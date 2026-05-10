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
from concurrent.futures import ThreadPoolExecutor
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
_last_update: dict[str, float] = {}

# ── User-Verwaltung ────────────────────────────────────────────────────────────
def get_user(request: Request) -> str:
    """
    Liest den eingeloggten User aus dem Cloudron proxyAuth Header.
    Fallback: 'default' (für lokale Entwicklung ohne proxyAuth)
    """
    user = request.headers.get("X-Forwarded-User", "").strip()
    user = re.sub(r'[^a-zA-Z0-9_.\-]', '', user)
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

        for i, ts in enumerate(timestamps):
            date_str = datetime.datetime.utcfromtimestamp(ts).strftime("%Y-%m-%d")
            if date_str <= last_date:
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

        # Heutiger Intraday-Kurs aus meta.regularMarketPrice
        # Überschreibt heutigen Eintrag mit aktuellem Kurs
        today = datetime.date.today().strftime("%Y-%m-%d")
        live_price = meta.get("regularMarketPrice")
        live_open  = meta.get("chartPreviousClose")  # Vortages-Close als Open-Proxy
        if live_price and live_price > 0:
            # Heutigen Eintrag mit Live-Kurs setzen/aktualisieren
            # open  = gestriger Schlusskurs (chartPreviousClose) als Proxy
            # high  = max(open, live_price)
            # low   = min(open, live_price)
            # close = live_price (aktueller Kurs)
            o = live_open or live_price
            h = max(o, live_price)
            l = min(o, live_price)
            conn.execute(
                "INSERT OR REPLACE INTO prices VALUES (?,?,?,?,?,?,?)",
                (ticker, today, o, h, l, live_price, 0)
            )
            count += 1

        conn.commit()
        return count
    except Exception as e:
        return f"error: {e}"

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

@app.get("/", response_class=HTMLResponse)
async def desktop(request: Request):
    """Desktop App."""
    with open(os.path.join(TEMPLATES_DIR, "desktop.html"), "r", encoding="utf-8") as f:
        return f.read()

@app.get("/mobile", response_class=HTMLResponse)
async def mobile(request: Request):
    """Mobile App."""
    mobile_file = os.path.join(TEMPLATES_DIR, "mobile.html")
    template = mobile_file if os.path.exists(mobile_file) else os.path.join(TEMPLATES_DIR, "desktop.html")
    with open(template, "r", encoding="utf-8") as f:
        return f.read()

@app.post("/api/prices/update")
async def update_prices(request: Request):
    """
    Delta-Update Yahoo Finance für alle Ticker eines Baskets.
    Rate Limit: 1x pro Minute pro User.
    """
    user = get_user(request)
    now = time.time()
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
    with open(files["notes"], "w") as f:
        json.dump(await request.json(), f)
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
            if q.get("quoteType") in ("EQUITY", "ETF")
        ]
        return JSONResponse(content=results)
    except Exception as e:
        print(f"Search error for {query}: {e}")
        return JSONResponse(content=[])
