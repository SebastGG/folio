"""
screener.py — Sektor-Screener (Finviz + yfinance)
==================================================
Logik aus dem Sector_Screener Notebook (Phase 1):
- Finviz: pro Index x Sektor mit TA-Filtern screenen
- yfinance: MarktCap-Filter

Jobs laufen in einem Background-Thread. Status/Log/Ergebnisse
werden in einem In-Memory-Dict pro User gehalten und vom Frontend
gepollt.
"""

import re
import gzip
import time
import uuid
import threading
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

import yfinance as yf
from bs4 import BeautifulSoup


# ── Konfiguration ────────────────────────────────────────────
DELAY_BETWEEN_REQUESTS = 2
YF_BATCH_SIZE          = 10
YF_BATCH_DELAY         = 1.5
YF_THREAD_WORKERS      = 5
JOB_TTL_SECONDS        = 30 * 60   # alte Jobs nach 30 Min weg
FINVIZ_PAGE_SIZE       = 20        # Treffer pro Finviz-Seite
MAX_PAGES              = 20        # Sicherheits-Obergrenze je Index×Sektor (≈400 Treffer)
PAGE_DELAY             = 1.0       # Pause zwischen Seiten-Abrufen

BASE_URL = "https://finviz.com/screener.ashx?v=111&f="

INDEXES = {
    "S&P 500":      "idx_sp500",
    "NASDAQ 100":   "idx_ndx",
    "DJIA":         "idx_djia",
    "Russell 2000": "idx_rut",
}

SECTORS = {
    "Basic Materials":        "sec_basicmaterials",
    "Communication Services": "sec_communicationservices",
    "Consumer Cyclical":      "sec_consumercyclical",
    "Consumer Defensive":     "sec_consumerdefensive",
    "Energy":                 "sec_energy",
    "Financial":              "sec_financial",
    "Healthcare":             "sec_healthcare",
    "Industrials":            "sec_industrials",
    "Real Estate":            "sec_realestate",
    "Technology":             "sec_technology",
    "Utilities":              "sec_utilities",
}

# Katalog auswählbarer Finviz-Filter (Gruppen → Items). Die Codes sind die
# Finviz-Screener-Parameter (f=…). Alle ausgewählten Filter werden UND-verknüpft.
FILTERS = [
    {"group": "52-Wochen / N-Tage-Hochs", "items": [
        {"code": "ta_highlow20d_nh", "label": "20-Tage-Hoch"},
        {"code": "ta_highlow50d_nh", "label": "50-Tage-Hoch"},
        {"code": "ta_highlow52w_nh", "label": "52-Wochen-Hoch"},
        {"code": "ta_highlow52w_nl", "label": "52-Wochen-Tief"},
    ]},
    {"group": "Gleitende Durchschnitte", "items": [
        {"code": "ta_sma20_pa",       "label": "Kurs über SMA20"},
        {"code": "ta_sma50_pa",       "label": "Kurs über SMA50"},
        {"code": "ta_sma200_pa",      "label": "Kurs über SMA200"},
        {"code": "ta_sma20_pb",       "label": "Kurs unter SMA20"},
        {"code": "ta_sma50_pb",       "label": "Kurs unter SMA50"},
        {"code": "ta_sma200_pb",      "label": "Kurs unter SMA200"},
        {"code": "ta_sma50_cross200a", "label": "Golden Cross (SMA50×200 ↑)"},
        {"code": "ta_sma50_cross200b", "label": "Death Cross (SMA50×200 ↓)"},
    ]},
    {"group": "RSI (14)", "items": [
        {"code": "ta_rsi_os30", "label": "überverkauft (<30)"},
        {"code": "ta_rsi_os40", "label": "< 40"},
        {"code": "ta_rsi_ob60", "label": "> 60"},
        {"code": "ta_rsi_ob70", "label": "überkauft (>70)"},
    ]},
    {"group": "Performance", "items": [
        {"code": "ta_perf_1wup",  "label": "Woche positiv"},
        {"code": "ta_perf_4wup",  "label": "Monat positiv"},
        {"code": "ta_perf_13wup", "label": "Quartal positiv"},
        {"code": "ta_perf_52wup", "label": "Jahr positiv"},
    ]},
    {"group": "Fundamental", "items": [
        {"code": "fa_pe_profitable", "label": "Profitabel (KGV positiv)"},
        {"code": "fa_pe_u20",        "label": "KGV < 20"},
        {"code": "fa_div_pos",       "label": "Dividende > 0"},
        {"code": "fa_epsyoy_pos",    "label": "EPS-Wachstum lfd. Jahr > 0"},
    ]},
]

# Voreinstellung = das bisherige fest verdrahtete Set
DEFAULT_FILTERS = [
    "ta_highlow20d_nh",
    "ta_highlow50d_nh",
    "ta_highlow52w_nh",
    "ta_sma20_pa",
    "ta_sma50_pa",
    "ta_sma200_pa",
]

import re as _re
_FILTER_CODE_RE = _re.compile(r"^[a-z0-9_.]+$")   # Punkt für Codes wie sh_relvol_o1.5

def sanitize_filters(codes) -> list[str]:
    """Lässt nur gültige Finviz-Filter-Codes durch (a-z0-9_.), dedupliziert, Reihenfolge erhalten."""
    out, seen = [], set()
    for c in (codes or []):
        c = str(c).strip().lower()
        if c and c not in seen and _FILTER_CODE_RE.match(c):
            seen.add(c)
            out.append(c)
    return out


# Referenz häufig genutzter Finviz-Screener-Codes (für die Legende im Frontend / das
# Eigenfilter-Feld). Suffixe sind mechanisch: _uN = unter N, _oN = über N. Keine
# vollständige Liste — die komplette Auswahl steht im Finviz-Screener (Link in der UI).
FILTER_LEGEND = [
    {"group": "Index", "items": [
        {"code": "idx_sp500", "desc": "S&P 500"},
        {"code": "idx_ndx",   "desc": "Nasdaq 100"},
        {"code": "idx_djia",  "desc": "Dow Jones"},
        {"code": "idx_rut",   "desc": "Russell 2000"},
    ]},
    {"group": "Sektor (sec_…)", "items": [
        {"code": "sec_technology",            "desc": "Technologie"},
        {"code": "sec_healthcare",            "desc": "Gesundheit"},
        {"code": "sec_financial",             "desc": "Finanzen"},
        {"code": "sec_energy",                "desc": "Energie"},
        {"code": "sec_industrials",           "desc": "Industrie"},
        {"code": "sec_consumercyclical",      "desc": "Zykl. Konsum"},
        {"code": "sec_consumerdefensive",     "desc": "Defensiver Konsum"},
        {"code": "sec_communicationservices", "desc": "Kommunikation"},
        {"code": "sec_basicmaterials",        "desc": "Rohstoffe"},
        {"code": "sec_realestate",            "desc": "Immobilien"},
        {"code": "sec_utilities",             "desc": "Versorger"},
    ]},
    {"group": "MarktCap (cap_…)", "items": [
        {"code": "cap_mega",       "desc": "Mega (> 200 Mrd $)"},
        {"code": "cap_large",      "desc": "Large (10–200 Mrd)"},
        {"code": "cap_mid",        "desc": "Mid (2–10 Mrd)"},
        {"code": "cap_small",      "desc": "Small (300 Mio–2 Mrd)"},
        {"code": "cap_micro",      "desc": "Micro (50–300 Mio)"},
        {"code": "cap_smallover",  "desc": "Small und größer"},
        {"code": "cap_midover",    "desc": "Mid und größer"},
    ]},
    {"group": "Kurs & Volumen", "items": [
        {"code": "sh_price_u5",     "desc": "Kurs < 5 $ (o10/o20/o50 = über N)"},
        {"code": "sh_price_o10",    "desc": "Kurs > 10 $"},
        {"code": "sh_avgvol_o100",  "desc": "Ø-Vol > 100K (o500, o1000=1 Mio)"},
        {"code": "sh_relvol_o1.5",  "desc": "Rel. Volumen > 1,5× (o2, o5)"},
        {"code": "sh_short_high",   "desc": "Hohe Short-Quote (short_low)"},
    ]},
    {"group": "Hochs/Tiefs (ta_highlow…)", "items": [
        {"code": "ta_highlow52w_nh",   "desc": "neues 52-Wochen-Hoch"},
        {"code": "ta_highlow52w_nl",   "desc": "neues 52-Wochen-Tief"},
        {"code": "ta_highlow52w_b0to10h", "desc": "max. 10 % unter 52W-Hoch"},
        {"code": "ta_highlow20d_nh",   "desc": "neues 20-Tage-Hoch"},
        {"code": "ta_highlow50d_nh",   "desc": "neues 50-Tage-Hoch"},
    ]},
    {"group": "SMA (ta_sma20/50/200_…)", "items": [
        {"code": "ta_sma50_pa",        "desc": "Kurs über SMA50 (_pb = unter)"},
        {"code": "ta_sma200_pa",       "desc": "Kurs über SMA200"},
        {"code": "ta_sma20_pca",       "desc": "Kurs kreuzt SMA20 von unten (_pcb = von oben)"},
        {"code": "ta_sma50_cross200a", "desc": "Golden Cross (50×200 ↑)"},
        {"code": "ta_sma50_cross200b", "desc": "Death Cross (50×200 ↓)"},
    ]},
    {"group": "RSI / Performance / Volatilität", "items": [
        {"code": "ta_rsi_os30",      "desc": "RSI < 30 überverkauft (os20/os40)"},
        {"code": "ta_rsi_ob70",      "desc": "RSI > 70 überkauft (ob60/ob80)"},
        {"code": "ta_perf_4wup",     "desc": "Monat positiv (1w/13w/26w/52w/ytd up)"},
        {"code": "ta_perf_52wdown",  "desc": "Jahr negativ (…down)"},
        {"code": "ta_volatility_wo3", "desc": "Woche-Volatilität > 3 % (mo3 = Monat)"},
    ]},
    {"group": "Chartmuster (ta_pattern_…)", "items": [
        {"code": "ta_pattern_channelup",   "desc": "Aufwärtskanal (channeldown)"},
        {"code": "ta_pattern_wedgeup",     "desc": "steigender Keil (wedgedown)"},
        {"code": "ta_pattern_triangleascending",  "desc": "aufst. Dreieck (…descending)"},
        {"code": "ta_pattern_doublebottom", "desc": "Doppelboden (doubletop)"},
        {"code": "ta_pattern_tlsupport",   "desc": "an Unterstützung (tlresistance)"},
    ]},
    {"group": "Bewertung (fa_…)", "items": [
        {"code": "fa_pe_profitable", "desc": "profitabel (KGV > 0)"},
        {"code": "fa_pe_u20",        "desc": "KGV < 20 (u15/u25/…)"},
        {"code": "fa_peg_u1",        "desc": "PEG < 1"},
        {"code": "fa_pb_u1",         "desc": "Kurs/Buch < 1"},
        {"code": "fa_ps_u1",         "desc": "Kurs/Umsatz < 1"},
    ]},
    {"group": "Dividende & Wachstum (fa_…)", "items": [
        {"code": "fa_div_pos",       "desc": "Dividende > 0 (div_none = keine)"},
        {"code": "fa_div_o2",        "desc": "Div.-Rendite > 2 % (o5, high>5%)"},
        {"code": "fa_epsyoy_pos",    "desc": "EPS-Wachstum lfd. Jahr > 0 (o10=>10%)"},
        {"code": "fa_eps5years_pos", "desc": "EPS-Wachstum 5J > 0"},
        {"code": "fa_salesqoq_pos",  "desc": "Umsatzwachstum Q/Q > 0"},
    ]},
    {"group": "Profitabilität & Bilanz (fa_…)", "items": [
        {"code": "fa_roe_o15",     "desc": "Eigenkapitalrendite > 15 %"},
        {"code": "fa_roa_pos",     "desc": "Gesamtkapitalrendite > 0"},
        {"code": "fa_netmargin_pos", "desc": "Nettomarge > 0 (_o10 = > 10 %)"},
        {"code": "fa_debteq_u0.5", "desc": "Verschuldung (D/E) < 0,5"},
        {"code": "fa_curratio_o1", "desc": "Liquidität 3. Grades > 1"},
    ]},
]


# ── Job-Verwaltung ──────────────────────────────────────────
_jobs: dict[str, dict] = {}
_jobs_lock = threading.Lock()


def _gc_old_jobs():
    now = time.time()
    with _jobs_lock:
        stale = [k for k, j in _jobs.items()
                 if now - j.get("created_at", now) > JOB_TTL_SECONDS]
        for k in stale:
            _jobs.pop(k, None)


def _log(job_id: str, msg: str):
    with _jobs_lock:
        j = _jobs.get(job_id)
        if j is not None:
            j["log"].append(msg)


def _set(job_id: str, **kw):
    with _jobs_lock:
        j = _jobs.get(job_id)
        if j is not None:
            j.update(kw)


# ── Finviz ──────────────────────────────────────────────────
def _build_url(index_code: str, sector_code: str, filters: list[str]) -> str:
    """Baut die Finviz-Screener-URL. Endet bewusst auf ein Komma.

    Ohne das abschließende Komma verwirft Finviz den LETZTEN Filter der Liste —
    nachgewiesen: `idx_sp500,sec_technology` liefert alle Sektoren des S&P 500,
    `sec_technology,idx_sp500` liefert Technology quer über alle Indizes, und erst
    `idx_sp500,sec_technology,` liefert wirklich S&P-500-Technologiewerte.
    Der Screener hat dadurch faktisch immer einen Filter zu wenig angewandt.
    """
    parts = [p for p in ([index_code, sector_code] + list(filters)) if p]
    if not parts:
        return BASE_URL
    return BASE_URL + ",".join(parts) + ","


def _extract_tickers(soup) -> list[str]:
    """Liest die Symbole einer Screener-Seite — aus dem HTML, nicht aus dem Zellentext.

    Finviz rendert in der Ticker-Spalte seit einer Umstellung ein Logo-Element vor
    dem Symbol. `pandas.read_html` liest dessen Text mit, wodurch der erste
    Buchstabe doppelt erscheint: aus „AAPL" wird „AAAPL", aus „A" wird „AA".
    Das Attribut `data-boxover-ticker` der Zelle trägt das Symbol unverfälscht.

    Fällt auf den Link `stock?t=SYMBOL` zurück, falls Finviz das Attribut aufgibt.
    """
    out, seen = [], set()

    def _add(sym):
        sym = (sym or "").strip().upper()
        if sym and sym not in seen:
            seen.add(sym)
            out.append(sym)

    for td in soup.find_all(attrs={"data-boxover-ticker": True}):
        _add(td.get("data-boxover-ticker"))

    if not out:
        for a in soup.find_all("a", class_="company-ticker"):
            href = a.get("href") or ""
            m = re.search(r"[?&]t=([A-Za-z0-9.\-]+)", href)
            if m:
                _add(m.group(1))

    return out


def _fetch_soup(url: str) -> BeautifulSoup:
    """Holt eine Finviz-Seite. Ohne browserähnliche Kopfzeilen liefert Finviz eine
    Seite ohne Ergebnistabelle."""
    req = urllib.request.Request(url, headers={
        "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                       "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
    })
    with urllib.request.urlopen(req, timeout=25) as resp:
        raw = resp.read()
    if raw[:2] == b"\x1f\x8b":                     # gzip
        raw = gzip.decompress(raw)
    return BeautifulSoup(raw.decode("utf-8", "replace"), "html.parser")


def _total_hits(soup) -> int | None:
    """Liest Finviz' eigene Trefferzahl („#1 / 86 Total"). None = nicht gefunden."""
    m = re.search(r"#\d+\s*/\s*([\d,]+)\s*Total", soup.get_text(" ", strip=True))
    return int(m.group(1).replace(",", "")) if m else None


def _screen_sector(index_code: str, sector_code: str, filters: list[str]) -> list[str]:
    """Holt ALLE Treffer eines Index×Sektors über Finviz-Seiten-Paginierung (&r=Offset).

    Bewusst ohne pyfinviz: dessen pandas-Auswertung scheitert an den Folgeseiten
    („Shape of passed values is (0, 1)"), der Fehler wurde hier als „Ende" gewertet
    und der Screener lieferte still nur die ersten 20 von z.B. 86 Treffern.
    Abbruch primär über Finviz' eigene Trefferzahl, ersatzweise über eine nicht
    volle bzw. wiederholte Seite.
    """
    base = _build_url(index_code, sector_code, filters)
    seen, seen_set = [], set()
    total = None
    for page in range(MAX_PAGES):
        offset = page * FINVIZ_PAGE_SIZE
        url = base + (f"&r={offset + 1}" if offset else "")
        try:
            soup = _fetch_soup(url)
        except Exception:
            break                              # Netzfehler → mit dem Bisherigen weiter
        if total is None:
            total = _total_hits(soup)
        tickers = _extract_tickers(soup)
        if not tickers:
            break
        new = [t for t in tickers if t not in seen_set]
        for t in new:
            seen_set.add(t)
            seen.append(t)
        if total is not None and len(seen) >= total:
            break
        # Letzte Seite erreicht: nicht voll ODER keine neuen Ticker (Wiederholung)
        if len(tickers) < FINVIZ_PAGE_SIZE or not new:
            break
        if page < MAX_PAGES - 1:
            time.sleep(PAGE_DELAY)
    return seen


# ── yfinance MarktCap ───────────────────────────────────────
def _fetch_marketcap(ticker: str):
    try:
        info = yf.Ticker(ticker).info
        return ticker, info.get("marketCap", None)
    except Exception:
        return ticker, None


def _fetch_all_marketcaps(tickers: list[str]) -> dict:
    result = {}
    for i in range(0, len(tickers), YF_BATCH_SIZE):
        batch = tickers[i : i + YF_BATCH_SIZE]
        with ThreadPoolExecutor(max_workers=YF_THREAD_WORKERS) as pool:
            futures = {pool.submit(_fetch_marketcap, t): t for t in batch}
            for fut in as_completed(futures):
                t, cap = fut.result()
                result[t] = cap
        if i + YF_BATCH_SIZE < len(tickers):
            time.sleep(YF_BATCH_DELAY)
    return result


def _filter_by_marketcap(tickers, cap_min, cap_max, marketcaps):
    kept, dropped = [], []
    for t in tickers:
        cap = marketcaps.get(t)
        if cap is None:
            dropped.append(t)
            continue
        if cap_min is not None and cap < cap_min:
            dropped.append(t)
            continue
        if cap_max is not None and cap > cap_max:
            dropped.append(t)
            continue
        kept.append(t)
    return kept, dropped


# ── Worker ──────────────────────────────────────────────────
def _run_job(job_id: str, index_names: list[str], cap_min, cap_max, unit: str,
             filters: list[str]):
    try:
        active_indexes = [(n, INDEXES[n]) for n in index_names if n in INDEXES]
        if not active_indexes:
            _set(job_id, status="error", error="Kein gültiger Index ausgewählt")
            return
        filters = list(filters or [])

        need_yf = cap_min is not None or cap_max is not None
        cap_label = "egal (alle)"
        if need_yf:
            mn = f"{cap_min/1e9:g} {unit}" if cap_min else "–"
            mx = f"{cap_max/1e9:g} {unit}" if cap_max else "–"
            cap_label = f"{mn} bis {mx}"

        _log(job_id, "═" * 50)
        _log(job_id, f"  Indizes:  {', '.join(n for n, _ in active_indexes)}")
        _log(job_id, f"  Filter:   {', '.join(filters) if filters else 'keine (ganzer Index/Sektor)'}")
        _log(job_id, f"  MarktCap: {cap_label}")
        _log(job_id, "═" * 50)
        _log(job_id, "")
        _log(job_id, "📡 Phase 1: Finviz Screening …")

        raw_scan = {name: set() for name in SECTORS}
        total = len(active_indexes) * len(SECTORS)
        counter = 0

        for idx_name, idx_code in active_indexes:
            _log(job_id, "")
            _log(job_id, f"── {idx_name} ──")
            for sec_name, sec_code in SECTORS.items():
                counter += 1
                try:
                    tickers = _screen_sector(idx_code, sec_code, filters)
                    raw_scan[sec_name].update(tickers)
                    _log(job_id, f"[{counter}/{total}] {sec_name}: {len(tickers)} Ticker")
                except Exception as e:
                    _log(job_id, f"[{counter}/{total}] {sec_name}: Fehler – {e}")
                _set(job_id, progress=counter / total)
                if counter < total:
                    time.sleep(DELAY_BETWEEN_REQUESTS)

        raw_total = sum(len(t) for t in raw_scan.values())
        _log(job_id, "")
        _log(job_id, f"✓ Finviz fertig — {raw_total} Ticker (mit Duplikaten je Sektor)")

        # Phase 2: MarktCap-Filter
        if need_yf:
            all_tickers = sorted({t for ts in raw_scan.values() for t in ts})
            _log(job_id, "")
            _log(job_id, f"📊 Phase 2: MarktCap für {len(all_tickers)} Ticker abfragen …")
            marketcaps = _fetch_all_marketcaps(all_tickers)

            final = {}
            for name in SECTORS:
                kept, dropped = _filter_by_marketcap(
                    list(raw_scan[name]), cap_min, cap_max, marketcaps
                )
                final[name] = sorted(kept)
                if dropped:
                    _log(job_id, f"  {name}: {len(kept)} behalten, {len(dropped)} raus")
                else:
                    _log(job_id, f"  {name}: {len(kept)} behalten")
            kept_total = sum(len(t) for t in final.values())
            _log(job_id, "")
            _log(job_id, f"✓ Filter fertig — {kept_total} von {raw_total} übrig")
        else:
            final = {name: sorted(ts) for name, ts in raw_scan.items()}

        # leere Sektoren raus
        final = {k: v for k, v in final.items() if v}

        _log(job_id, "")
        _log(job_id, "═" * 50)
        _log(job_id, "✓ Screening komplett")
        _log(job_id, "═" * 50)

        _set(job_id, status="done", results=final, progress=1.0)

    except Exception as e:
        _set(job_id, status="error", error=str(e))
        _log(job_id, f"FEHLER: {e}")


# ── Öffentliche API ─────────────────────────────────────────
def start_job(index_names: list[str], cap_min, cap_max, unit: str,
              filters: list[str] | None = None) -> str:
    _gc_old_jobs()
    job_id = uuid.uuid4().hex[:12]
    with _jobs_lock:
        _jobs[job_id] = {
            "status":     "running",
            "log":        [],
            "results":    {},
            "error":      None,
            "progress":   0.0,
            "created_at": time.time(),
        }
    t = threading.Thread(
        target=_run_job,
        args=(job_id, index_names, cap_min, cap_max, unit, filters or []),
        daemon=True,
    )
    t.start()
    return job_id


def get_status(job_id: str) -> dict | None:
    with _jobs_lock:
        j = _jobs.get(job_id)
        if j is None:
            return None
        return {
            "status":   j["status"],
            "progress": j["progress"],
            "log":      list(j["log"]),
            "results":  dict(j["results"]),
            "error":    j["error"],
        }


def format_tradingview(results: dict) -> str:
    """Format: ###Sektorname:,TICKER1,TICKER2,..., je Zeile ein Sektor."""
    lines = []
    for sector in SECTORS:  # stabile Reihenfolge
        tickers = results.get(sector)
        if tickers:
            lines.append(f"###{sector}:," + ",".join(tickers) + ",")
    return "\n".join(lines) + "\n"
