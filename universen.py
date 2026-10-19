"""
universen.py — Mitgliederlisten der Screening-Märkte, ohne Scraping
====================================================================
Der Screener rechnet seine Filter selbst aus Tageskursen (markt.py sammelt sie).
Welche Werte überhaupt dazugehören, kommt aus Dateien, die die Herausgeber zum
Herunterladen anbieten — keine Webseiten, deren Aufbau sich ändert:

  us        Nasdaq-Symbolverzeichnis (nasdaqlisted.txt + otherlisted.txt, per FTP):
            alle US-Notierungen, täglich neu, IPOs ab dem ersten Handelstag.
  stoxx600  Bestandsliste des iShares STOXX Europe 600 UCITS ETF (CSV).
  mdax/sdax Instrumentenliste von Xetra (Deutsche Börse, CSV); die Spalte
            „Product Assignment Group" nennt den Index.
  tsx       Bestandsliste des iShares Core S&P/TSX Capped Composite ETF (CSV).

Finviz kennt nur US-Notierungen; Kanada und Europa gäbe es dort ohnehin nicht.

Jeder Eintrag wird auf das Yahoo-Symbol übersetzt, unter dem markt.py die Kurse
holt. Ergebnis je Markt: Liste von Dicts {symbol, name, land, quelle[, sektor]};
quelle ist das Kürzel der Quelle bzw. bei Xetra die ISIN (für die Nachsuche,
wenn Yahoo ein Kürzel anders führt — TUI: Xetra TUIA, Yahoo TUI1.DE).
"""

import csv
import gzip
import io
import re
import urllib.request

_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")

QUELLEN = {
    # FTP zuerst: die Webseite schickt nach ein paar Abrufen von derselben IP eine
    # Bot-Prüfseite (Incapsula) statt der Datei; der FTP-Server liefert dieselbe Datei
    "nasdaq": ["ftp://ftp.nasdaqtrader.com/symboldirectory/nasdaqlisted.txt",
               "https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt"],
    "other":  ["ftp://ftp.nasdaqtrader.com/symboldirectory/otherlisted.txt",
               "https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt"],
    "stoxx600": ("https://www.ishares.com/uk/professionals/en/products/349428/"
                 "ishares-stoxx-europe-600-ucits-etf/latest-holdings.csv"),
    "xetra":  ("https://www.xetra.com/resource/blob/1528/856720963dadeaf95e4979e9b8c0e21b/"
               "data/t7-xetr-allTradableInstruments.csv"),
    "tsx":    ("https://www.blackrock.com/ca/investors/en/products/239837/"
               "ishares-sptsx-capped-composite-index-etf/1464253357814.ajax"
               "?fileType=csv&fileName=XIC_holdings&dataType=fund"),
}

# Börse laut iShares-Bestandsliste → Yahoo-Suffix
_SUFFIX = {
    "London Stock Exchange":                    ".L",
    "Nyse Euronext - Euronext Paris":           ".PA",
    "Xetra":                                    ".DE",
    "Deutsche Boerse Xetra":                    ".DE",
    "SIX Swiss Exchange":                       ".SW",
    "Nasdaq Omx Nordic":                        ".ST",   # Stockholm
    "Borsa Italiana":                           ".MI",
    "Euronext Amsterdam":                       ".AS",
    "Bolsa De Madrid":                          ".MC",
    "Omx Nordic Exchange Copenhagen A/S":       ".CO",
    "Oslo Bors Asa":                            ".OL",
    "Nasdaq Omx Helsinki Ltd.":                 ".HE",
    "Warsaw Stock Exchange/Equities/Main Market": ".WA",
    "Nyse Euronext - Euronext Brussels":        ".BR",
    "Athens Exchange S.A. Cash Market":         ".AT",
    "Wiener Boerse Ag":                         ".VI",
    "Irish Stock Exchange - All Market":        ".IR",
    "Nyse Euronext - Euronext Lisbon":          ".LS",
    "Toronto Stock Exchange":                   ".TO",
}

# US-Verzeichnis: was keine Stammaktie ist. ADRs („American Depositary Shares")
# bleiben drin — so sind ausländische Werte mit US-Notierung vertreten.
_US_KEINE_AKTIE = re.compile(
    r"\b(warrants?|units?|rights?|preferred|preference|notes? due|debentures?|"
    r"subordinated|perpetual|trust preferred|depositary shares,? each representing a "
    r"1/\d+|% )", re.I)


# GICS-Sektoren der iShares-Listen → die Namen, die Yahoo (und damit Heatmap und
# Screener-Baskets) verwenden
_GICS = {
    "Information Technology": "Technology",       "Financials": "Financial Services",
    "Health Care": "Healthcare",                  "Consumer Discretionary": "Consumer Cyclical",
    "Consumer Staples": "Consumer Defensive",     "Communication": "Communication Services",
    "Communication Services": "Communication Services", "Materials": "Basic Materials",
    "Industrials": "Industrials",                  "Energy": "Energy",
    "Utilities": "Utilities",                      "Real Estate": "Real Estate",
}


class QuelleFehler(Exception):
    """Eine Liste kam nicht oder unvollständig an. markt.py ersetzt dann die
    alte Liste nicht — eine halbe Liste würde Werte aus der Sammlung werfen."""


def _hole(url, timeout: int = 60) -> str:
    """Datei holen; bei einer Liste von Adressen die erste, die eine Datei liefert."""
    if isinstance(url, (list, tuple)):
        fehler = None
        for u in url:
            try:
                return _hole(u, timeout)
            except Exception as e:
                fehler = fehler or e
        raise QuelleFehler(f"keine Quelle erreichbar: {fehler}")
    if url.startswith("ftp://"):
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return r.read().decode("utf-8-sig", "replace")
    req = urllib.request.Request(url, headers={"User-Agent": _UA, "Accept-Language": "en"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        roh = r.read()
    if roh[:2] == b"\x1f\x8b":
        roh = gzip.decompress(roh)
    text = roh.decode("utf-8-sig", "replace")
    if text.lstrip()[:15].lower().startswith(("<!doctype", "<html")):
        raise QuelleFehler(f"HTML statt Datei: {url}")
    return text


def _csv_ab(text: str, kopf_beginnt: str, trenner: str = ",") -> list[dict]:
    """CSV ab der Kopfzeile lesen (iShares und Xetra setzen Kopfzeilen davor)."""
    zeilen = text.splitlines()
    for i, z in enumerate(zeilen[:30]):
        if z.startswith(kopf_beginnt):
            return list(csv.DictReader(io.StringIO("\n".join(zeilen[i:])), delimiter=trenner))
    raise QuelleFehler(f"Kopfzeile „{kopf_beginnt}…“ nicht gefunden")


# ── USA ─────────────────────────────────────────────────────────────────────────
def _us() -> list[dict]:
    out = []
    # nasdaqlisted: Symbol|Security Name|Market Category|Test Issue|Financial Status|Round Lot Size|ETF|NextShares
    for r in csv.DictReader(io.StringIO(_hole(QUELLEN["nasdaq"])), delimiter="|"):
        if r.get("Symbol", "").startswith("File Creation Time"):
            continue
        if r.get("ETF") != "N" or r.get("Test Issue") != "N" or r.get("NextShares") == "Y":
            continue
        out.append((r["Symbol"], r["Security Name"]))
    # otherlisted: ACT Symbol|Security Name|Exchange|CQS Symbol|ETF|Round Lot Size|Test Issue|NASDAQ Symbol
    for r in csv.DictReader(io.StringIO(_hole(QUELLEN["other"])), delimiter="|"):
        if r.get("ACT Symbol", "").startswith("File Creation Time"):
            continue
        if r.get("ETF") != "N" or r.get("Test Issue") != "N":
            continue
        out.append((r["ACT Symbol"], r["Security Name"]))
    liste, gesehen = [], set()
    for sym, name in out:
        if not sym or "$" in sym or "=" in sym or _US_KEINE_AKTIE.search(name or ""):
            continue
        y = sym.replace(".", "-")                      # BRK.A → BRK-A
        if y in gesehen:
            continue
        gesehen.add(y)
        liste.append({"symbol": y, "name": name, "land": "USA", "quelle": sym})
    if len(liste) < 3000:
        raise QuelleFehler(f"US-Verzeichnis: nur {len(liste)} Aktien")
    return liste


# ── iShares-Bestandslisten (STOXX 600, TSX) ─────────────────────────────────────
def _yahoo_aus_ishares(ticker: str, boerse: str) -> str | None:
    suffix = _SUFFIX.get(boerse)
    if not suffix or not ticker:
        return None
    t = ticker.strip().upper()
    if suffix == ".L":
        t = t.rstrip(".")                              # RR. → RR, BT.A → BT-A
    t = re.sub(r"[ .]", "-", t)                        # INVE B → INVE-B, AP.UN → AP-UN
    return t + suffix


def _ishares(url: str, mindestens: int) -> list[dict]:
    zeilen = _csv_ab(_hole(url), "Ticker,")
    liste, gesehen, fremd = [], set(), set()
    for r in zeilen:
        if r.get("Asset Class") != "Equity":
            continue
        try:
            if float((r.get("Price") or "0").replace(",", "")) <= 0:
                continue                               # Abwicklungsposten ohne Kurs
        except ValueError:
            continue
        y = _yahoo_aus_ishares(r.get("Ticker"), r.get("Exchange"))
        if not y:
            fremd.add(r.get("Exchange"))
            continue
        if y in gesehen:
            continue
        gesehen.add(y)
        liste.append({"symbol": y, "name": (r.get("Name") or "").title(),
                      "land": r.get("Location") or None, "quelle": r.get("Ticker"),
                      "sektor": _GICS.get(r.get("Sector") or "")})
    if len(liste) < mindestens:
        raise QuelleFehler(f"nur {len(liste)} Werte (unbekannte Börsen: {sorted(fremd)})")
    return liste


def _stoxx600() -> list[dict]:
    return _ishares(QUELLEN["stoxx600"], 550)


def _tsx() -> list[dict]:
    return _ishares(QUELLEN["tsx"], 200)


# ── Xetra (MDAX, SDAX) ──────────────────────────────────────────────────────────
_xetra_cache: dict = {}

def _xetra(gruppe: str, mindestens: int) -> list[dict]:
    if "zeilen" not in _xetra_cache:                   # einmal je Auffrischung
        _xetra_cache["zeilen"] = _csv_ab(_hole(QUELLEN["xetra"]), "Product Status;", ";")
    liste = []
    for r in _xetra_cache["zeilen"]:
        if r.get("Instrument Type") != "CS" or r.get("Product Assignment Group Description") != gruppe:
            continue
        if r.get("Instrument Status") != "Active" or not r.get("Mnemonic"):
            continue
        liste.append({"symbol": r["Mnemonic"].strip().upper() + ".DE",
                      "name": (r.get("Instrument") or "").title(), "land": "Deutschland",
                      "quelle": r.get("ISIN")})
    if len(liste) < mindestens:
        raise QuelleFehler(f"Xetra {gruppe}: nur {len(liste)} Werte")
    return liste


UNIVERSEN = {   # id → (Anzeigename, Ladefunktion)
    "us":       ("USA (alle Aktien)",  _us),
    "stoxx600": ("STOXX Europe 600",   _stoxx600),
    "mdax":     ("MDAX",               lambda: _xetra("MDAX", 45)),
    "sdax":     ("SDAX",               lambda: _xetra("SDAX", 60)),
    "tsx":      ("S&P/TSX Composite",  _tsx),
}


def laden(uid: str) -> list[dict]:
    """Mitglieder eines Markts. Wirft QuelleFehler, wenn die Liste nicht taugt."""
    return UNIVERSEN[uid][1]()


def neu_laden():
    """Zwischenspeicher leeren — vor jeder Auffrischungsrunde."""
    _xetra_cache.clear()
