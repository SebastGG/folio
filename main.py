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
import secrets as _secrets
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from dotenv import load_dotenv
from fastapi import FastAPI, Request, UploadFile, File
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware

import screener
from itsdangerous import URLSafeTimedSerializer, BadSignature, SignatureExpired

# ── Konfiguration ──────────────────────────────────────────────────────────────
# Cloudron: /app/data ist beschreibbar, /app/code ist read-only
# Lokal: ./data relativ zum Script
if os.path.exists("/app/data"):
    BASE_DATA_DIR = "/app/data"
else:
    BASE_DATA_DIR = os.environ.get("DATA_DIR", os.path.join(os.path.dirname(__file__), "data"))
os.makedirs(BASE_DATA_DIR, exist_ok=True)

load_dotenv("/app/data/.env", override=False)


_manifest_path = os.path.join(os.path.dirname(__file__), "CloudronManifest.json")
with open(_manifest_path) as _f:
    APP_VERSION = json.load(_f).get("version", "0.0.0")

_hash_path = os.path.join(os.path.dirname(__file__), "build_hash.txt")
if os.path.exists(_hash_path):
    with open(_hash_path) as _f:
        _build_hash = _f.read().strip()[:7]  # kurzer Hash, 7 Zeichen
    if _build_hash and _build_hash != "dev":
        APP_VERSION = f"{APP_VERSION}+{_build_hash}"

# ── OIDC / Authentifizierung ────────────────────────────────────────────────────
# Cloudron stellt via 'oidc'-Addon die OAuth-Endpunkte + Client-Credentials als
# Env-Variablen bereit. Wir führen den Authorization-Code-Flow selbst aus und legen
# die Identität (E-Mail) in ein signiertes Session-Cookie. Daraus liest get_user()
# den echten Benutzer → eigenes Datenverzeichnis pro User.
# WICHTIG (Cloudron): Env-Variablen können sich bei Neustart ändern → zur Laufzeit lesen.

_SESSION_COOKIE  = "folio_session"
_STATE_COOKIE    = "folio_oauth_state"
_SESSION_MAX_AGE = 30 * 86400   # 30 Tage

def _oidc_cfg() -> dict:
    return {
        "auth":     os.environ.get("CLOUDRON_OIDC_AUTH_ENDPOINT", "").strip(),
        "token":    os.environ.get("CLOUDRON_OIDC_TOKEN_ENDPOINT", "").strip(),
        "profile":  os.environ.get("CLOUDRON_OIDC_PROFILE_ENDPOINT", "").strip(),
        "client_id":     os.environ.get("CLOUDRON_OIDC_CLIENT_ID", "").strip(),
        "client_secret": os.environ.get("CLOUDRON_OIDC_CLIENT_SECRET", "").strip(),
        "origin":   os.environ.get("CLOUDRON_APP_ORIGIN", "").strip().rstrip("/"),
    }

def _oidc_enabled() -> bool:
    c = _oidc_cfg()
    return bool(c["auth"] and c["token"] and c["client_id"] and c["origin"])

def _cookie_secure() -> bool:
    return _oidc_cfg()["origin"].startswith("https://")

def _session_signer() -> URLSafeTimedSerializer:
    """Signierschlüssel persistent in BASE_DATA_DIR (überlebt Neustarts → Sessions bleiben gültig)."""
    key_file = os.path.join(BASE_DATA_DIR, "session.key")
    if os.path.exists(key_file):
        with open(key_file) as f:
            secret = f.read().strip()
    else:
        secret = _secrets.token_hex(32)
        with open(key_file, "w") as f:
            f.write(secret)
    return URLSafeTimedSerializer(secret, salt="folio-session")

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
def _sanitize_user(user: str) -> str:
    """Macht eine Identität (z.B. E-Mail) sicher als Verzeichnisnamen — kein Path Traversal."""
    user = re.sub(r'[^a-zA-Z0-9_@.\-]', '', (user or "").strip().lower())
    while ".." in user:
        user = user.replace("..", ".")
    user = user.strip(".")
    return user[:120]

def get_user(request: Request) -> str:
    """
    Liefert den eingeloggten Benutzer aus dem signierten Session-Cookie (OIDC).
    Ohne OIDC (lokale Entwicklung) Fallback auf 'default'. Ist OIDC aktiv und kein
    gültiges Cookie vorhanden, wird "" zurückgegeben (→ Middleware leitet zum Login).
    """
    cookie = request.cookies.get(_SESSION_COOKIE)
    if cookie:
        try:
            data = _session_signer().loads(cookie, max_age=_SESSION_MAX_AGE)
            u = _sanitize_user(data.get("user", ""))
            if u:
                return u
        except (BadSignature, SignatureExpired):
            pass
    if not _oidc_enabled():
        return "default"   # lokale Entwicklung ohne OIDC
    return ""

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

# ── Steuer-Datei-Ablage (pro User) ──────────────────────────────────────────────
# Hochgeladene IBKR-Statements werden serverseitig gespeichert, damit der User sie
# nicht bei jedem Besuch neu hochladen muss. Zwei Sorten, die sich Seiten teilen:
#   "xml" → Flex-XML (Steuer ++ und Steuer +++)
#   "csv" → Activity-CSV (Steuer und Steuer +)
# Liegt im User-Datenverzeichnis (pro User über OIDC isoliert), wie prices.db/fx_cache.
_TAX_STORE_KINDS = ("xml", "csv")

def _tax_safe_name(name: str, kind: str) -> str:
    """Dateinamen auf Basename + erlaubte Zeichen reduzieren, Endung erzwingen."""
    base = os.path.basename(name or "").replace("\\", "").strip()
    base = "".join(c for c in base if c.isalnum() or c in "._- ").strip()
    if not base:
        base = "datei"
    if not base.lower().endswith("." + kind):
        base += "." + kind
    return base

def _tax_store_dir(user: str, kind: str) -> str:
    d = os.path.join(get_user_dir(user), "tax_files", kind)
    os.makedirs(d, exist_ok=True)
    return d

def _tax_store_add(user: str, kind: str, items: list[tuple[str, bytes]]) -> list[str]:
    """Fügt Dateien zum Bestand hinzu (gleicher Name wird überschrieben, andere bleiben).
    So lassen sich einzelne Jahres-XMLs nachladen, ohne die übrigen zu verlieren."""
    d = _tax_store_dir(user, kind)
    for name, raw in items:
        sn = _tax_safe_name(name, kind)
        with open(os.path.join(d, sn), "wb") as fh:
            fh.write(raw)
    return _tax_store_list(user, kind)

def _tax_store_list(user: str, kind: str) -> list[str]:
    d = _tax_store_dir(user, kind)
    return sorted(f for f in os.listdir(d) if os.path.isfile(os.path.join(d, f)))

def _tax_store_load(user: str, kind: str) -> list[str]:
    """Liest die gespeicherten Dateien als Text (utf-8-sig), sortiert nach Name."""
    d = _tax_store_dir(user, kind)
    out = []
    for name in _tax_store_list(user, kind):
        with open(os.path.join(d, name), "rb") as fh:
            out.append(fh.read().decode("utf-8-sig", errors="replace"))
    return out

def _tax_store_delete_one(user: str, kind: str, name: str) -> bool:
    """Löscht eine einzelne gespeicherte Datei (per Name). True bei Erfolg."""
    sn = _tax_safe_name(name, kind)
    p = os.path.join(_tax_store_dir(user, kind), sn)
    if os.path.isfile(p):
        try:
            os.remove(p)
            return True
        except OSError:
            return False
    return False

def _tax_store_clear(user: str, kind: str) -> None:
    d = _tax_store_dir(user, kind)
    for f in os.listdir(d):
        try:
            os.remove(os.path.join(d, f))
        except OSError:
            pass

async def _tax_collect_texts(user: str, kind: str, files):
    """
    Liefert (texts, source) für einen Compute-Endpoint:
      • Wurden Dateien hochgeladen → in den Bestand mergen, dann den GESAMTEN
        Bestand laden (damit Einzel-Nachladen die Historie behält), source="upload".
      • Sonst → gespeicherten Bestand laden, source="stored".
    """
    items = []
    for f in (files or []):
        raw = await f.read()
        if raw:
            items.append((f.filename or "datei", raw))
    if items:
        _tax_store_add(user, kind, items)
        return _tax_store_load(user, kind), "upload"
    return _tax_store_load(user, kind), "stored"

# ── Auth-Middleware + OAuth-Routen ──────────────────────────────────────────────
_AUTH_PUBLIC = ("/health", "/login", "/callback", "/logout", "/favicon.ico")

@app.middleware("http")
async def _auth_gate(request: Request, call_next):
    path = request.url.path
    if not _oidc_enabled() or path in _AUTH_PUBLIC or path.startswith("/static/"):
        return await call_next(request)
    if get_user(request):
        return await call_next(request)
    # Nicht eingeloggt: API → 401, Seiten → Redirect zum Login
    if path.startswith("/api/"):
        return JSONResponse({"ok": False, "error": "not authenticated"}, status_code=401)
    return RedirectResponse("/login")

@app.get("/login")
async def login(request: Request):
    c = _oidc_cfg()
    if not _oidc_enabled():
        return RedirectResponse("/")
    state = _secrets.token_urlsafe(24)
    params = urllib.parse.urlencode({
        "response_type": "code",
        "client_id":     c["client_id"],
        "redirect_uri":  c["origin"] + "/callback",
        "scope":         "openid profile email",
        "state":         state,
    })
    resp = RedirectResponse(c["auth"] + "?" + params)
    resp.set_cookie(_STATE_COOKIE, state, max_age=600, httponly=True,
                    secure=_cookie_secure(), samesite="lax")
    return resp

@app.get("/callback")
async def callback(request: Request, code: str = "", state: str = ""):
    import httpx
    c = _oidc_cfg()
    if not _oidc_enabled():
        return RedirectResponse("/")
    if not code or not state or state != request.cookies.get(_STATE_COOKIE):
        return HTMLResponse("Login fehlgeschlagen (ungültiger State). "
                            "<a href='/login'>Erneut versuchen</a>", status_code=400)
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            tok = await client.post(c["token"], data={
                "grant_type":    "authorization_code",
                "code":          code,
                "redirect_uri":  c["origin"] + "/callback",
                "client_id":     c["client_id"],
                "client_secret": c["client_secret"],
            }, headers={"Accept": "application/json"})
            tok.raise_for_status()
            access = tok.json().get("access_token")
            if not access:
                return HTMLResponse("Kein Access-Token erhalten.", status_code=400)
            prof = await client.get(c["profile"], headers={"Authorization": "Bearer " + access})
            prof.raise_for_status()
            info = prof.json()
    except Exception as e:
        print(f"OIDC callback error: {e}")
        return HTMLResponse("Login fehlgeschlagen. <a href='/login'>Erneut versuchen</a>",
                            status_code=502)

    user = info.get("email") or info.get("preferred_username") or info.get("sub")
    if not _sanitize_user(user or ""):
        return HTMLResponse("Kein Benutzer im OIDC-Profil gefunden.", status_code=400)

    resp = RedirectResponse("/")
    resp.set_cookie(_SESSION_COOKIE, _session_signer().dumps({"user": user}),
                    max_age=_SESSION_MAX_AGE, httponly=True,
                    secure=_cookie_secure(), samesite="lax")
    resp.delete_cookie(_STATE_COOKIE)
    return resp

@app.get("/logout")
async def logout():
    resp = RedirectResponse("/")
    resp.delete_cookie(_SESSION_COOKIE)
    return resp

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
    conn.execute('''CREATE TABLE IF NOT EXISTS ticker_info (
        symbol  TEXT PRIMARY KEY,
        data    TEXT,
        updated REAL
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

@app.get("/api/whoami")
async def whoami(request: Request):
    """Gibt den via Cloudron proxyAuth eingeloggten Benutzer zurück."""
    return JSONResponse(content={"user": get_user(request)})

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

# ── Ticker-Fundamentaldaten (Sektor, MarktCap, …) ───────────────────────────────
# Holt Stammdaten via yfinance (kümmert sich um Yahoo-Crumb/Cookies). Persistiert in
# der User-DB (Tabelle ticker_info), zusätzlich prozessweiter In-Memory-Cache. Strategie:
# „stale-while-revalidate" — gespeicherte Daten werden SOFORT zurückgegeben; sind sie
# älter als die TTL, läuft im Hintergrund eine Auffrischung. So ist nur der allererste
# Abruf je Ticker langsam, danach fühlt es sich instant an (auch nach Server-Neustart).

_TICKER_INFO_CACHE: dict[str, tuple] = {}   # sym -> (timestamp, dict)
_TICKER_INFO_TTL = 12 * 3600
_TICKER_INFO_INFLIGHT: set[str] = set()     # läuft gerade eine (Hintergrund-)Auffrischung?

def _ticker_info_fetch(sym: str) -> dict:
    import yfinance as yf
    info = yf.Ticker(sym).info or {}
    return {
        "symbol":         sym,
        "name":           info.get("longName") or info.get("shortName") or sym,
        "sector":         info.get("sector"),
        "industry":       info.get("industry"),
        "market_cap":     info.get("marketCap"),
        "currency":       info.get("currency"),
        "country":        info.get("country"),
        "exchange":       info.get("fullExchangeName") or info.get("exchange"),
        "quote_type":     info.get("quoteType"),
        "pe":             info.get("trailingPE"),
        "forward_pe":     info.get("forwardPE"),
        "eps":            info.get("trailingEps"),
        "dividend_yield": info.get("dividendYield"),
        "beta":           info.get("beta"),
        "week52_high":    info.get("fiftyTwoWeekHigh"),
        "week52_low":     info.get("fiftyTwoWeekLow"),
        "employees":      info.get("fullTimeEmployees"),
        "website":        info.get("website"),
    }

def _ticker_info_db_get(db_file: str, sym: str):
    """Liefert (data, updated_ts) aus der DB oder (None, 0)."""
    try:
        conn = get_db(db_file)
        row = conn.execute("SELECT data, updated FROM ticker_info WHERE symbol=?", (sym,)).fetchone()
        conn.close()
        if row and row["data"]:
            return json.loads(row["data"]), (row["updated"] or 0)
    except Exception as e:
        print(f"ticker_info db_get {sym}: {e}")
    return None, 0

def _ticker_info_db_put(db_file: str, sym: str, data: dict, ts: float):
    try:
        conn = get_db(db_file)
        conn.execute("INSERT OR REPLACE INTO ticker_info VALUES (?,?,?)",
                     (sym, json.dumps(data), ts))
        conn.commit()
        conn.close()
    except Exception as e:
        print(f"ticker_info db_put {sym}: {e}")

def _ticker_info_refresh(sym: str, db_file: str):
    """Blockierende Auffrischung (yfinance + DB-Write) — im Threadpool/Hintergrund auszuführen."""
    if sym in _TICKER_INFO_INFLIGHT:
        return None
    _TICKER_INFO_INFLIGHT.add(sym)
    try:
        data = _ticker_info_fetch(sym)
        ts = time.time()
        _TICKER_INFO_CACHE[sym] = (ts, data)
        _ticker_info_db_put(db_file, sym, data, ts)
        return data
    except Exception as e:
        # Hintergrund-Auffrischungen laufen unbeaufsichtigt → Fehler nur loggen, nie werfen
        print(f"ticker_info refresh {sym}: {e}")
        return None
    finally:
        _TICKER_INFO_INFLIGHT.discard(sym)

@app.get("/api/ticker/info/{ticker}")
async def ticker_info(ticker: str, request: Request):
    import asyncio
    user  = get_user(request)
    files = get_user_files(user)
    init_db(files["db"])
    sym = (ticker or "").strip().upper()
    if not sym:
        return JSONResponse({"ok": False, "error": "Kein Ticker"}, status_code=400)

    now  = time.time()
    loop = asyncio.get_running_loop()

    # 1) In-Memory-Cache (prozessweit) — frisch → sofort
    cached = _TICKER_INFO_CACHE.get(sym)
    if cached and now - cached[0] < _TICKER_INFO_TTL:
        return JSONResponse({"ok": True, "cached": "mem", **cached[1]})

    # 2) DB — vorhanden → SOFORT zurückgeben; bei Veraltung im Hintergrund auffrischen
    data, updated = _ticker_info_db_get(files["db"], sym)
    if data:
        _TICKER_INFO_CACHE[sym] = (updated, data)
        if now - updated >= _TICKER_INFO_TTL:
            asyncio.ensure_future(loop.run_in_executor(None, _ticker_info_refresh, sym, files["db"]))
        return JSONResponse({"ok": True, "cached": "db", "stale": now - updated >= _TICKER_INFO_TTL, **data})

    # 3) Nichts gespeichert → live holen (erster Abruf je Ticker)
    try:
        result = await loop.run_in_executor(None, _ticker_info_refresh, sym, files["db"])
        if result is None:                       # parallele Auffrischung war schon unterwegs
            result = _TICKER_INFO_CACHE.get(sym, (0, _ticker_info_fetch(sym)))[1]
        return JSONResponse({"ok": True, "cached": False, **result})
    except Exception as e:
        print(f"ticker_info error {sym}: {e}")
        return JSONResponse({"ok": False, "error": str(e)}, status_code=502)


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

# ── IBKR Flex Query Integration ────────────────────────────────────────────────

try:
    from cryptography.fernet import Fernet as _Fernet
    _CRYPTO_OK = True
except ImportError:
    _CRYPTO_OK = False

def _get_ibkr_key(data_dir: str) -> bytes:
    """Gibt Fernet-Key für IBKR-Verschlüsselung zurück, erstellt ihn bei Bedarf."""
    key_file = os.path.join(data_dir, "ibkr.key")
    if os.path.exists(key_file):
        with open(key_file, "rb") as f:
            return f.read().strip()
    if not _CRYPTO_OK:
        return b""
    from cryptography.fernet import Fernet
    key = Fernet.generate_key()
    with open(key_file, "wb") as f:
        f.write(key)
    return key

def _ibkr_encrypt(text: str, data_dir: str) -> str:
    if not _CRYPTO_OK:
        import base64
        return base64.b64encode(text.encode()).decode()
    from cryptography.fernet import Fernet
    return Fernet(_get_ibkr_key(data_dir)).encrypt(text.encode()).decode()

def _ibkr_decrypt(token: str, data_dir: str) -> str:
    if not _CRYPTO_OK:
        import base64
        return base64.b64decode(token.encode()).decode()
    from cryptography.fernet import Fernet
    return Fernet(_get_ibkr_key(data_dir)).decrypt(token.encode()).decode()

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
        isin             TEXT,
        currency         TEXT,
        multiplier       REAL DEFAULT 1.0,
        provisional      INTEGER DEFAULT 0
    )''')
    try:
        conn.execute("ALTER TABLE positions ADD COLUMN fx_rate_to_base REAL DEFAULT 1.0")
    except Exception:
        pass
    try:
        conn.execute("ALTER TABLE positions ADD COLUMN multiplier REAL DEFAULT 1.0")
    except Exception:
        pass
    try:
        conn.execute("ALTER TABLE positions ADD COLUMN provisional INTEGER DEFAULT 0")
    except Exception:
        pass
    try:
        conn.execute("ALTER TABLE positions ADD COLUMN yahoo_symbol TEXT")
    except Exception:
        pass
    try:
        conn.execute("ALTER TABLE positions ADD COLUMN isin TEXT")
    except Exception:
        pass
    try:
        conn.execute("ALTER TABLE positions ADD COLUMN currency TEXT")
    except Exception:
        pass
    conn.execute('''CREATE TABLE IF NOT EXISTS cash_balances (
        currency    TEXT PRIMARY KEY,
        ending_cash REAL,
        last_sync   TEXT
    )''')
    conn.execute('''CREATE TABLE IF NOT EXISTS ibkr_config (
        key   TEXT PRIMARY KEY,
        value TEXT
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
        last_sync      TEXT,
        isin           TEXT
    )''')
    try:
        conn.execute("ALTER TABLE trades ADD COLUMN isin TEXT")
    except Exception:
        pass
    # ISIN → Yahoo-Symbol Mapping (persistent, überlebt geschlossene Positionen)
    # auto: 1 = automatisch aufgelöst (heilt sich beim Sync), 0 = manuell (fix), NULL = alt/unbekannt
    conn.execute('''CREATE TABLE IF NOT EXISTS isin_map (
        isin         TEXT PRIMARY KEY,
        yahoo_symbol TEXT,
        display_name TEXT,
        auto         INTEGER
    )''')
    try:
        conn.execute("ALTER TABLE isin_map ADD COLUMN auto INTEGER")
    except Exception:
        pass
    conn.commit()
    conn.close()

@app.get("/api/ibkr/config/status")
async def ibkr_config_status(request: Request):
    """Gibt Konfig-Status + Query-IDs zurück (Token bleibt geheim)."""
    user  = get_user(request)
    files = get_user_files(user)
    _init_ibkr_tables(files["db"])
    conn  = get_db(files["db"])
    cfg   = {r["key"]: r["value"] for r in conn.execute("SELECT key, value FROM ibkr_config").fetchall()}
    conn.close()
    def _dec(k):
        try:
            return _ibkr_decrypt(cfg[k], files["data_dir"]) if k in cfg else ""
        except Exception:
            return ""
    return JSONResponse(content={
        "configured":        "flex_token" in cfg and "query_id" in cfg,
        "trades_configured": "query_id_trades" in cfg,
        "tax_configured":    "flex_token" in cfg and "query_id_tax" in cfg,
        "query_id":          _dec("query_id"),          # Query-IDs sind nicht geheim
        "query_id_trades":   _dec("query_id_trades"),
        "query_id_tax":      _dec("query_id_tax"),
    })

@app.post("/api/ibkr/config")
async def set_ibkr_config(request: Request):
    """Speichert Flex Token + Query-ID(s) AES-verschlüsselt.

    Token ist optional, sofern bereits einer gespeichert ist (wird nie im Klartext
    zurückgegeben). `query_id_trades` (Handelsbestätigungen) ist optional — leer = entfernen.
    """
    user  = get_user(request)
    files = get_user_files(user)
    _init_ibkr_tables(files["db"])
    body  = await request.json()
    token      = (body.get("flex_token")      or "").strip()
    qid        = (body.get("query_id")        or "").strip()
    qid_trades = (body.get("query_id_trades") or "").strip()
    qid_tax    = (body.get("query_id_tax")    or "").strip()

    conn     = get_db(files["db"])
    existing = {r["key"] for r in conn.execute("SELECT key FROM ibkr_config").fetchall()}
    if not token and "flex_token" not in existing:
        conn.close()
        return JSONResponse({"ok": False, "error": "flex_token erforderlich"}, status_code=400)
    if not qid:
        conn.close()
        return JSONResponse({"ok": False, "error": "query_id erforderlich"}, status_code=400)

    if token:
        conn.execute("INSERT OR REPLACE INTO ibkr_config VALUES ('flex_token', ?)",
                     (_ibkr_encrypt(token, files["data_dir"]),))
    conn.execute("INSERT OR REPLACE INTO ibkr_config VALUES ('query_id', ?)",
                 (_ibkr_encrypt(qid, files["data_dir"]),))
    if qid_trades:
        conn.execute("INSERT OR REPLACE INTO ibkr_config VALUES ('query_id_trades', ?)",
                     (_ibkr_encrypt(qid_trades, files["data_dir"]),))
    else:
        conn.execute("DELETE FROM ibkr_config WHERE key='query_id_trades'")
    if qid_tax:
        conn.execute("INSERT OR REPLACE INTO ibkr_config VALUES ('query_id_tax', ?)",
                     (_ibkr_encrypt(qid_tax, files["data_dir"]),))
    else:
        conn.execute("DELETE FROM ibkr_config WHERE key='query_id_tax'")
    conn.commit()
    conn.close()
    return JSONResponse({"ok": True})

def _flex_fetch_csv(flex_token: str, query_id: str) -> tuple:
    """Holt eine Flex-Query als CSV-Text. Gibt (csv_text, error) zurück (eins ist None)."""
    import time as time_
    import urllib.request as urlreq
    import urllib.error

    # Step 1: SendRequest → ReferenceCode (bis zu 3 Versuche, 10s Pause)
    url1 = f"https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/SendRequest?v=3&t={flex_token}&q={query_id}"
    ref_code = None
    last_err = ""
    for attempt1 in range(3):
        try:
            req1 = urlreq.Request(url1, headers={"User-Agent": "Mozilla/5.0"})
            with urlreq.urlopen(req1, timeout=30) as resp:
                xml1 = resp.read().decode("utf-8")
        except urllib.error.URLError as e:
            last_err = f"SendRequest fehlgeschlagen: {e}"
            if attempt1 < 2:
                time_.sleep(10)
                continue
            return None, last_err

        print(f"[IBKR] SendRequest Antwort (Versuch {attempt1+1}): {xml1[:500]}")
        m = re.search(r"<ReferenceCode>(\w+)</ReferenceCode>", xml1)
        if m:
            ref_code = m.group(1)
            break

        err_m   = re.search(r"<ErrorMessage>([^<]+)</ErrorMessage>", xml1)
        last_err = err_m.group(1) if err_m else xml1[:300]
        if attempt1 < 2:
            time_.sleep(10)

    if not ref_code:
        return None, f"Kein ReferenceCode: {last_err}"

    # Step 2: GetStatement — retry bis zu 5× bei "Processing"
    for attempt in range(5):
        url2 = f"https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/GetStatement?v=3&t={flex_token}&q={ref_code}"
        try:
            req2 = urlreq.Request(url2, headers={"User-Agent": "Mozilla/5.0"})
            with urlreq.urlopen(req2, timeout=30) as resp:
                content = resp.read().decode("utf-8")
        except urllib.error.URLError as e:
            return None, f"GetStatement fehlgeschlagen: {e}"

        if "<ErrorCode>1019</ErrorCode>" in content or "<Status>Processing</Status>" in content:
            if attempt < 4:
                time_.sleep(5)
                continue
            return None, "IBKR verarbeitet noch — bitte in 30s erneut versuchen"
        return content, None

    return None, "Leere Antwort von IBKR"

def _parse_trade_confirmations(csv_text: str, now: str, fx_by_ccy: dict) -> list:
    """Parst das *flache* Trade-Confirmation-CSV (eine Header-Zeile, keine Sektionen).

    Liefert dieselben trade_rows-Tupel wie der Activity-Parser, gekeyt auf TradeID,
    sodass der T+1-Activity-Sync sie per INSERT OR REPLACE ersetzt. FXRateToBase fehlt
    im Confirmation-CSV → Kurs aus den Positionen ableiten (fx_by_ccy), sonst 1.0.
    """
    import csv as csv_mod
    rows = []
    cols = None
    for raw_line in csv_text.splitlines():
        if not raw_line.strip():
            continue
        try:
            parts = next(csv_mod.reader([raw_line]))
        except Exception:
            continue
        if cols is None:                       # erste nicht-leere Zeile = Header
            cols = {name: i for i, name in enumerate(parts)}
            continue
        def g(name, default=""):
            i = cols.get(name, -1)
            return parts[i].strip() if 0 <= i < len(parts) else default
        # Nur Ausführungen (keine Order-Aggregate), nur echte Trades
        if g("LevelOfDetail").upper() not in ("", "EXECUTION"):
            continue
        symbol = g("Symbol")
        tid    = g("TradeID")
        if not symbol or not tid:
            continue
        try:
            qty = float(g("Quantity", "0").replace(",", "") or "0")
            prc = float(g("Price",    "0").replace(",", "") or "0")
            val = float(g("Proceeds", "0").replace(",", "") or "0")
            com = float(g("Commission", "0").replace(",", "") or "0")
        except ValueError:
            continue
        action   = g("Buy/Sell")
        currency = g("CurrencyPrimary")
        fx       = fx_by_ccy.get(currency.upper(), 1.0) if currency else 1.0
        raw_date = g("TradeDate")
        if len(raw_date) == 8 and raw_date.isdigit():
            trade_date = f"{raw_date[:4]}-{raw_date[4:6]}-{raw_date[6:]}"
        else:
            trade_date = raw_date[:10]
        rows.append((tid, symbol, action, abs(qty), prc, abs(val), com,
                     currency, fx, trade_date, g("AssetClass"), now, g("ISIN")))
    return rows

def _xml_float(el, name, default=0.0):
    v = el.get(name, "")
    try:
        return float(v) if v not in ("", None) else default
    except (ValueError, TypeError):
        return default

def _xml_date(raw):
    raw = (raw or "").strip()
    if len(raw) == 8 and raw.isdigit():
        return f"{raw[:4]}-{raw[4:6]}-{raw[6:]}"
    return raw[:10]

def _parse_activity_xml(xml_text: str, now: str):
    """Parst die Activity-Flex-*XML* (OpenPositions / CashReport / Trades).

    Liefert (positions, cash_rows, trade_rows) im selben Tupel-Format wie der CSV-Parser.
    """
    import xml.etree.ElementTree as ET
    positions, cash_rows, trade_rows = [], [], []
    try:
        root = ET.fromstring(xml_text)
    except Exception as e:
        print(f"[IBKR] XML-Parse-Fehler (Activity): {e}")
        return positions, cash_rows, trade_rows

    for el in root.iter("OpenPosition"):
        sym = (el.get("symbol") or "").strip()
        if not sym:
            continue
        positions.append((
            sym, _xml_float(el, "position"), _xml_float(el, "costBasisPrice"),
            _xml_float(el, "costBasisMoney"), _xml_float(el, "markPrice"),
            _xml_float(el, "positionValue"), (el.get("assetCategory") or "").strip(),
            now, _xml_float(el, "fxRateToBase", 1.0) or 1.0, (el.get("isin") or "").strip(),
            (el.get("currency") or "").strip(), _xml_float(el, "multiplier", 1.0) or 1.0))

    for el in root.iter("CashReportCurrency"):
        cur = (el.get("currency") or "").strip()
        if not cur:
            continue
        key = "BASE" if cur == "BASE_SUMMARY" else cur
        cash_rows.append((key, _xml_float(el, "endingCash"), now))

    for el in root.iter("Trade"):
        sym = (el.get("symbol") or "").strip()
        action = (el.get("buySell") or "").strip()
        if not sym or not action:
            continue
        lod = (el.get("levelOfDetail") or "").upper()
        if lod and lod != "EXECUTION":          # Order-/Lot-Aggregate überspringen
            continue
        td  = _xml_date(el.get("tradeDate"))
        tid = (el.get("tradeID") or "").strip() or f"{sym}_{td}_{action}_{el.get('quantity')}_{el.get('tradePrice')}"
        val = el.get("tradeMoney")
        if val in ("", None):
            val = el.get("proceeds")
        try:
            valf = abs(float(val)) if val not in ("", None) else 0.0
        except (ValueError, TypeError):
            valf = 0.0
        trade_rows.append((
            tid, sym, action, abs(_xml_float(el, "quantity")), _xml_float(el, "tradePrice"),
            valf, _xml_float(el, "ibCommission"), (el.get("currency") or "").strip(),
            _xml_float(el, "fxRateToBase", 1.0) or 1.0, td,
            (el.get("assetCategory") or "").strip(), now, (el.get("isin") or "").strip()))

    return positions, cash_rows, trade_rows

def _parse_confirmations_xml(xml_text: str, now: str, fx_by_ccy: dict) -> list:
    """Parst die Trade-Confirmation-Flex-*XML* (<TradeConfirm levelOfDetail=EXECUTION>).

    <Order>-Aggregate werden ignoriert (anderer Tag). Format wie _parse_trade_confirmations.
    """
    import xml.etree.ElementTree as ET
    rows = []
    try:
        root = ET.fromstring(xml_text)
    except Exception as e:
        print(f"[IBKR] XML-Parse-Fehler (Confirmations): {e}")
        return rows
    for el in root.iter("TradeConfirm"):
        lod = (el.get("levelOfDetail") or "").upper()
        if lod and lod != "EXECUTION":
            continue
        sym = (el.get("symbol") or "").strip()
        tid = (el.get("tradeID") or "").strip()
        if not sym or not tid:
            continue
        ccy = (el.get("currency") or "").strip()
        fx  = fx_by_ccy.get(ccy.upper(), 1.0) if ccy else 1.0
        rows.append((
            tid, sym, (el.get("buySell") or "").strip(), abs(_xml_float(el, "quantity")),
            _xml_float(el, "price"), abs(_xml_float(el, "proceeds")), _xml_float(el, "commission"),
            ccy, fx, _xml_date(el.get("tradeDate")), (el.get("assetCategory") or "").strip(),
            now, (el.get("isin") or "").strip()))
    return rows

def _confirmation_position_deltas(conf_text: str, activity_tids: set, fx_by_ccy: dict) -> dict:
    """Aggregiert die noch-nicht-abgerechneten Confirmation-Trades (TradeID NICHT in der
    Activity) je Symbol → Mengen-/Kostenbasis-Änderung für taggleiche Positionen.

    Die Activity-OpenPositions sind EOD/gestern; heutige Trades (in der Confirmation,
    aber noch nicht in der Activity) werden so auf den gestrigen Stand angerechnet.
    Morgen stehen sie in der Activity → TradeID dann bekannt → nicht mehr addiert.
    """
    recs = {}
    def add(tid, sym, action, qty, price, mult, ccy, isin, cls):
        if not sym or not tid or tid in activity_tids:
            return
        mult = mult or 1.0
        fx   = fx_by_ccy.get((ccy or "").upper(), 1.0) if ccy else 1.0
        signed = abs(qty) if "BUY" in (action or "").upper() else -abs(qty)
        d = recs.setdefault(sym, {"signed_qty": 0.0, "last_price": price, "multiplier": mult,
                                  "currency": ccy, "fx": fx, "isin": isin, "asset_class": cls,
                                  "cost_delta_ccy": 0.0})
        d["signed_qty"]    += signed
        d["last_price"]     = price or d["last_price"]
        d["multiplier"]     = mult
        d["fx"]             = fx
        # Kostenbasis-Effekt in HANDELSwährung (positions speichert roh, FX erst bei Anzeige):
        # BUY +Wert, SELL -Wert
        val_ccy = abs(price * abs(qty) * mult)
        d["cost_delta_ccy"] += val_ccy if signed > 0 else -val_ccy

    if conf_text.lstrip()[:1] == "<":
        import xml.etree.ElementTree as ET
        try:
            root = ET.fromstring(conf_text)
        except Exception:
            return recs
        for el in root.iter("TradeConfirm"):
            lod = (el.get("levelOfDetail") or "").upper()
            if lod and lod != "EXECUTION":
                continue
            add((el.get("tradeID") or "").strip(), (el.get("symbol") or "").strip(),
                el.get("buySell"), _xml_float(el, "quantity"), _xml_float(el, "price"),
                _xml_float(el, "multiplier", 1.0), (el.get("currency") or "").strip(),
                (el.get("isin") or "").strip(), (el.get("assetCategory") or "").strip())
    else:
        import csv as _csv
        cols = None
        for raw in conf_text.splitlines():
            if not raw.strip():
                continue
            try:
                p = next(_csv.reader([raw]))
            except Exception:
                continue
            if cols is None:
                cols = {n: i for i, n in enumerate(p)}
                continue
            def g(n, d=""):
                i = cols.get(n, -1)
                return p[i].strip() if 0 <= i < len(p) else d
            if g("LevelOfDetail").upper() not in ("", "EXECUTION"):
                continue
            try:
                qty  = float(g("Quantity", "0").replace(",", "") or "0")
                prc  = float(g("Price",    "0").replace(",", "") or "0")
                mult = float(g("Multiplier", "1").replace(",", "") or "1")
            except ValueError:
                continue
            add(g("TradeID"), g("Symbol"), g("Buy/Sell"), qty, prc, mult,
                g("CurrencyPrimary"), g("ISIN"), g("AssetClass"))
    return recs

def _do_ibkr_sync(db_file: str, data_dir: str) -> dict:
    """Blockierender IBKR-Sync — läuft im ThreadPoolExecutor."""
    import csv as csv_mod
    import datetime as dt_
    import urllib.request as urlreq
    import urllib.error

    conn = get_db(db_file)
    cfg  = {r["key"]: r["value"] for r in conn.execute("SELECT key, value FROM ibkr_config").fetchall()}
    conn.close()

    if "flex_token" not in cfg or "query_id" not in cfg:
        return {"ok": False, "error": "IBKR nicht konfiguriert"}

    flex_token = _ibkr_decrypt(cfg["flex_token"], data_dir)
    query_id   = _ibkr_decrypt(cfg["query_id"],   data_dir)

    csv_text, err = _flex_fetch_csv(flex_token, query_id)
    if err:
        return {"ok": False, "error": err}

    now = dt_.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
    positions  = []
    cash_rows  = []
    trade_rows = []
    is_xml = csv_text.lstrip()[:1] == "<"

    if is_xml:
        positions, cash_rows, trade_rows = _parse_activity_xml(csv_text, now)

    # CSV-Fallback (HEADER/DATA-Sektionsformat) — bei XML übersprungen
    section_headers: dict = {}
    for raw_line in (csv_text.splitlines() if not is_xml else []):
        if not raw_line.strip():
            continue
        try:
            reader = csv_mod.reader([raw_line])
            parts  = next(reader)
        except Exception:
            continue
        if len(parts) < 2:
            continue
        row_type = parts[0]
        section  = parts[1]

        if row_type == "HEADER":
            section_headers[section] = {name: i for i, name in enumerate(parts)}
            print(f"[IBKR] Sektion gefunden: {section} ({len(parts)} Spalten)")
            continue
        if row_type != "DATA":
            continue

        cols = section_headers.get(section)
        if not cols:
            continue

        # ── CRTT: Cash Report ──────────────────────────────────────────
        if section == "CRTT":
            i_cur = cols.get("CurrencyPrimary", -1)
            i_lod = cols.get("LevelOfDetail",   -1)
            i_ec  = cols.get("EndingCash",       -1)
            if i_cur < 0 or i_ec < 0:
                continue
            lod      = parts[i_lod].strip() if 0 <= i_lod < len(parts) else ""
            currency = parts[i_cur].strip() if i_cur < len(parts) else ""
            if not currency:
                continue
            # "Currency" → native rows; "BaseCurrency" → total in base stored as "BASE"
            if lod == "Currency":
                key = currency
            elif lod == "BaseCurrency":
                key = "BASE"
            else:
                continue
            try:
                ending_cash = float(parts[i_ec].strip() or "0") if i_ec < len(parts) else 0.0
            except ValueError:
                continue
            cash_rows.append((key, ending_cash, now))
            continue

        # ── TRNT / Trade: Trades ───────────────────────────────────────
        if section in ("TRNT", "Trade", "Trades"):
            # TradeID als Dedup-Key (deckt sich mit der Trade-Confirmation-Query),
            # Fallback TransactionID, dann synthetisch.
            i_tid  = cols.get("TradeID", cols.get("TransactionID", -1))
            i_sym  = cols.get("Symbol", -1)
            i_act  = cols.get("Buy/Sell", cols.get("Action", -1))
            i_qty  = cols.get("Quantity", -1)
            i_prc  = cols.get("TradePrice", -1)
            i_val  = cols.get("TradeMoney", cols.get("Proceeds", -1))
            i_com  = cols.get("IBCommission", -1)
            i_cur  = cols.get("CurrencyPrimary", cols.get("Currency", -1))
            i_fx   = cols.get("FXRateToBase", -1)
            i_dat  = cols.get("TradeDate", -1)
            i_cls  = cols.get("AssetClass", -1)
            i_lod  = cols.get("LevelOfDetail", -1)
            i_isin = cols.get("ISIN", -1)
            if i_sym < 0 or i_qty < 0 or i_prc < 0:
                continue
            # Dividenden/Corporate Actions herausfiltern (kein TradePrice)
            if i_lod >= 0 and i_lod < len(parts):
                lod_val = parts[i_lod].strip().upper()
                if lod_val and lod_val in ("DIVIDENDACCRUAL", "DIVIDEND", "INTEREST"):
                    continue
            symbol = parts[i_sym].strip() if i_sym < len(parts) else ""
            if not symbol:
                continue
            try:
                qty    = float(parts[i_qty].strip().replace(",", "") or "0") if i_qty < len(parts) else 0.0
                prc    = float(parts[i_prc].strip().replace(",", "") or "0") if i_prc < len(parts) else 0.0
                val    = float(parts[i_val].strip().replace(",", "") or "0") if 0 <= i_val < len(parts) else 0.0
                com    = float(parts[i_com].strip().replace(",", "") or "0") if 0 <= i_com < len(parts) else 0.0
                fx     = float(parts[i_fx ].strip().replace(",", "") or "1") if 0 <= i_fx  < len(parts) else 1.0
            except ValueError:
                continue
            action     = parts[i_act].strip() if 0 <= i_act < len(parts) else ""
            currency   = parts[i_cur].strip() if 0 <= i_cur < len(parts) else ""
            asset_cls  = parts[i_cls].strip() if 0 <= i_cls < len(parts) else ""
            isin       = parts[i_isin].strip() if 0 <= i_isin < len(parts) else ""
            # TradeDate: YYYYMMDD → YYYY-MM-DD
            raw_date   = parts[i_dat].strip() if 0 <= i_dat < len(parts) else ""
            if len(raw_date) == 8 and raw_date.isdigit():
                trade_date = f"{raw_date[:4]}-{raw_date[4:6]}-{raw_date[6:]}"
            else:
                trade_date = raw_date[:10]
            # TransactionID — Fallback: symbol+date+action+qty
            if i_tid >= 0 and i_tid < len(parts) and parts[i_tid].strip():
                tid = parts[i_tid].strip()
            else:
                tid = f"{symbol}_{trade_date}_{action}_{qty}_{prc}"
            trade_rows.append((tid, symbol, action, abs(qty), prc, abs(val), com, currency, fx, trade_date, asset_cls, now, isin))
            continue

        # ── POST: Positionen ───────────────────────────────────────────
        i_sym = cols.get("Symbol", -1)
        i_qty = cols.get("Quantity", cols.get("Position", -1))
        i_mkp = cols.get("MarkPrice", -1)
        i_pv  = cols.get("PositionValue", -1)
        i_cbp = cols.get("CostBasisPrice", cols.get("OpenPrice", -1))
        i_cbm = cols.get("CostBasisMoney", -1)
        i_cls = cols.get("AssetClass", -1)
        i_fx  = cols.get("FXRateToBase", -1)
        i_isin = cols.get("ISIN", -1)
        i_cur  = cols.get("CurrencyPrimary", cols.get("Currency", -1))
        i_mul  = cols.get("Multiplier", -1)

        if i_sym < 0 or i_qty < 0 or i_mkp < 0:
            continue

        symbol = parts[i_sym].strip() if i_sym < len(parts) else ""
        if not symbol:
            continue
        try:
            qty    = float(parts[i_qty].strip() or "0") if i_qty < len(parts) else 0.0
            mrkp   = float(parts[i_mkp].strip() or "0") if i_mkp < len(parts) else 0.0
            posval = float(parts[i_pv ].strip() or "0") if 0 <= i_pv  < len(parts) else 0.0
            cbp    = float(parts[i_cbp].strip() or "0") if 0 <= i_cbp < len(parts) else 0.0
            cbm    = float(parts[i_cbm].strip() or "0") if 0 <= i_cbm < len(parts) else 0.0
            fx     = float(parts[i_fx ].strip() or "1") if 0 <= i_fx  < len(parts) else 1.0
            mult   = float(parts[i_mul].strip() or "1") if 0 <= i_mul < len(parts) else 1.0
        except ValueError:
            continue
        if mult == 0:
            mult = 1.0
        asset_class = parts[i_cls].strip() if 0 <= i_cls < len(parts) else ""
        isin        = parts[i_isin].strip() if 0 <= i_isin < len(parts) else ""
        currency    = parts[i_cur].strip() if 0 <= i_cur < len(parts) else ""
        positions.append((symbol, qty, cbp, cbm, mrkp, posval, asset_class, now, fx, isin, currency, mult))

    print(f"[IBKR] Positionen: {len(positions)}, Cash: {len(cash_rows)}, Trades: {len(trade_rows)}")
    if not positions and not cash_rows and not trade_rows:
        return {"ok": False, "error": "Keine Daten gefunden — prüfe Flex-Query-Konfiguration"}

    conn = get_db(db_file)
    conn.execute("DELETE FROM positions")
    if positions:
        conn.executemany(
            "INSERT OR REPLACE INTO positions "
            "(symbol,quantity,cost_basis_price,cost_basis_money,mark_price,position_value,asset_class,last_sync,fx_rate_to_base,isin,currency,multiplier) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", positions)
    conn.execute("DELETE FROM cash_balances")
    if cash_rows:
        conn.executemany("INSERT OR REPLACE INTO cash_balances VALUES (?,?,?)", cash_rows)
    if trade_rows:
        # Migration/Cleanup: alte (per TransactionID gekeyte) Duplikate im Activity-Fenster
        # entfernen, bevor die per TradeID gekeyten Rows neu eingespielt werden. Trades
        # ausserhalb des Fensters (aelter) bleiben unangetastet.
        min_date = min(t[9] for t in trade_rows if t[9])
        if min_date:
            conn.execute("DELETE FROM trades WHERE trade_date >= ?", (min_date,))
        conn.executemany(
            "INSERT OR REPLACE INTO trades "
            "(transaction_id,symbol,action,quantity,price,value,commission,currency,fx_rate,trade_date,asset_class,last_sync,isin) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", trade_rows)
    conn.commit()

    # ── Trade-Confirmations (2. Flex-Query): taggleiche Trades ──────────────────────
    # Separate Query (gleicher Token), XML oder flaches CSV. Per TradeID gekeyt → die
    # T+1-Activity-Trades ersetzen sie spaeter mit korrektem FXRateToBase. INSERT OR
    # IGNORE, damit bereits vorhandene (authoritative) Activity-Rows nicht ueberschrieben werden.
    conf_count = 0
    if "query_id_trades" in cfg:
        try:
            qid_trades = _ibkr_decrypt(cfg["query_id_trades"], data_dir)
            conf_csv, conf_err = _flex_fetch_csv(flex_token, qid_trades)
            if conf_err:
                print(f"[IBKR] Trade-Confirmations uebersprungen: {conf_err}")
            else:
                # FX je Waehrung: zuletzt gesyncte Trades (deckt z.B. USD-Futures ohne
                # offene USD-Position ab), Positionen ueberschreiben (aktuellster Kurs).
                fx_by_ccy = {}
                for r in conn.execute("SELECT currency, fx_rate FROM trades "
                                      "WHERE fx_rate IS NOT NULL ORDER BY trade_date").fetchall():
                    c = (r["currency"] or "").upper()
                    if c and r["fx_rate"]:
                        fx_by_ccy[c] = r["fx_rate"]
                for p in positions:
                    if p[10] and p[8]:
                        fx_by_ccy[(p[10] or "").upper()] = p[8]
                if conf_csv.lstrip()[:1] == "<":
                    conf_rows = _parse_confirmations_xml(conf_csv, now, fx_by_ccy)
                else:
                    conf_rows = _parse_trade_confirmations(conf_csv, now, fx_by_ccy)
                if conf_rows:
                    conn.executemany(
                        "INSERT OR IGNORE INTO trades "
                        "(transaction_id,symbol,action,quantity,price,value,commission,currency,fx_rate,trade_date,asset_class,last_sync,isin) "
                        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", conf_rows)
                    conn.commit()
                    conf_count = len(conf_rows)
                print(f"[IBKR] Trade-Confirmations: {conf_count} Rows")

                # ── Taggleiche Positionen: heutige Confirmation-Trades (TradeID noch nicht
                # in der Activity) auf den EOD-Stand anrechnen. Self-healing: morgen stehen
                # sie in der Activity → werden nicht mehr addiert. Provisorische Rows = provisional=1.
                activity_tids = {t[0] for t in trade_rows}
                deltas = _confirmation_position_deltas(conf_csv, activity_tids, fx_by_ccy)
                prov_n = 0
                for sym, a in deltas.items():
                    row = conn.execute(
                        "SELECT quantity, mark_price, multiplier, fx_rate_to_base, cost_basis_money "
                        "FROM positions WHERE symbol=?", (sym,)).fetchone()
                    if row:
                        new_qty = (row["quantity"] or 0) + a["signed_qty"]
                        if abs(new_qty) < 1e-9:
                            conn.execute("DELETE FROM positions WHERE symbol=?", (sym,))
                        else:
                            mult = row["multiplier"] or a["multiplier"] or 1.0
                            mark = row["mark_price"] or a["last_price"]
                            fx   = row["fx_rate_to_base"] or a["fx"]
                            # position_value/cost_basis_money in HANDELSwährung (roh, ohne fx)
                            conn.execute(
                                "UPDATE positions SET quantity=?, position_value=?, cost_basis_money=?, "
                                "provisional=1, last_sync=? WHERE symbol=?",
                                (new_qty, new_qty * mark * mult,
                                 (row["cost_basis_money"] or 0) + a["cost_delta_ccy"], now, sym))
                        prov_n += 1
                    elif abs(a["signed_qty"]) > 1e-9:
                        qty, price, mult, fx = a["signed_qty"], a["last_price"], a["multiplier"] or 1.0, a["fx"]
                        conn.execute(
                            "INSERT OR REPLACE INTO positions "
                            "(symbol,quantity,cost_basis_price,cost_basis_money,mark_price,position_value,"
                            "asset_class,last_sync,fx_rate_to_base,isin,currency,multiplier,provisional) "
                            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1)",
                            (sym, qty, price, a["cost_delta_ccy"], price, qty * price * mult,
                             a["asset_class"], now, fx, a["isin"], a["currency"], mult))
                        prov_n += 1
                if prov_n:
                    conn.commit()
                    print(f"[IBKR] Taggleiche Positionen angepasst: {prov_n}")
        except Exception as e:
            print(f"[IBKR] Trade-Confirmations Fehler: {e}")

    # ISIN → Yahoo-Symbol automatisch auflösen (Mapping aus der CSV ableiten).
    # Nur fehlende oder auto-aufgelöste Einträge — manuelle (auto=0) bleiben fix.
    # USD-Positionen nutzen das blanke Symbol (US-Listing nutzt kein Yahoo-Suffix);
    # sonst Yahoo-Suche per ISIN (liefert i.d.R. die Heimatbörse, passt zu EUR/GBP).
    try:
        existing = {r["isin"]: r["auto"] for r in conn.execute("SELECT isin, auto FROM isin_map").fetchall()}
        seen = set()
        for prow in positions:
            p_sym, p_cls, p_isin, p_cur = prow[0], (prow[6] or "").upper(), prow[9], (prow[10] or "").upper()
            if p_cls != "STK" or not p_isin or p_isin in seen:
                continue
            if p_isin in existing and existing[p_isin] == 0:   # manuell → nicht anfassen
                continue
            seen.add(p_isin)
            ysym = None
            if p_cur == "USD":
                ysym = p_sym
            else:
                try:
                    u  = f"https://query1.finance.yahoo.com/v1/finance/search?q={p_isin}&quotesCount=5"
                    rq = urlreq.Request(u, headers={"User-Agent": "Mozilla/5.0"})
                    with urlreq.urlopen(rq, timeout=6) as rp:
                        jd = json.loads(rp.read())
                    for q in jd.get("quotes", []):
                        if q.get("quoteType") in ("EQUITY", "ETF") and q.get("symbol"):
                            ysym = q["symbol"]
                            break
                except Exception:
                    ysym = None
            if ysym:
                conn.execute(
                    "INSERT INTO isin_map (isin, yahoo_symbol, display_name, auto) VALUES (?,?,NULL,1) "
                    "ON CONFLICT(isin) DO UPDATE SET yahoo_symbol=excluded.yahoo_symbol, auto=1",
                    (p_isin, ysym))
                print(f"[IBKR] ISIN {p_isin} → {ysym} (auto, {p_cur})")
        conn.commit()
    except Exception as e:
        print(f"[IBKR] ISIN auto-resolve übersprungen: {e}")

    conn.close()
    return {"ok": True, "count": len(positions), "cash_count": len(cash_rows),
            "trade_count": len(trade_rows), "confirm_count": conf_count, "last_sync": now}


@app.get("/api/ibkr/sync")
async def ibkr_sync(request: Request):
    """IBKR Flex Query: Positionen und Cash-Salden synchronisieren."""
    import asyncio
    user  = get_user(request)
    files = get_user_files(user)
    _init_ibkr_tables(files["db"])
    try:
        loop   = asyncio.get_running_loop()
        result = await loop.run_in_executor(None, _do_ibkr_sync, files["db"], files["data_dir"])
        return JSONResponse(content=result, status_code=200 if result.get("ok") else 502)
    except Exception as e:
        print(f"ibkr_sync error: {e}")
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)

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

@app.get("/api/ibkr/isin-map")
async def ibkr_isin_map(request: Request):
    """ISIN → Yahoo-Symbol Mapping als JSON-Liste."""
    user  = get_user(request)
    files = get_user_files(user)
    _init_ibkr_tables(files["db"])
    conn  = get_db(files["db"])
    rows  = conn.execute("SELECT * FROM isin_map ORDER BY isin").fetchall()
    conn.close()
    return JSONResponse(content=[dict(r) for r in rows])

@app.post("/api/ibkr/isin-map")
async def set_ibkr_isin_map(request: Request):
    """Upsert eines ISIN → Yahoo-Symbol Mappings."""
    user  = get_user(request)
    files = get_user_files(user)
    _init_ibkr_tables(files["db"])
    body  = await request.json()
    isin  = (body.get("isin") or "").strip().upper()
    if not isin:
        return JSONResponse({"ok": False, "error": "isin erforderlich"}, status_code=400)
    yahoo_sym = (body.get("yahoo_symbol") or "").strip().upper() or None
    display   = (body.get("display_name") or "").strip() or None
    conn = get_db(files["db"])
    conn.execute(
        "INSERT INTO isin_map (isin, yahoo_symbol, display_name, auto) VALUES (?,?,?,0) "
        "ON CONFLICT(isin) DO UPDATE SET yahoo_symbol=excluded.yahoo_symbol, display_name=excluded.display_name, auto=0",
        (isin, yahoo_sym, display))
    conn.commit()
    conn.close()
    return JSONResponse({"ok": True})

@app.get("/api/ibkr/isin-resolve/{isin}")
async def ibkr_isin_resolve(isin: str, request: Request):
    """Schlägt via Yahoo-Suche ein Symbol für eine ISIN vor (Auto-Mapping)."""
    try:
        import urllib.request
        url = f"https://query1.finance.yahoo.com/v1/finance/search?q={isin.strip()}&quotesCount=5"
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read())
        results = [
            {"symbol": q["symbol"], "name": q.get("shortname", q.get("longname", "")),
             "exchange": q.get("exchDisp", "")}
            for q in data.get("quotes", [])
            if q.get("quoteType") in ("EQUITY", "ETF")
        ]
        return JSONResponse(content=results)
    except Exception as e:
        print(f"ISIN resolve error for {isin}: {e}")
        return JSONResponse(content=[])

# ── Deutscher Steuer-Report (IBKR Activity Statements → Anlage KAP) ─────────────
# Stateless: Uploads werden geparst und sofort zurückgegeben, nichts gespeichert.
# Berechnung in tax_engine.py: FIFO über die ganze Historie + EUR-Umrechnung pro
# Trade (ECB-Kurse), Split-Anpassung, getrennt nach Aktien / Termingeschäften.

@app.post("/api/tax/report")
async def tax_report(request: Request, files: list[UploadFile] = File(default=[]), year: str = ""):
    """
    Nimmt EIN ODER MEHRERE IBKR Activity Statements (CSV, alle Jahre seit Depot-
    eröffnung) entgegen und berechnet die Anlage-KAP-relevanten Werte für ein
    Steuerjahr: FIFO über die ganze Historie mit EUR-Umrechnung pro Bein (ECB-Kurse),
    Split-Anpassung, getrennt nach Aktien / Termingeschäften.
    Hochgeladene Dateien werden pro User gespeichert (Sorte "csv", geteilt mit
    Steuer +); ohne Upload wird der gespeicherte Bestand verwendet (Auto-Laden).
    Der FX-Cache liegt pro User im Datenverzeichnis (historische Kurse sind fix).
    """
    import asyncio
    import tax_engine
    user  = get_user(request)
    files_u = get_user_files(user)
    fx_cache = os.path.join(files_u["data_dir"], "fx_cache")
    os.makedirs(fx_cache, exist_ok=True)

    texts, source = await _tax_collect_texts(user, "csv", files)
    if not texts:
        return JSONResponse({"ok": False, "no_files": True,
                             "error": "Keine gespeicherten Dateien — bitte CSV hochladen."})

    def _run():
        return tax_engine.compute_tax_report(texts, target_year=(year or None), cache_dir=fx_cache)

    try:
        loop = asyncio.get_running_loop()
        result = await loop.run_in_executor(None, _run)   # FX-Fetch blockiert → Threadpool
        if not result.get("year"):
            return JSONResponse(
                {"ok": False, "error": "Kein Steuerjahr erkannt — sind das IBKR Activity "
                                       "Statements (CSV)?"}, status_code=422)
        return JSONResponse({"ok": True, "source": source,
                             "stored_files": _tax_store_list(user, "csv"), **result})
    except Exception as e:
        print(f"tax_report error: {e}")
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)


# ── Steuer ++ : Berechnung aus IBKR Flex *XML* (Closed Lots) ─────────────────────
# Nutzt IBKRs autoritatives Lot-Matching (Detailgrad „Closed Lots") + EZB-FX pro Bein.
# Transparenter & korrekter als die CSV-Variante: echte Klassifikation (Aktien/ETF/
# Futures via subCategory), DE/Ausland-Split, Devisen (Regel F) pro Lot, prüffähiges
# Journal. Berechnung in tax_engine_xml.py. Stateless.

@app.post("/api/tax/report-xml")
async def tax_report_xml(request: Request, files: list[UploadFile] = File(default=[]), year: str = ""):
    import asyncio
    import tax_engine_xml
    user  = get_user(request)
    files_u = get_user_files(user)
    fx_cache = os.path.join(files_u["data_dir"], "fx_cache")
    os.makedirs(fx_cache, exist_ok=True)

    # Sorte "xml" wird mit Steuer +++ geteilt; ohne Upload Auto-Laden des Bestands.
    texts, source = await _tax_collect_texts(user, "xml", files)
    if not texts:
        return JSONResponse({"ok": False, "no_files": True,
                             "error": "Keine gespeicherten Dateien — bitte Flex-XML hochladen."})

    def _run():
        return tax_engine_xml.compute_tax_report_xml(
            texts, target_year=(year or None), cache_dir=fx_cache)

    try:
        loop = asyncio.get_running_loop()
        result = await loop.run_in_executor(None, _run)   # FX-Fetch blockiert → Threadpool
        if not result.get("year"):
            return JSONResponse(
                {"ok": False, "error": "Kein Steuerjahr erkannt — sind das IBKR Flex "
                                       "Statements (XML) mit Detailgrad Closed Lots?"},
                status_code=422)
        return JSONResponse({"ok": True, "source": source,
                             "stored_files": _tax_store_list(user, "xml"), **result})
    except Exception as e:
        print(f"tax_report_xml error: {e}")
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)


# ── Steuer +++ : Konvex-Engine (Anlage KAP / KAP-INV) ───────────────────────────
# Vendorierte Engine (konvex_tax/) via Adapter tax_engine_konvex.py. Zusätzlich zu
# Steuer ++: InvStG-Teilfreistellung, separate Anlage KAP-INV, Stillhalter-Zufluss-
# prinzip (Cross-Year), offizielle Anlage-KAP-Zeilennummern. Je Steuerjahr mit voller
# Historie gerechnet. Stateless.

@app.post("/api/tax/report-konvex")
async def tax_report_konvex(request: Request, files: list[UploadFile] = File(default=[]), year: str = ""):
    import asyncio
    import tax_engine_konvex
    user = get_user(request)

    # Sorte "xml" wird mit Steuer ++ geteilt; ohne Upload Auto-Laden des Bestands.
    texts, source = await _tax_collect_texts(user, "xml", files)
    if not texts:
        return JSONResponse({"ok": False, "no_files": True,
                             "error": "Keine gespeicherten Dateien — bitte Flex-XML hochladen."})

    def _run():
        return tax_engine_konvex.compute_tax_report_konvex(texts, target_year=(year or None))

    try:
        loop = asyncio.get_running_loop()
        result = await loop.run_in_executor(None, _run)   # CPU-/IO-lastig → Threadpool
        if result.get("error"):
            return JSONResponse({"ok": False, "error": result["error"]}, status_code=422)
        if not result.get("year"):
            return JSONResponse(
                {"ok": False, "error": "Kein Steuerjahr erkannt — sind das IBKR Flex "
                                       "Statements (XML) seit Depoteröffnung?"},
                status_code=422)
        return JSONResponse({"ok": True, "source": source,
                             "stored_files": _tax_store_list(user, "xml"), **result})
    except Exception as e:
        print(f"tax_report_konvex error: {e}")
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)


# ── Steuer +++ : Flex-XML automatisch von IBKR holen ────────────────────────────
# Holt die als "query_id_tax" konfigurierte Flex Query (Activity-XML), legt sie als
# Jahres-XML im Bestand ab (Dateiname je Jahr → erneutes Holen überschreibt) und
# rechnet sofort den Konvex-Report für das laufende Jahr.

def _flex_stmt_year(xml_text: str) -> str | None:
    """Ermittelt das (jüngste) Statement-Jahr aus den FlexStatement-Datumsattributen."""
    years = re.findall(r'(?:from|to)Date="?(\d{4})\d{4}"?', xml_text)
    if not years:
        years = re.findall(r'period="?(\d{4})', xml_text)
    return max(years) if years else None


@app.post("/api/tax/fetch-flex")
async def tax_fetch_flex(request: Request, year: str = ""):
    import asyncio
    import tax_engine_konvex
    user  = get_user(request)
    files = get_user_files(user)
    _init_ibkr_tables(files["db"])

    conn = get_db(files["db"])
    cfg  = {r["key"]: r["value"] for r in conn.execute("SELECT key, value FROM ibkr_config").fetchall()}
    conn.close()
    if "flex_token" not in cfg or "query_id_tax" not in cfg:
        return JSONResponse(
            {"ok": False, "error": "Keine Steuer-Flex-Query konfiguriert — bitte unter "
                                   "Einstellungen Token und Query-ID (Steuer) hinterlegen."},
            status_code=422)

    flex_token = _ibkr_decrypt(cfg["flex_token"],   files["data_dir"])
    query_id   = _ibkr_decrypt(cfg["query_id_tax"], files["data_dir"])

    loop = asyncio.get_running_loop()

    # IBKR-Abruf ist blockierend (SendRequest → Poll GetStatement, bis ~45s) → Threadpool
    xml_text, err = await loop.run_in_executor(None, _flex_fetch_csv, flex_token, query_id)
    if err:
        return JSONResponse({"ok": False, "error": f"IBKR-Abruf fehlgeschlagen: {err}"},
                            status_code=502)
    if not xml_text or "FlexStatement" not in xml_text:
        return JSONResponse(
            {"ok": False, "error": "Antwort enthält kein Flex-XML — ist die Steuer-Query als "
                                   "XML-Format (Activity) angelegt?"},
            status_code=422)

    # Als Jahres-XML ablegen (gleicher Name je Jahr → erneutes Holen überschreibt)
    stmt_year = _flex_stmt_year(xml_text) or str(time.localtime().tm_year)
    _tax_store_add(user, "xml", [(f"IBKR_Flex_{stmt_year}.xml", xml_text.encode("utf-8"))])

    texts = _tax_store_load(user, "xml")
    target = (year or stmt_year)

    def _run():
        return tax_engine_konvex.compute_tax_report_konvex(texts, target_year=target)

    try:
        result = await loop.run_in_executor(None, _run)
        if result.get("error"):
            return JSONResponse({"ok": False, "error": result["error"]}, status_code=422)
        if not result.get("year"):
            return JSONResponse(
                {"ok": False, "error": "Kein Steuerjahr erkannt — sind das IBKR Flex "
                                       "Statements (XML)?"}, status_code=422)
        return JSONResponse({"ok": True, "source": "ibkr", "fetched_year": stmt_year,
                             "stored_files": _tax_store_list(user, "xml"), **result})
    except Exception as e:
        print(f"tax_fetch_flex error: {e}")
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)


# ── Verwaltung der gespeicherten Steuer-Dateien (pro User) ──────────────────────

@app.get("/api/tax/files")
async def tax_files_status(request: Request, kind: str = "xml"):
    """Listet die serverseitig gespeicherten Steuer-Dateien einer Sorte (xml|csv)."""
    user = get_user(request)
    if kind not in _TAX_STORE_KINDS:
        return JSONResponse({"ok": False, "error": "Unbekannte Sorte"}, status_code=422)
    return JSONResponse({"ok": True, "kind": kind, "files": _tax_store_list(user, kind)})

@app.delete("/api/tax/files")
async def tax_files_clear(request: Request, kind: str = "xml", name: str = ""):
    """Löscht eine einzelne Datei (name=…) oder — ohne name — den ganzen Bestand der Sorte."""
    user = get_user(request)
    if kind not in _TAX_STORE_KINDS:
        return JSONResponse({"ok": False, "error": "Unbekannte Sorte"}, status_code=422)
    if name:
        _tax_store_delete_one(user, kind, name)
    else:
        _tax_store_clear(user, kind)
    return JSONResponse({"ok": True, "kind": kind, "files": _tax_store_list(user, kind)})


# ── Steuer +++ : PDF-Steuerbericht je Jahr ──────────────────────────────────────
# Rechnet aus den gespeicherten XMLs (Sorte xml) und liefert einen mehrseitigen
# PDF-Bericht (Zusammenfassung + vollständiges Trade-Journal) für das gewählte Jahr.

@app.get("/api/tax/report-konvex-pdf")
async def tax_report_konvex_pdf(request: Request, year: str = ""):
    import asyncio
    import tax_engine_konvex
    import tax_pdf_konvex
    user = get_user(request)

    texts = _tax_store_load(user, "xml")
    if not texts:
        return JSONResponse({"ok": False, "no_files": True,
                             "error": "Keine gespeicherten XML-Dateien."}, status_code=422)

    def _run():
        res = tax_engine_konvex.compute_tax_report_konvex(texts, target_year=(year or None))
        if res.get("error") or not res.get("year"):
            return None, res
        yr = year if (year and year in res.get("years", {})) else res["year"]
        pdf = tax_pdf_konvex.build_pdf(res["years"][yr], account=res.get("account", ""))
        return (pdf, yr), res

    try:
        loop = asyncio.get_running_loop()
        result, res = await loop.run_in_executor(None, _run)
        if result is None:
            return JSONResponse({"ok": False, "error": res.get("error", "Kein Steuerjahr")},
                                status_code=422)
        pdf_bytes, yr = result
        return Response(content=pdf_bytes, media_type="application/pdf",
                        headers={"Content-Disposition":
                                 f'attachment; filename="IBKR-Steuer-Report_{yr}.pdf"'})
    except Exception as e:
        print(f"tax_report_konvex_pdf error: {e}")
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)


# ── Screener ──────────────────────────────────────────────────────────────────
# Logik in screener.py. Jobs laufen im Background-Thread; Frontend pollt /status.

@app.get("/api/screener/config")
async def screener_config(request: Request):
    get_user(request)
    return {"indexes": list(screener.INDEXES.keys()),
            "sectors": list(screener.SECTORS.keys())}


@app.post("/api/screener/run")
async def screener_run(request: Request):
    get_user(request)
    body = await request.json()
    index_names = body.get("indexes") or []
    if not isinstance(index_names, list) or not index_names:
        return JSONResponse({"ok": False, "error": "Mindestens einen Index auswählen"},
                            status_code=400)

    unit = body.get("unit", "Mrd $")
    multiplier = 1_000_000_000 if unit == "Mrd $" else 1_000_000
    try:
        mn = float(body.get("cap_min", 0) or 0)
        mx = float(body.get("cap_max", 0) or 0)
    except (TypeError, ValueError):
        return JSONResponse({"ok": False, "error": "Ungültiger MarktCap-Wert"},
                            status_code=400)
    if mn > 0 and mx > 0 and mn >= mx:
        return JSONResponse({"ok": False, "error": "Min muss kleiner sein als Max"},
                            status_code=400)

    cap_min = int(mn * multiplier) if mn > 0 else None
    cap_max = int(mx * multiplier) if mx > 0 else None

    job_id = screener.start_job(index_names, cap_min, cap_max, unit)
    return {"ok": True, "job_id": job_id}


@app.get("/api/screener/status/{job_id}")
async def screener_status(job_id: str, request: Request):
    get_user(request)
    s = screener.get_status(job_id)
    if s is None:
        return JSONResponse({"ok": False, "error": "Job nicht gefunden"}, status_code=404)
    return {"ok": True, **s}


@app.get("/api/screener/export/{job_id}")
async def screener_export(job_id: str, request: Request):
    get_user(request)
    s = screener.get_status(job_id)
    if s is None:
        return JSONResponse({"ok": False, "error": "Job nicht gefunden"}, status_code=404)
    if s["status"] != "done":
        return JSONResponse({"ok": False, "error": "Screening läuft noch"}, status_code=409)
    text = screener.format_tradingview(s["results"])
    return PlainTextResponse(
        text,
        headers={"Content-Disposition":
                 'attachment; filename="Screening_Ergebnis.txt"'},
    )

