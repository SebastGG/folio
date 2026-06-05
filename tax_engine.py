"""
tax_engine.py — Deutsche Kapitalertrags-Berechnung aus IBKR Activity CSV
========================================================================
Eigenständige Berechnung (nicht das levino-Tool, das nur Dividenden/Zinsen macht):
FIFO über die komplette Trade-Historie mit Währungsumrechnung pro Bein zum
jeweiligen Handelstag (deutsche Methode), aufgeteilt in Aktien-Topf und Sonstiges.

Stufen (jede einzeln testbar):
  1. FX-Provider  — ECB-Referenzkurse (Frankfurter-API), Datei-Cache, Forward-Fill
  2. Parser       — Transaktionen/Dividenden/Zinsen/Quellensteuer aus dem CSV
  3. FIFO-Engine  — realisierte Gewinne/Verluste je Position in EUR
  4. KAP-Mapping  — Zeilen 18/19/20/22/23

FX-Konvention: fx_to_eur(currency, date) = EUR pro 1 Einheit <currency>.
"""

import os
import json
import bisect
import threading
import urllib.request

# ── Stufe 1: FX-Provider (ECB via Frankfurter) ──────────────────────────────────

_FX_LOCK = threading.Lock()
_FX_RATES: dict[str, dict[str, float]] = {}   # currency -> {date: eur_per_unit}
_FX_SORTED: dict[str, list[str]] = {}         # currency -> sortierte Datumsliste

_FX_API = "https://api.frankfurter.dev/v1"


def _fx_cache_path(cache_dir: str, currency: str) -> str:
    return os.path.join(cache_dir, f"fx_{currency}_EUR.json")


def _fetch_fx_range(currency: str, start: str, end: str) -> dict[str, float]:
    """Holt tägliche ECB-Kurse currency→EUR für [start, end]."""
    url = f"{_FX_API}/{start}..{end}?base={currency}&symbols=EUR"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read())
    return {d: float(v["EUR"]) for d, v in (data.get("rates") or {}).items() if "EUR" in v}


def load_fx(currency: str, start: str, end: str, cache_dir: str | None = None) -> None:
    """
    Lädt FX-Kurse currency→EUR für den Zeitraum in den Speicher.
    Nutzt — falls cache_dir gesetzt — einen persistenten Datei-Cache, da historische
    Kurse unveränderlich sind.
    """
    if currency in ("EUR", "GBp", "GBX"):
        return
    with _FX_LOCK:
        if currency in _FX_RATES and _FX_RATES[currency]:
            # Cache deckt Zeitraum? (grobe Prüfung über min/max)
            have = _FX_SORTED[currency]
            if have and have[0] <= start and have[-1] >= end:
                return

        rates: dict[str, float] = {}
        cache_file = _fx_cache_path(cache_dir, currency) if cache_dir else None
        if cache_file and os.path.exists(cache_file):
            try:
                with open(cache_file) as f:
                    rates = json.load(f)
            except Exception:
                rates = {}

        need = (not rates) or (min(rates) > start) or (max(rates) < end)
        if need:
            fetched = _fetch_fx_range(currency, start, end)
            rates.update(fetched)
            if cache_file:
                try:
                    with open(cache_file, "w") as f:
                        json.dump(rates, f)
                except Exception:
                    pass

        _FX_RATES[currency] = rates
        _FX_SORTED[currency] = sorted(rates.keys())


def fx_to_eur(currency: str, date: str) -> float:
    """
    EUR pro 1 Einheit <currency> am <date> (YYYY-MM-DD).
    Forward-Fill: an Wochenenden/Feiertagen gilt der letzte Handelstag davor.
    GBp/GBX (Pence) = GBP/100.
    """
    if currency == "EUR":
        return 1.0
    if currency in ("GBp", "GBX"):
        return fx_to_eur("GBP", date) / 100.0

    rates = _FX_RATES.get(currency)
    if not rates:
        raise ValueError(f"FX für {currency} nicht geladen — load_fx() zuerst aufrufen")
    if date in rates:
        return rates[date]
    sd = _FX_SORTED[currency]
    i = bisect.bisect_right(sd, date) - 1   # jüngster Handelstag <= date
    if i >= 0:
        return rates[sd[i]]
    return rates[sd[0]]   # vor erstem verfügbaren Kurs → ersten nehmen


# ── Stufe 2: Parser (eine CSV-Datei → strukturierte Sektionen) ──────────────────

import csv as _csv
import re as _re
from collections import defaultdict as _dd


def _num(s):
    s = (s or "").strip().replace('"', "").replace(",", "")
    try:
        return float(s)
    except ValueError:
        return None


def parse_file(text: str) -> dict:
    """Parst eine IBKR-Activity-CSV (deutsch) in Trades, Kapitalmaßnahmen und Erträge."""
    out = {
        "year": None,
        "trades": [],          # {date, qty, price, comm, currency, category, symbol}
        "corp_actions": [],     # {date, symbol, ratio}  (nur Splits)
        "dividends_eur": 0.0, "interest_eur": 0.0, "withholding_eur": 0.0,
        "div_de_eur": 0.0,      # näherungsweise inländisch (DE-ISIN), EUR
    }
    from collections import Counter
    years: Counter = Counter()

    sec_eur_label = {
        "Dividenden": "dividends_eur", "Zinsen": "interest_eur", "Quellensteuer": "withholding_eur",
    }

    for r in _csv.reader(text.splitlines()):
        if len(r) < 3:
            continue
        sec, typ = r[0].strip(), r[1].strip()

        # Zeitraum/Jahr aus dem Statement
        if sec == "Statement" and typ == "Data" and len(r) > 3 and r[2].strip() in ("Zeitraum", "Period"):
            m = _re.search(r"(\d{4})", r[3])
            if m:
                out["year"] = m.group(1)
            continue

        # Trades
        if sec == "Transaktionen" and typ == "Data" and len(r) > 13 and r[2].strip() == "Order":
            qty, price, comm = _num(r[7]), _num(r[8]), _num(r[11])
            if qty is None or price is None:
                continue
            date = r[6].strip().strip('"')[:10]
            out["trades"].append({
                "date": date, "qty": qty, "price": price, "comm": comm or 0.0,
                "currency": r[4].strip(), "category": r[3].strip(), "symbol": r[5].strip(),
                "realguv": _num(r[13]) or 0.0,   # IBKRs realisierter G&V (Handelswährung)
            })
            if len(date) >= 4:
                years[date[:4]] += 1
            continue

        # Kapitalmaßnahmen — Splits
        if sec == "Kapitalmaßnahmen" and typ == "Data" and len(r) > 7:
            m = _re.search(r"Split\s+([\d.]+)\s+für\s+([\d.]+)", r[6])
            if m:
                out["corp_actions"].append({
                    "date": r[5].strip()[:10],
                    "symbol": r[6].split("(")[0].strip(),
                    "ratio": float(m.group(1)) / float(m.group(2)),
                })
            continue

        # Erträge: EUR-Gesamtzeilen je Sektion
        key = sec_eur_label.get(sec)
        if key and typ == "Data" and len(r) >= 6:
            col2 = r[2].strip()
            betrag = _num(r[5])
            if betrag is None:
                continue
            if col2.startswith("Gesamt ") and col2.endswith(" in EUR"):
                out[key] += betrag
            # inländische Dividenden näherungsweise: EUR-Einzelposten mit DE-ISIN
            elif sec == "Dividenden" and 2 <= len(col2) <= 4 and col2.isalpha():
                if "(DE" in (r[4] if len(r) > 4 else ""):
                    # nativ EUR? nur wenn Währung EUR
                    if col2 == "EUR":
                        out["div_de_eur"] += betrag
            continue

    if not out["year"] and years:
        out["year"] = years.most_common(1)[0][0]
    return out


# ── Stufe 3+4: FIFO + FX + KAP-Mapping ──────────────────────────────────────────

# Kategorien, die als Aktien-Topf zählen (Z.20 Gewinne / Z.23 Verluste)
_AKTIEN_CATS = {"Aktien", "Stocks"}
# Forex zählt NICHT als §20-Veräußerungsgeschäft
_FOREX_CATS = {"Devisen", "Forex"}


def compute_tax_report(csv_texts: list[str], target_year: str | None = None,
                       cache_dir: str | None = None) -> dict:
    """
    Berechnet die Anlage-KAP-relevanten Werte für ein Steuerjahr aus der
    kompletten Trade-Historie (mehrere CSVs). FIFO + Split-Anpassung + FX pro Bein.
    """
    files = [parse_file(t) for t in csv_texts]
    if not target_year:
        target_year = max((f["year"] for f in files if f["year"]), default=None)

    # Trades + Splits über alle Dateien zusammenführen, je Symbol
    events = _dd(list)
    fx_currencies = set()
    for f in files:
        for t in f["trades"]:
            events[t["symbol"]].append({"t": "trade", **t})
            if t["category"] not in _FOREX_CATS:
                fx_currencies.add(t["currency"])
        for ca in f["corp_actions"]:
            events[ca["symbol"]].append({"t": "split", **ca})

    # FX laden (alle relevanten Währungen, ganzer Zeitraum)
    all_dates = [e["date"] for evs in events.values() for e in evs if e.get("date")]
    if all_dates:
        lo, hi = min(all_dates), max(all_dates)
        for c in fx_currencies:
            try:
                load_fx(c, lo, hi, cache_dir=cache_dir)
            except Exception as e:
                print(f"[tax] FX laden {c} fehlgeschlagen: {e}")

    res = {
        "aktien_gewinn": 0.0, "aktien_verlust": 0.0,        # Z.20 / Z.23
        "sonstige_gewinn": 0.0, "sonstige_verlust": 0.0,    # Z.22 (Verluste) u.a.
        "futures_gewinn": 0.0, "futures_verlust": 0.0,      # Termingeschäfte (separat)
        "warnings": [],
    }

    for sym, evs in events.items():
        evs = sorted(evs, key=lambda e: (e["date"], 0 if e["t"] == "split" else 1))
        lots = []   # [qty, price, comm_per_unit, date, currency]
        for e in evs:
            if e["t"] == "split":
                for lot in lots:
                    lot[0] *= e["ratio"]; lot[1] /= e["ratio"]; lot[2] /= e["ratio"]
                continue
            cat = e["category"]
            if cat in _FOREX_CATS:
                continue  # Forex: kein §20-Veräußerungsgeschäft
            # Futures (Termingeschäfte): IBKRs realisierten G&V nutzen (Multiplikator/MTM),
            # in EUR zum Handelstag. Kein FIFO (Kontraktbuchung).
            if cat == "Futures":
                if e["date"][:4] == target_year and e.get("realguv"):
                    try:
                        eur = e["realguv"] * fx_to_eur(e["currency"], e["date"])
                    except Exception:
                        eur = 0.0
                    if eur >= 0: res["futures_gewinn"] += eur
                    else: res["futures_verlust"] += -eur
                continue
            q, price, d, cur = e["qty"], e["price"], e["date"], e["currency"]
            cpu = (e["comm"] / abs(q)) if q else 0.0
            if not lots or (lots[-1][0] > 0) == (q > 0):
                lots.append([q, price, cpu, d, cur])
                continue
            rem = q
            while lots and abs(rem) > 1e-9 and (lots[0][0] > 0) != (rem > 0):
                lot = lots[0]; match = min(abs(lot[0]), abs(rem))
                bprice, bcpu, bdate, bcur = lot[1], lot[2], lot[3], lot[4]
                is_aktie = cat in _AKTIEN_CATS
                try:
                    if lot[0] > 0:   # long verkauft
                        proceeds = (match * price + cpu * match) * fx_to_eur(cur, d)
                        cost     = (match * bprice - bcpu * match) * fx_to_eur(bcur, bdate)
                        realized = proceeds - cost
                    else:            # short zurückgekauft
                        proceeds = (match * bprice + bcpu * match) * fx_to_eur(bcur, bdate)
                        cost     = (match * price - cpu * match) * fx_to_eur(cur, d)
                        realized = proceeds - cost
                except Exception:
                    realized = None
                if realized is not None and d[:4] == target_year:
                    if is_aktie:
                        if realized >= 0: res["aktien_gewinn"] += realized
                        else: res["aktien_verlust"] += -realized
                    else:
                        if realized >= 0: res["sonstige_gewinn"] += realized
                        else: res["sonstige_verlust"] += -realized
                lot[0] += (match if lot[0] < 0 else -match)
                rem    += (match if rem < 0 else -match)
                if abs(lot[0]) < 1e-9: lots.pop(0)
            if abs(rem) > 1e-9:
                lots.append([rem, price, cpu, d, cur])

    # Erträge des Zieljahres
    tfile = next((f for f in files if f["year"] == target_year), None)
    dividends = tfile["dividends_eur"] if tfile else 0.0
    interest  = tfile["interest_eur"] if tfile else 0.0
    withholding = abs(tfile["withholding_eur"]) if tfile else 0.0
    div_de    = tfile["div_de_eur"] if tfile else 0.0

    g = lambda x: round(x, 2)
    aktien_gewinn = g(res["aktien_gewinn"]); aktien_verlust = g(res["aktien_verlust"])
    futures_gewinn = g(res["futures_gewinn"]); futures_verlust = g(res["futures_verlust"])
    sonstige_gewinn = g(res["sonstige_gewinn"]); sonstige_verlust = g(res["sonstige_verlust"])
    # Ausländische Kapitalerträge (Z.19): Erträge + realisierte Netto-Ergebnisse (vereinfacht)
    kap_foreign = g(dividends - div_de + interest
                    + res["aktien_gewinn"] - res["aktien_verlust"]
                    + res["futures_gewinn"] - res["futures_verlust"]
                    + res["sonstige_gewinn"] - res["sonstige_verlust"])

    return {
        "year": target_year,
        "line18_inland": g(div_de),
        "line19_foreign": kap_foreign,
        "line20_aktien_gewinn": aktien_gewinn,
        "line22_sonstige_verlust": sonstige_verlust,
        "line23_aktien_verlust": aktien_verlust,
        "aktien_gewinn": aktien_gewinn, "aktien_verlust": aktien_verlust,
        "futures_gewinn": futures_gewinn, "futures_verlust": futures_verlust,
        "sonstige_gewinn": sonstige_gewinn, "sonstige_verlust": sonstige_verlust,
        "dividends_eur": g(dividends),
        "interest_eur": g(interest),
        "withholding_eur": g(withholding),
        "files_years": [f["year"] for f in files],
    }


# ── Selbsttest ──────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    load_fx("USD", "2025-01-01", "2025-01-31")
    load_fx("GBP", "2025-01-01", "2025-03-31")
    assert abs(fx_to_eur("USD", "2025-01-16") - 0.97352) < 1e-6, "USD 16.01 falsch"
    # 2025-01-18 = Samstag → Forward-Fill von Fr 17.01 (0.97106)
    assert abs(fx_to_eur("USD", "2025-01-18") - 0.97106) < 1e-6, "Forward-Fill falsch"
    assert fx_to_eur("EUR", "2025-06-01") == 1.0
    # GBp = GBP/100
    g = fx_to_eur("GBP", "2025-03-17")
    assert abs(fx_to_eur("GBp", "2025-03-17") - g / 100.0) < 1e-12
    print("FX-Provider OK:")
    print(f"  USD 2025-01-16 = {fx_to_eur('USD','2025-01-16')} EUR")
    print(f"  USD 2025-01-18 (Sa, Forward-Fill) = {fx_to_eur('USD','2025-01-18')} EUR")
    print(f"  GBP 2025-03-17 = {fx_to_eur('GBP','2025-03-17')} EUR")
