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
        "fx_realized": {},      # Regel F: realisiertes Fremdwährungsergebnis je Währung in EUR
    }
    from collections import Counter
    years: Counter = Counter()

    sec_eur_label = {
        "Dividenden": "dividends_eur", "Zinsen": "interest_eur", "Quellensteuer": "withholding_eur",
    }
    # Realisierte Performance: IBKR rechnet das Fremdwährungs-Ergebnis (Regel F) mit
    # vollständiger Historie selbst in Basis-EUR. Wir lesen "Realisiert Gesamt" je Devisen-Währung.
    _REAL_SEC = "Übersicht  zur realisierten und unrealisierten Performance"  # doppeltes Leerzeichen!
    _realhdr = None

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
                "proceeds": _num(r[10]) or 0.0,  # Erlös (enthält bei Futures den Multiplikator)
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

        # Regel F: realisiertes Fremdwährungsergebnis aus der Performance-Übersicht
        if sec == _REAL_SEC:
            if typ == "Header":
                _realhdr = {name.strip(): i for i, name in enumerate(r)}
            elif typ == "Data" and _realhdr:
                ci = _realhdr.get("Vermögenswertkategorie")
                si = _realhdr.get("Symbol")
                gi = _realhdr.get("Realisiert Gesamt")
                if (ci is not None and gi is not None and ci < len(r)
                        and r[ci].strip() == "Devisen"):
                    cur = r[si].strip() if (si is not None and si < len(r)) else ""
                    val = _num(r[gi]) if gi < len(r) else None
                    if cur and val is not None:
                        out["fx_realized"][cur] = out["fx_realized"].get(cur, 0.0) + val
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

    # Realisierte Ergebnisse je VERKAUFSJAHR sammeln (ein FIFO-Durchlauf für alle Jahre)
    def _ybucket():
        return {"aktien_gewinn": 0.0, "aktien_verlust": 0.0,
                "futures_gewinn": 0.0, "futures_verlust": 0.0,
                "sonstige_gewinn": 0.0, "sonstige_verlust": 0.0}
    peryear = _dd(_ybucket)
    # Nachweis je (Jahr, Symbol) — Summe ergibt die Topf-Werte (Z.20/23/22)
    pos = _dd(lambda: {"cat": "", "gewinn": 0.0, "verlust": 0.0})
    journal = []   # prüffähiges FIFO-Journal: jede Zuordnung mit Kauf/Verkauf-Bein, FX, EUR

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
            q, d, cur = e["qty"], e["date"], e["currency"]
            # Futures: effektiver Preis = Erlös/Menge (enthält den Kontrakt-Multiplikator);
            # sonst der normale Stückkurs. Beides läuft durch dasselbe FIFO + EUR pro Bein.
            if cat == "Futures" and q:
                price = abs(e["proceeds"] / q)
            else:
                price = e["price"]
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
                    if lot[0] > 0:   # long: Kauf=Lot (bdate), Verkauf=Trade (d)
                        fx_kauf, fx_verk = fx_to_eur(bcur, bdate), fx_to_eur(cur, d)
                        kauf_d, kauf_kurs, verk_d, verk_kurs = bdate, bprice, d, price
                        cost     = (match * bprice - bcpu * match) * fx_kauf
                        proceeds = (match * price + cpu * match) * fx_verk
                    else:            # short: Verkauf=Lot (bdate), Rückkauf/Anschaffung=Trade (d)
                        fx_kauf, fx_verk = fx_to_eur(cur, d), fx_to_eur(bcur, bdate)
                        kauf_d, kauf_kurs, verk_d, verk_kurs = d, price, bdate, bprice
                        cost     = (match * price - cpu * match) * fx_kauf
                        proceeds = (match * bprice + bcpu * match) * fx_verk
                    realized = proceeds - cost
                except Exception:
                    realized = None
                if realized is not None:
                    by = peryear[d[:4]]
                    p  = pos[(d[:4], sym)]
                    p["cat"] = "Aktien" if is_aktie else ("Futures" if cat == "Futures" else "Sonstige")
                    if realized >= 0: p["gewinn"] += realized
                    else: p["verlust"] += -realized
                    journal.append({
                        "year": d[:4], "symbol": sym, "category": p["cat"], "waehrung": cur,
                        "menge": round(match, 4), "short": lot[0] < 0,
                        "kauf_datum": kauf_d, "kauf_kurs": round(kauf_kurs, 4), "fx_kauf": round(fx_kauf, 5),
                        "anschaffung_eur": round(cost, 2),
                        "verkauf_datum": verk_d, "verkauf_kurs": round(verk_kurs, 4), "fx_verkauf": round(fx_verk, 5),
                        "erloes_eur": round(proceeds, 2),
                        "gewinn_eur": round(realized, 2),
                    })
                    if is_aktie:
                        if realized >= 0: by["aktien_gewinn"] += realized
                        else: by["aktien_verlust"] += -realized
                    elif cat == "Futures":
                        if realized >= 0: by["futures_gewinn"] += realized
                        else: by["futures_verlust"] += -realized
                    else:
                        if realized >= 0: by["sonstige_gewinn"] += realized
                        else: by["sonstige_verlust"] += -realized
                lot[0] += (match if lot[0] < 0 else -match)
                rem    += (match if rem < 0 else -match)
                if abs(lot[0]) < 1e-9: lots.pop(0)
            if abs(rem) > 1e-9:
                lots.append([rem, price, cpu, d, cur])

    g = lambda x: round(x, 2)
    income_by_year = {f["year"]: f for f in files if f["year"]}

    def _year_result(yr: str) -> dict:
        by = peryear.get(yr, _ybucket())
        fy = income_by_year.get(yr)
        dividends   = fy["dividends_eur"] if fy else 0.0
        interest    = fy["interest_eur"]  if fy else 0.0
        withholding = abs(fy["withholding_eur"]) if fy else 0.0
        div_de      = fy["div_de_eur"]    if fy else 0.0
        # Ausländische Kapitalerträge (Z.19): ausl. Erträge + realisierte Netto-Ergebnisse
        kap_foreign = g(dividends - div_de + interest
                        + by["aktien_gewinn"] - by["aktien_verlust"]
                        + by["futures_gewinn"] - by["futures_verlust"]
                        + by["sonstige_gewinn"] - by["sonstige_verlust"])
        # Nachweis je Position (Summe = Topf-Werte)
        _catord = {"Aktien": 0, "Futures": 1, "Sonstige": 2}
        positions = sorted(
            [{"symbol": s, "category": p["cat"],
              "gewinn": g(p["gewinn"]), "verlust": g(p["verlust"]),
              "net": g(p["gewinn"] - p["verlust"])}
             for (y, s), p in pos.items() if y == yr],
            key=lambda x: (_catord.get(x["category"], 9), -x["net"]))

        # Prüffähiges FIFO-Journal des Jahres (Aktien/Futures je Zuordnung)
        jrnl = sorted([j for j in journal if j["year"] == yr],
                      key=lambda j: (_catord.get(j["category"], 9), j["verkauf_datum"], j["symbol"]))

        # ── §20-Verlustverrechnungstöpfe + Steuer (Phase 2) ──────────────────
        # OHNE Sparer-Pauschbetrag (macht das Finanzamt), ohne KiSt, ohne Günstigerprüfung.
        # Fremdwährung (Regel F): IBKRs realisiertes Devisen-Ergebnis (Basis-EUR) → allg. Topf.
        fx_detail   = (fy["fx_realized"] if fy else {}) or {}
        waehrung_net = sum(fx_detail.values())                    # Regel F: realisiertes FX-Ergebnis
        ak_net   = by["aktien_gewinn"] - by["aktien_verlust"]      # Aktien-Topf (§20(6)S.4)
        fut_net  = by["futures_gewinn"] - by["futures_verlust"]    # Termingeschäfte (kein 20k-Limit)
        son_net  = by["sonstige_gewinn"] - by["sonstige_verlust"]
        allg_net = fut_net + son_net + dividends + interest + waehrung_net   # allgemeiner Topf
        ak_steuerbar   = max(0.0, ak_net)
        allg_steuerbar = max(0.0, allg_net)
        base   = ak_steuerbar + allg_steuerbar                     # Bemessungsgrundlage (vor Pauschbetrag)
        abgelt = base * 0.25
        soli   = abgelt * 0.055
        steuer_brutto = abgelt + soli
        # Anrechenbare ausl. Quellensteuer: max. DBA-Satz 15% der ausl. Dividenden, max. bis zur Steuer
        qst_anrechenbar = min(withholding, 0.15 * max(0.0, dividends), steuer_brutto)
        steuer_netto = max(0.0, steuer_brutto - qst_anrechenbar)
        tax = {
            "aktien_topf":       {"gewinn": g(by["aktien_gewinn"]), "verlust": g(by["aktien_verlust"]),
                                   "netto": g(ak_net), "steuerbar": g(ak_steuerbar),
                                   "verlustvortrag": g(max(0.0, -ak_net))},
            "allg_topf":         {"termingeschaefte": g(fut_net), "dividenden": g(dividends),
                                   "zinsen": g(interest), "sonstige": g(son_net),
                                   "waehrung_detail": {c: g(v) for c, v in fx_detail.items()},
                                   "waehrung": g(waehrung_net),  # Regel F (IBKR-Realisierung)
                                   "netto": g(allg_net), "steuerbar": g(allg_steuerbar),
                                   "verlustvortrag": g(max(0.0, -allg_net))},
            "bemessungsgrundlage": g(base),
            "abgeltungsteuer":   g(abgelt),
            "soli":              g(soli),
            "steuer_brutto":     g(steuer_brutto),
            "qst_anrechenbar":   g(qst_anrechenbar),
            "steuer_netto":      g(steuer_netto),
        }
        return {
            "year": yr,
            "positions": positions,
            "journal": jrnl,
            "line7_inland_abgeltung": g(div_de),                       # mit dt. Steuerabzug
            "line18_inland": None,                                     # nicht zuverlässig berechenbar
            "line19_foreign": kap_foreign,
            "line20_aktien_gewinn": g(by["aktien_gewinn"]),
            "line22_sonstige_verlust": g(by["futures_verlust"] + by["sonstige_verlust"]),
            "line23_aktien_verlust": g(by["aktien_verlust"]),
            "aktien_gewinn": g(by["aktien_gewinn"]), "aktien_verlust": g(by["aktien_verlust"]),
            "futures_gewinn": g(by["futures_gewinn"]), "futures_verlust": g(by["futures_verlust"]),
            "sonstige_gewinn": g(by["sonstige_gewinn"]), "sonstige_verlust": g(by["sonstige_verlust"]),
            "dividends_eur": g(dividends),
            "interest_eur": g(interest),
            "withholding_eur": g(withholding),
            "tax": tax,
        }

    avail = sorted(set(list(peryear.keys()) + list(income_by_year.keys())))
    years = {y: _year_result(y) for y in avail}
    default_year = target_year if (target_year in years) else (avail[-1] if avail else None)

    return {
        "year": default_year,
        "available_years": avail,
        "files_years": [f["year"] for f in files],
        "years": years,
        **(years.get(default_year, {})),   # Default-Jahr flach für Abwärtskompatibilität
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
