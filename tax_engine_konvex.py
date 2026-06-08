"""
tax_engine_konvex.py — Steuer +++ (Anlage KAP / KAP-INV)
========================================================
Adapter um die vendorierte Konvex-Engine (konvex_tax/) für Folio.

Warum eine dritte Steuer-Engine?
  • Steuer    (tax_engine.py)      — CSV, FIFO über die ganze Historie (Näherung)
  • Steuer ++ (tax_engine_xml.py)  — Flex-XML Closed Lots, EUR pro Bein, prüffähig
  • Steuer +++(diese Datei)        — Konvex-Engine: zusätzlich
        – InvStG-Teilfreistellung (30/15/60/0 %) tatsächlich angewandt
        – separate Anlage KAP-INV (Fonds aus dem allg. Topf herausgelöst)
        – Stillhalterprämien mit Zuflussprinzip (BMF Rn. 25-35), Cross-Year-Matching
        – offizielle Anlage-KAP-Zeilennummern 7/19/20/22/23/37/38/41
        – deutsche vs. ausländische Quellensteuer getrennt

Die eigentliche Berechnung steckt in konvex_tax/calculate_tax_report.py.
Diese Datei: XMLs nach Konto/Jahr gruppieren, je Steuerjahr mit voller Historie
rechnen lassen, das Ergebnis in eine kompakte, JSON-sichere Struktur für das
Frontend gießen und die resultierende Abgeltungsteuer nach §20 Abs. 6 EStG
ableiten (gleiche Topf-Logik wie Steuer ++, plus KAP-INV separat).

Stateless. Kein Netz nötig (EUR-Konten nutzen die in der XML enthaltenen
ConversionRates; ecb_rates.py liefert USD-Konten offline).
"""

from __future__ import annotations

import contextlib
import io
import os
import tempfile
import threading
import xml.etree.ElementTree as ET

from konvex_tax import calculate_tax_report, extract_ibkr_data

# Die Engine schreibt viel Diagnose-Output (inkl. Unicode-Pfeile) nach stdout.
# Das verschmutzt Folios Logs und crasht auf Nicht-UTF-8-Konsolen (Windows cp1252).
# → stdout während der Berechnung wegfangen. Der Lock serialisiert zugleich die
#   CPU-lastige Berechnung und macht das stdout-Umlenken thread-sicher.
_ENGINE_LOCK = threading.Lock()


def _g(v, nd=2):
    """JSON-sicherer, gerundeter Float (None → None)."""
    if v is None:
        return None
    try:
        return round(float(v), nd)
    except (TypeError, ValueError):
        return None


def _peek_xml_meta(text: str) -> dict | None:
    """accountId + Zeitraum aus einer Flex-XML lesen (ohne volle Verarbeitung)."""
    try:
        root = ET.fromstring(text)
    except ET.ParseError:
        return None
    stmt = root.find('.//FlexStatement')
    if stmt is None:
        return None
    acct = root.find('.//AccountInformation')
    to_date = stmt.get('toDate', '') or ''
    from_date = stmt.get('fromDate', '') or ''
    return {
        'account_id': stmt.get('accountId', 'unknown'),
        'from_date': from_date,
        'to_date': to_date,
        'year': (to_date[:4] or from_date[:4]),
        'currency': acct.get('currency', 'EUR') if acct is not None else 'EUR',
        'account_name': acct.get('name', '') if acct is not None else '',
    }


def _shape_year(d: dict) -> dict:
    """Konvex-Ergebnis-Dict → kompakte Frontend-Struktur + §20-Abs.-6-Steuer."""
    eur = d.get  # alias

    # ── Roh-Bausteine (vor Korrekturen) ──────────────────────────────────────
    ak_gewinn_raw = float(eur('zeile_20_stock_gains_eur', 0) or 0)      # = stocks_gain
    ak_verlust_raw = float(eur('zeile_23_stock_losses_eur', 0) or 0)    # positiv
    ak_net_raw = float(eur('topf_1_aktien_netto', 0) or 0)
    allg_net_raw = float(eur('topf_2_sonstiges_netto', 0) or 0)
    options_gain_raw = float(eur('options_gain_eur', 0) or 0)
    options_loss_raw = float(eur('options_loss_eur', 0) or 0)          # negativ

    fx_gain = float(eur('fx_total_gain', 0) or 0)
    fx_loss = float(eur('fx_total_loss', 0) or 0)
    fx_net = fx_gain + fx_loss
    dividends = float(eur('dividends_eur', 0) or 0)                     # ausl. + inl.
    div_de = float(eur('domestic_taxed_dividends_eur', 0) or 0)
    div_foreign = dividends - div_de
    interest = float(eur('interest_eur', 0) or 0)
    interest_paid = float(eur('debit_interest_eur', 0) or 0)           # negativ
    wht_foreign = float(eur('withholding_tax_eur', 0) or 0)            # anrechenbar
    wht_domestic = float(eur('domestic_withholding_tax_eur', 0) or 0)

    kap_inv = eur('kap_inv', {}) or {}
    kap_inv_net_raw = float(kap_inv.get('etf_net_taxable_eur', 0) or 0)
    kap_inv_wht = float(calculate_tax_report.get_kap_inv_wht_for_reporting(kap_inv) or 0)

    # ── Korrekturen wie im offiziellen Konvex-Report (GUI-Defaults) ──────────
    # Der Konvex-Textreport ist die „Single Source of Truth". Seine Default-
    # Schalter: Tageskurs-Methode AN, InvStG AN, Zuflussprinzip (falls Cross-Year),
    # Variante B AUS. Wir spiegeln das, damit Steuer +++ exakt diese Werte zeigt.
    #
    # Tageskurs-Methode (§20 Abs. 4 S. 1 EStG): Erlös zum Verkaufs-, Kosten zum
    # Kauf-FX-Kurs (statt IBKRs Netto-PnL zum Schlusskurs) — pro Lot. Futures sind
    # ausgeschlossen (Kostenbasis = voller Kontraktwert). Engine liefert die Deltas.
    fx_corr_by_topf = eur('fx_correction_by_topf', {}) or {}
    tk_gain_adj = eur('fx_corr_gain_adj', {}) or {}
    tk_loss_adj = eur('fx_corr_loss_adj', {}) or {}
    corr_topf1 = float(fx_corr_by_topf.get('Topf1', 0) or 0)
    corr_topf2 = float(fx_corr_by_topf.get('Topf2', 0) or 0)
    g1 = float(tk_gain_adj.get('Topf1', 0) or 0)
    l1 = float(tk_loss_adj.get('Topf1', 0) or 0)     # negativ → erhöht Verluste
    g2 = float(tk_gain_adj.get('Topf2', 0) or 0)
    l2 = float(tk_loss_adj.get('Topf2', 0) or 0)
    kap_inv_tk = float(eur('fx_correction_kap_inv_taxable', 0) or 0)

    # Zuflussprinzip (BMF Rn. 25/33): Assignment-Prämien aus Vorjahren raus.
    audit = eur('audit', {}) or {}
    cross_year_premium = float(audit.get('cross_year_premium_eur', 0) or 0)

    # Finale Werte (= Konvex-Report)
    ak_gewinn = ak_gewinn_raw + g1                       # Zeile 20
    ak_verlust = ak_verlust_raw - l1                     # Zeile 23 (positiv)
    ak_net = ak_net_raw + corr_topf1                     # Topf 1 / Saldo Aktien
    options_gain = options_gain_raw - cross_year_premium + g2
    options_loss = options_loss_raw + l2
    allg_net = allg_net_raw - cross_year_premium + corr_topf2   # Topf 2
    kap_inv_net = kap_inv_net_raw + kap_inv_tk
    allg_korrektur = corr_topf2 - cross_year_premium     # für transparente Anzeige
    tageskurs_corr = corr_topf1 + corr_topf2             # gesamte Tageskurs-Korrektur

    # ── Saubere Aufschlüsselung des allgemeinen Topfs (Topf 2) ───────────────
    # WICHTIG: die Engine bündelt in options_loss/options_gain SOWOHL Termin-
    # geschäfte (Optionen/Futures) ALS AUCH die Devisen (Regel F) — siehe
    # calculate_tax_report.py „options_loss += fx_total_loss". Für eine
    # nachvollziehbare, doppelfreie Anzeige nutzen wir die autoritative
    # `topf2_by_category` (je Instrumentenklasse getrennt) und gruppieren:
    #   Termingeschäfte = Optionen + Futures   ·   Devisen = FX (Regel F)
    #   Sonstige        = T-Bills, Anleihen, Crypto/Commodity ETPs …
    by_cat = eur('topf2_by_category', {}) or {}
    _TERMIN = {'Optionen', 'Futures'}
    _DEVISEN = {'Devisen'}

    def _cat_gl(names):
        g = sum(float(by_cat[c].get('gain', 0) or 0) for c in by_cat if c in names)
        l = sum(float(by_cat[c].get('loss', 0) or 0) for c in by_cat if c in names)
        return g, l

    termin_g, termin_l = _cat_gl(_TERMIN)
    dev_g, dev_l = _cat_gl(_DEVISEN)
    _other_names = set(by_cat) - _TERMIN - _DEVISEN
    other_g, other_l = _cat_gl(_other_names)

    # Zeile-22-Zerlegung: positive Verlustbeträge je Gruppe (Summe = Zeile 22).
    # by_cat ist roh (vor Tageskurs-Topf2-Delta); ein evtl. Restbetrag (Tageskurs-
    # Korrektur, Zuflussprinzip) wird transparent als „rest" ausgewiesen, damit die
    # Summe immer auf die finale Zeile 22 passt.
    z22_total = abs(options_loss)
    z22_termin = -termin_l
    z22_dev = -dev_l
    z22_other = -other_l
    z22_rest = z22_total - (z22_termin + z22_dev + z22_other)

    # ── §20 Abs. 6 EStG — Topf-übergreifende Verrechnung ─────────────────────
    # Identische Logik wie Steuer ++ (tax_engine_xml.py): Aktien-Verluste nur
    # gegen Aktien-Gewinne (S.4 → Vortrag), allgemeine Verluste dürfen den
    # verbleibenden Aktien-Gewinn zusätzlich mindern (Überlauf, JStG 2024).
    ak_verlustvortrag = max(0.0, -ak_net)
    rest_aktiengewinn = max(0.0, ak_net)
    if allg_net >= 0:
        spillover = 0.0
        ak_steuerbar = rest_aktiengewinn
        allg_steuerbar = allg_net
        allg_verlustvortrag = 0.0
    else:
        spillover = min(rest_aktiengewinn, -allg_net)
        ak_steuerbar = rest_aktiengewinn - spillover
        allg_steuerbar = 0.0
        allg_verlustvortrag = -allg_net - spillover

    # KAP-INV: eigener Verrechnungskreis. Gewinn (nach Teilfreistellung) ist
    # steuerbar, Verlust wird vorgetragen.
    kap_inv_steuerbar = max(0.0, kap_inv_net)
    kap_inv_verlustvortrag = max(0.0, -kap_inv_net)

    base = ak_steuerbar + allg_steuerbar + kap_inv_steuerbar
    abgelt = base * 0.25
    soli = abgelt * 0.055
    steuer_brutto = abgelt + soli
    # Anrechenbare ausl. QSt: tatsächlich anrechenbarer Betrag aus der Engine
    # (DBA-Höchstsatz bereits berücksichtigt), gedeckelt auf die Steuer.
    qst = min(wht_foreign + kap_inv_wht, steuer_brutto)
    steuer_netto = max(0.0, steuer_brutto - qst)

    # ── FX je Währung (Regel F, IBKR-realisiert) ─────────────────────────────
    fx_results = {}
    for ccy, r in (eur('fx_results', {}) or {}).items():
        fx_results[ccy] = {
            'gain': _g(r.get('gain')), 'loss': _g(r.get('loss')),
            'net': _g(r.get('net')),
            'disposals': int(r.get('disposals_count', 0) or 0),
            'days_negative': int(r.get('days_negative', 0) or 0),
        }

    # ── KAP-INV je Fonds (InvStG-Teilfreistellung) ───────────────────────────
    etf_by_isin = []
    for isin, f in (kap_inv.get('etf_by_isin', {}) or {}).items():
        etf_by_isin.append({
            'isin': isin,
            'name': f.get('name') or f.get('ticker') or isin,
            'classification': f.get('classification', ''),
            'tfs_rate': _g(f.get('tfs_rate'), 4),
            'gain': _g(f.get('gain')), 'loss': _g(f.get('loss')),
            'div': _g(f.get('div')),
            'gain_taxable': _g(f.get('gain_taxable')),
            'loss_taxable': _g(f.get('loss_taxable')),
            'div_taxable': _g(f.get('div_taxable')),
            'wht': _g(f.get('wht')),
        })
    etf_by_isin.sort(key=lambda x: (x['classification'], x['isin']))

    audit = eur('audit', {}) or {}

    return {
        'tax_year': eur('tax_year'),
        'base_currency': eur('base_currency', 'EUR'),

        # offizielle Anlage-KAP / KAP-INV Zeilen (final, = Konvex-Report)
        'zeile': {
            'z7': _g(eur('zeile_7_kapitalertraege_mit_inlaendischem_steuerabzug_eur')),
            'z19': _g(ak_net + allg_net),     # = Topf 1 + Topf 2 (Korrekturen drin)
            'z20': _g(ak_gewinn),
            'z22': _g(z22_total),
            'z23': _g(ak_verlust),
            'z37': _g(eur('zeile_37_kapitalertragsteuer_eur')),
            'z38': _g(eur('zeile_38_solidaritaetszuschlag_eur')),
            'z41': _g(eur('zeile_41_withholding_tax_eur')),
            'kap_inv_net': _g(kap_inv_net),
        },

        # Zwei-Töpfe (§20 Abs. 6)
        'toepfe': {
            'aktien': {
                'gewinn': _g(ak_gewinn), 'verlust': _g(ak_verlust),
                'netto': _g(ak_net), 'steuerbar': _g(ak_steuerbar),
                'verlustvortrag': _g(ak_verlustvortrag),
                'gewinn_raw': _g(ak_gewinn_raw), 'verlust_raw': _g(ak_verlust_raw),
                'tageskurs_korrektur': _g(corr_topf1),   # §20 Abs.4 — IBKR→Tageskurs
            },
            'allg': {
                # doppelfrei: Termingeschäfte = Optionen+Futures (OHNE Devisen),
                # Devisen separat — beide aus topf2_by_category abgeleitet.
                'termingeschaefte': _g(termin_g + termin_l),
                'termingeschaefte_gewinn': _g(termin_g),
                'termingeschaefte_verlust': _g(termin_l),
                'waehrung': _g(dev_g + dev_l),
                'waehrung_gewinn': _g(dev_g),
                'waehrung_verlust': _g(dev_l),
                'sonstige': _g(other_g + other_l),
                'sonstige_gewinn': _g(other_g),
                'sonstige_verlust': _g(other_l),
                'dividenden': _g(div_foreign),       # ausländisch (Z.19)
                'dividenden_de': _g(div_de),         # inländisch (in topf_2 enthalten, auch Z.7)
                'zinsen': _g(interest),
                'korrektur': _g(allg_korrektur),     # Tageskurs-Topf2 + Zuflussprinzip
                'netto': _g(allg_net), 'steuerbar': _g(allg_steuerbar),
                'verlustvortrag': _g(allg_verlustvortrag),
                'by_category': {
                    c: {'gewinn': _g(v.get('gain')), 'verlust': _g(v.get('loss')),
                        'netto': _g(float(v.get('gain', 0) or 0) + float(v.get('loss', 0) or 0))}
                    for c, v in by_cat.items()
                },
            },
            # Aufschlüsselung von Zeile 22 (alle Nicht-Aktien-Verluste, positiv)
            'z22_components': {
                'termingeschaefte': _g(z22_termin),
                'waehrung': _g(z22_dev),
                'sonstige': _g(z22_other),
                'rest': _g(z22_rest),
                'total': _g(z22_total),
            },
            'spillover': _g(spillover),
            'kap_inv': {
                'netto': _g(kap_inv_net), 'steuerbar': _g(kap_inv_steuerbar),
                'verlustvortrag': _g(kap_inv_verlustvortrag),
            },
        },

        # Erträge / Quellensteuer
        'income': {
            'dividends': _g(dividends), 'dividends_de': _g(div_de),
            'dividends_foreign': _g(div_foreign),
            'interest': _g(interest), 'interest_paid': _g(interest_paid),
            'wht_foreign': _g(wht_foreign), 'wht_domestic': _g(wht_domestic),
            'stocks_gain': _g(ak_gewinn), 'stocks_loss': _g(-ak_verlust),
            'options_gain': _g(options_gain), 'options_loss': _g(options_loss),
        },

        # InvStG / KAP-INV Detail
        'kap_inv': {
            'net_taxable': _g(kap_inv_net),
            'gain_raw': _g(kap_inv.get('etf_gain_raw_eur')),
            'loss_raw': _g(kap_inv.get('etf_loss_raw_eur')),
            'gain_taxable': _g(kap_inv.get('etf_gain_taxable_eur')),
            'loss_taxable': _g(kap_inv.get('etf_loss_taxable_eur')),
            'dividends_raw': _g(kap_inv.get('etf_dividends_raw_eur')),
            'dividends_taxable': _g(kap_inv.get('etf_dividends_taxable_eur')),
            'wht': _g(kap_inv_wht),
            'stillhalter_premium': _g(kap_inv.get('etf_stillhalter_premium_eur')),
            'by_isin': etf_by_isin,
            'unknown_isins': list(kap_inv.get('etf_unknown_isins', []) or []),
        },

        # FX je Währung
        'fx': {
            'results': fx_results,
            'total_gain': _g(fx_gain), 'total_loss': _g(fx_loss),
            'net': _g(fx_net),
            'mtm': {c: _g(v) for c, v in (eur('fx_mtm', {}) or {}).items()},
            'has_negative_balance': bool(eur('fx_has_negative_balance', False)),
        },

        # Abgeltungsteuer
        'tax': {
            'bemessungsgrundlage': _g(base),
            'abgeltungsteuer': _g(abgelt), 'soli': _g(soli),
            'steuer_brutto': _g(steuer_brutto),
            'qst_anrechenbar': _g(qst), 'steuer_netto': _g(steuer_netto),
        },

        # Hinweise / Plausibilität
        'flags': {
            'has_trade_price': bool(eur('has_trade_price', False)),
            'fx_margin_correction': bool(eur('fx_margin_correction_enabled', False)),
            'stillhalter_unmatched': audit.get('stillhalter_unmatched', []) or [],
            'zufluss_unmatched': audit.get('zufluss_unmatched', []) or [],
            'cross_year_premium': _g(cross_year_premium),
            'funds_processed': int(audit.get('funds_processed', 0) or 0),
            'tageskurs_korrektur': _g(tageskurs_corr),   # §20 Abs.4 gesamt (Topf1+Topf2)
        },
    }


def compute_tax_report_konvex(xml_texts: list[str], target_year: str | None = None) -> dict:
    """
    Nimmt mehrere IBKR-Flex-XML-Texte (alle Jahre seit Depoteröffnung), gruppiert
    sie nach Konto und rechnet je Steuerjahr mit voller Historie. Gibt eine
    Jahr→Ergebnis-Struktur für den Jahres-Selektor des Frontends zurück.

    Annahme: ein Konto. Bei mehreren unterschiedlichen Konten wird ein Fehler
    gemeldet (bitte pro Konto getrennt hochladen — wie in der Konvex-App).
    """
    metas = []
    for text in xml_texts:
        m = _peek_xml_meta(text)
        if m:
            m['_text'] = text
            metas.append(m)
    if not metas:
        return {'year': None, 'error': 'Keine gültige Flex-XML erkannt.'}

    accounts = {m['account_id'] for m in metas}
    if len(accounts) > 1:
        return {'year': None,
                'error': f'{len(accounts)} verschiedene Konten erkannt '
                         f'({", ".join(sorted(accounts))}). Bitte pro Konto getrennt '
                         f'hochladen (eigene Flex Query je Konto).'}

    # nach Steuerjahr sortieren (spätestes = aktuellstes)
    metas.sort(key=lambda m: m['to_date'])
    years_present = sorted({m['year'] for m in metas if m['year']})

    files_years = [m['year'] for m in metas]
    years_out: dict[str, dict] = {}

    for yr in years_present:
        main = None
        for m in metas:
            if m['year'] == yr:
                main = m   # letztes XML dieses Jahres
        if main is None:
            continue
        history = [m for m in metas if m['year'] and m['year'] < yr]

        with tempfile.TemporaryDirectory() as tmp:
            main_path = os.path.join(tmp, 'input.xml')
            with open(main_path, 'w', encoding='utf-8') as f:
                f.write(main['_text'])
            with _ENGINE_LOCK, contextlib.redirect_stdout(io.StringIO()):
                if history:
                    hist_paths = []
                    for i, h in enumerate(history):
                        hp = os.path.join(tmp, f'history_{i:02d}.xml')
                        with open(hp, 'w', encoding='utf-8') as f:
                            f.write(h['_text'])
                        hist_paths.append(hp)
                    extract_ibkr_data.extract_fx_multi_xml(sorted(hist_paths) + [main_path], tmp)
                else:
                    extract_ibkr_data.parse_ibkr_xml(main_path, tmp)
                d = calculate_tax_report.calculate_tax(tmp)
        years_out[yr] = _shape_year(d)

    if not years_out:
        return {'year': None, 'error': 'Kein Steuerjahr aus den XMLs ableitbar.'}

    available = sorted(years_out.keys())
    if not target_year or target_year not in years_out:
        target_year = available[-1]

    return {
        'year': target_year,
        'available_years': available,
        'years': years_out,
        'files_years': files_years,
        'account': metas[-1].get('account_name') or metas[-1].get('account_id'),
        'base_currency': years_out[target_year].get('base_currency', 'EUR'),
    }
