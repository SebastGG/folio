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
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
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

def _tax_store_save(user: str, kind: str, items: list[tuple[str, bytes]]) -> list[str]:
    """Ersetzt den Bestand der Sorte durch die übergebenen Dateien. Gibt Namen zurück."""
    d = _tax_store_dir(user, kind)
    for f in os.listdir(d):
        try:
            os.remove(os.path.join(d, f))
        except OSError:
            pass
    saved, seen = [], set()
    for name, raw in items:
        sn = _tax_safe_name(name, kind)
        # Doppelte Namen entschärfen
        stem, n = sn, 1
        while sn in seen:
            root, ext = os.path.splitext(stem)
            sn = f"{root}_{n}{ext}"; n += 1
        seen.add(sn)
        with open(os.path.join(d, sn), "wb") as fh:
            fh.write(raw)
        saved.append(sn)
    return sorted(saved)

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
      • Wurden Dateien hochgeladen → speichern (ersetzt den Bestand), source="upload".
      • Sonst → gespeicherten Bestand laden, source="stored".
    """
    items = []
    for f in (files or []):
        raw = await f.read()
        if raw:
            items.append((f.filename or "datei", raw))
    if items:
        _tax_store_save(user, kind, items)
        return [raw.decode("utf-8-sig", errors="replace") for _, raw in items], "upload"
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
        currency         TEXT
    )''')
    try:
        conn.execute("ALTER TABLE positions ADD COLUMN fx_rate_to_base REAL DEFAULT 1.0")
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
    """Gibt zurück ob IBKR konfiguriert ist (ohne Credentials zu senden)."""
    user  = get_user(request)
    files = get_user_files(user)
    _init_ibkr_tables(files["db"])
    conn  = get_db(files["db"])
    keys  = {r["key"] for r in conn.execute("SELECT key FROM ibkr_config").fetchall()}
    conn.close()
    return JSONResponse(content={"configured": "flex_token" in keys and "query_id" in keys})

@app.post("/api/ibkr/config")
async def set_ibkr_config(request: Request):
    """Speichert Flex Token + Query ID AES-verschlüsselt."""
    user  = get_user(request)
    files = get_user_files(user)
    _init_ibkr_tables(files["db"])
    body  = await request.json()
    token = (body.get("flex_token") or "").strip()
    qid   = (body.get("query_id")   or "").strip()
    if not token or not qid:
        return JSONResponse({"ok": False, "error": "flex_token und query_id erforderlich"}, status_code=400)
    enc_token = _ibkr_encrypt(token, files["data_dir"])
    enc_qid   = _ibkr_encrypt(qid,   files["data_dir"])
    conn = get_db(files["db"])
    conn.execute("INSERT OR REPLACE INTO ibkr_config VALUES ('flex_token', ?)", (enc_token,))
    conn.execute("INSERT OR REPLACE INTO ibkr_config VALUES ('query_id',   ?)", (enc_qid,))
    conn.commit()
    conn.close()
    return JSONResponse({"ok": True})

def _do_ibkr_sync(db_file: str, data_dir: str) -> dict:
    """Blockierender IBKR-Sync — läuft im ThreadPoolExecutor."""
    import csv as csv_mod
    import datetime as dt_
    import time as time_
    import urllib.request as urlreq
    import urllib.error

    conn = get_db(db_file)
    cfg  = {r["key"]: r["value"] for r in conn.execute("SELECT key, value FROM ibkr_config").fetchall()}
    conn.close()

    if "flex_token" not in cfg or "query_id" not in cfg:
        return {"ok": False, "error": "IBKR nicht konfiguriert"}

    flex_token = _ibkr_decrypt(cfg["flex_token"], data_dir)
    query_id   = _ibkr_decrypt(cfg["query_id"],   data_dir)

    # Step 1: SendRequest → ReferenceCode (bis zu 3 Versuche, 10s Pause)
    url1 = f"https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/SendRequest?v=3&t={flex_token}&q={query_id}"
    ref_code = None
    last_err  = ""
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
            return {"ok": False, "error": last_err}

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
        return {"ok": False, "error": f"Kein ReferenceCode: {last_err}"}

    # Step 2: GetStatement — retry bis zu 5× bei "Processing"
    csv_text = None
    for attempt in range(5):
        url2 = f"https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/GetStatement?v=3&t={flex_token}&q={ref_code}"
        try:
            req2 = urlreq.Request(url2, headers={"User-Agent": "Mozilla/5.0"})
            with urlreq.urlopen(req2, timeout=30) as resp:
                content = resp.read().decode("utf-8")
        except urllib.error.URLError as e:
            return {"ok": False, "error": f"GetStatement fehlgeschlagen: {e}"}

        if "<ErrorCode>1019</ErrorCode>" in content or "<Status>Processing</Status>" in content:
            if attempt < 4:
                time_.sleep(5)
                continue
            return {"ok": False, "error": "IBKR verarbeitet noch — bitte in 30s erneut versuchen"}
        csv_text = content
        break

    if not csv_text:
        return {"ok": False, "error": "Leere Antwort von IBKR"}

    # Spalten-Indizes dynamisch aus HEADER-Zeilen ermitteln
    section_headers: dict = {}

    positions  = []
    cash_rows  = []
    trade_rows = []
    now = dt_.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")

    for raw_line in csv_text.splitlines():
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
            i_tid  = cols.get("TransactionID", -1)
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
        except ValueError:
            continue
        asset_class = parts[i_cls].strip() if 0 <= i_cls < len(parts) else ""
        isin        = parts[i_isin].strip() if 0 <= i_isin < len(parts) else ""
        currency    = parts[i_cur].strip() if 0 <= i_cur < len(parts) else ""
        positions.append((symbol, qty, cbp, cbm, mrkp, posval, asset_class, now, fx, isin, currency))

    print(f"[IBKR] Positionen: {len(positions)}, Cash: {len(cash_rows)}, Trades: {len(trade_rows)}")
    if not positions and not cash_rows and not trade_rows:
        return {"ok": False, "error": "Keine DATA-Zeilen im CSV gefunden — prüfe Flex-Query-Konfiguration"}

    conn = get_db(db_file)
    conn.execute("DELETE FROM positions")
    if positions:
        conn.executemany(
            "INSERT OR REPLACE INTO positions "
            "(symbol,quantity,cost_basis_price,cost_basis_money,mark_price,position_value,asset_class,last_sync,fx_rate_to_base,isin,currency) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?)", positions)
    conn.execute("DELETE FROM cash_balances")
    if cash_rows:
        conn.executemany("INSERT OR REPLACE INTO cash_balances VALUES (?,?,?)", cash_rows)
    if trade_rows:
        conn.executemany(
            "INSERT OR REPLACE INTO trades "
            "(transaction_id,symbol,action,quantity,price,value,commission,currency,fx_rate,trade_date,asset_class,last_sync,isin) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", trade_rows)
    conn.commit()

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
    return {"ok": True, "count": len(positions), "cash_count": len(cash_rows), "trade_count": len(trade_rows), "last_sync": now}


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


# ── Verwaltung der gespeicherten Steuer-Dateien (pro User) ──────────────────────

@app.get("/api/tax/files")
async def tax_files_status(request: Request, kind: str = "xml"):
    """Listet die serverseitig gespeicherten Steuer-Dateien einer Sorte (xml|csv)."""
    user = get_user(request)
    if kind not in _TAX_STORE_KINDS:
        return JSONResponse({"ok": False, "error": "Unbekannte Sorte"}, status_code=422)
    return JSONResponse({"ok": True, "kind": kind, "files": _tax_store_list(user, kind)})

@app.delete("/api/tax/files")
async def tax_files_clear(request: Request, kind: str = "xml"):
    """Löscht den gespeicherten Bestand einer Sorte (xml|csv) für den User."""
    user = get_user(request)
    if kind not in _TAX_STORE_KINDS:
        return JSONResponse({"ok": False, "error": "Unbekannte Sorte"}, status_code=422)
    _tax_store_clear(user, kind)
    return JSONResponse({"ok": True, "kind": kind, "files": []})


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

