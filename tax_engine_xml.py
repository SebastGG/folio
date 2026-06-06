"""
tax_engine_xml.py — Deutsche Kapitalertrags-Berechnung aus IBKR Flex *XML*
=========================================================================
Datenquelle für die Seite „Steuer ++". Im Gegensatz zu tax_engine.py (CSV,
eigenes FIFO) nutzt dieses Modul IBKRs *autoritatives Lot-Matching* aus der
Flex-Query (Detailgrad „Closed Lots") und rechnet nur noch die EUR-Umrechnung
pro Bein selbst (EZB-Referenzkurse). Damit entfallen die FIFO-/Split-/Spinoff-
Fehlerquellen der CSV-Engine — IBKR liefert je geschlossenem Lot:

  <Lot>          Aktien/Futures: cost (Anschaffung inkl. Kaufprovision, Handels-
                 währung, split-bereinigt) + fifoPnlRealized (realisierte G/V in
                 Handelswährung, netto aller Provisionen) + openDateTime (echter
                 Kauf) + tradeDate (Verkauf) + isin/subCategory/issuerCountryCode.
  <FxClosedLot>  Devisen (Regel F): realizedPL bereits in Basis-EUR.
  <CashTransaction>  Dividenden / PIL / Zinsen / Quellensteuer, je Einzelposten.

Kern-Formel je Lot (volle Halteperiode, deutsche Pro-Bein-Methode):
  Verkaufserlös (Handelswährung, netto) = cost + fifoPnlRealized
  Gewinn_EUR = Erlös · EZB(Verkaufstag) − Anschaffung · EZB(Kauftag)

EZB bleibt maßgeblich (Finanzamt); IBKRs Handelskurse fließen NICHT in die
Steuerzahl ein (nur Devisen-Regel-F nutzt IBKRs realizedPL, da rein FX).
"""

import xml.etree.ElementTree as _ET
from collections import defaultdict as _dd

import tax_engine  # FX-Provider wiederverwenden: load_fx(), fx_to_eur()


# ── Helfer ───────────────────────────────────────────────────────────────────────

def _date(s: str | None) -> str:
    """'2025-01-27 11:34:06' | '20250127;113406' | '20250127' → '2025-01-27'."""
    if not s:
        return ""
    s = s.strip()
    head = s.replace("T", " ").split(" ")[0].split(";")[0]
    if "-" in head:
        return head[:10]
    digits = "".join(ch for ch in head if ch.isdigit())
    if len(digits) >= 8:
        return f"{digits[0:4]}-{digits[4:6]}-{digits[6:8]}"
    return head


def _f(s):
    if s is None or s == "":
        return None
    try:
        return float(str(s).replace(",", ""))
    except ValueError:
        return None


# Aktien-Topf (§20 Abs. 6 S.4): nur echte Aktien. Fonds/ETF → allgemeiner Topf.
_AKTIEN_SUB = {"COMMON", "ADR", "PREFERRED", "PREFERREDSTOCK", "REIT"}


def _classify(asset: str, sub: str) -> str:
    asset = (asset or "").upper()
    sub = (sub or "").upper()
    if asset == "STK":
        if sub in ("ETF", "FUND", "MF", "CLOSED-END FUND", "ETN"):
            return "Fonds"
        return "Aktien"
    if asset in ("FUT", "FOP", "CFD", "OPT"):
        return "Futures"   # Termingeschäfte (allg. Topf, kein 20k-Limit ab JStG 2024)
    return "Sonstige"


# ── Parser: eine XML-Datei → strukturierte Posten ────────────────────────────────

def parse_xml_file(text: str) -> dict:
    """Parst ein IBKR Flex-XML in geschlossene Lots, Devisen-Lots und Cash-Erträge."""
    out = {
        "statement_years": [],   # Jahre laut FlexStatement-Zeitraum
        "lots": [],              # Aktien/Futures: geschlossene Lots
        "fx_lots": [],           # Devisen (Regel F)
        "cash": [],              # Dividenden/Zinsen/Quellensteuer/Gebühren
    }
    try:
        root = _ET.fromstring(text)
    except _ET.ParseError as e:
        raise ValueError(f"XML nicht parsebar: {e}")

    for stmt in root.iter("FlexStatement"):
        fd = stmt.get("fromDate") or ""
        y = _date(fd)[:4]
        if y:
            out["statement_years"].append(y)

    # Aktien/Futures — geschlossene Lots (autoritatives IBKR-FIFO-Matching)
    for lot in root.iter("Lot"):
        if lot.get("levelOfDetail") != "CLOSED_LOT":
            continue
        qty = _f(lot.get("quantity"))
        cost = _f(lot.get("cost"))
        pnl = _f(lot.get("fifoPnlRealized"))
        if qty is None or cost is None or pnl is None or qty == 0:
            continue
        out["lots"].append({
            "symbol": lot.get("symbol", ""),
            "isin": lot.get("isin", ""),
            "asset": lot.get("assetCategory", ""),
            "sub": lot.get("subCategory", ""),
            "country": lot.get("issuerCountryCode", ""),
            "currency": lot.get("currency", "EUR"),
            "qty": qty,
            "mult": _f(lot.get("multiplier")) or 1.0,
            "cost_local": cost,            # Handelswährung, inkl. Kaufprovision (signiert)
            "pnl_local": pnl,              # realisierte G/V, Handelswährung, netto
            "open_date": _date(lot.get("openDateTime")),
            "close_date": _date(lot.get("tradeDate") or lot.get("dateTime")),
        })

    # Devisen — Regel F (realizedPL bereits in functionalCurrency = EUR)
    for fx in root.iter("FxClosedLot"):
        pl = _f(fx.get("realizedPL"))
        if pl is None:
            continue
        out["fx_lots"].append({
            "currency": fx.get("fxCurrency", ""),
            "date": _date(fx.get("dateTime") or fx.get("reportDate")),
            "qty": _f(fx.get("quantity")),
            "proceeds": _f(fx.get("proceeds")),
            "cost": _f(fx.get("cost")),
            "realized_eur": pl,
            "desc": fx.get("activityDescription", ""),
            "func_ccy": fx.get("functionalCurrency", "EUR"),
        })

    # Erträge — Dividenden / PIL / Zinsen / Quellensteuer / Gebühren
    for ct in root.iter("CashTransaction"):
        amt = _f(ct.get("amount"))
        if amt is None:
            continue
        out["cash"].append({
            "type": ct.get("type", ""),
            "symbol": ct.get("symbol", ""),
            "isin": ct.get("isin", ""),
            "country": ct.get("issuerCountryCode", ""),
            "currency": ct.get("currency", "EUR"),
            "amount_local": amt,
            "date": _date(ct.get("dateTime") or ct.get("settleDate") or ct.get("reportDate")),
            "desc": ct.get("description", ""),
        })

    return out


# ── Klassifikation der Cash-Typen ─────────────────────────────────────────────────

_DIV_TYPES = {"Dividends", "Payment In Lieu Of Dividends"}
_INT_RECV = {"Broker Interest Received"}
_INT_PAID = {"Broker Interest Paid"}
_FEE_TYPES = {"Other Fees", "Commission Adjustments"}
_WH_TYPES = {"Withholding Tax"}


# ── Berechnung ────────────────────────────────────────────────────────────────────

def compute_tax_report_xml(xml_texts: list[str], target_year: str | None = None,
                           cache_dir: str | None = None) -> dict:
    """
    Berechnet die Anlage-KAP-relevanten Werte je Steuerjahr aus IBKR Flex-XMLs.
    EZB-Umrechnung pro Bein; IBKR-Lot-Matching als Grundlage. Stateless.
    """
    files = [parse_xml_file(t) for t in xml_texts]

    lots, fx_lots, cash = [], [], []
    seen_fx = set()
    for f in files:
        lots.extend(f["lots"])
        cash.extend(f["cash"])
        for x in f["fx_lots"]:
            # Devisen-Lot kann (Settlement) in zwei Jahres-Files auftauchen → dedupe
            k = (x["currency"], x["date"], x["qty"], x["realized_eur"], x["desc"])
            if k in seen_fx:
                continue
            seen_fx.add(k)
            fx_lots.append(x)

    # FX-Kurse laden (alle Nicht-EUR-Währungen, ganzer Zeitraum)
    dates = ([l["open_date"] for l in lots] + [l["close_date"] for l in lots]
             + [c["date"] for c in cash])
    dates = [d for d in dates if d]
    if dates:
        lo, hi = min(dates), max(dates)
        ccys = {l["currency"] for l in lots} | {c["currency"] for c in cash}
        for c in ccys:
            try:
                tax_engine.load_fx(c, lo, hi, cache_dir=cache_dir)
            except Exception as e:
                print(f"[tax_xml] FX {c} laden fehlgeschlagen: {e}")

    fx = tax_engine.fx_to_eur

    # ── je Lot: deutsche EUR-G/V (volle Halteperiode, Pro-Bein-EZB) ───────────────
    journal = []
    for l in lots:
        ccy, qty, mult = l["currency"], l["qty"], l["mult"]
        cost_local, pnl_local = l["cost_local"], l["pnl_local"]
        absnotional = abs(cost_local)
        units = abs(qty) * mult
        try:
            if qty > 0:   # Long: Kauf bei open, Verkauf bei close
                cost_eur = absnotional * fx(ccy, l["open_date"])
                proceeds_local = absnotional + pnl_local
                proceeds_eur = proceeds_local * fx(ccy, l["close_date"])
                kauf_d, verk_d = l["open_date"], l["close_date"]
                kauf_local, verk_local = absnotional, proceeds_local
            else:         # Short: Verkauf bei open, Rückkauf bei close
                proceeds_eur = absnotional * fx(ccy, l["open_date"])
                cost_local = absnotional - pnl_local
                cost_eur = cost_local * fx(ccy, l["close_date"])
                kauf_d, verk_d = l["close_date"], l["open_date"]
                kauf_local, verk_local = cost_local, absnotional
        except Exception as e:
            print(f"[tax_xml] FX fehlend für {l['symbol']} {ccy}: {e}")
            continue
        gain_eur = proceeds_eur - cost_eur
        cat = _classify(l["asset"], l["sub"])
        journal.append({
            "year": l["close_date"][:4],
            "symbol": l["symbol"], "isin": l["isin"], "category": cat,
            "currency": ccy, "menge": round(abs(qty), 4), "short": qty < 0,
            "kauf_datum": kauf_d, "verkauf_datum": verk_d,
            "kauf_kurs": round(kauf_local / units, 4) if units else None,
            "verkauf_kurs": round(verk_local / units, 4) if units else None,
            "fx_kauf": round(fx(ccy, kauf_d), 5),
            "fx_verkauf": round(fx(ccy, verk_d), 5),
            "anschaffung_eur": round(cost_eur, 2),
            "erloes_eur": round(proceeds_eur, 2),
            "gewinn_eur": round(gain_eur, 2),
            "ibkr_pnl_local": round(pnl_local, 2),   # IBKR-Gegencheck (Handelswährung)
        })

    # ── Erträge je Jahr (EZB-Umrechnung am Zuflusstag) ────────────────────────────
    income = _dd(lambda: {
        "dividends": 0.0, "div_de": 0.0, "interest": 0.0, "interest_paid": 0.0,
        "fees": 0.0, "withholding": 0.0, "withholding_de": 0.0,
        "detail": [],
    })
    for c in cash:
        y = c["date"][:4]
        if not y:
            continue
        ccy = c["currency"]
        try:
            rate = fx(ccy, c["date"])
        except Exception:
            rate = 1.0
        eur = c["amount_local"] * rate
        is_de = (c["country"] or "").upper() == "DE"
        t = c["type"]
        bucket = None
        if t in _DIV_TYPES:
            income[y]["dividends"] += eur
            if is_de:
                income[y]["div_de"] += eur
            bucket = "Dividende"
        elif t in _INT_RECV:
            income[y]["interest"] += eur
            bucket = "Zins erhalten"
        elif t in _INT_PAID:
            income[y]["interest_paid"] += eur
            bucket = "Zins gezahlt (nicht abzugsf.)"
        elif t in _WH_TYPES:
            income[y]["withholding"] += eur     # negativ
            if is_de:
                income[y]["withholding_de"] += eur
            bucket = "Quellensteuer"
        elif t in _FEE_TYPES:
            income[y]["fees"] += eur
            bucket = "Gebühr (nicht abzugsf.)"
        else:
            continue   # Deposits/Withdrawals u.ä. ignorieren
        income[y]["detail"].append({
            "date": c["date"], "type": bucket, "symbol": c["symbol"],
            "country": c["country"], "currency": ccy,
            "amount_local": round(c["amount_local"], 2), "fx": round(rate, 5),
            "amount_eur": round(eur, 2), "foreign": not is_de,
        })

    # ── Devisen (Regel F) je Jahr ─────────────────────────────────────────────────
    fxyear = _dd(lambda: {"net": 0.0, "by_ccy": _dd(float), "detail": []})
    for x in fx_lots:
        y = x["date"][:4]
        if not y:
            continue
        fxyear[y]["net"] += x["realized_eur"]
        fxyear[y]["by_ccy"][x["currency"]] += x["realized_eur"]
        fxyear[y]["detail"].append({
            "date": x["date"], "currency": x["currency"],
            "realized_eur": round(x["realized_eur"], 2), "desc": x["desc"],
        })

    # ── je Jahr aggregieren + Töpfe + Steuer ──────────────────────────────────────
    g = lambda v: round(v, 2)
    _catord = {"Aktien": 0, "Futures": 1, "Fonds": 2, "Sonstige": 3}

    all_years = sorted(
        {j["year"] for j in journal if j["year"]}
        | set(income.keys()) | set(fxyear.keys())
        | {y for f in files for y in f["statement_years"]}
    )

    def _year_result(yr: str) -> dict:
        jr = [j for j in journal if j["year"] == yr]
        buckets = _dd(lambda: {"gewinn": 0.0, "verlust": 0.0})
        for j in jr:
            b = buckets[j["category"]]
            if j["gewinn_eur"] >= 0:
                b["gewinn"] += j["gewinn_eur"]
            else:
                b["verlust"] += -j["gewinn_eur"]

        ak = buckets["Aktien"]; fut = buckets["Futures"]
        fo = buckets["Fonds"]; so = buckets["Sonstige"]
        inc = income.get(yr)
        dividends = inc["dividends"] if inc else 0.0
        div_de = inc["div_de"] if inc else 0.0
        interest = inc["interest"] if inc else 0.0
        interest_paid = inc["interest_paid"] if inc else 0.0
        fees = inc["fees"] if inc else 0.0
        withholding = abs(inc["withholding"]) if inc else 0.0
        wh_de = abs(inc["withholding_de"]) if inc else 0.0
        wh_foreign = max(0.0, withholding - wh_de)
        fxnet = fxyear[yr]["net"] if yr in fxyear else 0.0

        ak_net = ak["gewinn"] - ak["verlust"]
        fut_net = fut["gewinn"] - fut["verlust"]
        fo_net = fo["gewinn"] - fo["verlust"]
        so_net = so["gewinn"] - so["verlust"]
        # Allgemeiner Topf: Termingeschäfte + Fonds + Sonstige + ausl. Div + Zinsen + FX(RegelF).
        # Inländische Dividenden (div_de, Z.7) sind an der Quelle bereits abgeltend
        # versteuert → NICHT erneut in die Bemessungsgrundlage.
        div_foreign = dividends - div_de
        allg_net = fut_net + fo_net + so_net + div_foreign + interest + fxnet

        # ── Topf-übergreifende Verrechnung (§20 Abs. 6) ───────────────────────────
        # 1. Aktien-Verluste zuerst gegen Aktien-Gewinne (im Aktien-Topf, S.4):
        #    negativ → Vortrag (gefangen, nur ggü. künftigen Aktiengewinnen).
        # 2. Allgemeine Verluste dürfen ZUSÄTZLICH den verbleibenden Aktien-Gewinn
        #    mindern (Überlauf) — Termingeschäfte-Verluste sind seit JStG 2024 frei
        #    verrechenbar. Umgekehrt NICHT: Aktien-Verluste mindern keine allg. Gewinne.
        #    Diese Reihenfolge ist zwingend und zugleich die günstigste (frei
        #    vortragbarer allg. Verlust bleibt übrig statt gefangenem Aktien-Verlust).
        ak_verlustvortrag = max(0.0, -ak_net)
        rest_aktiengewinn = max(0.0, ak_net)
        if allg_net >= 0:
            spillover = 0.0
            ak_steuerbar = rest_aktiengewinn
            allg_steuerbar = allg_net
            allg_verlustvortrag = 0.0
        else:
            spillover = min(rest_aktiengewinn, -allg_net)   # allg. Verlust mindert Aktiengewinn
            ak_steuerbar = rest_aktiengewinn - spillover
            allg_steuerbar = 0.0
            allg_verlustvortrag = -allg_net - spillover
        base = ak_steuerbar + allg_steuerbar
        abgelt = base * 0.25
        soli = abgelt * 0.055
        steuer_brutto = abgelt + soli
        # Anrechenbare ausl. QSt: DBA-Höchstsatz 15 % der ausl. Dividenden, max. bis Steuer
        qst = min(wh_foreign, 0.15 * max(0.0, div_foreign), steuer_brutto)
        steuer_netto = max(0.0, steuer_brutto - qst)

        kap_foreign = g(dividends - div_de + interest
                        + ak_net + fut_net + fo_net + so_net + fxnet)

        journal_sorted = sorted(jr, key=lambda j: (_catord.get(j["category"], 9),
                                                   j["verkauf_datum"], j["symbol"]))
        positions = _dd(lambda: {"cat": "", "gewinn": 0.0, "verlust": 0.0})
        for j in jr:
            p = positions[j["symbol"]]
            p["cat"] = j["category"]
            if j["gewinn_eur"] >= 0:
                p["gewinn"] += j["gewinn_eur"]
            else:
                p["verlust"] += -j["gewinn_eur"]
        pos_list = sorted(
            [{"symbol": s, "category": p["cat"], "gewinn": g(p["gewinn"]),
              "verlust": g(p["verlust"]), "net": g(p["gewinn"] - p["verlust"])}
             for s, p in positions.items()],
            key=lambda x: (_catord.get(x["category"], 9), -x["net"]))

        return {
            "year": yr,
            "journal": journal_sorted,
            "positions": pos_list,
            "income_detail": (inc["detail"] if inc else []),
            "fx_detail": (fxyear[yr]["detail"] if yr in fxyear else []),
            "fx_by_ccy": {c: g(v) for c, v in (fxyear[yr]["by_ccy"].items() if yr in fxyear else [])},

            # Anlage-KAP-Orientierung
            "line7_inland": g(div_de),
            "line19_foreign": kap_foreign,
            "line20_aktien_gewinn": g(ak["gewinn"]),
            "line22_termin_verlust": g(fut["verlust"] + fo["verlust"] + so["verlust"]),
            "line23_aktien_verlust": g(ak["verlust"]),

            # Detailwerte
            "aktien_gewinn": g(ak["gewinn"]), "aktien_verlust": g(ak["verlust"]),
            "futures_gewinn": g(fut["gewinn"]), "futures_verlust": g(fut["verlust"]),
            "fonds_gewinn": g(fo["gewinn"]), "fonds_verlust": g(fo["verlust"]),
            "sonstige_gewinn": g(so["gewinn"]), "sonstige_verlust": g(so["verlust"]),
            "dividends_eur": g(dividends), "dividends_de_eur": g(div_de),
            "interest_eur": g(interest), "interest_paid_eur": g(interest_paid),
            "fees_eur": g(fees),
            "withholding_eur": g(withholding), "withholding_foreign_eur": g(wh_foreign),

            "tax": {
                "aktien_topf": {"gewinn": g(ak["gewinn"]), "verlust": g(ak["verlust"]),
                                "netto": g(ak_net), "steuerbar": g(ak_steuerbar),
                                "verlustvortrag": g(ak_verlustvortrag)},
                "allg_topf": {"termingeschaefte": g(fut_net), "fonds": g(fo_net),
                              "sonstige": g(so_net), "dividenden": g(div_foreign),
                              "zinsen": g(interest), "waehrung": g(fxnet),
                              "waehrung_detail": {c: g(v) for c, v in
                                                  (fxyear[yr]["by_ccy"].items() if yr in fxyear else [])},
                              "netto": g(allg_net), "steuerbar": g(allg_steuerbar),
                              "verlustvortrag": g(allg_verlustvortrag)},
                "spillover": g(spillover),   # allg. Verlust, der Aktiengewinn gemindert hat
                "nicht_abzugsfaehig": {"zinsen_gezahlt": g(interest_paid), "gebuehren": g(fees)},
                "bemessungsgrundlage": g(base),
                "abgeltungsteuer": g(abgelt), "soli": g(soli),
                "steuer_brutto": g(steuer_brutto),
                "qst_anrechenbar": g(qst), "steuer_netto": g(steuer_netto),
            },
        }

    years = {y: _year_result(y) for y in all_years}
    if not target_year or target_year not in years:
        target_year = all_years[-1] if all_years else None

    return {
        "year": target_year,
        "available_years": all_years,
        "files_years": [y for f in files for y in f["statement_years"]],
        "lot_count": len(lots),
        "fx_lot_count": len(fx_lots),
        "years": years,
        **(years.get(target_year, {})),
    }
