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
var _dataMap = {}; // { AAPL: [{time, open, high, low, close, volume}] }

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
function calcLogReg(candles, stdDev) {
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

    // ARR = Annual Rate of Return (Tageskurs-Steigung × 252 Handelstage)
    var arr = ((Math.exp(slope * 252) - 1) * 100).toFixed(1);

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
function buildIndex(dataMap) {
    // ── Wertgewichteter Portfolio-Index ──────────────────────────
    // Index = Portfoliowert / Basis-Portfoliowert × 100
    // Portfoliowert = Σ(Kurs_i × Anzahl_i)
    // OHLC wird aus täglichen Portfoliowerten berechnet
    // ─────────────────────────────────────────────────────────────

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

    // Zeiger für alle Ticker bis einschließlich `date` vorwärts schieben
    function advanceTo(date) {
        Object.keys(WEIGHTS).forEach(function(sym) {
            if ((WEIGHTS[sym] || 0) === 0) return;
            var bars = _sorted[sym];
            while (_ptrs[sym] < bars.length && bars[_ptrs[sym]].time <= date) {
                _last[sym] = bars[_ptrs[sym]];
                _ptrs[sym]++;
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
            if (bar && bar[field]) val += bar[field] * w;
        });
        return val;
    }

    // Basis = Schlusskurs-Portfoliowert am ersten Handelstag
    advanceTo(dates[0]);
    var baseVal = portVal('close');
    if (baseVal === 0) return [];

    // Zeiger zurücksetzen — forEach beginnt ebenfalls bei dates[0]
    Object.keys(WEIGHTS).forEach(function(sym) { _ptrs[sym] = 0; _last[sym] = null; });

    var totalShares = Object.keys(WEIGHTS).reduce(function(sum, sym) {
        return sum + (WEIGHTS[sym] || 0);
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
            if (bar && bar.time === date && bar.volume && bar.close) vol += bar.volume * bar.close * w;
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

    // IBKR P&L-Hilfsfunktionen
    var ibkrMap = {};
    (ibkrPositions || []).forEach(function(p) { ibkrMap[p.symbol] = p; });

    var ibkrPnlPct = function(sym) {
        var pos = ibkrMap[sym];
        if (!pos || !(pos.cost_basis_price > 0)) return null;
        return ((pos.mark_price - pos.cost_basis_price) / pos.cost_basis_price * 100).toFixed(2);
    };

    // IBKR Index-P&L (nur Ticker die im Basket UND in IBKR sind)
    var ibkrTotalCost = 0, ibkrTotalValue = 0;
    (ibkrPositions || []).forEach(function(p) {
        if ((WEIGHTS[p.symbol] || 0) > 0) {
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

        html += '<tr style="background:var(--bg);border-bottom:2px solid var(--border);">'
            + '<td style="font-weight:700;color:var(--text);">&#9679; INDEX</td>'
            + '<td style="font-weight:700;">$' + last.close.toFixed(2) + '</td>'
            + '<td></td><td></td>'
            + fmt(idxIbkrPnl)
            + fmt(pct(get(1))) + fmt(pct(get(5))) + fmt(pct(get(22))) + fmt(pct(get(66)))
            + fmt(yearBar ? pct(yearBar.close) : null)
            + '</tr>';
    }

    // Ticker-Zeilen
    var totalValue = 0, totalPrevValue = 0;

    syms.forEach(function(sym) {
        var p = perfData[sym];
        if (!p) return;
        var anzahl   = WEIGHTS[sym] || 0;
        var posValue = p.price * anzahl;
        totalValue     += posValue;
        totalPrevValue += posValue / (1 + parseFloat(p.d1 || 0) / 100);

        html += '<tr>'
            + '<td style="font-weight:500">' + sym + '</td>'
            + '<td>$' + p.price.toFixed(2) + '</td>'
            + '<td style="color:var(--muted)">' + anzahl + '</td>'
            + '<td style="font-weight:500">$' + posValue.toFixed(0) + '</td>'
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
            + '<td></td><td></td>'
            + '<td style="font-weight:700">$' + totalValue.toFixed(0) + '</td>'
            + (idxIbkrPnl ? '<td style="font-weight:700;color:' + ibkrColor + '">' + (parseFloat(idxIbkrPnl)>=0?'+':'') + idxIbkrPnl + '%</td>' : '<td>-</td>')
            + '<td style="font-weight:700;color:' + chgColor + '">' + (parseFloat(totalChg)>=0?'+':'') + totalChg + '%</td>'
            + '<td colspan="3" style="color:var(--muted);font-size:10px;">' + syms.length + ' Pos.</td>'
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
    if (!allCandles.length) return;

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
        regResult = calcLogReg(regCandles, 2);
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
        // Layout wiederherstellen
        if (typeof loadLayout === 'function' && cfg.layout) {
            _layout = cfg.layout;
            loadLayout();
        }

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
    } catch (e) {
        console.error('loadConfig failed:', e);
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
            body: JSON.stringify({ baskets: baskets, currentBasket: currentBasket, layout: (typeof _layout !== 'undefined' ? _layout : {}) })
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
    } catch (e) {
        console.warn('loadDbTickers failed:', e);
    }
}

/**
 * Aktualisiert alle Ticker-Preise via Yahoo Finance.
 */
async function updateAllPrices() {
    var tickers = Object.keys(WEIGHTS).filter(function(s) { return (WEIGHTS[s] || 0) > 0; });
    if (tickers.length === 0) return;
    try {
        var r = await fetch('/api/prices/update', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tickers: tickers })
        });
        var data = await r.json();
        if (!data.ok) {
            console.warn('updateAllPrices:', data.error);
            return false;
        }
        return true;
    } catch (e) {
        console.error('updateAllPrices failed:', e);
        return false;
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
    try {
        await updateAllPrices();
        await loadData();
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.style.opacity = '';
            btn.textContent = origText;
        }
    }
}

/**
 * Lädt Kursdaten für einen einzelnen Ticker.
 */
async function fetchTicker(sym) {
    try {
        var r    = await fetch('/api/prices/' + sym, { cache: 'no-store' });
        var data = await r.json();
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
        console.error('fetchTicker failed for ' + sym + ':', e);
        return [];
    }
}

/**
 * Lädt Index-Daten: alle Ticker parallel, dann Index berechnen.
 */
async function loadIndexData() {
    if (typeof showLoading === 'function') showLoading('Lade Index...');
    try {
        var syms = Object.keys(WEIGHTS).filter(function(s) { return (WEIGHTS[s] || 0) > 0; });
        if (syms.length === 0) {
            if (typeof hideLoading === 'function') hideLoading();
            return;
        }

        // Alle Ticker parallel laden
        var results = await Promise.all(syms.map(function(sym) {
            return fetchTicker(sym).then(function(data) {
                return { sym: sym, data: data };
            });
        }));

        results.forEach(function(r) { _dataMap[r.sym] = r.data; });

        // Index aufbauen
        allCandles  = buildIndex(_dataMap);
        _volumeData = allCandles.map(function(c) { return { time: c.time, volume: c.volume }; });

        if (allCandles.length === 0) {
            if (typeof hideLoading === 'function') hideLoading();
            return;
        }

        applyPeriod();
        if (typeof renderWatchlist === 'function') renderWatchlist();
        if (typeof hideLoading === 'function') hideLoading();
    } catch (e) {
        console.error('loadIndexData failed:', e);
        if (typeof hideLoading === 'function') hideLoading();
    }
}

/**
 * Lädt Daten für einen einzelnen Ticker.
 */
async function loadTickerData(sym) {
    if (typeof showLoading === 'function') showLoading('Lade ' + sym + '...');
    try {
        var data    = await fetchTicker(sym);
        _dataMap[sym] = data;   // auch in _dataMap speichern für buildPerfData()
        allCandles  = data;
        _volumeData = data.map(function(c) { return { time: c.time, volume: c.volume }; });
        applyPeriod();
        if (typeof hideLoading === 'function') hideLoading();
    } catch (e) {
        console.error('loadTickerData failed for ' + sym + ':', e);
        if (typeof hideLoading === 'function') hideLoading();
    }
}

/**
 * Lädt Daten je nach aktuellem View (Index oder Ticker).
 */
async function loadData() {
    if (currentView === 'index') {
        await loadIndexData();
    } else {
        await loadTickerData(currentView);
    }
}

/**
 * Wechselt zwischen Index und Ticker-View.
 */
function switchView(view) {
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
    var rpEl = document.getElementById('regPeriod');
    if (rpEl) baskets[currentBasket].regPeriod = parseInt(rpEl.value, 10) || 12;
}

/**
 * Lädt Basket-Zustand in den globalen State.
 */
function loadBasketState() {
    var b = baskets[currentBasket];
    if (!b) return;
    WEIGHTS       = Object.assign({}, b.weights || {});
    currentPeriod = b.period !== undefined ? b.period : 180;
    currentTF     = b.tf || '1D';
    if (b.indicators) indicators = Object.assign({}, b.indicators);
    if (b.logScale !== undefined) logScale = b.logScale;
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
    allCandles  = [];
    currentView = 'index';
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
        if (sym && !isNaN(w) && w >= 0) weights[sym] = w;
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
    var syms = ['index'].concat(Object.keys(WEIGHTS).filter(function(s) { return (WEIGHTS[s]||0) >= 0; }));
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

async function ibkrLoadPositions() {
    try {
        var r = await fetch('/api/ibkr/positions');
        ibkrPositions = await r.json();
        if (ibkrPositions.length > 0) ibkrLastSync = ibkrPositions[0].last_sync;
        return ibkrPositions;
    } catch(e) {
        console.warn('ibkrLoadPositions failed:', e);
        ibkrPositions = [];
        return [];
    }
}

async function ibkrLoadCash() {
    try {
        var r = await fetch('/api/ibkr/cash');
        ibkrCash = await r.json();
        if (ibkrCash.length > 0 && !ibkrLastSync) ibkrLastSync = ibkrCash[0].last_sync;
        return ibkrCash;
    } catch(e) {
        console.warn('ibkrLoadCash failed:', e);
        ibkrCash = [];
        return [];
    }
}

async function ibkrLoadTrades() {
    try {
        var r = await fetch('/api/ibkr/trades');
        ibkrTrades = await r.json();
        return ibkrTrades;
    } catch(e) {
        console.warn('ibkrLoadTrades failed:', e);
        ibkrTrades = [];
        return [];
    }
}

async function ibkrSaveConfig(token, queryId) {
    var r = await fetch('/api/ibkr/config', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({flex_token: token, query_id: queryId})
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

