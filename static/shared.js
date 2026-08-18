/**
 * shared.js — Gemeinsame Logik für Desktop und Mobile
 * =====================================================
 * Enthält: State, Berechnungen, API-Calls, Datenhaltung
 * Enthält NICHT: Chart-Rendering, DOM-Manipulation, UI-Events
 *
 * !! REFACTORING-REGEL !!
 * Bestehenden Code ÄNDERN, keinen neuen Code hinzufügen.
 * Neue Features → bestehende Funktion erweitern.
 *
 * Wird geladen von:
 *   desktop.html → <script src="/static/shared.js"></script>
 *   mobile.html  → <script src="/static/shared.js"></script>
 */

'use strict';

// ╔══════════════════════════════════════════════════════════╗
// ║  1. GLOBALER STATE — Eine Wahrheit für Desktop + Mobile  ║
// ╚══════════════════════════════════════════════════════════╝

// Kursdaten
var allCandles   = [];   // Alle Tageskerzen des aktuellen Views (Index oder Ticker)
var _lastCandles = [];   // Gefärbte + aggregierte Kerzen (nach applyPeriod)
var _volumeData  = [];   // Volumen-Daten (Tagesebene)

// Portfolio / Baskets
var WEIGHTS       = {};  // { AAPL: 10, GOOGL: 5 } — Anzahl Aktien pro Ticker
var TICKERS       = [];  // Alle Ticker mit Daten in der DB
var baskets       = {};  // { basket_id: { name, weights, period, tf, ... } }
var currentBasket = '';  // Aktiver Basket-ID
// Aussehen (pro Nutzer in der Config gespeichert). Defaults = bisheriges Aussehen.
// chartBg (optional) = eigene Hintergrundfarbe des Charts, '' bedeutet „wie Theme".
var appearance    = { theme: 'light', contrast: 'normal', fontSize: 'compact', accent: 'green' };
// Fenstergrößen und geschlossene Fenster der Desktop-Oberfläche. Hier deklariert,
// damit Mobile den Desktop-Stand beim Speichern durchreicht statt ihn zu löschen.
var _layout       = {};
var currentView   = 'index'; // 'index' oder Ticker-Symbol z.B. 'AAPL'

// Chart-Einstellungen
var currentPeriod = 180;  // Tage (0 = All)
var currentTF     = '1D'; // '1D', '1W', '1M'
var logScale      = false;
var indicators    = { ma50: false, ma200: false, reg: false };

// Performance
var perfData = {}; // { AAPL: { price, d1, d5, d22, d66, ytd, since } }

// Zeichnungen (wird von desktop.js genutzt)
var drawings = [];

// Interner State
var _dataMap         = {}; // { AAPL: [{time, open, high, low, close, volume}] }
var tickerCurrencies = {}; // { AAPL: 'USD', HLMA.L: 'GBp', SAP.DE: 'EUR' }
var _fxDataMap       = {}; // { 'EURUSD=X': [...], 'GBPUSD=X': [...] }

// ╔══════════════════════════════════════════════════════════╗
// ║  1b. LAUFPROTOKOLL                                        ║
// ╚══════════════════════════════════════════════════════════╝
// Ringpuffer im Browser. Jeder Eintrag hat eine Stufe 1–10; angezeigt wird alles
// bis zum eingestellten Detailgrad (1 = nur Fehler, 10 = jeder Einzelschritt).
// Faustregel für neue Aufrufe:
//   1 Fehler · 2 Warnungen · 3 Ergebnis einer Aktion · 4 Start einer Aktion
//   5 Teilschritte · 6 Netzabrufe gebündelt · 7 einzelner Netzabruf
//   8 Rendern/Zeichnen · 9 Zwischenwerte · 10 alles

/** HTML-Maskierung für eingebettete Fremdtexte (Tickernamen, Fehlermeldungen). */
function escHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

var LOG_MAX     = 800;     // Ringpuffer-Größe
var logEntries  = [];      // [{ t: Date, lvl: 1..10, tag, msg }]
var logLevel    = 3;       // Detailgrad, aus localStorage wiederhergestellt
var _logSeq     = 0;
var _logT0      = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;

try {
    var _lvl = parseInt(localStorage.getItem('folio.logLevel'), 10);
    if (_lvl >= 1 && _lvl <= 10) logLevel = _lvl;
} catch (e) {}

/**
 * Schreibt einen Protokolleintrag.
 * @param {number} lvl 1–10, siehe Faustregel oben
 * @param {string} tag Kurzer Bereich, z.B. 'Kurse', 'IBKR', 'Chart'
 * @param {string} msg Meldung
 */
function logIt(lvl, tag, msg) {
    var now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
    logEntries.push({
        n:   ++_logSeq,
        t:   new Date(),
        ms:  Math.round(now - _logT0),
        lvl: lvl,
        tag: tag || '',
        msg: String(msg)
    });
    if (logEntries.length > LOG_MAX) logEntries.splice(0, logEntries.length - LOG_MAX);
    if (lvl <= 2 && typeof console !== 'undefined') {
        (lvl === 1 ? console.error : console.warn)('[' + tag + '] ' + msg);
    }
    if (typeof renderLog === 'function') renderLog();
}

/** Misst die Dauer eines Abschnitts: var done = logTimer(4,'Kurse','Refresh'); … done(); */
function logTimer(lvl, tag, msg) {
    var t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
    logIt(lvl, tag, msg + ' …');
    return function(suffix) {
        var dt = ((typeof performance !== 'undefined' && performance.now ? performance.now() : 0) - t0);
        logIt(lvl, tag, msg + ' fertig' + (suffix ? ' — ' + suffix : '') + ' (' + Math.round(dt) + ' ms)');
    };
}

function setLogLevel(v) {
    var n = parseInt(v, 10);
    if (isNaN(n)) n = 3;                       // nicht `|| 3` — das verschluckt die 0
    n = Math.max(1, Math.min(10, n));
    logLevel = n;
    try { localStorage.setItem('folio.logLevel', String(n)); } catch (e) {}
    logIt(1, 'Log', 'Detailgrad auf ' + n + ' gesetzt');   // Stufe 1 → immer sichtbar
    if (typeof renderLog === 'function') renderLog();
}

function clearLog() {
    logEntries = [];
    if (typeof renderLog === 'function') renderLog();
}

// Unerwartete Fehler landen ebenfalls im Protokoll — sonst sieht der Benutzer nur,
// dass „nichts passiert" ist.
if (typeof window !== 'undefined') {
    window.addEventListener('error', function(e) {
        logIt(1, 'Fehler', (e.message || 'Fehler') + ' @ ' + (e.filename || '').split('/').pop() + ':' + e.lineno);
    });
    window.addEventListener('unhandledrejection', function(e) {
        logIt(1, 'Fehler', 'Unbehandelt: ' + ((e.reason && e.reason.message) || e.reason));
    });
}

// ── Währungssymbol für die aktuelle Basket-Basiswährung ──────────────
var _CUR_SYMBOLS = { USD: '$', EUR: '€', GBP: '£', CHF: 'Fr.', JPY: '¥', CAD: 'C$', AUD: 'A$' };
function basketCurSymbol() {
    var b = baskets[currentBasket] || {};
    return _CUR_SYMBOLS[b.baseCurrency || 'USD'] || (b.baseCurrency || '$');
}
function tickerCurSymbol(sym) {
    var c = tickerCurrencies[sym];
    if (!c) return basketCurSymbol();
    if (c === 'GBp') return 'p';
    return _CUR_SYMBOLS[c] || c;
}

// ╔══════════════════════════════════════════════════════════╗
// ║  2. BERECHNUNGEN                                          ║
// ╚══════════════════════════════════════════════════════════╝

/**
 * Berechnet Moving Average.
 * @param {Array} candles - Array von {time, close}
 * @param {number} period - MA-Periode (50 oder 200)
 * @returns {Array} [{time, value}]
 */
function calcMA(candles, period) {
    var result = [];
    for (var i = period - 1; i < candles.length; i++) {
        var sum = 0;
        for (var j = 0; j < period; j++) {
            sum += candles[i - j].close;
        }
        result.push({ time: candles[i].time, value: sum / period });
    }
    return result;
}

/**
 * Berechnet logarithmische Regression mit Konfidenzband.
 * @param {Array} candles - Array von {time, close}
 * @param {number} stdDev - Anzahl Standardabweichungen für Band
 * @returns {Object} { reg, upper, lower, arr, r2 }
 */
function calcLogReg(candles, stdDev, barsPerYear) {
    if (candles.length < 10) return null;
    var n = candles.length;
    var xs = candles.map(function(_, i) { return i; });
    var ys = candles.map(function(c) { return Math.log(c.close); });
    var xMean = xs.reduce(function(a, b) { return a + b; }, 0) / n;
    var yMean = ys.reduce(function(a, b) { return a + b; }, 0) / n;
    var ssXY = 0, ssXX = 0;
    for (var i = 0; i < n; i++) {
        ssXY += (xs[i] - xMean) * (ys[i] - yMean);
        ssXX += (xs[i] - xMean) * (xs[i] - xMean);
    }
    var slope = ssXY / ssXX;
    var intercept = yMean - slope * xMean;

    // R²
    var ssRes = 0, ssTot = 0;
    for (var i = 0; i < n; i++) {
        var pred = slope * xs[i] + intercept;
        ssRes += (ys[i] - pred) * (ys[i] - pred);
        ssTot += (ys[i] - yMean) * (ys[i] - yMean);
    }
    var r2 = 1 - ssRes / ssTot;

    // Standardabweichung der Residuen
    var se = Math.sqrt(ssRes / (n - 2));

    // ARR = Annual Rate of Return (Steigung × Bars pro Jahr)
    var arr = ((Math.exp(slope * (barsPerYear || 252)) - 1) * 100).toFixed(1);

    var reg = [], upper = [], lower = [];
    candles.forEach(function(c, i) {
        var logVal = slope * i + intercept;
        reg.push({ time: c.time, value: Math.exp(logVal) });
        upper.push({ time: c.time, value: Math.exp(logVal + stdDev * se) });
        lower.push({ time: c.time, value: Math.exp(logVal - stdDev * se) });
    });

    return { reg: reg, upper: upper, lower: lower, arr: arr, r2: r2.toFixed(3) };
}

/**
 * Färbt Kerzen: grün wenn Close >= vorheriger Close, sonst rot.
 * @param {Array} candles - Rohe OHLC-Daten
 * @returns {Array} Kerzen mit color, borderColor, wickColor
 */
function colorCandles(candles) {
    return candles.map(function(c, i) {
        var prevClose = i > 0 ? candles[i - 1].close : c.open;
        var up = c.close >= prevClose;
        return Object.assign({}, c, {
            color:       up ? '#2d8a4e' : '#c0392b',
            borderColor: up ? '#2d8a4e' : '#c0392b',
            wickColor:   up ? '#2d8a4e' : '#c0392b',
        });
    });
}

/**
 * Aggregiert Tageskerzen auf Wochen- oder Monatsebene.
 * @param {Array} candles - Tageskerzen
 * @param {string} tf - '1D', '1W', '1M'
 * @returns {Array} Aggregierte Kerzen
 */
function aggregateCandles(candles, tf) {
    if (tf === '1D') return candles;
    var groups = {};
    candles.forEach(function(c) {
        var d = new Date(c.time);
        var key;
        if (tf === '1W') {
            var day = d.getDay();
            var diff = d.getDate() - day + (day === 0 ? -6 : 1);
            var mon = new Date(d.setDate(diff));
            key = mon.toISOString().slice(0, 10);
        } else { // 1M
            key = c.time.slice(0, 7) + '-01';
        }
        if (!groups[key]) {
            groups[key] = { time: key, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0 };
        } else {
            groups[key].high   = Math.max(groups[key].high, c.high);
            groups[key].low    = Math.min(groups[key].low, c.low);
            groups[key].close  = c.close;
            groups[key].volume = (groups[key].volume || 0) + (c.volume || 0);
        }
    });
    return Object.values(groups).sort(function(a, b) { return a.time.localeCompare(b.time); });
}

/**
 * Aggregiert Volumen auf Wochen- oder Monatsebene.
 */
function aggregateVolume(candles, tf) {
    if (tf === '1D') return candles;
    return aggregateCandles(candles, tf).map(function(c) {
        return { time: c.time, volume: c.volume || 0 };
    });
}

// ╔══════════════════════════════════════════════════════════╗
// ║  3. INDEX-BERECHNUNG                                      ║
// ╚══════════════════════════════════════════════════════════╝

/**
 * Berechnet den Portfoliowert an einem Datum.
 * Portfoliowert = Σ(Kurs_i × Anzahl_i) für alle Ticker mit Anzahl > 0
 */
function portfolioValue(dataMap, dateStr) {
    var val = 0;
    Object.keys(WEIGHTS).forEach(function(sym) {
        var w = WEIGHTS[sym];
        if (!w || w === 0) return;
        var bar = (dataMap[sym] || []).find(function(d) { return d.time === dateStr; });
        if (bar && bar.close) val += bar.close * w;
    });
    return val;
}

/**
 * Berechnet die Tagesrendite als gleichgewichteter Durchschnitt.
 */
function dayReturn(dataMap, dateStr, prevDateStr) {
    var rO = 0, rH = 0, rL = 0, rC = 0, n = 0;
    Object.keys(WEIGHTS).forEach(function(sym) {
        if ((WEIGHTS[sym] || 0) === 0) return;
        var bar  = (dataMap[sym] || []).find(function(d) { return d.time === dateStr; });
        var prev = (dataMap[sym] || []).find(function(d) { return d.time === prevDateStr; });
        if (!bar || !prev || prev.close <= 0) return;
        rO += bar.open  / prev.close - 1;
        rH += bar.high  / prev.close - 1;
        rL += bar.low   / prev.close - 1;
        rC += bar.close / prev.close - 1;
        n++;
    });
    if (n === 0) return null;
    return { rO: rO/n, rH: rH/n, rL: rL/n, rC: rC/n };
}

/**
 * Baut den gewichteten Portfolio-Index aus allen Ticker-Daten.
 * Normiert auf Startwert 100.
 * @param {Object} dataMap - { AAPL: [{time, close, ...}] }
 * @returns {Array} [{time, open, high, low, close, volume}]
 */
function buildIndex(dataMap, currencies, baseCurrency, fxDataMap) {
    // ── Wertgewichteter Portfolio-Index ──────────────────────────
    // Index = Portfoliowert / Basis-Portfoliowert × 100
    // Portfoliowert = Σ(Kurs_i × Anzahl_i × FX_i)
    // FX_i = Umrechnungsfaktor zur Basiswährung (Standard: USD)
    // ─────────────────────────────────────────────────────────────
    var _currencies = currencies || {};
    var _baseCur    = baseCurrency || 'USD';
    var _fxMap      = fxDataMap   || {};

    // FX Forward-Fill-Tabellen für alle benötigten Währungspaare
    var _fxSorted = {}, _fxPtrs = {}, _fxLast = {};
    Object.keys(_fxMap).forEach(function(pair) {
        _fxSorted[pair] = (_fxMap[pair] || []).slice().sort(function(a, b) {
            return a.time < b.time ? -1 : 1;
        });
        _fxPtrs[pair] = 0;
        _fxLast[pair] = null;
    });

    // FX-Umrechnungsfaktor für einen Kurs in `cur` → `_baseCur`
    function fxRate(cur) {
        if (!cur || cur === _baseCur) return 1;
        var isGBp = (cur === 'GBp');
        var baseCur3 = isGBp ? 'GBP' : cur;
        var pair = baseCur3 + _baseCur + '=X';
        var bar = _fxLast[pair];
        if (!bar) return 1;  // kein FX-Kurs verfügbar → kein Konvertierung
        return isGBp ? bar.close / 100 : bar.close;
    }

    // Alle Handelstage sammeln
    var datesSet = new Set();
    Object.keys(WEIGHTS).forEach(function(sym) {
        if ((WEIGHTS[sym] || 0) === 0) return;
        (dataMap[sym] || []).forEach(function(d) { datesSet.add(d.time); });
    });
    // Wochenenden aus dem Datum-Set entfernen (Samstag=6, Sonntag=0)
    var dates = Array.from(datesSet).sort().filter(function(d) {
        var day = new Date(d + 'T12:00:00Z').getUTCDay();
        return day !== 0 && day !== 6;
    });
    if (dates.length === 0) return [];

    // Sortierte Arrays + Zeiger pro Ticker für Forward-Fill (O(n) statt O(n²))
    // Fehlt ein Ticker an einem Tag (Wochenende/Feiertag), wird der letzte bekannte Kurs genutzt.
    var _sorted = {}, _ptrs = {}, _last = {};
    Object.keys(WEIGHTS).forEach(function(sym) {
        if ((WEIGHTS[sym] || 0) === 0) return;
        _sorted[sym] = (dataMap[sym] || []).slice().sort(function(a, b) {
            return a.time < b.time ? -1 : 1;
        });
        _ptrs[sym] = 0;
        _last[sym] = null;
    });

    // Zeiger für alle Ticker und FX-Paare bis einschließlich `date` vorwärts schieben
    function advanceTo(date) {
        Object.keys(WEIGHTS).forEach(function(sym) {
            if ((WEIGHTS[sym] || 0) === 0) return;
            var bars = _sorted[sym];
            while (_ptrs[sym] < bars.length && bars[_ptrs[sym]].time <= date) {
                _last[sym] = bars[_ptrs[sym]];
                _ptrs[sym]++;
            }
        });
        Object.keys(_fxSorted).forEach(function(pair) {
            var bars = _fxSorted[pair];
            while (_fxPtrs[pair] < bars.length && bars[_fxPtrs[pair]].time <= date) {
                _fxLast[pair] = bars[_fxPtrs[pair]];
                _fxPtrs[pair]++;
            }
        });
    }

    // Portfoliowert mit Forward-Fill: fehlt ein Ticker-Bar, letzten bekannten Kurs nehmen
    function portVal(field) {
        var val = 0;
        Object.keys(WEIGHTS).forEach(function(sym) {
            var w = WEIGHTS[sym] || 0;
            if (w === 0) return;
            var bar = _last[sym];
            if (bar && bar[field]) {
                var fx = fxRate(_currencies[sym]);
                val += bar[field] * w * fx;
            }
        });
        return val;
    }

    // Basis = Schlusskurs-Portfoliowert am ersten Handelstag
    advanceTo(dates[0]);
    var baseVal = portVal('close');
    if (baseVal === 0) return [];

    // Zeiger zurücksetzen — forEach beginnt ebenfalls bei dates[0]
    Object.keys(WEIGHTS).forEach(function(sym) { _ptrs[sym] = 0; _last[sym] = null; });
    Object.keys(_fxSorted).forEach(function(pair) { _fxPtrs[pair] = 0; _fxLast[pair] = null; });

    // Brutto-Summe der Gewichte (|w|) als Normierung — bleibt positiv/stabil auch wenn
    // Short-Gewichte (negativ, z.B. Future-Hedge) dabei sind. portVal subtrahiert Shorts
    // ohnehin korrekt (Σ Kurs×w×fx), div skaliert nur die absolute Höhe.
    var totalShares = Object.keys(WEIGHTS).reduce(function(sum, sym) {
        return sum + Math.abs(WEIGHTS[sym] || 0);
    }, 0);
    var div = totalShares || 1;

    var result = [];
    dates.forEach(function(date) {
        advanceTo(date);
        var closeVal = portVal('close');
        var openVal  = portVal('open')  || closeVal;
        var highVal  = portVal('high')  || closeVal;
        var lowVal   = portVal('low')   || closeVal;
        // Sicherheitsnetz: high/low dürfen open/close nicht um >50% überschreiten
        // (verhindert Ausreißer durch fehlerhafte DB-Einträge)
        var maxRange = Math.max(openVal, closeVal) * 1.5;
        var minRange = Math.min(openVal, closeVal) * 0.5;
        if (highVal > maxRange) highVal = Math.max(openVal, closeVal);
        if (lowVal  < minRange) lowVal  = Math.min(openVal, closeVal);

        // Volumen nur für Tage mit echten Bars summieren (kein Forward-Fill bei Volumen)
        var vol = 0;
        Object.keys(WEIGHTS).forEach(function(sym) {
            var w = WEIGHTS[sym] || 0;
            if (w === 0) return;
            var bar = _last[sym];
            if (bar && bar.time === date && bar.volume && bar.close) {
                var fx = fxRate(_currencies[sym]);
                vol += bar.volume * bar.close * w * fx;
            }
        });

        result.push({
            time:   date,
            open:   parseFloat((openVal  / div).toFixed(2)),
            high:   parseFloat((highVal  / div).toFixed(2)),
            low:    parseFloat((lowVal   / div).toFixed(2)),
            close:  parseFloat((closeVal / div).toFixed(2)),
            volume: vol,
        });
    });
    return result;
}

// ╔══════════════════════════════════════════════════════════╗
// ║  4. STATS (Statuszeile)                                   ║
// ╚══════════════════════════════════════════════════════════╝

/**
 * Berechnet Statistiken für die Statuszeile.
 * Setzt DOM-Elemente — nur auf Desktop vorhanden.
 */
function computeStats(candles) {
    if (!candles || candles.length === 0) return;
    var last  = candles[candles.length - 1];
    var prev  = candles.length > 1 ? candles[candles.length - 2] : last;
    var first = candles[0];

    var setEl = function(id, val) {
        var el = document.getElementById(id);
        if (el) el.textContent = val;
    };
    var pct = function(a, b) { return b > 0 ? ((a/b - 1)*100).toFixed(2) + '%' : '-'; };
    var fmt = function(v) { return v ? v.toFixed(2) : '-'; };

    setEl('sv',  '$' + fmt(last.close));
    setEl('s1d', pct(last.close, prev.close));
    setEl('s1w', candles.length > 5  ? pct(last.close, candles[Math.max(0, candles.length-6)].close)  : '-');
    setEl('s1m', candles.length > 22 ? pct(last.close, candles[Math.max(0, candles.length-23)].close) : '-');
    setEl('s3m', candles.length > 66 ? pct(last.close, candles[Math.max(0, candles.length-67)].close) : '-');
    setEl('shi', '$' + fmt(Math.max.apply(null, candles.map(function(c){ return c.high; }))));
    setEl('slo', '$' + fmt(Math.min.apply(null, candles.map(function(c){ return c.low; }))));
    setEl('sct', String(Object.keys(WEIGHTS).filter(function(s){ return (WEIGHTS[s]||0) > 0; }).length));
}

// ╔══════════════════════════════════════════════════════════╗
// ║  5. PERFORMANCE-TABELLE                                   ║
// ╚══════════════════════════════════════════════════════════╝

/**
 * Berechnet Performance-Daten für einen Ticker.
 * @param {Array} data - [{time, close}]
 * @returns {Object} { price, d1, d5, d22, d66, ytd }
 */
function calcPerf(data) {
    if (!data || data.length < 2) return null;
    var last = data[data.length - 1];

    var get = function(n) {
        var idx = data.length - 1 - n;
        return idx >= 0 ? data[idx].close : null;
    };

    var pct = function(from) {
        if (from === null || from === undefined || from <= 0) return null;
        return ((last.close / from - 1) * 100).toFixed(2);
    };

    var year    = new Date().getFullYear().toString();
    var yearBar = data.find(function(d) { return d.time.startsWith(year); });

    return {
        price: last.close,
        d1:    pct(get(1)),
        d5:    pct(get(5)),
        d22:   pct(get(22)),
        d66:   pct(get(66)),
        ytd:   yearBar ? pct(yearBar.close) : null,
    };
}

/**
 * Baut perfData aus _dataMap auf.
 * Speichert in globaler Variable perfData.
 */
function buildPerfData() {
    perfData = {};
    Object.keys(WEIGHTS).forEach(function(sym) {
        var data = _dataMap[sym] || (currentView === sym ? allCandles : null);
        if (data && data.length > 0) {
            perfData[sym] = calcPerf(data);
        }
    });
}

/**
 * Rendert die Performance-Tabelle.
 * Schreibt in #perfBody und #perfFoot.
 * Wird von Desktop direkt und von Mobile via Kopie genutzt.
 */
function renderPerfTable() {
    var tbody = document.getElementById('perfBody');
    var foot  = document.getElementById('perfFoot');
    if (!tbody) return;

    buildPerfData();

    var sortVal = (document.getElementById('perfSort') || {}).value || 'alpha';

    var fmt = function(v) {
        if (v === null || v === undefined || v === 'n/a') return '<td style="color:var(--muted)">-</td>';
        var n = parseFloat(v);
        var color = n >= 0 ? '#2d8a4e' : '#c0392b';
        return '<td style="color:' + color + '">' + (n >= 0 ? '+' : '') + parseFloat(v).toFixed(2) + '%</td>';
    };

    // IBKR P&L-Hilfsfunktionen (per IBKR-Symbol und Yahoo-Symbol auffindbar)
    var ibkrMap = {};
    (ibkrPositions || []).forEach(function(p) {
        ibkrMap[p.symbol] = p;
        if (p.yahoo_symbol) ibkrMap[p.yahoo_symbol] = p;
        ibkrMap[ibkrPosYahoo(p)] = p;   // gemapptes Yahoo-Symbol (ISIN-Mapping)
    });

    var ibkrPnlPct = function(sym) {
        var pos = ibkrMap[sym];
        if (!pos || !(pos.cost_basis_price > 0)) return null;
        return ((pos.mark_price - pos.cost_basis_price) / pos.cost_basis_price * 100).toFixed(2);
    };

    // Währung→EUR aus IBKRs eigenen FX-Raten (fx_rate_to_base, Base=EUR).
    var ccyFx = {};
    (ibkrPositions || []).forEach(function(p) {
        if (p.currency && p.fx_rate_to_base) ccyFx[p.currency] = p.fx_rate_to_base;
    });
    function eurValue(cur, amount) {
        if (cur === 'EUR') return amount;
        if (cur === 'GBp' || cur === 'GBX') return ccyFx['GBP'] ? amount * ccyFx['GBP'] / 100 : null;
        return (cur in ccyFx) ? amount * ccyFx[cur] : null;
    }

    // IBKR Index-P&L (nur Ticker die im Basket UND in IBKR sind)
    var ibkrTotalCost = 0, ibkrTotalValue = 0;
    (ibkrPositions || []).forEach(function(p) {
        var sym = p.yahoo_symbol || p.symbol;
        if ((WEIGHTS[sym] || WEIGHTS[p.symbol] || 0) > 0) {
            var fx = p.fx_rate_to_base || 1;
            ibkrTotalCost  += (p.cost_basis_money || 0) * fx;
            ibkrTotalValue += (p.position_value   || 0) * fx;
        }
    });
    var idxIbkrPnl = ibkrTotalCost > 0
        ? ((ibkrTotalValue - ibkrTotalCost) / ibkrTotalCost * 100).toFixed(2) : null;

    // Sortierung
    var syms = Object.keys(perfData);
    var sortKey = { alpha: null, '1d': 'd1', '1w': 'd5', '1m': 'd22', '3m': 'd66', ytd: 'ytd', ibkr: '_ibkr' }[sortVal];
    if (sortKey === '_ibkr') {
        syms.sort(function(a, b) {
            return parseFloat(ibkrPnlPct(b) || 0) - parseFloat(ibkrPnlPct(a) || 0);
        });
    } else {
        syms.sort(function(a, b) {
            if (!sortKey) return a.localeCompare(b);
            return parseFloat(perfData[b][sortKey] || 0) - parseFloat(perfData[a][sortKey] || 0);
        });
    }

    // INDEX-Zeile
    var html = '';
    if (allCandles.length > 0) {
        var last    = allCandles[allCandles.length - 1];
        var get     = function(n) { return allCandles[Math.max(0, allCandles.length-1-n)].close || last.close; };
        var pct     = function(f) { return ((last.close / f - 1) * 100).toFixed(2); };
        var yearBar = allCandles.find(function(c) { return c.time.startsWith(new Date().getFullYear().toString()); });

        var cs = basketCurSymbol();
        html += '<tr style="background:var(--bg);border-bottom:2px solid var(--border);">'
            + '<td style="font-weight:700;color:var(--text);">&#9679; INDEX</td>'
            + '<td style="font-weight:700;">' + cs + last.close.toFixed(2) + '</td>'
            + '<td></td><td></td><td></td>'
            + fmt(idxIbkrPnl)
            + fmt(pct(get(1))) + fmt(pct(get(5))) + fmt(pct(get(22))) + fmt(pct(get(66)))
            + fmt(yearBar ? pct(yearBar.close) : null)
            + '</tr>';
    }

    // Ticker-Zeilen — Kurs/Position in Ticker-Währung, zusätzliche Spalte in EUR
    var totalValue = 0, totalPrevValue = 0;

    syms.forEach(function(sym) {
        var p = perfData[sym];
        if (!p) return;
        var anzahl   = WEIGHTS[sym] || 0;
        var tcs      = tickerCurSymbol(sym);
        var posValue = p.price * anzahl;                          // nativ (Ticker-Währung)
        var eurVal   = eurValue(tickerCurrencies[sym], posValue); // → EUR via IBKR-FX
        if (eurVal !== null) {
            totalValue     += eurVal;
            totalPrevValue += eurVal / (1 + parseFloat(p.d1 || 0) / 100);
        }

        html += '<tr>'
            + '<td style="font-weight:500">' + sym + '</td>'
            + '<td>' + tcs + p.price.toFixed(2) + '</td>'
            + '<td style="color:var(--muted)">' + anzahl + '</td>'
            + '<td>' + tcs + posValue.toFixed(0) + '</td>'
            + '<td style="font-weight:500">' + (eurVal !== null ? '€' + eurVal.toFixed(0) : '-') + '</td>'
            + fmt(ibkrPnlPct(sym))
            + fmt(p.d1) + fmt(p.d5) + fmt(p.d22) + fmt(p.d66) + fmt(p.ytd)
            + '</tr>';
    });

    tbody.innerHTML = html;

    // Summenzeile
    if (foot && totalValue > 0) {
        var totalChg  = ((totalValue - totalPrevValue) / totalPrevValue * 100).toFixed(2);
        var chgColor  = parseFloat(totalChg) >= 0 ? '#2d8a4e' : '#c0392b';
        var ibkrColor = idxIbkrPnl ? (parseFloat(idxIbkrPnl) >= 0 ? '#2d8a4e' : '#c0392b') : '';

        foot.innerHTML = '<tr style="border-top:2px solid var(--border);background:var(--bg);">'
            + '<td style="font-weight:700">TOTAL</td>'
            + '<td></td><td></td><td></td>'
            + '<td style="font-weight:700">&euro;' + totalValue.toFixed(0) + '</td>'
            + (idxIbkrPnl ? '<td style="font-weight:700;color:' + ibkrColor + '">' + (parseFloat(idxIbkrPnl)>=0?'+':'') + idxIbkrPnl + '%</td>' : '<td>-</td>')
            + '<td style="font-weight:700;color:' + chgColor + '">' + (parseFloat(totalChg)>=0?'+':'') + totalChg + '%</td>'
            + '<td colspan="4" style="color:var(--muted);font-size:10px;">' + syms.length + ' Pos.</td>'
            + '</tr>';
    }
}

// ╔══════════════════════════════════════════════════════════╗
// ║  6. APPLYPERIOD — Zentraler Renderer                     ║
// ╚══════════════════════════════════════════════════════════╝

/**
 * Zentraler Rendering-Einstiegspunkt.
 * Wird aufgerufen bei: Datenladen, Zeitraum-Wechsel, TF-Wechsel, Indikator-Toggle.
 *
 * Ablauf:
 *   1. Daten filtern & aggregieren
 *   2. Kerzen einfärben
 *   3. LogReg berechnen
 *   4. Desktop Chart rendern (via renderDesktopChart aus desktop.js)
 *   5. Mobile Chart rendern (via renderMobileChart aus mobile.js)
 *   6. Performance-Tabelle aktualisieren
 *   7. Stats-Zeile aktualisieren
 */
function applyPeriod() {
    if (!allCandles.length) {
        // Leerer Basket — Chart und Tabellen explizit leeren
        _lastCandles = [];
        if (typeof renderDesktopChart === 'function') renderDesktopChart([], [], [], null);
        if (typeof renderWatchlist    === 'function') renderWatchlist();
        renderPerfTable();
        return;
    }

    // 1. Filtern
    var filtered = allCandles;
    if (currentPeriod > 0) {
        var cut = new Date();
        cut.setDate(cut.getDate() - currentPeriod);
        var cutStr = cut.toISOString().slice(0, 10);
        filtered = allCandles.filter(function(c) { return c.time >= cutStr; });
    }

    // 2. Aggregieren
    var agg    = aggregateCandles(filtered, currentTF);
    var volAgg = aggregateVolume(filtered, currentTF);

    // 3. Einfärben
    var colored = colorCandles(agg);
    _lastCandles = colored;

    // 4. LogReg berechnen — Zeitrahmen editierbar via #regPeriod Input
    var regResult = null;
    if (indicators.reg && agg.length >= 10) {
        var regPeriodEl = document.getElementById('regPeriod');
        var regN = regPeriodEl ? Math.max(5, parseInt(regPeriodEl.value, 10) || 12) : 12;
        var regCandles = agg.slice(-regN);
        if (regCandles.length < 10) regCandles = agg;
        var bpy = currentTF === '1W' ? 52 : currentTF === '1M' ? 12 : 252;
        regResult = calcLogReg(regCandles, 2, bpy);
    }

    // 5. Desktop Chart rendern (desktop.js stellt renderDesktopChart bereit)
    if (typeof renderDesktopChart === 'function') {
        renderDesktopChart(colored, volAgg, agg, regResult);
    }

    // 6. Mobile Chart rendern (mobile.js stellt renderMobileChart bereit)
    if (typeof renderMobileChart === 'function') {
        renderMobileChart(colored, volAgg, agg, regResult);
    }

    // 7. Stats + Performance
    computeStats(allCandles);
    renderPerfTable();
}

// ╔══════════════════════════════════════════════════════════╗
// ║  7. ZEITRAUM & TIMEFRAME                                  ║
// ╚══════════════════════════════════════════════════════════╝

function setPeriod(days) {
    currentPeriod = days;
    applyPeriod();
    markUnsaved();
}

function setTF(tf) {
    currentTF = tf;
    // Sinnvoller Standardzeitraum für Wochen/Monatskerzen
    if (tf !== '1D' && currentPeriod < 365) {
        currentPeriod = 0; // All
    }
    applyPeriod();
    loadDrawings(); // Anker auf neue TF-Bars snappen
    markUnsaved();
}

function togInd(name) {
    indicators[name] = !indicators[name];
    applyPeriod();
    markUnsaved();
}

function togLog() {
    logScale = !logScale;
    applyPeriod();
    markUnsaved();
}

// ╔══════════════════════════════════════════════════════════╗
// ║  8. API-CALLS                                             ║
// ╚══════════════════════════════════════════════════════════╝

/**
 * Lädt Konfiguration (Baskets) vom Server.
 */
async function loadConfig() {
    try {
        var r   = await fetch('/api/config');
        var cfg = await r.json();
        baskets       = cfg.baskets       || {};
        currentBasket = cfg.currentBasket || '';
        // Aussehen wiederherstellen und anwenden
        appearance    = Object.assign(appearance, cfg.appearance || {});
        if (typeof applyAppearance === 'function') applyAppearance();
        // Layout merken (auch auf Mobile — sonst ginge der Desktop-Stand beim
        // nächsten Speichern verloren) und, wenn vorhanden, anwenden.
        if (cfg.layout) _layout = cfg.layout;
        if (typeof loadLayout === 'function') loadLayout();

        // Erster Basket als Default
        if (!currentBasket || !baskets[currentBasket]) {
            var keys = Object.keys(baskets);
            currentBasket = keys.length > 0 ? keys[0] : '';
        }

        // Neuer Basket falls keine vorhanden
        if (Object.keys(baskets).length === 0) {
            var id = 'basket_' + Date.now();
            baskets[id] = { name: 'Mein Portfolio', weights: {}, period: 180, tf: '1D', indicators: { ma50: false, ma200: false, reg: false }, logScale: false };
            currentBasket = id;
            await saveBasketsToServer();
        }

        loadBasketState();
        if (typeof renderBasketSelect === 'function') renderBasketSelect();
        logIt(3, 'Config', 'Geladen: ' + Object.keys(baskets).length + ' Portfolios, aktiv „'
            + ((baskets[currentBasket] || {}).name || currentBasket) + '"');
    } catch (e) {
        logIt(1, 'Config', 'Laden fehlgeschlagen: ' + e.message);
    }
}

/**
 * Speichert Konfiguration auf Server (atomar via main.py).
 */
async function saveBasketsToServer() {
    try {
        await fetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ baskets: baskets, currentBasket: currentBasket, appearance: appearance, layout: _layout || {} })
        });
    } catch (e) {
        console.warn('saveBasketsToServer failed:', e);
    }
}

/**
 * Speichert alles — wird vom Speichern-Button aufgerufen.
 */
async function saveAll(btn) {
    if (btn) { btn.textContent = '...'; btn.disabled = true; }
    try {
        saveCurrentBasketState();
        await saveBasketsToServer();
        if (btn) { btn.textContent = '✓ Gespeichert'; btn.style.background = '#2d8a4e'; }
    } catch (e) {
        if (btn) { btn.textContent = '✗ Fehler'; btn.style.background = '#c0392b'; }
        console.error('saveAll failed:', e);
    } finally {
        setTimeout(function() {
            if (btn) {
                btn.textContent = '✓ Speichern';
                btn.disabled = false;
                btn.style.background = '#2d8a4e';
            }
        }, 2000);
    }
}

/**
 * Lädt alle Ticker aus der DB.
 */
async function loadDbTickers() {
    try {
        var r    = await fetch('/api/prices/status/all');
        var data = await r.json();
        TICKERS  = Object.keys(data);
        _volumeData = []; // Reset
        logIt(3, 'DB', TICKERS.length + ' Ticker mit Kursdaten in der Datenbank');
        // Bei hohem Detailgrad: welcher Ticker hängt auf welchem Stand fest?
        if (logLevel >= 9) {
            TICKERS.forEach(function(t) {
                logIt(9, 'DB', t + ': bis ' + data[t].last + ' (' + data[t].count + ' Tage)');
            });
        }
    } catch (e) {
        logIt(1, 'DB', 'Ticker-Status konnte nicht geladen werden: ' + e.message);
    }
}

/**
 * Ermittelt die Wechselkurs-Paare, die die Baskets zum Umrechnen auf ihre
 * Basiswährung brauchen (z.B. GBPUSD=X für eine Londoner Aktie im USD-Basket).
 *
 * Die Währung je Ticker kennt nur der Server (Tabelle ticker_currency, gefüllt
 * beim Kurs-Update) — ein frisch angelegter Ticker liefert sein Paar deshalb
 * erst beim nächsten Durchlauf nach. Das ist selbstheilend und billiger, als
 * die Währung hier im Frontend zu spiegeln.
 */
async function neededFxPairs(tickers) {
    var curr;
    try {
        var r = await fetch('/api/prices/currencies?tickers=' + encodeURIComponent(tickers.join(',')));
        curr = await r.json();
    } catch (e) {
        logIt(2, 'Kurse', 'Währungen nicht abrufbar — Wechselkurse bleiben auf altem Stand: ' + e.message);
        return [];
    }
    var pairs = new Set();
    Object.values(baskets).forEach(function(b) {
        var base = b.baseCurrency || 'USD';
        Object.keys(b.weights || {}).forEach(function(s) {
            if ((b.weights[s] || 0) === 0) return;
            var c = curr[s] || curr[s.toUpperCase()];
            if (!c) return;
            if (c === 'GBp') c = 'GBP';   // Pence notiert, Kurs kommt über GBP
            if (c === base) return;
            pairs.add(c + base + '=X');
        });
    });
    return Array.from(pairs);
}

/**
 * Aktualisiert alle Ticker-Preise via Yahoo Finance.
 */
async function updateAllPrices() {
    var _allT = new Set();
    Object.values(baskets).forEach(function(b) {
        Object.keys(b.weights || {}).forEach(function(s) { if ((b.weights[s] || 0) !== 0) _allT.add(s); });
    });
    var tickers = Array.from(_allT);
    if (tickers.length === 0) {
        logIt(2, 'Kurse', 'Kein Ticker mit Gewicht ≠ 0 — nichts zu aktualisieren');
        return { ok: true, requested: 0, updated: 0, failed: {} };
    }
    logIt(6, 'Kurse', 'Yahoo-Update für ' + tickers.length + ' Ticker: ' + tickers.join(', '));

    // Wechselkurs-Paare mit aktualisieren: loadIndexData() holt sie nur aus der
    // Datenbank. Fehlt das Paar dort, bleibt die Fremdwährungs-Position still
    // unkonvertiert im Index stehen — hier ist die einzige Stelle, die es füllt.
    var fxPairs = await neededFxPairs(tickers);
    if (fxPairs.length) logIt(6, 'Kurse', 'Wechselkurse mit aktualisieren: ' + fxPairs.join(', '));
    var all = tickers.concat(fxPairs);

    try {
        var r = await fetch('/api/prices/update', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tickers: all })
        });
        var data = await r.json();

        if (r.status === 429) {
            logIt(2, 'Kurse', 'Rate-Limit — noch ' + (data.retry_after || 60) + ' s bis zum nächsten Update');
            return { ok: false, rateLimited: true, retryAfter: data.retry_after || 60,
                     requested: all.length, updated: 0, failed: {} };
        }
        var failed = data.failed || {};
        var nFailed = Object.keys(failed).length;
        if (nFailed) {
            logIt(1, 'Kurse', nFailed + ' von ' + all.length + ' Tickern fehlgeschlagen');
            Object.keys(failed).forEach(function(t) { logIt(2, 'Kurse', t + ': ' + failed[t]); });
        } else {
            logIt(3, 'Kurse', 'Alle ' + all.length + ' Ticker aktualisiert');
        }
        return {
            ok: !!data.ok, requested: all.length,
            updated: data.updated != null ? data.updated : all.length - nFailed,
            failed: failed
        };
    } catch (e) {
        logIt(1, 'Kurse', 'Update-Aufruf fehlgeschlagen: ' + e.message);
        return { ok: false, requested: all.length, updated: 0,
                 failed: {}, transport: e.message };
    }
}

/**
 * Refresh-Button-Handler: sperrt den Button während Update + Laden,
 * verhindert Doppelklick und Race Conditions durch parallele loadData-Aufrufe.
 */
async function doRefresh() {
    var btn = document.getElementById('refreshBtn') || document.getElementById('m-refresh-btn');
    if (btn && btn.disabled) return;
    var origText = btn ? btn.textContent : '';
    if (btn) {
        btn.disabled = true;
        btn.style.opacity = '0.55';
        btn.textContent = btn.id === 'm-refresh-btn' ? '…' : '⟳ Laden…';
    }
    var done = logTimer(4, 'Refresh', 'Kurse aktualisieren + neu laden');
    try {
        var res = await updateAllPrices();
        await loadData();
        setRefreshStatus(res);
        done(res.ok ? res.updated + ' Ticker' : 'mit Fehlern');
        return res;
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.style.opacity = '';
            btn.textContent = origText;
        }
    }
}

/**
 * Schreibt das Ergebnis eines Refresh sichtbar in die Fußzeile (#lastUpdate).
 * Vorher stand dort dauerhaft „Noch nicht geladen" — ein fehlgeschlagenes oder
 * durch das Rate-Limit abgewiesenes Update war von einem erfolgreichen nicht
 * zu unterscheiden.
 */
function setRefreshStatus(res) {
    var el = document.getElementById('lastUpdate');
    if (!el) return;
    var now = new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    if (res.rateLimited) {
        el.textContent = '⏳ ' + now + ' — Rate-Limit, Kurse unverändert (noch ' + res.retryAfter + ' s)';
        el.style.color = '#d08a1e';
        return;
    }
    if (res.transport) {
        el.textContent = '✕ ' + now + ' — Server nicht erreichbar: ' + res.transport;
        el.style.color = 'var(--red)';
        return;
    }
    var failedSyms = Object.keys(res.failed || {});
    if (failedSyms.length) {
        el.textContent = '⚠ ' + now + ' — ' + res.updated + '/' + res.requested
            + ' aktualisiert, fehlgeschlagen: ' + failedSyms.slice(0, 6).join(', ')
            + (failedSyms.length > 6 ? ' …' : '') + ' (Details im Protokoll)';
        el.style.color = 'var(--red)';
        return;
    }
    el.textContent = '✓ ' + now + ' — ' + res.updated + ' Ticker aktualisiert';
    el.style.color = '';
}

/**
 * Lädt Kursdaten für einen einzelnen Ticker.
 */
async function fetchTicker(sym, ensure) {
    try {
        // ensure=true: der Server holt fehlende/veraltete Tage vorher bei Yahoo
        // (gedrosselt auf 1 Abruf pro Ticker und Minute). Sonst nur Datenbank.
        var url  = ensure ? '/api/prices/ensure/' + encodeURIComponent(sym)
                          : '/api/prices/' + sym;
        var r    = await fetch(url, { cache: 'no-store' });
        var data = await r.json();
        if (!Array.isArray(data)) throw new Error('Unerwartete Antwort für ' + sym);
        if (!data.length) logIt(2, 'Kurse', sym + (ensure ? ': auch bei Yahoo keine Kursdaten'
                                                         : ': keine Kursdaten in der Datenbank'));
        else logIt(7, 'Kurse', sym + ': ' + data.length + ' Tage, letzter ' + data[data.length - 1].date);
        return data.map(function(d) {
            return {
                time:   d.date,
                open:   d.open,
                high:   d.high,
                low:    d.low,
                close:  d.close,
                volume: d.volume || 0,
            };
        }).filter(function(d) {
            var day = new Date(d.time + 'T12:00:00Z').getUTCDay();
            return day !== 0 && day !== 6;
        });
    } catch (e) {
        logIt(1, 'Kurse', sym + ': Abruf fehlgeschlagen — ' + e.message);
        return [];
    }
}

/**
 * Lädt Index-Daten: alle Ticker parallel, dann Index berechnen.
 */
async function loadIndexData() {
    if (typeof showLoading === 'function') showLoading('Lade Index...');
    var done = logTimer(4, 'Index', 'Indexdaten laden');
    try {
        var syms = Object.keys(WEIGHTS).filter(function(s) { return (WEIGHTS[s] || 0) !== 0; });
        if (syms.length === 0) {
            allCandles = []; _lastCandles = []; _dataMap = {}; _fxDataMap = {}; tickerCurrencies = {};
            if (typeof renderDesktopChart === 'function') renderDesktopChart([], [], [], null);
            if (typeof renderWatchlist    === 'function') renderWatchlist();
            renderPerfTable();
            if (typeof hideLoading === 'function') hideLoading();
            logIt(2, 'Index', 'Portfolio ohne Positionen — nichts zu zeichnen');
            done();
            return;
        }

        // Alle Ticker parallel laden
        logIt(6, 'Index', syms.length + ' Ticker aus der Datenbank abrufen');
        var results = await Promise.all(syms.map(function(sym) {
            return fetchTicker(sym).then(function(data) {
                return { sym: sym, data: data };
            });
        }));

        results.forEach(function(r) { _dataMap[r.sym] = r.data; });
        var leer = results.filter(function(r) { return !r.data.length; }).map(function(r) { return r.sym; });
        if (leer.length) logIt(2, 'Index', 'Ohne Kursdaten: ' + leer.join(', '));

        // Währungen laden und FX-Paare bei Bedarf nachladen
        try {
            var currResp = await fetch('/api/prices/currencies?tickers=' + syms.join(','));
            tickerCurrencies = await currResp.json();
        } catch(e) {
            tickerCurrencies = {};
            logIt(2, 'Index', 'Währungen nicht abrufbar — rechne ohne Umrechnung: ' + e.message);
        }

        var basket   = baskets[currentBasket] || {};
        var baseCur  = basket.baseCurrency || 'USD';
        var fxNeeded = {};
        syms.forEach(function(s) {
            var c = tickerCurrencies[s];
            if (c && c !== baseCur) {
                var pair = (c === 'GBp' ? 'GBP' : c) + baseCur + '=X';
                fxNeeded[pair] = true;
            }
        });
        _fxDataMap = {};
        var fxPairs = Object.keys(fxNeeded);
        if (fxPairs.length > 0) {
            var fxResults = await Promise.all(fxPairs.map(function(fx) {
                return fetchTicker(fx).then(function(data) { return { sym: fx, data: data }; });
            }));
            fxResults.forEach(function(r) { if (r.data && r.data.length) _fxDataMap[r.sym] = r.data; });
            logIt(5, 'Index', 'Wechselkurse nach ' + baseCur + ': ' + fxPairs.join(', '));

            // Paar noch nie geholt (neuer Ticker in fremder Währung, oder das Paar
            // stand nie in einem Basket): einmal direkt bei Yahoo nachziehen. Ohne
            // das bliebe die Position bis zum nächsten Refresh unkonvertiert im
            // Index stehen — der Fehler war im Protokoll sichtbar, im Chart nicht.
            var fxFehlt = fxPairs.filter(function(p) { return !_fxDataMap[p]; });
            if (fxFehlt.length) {
                logIt(5, 'Index', 'Wechselkurs fehlt in der Datenbank, hole nach: ' + fxFehlt.join(', '));
                var fxNach = await Promise.all(fxFehlt.map(function(fx) {
                    return fetchTicker(fx, true).then(function(data) { return { sym: fx, data: data }; });
                }));
                fxNach.forEach(function(r) { if (r.data && r.data.length) _fxDataMap[r.sym] = r.data; });
            }
            var fxLeer = fxPairs.filter(function(p) { return !_fxDataMap[p]; });
            if (fxLeer.length) logIt(2, 'Index', 'Ohne Wechselkurs (Positionen bleiben in Fremdwährung): ' + fxLeer.join(', '));
        }

        // Index aufbauen (mit optionaler Währungskonvertierung)
        allCandles  = buildIndex(_dataMap, tickerCurrencies, baseCur, _fxDataMap);
        _volumeData = allCandles.map(function(c) { return { time: c.time, volume: c.volume }; });

        if (allCandles.length === 0) {
            if (typeof hideLoading === 'function') hideLoading();
            logIt(1, 'Index', 'Indexreihe ist leer — kein Ticker lieferte verwertbare Kurse');
            done();
            return;
        }

        applyPeriod();
        if (typeof renderWatchlist === 'function') renderWatchlist();
        if (typeof hideLoading === 'function') hideLoading();
        done(allCandles.length + ' Tage, Basis ' + baseCur);
    } catch (e) {
        logIt(1, 'Index', 'Laden fehlgeschlagen: ' + e.message);
        if (typeof hideLoading === 'function') hideLoading();
        done('Fehler');
    }
}

/**
 * Lädt Daten für einen einzelnen Ticker.
 */
async function loadTickerData(sym) {
    if (typeof showLoading === 'function') showLoading('Lade ' + sym + '...');
    var done = logTimer(4, 'Chart', sym + ' laden');
    try {
        // ensure=true: der Ticker in der Einzelansicht wird beim Öffnen nachgezogen.
        // Vorher kam er nur aus der Datenbank — steht er in keinem Basket mit
        // Gewicht ≠ 0, fasst ihn "Kurse aktualisieren" nie an, und man sah beliebig
        // alte Kurse und ein während des Handels eingefrorenes Teilvolumen.
        // Der Server drosselt selbst auf einen Yahoo-Abruf je Ticker und Minute.
        var data    = await fetchTicker(sym, true);
        _dataMap[sym] = data;   // auch in _dataMap speichern für buildPerfData()
        allCandles  = data;
        _volumeData = data.map(function(c) { return { time: c.time, volume: c.volume }; });
        applyPeriod();
        if (typeof hideLoading === 'function') hideLoading();
        done(data.length + ' Tage');
    } catch (e) {
        logIt(1, 'Chart', sym + ' laden fehlgeschlagen: ' + e.message);
        if (typeof hideLoading === 'function') hideLoading();
        done('Fehler');
    }
}

/**
 * Lädt Daten je nach aktuellem View (Index oder Ticker).
 */
async function loadData() {
    if (currentView === 'index' && !basketShowIndex()) {
        currentView = Object.keys(WEIGHTS)[0] || 'index';
    }
    if (currentView === 'index') {
        await loadIndexData();
    } else {
        await loadTickerData(currentView);
    }
    if (typeof updateChartMeta === 'function') updateChartMeta();
}

/**
 * Wechselt zwischen Index und Ticker-View.
 */
function switchView(view) {
    logIt(4, 'Ansicht', 'Wechsel ' + currentView + ' → ' + view);
    if (typeof saveChartRange === 'function') saveChartRange();
    if (typeof saveMobileChartRange === 'function') saveMobileChartRange();
    currentView = view;
    allCandles  = [];
    _lastCandles = [];
    drawings    = [];   // sofort leeren, damit redrawAll() während loadData keine alten Drawings zeigt
    loadData().then(function() {
        if (typeof renderWatchlist === 'function') renderWatchlist();
        loadDrawings();
    });
}

// ╔══════════════════════════════════════════════════════════╗
// ║  9. BASKET-VERWALTUNG                                     ║
// ╚══════════════════════════════════════════════════════════╝

/**
 * Hilfsfunktionen für die Config-Derived-Values.
 * Wird aufgerufen wenn WEIGHTS sich ändert.
 */
function updateDerivedConfig() {
    // Kann von Desktop/Mobile erweitert werden
}

/**
 * Speichert den aktuellen Basket-Zustand in der JS-Variable.
 * Noch NICHT auf dem Server — dafür saveAll() aufrufen.
 */
function saveCurrentBasketState() {
    if (!baskets[currentBasket]) return;
    baskets[currentBasket].weights       = Object.assign({}, WEIGHTS);
    baskets[currentBasket].period        = currentPeriod;
    baskets[currentBasket].tf            = currentTF;
    baskets[currentBasket].indicators    = Object.assign({}, indicators);
    baskets[currentBasket].logScale      = logScale;
    if (typeof _showSectorEtf !== 'undefined') baskets[currentBasket].showSectorEtf = _showSectorEtf;
    var rpEl = document.getElementById('regPeriod');
    if (rpEl) baskets[currentBasket].regPeriod = parseInt(rpEl.value, 10) || 12;
}

/**
 * Lädt Basket-Zustand in den globalen State.
 */
function basketShowIndex() {
    var b = baskets[currentBasket];
    return !b || b.showIndex !== false;
}

function loadBasketState() {
    var b = baskets[currentBasket];
    if (!b) return;
    WEIGHTS       = Object.assign({}, b.weights || {});
    currentPeriod = b.period !== undefined ? b.period : 180;
    currentTF     = b.tf || '1D';
    if (b.indicators) indicators = Object.assign({}, b.indicators);
    if (b.logScale !== undefined) logScale = b.logScale;
    if (typeof _showSectorEtf !== 'undefined') _showSectorEtf = !!b.showSectorEtf;
    var rpEl = document.getElementById('regPeriod');
    if (rpEl && b.regPeriod) rpEl.value = b.regPeriod;
    updateDerivedConfig();
    loadPerfDate();
}

/**
 * Stellt das Seit-Datum aus dem Basket wieder her.
 */
function loadPerfDate() {
    var b = baskets[currentBasket];
    var d = b ? (b.perfSinceDate || '') : '';
    var el = document.getElementById('perfSinceDate');
    if (el) el.value = d;
    var h = document.getElementById('sinceHeader');
    if (h) h.textContent = d ? 'Seit ' + d.slice(5) : 'Seit';
}

/**
 * Wechselt den aktiven Basket.
 */
async function switchBasket(id) {
    saveCurrentBasketState();
    currentBasket = id;
    loadBasketState();
    updateDerivedConfig();
    if (typeof renderBasketSelect === 'function') renderBasketSelect();
    if (typeof updateChartTitle   === 'function') updateChartTitle();
    if (typeof syncUIState        === 'function') syncUIState();
    if (typeof renderWatchlist    === 'function') renderWatchlist();
    allCandles  = [];
    currentView = basketShowIndex() ? 'index' : (Object.keys(WEIGHTS)[0] || 'index');
    drawings    = [];
    await loadData();
    loadDrawings();
}

/**
 * Erstellt einen neuen Basket.
 */
async function addBasket() {
    var name = prompt('Name des neuen Baskets:', 'Neues Portfolio');
    if (!name) return;
    var id = 'basket_' + Date.now();
    baskets[id] = {
        name: name, weights: {}, period: 180, tf: '1D',
        perfSinceDate: '', indicators: { ma50: false, ma200: false, reg: false }, logScale: false
    };
    await saveBasketsToServer();
    await switchBasket(id);
}

/**
 * Benennt den aktuellen Basket um.
 */
async function renameBasket() {
    var b = baskets[currentBasket];
    if (!b) return;
    var name = prompt('Neuer Name:', b.name);
    if (!name) return;
    b.name = name;
    if (typeof renderBasketSelect === 'function') renderBasketSelect();
    if (typeof updateChartTitle   === 'function') updateChartTitle();
    if (typeof updateChartMeta    === 'function') updateChartMeta();
    await saveBasketsToServer();
}

/**
 * Löscht den aktuellen Basket.
 */
async function deleteBasket() {
    if (Object.keys(baskets).length <= 1) {
        alert('Mindestens ein Basket muss vorhanden sein.');
        return;
    }
    var b = baskets[currentBasket];
    if (!confirm('"' + (b ? b.name : '') + '" löschen?')) return;
    delete baskets[currentBasket];
    currentBasket = Object.keys(baskets)[0];
    await saveBasketsToServer();
    loadBasketState();
    if (typeof renderBasketSelect === 'function') renderBasketSelect();
    allCandles = [];
    currentView = 'index';
    await loadData();
}

// ╔══════════════════════════════════════════════════════════╗
// ║ 10. NOTIZEN                                               ║
// ╚══════════════════════════════════════════════════════════╝

var _notesTimer = null;

function loadNotes() {
    fetch('/api/notes').then(function(r) { return r.json(); }).then(function(d) {
        var el = document.getElementById('notesArea');
        if (el) el.value = d.text || '';
    }).catch(function(e) { console.warn('loadNotes failed:', e); });
}

function saveNotes() {
    var el = document.getElementById('notesArea');
    if (!el) return;
    fetch('/api/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: el.value })
    }).catch(function(e) { console.warn('saveNotes failed:', e); });
}

// ╔══════════════════════════════════════════════════════════╗
// ║ 11. ZEICHNUNGEN                                           ║
// ╚══════════════════════════════════════════════════════════╝

/**
 * Gibt den View-Key für Zeichnungen zurück.
 * Index:  'index:basket_id'
 * Ticker: 'ticker:AAPL'
 */
function getViewKey() {
    return currentView === 'index'
        ? 'index:' + currentBasket
        : 'ticker:' + currentView;
}

async function loadDrawings() {
    try {
        var r = await fetch('/api/drawings?view=' + getViewKey(), { cache: 'no-store' });
        drawings = await r.json();
        if (typeof onDrawingsLoaded === 'function') onDrawingsLoaded(drawings);
        else if (typeof redrawAll === 'function') redrawAll();
    } catch (e) {
        console.warn('loadDrawings failed:', e);
    }
}

async function saveDrawing(drawing) {
    try {
        await fetch('/api/drawings?view=' + getViewKey(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(drawing)
        });
    } catch (e) {
        console.warn('saveDrawing failed:', e);
    }
}

async function deleteDrawing(id) {
    try {
        await fetch('/api/drawings/' + id + '?view=' + getViewKey(), { method: 'DELETE' });
    } catch (e) {
        console.warn('deleteDrawing failed:', e);
    }
}

async function clearAllDrawings() {
    try {
        await fetch('/api/drawings?view=' + getViewKey(), { method: 'DELETE' });
        drawings = [];
        if (typeof onDrawingsCleared === 'function') onDrawingsCleared();
        else if (typeof redrawAll === 'function') redrawAll();
    } catch (e) {
        console.warn('clearAllDrawings failed:', e);
    }
}

// ╔══════════════════════════════════════════════════════════╗
// ║ 12. IMPORT / EXPORT                                       ║
// ╚══════════════════════════════════════════════════════════╝

/**
 * Parst TXT-Import-Format: "AAPL 10" oder "AAPL,10"
 */
function parseTxt(text) {
    var weights = {};
    text.split('\n').forEach(function(line) {
        line = line.trim();
        if (!line) return;
        var parts = line.split(/[\s,]+/);
        var sym = (parts[0] || '').toUpperCase();
        var w   = parseInt(parts[1] || '1', 10);
        if (sym && !isNaN(w)) weights[sym] = w;   // negativ = Short erlaubt
    });
    return weights;
}

/**
 * Exportiert aktuellen Basket als TXT.
 */
function exportTxt() {
    var text = Object.keys(WEIGHTS).map(function(sym) {
        return sym + ' ' + (WEIGHTS[sym] || 0);
    }).join('\n');
    var blob = new Blob([text], { type: 'text/plain' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (baskets[currentBasket] ? baskets[currentBasket].name : 'portfolio') + '.txt';
    a.click();
}

// ╔══════════════════════════════════════════════════════════╗
// ║ 13. HILFSFUNKTIONEN                                       ║
// ╚══════════════════════════════════════════════════════════╝

/**
 * Markiert den Speichern-Button als ungespeichert (orange).
 * Wird aufgerufen wenn State sich ändert.
 */
function markUnsaved() {
    var btn = document.getElementById('saveBtn');
    if (btn && !btn.disabled) {
        btn.textContent = '● Speichern';
        btn.style.background = '#e67e22';
    }
}

/**
 * Navigiert zur nächsten/vorherigen Watchlist-Position.
 * Wird von Keyboard-Navigation (Desktop) aufgerufen.
 */
function navigateWatchlist(dir) {
    var syms = ['index'].concat(Object.keys(WEIGHTS).filter(function(s) { return (WEIGHTS[s]||0) !== 0; }));
    var cur  = currentView === 'index' ? 'index' : currentView;
    var idx  = syms.indexOf(cur);
    if (idx < 0) idx = 0;
    var next = syms[(idx + dir + syms.length) % syms.length];
    if (next === 'index') {
        switchView('index');
    } else {
        switchView(next);
    }
    // renderWatchlist wird von switchView → loadData → renderWatchlist aufgerufen
}

// ╔══════════════════════════════════════════════════════════╗
// ║ 14. IBKR FLEX QUERY                                       ║
// ╚══════════════════════════════════════════════════════════╝

var ibkrPositions = [];   // Geladene IBKR-Positionen
var ibkrCash      = [];   // Geladene IBKR-Cash-Balances
var ibkrTrades    = [];   // Geladene IBKR-Trades
var ibkrLastSync  = null; // ISO-Timestamp des letzten Syncs
var ibkrIsinMap   = {};   // ISIN → Yahoo-Symbol (persistentes Mapping)
var ibkrSectors   = {};   // Yahoo-Symbol → GICS-Sektor (via /api/ticker/info, gecacht)
var ibkrIndustries= {};   // Yahoo-Symbol → Subsektor/Industry (via /api/ticker/info, gecacht)

// Auflösung Trade/Position → Yahoo-Symbol des Charts.
// ISIN-Mapping hat Vorrang (venue-unabhängig); sonst Symbol-Fallback,
// damit US-Ticker ohne manuelles Mapping weiter matchen.
function ibkrTradeYahoo(t) {
    if (t.isin && ibkrIsinMap[t.isin]) return ibkrIsinMap[t.isin];
    var p = (ibkrPositions || []).find(function(x) { return x.symbol === t.symbol; });
    if (p) return p.yahoo_symbol || p.symbol;
    return t.symbol;
}
function ibkrPosYahoo(p) {
    if (p.isin && ibkrIsinMap[p.isin]) return ibkrIsinMap[p.isin];
    return p.yahoo_symbol || p.symbol;
}

/**
 * Aktien-Trades eines Tickers, aufsteigend nach Datum. Einzige Auswahlstelle für
 * Chart-Pfeile UND Trade-Fenster — beide müssen dieselben Trades sehen, sonst
 * widersprechen sich Pfeile und Tabelle.
 * Nur `STK`: Optionen und Anleihen mischen sich sonst in die Stückzahlen.
 */
function ibkrStockTrades(sym) {
    if (!sym || sym === 'index' || !ibkrTrades) return [];
    return ibkrTrades.filter(function(t) {
        return ibkrTradeYahoo(t) === sym && (t.asset_class || '').toUpperCase() === 'STK';
    }).sort(function(a, b) {
        return a.trade_date < b.trade_date ? -1 : a.trade_date > b.trade_date ? 1 : 0;
    });
}

/**
 * Aktueller IBKR-Bestand eines Tickers — der Anker jeder Bestandsrechnung.
 * Nicht (mehr) im Depot ⇒ 0, die Position ist geschlossen.
 *
 * Warum überhaupt ein Anker: Die Flex-Historie reicht nur so weit zurück, wie die
 * Query eingestellt ist. Käufe von davor fehlen, deshalb ergibt „Summe Käufe minus
 * Summe Verkäufe" einen zu kleinen, oft negativen Bestand. Vom bekannten Endstand
 * rückwärts gerechnet stimmt der Verlauf dagegen immer am rechten Rand.
 */
function ibkrCurrentQty(sym) {
    var p = (ibkrPositions || []).find(function(x) {
        return ibkrPosYahoo(x) === sym || x.symbol === sym;
    });
    return p ? (p.quantity || 0) : 0;
}

/**
 * Bestand, mit dem die bekannte Historie *beginnt* — also das, was vor dem ersten
 * bekannten Trade schon da war. 0 heißt: die Historie ist lückenlos.
 */
function ibkrCarryInQty(sym) {
    var traded = ibkrStockTrades(sym).reduce(function(s, t) {
        var buy = (t.action || '').toUpperCase().indexOf('BUY') >= 0;
        return s + (buy ? Math.abs(t.quantity || 0) : -Math.abs(t.quantity || 0));
    }, 0);
    return ibkrCurrentQty(sym) - traded;
}

async function ibkrLoadPositions() {
    try {
        var r = await fetch('/api/ibkr/positions');
        ibkrPositions = await r.json();
        if (ibkrPositions.length > 0) ibkrLastSync = ibkrPositions[0].last_sync;
        logIt(3, 'IBKR', ibkrPositions.length + ' Positionen geladen'
            + (ibkrLastSync ? ', Sync ' + String(ibkrLastSync).slice(0, 16).replace('T', ' ') : ''));
        return ibkrPositions;
    } catch(e) {
        logIt(1, 'IBKR', 'Positionen laden fehlgeschlagen: ' + e.message);
        ibkrPositions = [];
        return [];
    }
}

// Sektor einer Position (aus dem gecachten ibkrSectors-Map). null = unbekannt/kein Aktien-Sektor.
function ibkrPosSector(p) {
    return ibkrSectors[ibkrPosYahoo(p)] || null;
}

// Subsektor (yfinance "industry") einer Position. null = unbekannt/kein Aktien-Subsektor.
function ibkrPosIndustry(p) {
    return ibkrIndustries[ibkrPosYahoo(p)] || null;
}

// Lädt für alle Aktien-Positionen (STK, qty>0) GICS-Sektor + Subsektor via /api/ticker/info.
// Der Endpoint cached serverseitig (stale-while-revalidate) → nach dem ersten Abruf instant.
// Läuft mit begrenzter Parallelität, um Yahoo nicht zu überlasten.
async function ibkrLoadSectors() {
    var syms = {};
    (ibkrPositions || []).forEach(function(p) {
        if ((p.asset_class || '').toUpperCase() !== 'STK') return;
        if ((p.quantity || 0) <= 0) return;
        var sym = ibkrPosYahoo(p);
        if (sym && !(sym in ibkrSectors)) syms[sym] = true;
    });
    var todo = Object.keys(syms);
    if (!todo.length) return ibkrSectors;

    var idx = 0;
    async function worker() {
        while (idx < todo.length) {
            var sym = todo[idx++];
            try {
                var r = await fetch('/api/ticker/info/' + encodeURIComponent(sym));
                var d = await r.json();
                var ok = d && d.ok !== false;
                ibkrSectors[sym]    = (ok && d.sector)   ? d.sector   : null;
                ibkrIndustries[sym] = (ok && d.industry) ? d.industry : null;
            } catch(e) {
                ibkrSectors[sym]    = null;
                ibkrIndustries[sym] = null;
            }
        }
    }
    // max. 4 parallele Abrufe
    var pool = [];
    for (var i = 0; i < 4; i++) pool.push(worker());
    await Promise.all(pool);
    return ibkrSectors;
}

async function ibkrLoadCash() {
    try {
        var r = await fetch('/api/ibkr/cash');
        ibkrCash = await r.json();
        if (ibkrCash.length > 0 && !ibkrLastSync) ibkrLastSync = ibkrCash[0].last_sync;
        logIt(5, 'IBKR', ibkrCash.length + ' Cash-Salden geladen');
        return ibkrCash;
    } catch(e) {
        logIt(1, 'IBKR', 'Cash laden fehlgeschlagen: ' + e.message);
        ibkrCash = [];
        return [];
    }
}

async function ibkrLoadTrades() {
    try {
        var r = await fetch('/api/ibkr/trades');
        ibkrTrades = await r.json();
        logIt(3, 'IBKR', ibkrTrades.length + ' Trades geladen');
        return ibkrTrades;
    } catch(e) {
        logIt(1, 'IBKR', 'Trades laden fehlgeschlagen: ' + e.message);
        ibkrTrades = [];
        return [];
    }
}

async function ibkrLoadIsinMap() {
    try {
        var r = await fetch('/api/ibkr/isin-map');
        var rows = await r.json();
        ibkrIsinMap = {};
        (rows || []).forEach(function(m) {
            if (m.isin && m.yahoo_symbol) ibkrIsinMap[m.isin] = m.yahoo_symbol;
        });
        return ibkrIsinMap;
    } catch(e) {
        console.warn('ibkrLoadIsinMap failed:', e);
        ibkrIsinMap = {};
        return {};
    }
}

async function ibkrSaveIsinMap(isin, yahooSymbol, displayName) {
    var r = await fetch('/api/ibkr/isin-map', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({isin: isin, yahoo_symbol: yahooSymbol, display_name: displayName || null})
    });
    return await r.json();
}

async function ibkrSaveConfig(token, queryId, queryIdTrades, queryIdTax) {
    var r = await fetch('/api/ibkr/config', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({flex_token: token, query_id: queryId,
                              query_id_trades: queryIdTrades || '', query_id_tax: queryIdTax || ''})
    });
    return await r.json();
}

async function ibkrDoSync() {
    var r = await fetch('/api/ibkr/sync');
    return await r.json();
}

/**
 * Erzeugt CSV im IBKR Basket Trader Format aus dem Vergleich
 * aktiver Basket-Gewichte mit IBKR-Ist-Positionen.
 */
function ibkrBuildExportCsv() {
    var totalPortValue = ibkrPositions.reduce(function(s, p) { return s + (p.position_value || 0); }, 0);
    if (totalPortValue <= 0) return null;

    var tickers = Object.keys(WEIGHTS).filter(function(s) { return (WEIGHTS[s] || 0) > 0; });
    if (tickers.length === 0) return null;
    var totalWeight = tickers.reduce(function(s, sym) { return s + (WEIGHTS[sym] || 0); }, 0);

    var ibkrMap = {};
    ibkrPositions.forEach(function(p) { ibkrMap[p.symbol] = p; });

    var rows = [['Symbol', 'Action', 'Quantity']];
    tickers.forEach(function(sym) {
        var targetValue = (WEIGHTS[sym] / totalWeight) * totalPortValue;
        var pos         = ibkrMap[sym];
        var markPrice   = pos ? (pos.mark_price || 0) : 0;
        var curQty      = pos ? (pos.quantity   || 0) : 0;
        if (markPrice <= 0) return;
        var targetQty = Math.round(targetValue / markPrice);
        var diff      = targetQty - curQty;
        if (Math.abs(diff) < 1) return;
        rows.push([sym, diff > 0 ? 'BUY' : 'SELL', String(Math.abs(diff))]);
    });

    return rows.length > 1 ? rows.map(function(r) { return r.join(','); }).join('\n') : null;
}

