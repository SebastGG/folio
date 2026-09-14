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
import hashlib
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
from starlette.concurrency import run_in_threadpool

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


# ── Steuer-Dateien: Kopfdaten für den Dateibaum + Ergebnis-Cache ────────────────
# Die Engine rechnet jedes Steuerjahr mit voller Historie durch und braucht dafür
# Sekunden bis Minuten. Deshalb: (1) die XMLs liegen einfach im Bestand und werden
# nur auf Knopfdruck ausgewertet, (2) jedes gerechnete Jahr landet als JSON im
# Cache. Cache-Schlüssel ist ein Fingerabdruck des GESAMTEN Bestands (Name+Größe+
# mtime) — jedes Jahr hängt über die Historie an allen älteren Dateien, eine neue
# Datei macht also alle Jahre neu.

def _flex_xml_head_meta(text: str) -> dict:
    """Konto/Zeitraum/Jahr aus dem Kopf einer Flex-XML (ohne vollen Parse).
    Verträgt beide IBKR-Datumsformate: 20250131 und 2025-01-31."""
    head = text[:200_000]
    def _d(attr):
        m = re.search(attr + r'="?(\d{4})-?(\d{2})-?(\d{2})', head)
        return f"{m.group(1)}-{m.group(2)}-{m.group(3)}" if m else ""
    frm, to = _d("fromDate"), _d("toDate")
    acct = re.search(r'accountId="([^"]*)"', head)
    name = re.search(r'<AccountInformation[^>]*\bname="([^"]*)"', head)
    year = (to or frm)[:4]
    if not year:
        m = re.search(r'period="?(\d{4})', head)
        year = m.group(1) if m else ""
    return {"account_id": acct.group(1) if acct else "",
            "account_name": name.group(1) if name else "",
            "from_date": frm, "to_date": to, "year": year}


def _tax_store_entries(user: str, kind: str = "xml") -> list[dict]:
    """Dateibaum-Daten: je gespeicherter Datei Name, Größe, Zeitstempel, Konto, Zeitraum."""
    d = _tax_store_dir(user, kind)
    out = []
    for name in _tax_store_list(user, kind):
        p = os.path.join(d, name)
        st = os.stat(p)
        meta = {}
        if kind == "xml":
            try:
                with open(p, "rb") as fh:
                    meta = _flex_xml_head_meta(fh.read(200_000).decode("utf-8-sig", errors="replace"))
            except OSError:
                meta = {}
        out.append({"name": name, "size": st.st_size, "mtime": st.st_mtime, **meta})
    return out


def _tax_store_fingerprint(user: str, kind: str = "xml") -> str:
    """Kurzer Hash über den kompletten Bestand — ändert sich bei jeder Änderung."""
    d = _tax_store_dir(user, kind)
    parts = []
    for name in _tax_store_list(user, kind):
        st = os.stat(os.path.join(d, name))
        parts.append(f"{name}:{st.st_size}:{int(st.st_mtime)}")
    return hashlib.sha1("|".join(parts).encode("utf-8")).hexdigest()[:16]


def _tax_cache_dir(user: str, fp: str) -> str:
    d = os.path.join(get_user_dir(user), "tax_files", "cache", fp)
    os.makedirs(d, exist_ok=True)
    return d


def _tax_cache_get(user: str, fp: str, year: str):
    p = os.path.join(_tax_cache_dir(user, fp), f"{year}.json")
    if not os.path.isfile(p):
        return None
    try:
        with open(p, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def _tax_cache_put(user: str, fp: str, year: str, data: dict) -> None:
    d = _tax_cache_dir(user, fp)
    try:
        with open(os.path.join(d, f"{year}.json"), "w", encoding="utf-8") as fh:
            json.dump(data, fh)
    except (OSError, TypeError, ValueError) as e:
        print(f"tax cache write failed ({year}): {e}")
    # Caches vergangener Bestände wegräumen
    root = os.path.dirname(d)
    for other in os.listdir(root):
        if other != fp:
            shutil.rmtree(os.path.join(root, other), ignore_errors=True)


def _tax_cache_years(user: str, fp: str) -> list[str]:
    d = _tax_cache_dir(user, fp)
    return sorted(f[:-5] for f in os.listdir(d) if f.endswith(".json"))


def _tax_konvex_years(user: str, targets: list[str], fp: str) -> dict:
    """{Jahr: Ergebnis} für die gewünschten Jahre — aus dem Cache, Fehlendes wird
    gerechnet (ein Engine-Lauf für alle fehlenden Jahre) und gecacht. Blockierend."""
    import tax_engine_konvex
    out, missing = {}, []
    for y in targets:
        hit = _tax_cache_get(user, fp, y)
        if hit:
            out[y] = hit
        else:
            missing.append(y)
    meta = {}
    if missing:
        texts = _tax_store_load(user, "xml")
        res = tax_engine_konvex.compute_tax_report_konvex(
            texts, target_year=missing[-1], only_years=missing)
        if res.get("error"):
            raise ValueError(res["error"])
        for y, data in (res.get("years") or {}).items():
            _tax_cache_put(user, fp, y, data)
            out[y] = data
        meta = {"account": res.get("account", ""), "base_currency": res.get("base_currency", "EUR")}
    return {"years": out, "computed": sorted(missing), "meta": meta}


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
    # timeout/busy_timeout: WAL erlaubt parallele Leser, aber nur EINEN Schreiber.
    # Beim Refresh schreiben mehrere Worker-Threads gleichzeitig — mit dem sqlite3-
    # Default von 5 s brach das unter Last mit "database is locked" ab (der Fehler
    # wurde früher verschluckt, der Ticker blieb einfach ohne neue Kurse).
    conn = sqlite3.connect(db_file, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")  # besser für concurrent reads
    conn.execute("PRAGMA busy_timeout=30000")
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
    # Verarbeitete Aktien-Splits — verhindert Doppel-Korrektur der Kursdaten.
    conn.execute('''CREATE TABLE IF NOT EXISTS ticker_splits (
        ticker  TEXT NOT NULL,
        date    TEXT NOT NULL,   -- Ex-Split-Datum (erster Handelstag neu)
        ratio   REAL NOT NULL,   -- Faktor num/den (4:1 → 4.0, 1:10 → 0.1)
        applied INTEGER,         -- 1 = Kursdaten wurden rückwirkend skaliert
        seen_at REAL,
        PRIMARY KEY (ticker, date)
    )''')
    # Earnings-Termine (vergangene + kommende) je Ticker, gecacht (siehe /api/earnings).
    conn.execute('''CREATE TABLE IF NOT EXISTS earnings (
        ticker  TEXT NOT NULL,
        date    TEXT NOT NULL,   -- Earnings-Termin YYYY-MM-DD
        eps_est REAL,            -- geschätztes EPS
        eps_act REAL,            -- berichtetes EPS (NULL = noch nicht berichtet)
        PRIMARY KEY (ticker, date)
    )''')
    conn.execute('''CREATE TABLE IF NOT EXISTS earnings_meta (
        ticker  TEXT PRIMARY KEY,
        updated REAL             -- Zeitstempel des letzten Yahoo-Abrufs
    )''')
    conn.commit()
    conn.close()

# ── Aktien-Splits ────────────────────────────────────────────────────────────────
# Yahoo liefert OHLC rückwirkend split-bereinigt. Da wir aber nur Delta-Updates
# schreiben (neue Tage anhängen), bleiben Alt-Zeilen nach einem Split auf der
# Vor-Split-Skala stehen, während neue Tage bereits neu skaliert reinkommen →
# künstliche Kursklippe. Wir erkennen das am tatsächlichen Kurssprung an der
# Split-Grenze und korrigieren die Altdaten dann rückwirkend.

def _fetch_all_splits(ticker: str) -> dict:
    """Alle jemals erfolgten Splits (Datum → Faktor num/den). range=max mit grober
    Auflösung → winzige Payload (~20 KB)."""
    import urllib.request, datetime
    url = (f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}"
           f"?interval=3mo&range=max&events=split")
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        data = json.loads(resp.read())
    result = (data.get("chart", {}).get("result") or [None])[0]
    if not result:
        return {}
    splits = (result.get("events", {}) or {}).get("splits", {}) or {}
    out = {}
    for ev in splits.values():
        num = ev.get("numerator") or 0
        den = ev.get("denominator") or 0
        if num > 0 and den > 0:
            d = datetime.datetime.utcfromtimestamp(ev["date"]).strftime("%Y-%m-%d")
            out[d] = num / den
    return out

def _reconcile_splits(ticker: str, conn: sqlite3.Connection) -> list:
    """Gleicht Yahoo-Splits mit der DB ab und korrigiert Altdaten rückwirkend,
    falls sie noch auf der Vor-Split-Skala liegen. Gibt die Faktoren der NEU
    angewandten Splits zurück (für die Zeichnungs-Anpassung)."""
    import math
    try:
        splits = _fetch_all_splits(ticker)
    except Exception as e:
        print(f"reconcile_splits fetch {ticker}: {e}")
        return []
    if not splits:
        return []
    applied_factors = []
    for date_str, f in sorted(splits.items()):
        if conn.execute("SELECT 1 FROM ticker_splits WHERE ticker=? AND date=?",
                        (ticker, date_str)).fetchone():
            continue  # schon abgehandelt
        # Kurssprung an der Grenze aus unseren eigenen Tagesdaten messen
        pre = conn.execute(
            "SELECT close FROM prices WHERE ticker=? AND date<? AND close>0 "
            "ORDER BY date DESC LIMIT 5", (ticker, date_str)).fetchall()
        post = conn.execute(
            "SELECT close FROM prices WHERE ticker=? AND date>=? AND close>0 "
            "ORDER BY date ASC LIMIT 5", (ticker, date_str)).fetchall()
        applied = 0
        if pre and post:
            pre_m  = sorted(r["close"] for r in pre)[len(pre) // 2]
            post_m = sorted(r["close"] for r in post)[len(post) // 2]
            lr, lf = math.log(pre_m / post_m), math.log(f)
            # Ist die Diskontinuität mind. halbwegs in Richtung Split-Faktor
            # (gleiche Richtung)? → Altdaten liegen noch auf der Vor-Split-Skala.
            if lf != 0 and (lr / lf) > 0.5:
                # Yahoo back-adjustiert die jüngsten Vor-Split-Tage oft schon mit
                # dem Ex-Tag; unser Delta-Update holt genau die erneut und legt sie
                # BEREITS skaliert ab. Nicht pauschal alles < date_str teilen (das
                # würde diese Tage ein zweites Mal halbieren → künstliche Delle),
                # sondern nur den zusammenhängenden Roh-Block: von der Grenze rück-
                # wärts den schon adjustierten Tail (Ratio ≈ 0) überspringen und
                # erst ab dem ersten klar rohen Tag (Ratio > 0.5) abwärts skalieren.
                boundary = date_str
                older = conn.execute(
                    "SELECT date, close FROM prices WHERE ticker=? AND date<? "
                    "AND close>0 ORDER BY date DESC", (ticker, date_str)).fetchall()
                for r in older:
                    if (math.log(r["close"] / post_m) / lf) > 0.5:
                        break                 # erster roher Tag → ab hier abwärts
                    boundary = r["date"]      # noch adjustiert → aus Korrektur raus
                conn.execute(
                    "UPDATE prices SET open=open/?, high=high/?, low=low/?, "
                    "close=close/?, volume=volume*? WHERE ticker=? AND date<?",
                    (f, f, f, f, f, ticker, boundary))
                applied = 1
                applied_factors.append(f)
        elif post and not pre:
            applied = 1  # Split liegt vor unseren Daten → nichts zu korrigieren
        else:
            continue     # zu wenig Daten für sichere Entscheidung → später erneut
        conn.execute("INSERT OR REPLACE INTO ticker_splits VALUES (?,?,?,?,?)",
                     (ticker, date_str, f, applied, time.time()))
    conn.commit()
    return applied_factors

def _adjust_drawings_for_split(data_dir: str, view_key: str, factors: list):
    """Skaliert die Preis-Anker gespeicherter Zeichnungen um die Split-Faktoren
    (Kurse ÷ f → Anker ÷ f), damit Zeichnungen relativ zu den korrigierten
    Kerzen an Ort und Stelle bleiben. Alle vor dem Split angelegten Zeichnungen
    liegen auf der Vor-Split-Skala."""
    try:
        f = 1.0
        for x in factors:
            f *= x
        if f == 1.0:
            return
        drawings = load_drawings(data_dir, view_key)
        if not drawings:
            return
        for d in drawings:
            for a in (d.get("anchors") or []):
                if isinstance(a, dict) and a.get("price") is not None:
                    a["price"] = a["price"] / f
        save_drawings(data_dir, view_key, drawings)
    except Exception as e:
        print(f"adjust_drawings_for_split {view_key}: {e}")

# ── Yahoo Finance ──────────────────────────────────────────────────────────────
_SYMBOL_HINT_CACHE: dict[str, str] = {}   # Ticker -> " — meintest du …" (auch leer)

def _symbol_hint(ticker: str) -> str:
    """Sucht bei Yahoo nach dem gemeinten Symbol und formuliert einen Vorschlag.

    Ein nacktes „HTTP 404" sagt nicht, was zu tun ist — die Ursache ist fast immer
    ein fehlendes Börsensuffix (CSU statt CSU.TO). Läuft nur im Fehlerfall und wird
    prozessweit gemerkt, damit ein dauerhaft falscher Ticker nicht bei jedem
    Kurs-Update erneut gesucht wird.
    """
    if ticker in _SYMBOL_HINT_CACHE:
        return _SYMBOL_HINT_CACHE[ticker]
    hint = ""
    try:
        import urllib.request, urllib.parse
        url = ("https://query1.finance.yahoo.com/v1/finance/search?q="
               + urllib.parse.quote(ticker) + "&quotesCount=6&newsCount=0")
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=8) as resp:
            quotes = (json.loads(resp.read()) or {}).get("quotes") or []
        base = ticker.upper()
        for q in quotes:
            sym = (q.get("symbol") or "").upper()
            # Nur echte Wertpapiere und nur Treffer, die wie derselbe Ticker mit
            # Börsensuffix aussehen — sonst schlägt die Suche wahllos ETFs vor.
            if q.get("quoteType") != "EQUITY" or not sym.startswith(base + "."):
                continue
            name = q.get("shortname") or q.get("longname") or ""
            exch = q.get("exchDisp") or ""
            detail = " — ".join(x for x in (name, exch) if x)
            hint = f" — meintest du {sym}?" + (f" ({detail})" if detail else "")
            break
    except Exception:
        pass                       # Vorschlag ist Beiwerk, der 404 bleibt der Fehler
    _SYMBOL_HINT_CACHE[ticker] = hint
    return hint

def _yahoo_chart(ticker: str, period1: int, period2: int) -> dict:
    """Holt die Yahoo-Chart-Antwort mit Retry.

    Yahoo drosselt Bursts (429/999) und lässt einzelne Verbindungen auflaufen. Ohne
    Retry blieb bei jedem Refresh zufällig ein Teil der Ticker auf altem Stand —
    genau das Symptom „manchmal werden die Kurse nicht geladen".
    """
    import urllib.request, urllib.error, time as time_module

    url = (
        f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}"
        f"?interval=1d&period1={period1}&period2={period2}"
    )
    last_err = None
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = json.loads(resp.read())
            err = (data.get("chart") or {}).get("error")
            if err:
                # Fachlicher Fehler (unbekanntes Symbol o.ä.) — Retry bringt nichts
                raise RuntimeError(f"Yahoo: {err.get('description') or err}")
            result = (data.get("chart") or {}).get("result") or []
            if not result:
                raise RuntimeError("Yahoo: leere Antwort")
            return result[0]
        except RuntimeError:
            raise
        except urllib.error.HTTPError as e:
            # 400/404 = Symbol gibt es nicht — sofort aufgeben statt 4,5 s zu warten.
            # 429/5xx dagegen sind genau die Fälle, für die der Retry da ist.
            if e.code in (400, 404):
                raise RuntimeError(
                    f"Unbekanntes Symbol (HTTP {e.code}){_symbol_hint(ticker)}"
                )
            last_err = e
            if attempt < 2:
                time_module.sleep(1.5 * (attempt + 1))   # 1,5 s / 3 s
        except Exception as e:          # URLError, Timeout, JSON-Fehler
            last_err = e
            if attempt < 2:
                time_module.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"Yahoo nicht erreichbar: {last_err}")

def update_ticker(ticker: str, conn: sqlite3.Connection):
    """
    Lädt Kursdaten von Yahoo Finance und speichert sie in SQLite.
    Nutzt Delta-Updates + holt heutigen Intraday-Kurs separat.
    Rückgabe: (Anzahl neuer/aktualisierter Zeilen, [neu angewandte Split-Faktoren]).
    Wirft bei Fehlschlag — die Aufrufer melden das an die Oberfläche weiter.
    """
    try:
        import datetime, time as time_module

        row = conn.execute(
            "SELECT MAX(date) as last FROM prices WHERE ticker=?", (ticker,)
        ).fetchone()
        last_date = row["last"] if row and row["last"] else "2020-01-01"

        # Nachlauffenster: die letzten Tage werden bei JEDEM Update neu geschrieben,
        # nicht nur der jüngste. Grund ist das Volumen: ein Tagesbalken, der während
        # der Handelszeit geholt wurde, trägt nur das Volumen bis zu diesem Moment
        # (IBKR am 2026-08-17 kurz nach der Eröffnung: 495 Tsd. statt 4,63 Mio zum
        # Schluss). Wurde derselbe Ticker danach nicht mehr angefasst — weil er in
        # keinem Basket mit Gewicht ≠ 0 steht —, blieb dieses Teilvolumen für immer
        # stehen. Yahoo revidiert das konsolidierte Volumen ausserdem noch Stunden
        # nach Handelsschluss. Ein paar Tage rückwärts kosten nichts: es ist derselbe
        # Abruf, nur ein paar INSERT OR REPLACE mehr.
        REWRITE_DAYS = 7

        # Historische Daten (1d interval) — liefert abgeschlossene Tage.
        # calendar.timegm statt mktime: last_date/from_date sind UTC-Datumsangaben,
        # mktime hätte sie als Lokalzeit gelesen (auf UTC+X ein Tag Versatz).
        # Ein Tag Vorlauf als Puffer gegen Zeitzonen-Randfälle (Börsen östlich von UTC
        # haben ihren Balken-Zeitstempel genau auf Mitternacht UTC). Zusätzliche Tage
        # kosten nichts: die Schleife unten überspringt alles vor from_date.
        import calendar
        from_date = (datetime.date.fromisoformat(last_date)
                     - datetime.timedelta(days=REWRITE_DAYS)).isoformat()
        period1 = calendar.timegm(time_module.strptime(from_date, "%Y-%m-%d")) - 86400
        period2 = int(time_module.time())
        chart = _yahoo_chart(ticker, period1, period2)
        # Yahoo kennt das Symbol, liefert aber keine Kerzen (ausgesetzt, delistet oder
        # jünger als der abgefragte Zeitraum). Klartext statt rohem KeyError 'timestamp'.
        timestamps = chart.get("timestamp")
        quotes     = (chart.get("indicators") or {}).get("quote") or []
        if not timestamps or not quotes:
            raise RuntimeError("Keine Kursdaten bei Yahoo (delistet oder ausgesetzt?)")
        ohlcv = quotes[0]
        meta  = chart.get("meta", {})
        count = 0

        # UTC konsistent mit utcfromtimestamp — verhindert Datum-Mismatch auf UTC+X Servern
        today_obj = datetime.datetime.utcnow().date()
        today = today_obj.strftime("%Y-%m-%d")

        for i, ts in enumerate(timestamps):
            date_str = datetime.datetime.utcfromtimestamp(ts).strftime("%Y-%m-%d")
            if date_str < from_date:  # alles im Nachlauffenster wird neu geschrieben
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
        # Volumen aus dem Kopfteil mitnehmen: es gehört zum selben Zeitpunkt wie der
        # Live-Kurs und ist damit nie älter als der Tagesbalken. Nur nach oben
        # korrigieren — ein Tagesvolumen kann im Lauf des Tages nicht schrumpfen,
        # und ein leeres/veraltetes Meta-Feld soll den Balken nicht leerräumen.
        live_vol = meta.get("regularMarketVolume") or 0
        market_time = meta.get("regularMarketTime") or 0
        market_date = datetime.datetime.utcfromtimestamp(market_time).strftime("%Y-%m-%d") if market_time else ""
        if live_price and live_price > 0 and today_obj.weekday() < 5 and market_date == today:
            existing = conn.execute(
                "SELECT open, high, low, volume FROM prices WHERE ticker=? AND date=?",
                (ticker, today)
            ).fetchone()
            if existing:
                conn.execute(
                    "UPDATE prices SET close=?, high=?, low=?, volume=? WHERE ticker=? AND date=?",
                    (live_price,
                     max(existing["high"], live_price),
                     min(existing["low"],  live_price),
                     max(existing["volume"] or 0, live_vol),
                     ticker, today)
                )
            else:
                # Kein historischer Bar vorhanden (z.B. Feiertag) — Meta als Fallback.
                # Früher stand hier hart 0 als Volumen: die Kerze sah aus wie ein
                # Handelstag ohne jeden Umsatz.
                o = meta.get("regularMarketOpen")    or live_price
                h = meta.get("regularMarketDayHigh") or live_price
                l = meta.get("regularMarketDayLow")  or live_price
                conn.execute(
                    "INSERT OR REPLACE INTO prices VALUES (?,?,?,?,?,?,?)",
                    (ticker, today, o, max(h, live_price), min(l, live_price), live_price, live_vol)
                )
            count += 1

        # Währung speichern
        currency = meta.get("currency") or "USD"
        conn.execute(
            "INSERT OR REPLACE INTO ticker_currency VALUES (?,?)", (ticker, currency)
        )
        conn.commit()

        # Splits abgleichen & Altdaten ggf. rückwirkend korrigieren (nach dem
        # Insert, damit die neuen Post-Split-Tage in der Sprung-Messung stecken)
        split_factors = _reconcile_splits(ticker, conn)
        return count, split_factors
    except Exception as e:
        # Bewusst weiterwerfen: früher wurde hier -1 zurückgegeben und der Fehler war
        # für die Oberfläche unsichtbar — der Refresh sah erfolgreich aus, obwohl der
        # Ticker auf altem Stand blieb.
        print(f"update_ticker error for {ticker}: {e}")
        raise

# ── Config ──────────────────────────────────────────────────────────────────────
def load_config(config_file: str) -> dict:
    if os.path.exists(config_file):
        with open(config_file, "r") as f:
            return json.load(f)
    return {"baskets": {}, "currentBasket": ""}

CONFIG_SICHERUNGEN = 14        # Tagessicherungen der Config, die aufgehoben werden

def _config_sichern(config_file: str):
    """Legt eine Tagessicherung der Config an, bevor sie überschrieben wird.

    Eine einzelne „vorherige Fassung" nützt nichts: wird ein kaputter Stand
    mehrfach gespeichert, ist auch die Sicherung kaputt. Darum eine je Tag, die
    erste Änderung des Tages gewinnt — damit bleibt der Stand von gestern heil,
    egal wie oft heute noch geschrieben wird.
    """
    if not os.path.exists(config_file):
        return
    ordner = os.path.dirname(config_file)
    ziel   = os.path.join(ordner, f"config_{time.strftime('%Y-%m-%d')}.json")
    try:
        if not os.path.exists(ziel):
            shutil.copy2(config_file, ziel)
        # Ausdünnen unabhängig davon, ob gerade eine neue entstanden ist — sonst
        # räumt nur das erste Speichern eines Tages auf.
        alte = sorted(f for f in os.listdir(ordner)
                      if re.fullmatch(r"config_\d{4}-\d{2}-\d{2}\.json", f))
        for f in alte[:-CONFIG_SICHERUNGEN]:
            os.remove(os.path.join(ordner, f))
    except Exception as e:
        print(f"[Config] Sicherung fehlgeschlagen: {e}")   # Speichern geht trotzdem

def save_config_data(config_file: str, cfg: dict):
    """Atomares Speichern via tempfile + rename — kein Datenverlust bei Crash."""
    _config_sichern(config_file)
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
        wait = 60 - (now - _last_update.get(user, 0))
        if wait > 0:
            return JSONResponse(
                content={"ok": False, "error": "Rate limit: 1x pro Minute",
                         "retry_after": int(wait) + 1},
                status_code=429
            )
        _last_update[user] = now

    files = get_user_files(user)
    init_db(files["db"])
    body = await request.json()
    tickers = body.get("tickers", [])
    if not tickers:
        return JSONResponse(content={"ok": True, "updated": 0, "failed": {}})

    def update_one(ticker):
        conn = None
        try:
            conn = get_db(files["db"])
            n, split_factors = update_ticker(ticker, conn)
            # Nach rückwirkender Split-Korrektur der Kurse auch die Zeichnungen
            # dieses Tickers auf die neue Kurs-Skala anpassen.
            if split_factors:
                _adjust_drawings_for_split(files["data_dir"], "ticker:" + ticker, split_factors)
            return ticker, {"ok": True, "rows": n}
        except Exception as e:
            return ticker, {"ok": False, "error": str(e)}
        finally:
            if conn is not None:
                try:
                    conn.close()
                except Exception:
                    pass

    def run_all():
        # Weniger Worker als früher (8): Yahoo drosselt parallele Bursts, und jeder
        # Worker schreibt in dieselbe SQLite — beides erzeugte stille Ausfälle.
        with ThreadPoolExecutor(max_workers=4) as ex:
            return dict(ex.map(update_one, tickers))

    # Der Pool blockiert; in einer async-Route würde er den Event-Loop anhalten und
    # alle parallelen /api/prices/-Abrufe der Oberfläche mit ausbremsen.
    results = await run_in_threadpool(run_all)

    failed = {t: r["error"] for t, r in results.items() if not r["ok"]}
    if failed and len(failed) == len(tickers):
        # Komplett fehlgeschlagen (Yahoo weg, kein Netz) — Sperre wieder freigeben,
        # sonst wartet der Benutzer eine Minute auf einen Versuch, der nichts tat.
        with _last_update_lock:
            _last_update.pop(user, None)

    return JSONResponse(content={
        "ok": not failed,
        "requested": len(tickers),
        "updated": len(tickers) - len(failed),
        "failed": failed,
    })

@app.post("/api/prices/repair/{ticker}")
async def repair_ticker(ticker: str, request: Request):
    """Ticker nach einem fehlerhaften Split-Reconcile sauber neu aufbauen.

    Behebt Fälle, in denen einzelne Tage doppelt split-korrigiert wurden (z.B. weil
    Yahoo die jüngsten Vor-Split-Tage schon adjustiert lieferte und der frühere
    pauschale Blanket-Divide sie ein zweites Mal halbierte). Löscht Split-Marker +
    alle Kurszeilen des Tickers und lädt die Historie voll neu — die korrigierte
    _reconcile_splits-Logik skaliert dann nur noch den echten Roh-Block.

    Zeichnungen werden NICHT erneut skaliert (sie wurden beim ursprünglichen Lauf
    bereits angepasst) → hier bewusst ohne _adjust_drawings_for_split.
    """
    ticker = ticker.strip().upper()
    user  = get_user(request)
    files = get_user_files(user)
    init_db(files["db"])
    conn = get_db(files["db"])
    error, split_factors = None, []
    try:
        conn.execute("DELETE FROM ticker_splits WHERE ticker=?", (ticker,))
        conn.execute("DELETE FROM prices WHERE ticker=?", (ticker,))
        conn.commit()
        try:
            _n, split_factors = update_ticker(ticker, conn)
        except Exception as e:
            error = str(e)
        count = conn.execute(
            "SELECT COUNT(*) AS c FROM prices WHERE ticker=?", (ticker,)).fetchone()["c"]
    finally:
        conn.close()
    return JSONResponse(content={
        "ok": error is None, "ticker": ticker, "rows": count,
        "splits_applied": split_factors, "error": error,
    })

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
    init_db(files["db"])   # frischer Benutzer: sonst "no such table: prices"
    conn = get_db(files["db"])
    rows = conn.execute(
        "SELECT date,open,high,low,close,volume FROM prices "
        "WHERE ticker=? ORDER BY date",
        (ticker,)
    ).fetchall()
    conn.close()
    return JSONResponse(content=[dict(r) for r in rows])

# On-Demand-Ticker (z.B. Sektor-ETF-Overlay): sorgt dafür, dass Kursdaten vorhanden
# und aktuell sind, und gibt sie zurück. Anders als /api/prices/update OHNE das
# globale 1x/min-Limit — es holt nur bei fehlenden/veralteten Daten (Delta) und
# drosselt pro (User,Ticker) auf max. 1 Yahoo-Abruf/60s gegen wiederholtes Toggeln.
_last_ensure: dict[str, float] = {}        # "user:ticker" -> ts (prozessweiter Throttle)
_last_ensure_lock = threading.Lock()

@app.get("/api/prices/ensure/{ticker}")
async def ensure_prices(ticker: str, request: Request):
    ticker = ticker.strip().upper()
    user   = get_user(request)
    files  = get_user_files(user)
    init_db(files["db"])
    conn   = get_db(files["db"])
    try:
        # Kein Datums-Vorfilter mehr: früher wurde nur geholt, wenn der jüngste
        # gespeicherte Tag vor heute lag. Existierte der heutige Balken schon, blieb
        # er stehen, wie alt er auch war — samt des Volumens, das er in dem Moment
        # hatte, in dem er zufällig geschrieben wurde. Die 60-s-Drossel je
        # (Benutzer, Ticker) hält die Yahoo-Last trotzdem klein.
        with _last_ensure_lock:
            key   = f"{user}:{ticker}"
            stale = time.time() - _last_ensure.get(key, 0) >= 60
            if stale:
                _last_ensure[key] = time.time()
        if stale:
            try:
                _n, split_factors = update_ticker(ticker, conn)
                if split_factors:
                    _adjust_drawings_for_split(files["data_dir"], "ticker:" + ticker, split_factors)
            except Exception:
                pass
        rows = conn.execute(
            "SELECT date,open,high,low,close,volume FROM prices WHERE ticker=? ORDER BY date",
            (ticker,)
        ).fetchall()
    finally:
        conn.close()
    return JSONResponse(content=[dict(r) for r in rows])

@app.get("/api/splits")
async def get_splits(request: Request):
    """Alle bekannten Splits je Ticker: {"AAPL": [{"date": ..., "ratio": 4.0}, …]}.

    Quelle ist `ticker_splits`, gefüllt von `_reconcile_splits` aus Yahoos
    vollständiger Split-Historie (range=max). Das Frontend rechnet damit die
    IBKR-Trades auf die heutige Kursskala um: Die Kurse in `prices` sind
    split-bereinigt, die Ausführungskurse und Stückzahlen aus dem Flex-Report
    dagegen die historisch echten. Ohne Umrechnung sitzt ein Kauf von vor einem
    4:1-Split viermal zu hoch im Chart.

    `applied` spielt dabei keine Rolle: es sagt nur, ob WIR die Altkurse noch
    skalieren mussten oder Yahoo sie schon bereinigt geliefert hat — auf der
    aktuellen Skala liegen sie in beiden Fällen.
    """
    user  = get_user(request)
    files = get_user_files(user)
    init_db(files["db"])
    conn  = get_db(files["db"])
    rows  = conn.execute(
        "SELECT ticker, date, ratio FROM ticker_splits ORDER BY ticker, date"
    ).fetchall()
    conn.close()
    out: dict[str, list] = {}
    for r in rows:
        out.setdefault(r["ticker"], []).append({"date": r["date"], "ratio": r["ratio"]})
    return JSONResponse(content=out)

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


# ── Earnings-Termine ─────────────────────────────────────────────────────────────
# Vergangene + kommende Earnings-Daten via yfinance (get_earnings_dates), gecacht in
# der User-DB (Tabellen earnings/earnings_meta). Gleiche „stale-while-revalidate"-
# Strategie wie ticker_info: gespeicherte Termine sofort zurück, bei Veraltung
# (> TTL) im Hintergrund auffrischen. Genutzt für die vertikalen Earnings-Linien im Chart.

_EARNINGS_CACHE: dict[str, tuple] = {}      # sym -> (timestamp, [ {date, eps_est, eps_act} ])
_EARNINGS_TTL = 24 * 3600                    # Earnings-Termine ändern sich selten → 1 Tag
_EARNINGS_INFLIGHT: set[str] = set()

def _earnings_fetch(sym: str) -> list:
    """Earnings-Termine via yfinance. Liste von {date, eps_est, eps_act}, aufsteigend."""
    import yfinance as yf, math
    df = yf.Ticker(sym).get_earnings_dates(limit=24)
    out: list = []
    if df is None or getattr(df, "empty", True):
        return out

    def _num(v):
        try:
            f = float(v)
            return None if math.isnan(f) else f
        except (TypeError, ValueError):
            return None

    for idx, row in df.iterrows():
        try:
            date_str = idx.date().strftime("%Y-%m-%d")
        except Exception:
            continue
        out.append({
            "date":    date_str,
            "eps_est": _num(row.get("EPS Estimate")),
            "eps_act": _num(row.get("Reported EPS")),
        })
    out.sort(key=lambda r: r["date"])
    return out

def _earnings_db_get(db_file: str, sym: str):
    """Liefert (list, updated_ts) aus der DB oder ([], 0)."""
    try:
        conn = get_db(db_file)
        meta = conn.execute("SELECT updated FROM earnings_meta WHERE ticker=?", (sym,)).fetchone()
        rows = conn.execute(
            "SELECT date, eps_est, eps_act FROM earnings WHERE ticker=? ORDER BY date", (sym,)
        ).fetchall()
        conn.close()
        if meta:
            return [dict(r) for r in rows], (meta["updated"] or 0)
    except Exception as e:
        print(f"earnings db_get {sym}: {e}")
    return [], 0

def _earnings_db_put(db_file: str, sym: str, items: list, ts: float):
    try:
        conn = get_db(db_file)
        conn.execute("DELETE FROM earnings WHERE ticker=?", (sym,))
        conn.executemany(
            "INSERT OR REPLACE INTO earnings (ticker,date,eps_est,eps_act) VALUES (?,?,?,?)",
            [(sym, it["date"], it["eps_est"], it["eps_act"]) for it in items],
        )
        conn.execute("INSERT OR REPLACE INTO earnings_meta (ticker,updated) VALUES (?,?)", (sym, ts))
        conn.commit()
        conn.close()
    except Exception as e:
        print(f"earnings db_put {sym}: {e}")

def _earnings_refresh(sym: str, db_file: str):
    """Blockierende Auffrischung (yfinance + DB-Write) — im Threadpool auszuführen."""
    if sym in _EARNINGS_INFLIGHT:
        return None
    _EARNINGS_INFLIGHT.add(sym)
    try:
        items = _earnings_fetch(sym)
        ts = time.time()
        _EARNINGS_CACHE[sym] = (ts, items)
        _earnings_db_put(db_file, sym, items, ts)
        return items
    except Exception as e:
        print(f"earnings refresh {sym}: {e}")
        return None
    finally:
        _EARNINGS_INFLIGHT.discard(sym)

@app.get("/api/earnings/{ticker}")
async def get_earnings(ticker: str, request: Request):
    import asyncio, datetime
    user  = get_user(request)
    files = get_user_files(user)
    init_db(files["db"])
    sym = (ticker or "").strip().upper()
    if not sym:
        return JSONResponse({"ok": False, "error": "Kein Ticker"}, status_code=400)

    now   = time.time()
    loop  = asyncio.get_running_loop()
    today = datetime.datetime.utcnow().date().strftime("%Y-%m-%d")

    def _pack(items):
        return [{
            "date":    it["date"],
            "eps_est": it.get("eps_est"),
            "eps_act": it.get("eps_act"),
            "future":  it["date"] > today,
        } for it in items]

    # 1) In-Memory-Cache — frisch → sofort
    cached = _EARNINGS_CACHE.get(sym)
    if cached and now - cached[0] < _EARNINGS_TTL:
        return JSONResponse({"ok": True, "cached": "mem", "earnings": _pack(cached[1])})

    # 2) DB — vorhanden → SOFORT zurück; bei Veraltung im Hintergrund auffrischen
    items, updated = _earnings_db_get(files["db"], sym)
    if items:
        _EARNINGS_CACHE[sym] = (updated, items)
        if now - updated >= _EARNINGS_TTL:
            asyncio.ensure_future(loop.run_in_executor(None, _earnings_refresh, sym, files["db"]))
        return JSONResponse({"ok": True, "cached": "db",
                             "stale": now - updated >= _EARNINGS_TTL, "earnings": _pack(items)})

    # 3) Nichts gespeichert → live holen (erster Abruf je Ticker)
    try:
        result = await loop.run_in_executor(None, _earnings_refresh, sym, files["db"])
        if result is None:                       # parallele Auffrischung war schon unterwegs
            result = _EARNINGS_CACHE.get(sym, (0, []))[1]
        return JSONResponse({"ok": True, "cached": False, "earnings": _pack(result)})
    except Exception as e:
        print(f"earnings error {sym}: {e}")
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
    """Speichert die Config und merkt sich nebenbei, was aus Screener-Baskets
    verschwunden ist (→ Blacklist, siehe _screener_protokolliere_entfernte).

    `?quelle=screener` schaltet das Protokoll für diesen Aufruf ab: wenn der
    Screener seine Baskets selbst neu schreibt, fehlen dort Werte, die diesmal
    schlicht kein Treffer mehr waren — das ist keine Absage des Benutzers.
    """
    user  = get_user(request)
    files = get_user_files(user)
    neu   = await request.json()

    # Notbremse: einen vorhandenen Bestand an Portfolios nicht durch nichts
    # ersetzen. Am 2026-09-14 hat die Oberfläche beim Laden einer leer
    # angekommenen Config selbsttätig ein „Mein Portfolio" angelegt und
    # zurückgeschrieben — damit waren die echten Baskets weg. Die Ursache ist
    # behoben, aber ein alter Browser-Tab kann dasselbe jederzeit wieder tun,
    # und das Löschen aller Portfolios auf einmal ist über die Oberfläche
    # ohnehin nicht vorgesehen.
    alt = load_config(files["config"])
    alt_n = len(alt.get("baskets") or {})
    neu_n = len(neu.get("baskets") or {})
    if alt_n and not neu_n:
        print(f"[Config] Speichern abgelehnt: {alt_n} Portfolios -> 0 (Benutzer {user})")
        return JSONResponse({"ok": False, "abgelehnt": "leer",
                             "error": f"Speichern abgelehnt: Der Server hat {alt_n} Portfolios, "
                                      f"gesendet wurden 0. Bitte die Seite neu laden."},
                            status_code=409)
    if alt_n > 1 and neu_n == 1 and not request.query_params.get("bestaetigt"):
        einziger = list((neu.get("baskets") or {}).values())[0]
        if (einziger.get("name") == "Mein Portfolio") and not (einziger.get("weights") or {}):
            print(f"[Config] Speichern abgelehnt: {alt_n} Portfolios -> leeres "
                  f"Mein Portfolio (Benutzer {user})")
            return JSONResponse({"ok": False, "abgelehnt": "notbasket",
                                 "error": f"Speichern abgelehnt: Der Server hat {alt_n} Portfolios, "
                                          f"gesendet wurde nur ein leeres „Mein Portfolio“. "
                                          f"Bitte die Seite neu laden."},
                                status_code=409)

    gesperrt = []
    if request.query_params.get("quelle") != "screener":
        try:
            gesperrt = _screener_protokolliere_entfernte(user, alt, neu)
        except Exception as e:
            print(f"Blacklist-Protokoll fehlgeschlagen: {e}")   # Speichern geht trotzdem weiter
    save_config_data(files["config"], neu)
    return JSONResponse(content={"ok": True, "blacklisted": gesperrt})

@app.post("/api/appearance")
async def set_appearance(request: Request):
    """Nur den Abschnitt `appearance` der Config schreiben — Aussehen und die
    benutzerweiten Chart-Einstellungen.

    Eigener Endpunkt, weil POST /api/config die Config als **Ganzes** ersetzt:
    beim Umschalten eines Indikators würden sonst auch Gewichte mitgeschrieben,
    die der Benutzer gerade nur ausprobiert und noch nicht gespeichert hat.
    """
    user  = get_user(request)
    files = get_user_files(user)
    body  = await request.json()
    neu   = body.get("appearance")
    if not isinstance(neu, dict):
        return JSONResponse({"ok": False, "error": "appearance fehlt"}, status_code=400)
    cfg = load_config(files["config"])
    cfg["appearance"] = neu
    save_config_data(files["config"], cfg)
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

def _isin_auto_resolve(conn, items) -> int:
    """Füllt die isin_map für (symbol, isin, currency)-Tripel. Gibt die Zahl der
    neu aufgelösten ISINs zurück.

    Nur fehlende oder auto-aufgelöste Einträge — manuelle (auto=0) bleiben fix.
    USD-Positionen nutzen das blanke Symbol (US-Listing nutzt kein Yahoo-Suffix);
    sonst Yahoo-Suche per ISIN (liefert i.d.R. die Heimatbörse, passt zu EUR/GBP).
    Wird vom IBKR-Sync und vom Depot-Import benutzt.
    """
    import urllib.request as urlreq
    geloest = 0
    try:
        existing = {r["isin"]: r["auto"] for r in conn.execute("SELECT isin, auto FROM isin_map").fetchall()}
    except Exception as e:
        print(f"[ISIN] auto-resolve uebersprungen: {e}")
        return 0
    seen = set()
    for sym, isin, cur in items:
        # Jede ISIN für sich absichern — ein Ausreißer darf nicht den Rest verschlucken.
        try:
            isin = (isin or "").strip().upper()
            cur  = (cur or "").strip().upper()
            if not isin or isin in seen:
                continue
            if isin in existing and existing[isin] == 0:   # manuell → nicht anfassen
                continue
            seen.add(isin)
            ysym = None
            # Nur wenn das Symbol wirklich ein Ticker ist — beim Depot-Import steht
            # dort die ISIN selbst, die als Yahoo-Symbol nichts taugt.
            if cur == "USD" and sym and sym.upper() != isin:
                ysym = sym
            else:
                try:
                    u  = f"https://query1.finance.yahoo.com/v1/finance/search?q={isin}&quotesCount=5"
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
                    (isin, ysym))
                geloest += 1
                # ASCII-Pfeil: die Windows-Konsole beim lokalen Lauf kann kein → und
                # riss frueher den ganzen Auflöse-Lauf mit in den Fehlerzweig.
                print(f"[ISIN] {isin} -> {ysym} (auto, {cur})")
        except Exception as e:
            print(f"[ISIN] {isin} uebersprungen: {e}")
    try:
        conn.commit()
    except Exception as e:
        print(f"[ISIN] commit fehlgeschlagen: {e}")
    return geloest

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
    # Nur Aktien — Futures/Optionen haben keine handelbare ISIN bei Yahoo.
    _isin_auto_resolve(conn, [
        (prow[0], prow[9], prow[10]) for prow in positions
        if (prow[6] or "").upper() == "STK"
    ])

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
    """Alle Positionen als JSON — IBKR und die weiteren Depots aus /api/konten.

    Beide Quellen haben dieselben Spaltennamen und werden deshalb hier einfach
    aneinandergehängt; das Feld `account` sagt, woher eine Zeile stammt. Dadurch
    laufen Positionstabelle, Portfolio-Report, Sektor-Allokation und die
    Watchlist-Werte ohne Sonderfall über beide Depots.
    """
    user  = get_user(request)
    files = get_user_files(user)
    _init_ibkr_tables(files["db"])
    _init_account_tables(files["db"])
    conn  = get_db(files["db"])
    out   = []
    for r in conn.execute("SELECT * FROM positions ORDER BY symbol").fetchall():
        d = dict(r)
        d["account"] = "IBKR"
        out.append(d)
    for r in conn.execute(
            "SELECT p.*, a.name AS konto FROM depot_positions p "
            "JOIN accounts a ON a.id = p.account_id "
            "WHERE COALESCE(a.archived,0) = 0 ORDER BY a.name, p.symbol").fetchall():
        d = dict(r)
        d["account"] = d.pop("konto")
        out.append(d)
    conn.close()
    return JSONResponse(content=out)

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

# ── Konten & Vermögen ──────────────────────────────────────────────────────────
# Alles, was NICHT bei IBKR liegt: Girokonten, Tagesgeld, weitere Depots (Baader/
# Smartbroker), Darlehen und Sachwerte. Bewusst eigene Tabellen — `_do_ibkr_sync`
# ersetzt `positions`/`cash_balances` komplett (DELETE ohne WHERE), diese Daten
# dürfen ihm nicht in die Quere kommen.
#
# Vorzeichen: 'darlehen' zählt negativ, alles andere positiv. Restschulden werden
# IMMER als positive Zahl gespeichert, das Minus entsteht erst in der Summe.
#
# Verlauf: `account_history` hält je Konto und Tag den GESAMTBEITRAG des Kontos
# (bei Depots also Positionen + Verrechnungskonto). Der IBKR-Anteil lässt sich
# nicht rekonstruieren und wird täglich in `wealth_history` fortgeschrieben.

ACCOUNT_KINDS   = ("giro", "tagesgeld", "depot", "darlehen", "sachwert")
# Zuordnung Kontoart → Gruppe der Vermögensübersicht
ACCOUNT_GROUPS  = {"giro": "guthaben", "tagesgeld": "guthaben", "depot": "depots",
                   "darlehen": "schulden", "sachwert": "sachwerte"}

def _init_account_tables(db_file: str):
    """Erstellt die Konten-Tabellen falls nicht vorhanden."""
    conn = get_db(db_file)
    conn.execute('''CREATE TABLE IF NOT EXISTS accounts (
        id             TEXT PRIMARY KEY,
        name           TEXT,
        kind           TEXT,
        institute      TEXT,
        currency       TEXT DEFAULT 'EUR',
        fx_rate        REAL DEFAULT 1.0,
        note           TEXT,
        balance        REAL DEFAULT 0,
        balance_date   TEXT,
        sort           INTEGER DEFAULT 0,
        archived       INTEGER DEFAULT 0,
        rate           REAL,
        interest       REAL,
        fixed_until    TEXT,
        asset_id       TEXT,
        valuation      REAL,
        valuation_date TEXT,
        updated        TEXT
    )''')
    # Migrationen nach dem Muster von _init_ibkr_tables
    for ddl in ("fx_rate REAL DEFAULT 1.0", "asset_id TEXT", "valuation REAL",
                "valuation_date TEXT", "fixed_until TEXT", "archived INTEGER DEFAULT 0"):
        try:
            conn.execute(f"ALTER TABLE accounts ADD COLUMN {ddl}")
        except Exception:
            pass
    conn.execute('''CREATE TABLE IF NOT EXISTS account_history (
        account_id TEXT,
        date       TEXT,
        value      REAL,
        PRIMARY KEY (account_id, date)
    )''')
    # Gleiche Spaltennamen wie `positions` — dadurch laufen ibkrLiveValue,
    # ibkrPosYahoo und das ISIN-Mapping im Frontend unverändert darüber.
    conn.execute('''CREATE TABLE IF NOT EXISTS depot_positions (
        account_id       TEXT,
        symbol           TEXT,
        quantity         REAL,
        cost_basis_price REAL,
        cost_basis_money REAL,
        mark_price       REAL,
        position_value   REAL,
        asset_class      TEXT DEFAULT 'STK',
        currency         TEXT DEFAULT 'EUR',
        isin             TEXT,
        yahoo_symbol     TEXT,
        fx_rate_to_base  REAL DEFAULT 1.0,
        multiplier       REAL DEFAULT 1.0,
        name             TEXT,
        updated          TEXT,
        PRIMARY KEY (account_id, symbol)
    )''')
    # Nur der IBKR-Anteil: alles andere wird aus account_history gerechnet, damit
    # eine nachträgliche Korrektur eines Kontostands rückwirkend durchschlägt.
    conn.execute('''CREATE TABLE IF NOT EXISTS wealth_history (
        date TEXT PRIMARY KEY,
        ibkr REAL
    )''')
    # Einzelbuchungen aus camt/CSV. `saldo` ist der Stand NACH der Buchung —
    # daraus entsteht der Tagesverlauf, siehe _umsatz_verlauf_schreiben.
    conn.execute('''CREATE TABLE IF NOT EXISTS account_transactions (
        account_id TEXT,
        tx_id      TEXT,
        date       TEXT,
        valuta     TEXT,
        amount     REAL,
        currency   TEXT DEFAULT 'EUR',
        saldo      REAL,
        name       TEXT,
        purpose    TEXT,
        kind       TEXT,
        ref        TEXT,
        seq        INTEGER DEFAULT 0,
        source     TEXT,
        imported   TEXT,
        isin       TEXT,
        quantity   REAL,
        datei      TEXT,
        PRIMARY KEY (account_id, tx_id)
    )''')
    # Nachtraeglich ergaenzt, damit aus den Buchungen der Wertpapierbestand
    # rueckwaerts gerechnet werden kann (siehe _depot_rueckrechnung).
    for ddl in ("isin TEXT", "quantity REAL", "datei TEXT"):
        try:
            conn.execute(f"ALTER TABLE account_transactions ADD COLUMN {ddl}")
        except Exception:
            pass
    conn.execute("CREATE INDEX IF NOT EXISTS idx_acc_tx_datum "
                 "ON account_transactions (account_id, date)")
    # Kontostände des Verrechnungskontos aus den Auszügen (OPBD/CLBD).
    # Beim Depot gehören die NICHT in account_history — dort steht der
    # Gesamtbeitrag inklusive Wertpapiere. Für die Rückrechnung werden sie
    # trotzdem gebraucht, und in einem buchungsfreien Monat sind sie das
    # Einzige, was über den Zeitraum bekannt ist.
    conn.execute('''CREATE TABLE IF NOT EXISTS account_cash_balances (
        account_id TEXT,
        date       TEXT,
        saldo      REAL,
        PRIMARY KEY (account_id, date)
    )''')
    conn.commit()
    conn.close()

def _heute() -> str:
    return time.strftime("%Y-%m-%d")

def _de_num(v):
    """'1.234,56' → 1234.56, '1,234.56' → 1234.56, '12,5' → 12.5. Leer → None.

    Ein einzelner Punkt vor genau drei Ziffern ist mehrdeutig ('1.234' = 1234 im
    Deutschen, 1.234 im Englischen). Bei einer führenden 0 gewinnt der Dezimal-
    punkt (Bruchstücke aus ETF-Sparplänen), sonst der Tausenderpunkt.
    """
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).replace(" ", " ").strip()
    if not s:
        return None
    neg = s.startswith("-") or (s.startswith("(") and s.endswith(")"))
    s = re.sub(r"[^0-9,.]", "", s)
    if not s:
        return None
    if "," in s and "." in s:
        if s.rfind(",") > s.rfind("."):          # 1.234,56 → deutsch
            s = s.replace(".", "").replace(",", ".")
        else:                                     # 1,234.56 → englisch
            s = s.replace(",", "")
    elif "," in s:
        s = s.replace(",", ".", 1).replace(",", "")
    elif re.fullmatch(r"[1-9]\d{0,2}(\.\d{3})+", s):
        s = s.replace(".", "")                    # 1.234.567 → Tausenderpunkte
    try:
        f = float(s)
    except ValueError:
        return None
    return -f if neg and f > 0 else f

def _account_positions_value(conn, account_id: str) -> float:
    """Summe der Positionen eines Depotkontos in Base (EUR)."""
    row = conn.execute(
        "SELECT COALESCE(SUM(position_value * COALESCE(fx_rate_to_base, 1.0)), 0) AS v "
        "FROM depot_positions WHERE account_id = ?", (account_id,)).fetchone()
    return float(row["v"] or 0)

def _account_value(conn, acc) -> float:
    """Gesamtbeitrag eines Kontos in EUR, OHNE Vorzeichen der Gruppe.

    Depot = Wertpapiere + Verrechnungskonto. Sachwert = geschätzter Verkaufserlös.
    Darlehen = Restschuld (positiv; das Minus setzt erst die Summe).
    """
    kind = acc["kind"]
    fx   = float(acc["fx_rate"] or 1.0)
    if kind == "sachwert":
        return float(acc["valuation"] or 0) * fx
    val = float(acc["balance"] or 0) * fx
    if kind == "depot":
        val += _account_positions_value(conn, acc["id"])
    if kind == "darlehen":
        val = abs(val)
    return val

def _account_row(conn, acc) -> dict:
    """Konto als JSON-Objekt inkl. berechneter Werte."""
    d = dict(acc)
    d["kind"]      = d.get("kind") or "giro"
    d["group"]     = ACCOUNT_GROUPS.get(d["kind"], "guthaben")
    d["value"]     = _account_value(conn, acc)
    d["signed"]    = -d["value"] if d["kind"] == "darlehen" else d["value"]
    if d["kind"] == "depot":
        d["positions_value"] = _account_positions_value(conn, acc["id"])
        d["positions_count"] = conn.execute(
            "SELECT COUNT(*) AS c FROM depot_positions WHERE account_id = ?",
            (acc["id"],)).fetchone()["c"]
    return d

def _write_account_history(conn, account_id: str, value: float, date: str = None):
    """Schreibt den Gesamtbeitrag eines Kontos für einen Tag (ein Eintrag je Tag)."""
    conn.execute(
        "INSERT INTO account_history (account_id, date, value) VALUES (?,?,?) "
        "ON CONFLICT(account_id, date) DO UPDATE SET value = excluded.value",
        (account_id, date or _heute(), float(value or 0)))

def _ibkr_db_value(conn) -> float:
    """IBKR-Depotwert aus den zuletzt gesynct Zahlen (ohne Live-Kurse).

    Entspricht der Zeile "NET Gesamt" im Portfolio-Report: Positionen + Cash.
    Das Frontend rechnet dieselbe Summe mit Live-Kursen und darf sie an
    /api/vermoegen mitgeben; ohne diese Angabe gilt der Stand vom letzten Sync.
    """
    try:
        pos  = conn.execute(
            "SELECT COALESCE(SUM(position_value * COALESCE(fx_rate_to_base,1.0)),0) AS v "
            "FROM positions").fetchone()["v"] or 0
        cash = conn.execute(
            "SELECT ending_cash FROM cash_balances WHERE currency='BASE'").fetchone()
        return float(pos) + float(cash["ending_cash"] if cash else 0)
    except Exception:
        return 0.0

def _wealth_summary(conn, ibkr: float = None) -> dict:
    """Vermögensübersicht nach Gruppen."""
    accs = conn.execute(
        "SELECT * FROM accounts WHERE COALESCE(archived,0) = 0 ORDER BY sort, name").fetchall()
    grp = {"depots": 0.0, "guthaben": 0.0, "sachwerte": 0.0, "schulden": 0.0}
    for a in accs:
        grp[ACCOUNT_GROUPS.get(a["kind"], "guthaben")] += _account_value(conn, a)
    grp["ibkr"]  = float(ibkr) if ibkr is not None else _ibkr_db_value(conn)
    grp["total"] = grp["ibkr"] + grp["depots"] + grp["guthaben"] + grp["sachwerte"] - grp["schulden"]
    return grp

def _wealth_series(conn) -> list:
    """Tagesreihe des Vermögens nach Gruppen.

    Kontostände werden vorwärts gefüllt: ein Konto ohne neuen Eintrag behält
    seinen letzten bekannten Stand, statt auf null zu fallen. Der IBKR-Anteil
    kommt aus wealth_history (ebenfalls vorwärts gefüllt).
    """
    kinds = {r["id"]: r["kind"] for r in conn.execute("SELECT id, kind FROM accounts").fetchall()}
    hist  = conn.execute(
        "SELECT account_id, date, value FROM account_history ORDER BY date").fetchall()
    wh    = conn.execute("SELECT date, ibkr FROM wealth_history ORDER BY date").fetchall()

    tage = sorted({r["date"] for r in hist} | {r["date"] for r in wh})
    if not tage:
        return []
    per_tag_acc = {}
    for r in hist:
        per_tag_acc.setdefault(r["date"], []).append((r["account_id"], r["value"]))
    per_tag_ibkr = {r["date"]: r["ibkr"] for r in wh}

    stand, ibkr_stand, out = {}, 0.0, []
    for tag in tage:
        for acc_id, val in per_tag_acc.get(tag, []):
            stand[acc_id] = float(val or 0)
        if tag in per_tag_ibkr:
            ibkr_stand = float(per_tag_ibkr[tag] or 0)
        grp = {"depots": 0.0, "guthaben": 0.0, "sachwerte": 0.0, "schulden": 0.0}
        for acc_id, val in stand.items():
            if acc_id in kinds:
                grp[ACCOUNT_GROUPS.get(kinds[acc_id], "guthaben")] += val
        grp["date"]  = tag
        grp["ibkr"]  = ibkr_stand
        grp["total"] = ibkr_stand + grp["depots"] + grp["guthaben"] + grp["sachwerte"] - grp["schulden"]
        out.append(grp)
    return out

@app.get("/api/konten")
async def konten_list(request: Request):
    """Alle Konten mit berechneten Werten + Vermögensübersicht."""
    user  = get_user(request)
    files = get_user_files(user)
    _init_account_tables(files["db"])
    _init_ibkr_tables(files["db"])
    conn = get_db(files["db"])
    accs = conn.execute("SELECT * FROM accounts ORDER BY sort, name").fetchall()
    out  = [_account_row(conn, a) for a in accs]
    summary = _wealth_summary(conn)
    conn.close()
    return JSONResponse({"accounts": out, "summary": summary})

@app.post("/api/konten")
async def konten_save(request: Request):
    """Legt ein Konto an oder ändert es (Upsert über `id`).

    Schreibt den Gesamtbeitrag als Verlaufseintrag — für `balance_date`, falls
    angegeben, sonst für heute. So kann beim Anlegen gleich ein Anfangsstand mit
    zurückliegendem Datum hinterlegt werden und die Kurve beginnt nicht erst heute.
    """
    user  = get_user(request)
    files = get_user_files(user)
    _init_account_tables(files["db"])
    body  = await request.json()

    name = (body.get("name") or "").strip()
    kind = (body.get("kind") or "giro").strip().lower()
    if not name:
        return JSONResponse({"ok": False, "error": "Name erforderlich"}, status_code=400)
    if kind not in ACCOUNT_KINDS:
        return JSONResponse({"ok": False, "error": f"Unbekannte Kontoart: {kind}"}, status_code=400)

    acc_id = (body.get("id") or "").strip() or f"acc_{int(time.time()*1000)}_{_secrets.token_hex(3)}"
    bal    = _de_num(body.get("balance")) or 0.0
    if kind == "darlehen":
        bal = abs(bal)                      # Restschuld immer positiv speichern
    fx     = _de_num(body.get("fx_rate")) or 1.0
    datum  = (body.get("balance_date") or "").strip() or _heute()

    conn = get_db(files["db"])
    conn.execute('''INSERT INTO accounts
        (id, name, kind, institute, currency, fx_rate, note, balance, balance_date,
         sort, archived, rate, interest, fixed_until, asset_id, valuation, valuation_date, updated)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET
            name=excluded.name, kind=excluded.kind, institute=excluded.institute,
            currency=excluded.currency, fx_rate=excluded.fx_rate, note=excluded.note,
            balance=excluded.balance, balance_date=excluded.balance_date,
            sort=excluded.sort, archived=excluded.archived, rate=excluded.rate,
            interest=excluded.interest, fixed_until=excluded.fixed_until,
            asset_id=excluded.asset_id, valuation=excluded.valuation,
            valuation_date=excluded.valuation_date, updated=excluded.updated''',
        (acc_id, name, kind, (body.get("institute") or "").strip(),
         (body.get("currency") or "EUR").strip().upper() or "EUR", fx,
         (body.get("note") or "").strip(), bal, datum,
         int(body.get("sort") or 0), 1 if body.get("archived") else 0,
         _de_num(body.get("rate")), _de_num(body.get("interest")),
         (body.get("fixed_until") or "").strip() or None,
         (body.get("asset_id") or "").strip() or None,
         _de_num(body.get("valuation")),
         (body.get("valuation_date") or "").strip() or None,
         time.strftime("%Y-%m-%d %H:%M:%S")))

    acc = conn.execute("SELECT * FROM accounts WHERE id = ?", (acc_id,)).fetchone()
    _write_account_history(conn, acc_id, _account_value(conn, acc), datum)
    conn.commit()
    row = _account_row(conn, acc)
    conn.close()
    return JSONResponse({"ok": True, "account": row})

@app.delete("/api/konten/{account_id}")
async def konten_delete(account_id: str, request: Request):
    """Entfernt ein Konto samt Verlauf und Positionen."""
    user  = get_user(request)
    files = get_user_files(user)
    _init_account_tables(files["db"])
    conn = get_db(files["db"])
    conn.execute("DELETE FROM accounts         WHERE id = ?",         (account_id,))
    conn.execute("DELETE FROM account_history  WHERE account_id = ?", (account_id,))
    conn.execute("DELETE FROM depot_positions  WHERE account_id = ?", (account_id,))
    conn.execute("DELETE FROM account_transactions  WHERE account_id = ?", (account_id,))
    conn.execute("DELETE FROM account_cash_balances WHERE account_id = ?", (account_id,))
    # Verweise von Darlehen auf einen gelöschten Sachwert aufräumen
    conn.execute("UPDATE accounts SET asset_id = NULL WHERE asset_id = ?", (account_id,))
    conn.commit()
    conn.close()
    return JSONResponse({"ok": True})

@app.get("/api/konten/{account_id}/verlauf")
async def konten_verlauf(account_id: str, request: Request):
    """Verlauf eines Kontos, älteste zuerst."""
    user  = get_user(request)
    files = get_user_files(user)
    _init_account_tables(files["db"])
    conn = get_db(files["db"])
    rows = conn.execute(
        "SELECT date, value FROM account_history WHERE account_id = ? ORDER BY date",
        (account_id,)).fetchall()
    conn.close()
    return JSONResponse([dict(r) for r in rows])

@app.post("/api/konten/{account_id}/verlauf")
async def konten_verlauf_set(account_id: str, request: Request):
    """Trägt einen Stand für ein Datum nach oder korrigiert ihn (löschen: value=null).

    Ist das Datum der jüngste Eintrag, wandert der Wert auch in `accounts.balance`,
    damit Übersicht und Verlauf nicht auseinanderlaufen.
    """
    user  = get_user(request)
    files = get_user_files(user)
    _init_account_tables(files["db"])
    body  = await request.json()
    datum = (body.get("date") or "").strip()
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", datum):
        return JSONResponse({"ok": False, "error": "Datum als JJJJ-MM-TT erwartet"}, status_code=400)

    conn = get_db(files["db"])
    acc  = conn.execute("SELECT * FROM accounts WHERE id = ?", (account_id,)).fetchone()
    if not acc:
        conn.close()
        return JSONResponse({"ok": False, "error": "Konto nicht gefunden"}, status_code=404)

    if body.get("value") is None and "value" in body:
        conn.execute("DELETE FROM account_history WHERE account_id = ? AND date = ?",
                     (account_id, datum))
    else:
        val = _de_num(body.get("value")) or 0.0
        if acc["kind"] == "darlehen":
            val = abs(val)
        _write_account_history(conn, account_id, val, datum)
        juengste = conn.execute(
            "SELECT MAX(date) AS d FROM account_history WHERE account_id = ?",
            (account_id,)).fetchone()["d"]
        if juengste == datum and acc["kind"] != "depot":
            feld = "valuation" if acc["kind"] == "sachwert" else "balance"
            conn.execute(f"UPDATE accounts SET {feld} = ?, balance_date = ? WHERE id = ?",
                         (val / float(acc["fx_rate"] or 1.0), datum, account_id))
    conn.commit()
    conn.close()
    return JSONResponse({"ok": True})

@app.get("/api/konten/{account_id}/positionen")
async def konten_positionen(account_id: str, request: Request):
    """Positionen eines Depotkontos."""
    user  = get_user(request)
    files = get_user_files(user)
    _init_account_tables(files["db"])
    conn = get_db(files["db"])
    rows = conn.execute(
        "SELECT * FROM depot_positions WHERE account_id = ? ORDER BY symbol",
        (account_id,)).fetchall()
    conn.close()
    return JSONResponse([dict(r) for r in rows])

def _positionen_schreiben(db_file: str, account_id: str, items: list) -> dict:
    """Ersetzt die Positionsliste eines Depotkontos.

    `items`: Liste aus {isin, name, quantity, cost_basis_price, mark_price,
    position_value, currency}. Fehlende Werte werden abgeleitet (Wert = Menge ×
    Kurs und umgekehrt). Danach wandert der neue Depotwert in den Verlauf.
    """
    _init_account_tables(db_file)
    _init_ibkr_tables(db_file)

    conn = get_db(db_file)
    acc  = conn.execute("SELECT * FROM accounts WHERE id = ?", (account_id,)).fetchone()
    if not acc:
        conn.close()
        return {"ok": False, "error": "Konto nicht gefunden", "status": 404}

    now  = time.strftime("%Y-%m-%d %H:%M:%S")
    rows = []
    for it in items:
        isin = (it.get("isin") or "").strip().upper() or None
        sym  = (it.get("symbol") or "").strip().upper() or isin
        if not sym:
            continue
        qty   = _de_num(it.get("quantity")) or 0.0
        price = _de_num(it.get("mark_price"))
        wert  = _de_num(it.get("position_value"))
        if wert is None and price is not None:
            wert = qty * price
        if price is None and wert is not None and qty:
            price = wert / qty
        einst = _de_num(it.get("cost_basis_price"))
        ebm   = _de_num(it.get("cost_basis_money"))
        if ebm is None and einst is not None:
            ebm = qty * einst
        if einst is None and ebm is not None and qty:
            einst = ebm / qty
        cur = (it.get("currency") or acc["currency"] or "EUR").strip().upper()
        rows.append((account_id, sym, qty, einst, ebm, price, wert or 0.0,
                     (it.get("asset_class") or "STK").upper(), cur, isin,
                     (it.get("yahoo_symbol") or "").strip().upper() or None,
                     _de_num(it.get("fx_rate_to_base")) or 1.0, 1.0,
                     (it.get("name") or "").strip() or None, now))

    conn.execute("DELETE FROM depot_positions WHERE account_id = ?", (account_id,))
    if rows:
        conn.executemany(
            "INSERT OR REPLACE INTO depot_positions "
            "(account_id,symbol,quantity,cost_basis_price,cost_basis_money,mark_price,"
            " position_value,asset_class,currency,isin,yahoo_symbol,fx_rate_to_base,"
            " multiplier,name,updated) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
    conn.commit()

    # ISIN → Yahoo-Symbol auflösen, damit die Titel dieselben Kurse bekommen wie
    # die IBKR-Positionen (dieselbe isin_map, manuelle Einträge bleiben unangetastet).
    geloest = _isin_auto_resolve(conn, [(r[1], r[9], r[8]) for r in rows if r[9]])

    acc = conn.execute("SELECT * FROM accounts WHERE id = ?", (account_id,)).fetchone()
    wert_gesamt = _account_value(conn, acc)
    _write_account_history(conn, account_id, wert_gesamt)
    conn.commit()
    conn.close()
    return {"ok": True, "count": len(rows), "isin_aufgeloest": geloest, "wert": wert_gesamt}

@app.post("/api/konten/{account_id}/positionen")
async def konten_positionen_set(account_id: str, request: Request):
    """Ersetzt die Positionsliste eines Depotkontos (Feld `positionen`)."""
    user  = get_user(request)
    files = get_user_files(user)
    body  = await request.json()
    res   = _positionen_schreiben(files["db"], account_id, body.get("positionen") or [])
    return JSONResponse(res, status_code=res.pop("status", 200))

# ── Depotauszug einlesen ───────────────────────────────────────────────────────
# Bewusst generisch statt auf ein Broker-Format verdrahtet: der Text darf aus
# einer CSV-Datei stammen oder direkt aus der Zwischenablage kommen (Tabulatoren).
# Die Spalten werden über die Kopfzeile erraten, die Zuordnung ist in der
# Oberfläche korrigierbar.

# Je Feld die Muster in der Reihenfolge ihrer Güte — das erste, das irgendwo in
# der Kopfzeile greift, gewinnt. Genaue Muster gehören darum nach vorn: der
# Smartbroker-Bestand führt neben „WÄHRUNG" auch „WÄHRUNGSGEWINN", und neben
# „EINSTANDSKURS PRO STÜCK" noch „EINSTANDSWERT".
_SPALTEN_MUSTER = [
    ("isin",             (r"isin",)),
    ("wkn",              (r"wkn",)),
    ("name",             (r"^name 1$", r"bezeichnung", r"wertpapier", r"instrument",
                          r"titel", r"produkt", r"^name$", r"^name", r"security")),
    ("quantity",         (r"^st.?cke?$", r"st.?ck", r"anzahl", r"nominal", r"menge",
                          r"bestand", r"quantity", r"^stk")),
    ("cost_basis_price", (r"einstandskurs", r"einstandspreis", r"einkaufs", r"kaufkurs",
                          r"durchschnitt", r"^ek", r"einstand", r"cost")),
    ("mark_price",       (r"marktkurs", r"aktueller kurs", r"letzter", r"kurs", r"preis",
                          r"price")),
    ("position_value",   (r"kurswert", r"marktwert", r"gesamtwert", r"^wert",
                          r"value", r"volumen")),
    ("cost_basis_money", (r"einstandswert", r"einstandssumme", r"kaufwert")),
    ("currency",         (r"^w.?hrung$", r"^whg$", r"^currency$", r"kontow.?hrung",
                          r"w.?hrung(?!sgewinn)", r"whg", r"currency")),
]

def _trennzeichen(text: str) -> str:
    """Häufigstes Trennzeichen der Kopfzeile — Tab, Semikolon oder Komma."""
    kopf = text.splitlines()[0] if text.splitlines() else ""
    return max(("\t", ";", ","), key=kopf.count) if any(c in kopf for c in "\t;,") else ";"

def _spalten_zuordnen_nach(kopf: list, muster_liste) -> dict:
    """Ordnet Kopfzeilen-Beschriftungen den Feldern zu. {feld: index}

    Das Muster entscheidet VOR der Spaltenposition: erst wird das beste Muster
    über alle Spalten probiert, dann das nächste. Andersherum schnappte sich
    „Währungsgewinn" die Rolle der Währung, nur weil es weiter links steht.
    Eine einmal belegte Spalte ist für die folgenden Felder gesperrt.
    """
    titel = [t.strip().strip('"').lower() for t in kopf]
    zuordnung, belegt = {}, set()
    for feld, muster in muster_liste:
        for m in muster:
            treffer = next((i for i, t in enumerate(titel)
                            if i not in belegt and re.search(m, t)), None)
            if treffer is not None:
                zuordnung[feld] = treffer
                belegt.add(treffer)
                break
    return zuordnung

def _spalten_zuordnen(kopf: list) -> dict:
    """Spalten eines Depotauszugs (Bestandsliste)."""
    return _spalten_zuordnen_nach(kopf, _SPALTEN_MUSTER)

def _tabelle_lesen(text: str, sep: str) -> list:
    """Zerlegt eine Tabelle unter Beachtung von Anführungszeichen.

    Nicht mit split(): der Smartbroker-Export trennt mit Komma und setzt die
    Felder in Anführungszeichen — dort steckt in jedem Betrag ein Dezimalkomma,
    und ein naives Zerlegen verschiebt die ganze Zeile. Das fiel nicht einmal
    auf, weil hinterher trotzdem Zahlen dastanden: aus 30.252 € wurden 1,00 €.
    """
    import csv as _csv, io as _io
    try:
        return [[f.strip() for f in z]
                for z in _csv.reader(_io.StringIO(text), delimiter=sep)
                if any((f or "").strip() for f in z)]
    except Exception:
        return [[f.strip().strip('"') for f in z.split(sep)]
                for z in text.splitlines() if z.strip()]

def _depot_text_parsen(text: str) -> dict:
    """Zerlegt einen eingefügten Depotauszug in Zeilen + erkannte Spalten."""
    text = (text or "").lstrip("﻿")
    if not text.strip():
        return {"ok": False, "error": "Kein Inhalt"}
    sep  = _trennzeichen(text)
    tab  = _tabelle_lesen(text, sep)
    if not tab:
        return {"ok": False, "error": "Kein Inhalt"}
    kopf = tab[0]
    zuordnung = _spalten_zuordnen(kopf)
    daten = tab[1:]
    if "isin" not in zuordnung and "name" not in zuordnung:
        # Keine brauchbare Kopfzeile — ISIN-Muster irgendwo in den Feldern suchen
        for i, feld in enumerate(kopf):
            if re.fullmatch(r"[A-Z]{2}[A-Z0-9]{9}\d", feld.upper()):
                zuordnung["isin"] = i
                daten = tab            # dann ist Zeile 1 schon eine Datenzeile
                break
    if not zuordnung:
        return {"ok": False, "error": "Spalten nicht erkannt — bitte mit Kopfzeile einfügen"}

    hinweise, positionen = [], []
    for z in daten:
        def feld(name):
            i = zuordnung.get(name)
            return z[i] if i is not None and i < len(z) else ""
        isin = feld("isin").upper()
        if isin and not re.fullmatch(r"[A-Z]{2}[A-Z0-9]{9}\d", isin):
            isin = ""
        name = feld("name")
        if not isin and not name:
            continue
        qty = _de_num(feld("quantity"))
        if qty is None and not isin:
            continue                   # Summen-/Leerzeile
        positionen.append({
            "isin": isin or None, "wkn": feld("wkn") or None, "name": name or None,
            "quantity": qty or 0.0,
            "cost_basis_price": _de_num(feld("cost_basis_price")),
            "cost_basis_money": _de_num(feld("cost_basis_money")),
            "mark_price":       _de_num(feld("mark_price")),
            "position_value":   _de_num(feld("position_value")),
            "currency": (feld("currency") or "EUR").upper()[:3] or "EUR",
        })
    if not positionen:
        return {"ok": False, "error": "Keine Positionen erkannt"}
    if "isin" not in zuordnung:
        hinweise.append("Keine ISIN-Spalte gefunden — die Titel bekommen keine Kurse.")
    if "quantity" not in zuordnung:
        hinweise.append("Keine Stück-Spalte gefunden.")
    if "position_value" not in zuordnung and "mark_price" not in zuordnung:
        hinweise.append("Weder Kurs noch Wert gefunden — der Depotwert bleibt 0.")
    # Stück × Kurs muss ungefähr den Wert ergeben. Tut es das reihenweise nicht,
    # sind die Spalten verrutscht — genau das passierte vor dem csv-Modul bei
    # Beträgen mit Dezimalkomma, und zwar ohne dass es jemand merkte.
    pruefbar = [p for p in positionen
                if p["quantity"] and p["mark_price"] and p["position_value"]]
    schief = [p for p in pruefbar
              if abs(p["quantity"] * p["mark_price"] - p["position_value"])
                 > max(1.0, abs(p["position_value"]) * 0.05)]
    if pruefbar and len(schief) > len(pruefbar) / 2:
        hinweise.append("Stück × Kurs passt bei den meisten Zeilen nicht zum Wert — "
                        "die Spalten sind vermutlich falsch zugeordnet. Bitte die "
                        "Vorschau genau ansehen.")
    return {"ok": True, "spalten": kopf, "zuordnung": zuordnung,
            "trennzeichen": {"\t": "Tabulator", ";": "Semikolon", ",": "Komma"}[sep],
            "positionen": positionen, "hinweise": hinweise}

@app.post("/api/konten/{account_id}/import")
async def konten_import(account_id: str, request: Request):
    """Liest einen eingefügten Depotauszug. Vorschau, bis `bestaetigt` gesetzt ist."""
    user  = get_user(request)
    files = get_user_files(user)
    _init_account_tables(files["db"])
    body  = await request.json()
    ergebnis = _depot_text_parsen(body.get("text") or "")
    if not ergebnis.get("ok"):
        return JSONResponse(ergebnis, status_code=400)
    if not body.get("bestaetigt"):
        return JSONResponse(ergebnis)

    # Die Oberfläche darf die erkannte Liste vor dem Übernehmen korrigieren.
    positionen = body.get("positionen") or ergebnis["positionen"]
    res = _positionen_schreiben(files["db"], account_id, positionen)
    res["hinweise"] = ergebnis.get("hinweise", [])
    return JSONResponse(res, status_code=res.pop("status", 200))

# ── Kontoumsätze einlesen (camt.052/053 und CSV) ───────────────────────────────
# Damit Kontostand und Vermögenskurve nicht von Hand kommen.
#
# camt ist der bevorzugte Weg: Salden (OPBD/CLBD) stehen mit Datum drin, Beträge
# sind ISO-Dezimalzahlen, Soll/Haben ist ein eigenes Feld und jede Buchung trägt
# eine Bankreferenz — daraus wird der Schlüssel gegen Doppeleinträge. CSV bleibt
# der schnelle Weg aus der Zwischenablage; dort werden die Spalten wie beim
# Depotauszug über die Kopfzeile erraten.
#
# Die GLS liefert den camt-Export als ZIP mit EINER XML JE ABRUFTAG. Darum wird
# nicht eine Datei gelesen, sondern ein Stapel: jede Datei bringt ihre eigenen
# Salden mit, die Buchungen werden zusammengelegt und der Saldoverlauf am Ende
# über den ganzen Stapel gefüllt.
#
# Depotkonten (Smartbroker/Baader gibt es nur als CSV) sind dabei, aber mit einer
# Einschränkung: `account_history` hält den GESAMTBEITRAG eines Kontos, beim Depot
# also Verrechnungskonto + Wertpapiere. Ein Saldoverlauf des Verrechnungskontos
# würde die Positionen rückwirkend aus der Kurve werfen — darum werden dort nur
# die Buchungen abgelegt und der Verrechnungsstand nachgezogen; der Verlauf
# bekommt einen Eintrag für heute, mit dem Depotwert von heute.

UMSATZ_ARTEN = ("giro", "tagesgeld", "darlehen", "depot")

_UMSATZ_MUSTER = [
    # Reihenfolge zählt: „Saldo nach Buchung" muss vor „Betrag" abgeräumt sein,
    # und die Währung erst danach, damit „Waehrung Saldo" nicht die Betrags-
    # währung belegt.
    ("saldo",      (r"saldo nach", r"^saldo", r"kontostand", r"balance")),
    ("date",       (r"buchungstag", r"buchung", r"^datum", r"date")),
    ("valuta",     (r"valuta", r"wertstellung")),
    # „Gesamtbetrag" zuerst: der Smartbroker-Auszug führt daneben Anlagebetrag,
    # Gebühren, Steuern und Zinsen — nur der Gesamtbetrag ist das, was das
    # Verrechnungskonto tatsächlich bewegt.
    ("amount",     (r"gesamtbetrag", r"^betrag", r"betrag$", r"^umsatz", r"^amount",
                    r"betrag")),
    ("soll_haben", (r"soll.?haben", r"^s/h", r"haben.?kennz", r"cdtdbtind")),
    ("currency",   (r"kontow.?hrung", r"w.?hrung", r"whg", r"currency")),
    ("name",       (r"zahlungsbeteiligter", r"beg.?nstigter", r"auftraggeber",
                    r"zahlungspflichtiger", r"empf.?nger", r"^name", r"gegenkonto")),
    ("purpose",    (r"verwendungszweck", r"zweck", r"vwz", r"referenz")),
    ("kind",       (r"buchungstext", r"transaktionstyp", r"umsatzart", r"vorgang", r"^art")),
    # Nur im Transaktionsexport eines Depots vorhanden — daraus entsteht der
    # Bestandsverlauf, siehe _depot_rueckrechnung.
    ("isin",       (r"^isin$", r"isin")),
    ("quantity",   (r"^st.?cke?$", r"^stk$", r"nominal", r"^anzahl$")),
]

# Vorzeichen aus der Umsatzart, wenn die Datei keine Minuszeichen mitbringt
# (Smartbroker/Baader liefert die Beträge teils vorzeichenlos). Die Liste wird
# der REIHE NACH geprüft — „Verkauf" enthält „kauf", und ein „Zinsabschlag" ist
# eine Steuer, kein Zinsertrag.
_UMSATZ_TYP_VORZEICHEN = [
    (r"verkauf|ver.?u.?er",                                              +1),
    (r"kauf|zeichnung|sparplan",                                         -1),
    (r"steuer|abschlag|geb.?hr|entgelt|provision|pauschale|spesen",      -1),
    (r"dividend|aussch.?tt|ertrag|zins|gutschrift|einzahlung|eingang|"
     r"tilgung|r.?ckzahlung|erstattung",                                 +1),
    (r"lastschrift|auszahlung|abbuchung|belastung|.?berweisung|entnahme", -1),
]

def _umsatz_typ_vorzeichen(typ: str) -> int:
    """+1, -1 oder 0 (unbekannt) anhand der Umsatzart."""
    t = (typ or "").lower()
    for muster, vz in _UMSATZ_TYP_VORZEICHEN:
        if re.search(muster, t):
            return vz
    return 0

# Bewegt die Buchung den Wertpapierbestand, und in welche Richtung?
_STUECK_RICHTUNG = [
    (r"verkauf|ver.?u.?er|ausbuchung|auslieferung",              -1),
    (r"kauf|zeichnung|sparplan|einbuchung|einlieferung",         +1),
]
# Geldbuchungen, bei denen manche Banken trotzdem eine Stückzahl mitdrucken
_NUR_GELD = (r"dividend|aussch.?tt|zins|ertrag|steuer|geb.?hr|entgelt|"
             r".?berweisung|lastschrift|gutschrift|einzahlung|auszahlung")

def _wertpapier_aus_text(u: dict):
    """Holt ISIN und Stückzahl aus Zweck und Name, falls die Quelle sie nicht
    als eigene Felder liefert.

    Der Transaktionsexport hat eigene Spalten; camt und der PDF-Kontoauszug
    schreiben beides in den Text („ISIN IE00B5BMR087  STK 35"). Aus diesen
    Angaben entsteht der Bestandsverlauf, siehe `_depot_rueckrechnung`.
    """
    text = " ".join(x for x in (u.get("purpose"), u.get("name"), u.get("kind")) if x)
    if not u.get("isin"):
        m = re.search(r"\bISIN[:\s]+([A-Z]{2}[A-Z0-9]{9}\d)\b", text)
        if m:
            u["isin"] = m.group(1)
    if not u.get("quantity"):
        m = re.search(r"\b(?:STK|ST|STCK|STÜCK|STUECK|NOM)\.?[:\s]+([\d.]*\d(?:,\d+)?)\b",
                      text, re.I)
        if m:
            u["quantity"] = _de_num(m.group(1))

def _stueck_richtung(typ: str, betrag: float) -> int:
    """+1 = Stücke kommen ins Depot, -1 = gehen heraus, 0 = keine Bestandsänderung.

    Die Umsatzart entscheidet. Ist sie unbekannt, gilt die Geldrichtung: Geld
    raus heißt Stücke rein. Eine Dividende bringt bei manchen Banken eine
    Stückzahl mit, ohne dass sich am Bestand etwas ändert — die muss draußen
    bleiben, sonst verkauft die Rückrechnung Anteile, die nie bewegt wurden.
    """
    t = (typ or "").lower()
    for muster, vz in _STUECK_RICHTUNG:
        if re.search(muster, t):
            return vz
    if re.search(_NUR_GELD, t):
        return 0
    return -1 if (betrag or 0) > 0 else 1

def _datum_iso(v):
    """'12.03.2026', '12.03.26', '2026-03-12', '2026-03-12T09:00:00' → '2026-03-12'."""
    s = (str(v or "")).strip()
    if not s:
        return None
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})", s)
    if m:
        return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
    m = re.match(r"(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{2,4})", s)
    if m:
        tag, monat, jahr = int(m.group(1)), int(m.group(2)), int(m.group(3))
        if jahr < 100:
            jahr += 2000 if jahr < 70 else 1900
        if not (1 <= monat <= 12 and 1 <= tag <= 31):
            return None
        return f"{jahr:04d}-{monat:02d}-{tag:02d}"
    return None

def _iso_num(v):
    """Betrag aus einer camt-Datei — immer ISO mit Punkt, NIE deutsch gelesen.

    Nicht `_de_num` benutzen: das hält '1.234' für einen Tausenderpunkt und
    macht aus 1,23 EUR stillschweigend 1234 EUR.
    """
    try:
        return float(str(v or "").strip())
    except (TypeError, ValueError):
        return None

def _umsatz_id(account_id: str, u: dict) -> str:
    """Schlüssel gegen Doppeleinträge bei überlappenden Zeiträumen.

    Bevorzugt die Bankreferenz (in camt eindeutig je Buchung). Ohne sie bleibt
    ein Fingerabdruck aus Tag, Betrag, Name und Zweck — und zusätzlich die
    laufende Nummer INNERHALB DES TAGES: sonst verschluckt ein zweites Abheben
    über 50 € am selben Tag das erste, und beim erneuten Einlesen desselben
    Zeitraums müssen dieselben Nummern wieder herauskommen.
    """
    if u.get("ref"):
        roh = f"{account_id}|ref|{u['ref']}"
    else:
        roh = "|".join([account_id, u.get("date") or "", f"{float(u.get('amount') or 0):.2f}",
                        (u.get("name") or "")[:60], (u.get("purpose") or "")[:120],
                        str(u.get("seq") or 0)])
    return hashlib.sha1(roh.encode("utf-8", "replace")).hexdigest()[:20]

# ── camt.052 / camt.053 ────────────────────────────────────────────────────────

def _lok(tag) -> str:
    """'{urn:iso:std:iso:20022:…}Ntry' → 'Ntry'. camt trägt je Version einen
    anderen Namensraum; über den lokalen Namen läuft der Parser über alle."""
    return str(tag).rsplit("}", 1)[-1]

def _kind_el(el, *namen):
    """Erstes direktes Kind mit einem dieser lokalen Namen."""
    if el is None:
        return None
    for c in el:
        if _lok(c.tag) in namen:
            return c
    return None

def _tief_el(el, *namen):
    """Erster Nachfahre mit einem dieser lokalen Namen."""
    if el is None:
        return None
    for c in el.iter():
        if c is not el and _lok(c.tag) in namen:
            return c
    return None

def _txt(el) -> str:
    return (el.text or "").strip() if el is not None and el.text else ""

def _camt_saldo(bal):
    """Ein <Bal>-Block → (Code, Wert mit Vorzeichen, Datum)."""
    code = _txt(_tief_el(bal, "Cd", "Prtry")).upper()
    amt  = _kind_el(bal, "Amt")
    wert = _iso_num(_txt(amt))
    if wert is None:
        return None
    if _txt(_kind_el(bal, "CdtDbtInd")).upper() == "DBIT":
        wert = -wert
    dt    = _kind_el(bal, "Dt")
    datum = _datum_iso(_txt(_kind_el(dt, "Dt", "DtTm"))) or _datum_iso(_txt(dt))
    return (code, wert, datum)

def _umsatz_camt_parsen(daten) -> dict:
    """Liest camt.052 (untertägiger Bericht) oder camt.053 (Tagesauszug).

    Eine Sammelbuchung (mehrere <TxDtls> unter einem <Ntry>) bleibt EINE Buchung
    — nur so stimmt der Saldo; die Einzelheiten wandern in Name und Zweck.
    """
    import xml.etree.ElementTree as ET
    if isinstance(daten, str):
        # ET lehnt Unicode-Text mit Encoding-Angabe ab; die Angabe stimmt nach
        # dem Dekodieren ohnehin nicht mehr, also fliegt sie raus.
        daten = re.sub(r"^\s*<\?xml[^>]*\?>", "", daten, count=1).encode("utf-8")
    try:
        wurzel = ET.fromstring(daten)
    except Exception as e:
        return {"ok": False, "error": f"XML nicht lesbar: {e}"}

    hinweise, umsaetze, salden = [], [], {}
    iban = waehrung = ""

    for rpt in [e for e in wurzel.iter() if _lok(e.tag) in ("Rpt", "Stmt")]:
        acct = _kind_el(rpt, "Acct")
        if acct is not None:
            iban     = iban or _txt(_tief_el(acct, "IBAN"))
            waehrung = waehrung or _txt(_kind_el(acct, "Ccy"))

        for bal in [e for e in rpt if _lok(e.tag) == "Bal"]:
            s = _camt_saldo(bal)
            if not s or not s[0]:
                continue
            code, wert, datum = s
            alt = salden.get(code)
            # Mehrere Berichte in einer Datei: der früheste Eröffnungs- und der
            # späteste Schlusssaldo spannen den Zeitraum auf.
            if alt is None or (datum and alt[1] and (
                    (code in ("OPBD", "PRCD") and datum < alt[1]) or
                    (code not in ("OPBD", "PRCD") and datum > alt[1]))):
                salden[code] = (wert, datum)

        for seq, ntry in enumerate([e for e in rpt if _lok(e.tag) == "Ntry"]):
            sts_el = _kind_el(ntry, "Sts")
            sts    = _txt(sts_el) or _txt(_kind_el(sts_el, "Cd"))
            if sts and sts.upper() != "BOOK":
                continue                     # Vormerkungen zählen nicht zum Saldo
            amt    = _kind_el(ntry, "Amt")
            betrag = _iso_num(_txt(amt))
            if betrag is None:
                continue
            if _txt(_kind_el(ntry, "CdtDbtInd")).upper() == "DBIT":
                betrag = -betrag
            ccy = (amt.get("Ccy") if amt is not None else "") or waehrung or "EUR"

            bd     = _kind_el(ntry, "BookgDt")
            vd     = _kind_el(ntry, "ValDt")
            datum  = _datum_iso(_txt(_kind_el(bd, "Dt", "DtTm")))
            valuta = _datum_iso(_txt(_kind_el(vd, "Dt", "DtTm")))
            datum  = datum or valuta
            if not datum:
                continue

            namen, zwecke, refs = [], [], []
            for txd in [e for e in ntry.iter() if _lok(e.tag) == "TxDtls"]:
                parteien = _tief_el(txd, "RltdPties") or txd
                # Gegenkonto: bei einer Gutschrift der Zahler, bei einer
                # Abbuchung der Empfänger.
                partei = _kind_el(parteien, "Dbtr" if betrag > 0 else "Cdtr") \
                         or _kind_el(parteien, "Cdtr" if betrag > 0 else "Dbtr")
                nm = _txt(_tief_el(partei, "Nm"))
                if nm and nm not in namen:
                    namen.append(nm)
                for u in [e for e in txd.iter() if _lok(e.tag) == "Ustrd"]:
                    if _txt(u):
                        zwecke.append(_txt(u))
                e2e = _txt(_tief_el(txd, "EndToEndId"))
                if e2e and e2e.upper() not in ("NOTPROVIDED", "NICHT ANGEGEBEN"):
                    refs.append(e2e)

            art = _txt(_kind_el(ntry, "AddtlNtryInf")) \
                  or _txt(_tief_el(_kind_el(ntry, "BkTxCd") or ntry, "Prtry"))

            umsaetze.append({
                "date": datum, "valuta": valuta, "amount": round(betrag, 2),
                "currency": (ccy or "EUR").upper()[:3] or "EUR",
                "name": " / ".join(namen)[:200] or None,
                "purpose": " ".join(zwecke)[:500] or None,
                "kind": (art or "")[:80] or None,
                "ref": _txt(_kind_el(ntry, "AcctSvcrRef")) or (refs[0] if refs else None),
                "seq": seq, "saldo": None,
            })

    if not umsaetze and not salden:
        return {"ok": False, "error": "Keine Buchungen gefunden — ist das eine camt-Datei?"}
    if not umsaetze:
        hinweise.append("Die Datei enthält nur Salden, keine Buchungen.")

    umsaetze.sort(key=lambda u: (u["date"], u["seq"]))
    art = "camt.053" if any(_lok(e.tag) == "Stmt" for e in wurzel.iter()) else "camt.052"
    return {"ok": True, "quelle": art, "umsaetze": umsaetze, "iban": iban,
            "eroeffnung": salden.get("OPBD") or salden.get("PRCD"),
            "schluss": salden.get("CLBD") or salden.get("CLAV") or salden.get("ITBD"),
            "hinweise": hinweise}

# ── CSV / Zwischenablage ───────────────────────────────────────────────────────

def _spalten_zuordnen_umsatz(kopf: list) -> dict:
    """Spalten einer Umsatzliste — dieselbe Regel wie beim Depotauszug."""
    return _spalten_zuordnen_nach(kopf, _UMSATZ_MUSTER)

def _umsatz_kopfzeile(tab: list):
    """Findet die Kopfzeile — Bankexporte stellen ihr gern eine Zeile mit
    Kontoangaben voran. Gewählt wird die Zeile mit den meisten Treffern, die
    mindestens Datum und Betrag (oder Saldo) trägt. → (index, zuordnung)"""
    bester, beste_z, bester_i = 0, {}, -1
    for i, zeile in enumerate(tab[:15]):
        z = _spalten_zuordnen_umsatz(zeile)
        if "date" in z and ("amount" in z or "saldo" in z) and len(z) > bester:
            bester, beste_z, bester_i = len(z), z, i
    return bester_i, beste_z

def _saldo_richtung(umsaetze: list) -> int:
    """Wie viele Übergänge erfüllen saldo[i] = saldo[i-1] + betrag[i]?

    Damit lässt sich die Sortierrichtung einer Umsatzliste ablesen, ohne aufs
    Datum angewiesen zu sein.
    """
    treffer = 0
    for i in range(1, len(umsaetze)):
        vor, ist = umsaetze[i - 1].get("saldo"), umsaetze[i].get("saldo")
        if vor is None or ist is None:
            continue
        if abs((float(vor) + float(umsaetze[i].get("amount") or 0)) - float(ist)) < 0.011:
            treffer += 1
    return treffer

def _umsatz_csv_parsen(text: str) -> dict:
    if not (text or "").strip():
        return {"ok": False, "error": "Kein Inhalt"}
    sep = _trennzeichen(text)
    tab = _tabelle_lesen(text, sep)
    if not tab:
        return {"ok": False, "error": "Kein Inhalt"}
    kopf_i, zuordnung = _umsatz_kopfzeile(tab)
    if kopf_i < 0:
        return {"ok": False, "error": "Spalten nicht erkannt — bitte mit Kopfzeile "
                                      "einfügen (Buchungstag, Betrag, …)"}

    hinweise, umsaetze = [], []
    for z in tab[kopf_i + 1:]:
        def feld(name):
            i = zuordnung.get(name)
            return z[i] if i is not None and i < len(z) else ""
        datum = _datum_iso(feld("date"))
        if not datum:
            continue                         # Vorspann, Summen- und Leerzeilen
        betrag = _de_num(feld("amount"))
        if betrag is None:
            continue
        sh = feld("soll_haben").strip().upper()[:1]
        if sh in ("S", "D", "-"):
            betrag = -abs(betrag)
        elif sh in ("H", "C", "+"):
            betrag = abs(betrag)
        umsaetze.append({
            "date": datum, "valuta": _datum_iso(feld("valuta")),
            "amount": round(betrag, 2),
            "currency": (feld("currency") or "EUR").upper()[:3] or "EUR",
            "saldo": _de_num(feld("saldo")),
            "name": feld("name") or None, "purpose": feld("purpose") or None,
            "kind": feld("kind") or None, "ref": None, "seq": 0,
            "isin": (feld("isin") or "").strip().upper() or None,
            "quantity": _de_num(feld("quantity")),
        })
    if not umsaetze:
        return {"ok": False, "error": "Keine Buchungen erkannt"}

    # Vorzeichen VOR der Richtungserkennung: die liest sich aus dem Verhältnis
    # von Saldo und Betrag, und das stimmt nur mit richtigem Vorzeichen.
    # Kommt die Datei ganz ohne Minuszeichen, muss es aus der Umsatzart kommen —
    # sonst zählte ein Wertpapierkauf als Geldeingang.
    if all((u["amount"] or 0) >= 0 for u in umsaetze) and "soll_haben" not in zuordnung:
        if "kind" in zuordnung and any(_umsatz_typ_vorzeichen(u["kind"]) for u in umsaetze):
            unklar = set()
            for u in umsaetze:
                vz = _umsatz_typ_vorzeichen(u["kind"])
                if vz:
                    u["amount"] = round(abs(u["amount"]) * vz, 2)
                elif u["amount"]:
                    unklar.add((u["kind"] or "?").strip())
            hinweise.append("Die Datei führt keine Vorzeichen — sie stammen aus der Spalte "
                            "„" + tab[kopf_i][zuordnung["kind"]] + "“. Bitte in der Vorschau "
                            "prüfen, ob Ein- und Ausgänge richtig herum stehen.")
            if unklar:
                hinweise.append("Diese Umsatzarten kenne ich nicht, sie zählen als Eingang: "
                                + ", ".join(sorted(unklar)[:8]) + ".")
        else:
            hinweise.append("Alle Beträge sind positiv und es gibt keine Soll/Haben-Spalte "
                            "— bitte prüfen, ob die Abbuchungen fehlen.")

    # Viele Banken liefern die neueste Buchung zuerst — für den Saldoverlauf muss
    # es aufsteigend sein. Gibt es eine Saldospalte, sagt sie die Richtung genau:
    # aufsteigend gilt saldo[i] = saldo[i-1] + betrag[i]. Das Datum allein reicht
    # nicht, denn ein Export über einen einzigen Tag hat gar kein Gefälle — die
    # Buchungen stünden dann verkehrt herum, und in die Kurve käme der Saldo der
    # ÄLTESTEN statt der letzten Buchung des Tages.
    if "saldo" in zuordnung and len(umsaetze) > 1:
        if _saldo_richtung(umsaetze[::-1]) > _saldo_richtung(umsaetze):
            umsaetze.reverse()
    elif umsaetze[0]["date"] > umsaetze[-1]["date"]:
        umsaetze.reverse()
    for i, u in enumerate(umsaetze):
        u["seq"] = i

    if "saldo" not in zuordnung:
        hinweise.append("Keine Spalte „Saldo nach Buchung“ — der Verlauf wird vom "
                        "hinterlegten Kontostand rückwärts gerechnet.")
    return {"ok": True, "quelle": "csv", "umsaetze": umsaetze,
            "spalten": tab[kopf_i], "zuordnung": zuordnung,
            "trennzeichen": {"\t": "Tabulator", ";": "Semikolon", ",": "Komma"}[sep],
            "eroeffnung": None, "schluss": None, "hinweise": hinweise}

# ── Kontoauszug als PDF ────────────────────────────────────────────────────────
# Smartbroker/Baader gibt für das Verrechnungskonto keine Umsatz-CSV aus, nur den
# monatlichen Kontoauszug als PDF. Der trägt aber alles, was gebraucht wird:
# Anfangs- und Schlusssaldo mit Datum und die Buchungen dazwischen.
#
# Gelesen wird im LAYOUT-Modus von pypdf. Im normalen Textmodus purzeln die
# Spalten durcheinander, und genau daran hängt hier das Vorzeichen: ob ein Betrag
# eine Belastung oder eine Gutschrift ist, sagt allein seine waagerechte Lage.
# Darum wird aus der Kopfzeile die Grenze zwischen beiden Spalten bestimmt und
# jeder Betrag danach eingeordnet.

_PDF_SOLL  = (r"belastung", r"\bsoll\b", r"abgang", r"ausgang", r"lastschrift")
_PDF_HABEN = (r"gutschrift", r"\bhaben\b", r"zugang", r"eingang")
_PDF_BETRAG = r"(?<![\d.,])\d{1,3}(?:\.\d{3})*,\d{2}(?![\d])"
_PDF_DATUM  = r"\d{2}\.\d{2}\.\d{4}"

def _pdf_spaltengrenze(zeile: str):
    """Aus einer Kopfzeile die Grenze zwischen Soll- und Habenspalte. → (grenze, ok)

    Maßgeblich ist das ENDE der Beschriftung, weil die Beträge rechtsbündig
    stehen. Die Grenze liegt in der Mitte zwischen beiden Enden.
    """
    t = zeile.lower()
    soll  = next((re.search(m, t) for m in _PDF_SOLL  if re.search(m, t)), None)
    haben = next((re.search(m, t) for m in _PDF_HABEN if re.search(m, t)), None)
    if not soll or not haben or soll.end() == haben.end():
        return (None, False)
    return ((soll.end() + haben.end()) / 2.0, soll.end() < haben.end())

def _pdf_vorzeichen(ende: int, grenze: float, soll_links: bool) -> int:
    """Betrag links der Grenze = Soll, rechts = Haben (oder umgekehrt)."""
    links = ende <= grenze
    return -1 if links == soll_links else 1

def _umsatz_pdf_parsen(daten: bytes) -> dict:
    """Liest einen Kontoauszug im PDF-Format (Baader/Smartbroker-Bauart)."""
    try:
        from pypdf import PdfReader
    except ImportError:
        return {"ok": False, "error": "PDF-Unterstützung fehlt auf dem Server (pypdf)."}
    import io as _io
    try:
        leser = PdfReader(_io.BytesIO(daten))
        seiten = [(s.extract_text(extraction_mode="layout") or "") for s in leser.pages]
    except Exception as e:
        return {"ok": False, "error": f"PDF nicht lesbar: {e}"}

    zeilen = [z for s in seiten for z in s.splitlines()]
    if not any(z.strip() for z in zeilen):
        return {"ok": False, "error": "Der Auszug enthält keinen Text — ist er eingescannt?"}

    grenze, soll_links, hinweise = None, True, []
    for z in zeilen:
        g, sl = _pdf_spaltengrenze(z)
        if g is not None:
            grenze, soll_links = g, sl
            break

    iban = ""
    m = re.search(r"IBAN[:\s]+((?:[A-Z]{2}\d{2}\s?)(?:[A-Z0-9]{4}\s?){2,7}[A-Z0-9]{0,4})", "\n".join(zeilen))
    if m:
        iban = m.group(1).replace(" ", "").upper()
    waehrung = "EUR"
    m = re.search(r"Kontoauszug[:\s]+([A-Z]{3})-Konto", "\n".join(zeilen))
    if m:
        waehrung = m.group(1)

    def betrag_aus(zeile):
        """Letzter Betrag der Zeile samt Vorzeichen aus der Spaltenlage."""
        treffer = list(re.finditer(_PDF_BETRAG, zeile))
        if not treffer:
            return None
        letzter = treffer[-1]
        wert = _de_num(letzter.group())
        if wert is None:
            return None
        if grenze is None:
            return wert
        return abs(wert) * _pdf_vorzeichen(letzter.end(), grenze, soll_links)

    salden, umsaetze = [], []
    offen = None          # Buchung, die gerade noch Fortsetzungszeilen annimmt
    for seite in seiten:
        offen = None      # Seitenwechsel beendet den Block (darunter steht die Fußzeile)
        for z in seite.splitlines():
            if not z.strip():
                continue
            # Saldozeile: „Kontostand in EUR am 31.07.2026"
            m = re.search(r"(?:kontostand|kontosaldo|saldo)\b[^\d]*?(" + _PDF_DATUM + ")", z, re.I)
            if m and re.search(_PDF_BETRAG, z):
                wert = betrag_aus(z)
                if wert is not None:
                    salden.append((_datum_iso(m.group(1)), wert))
                offen = None
                continue
            # Buchungszeile: beginnt mit dem Buchungstag
            m = re.match(r"\s*(" + _PDF_DATUM + r")\s", z)
            if m:
                wert = betrag_aus(z)
                if wert is None:
                    continue
                datumsfelder = list(re.finditer(_PDF_DATUM, z))
                valuta = _datum_iso(datumsfelder[1].group()) if len(datumsfelder) > 1 else None
                # Zwischen Buchungstag und Valuta steht die Erläuterung
                bis = datumsfelder[1].start() if len(datumsfelder) > 1 else len(z)
                rest = z[m.end(1):bis]
                art  = rest.strip() or z[m.end(1):].strip()
                umsaetze.append({
                    "date": _datum_iso(m.group(1)), "valuta": valuta,
                    "amount": round(wert, 2), "currency": waehrung,
                    "name": None, "purpose": None,
                    "kind": re.sub(r"\s{2,}", " ", art) or None,
                    "ref": None, "seq": len(umsaetze), "saldo": None,
                    "_zeilen": [],
                    # Spalte, in der die Erläuterung beginnt — nur was bündig
                    # darunter steht, gehört zur Buchung. Sonst sammelt eine
                    # Buchung am Seitenende die ganze Fußzeile ein.
                    "_spalte": m.end(1) + (len(rest) - len(rest.lstrip())),
                })
                offen = umsaetze[-1]
                continue
            # Fortsetzungszeile: Titel, ISIN, Stück, Vorgangs-Nr.
            if offen is not None:
                einzug = len(z) - len(z.lstrip())
                if abs(einzug - offen["_spalte"]) <= 3:
                    offen["_zeilen"].append(re.sub(r"\s{2,}", " ", z.strip()))

    for u in umsaetze:
        teile = u.pop("_zeilen", [])
        u.pop("_spalte", None)
        if teile:
            u["purpose"] = " · ".join(teile)[:500]
            u["name"] = teile[0][:200]
        text = u["purpose"] or ""
        # Vorgangs-Nr. ist je Buchung eindeutig — der beste Schlüssel gegen Doppelte
        m = re.search(r"Vorgangs-?Nr\.?:?\s*([A-Z0-9 ]{6,40})", text, re.I)
        if m:
            u["ref"] = re.sub(r"\s+", "", m.group(1))
        # ISIN und Stückzahl holt _wertpapier_aus_text zentral heraus — im PDF
        # stehen sie als eigene Zeilen unter der Buchung, im camt im
        # Verwendungszweck, und beides landet hier im selben Feld.

    if not umsaetze and not salden:
        return {"ok": False, "error": "Im PDF wurden weder Buchungen noch Salden gefunden — "
                                      "ist das ein Kontoauszug?"}
    if grenze is None:
        hinweise.append("Belastung und Gutschrift waren im PDF nicht auseinanderzuhalten — "
                        "bitte die Vorzeichen in der Vorschau prüfen.")

    umsaetze.sort(key=lambda u: (u["date"], u["seq"]))
    salden.sort(key=lambda s: s[0] or "")
    # Der früheste Saldo eröffnet, der späteste schließt. Bei nur einem Saldo
    # entscheidet der Vergleich mit den Buchungstagen, wofür er steht.
    eroeffnung = schluss = None
    if len(salden) >= 2:
        eroeffnung, schluss = (salden[0][1], salden[0][0]), (salden[-1][1], salden[-1][0])
    elif len(salden) == 1:
        datum, wert = salden[0][0], salden[0][1]
        if umsaetze and datum and datum < umsaetze[0]["date"]:
            eroeffnung = (wert, datum)
        else:
            schluss = (wert, datum)
    return {"ok": True, "quelle": "pdf", "umsaetze": umsaetze, "iban": iban,
            "eroeffnung": eroeffnung, "schluss": schluss, "hinweise": hinweise}

def _umsatz_datei_parsen(name: str, daten: bytes) -> dict:
    """Erkennt camt oder CSV an Inhalt und Endung und liest die Datei ein."""
    kopf = daten[:2000].lstrip()
    if kopf.startswith(b"%PDF") or name.lower().endswith(".pdf"):
        return _umsatz_pdf_parsen(daten)
    if kopf.startswith(b"<") or b"urn:iso:std:iso:20022" in kopf:
        return _umsatz_camt_parsen(daten)
    # CSV: die deutschen Bankexporte kommen in Windows-1252, neuere in UTF-8.
    try:
        text = daten.decode("utf-8")
    except UnicodeDecodeError:
        text = daten.decode("cp1252", "replace")
    return _umsatz_csv_parsen(text.lstrip("﻿"))

# ── Stapel: ZIP und mehrere Dateien ────────────────────────────────────────────

def _dateien_entpacken(dateien: list) -> list:
    """Packt ZIPs aus. `dateien` = [(name, bytes)] → [(name, bytes)] ohne Archive.

    Die GLS liefert den camt-Export als ZIP mit einer XML je Abruftag.
    """
    import zipfile, io
    raus = []
    for name, daten in dateien:
        if not daten:
            continue
        if daten[:2] == b"PK":
            try:
                with zipfile.ZipFile(io.BytesIO(daten)) as z:
                    for info in sorted(z.infolist(), key=lambda i: i.filename):
                        if info.is_dir() or info.file_size == 0:
                            continue
                        if info.filename.rsplit("/", 1)[-1].startswith((".", "__")):
                            continue          # macOS-Beiwerk
                        raus.append((f"{name}:{info.filename}", z.read(info)))
            except Exception as e:
                raus.append((name, b""))      # unten als Fehler gemeldet
                print(f"[Konten] ZIP {name} nicht lesbar: {e}")
        else:
            raus.append((name, daten))
    return raus

def _umsaetze_sammeln(dateien: list) -> dict:
    """Liest einen Stapel Dateien und legt die Buchungen zusammen.

    Jede Datei bringt ihre eigenen Salden mit; die werden gleich hier in die
    Buchungen der jeweiligen Datei gerechnet. Was danach noch ohne Saldo ist,
    füllt `_salden_fuellen` über den ganzen Stapel.
    """
    dateien = _dateien_entpacken(dateien)
    if not dateien:
        return {"ok": False, "error": "Keine Datei erhalten"}

    alle, hinweise, quellen, ibans, gelesen = [], [], [], [], 0
    fehler, raender, protokoll = [], [], []
    for name, daten in dateien:
        kurz = name.rsplit("/", 1)[-1].rsplit(":", 1)[-1]
        if not daten:
            fehler.append(f"{kurz}: leer oder nicht lesbar")
            continue
        res = _umsatz_datei_parsen(kurz, daten)
        if not res.get("ok"):
            fehler.append(f"{kurz}: {res.get('error')}")
            protokoll.append({"datei": kurz, "fehler": res.get("error"),
                              "buchungen": 0, "salden": []})
            continue
        gelesen += 1
        quellen.append(res["quelle"])
        if res.get("iban"):
            ibans.append(res["iban"])
        # Salden der EINZELNEN Datei anwenden — so bleiben Lücken zwischen zwei
        # Tagesauszügen folgenlos, statt eine durchgehende Rechnung zu verfälschen.
        _salden_aus_raendern(res["umsaetze"], res.get("eroeffnung"), res.get("schluss"),
                             hinweise, kurz)
        # Anfangs- und Schlusssaldo sind für sich schon Stände mit Datum — bei
        # einem Monatsauszug oft genauer und jünger als die letzte Buchung, und
        # in buchungsfreien Monaten das Einzige, was es gibt.
        #
        # Die Rolle muss mit: im camt tragen BEIDE dasselbe Datum, und der
        # Eröffnungssaldo ist der Stand VOR den Buchungen des Tages. Ohne
        # Rangfolge gewinnt sonst der falsche — der Kontostand stand danach auf
        # dem Anfangs- statt auf dem Schlusssaldo.
        for rolle, rand in (("start", res.get("eroeffnung")), ("ende", res.get("schluss"))):
            if rand and rand[0] is not None and rand[1]:
                raender.append((rand[1], float(rand[0]), rolle))
        for u in res["umsaetze"]:
            u["datei"] = kurz
        # Je Datei festhalten, was sie beigetragen hat — auch wenn es nichts war.
        # Nur so lässt sich nach einem Stapel von zwanzig Auszügen nachsehen, ob
        # wirklich jeder angekommen ist.
        protokoll.append({
            "datei": kurz, "quelle": res["quelle"],
            "buchungen": len(res["umsaetze"]),
            "von": min((u["date"] for u in res["umsaetze"]), default=None),
            "bis": max((u["date"] for u in res["umsaetze"]), default=None),
            "salden": [[r[1], float(r[0])] for r in
                       (res.get("eroeffnung"), res.get("schluss")) if r and r[1]],
        })
        alle.extend(res["umsaetze"])
        hinweise.extend(f"{kurz}: {h}" if gelesen and len(dateien) > 1 else h
                        for h in res.get("hinweise") or [])

    # Ein buchungsfreier Monat ist kein Fehler: der Auszug bringt trotzdem einen
    # Saldo mit Datum mit, und genau der ist dann das Einzige, was den Verlauf
    # weiterträgt. Nur wenn auch kein Saldo dabei ist, gibt es nichts zu holen.
    if not alle and not raender:
        return {"ok": False, "error": "; ".join(fehler)
                or "Weder Buchungen noch Salden gefunden"}
    if fehler:
        hinweise.extend(fehler)
    if not alle:
        hinweise.append("Keine Buchungen in diesem Zeitraum — übernommen werden nur "
                        "die Salden.")

    # Wertpapierangaben aus dem Text nachziehen, wo die Quelle keine eigenen
    # Spalten hat (camt und PDF schreiben ISIN und Stückzahl in den Text).
    for u in alle:
        _wertpapier_aus_text(u)

    # Stückzahlen mit Richtung versehen: Kauf bringt Stücke ins Depot, Verkauf
    # holt sie heraus. Die Umsatzart entscheidet, nicht das Geld allein.
    for u in alle:
        if u.get("quantity"):
            vz = _stueck_richtung(u.get("kind"), u.get("amount"))
            u["quantity"] = abs(float(u["quantity"])) * vz if vz else None
            if not vz:
                u["isin"] = u.get("isin")     # ISIN bleibt zur Einordnung stehen

    # Doppelte aus überlappenden Dateien: über die Bankreferenz eindeutig.
    gesehen, sauber = set(), []
    for u in alle:
        if u.get("ref"):
            if u["ref"] in gesehen:
                continue
            gesehen.add(u["ref"])
        sauber.append(u)
    doppelt = len(alle) - len(sauber)

    sauber.sort(key=lambda u: (u["date"], u.get("datei") or "", u.get("seq") or 0))
    # Laufende Nummer JE TAG — der Schlüssel in _umsatz_id hängt daran und muss
    # beim erneuten Einlesen desselben Tages wieder gleich herauskommen.
    lauf = {}
    for u in sauber:
        lauf[u["date"]] = lauf.get(u["date"], -1) + 1
        u["seq"] = lauf[u["date"]]

    quelle = quellen[0] if len(set(quellen)) == 1 else "gemischt"
    return {"ok": True, "quelle": quelle, "umsaetze": sauber,
            "iban": ibans[0] if ibans else "", "ibans": sorted(set(ibans)),
            "dateien": gelesen, "doppelt": doppelt, "hinweise": hinweise,
            "salden": sorted(set(raender), key=_saldo_rang),
            "protokoll": sorted(protokoll, key=lambda p: p["datei"])}

def _saldo_rang(rand):
    """Sortierschlüssel für (datum, wert, rolle): je Tag zuerst der Anfangs-,
    dann der Schlusssaldo. Wer später kommt, gewinnt — beim Schreiben in den
    Verlauf wie beim Nachziehen des Kontostands."""
    return (rand[0] or "", 0 if rand[2] == "start" else 1)

# ── Saldo je Buchung ───────────────────────────────────────────────────────────

def _salden_aus_raendern(umsaetze: list, eroeffnung, schluss, hinweise: list, quelle: str):
    """Rechnet die Salden EINER Datei aus ihrem Eröffnungs- bzw. Schlusssaldo.

    Vorwärts ab der Eröffnung ist der Normalfall; gibt es nur den Schlusssaldo,
    wird rückwärts gerechnet. Stimmen beide nicht überein, fehlen Buchungen —
    das muss man sehen, statt es stillschweigend glattzuziehen.
    """
    if not umsaetze or all(u.get("saldo") is not None for u in umsaetze):
        return
    reihe = sorted(umsaetze, key=lambda u: (u["date"], u.get("seq") or 0))
    if eroeffnung and eroeffnung[0] is not None:
        stand = float(eroeffnung[0])
        for u in reihe:
            stand += float(u["amount"] or 0)
            u["saldo"] = round(stand, 2)
        if schluss and schluss[0] is not None and abs(stand - float(schluss[0])) > 0.01:
            hinweise.append(f"{quelle}: Eröffnungssaldo plus Buchungen ergibt {stand:.2f}, "
                            f"die Datei nennt {float(schluss[0]):.2f} als Schlusssaldo "
                            f"(Differenz {stand - float(schluss[0]):+.2f}).")
    elif schluss and schluss[0] is not None:
        stand = float(schluss[0])
        for u in reversed(reihe):
            u["saldo"] = round(stand, 2)
            stand -= float(u["amount"] or 0)

def _salden_fuellen(umsaetze: list, anker=None) -> list:
    """Füllt die noch offenen Salden über den ganzen Stapel.

    Ausgehend von jeder bekannten Buchung wird vorwärts weitergerechnet, vor der
    ersten bekannten rückwärts. Ist gar nichts bekannt, dient der hinterlegte
    Kontostand als Anker (`anker` = (wert, datum)) — aber nur, wenn er nicht ÄLTER
    ist als die letzte Buchung, sonst rechnete man an einem Stand herum, der die
    Buchungen noch gar nicht kennt.
    """
    hinweise = []
    if not umsaetze:
        return hinweise
    reihe = sorted(umsaetze, key=lambda u: (u["date"], u.get("seq") or 0))
    bekannt = [i for i, u in enumerate(reihe) if u.get("saldo") is not None]

    if not bekannt:
        if not anker or anker[0] is None:
            hinweise.append("Kein Saldo bekannt — es werden nur die Buchungen gespeichert, "
                            "der Verlauf bleibt unverändert.")
            return hinweise
        if anker[1] and anker[1] < reihe[-1]["date"]:
            hinweise.append("Der hinterlegte Kontostand ist älter als die letzte Buchung — "
                            "ohne Saldo in der Datei bleibt der Verlauf offen. Trag den "
                            "aktuellen Stand oben ein und lies die Dateien nochmal ein.")
            return hinweise
        reihe[-1]["saldo"] = round(float(anker[0]), 2)
        bekannt = [len(reihe) - 1]

    # Vorwärts ab dem ersten bekannten Saldo. `stand` ist immer der Saldo NACH
    # der zuletzt gesehenen Buchung. Wo ein weiterer bekannter Saldo auftaucht,
    # gilt der — er kommt aus der Datei und ist die bessere Quelle; passt er
    # nicht zum Erwartungswert, fehlen Buchungen dazwischen.
    luecken, stand = [], None
    for u in reihe[bekannt[0]:]:
        erwartet = None if stand is None else round(stand + float(u["amount"] or 0), 2)
        if u.get("saldo") is not None:
            if erwartet is not None and abs(float(u["saldo"]) - erwartet) > 0.01:
                luecken.append(u["date"])
            stand = float(u["saldo"])
        else:
            stand = erwartet
            u["saldo"] = stand

    # Rückwärts vor den ersten bekannten Saldo
    stand = float(reihe[bekannt[0]]["saldo"])
    for i in range(bekannt[0] - 1, -1, -1):
        stand = round(stand - float(reihe[i + 1]["amount"] or 0), 2)
        reihe[i]["saldo"] = stand

    if luecken:
        hinweise.append("Zwischen den Buchungen klafft eine Lücke (" +
                        ", ".join(sorted(set(luecken))[:5]) +
                        ") — dort fehlen offenbar Tage im Export.")
    return hinweise

# ── Speichern ──────────────────────────────────────────────────────────────────

def _umsatz_verlauf_schreiben(conn, acc) -> set:
    """Schreibt aus den gespeicherten Buchungen je Tag einen Stand in
    `account_history` — den Saldo der letzten Buchung des Tages.

    Darlehen liegen dort positiv (siehe `_account_value`), der Saldo eines
    Darlehenskontos kommt aber negativ aus der Bank.

    Beim Depot ist der Saldo nur das Verrechnungskonto; was historisch in den
    Wertpapieren steckte, weiß niemand. Darum dort kein Tagesverlauf aus den
    Buchungen, sondern ein einzelner Eintrag für heute über den gesamten
    Depotwert — so wie ihn auch das Speichern des Kontos schreibt.
    """
    if acc["kind"] == "depot":
        _write_account_history(conn, acc["id"], _account_value(conn, acc))
        return {_heute()}
    rows = conn.execute(
        "SELECT date, saldo FROM account_transactions "
        "WHERE account_id = ? AND saldo IS NOT NULL ORDER BY date, seq, rowid",
        (acc["id"],)).fetchall()
    if not rows:
        return set()
    je_tag = {}
    for r in rows:
        je_tag[r["date"]] = float(r["saldo"])
    fx = float(acc["fx_rate"] or 1.0)
    for tag, saldo in je_tag.items():
        wert = abs(saldo) if acc["kind"] == "darlehen" else saldo
        _write_account_history(conn, acc["id"], wert * fx, tag)
    return set(je_tag)

def _umsaetze_schreiben(db_file: str, account_id: str, umsaetze: list,
                        salden: list = None) -> dict:
    """Legt die Buchungen ab, schreibt den Tagesverlauf und zieht den Stand nach.

    `salden` sind die Anfangs- und Schlusssalden der eingelesenen Dateien —
    Stände mit Datum, die ohne eigene Buchung dastehen.
    """
    _init_account_tables(db_file)
    conn = get_db(db_file)
    acc  = conn.execute("SELECT * FROM accounts WHERE id = ?", (account_id,)).fetchone()
    if not acc:
        conn.close()
        return {"ok": False, "error": "Konto nicht gefunden", "status": 404}
    if acc["kind"] not in UMSATZ_ARTEN:
        conn.close()
        return {"ok": False, "status": 400,
                "error": "Für Sachwerte gibt es keine Umsätze"}

    now, neu, bekannt = time.strftime("%Y-%m-%d %H:%M:%S"), 0, 0
    for u in umsaetze:
        tx_id = _umsatz_id(account_id, u)
        da = conn.execute("SELECT saldo FROM account_transactions "
                          "WHERE account_id = ? AND tx_id = ?", (account_id, tx_id)).fetchone()
        if da is not None:
            bekannt += 1
            # Beim zweiten Lauf kann ein Saldo bekannt sein, der vorher fehlte
            if u.get("saldo") is not None and da["saldo"] is None:
                conn.execute("UPDATE account_transactions SET saldo = ? "
                             "WHERE account_id = ? AND tx_id = ?",
                             (float(u["saldo"]), account_id, tx_id))
            continue
        conn.execute(
            "INSERT INTO account_transactions (account_id, tx_id, date, valuta, amount, "
            "currency, saldo, name, purpose, kind, ref, seq, source, imported, isin, "
            "quantity, datei) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (account_id, tx_id, u.get("date"), u.get("valuta"),
             float(u.get("amount") or 0), (u.get("currency") or "EUR")[:3],
             None if u.get("saldo") is None else float(u["saldo"]),
             u.get("name"), u.get("purpose"), u.get("kind"), u.get("ref"),
             int(u.get("seq") or 0), u.get("source") or "", now,
             u.get("isin"), u.get("quantity"), u.get("datei")))
        neu += 1
    conn.commit()

    # Anfangs-/Schlusssalden der Dateien als eigene Stände ablegen. Beim Depot
    # nicht: dort hält account_history Verrechnungskonto PLUS Wertpapiere.
    rand_tage = set()
    fx = float(acc["fx_rate"] or 1.0)
    for datum, wert, _rolle in sorted(salden or [], key=_saldo_rang):
        if not datum:
            continue
        # Der reine Kontostand — für jede Kontoart, auch fürs Depot.
        conn.execute("INSERT INTO account_cash_balances (account_id, date, saldo) "
                     "VALUES (?,?,?) ON CONFLICT(account_id, date) DO UPDATE SET "
                     "saldo = excluded.saldo", (account_id, datum, float(wert)))
        if acc["kind"] != "depot":
            w = abs(float(wert)) if acc["kind"] == "darlehen" else float(wert)
            _write_account_history(conn, account_id, w * fx, datum)
            rand_tage.add(datum)
    conn.commit()

    # Erst den Kontostand nachziehen, wenn die Buchungen neuer sind als der
    # hinterlegte Stand — der Depot-Verlauf unten rechnet damit weiter.
    #
    # Ausnahme: ein Stand von 0 sagt nichts aus. Ein frisch angelegtes Konto trägt
    # „0 € von heute", und der ist zwangsläufig neuer als jeder Auszug — ohne die
    # Ausnahme bliebe der Kontostand 0 und die Vermögenskurve fiele nach dem
    # Import auf null zurück. Die Platzhalter-Nullen danach fliegen mit raus.
    row = conn.execute(
        "SELECT date, saldo FROM account_transactions WHERE account_id = ? AND saldo IS NOT NULL "
        "ORDER BY date DESC, seq DESC, rowid DESC LIMIT 1", (account_id,)).fetchone()
    # Ein Schlusssaldo ohne Buchung kann jünger sein als die letzte Buchung —
    # bei einem Monatsauszug ist er das fast immer. Bei Gleichstand am selben Tag
    # gilt die Rangfolge Anfangssaldo < Schlusssaldo < Buchung.
    kandidaten = [(datum, 0 if rolle == "start" else 1, float(wert))
                  for datum, wert, rolle in (salden or []) if datum]
    if row:
        kandidaten.append((row["date"], 2, float(row["saldo"])))
    bester   = max(kandidaten, key=lambda k: (k[0], k[1])) if kandidaten else None
    juengste = (bester[0], bester[2]) if bester else None

    stand = None
    leer  = not float(acc["balance"] or 0) and not float(acc["valuation"] or 0)
    if juengste and (not acc["balance_date"] or juengste[0] >= acc["balance_date"] or leer):
        stand = abs(juengste[1]) if acc["kind"] == "darlehen" else juengste[1]
        conn.execute("UPDATE accounts SET balance = ?, balance_date = ?, updated = ? WHERE id = ?",
                     (stand, juengste[0], now, account_id))
        if leer:
            conn.execute("DELETE FROM account_history WHERE account_id = ? AND date > ? "
                         "AND COALESCE(value, 0) = 0", (account_id, juengste[0]))
        conn.commit()
        acc = conn.execute("SELECT * FROM accounts WHERE id = ?", (account_id,)).fetchone()

    tage = len(rand_tage | _umsatz_verlauf_schreiben(conn, acc))
    conn.commit()
    row = _account_row(conn, acc)
    conn.close()
    return {"ok": True, "neu": neu, "bekannt": bekannt, "tage": tage,
            "saldo": stand, "account": row}

def _umsatz_vorschau(db_file: str, account_id: str, dateien: list) -> dict:
    """Liest den Stapel und ergänzt alles, was die Vorschau zeigen soll."""
    conn = get_db(db_file)
    acc  = conn.execute("SELECT * FROM accounts WHERE id = ?", (account_id,)).fetchone()
    conn.close()
    if not acc:
        return {"ok": False, "error": "Konto nicht gefunden", "status": 404}

    res = _umsaetze_sammeln(dateien)
    if not res.get("ok"):
        res["status"] = 400
        return res

    anker = (float(acc["balance"] or 0), acc["balance_date"])
    if acc["kind"] == "darlehen":
        anker = (-abs(anker[0]), anker[1])    # Restschuld liegt positiv in der DB
    res["hinweise"] = list(res.get("hinweise") or []) + _salden_fuellen(res["umsaetze"], anker)
    for u in res["umsaetze"]:
        u["source"] = res["quelle"]

    # Ein Auszug im falschen Konto verdirbt den Verlauf lautlos — darum der
    # Abgleich mit einer IBAN, die in der Notiz des Kontos steht.
    for iban in res.get("ibans") or []:
        andere = re.findall(r"[A-Z]{2}\d{2}[A-Z0-9]{10,30}",
                            (acc["note"] or "").replace(" ", "").upper())
        if andere and iban.replace(" ", "").upper() not in andere:
            res["hinweise"].append(f"Die Datei gehört zu {iban}, in der Notiz des Kontos "
                                   f"steht {andere[0]}.")
            break

    je_datei = {}
    for u in res["umsaetze"]:
        je_datei[u.get("datei") or "?"] = je_datei.get(u.get("datei") or "?", 0) + 1
    res["je_datei"] = sorted(je_datei.items())
    res["summe"] = round(sum(float(u["amount"] or 0) for u in res["umsaetze"]), 2)
    res["von"]   = min((u["date"] for u in res["umsaetze"]), default=None)
    res["bis"]   = max((u["date"] for u in res["umsaetze"]), default=None)
    res["konto"] = acc["name"]
    return res

@app.get("/api/konten/{account_id}/umsaetze")
async def konten_umsaetze(account_id: str, request: Request, limit: int = 200):
    """Gespeicherte Buchungen eines Kontos, neueste zuerst."""
    user  = get_user(request)
    files = get_user_files(user)
    _init_account_tables(files["db"])
    conn = get_db(files["db"])
    rows = conn.execute(
        "SELECT * FROM account_transactions WHERE account_id = ? "
        "ORDER BY date DESC, seq DESC, rowid DESC LIMIT ?",
        (account_id, max(1, min(int(limit or 200), 2000)))).fetchall()
    anzahl = conn.execute("SELECT COUNT(*) AS c FROM account_transactions WHERE account_id = ?",
                          (account_id,)).fetchone()["c"]
    conn.close()
    return JSONResponse({"umsaetze": [dict(r) for r in rows], "anzahl": anzahl})

@app.delete("/api/konten/{account_id}/umsaetze")
async def konten_umsaetze_loeschen(account_id: str, request: Request):
    """Verwirft alle Buchungen eines Kontos. Der Verlauf bleibt stehen — er wird
    auch von Hand gepflegt und soll nicht an einem Fehlimport hängen."""
    user  = get_user(request)
    files = get_user_files(user)
    _init_account_tables(files["db"])
    conn = get_db(files["db"])
    conn.execute("DELETE FROM account_transactions  WHERE account_id = ?", (account_id,))
    conn.execute("DELETE FROM account_cash_balances WHERE account_id = ?", (account_id,))
    conn.commit()
    conn.close()
    return JSONResponse({"ok": True})

@app.post("/api/konten/{account_id}/umsaetze")
async def konten_umsaetze_import(account_id: str, request: Request):
    """Umsätze aus eingefügtem Text (CSV oder eine camt-XML). Vorschau, bis
    `bestaetigt` gesetzt ist. Für Dateien und ZIPs siehe /umsaetze/dateien."""
    user  = get_user(request)
    files = get_user_files(user)
    _init_account_tables(files["db"])
    body  = await request.json()
    text  = body.get("text") or ""
    if not text.strip():
        return JSONResponse({"ok": False, "error": "Nichts eingefügt"}, status_code=400)

    res = _umsatz_vorschau(files["db"], account_id, [("Eingefügt", text.encode("utf-8"))])
    if not res.get("ok"):
        return JSONResponse(res, status_code=res.pop("status", 400))
    if not body.get("bestaetigt"):
        return JSONResponse(res)

    erg = _umsaetze_schreiben(files["db"], account_id, res["umsaetze"], res.get("salden"))
    erg["hinweise"] = res["hinweise"]
    return JSONResponse(erg, status_code=erg.pop("status", 200))

@app.post("/api/konten/{account_id}/umsaetze/dateien")
async def konten_umsaetze_dateien(account_id: str, request: Request,
                                  dateien: list[UploadFile] = File(default=[]),
                                  bestaetigt: str = ""):
    """camt-Dateien oder das ZIP der Bank einlesen. Ohne `bestaetigt` nur Vorschau.

    Die Oberfläche lädt denselben Stapel zweimal hoch — einmal für die Vorschau,
    einmal zum Übernehmen. Das ist billiger als die Dateien serverseitig zwischen
    zwei Aufrufen vorzuhalten, und es gibt keinen Zustand, der ablaufen kann.
    """
    user  = get_user(request)
    files = get_user_files(user)
    _init_account_tables(files["db"])

    stapel = []
    for f in dateien or []:
        stapel.append((f.filename or "Datei", await f.read()))
    if not stapel:
        return JSONResponse({"ok": False, "error": "Keine Datei erhalten"}, status_code=400)

    res = await run_in_threadpool(_umsatz_vorschau, files["db"], account_id, stapel)
    if not res.get("ok"):
        return JSONResponse(res, status_code=res.pop("status", 400))
    if not bestaetigt:
        return JSONResponse(res)

    erg = await run_in_threadpool(_umsaetze_schreiben, files["db"], account_id,
                                  res["umsaetze"], res.get("salden"))
    erg["hinweise"] = res["hinweise"]
    return JSONResponse(erg, status_code=erg.pop("status", 200))

# ── Depotverlauf rückwärts rechnen ─────────────────────────────────────────────
# Ein Depot ist Verrechnungskonto + Wertpapiere. Was heute drinliegt, weiß folio
# aus dem Depotauszug; was früher drinlag, hat niemand aufgeschrieben. Es lässt
# sich aber ausrechnen, denn jede Veränderung steht in den Kontoauszügen:
#
#     Bestand(t) = Bestand heute − alle Käufe/Verkäufe nach t
#
# Bewertet wird mit den Kursen aus folios eigener Datenbank. Dasselbe Verfahren
# nutzt die App bereits für die IBKR-Trades.
#
# Die Rechnung trägt ihre eigene Prüfung: läuft sie vor der ersten bekannten
# Buchung nicht auf null aus, fehlen Auszüge — dann wird gewarnt, statt eine
# hübsche, falsche Kurve zu zeichnen.

def _depot_symbol(conn, isin: str, symbol_fallback: str = "") -> str:
    """ISIN → Yahoo-Symbol über dieselbe isin_map wie die IBKR-Positionen."""
    if isin:
        r = conn.execute("SELECT yahoo_symbol FROM isin_map WHERE isin = ?", (isin,)).fetchone()
        if r and r["yahoo_symbol"]:
            return r["yahoo_symbol"]
    return (symbol_fallback or "").upper()

def _kurse_je_tag(conn, symbol: str) -> list:
    """Alle bekannten Schlusskurse eines Symbols, aufsteigend. [(datum, kurs)]"""
    return [(r["date"], float(r["close"])) for r in conn.execute(
        "SELECT date, close FROM prices WHERE ticker = ? AND close > 0 ORDER BY date",
        (symbol,)).fetchall()]

def _tage_zwischen(von: str, bis: str):
    """Alle Kalendertage von..bis einschließlich, als JJJJ-MM-TT."""
    from datetime import date, timedelta
    j, m, t = (int(x) for x in von.split("-"))
    d, ende = date(j, m, t), bis
    while True:
        s = d.isoformat()
        yield s
        if s >= ende:
            return
        d += timedelta(days=1)

def _depot_bargeld_reihe(conn, account_id: str, von: str, bis: str) -> dict:
    """Verrechnungskonto je Tag, aus den Salden der Buchungen vorwärts gefüllt.

    Vor der ersten Buchung gilt deren Saldo minus deren Betrag — das ist der
    Stand, mit dem der Zeitraum begonnen hat.
    """
    rows = conn.execute(
        "SELECT date, saldo, amount FROM account_transactions "
        "WHERE account_id = ? AND saldo IS NOT NULL ORDER BY date, seq, rowid",
        (account_id,)).fetchall()
    # Kontostände aus den Auszügen zuerst — Buchungen überschreiben sie gleich
    # wieder, denn am selben Tag ist der Stand NACH der Buchung der genauere.
    je_tag = {r["date"]: float(r["saldo"]) for r in conn.execute(
        "SELECT date, saldo FROM account_cash_balances WHERE account_id = ? ORDER BY date",
        (account_id,)).fetchall()}
    if not rows and not je_tag:
        return {}
    start = None
    if rows:
        start = float(rows[0]["saldo"]) - float(rows[0]["amount"] or 0)
    for r in rows:
        je_tag[r["date"]] = float(r["saldo"])
    if start is None:
        start = je_tag[min(je_tag)]
    reihe, stand = {}, start
    for tag in _tage_zwischen(von, bis):
        if tag in je_tag:
            stand = je_tag[tag]
        reihe[tag] = stand
    return reihe

def _depot_rueckrechnung(db_file: str, account_id: str, schreiben: bool = True) -> dict:
    """Rechnet den Wertpapierbestand rückwärts und schreibt den Depotverlauf."""
    _init_account_tables(db_file)
    conn = get_db(db_file)
    acc  = conn.execute("SELECT * FROM accounts WHERE id = ?", (account_id,)).fetchone()
    if not acc:
        conn.close()
        return {"ok": False, "error": "Konto nicht gefunden", "status": 404}
    if acc["kind"] != "depot":
        conn.close()
        return {"ok": False, "status": 400,
                "error": "Die Rückrechnung gibt es nur für Depotkonten"}

    # Heutiger Bestand je ISIN + das Symbol, unter dem die Kurse liegen
    heute_bestand, symbole, fx = {}, {}, {}
    for p in conn.execute("SELECT * FROM depot_positions WHERE account_id = ?",
                          (account_id,)).fetchall():
        key = (p["isin"] or p["symbol"] or "").upper()
        if not key:
            continue
        heute_bestand[key] = heute_bestand.get(key, 0.0) + float(p["quantity"] or 0)
        symbole[key] = p["yahoo_symbol"] or _depot_symbol(conn, p["isin"], p["symbol"])
        fx[key] = float(p["fx_rate_to_base"] or 1.0)

    # Buchungen mit Stückzahl — daraus entstehen die Veränderungen
    trades = conn.execute(
        "SELECT date, isin, quantity, name FROM account_transactions "
        "WHERE account_id = ? AND quantity IS NOT NULL AND quantity <> 0 "
        "AND isin IS NOT NULL ORDER BY date, seq, rowid", (account_id,)).fetchall()
    if not trades:
        conn.close()
        return {"ok": False, "status": 400,
                "error": "Keine Buchungen mit Stückzahl vorhanden — bitte zuerst die "
                         "Kontoauszüge einlesen."}

    for t in trades:
        key = (t["isin"] or "").upper()
        symbole.setdefault(key, _depot_symbol(conn, key))
        fx.setdefault(key, 1.0)
        heute_bestand.setdefault(key, 0.0)

    # Zeitraum: so weit zurück, wie über dieses Konto überhaupt etwas bekannt ist
    # — nicht erst ab der ersten Wertpapierbuchung. Sonst fehlt der Blick auf den
    # Bestand DAVOR, und genau der ist bei einem Verkauf die interessante Hälfte.
    grenzen = [min(t["date"] for t in trades)]
    for sql in ("SELECT MIN(date) AS d FROM account_transactions WHERE account_id = ?",
                "SELECT MIN(date) AS d FROM account_cash_balances WHERE account_id = ?",
                "SELECT MIN(date) AS d FROM account_history WHERE account_id = ?"):
        r = conn.execute(sql, (account_id,)).fetchone()
        if r and r["d"]:
            grenzen.append(r["d"])
    von = min(grenzen)
    bis = _heute()
    warnungen = []

    # Rückwärts: am Ende jedes Tages den Bestand festhalten, dann die Buchungen
    # dieses Tages wieder herausrechnen — übrig bleibt der Stand vom Vortag.
    trades_je_tag = {}
    for t in trades:
        trades_je_tag.setdefault(t["date"], []).append(
            ((t["isin"] or "").upper(), float(t["quantity"])))

    laufend = dict(heute_bestand)
    bestand_je_tag = {}
    for tag in reversed(list(_tage_zwischen(von, bis))):
        bestand_je_tag[tag] = dict(laufend)
        for key, menge in trades_je_tag.get(tag, []):
            laufend[key] = laufend.get(key, 0.0) - menge

    # Gegenprobe: vor der ersten bekannten Buchung muss das Depot leer sein.
    offen = {k: round(v, 4) for k, v in laufend.items() if abs(v) > 0.0001}
    if offen:
        erster_trade = min(t["date"] for t in trades)
        warnungen.append(
            "Vor der ersten bekannten Wertpapierbuchung (" + erster_trade + ") bleibt ein "
            "Bestand übrig ("
            + ", ".join(f"{k}: {v:g} Stück" for k, v in sorted(offen.items())[:5])
            + "). Es fehlen Auszüge — davor wird dieser Bestand als unverändert "
              "angenommen, der Verlauf dort ist also nur eine Schätzung.")

    # Kurse je Symbol, vorwärts gefüllt (Wochenenden, Feiertage)
    kurse = {}
    for key, sym in symbole.items():
        if not sym:
            warnungen.append(f"Für {key} ist kein Kurssymbol hinterlegt — "
                             f"die Position wird mit 0 bewertet.")
            continue
        reihe = _kurse_je_tag(conn, sym)
        if not reihe:
            warnungen.append(f"Für {sym} ({key}) liegen keine Kurse in der Datenbank — "
                             f"die Position wird mit 0 bewertet.")
            continue
        if reihe[0][0] > von:
            warnungen.append(f"Kurse für {sym} beginnen erst am {reihe[0][0]}, der Verlauf "
                             f"davor bewertet diese Position mit 0.")
        kurse[key] = reihe

    def kurs(key, tag):
        reihe = kurse.get(key)
        if not reihe:
            return 0.0
        # letzter Kurs am oder vor dem Tag
        lo, hi, treffer = 0, len(reihe) - 1, None
        while lo <= hi:
            mid = (lo + hi) // 2
            if reihe[mid][0] <= tag:
                treffer, lo = reihe[mid][1], mid + 1
            else:
                hi = mid - 1
        return treffer or 0.0

    bargeld = _depot_bargeld_reihe(conn, account_id, von, bis)
    reihe_out, geschrieben = [], 0
    for tag in _tage_zwischen(von, bis):
        wp = sum(menge * kurs(key, tag) * fx.get(key, 1.0)
                 for key, menge in bestand_je_tag.get(tag, {}).items() if menge)
        gesamt = wp + bargeld.get(tag, 0.0)
        reihe_out.append({"date": tag, "wertpapiere": round(wp, 2),
                          "bargeld": round(bargeld.get(tag, 0.0), 2),
                          "total": round(gesamt, 2)})
        if schreiben:
            _write_account_history(conn, account_id, gesamt, tag)
            geschrieben += 1
    if schreiben:
        conn.commit()

    # Kontrolle gegen den heutigen Stand aus dem Depotauszug
    heute_soll = _account_value(conn, acc)
    heute_ist  = reihe_out[-1]["total"] if reihe_out else 0.0
    if abs(heute_soll - heute_ist) > max(1.0, abs(heute_soll) * 0.01):
        warnungen.append(f"Der errechnete Wert von heute ({heute_ist:,.2f}) weicht vom "
                         f"Depotauszug ({heute_soll:,.2f}) ab. Meist fehlen Kurse für "
                         f"einen Titel.")
    conn.close()
    return {"ok": True, "von": von, "bis": bis, "tage": geschrieben,
            "trades": len(trades), "titel": len([s for s in symbole.values() if s]),
            "warnungen": warnungen, "reihe": reihe_out[-90:],
            "heute_errechnet": round(heute_ist, 2), "heute_auszug": round(heute_soll, 2)}

@app.post("/api/konten/{account_id}/rueckrechnung")
async def konten_rueckrechnung(account_id: str, request: Request, probe: str = ""):
    """Depotverlauf aus Bestand und Buchungen rückwärts rechnen.

    Mit `probe=1` wird nur gerechnet und nichts geschrieben — dann lässt sich
    vorher sehen, ob die Gegenproben aufgehen.
    """
    user  = get_user(request)
    files = get_user_files(user)
    res = await run_in_threadpool(_depot_rueckrechnung, files["db"], account_id, not probe)
    return JSONResponse(res, status_code=res.pop("status", 200))

@app.get("/api/vermoegen")
async def vermoegen(request: Request, ibkr: str = ""):
    """Vermögensübersicht. `ibkr` = vom Frontend mit Live-Kursen gerechneter Wert.

    Schreibt nebenbei den IBKR-Stand des Tages fort — dadurch entsteht die
    Vermögenskurve ohne eigenen Hintergrundjob, einfach dadurch dass die Seite
    benutzt wird. Ein Eintrag je Tag, der letzte gewinnt.
    """
    user  = get_user(request)
    files = get_user_files(user)
    _init_account_tables(files["db"])
    _init_ibkr_tables(files["db"])
    conn  = get_db(files["db"])
    live  = _de_num(ibkr) if ibkr else None
    summe = _wealth_summary(conn, live)
    try:
        conn.execute("INSERT INTO wealth_history (date, ibkr) VALUES (?,?) "
                     "ON CONFLICT(date) DO UPDATE SET ibkr = excluded.ibkr",
                     (_heute(), summe["ibkr"]))
        conn.commit()
    except Exception as e:
        print(f"[Konten] Vermoegens-Fortschreibung uebersprungen: {e}")
    conn.close()
    return JSONResponse(summe)

@app.get("/api/vermoegen/verlauf")
async def vermoegen_verlauf(request: Request):
    """Tagesreihe des Gesamtvermögens nach Gruppen."""
    user  = get_user(request)
    files = get_user_files(user)
    _init_account_tables(files["db"])
    conn = get_db(files["db"])
    reihe = _wealth_series(conn)
    conn.close()
    return JSONResponse(reihe)

@app.post("/api/vermoegen/verlauf")
async def vermoegen_verlauf_set(request: Request):
    """Trägt den IBKR-Depotwert für ein zurückliegendes Datum nach."""
    user  = get_user(request)
    files = get_user_files(user)
    _init_account_tables(files["db"])
    body  = await request.json()
    datum = (body.get("date") or "").strip()
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", datum):
        return JSONResponse({"ok": False, "error": "Datum als JJJJ-MM-TT erwartet"}, status_code=400)
    conn = get_db(files["db"])
    if body.get("ibkr") is None and "ibkr" in body:
        conn.execute("DELETE FROM wealth_history WHERE date = ?", (datum,))
    else:
        conn.execute("INSERT INTO wealth_history (date, ibkr) VALUES (?,?) "
                     "ON CONFLICT(date) DO UPDATE SET ibkr = excluded.ibkr",
                     (datum, _de_num(body.get("ibkr")) or 0.0))
    conn.commit()
    conn.close()
    return JSONResponse({"ok": True})

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

def _tax_targets(user: str, year: str) -> tuple[list[str], list[str]]:
    """(verfügbare Jahre, zu rechnende Jahre) aus dem Bestand ableiten.
    year = "all" → alle, "2024" → nur dieses, "" → das jüngste."""
    available = sorted({e["year"] for e in _tax_store_entries(user, "xml") if e.get("year")})
    if not available:
        return [], []
    if year == "all":
        return available, available
    if year and year in available:
        return available, [year]
    return available, available[-1:]


@app.post("/api/tax/report-konvex")
async def tax_report_konvex(request: Request, year: str = ""):
    """Rechnet den Steuerreport aus dem gespeicherten XML-Bestand — auf Knopfdruck,
    für ein Jahr (year=YYYY), alle Jahre (year=all) oder das jüngste (year leer).
    Bereits gerechnete Jahre kommen aus dem Cache, solange der Bestand unverändert ist."""
    user = get_user(request)

    available, targets = _tax_targets(user, year)
    if not targets:
        return JSONResponse({"ok": False, "no_files": True,
                             "error": "Keine gespeicherten Dateien — bitte Flex-XML hochladen."})

    fp = _tax_store_fingerprint(user, "xml")
    try:
        res = await run_in_threadpool(_tax_konvex_years, user, targets, fp)
    except ValueError as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=422)
    except Exception as e:
        print(f"tax_report_konvex error: {e}")
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)

    years_out = res["years"]
    if not years_out:
        return JSONResponse(
            {"ok": False, "error": "Kein Steuerjahr erkannt — sind das IBKR Flex "
                                   "Statements (XML) seit Depoteröffnung?"}, status_code=422)
    sel = targets[-1] if targets[-1] in years_out else sorted(years_out)[-1]
    entries = _tax_store_entries(user, "xml")
    account = res["meta"].get("account") or next(
        (e.get("account_name") or e.get("account_id") for e in reversed(entries)
         if e.get("account_name") or e.get("account_id")), "")
    return JSONResponse({
        "ok": True,
        "source": "stored",
        "year": sel,
        "years": years_out,
        "available_years": available,
        "computed_years": sorted(years_out),
        "recomputed": res["computed"],          # tatsächlich neu gerechnet (Rest: Cache)
        "cached_years": _tax_cache_years(user, fp),
        "account": account,
        "base_currency": res["meta"].get("base_currency")
                         or years_out[sel].get("base_currency", "EUR"),
        "stored_files": _tax_store_list(user, "xml"),
        "files": entries,
    })


@app.post("/api/tax/upload")
async def tax_upload(request: Request, files: list[UploadFile] = File(default=[]), kind: str = "xml"):
    """Legt hochgeladene Statements im Bestand ab — ohne zu rechnen. Gleichnamige
    Dateien werden ersetzt, andere bleiben; gerechnet wird erst auf Knopfdruck."""
    user = get_user(request)
    if kind not in _TAX_STORE_KINDS:
        return JSONResponse({"ok": False, "error": "Unbekannte Sorte"}, status_code=422)
    items = []
    for f in (files or []):
        raw = await f.read()
        if raw:
            items.append((f.filename or "datei", raw))
    if not items:
        return JSONResponse({"ok": False, "error": "Keine Dateien empfangen."}, status_code=422)
    _tax_store_add(user, kind, items)
    return JSONResponse({"ok": True, "kind": kind, "added": len(items),
                         "files": _tax_store_entries(user, kind),
                         "stored_files": _tax_store_list(user, kind),
                         "cached_years": _tax_cache_years(user, _tax_store_fingerprint(user, kind))})


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
    stmt_year = (_flex_xml_head_meta(xml_text).get("year")
                 or _flex_stmt_year(xml_text) or str(time.localtime().tm_year))
    _tax_store_add(user, "xml", [(f"IBKR_Flex_{stmt_year}.xml", xml_text.encode("utf-8"))])

    # Nur das geholte Jahr rechnen (der Bestand hat sich geändert → Cache ist neu).
    target = (year or stmt_year)
    available, _ = _tax_targets(user, target)
    fp = _tax_store_fingerprint(user, "xml")
    try:
        res = await run_in_threadpool(_tax_konvex_years, user, [target], fp)
        years_out = res["years"]
        if not years_out:
            return JSONResponse(
                {"ok": False, "error": "Kein Steuerjahr erkannt — sind das IBKR Flex "
                                       "Statements (XML)?"}, status_code=422)
        entries = _tax_store_entries(user, "xml")
        return JSONResponse({
            "ok": True, "source": "ibkr", "fetched_year": stmt_year,
            "year": target if target in years_out else sorted(years_out)[-1],
            "years": years_out,
            "available_years": available,
            "computed_years": sorted(years_out),
            "cached_years": _tax_cache_years(user, fp),
            "account": res["meta"].get("account", ""),
            "base_currency": res["meta"].get("base_currency", "EUR"),
            "stored_files": [e["name"] for e in entries],
            "files": entries,
        })
    except ValueError as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=422)
    except Exception as e:
        print(f"tax_fetch_flex error: {e}")
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)


# ── Verwaltung der gespeicherten Steuer-Dateien (pro User) ──────────────────────

@app.get("/api/tax/files")
async def tax_files_status(request: Request, kind: str = "xml"):
    """Listet die serverseitig gespeicherten Steuer-Dateien einer Sorte (xml|csv)
    mit Kopfdaten (Konto, Zeitraum, Jahr, Größe) für den Dateibaum — plus die
    Jahre, für die bereits ein gerechnetes Ergebnis im Cache liegt."""
    user = get_user(request)
    if kind not in _TAX_STORE_KINDS:
        return JSONResponse({"ok": False, "error": "Unbekannte Sorte"}, status_code=422)
    entries = _tax_store_entries(user, kind)
    return JSONResponse({"ok": True, "kind": kind,
                         "stored_files": [e["name"] for e in entries],
                         "files": entries,
                         "cached_years": _tax_cache_years(user, _tax_store_fingerprint(user, kind))})

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
    entries = _tax_store_entries(user, kind)
    return JSONResponse({"ok": True, "kind": kind,
                         "stored_files": [e["name"] for e in entries],
                         "files": entries,
                         "cached_years": _tax_cache_years(user, _tax_store_fingerprint(user, kind))})


# ── Steuer +++ : PDF-Steuerbericht je Jahr ──────────────────────────────────────
# Rechnet aus den gespeicherten XMLs (Sorte xml) und liefert einen mehrseitigen
# PDF-Bericht (Zusammenfassung + vollständiges Trade-Journal) für das gewählte Jahr.

@app.get("/api/tax/pdf-sections")
async def tax_pdf_sections(request: Request):
    """Die wählbaren PDF-Abschnitte (Schlüssel + Beschriftung) für das Frontend."""
    import tax_pdf_konvex
    get_user(request)
    return JSONResponse({"ok": True,
                         "sections": [{"key": k, "label": l} for k, l in tax_pdf_konvex.SECTIONS],
                         "defaults": tax_pdf_konvex.DEFAULT_SECTIONS})


@app.get("/api/tax/report-konvex-pdf")
async def tax_report_konvex_pdf(request: Request, year: str = "", sections: str = ""):
    """PDF für ein Jahr. `sections` = kommagetrennte Abschnitts-Schlüssel (leer = alle).
    Das Jahr kommt aus dem Cache, wenn es schon gerechnet wurde."""
    import tax_pdf_konvex
    user = get_user(request)

    _, targets = _tax_targets(user, year)
    if not targets:
        return JSONResponse({"ok": False, "no_files": True,
                             "error": "Keine gespeicherten XML-Dateien."}, status_code=422)
    want = [s.strip() for s in (sections or "").split(",") if s.strip()]
    fp = _tax_store_fingerprint(user, "xml")

    def _run():
        res = _tax_konvex_years(user, targets[-1:], fp)
        yr = targets[-1]
        data = res["years"].get(yr)
        if not data:
            return None, None
        entries = _tax_store_entries(user, "xml")
        account = res["meta"].get("account") or next(
            (e.get("account_name") or e.get("account_id") for e in reversed(entries)
             if e.get("account_name") or e.get("account_id")), "")
        # sections-Parameter angegeben → genau diese Auswahl (auch wenn sie leer ist)
        return tax_pdf_konvex.build_pdf(data, account=account,
                                        sections=(want if sections else None)), yr

    try:
        pdf_bytes, yr = await run_in_threadpool(_run)
        if pdf_bytes is None:
            return JSONResponse({"ok": False, "error": "Kein Steuerjahr"}, status_code=422)
        return Response(content=pdf_bytes, media_type="application/pdf",
                        headers={"Content-Disposition":
                                 f'attachment; filename="IBKR-Steuer-Report_{yr}.pdf"'})
    except ValueError as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=422)
    except Exception as e:
        print(f"tax_report_konvex_pdf error: {e}")
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)


# ── Screener ──────────────────────────────────────────────────────────────────
# Logik in screener.py. Jobs laufen im Background-Thread; Frontend pollt /status.
# Die zuletzt gestartete Job-ID liegt pro Benutzer auf der Platte, damit ein
# Neuladen der Seite ein laufendes Screening nicht aus den Augen verliert.

def _last_screener_job_path(user: str) -> str:
    return os.path.join(get_user_dir(user), "last_screener_job.json")


def _save_last_screener_job(user: str, job_id):
    path = _last_screener_job_path(user)
    if job_id is None:
        if os.path.exists(path):
            try:
                os.remove(path)
            except OSError:
                pass
        return
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump({"job_id": job_id, "started": time.time()}, f)
    shutil.move(tmp, path)


def _load_last_screener_job(user: str):
    path = _last_screener_job_path(user)
    if not os.path.exists(path):
        return None
    try:
        with open(path) as f:
            return json.load(f).get("job_id") or None
    except (OSError, ValueError):
        return None


@app.get("/api/screener/config")
async def screener_config(request: Request):
    get_user(request)
    return {"indexes": list(screener.INDEXES.keys()),
            "sectors": list(screener.SECTORS.keys()),
            "filters": screener.FILTERS,
            "filter_defaults": screener.DEFAULT_FILTERS,
            "legend": screener.FILTER_LEGEND}


# ── Screener-Einstellungen (pro Benutzer) ──────────────────────────────────────
# Eigene Datei statt eines Schlüssels in config.json: `POST /api/config` schreibt
# die Config als Ganzes: der Screener würde bei jedem Basket-Speichern
# überschrieben, weil das Chart-Frontend den Schlüssel gar nicht kennt.

def _screener_settings_path(user: str) -> str:
    return os.path.join(get_user_dir(user), "screener_settings.json")


def _sanitize_screener_settings(body: dict) -> dict:
    """Nur bekannte Werte übernehmen — die Datei wird beim Start wieder in die
    Oberfläche geschrieben, also nichts Ungeprüftes hineinlassen."""
    idx = [n for n in (body.get("indexes") or []) if n in screener.INDEXES]
    try:
        cap_min = max(0.0, float(body.get("cap_min") or 0))
        cap_max = max(0.0, float(body.get("cap_max") or 0))
    except (TypeError, ValueError):
        cap_min = cap_max = 0.0
    unit = body.get("unit") if body.get("unit") in ("Mrd $", "Mio $") else "Mrd $"
    return {
        "indexes": idx,
        "cap_min": cap_min,
        "cap_max": cap_max,
        "unit":    unit,
        # Katalog-Haken und Eigenfilter getrennt: sonst wandern die Eigenen beim
        # nächsten Laden in den Katalog und lassen sich nicht mehr abwählen.
        "filters": screener.sanitize_filters(body.get("filters")),
        "custom":  screener.sanitize_filters(body.get("custom")),
    }


@app.get("/api/screener/settings")
async def screener_settings_get(request: Request):
    """Zuletzt benutzte Screener-Einstellungen. Leeres Objekt = noch keine
    gespeichert, dann gelten die Vorgaben aus screener.py."""
    user = get_user(request)
    path = _screener_settings_path(user)
    if not os.path.exists(path):
        return JSONResponse(content={})
    try:
        with open(path) as f:
            return JSONResponse(content=_sanitize_screener_settings(json.load(f)))
    except Exception:
        return JSONResponse(content={})


@app.post("/api/screener/settings")
async def screener_settings_set(request: Request):
    user = get_user(request)
    data = _sanitize_screener_settings(await request.json())
    path = _screener_settings_path(user)
    tmp  = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f)
    shutil.move(tmp, path)
    return JSONResponse(content={"ok": True, "settings": data})


@app.delete("/api/screener/settings")
async def screener_settings_delete(request: Request):
    """Zurück auf die Vorgaben — Datei weg, nicht leer schreiben."""
    user = get_user(request)
    path = _screener_settings_path(user)
    try:
        if os.path.exists(path):
            os.remove(path)
    except Exception as e:
        return JSONResponse(content={"ok": False, "error": str(e)}, status_code=500)
    return JSONResponse(content={"ok": True})


# ── Screener-Blacklist (pro Benutzer) ─────────────────────────────────────────
# Der Ablauf: Screening → Treffer landen in Baskets → der Benutzer geht die
# Charts durch und wirft heraus, was ihm nicht gefällt → beim nächsten
# Screening kommt das Herausgeworfene nicht wieder, bis die Sperrzeit um ist.
#
# Erfasst wird das Herauswerfen **beim Speichern der Config** und nicht über
# einen eigenen Knopf: gelöscht wird mal in der Stammdatenliste, mal über das
# Chart, und jeder dieser Wege endet in POST /api/config. Ein Knopf müsste an
# jedem einzelnen davon hängen und würde beim nächsten Weg vergessen.
#
# Eigene Datei aus demselben Grund wie die Screener-Einstellungen: POST
# /api/config schreibt die Config als Ganzes und kennt den Screener nicht.

SCREENER_BASKET_PREFIX     = "Screener "   # Präfix aus screenerToBaskets()
BLACKLIST_COOLDOWN_DEFAULT = 6             # Monate
BLACKLIST_COOLDOWN_MAX     = 120
_TICKER_RE = re.compile(r"^[A-Z][A-Z0-9.\-]{0,9}$")


def _screener_ticker(roh) -> str | None:
    """Symbol aus einer Basket-Angabe — oder None, wenn es keins ist."""
    t = str(roh or "").strip().upper()
    return t if _TICKER_RE.match(t) else None


def _screener_blacklist_path(user: str) -> str:
    return os.path.join(get_user_dir(user), "screener_blacklist.json")


def _screener_blacklist_load(user: str) -> dict:
    """Datei lesen und auf die bekannte Form bringen. Fehlt sie, gelten die Vorgaben."""
    daten = {"cooldown_months": BLACKLIST_COOLDOWN_DEFAULT, "active": True, "entries": {}}
    path = _screener_blacklist_path(user)
    if not os.path.exists(path):
        return daten
    try:
        with open(path) as f:
            roh = json.load(f)
    except (OSError, ValueError):
        return daten
    try:
        cd = int(roh.get("cooldown_months", BLACKLIST_COOLDOWN_DEFAULT))
    except (TypeError, ValueError):
        cd = BLACKLIST_COOLDOWN_DEFAULT
    daten["cooldown_months"] = max(1, min(cd, BLACKLIST_COOLDOWN_MAX))
    daten["active"] = bool(roh.get("active", True))
    for t, e in (roh.get("entries") or {}).items():
        sym = _screener_ticker(t)
        if not sym:
            continue
        if isinstance(e, str):          # knappe Form: nur das Datum
            e = {"date": e}
        if not isinstance(e, dict):
            continue
        daten["entries"][sym] = {"date": str(e.get("date") or "")[:10],
                                 "from":  str(e.get("from") or "")[:120]}
    return daten


def _screener_blacklist_save(user: str, daten: dict):
    path = _screener_blacklist_path(user)
    tmp  = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump({"cooldown_months": daten.get("cooldown_months", BLACKLIST_COOLDOWN_DEFAULT),
                   "active":  bool(daten.get("active", True)),
                   "entries": daten.get("entries") or {}}, f, indent=2)
    shutil.move(tmp, path)


def _datum_ts(datum):
    """„YYYY-MM-DD" → Zeitstempel. None, wenn das Feld leer oder unlesbar ist."""
    try:
        return time.mktime(time.strptime(str(datum)[:10], "%Y-%m-%d"))
    except (TypeError, ValueError, OverflowError):
        return None


def _screener_aktive_sperren(daten: dict) -> dict:
    """Die noch wirksamen Einträge. Ein Monat zählt als 30 Tage — die Sperrzeit
    ist eine Hausnummer und keine Frist, auf die es taggenau ankäme. Einträge
    ohne lesbares Datum bleiben wirksam, statt still zu verfallen."""
    monate = int(daten.get("cooldown_months") or BLACKLIST_COOLDOWN_DEFAULT)
    grenze = time.time() - monate * 30 * 86400
    aktiv = {}
    for sym, e in (daten.get("entries") or {}).items():
        ts = _datum_ts(e.get("date"))
        if ts is None or ts > grenze:
            aktiv[sym] = e
    return aktiv


def _screener_basket_inhalte(cfg: dict) -> dict:
    """{basket_id: (Name, set(Ticker))} für alle Baskets mit dem Screener-Präfix."""
    out = {}
    for bid, b in ((cfg or {}).get("baskets") or {}).items():
        if not isinstance(b, dict):
            continue
        name = str(b.get("name") or "")
        if not name.startswith(SCREENER_BASKET_PREFIX):
            continue
        out[bid] = (name, {t for t in (b.get("weights") or {}) if _screener_ticker(t)})
    return out


def _screener_protokolliere_entfernte(user: str, alt: dict, neu: dict) -> list[str]:
    """Vergleicht die Screener-Baskets vor und nach dem Speichern und schreibt
    jedes entfernte Symbol mit dem heutigen Datum in die Blacklist.

    Nur Baskets, die es **vorher und nachher** gibt: wer einen ganzen Basket
    löscht (oder den Knopf „Screener-Baskets löschen" drückt), sortiert nicht
    hundert Werte aus, sondern räumt auf. Ein bereits gesperrtes Symbol behält
    sein altes Datum — sonst verlängerte jedes erneute Aufräumen die Sperre.
    """
    vorher, nachher = _screener_basket_inhalte(alt), _screener_basket_inhalte(neu)
    entfernt = {}
    for bid, (name, tickers) in vorher.items():
        if bid not in nachher:
            continue
        for t in tickers - nachher[bid][1]:
            entfernt.setdefault(t, name)
    if not entfernt:
        return []

    daten = _screener_blacklist_load(user)
    # Abgelaufene fallen beim Schreiben heraus: sie wirken ohnehin nicht mehr.
    daten["entries"] = _screener_aktive_sperren(daten)
    heute = time.strftime("%Y-%m-%d")
    neu_gesperrt = []
    for sym, basket in sorted(entfernt.items()):
        if sym in daten["entries"]:
            continue
        daten["entries"][sym] = {"date": heute, "from": basket}
        neu_gesperrt.append(sym)
    _screener_blacklist_save(user, daten)
    return neu_gesperrt


@app.get("/api/screener/blacklist")
async def screener_blacklist_get(request: Request):
    """Die wirksamen Sperren, neueste zuerst. Abgelaufene stehen nicht drin."""
    user  = get_user(request)
    daten = _screener_blacklist_load(user)
    jetzt = time.time()
    liste = []
    for sym, e in _screener_aktive_sperren(daten).items():
        ts = _datum_ts(e.get("date"))
        liste.append({
            "ticker":   sym,
            "date":     e.get("date") or "",
            "from":     e.get("from") or "",
            "age_days": int((jetzt - ts) // 86400) if ts else None,
        })
    liste.sort(key=lambda x: (x["date"], x["ticker"]), reverse=True)
    return {"ok": True,
            "cooldown_months": daten["cooldown_months"],
            "active":          daten["active"],
            "count":           len(liste),
            "entries":         liste}


@app.post("/api/screener/blacklist")
async def screener_blacklist_set(request: Request):
    """Sperrzeit und Ein/Aus. Die Einträge selbst entstehen beim Aufräumen der
    Baskets, nicht hier."""
    user  = get_user(request)
    body  = await request.json()
    daten = _screener_blacklist_load(user)
    if "cooldown_months" in body:
        try:
            cd = int(body.get("cooldown_months"))
        except (TypeError, ValueError):
            return JSONResponse({"ok": False, "error": "Sperrzeit muss eine Zahl sein"},
                                status_code=400)
        daten["cooldown_months"] = max(1, min(cd, BLACKLIST_COOLDOWN_MAX))
    if "active" in body:
        daten["active"] = bool(body.get("active"))
    _screener_blacklist_save(user, daten)
    return {"ok": True,
            "cooldown_months": daten["cooldown_months"],
            "active":          daten["active"]}


@app.delete("/api/screener/blacklist")
async def screener_blacklist_clear(request: Request):
    """Alles freigeben. Die Einstellungen bleiben, nur die Einträge gehen weg."""
    user   = get_user(request)
    daten  = _screener_blacklist_load(user)
    anzahl = len(_screener_aktive_sperren(daten))
    daten["entries"] = {}
    _screener_blacklist_save(user, daten)
    return {"ok": True, "removed": anzahl}


@app.delete("/api/screener/blacklist/{ticker}")
async def screener_blacklist_free(ticker: str, request: Request):
    """Einen einzelnen Wert wieder zulassen. Fliegt er erneut aus einem
    Screener-Basket, steht er mit neuem Datum wieder hier."""
    user = get_user(request)
    sym  = _screener_ticker(ticker)
    if not sym:
        return JSONResponse({"ok": False, "error": "Kein gültiges Symbol"}, status_code=400)
    daten = _screener_blacklist_load(user)
    if sym not in daten["entries"]:
        return JSONResponse({"ok": False, "error": f"{sym} steht nicht auf der Blacklist"},
                            status_code=404)
    daten["entries"].pop(sym)
    _screener_blacklist_save(user, daten)
    return {"ok": True, "ticker": sym}


@app.post("/api/screener/run")
async def screener_run(request: Request):
    user = get_user(request)
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

    # Filter aus Katalog-Auswahl + optionalen Eigenangaben, serverseitig validiert
    raw_filters = body.get("filters")
    if not isinstance(raw_filters, list):
        raw_filters = []
    filters = screener.sanitize_filters(raw_filters)

    # Gesperrte Werte gar nicht erst ausliefern: sie hat der Benutzer beim
    # letzten Durchgang aus den Baskets geworfen.
    bl = _screener_blacklist_load(user)
    gesperrt = set(_screener_aktive_sperren(bl)) if bl.get("active", True) else set()

    job_id = screener.start_job(index_names, cap_min, cap_max, unit, filters,
                                blacklist=gesperrt)
    _save_last_screener_job(user, job_id)
    return {"ok": True, "job_id": job_id, "blacklist": len(gesperrt)}


@app.get("/api/screener/last")
async def screener_last(request: Request):
    """
    Letzter gestarteter Job dieses Benutzers — damit sich die Oberfläche nach
    einem Seitenwechsel oder Neuladen wieder an ein laufendes Screening hängt.
    Jobs leben nur im Speicher (30 Min TTL); ist der Job weg, gilt das auch hier.
    """
    user = get_user(request)
    job_id = _load_last_screener_job(user)
    if not job_id or screener.get_status(job_id) is None:
        if job_id:
            _save_last_screener_job(user, None)   # verwaiste Notiz aufräumen
        return {"ok": True, "job_id": None}
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
    fname = f'Screening_Ergebnis_{time.strftime("%Y-%m-%d_%H-%M")}.txt'
    return PlainTextResponse(
        text,
        headers={"Content-Disposition":
                 f'attachment; filename="{fname}"'},
    )

