"""
Folio — Portfolio Index App v1.0.0
==========================================
FastAPI + SQLite + Yahoo Finance + Cloudron proxyAuth

Architektur:
  /                  → templates/desktop.html
  /mobile            → templates/mobile.html
  /static/*          → static/ (shared.js, desktop.js, mobile.js, *.css)
  /api/*             → REST API

Multi-User:
  Cloudron proxyAuth setzt X-Forwarded-User Header
  Jeder User bekommt /app/data/{user}/ als persistentes Verzeichnis

Persistenz:
  /app/data/{user}/prices.db     SQLite Kursdatenbank
  /app/data/{user}/config.json   Basket-Konfiguration
  /app/data/{user}/notes.json    Notizen
  /app/data/{user}/drawings_*.json  Zeichnungen pro View
"""

import os
import re
import json
import time
import sqlite3
import shutil
import tempfile
import base64
import asyncio
import urllib.request as _urlreq
from concurrent.futures import ThreadPoolExecutor
from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware

# ── Konfiguration ──────────────────────────────────────────────────────────────
# Cloudron: /app/data ist beschreibbar, /app/code ist read-only
# Lokal: ./data relativ zum Script
if os.path.exists("/app/data"):
    BASE_DATA_DIR = "/app/data"
else:
    BASE_DATA_DIR = os.environ.get("DATA_DIR", os.path.join(os.path.dirname(__file__), "data"))
os.makedirs(BASE_DATA_DIR, exist_ok=True)

load_dotenv("/app/data/.env", override=True)

_IBKR_GATEWAY_URL = (os.environ.get("IBKR_GATEWAY_URL") or "").rstrip("/")

def _ibkr_gateway_request(path: str, method: str = "GET", data: bytes | None = None, timeout: int = 10):
    """HTTP request to IBKR Client Portal Gateway with Basic Auth."""
    api_user = os.environ.get("IBKR_API_USER", "api")
    api_pass = os.environ.get("IBKR_API_PASSWORD", "")
    creds    = base64.b64encode(f"{api_user}:{api_pass}".encode()).decode()
    req = _urlreq.Request(
        f"{_IBKR_GATEWAY_URL}{path}",
        headers={"Authorization": f"Basic {creds}", "Accept": "application/json"},
        method=method,
        data=data,
    )
    return _urlreq.urlopen(req, timeout=timeout)


_manifest_path = os.path.join(os.path.dirname(__file__), "CloudronManifest.json")
with open(_manifest_path) as _f:
    APP_VERSION = json.load(_f).get("version", "0.0.0")

_hash_path = os.path.join(os.path.dirname(__file__), "build_hash.txt")
if os.path.exists(_hash_path):
    with open(_hash_path) as _f:
        _build_hash = _f.read().strip()[:7]  # kurzer Hash, 7 Zeichen
    if _build_hash and _build_hash != "dev":
        APP_VERSION = f"{APP_VERSION}+{_build_hash}"

# ── App-Setup ──────────────────────────────────────────────────────────────────
app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"]
)

# Static files
app.mount("/static", StaticFiles(directory=os.path.join(os.path.dirname(__file__), "static")), name="static")
TEMPLATES_DIR = os.path.join(os.path.dirname(__file__), "templates")

# Rate Limiting: max 1 Update pro Minute pro User
import threading
_last_update: dict[str, float] = {}
_last_update_lock = threading.Lock()

# ── User-Verwaltung ────────────────────────────────────────────────────────────
def get_user(request: Request) -> str:
    """
    Liest den eingeloggten User aus dem Cloudron proxyAuth Header.
    Fallback: 'default' (für lokale Entwicklung ohne proxyAuth)
    """
    user = request.headers.get("X-Forwarded-User", "").strip()
    user = re.sub(r'[^a-zA-Z0-9_\-]', '', user)  # kein Punkt — verhindert Path Traversal via ".."
    return user or "default"

def get_user_dir(user: str) -> str:
    """Gibt das persistente Datenverzeichnis für einen User zurück."""
    user_dir = os.path.join(BASE_DATA_DIR, user)
    os.makedirs(user_dir, exist_ok=True)
    return user_dir

def get_user_files(user: str) -> dict:
    """Gibt alle Dateipfade für einen User zurück."""
    d = get_user_dir(user)
    return {
        "db":       os.path.join(d, "prices.db"),
        "config":   os.path.join(d, "config.json"),
        "notes":    os.path.join(d, "notes.json"),
        "data_dir": d,
    }

# ── SQLite ─────────────────────────────────────────────────────────────────────
def get_db(db_file: str) -> sqlite3.Connection:
    conn = sqlite3.connect(db_file)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")  # besser für concurrent reads
    return conn

def init_db(db_file: str):
    """Erstellt die Preistabelle falls sie nicht existiert."""
    conn = get_db(db_file)
    conn.execute('''CREATE TABLE IF NOT EXISTS prices (
        ticker TEXT NOT NULL,
        date   TEXT NOT NULL,
        open   REAL, high REAL, low REAL, close REAL, volume REAL,
        PRIMARY KEY (ticker, date)
    )''')
    conn.execute('CREATE INDEX IF NOT EXISTS idx_ticker_date ON prices(ticker, date)')
    conn.execute('''CREATE TABLE IF NOT EXISTS ticker_logos (
        ticker     TEXT PRIMARY KEY,
        logo_url   TEXT,
        fetched_at INTEGER
    )''')
    conn.execute('''CREATE TABLE IF NOT EXISTS ticker_currency (
        ticker   TEXT PRIMARY KEY,
        currency TEXT
    )''')
    conn.execute('''CREATE TABLE IF NOT EXISTS ticker_conid (
        ticker     TEXT PRIMARY KEY,
        conid      INTEGER,
        fetched_at INTEGER
    )''')
    conn.commit()
    conn.close()

# ── Yahoo Finance ──────────────────────────────────────────────────────────────
def update_ticker(ticker: str, conn: sqlite3.Connection) -> int:
    """
    Lädt Kursdaten von Yahoo Finance und speichert sie in SQLite.
    Nutzt Delta-Updates + holt heutigen Intraday-Kurs separat.
    """
    try:
        import urllib.request, datetime, time as time_module

        row = conn.execute(
            "SELECT MAX(date) as last FROM prices WHERE ticker=?", (ticker,)
        ).fetchone()
        last_date = row["last"] if row and row["last"] else "2020-01-01"

        # Historische Daten (1d interval) — liefert abgeschlossene Tage
        period1 = int(time_module.mktime(time_module.strptime(last_date, "%Y-%m-%d")))
        period2 = int(time_module.time())
        url = (
            f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}"
            f"?interval=1d&period1={period1}&period2={period2}"
        )
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())

        chart = data["chart"]["result"][0]
        timestamps = chart["timestamp"]
        ohlcv = chart["indicators"]["quote"][0]
        meta  = chart.get("meta", {})
        count = 0

        # UTC konsistent mit utcfromtimestamp — verhindert Datum-Mismatch auf UTC+X Servern
        today_obj = datetime.datetime.utcnow().date()
        today = today_obj.strftime("%Y-%m-%d")

        for i, ts in enumerate(timestamps):
            date_str = datetime.datetime.utcfromtimestamp(ts).strftime("%Y-%m-%d")
            if date_str < last_date:  # < statt <= damit heute immer neu geladen wird
                continue
            o = ohlcv["open"][i]
            h = ohlcv["high"][i]
            l = ohlcv["low"][i]
            c = ohlcv["close"][i]
            v = ohlcv["volume"][i]
            if None in (o, h, l, c):
                continue
            conn.execute(
                "INSERT OR REPLACE INTO prices VALUES (?,?,?,?,?,?,?)",
                (ticker, date_str, o, h, l, c, v)
            )
            count += 1

        # Close auf aktuellen Live-Kurs aktualisieren — nur an Handelstagen (Mo–Fr)
        # Kein Eintrag für Wochenenden: regularMarketPrice wäre der letzte Schlusskurs und
        # würde als Samstag/Sonntag-Kerze in der DB landen.
        live_price = meta.get("regularMarketPrice")
        market_time = meta.get("regularMarketTime") or 0
        market_date = datetime.datetime.utcfromtimestamp(market_time).strftime("%Y-%m-%d") if market_time else ""
        if live_price and live_price > 0 and today_obj.weekday() < 5 and market_date == today:
            existing = conn.execute(
                "SELECT open, high, low FROM prices WHERE ticker=? AND date=?",
                (ticker, today)
            ).fetchone()
            if existing:
                conn.execute(
                    "UPDATE prices SET close=?, high=?, low=? WHERE ticker=? AND date=?",
                    (live_price,
                     max(existing["high"], live_price),
                     min(existing["low"],  live_price),
                     ticker, today)
                )
            else:
                # Kein historischer Bar vorhanden (z.B. Feiertag) — Meta als Fallback
                o = meta.get("regularMarketOpen")    or live_price
                h = meta.get("regularMarketDayHigh") or live_price
                l = meta.get("regularMarketDayLow")  or live_price
                conn.execute(
                    "INSERT OR REPLACE INTO prices VALUES (?,?,?,?,?,?,?)",
                    (ticker, today, o, max(h, live_price), min(l, live_price), live_price, 0)
                )
            count += 1

        # Währung speichern
        currency = meta.get("currency") or "USD"
        conn.execute(
            "INSERT OR REPLACE INTO ticker_currency VALUES (?,?)", (ticker, currency)
        )
        conn.commit()
        return count
    except Exception as e:
        print(f"update_ticker error for {ticker}: {e}")
        return -1

# ── Config ──────────────────────────────────────────────────────────────────────
def load_config(config_file: str) -> dict:
    if os.path.exists(config_file):
        with open(config_file, "r") as f:
            return json.load(f)
    return {"baskets": {}, "currentBasket": ""}

def save_config_data(config_file: str, cfg: dict):
    """Atomares Speichern via tempfile + rename — kein Datenverlust bei Crash."""
    tmp = config_file + ".tmp"
    with open(tmp, "w") as f:
        json.dump(cfg, f, indent=2)
    shutil.move(tmp, config_file)

# ── Zeichnungen ────────────────────────────────────────────────────────────────
def drawings_file(data_dir: str, view_key: str) -> str:
    import pathlib
    safe = pathlib.Path(view_key).name.replace(":", "_")[:100]
    return os.path.join(data_dir, f"drawings_{safe}.json")

def load_drawings(data_dir: str, view_key: str) -> list:
    f = drawings_file(data_dir, view_key)
    if os.path.exists(f):
        with open(f) as fp:
            return json.load(fp)
    return []

def save_drawings(data_dir: str, view_key: str, d: list):
    with open(drawings_file(data_dir, view_key), "w") as f:
        json.dump(d, f)

# ── Endpunkte ──────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    """Cloudron Healthcheck — kein Auth nötig."""
    return {"status": "ok"}

def _render(path: str) -> str:
    with open(path, "r", encoding="utf-8") as f:
        html = f.read()
    html = html.replace("{{APP_VERSION}}", APP_VERSION)
    # Cache-Busting: ?v= an lokale statische Dateien hängen
    html = re.sub(r'(/static/[^"\']+\.(js|css))', lambda m: m.group(1) + f'?v={APP_VERSION}', html)
    return html

@app.get("/", response_class=HTMLResponse)
async def desktop(request: Request):
    """Desktop App."""
    return _render(os.path.join(TEMPLATES_DIR, "desktop.html"))

@app.get("/mobile", response_class=HTMLResponse)
async def mobile(request: Request):
    """Mobile App."""
    mobile_file = os.path.join(TEMPLATES_DIR, "mobile.html")
    template = mobile_file if os.path.exists(mobile_file) else os.path.join(TEMPLATES_DIR, "desktop.html")
    return _render(template)

@app.post("/api/prices/update")
async def update_prices(request: Request):
    """
    Delta-Update Yahoo Finance für alle Ticker eines Baskets.
    Rate Limit: 1x pro Minute pro User.
    """
    user = get_user(request)
    now = time.time()
    with _last_update_lock:
        if now - _last_update.get(user, 0) < 60:
            return JSONResponse(
                content={"ok": False, "error": "Rate limit: 1x pro Minute"},
                status_code=429
            )
        _last_update[user] = now

    files = get_user_files(user)
    init_db(files["db"])
    body = await request.json()
    tickers = body.get("tickers", [])
    if not tickers:
        return JSONResponse(content={"ok": True, "updated": 0})

    def update_one(ticker):
        try:
            conn = get_db(files["db"])
            n = update_ticker(ticker, conn)
            conn.close()
            return ticker, n
        except Exception as e:
            return ticker, f"error: {e}"

    with ThreadPoolExecutor(max_workers=8) as ex:
        results = dict(ex.map(lambda t: update_one(t), tickers))

    return JSONResponse(content={"ok": True, "results": results})

@app.get("/api/prices/status/all")
async def get_prices_status(request: Request):
    """Letztes Update + Anzahl Einträge pro Ticker."""
    user = get_user(request)
    files = get_user_files(user)
    init_db(files["db"])
    conn = get_db(files["db"])
    rows = conn.execute(
        "SELECT ticker, MAX(date) as last_date, COUNT(*) as count "
        "FROM prices GROUP BY ticker"
    ).fetchall()
    conn.close()
    return JSONResponse(content={
        r["ticker"]: {"last": r["last_date"], "count": r["count"]}
        for r in rows
    })

@app.get("/api/prices/currencies")
async def get_currencies(request: Request, tickers: str = ""):
    """Gibt Währungen für Ticker zurück: {ticker: currency}."""
    user  = get_user(request)
    files = get_user_files(user)
    init_db(files["db"])
    conn  = get_db(files["db"])
    ticker_list = [t.strip().upper() for t in tickers.split(',') if t.strip()] if tickers else []
    if ticker_list:
        placeholders = ','.join('?' * len(ticker_list))
        rows = conn.execute(
            f"SELECT ticker, currency FROM ticker_currency WHERE ticker IN ({placeholders})",
            ticker_list
        ).fetchall()
    else:
        rows = conn.execute("SELECT ticker, currency FROM ticker_currency").fetchall()
    conn.close()
    return JSONResponse(content={r["ticker"]: r["currency"] for r in rows})

@app.get("/api/prices/{ticker}")
async def get_prices(ticker: str, request: Request):
    """Kursdaten für einen Ticker aus SQLite."""
    user = get_user(request)
    files = get_user_files(user)
    conn = get_db(files["db"])
    rows = conn.execute(
        "SELECT date,open,high,low,close,volume FROM prices "
        "WHERE ticker=? ORDER BY date",
        (ticker,)
    ).fetchall()
    conn.close()
    return JSONResponse(content=[dict(r) for r in rows])

@app.get("/api/drawings")
async def get_drawings(request: Request, view: str = "index:default"):
    user = get_user(request)
    files = get_user_files(user)
    return JSONResponse(content=load_drawings(files["data_dir"], view))

@app.post("/api/drawings")
async def save_drawing(request: Request, view: str = "index:default"):
    user = get_user(request)
    files = get_user_files(user)
    drawing = await request.json()
    drawings = load_drawings(files["data_dir"], view)
    idx = next((i for i, d in enumerate(drawings) if d.get("id") == drawing.get("id")), None)
    if idx is not None:
        drawings[idx] = drawing
    else:
        drawings.append(drawing)
    save_drawings(files["data_dir"], view, drawings)
    return JSONResponse(content={"ok": True})

@app.delete("/api/drawings/{drawing_id}")
async def delete_drawing(drawing_id: str, request: Request, view: str = "index:default"):
    user = get_user(request)
    files = get_user_files(user)
    drawings = [d for d in load_drawings(files["data_dir"], view) if d.get("id") != drawing_id]
    save_drawings(files["data_dir"], view, drawings)
    return JSONResponse(content={"ok": True})

@app.delete("/api/drawings")
async def clear_drawings(request: Request, view: str = "index:default"):
    user = get_user(request)
    files = get_user_files(user)
    save_drawings(files["data_dir"], view, [])
    return JSONResponse(content={"ok": True})

@app.get("/api/config")
async def get_config(request: Request):
    user = get_user(request)
    files = get_user_files(user)
    return JSONResponse(content=load_config(files["config"]))

@app.post("/api/config")
async def set_config(request: Request):
    user = get_user(request)
    files = get_user_files(user)
    save_config_data(files["config"], await request.json())
    return JSONResponse(content={"ok": True})

@app.get("/api/notes")
async def get_notes(request: Request):
    user = get_user(request)
    files = get_user_files(user)
    if os.path.exists(files["notes"]):
        with open(files["notes"]) as f:
            return JSONResponse(content=json.load(f))
    return JSONResponse(content={"text": ""})

@app.post("/api/notes")
async def save_notes(request: Request):
    user = get_user(request)
    files = get_user_files(user)
    tmp = files["notes"] + ".tmp"
    with open(tmp, "w") as f:
        json.dump(await request.json(), f)
    shutil.move(tmp, files["notes"])
    return JSONResponse(content={"ok": True})

@app.get("/api/search/{query}")
async def search_ticker(query: str, request: Request):
    """Yahoo Finance Ticker-Suche."""
    try:
        import urllib.request
        url = f"https://query1.finance.yahoo.com/v1/finance/search?q={query}&quotesCount=8"
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read())
        results = [
            {"symbol": q["symbol"], "name": q.get("shortname", q.get("longname", ""))}
            for q in data.get("quotes", [])
            if q.get("quoteType") in ("EQUITY", "ETF", "FUTURE", "INDEX", "CURRENCY")
        ]
        return JSONResponse(content=results)
    except Exception as e:
        print(f"Search error for {query}: {e}")
        return JSONResponse(content=[])

@app.post("/api/logos")
async def get_logos(request: Request):
    """Gibt Logo-URLs für eine Liste von Tickern zurück (gecacht in SQLite, 7 Tage)."""
    import urllib.request as _ur
    user  = get_user(request)
    files = get_user_files(user)
    body  = await request.json()
    tickers = [str(t).upper().strip() for t in body.get("tickers", []) if t]

    conn = get_db(files["db"])
    now  = int(time.time())
    ttl  = 7 * 86400
    result: dict[str, str | None] = {}
    to_fetch: list[str] = []

    for t in tickers:
        row = conn.execute("SELECT logo_url, fetched_at FROM ticker_logos WHERE ticker=?", (t,)).fetchone()
        if row and (now - (row["fetched_at"] or 0)) < ttl:
            result[t] = row["logo_url"]
        else:
            to_fetch.append(t)

    for t in to_fetch:
        logo = None
        try:
            url = f"https://query2.finance.yahoo.com/v10/finance/quoteSummary/{t}?modules=assetProfile"
            req = _ur.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with _ur.urlopen(req, timeout=6) as resp:
                data = json.loads(resp.read())
            profile = (data.get("quoteSummary") or {}).get("result") or [{}]
            logo = (profile[0].get("assetProfile") or {}).get("logoUrl")
        except Exception:
            pass
        result[t] = logo
        conn.execute("INSERT OR REPLACE INTO ticker_logos VALUES (?,?,?)", (t, logo, now))

    conn.commit()
    return JSONResponse(content=result)

# ── IBKR Client Portal Gateway ─────────────────────────────────────────────────

def _init_ibkr_tables(db_file: str):
    """Erstellt IBKR-Tabellen falls nicht vorhanden."""
    conn = get_db(db_file)
    conn.execute('''CREATE TABLE IF NOT EXISTS positions (
        symbol           TEXT PRIMARY KEY,
        quantity         REAL,
        cost_basis_price REAL,
        cost_basis_money REAL,
        mark_price       REAL,
        position_value   REAL,
        asset_class      TEXT,
        last_sync        TEXT,
        fx_rate_to_base  REAL DEFAULT 1.0,
        conid            INTEGER,
        yahoo_symbol     TEXT
    )''')
    for col, typ in [("fx_rate_to_base", "REAL DEFAULT 1.0"), ("conid", "INTEGER"), ("yahoo_symbol", "TEXT")]:
        try:
            conn.execute(f"ALTER TABLE positions ADD COLUMN {col} {typ}")
        except Exception:
            pass
    conn.execute('''CREATE TABLE IF NOT EXISTS cash_balances (
        currency    TEXT PRIMARY KEY,
        ending_cash REAL,
        last_sync   TEXT
    )''')
    conn.execute('''CREATE TABLE IF NOT EXISTS trades (
        transaction_id TEXT PRIMARY KEY,
        symbol         TEXT,
        action         TEXT,
        quantity       REAL,
        price          REAL,
        value          REAL,
        commission     REAL,
        currency       TEXT,
        fx_rate        REAL DEFAULT 1.0,
        trade_date     TEXT,
        asset_class    TEXT,
        last_sync      TEXT
    )''')
    conn.commit()
    conn.close()


def _do_ibkr_gateway_sync(db_file: str) -> dict:
    """Sync Positionen + Cash via IBKR Client Portal Gateway API."""
    import datetime as dt_
    import urllib.error

    if not _IBKR_GATEWAY_URL:
        return {"ok": False, "error": "IBKR_GATEWAY_URL nicht konfiguriert"}

    now = dt_.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")

    # 1 — Konto-ID ermitteln
    try:
        with _ibkr_gateway_request("/v1/api/portfolio/accounts", timeout=15) as resp:
            accounts = json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return {"ok": False, "error": f"Gateway accounts {e.code}: {e.read().decode()[:200]}"}
    except Exception as e:
        return {"ok": False, "error": f"Gateway nicht erreichbar: {e}"}

    if not accounts:
        return {"ok": False, "error": "Keine IBKR Konten — ist das Gateway eingeloggt?"}

    acct_id = accounts[0].get("id") or accounts[0].get("accountId") or ""
    if not acct_id:
        return {"ok": False, "error": f"Kein accountId im Gateway-Response: {accounts[0]}"}
    print(f"[IBKR GW] Konto: {acct_id}")

    # 2 — Positionen seitenweise abrufen
    raw_positions = []
    for page in range(50):
        params = "?invalidatecache=1" if page == 0 else ""
        try:
            with _ibkr_gateway_request(
                f"/v1/api/portfolio/{acct_id}/positions/{page}{params}", timeout=20
            ) as resp:
                page_data = json.loads(resp.read().decode())
        except Exception as e:
            print(f"[IBKR GW] Positionen Seite {page} Fehler: {e}")
            break
        if not page_data:
            break
        raw_positions.extend(page_data)
        if len(page_data) < 30:
            break

    print(f"[IBKR GW] {len(raw_positions)} Positionen empfangen")

    # 3 — Ledger: Cash-Salden + FX-Kurse
    fx_rates: dict[str, float] = {}
    cash_rows = []
    try:
        with _ibkr_gateway_request(f"/v1/api/portfolio/{acct_id}/ledger", timeout=15) as resp:
            ledger = json.loads(resp.read().decode())
        for ccy, data in ledger.items():
            rate = float(data.get("exchangerate") or 1.0)
            if ccy != "BASE":
                fx_rates[ccy] = rate
            cash_bal = float(data.get("cashbalance") or 0.0)
            cash_rows.append((ccy, cash_bal, now))
    except Exception as e:
        print(f"[IBKR GW] Ledger Fehler (nicht fatal): {e}")

    # 4 — Positionen mappen (inkl. conid)
    position_rows = []
    for p in raw_positions:
        symbol = (p.get("symbol") or p.get("contractDesc") or "").strip()
        if not symbol:
            continue
        qty       = float(p.get("position")      or 0)
        avg_price = float(p.get("avgPrice")       or 0) or float(p.get("avgCost") or 0)
        mkt_price = float(p.get("mktPrice")       or 0)
        mkt_value = float(p.get("mktValue")       or 0)
        unrealized= float(p.get("unrealizedPnl")  or 0)
        currency  = (p.get("currency") or "USD").strip()
        fx        = fx_rates.get(currency, 1.0)
        cbm       = mkt_value - unrealized
        asset_cls = (p.get("assetClass") or "STK").strip()
        conid     = p.get("conid") or None
        position_rows.append((symbol, qty, avg_price, cbm, mkt_price, mkt_value, asset_cls, now, fx, conid))

    if not position_rows and not cash_rows:
        return {"ok": False, "error": "Keine Positionen oder Cash-Daten vom Gateway"}

    # 5 — In DB schreiben
    conn = get_db(db_file)
    conn.execute("DELETE FROM positions")
    if position_rows:
        conn.executemany(
            "INSERT OR REPLACE INTO positions "
            "(symbol,quantity,cost_basis_price,cost_basis_money,mark_price,position_value,asset_class,last_sync,fx_rate_to_base,conid) "
            "VALUES (?,?,?,?,?,?,?,?,?,?)", position_rows)
    conn.execute("DELETE FROM cash_balances")
    if cash_rows:
        conn.executemany("INSERT OR REPLACE INTO cash_balances VALUES (?,?,?)", cash_rows)
    conn.commit()
    conn.close()

    return {"ok": True, "count": len(position_rows), "cash_count": len(cash_rows), "last_sync": now}


@app.get("/api/ibkr/sync")
async def ibkr_sync(request: Request):
    """IBKR Gateway: Positionen und Cash-Salden synchronisieren."""
    user  = get_user(request)
    files = get_user_files(user)
    _init_ibkr_tables(files["db"])
    try:
        loop   = asyncio.get_running_loop()
        result = await loop.run_in_executor(None, _do_ibkr_gateway_sync, files["db"])
        return JSONResponse(content=result, status_code=200 if result.get("ok") else 502)
    except Exception as e:
        print(f"ibkr_sync error: {e}")
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)


@app.get("/api/ibkr/gateway/status")
async def ibkr_gateway_status():
    """IBKR Gateway Auth-Status."""
    if not _IBKR_GATEWAY_URL:
        return JSONResponse({"authenticated": False})
    try:
        with _ibkr_gateway_request("/v1/api/iserver/auth/status") as resp:
            data = json.loads(resp.read().decode())
            return JSONResponse({"authenticated": data.get("authenticated", False)})
    except Exception:
        return JSONResponse({"authenticated": False})


@app.post("/api/ibkr/gateway/logout")
async def ibkr_gateway_logout():
    """IBKR Gateway Logout."""
    try:
        with _ibkr_gateway_request("/v1/api/logout", method="POST", data=b"") as resp:
            status = resp.status
            body   = resp.read().decode("utf-8", errors="replace")
            print(f"[IBKR GW] logout response {status}: {body[:200]}")
            return JSONResponse({"ok": True, "status": status})
    except Exception as e:
        print(f"[IBKR GW] logout FEHLER: {e}")
        return JSONResponse({"ok": False, "error": str(e)}, status_code=502)


@app.get("/api/ibkr/positions")
async def ibkr_positions(request: Request):
    """Alle gespeicherten IBKR-Positionen als JSON."""
    user  = get_user(request)
    files = get_user_files(user)
    _init_ibkr_tables(files["db"])
    conn  = get_db(files["db"])
    rows  = conn.execute("SELECT * FROM positions ORDER BY symbol").fetchall()
    conn.close()
    return JSONResponse(content=[dict(r) for r in rows])


@app.patch("/api/ibkr/positions/{symbol}")
async def update_ibkr_position(symbol: str, request: Request):
    """Setzt yahoo_symbol-Mapping für eine IBKR-Position."""
    user  = get_user(request)
    files = get_user_files(user)
    _init_ibkr_tables(files["db"])
    body  = await request.json()
    yahoo_sym = (body.get("yahoo_symbol") or "").strip().upper() or None
    conn = get_db(files["db"])
    conn.execute("UPDATE positions SET yahoo_symbol=? WHERE symbol=?", (yahoo_sym, symbol))
    conn.commit()
    conn.close()
    return JSONResponse({"ok": True})


@app.get("/api/ibkr/cash")
async def ibkr_cash(request: Request):
    """Alle gespeicherten IBKR-Cash-Balances als JSON."""
    user  = get_user(request)
    files = get_user_files(user)
    _init_ibkr_tables(files["db"])
    conn  = get_db(files["db"])
    rows  = conn.execute("SELECT * FROM cash_balances ORDER BY currency").fetchall()
    conn.close()
    return JSONResponse(content=[dict(r) for r in rows])


@app.get("/api/ibkr/trades")
async def ibkr_trades(request: Request):
    """Alle gespeicherten IBKR-Trades als JSON, neueste zuerst."""
    user  = get_user(request)
    files = get_user_files(user)
    _init_ibkr_tables(files["db"])
    conn  = get_db(files["db"])
    rows  = conn.execute(
        "SELECT * FROM trades ORDER BY trade_date DESC, transaction_id DESC"
    ).fetchall()
    conn.close()
    return JSONResponse(content=[dict(r) for r in rows])


# ── IBKR Snapshot Background Task ──────────────────────────────────────────────

_snapshot_source: str = "yahoo"
_snapshot_conids: dict[str, int | None] = {}


def _resolve_conid(ticker: str) -> int | None:
    """Löst ein Ticker-Symbol zu einer IBKR conid via /iserver/secdef/search."""
    try:
        with _ibkr_gateway_request(
            f"/v1/api/iserver/secdef/search?symbol={ticker}&name=false&secType=STK",
            timeout=8
        ) as resp:
            results = json.loads(resp.read().decode())
        if results:
            return results[0].get("conid") or None
    except Exception as e:
        print(f"[Snapshot] conid lookup für {ticker} fehlgeschlagen: {e}")
    return None


async def _snapshot_loop():
    """Background Task: aktualisiert heutige Kerzen für alle Ticker via IBKR Snapshot API."""
    global _snapshot_source
    import datetime as dt_

    while True:
        try:
            if not _IBKR_GATEWAY_URL:
                await asyncio.sleep(60)
                continue

            # Alle User-Config-Dateien durchsuchen → ticker → [user, ...]
            ticker_users: dict[str, list[str]] = {}
            for entry in os.scandir(BASE_DATA_DIR):
                if not entry.is_dir():
                    continue
                cfg_path = os.path.join(entry.path, "config.json")
                if not os.path.exists(cfg_path):
                    continue
                try:
                    with open(cfg_path) as f:
                        cfg = json.load(f)
                    for basket in cfg.get("baskets", {}).values():
                        for item in basket.get("items", []):
                            t = (item.get("ticker") or "").strip().upper()
                            if t:
                                ticker_users.setdefault(t, [])
                                if entry.name not in ticker_users[t]:
                                    ticker_users[t].append(entry.name)
                except Exception:
                    pass

            if not ticker_users:
                await asyncio.sleep(5)
                continue

            # conids auflösen — fehlende Einträge via API
            loop = asyncio.get_running_loop()
            tickers_with_conid: list[tuple[str, int]] = []
            for ticker in ticker_users:
                if ticker not in _snapshot_conids:
                    cid = await loop.run_in_executor(None, _resolve_conid, ticker)
                    _snapshot_conids[ticker] = cid
                if _snapshot_conids[ticker]:
                    tickers_with_conid.append((ticker, _snapshot_conids[ticker]))

            if not tickers_with_conid:
                await asyncio.sleep(10)
                continue

            today = dt_.datetime.utcnow().strftime("%Y-%m-%d")
            any_ok = False

            # Batches à 20 Ticker (Rate Limit: max 60 req/min)
            for i in range(0, len(tickers_with_conid), 20):
                batch = tickers_with_conid[i:i + 20]
                conids_str = ",".join(str(c) for _, c in batch)
                try:
                    with _ibkr_gateway_request(
                        f"/v1/api/iserver/marketdata/snapshot?conids={conids_str}&fields=31,70,71,88,7295",
                        timeout=10
                    ) as resp:
                        snap_data = json.loads(resp.read().decode())
                except Exception as e:
                    print(f"[Snapshot] Batch {i//20+1} fehlgeschlagen: {e}")
                    snap_data = []

                snap_by_conid: dict[int, dict] = {s["conid"]: s for s in snap_data if s.get("conid")}

                for ticker, conid in batch:
                    snap = snap_by_conid.get(conid)
                    if not snap:
                        continue
                    try:
                        close  = float(snap.get("31")   or 0)
                        high   = float(snap.get("70")   or 0)
                        low    = float(snap.get("71")   or 0)
                        volume = float(snap.get("88")   or 0)
                        open_  = float(snap.get("7295") or 0)
                    except (ValueError, TypeError):
                        continue
                    if not close or not open_:
                        continue

                    any_ok = True
                    for user in ticker_users.get(ticker, []):
                        db_file = os.path.join(BASE_DATA_DIR, user, "prices.db")
                        if not os.path.exists(db_file):
                            continue
                        try:
                            conn = get_db(db_file)
                            conn.execute(
                                "INSERT OR REPLACE INTO prices VALUES (?,?,?,?,?,?,?)",
                                (ticker, today, open_, max(high, close), min(low, close), close, volume)
                            )
                            conn.commit()
                            conn.close()
                        except Exception as e:
                            print(f"[Snapshot] DB-Schreib-Fehler {user}/{ticker}: {e}")

                await asyncio.sleep(1)

            _snapshot_source = "ibkr" if any_ok else "yahoo"

        except Exception as e:
            print(f"[Snapshot] Loop-Fehler: {e}")
            _snapshot_source = "yahoo"

        await asyncio.sleep(2)


@app.on_event("startup")
async def start_snapshot_task():
    asyncio.create_task(_snapshot_loop())


@app.get("/api/ibkr/snapshot/status")
async def snapshot_status():
    """Gibt an ob Live-Preise von IBKR oder Yahoo Finance kommen."""
    return JSONResponse({"source": _snapshot_source, "gateway_configured": bool(_IBKR_GATEWAY_URL)})
