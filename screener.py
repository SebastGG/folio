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

import time
import uuid
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed

import pandas as pd
import yfinance as yf
from pyfinviz.screener import Screener


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
_FILTER_CODE_RE = _re.compile(r"^[a-z0-9_]+$")

def sanitize_filters(codes) -> list[str]:
    """Lässt nur gültige Finviz-Filter-Codes durch (a-z0-9_), dedupliziert, Reihenfolge erhalten."""
    out, seen = [], set()
    for c in (codes or []):
        c = str(c).strip().lower()
        if c and c not in seen and _FILTER_CODE_RE.match(c):
            seen.add(c)
            out.append(c)
    return out


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
    return BASE_URL + ",".join([index_code, sector_code] + list(filters))


def _extract_tickers(df) -> list[str]:
    ticker_col = next(
        (c for c in df.columns if "Ticker" in c or "Symbol" in c),
        None,
    )
    if ticker_col is None:
        return []
    return df[ticker_col].dropna().unique().tolist()


def _screen_sector(index_code: str, sector_code: str, filters: list[str]) -> list[str]:
    """Holt ALLE Treffer eines Index×Sektors über Finviz-Seiten-Paginierung (&r=Offset).

    Finviz liefert 20 Treffer/Seite. Wir holen Seite für Seite, bis eine Seite
    keine neuen Ticker oder weniger als eine volle Seite liefert (oder MAX_PAGES).
    pyfinviz wirft bei einer leeren Folgeseite einen Fehler → als „Ende" werten.
    """
    base = _build_url(index_code, sector_code, filters)
    seen, seen_set = [], set()
    for page in range(MAX_PAGES):
        offset = page * FINVIZ_PAGE_SIZE
        url = base + (f"&r={offset + 1}" if offset else "")
        try:
            s = Screener(main_url=url)
            frames = s.data_frames
            if not frames:
                break
            df = pd.concat(frames.values(), ignore_index=True)
        except Exception:
            break                              # leere/letzte Folgeseite → Ende
        if df.empty:
            break
        tickers = _extract_tickers(df)
        new = [t for t in tickers if t not in seen_set]
        for t in new:
            seen_set.add(t)
            seen.append(t)
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
