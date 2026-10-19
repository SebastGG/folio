"""
markt.py — Marktdaten ganzer Indizes: Stundenkerzen sammeln, Tageskurse für die Heatmap
========================================================================================
Ein Hintergrund-Thread holt einmal je Handelstag, nach dem Ende der Nachbörse, für alle
Werte aus S&P 500, Nasdaq-100 und Russell 2000 (dazu SPY/QQQ/IWM/DIA und die Sektor-ETFs)
die Stundenkerzen samt Vor- und Nachbörse und die Tageskerzen bei Yahoo. Beim ersten Mal
reicht er so weit zurück, wie Yahoo Stundenkerzen herausgibt: 730 Tage. Was älter wird,
gibt es dort nie wieder — deshalb wird gesammelt statt bei Bedarf abgefragt.

Ablage, gemeinsam für alle Benutzer (es sind Marktdaten, keine persönlichen):
  {BASE}/_markt/markt.db              Indexlisten, Sammelstand, Tageskerzen (Aufbau wie prices.db)
  {BASE}/_markt/stunden/JJJJ-MM.db    Stundenkerzen, eine Datei je Monat (UTC)

Eine Datei je Monat, damit eine Sicherung nur den laufenden Monat neu übertragen muss:
abgeschlossene Monate ändern sich nicht mehr, außer bei einem Aktiensplit.

24-Stunden-Handel: Gespeichert werden Zeitstempel, keine festen Handelszeiten. Die Sitzung
jeder Kerze (regulär / Vorbörse / Nachbörse / sonst) kommt aus Yahoos `tradingPeriods`.
Was in keine dieser Spannen fällt, bekommt „sonst" (3) — liefert Yahoo Nachtkerzen, landen
sie ohne Umbau mit in der Sammlung.

Daneben eine zweite, reine Tagesrunde für die Screening-Märkte (universen.py): US-Gesamtmarkt,
STOXX Europe 600, MDAX, SDAX und S&P/TSX Composite — nur Tageskerzen, dazu Marktkapitalisierung,
Börsengang und Sektor. Sie läuft Mo–Fr um TAGES_UM Berliner Zeit, nach US-Schluss und klar vor
dem nächtlichen Backup. Der Screener rechnet seine Filter daraus selbst.

Yahoo drosselt inoffiziell (HTTP 429). Der Sammler läuft deshalb bewusst langsam, und nach
wiederholter Drosselung bricht er die Runde ab und versucht es eine Stunde später — die
normalen Kurs-Updates der Benutzer laufen über dieselbe Server-IP und sollen nicht leiden.
"""

import os
import re
import json
import math
import time
import bisect
import shutil
import sqlite3
import calendar
import datetime
import threading
import collections
import urllib.parse
import urllib.error
import urllib.request

import screener   # Finviz: Seiten holen, Ticker und Trefferzahl lesen
import universen  # Mitgliederlisten der Screening-Märkte

try:
    from zoneinfo import ZoneInfo
    _NY = ZoneInfo("America/New_York")
    _BERLIN = ZoneInfo("Europe/Berlin")
except Exception:          # ohne Zeitzonendaten: Sommerzeitregel unten von Hand
    ZoneInfo = None
    _NY = None
    _BERLIN = None


# ── Einstellungen ───────────────────────────────────────────────────────────────
LISTEN = {                    # id → (Anzeigename, Finviz-Filter)
    "sp500": ("S&P 500",      "idx_sp500"),
    "ndx":   ("Nasdaq-100",   "idx_ndx"),
    "rut":   ("Russell 2000", "idx_rut"),
}
REFERENZ = ["SPY", "QQQ", "IWM", "DIA",
            "XLB", "XLC", "XLE", "XLF", "XLI", "XLK", "XLP", "XLRE", "XLU", "XLV", "XLY"]

STUNDEN_TAGE  = 729            # Yahoo gibt Stundenkerzen nur für die letzten 730 Tage heraus
TAGE_START    = 400            # Tageskerzen für neue Werte (Heatmap braucht ≤ 300 Handelstage)
UEBERLAPP_H   = 3 * 86400      # so weit schreibt jeder Abruf rückwärts neu (Teilkerzen, Splits)
UEBERLAPP_D   = 10 * 86400
RUNDE_UM      = (20, 30)       # New Yorker Zeit — die Nachbörse endet um 20:00
LISTEN_ALTER  = 7 * 86400      # Indexlisten wöchentlich neu
ABRUF_HALTEN  = 60 * 86400     # einzeln im Chart angesehene Werte so lange mitsammeln
PAUSE         = 0.35           # Sekunden zwischen zwei Yahoo-Abrufen des Sammlers
LIVE_ALTER    = 600            # Heatmap-Kurse frühestens nach 10 Minuten wieder holen
FRISCH_CHART  = 900            # Stundenkerzen im Chart: älter als 15 min → nachladen
DROSSEL_MAX   = 3              # so oft gedrosselt → Runde abbrechen
MIN_FREI      = 2 * 1024 ** 3  # weniger freier Platz → Sammeln pausiert von selbst
SKALA         = 10000          # Kurse als ganze Zahlen in 1/10000 — spart ein Drittel Platz

# Tagesrunde der Screening-Märkte
TAGES_UM      = (22, 30)       # Berliner Zeit: US-Schluss ist spätestens 22:00, Europa 17:30
TAGES_LISTEN_ALTER = 20 * 3600 # Mitgliederlisten täglich (Nasdaq-Verzeichnis: IPOs)
TAGE_FRISCH   = 6 * 3600       # so frisch geholte Tageskerzen lässt die Stundenrunde liegen
SEKTOR_JE_NACHT = 500          # Sektor einzeln bei Yahoo nachfragen: höchstens so viele je Runde
SEKTOR_NEU_NACH = 30 * 86400   # ohne Ergebnis frühestens nach 30 Tagen wieder fragen
QUOTE_JE_ABRUF = 150           # Werte je Yahoo-Sammelabruf (Marktkap., Börsengang)
# Wechselkurse für die Marktkapitalisierung in USD (Screener-Filter)
FX_PAARE      = ["EURUSD=X", "GBPUSD=X", "CHFUSD=X", "SEKUSD=X", "DKKUSD=X",
                 "NOKUSD=X", "PLNUSD=X", "CADUSD=X"]

_SYMBOL_RE = re.compile(r"^[A-Z0-9^][A-Z0-9.\-=^]{0,14}$")

VERZ = None                    # {BASE}/_markt — gesetzt von start()
_init_db = None                # main.init_db (Tabellen prices, ticker_info, …)

_stop      = threading.Event()
_wecker    = threading.Event()
_schreiben = threading.Lock()  # Split-Prüfung + Schreiben eines Werts nicht verschränken
_thread    = None
_log       = collections.deque(maxlen=300)
_runde     = {"laeuft": False}
_tagesrunde = {"laeuft": False}
_live      = {"laeuft": False}
_drossel_ensure: dict = {}
_drossel_lock = threading.Lock()


class Gedrosselt(Exception):
    """Yahoo oder Finviz verweigern wegen zu vieler Anfragen."""


# ── Protokoll ───────────────────────────────────────────────────────────────────
def log(stufe: int, text: str):
    """stufe wie im Laufprotokoll der Oberfläche: 1 Fehler, 2 Warnung, 4 Ablauf, 7 Detail."""
    _log.append((time.time(), stufe, text))
    if stufe <= 2:
        print(f"markt: {text}")


# ── Ablage ──────────────────────────────────────────────────────────────────────
def _pfad_markt() -> str:
    return os.path.join(VERZ, "markt.db")

def _pfad_stunden(monat: str) -> str:
    return os.path.join(VERZ, "stunden", monat + ".db")

def _db(pfad: str) -> sqlite3.Connection:
    conn = sqlite3.connect(pfad, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=30000")
    return conn

def markt_db() -> str:
    """Pfad der Datenbank mit den Tageskerzen — gleicher Aufbau wie prices.db."""
    return _pfad_markt()

def _einrichten():
    os.makedirs(os.path.join(VERZ, "stunden"), exist_ok=True)
    if _init_db:
        _init_db(_pfad_markt())
    conn = _db(_pfad_markt())
    try:
        conn.execute("""CREATE TABLE IF NOT EXISTS mitglied (
            liste  TEXT NOT NULL,
            ticker TEXT NOT NULL,
            PRIMARY KEY (liste, ticker))""")
        conn.execute("""CREATE TABLE IF NOT EXISTS abruf (
            ticker  TEXT PRIMARY KEY,
            zuletzt REAL)""")
        conn.execute("""CREATE TABLE IF NOT EXISTS sammelstand (
            ticker       TEXT PRIMARY KEY,
            tz           TEXT,
            letzte_h     INTEGER,   -- jüngste gespeicherte Stundenkerze (UTC-Sekunden)
            abruf_h      REAL,      -- letzter erfolgreicher Abruf der Stundenkerzen
            abruf_d      REAL,      -- letzter erfolgreicher Abruf der Tageskerzen
            runde        REAL,      -- in der Runde nach diesem Zeitpunkt erledigt
            fehler       TEXT,
            fehler_zahl  INTEGER DEFAULT 0,
            fehler_zeit  REAL)""")
        conn.execute("""CREATE TABLE IF NOT EXISTS meta (
            k TEXT PRIMARY KEY,
            v TEXT)""")
        # Screening-Märkte (nur Tageskerzen); getrennt von `mitglied`, damit die
        # Stundenrunde bei ihren drei Indizes bleibt
        conn.execute("""CREATE TABLE IF NOT EXISTS tagesmitglied (
            liste  TEXT NOT NULL,
            ticker TEXT NOT NULL,
            quelle TEXT,              -- Kürzel der Quelle bzw. ISIN (Xetra)
            sektor TEXT,              -- aus der Quelle, falls sie einen nennt
            PRIMARY KEY (liste, ticker))""")
        # Kürzel/ISIN der Quelle → Yahoo-Symbol, wenn Yahoo den Wert anders führt
        conn.execute("""CREATE TABLE IF NOT EXISTS alias (
            quelle TEXT PRIMARY KEY,
            ticker TEXT,
            zeit   REAL)""")
        conn.commit()
    finally:
        conn.close()

def _stunden_db(monat: str, anlegen: bool = True):
    pfad = _pfad_stunden(monat)
    if not anlegen and not os.path.exists(pfad):
        return None
    conn = _db(pfad)
    if anlegen:
        conn.execute("""CREATE TABLE IF NOT EXISTS kerzen (
            ticker TEXT    NOT NULL,
            ts     INTEGER NOT NULL,   -- Beginn der Kerze, UTC-Sekunden
            o INTEGER, h INTEGER, l INTEGER, c INTEGER,   -- Kurs × 10000
            v INTEGER,
            s INTEGER,                 -- Sitzung: 0 regulär, 1 Vorbörse, 2 Nachbörse, 3 sonst
            PRIMARY KEY (ticker, ts)) WITHOUT ROWID""")
    return conn

def _monat(ts: int) -> str:
    return time.strftime("%Y-%m", time.gmtime(ts))

def _monate() -> list:
    try:
        return sorted(f[:-3] for f in os.listdir(os.path.join(VERZ, "stunden"))
                      if re.match(r"^\d{4}-\d{2}\.db$", f))
    except FileNotFoundError:
        return []

def _meta(conn, k, vorgabe=None):
    r = conn.execute("SELECT v FROM meta WHERE k=?", (k,)).fetchone()
    return r["v"] if r else vorgabe

def _meta_setzen(conn, k, v):
    conn.execute("INSERT OR REPLACE INTO meta VALUES (?,?)", (k, None if v is None else str(v)))

def _meta_zahl(conn, k) -> float:
    try:
        return float(_meta(conn, k) or 0)
    except ValueError:
        return 0.0


# ── Zeit ────────────────────────────────────────────────────────────────────────
def _ny(ts: float) -> datetime.datetime:
    """New Yorker Ortszeit eines Zeitstempels (naiv)."""
    if _NY:
        return datetime.datetime.fromtimestamp(ts, _NY).replace(tzinfo=None)
    # Ersatz ohne Zeitzonendaten: Sommerzeit vom 2. Sonntag im März bis 1. Sonntag im November
    u = datetime.datetime.utcfromtimestamp(ts)
    def sonntag(jahr, monat, nr):
        d = datetime.datetime(jahr, monat, 1)
        d += datetime.timedelta(days=(6 - d.weekday()) % 7 + 7 * (nr - 1))
        return d
    beginn = sonntag(u.year, 3, 2) + datetime.timedelta(hours=7)    # 2:00 EST = 7:00 UTC
    ende   = sonntag(u.year, 11, 1) + datetime.timedelta(hours=6)   # 2:00 EDT = 6:00 UTC
    return u - datetime.timedelta(hours=4 if beginn <= u < ende else 5)

def _ny_zu_ts(lokal: datetime.datetime) -> float:
    if _NY:
        return lokal.replace(tzinfo=_NY).timestamp()
    for stunden in (4, 5):                  # beide Versätze probieren, der passende bleibt
        ts = calendar.timegm((lokal + datetime.timedelta(hours=stunden)).timetuple())
        if _ny(ts) == lokal:
            return ts
    return calendar.timegm((lokal + datetime.timedelta(hours=5)).timetuple())

def _letzter_termin(jetzt: float) -> float:
    """Jüngster planmäßige Rundenbeginn ≤ jetzt: Mo–Fr um RUNDE_UM New Yorker Zeit."""
    lokal = _ny(jetzt)
    d = lokal.replace(hour=RUNDE_UM[0], minute=RUNDE_UM[1], second=0, microsecond=0)
    if d > lokal:
        d -= datetime.timedelta(days=1)
    while d.weekday() >= 5:
        d -= datetime.timedelta(days=1)
    return _ny_zu_ts(d)

def _naechster_termin(jetzt: float) -> float:
    lokal = _ny(jetzt)
    d = lokal.replace(hour=RUNDE_UM[0], minute=RUNDE_UM[1], second=0, microsecond=0)
    if d <= lokal:
        d += datetime.timedelta(days=1)
    while d.weekday() >= 5:
        d += datetime.timedelta(days=1)
    return _ny_zu_ts(d)

def _berlin(ts: float) -> datetime.datetime:
    """Berliner Ortszeit eines Zeitstempels (naiv)."""
    if _BERLIN:
        return datetime.datetime.fromtimestamp(ts, _BERLIN).replace(tzinfo=None)
    # Ersatz: Sommerzeit vom letzten Sonntag im März bis zum letzten im Oktober, je 1:00 UTC
    u = datetime.datetime.utcfromtimestamp(ts)
    def letzter_sonntag(monat):
        d = datetime.datetime(u.year, monat, 31)
        return d - datetime.timedelta(days=(d.weekday() + 1) % 7)
    sommer = letzter_sonntag(3) + datetime.timedelta(hours=1) <= u < letzter_sonntag(10) + datetime.timedelta(hours=1)
    return u + datetime.timedelta(hours=2 if sommer else 1)

def _berlin_zu_ts(lokal: datetime.datetime) -> float:
    if _BERLIN:
        return lokal.replace(tzinfo=_BERLIN).timestamp()
    for stunden in (2, 1):
        ts = calendar.timegm((lokal - datetime.timedelta(hours=stunden)).timetuple())
        if _berlin(ts) == lokal:
            return ts
    return calendar.timegm((lokal - datetime.timedelta(hours=1)).timetuple())

def _tagestermin(jetzt: float, richtung: int) -> float:
    """Letzter (richtung −1) bzw. nächster (+1) Termin der Tagesrunde: Mo–Fr um TAGES_UM Berlin."""
    lokal = _berlin(jetzt)
    d = lokal.replace(hour=TAGES_UM[0], minute=TAGES_UM[1], second=0, microsecond=0)
    if richtung < 0 and d > lokal:
        d -= datetime.timedelta(days=1)
    if richtung > 0 and d <= lokal:
        d += datetime.timedelta(days=1)
    while d.weekday() >= 5:
        d += datetime.timedelta(days=richtung)
    return _berlin_zu_ts(d)

def markt_offen(jetzt: float = None) -> bool:
    """Reguläre US-Sitzung (mit einer Stunde Nachlauf für die Schlusskurse)."""
    lokal = _ny(jetzt or time.time())
    if lokal.weekday() >= 5:
        return False
    m = lokal.hour * 60 + lokal.minute
    return 9 * 60 + 30 <= m < 17 * 60


# ── Yahoo ───────────────────────────────────────────────────────────────────────
def _hole_json(url: str, timeout: int = 25) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        if e.code in (429, 999, 503):
            raise Gedrosselt(f"HTTP {e.code}")
        beschreibung = ""
        try:
            fehler = (json.loads(e.read()).get("chart") or {}).get("error") or {}
            beschreibung = fehler.get("description") or ""
        except Exception:
            pass
        raise RuntimeError(f"HTTP {e.code}" + (f": {beschreibung}" if beschreibung else ""))

def _chart(sym: str, intervall: str, von: float, bis: float, prepost: bool) -> dict:
    url = (f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(sym)}"
           f"?interval={intervall}&period1={int(von)}&period2={int(bis)}"
           f"&includePrePost={'true' if prepost else 'false'}")
    for versuch in range(2):
        try:
            d = _hole_json(url)
        except (Gedrosselt, RuntimeError):
            raise
        except Exception as e:                       # Netz, Zeitüberschreitung, JSON
            if versuch:
                raise RuntimeError(f"Yahoo nicht erreichbar: {e}")
            time.sleep(2)
            continue
        ch = d.get("chart") or {}
        if ch.get("error"):
            raise RuntimeError(f"Yahoo: {ch['error'].get('description') or ch['error']}")
        res = ch.get("result") or []
        if not res:
            raise RuntimeError("Yahoo: leere Antwort")
        return res[0]
    raise RuntimeError("Yahoo nicht erreichbar")

def _quote_reihen(r: dict):
    ts = r.get("timestamp") or []
    q = ((r.get("indicators") or {}).get("quote") or [{}])[0] or {}
    leer = [None] * len(ts)
    return ts, [q.get(k) or leer for k in ("open", "high", "low", "close", "volume")]


# ── Sitzungen ───────────────────────────────────────────────────────────────────
def _perioden(meta: dict) -> list:
    """[(start, ende, sitzung)] aufsteigend aus Yahoos tradingPeriods."""
    tp = meta.get("tradingPeriods")
    out = []
    def rein(eintraege, s):
        for tag in eintraege or []:
            for p in (tag if isinstance(tag, list) else [tag]):
                if isinstance(p, dict) and p.get("start") and p.get("end"):
                    out.append((int(p["start"]), int(p["end"]), s))
    if isinstance(tp, dict):
        rein(tp.get("regular"), 0)
        rein(tp.get("pre"), 1)
        rein(tp.get("post"), 2)
    elif isinstance(tp, list):           # ohne includePrePost: nur reguläre Sitzungen
        rein(tp, 0)
    out.sort()
    return out

def _sitzungs_rechner(meta: dict):
    """Funktion ts → Sitzung (0 regulär, 1 vor, 2 nach, 3 sonst)."""
    perioden = _perioden(meta)
    if perioden:
        starts = [p[0] for p in perioden]
        def sitzung(t):
            i = bisect.bisect_right(starts, t) - 1
            if i >= 0 and perioden[i][0] <= t < perioden[i][1]:
                return perioden[i][2]
            return 3
        return sitzung
    # Ersatz: Uhrzeiten der heutigen Sitzungen auf jeden Tag übertragen
    ctp = meta.get("currentTradingPeriod") or {}
    tzname = meta.get("exchangeTimezoneName") or ""
    try:
        tz = ZoneInfo(tzname) if ZoneInfo and tzname else None
    except Exception:
        tz = None
    if not tz or not ctp:
        return lambda t: 0
    def minute(ts):
        lt = datetime.datetime.fromtimestamp(ts, tz)
        return lt.hour * 60 + lt.minute
    grenzen = []
    for name, s in (("regular", 0), ("pre", 1), ("post", 2)):
        p = ctp.get(name) or {}
        if p.get("start") and p.get("end"):
            grenzen.append((minute(p["start"]), minute(p["end"]) or 1440, s))
    def sitzung(t):
        m = minute(t)
        for a, b, s in grenzen:
            if a <= m < b:
                return s
        return 3
    return sitzung

def _erlaubte_minuten(meta: dict) -> set:
    """Minuten-Versatz in der Stunde, auf dem Kerzen beginnen dürfen.

    Yahoo hängt an die Kerzen ein weiteres Element mit dem Zeitpunkt des letzten
    Kurses an (z. B. 20:44). Das ist keine Kerze; als solche gespeichert, bliebe es
    für immer neben der echten 20:00-Kerze liegen.
    """
    s = {p[0] % 3600 for p in _perioden(meta)}
    return s or {0, 1800}


# ── Splits ──────────────────────────────────────────────────────────────────────
def _split_faktor(paare) -> float | None:
    """Verhältnis alt/neu derselben Kerzen. Yahoo rechnet nach einem Split die ganze
    Historie um; gespeicherte Kerzen liegen dann auf der alten Skala. Eine Abweichung
    von mehr als 15 % auf identischen Zeitpunkten kann nur das sein."""
    rs = sorted(a / n for a, n in paare if a and n and a > 0 and n > 0)
    if len(rs) < 3:
        return None
    m = rs[len(rs) // 2]
    return m if abs(math.log(m)) > math.log(1.15) else None


# ── Stundenkerzen ───────────────────────────────────────────────────────────────
def _stand(conn, sym):
    return conn.execute("SELECT * FROM sammelstand WHERE ticker=?", (sym,)).fetchone()

def _stand_setzen(conn, sym, **felder):
    conn.execute("INSERT OR IGNORE INTO sammelstand (ticker) VALUES (?)", (sym,))
    if felder:
        conn.execute("UPDATE sammelstand SET " + ", ".join(f"{k}=?" for k in felder) +
                     " WHERE ticker=?", (*felder.values(), sym))

def stunden_holen(sym: str) -> int:
    """Holt die Stundenkerzen eines Werts nach (beim ersten Mal 729 Tage).
    Rückgabe: Zahl der geschriebenen Kerzen. Wirft bei Fehlern."""
    jetzt = int(time.time())
    mc = _db(_pfad_markt())
    try:
        st = _stand(mc, sym)
        frueheste = jetzt - STUNDEN_TAGE * 86400
        von = max(st["letzte_h"] - UEBERLAPP_H, frueheste) if st and st["letzte_h"] else frueheste
        r = _chart(sym, "1h", von, jetzt, True)
        meta = r.get("meta") or {}
        ts, (o, h, l, c, v) = _quote_reihen(r)
        sitzung = _sitzungs_rechner(meta)
        erlaubt = _erlaubte_minuten(meta)
        kerzen = []
        for i, t in enumerate(ts):
            if None in (o[i], h[i], l[i], c[i]) or c[i] <= 0 or (t % 3600) not in erlaubt:
                continue
            kerzen.append((sym, int(t), round(o[i] * SKALA), round(h[i] * SKALA),
                           round(l[i] * SKALA), round(c[i] * SKALA),
                           int(v[i]) if v[i] is not None else None, sitzung(t)))
        with _schreiben:
            if kerzen:
                _stunden_split_pruefen(sym, kerzen)
                nach_monat = collections.defaultdict(list)
                for k in kerzen:
                    nach_monat[_monat(k[1])].append(k)
                for monat, zeilen in nach_monat.items():
                    sc = _stunden_db(monat)
                    try:
                        sc.executemany("INSERT OR REPLACE INTO kerzen VALUES (?,?,?,?,?,?,?,?)", zeilen)
                        sc.commit()
                    finally:
                        sc.close()
            letzte = max([k[1] for k in kerzen] + [st["letzte_h"] if st and st["letzte_h"] else 0]) or None
            _stand_setzen(mc, sym, tz=meta.get("exchangeTimezoneName") or (st["tz"] if st else None),
                          letzte_h=letzte, abruf_h=time.time())
            mc.commit()
        return len(kerzen)
    finally:
        mc.close()

def _stunden_split_pruefen(sym: str, kerzen: list):
    """Vergleicht neue mit gespeicherten Kerzen derselben Zeitpunkte; bei einem Split
    werden alle älteren gespeicherten Kerzen umgerechnet. Läuft unter _schreiben."""
    neu = {k[1]: k[5] for k in kerzen}
    erste = min(neu)
    paare = []
    for monat in sorted({_monat(t) for t in neu}):
        sc = _stunden_db(monat, anlegen=False)
        if not sc:
            continue
        try:
            for r in sc.execute("SELECT ts, c FROM kerzen WHERE ticker=? AND ts>=?", (sym, erste)):
                if r["ts"] in neu:
                    paare.append((r["c"], neu[r["ts"]]))
        except sqlite3.OperationalError:
            pass
        finally:
            sc.close()
    f = _split_faktor(paare)
    if not f:
        return
    bis_monat = _monat(erste)
    for monat in _monate():
        if monat > bis_monat:
            break
        sc = _stunden_db(monat)
        try:
            sc.execute("UPDATE kerzen SET o=CAST(ROUND(o/?) AS INTEGER), h=CAST(ROUND(h/?) AS INTEGER), "
                       "l=CAST(ROUND(l/?) AS INTEGER), c=CAST(ROUND(c/?) AS INTEGER), "
                       "v=CAST(ROUND(v*?) AS INTEGER) WHERE ticker=? AND ts<?",
                       (f, f, f, f, f, sym, erste))
            sc.commit()
        finally:
            sc.close()
    log(2, f"{sym}: Split erkannt (Faktor {f:.4g}) — ältere Stundenkerzen umgerechnet")

def stunden_lesen(sym: str) -> list:
    """Alle gespeicherten Stundenkerzen: [[ts, o, h, l, c, v, s], …] aufsteigend."""
    ab = _monat(int(time.time()) - (STUNDEN_TAGE + 31) * 86400)
    out = []
    for monat in _monate():
        if monat < ab:
            continue
        sc = _stunden_db(monat, anlegen=False)
        if not sc:
            continue
        try:
            for r in sc.execute("SELECT ts,o,h,l,c,v,s FROM kerzen WHERE ticker=? ORDER BY ts", (sym,)):
                out.append([r[0], r[1] / SKALA, r[2] / SKALA, r[3] / SKALA, r[4] / SKALA, r[5], r[6]])
        except sqlite3.OperationalError:
            pass
        finally:
            sc.close()
    return out

DOCHT_MAX = 2.0     # Docht außerhalb der Sitzung höchstens 2 × übliche Stundenspanne
DOCHT_TAGE = 20     # übliche Spanne: Median der regulären Sitzung über so viele Handelstage

def dochte_kappen(kerzen: list) -> list:
    """Kappt Ausreißer-Dochte der Kerzen außerhalb der regulären Sitzung.

    Yahoo übernimmt in Vor- und Nachbörse jeden gemeldeten Kurs ins Hoch/Tief, auch
    offensichtliche Fehlkurse: MSFT am 30.09.2026 um 17:05 New York mit Tief 412,92 bei
    einem Kurs von 513, NVDA tags darauf 169,85 statt 231 — Volumen jeweils 0, Eröffnung
    und Schluss der Kerze normal. Bei großen US-Werten hat so jede fünfte Kerze außerhalb
    der Sitzung einen Docht über dem Fünffachen der üblichen Stundenspanne; in der
    regulären Sitzung bleiben 99 % unter dem Doppelten.

    Der Docht darf deshalb höchstens DOCHT_MAX × die übliche Spanne (Median der regulären
    Stundenkerzen der letzten DOCHT_TAGE Handelstage) über den Körper hinausreichen. Echte
    große Bewegungen (Quartalszahlen) stecken im Körper und bleiben. Reguläre Kerzen
    bleiben unverändert, gespeichert wird immer das Original.
    """
    if not kerzen:
        return kerzen
    # Mediane Spanne je Handelstag (UTC-Tag genügt: eine reguläre US-Sitzung liegt ganz in einem)
    je_tag = collections.OrderedDict()
    for t, o, h, l, c, v, s in kerzen:
        if s == 0 and c:
            je_tag.setdefault(t // 86400, []).append((h - l) / c)
    tage = list(je_tag.keys())
    tag_median = [sorted(x)[len(x) // 2] for x in je_tag.values()]
    def spanne(t):
        i = bisect.bisect_right(tage, t // 86400)          # Tage bis einschließlich heute
        fenster = sorted(tag_median[max(0, i - DOCHT_TAGE):i] or tag_median[:DOCHT_TAGE])
        return fenster[len(fenster) // 2] if fenster else None
    out = []
    for k in kerzen:
        t, o, h, l, c, v, s = k
        if s != 0:
            r = spanne(t)
            if r:
                hoch, tief = max(o, c), min(o, c)
                h = min(h, hoch * (1 + DOCHT_MAX * r))
                l = max(l, tief * (1 - DOCHT_MAX * r))
                k = [t, o, max(h, hoch), min(l, tief), c, v, s]
        out.append(k)
    return out

def stunden_fuer_chart(sym: str) -> dict:
    """Für /api/stunden: bei Bedarf nachladen (höchstens einmal je Minute und Wert),
    den Wert in die tägliche Sammlung aufnehmen und alles Gespeicherte liefern."""
    sym = (sym or "").strip().upper()
    if not _SYMBOL_RE.match(sym):
        return {"ok": False, "error": "Ungültiges Symbol"}
    mc = _db(_pfad_markt())
    try:
        st = _stand(mc, sym)
    finally:
        mc.close()
    fehler = None
    alt = not st or not st["abruf_h"] or time.time() - st["abruf_h"] > FRISCH_CHART
    if alt:
        with _drossel_lock:
            darf = time.time() - _drossel_ensure.get(sym, 0) >= 60
            if darf:
                _drossel_ensure[sym] = time.time()
        if darf:
            try:
                n = stunden_holen(sym)
                log(7, f"{sym}: {n} Stundenkerzen für den Chart nachgeladen")
            except Exception as e:
                fehler = str(e)
                log(2, f"{sym}: Stundenkerzen nicht abrufbar — {e}")
    mc = _db(_pfad_markt())
    try:
        if not mc.execute("SELECT 1 FROM mitglied WHERE ticker=? LIMIT 1", (sym,)).fetchone() \
                and sym not in REFERENZ:
            mc.execute("INSERT OR REPLACE INTO abruf VALUES (?,?)", (sym, time.time()))
            mc.commit()
        st = _stand(mc, sym)
    finally:
        mc.close()
    return {
        "ok":     True,
        "ticker": sym,
        "tz":     (st["tz"] if st and st["tz"] else "America/New_York"),
        "stand":  st["abruf_h"] if st else None,
        "fehler": fehler,
        "kerzen": dochte_kappen(stunden_lesen(sym)),
    }


# ── Tageskerzen (für die Heatmap der Indizes) ───────────────────────────────────
def tage_holen(sym: str) -> int:
    """Tageskerzen eines Werts in markt.db nachziehen — wie update_ticker, aber ohne den
    zusätzlichen Split-Abruf: Splits erkennt der Vergleich im Überlappungsfenster."""
    jetzt = time.time()
    mc = _db(_pfad_markt())
    try:
        r0 = mc.execute("SELECT MAX(date) d FROM prices WHERE ticker=?", (sym,)).fetchone()
        if r0 and r0["d"]:
            von = calendar.timegm(time.strptime(r0["d"], "%Y-%m-%d")) - UEBERLAPP_D
        else:
            von = jetzt - TAGE_START * 86400
        r = _chart(sym, "1d", von, jetzt, False)
        meta = r.get("meta") or {}
        ts, (o, h, l, c, v) = _quote_reihen(r)
        zeilen = {}
        for i, t in enumerate(ts):
            if None in (o[i], h[i], l[i], c[i]) or c[i] <= 0:
                continue
            d = time.strftime("%Y-%m-%d", time.gmtime(t))
            zeilen[d] = (sym, d, o[i], h[i], l[i], c[i], v[i] or 0)
        # Live-Kurs des laufenden Tages (wie update_ticker): der Tagesbalken hinkt oft hinterher
        preis = meta.get("regularMarketPrice")
        mzeit = meta.get("regularMarketTime") or 0
        heute = time.strftime("%Y-%m-%d", time.gmtime(jetzt))
        if preis and preis > 0 and mzeit and time.strftime("%Y-%m-%d", time.gmtime(mzeit)) == heute \
                and time.gmtime(jetzt).tm_wday < 5:
            alt = zeilen.get(heute)
            vol = meta.get("regularMarketVolume") or 0
            if alt:
                zeilen[heute] = (sym, heute, alt[2], max(alt[3], preis), min(alt[4], preis), preis,
                                 max(alt[6] or 0, vol))
            else:
                hi = meta.get("regularMarketDayHigh") or preis
                lo = meta.get("regularMarketDayLow") or preis
                zeilen[heute] = (sym, heute, preis, max(hi, preis), min(lo, preis), preis, vol)
        with _schreiben:
            if zeilen:
                erste = min(zeilen)
                gespeichert = {x["date"]: x["close"] for x in mc.execute(
                    "SELECT date, close FROM prices WHERE ticker=? AND date>=?", (sym, erste))}
                f = _split_faktor([(gespeichert[d], z[5]) for d, z in zeilen.items() if d in gespeichert])
                if f:
                    mc.execute("UPDATE prices SET open=open/?, high=high/?, low=low/?, close=close/?, "
                               "volume=volume*? WHERE ticker=? AND date<?", (f, f, f, f, f, sym, erste))
                    log(2, f"{sym}: Split erkannt (Faktor {f:.4g}) — ältere Tageskerzen umgerechnet")
                mc.executemany("INSERT OR REPLACE INTO prices VALUES (?,?,?,?,?,?,?)", list(zeilen.values()))
            mc.execute("INSERT OR REPLACE INTO ticker_currency VALUES (?,?)",
                       (sym, meta.get("currency") or "USD"))
            # Ohne Finviz-Stammdaten (Referenz-ETFs, einzeln angesehene Werte) wenigstens Name und Art
            if not mc.execute("SELECT 1 FROM ticker_info WHERE symbol=?", (sym,)).fetchone():
                info = {"symbol": sym, "name": meta.get("longName") or meta.get("shortName") or sym,
                        "quote_type": meta.get("instrumentType"), "currency": meta.get("currency"),
                        "quelle": "yahoo"}
                mc.execute("INSERT OR REPLACE INTO ticker_info VALUES (?,?,?)",
                           (sym, json.dumps(info), time.time()))
            _stand_setzen(mc, sym, abruf_d=time.time())
            mc.commit()
        return len(zeilen)
    finally:
        mc.close()


# ── Indexlisten (Finviz) ────────────────────────────────────────────────────────
def _finviz_seite(url: str):
    for versuch in range(2):
        try:
            return screener._fetch_soup(url)
        except urllib.error.HTTPError as e:
            if e.code == 429 and not versuch:
                _stop.wait(30)
                continue
            if e.code == 429:
                raise Gedrosselt("Finviz HTTP 429")
            raise

def _finviz_abschnitte(code: str):
    """Filter, in die ein Index zerlegt werden muss, und seine Gesamtzahl.

    Ohne Anmeldung blättert Finviz nicht über Treffer 1000 hinaus (ab r=1000 kommt eine
    Cloudflare-Sperre statt der Seite). Die Russell 2000 hat aber knapp 2000 Werte —
    sie wird deshalb nach Sektoren zerlegt, keiner davon kommt in die Nähe von 1000.
    Filter enden auf ein Komma, siehe screener._build_url.
    """
    soup = _finviz_seite(f"https://finviz.com/screener.ashx?v=411&f={code},")
    gesamt = screener._total_hits(soup)
    if gesamt and gesamt <= 1000:
        return [code + ","], gesamt, soup
    return [f"{code},{sek}," for sek in screener.SECTORS.values()], gesamt, None

def _finviz_tickerliste(code: str) -> list:
    """Alle Mitglieder eines Index über die Ticker-Ansicht (bis 1000 je Seite)."""
    abschnitte, gesamt, erste = _finviz_abschnitte(code)
    gesehen, menge = [], set()
    for f in abschnitte:
        if erste is None:
            _stop.wait(1.5)
        soup = erste or _finviz_seite(f"https://finviz.com/screener.ashx?v=411&f={f}")
        erste = None
        for t in screener._extract_tickers(soup):
            if t not in menge:
                menge.add(t)
                gesehen.append(t)
    if not gesamt or len(gesehen) < gesamt * 0.98:
        raise RuntimeError(f"Finviz lieferte {len(gesehen)} von {gesamt or '?'} Werten")
    return gesehen

def _kap(text: str):
    m = re.match(r"^([\d.]+)([KMBT]?)$", (text or "").strip())
    if not m:
        return None
    return float(m.group(1)) * {"": 1, "K": 1e3, "M": 1e6, "B": 1e9, "T": 1e12}[m.group(2)]

def _finviz_stammdaten(code: str) -> dict:
    """Name, Sektor, Branche, Land, Marktkap. aus der Übersicht (20 je Seite)."""
    abschnitte, _gesamt, _erste = _finviz_abschnitte(code)
    out = {}
    for f in abschnitte:
        _stop.wait(1.2)
        _finviz_stammdaten_abschnitt(f, out)
        if _stop.is_set():
            break
    return out

def _finviz_stammdaten_abschnitt(f: str, out: dict):
    gesamt, vorher = None, len(out)
    for seite in range(50):                       # 50 × 20 = die 1000, bis zu denen Finviz blättert
        url = screener.BASE_URL + f + (f"&r={seite * 20 + 1}" if seite else "")
        try:
            soup = _finviz_seite(url)
        except Gedrosselt:
            raise
        except Exception as e:
            log(2, f"Finviz-Stammdaten {f} Seite {seite + 1}: {e}")
            break
        if gesamt is None:
            gesamt = screener._total_hits(soup)
        zeilen = _finviz_zeilen(soup)
        if not zeilen:
            if seite == 0 and gesamt:
                # Finviz meldet Treffer, die Tabelle ist aber nicht lesbar → Seitenaufbau
                # geändert (so im Oktober 2026). Laut melden, statt still nichts zu tun.
                log(1, f"Finviz-Stammdaten {f}: {gesamt} Treffer gemeldet, aber keine Zeile lesbar "
                       f"— Seitenaufbau vermutlich geändert")
            break
        neu = 0
        for sym, feld in zeilen:
            if sym in out:
                continue
            sektor = feld("Sector") or None
            if sektor == "Financial":
                sektor = "Financial Services"     # Yahoos Name — so gruppiert die Heatmap sonst auch
            try:
                kurs = float(feld("Price").replace(",", ""))
            except ValueError:
                kurs = None
            out[sym] = {"name": feld("Company") or None, "sector": sektor,
                        "industry": feld("Industry") or None, "country": feld("Country") or None,
                        "market_cap": _kap(feld("Market Cap")), "kurs": kurs}
            neu += 1
        if not neu or (gesamt and len(out) - vorher >= gesamt):
            break
        _stop.wait(1.2)

# Spalten-IDs der neuen Finviz-Tabelle (fv-table) → Überschriften der alten
_FV_SPALTEN = {"Company": "company", "Sector": "sector", "Industry": "industry",
               "Country": "country", "Market Cap": "marketCap", "Price": "price"}

def _finviz_zeilen(soup) -> list:
    """Zeilen der Übersicht als [(Symbol, feld(Überschrift) → Text)].

    Neue Tabelle (seit Oktober 2026): div-Zeilen mit `data-row-key`, Zellen mit
    `data-column-id`. Alte Tabelle als Rückfall: <tr>/<td> mit `data-boxover-ticker`
    und Spalten nach der Kopfzeile.
    """
    out = []
    for z in soup.find_all(attrs={"role": "row", "data-row-key": True}):
        zellen = {c.get("data-column-id"): c.get_text(" ", strip=True)
                  for c in z.find_all(attrs={"data-column-id": True})}
        out.append((z.get("data-row-key").strip().upper(),
                    lambda name, zellen=zellen: zellen.get(_FV_SPALTEN.get(name, name), "")))
    if out:
        return out
    tabelle = None
    for t in soup.find_all("table"):
        if t.find(attrs={"data-boxover-ticker": True}):
            tabelle = t
    if not tabelle:
        return out
    zeilen = tabelle.find_all("tr")
    kopf = [x.get_text(" ", strip=True) for x in zeilen[0].find_all(["th", "td"])]
    sp = {name: i for i, name in enumerate(kopf)}
    for z in zeilen[1:]:
        zellen = z.find_all("td")
        sym = next((td.get("data-boxover-ticker").strip().upper() for td in zellen
                    if td.get("data-boxover-ticker")), None)
        if not sym:
            continue
        def feld(name, zellen=zellen):
            i = sp.get(name)
            return zellen[i].get_text(" ", strip=True) if i is not None and i < len(zellen) else ""
        out.append((sym, feld))
    return out

def listen_auffrischen():
    """Indexlisten und Stammdaten neu holen. Eine Liste wird nur ersetzt, wenn sie
    vollständig ankam — eine halbe Liste würde sonst Werte aus der Sammlung werfen."""
    mc = _db(_pfad_markt())
    try:
        _meta_setzen(mc, "listen_versuch", time.time())
        mc.commit()
    finally:
        mc.close()
    ok = 0
    for lid, (name, code) in LISTEN.items():
        if _stop.is_set():
            return
        try:
            syms = _finviz_tickerliste(code)
        except Exception as e:
            log(1, f"Indexliste {name} nicht abrufbar: {e}")
            continue
        mc = _db(_pfad_markt())
        try:
            alt = {r[0] for r in mc.execute("SELECT ticker FROM mitglied WHERE liste=?", (lid,))}
            mc.execute("DELETE FROM mitglied WHERE liste=?", (lid,))
            mc.executemany("INSERT INTO mitglied VALUES (?,?)", [(lid, s) for s in syms])
            mc.commit()
        finally:
            mc.close()
        rein, raus = sorted(set(syms) - alt), sorted(alt - set(syms))
        text = f"Indexliste {name}: {len(syms)} Werte"
        if alt and (rein or raus):
            text += f" (neu: {', '.join(rein[:12]) or '–'}; raus: {', '.join(raus[:12]) or '–'})"
        log(4, text)
        ok += 1
        _stop.wait(1.5)
    for lid, (name, code) in LISTEN.items():
        if _stop.is_set():
            return
        try:
            stamm = _finviz_stammdaten(code)
        except Exception as e:
            log(2, f"Stammdaten {name} nicht abrufbar: {e}")
            continue
        mc = _db(_pfad_markt())
        try:
            jetzt = time.time()
            for sym, s in stamm.items():
                info = {"symbol": sym, "name": s["name"], "sector": s["sector"], "industry": s["industry"],
                        "country": s["country"], "market_cap": s["market_cap"], "currency": "USD",
                        "quote_type": "EQUITY", "quelle": "finviz", "kurs_stamm": s["kurs"]}
                mc.execute("INSERT OR REPLACE INTO ticker_info VALUES (?,?,?)", (sym, json.dumps(info), jetzt))
            mc.commit()
        finally:
            mc.close()
        log(4, f"Stammdaten {name}: {len(stamm)} Werte")
    if ok == len(LISTEN):
        mc = _db(_pfad_markt())
        try:
            _meta_setzen(mc, "listen_stand", time.time())
            mc.commit()
        finally:
            mc.close()


# ── Sammelrunde ─────────────────────────────────────────────────────────────────
def _sammelliste(mc) -> list:
    syms = {r[0] for r in mc.execute("SELECT DISTINCT ticker FROM mitglied")}
    syms |= set(REFERENZ)
    syms |= {r[0] for r in mc.execute("SELECT ticker FROM abruf WHERE zuletzt>?",
                                      (time.time() - ABRUF_HALTEN,))}
    return sorted(syms)

def _pausiert(mc=None) -> bool:
    eigene = mc is None
    mc = mc or _db(_pfad_markt())
    try:
        return _meta(mc, "pausiert") == "1"
    finally:
        if eigene:
            mc.close()

def _platz_frei() -> int:
    try:
        return shutil.disk_usage(VERZ).free
    except Exception:
        return MIN_FREI * 10

def _runde_faellig(mc, jetzt: float):
    """Zeitpunkt, ab dem die fällige Runde zählt — oder None."""
    if jetzt - _meta_zahl(mc, "runde_abbruch") < 3600:
        return None
    soll = max(_letzter_termin(jetzt), _meta_zahl(mc, "runde_soll"))
    return soll if _meta_zahl(mc, "runde_ende") < soll else None

def _runde_fahren(soll: float):
    mc = _db(_pfad_markt())
    try:
        syms = _sammelliste(mc)
        stand = {r["ticker"]: r for r in mc.execute("SELECT * FROM sammelstand")}
        _meta_setzen(mc, "runde_start", time.time())
        mc.commit()
    finally:
        mc.close()
    # Nie Geholtes zuerst (Rückblick), dann die am längsten nicht Geholten
    def rang(s):
        st = stand.get(s)
        return (1 if st and st["letzte_h"] else 0, (st["abruf_h"] or 0) if st else 0)
    offen = [s for s in sorted(syms, key=rang)
             if not (stand.get(s) and (stand[s]["runde"] or 0) >= soll)]
    # Dauerhaft scheiternde Werte (delistet …) nur noch wöchentlich versuchen
    jetzt = time.time()
    offen = [s for s in offen if not (stand.get(s) and (stand[s]["fehler_zahl"] or 0) >= 5
                                      and jetzt - (stand[s]["fehler_zeit"] or 0) < 7 * 86400)]
    neu = sum(1 for s in offen if not (stand.get(s) and stand[s]["letzte_h"]))
    _runde.update(laeuft=True, start=time.time(), gesamt=len(offen), fertig=0, fehler=0,
                  gedrosselt=0, neu=neu, aktuell=None)
    log(4, f"Sammelrunde: {len(offen)} Werte" + (f", davon {neu} mit 2-Jahres-Rückblick" if neu else ""))
    abbruch = None
    for sym in offen:
        if _stop.is_set():
            abbruch = "App wird beendet"
            break
        if _pausiert():
            abbruch = "pausiert"
            break
        if _platz_frei() < MIN_FREI:
            abbruch = f"weniger als {MIN_FREI // 1024 ** 3} GB frei"
            mc = _db(_pfad_markt())
            try:
                _meta_setzen(mc, "pausiert", "1")
                mc.commit()
            finally:
                mc.close()
            log(1, "Sammeln angehalten: zu wenig Speicherplatz frei")
            break
        _runde["aktuell"] = sym
        try:
            stunden_holen(sym)
            # Die Tagesrunde (TAGES_UM Berlin) hat die Tageskerzen meist schon geholt
            st = stand.get(sym)
            if not (st and (st["abruf_d"] or 0) > time.time() - TAGE_FRISCH):
                _stop.wait(PAUSE)
                tage_holen(sym)
            mc = _db(_pfad_markt())
            try:
                _stand_setzen(mc, sym, runde=time.time(), fehler=None, fehler_zahl=0)
                mc.commit()
            finally:
                mc.close()
        except Gedrosselt as e:
            _runde["gedrosselt"] += 1
            log(2, f"Yahoo drosselt ({e}) bei {sym} — Pause 5 min")
            if _runde["gedrosselt"] >= DROSSEL_MAX:
                abbruch = "Yahoo drosselt wiederholt, neuer Versuch in einer Stunde"
                break
            _stop.wait(300)
        except Exception as e:
            _runde["fehler"] += 1
            log(2, f"{sym}: {e}")
            mc = _db(_pfad_markt())
            try:
                st = _stand(mc, sym)
                _stand_setzen(mc, sym, fehler=str(e)[:300], fehler_zeit=time.time(),
                              fehler_zahl=((st["fehler_zahl"] or 0) if st else 0) + 1)
                mc.commit()
            finally:
                mc.close()
        _runde["fertig"] += 1
        _stop.wait(PAUSE)
    dauer = time.time() - _runde["start"]
    mc = _db(_pfad_markt())
    try:
        if abbruch:
            _meta_setzen(mc, "runde_abbruch", time.time())
            log(2 if abbruch == "pausiert" else 1,
                f"Sammelrunde abgebrochen nach {_runde['fertig']} von {_runde['gesamt']}: {abbruch}")
        else:
            _meta_setzen(mc, "runde_ende", time.time())
            _meta_setzen(mc, "runde_bericht", json.dumps({
                "ende": time.time(), "dauer": round(dauer), "werte": _runde["gesamt"],
                "fehler": _runde["fehler"], "gedrosselt": _runde["gedrosselt"]}))
            log(4, f"Sammelrunde fertig: {_runde['gesamt']} Werte in {round(dauer / 60)} min, "
                   f"{_runde['fehler']} Fehler")
        mc.commit()
    finally:
        mc.close()
        _runde.update(laeuft=False, aktuell=None)

# ── Tagesrunde: Screening-Märkte ────────────────────────────────────────────────
def tageslisten_auffrischen():
    """Mitgliederlisten der Screening-Märkte neu laden. Eine Liste wird nur ersetzt,
    wenn sie vollständig ankam (universen.py prüft Mindestgrößen)."""
    mc = _db(_pfad_markt())
    try:
        _meta_setzen(mc, "tageslisten_versuch", time.time())
        mc.commit()
        alias = {r["quelle"]: r["ticker"] for r in mc.execute("SELECT quelle, ticker FROM alias")}
    finally:
        mc.close()
    universen.neu_laden()
    ok = 0
    for uid, (name, _f) in universen.UNIVERSEN.items():
        if _stop.is_set():
            return
        try:
            eintraege = universen.laden(uid)
        except Exception as e:
            log(1, f"Liste {name} nicht abrufbar: {e}")
            continue
        zeilen = {}
        for e in eintraege:
            sym = alias.get(e["quelle"]) or e["symbol"]
            zeilen[sym] = (uid, sym, e["quelle"], e.get("sektor"))
        mc = _db(_pfad_markt())
        try:
            alt = {r[0] for r in mc.execute("SELECT ticker FROM tagesmitglied WHERE liste=?", (uid,))}
            mc.execute("DELETE FROM tagesmitglied WHERE liste=?", (uid,))
            mc.executemany("INSERT INTO tagesmitglied VALUES (?,?,?,?)", list(zeilen.values()))
            mc.commit()
        finally:
            mc.close()
        rein, raus = sorted(set(zeilen) - alt), sorted(alt - set(zeilen))
        text = f"Liste {name}: {len(zeilen)} Werte"
        if alt and (rein or raus):
            text += f" (neu: {', '.join(rein[:12]) or '–'}{' …' if len(rein) > 12 else ''}; " \
                    f"raus: {', '.join(raus[:12]) or '–'}{' …' if len(raus) > 12 else ''})"
        log(4, text)
        ok += 1
    if ok == len(universen.UNIVERSEN):
        mc = _db(_pfad_markt())
        try:
            _meta_setzen(mc, "tageslisten_stand", time.time())
            mc.commit()
        finally:
            mc.close()

def tagesliste(mc=None) -> list:
    """Alle Werte der Screening-Märkte (ohne Doppelte)."""
    eigene = mc is None
    mc = mc or _db(_pfad_markt())
    try:
        return sorted({r[0] for r in mc.execute("SELECT DISTINCT ticker FROM tagesmitglied")})
    finally:
        if eigene:
            mc.close()

_ISIN_RE = re.compile(r"^[A-Z]{2}[A-Z0-9]{9}\d$")

def _alias_suchen(sym: str) -> str | None:
    """Yahoo kennt `sym` nicht: über die ISIN der Quelle das Yahoo-Symbol suchen,
    merken und die Mitgliedschaft umschreiben. Nur für Quellen mit ISIN (Xetra)."""
    mc = _db(_pfad_markt())
    try:
        r = mc.execute("SELECT quelle FROM tagesmitglied WHERE ticker=? LIMIT 1", (sym,)).fetchone()
        isin = r["quelle"] if r else None
        if not isin or not _ISIN_RE.match(isin):
            return None
        a = mc.execute("SELECT ticker, zeit FROM alias WHERE quelle=?", (isin,)).fetchone()
        if a and time.time() - (a["zeit"] or 0) < 7 * 86400:
            return None                       # erst kürzlich gesucht
    finally:
        mc.close()
    url = ("https://query2.finance.yahoo.com/v1/finance/search?q=" + urllib.parse.quote(isin) +
           "&quotesCount=6&newsCount=0")
    try:
        treffer = [q.get("symbol") for q in (_hole_json(url, timeout=15).get("quotes") or [])
                   if q.get("symbol") and q.get("quoteType") == "EQUITY"]
    except Gedrosselt:
        raise
    except Exception as e:
        log(2, f"{sym}: ISIN-Suche fehlgeschlagen ({e})")
        treffer = []
    # Nur an derselben Börse: eine Regionalbörse (TUIA.HA statt Xetra) hätte ein
    # Bruchteil des Volumens und verfälschte die Filter. Kennt Yahoo die Notierung
    # noch nicht, wird es in einer Woche erneut versucht.
    endung = sym[sym.rfind("."):] if "." in sym else ""
    neu = next((t for t in treffer if endung and t.endswith(endung)), None)
    mc = _db(_pfad_markt())
    try:
        mc.execute("INSERT OR REPLACE INTO alias VALUES (?,?,?)", (isin, neu or sym, time.time()))
        if not neu:
            log(2, f"{sym}: Yahoo kennt die Notierung noch nicht (ISIN {isin}, gefunden: "
                   f"{', '.join(treffer[:4]) or 'nichts'}) — neuer Versuch in einer Woche")
        if neu and neu != sym:
            mc.execute("UPDATE OR REPLACE tagesmitglied SET ticker=? WHERE ticker=?", (neu, sym))
        mc.commit()
    finally:
        mc.close()
    if neu and neu != sym:
        log(4, f"{sym} heißt bei Yahoo {neu} (über ISIN {isin})")
        return neu
    return None

# Yahoo-Sitzung (Cookie + Crumb) für Sammelabrufe; hält eine Stunde.
# Über curl_cffi mit Chrome-Fingerabdruck: mit urllib verweigert Yahoo den Crumb
# immer wieder mit 401 (es prüft den TLS-Handshake) — dasselbe Mittel nutzt yfinance.
_yahoo = {"sitzung": None, "crumb": None, "zeit": 0}

def _yahoo_sitzung():
    from curl_cffi import requests as cr
    if _yahoo["sitzung"] and time.time() - _yahoo["zeit"] < 3600:
        return _yahoo["sitzung"], _yahoo["crumb"]
    s = cr.Session(impersonate="chrome")
    try:
        s.get("https://fc.yahoo.com", timeout=15)          # setzt das Cookie (antwortet 404)
    except Exception:
        pass
    r = s.get("https://query1.finance.yahoo.com/v1/test/getcrumb", timeout=15)
    crumb = (r.text or "").strip()
    if r.status_code != 200 or not crumb or "<" in crumb:
        raise RuntimeError(f"Yahoo-Crumb nicht erhältlich (HTTP {r.status_code})")
    _yahoo.update(sitzung=s, crumb=crumb, zeit=time.time())
    return s, crumb

def _yahoo_get(pfad: str, params: dict = None) -> dict:
    s, crumb = _yahoo_sitzung()
    r = s.get("https://query1.finance.yahoo.com" + pfad, params={**(params or {}), "crumb": crumb}, timeout=25)
    if r.status_code in (429, 999, 503):
        raise Gedrosselt(f"HTTP {r.status_code}")
    if r.status_code == 401:
        _yahoo["sitzung"] = None                           # Crumb verfallen → beim nächsten Mal neu
    if r.status_code != 200:
        raise RuntimeError(f"HTTP {r.status_code}")
    return r.json()

def _info_lesen(mc, sym) -> dict:
    r = mc.execute("SELECT data FROM ticker_info WHERE symbol=?", (sym,)).fetchone()
    try:
        return json.loads(r["data"]) if r and r["data"] else {}
    except ValueError:
        return {}

def tages_stammdaten(syms: list) -> int:
    """Marktkapitalisierung, Währung, Name und ersten Handelstag per Sammelabruf
    (QUOTE_JE_ABRUF Werte je Anfrage) in ticker_info nachtragen. Vorhandenes
    (Finviz-Sektor, Branche) bleibt stehen. Rückgabe: Zahl der aktualisierten Werte."""
    sektor_quelle = {}
    mc = _db(_pfad_markt())
    try:
        for r in mc.execute("SELECT ticker, sektor FROM tagesmitglied WHERE sektor IS NOT NULL"):
            sektor_quelle[r["ticker"]] = r["sektor"]
    finally:
        mc.close()
    n = 0
    for i in range(0, len(syms), QUOTE_JE_ABRUF):
        if _stop.is_set():
            break
        teil = syms[i:i + QUOTE_JE_ABRUF]
        try:
            d = _yahoo_get("/v7/finance/quote", {"symbols": ",".join(teil)})
        except Gedrosselt:
            raise
        except Exception as e:
            log(2, f"Stammdaten-Sammelabruf ab {teil[0]}: {e}")
            continue
        jetzt = time.time()
        with _schreiben:
            mc = _db(_pfad_markt())
            try:
                for q in ((d.get("quoteResponse") or {}).get("result") or []):
                    sym = q.get("symbol")
                    if not sym:
                        continue
                    info = _info_lesen(mc, sym)
                    info["symbol"] = sym
                    info["name"] = info.get("name") or q.get("longName") or q.get("shortName") or sym
                    if q.get("marketCap"):
                        info["market_cap"] = q["marketCap"]
                        info["market_cap_stand"] = time.strftime("%Y-%m-%d", time.gmtime(jetzt))
                    info["currency"] = q.get("currency") or info.get("currency")
                    info["quote_type"] = q.get("quoteType") or info.get("quote_type")
                    info["exchange"] = q.get("fullExchangeName") or info.get("exchange")
                    if q.get("firstTradeDateMilliseconds"):
                        info["erster_handel"] = time.strftime(
                            "%Y-%m-%d", time.gmtime(q["firstTradeDateMilliseconds"] / 1000))
                    if not info.get("sector") and sektor_quelle.get(sym):
                        info["sector"] = sektor_quelle[sym]
                    info.setdefault("quelle", "yahoo")
                    mc.execute("INSERT OR REPLACE INTO ticker_info VALUES (?,?,?)", (sym, json.dumps(info), jetzt))
                    n += 1
                mc.commit()
            finally:
                mc.close()
        _stop.wait(1.0)
    return n

def tages_sektoren(syms: list) -> int:
    """Sektor und Branche einzeln bei Yahoo (quoteSummary) für Werte ohne Sektor —
    höchstens SEKTOR_JE_NACHT je Runde; erfolglose erst nach SEKTOR_NEU_NACH wieder."""
    mc = _db(_pfad_markt())
    try:
        offen = []
        for sym in syms:
            info = _info_lesen(mc, sym)
            if info.get("sector") or info.get("quote_type") not in (None, "EQUITY"):
                continue
            if time.time() - (info.get("sektor_versucht") or 0) < SEKTOR_NEU_NACH:
                continue
            offen.append(sym)
    finally:
        mc.close()
    n = 0
    for sym in offen[:SEKTOR_JE_NACHT]:
        if _stop.is_set():
            break
        try:
            d = _yahoo_get(f"/v10/finance/quoteSummary/{urllib.parse.quote(sym)}", {"modules": "assetProfile"})
            prof = (((d.get("quoteSummary") or {}).get("result") or [{}])[0] or {}).get("assetProfile") or {}
        except Gedrosselt:
            raise
        except Exception as e:
            # Kein „versucht" vermerken: ein Netz- oder Crumb-Fehler sagt nichts über den Wert
            log(7, f"{sym}: Sektor nicht abrufbar ({e})")
            _stop.wait(PAUSE)
            continue
        with _schreiben:
            mc = _db(_pfad_markt())
            try:
                info = _info_lesen(mc, sym)
                info.update(symbol=sym, sektor_versucht=time.time())
                if prof.get("sector"):
                    info["sector"], info["industry"] = prof["sector"], prof.get("industry")
                    info["country"] = info.get("country") or prof.get("country")
                    n += 1
                mc.execute("INSERT OR REPLACE INTO ticker_info VALUES (?,?,?)", (sym, json.dumps(info), time.time()))
                mc.commit()
            finally:
                mc.close()
        _stop.wait(PAUSE)
    if offen:
        log(4, f"Sektoren: {n} von {min(len(offen), SEKTOR_JE_NACHT)} nachgetragen"
               + (f", {len(offen) - SEKTOR_JE_NACHT} folgen in den nächsten Runden" if len(offen) > SEKTOR_JE_NACHT else ""))
    return n

def _tagesrunde_faellig(mc, jetzt: float):
    if jetzt - _meta_zahl(mc, "tagesrunde_abbruch") < 3600:
        return None
    soll = max(_tagestermin(jetzt, -1), _meta_zahl(mc, "tagesrunde_soll"))
    return soll if _meta_zahl(mc, "tagesrunde_ende") < soll else None

def _tagesrunde_fahren(soll: float):
    mc = _db(_pfad_markt())
    try:
        syms = tagesliste(mc)
        stand = {r["ticker"]: r for r in mc.execute("SELECT * FROM sammelstand")}
        _meta_setzen(mc, "tagesrunde_start", time.time())
        mc.commit()
    finally:
        mc.close()
    jetzt = time.time()
    def rang(s):                               # nie Geholtes zuerst, dann die ältesten
        st = stand.get(s)
        return (1 if st and st["abruf_d"] else 0, (st["abruf_d"] or 0) if st else 0)
    offen = [s for s in sorted(syms, key=rang)
             if not (stand.get(s) and (stand[s]["abruf_d"] or 0) >= soll)
             and not (stand.get(s) and (stand[s]["fehler_zahl"] or 0) >= 5
                      and jetzt - (stand[s]["fehler_zeit"] or 0) < 7 * 86400)]
    neu = sum(1 for s in offen if not (stand.get(s) and stand[s]["abruf_d"]))
    _tagesrunde.update(laeuft=True, start=time.time(), gesamt=len(offen), fertig=0, fehler=0,
                       gedrosselt=0, neu=neu, aktuell=None, phase="Tageskerzen")
    log(4, f"Tagesrunde: {len(offen)} Werte" + (f", davon {neu} neu (je {TAGE_START} Tage)" if neu else ""))
    for paar in FX_PAARE:                      # zuerst: der Screener rechnet damit in USD um
        try:
            tage_holen(paar)
        except Exception as e:
            log(2, f"Wechselkurs {paar}: {e}")
        _stop.wait(PAUSE)
    abbruch = None
    for sym in offen:
        if _stop.is_set():
            abbruch = "App wird beendet"
            break
        if _pausiert():
            abbruch = "pausiert"
            break
        if _platz_frei() < MIN_FREI:
            abbruch = f"weniger als {MIN_FREI // 1024 ** 3} GB frei"
            break
        _tagesrunde["aktuell"] = sym
        try:
            try:
                tage_holen(sym)
            except RuntimeError as e:
                neu_sym = _alias_suchen(sym) if "404" in str(e) else None
                if not neu_sym:
                    raise
                _stop.wait(PAUSE)
                tage_holen(neu_sym)
                sym = neu_sym
            mc = _db(_pfad_markt())
            try:
                _stand_setzen(mc, sym, fehler=None, fehler_zahl=0)
                mc.commit()
            finally:
                mc.close()
        except Gedrosselt as e:
            _tagesrunde["gedrosselt"] += 1
            log(2, f"Yahoo drosselt ({e}) bei {sym} — Pause 5 min")
            if _tagesrunde["gedrosselt"] >= DROSSEL_MAX:
                abbruch = "Yahoo drosselt wiederholt, neuer Versuch in einer Stunde"
                break
            _stop.wait(300)
        except Exception as e:
            _tagesrunde["fehler"] += 1
            log(7, f"{sym}: {e}")
            mc = _db(_pfad_markt())
            try:
                st = _stand(mc, sym)
                _stand_setzen(mc, sym, fehler=str(e)[:300], fehler_zeit=time.time(),
                              fehler_zahl=((st["fehler_zahl"] or 0) if st else 0) + 1)
                mc.commit()
            finally:
                mc.close()
        _tagesrunde["fertig"] += 1
        _stop.wait(PAUSE)
    stamm = sek = 0
    if not abbruch:
        try:
            _tagesrunde.update(phase="Stammdaten", aktuell=None)
            stamm = tages_stammdaten(tagesliste())
            _tagesrunde["phase"] = "Sektoren"
            sek = tages_sektoren(tagesliste())
        except Gedrosselt as e:
            log(2, f"Stammdaten: Yahoo drosselt ({e}) — beim nächsten Mal weiter")
        except Exception as e:
            log(1, f"Stammdaten: {e}")
    dauer = time.time() - _tagesrunde["start"]
    mc = _db(_pfad_markt())
    try:
        if abbruch and abbruch != "App wird beendet":
            # Ein Neustart (Deploy) ist keine Störung: nach dem Hochfahren geht es gleich
            # mit den noch offenen Werten weiter, statt eine Stunde zu warten
            _meta_setzen(mc, "tagesrunde_abbruch", time.time())
        if abbruch:
            log(2 if abbruch == "pausiert" else 1,
                f"Tagesrunde abgebrochen nach {_tagesrunde['fertig']} von {_tagesrunde['gesamt']}: {abbruch}")
        else:
            _meta_setzen(mc, "tagesrunde_ende", time.time())
            _meta_setzen(mc, "tagesrunde_bericht", json.dumps({
                "ende": time.time(), "dauer": round(dauer), "werte": _tagesrunde["gesamt"],
                "fehler": _tagesrunde["fehler"], "gedrosselt": _tagesrunde["gedrosselt"],
                "stammdaten": stamm, "sektoren": sek}))
            log(4, f"Tagesrunde fertig: {_tagesrunde['gesamt']} Werte in {round(dauer / 60)} min, "
                   f"{_tagesrunde['fehler']} Fehler, Stammdaten {stamm}, Sektoren {sek}")
        mc.commit()
    finally:
        mc.close()
        _tagesrunde.update(laeuft=False, aktuell=None, phase=None)

def _arbeit_tages():
    mc = _db(_pfad_markt())
    try:
        if _pausiert(mc):
            return
        jetzt = time.time()
        listen_faellig = (jetzt - _meta_zahl(mc, "tageslisten_stand") > TAGES_LISTEN_ALTER
                          and jetzt - _meta_zahl(mc, "tageslisten_versuch") > 3600)
    finally:
        mc.close()
    if listen_faellig:
        tageslisten_auffrischen()
    mc = _db(_pfad_markt())
    try:
        leer = not mc.execute("SELECT 1 FROM tagesmitglied LIMIT 1").fetchone()
        soll = None if leer else _tagesrunde_faellig(mc, time.time())
    finally:
        mc.close()
    if soll:
        _tagesrunde_fahren(soll)

def tagesrunde_jetzt():
    """Tagesrunde außer der Reihe anstoßen (Protokoll-Seite)."""
    mc = _db(_pfad_markt())
    try:
        _meta_setzen(mc, "tagesrunde_soll", time.time())
        _meta_setzen(mc, "tagesrunde_abbruch", 0)
        mc.commit()
    finally:
        mc.close()
    _wecker.set()

def _arbeit():
    mc = _db(_pfad_markt())
    try:
        if _pausiert(mc):
            return
        jetzt = time.time()
        listen_faellig = (jetzt - _meta_zahl(mc, "listen_stand") > LISTEN_ALTER
                          and jetzt - _meta_zahl(mc, "listen_versuch") > 3600)
    finally:
        mc.close()
    if listen_faellig:
        listen_auffrischen()
    mc = _db(_pfad_markt())
    try:
        # Ohne Indexlisten keine Runde: sie gälte sonst als erledigt, und die Indexwerte
        # kämen erst am nächsten Handelstag dran. Der Listenversuch wiederholt sich stündlich.
        leer = not mc.execute("SELECT 1 FROM mitglied LIMIT 1").fetchone()
        soll = None if leer else _runde_faellig(mc, time.time())
    finally:
        mc.close()
    if soll:
        _runde_fahren(soll)

def _schleife():
    _stop.wait(20)                    # die App erst in Ruhe hochfahren lassen
    while not _stop.is_set():
        try:
            _arbeit()
        except Exception as e:
            log(1, f"Sammler: {e}")
        try:
            _arbeit_tages()
        except Exception as e:
            log(1, f"Tagesrunde: {e}")
        _wecker.wait(60)
        _wecker.clear()

def start(basis_verz: str, init_db_fn=None):
    """Einmal beim App-Start. Legt die Ablage an und startet den Sammler-Thread."""
    global VERZ, _init_db, _thread
    VERZ = os.path.join(basis_verz, "_markt")
    _init_db = init_db_fn
    _einrichten()
    if _thread and _thread.is_alive():
        return
    _stop.clear()
    _thread = threading.Thread(target=_schleife, daemon=True, name="markt-sammler")
    _thread.start()
    log(4, "Sammler gestartet")

def einrichten(basis_verz: str, init_db_fn=None):
    """Nur die Ablage, ohne Sammler-Thread (Tests, abgeschalteter Sammler)."""
    global VERZ, _init_db
    VERZ = os.path.join(basis_verz, "_markt")
    _init_db = init_db_fn
    _einrichten()

def stoppen():
    _stop.set()
    _wecker.set()


# ── Steuerung von außen ─────────────────────────────────────────────────────────
def pausieren(an: bool):
    mc = _db(_pfad_markt())
    try:
        _meta_setzen(mc, "pausiert", "1" if an else "0")
        if not an:
            _meta_setzen(mc, "runde_abbruch", 0)   # nach dem Fortsetzen nicht erst eine Stunde warten
        mc.commit()
    finally:
        mc.close()
    log(4, "Sammeln pausiert" if an else "Sammeln fortgesetzt")
    _wecker.set()

def runde_jetzt():
    mc = _db(_pfad_markt())
    try:
        _meta_setzen(mc, "runde_soll", time.time())
        _meta_setzen(mc, "runde_abbruch", 0)
        mc.commit()
    finally:
        mc.close()
    log(4, "Sammelrunde von Hand angestoßen")
    _wecker.set()


# ── Live-Kurse für die Heatmap ──────────────────────────────────────────────────
def live_anstossen(erzwingen: bool = False) -> bool:
    """Startet im Hintergrund eine Runde über Yahoos Sammelabruf (20 Werte je Anfrage),
    die den heutigen Tageskurs aller Indexwerte auffrischt. True = gestartet."""
    if _live["laeuft"] or not VERZ:
        return False
    mc = _db(_pfad_markt())
    try:
        alter = time.time() - _meta_zahl(mc, "live_stand")
        if _pausiert(mc):
            return False
    finally:
        mc.close()
    if not erzwingen and (alter < LIVE_ALTER or not markt_offen()):
        return False
    if erzwingen and alter < 60:
        return False
    _live["laeuft"] = True
    threading.Thread(target=_live_runde, daemon=True, name="markt-live").start()
    return True

def _live_runde():
    try:
        mc = _db(_pfad_markt())
        try:
            syms = sorted({r[0] for r in mc.execute("SELECT DISTINCT ticker FROM mitglied")})
        finally:
            mc.close()
        n, t0 = 0, time.time()
        for i in range(0, len(syms), 20):
            if _stop.is_set():
                return
            teil = syms[i:i + 20]
            url = ("https://query1.finance.yahoo.com/v7/finance/spark?symbols=" +
                   ",".join(urllib.parse.quote(s) for s in teil) + "&range=1d&interval=1d")
            try:
                d = _hole_json(url, timeout=20)
            except Gedrosselt as e:
                log(2, f"Live-Kurse: Yahoo drosselt ({e}) — abgebrochen")
                return
            except Exception as e:
                log(2, f"Live-Kurse {teil[0]}…: {e}")
                continue
            zeilen = []
            for erg in ((d.get("spark") or {}).get("result") or []):
                antwort = (erg.get("response") or [{}])[0] or {}
                m = antwort.get("meta") or {}
                preis, zeit = m.get("regularMarketPrice"), m.get("regularMarketTime")
                if not preis or not zeit or time.time() - zeit > 20 * 3600:
                    continue
                zeilen.append((erg.get("symbol"), time.strftime("%Y-%m-%d", time.gmtime(zeit)), preis,
                               m.get("regularMarketDayHigh") or preis, m.get("regularMarketDayLow") or preis,
                               m.get("regularMarketVolume") or 0))
            if zeilen:
                with _schreiben:
                    mc = _db(_pfad_markt())
                    try:
                        for sym, tag, preis, hi, lo, vol in zeilen:
                            alt = mc.execute("SELECT open, high, low, volume FROM prices WHERE ticker=? AND date=?",
                                             (sym, tag)).fetchone()
                            if alt:
                                mc.execute("UPDATE prices SET close=?, high=?, low=?, volume=? WHERE ticker=? AND date=?",
                                           (preis, max(alt["high"], preis, hi), min(alt["low"], preis, lo),
                                            max(alt["volume"] or 0, vol), sym, tag))
                            else:
                                mc.execute("INSERT INTO prices VALUES (?,?,?,?,?,?,?)",
                                           (sym, tag, preis, max(hi, preis), min(lo, preis), preis, vol))
                            n += 1
                        mc.commit()
                    finally:
                        mc.close()
            _stop.wait(0.25)
        mc = _db(_pfad_markt())
        try:
            _meta_setzen(mc, "live_stand", time.time())
            mc.commit()
        finally:
            mc.close()
        log(7, f"Live-Kurse: {n} Werte in {time.time() - t0:.0f} s")
    finally:
        _live["laeuft"] = False


# ── Auskunft ────────────────────────────────────────────────────────────────────
def liste(lid: str) -> set:
    mc = _db(_pfad_markt())
    try:
        return {r[0] for r in mc.execute("SELECT ticker FROM mitglied WHERE liste=?", (lid,))}
    finally:
        mc.close()

def kurs_stand() -> float:
    """Zeitpunkt der jüngsten Kurse für die Heatmap (Live-Runde oder Sammelrunde)."""
    mc = _db(_pfad_markt())
    try:
        return max(_meta_zahl(mc, "live_stand"), _meta_zahl(mc, "runde_ende"))
    finally:
        mc.close()

def _groesse() -> int:
    summe = 0
    for wurzel, _verz, dateien in os.walk(VERZ):
        for f in dateien:
            try:
                summe += os.path.getsize(os.path.join(wurzel, f))
            except OSError:
                pass
    return summe

def status() -> dict:
    mc = _db(_pfad_markt())
    try:
        zahl = {lid: 0 for lid in LISTEN}
        for r in mc.execute("SELECT liste, COUNT(*) n FROM mitglied GROUP BY liste"):
            zahl[r["liste"]] = r["n"]
        syms = _sammelliste(mc)
        menge = set(syms)
        mit_h = sum(1 for r in mc.execute("SELECT ticker FROM sammelstand WHERE letzte_h IS NOT NULL")
                    if r[0] in menge)
        mit_d = sum(1 for r in mc.execute("SELECT DISTINCT ticker FROM prices") if r[0] in menge)
        abruf = [r[0] for r in mc.execute("SELECT ticker FROM abruf WHERE zuletzt>? ORDER BY ticker",
                                          (time.time() - ABRUF_HALTEN,))]
        fehler = [{"ticker": r["ticker"], "fehler": r["fehler"], "zahl": r["fehler_zahl"]}
                  for r in mc.execute("SELECT ticker, fehler, fehler_zahl FROM sammelstand "
                                      "WHERE fehler IS NOT NULL ORDER BY fehler_zeit DESC LIMIT 25")]
        try:
            bericht = json.loads(_meta(mc, "runde_bericht") or "null")
        except ValueError:
            bericht = None
        try:
            tagesbericht = json.loads(_meta(mc, "tagesrunde_bericht") or "null")
        except ValueError:
            tagesbericht = None
        tageszahl = {uid: 0 for uid in universen.UNIVERSEN}
        for r in mc.execute("SELECT liste, COUNT(*) n FROM tagesmitglied GROUP BY liste"):
            tageszahl[r["liste"]] = r["n"]
        jetzt = time.time()
        out = {
            "ok":          True,
            "aktiv":       bool(_thread and _thread.is_alive()),
            "pausiert":    _meta(mc, "pausiert") == "1",
            "listen":      [{"id": lid, "name": LISTEN[lid][0], "anzahl": zahl[lid]} for lid in LISTEN],
            "listen_stand": _meta_zahl(mc, "listen_stand") or None,
            "referenz":    len(REFERENZ),
            "abruf":       abruf,
            "gesamt":      len(syms),
            "mit_stunden": mit_h,
            "mit_tagen":   mit_d,
            "runde":       dict(_runde),
            "bericht":     bericht,
            "abbruch":     _meta_zahl(mc, "runde_abbruch") or None,
            "naechste":    _naechster_termin(jetzt),
            "tages": {
                "listen":   [{"id": uid, "name": universen.UNIVERSEN[uid][0], "anzahl": tageszahl[uid]}
                             for uid in universen.UNIVERSEN],
                "listen_stand": _meta_zahl(mc, "tageslisten_stand") or None,
                "gesamt":   len(tagesliste(mc)),
                "runde":    dict(_tagesrunde),
                "bericht":  tagesbericht,
                "abbruch":  _meta_zahl(mc, "tagesrunde_abbruch") or None,
                "naechste": _tagestermin(jetzt, +1),
            },
            "live":        {"stand": _meta_zahl(mc, "live_stand") or None, "laeuft": _live["laeuft"]},
            "speicher":    _groesse(),
            "frei":        _platz_frei(),
            "fehler":      fehler,
            "protokoll":   [{"t": t, "lvl": s, "msg": m} for t, s, m in list(_log)[-120:]],
        }
        return out
    finally:
        mc.close()
