"""
tax_pdf_konvex.py — PDF-Steuerbericht für Steuer +++ (Anlage KAP / KAP-INV)
===========================================================================
Erzeugt aus dem geformten Jahres-Ergebnis (tax_engine_konvex._shape_year) einen
mehrseitigen PDF-Bericht: Zusammenfassung, Anlage-KAP-Zeilen, beide Töpfe,
Abgeltungsteuer, KAP-INV, Devisen, Erträge und das vollständige Trade-Journal
(je Position mit allen Lots, Tageskurs-Korrekturen, Zwischensummen).

Reines fpdf2 (kein System-Dependency). Kernschrift Helvetica → latin-1; das
Euro-Zeichen und Sonderpfeile werden auf „EUR"/„->" abgebildet (_s()).
"""

from __future__ import annotations

from datetime import datetime
from fpdf import FPDF


def _s(v) -> str:
    """latin-1-sicherer String (Helvetica-Kernschrift kann kein €/→)."""
    if v is None:
        return ""
    s = str(v)
    for a, b in (("€", "EUR"), ("→", "->"), ("—", "-"), ("–", "-"),
                 ("„", '"'), ("“", '"'), ("”", '"'), ("’", "'"), ("…", "...")):
        s = s.replace(a, b)
    return s.encode("latin-1", "replace").decode("latin-1")


def _eur(v) -> str:
    if v is None:
        return "-"
    return f"{float(v):,.2f}".replace(",", "X").replace(".", ",").replace("X", ".") + " EUR"


def _num(v, dec=2) -> str:
    if v is None or v == "":
        return ""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return _s(v)
    return f"{f:,.{dec}f}".replace(",", "X").replace(".", ",").replace("X", ".")


class _PDF(FPDF):
    def __init__(self, title, subtitle):
        super().__init__(orientation="L", unit="mm", format="A4")
        self._title = title
        self._subtitle = subtitle
        self.set_auto_page_break(True, margin=14)
        self.set_margins(10, 12, 10)

    def header(self):
        self.set_font("Helvetica", "B", 12)
        self.set_text_color(20, 20, 20)
        self.cell(0, 6, _s(self._title), ln=1)
        self.set_font("Helvetica", "", 8)
        self.set_text_color(110, 110, 110)
        self.cell(0, 4, _s(self._subtitle), ln=1)
        self.set_draw_color(200, 200, 200)
        self.line(self.l_margin, self.get_y() + 1, self.w - self.r_margin, self.get_y() + 1)
        self.ln(3)
        self.set_text_color(20, 20, 20)

    def footer(self):
        self.set_y(-10)
        self.set_font("Helvetica", "", 7)
        self.set_text_color(150, 150, 150)
        self.cell(0, 4, _s("Steuer +++ (Folio · Engine KonvexInvestment/ibkr-steuer) — "
                           "ohne Gewähr, keine Steuerberatung"), align="L")
        self.cell(0, 4, f"Seite {self.page_no()}", align="R")


def _section(pdf: _PDF, title: str):
    if pdf.get_y() > pdf.h - 40:
        pdf.add_page()
    pdf.ln(2)
    pdf.set_font("Helvetica", "B", 9.5)
    pdf.set_fill_color(238, 238, 240)
    pdf.set_text_color(20, 20, 20)
    pdf.cell(0, 6, "  " + _s(title), ln=1, fill=True)
    pdf.ln(1)


def _kv_rows(pdf: _PDF, rows, label_w=120, val_w=45):
    """rows = list of (label, value_str, bold?, color(r,g,b)?)."""
    for r in rows:
        label, val = r[0], r[1]
        bold = r[2] if len(r) > 2 else False
        color = r[3] if len(r) > 3 else (40, 40, 40)
        pdf.set_font("Helvetica", "B" if bold else "", 8.5)
        pdf.set_text_color(60, 60, 60)
        pdf.cell(label_w, 5, _s(label))
        pdf.set_text_color(*color)
        pdf.cell(val_w, 5, _s(val), align="R", ln=1)
    pdf.set_text_color(40, 40, 40)


_GREEN = (22, 130, 70)
_RED = (190, 40, 40)


def _signed(v):
    return _GREEN if (v or 0) >= 0 else _RED


# ── Journal-Tabelle ──────────────────────────────────────────────────────────
_JCOLS = [
    ("Datum", 20, "L"), ("K/V", 12, "C"), ("Stk.", 14, "R"), ("Kurs", 20, "R"),
    ("Kostenbasis", 24, "R"), ("Erloese", 24, "R"), ("G/V lokal", 22, "R"),
    ("Komm.", 15, "R"), ("Whr.", 12, "C"), ("FX", 17, "R"), ("G/V EUR", 24, "R"),
    ("Anmerkung", 0, "L"),  # 0 = Rest
]


def _jcol_widths(pdf: _PDF):
    avail = pdf.w - pdf.l_margin - pdf.r_margin
    fixed = sum(w for _, w, _ in _JCOLS if w)
    widths = []
    for _, w, _a in _JCOLS:
        widths.append(w if w else max(28, avail - fixed))
    return widths


def _jhead(pdf: _PDF, widths):
    pdf.set_font("Helvetica", "B", 6.8)
    pdf.set_fill_color(232, 232, 232)
    pdf.set_text_color(70, 70, 70)
    for (name, _w, align), w in zip(_JCOLS, widths):
        pdf.cell(w, 4.5, _s(name), align=align, fill=True, border="B")
    pdf.ln(4.5)
    pdf.set_text_color(30, 30, 30)


def _journal(pdf: _PDF, journal: dict):
    _section(pdf, "Prueffaehiges Trade-Journal je Veraeusserung (= Konvex-Excel-Export)")
    widths = _jcol_widths(pdf)
    for topf_key in ("Topf1", "Topf2", "KAP-INV"):
        blk = journal.get(topf_key)
        if not blk or not blk.get("groups"):
            continue
        # Topf-Kopf
        if pdf.get_y() > pdf.h - 30:
            pdf.add_page()
        pdf.set_font("Helvetica", "B", 8.5)
        pdf.set_fill_color(70, 80, 130)
        pdf.set_text_color(255, 255, 255)
        pdf.cell(sum(widths) - widths[-1], 6, "  " + _s(blk["label"]), fill=True)
        pdf.cell(widths[-1], 6, _s("Summe " + _eur(blk["total"])), align="R", fill=True, ln=1)
        pdf.set_text_color(30, 30, 30)

        for g in blk["groups"]:
            if pdf.get_y() > pdf.h - 22:
                pdf.add_page()
            # Gruppen-Label
            lbl = g["key"] + (" - " + g["desc"] if g.get("desc") else "") + \
                  (" (" + g["isin"] + ")" if g.get("isin") else "")
            pdf.set_font("Helvetica", "B", 7.4)
            pdf.set_fill_color(246, 246, 248)
            pdf.cell(sum(widths) - widths[-1], 5, _s(lbl), fill=True)
            pdf.cell(widths[-1], 5, _eur(g["total"]), align="R", fill=True, ln=1)
            _jhead(pdf, widths)
            for r in g["rows"]:
                if pdf.get_y() > pdf.h - 16:
                    pdf.add_page()
                    _jhead(pdf, widths)
                korr = r.get("source") == "tageskurs_korrektur"
                pdf.set_font("Helvetica", "I" if korr else "", 6.8)
                cells = [
                    r.get("datum", ""), r.get("kv", "") or "",
                    _num(r.get("stk"), 0) if str(r.get("stk", "")).lstrip("-").isdigit() else _s(r.get("stk", "")),
                    _num(r.get("kurs"), 4), _num(r.get("kostenbasis")), _num(r.get("erloese")),
                    _num(r.get("gv_orig")), _num(r.get("kommission")), r.get("waehrung", "") or "",
                    _num(r.get("fx"), 4), _num(r.get("gv_eur")), r.get("anmerkung", "") or "",
                ]
                for i, ((_n, _w, align), w) in enumerate(zip(_JCOLS, widths)):
                    val = cells[i]
                    if i == 10:  # G/V EUR farbig
                        pdf.set_text_color(*( (120, 120, 120) if korr else _signed(r.get("gv_eur"))))
                    elif korr:
                        pdf.set_text_color(120, 120, 120)
                    else:
                        pdf.set_text_color(40, 40, 40)
                    txt = _s(val)
                    if i == 11 and len(txt) > 70:
                        txt = txt[:69] + "."
                    pdf.cell(w, 3.8, txt, align=align)
                pdf.ln(3.8)
            # Zwischensumme
            pdf.set_font("Helvetica", "B", 6.8)
            pdf.set_text_color(30, 30, 30)
            pdf.cell(sum(widths[:10]), 4.3, _s("Zwischensumme " + g["key"]), align="R", border="T")
            pdf.set_text_color(*_signed(g["total"]))
            pdf.cell(widths[10], 4.3, _num(g["total"]), align="R", border="T")
            pdf.cell(widths[11], 4.3, "", border="T", ln=1)
            pdf.set_text_color(30, 30, 30)
            pdf.ln(1)


def build_pdf(year_data: dict, account: str = "", created_at: str | None = None) -> bytes:
    yr = year_data.get("tax_year", "")
    created = created_at or datetime.now().strftime("%d.%m.%Y %H:%M")
    sub = f"Anlage KAP / KAP-INV  ·  Konto {account or '-'}  ·  " \
          f"Basiswaehrung {year_data.get('base_currency', 'EUR')}  ·  erstellt {created}"
    pdf = _PDF(f"Steuerbericht {yr} — Steuer +++", sub)
    pdf.add_page()

    t = year_data.get("tax", {})
    z = year_data.get("zeile", {})
    tp = year_data.get("toepfe", {})
    ak = tp.get("aktien", {})
    al = tp.get("allg", {})
    ki = tp.get("kap_inv", {})
    z22 = tp.get("z22_components", {})
    inc = year_data.get("income", {})
    kap = year_data.get("kap_inv", {})
    fx = year_data.get("fx", {})

    # ── Kennzahlen ──
    _section(pdf, "Ergebnis (Abgeltungsteuer)")
    _kv_rows(pdf, [
        ("Bemessungsgrundlage", _eur(t.get("bemessungsgrundlage")), True),
        ("Abgeltungsteuer 25 % + Solidaritaetszuschlag 5,5 %", _eur(t.get("steuer_brutto")), False, _RED),
        ("abzgl. anrechenbare auslaendische Quellensteuer (Z.41)", _eur(t.get("qst_anrechenbar")), False, _GREEN),
        ("Verbleibende Steuer", _eur(t.get("steuer_netto")), True, _RED),
    ])

    # ── Anlage-KAP Zeilen ──
    _section(pdf, "Anlage KAP / KAP-INV — Eintragungshilfe")
    _kv_rows(pdf, [
        ("Zeile 7  — Inlaendische Kapitalertraege mit Steuerabzug", _eur(z.get("z7"))),
        ("Zeile 19 — Auslaendische Kapitalertraege (Netto-Saldo)", _eur(z.get("z19")), True, _signed(z.get("z19"))),
        ("Zeile 20 — darin: Gewinne aus Aktienveraeusserungen", _eur(z.get("z20")), False, _GREEN),
        ("Zeile 22 — Verluste ohne Aktien (Termingeschaefte etc.)", _eur(z.get("z22")), False, _RED),
        ("Zeile 23 — Verluste aus Aktienveraeusserungen", _eur(z.get("z23")), False, _RED),
        ("Zeile 37 — Kapitalertragsteuer (inlaendisch)", _eur(z.get("z37"))),
        ("Zeile 38 — Solidaritaetszuschlag (inlaendisch)", _eur(z.get("z38"))),
        ("Zeile 41 — Anrechenbare auslaendische Quellensteuer", _eur(z.get("z41")), False, _GREEN),
        ("KAP-INV — Investmentertraege netto (nach Teilfreistellung)", _eur(z.get("kap_inv_net")), False, _signed(z.get("kap_inv_net"))),
    ])
    if (z22.get("termingeschaefte") or 0) + (z22.get("waehrung") or 0) > 0:
        pdf.set_font("Helvetica", "I", 7.5)
        pdf.set_text_color(110, 110, 110)
        pdf.multi_cell(0, 4, _s(
            "Zeile 22 = Termingeschaefte " + _eur(z22.get("termingeschaefte")) +
            " + Devisen (Regel F) " + _eur(z22.get("waehrung")) +
            ((" + Sonstige " + _eur(z22.get("sonstige"))) if z22.get("sonstige") else "") +
            " = " + _eur(z22.get("total"))))
        pdf.set_text_color(40, 40, 40)

    # ── Beide Toepfe ──
    _section(pdf, "Verlustverrechnung (§20 Abs. 6 EStG)")
    rows = [
        ("AKTIEN-TOPF (§20 Abs. 6 S. 4 — nur untereinander verrechenbar)", "", True),
        ("  Aktiengewinne (Z.20)", _eur(ak.get("gewinn")), False, _GREEN),
        ("  Aktienverluste (Z.23)", _eur(-(ak.get("verlust") or 0)), False, _RED),
    ]
    if ak.get("tageskurs_korrektur"):
        rows.append(("  darin Tageskurs-Korrektur §20 Abs. 4 (IBKR-Roh-Saldo "
                     + _eur((ak.get("netto") or 0) - (ak.get("tageskurs_korrektur") or 0)) + ")",
                     _eur(ak.get("tageskurs_korrektur")), False, (110, 110, 110)))
    rows += [
        ("  Netto Aktien-Topf", _eur(ak.get("netto")), True, _signed(ak.get("netto"))),
    ]
    if (ak.get("verlustvortrag") or 0) > 0:
        rows.append(("  -> Verlustvortrag (nur ggue. Aktiengewinnen)", _eur(ak.get("verlustvortrag")), False, _RED))
    rows += [
        ("ALLGEMEINER TOPF (ohne Investmentfonds)", "", True),
        ("  Termingeschaefte (Optionen + Futures)", _eur(al.get("termingeschaefte")), False, _signed(al.get("termingeschaefte"))),
        ("  Devisen (Regel F)", _eur(al.get("waehrung")), False, _signed(al.get("waehrung"))),
    ]
    if al.get("sonstige"):
        rows.append(("  Sonstige (T-Bills, Anleihen ...)", _eur(al.get("sonstige")), False, _signed(al.get("sonstige"))))
    rows += [
        ("  Auslaendische Dividenden (Z.19)", _eur(al.get("dividenden"))),
        ("  Inlaendische Dividenden (auch Z.7)", _eur(al.get("dividenden_de")), False, (110, 110, 110)),
        ("  Zinsen", _eur(al.get("zinsen"))),
        ("  Netto allg. Topf", _eur(al.get("netto")), True, _signed(al.get("netto"))),
    ]
    if (al.get("verlustvortrag") or 0) > 0:
        rows.append(("  -> Verlustvortrag (frei verrechenbar)", _eur(al.get("verlustvortrag")), False, _RED))
    rows += [
        ("ANLAGE KAP-INV (eigener Verrechnungskreis, §20 InvStG)", "", True),
        ("  Netto KAP-INV (nach Teilfreistellung)", _eur(ki.get("netto")), False, _signed(ki.get("netto"))),
    ]
    if (ki.get("verlustvortrag") or 0) > 0:
        rows.append(("  -> Verlustvortrag KAP-INV", _eur(ki.get("verlustvortrag")), False, _RED))
    _kv_rows(pdf, rows)

    # ── Steuerberechnung ──
    _section(pdf, "Steuerberechnung (ohne Sparer-Pauschbetrag, ohne KiSt)")
    _kv_rows(pdf, [
        ("Bemessungsgrundlage (Aktien + Allg. + KAP-INV)", _eur(t.get("bemessungsgrundlage")), True),
        ("Abgeltungsteuer 25 %", _eur(t.get("abgeltungsteuer"))),
        ("Solidaritaetszuschlag 5,5 %", _eur(t.get("soli"))),
        ("Steuer brutto", _eur(t.get("steuer_brutto")), True, _RED),
        ("abzgl. anrechenbare auslaendische Quellensteuer (Z.41)", _eur(t.get("qst_anrechenbar")), False, _GREEN),
        ("Verbleibende Steuer", _eur(t.get("steuer_netto")), True, _RED),
    ])

    # ── KAP-INV je Fonds ──
    if kap.get("by_isin"):
        _section(pdf, "Anlage KAP-INV — Investmentfonds (InvStG-Teilfreistellung)")
        pdf.set_font("Helvetica", "B", 7.5)
        for name, w, al_ in (("ISIN", 40, "L"), ("Klasse", 55, "L"), ("TFS", 20, "R"),
                             ("G/V brutto EUR", 45, "R"), ("steuerpflichtig EUR", 45, "R")):
            pdf.cell(w, 5, _s(name), align=al_, border="B")
        pdf.ln(5)
        cls = {"aktienfonds": "Aktienfonds (30%)", "mischfonds": "Mischfonds (15%)",
               "immobilienfonds": "Immobilienfonds (60/80%)", "sonstiger_fonds": "Sonstiger Fonds (0%)"}
        for f in kap["by_isin"]:
            net = (f.get("gain") or 0) + (f.get("loss") or 0) + (f.get("div") or 0)
            nett = (f.get("gain_taxable") or 0) + (f.get("loss_taxable") or 0) + (f.get("div_taxable") or 0)
            pdf.set_font("Helvetica", "", 7.5)
            pdf.cell(40, 4.6, _s(f.get("isin", "")), align="L")
            pdf.cell(55, 4.6, _s(cls.get(f.get("classification"), f.get("classification", ""))), align="L")
            pdf.cell(20, 4.6, (f"{(f.get('tfs_rate') or 0) * 100:.0f}%"), align="R")
            pdf.set_text_color(*_signed(net)); pdf.cell(45, 4.6, _num(net), align="R")
            pdf.set_text_color(*_signed(nett)); pdf.cell(45, 4.6, _num(nett), align="R", ln=1)
            pdf.set_text_color(40, 40, 40)

    # ── Devisen ──
    if fx.get("results"):
        _section(pdf, "Devisen (Regel F) je Waehrung — IBKR-realisiert, FIFO")
        pdf.set_font("Helvetica", "B", 7.5)
        for name, w, al_ in (("Waehrung", 30, "L"), ("Gewinn EUR", 40, "R"), ("Verlust EUR", 40, "R"),
                             ("Netto EUR", 40, "R"), ("Veraeuss.", 25, "R"), ("Tage neg.", 25, "R")):
            pdf.cell(w, 5, _s(name), align=al_, border="B")
        pdf.ln(5)
        for ccy in sorted(fx["results"]):
            r = fx["results"][ccy]
            pdf.set_font("Helvetica", "", 7.5)
            pdf.cell(30, 4.6, _s(ccy), align="L")
            pdf.set_text_color(*_GREEN); pdf.cell(40, 4.6, _num(r.get("gain")), align="R")
            pdf.set_text_color(*_RED); pdf.cell(40, 4.6, _num(r.get("loss")), align="R")
            pdf.set_text_color(*_signed(r.get("net"))); pdf.cell(40, 4.6, _num(r.get("net")), align="R")
            pdf.set_text_color(40, 40, 40)
            pdf.cell(25, 4.6, str(r.get("disposals", 0)), align="R")
            pdf.cell(25, 4.6, str(r.get("days_negative", 0)), align="R", ln=1)

    # ── Ertraege ──
    _section(pdf, "Ertraege & Quellensteuer")
    _kv_rows(pdf, [
        ("Dividenden gesamt", _eur(inc.get("dividends"))),
        ("  davon inlaendisch (Z.7)", _eur(inc.get("dividends_de")), False, (110, 110, 110)),
        ("  davon auslaendisch (Z.19)", _eur(inc.get("dividends_foreign")), False, (110, 110, 110)),
        ("Zinsen", _eur(inc.get("interest"))),
        ("gezahlte Zinsen (nicht abzugsfaehig §20 Abs. 9)", _eur(inc.get("interest_paid")), False, (110, 110, 110)),
        ("Auslaendische Quellensteuer (anrechenbar)", _eur(inc.get("wht_foreign")), False, _GREEN),
        ("Inlaendische Quellensteuer", _eur(inc.get("wht_domestic")), False, (110, 110, 110)),
    ])

    # ── Journal ──
    journal = year_data.get("journal", {})
    if journal:
        _journal(pdf, journal)

    out = pdf.output()
    return bytes(out)
