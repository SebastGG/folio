"""
screening.py — Screener, der seine Filter selbst rechnet
=========================================================
Statt Finviz je Index × Sektor abzufragen, rechnet er die technischen Filter aus
den Tageskursen, die markt.py für die Screening-Märkte sammelt (universen.py):
US-Gesamtmarkt, STOXX Europe 600, MDAX, SDAX und S&P/TSX Composite. Finviz kennt
nur US-Notierungen; Kanada und Europa gäbe es dort nicht.

Die Filtercodes sind die des bisherigen Katalogs (screener.FILTERS), damit die
gespeicherten Einstellungen weiter gelten. Fundamentale Filter (fa_…) lassen sich
aus Kursen nicht rechnen und werden abgelehnt, statt still übergangen zu werden.

Junge Werte (IPOs): Ein Filter, für den die Historie nicht reicht (SMA200 nach
drei Monaten Börsenhandel), gilt als nicht erfüllt — außer mit `junge=True`, dann
wird er übersprungen. Das 52-Wochen-Hoch/-Tief gilt wie bei Finviz seit dem
ersten Handelstag.

Die Läufe nutzen die Job-Verwaltung von screener.py (Fortschritt, Protokoll,
Status-Abfrage), damit die Oberfläche gleich bleibt.
"""

import json
import math
import sqlite3
import threading
import time
import uuid

import markt
import screener
import universen

# Kerzen je Zeitraum (Handelstage)
_N = {"20d": 20, "50d": 50, "52w": 252}
_PERF = {"1w": 5, "4w": 21, "13w": 63, "52w": 252}
LESE_KERZEN = 320            # reicht für SMA200 + Kreuzung in den letzten Tagen und 52 Wochen
KREUZ_TAGE = 5               # Golden/Death Cross: innerhalb der letzten 5 Handelstage
VERALTET_TAGE = 6            # letzter Kurs so viele Kalendertage hinter dem Markt → raus

# Yahoo-Sektoren → Namen der Screener-Baskets (bisher Finviz-Namen)
_SEKTOR = {"Financial Services": "Financial"}
OHNE_SEKTOR = "Ohne Sektor"

# Kleinwährungen bei Yahoo — die Marktkapitalisierung steht in der Hauptwährung
_KLEIN = {"GBp": "GBP", "GBX": "GBP", "ZAc": "ZAR", "ILA": "ILS"}


def lokale_filter() -> list[dict]:
    """Der Filterkatalog ohne die fundamentalen Filter."""
    return [g for g in screener.FILTERS if not all(it["code"].startswith("fa_") for it in g["items"])]


def unterstuetzt(code: str) -> bool:
    return _pruefer(code) is not None


# ── Kennzahlen ──────────────────────────────────────────────────────────────────
def _sma(werte, n, ende=None):
    """Mittel der n Werte bis einschließlich Index `ende` (Vorgabe: letzter)."""
    ende = len(werte) - 1 if ende is None else ende
    if ende + 1 < n or ende < 0:
        return None
    return sum(werte[ende - n + 1:ende + 1]) / n

def _rsi(closes, n=14):
    """RSI nach Wilder. Braucht mindestens 3n Kerzen, damit die Glättung eingeschwungen ist."""
    if len(closes) < 3 * n + 1:
        return None
    gew = verl = 0.0
    for i in range(1, n + 1):
        d = closes[i] - closes[i - 1]
        gew += max(d, 0); verl += max(-d, 0)
    gew /= n; verl /= n
    for i in range(n + 1, len(closes)):
        d = closes[i] - closes[i - 1]
        gew = (gew * (n - 1) + max(d, 0)) / n
        verl = (verl * (n - 1) + max(-d, 0)) / n
    if verl == 0:
        return 100.0
    return 100 - 100 / (1 + gew / verl)


# ── Filter ──────────────────────────────────────────────────────────────────────
# Jeder Prüfer bekommt die Kerzen (dict mit Listen c/h/l) und liefert True,
# False oder None (Historie reicht nicht).

def _pruefer(code: str):
    teile = code.split("_")
    if code.startswith("ta_highlow") and len(teile) == 3:
        zr, art = teile[1][len("highlow"):], teile[2]
        n = _N.get(zr)
        if not n or art not in ("nh", "nl"):
            return None
        def f(k, n=n, art=art, zr=zr):
            reihe = k["h"] if art == "nh" else k["l"]
            if len(reihe) < n:
                if zr != "52w" or len(reihe) < 2:
                    return None
                fenster = reihe                       # wie Finviz: seit dem ersten Handelstag
            else:
                fenster = reihe[-n:]
            return reihe[-1] >= max(fenster) if art == "nh" else reihe[-1] <= min(fenster)
        return f
    if code.startswith("ta_sma") and len(teile) == 3:
        if teile[2] in ("pa", "pb"):
            try:
                n = int(teile[1][3:])
            except ValueError:
                return None
            def f(k, n=n, ueber=teile[2] == "pa"):
                m = _sma(k["c"], n)
                if m is None:
                    return None
                return k["c"][-1] > m if ueber else k["c"][-1] < m
            return f
        if teile[1] == "sma50" and teile[2] in ("cross200a", "cross200b"):
            def f(k, auf=teile[2] == "cross200a"):
                c = k["c"]
                if len(c) < 200 + KREUZ_TAGE:
                    return None
                for i in range(len(c) - KREUZ_TAGE, len(c)):
                    v50, v200 = _sma(c, 50, i - 1), _sma(c, 200, i - 1)
                    j50, j200 = _sma(c, 50, i), _sma(c, 200, i)
                    if auf and v50 <= v200 and j50 > j200:
                        return True
                    if not auf and v50 >= v200 and j50 < j200:
                        return True
                return False
            return f
        return None
    if code.startswith("ta_rsi_") and len(teile) == 3:
        art, grenze = teile[2][:2], teile[2][2:]
        if art not in ("os", "ob") or not grenze.isdigit():
            return None
        def f(k, unter=art == "os", g=int(grenze)):
            r = _rsi(k["c"])
            if r is None:
                return None
            return r < g if unter else r > g
        return f
    if code.startswith("ta_perf_") and len(teile) == 3 and teile[2].endswith(("up", "down")):
        zr = teile[2][:-2] if teile[2].endswith("up") else teile[2][:-4]
        n = _PERF.get(zr)
        if not n:
            return None
        def f(k, n=n, auf=teile[2].endswith("up")):
            c = k["c"]
            if len(c) <= n:
                return None
            return c[-1] > c[-1 - n] if auf else c[-1] < c[-1 - n]
        return f
    return None


# ── Daten ───────────────────────────────────────────────────────────────────────
def _db():
    conn = sqlite3.connect(markt.markt_db(), timeout=30)
    conn.row_factory = sqlite3.Row
    return conn

def _mitglieder(conn, maerkte) -> dict:
    """{ticker: [Markt-IDs]} in der Reihenfolge der Auswahl. Viele MDAX-Werte stehen
    auch im STOXX 600 — gerechnet wird jeder Wert einmal, gezählt in jedem Markt."""
    out = {}
    for uid in maerkte:
        for r in conn.execute("SELECT ticker FROM tagesmitglied WHERE liste=?", (uid,)):
            out.setdefault(r[0], []).append(uid)
    return out

def _fx_usd(conn) -> dict:
    """{Währung: USD je Einheit} aus den Wechselkurs-Paaren des Sammlers."""
    fx = {"USD": 1.0}
    for paar in markt.FX_PAARE:
        r = conn.execute("SELECT close FROM prices WHERE ticker=? ORDER BY date DESC LIMIT 1", (paar,)).fetchone()
        if r and r[0]:
            fx[paar[:3]] = r[0]
    return fx

def _info(conn, sym) -> dict:
    r = conn.execute("SELECT data FROM ticker_info WHERE symbol=?", (sym,)).fetchone()
    try:
        return json.loads(r[0]) if r and r[0] else {}
    except ValueError:
        return {}

def _kerzen(conn, sym):
    rows = conn.execute("SELECT date, high, low, close FROM prices WHERE ticker=? "
                        "ORDER BY date DESC LIMIT ?", (sym, LESE_KERZEN)).fetchall()
    rows = [r for r in reversed(rows) if r["close"] and r["high"] and r["low"]]
    if not rows:
        return None
    return {"d": [r["date"] for r in rows], "h": [r["high"] for r in rows],
            "l": [r["low"] for r in rows], "c": [r["close"] for r in rows]}


def _tage(a: str, b: str) -> int:
    return round((time.mktime(time.strptime(b, "%Y-%m-%d")) - time.mktime(time.strptime(a, "%Y-%m-%d"))) / 86400)


# ── Lauf ────────────────────────────────────────────────────────────────────────
def _lauf(job_id: str, maerkte: list, cap_min, cap_max, unit: str, filters: list,
          blacklist, junge: bool):
    log = lambda m: screener._log(job_id, m)
    try:
        pruefer = [(c, _pruefer(c)) for c in filters]
        namen = {it["code"]: it["label"] for g in screener.FILTERS for it in g["items"]}
        log("═" * 50)
        log(f"  Märkte:   {', '.join(universen.UNIVERSEN[m][0] for m in maerkte)}")
        log(f"  Filter:   {', '.join(namen.get(c, c) for c in filters) or 'keine'}")
        cap_label = "egal (alle)"
        if cap_min is not None or cap_max is not None:
            fmt = lambda v: f"{v / (1e9 if unit == 'Mrd $' else 1e6):g} {unit}" if v else "–"
            cap_label = f"{fmt(cap_min)} bis {fmt(cap_max)}"
        log(f"  MarktCap: {cap_label}")
        if junge:
            log("  Junge Werte: Filter ohne genug Historie werden übersprungen")
        gesperrt = set(blacklist or ())
        if gesperrt:
            log(f"  Blacklist: {len(gesperrt)} Ticker werden ausgeblendet")
        log("═" * 50)

        conn = _db()
        try:
            mitglieder = _mitglieder(conn, maerkte)
            fx = _fx_usd(conn)
            if not mitglieder:
                screener._set(job_id, status="error",
                              error="Für die gewählten Märkte liegen noch keine Mitgliederlisten vor — "
                                    "der Marktdaten-Sammler lädt sie beim ersten Lauf")
                return
            # Stand je Markt: jüngster Kurstag — Maßstab für „veraltet"
            daten, stand = {}, {}
            syms = sorted(mitglieder)
            for i, sym in enumerate(syms):
                k = _kerzen(conn, sym)
                if k:
                    daten[sym] = k
                    for m in mitglieder[sym]:
                        stand[m] = max(stand.get(m, ""), k["d"][-1])
                if i % 250 == 0:
                    screener._set(job_id, progress=0.6 * i / len(syms))
            infos = {sym: _info(conn, sym) for sym in daten}
        finally:
            conn.close()

        log("")
        for m in maerkte:
            n_m = sum(1 for ms in mitglieder.values() if m in ms)
            n_d = sum(1 for s in daten if m in mitglieder[s])
            zeile = f"{universen.UNIVERSEN[m][0]}: Kurse für {n_d} von {n_m} Werten"
            if stand.get(m):
                zeile += f", Stand {stand[m]}"
            log(zeile)
        abdeckung = len(daten) / max(1, len(mitglieder))

        treffer, details = {}, {}
        zaehl = {"veraltet": 0, "keine_aktie": 0, "cap_unbekannt": 0, "cap": 0, "historie": 0}
        heute = time.strftime("%Y-%m-%d")
        for i, (sym, k) in enumerate(daten.items()):
            if i % 250 == 0:
                screener._set(job_id, progress=0.6 + 0.35 * i / max(1, len(daten)))
            m = mitglieder[sym][0]
            if _tage(k["d"][-1], stand[m]) > VERALTET_TAGE:
                zaehl["veraltet"] += 1
                continue
            info = infos.get(sym) or {}
            if info.get("quote_type") not in (None, "EQUITY"):
                zaehl["keine_aktie"] += 1               # ETNs, Fonds, Optionsscheine
                continue
            if cap_min is not None or cap_max is not None:
                cap, ccy = info.get("market_cap"), info.get("currency") or "USD"
                kurs_fx = fx.get(_KLEIN.get(ccy, ccy))
                if not cap or not kurs_fx:
                    zaehl["cap_unbekannt"] += 1
                    continue
                cap_usd = cap * kurs_fx
                if (cap_min is not None and cap_usd < cap_min) or (cap_max is not None and cap_usd > cap_max):
                    zaehl["cap"] += 1
                    continue
            ok, zu_jung = True, False
            for code, f in pruefer:
                erg = f(k)
                if erg is None:
                    zu_jung = True
                    if junge:
                        continue
                    ok = False
                    break
                if not erg:
                    ok = False
                    break
            if not ok:
                if zu_jung and not junge:
                    zaehl["historie"] += 1
                continue
            sektor = info.get("sector")
            sektor = _SEKTOR.get(sektor, sektor) or OHNE_SEKTOR
            treffer.setdefault(sektor, []).append(sym)
            erster = info.get("erster_handel") or k["d"][0]
            alter = _tage(erster, heute) if erster else None
            details[sym] = {"markt": m, "maerkte": mitglieder[sym], "alter_tage": alter,
                            "jung": bool(alter is not None and alter < 365)}

        final = {s: sorted(t) for s, t in sorted(treffer.items())}
        log("")
        for s, t in final.items():
            log(f"  {s}: {len(t)}")
        hinweise = []
        if zaehl["historie"]:
            hinweise.append(f"{zaehl['historie']} junge Werte ohne genug Historie nicht berücksichtigt "
                            f"(„junge Werte prüfen“ nimmt sie mit)")
        if zaehl["cap_unbekannt"]:
            hinweise.append(f"{zaehl['cap_unbekannt']} ohne bekannte Marktkapitalisierung übergangen")
        if zaehl["veraltet"]:
            hinweise.append(f"{zaehl['veraltet']} mit veraltetem Kurs (eingestellt/delistet?) übergangen")
        for h in hinweise:
            log("  · " + h)

        blockiert = []
        if gesperrt:
            final, blockiert = screener.apply_blacklist(final, gesperrt)
            if blockiert:
                log(f"🚫 Blacklist: {len(blockiert)} bereits aussortierte Ticker entfernt")
        details = {s: d for s, d in details.items() if s not in set(blockiert)}

        warnung = None
        if abdeckung < 0.9:
            warnung = (f"Kurse erst für {round(abdeckung * 100)} % der Werte gesammelt — der "
                       f"Marktdaten-Sammler ist noch nicht durch, das Ergebnis ist unvollständig")
            log("⚠ " + warnung)
        log("")
        log("═" * 50)
        log(f"✓ Screening komplett — {sum(len(t) for t in final.values())} Treffer")
        log("═" * 50)
        screener._set(job_id, status="done", results=final, blocked=blockiert, warning=warnung,
                      details=details, progress=1.0)
    except Exception as e:
        screener._set(job_id, status="error", error=f"Screening fehlgeschlagen: {e}")
        log(f"FEHLER: {e}")


def start_job(maerkte: list, cap_min, cap_max, unit: str, filters: list,
              blacklist=None, junge: bool = False) -> str:
    """Wie screener.start_job, nur lokal gerechnet. Unbekannte Filter wirft ValueError."""
    fremd = [c for c in filters if not unterstuetzt(c)]
    if fremd:
        raise ValueError("Diese Filter lassen sich aus Kursen nicht rechnen: " + ", ".join(fremd))
    maerkte = [m for m in maerkte if m in universen.UNIVERSEN]
    if not maerkte:
        raise ValueError("Mindestens einen Markt auswählen")
    screener._gc_old_jobs()
    job_id = uuid.uuid4().hex[:12]
    with screener._jobs_lock:
        screener._jobs[job_id] = {"status": "running", "log": [], "results": {}, "blocked": [],
                                  "error": None, "warning": None, "details": {}, "progress": 0.0,
                                  "created_at": time.time()}
    threading.Thread(target=_lauf, args=(job_id, maerkte, cap_min, cap_max, unit, list(filters),
                                         set(blacklist or ()), bool(junge)), daemon=True).start()
    return job_id
