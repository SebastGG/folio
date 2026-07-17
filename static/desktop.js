/**
 * desktop.js — Desktop UI & Chart
 * =================================
 * Lädt NACH shared.js.
 * Enthält: Chart-Initialisierung, Zeichnungen, Watchlist, Sidebar, Resizer.
 * Enthält NICHT: Berechnungen, API-Calls (→ shared.js)
 *
 * !! REFACTORING-REGEL !!
 * Bestehenden Code ÄNDERN, keinen neuen Code hinzufügen.
 * Neue Funktion? → Bestehende erweitern oder umbenennen.
 *
 * Schnittstelle zu shared.js:
 *   renderDesktopChart(colored, volAgg, agg, regResult) ← wird von applyPeriod() aufgerufen
 *   showLoading(msg) / hideLoading()                    ← wird von loadIndexData() aufgerufen
 *   renderWatchlist()                                   ← wird von loadData() aufgerufen
 *   renderBasketSelect()                                ← wird von loadConfig() aufgerufen
 *   updateChartTitle()                                  ← wird von switchView() aufgerufen
 */

'use strict';

// ╔══════════════════════════════════════════════════════════╗
// ║  1. CHART-STATE (nur Desktop)                            ║
// ╚══════════════════════════════════════════════════════════╝

// Lightweight Charts Instanzen
var chart, csSeries, volSeries, ma50S, ma200S, regS, regUS, regLS, ghostSeries;
var _ibkrCostLine      = null;   // Einstandskurs-Preislinie (wird pro Ticker neu gesetzt)
var _markersPlugin     = null;   // LWC v5 SeriesMarkers-Plugin
var _showTradeMarkers  = true;   // Toggle-Zustand
var _savedLogicalRange = null;   // Gespeicherter Zoom beim Ticker-Wechsel

function saveChartRange() {
    if (!chart) return;
    var r = chart.timeScale().getVisibleLogicalRange();
    if (r) _savedLogicalRange = r;
}

// ── VRVP ──────────────────────────────────────────────────────────────────────
var _vrvpEnabled  = false;
var _vrvpCanvas   = null;
var _vrvpRaf      = null;
var _vrvpRangeSub = null;

function togVRVP(btn) {
    _vrvpEnabled = !_vrvpEnabled;
    if (btn) btn.classList.toggle('ind-active', _vrvpEnabled);
    if (_vrvpEnabled) { _initVRVP(); } else { _clearVRVP(); }
}

function _initVRVP() {
    var container = document.getElementById('chartContainer');
    if (!container || !chart) return;
    if (!_vrvpCanvas) {
        _vrvpCanvas = document.createElement('canvas');
        _vrvpCanvas.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;z-index:4;';
        container.appendChild(_vrvpCanvas);
    }
    _vrvpCanvas.style.display = '';
    _resizeVRVP();
    if (!_vrvpRangeSub) {
        _vrvpRangeSub = function() { _scheduleVRVP(); };
        chart.timeScale().subscribeVisibleTimeRangeChange(_vrvpRangeSub);
    }
    _scheduleVRVP();
}

function _clearVRVP() {
    if (_vrvpCanvas) {
        _vrvpCanvas.style.display = 'none';
        var ctx = _vrvpCanvas.getContext('2d');
        if (ctx) ctx.clearRect(0, 0, _vrvpCanvas.width, _vrvpCanvas.height);
    }
    if (_vrvpRangeSub && chart) {
        chart.timeScale().unsubscribeVisibleTimeRangeChange(_vrvpRangeSub);
        _vrvpRangeSub = null;
    }
    if (_vrvpRaf) { cancelAnimationFrame(_vrvpRaf); _vrvpRaf = null; }
}

function _resizeVRVP() {
    if (!_vrvpCanvas) return;
    var c = document.getElementById('chartContainer');
    if (c) { _vrvpCanvas.width = c.clientWidth; _vrvpCanvas.height = c.clientHeight; }
}

function _scheduleVRVP() {
    if (_vrvpRaf) return;
    _vrvpRaf = requestAnimationFrame(function() { _vrvpRaf = null; _drawVRVP(); });
}

function _timeToStr(t) {
    if (!t && t !== 0) return '';
    if (typeof t === 'string') return t;
    if (typeof t === 'number') return new Date(t * 1000).toISOString().slice(0, 10);
    if (t.year) return t.year + '-' + String(t.month).padStart(2,'0') + '-' + String(t.day).padStart(2,'0');
    return '';
}

function _drawVRVP() {
    if (!_vrvpEnabled || !_vrvpCanvas || !csSeries || !chart || !_lastCandles || !_lastCandles.length) return;
    var canvas = _vrvpCanvas;
    var ctx = canvas.getContext('2d');
    var container = document.getElementById('chartContainer');
    if (container && (canvas.width !== container.clientWidth || canvas.height !== container.clientHeight)) {
        canvas.width = container.clientWidth; canvas.height = container.clientHeight;
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    var visRange = chart.timeScale().getVisibleRange();
    if (!visRange) return;
    var fromStr = _timeToStr(visRange.from), toStr = _timeToStr(visRange.to);
    if (!fromStr || !toStr) return;
    var visCan = _lastCandles.filter(function(c) { return c.time >= fromStr && c.time <= toStr; });
    if (!visCan.length) return;
    var priceMin = Infinity, priceMax = -Infinity;
    visCan.forEach(function(c) {
        if (c.low  < priceMin) priceMin = c.low;
        if (c.high > priceMax) priceMax = c.high;
    });
    if (priceMin >= priceMax) return;
    var NUM_BUCKETS = 24;
    var bucketSize = (priceMax - priceMin) / NUM_BUCKETS;
    var volumes = new Float64Array(NUM_BUCKETS);
    visCan.forEach(function(c) {
        var vol = c.volume || 0;
        var cRng = c.high - c.low || bucketSize;
        for (var i = 0; i < NUM_BUCKETS; i++) {
            var bLow = priceMin + i * bucketSize, bHigh = bLow + bucketSize;
            var oLow = Math.max(c.low, bLow), oHigh = Math.min(c.high, bHigh);
            if (oHigh > oLow) volumes[i] += vol * (oHigh - oLow) / cRng;
        }
    });
    var maxVol = 0, pocIdx = 0;
    for (var i = 0; i < NUM_BUCKETS; i++) {
        if (volumes[i] > maxVol) { maxVol = volumes[i]; pocIdx = i; }
    }
    if (!maxVol) return;
    var priceScaleW = 58;
    var maxBarW = Math.min(canvas.width * 0.15, 120);
    var barRight = canvas.width - priceScaleW;
    for (var i = 0; i < NUM_BUCKETS; i++) {
        var bLow = priceMin + i * bucketSize, bHigh = bLow + bucketSize;
        var yTop    = csSeries.priceToCoordinate(bHigh);
        var yBottom = csSeries.priceToCoordinate(bLow);
        if (yTop === null || yBottom === null) continue;
        var barH = Math.max(1, Math.abs(yBottom - yTop) - 1);
        var barW = (volumes[i] / maxVol) * maxBarW;
        ctx.fillStyle = i === pocIdx ? 'rgba(39,174,96,0.85)' : 'rgba(220,53,69,0.45)';
        ctx.fillRect(barRight - barW, Math.min(yTop, yBottom), barW, barH);
    }
    var pocMid = priceMin + (pocIdx + 0.5) * bucketSize;
    var pocY   = csSeries.priceToCoordinate(pocMid);
    if (pocY !== null) {
        ctx.fillStyle = 'rgba(39,174,96,0.9)';
        ctx.font = '10px monospace';
        ctx.textAlign = 'right';
        ctx.fillText('POC ' + pocMid.toFixed(2), barRight - 2, pocY + 3);
    }
}

// Drawing Manager
var drawingManager   = null;  // LightweightChartsDrawing.DrawingManager Instanz
var _drawSelected    = null;  // zuletzt ausgewählte Zeichnung
var _multiSelected   = new Set(); // alle per Ctrl+Klick ausgewählten Zeichnungen
var _lastClickCtrl   = false;
var _activeToolType  = null;  // aktiver Tool-Typ (kebab-case)
var _pendingAnchors  = [];    // Ankerpunkte während der Zeichnung
var _previewDrawing  = null;  // temporäre Vorschau-Zeichnung
var _crosshairCb     = null;  // CrosshairMove-Callback-Referenz (zum Abmelden)

// ╔══════════════════════════════════════════════════════════╗
// ║  2. LOADING-OVERLAY                                       ║
// ╚══════════════════════════════════════════════════════════╝

function showLoading(msg) {
    var overlay = document.getElementById('statusOverlay');
    if (!overlay) return;
    var text = overlay.querySelector('.status-text');
    if (text) text.textContent = msg || 'Lade Kursdaten...';
    overlay.style.display = 'flex';
}

function hideLoading() {
    var overlay = document.getElementById('statusOverlay');
    if (overlay) overlay.style.display = 'none';
}

// ╔══════════════════════════════════════════════════════════╗
// ║  3. CHART-INITIALISIERUNG                                 ║
// ╚══════════════════════════════════════════════════════════╝

function initChart() {
    var container = document.getElementById('chartContainer');
    if (!container) return;

    chart = LightweightCharts.createChart(container, {
        width:  container.clientWidth,
        height: container.clientHeight,
        layout: {
            background:  { color: 'transparent' },
            textColor:   getComputedStyle(document.documentElement).getPropertyValue('--text').trim() || '#1a1a18',
            fontFamily:  "-apple-system, BlinkMacSystemFont, 'Trebuchet MS', Roboto, Ubuntu, Arial, sans-serif",
        },
        grid: {
            vertLines: { color: 'rgba(0,0,0,0.05)' },
            horzLines: { color: 'rgba(0,0,0,0.05)' },
        },
        timeScale: { borderVisible: false, timeVisible: false, rightOffset: 12, fixLeftEdge: false, fixRightEdge: false },
        rightPriceScale: { borderVisible: false, autoScale: false },
        crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    });

    // Volumen (Hintergrund)
    volSeries = chart.addSeries(LightweightCharts.HistogramSeries, {
        color: '#2d8a4e',
        priceFormat: { type: 'volume' },
        priceScaleId: 'vol',
        lastValueVisible: false,
        priceLineVisible: false,
    });
    chart.priceScale('vol').applyOptions({
        scaleMargins: { top: 0.85, bottom: 0 },
        borderVisible: false,
    });

    // Kerzen
    csSeries = chart.addSeries(LightweightCharts.CandlestickSeries, {
        upColor:        '#2d8a4e', downColor:       '#c0392b',
        borderUpColor:  '#2d8a4e', borderDownColor: '#c0392b',
        wickUpColor:    '#2d8a4e', wickDownColor:   '#c0392b',
    });

    // Ghost-Serie: unsichtbar, nur für Zeitachsenbeschriftung in der Zukunft
    ghostSeries = chart.addSeries(LightweightCharts.LineSeries, {
        color: 'rgba(0,0,0,0)', lineWidth: 0,
        lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false,
        priceScaleId: 'ghost',
    });
    chart.priceScale('ghost').applyOptions({ visible: false });

    // Indikatoren
    ma50S  = chart.addSeries(LightweightCharts.LineSeries, { color: '#2962ff',  lineWidth: 1.5, visible: false, priceLineVisible: false, lastValueVisible: false });
    ma200S = chart.addSeries(LightweightCharts.LineSeries, { color: '#f5a623',  lineWidth: 1.5, visible: false, priceLineVisible: false, lastValueVisible: false });
    regS   = chart.addSeries(LightweightCharts.LineSeries, { color: '#9b59b6',  lineWidth: 2,   visible: false, priceLineVisible: false, lastValueVisible: false });
    regUS  = chart.addSeries(LightweightCharts.LineSeries, { color: '#9b59b6',  lineWidth: 1,   visible: false, priceLineVisible: false, lastValueVisible: false, lineStyle: 2 });
    regLS  = chart.addSeries(LightweightCharts.LineSeries, { color: '#9b59b6',  lineWidth: 1,   visible: false, priceLineVisible: false, lastValueVisible: false, lineStyle: 2 });

    // ResizeObserver — Chart passt sich Container an
    new ResizeObserver(fitChart).observe(container);

    // Crosshair → Stats aktualisieren
    chart.subscribeCrosshairMove(function(param) {
        var overlay = document.getElementById('ohlcv-overlay');
        if (!overlay) return;
        if (!param || !param.time) {
            overlay.style.display = 'none';
            return;
        }
        var bar = csSeries ? param.seriesData.get(csSeries) : null;
        if (!bar) { overlay.style.display = 'none'; return; }

        overlay.style.display = 'block';

        var fmt = function(v) { return v != null ? '$' + parseFloat(v).toFixed(2) : '-'; };
        var fmtVol = function(v) {
            if (!v) return '-';
            if (v >= 1e9) return (v/1e9).toFixed(2) + 'B';
            if (v >= 1e6) return (v/1e6).toFixed(2) + 'M';
            if (v >= 1e3) return (v/1e3).toFixed(0) + 'K';
            return v.toFixed(0);
        };

        var setEl = function(id, val) { var e = document.getElementById(id); if(e) e.textContent = val; };
        setEl('ov-date', param.time);
        setEl('ov',  fmt(bar.open));
        setEl('oh',  fmt(bar.high));
        setEl('ol',  fmt(bar.low));
        setEl('oc',  fmt(bar.close));

        // Tatsächliches Volumen aus _lastCandles (nicht normalisierter volSeries-Wert)
        var idx = _lastCandles.findIndex(function(c) { return c.time === param.time; });
        var actualVol = idx >= 0 ? (_lastCandles[idx].volume || 0) : 0;
        setEl('ovol', fmtVol(actualVol));

        // Volume averaged (20-Tage gleitender Schnitt) — ebenfalls aus _lastCandles
        if (idx >= 0) {
            var n = Math.min(20, idx + 1);
            var sum = 0;
            for (var i = idx - n + 1; i <= idx; i++) {
                sum += _lastCandles[i].volume || 0;
            }
            setEl('ovola', fmtVol(sum / n));
        }
    });

    applyChartTheme();   // Chart-Farben ans gespeicherte Theme angleichen
}

function fitChart() {
    var container = document.getElementById('chartContainer');
    if (!container || !chart) return;
    var w = container.clientWidth;
    var h = container.clientHeight;
    if (w > 0 && h > 0) chart.applyOptions({ width: w, height: h });
    if (typeof resizeCanvas === 'function') resizeCanvas();
    if (_vrvpEnabled) { _resizeVRVP(); _scheduleVRVP(); }
}

// ╔══════════════════════════════════════════════════════════╗
// ║  4. CHART-RENDERING (Interface zu shared.js)             ║
// ╚══════════════════════════════════════════════════════════╝

function refreshIbkrCostLine(colored) {
    if (!csSeries) return;
    if (_ibkrCostLine) { try { csSeries.removePriceLine(_ibkrCostLine); } catch(e) {} _ibkrCostLine = null; }
    if (!colored || !colored.length || !ibkrPositions || !ibkrPositions.length) return;
    var cbPrice = 0;
    if (currentView !== 'index') {
        var pos = ibkrPositions.find(function(p) {
            return ibkrPosYahoo(p) === currentView || p.symbol === currentView;
        });
        if (pos && pos.cost_basis_price > 0) cbPrice = pos.cost_basis_price;
    } else {
        var totalCost = 0, totalValue = 0;
        ibkrPositions.forEach(function(p) {
            var sym = ibkrPosYahoo(p);
            if ((WEIGHTS[sym] || WEIGHTS[p.symbol] || 0) > 0) {
                var fx = p.fx_rate_to_base || 1;
                totalCost  += (p.cost_basis_money || 0) * fx;
                totalValue += (p.position_value   || 0) * fx;
            }
        });
        if (totalValue > 0 && totalCost > 0)
            cbPrice = colored[colored.length - 1].close * totalCost / totalValue;
    }
    if (cbPrice > 0) {
        _ibkrCostLine = csSeries.createPriceLine({
            price: cbPrice, color: '#e67e22', lineWidth: 1, lineStyle: 2,
            axisLabelVisible: true, title: 'Einstand',
        });
    }
}

/**
 * Wird von shared.js applyPeriod() aufgerufen.
 * Rendert Kerzen, Volumen, Indikatoren, LogReg, Seit-Marker.
 */
function refreshTradeMarkers() {
    if (!csSeries) return;
    var markers = [];
    if (_showTradeMarkers && currentView !== 'index' && ibkrTrades && ibkrTrades.length > 0) {
        // Aktuelle IBKR-Position für laufende Bestandsberechnung
        var ibkrPos = (ibkrPositions || []).find(function(p) {
            return ibkrPosYahoo(p) === currentView || p.symbol === currentView;
        });
        var currentQty = ibkrPos ? (ibkrPos.quantity || 0) : null;

        // Partial fills aggregieren: ein Marker pro Tag + Richtung
        // Matching via ISIN (Vorrang) bzw. Symbol-Fallback — siehe ibkrTradeYahoo()
        var relevantTrades = ibkrTrades.filter(function(t) {
            return ibkrTradeYahoo(t) === currentView && (t.asset_class || '').toUpperCase() === 'STK';
        }).sort(function(a, b) { return a.trade_date < b.trade_date ? -1 : a.trade_date > b.trade_date ? 1 : 0; });

        // Laufenden Bestand ab erster Transaktion berechnen
        // Startbestand = aktuelle IBKR-Menge minus aller bekannten Trades
        var totalTraded = relevantTrades.reduce(function(s, t) {
            var buy = (t.action || '').toUpperCase().indexOf('BUY') >= 0;
            return s + (buy ? Math.abs(t.quantity || 0) : -Math.abs(t.quantity || 0));
        }, 0);
        var runningQty = currentQty !== null ? currentQty - totalTraded : 0;

        // Pro Tag laufenden Bestand ermitteln
        var dateRunning = {};
        var tradeDates  = [];
        relevantTrades.forEach(function(t) {
            if (tradeDates.indexOf(t.trade_date) < 0) tradeDates.push(t.trade_date);
        });
        tradeDates.forEach(function(date) {
            relevantTrades.filter(function(t) { return t.trade_date === date; }).forEach(function(t) {
                var buy = (t.action || '').toUpperCase().indexOf('BUY') >= 0;
                runningQty += buy ? Math.abs(t.quantity || 0) : -Math.abs(t.quantity || 0);
            });
            dateRunning[date] = runningQty;
        });

        var agg = {};
        relevantTrades.forEach(function(t) {
            if (!t.trade_date) return;
            var isBuy = (t.action || '').toUpperCase().indexOf('BUY') >= 0;
            var key = t.trade_date + (isBuy ? '_B' : '_S');
            if (!agg[key]) agg[key] = { date: t.trade_date, isBuy: isBuy, qty: 0 };
            agg[key].qty += Math.abs(t.quantity || 0);
        });
        Object.keys(agg).forEach(function(k) {
            var g = agg[k];
            var fmt = function(n) { return n === Math.floor(n) ? n : n.toFixed(1); };
            var pos = dateRunning[g.date];
            var label;
            if (pos !== undefined) {
                var from = g.isBuy ? pos - g.qty : pos + g.qty;
                label = fmt(from) + (g.isBuy ? ' +' : ' -') + fmt(g.qty) + '→' + fmt(pos);
            } else {
                label = (g.isBuy ? '+' : '-') + fmt(g.qty);
            }
            var _pos = g.isBuy ? 'belowBar' : 'aboveBar';
            markers.push({
                time: g.date, position: _pos,
                color: g.isBuy ? '#00E5FF' : '#FF6D00',
                shape: g.isBuy ? 'arrowUp' : 'arrowDown',
                text: '', size: 3,
            });
            markers.push({
                time: g.date, position: _pos,
                color: '#000000',
                shape: g.isBuy ? 'arrowUp' : 'arrowDown',
                text: label,
                size: 0,
            });
        });
        markers.sort(function(a, b) { return a.time < b.time ? -1 : a.time > b.time ? 1 : 0; });
    }
    try {
        if (!_markersPlugin) {
            _markersPlugin = LightweightCharts.createSeriesMarkers(csSeries, markers);
        } else {
            _markersPlugin.setMarkers(markers);
        }
    } catch(e) { console.warn('refreshTradeMarkers:', e); }
}

/**
 * Wird von shared.js applyPeriod() aufgerufen.
 * Rendert Kerzen, Volumen, Indikatoren, LogReg, Seit-Marker.
 */
function renderDesktopChart(colored, volAgg, agg, regResult) {
    if (!chart || !csSeries) return;

    // Reg-Serien zuerst updaten — verhindert dass LWC den Zeitstrich auf tägliche
    // Granularität setzt bevor die Kerzen auf Wochen/Monats-TF umgeschaltet werden.
    applyLogReg(regResult, regS, regUS, regLS);

    // Kerzen
    csSeries.setData(colored);

    // Leerer Basket — alle Serien leeren und sofort zurück
    if (!colored || !colored.length) {
        if (volSeries) try { volSeries.setData([]); } catch(e) {}
        if (ma50S)  ma50S.applyOptions({ visible: false });
        if (ma200S) ma200S.applyOptions({ visible: false });
        if (regS)   regS.applyOptions({ visible: false });
        if (regUS)  regUS.applyOptions({ visible: false });
        if (regLS)  regLS.applyOptions({ visible: false });
        if (ghostSeries) try { ghostSeries.setData([]); } catch(e) {}
        return;
    }

    // IBKR Einstandskurs + Trade-Marker
    refreshIbkrCostLine(colored);
    refreshTradeMarkers();

    // Ghost-Serie: Zukunftsdaten für Zeitachsenbeschriftung
    if (ghostSeries && colored.length) {
        var lastC    = colored[colored.length - 1];
        var count    = currentTF === '1W' ? 52 : currentTF === '1M' ? 12 : 252;
        var fDates   = generateFutureDates(lastC.time, currentTF, count);
        try {
            ghostSeries.setData(fDates.map(function(d) { return { time: d, value: lastC.close }; }));
        } catch(e) {}
    }

    // Volumen
    if (volSeries && volAgg.length) {
        var cmap = {};
        colored.forEach(function(c) { cmap[c.time] = c.color; });
        // Index-View: normiert (Durchschnitt=100), da Volumen dort eine gewichtete Hilfsgröße ist.
        // Ticker-View: echtes Volumen in Stückzahl (wie TradingView).
        var volData;
        if (currentView === 'index') {
            var volSum = volAgg.reduce(function(s, v) { return s + (v.volume || 0); }, 0);
            var volAvg = volSum / volAgg.length || 1;
            volData = volAgg.map(function(v) {
                return {
                    time:  v.time,
                    value: (v.volume || 0) / volAvg * 100,
                    color: cmap[v.time] === '#2d8a4e' ? 'rgba(45,138,78,0.4)' : 'rgba(192,57,43,0.4)',
                };
            });
        } else {
            volData = volAgg.map(function(v) {
                return {
                    time:  v.time,
                    value: v.volume || 0,
                    color: cmap[v.time] === '#2d8a4e' ? 'rgba(45,138,78,0.4)' : 'rgba(192,57,43,0.4)',
                };
            });
        }
        try { volSeries.setData(volData); } catch(e) {}
    }

    // MA50
    if (ma50S) {
        if (indicators.ma50) {
            ma50S.applyOptions({ visible: true });
            ma50S.setData(calcMA(agg, 50));
        } else {
            ma50S.applyOptions({ visible: false });
        }
    }

    // MA200
    if (ma200S) {
        if (indicators.ma200) {
            ma200S.applyOptions({ visible: true });
            ma200S.setData(calcMA(agg, 200));
        } else {
            ma200S.applyOptions({ visible: false });
        }
    }

    // Log-Skala
    chart.applyOptions({ rightPriceScale: { mode: logScale ? 1 : 0 } });

    // Zoom-Range wiederherstellen (Ticker-Wechsel) oder auf Inhalt fitten
    if (_savedLogicalRange !== null) {
        var _rangeToRestore = _savedLogicalRange;
        _savedLogicalRange = null;
        requestAnimationFrame(function() {
            if (chart) try { chart.timeScale().setVisibleLogicalRange(_rangeToRestore); } catch(e) { fitWithFuture(); }
        });
    } else {
        fitWithFuture();
    }

    // VRVP neu zeichnen nach Datenwechsel
    if (_vrvpEnabled) _scheduleVRVP();

}

/**
 * fitContent() + Zeitachse ~1 Jahr in die Zukunft verlängern.
 * setVisibleLogicalRange() nach fitContent() — rightOffset wird von fitContent() ignoriert.
 */
/**
 * Erzeugt zukünftige Datumswerte im gleichen Format wie aggregateCandles().
 * 1D: Werktage (Mo–Fr), 1W: Montage, 1M: Monatserste.
 */
function generateFutureDates(lastDate, tf, count) {
    var dates = [];
    var d = new Date(lastDate + 'T12:00:00Z');
    if (tf === '1W') {
        for (var i = 0; i < count; i++) {
            d.setUTCDate(d.getUTCDate() + 7);
            dates.push(d.toISOString().slice(0, 10));
        }
    } else if (tf === '1M') {
        for (var i = 0; i < count; i++) {
            d.setUTCMonth(d.getUTCMonth() + 1);
            d.setUTCDate(1);
            dates.push(d.toISOString().slice(0, 10));
        }
    } else {
        while (dates.length < count) {
            d.setUTCDate(d.getUTCDate() + 1);
            var day = d.getUTCDay();
            if (day !== 0 && day !== 6) dates.push(d.toISOString().slice(0, 10));
        }
    }
    return dates;
}

function fitWithFuture() {
    if (!chart || !csSeries) return;
    csSeries.priceScale().applyOptions({ autoScale: true });
    chart.timeScale().fitContent();
    requestAnimationFrame(function() {
        if (csSeries) csSeries.priceScale().applyOptions({ autoScale: false });
    });
}

function fitView() {
    fitChart();
    if (!chart || !csSeries) return;
    csSeries.priceScale().applyOptions({ autoScale: true });
    requestAnimationFrame(function() {
        if (csSeries) csSeries.priceScale().applyOptions({ autoScale: false });
    });
    var candles = allCandles;
    if (!candles || !candles.length) { chart.timeScale().fitContent(); return; }
    var toDate   = candles[candles.length - 1].time;
    var fromDate;
    if (currentPeriod > 0) {
        var cut = new Date();
        cut.setDate(cut.getDate() - currentPeriod);
        fromDate = cut.toISOString().slice(0, 10);
        // nicht vor dem ersten verfügbaren Kerze
        if (fromDate < candles[0].time) fromDate = candles[0].time;
    } else {
        fromDate = candles[0].time;
    }
    try {
        chart.timeScale().setVisibleRange({ from: fromDate, to: toDate });
    } catch(e) {
        chart.timeScale().fitContent();
    }
}

function applyLogReg(regResult, rS, rUS, rLS) {
    if (!rS) return;
    if (regResult) {
        rS.applyOptions({ visible: true, title: 'ARR: ' + regResult.arr + '% R²: ' + regResult.r2 });
        rS.setData(regResult.reg);
        if (rUS) { rUS.applyOptions({ visible: true }); rUS.setData(regResult.upper); }
        if (rLS) { rLS.applyOptions({ visible: true }); rLS.setData(regResult.lower); }
    } else {
        rS.applyOptions({ visible: false });
        if (rUS) rUS.applyOptions({ visible: false });
        if (rLS) rLS.applyOptions({ visible: false });
    }
}


function syncUIState() {
    var periodLabels = { 30: '1M', 90: '3M', 180: '6M', 365: '1J', 0: 'All' };
    var grp = document.getElementById('period-btns');
    if (grp) grp.querySelectorAll('.btn').forEach(function(b) {
        b.classList.toggle('active', b.textContent === (periodLabels[currentPeriod] || ''));
    });
    ['1D', '1W', '1M'].forEach(function(t) {
        var b = document.getElementById('tf' + t);
        if (b) b.classList.toggle('active', t === currentTF);
    });
    ['ma50', 'ma200', 'reg'].forEach(function(n) {
        var b = document.getElementById('b' + n);
        if (b) b.classList.toggle('ind-active', !!indicators[n]);
    });
    var blog = document.getElementById('blog');
    if (blog) blog.classList.toggle('ind-active', !!logScale);
}

// ╔══════════════════════════════════════════════════════════╗
// ║  5. WATCHLIST & SIDEBAR                                   ║
// ╚══════════════════════════════════════════════════════════╝

function renderWatchlist() {
    var el = document.getElementById('watchlist');
    if (!el) return;
    el.innerHTML = '';

    // Index-Zeile: nur wenn für diesen Basket aktiviert
    if (basketShowIndex()) {
    var idxCandles = buildIndex(_dataMap);
    var idxLast = idxCandles.length ? idxCandles[idxCandles.length - 1] : null;
    var idxPrev = idxCandles.length > 1 ? idxCandles[idxCandles.length - 2] : idxLast;
    var idxChg  = idxLast && idxPrev ? ((idxLast.close - idxPrev.close) / idxPrev.close * 100).toFixed(2) : null;
    var idxActive = currentView === 'index';

    var idxDiv = document.createElement('div');
    idxDiv.className = 'wl-item wl-index' + (idxActive ? ' active' : '');
    idxDiv.innerHTML = '<div class="wl-sym">● ' + (baskets[currentBasket] ? baskets[currentBasket].name : 'Index') + '</div>'
        + '<div class="wl-right">'
        + '<div class="wl-price">' + (idxLast ? basketCurSymbol() + idxLast.close.toFixed(2) : '-') + '</div>'
        + '<div class="wl-chg" style="color:' + (!idxActive && idxChg ? (parseFloat(idxChg) >= 0 ? 'var(--green)' : 'var(--red)') : '') + '">'
        + (idxChg ? (parseFloat(idxChg) >= 0 ? '+' : '') + idxChg + '%' : '-') + '</div>'
        + '</div>';
    idxDiv.onclick = function() { switchView('index'); };
    el.appendChild(idxDiv);
    } // end basketShowIndex

    // Ticker (alphabetisch)
    Object.keys(WEIGHTS).sort().forEach(function(sym) {
        var p      = perfData[sym];
        var active = currentView === sym;
        var div    = document.createElement('div');
        div.className = 'wl-item' + (active ? ' active' : '');
        var chgColor = p ? (parseFloat(p.d1) >= 0 ? 'var(--green)' : 'var(--red)') : 'var(--muted)';
        var logoHtml = '<img class="wl-logo"'
            + ' src="https://financialmodelingprep.com/image-stock/' + sym + '.png"'
            + ' onerror="this.style.display=\'none\'">';
        div.innerHTML = '<div class="wl-sym">' + logoHtml + sym + '</div>'
            + '<div class="wl-right">'
            + '<div class="wl-price">' + (p ? tickerCurSymbol(sym) + p.price.toFixed(2) : '-') + '</div>'
            + '<div class="wl-chg" style="color:' + (!active ? chgColor : 'rgba(255,255,255,0.85)') + '">'
            + (p ? (parseFloat(p.d1) >= 0 ? '+' : '') + p.d1 + '%' : '-') + '</div>'
            + '</div>';
        div.onclick = (function(s) { return function() { switchView(s); }; })(sym);
        if (active) div.scrollIntoView({ block: 'nearest' });
        el.appendChild(div);
    });
}

function renderBasketSelect() {
    var sortedIds = Object.keys(baskets).sort(function(a, b) {
        return (baskets[a].name || a).localeCompare(baskets[b].name || b, undefined, { sensitivity: 'base', numeric: true });
    });
    // Hidden select (für saveAll/shared.js-Kompatibilität)
    var sel = document.getElementById('basketSelect');
    if (sel) {
        sel.innerHTML = '';
        sortedIds.forEach(function(id) {
            var opt = document.createElement('option');
            opt.value = id; opt.textContent = baskets[id].name || id;
            opt.selected = id === currentBasket;
            sel.appendChild(opt);
        });
    }
    // Basket-Pills in der Sidebar
    var bar = document.getElementById('basket-pills-bar');
    if (bar) {
        bar.innerHTML = '';
        sortedIds.forEach(function(id) {
            var pill = document.createElement('div');
            pill.className = 'basket-pill' + (id === currentBasket ? ' active' : '');
            var name = (baskets[id].name || id);
            if (id === currentBasket) {
                pill.innerHTML = '<span>' + name + '</span>'
                    + '<button class="bp-edit" title="Umbenennen" onclick="renameBasket();event.stopPropagation()">✎</button>'
                    + '<button class="bp-del"  title="Löschen"    onclick="deleteBasket();event.stopPropagation()">×</button>';
            } else {
                pill.textContent = name;
                pill.onclick = (function(bid) { return function() { switchBasket(bid); }; })(id);
            }
            bar.appendChild(pill);
        });
        var addBtn = document.createElement('button');
        addBtn.className = 'bp-add'; addBtn.title = 'Neues Portfolio'; addBtn.textContent = '+';
        addBtn.onclick = addBasket;
        bar.appendChild(addBtn);
    }
    updateChartTitle();
}

function updateChartTitle() {
    var el = document.getElementById('chartTitle');
    if (!el) return;
    if (currentView === 'index') {
        el.textContent = baskets[currentBasket] ? baskets[currentBasket].name : 'Index';
    } else {
        el.textContent = currentView;
    }
}

// ── Chart-Meta: Hintergrund-Wasserzeichen + Stammdaten-Feld ──────────────────────

var _tickerInfoCache = {};   // sym -> info-Objekt
var _tickerInfoReq   = 0;    // Race-Schutz (nur die letzte Anfrage rendert)

/** Setzt den Wasserzeichen-Text im Chart-Hintergrund. */
function setChartWatermark(text) {
    var el = document.getElementById('chartWatermark');
    if (el) el.textContent = text || '';
}

/** Aktualisiert Wasserzeichen + Stammdaten-Feld passend zur aktuellen Ansicht. */
function updateChartMeta() {
    if (typeof currentView === 'undefined') return;
    if (currentView === 'index') {
        var name = (typeof baskets !== 'undefined' && baskets[currentBasket])
            ? baskets[currentBasket].name : 'Index';
        setChartWatermark(name);
        renderTickerInfo(null);            // Stammdaten nur für Einzelaktien
    } else {
        setChartWatermark(currentView);
        if (_tickerInfoCache[currentView]) {
            renderTickerInfo(_tickerInfoCache[currentView]);
        } else {
            renderTickerInfo({ loading: true, symbol: currentView });
            fetchTickerInfo(currentView);
        }
    }
}

/** Holt Stammdaten vom Backend (gecacht) und rendert sie, wenn noch aktuell. */
async function fetchTickerInfo(sym) {
    var req = ++_tickerInfoReq;
    try {
        var res = await fetch('/api/ticker/info/' + encodeURIComponent(sym))
                        .then(function(r) { return r.json(); });
        if (res && res.ok) _tickerInfoCache[sym] = res;
        if (req !== _tickerInfoReq || currentView !== sym) return;   // Ansicht hat gewechselt
        renderTickerInfo(res && res.ok ? res : { error: true, symbol: sym });
    } catch (e) {
        if (req === _tickerInfoReq && currentView === sym) renderTickerInfo({ error: true, symbol: sym });
    }
}

/** Rendert das Stammdaten-Fenster. null → Platzhalter (Index-Ansicht). */
function renderTickerInfo(d) {
    var el = document.getElementById('ticker-info');
    if (!el) return;
    if (!d)        { el.innerHTML = '<div class="ti-loading">Einzelaktie wählen für Stammdaten.</div>'; return; }
    if (d.loading) { el.innerHTML = '<div class="ti-loading">Lade Stammdaten …</div>'; return; }
    if (d.error)   { el.innerHTML = '<div class="ti-loading">Keine Stammdaten verfügbar</div>'; return; }

    var esc = function(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    };
    var cap = function(v) {
        if (v == null) return null;
        var a = Math.abs(v);
        if (a >= 1e12) return (v/1e12).toFixed(2) + ' T';
        if (a >= 1e9)  return (v/1e9).toFixed(2) + ' Mrd';
        if (a >= 1e6)  return (v/1e6).toFixed(2) + ' Mio';
        return v.toLocaleString('de-DE');
    };
    var num = function(v, dec) { return v == null ? null : Number(v).toLocaleString('de-DE', { maximumFractionDigits: dec == null ? 2 : dec }); };
    // yfinance liefert dividendYield bereits in Prozent (z.B. 0.37 = 0,37 %, 2.64 = 2,64 %)
    var pct = function(v) { return v == null ? null : Number(v).toLocaleString('de-DE', { maximumFractionDigits: 2 }) + ' %'; };

    var ccy  = d.currency ? (' ' + esc(d.currency)) : '';
    var rows = [
        ['Sektor',     d.sector ? esc(d.sector) : null],
        ['Branche',    d.industry ? esc(d.industry) : null],
        ['MarktKap.',  cap(d.market_cap) ? cap(d.market_cap) + ccy : null],
        ['KGV',        num(d.pe)],
        ['KGV (e)',    num(d.forward_pe)],
        ['Div.-Rend.', pct(d.dividend_yield)],
        ['Beta',       num(d.beta)],
        ['52W-Hoch',   num(d.week52_high) ? num(d.week52_high) + ccy : null],
        ['52W-Tief',   num(d.week52_low)  ? num(d.week52_low)  + ccy : null],
        ['Land',       d.country ? esc(d.country) : null],
        ['Börse',      d.exchange ? esc(d.exchange) : null]
    ].filter(function(r) { return r[1] != null && r[1] !== ''; });

    var html = '<div class="ti-name">' + esc(d.name || d.symbol) + '</div>';
    html += '<div class="ti-sub">' + esc(d.symbol)
          + (d.quote_type ? ' · ' + esc(d.quote_type) : '') + '</div>';

    // Saubere Tabelle: zwei Merkmal/Wert-Paare je Zeile (nutzt die Pane-Breite)
    var cells = '';
    for (var i = 0; i < rows.length; i += 2) {
        var a = rows[i], b = rows[i + 1];
        cells += '<tr>'
              +  '<th>' + a[0] + '</th><td>' + a[1] + '</td>'
              +  (b ? '<th>' + b[0] + '</th><td>' + b[1] + '</td>'
                    : '<th></th><td></td>')
              +  '</tr>';
    }
    html += '<table class="ti-table"><tbody>' + cells + '</tbody></table>';
    el.innerHTML = html;
}

function showTab(tab) {
    document.querySelectorAll('.sidebar-tab').forEach(function(t) { t.classList.remove('active'); });
    document.querySelectorAll('.sidebar-content').forEach(function(c) { c.style.display = 'none'; });
    var btn = document.getElementById('tab-' + tab);
    var content = document.getElementById('content-' + tab);
    if (btn) btn.classList.add('active');
    if (content) content.style.display = '';
    // Inhalte rendern wenn nötig
    if (tab === 'verwaltung') renderManageList();
}

function renderTickerBar() {
    var el = document.getElementById('tickerBar');
    if (!el) return;
    var syms = Object.keys(WEIGHTS).filter(function(s) { return (WEIGHTS[s] || 0) > 0; });
    el.innerHTML = syms.map(function(sym) {
        var p = perfData[sym];
        var chg = p ? parseFloat(p.d1) : 0;
        return '<span style="margin-right:16px;color:' + (chg >= 0 ? 'var(--green)' : 'var(--red)') + '">'
            + sym + ' ' + (p ? '$' + p.price.toFixed(2) : '-')
            + ' (' + (chg >= 0 ? '+' : '') + (p ? p.d1 : '0') + '%)</span>';
    }).join('');
}

// ╔══════════════════════════════════════════════════════════╗
// ║  6. TICKER VERWALTUNG                                     ║
// ╚══════════════════════════════════════════════════════════╝

function renderManageList() {
    var el = document.getElementById('manageList');
    if (!el) return;
    el.innerHTML = '';
    // Index-toggle header
    var header = document.createElement('div');
    header.style.cssText = 'padding:4px 0 8px;border-bottom:1px solid var(--border);margin-bottom:8px;';
    var showIdx = basketShowIndex();
    header.innerHTML = '<label style="display:flex;align-items:center;gap:6px;font-size:10px;cursor:pointer;">'
        + '<input type="checkbox" id="chk-show-index"' + (showIdx ? ' checked' : '') + '>'
        + 'Index anzeigen</label>';
    header.querySelector('input').onchange = function() {
        baskets[currentBasket].showIndex = this.checked;
        markUnsaved();
        if (!this.checked && currentView === 'index') switchView(Object.keys(WEIGHTS)[0] || 'index');
        renderWatchlist();
    };
    el.appendChild(header);
    var syms = Object.keys(WEIGHTS);
    if (syms.length === 0) {
        var empty = document.createElement('p');
        empty.style.cssText = 'color:var(--muted);padding:8px;';
        empty.textContent = 'Noch keine Ticker. Suche unten.';
        el.appendChild(empty);
        return;
    }
    syms.forEach(function(sym) {
        var row = document.createElement('div');
        row.className = 'manage-item';
        row.innerHTML = '<span class="sym-label">' + sym + '</span>'
            + '<input type="number" value="' + (WEIGHTS[sym] || 0) + '" data-sym="' + sym + '" title="negativ = Short">'
            + '<button class="manage-del" onclick="removeTicker(\'' + sym + '\')" title="Entfernen">×</button>';
        var input = row.querySelector('input');
        input.oninput = function() {
            var v = parseInt(this.value, 10);
            WEIGHTS[sym] = isNaN(v) ? 0 : v;
            markUnsaved();
        };
        el.appendChild(row);
    });
}

async function addTicker(sym) {
    sym = sym.toUpperCase().trim();
    if (!sym || WEIGHTS[sym] !== undefined) return;
    WEIGHTS[sym] = 1;
    markUnsaved();
    renderManageList();
    // Kursdaten sofort laden
    showLoading('Lade ' + sym + '...');
    var r = await fetch('/api/prices/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tickers: [sym] })
    });
    hideLoading();
    await loadData();
    renderManageList();
}

function removeTicker(sym) {
    delete WEIGHTS[sym];
    markUnsaved();
    renderManageList();
    if (currentView === sym) switchView(basketShowIndex() ? 'index' : (Object.keys(WEIGHTS)[0] || 'index'));
    else loadData();
}

function onSearch(val) {
    var res = document.getElementById('searchResults');
    if (!res) return;
    if (!val || val.length < 1) { res.innerHTML = ''; return; }
    fetch('/api/search/' + encodeURIComponent(val))
        .then(function(r) { return r.json(); })
        .then(function(data) {
            res.innerHTML = data.slice(0, 6).map(function(d) {
                return '<div class="search-result" onclick="addTicker(\'' + d.symbol + '\');document.getElementById(\'searchInput\').value=\'\';document.getElementById(\'searchResults\').innerHTML=\'\';">'
                    + '<span style="font-weight:600">' + d.symbol + '</span>'
                    + '<span style="color:var(--muted);font-size:10px">' + (d.name || '') + '</span>'
                    + '</div>';
            }).join('');
        })
        .catch(function() { res.innerHTML = ''; });
}

// ╔══════════════════════════════════════════════════════════╗
// ║  7. DRAWING MANAGER (lightweight-charts-drawing)          ║
// ╚══════════════════════════════════════════════════════════╝

// Tool → Gruppen-ID
var _TOOL_GROUP = {
    'trend-line':'dg-lines','extended-line':'dg-lines','horizontal-line':'dg-lines',
    'horizontal-ray':'dg-lines','vertical-line':'dg-lines','ray':'dg-lines',
    'cross-line':'dg-lines','info-line':'dg-lines','trend-angle':'dg-lines',
    'fib-retracement':'dg-fib','fib-extension':'dg-fib','fib-circles':'dg-fib',
    'fib-speed-fan':'dg-fib','fib-arcs':'dg-fib','fib-channel':'dg-fib',
    'fib-time-zone':'dg-fib','fib-time-extension':'dg-fib','fib-spiral':'dg-fib','fib-wedge':'dg-fib',
    'gann-box':'dg-gann','gann-fan':'dg-gann','gann-square':'dg-gann','gann-square-fixed':'dg-gann',
    'parallel-channel':'dg-ch','regression-trend':'dg-ch','flat-top-bottom':'dg-ch','disjoint-channel':'dg-ch',
    'andrews-pitchfork':'dg-pf','schiff-pitchfork':'dg-pf','modified-schiff-pitchfork':'dg-pf',
    'inside-pitchfork':'dg-pf','pitchfan':'dg-pf',
    'rectangle':'dg-sh','triangle':'dg-sh','circle':'dg-sh','ellipse':'dg-sh',
    'arc':'dg-sh','rotated-rectangle':'dg-sh','polyline':'dg-sh',
    'curve':'dg-sh','double-curve':'dg-sh','path':'dg-sh',
    'text-annotation':'dg-an','callout':'dg-an','arrow':'dg-an','brush':'dg-an',
    'highlighter':'dg-an','arrow-marker':'dg-an','arrow-mark-up':'dg-an','arrow-mark-down':'dg-an',
    'anchored-text':'dg-an','note':'dg-an','price-note':'dg-an','price-label':'dg-an',
    'flag-mark':'dg-an','pin':'dg-an','comment':'dg-an','signpost':'dg-an','table':'dg-an',
    'price-range':'dg-fc','projection':'dg-fc','long-position':'dg-fc','short-position':'dg-fc',
    'date-range':'dg-fc','date-price-range':'dg-fc','forecast':'dg-fc','bars-pattern':'dg-fc',
};

// Tool → Gruppen-Icon (letztes genutztes Tool als Gruppen-Icon)
var _TOOL_ICON = {
    'trend-line':'╱','extended-line':'↔','horizontal-line':'—','horizontal-ray':'→',
    'vertical-line':'│','ray':'⟶','cross-line':'✛','info-line':'ℹ','trend-angle':'∠',
    'fib-retracement':'Φ','fib-extension':'Φ↑','fib-circles':'Φ○','fib-speed-fan':'Φ⑂',
    'fib-arcs':'Φ⌒','fib-channel':'Φ⋕','fib-time-zone':'Φ|','fib-time-extension':'Φ→',
    'fib-spiral':'Φ@','fib-wedge':'Φ∨',
    'gann-box':'G□','gann-fan':'G⑂','gann-square':'G◼','gann-square-fixed':'G◻',
    'parallel-channel':'⋕','regression-trend':'≈','flat-top-bottom':'⊟','disjoint-channel':'≋',
    'andrews-pitchfork':'⑂','schiff-pitchfork':'⑂s','modified-schiff-pitchfork':'⑂m',
    'inside-pitchfork':'⑂i','pitchfan':'⑂f',
    'rectangle':'□','triangle':'△','circle':'○','ellipse':'⬭','arc':'⌒',
    'rotated-rectangle':'◱','polyline':'∧','curve':'∿','double-curve':'≈','path':'⤡',
    'text-annotation':'T','callout':'💬','arrow':'→','brush':'✎','highlighter':'▬',
    'arrow-marker':'▲','arrow-mark-up':'↑','arrow-mark-down':'↓','anchored-text':'⚓',
    'note':'📌','price-note':'$n','price-label':'$l','flag-mark':'⚑',
    'pin':'●','comment':'💭','signpost':'▷','table':'▦',
    'price-range':'↕','projection':'⊿','long-position':'▲','short-position':'▼',
    'date-range':'📅','date-price-range':'⊞','forecast':'∿','bars-pattern':'⬛',
};

// Utility-Toggle-States
var _drawSnap = false;
var _drawLock = false;
var _drawVisible = true;

function toggleSnap() {
    _drawSnap = !_drawSnap;
    var btn = document.getElementById('dsSnap');
    if (btn) btn.classList.toggle('util-active', _drawSnap);
}

function toggleDrawLock() {
    _drawLock = !_drawLock;
    var btn = document.getElementById('dsLock');
    if (btn) btn.classList.toggle('util-active', _drawLock);
}

function toggleDrawVisibility() {
    _drawVisible = !_drawVisible;
    var btn = document.getElementById('dsVis');
    if (btn) btn.classList.toggle('util-active', !_drawVisible);
if (drawingManager && typeof drawingManager.getAllDrawings === 'function') {
        drawingManager.getAllDrawings().forEach(function(d) {
            d.options = Object.assign({}, d.options, { visible: _drawVisible });
        });
    }
}

var _DASH_PATTERNS = [[], [8, 4], [2, 4]];

function _getTargets() {
    if (_multiSelected.size > 0) return Array.from(_multiSelected);
    var d = _drawSelected || (drawingManager && drawingManager.getSelectedDrawing && drawingManager.getSelectedDrawing());
    return d ? [d] : [];
}

function applyDrawingColor(hex) {
    var targets = _getTargets();
    if (!targets.length) return;
    var r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    targets.forEach(function(d) {
        d.updateStyle({ lineColor: hex, labelColor: hex, fillColor: 'rgba(' + r + ',' + g + ',' + b + ',0.1)' });
        saveDrawingWithText(d);
    });
}

function applyDrawingDash(idx) {
    var targets = _getTargets();
    if (!targets.length) return;
    targets.forEach(function(d) {
        d.updateStyle({ lineDash: _DASH_PATTERNS[idx] });
        saveDrawingWithText(d);
    });
    [0, 1, 2].forEach(function(i) {
        var b = document.getElementById('dsDash' + i);
        if (b) b.classList.toggle('util-active', i === idx);
    });
}

function _syncDashButtons(lineDash) {
    var pattern = JSON.stringify(lineDash || []);
    [0, 1, 2].forEach(function(i) {
        var b = document.getElementById('dsDash' + i);
        if (b) b.classList.toggle('util-active', JSON.stringify(_DASH_PATTERNS[i]) === pattern);
    });
}

// Kebab-Type → Klassen-Name für importDrawings-Factory
var _TOOL_CLASS = {
    'line':'TrendLine','trend-line':'TrendLine','extended-line':'ExtendedLine',
    'horizontal-line':'HorizontalLine','horizontal-ray':'HorizontalRay',
    'vertical-line':'VerticalLine','ray':'Ray','cross-line':'CrossLine',
    'info-line':'InfoLine','trend-angle':'TrendAngle',
    'fib-retracement':'FibRetracement','fib-extension':'FibExtension',
    'fib-circles':'FibCircles','fib-speed-fan':'FibSpeedFan',
    'fib-arcs':'FibArcs','fib-channel':'FibChannel','fib-time-zone':'FibTimeZone',
    'fib-time-extension':'FibTimeExtension','fib-spiral':'FibSpiral','fib-wedge':'FibWedge',
    'gann-box':'GannBox','gann-fan':'GannFan','gann-square':'GannSquare','gann-square-fixed':'GannSquareFixed',
    'parallel-channel':'ParallelChannel','regression-trend':'RegressionTrend',
    'flat-top-bottom':'FlatTopBottom','disjoint-channel':'DisjointChannel',
    'andrews-pitchfork':'AndrewsPitchfork','schiff-pitchfork':'SchiffPitchfork',
    'modified-schiff-pitchfork':'ModifiedSchiffPitchfork','inside-pitchfork':'InsidePitchfork',
    'pitchfan':'Pitchfan',
    'rectangle':'Rectangle','triangle':'Triangle','circle':'Circle','ellipse':'Ellipse',
    'arc':'Arc','rotated-rectangle':'RotatedRectangle','polyline':'Polyline',
    'curve':'Curve','double-curve':'DoubleCurve','path':'Path',
    'text-annotation':'TextAnnotation','callout':'Callout','arrow':'Arrow','brush':'Brush',
    'highlighter':'Highlighter','arrow-marker':'ArrowMarker','arrow-mark-up':'ArrowMarkUp',
    'arrow-mark-down':'ArrowMarkDown','anchored-text':'AnchoredText','note':'Note',
    'price-note':'PriceNote','price-label':'PriceLabel','flag-mark':'FlagMark','pin':'Pin',
    'comment':'Comment','signpost':'Signpost','table':'Table',
    'price-range':'PriceRange','projection':'Projection','long-position':'LongPosition',
    'short-position':'ShortPosition','date-range':'DateRange','date-price-range':'DatePriceRange',
    'forecast':'Forecast','bars-pattern':'BarsPattern',
};

// Zeichnungs-Tools mit Text-Eingabe
var _TEXT_TOOLS = new Set([
    'text-annotation','callout','note','anchored-text',
    'price-note','price-label','comment','signpost'
]);

/**
 * Speichert Zeichnung inkl. Text — toJSON() der Bibliothek schreibt text NICHT
 * in options (wird beim Destrukturieren im Konstruktor herausgezogen), daher
 * wird getText() manuell in options.text gepatcht.
 */
function saveDrawingWithText(drawing) {
    try {
        var json = drawing.toJSON ? drawing.toJSON() : drawing;
        if (typeof drawing.getText === 'function') {
            json.options = json.options || {};
            json.options.text = drawing.getText();
        }
        saveDrawing(json);
    } catch(e) { console.warn('saveDrawingWithText:', e); }
}

function initDrawingManager() {
    var lcd = window.LightweightChartsDrawing;
    if (!lcd || !chart || !csSeries) return;
    drawingManager = new lcd.DrawingManager();
    var _dmContainer = document.getElementById('chartContainer');
    drawingManager.attach(chart, csSeries, _dmContainer);

    // Disable chart panning while dragging anchor or translating drawing
    var _xlate = null; // translate-drag state
    var _xlateActive = false;

    _dmContainer.addEventListener('mousedown', function(e) {
        if (!drawingManager) return;
        _lastClickCtrl = e.ctrlKey || e.metaKey;
        var rect = _dmContainer.getBoundingClientRect();
        var pt = { x: e.clientX - rect.left, y: e.clientY - rect.top };

        if (drawingManager.hitTestAnchor(pt) !== null) {
            // Anchor drag — existing behaviour
            chart.applyOptions({ handleScroll: false, handleScale: false });
            return;
        }
        if (_activeToolType) return; // creating a new drawing — don't intercept

        var hit = drawingManager.hitTest(pt);
        if (!hit && !_lastClickCtrl) _multiSelected.clear();
        if (hit) {
            chart.applyOptions({ handleScroll: false, handleScale: false });
            var ts = chart.timeScale();
            _xlate = {
                drawing: hit,
                startX: pt.x, startY: pt.y,
                pixAnchors: hit.anchors.map(function(a) {
                    return { x: ts.timeToCoordinate(a.time), y: csSeries.priceToCoordinate(a.price) };
                }),
                origAnchors: hit.anchors.map(function(a) { return { time: a.time, price: a.price }; })
            };
            _xlateActive = false;
        }
    }, true);

    _dmContainer.addEventListener('mousemove', function(e) {
        if (!_xlate) return;
        var rect = _dmContainer.getBoundingClientRect();
        var pt = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        var dx = pt.x - _xlate.startX, dy = pt.y - _xlate.startY;
        if (!_xlateActive && dx * dx + dy * dy < 16) return; // 4 px threshold
        _xlateActive = true;
        var ts = chart.timeScale();
        var newAnchors = _xlate.pixAnchors.map(function(ap, i) {
            var nx = ap.x + dx, ny = ap.y + dy;
            var nt = ts.coordinateToTime(nx), np = csSeries.coordinateToPrice(ny);
            return (nt !== null && np !== null) ? { time: nt, price: np } : _xlate.origAnchors[i];
        });
        _xlate.drawing.setAnchors(newAnchors);
    }, true);

    var _endXlate = function() {
        if (_xlate && _xlateActive) saveDrawingWithText(_xlate.drawing);
        _xlate = null; _xlateActive = false;
        chart.applyOptions({ handleScroll: true, handleScale: true });
    };
    _dmContainer.addEventListener('mouseup', _endXlate, true);
    _dmContainer.addEventListener('mouseleave', _endXlate, true);

    // Hilfsfunktion: Preview-Zeichnung erstellen/aktualisieren
    function _refreshPreview(anchors) {
        if (_previewDrawing) {
            drawingManager.removeDrawing(_previewDrawing.id);
            _previewDrawing = null;
        }
        // Platzhalter: letzter Ankerpunkt wird vom Crosshair überschrieben
        var previewAnchors = anchors.concat([anchors[anchors.length - 1]]);
        _previewDrawing = lcd.getToolRegistry().createDrawing(_activeToolType, '__preview__', previewAnchors, {}, {});
        if (_previewDrawing) drawingManager.addDrawing(_previewDrawing);
    }

    // DrawingManager handles selection only; creation is wired here via subscribeClick
    chart.subscribeClick(function(param) {
        if (!_activeToolType || !drawingManager) return;
        if (!param.point) return;
        var ts = chart.timeScale();
        var time = ts.coordinateToTime(param.point.x);
        var price = csSeries.coordinateToPrice(param.point.y);
        if (time === null || price === null) return;
        _pendingAnchors.push({ time: time, price: price });
        var toolDef = lcd.TOOL_DEFINITIONS.find(function(t) { return t.type === _activeToolType; });
        var required = toolDef ? toolDef.requiredAnchors : 2;

        if (_pendingAnchors.length >= required) {
            // Finaler Klick: Preview entfernen, echte Zeichnung erstellen
            if (_crosshairCb) { chart.unsubscribeCrosshairMove(_crosshairCb); _crosshairCb = null; }
            if (_previewDrawing) { drawingManager.removeDrawing(_previewDrawing.id); _previewDrawing = null; }

            // Text-Tools: Text vor Erstellung abfragen
            var initialOpts = {};
            if (_TEXT_TOOLS.has(_activeToolType)) {
                var inputText = prompt('Text eingeben:', '');
                if (inputText === null) { _pendingAnchors = []; setDrawTool(null); return; }
                initialOpts.text = inputText || ' ';
            }

            var id = 'draw_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
            var drawing = lcd.getToolRegistry().createDrawing(_activeToolType, id, _pendingAnchors.slice(), {}, initialOpts);
            _pendingAnchors = [];
            if (drawing) drawingManager.addDrawing(drawing);
            setDrawTool(null);
        } else {
            // Zwischenklick: Preview-Zeichnung aufbauen/aktualisieren
            _refreshPreview(_pendingAnchors);
            // Crosshair-Listener starten falls noch nicht aktiv
            if (!_crosshairCb) {
                _crosshairCb = function(param) {
                    if (!_previewDrawing || !param.point) return;
                    var t2 = chart.timeScale().coordinateToTime(param.point.x);
                    var p2 = csSeries.coordinateToPrice(param.point.y);
                    if (t2 !== null && p2 !== null) {
                        _previewDrawing.updateAnchor(_previewDrawing.anchors.length - 1, { time: t2, price: p2 });
                    }
                };
                chart.subscribeCrosshairMove(_crosshairCb);
            }
        }
    });

    drawingManager.on('drawing:added', function(evt) {
        var d = evt.drawing || evt;
        if (d.id === '__preview__') return; // Preview nicht speichern
        saveDrawingWithText(d);
    });
    drawingManager.on('drawing:removed', function(evt) {
        var id = evt.drawingId || ((evt.drawing || {}).id);
        if (!id || id === '__preview__') return; // Preview nicht löschen
        deleteDrawing(id);
    });
    drawingManager.on('drawing:selected', function(evt) {
        _drawSelected = evt && (evt.drawing || null);
        if (!_lastClickCtrl) _multiSelected.clear();
        if (_drawSelected) _multiSelected.add(_drawSelected);
        if (_drawSelected && _drawSelected.style) {
            var inp = document.getElementById('dsColor');
            var c = _drawSelected.style.lineColor || '#2962ff';
            if (inp && /^#[0-9a-fA-F]{6}$/.test(c)) inp.value = c;
            _syncDashButtons(_drawSelected.style.lineDash);
        }
    });
    drawingManager.on('drawing:deselected', function(evt) {
        var d = evt && (evt.drawing || null);
        if (!_lastClickCtrl) {
            _drawSelected = null;
            _multiSelected.clear();
        } else if (d) {
            // Ctrl gehalten: aus Menge entfernen statt alles leeren
            _multiSelected.delete(d);
        }
    });
    drawingManager.on('drawing:updated', function(evt) {
        var d = evt && (evt.drawing || null);
        if (d && d.id !== '__preview__') saveDrawingWithText(d);
    });

    // Doppelklick auf Zeichnung → Text bearbeiten
    _dmContainer.addEventListener('dblclick', function(e) {
        var selected = drawingManager.getSelectedDrawing
            ? drawingManager.getSelectedDrawing()
            : _drawSelected;
        if (!selected || typeof selected.setText !== 'function') return;
        e.stopPropagation();
        var current = selected.getText ? selected.getText() : '';
        var newText = prompt('Text bearbeiten:', current);
        if (newText === null) return;
        selected.setText(newText || ' ');
        saveDrawingWithText(selected);
    });
}

// Mappt ein Datum auf den nächsten vorhandenen Bar (für TF-übergreifende Drawings)
function _snapAnchorTime(time) {
    if (!_lastCandles || !_lastCandles.length || currentTF === '1D') return time;
    var tMs = new Date(time).getTime();
    var best = _lastCandles[0].time, bestDiff = Infinity;
    for (var i = 0; i < _lastCandles.length; i++) {
        var diff = Math.abs(new Date(_lastCandles[i].time).getTime() - tMs);
        if (diff < bestDiff) { bestDiff = diff; best = _lastCandles[i].time; }
        else break; // Array ist aufsteigend sortiert
    }
    return best;
}

// Wird von shared.js loadDrawings() aufgerufen
function onDrawingsLoaded(data) {
    if (!drawingManager) return;
    drawingManager.clearAll();
    if (!data || !data.length) return;
    try {
        drawingManager.importDrawings(data, function(type, d) {
            var lcd = window.LightweightChartsDrawing;
            if (!lcd) return null;
            var Cls = lcd[_TOOL_CLASS[type]];
            if (typeof Cls !== 'function') return null;
            var anchors = (d.anchors || []).map(function(a) {
                return { time: _snapAnchorTime(a.time), price: a.price };
            });
            try { return new Cls(d.id, anchors, d.style || {}, d.options || {}); }
            catch(e) { console.warn('importDrawings factory:', type, e); return null; }
        });
    } catch(e) { console.warn('importDrawings failed:', e); }
}

// Wird von shared.js clearAllDrawings() aufgerufen
function onDrawingsCleared() {
    if (drawingManager) drawingManager.clearAll();
}

function setDrawTool(type) {
    if (!drawingManager) return;
    var current = drawingManager.getActiveTool ? drawingManager.getActiveTool() : _activeToolType;
    if (current === type) type = null;
    _activeToolType = type;
    _pendingAnchors = [];
    if (_crosshairCb) { chart.unsubscribeCrosshairMove(_crosshairCb); _crosshairCb = null; }
    if (_previewDrawing) { drawingManager.removeDrawing(_previewDrawing.id); _previewDrawing = null; }
    drawingManager.setActiveTool(type);
    document.querySelectorAll('.dtool-btn').forEach(function(b) {
        b.classList.toggle('active', b.dataset.tool === type);
    });
    // Letztes genutztes Tool als Gruppen-Icon anzeigen
    if (type && _TOOL_GROUP[type] && _TOOL_ICON[type]) {
        var iconEl = document.getElementById(_TOOL_GROUP[type] + '-icon');
        if (iconEl) iconEl.textContent = _TOOL_ICON[type];
    }
    // Aktive Gruppe blau hervorheben
    document.querySelectorAll('.ds-group-btn').forEach(function(b) {
        var gId = b.closest('.draw-group') ? b.closest('.draw-group').id : null;
        b.classList.toggle('active', !!type && _TOOL_GROUP[type] === gId);
    });
    var ptr = document.getElementById('drawPtr');
    if (ptr) ptr.classList.toggle('active', !type);
    document.querySelectorAll('.draw-group').forEach(function(g) { g.classList.remove('open'); });
    var hint = document.getElementById('cursorHint');
    if (hint) {
        hint.textContent = type ? 'Klicken zum Zeichnen  •  Escape bricht ab' : '';
        hint.classList.toggle('show', !!type);
    }
}

function toggleDrawFlyout(id, event) {
    if (event) event.stopPropagation();
    var group = document.getElementById(id);
    if (!group) return;
    var wasOpen = group.classList.contains('open');
    document.querySelectorAll('.draw-group').forEach(function(g) { g.classList.remove('open'); });
    if (!wasOpen) group.classList.add('open');
}

// ╔══════════════════════════════════════════════════════════╗
// ║  8. RESIZER (horizontal + vertikal)                       ║
// ╚══════════════════════════════════════════════════════════╝

// ── Layouts speichern / laden ──
var _layout = {};

function saveLayout() {
    var rc = document.getElementById('right-col');
    var rp = document.getElementById('r-perf');
    var rn = document.getElementById('r-notes');
    var ri = document.getElementById('r-import');
    var st = document.getElementById('r-stammdaten');
    _layout = {
        rightColW: rc ? rc.offsetWidth  : null,
        rPerfH:   rp ? rp.offsetHeight : null,
        rNotesH:  rn ? rn.offsetHeight : null,
        rImportH: ri ? ri.offsetHeight : null,
        stammH:   st ? st.offsetHeight : null,
    };
    saveBasketsToServer();
}

function loadLayout() {
    var lay = _layout || {};
    var rc = document.getElementById('right-col');
    var rp = document.getElementById('r-perf');
    var rn = document.getElementById('r-notes');
    var ri = document.getElementById('r-import');
    var st = document.getElementById('r-stammdaten');
    if (lay.rightColW != null && rc) rc.style.width  = lay.rightColW + 'px';
    if (lay.rPerfH   != null && rp) rp.style.height = lay.rPerfH    + 'px';
    if (lay.rNotesH  != null && rn) rn.style.height = lay.rNotesH   + 'px';
    if (lay.rImportH != null && ri) ri.style.height = lay.rImportH  + 'px';
    if (lay.stammH   != null && st) st.style.height = lay.stammH    + 'px';
    if (chart) fitChart();
}

(function() {
    // Hilfsfunktion: Resizer für Panel UNTERHALB (down = Panel kleiner)
    function makeBottomResizer(resizerId, belowId, minH, maxH, cb) {
        var res = document.getElementById(resizerId);
        var pan = document.getElementById(belowId);
        if (!res || !pan) return;
        var drag = false, startY = 0, startH = 0;
        res.addEventListener('mousedown', function(e) {
            drag = true; startY = e.clientY; startH = pan.offsetHeight;
            res.classList.add('dragging');
            document.body.style.userSelect = 'none'; document.body.style.cursor = 'row-resize';
            e.preventDefault();
        });
        window.addEventListener('mousemove', function(e) {
            if (!drag) return;
            var newH = Math.max(minH, Math.min(maxH, startH - (e.clientY - startY)));
            pan.style.height = newH + 'px';
            if (cb) cb();
        });
        window.addEventListener('mouseup', function() {
            if (drag) { drag = false; res.classList.remove('dragging'); document.body.style.userSelect = ''; document.body.style.cursor = ''; saveLayout(); }
        });
    }

    // Hilfsfunktion: Resizer zwischen zwei Fixed-Panels (split)
    function makeSplitResizer(resizerId, aboveId, belowId, minH) {
        var res   = document.getElementById(resizerId);
        var above = document.getElementById(aboveId);
        var below = document.getElementById(belowId);
        if (!res || !above || !below) return;
        var drag = false, startY = 0, aboveH = 0, belowH = 0;
        res.addEventListener('mousedown', function(e) {
            drag = true; startY = e.clientY; aboveH = above.offsetHeight; belowH = below.offsetHeight;
            res.classList.add('dragging');
            document.body.style.userSelect = 'none'; document.body.style.cursor = 'row-resize';
            e.preventDefault();
        });
        window.addEventListener('mousemove', function(e) {
            if (!drag) return;
            var d = e.clientY - startY;
            above.style.height = Math.max(minH, aboveH + d) + 'px';
            below.style.height = Math.max(minH, belowH - d) + 'px';
        });
        window.addEventListener('mouseup', function() {
            if (drag) { drag = false; res.classList.remove('dragging'); document.body.style.userSelect = ''; document.body.style.cursor = ''; saveLayout(); }
        });
    }

    // ── Horizontal: Rechte Spalte breite ──
    var colRes  = document.getElementById('col-resizer');
    var rightCol = document.getElementById('right-col');
    if (colRes && rightCol) {
        var cDrag = false, cStartX = 0, cStartW = 0;
        colRes.addEventListener('mousedown', function(e) {
            cDrag = true; cStartX = e.clientX; cStartW = rightCol.offsetWidth;
            colRes.classList.add('dragging');
            document.body.style.userSelect = 'none'; document.body.style.cursor = 'col-resize';
            e.preventDefault();
        });
        window.addEventListener('mousemove', function(e) {
            if (!cDrag) return;
            var newW = Math.max(180, Math.min(600, cStartW - (e.clientX - cStartX)));
            rightCol.style.width = newW + 'px';
            fitChart();
        });
        window.addEventListener('mouseup', function() {
            if (cDrag) { cDrag = false; colRes.classList.remove('dragging'); document.body.style.userSelect = ''; document.body.style.cursor = ''; saveLayout(); }
        });
    }

    // ── Horizontal: IBKR Report | Detail (inner) ──
    (function() {
        var res   = document.getElementById('ibkr-h-resizer');
        var left  = document.getElementById('ibkr-report');
        if (!res || !left) return;
        var drag = false, startX = 0, startW = 0;
        res.addEventListener('mousedown', function(e) {
            drag = true; startX = e.clientX; startW = left.offsetWidth;
            res.classList.add('dragging');
            document.body.style.userSelect = 'none'; document.body.style.cursor = 'col-resize';
            e.preventDefault();
        });
        window.addEventListener('mousemove', function(e) {
            if (!drag) return;
            var newW = Math.max(140, Math.min(500, startW + (e.clientX - startX)));
            left.style.width = newW + 'px';
            left.style.flex  = 'none';
        });
        window.addEventListener('mouseup', function() {
            if (drag) { drag = false; res.classList.remove('dragging'); document.body.style.userSelect = ''; document.body.style.cursor = ''; }
        });
    })();

    // ── Vertikal Links: zwischen Chart und Stammdaten-Fenster (Chart=flex:1 schrumpft) ──
    makeBottomResizer('lv-resizer-1', 'r-stammdaten', 34, 600, fitChart);

    // ── Vertikal Rechts: zwischen Watchlist und Perf (perf schrumpft beim Ziehen nach unten) ──
    makeBottomResizer('rv-resizer-1', 'r-perf', 60, 500, null);

    // ── Vertikal Rechts: zwischen Perf und Notes (split) ──
    makeSplitResizer('rv-resizer-2', 'r-perf', 'r-notes', 60);

    // ── Vertikal Rechts: zwischen Notes und Import (split) ──
    makeSplitResizer('rv-resizer-3', 'r-notes', 'r-import', 50);
})();

// ╔══════════════════════════════════════════════════════════╗
// ║  9. KEYBOARD NAVIGATION                                   ║
// ╚══════════════════════════════════════════════════════════╝

document.addEventListener('keydown', function(e) {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement && document.activeElement.tagName)) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); navigateWatchlist(+1); }
    if (e.key === 'ArrowUp')   { e.preventDefault(); navigateWatchlist(-1); }
    // Delete/Backspace → ausgewählte Zeichnung(en) löschen
    if ((e.key === 'Delete' || e.key === 'Backspace') && (_multiSelected.size > 0 || _drawSelected)) {
        var toDelete = _multiSelected.size > 0 ? Array.from(_multiSelected) : (_drawSelected ? [_drawSelected] : []);
        toDelete.forEach(function(d) { if (drawingManager) drawingManager.removeDrawing(d.id); });
        _drawSelected = null;
        _multiSelected.clear();
    }
    // Escape → Zeichnungsmodus beenden
    if (e.key === 'Escape') {
        if (typeof setDrawTool === 'function') setDrawTool(null);
        document.querySelectorAll('.draw-group').forEach(function(g) { g.classList.remove('open'); });
    }
});

// ╔══════════════════════════════════════════════════════════╗
// ║ 10. UHR                                                   ║
// ╚══════════════════════════════════════════════════════════╝

function updateClock() {
    var el = document.getElementById('clock');
    if (!el) return;
    var now = new Date();
    el.textContent = now.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
setInterval(updateClock, 1000);
updateClock();

// ╔══════════════════════════════════════════════════════════╗
// ║ 11. STARTUP                                               ║
// ╚══════════════════════════════════════════════════════════╝

/**
 * Desktop-Startup-Sequenz:
 * 1. Chart initialisieren
 * 2. Draw-Canvas initialisieren
 * 3. Config laden (Baskets, Gewichte)
 * 4. DB-Ticker laden
 * 5. Daten laden + rendern
 * 6. Zeichnungen + Notizen laden
 */
(function startup() {
    initChart();
    initDrawingManager();
    loadLayout();  // Layout wiederherstellen nachdem Chart initialisiert
    fitChart();

    loadConfig().then(function() {
        return loadDbTickers();
    }).then(function() {
        return loadData();
    }).then(function() {
        loadDrawings();
        loadNotes();
        ibkrLoadIsinMap().then(function() {
            ibkrLoadPositions().then(function() { return ibkrLoadCash(); }).then(function() {
                ibkrRenderTable(); refreshIbkrCostLine(_lastCandles); renderPerfTable();
                ibkrLoadSectors().then(function() { ibkrRenderTable(); });
            });
            ibkrLoadTrades().then(function() { ibkrRenderTrades(); refreshTradeMarkers(); });
        });
        var tbtn = document.getElementById('btn-trades-toggle');
        if (tbtn) tbtn.classList.toggle('active', _showTradeMarkers);
    });
})();

// ╔══════════════════════════════════════════════════════════╗
// ║ 12. IBKR POSITIONEN (Desktop)                             ║
// ╚══════════════════════════════════════════════════════════╝

// ── IBKR Live-Bewertung ──────────────────────────────────────────────────────
// Mengen + Einstand kommen aus dem Flex-Sync, der AKTUELLE Wert wird mit Live-
// Yahoo-Kursen gerechnet (× Menge, in Base umgerechnet). Fällt auf den IBKR-
// position_value zurück, wenn kein Live-Kurs vorliegt (z.B. Ticker nicht im Basket).

/** Währung→Base-Raten aus IBKRs eigenen FX-Raten der Positionen. */
function ibkrCcyFx() {
    var ccyFx = {};
    (ibkrPositions || []).forEach(function(p) {
        if (p.currency && p.fx_rate_to_base) ccyFx[p.currency] = p.fx_rate_to_base;
    });
    return ccyFx;
}

/** Wechselkurs einer Notierungswährung nach Base (GBp/GBX = GBP/100). null = unbekannt. */
function ibkrFxToBase(cur, ccyFx) {
    if (!cur) return null;
    if (cur === 'GBp' || cur === 'GBX') return ccyFx['GBP'] ? ccyFx['GBP'] / 100 : null;
    return (cur in ccyFx) ? ccyFx[cur] : null;
}

/** Aktueller Wert einer Position in Base: Live-Yahoo-Kurs × Menge, sonst IBKR-Wert. */
function ibkrLiveValue(p, ccyFx) {
    var fx    = p.fx_rate_to_base || 1.0;
    var qty   = p.quantity || 0;
    var ysym  = ibkrPosYahoo(p);
    var liveP = perfData[ysym];
    var yrate = (liveP && liveP.price) ? ibkrFxToBase(tickerCurrencies[ysym], ccyFx) : null;
    return (yrate !== null) ? qty * liveP.price * yrate : (p.position_value || 0) * fx;
}

/**
 * Markt-Exposure einer Position in Base (signiert: long > 0, short < 0).
 * Futures: Notional = Menge × MarkPrice × Multiplier × FX (gehebelt, nicht der Kontowert).
 * Aktien & Rest: Marktwert (Live-Yahoo, sonst IBKR-Wert).
 */
function ibkrExposure(p, ccyFx) {
    if ((p.asset_class || '').toUpperCase() === 'FUT') {
        var fx   = p.fx_rate_to_base || 1.0;
        var mult = p.multiplier || 1.0;
        return (p.quantity || 0) * (p.mark_price || 0) * mult * fx;
    }
    return ibkrLiveValue(p, ccyFx);
}

function renderPortfolioReport() {
    var el = document.getElementById('portfolioReport');
    if (!el) return;

    var cashBase = (ibkrCash || []).find(function(c) { return c.currency === 'BASE'; });
    var cashEur  = cashBase ? (cashBase.ending_cash || 0) : 0;

    // Währung→Base aus IBKRs eigenen FX-Raten (konsistent mit Positions-Bewertung)
    var ccyFx = ibkrCcyFx();

    var longG = {}, shortG = {};
    (ibkrPositions || []).forEach(function(p) {
        var fx  = p.fx_rate_to_base || 1.0;
        var qty = p.quantity || 0;
        var cb  = (p.cost_basis_money || 0) * fx;
        var cls = (p.asset_class || 'OTHER').toUpperCase();
        // Aktueller Wert mit Live-Yahoo-Kurs (sonst IBKR-Wert) — siehe ibkrLiveValue.
        // Futures: voller Kontraktwert (Notional) zählt mit ins Depot (Steuer = Differenzausgleich,
        // das ist die andere Sichtweise, separat im Steuer-Report).
        var pv  = ibkrLiveValue(p, ccyFx);
        var grp = qty >= 0 ? longG : shortG;
        if (!grp[cls]) grp[cls] = { value: 0, cost: 0, pnl: 0, count: 0 };
        grp[cls].value += pv;
        grp[cls].cost  += cb;
        grp[cls].pnl   += pv - cb;
        grp[cls].count++;
    });

    // Markt-Exposure (inkl. Futures-Notional, signiert: long > 0 / short < 0)
    var longExp = 0, shortExp = 0, futGross = 0;
    (ibkrPositions || []).forEach(function(p) {
        var e = ibkrExposure(p, ccyFx);
        if (e >= 0) longExp += e; else shortExp += e;
        if ((p.asset_class || '').toUpperCase() === 'FUT') futGross += Math.abs(e);
    });
    var netExp   = longExp + shortExp;    // shortExp ist negativ

    var sumV = function(g) { return Object.values(g).reduce(function(s, x) { return s + x.value; }, 0); };
    var sumP = function(g) { return Object.values(g).reduce(function(s, x) { return s + x.pnl;   }, 0); };
    var longValue    = sumV(longG);
    var longPnl      = sumP(longG);
    var shortValue   = sumV(shortG);
    var shortPnl     = sumP(shortG);
    var longWithCash = longValue + cashEur;
    var netTotal     = longWithCash + shortValue;
    var netPnl       = longPnl + shortPnl;

    var fmt = function(v) { return Math.round(v).toLocaleString('de-DE') + ' €'; };
    var pf  = function(v) { return (v >= 0 ? '+' : '') + Math.round(v).toLocaleString('de-DE') + ' €'; };
    var gc  = function(v) { return v >= 0 ? 'var(--green)' : 'var(--red)'; };

    var h = '<table class="pr-table"><colgroup><col style="width:55%"><col style="width:25%"><col style="width:20%"></colgroup><tbody>';

    // LONG
    h += '<tr class="pr-section"><td colspan="3">LONG</td></tr>';
    if (cashEur !== 0 || !Object.keys(longG).length) {
        h += '<tr class="pr-row"><td>Cash</td>'
            + '<td style="color:' + gc(cashEur) + '">' + fmt(cashEur) + '</td><td>—</td></tr>';
    }
    Object.keys(longG).sort().forEach(function(cls) {
        var g = longG[cls];
        h += '<tr class="pr-row"><td>' + cls + '</td>'
            + '<td>' + fmt(g.value) + '</td>'
            + '<td style="color:' + gc(g.pnl) + '">' + pf(g.pnl) + '</td></tr>';
    });
    h += '<tr class="pr-subtotal"><td>Long + Cash</td>'
        + '<td style="color:' + gc(longWithCash) + '">' + fmt(longWithCash) + '</td>'
        + '<td style="color:' + gc(longPnl) + '">' + pf(longPnl) + '</td></tr>';

    // SHORT
    if (Object.keys(shortG).length > 0) {
        h += '<tr class="pr-section"><td colspan="3">SHORT (Hedge)</td></tr>';
        Object.keys(shortG).sort().forEach(function(cls) {
            var g = shortG[cls];
            h += '<tr class="pr-row"><td>' + cls + '</td>'
                + '<td style="color:var(--red)">' + fmt(g.value) + '</td>'
                + '<td style="color:' + gc(g.pnl) + '">' + pf(g.pnl) + '</td></tr>';
        });
        h += '<tr class="pr-subtotal"><td>Short Gesamt</td>'
            + '<td style="color:var(--red)">' + fmt(shortValue) + '</td>'
            + '<td style="color:' + gc(shortPnl) + '">' + pf(shortPnl) + '</td></tr>';
    }

    // NET
    h += '<tr class="pr-total"><td>NET Gesamt</td>'
        + '<td style="color:' + gc(netTotal) + '">' + fmt(netTotal) + '</td>'
        + '<td style="color:' + gc(netPnl) + '">' + pf(netPnl) + '</td></tr>';

    // EXPOSURE — Marktwirkung inkl. Futures-Notional (€-Beträge, ohne Prozente)
    h += '<tr class="pr-section"><td colspan="3">EXPOSURE (inkl. Futures)</td></tr>';
    h += '<tr class="pr-row"><td>Long</td><td>' + fmt(longExp) + '</td><td></td></tr>';
    if (shortExp !== 0) {
        h += '<tr class="pr-row"><td>Short</td><td style="color:var(--red)">' + fmt(shortExp) + '</td><td></td></tr>';
    }
    if (futGross !== 0) {
        h += '<tr class="pr-row"><td style="padding-left:14px;color:var(--muted)">davon Futures</td>'
            + '<td style="color:var(--muted)">' + fmt(futGross) + '</td><td></td></tr>';
    }
    h += '<tr class="pr-subtotal"><td>Netto Exposure</td>'
        + '<td style="color:' + gc(netExp) + '">' + fmt(netExp) + '</td><td></td></tr>';

    if ((ibkrPositions || []).some(function(p) { return p.provisional; })) {
        h += '<tr><td colspan="3" style="color:var(--accent);font-size:9px;padding:5px 6px 0">'
            + '• Positionen enthalten heutige Trades (vorläufig, bis IBKR-Abrechnung T+1)</td></tr>';
    }

    h += '</tbody></table>';
    el.innerHTML = h;
}

// ── Sortierung der Positionstabelle ──────────────────────────────────────────
// col = null → Original-Reihenfolge (Backend: nach Symbol). dir: 1 aufsteigend, -1 absteigend.
var ibkrSort = { col: null, dir: 1 };

// Sortierschlüssel einer Position für eine Spalte (Strings für Text, Zahlen für Werte).
function ibkrSortKey(p, col, ccyFx) {
    var fx = p.fx_rate_to_base || 1.0;
    var cost = (p.cost_basis_money || 0) * fx;
    switch (col) {
        case 'ticker': return (ibkrPosYahoo(p) || p.symbol || '').toUpperCase();
        case 'class':  return (p.asset_class || '').toUpperCase();
        case 'sector':   return (ibkrPosSector(p)   || '￿').toUpperCase(); // ohne Sektor ans Ende
        case 'industry': return (ibkrPosIndustry(p) || '￿').toUpperCase(); // ohne Subsektor ans Ende
        case 'qty':    return p.quantity || 0;
        case 'cost':   return cost;
        case 'value':  return ibkrLiveValue(p, ccyFx);
        case 'pnl':    return ibkrLiveValue(p, ccyFx) - cost;
        case 'pnlpct': return cost ? (ibkrLiveValue(p, ccyFx) - cost) / Math.abs(cost) * 100 : 0;
        default:       return 0;
    }
}

// Liefert die Anzeige-Reihenfolge als Original-Indizes (stabil, data-idx bleibt gültig).
function ibkrSortedOrder(ccyFx) {
    var order = (ibkrPositions || []).map(function(_, i) { return i; });
    if (!ibkrSort.col) return order;
    order.sort(function(a, b) {
        var ka = ibkrSortKey(ibkrPositions[a], ibkrSort.col, ccyFx);
        var kb = ibkrSortKey(ibkrPositions[b], ibkrSort.col, ccyFx);
        if (ka < kb) return -ibkrSort.dir;
        if (ka > kb) return  ibkrSort.dir;
        return a - b;   // stabil bei Gleichstand
    });
    return order;
}

// Klick auf einen Spaltenkopf: gleiche Spalte → Richtung umkehren, sonst sinnvolle Startrichtung.
function ibkrSortBy(col) {
    if (ibkrSort.col === col) {
        ibkrSort.dir = -ibkrSort.dir;
    } else {
        ibkrSort.col = col;
        ibkrSort.dir = (col === 'ticker' || col === 'class' || col === 'sector') ? 1 : -1;  // Text A→Z, Zahlen groß→klein
    }
    ibkrRenderTable();
}

function ibkrRenderTable() {
    var tbody = document.getElementById('ibkrBody');
    var tfoot = document.getElementById('ibkrFoot');
    if (!tbody) return;
    var esc = function(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };

    var cashItems = (ibkrCash || []).filter(function(c) { return c.currency !== 'BASE'; });
    var cashBase  = (ibkrCash || []).find(function(c)   { return c.currency === 'BASE'; });
    var hasPosns  = ibkrPositions && ibkrPositions.length > 0;
    var hasCash   = cashItems.length > 0;

    if (!hasPosns && !hasCash) {
        tbody.innerHTML = '<tr><td colspan="10" style="padding:16px;color:var(--muted);text-align:center;">Keine Positionen — Sync drücken oder IBKR konfigurieren (⚙ Einst.)</td></tr>';
        if (tfoot) tfoot.innerHTML = '';
        return;
    }

    var sectionHdr = function(label) {
        return '<tr style="background:var(--surface);">'
            + '<td colspan="10" style="font-weight:700;font-size:9px;text-transform:uppercase;'
            + 'letter-spacing:.06em;color:var(--muted);padding:3px 6px;">' + label + '</td></tr>';
    };

    var html = '', totalValueEur = 0, totalCostEur = 0, totalPnlEur = 0;

    // ── Positionen ─────────────────────────────────────────────
    if (hasPosns) {
        html += sectionHdr('Positionen');
        var ccyFx = ibkrCcyFx();
        ibkrSortedOrder(ccyFx).forEach(function(idx) {
            var p        = ibkrPositions[idx];
            var fx       = p.fx_rate_to_base || 1.0;
            var cbmEur   = (p.cost_basis_money || 0) * fx;   // Einstand aus IBKR
            var pvEur    = ibkrLiveValue(p, ccyFx);          // aktueller Wert / Notional (Futures: voller Kontraktwert)
            var pnlEur   = pvEur - cbmEur;
            var pnlPct   = cbmEur ? pnlEur / Math.abs(cbmEur) * 100 : 0;
            totalValueEur += pvEur;
            totalCostEur  += cbmEur;
            totalPnlEur   += pnlEur;
            var pColor = pnlEur >= 0 ? '#2d8a4e' : '#c0392b';
            var qty    = p.quantity || 0;
            var yahooSym = (p.isin && ibkrIsinMap[p.isin]) || p.yahoo_symbol || '';
            var symHtml = '<span style="font-weight:500;cursor:pointer" title="Yahoo-Symbol setzen" onclick="ibkrEditSymbol(\'' + p.symbol + '\',this)">'
                + p.symbol + (yahooSym && yahooSym !== p.symbol ? ' <span style="color:var(--accent);font-size:10px">→' + yahooSym + '</span>' : ' <span style="color:var(--muted);font-size:10px">✎</span>')
                + '</span>';
            var provBadge = p.provisional ? ' <span title="inkl. heutiger Trades (vorläufig, bis T+1-Abrechnung)" style="font-size:9px;color:var(--accent);font-weight:700">•heute</span>' : '';
            var cls    = (p.asset_class || '').toUpperCase();
            var secTd;
            if (cls === 'STK' && qty > 0) {
                var sec = ibkrPosSector(p);
                if (sec) {
                    secTd = '<span style="display:inline-block;width:8px;height:8px;border-radius:2px;'
                        + 'background:' + ibkrSectorColor(sec) + ';margin-right:5px;vertical-align:middle"></span>' + esc(sec);
                } else if (ibkrPosYahoo(p) in ibkrSectors) {
                    secTd = '<span style="color:var(--muted)">—</span>';        // Aktie ohne Sektor-Angabe
                } else {
                    secTd = '<span style="color:var(--muted)">…</span>';        // wird noch geladen
                }
            } else {
                secTd = '<span style="color:var(--muted)">—</span>';            // ETF/Future/Cash: kein Sektor
            }
            var indTd;
            if (cls === 'STK' && qty > 0) {
                var ind = ibkrPosIndustry(p);
                if (ind) indTd = esc(ind);
                else if (ibkrPosYahoo(p) in ibkrIndustries) indTd = '<span style="color:var(--muted)">—</span>';
                else indTd = '<span style="color:var(--muted)">…</span>';       // wird noch geladen
            } else {
                indTd = '<span style="color:var(--muted)">—</span>';            // ETF/Future/Cash: kein Subsektor
            }
            html += '<tr>'
                + '<td style="text-align:center"><input type="checkbox" class="ibkr-sel" data-idx="' + idx + '" onclick="ibkrSyncSelAll()"></td>'
                + '<td>' + symHtml + provBadge + '</td>'
                + '<td style="color:var(--muted)">' + (p.asset_class || '-') + '</td>'
                + '<td style="color:var(--muted);font-size:10px">' + secTd + '</td>'
                + '<td style="color:var(--muted);font-size:10px">' + indTd + '</td>'
                + '<td>' + (qty % 1 !== 0 ? qty.toFixed(4) : qty) + '</td>'
                + '<td>' + cbmEur.toFixed(0) + '</td>'
                + '<td>' + pvEur.toFixed(0) + '</td>'
                + '<td style="color:' + pColor + '">' + (pnlEur >= 0 ? '+' : '') + pnlEur.toFixed(0) + '</td>'
                + '<td style="color:' + pColor + '">' + (pnlPct >= 0 ? '+' : '') + pnlPct.toFixed(2)  + '%</td>'
                + '</tr>';
        });
    }

    // ── Cash ────────────────────────────────────────────────────
    if (hasCash) {
        html += sectionHdr('Cash');
        cashItems.forEach(function(c) {
            var amt = c.ending_cash || 0;
            var amtColor = amt >= 0 ? 'var(--text)' : '#c0392b';
            html += '<tr>'
                + '<td></td>'
                + '<td style="font-weight:500">' + c.currency + '</td>'
                + '<td style="color:var(--muted)">Cash</td>'
                + '<td style="color:var(--muted)">—</td>'
                + '<td style="color:var(--muted)">—</td>'
                + '<td>—</td><td>—</td>'
                + '<td style="color:' + amtColor + '">' + amt.toFixed(2) + '</td>'
                + '<td>—</td><td>—</td>'
                + '</tr>';
        });
    }

    tbody.innerHTML = html;

    // ── Footer ──────────────────────────────────────────────────
    var footHtml = '';
    if (hasPosns && totalValueEur !== 0) {
        var tPnlPctEur = totalCostEur ? totalPnlEur / Math.abs(totalCostEur) * 100 : 0;
        var tc = totalPnlEur >= 0 ? '#2d8a4e' : '#c0392b';
        footHtml += '<tr style="border-top:2px solid var(--border);background:var(--bg);">'
            + '<td></td><td style="font-weight:700">Assets</td><td></td><td></td><td></td><td></td>'
            + '<td style="font-weight:700">' + totalCostEur.toFixed(0) + ' €</td>'
            + '<td style="font-weight:700">' + totalValueEur.toFixed(0) + ' €</td>'
            + '<td style="font-weight:700;color:' + tc + '">' + (totalPnlEur >= 0 ? '+' : '') + totalPnlEur.toFixed(2) + ' €</td>'
            + '<td style="font-weight:700;color:' + tc + '">' + (tPnlPctEur  >= 0 ? '+' : '') + tPnlPctEur.toFixed(2)  + '%</td>'
            + '</tr>';
    }
    if (cashBase) {
        var cb = cashBase.ending_cash || 0;
        footHtml += '<tr style="border-top:1px solid var(--border);background:var(--bg);">'
            + '<td></td><td style="font-weight:700">Cash (Basis)</td><td colspan="5"></td>'
            + '<td style="font-weight:700">' + cb.toFixed(2) + ' €</td>'
            + '<td colspan="2"></td>'
            + '</tr>';
        if (hasPosns && totalValueEur !== 0) {
            var grandTotal = totalValueEur + cb;
            var grandPnl   = totalPnlEur;
            var grandPnlPct = (totalCostEur + cb - grandPnl) > 0
                ? grandPnl / Math.abs(totalCostEur + cb - grandPnl) * 100 : 0;
            var gc = grandTotal >= 0 ? '#2d8a4e' : '#c0392b';
            footHtml += '<tr style="border-top:2px solid var(--border);background:var(--bg);">'
                + '<td></td><td style="font-weight:700;font-size:11px;">SUMME</td><td colspan="4"></td>'
                + '<td style="font-weight:700;font-size:11px;">' + (totalCostEur + cb).toFixed(0) + ' €</td>'
                + '<td style="font-weight:700;font-size:11px;">' + grandTotal.toFixed(0) + ' €</td>'
                + '<td style="font-weight:700;font-size:11px;color:' + gc + '">' + (grandPnl >= 0 ? '+' : '') + grandPnl.toFixed(0) + ' €</td>'
                + '<td style="font-weight:700;font-size:11px;color:' + gc + '">' + (grandPnlPct >= 0 ? '+' : '') + grandPnlPct.toFixed(2) + '%</td>'
                + '</tr>';
        }
    }
    if (tfoot) tfoot.innerHTML = footHtml;

    var syncEl = document.getElementById('ibkrLastSync');
    if (syncEl && ibkrLastSync) {
        syncEl.textContent = ibkrLastSync.slice(0, 16).replace('T', ' ') + ' UTC';
    }
    renderPortfolioReport();
    ibkrRenderCoverage();
    ibkrRenderSectorAllocation();

    // Sortier-Pfeile in den Spaltenköpfen aktualisieren
    document.querySelectorAll('th.ibkr-sort').forEach(function(th) {
        var ind = th.querySelector('.sort-ind');
        if (!ind) return;
        ind.textContent = (th.getAttribute('data-col') === ibkrSort.col) ? (ibkrSort.dir > 0 ? ' ▲' : ' ▼') : '';
    });
}

// ╔══════════════════════════════════════════════════════════╗
// ║ 12b. SEKTOR-ALLOKATION (nur Aktien, aktueller Wert)        ║
// ╚══════════════════════════════════════════════════════════╝

// GICS-Sektorname (Yahoo/Finviz) → CSS-Slug. Farben stehen in desktop.css als
// --sec-<slug> (hell/dunkel via [data-theme]). Yahoo liefert "Financial Services"
// und "Technology"; Finviz "Financial" — beide werden abgebildet.
var IBKR_SECTOR_SLUG = {
    'Technology':             'technology',
    'Financial Services':     'financial',
    'Financial':              'financial',
    'Healthcare':             'healthcare',
    'Consumer Cyclical':      'consumer-cyclical',
    'Communication Services': 'communication',
    'Energy':                 'energy',
    'Industrials':            'industrials',
    'Consumer Defensive':     'consumer-defensive',
    'Basic Materials':        'basic-materials',
    'Real Estate':            'real-estate',
    'Utilities':              'utilities',
};

// Theme-reaktive Farbe je Sektor (gibt die CSS-Variable zurück, nicht den Hex-Wert).
function ibkrSectorColor(sector) {
    var slug = IBKR_SECTOR_SLUG[sector];
    return slug ? 'var(--sec-' + slug + ')' : 'var(--muted)';
}

// Summiert den aktuellen EUR-Wert je Sektor über die Aktien-Positionen (STK, qty>0).
// ETFs/Futures/Cash bleiben außen vor. Aktien ohne Sektor-Angabe → "Unbekannt".
function ibkrSectorAlloc() {
    var ccyFx = ibkrCcyFx();
    var bySec = {}, total = 0;
    (ibkrPositions || []).forEach(function(p) {
        if ((p.asset_class || '').toUpperCase() !== 'STK') return;
        if ((p.quantity || 0) <= 0) return;
        var val = ibkrLiveValue(p, ccyFx);
        if (!(val > 0)) return;
        var sec = ibkrPosSector(p) || 'Unbekannt';
        bySec[sec] = (bySec[sec] || 0) + val;
        total += val;
    });
    return { bySec: bySec, total: total };
}

// Rendert Donut-Diagramm + Legende der Sektor-Allokation in #ibkrSectorAlloc.
function ibkrRenderSectorAllocation() {
    var box = document.getElementById('ibkrSectorAlloc');
    if (!box) return;
    var esc = function(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
    var eur = function(v) { return Math.round(v).toLocaleString('de-DE'); };

    var a = ibkrSectorAlloc();
    if (!a.total) {
        box.innerHTML = '<div style="color:var(--muted);font-size:10px;padding:6px 2px;">Keine Aktien-Positionen mit Sektor — Sync drücken oder kurz warten (Sektoren werden geladen …).</div>';
        return;
    }

    var entries = Object.keys(a.bySec).map(function(s) { return { sector: s, val: a.bySec[s] }; });
    entries.sort(function(x, y) { return y.val - x.val; });
    // Mehr als 8 Segmente → kleinste zu "Sonstige" zusammenfassen (Lesbarkeit/Palette).
    if (entries.length > 8) {
        var head = entries.slice(0, 7);
        var restVal = entries.slice(7).reduce(function(s, e) { return s + e.val; }, 0);
        head.push({ sector: 'Sonstige', val: restVal, _other: true });
        entries = head;
    }

    var colOf = function(e) {
        return (e._other || e.sector === 'Unbekannt') ? 'var(--muted)' : ibkrSectorColor(e.sector);
    };

    // Donut über gestapelte <circle> mit stroke-dasharray (rotiert, Start oben).
    var R = 54, SW = 22, r = R - SW / 2, C = 2 * Math.PI * r, off = 0, segs = '';
    entries.forEach(function(e) {
        var frac = e.val / a.total;
        var len  = frac * C;
        segs += '<circle cx="' + R + '" cy="' + R + '" r="' + r.toFixed(2) + '" fill="none" stroke-width="' + SW + '" '
            + 'style="stroke:' + colOf(e) + '" stroke-dasharray="' + len.toFixed(2) + ' ' + (C - len).toFixed(2) + '" '
            + 'stroke-dashoffset="' + (-off).toFixed(2) + '"><title>' + esc(e.sector) + ' — ' + (frac * 100).toFixed(1) + '%</title></circle>';
        off += len;
    });
    var svg = '<svg viewBox="0 0 ' + (R * 2) + ' ' + (R * 2) + '" width="116" height="116" style="transform:rotate(-90deg)">' + segs + '</svg>';

    var leg = entries.map(function(e) {
        var frac = e.val / a.total;
        return '<div class="sec-leg-row">'
            + '<span class="sec-leg-dot" style="background:' + colOf(e) + '"></span>'
            + '<span class="sec-leg-name">' + esc(e.sector) + '</span>'
            + '<span class="sec-leg-pct">' + (frac * 100).toFixed(1) + '%</span>'
            + '<span class="sec-leg-val">' + eur(e.val) + ' €</span>'
            + '</div>';
    }).join('');

    box.innerHTML = '<div class="sec-alloc-wrap">'
        + '<div class="sec-alloc-chart">'
        +   '<div style="position:relative;width:116px;height:116px;">' + svg
        +     '<div class="sec-alloc-center">' + eur(a.total) + ' €<span>Aktien</span></div>'
        +   '</div>'
        + '</div>'
        + '<div class="sec-alloc-legend">' + leg + '</div>'
        + '</div>';
}

async function ibkrSync() {
    var btn = document.getElementById('ibkrSyncBtn');
    if (btn) { btn.textContent = '...'; btn.disabled = true; }
    try {
        var result = await ibkrDoSync();
        if (result.ok) {
            ibkrLastSync = result.last_sync;
            await ibkrLoadIsinMap();
            await ibkrLoadPositions();
            await ibkrLoadCash();
            await ibkrLoadTrades();
            // IBKR-verwaltete Baskets komplett neu aufbauen; zusätzlich in allen übrigen
            // Baskets die Stückzahlen der Depot-Aktien angleichen.
            var rebuilt       = ibkrRebuildManagedBaskets();
            var rebuiltFormer = ibkrRebuildFormerBaskets();
            var qtyChangedIds = ibkrSyncBasketQuantities();
            var changed       = rebuilt || rebuiltFormer || qtyChangedIds.length > 0;
            if (changed) {
                await saveBasketsToServer();
                renderBasketSelect();
            }
            // Aktuellen Basket nur dann neu laden (Kurse/Index/Marker), wenn er selbst
            // betroffen ist — sonst reicht ein Auffrischen der IBKR-Tabelle.
            var curB          = baskets[currentBasket];
            var curAffected   = false;
            if (curB) {
                if (curB.ibkrManaged)     curAffected = rebuilt;
                else if (curB.ibkrFormer) curAffected = rebuiltFormer;
                else                      curAffected = qtyChangedIds.indexOf(currentBasket) !== -1;
            }
            if (changed && curAffected) {
                ibkrSyncWeightsIfCurrent(currentBasket);   // Rebuild/Angleich-Weights übernehmen, nicht zurücksetzen
                await switchBasket(currentBasket);   // lädt Kurse/Index/Tabelle/Marker neu
            } else {
                ibkrRenderTable();
                refreshIbkrCostLine(_lastCandles);
                renderPerfTable();
                ibkrRenderTrades();
                refreshTradeMarkers();
            }
            ibkrLoadSectors().then(function() { ibkrRenderTable(); });
        } else {
            alert('IBKR Sync Fehler: ' + (result.error || 'Unbekannter Fehler'));
        }
    } catch(e) {
        alert('Verbindungsfehler: ' + e.message);
    } finally {
        if (btn) { btn.textContent = '↻ Sync'; btn.disabled = false; }
    }
}

// Nach externem Ersetzen von baskets[id].weights die Anzeige-Weights (globales WEIGHTS)
// mitziehen — sonst überschreibt switchBasket()'s saveCurrentBasketState() die frisch
// gesetzten Weights sofort wieder mit dem alten Anzeige-Stand ("überschreiben ändert nichts").
function ibkrSyncWeightsIfCurrent(id) {
    if (id === currentBasket && baskets[id]) WEIGHTS = Object.assign({}, baskets[id].weights || {});
}

async function ibkrCreateBasket() {
    var weights = {};
    (ibkrPositions || []).forEach(function(p) {
        var cls = (p.asset_class || '').toUpperCase();
        var qty = p.quantity || 0;
        if (cls === 'STK' && qty > 0) {
            var sym = ibkrPosYahoo(p);   // ISIN-Mapping → korrekte Notierung (z.B. ASML.AS)
            if (sym) weights[sym] = Math.abs(qty);
        } else if (cls === 'FUT' && qty !== 0) {
            // Future → fortlaufender Yahoo-Kontrakt (Underlying + "=F", z.B. MNQU6 → MNQ=F).
            // Gewicht = Kontrakte × Multiplier, Vorzeichen = Richtung (short → negativ = Hedge).
            var fsym = p.yahoo_symbol || ((p.symbol || '').replace(/[FGHJKMNQUVXZ]\d{1,2}$/, '') + '=F');
            if (fsym && fsym !== '=F') weights[fsym] = qty * (p.multiplier || 1);
        }
    });
    if (Object.keys(weights).length === 0) { alert('Keine geeigneten Positionen (Long-Aktien / Futures) gefunden.'); return; }

    // Existiert schon ein IBKR-Basket? → überschreiben oder neu anlegen lassen
    var managed = Object.keys(baskets).filter(function(id) { return baskets[id] && baskets[id].ibkrManaged; });
    if (managed.length) {
        var ov = confirm('Es gibt bereits einen IBKR-Basket ("' + baskets[managed[0]].name + '").\n\n'
            + 'OK = überschreiben\nAbbrechen = neuen Basket anlegen');
        if (ov) {
            baskets[managed[0]].weights = weights;
            ibkrSyncWeightsIfCurrent(managed[0]);   // sonst setzt switchBasket() die neuen Weights wieder zurück
            await saveBasketsToServer();
            await switchBasket(managed[0]);
            return;
        }
    }
    var name = prompt('Name des neuen Baskets:', 'IBKR Positionen');
    if (!name) return;
    var id = 'basket_' + Date.now();
    baskets[id] = {
        name: name, weights: weights, period: 180, tf: '1D', ibkrManaged: true,
        perfSinceDate: '', indicators: { ma50: false, ma200: false, reg: false }, logScale: false
    };
    await saveBasketsToServer();
    await switchBasket(id);
}

// Watchlist-Basket "Ehemalige Positionen": alle je gehandelten Aktien (aus den
// IBKR-Trades), die NICHT mehr im aktuellen Depot liegen — um Aktien im Blick zu
// behalten, obwohl man sie verkauft hat. Wird als ibkrFormer markiert und beim
// nächsten Sync automatisch neu abgeglichen (siehe ibkrRebuildFormerBaskets).
async function ibkrCreateFormerBasket() {
    if (!ibkrTrades || !ibkrTrades.length) {
        alert('Keine IBKR-Trades geladen — zuerst Sync mit konfigurierter Trades-Query (⚙ Einst.).');
        return;
    }
    var weights = ibkrFormerWeights();
    if (Object.keys(weights).length === 0) {
        alert('Keine ehemaligen Aktien gefunden — alle je gehandelten Aktien liegen aktuell im Depot.');
        return;
    }
    // Existiert schon ein Ehemalige-Basket? → überschreiben oder neu anlegen lassen
    var former = Object.keys(baskets).filter(function(id) { return baskets[id] && baskets[id].ibkrFormer; });
    if (former.length) {
        var ov = confirm('Es gibt bereits einen Ehemalige-Positionen-Basket ("' + baskets[former[0]].name + '").\n\n'
            + 'OK = überschreiben\nAbbrechen = neuen Basket anlegen');
        if (ov) {
            baskets[former[0]].weights = weights;
            ibkrSyncWeightsIfCurrent(former[0]);   // sonst setzt switchBasket() die neuen Weights wieder zurück
            await saveBasketsToServer();
            await switchBasket(former[0]);
            return;
        }
    }
    var name = prompt('Name des neuen Baskets:', 'Ehemalige Positionen');
    if (!name) return;
    var id = 'basket_' + Date.now();
    baskets[id] = {
        name: name, weights: weights, period: 180, tf: '1D', ibkrFormer: true,
        perfSinceDate: '', indicators: { ma50: false, ma200: false, reg: false }, logScale: false
    };
    await saveBasketsToServer();
    await switchBasket(id);
}

// Legt je Sektor einen Basket aus den Long-Aktien-Positionen an (Depot-Stückzahlen
// als Gewichte). Name: "IBKR {Sektor}". Gleichnamige Baskets werden aktualisiert.
// Nicht ibkrManaged — sonst würden sie beim Sync auf alle Positionen zurückgesetzt.
async function ibkrCreateSectorBaskets() {
    // Sektoren ggf. erst nachladen (falls Seite frisch und noch nicht gefüllt).
    if (!Object.keys(ibkrSectors).length) {
        await ibkrLoadSectors();
        ibkrRenderTable();
    }
    var bySector = {};
    (ibkrPositions || []).forEach(function(p) {
        if ((p.asset_class || '').toUpperCase() !== 'STK') return;
        var qty = p.quantity || 0;
        if (qty <= 0) return;
        var sym = ibkrPosYahoo(p);
        if (!sym) return;
        var sec = ibkrPosSector(p) || 'Unbekannt';
        (bySector[sec] = bySector[sec] || {})[sym] = Math.abs(qty);
    });
    var sectors = Object.keys(bySector);
    if (!sectors.length) { alert('Keine Long-Aktien-Positionen gefunden.'); return; }

    // Bestehende Baskets nach Name indexieren (für Overwrite).
    var byName = {};
    Object.keys(baskets).forEach(function(id) {
        if (baskets[id] && baskets[id].name) byName[baskets[id].name] = id;
    });

    var created = 0, updated = 0, firstId = null;
    sectors.sort().forEach(function(sec, i) {
        var name = 'IBKR ' + sec;
        var weights = bySector[sec];
        var existingId = byName[name];
        if (existingId) {
            baskets[existingId].weights = weights;
            updated++;
            if (!firstId) firstId = existingId;
        } else {
            var id = 'basket_' + (Date.now() + i);   // +i = Kollisionen vermeiden
            baskets[id] = {
                name: name, weights: weights, period: 180, tf: '1D',
                perfSinceDate: '', indicators: { ma50: false, ma200: false, reg: false }, logScale: false
            };
            created++;
            if (!firstId) firstId = id;
        }
    });

    await saveBasketsToServer();
    if (typeof renderBasketSelect === 'function') renderBasketSelect();
    var parts = [];
    if (created) parts.push(created + ' neu');
    if (updated) parts.push(updated + ' aktualisiert');
    alert('Sektor-Baskets: ' + parts.join(', ') + ' (' + sectors.length + ' Sektoren).');
    if (firstId) { ibkrSyncWeightsIfCurrent(firstId); await switchBasket(firstId); }
}

// Header-Checkbox: alle Positions-Checkboxen an-/abwählen.
function ibkrToggleSelAll(cb) {
    document.querySelectorAll('#ibkrBody input.ibkr-sel').forEach(function(box) {
        box.checked = cb.checked;
    });
}

// Hält die Header-Checkbox im Einklang mit den Zeilen (checked nur wenn alle an).
function ibkrSyncSelAll() {
    var all = document.querySelectorAll('#ibkrBody input.ibkr-sel');
    var sel = document.querySelectorAll('#ibkrBody input.ibkr-sel:checked');
    var head = document.getElementById('ibkrSelAll');
    if (!head) return;
    head.checked       = all.length > 0 && sel.length === all.length;
    head.indeterminate = sel.length > 0 && sel.length < all.length;
}

// Prüft, welche Long-Aktien aus IBKR in keinem Basket einsortiert sind.
function ibkrRenderCoverage() {
    var el = document.getElementById('ibkrCoverage');
    if (!el) return;
    // Alle Symbole über alle Baskets sammeln (case-insensitiver Vergleich).
    var covered = {};
    Object.keys(baskets).forEach(function(id) {
        var w = baskets[id] && baskets[id].weights;
        if (w) Object.keys(w).forEach(function(sym) { covered[sym.toUpperCase()] = true; });
    });
    var missing = [], stkCount = 0;
    (ibkrPositions || []).forEach(function(p, idx) {
        if ((p.asset_class || '').toUpperCase() !== 'STK') return;
        if ((p.quantity || 0) <= 0) return;
        stkCount++;
        var sym = ibkrPosYahoo(p);
        if (!sym || !covered[sym.toUpperCase()]) missing.push({ idx: idx, sym: sym || p.symbol });
    });
    el._missing = missing;
    if (stkCount === 0) { el.innerHTML = ''; el.style.background = ''; return; }
    if (missing.length === 0) {
        el.style.background = 'rgba(45,138,78,.12)';
        el.style.color      = '#2d8a4e';
        el.innerHTML = '✓ Alle ' + stkCount + ' Aktien sind in Baskets einsortiert.';
    } else {
        el.style.background = 'rgba(192,57,43,.12)';
        el.style.color      = '#c0392b';
        var names = missing.map(function(m) { return m.sym; }).join(', ');
        el.innerHTML = '⚠ ' + missing.length + ' von ' + stkCount + ' Aktien in keinem Basket: '
            + '<b>' + names + '</b> '
            + '<a href="#" onclick="ibkrSelectMissing();return false;" style="color:inherit;text-decoration:underline;margin-left:4px;">→ markieren</a>';
    }
}

// Hakt genau die nicht einsortierten Aktien an (für "+ Basket aus Auswahl").
function ibkrSelectMissing() {
    var el = document.getElementById('ibkrCoverage');
    var missing = el && el._missing;
    if (!missing || !missing.length) return;
    var want = {};
    missing.forEach(function(m) { want[m.idx] = true; });
    document.querySelectorAll('#ibkrBody input.ibkr-sel').forEach(function(box) {
        box.checked = !!want[parseInt(box.getAttribute('data-idx'), 10)];
    });
    ibkrSyncSelAll();
}

// Erstellt einen Basket aus den angehakten Positionen.
async function ibkrCreateBasketFromSelection() {
    var boxes = document.querySelectorAll('#ibkrBody input.ibkr-sel:checked');
    if (!boxes.length) { alert('Keine Positionen ausgewählt.'); return; }
    var weights = {};
    boxes.forEach(function(box) {
        var p = (ibkrPositions || [])[parseInt(box.getAttribute('data-idx'), 10)];
        if (!p) return;
        var cls = (p.asset_class || '').toUpperCase();
        var qty = p.quantity || 0;
        if (cls === 'STK' && qty > 0) {
            var sym = ibkrPosYahoo(p);   // ISIN-Mapping → korrekte Notierung (z.B. ASML.AS)
            if (sym) weights[sym] = Math.abs(qty);
        } else if (cls === 'FUT' && qty !== 0) {
            var fsym = p.yahoo_symbol || ((p.symbol || '').replace(/[FGHJKMNQUVXZ]\d{1,2}$/, '') + '=F');
            if (fsym && fsym !== '=F') weights[fsym] = qty * (p.multiplier || 1);
        }
    });
    if (Object.keys(weights).length === 0) { alert('Auswahl enthält keine geeigneten Positionen (Long-Aktien / Futures).'); return; }
    var name = prompt('Name des neuen Baskets:', 'IBKR Auswahl');
    if (!name) return;
    var id = 'basket_' + Date.now();
    baskets[id] = {
        name: name, weights: weights, period: 180, tf: '1D', ibkrManaged: false,
        perfSinceDate: '', indicators: { ma50: false, ma200: false, reg: false }, logScale: false
    };
    await saveBasketsToServer();
    await switchBasket(id);
}

// Gleicht alle als IBKR-verwaltet markierten Baskets an den aktuellen
// Positions-Bestand an (Ticker via ISIN-Mapping, Menge = aktuelle Stückzahl).
function ibkrRebuildManagedBaskets() {
    var changed = false;
    Object.keys(baskets).forEach(function(id) {
        if (!baskets[id] || !baskets[id].ibkrManaged) return;
        var w = {};
        (ibkrPositions || []).forEach(function(p) {
            var cls = (p.asset_class || '').toUpperCase();
            var qty = p.quantity || 0;
            if (cls === 'STK' && qty > 0) {
                var sym = ibkrPosYahoo(p);
                if (sym) w[sym] = Math.abs(qty);
            } else if (cls === 'FUT' && qty !== 0) {
                var fsym = p.yahoo_symbol || ((p.symbol || '').replace(/[FGHJKMNQUVXZ]\d{1,2}$/, '') + '=F');
                if (fsym && fsym !== '=F') w[fsym] = qty * (p.multiplier || 1);
            }
        });
        baskets[id].weights = w;
        changed = true;
    });
    return changed;
}

// Weights für den "Ehemalige Positionen"-Basket: alle je gehandelten Aktien (STK
// aus den IBKR-Trades) außer den aktuell im Depot gehaltenen. Gewicht = 1 je Ticker
// (Watchlist-Charakter — für geschlossene Positionen gibt es keine Stückzahl).
// Yahoo-Symbol via ISIN-Mapping (ibkrTradeYahoo), damit auch ausländische Notierungen
// nach Symbolwechsel korrekt matchen.
function ibkrFormerWeights() {
    // Aktuell gehaltene Symbole (im Depot, qty ≠ 0) — werden ausgeschlossen.
    var held = {};
    (ibkrPositions || []).forEach(function(p) {
        if ((p.quantity || 0) === 0) return;
        var sym = ibkrPosYahoo(p);
        if (sym) held[sym.toUpperCase()] = true;
    });
    var weights = {};
    (ibkrTrades || []).forEach(function(t) {
        if ((t.asset_class || '').toUpperCase() !== 'STK') return;
        var sym = ibkrTradeYahoo(t);
        if (!sym || held[sym.toUpperCase()]) return;
        weights[sym] = 1;
    });
    return weights;
}

// Baut alle als "Ehemalige Positionen" markierten Baskets (ibkrFormer) beim Sync
// komplett neu auf. Liefert true, sobald mindestens ein solcher Basket existiert.
function ibkrRebuildFormerBaskets() {
    var changed = false;
    Object.keys(baskets).forEach(function(id) {
        if (!baskets[id] || !baskets[id].ibkrFormer) return;
        baskets[id].weights = ibkrFormerWeights();
        changed = true;
    });
    return changed;
}

// Gleicht in ALLEN (nicht IBKR-verwalteten) Baskets die Stückzahl der Aktien an den
// aktuellen IBKR-Depotbestand an — aber nur für Ticker, die im Basket UND im Depot
// liegen. Fügt nichts hinzu und entfernt nichts; ändert ausschließlich überlappende
// Gewichte. Liefert die Liste der veränderten Basket-IDs zurück.
function ibkrSyncBasketQuantities() {
    // IBKR-Aktienbestand: Yahoo-Symbol (uppercase) → Stückzahl
    var held = {};
    (ibkrPositions || []).forEach(function(p) {
        if ((p.asset_class || '').toUpperCase() !== 'STK') return;
        var qty = p.quantity || 0;
        if (qty <= 0) return;
        var sym = ibkrPosYahoo(p);
        if (sym) held[sym.toUpperCase()] = Math.abs(qty);
    });
    var changedIds = [];
    if (!Object.keys(held).length) return changedIds;

    Object.keys(baskets).forEach(function(id) {
        var b = baskets[id];
        if (!b || b.ibkrManaged || b.ibkrFormer) return;   // verwaltete/Ehemalige Baskets werden separat komplett neu aufgebaut
        var w = b.weights || {};
        var localChanged = false;
        Object.keys(w).forEach(function(sym) {
            var q = held[sym.toUpperCase()];
            if (q !== undefined && w[sym] !== q) {
                w[sym] = q;
                localChanged = true;
            }
        });
        if (localChanged) changedIds.push(id);
    });
    return changedIds;
}

async function ibkrEditSymbol(ibkrSym, el) {
    var p = ibkrPositions.find(function(x) { return x.symbol === ibkrSym; }) || {};
    var isin = p.isin || '';
    if (!isin) { alert('Keine ISIN für "' + ibkrSym + '" hinterlegt — Mapping nur per ISIN möglich.'); return; }
    var current = ibkrIsinMap[isin] || p.yahoo_symbol || '';
    // Auto-Vorschlag via Yahoo-Suche nach ISIN, falls noch kein Mapping existiert
    if (!current) {
        try {
            var rr   = await fetch('/api/ibkr/isin-resolve/' + encodeURIComponent(isin));
            var hits = await rr.json();
            if (hits && hits.length) current = hits[0].symbol;
        } catch(e) {}
    }
    var newSym = prompt('Yahoo-Symbol für "' + ibkrSym + '"\n(ISIN ' + isin + ', leer = kein Mapping):', current);
    if (newSym === null) return;
    newSym = newSym.trim().toUpperCase();
    try {
        await ibkrSaveIsinMap(isin, newSym || null, null);
        await ibkrLoadIsinMap();
        await ibkrLoadPositions();
        ibkrRenderTable();
        refreshIbkrCostLine(_lastCandles);
        refreshTradeMarkers();
        renderPerfTable();
    } catch(e) {
        alert('Fehler beim Speichern: ' + e.message);
    }
}

function ibkrRenderTrades() {
    var tbody = document.getElementById('ibkrTradesBody');
    if (!tbody) return;
    if (!ibkrTrades || ibkrTrades.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" style="padding:10px;color:var(--muted);text-align:center;">Keine Trades — Flex-Query muss TRNT-Sektion enthalten</td></tr>';
        return;
    }
    var html = '';
    var shownTrades = ibkrTrades.filter(function(t) {
        var c = (t.asset_class || '').toUpperCase();
        return c === 'STK' || c === 'FUT';
    });
    if (shownTrades.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" style="padding:10px;color:var(--muted);text-align:center;">Keine Trades — Sync durchführen</td></tr>';
        return;
    }
    shownTrades.forEach(function(t) {
        var fx      = t.fx_rate || 1;
        var valEur  = Math.abs(t.value || 0) * fx;
        var comEur  = Math.abs(t.commission || 0) * fx;
        var isBuy   = (t.action || '').toUpperCase().indexOf('BUY') >= 0;
        var actColor = isBuy ? '#2d8a4e' : '#c0392b';
        var actLabel = isBuy ? 'K' : 'V';
        var isFut    = (t.asset_class || '').toUpperCase() === 'FUT';
        html += '<tr>'
            + '<td style="color:var(--muted)">' + (t.trade_date || '').slice(0, 10) + '</td>'
            + '<td style="font-weight:500">' + (t.symbol || '') + (isFut ? ' <span style="font-size:9px;color:var(--muted);font-weight:600">FUT</span>' : '') + '</td>'
            + '<td style="color:' + actColor + ';font-weight:700;text-align:center">' + actLabel + '</td>'
            + '<td style="text-align:right">' + Math.abs(t.quantity || 0) + '</td>'
            + '<td style="text-align:right">' + (t.price || 0).toFixed(2) + '</td>'
            + '<td style="text-align:right;font-weight:500">' + valEur.toFixed(0) + ' €</td>'
            + '<td style="text-align:right;color:var(--muted)">' + comEur.toFixed(2) + ' €</td>'
            + '</tr>';
    });
    tbody.innerHTML = html;
}

function toggleTradeMarkers(btn) {
    _showTradeMarkers = !_showTradeMarkers;
    if (btn) btn.classList.toggle('active', _showTradeMarkers);
    refreshTradeMarkers();
}

function doLogout() {
    window.location.href = '/logout';
}

function ibkrExport() {
    if (!ibkrPositions || ibkrPositions.length === 0) {
        alert('Keine IBKR Positionen geladen. Bitte zuerst synchronisieren.');
        return;
    }
    var csv = ibkrBuildExportCsv();
    if (!csv) {
        alert('Kein Export möglich — kein aktiver Basket oder Portfoliowert = 0.');
        return;
    }
    var blob = new Blob([csv], { type: 'text/csv' });
    var a    = document.createElement('a');
    a.href   = URL.createObjectURL(blob);
    a.download = 'ibkr_basket_' + new Date().toISOString().slice(0, 10) + '.csv';
    a.click();
}

// Flyouts bei Klick außerhalb der Draw-Sidebar schließen
document.addEventListener('click', function(e) {
    if (!e.target.closest || !e.target.closest('.draw-sidebar')) {
        document.querySelectorAll('.draw-group').forEach(function(g) { g.classList.remove('open'); });
    }
});

// ╔══════════════════════════════════════════════════════════╗
// ║ 13. EINSTELLUNGEN (Konto + IBKR Flex Query)              ║
// ╚══════════════════════════════════════════════════════════╝

// ── Aussehen / Theme ──────────────────────────────────────────
// Setzt die data-Attribute am <html>, woraus desktop.css das Theme ableitet.
function applyAppearance() {
    var a    = appearance || {};
    var root = document.documentElement;
    root.setAttribute('data-theme',    a.theme    || 'light');
    root.setAttribute('data-contrast', a.contrast || 'normal');
    root.setAttribute('data-accent',   a.accent   || 'green');
    root.setAttribute('data-fontsize', a.fontSize || 'compact');
    applyChartTheme();
    renderAppearanceControls();
}

// Chart-Farben (Text + Gitter) an das aktuelle Theme angleichen.
function applyChartTheme() {
    if (typeof chart === 'undefined' || !chart) return;
    var cs   = getComputedStyle(document.documentElement);
    var txt  = cs.getPropertyValue('--text').trim() || '#1a1a18';
    var dark = (appearance && appearance.theme === 'dark');
    var grid = dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)';
    try {
        chart.applyOptions({
            layout: { textColor: txt },
            grid:   { vertLines: { color: grid }, horzLines: { color: grid } },
        });
    } catch (e) { /* ignore */ }
}

// Markiert in den Segmented-Controls die aktiven Werte.
function renderAppearanceControls() {
    [['ap-theme', 'theme'], ['ap-contrast', 'contrast'], ['ap-fontSize', 'fontSize'], ['ap-accent', 'accent']]
        .forEach(function(pair) {
            var grp = document.getElementById(pair[0]);
            if (!grp) return;
            var cur = (appearance && appearance[pair[1]]) || '';
            grp.querySelectorAll('.seg-btn').forEach(function(btn) {
                btn.classList.toggle('active', btn.getAttribute('data-v') === cur);
            });
        });
}

// Einstellung ändern → anwenden + pro Nutzer speichern.
async function setAppearance(key, value) {
    if (!appearance) appearance = {};
    appearance[key] = value;
    applyAppearance();
    await saveBasketsToServer();
}

/** Lädt eingeloggten User + IBKR-Konfigurationsstatus in die Settings-Seite. */
async function settingsLoad() {
    renderAppearanceControls();
    try {
        var w = await fetch('/api/whoami').then(function(r) { return r.json(); });
        var u = document.getElementById('set-user');
        if (u) u.textContent = w.user || '—';
    } catch (e) { /* ignore */ }

    try {
        var s = await fetch('/api/ibkr/config/status').then(function(r) { return r.json(); });
        var badge = document.getElementById('set-ibkr-status');
        if (badge) {
            badge.textContent = s.configured ? '✓ konfiguriert' : '✗ nicht konfiguriert';
            badge.className   = 'settings-badge ' + (s.configured ? 'ok' : 'no');
        }
        // Query-IDs vorbefüllen (nicht geheim) — Token bleibt leer
        var qf = document.getElementById('set-query-id');
        if (qf) qf.value = s.query_id || '';
        var tf = document.getElementById('set-query-id-trades');
        if (tf) tf.value = s.query_id_trades || '';
        var xf = document.getElementById('set-query-id-tax');
        if (xf) xf.value = s.query_id_tax || '';
    } catch (e) { /* ignore */ }
}

/** Speichert Flex Token + Query ID (verschlüsselt, pro User) und aktualisiert den Status. */
async function settingsSaveIbkr(btn) {
    var token  = (document.getElementById('set-flex-token').value     || '').trim();
    var qid    = (document.getElementById('set-query-id').value       || '').trim();
    var qidTr  = (document.getElementById('set-query-id-trades').value || '').trim();
    var qidTax = (document.getElementById('set-query-id-tax').value    || '').trim();
    var msg    = document.getElementById('set-ibkr-msg');
    function setMsg(text, cls) { if (msg) { msg.textContent = text; msg.className = 'settings-msg ' + (cls || ''); } }

    if (!qid) { setMsg('Query-ID (Activity) erforderlich', 'err'); return; }
    if (btn) btn.disabled = true;
    setMsg('Speichere…', '');
    try {
        var res = await ibkrSaveConfig(token, qid, qidTr, qidTax);
        if (res && res.ok) {
            setMsg('✓ Gespeichert', 'ok');
            document.getElementById('set-flex-token').value = '';  // Token nicht im Klartext stehen lassen
            settingsLoad();
        } else {
            setMsg('Fehler: ' + ((res && res.error) || 'unbekannt'), 'err');
        }
    } catch (e) {
        setMsg('Fehler: ' + e.message, 'err');
    } finally {
        if (btn) btn.disabled = false;
    }
}

// ╔══════════════════════════════════════════════════════════╗
// ║ 14. STEUER-REPORT (IBKR Activity CSV → Anlage KAP)        ║
// ╚══════════════════════════════════════════════════════════╝

/** Lädt alle IBKR Activity CSVs hoch (Multi-File) und rendert das Ergebnis. Stateless. */
function taxUpload(fileList) {
    if (!fileList || !fileList.length) return;
    _taxRun('tax', fileList);
}

/** Speichert die Mehrjahres-Antwort, füllt das Jahres-Dropdown, rendert das Default-Jahr. */
var _taxData = null;
function taxRender(data) {
    _taxData = data;
    var box = document.getElementById('tax-result');
    if (box) box.style.display = '';

    var sel = document.getElementById('tax-year-select');
    if (sel) {
        sel.innerHTML = (data.available_years || []).map(function(y) {
            return '<option value="' + y + '"' + (y === data.year ? ' selected' : '') + '>' + y + '</option>';
        }).join('');
    }
    _taxRenderYearTable();          // Jahres-Vergleichstabelle (einmal, alle Jahre)
    taxSelectYear(data.year);
}

/** Wechselt das angezeigte Steuerjahr (instant, ohne erneuten Upload). */
function taxSelectYear(year) {
    if (!_taxData || !_taxData.years || !_taxData.years[year]) return;
    _taxRenderYear(_taxData.years[year], _taxData.files_years || []);
    _taxRenderChart(year);
}

/** Jahr per Klick (Chart/Tabelle) wählen — aktualisiert auch das Dropdown. */
function taxPickYear(y) {
    var s = document.getElementById('tax-year-select');
    if (s) s.value = y;
    taxSelectYear(y);
}

/** Nachweis je Position: Symbol → Gewinn/Verlust/Netto, Summen je Topf = Z.20/23/22. */
function _taxRenderPositions(positions) {
    var el = document.getElementById('tax-positions');
    if (!el) return;
    var eur = function(v) { return (v || 0).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
    var groups = [
        { cat: 'Aktien',   title: 'Aktien',                     note: 'Summe Gewinne = Z.20 · Summe Verluste = Z.23' },
        { cat: 'Futures',  title: 'Termingeschäfte (Futures)',  note: 'Summe Verluste fließt in Z.22' },
        { cat: 'Sonstige', title: 'Sonstige',                   note: '' }
    ];
    var html = '<div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin:18px 0 4px;">'
             + 'Nachweis je Position — so summieren sich Gewinne/Verluste</div>'
             + '<div style="overflow-x:auto"><table class="perf-table" style="min-width:400px"><thead><tr>'
             + '<th style="text-align:left">Symbol</th><th style="text-align:right">Gewinn €</th>'
             + '<th style="text-align:right">Verlust €</th><th style="text-align:right">Netto €</th></tr></thead><tbody>';
    var any = false;
    groups.forEach(function(grp) {
        var rows = (positions || []).filter(function(p) { return p.category === grp.cat; });
        if (!rows.length) return;
        any = true;
        var sg = 0, sv = 0;
        html += '<tr class="pr-section"><td colspan="4">' + grp.title
              + (grp.note ? ' <span style="font-weight:400;text-transform:none;letter-spacing:0">— ' + grp.note + '</span>' : '')
              + '</td></tr>';
        rows.forEach(function(p) {
            sg += p.gewinn; sv += p.verlust;
            html += '<tr><td>' + p.symbol + '</td>'
                 + '<td style="text-align:right;color:var(--green)">' + (p.gewinn ? eur(p.gewinn) : '–') + '</td>'
                 + '<td style="text-align:right;color:var(--red)">' + (p.verlust ? eur(p.verlust) : '–') + '</td>'
                 + '<td style="text-align:right;font-variant-numeric:tabular-nums;color:' + (p.net >= 0 ? 'var(--green)' : 'var(--red)') + '">' + eur(p.net) + '</td></tr>';
        });
        html += '<tr style="font-weight:700;border-top:1px solid var(--border)"><td>Summe ' + grp.title + '</td>'
              + '<td style="text-align:right;color:var(--green)">' + eur(sg) + '</td>'
              + '<td style="text-align:right;color:var(--red)">' + eur(sv) + '</td>'
              + '<td style="text-align:right;color:' + ((sg - sv) >= 0 ? 'var(--green)' : 'var(--red)') + '">' + eur(sg - sv) + '</td></tr>';
    });
    html += '</tbody></table></div>';
    el.innerHTML = any ? html : '';
}

/** Balkendiagramm über die Steuerjahre: Gewinne (grün) / Verluste (rot), Netto-Label. */
function _taxRenderChart(selYear) {
    var el = document.getElementById('tax-chart');
    if (!el || !_taxData || !_taxData.available_years) return;
    var rows = _taxData.available_years.map(function(y) {
        var d = _taxData.years[y] || {};
        var g = (d.aktien_gewinn || 0) + (d.futures_gewinn || 0) + (d.sonstige_gewinn || 0);
        var l = (d.aktien_verlust || 0) + (d.futures_verlust || 0) + (d.sonstige_verlust || 0);
        return { y: y, g: g, l: l, net: g - l };
    });
    var maxAbs = Math.max(1, Math.max.apply(null, rows.map(function(d) { return Math.max(d.g, d.l); })));
    var W = 620, H = 220, padL = 12, padR = 12, padTop = 26, padBot = 28;
    var plotH = H - padTop - padBot, zeroY = padTop + plotH / 2, half = plotH / 2;
    var n = rows.length, slot = (W - padL - padR) / Math.max(1, n), bw = Math.min(46, slot * 0.5);
    var fmt = function(v) { return (v >= 0 ? '+' : '') + Math.round(v).toLocaleString('de-DE'); };
    var svg = '<line x1="' + padL + '" y1="' + zeroY + '" x2="' + (W - padR) + '" y2="' + zeroY + '" stroke="var(--border)"/>';
    rows.forEach(function(d, i) {
        var cx = padL + slot * i + slot / 2, sel = (d.y === selYear), op = sel ? '1' : '0.5';
        var gh = d.g / maxAbs * half, lh = d.l / maxAbs * half;
        if (sel) svg += '<rect x="' + (cx - slot / 2 + 2) + '" y="' + padTop + '" width="' + (slot - 4) + '" height="' + plotH + '" fill="var(--bg)"/>';
        svg += '<rect x="' + (cx - bw / 2) + '" y="' + (zeroY - gh) + '" width="' + bw + '" height="' + gh + '" fill="var(--green)" opacity="' + op + '"/>';
        svg += '<rect x="' + (cx - bw / 2) + '" y="' + zeroY + '" width="' + bw + '" height="' + lh + '" fill="var(--red)" opacity="' + op + '"/>';
        svg += '<text x="' + cx + '" y="' + (padTop - 9) + '" text-anchor="middle" font-size="10" font-weight="700" fill="' + (d.net >= 0 ? 'var(--green)' : 'var(--red)') + '">' + fmt(d.net) + '</text>';
        svg += '<text x="' + cx + '" y="' + (H - 9) + '" text-anchor="middle" font-size="11" font-weight="' + (sel ? '700' : '400') + '" fill="' + (sel ? 'var(--text)' : 'var(--muted)') + '">' + d.y + '</text>';
        svg += '<rect x="' + (cx - slot / 2) + '" y="' + padTop + '" width="' + slot + '" height="' + plotH + '" fill="transparent" style="cursor:pointer" onclick="taxPickYear(\'' + d.y + '\')"><title>' + d.y + ': Netto ' + fmt(d.net) + ' €</title></rect>';
    });
    el.innerHTML = '<div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin:18px 0 2px;">Verlauf über die Steuerjahre — Gewinne (grün) / Verluste (rot), Netto je Jahr</div>'
        + '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto" preserveAspectRatio="xMidYMid meet">' + svg + '</svg>';
}

/** Jahres-Vergleichstabelle: Kennzahlen als Zeilen, Jahre als Spalten. */
function _taxRenderYearTable() {
    var el = document.getElementById('tax-yeartable');
    if (!el || !_taxData || !_taxData.available_years) return;
    var ys = _taxData.available_years;
    var num = function(v) {
        if (v == null) return '—';
        return v.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    };
    var metrics = [
        { k: 'line19_foreign',          label: 'Ausländ. Kapitalerträge (Z.19)', strong: true },
        { k: 'line20_aktien_gewinn',    label: 'Aktiengewinne (Z.20)' },
        { k: 'line23_aktien_verlust',   label: 'Aktienverluste (Z.23)' },
        { k: 'line22_sonstige_verlust', label: 'Nicht-Aktien-Verluste (Z.22)' },
        { k: 'dividends_eur',           label: 'Dividenden' },
        { k: 'interest_eur',            label: 'Zinsen' },
        { k: 'withholding_eur',         label: 'Quellensteuer' }
    ];
    var head = '<th style="text-align:left">Kennzahl (EUR)</th>'
        + ys.map(function(y) {
            return '<th style="text-align:right;cursor:pointer" onclick="taxPickYear(\'' + y + '\')">' + y + '</th>';
        }).join('');
    var body = metrics.map(function(m) {
        var cells = ys.map(function(y) {
            var v = (_taxData.years[y] || {})[m.k];
            var col = (typeof v === 'number' && v < 0) ? 'var(--red)' : '';
            return '<td style="text-align:right;font-variant-numeric:tabular-nums;' + (col ? 'color:' + col : '') + '">' + num(v) + '</td>';
        }).join('');
        return '<tr' + (m.strong ? ' style="font-weight:600"' : '') + '><td>' + m.label + '</td>' + cells + '</tr>';
    }).join('');
    el.innerHTML = '<div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin:18px 0 4px;">Vergleich je Steuerjahr</div>'
        + '<div style="overflow-x:auto"><table class="perf-table" style="min-width:420px"><thead><tr>'
        + head + '</tr></thead><tbody>' + body + '</tbody></table></div>';
}

// ╔══════════════════════════════════════════════════════════╗
// ║ 15. STEUER + — vollständige §20-Berechnung (Phase 1)      ║
// ╚══════════════════════════════════════════════════════════╝

var _taxData2 = null;

function taxFullUpload(fileList) {
    if (!fileList || !fileList.length) return;
    _taxRun('steuer2', fileList);
}

function taxFullRender(data) {
    _taxData2 = data;
    var box = document.getElementById('tax2-result');
    if (box) box.style.display = '';
    var sel = document.getElementById('tax2-year-select');
    if (sel) {
        sel.innerHTML = (data.available_years || []).map(function(y) {
            return '<option value="' + y + '"' + (y === data.year ? ' selected' : '') + '>' + y + '</option>';
        }).join('');
    }
    taxFullSelectYear(data.year);
}

function taxFullSelectYear(year) {
    if (!_taxData2 || !_taxData2.years || !_taxData2.years[year]) return;
    _taxFullRenderYear(_taxData2.years[year]);
}

function _taxFullRenderYear(d) {
    var t = d.tax || {};
    var ak = t.aktien_topf || {}, al = t.allg_topf || {};
    var eur = function(v) { return (v == null ? '—' : v.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €'); };
    var card = function(label, val, accent) {
        return '<div class="tax-card"><div class="tc-label">' + label + '</div>'
             + '<div class="tc-val" style="color:' + (accent || 'var(--text)') + '">' + eur(val) + '</div></div>';
    };
    var cardsEl = document.getElementById('tax2-cards');
    if (cardsEl) cardsEl.innerHTML =
          card('Bemessungsgrundlage', t.bemessungsgrundlage, 'var(--accent)')
        + card('Abgeltungst. + Soli', t.steuer_brutto, 'var(--red)')
        + card('Anrechenb. ausl. QSt', t.qst_anrechenbar, 'var(--green)')
        + card('Verbleibende Steuer', t.steuer_netto, 'var(--red)');

    var sec = function(label, note) {
        return '<tr class="pr-section"><td colspan="2">' + label
             + (note ? ' <span style="font-weight:400;text-transform:none;letter-spacing:0">— ' + note + '</span>' : '') + '</td></tr>';
    };
    var row = function(label, val, indent, strong, color) {
        return '<tr class="pr-row"' + (strong ? ' style="font-weight:700"' : '') + '>'
             + '<td style="' + (indent ? 'padding-left:18px;color:var(--muted)' : '') + '">' + label + '</td>'
             + '<td style="text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums;' + (color ? 'color:' + color : '') + '">' + eur(val) + '</td></tr>';
    };
    var R = function(v) { return (v || 0) >= 0 ? 'var(--green)' : 'var(--red)'; };

    var toepfe = document.getElementById('tax2-toepfe');
    if (toepfe) toepfe.innerHTML =
          '<table class="pr-table" style="margin-top:14px"><colgroup><col><col style="width:140px"></colgroup><tbody>'
        + sec('Aktien-Topf', '§20 Abs. 6 S.4 — nur untereinander verrechenbar · BVerfG 2 BvL 3/21')
        + row('Aktiengewinne · Anlage KAP Z.20', ak.gewinn, true, false, 'var(--green)')
        + row('Aktienverluste · Anlage KAP Z.23', ak.verlust, true, false, 'var(--red)')
        + row('Netto Aktien-Topf', ak.netto, false, true, R(ak.netto))
        + (ak.verlustvortrag > 0 ? row('→ Verlustvortrag (nicht verrechenbar)', ak.verlustvortrag, true, false, 'var(--red)')
                                 : row('→ steuerpflichtig', ak.steuerbar, true, false))
        + sec('Allgemeiner Topf', 'Anlage KAP — Erträge/Gewinne in Z.19, Verluste in Z.22')
        + row('Termingeschäfte (netto) · Z.19 / Z.22', al.termingeschaefte, true, false, R(al.termingeschaefte))
        + row('Dividenden · Z.19', al.dividenden, true)
        + row('Zinsen · Z.19', al.zinsen, true)
        + row('Fremdwährung (Regel F) · Z.19 / Z.22', al.waehrung, true, false, R(al.waehrung))
        + Object.keys(al.waehrung_detail || {}).sort().map(function(c) {
              return '<tr class="pr-row"><td style="padding-left:34px;color:var(--muted);font-size:10px">'
                   + c + '</td><td style="text-align:right;font-size:10px;color:' + R(al.waehrung_detail[c])
                   + '">' + eur(al.waehrung_detail[c]) + '</td></tr>';
          }).join('')
        + row('Netto allg. Topf', al.netto, false, true, R(al.netto))
        + (al.verlustvortrag > 0 ? row('→ Verlustvortrag', al.verlustvortrag, true, false, 'var(--red)')
                                 : row('→ steuerpflichtig', al.steuerbar, true, false))
        + '</tbody></table>';

    var steuer = document.getElementById('tax2-steuer');
    if (steuer) steuer.innerHTML =
          '<table class="pr-table" style="margin-top:14px"><colgroup><col><col style="width:140px"></colgroup><tbody>'
        + sec('Steuerberechnung', 'ohne Sparer-Pauschbetrag · ohne KiSt')
        + row('Bemessungsgrundlage', t.bemessungsgrundlage, false, true)
        + row('Abgeltungsteuer 25 %', t.abgeltungsteuer, true)
        + row('Solidaritätszuschlag 5,5 %', t.soli, true)
        + row('Steuer brutto', t.steuer_brutto, false, true, 'var(--red)')
        + row('abzgl. anrechenbare ausl. Quellensteuer · Z.41', t.qst_anrechenbar, true, false, 'var(--green)')
        + row('Verbleibende Steuer', t.steuer_netto, false, true, 'var(--red)')
        + '</tbody></table>';

    _taxFullRenderJournal(d);
}

/** Prüffähiges FIFO-Journal je Topf (jede Veräußerung mit Kauf/Verkauf-Bein, FX, EUR). */
function _taxFullRenderJournal(d) {
    var el = document.getElementById('tax2-journal');
    if (!el) return;
    var jr = d.journal || [];
    var t = d.tax || {}, al = t.allg_topf || {};
    var n2 = function(v) { return (v || 0).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
    var d4 = function(v) { return (v || 0).toLocaleString('de-DE', { minimumFractionDigits: 0, maximumFractionDigits: 4 }); };

    function block(title, cat) {
        var rows = jr.filter(function(j) { return j.category === cat; });
        if (!rows.length) return '';
        var sg = rows.reduce(function(s, j) { return s + j.gewinn_eur; }, 0);
        var head = '<tr>'
            + '<th style="text-align:left">Symbol</th><th style="text-align:right">Stück</th>'
            + '<th style="text-align:left">Kauf</th><th style="text-align:right">Kurs</th><th style="text-align:right">FX</th><th style="text-align:right">Anschaffung €</th>'
            + '<th style="text-align:left">Verkauf</th><th style="text-align:right">Kurs</th><th style="text-align:right">FX</th><th style="text-align:right">Erlös €</th>'
            + '<th style="text-align:right">G/V €</th></tr>';
        var body = rows.map(function(j) {
            return '<tr><td>' + j.symbol + (j.short ? ' <span style="color:var(--muted);font-size:9px">(short)</span>' : '') + '</td>'
                + '<td style="text-align:right">' + d4(j.menge) + '</td>'
                + '<td style="color:var(--muted)">' + j.kauf_datum + '</td>'
                + '<td style="text-align:right">' + d4(j.kauf_kurs) + ' ' + j.waehrung + '</td>'
                + '<td style="text-align:right;color:var(--muted)">' + d4(j.fx_kauf) + '</td>'
                + '<td style="text-align:right">' + n2(j.anschaffung_eur) + '</td>'
                + '<td style="color:var(--muted)">' + j.verkauf_datum + '</td>'
                + '<td style="text-align:right">' + d4(j.verkauf_kurs) + ' ' + j.waehrung + '</td>'
                + '<td style="text-align:right;color:var(--muted)">' + d4(j.fx_verkauf) + '</td>'
                + '<td style="text-align:right">' + n2(j.erloes_eur) + '</td>'
                + '<td style="text-align:right;font-variant-numeric:tabular-nums;color:' + (j.gewinn_eur >= 0 ? 'var(--green)' : 'var(--red)') + '">' + n2(j.gewinn_eur) + '</td></tr>';
        }).join('');
        return '<details style="margin-top:10px"><summary style="cursor:pointer;font-size:11px;color:var(--muted)">'
            + title + ' — ' + rows.length + ' Veräußerungen, Summe G/V ' + n2(sg) + ' €</summary>'
            + '<div style="overflow-x:auto;margin-top:6px"><table class="perf-table" style="min-width:760px;font-size:10px">'
            + '<thead>' + head + '</thead><tbody>' + body + '</tbody></table></div></details>';
    }

    // Fremdwährung: IBKR-realisiert, keine Einzel-FIFO verfügbar
    var fx = al.waehrung_detail || {};
    var fxBlock = '';
    if (Object.keys(fx).length) {
        var rows = Object.keys(fx).sort().map(function(c) {
            return '<tr><td>' + c + '</td><td style="text-align:right;color:' + (fx[c] >= 0 ? 'var(--green)' : 'var(--red)') + '">' + n2(fx[c]) + ' €</td></tr>';
        }).join('');
        fxBlock = '<details style="margin-top:10px"><summary style="cursor:pointer;font-size:11px;color:var(--muted)">'
            + 'Fremdwährung (Regel F) — IBKR-realisiert, ' + n2(al.waehrung) + ' € <span style="font-style:italic">(keine Einzel-FIFO im Statement)</span></summary>'
            + '<table class="pr-table" style="margin-top:6px;max-width:280px"><tbody>' + rows + '</tbody></table></details>';
    }

    var html = block('Aktien-Topf (FIFO-Journal)', 'Aktien')
             + block('Termingeschäfte (FIFO-Journal)', 'Futures')
             + fxBlock;
    el.innerHTML = html
        ? '<div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin:18px 0 4px;">Prüffähiges FIFO-Journal (aufklappen)</div>' + html
        : '';
}

// ╔══════════════════════════════════════════════════════════╗
// ║ 16. STEUER ++ — Flex-XML (Closed Lots) + EZB pro Bein     ║
// ╚══════════════════════════════════════════════════════════╝

var _taxData3 = null;

function taxXmlUpload(fileList) {
    if (!fileList || !fileList.length) return;
    _taxRun('steuer3', fileList);
}

function taxXmlRender(data) {
    _taxData3 = data;
    var box = document.getElementById('tax3-result');
    if (box) box.style.display = '';
    var sel = document.getElementById('tax3-year-select');
    if (sel) {
        sel.innerHTML = (data.available_years || []).map(function(y) {
            return '<option value="' + y + '"' + (y === data.year ? ' selected' : '') + '>' + y + '</option>';
        }).join('');
    }
    taxXmlSelectYear(data.year);
}

function taxXmlSelectYear(year) {
    if (!_taxData3 || !_taxData3.years || !_taxData3.years[year]) return;
    _taxXmlRenderYear(_taxData3.years[year]);
}

function _taxXmlRenderYear(d) {
    var t = d.tax || {};
    var ak = t.aktien_topf || {}, al = t.allg_topf || {}, na = t.nicht_abzugsfaehig || {};
    var eur = function(v) { return (v == null ? '—' : v.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €'); };
    var R = function(v) { return (v || 0) >= 0 ? 'var(--green)' : 'var(--red)'; };
    var card = function(label, val, accent) {
        return '<div class="tax-card"><div class="tc-label">' + label + '</div>'
             + '<div class="tc-val" style="color:' + (accent || 'var(--text)') + '">' + eur(val) + '</div></div>';
    };
    var cardsEl = document.getElementById('tax3-cards');
    if (cardsEl) cardsEl.innerHTML =
          card('Bemessungsgrundlage', t.bemessungsgrundlage, 'var(--accent)')
        + card('Abgeltungst. + Soli', t.steuer_brutto, 'var(--red)')
        + card('Anrechenb. ausl. QSt', t.qst_anrechenbar, 'var(--green)')
        + card('Verbleibende Steuer', t.steuer_netto, 'var(--red)');

    var sec = function(label, note) {
        return '<tr class="pr-section"><td colspan="2">' + label
             + (note ? ' <span style="font-weight:400;text-transform:none;letter-spacing:0">— ' + note + '</span>' : '') + '</td></tr>';
    };
    var row = function(label, val, indent, strong, color) {
        return '<tr class="pr-row"' + (strong ? ' style="font-weight:700"' : '') + '>'
             + '<td style="' + (indent ? 'padding-left:18px;color:var(--muted)' : '') + '">' + label + '</td>'
             + '<td style="text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums;' + (color ? 'color:' + color : '') + '">' + eur(val) + '</td></tr>';
    };

    var toepfe = document.getElementById('tax3-toepfe');
    if (toepfe) toepfe.innerHTML =
          '<table class="pr-table" style="margin-top:14px"><colgroup><col><col style="width:140px"></colgroup><tbody>'
        + sec('Aktien-Topf', '§20 Abs. 6 S.4 — nur untereinander verrechenbar · BVerfG 2 BvL 3/21')
        + row('Aktiengewinne · Anlage KAP Z.20', ak.gewinn, true, false, 'var(--green)')
        + row('Aktienverluste · Anlage KAP Z.23', ak.verlust, true, false, 'var(--red)')
        + row('Netto Aktien-Topf', ak.netto, false, true, R(ak.netto))
        + (ak.verlustvortrag > 0
              ? row('→ Verlustvortrag (nur ggü. Aktiengewinnen)', ak.verlustvortrag, true, false, 'var(--red)')
              : (t.spillover > 0
                    ? row('abzgl. allgemeine Verluste (Überlauf)', -t.spillover, true, false, 'var(--red)')
                      + row('→ steuerpflichtig', ak.steuerbar, true, true)
                    : row('→ steuerpflichtig', ak.steuerbar, true, false)))
        + sec('Allgemeiner Topf', 'Anlage KAP — Erträge/Gewinne Z.19, Verluste Z.22')
        + row('Termingeschäfte (netto) · Z.19 / Z.22', al.termingeschaefte, true, false, R(al.termingeschaefte))
        + row('ETF/Fonds (netto, vor Teilfreistellung)', al.fonds, true, false, R(al.fonds))
        + row('Ausländische Dividenden · Z.19', al.dividenden, true)
        + row('Zinsen · Z.19', al.zinsen, true)
        + row('Devisen (Regel F) · Z.19 / Z.22', al.waehrung, true, false, R(al.waehrung))
        + Object.keys(al.waehrung_detail || {}).sort().map(function(c) {
              return '<tr class="pr-row"><td style="padding-left:34px;color:var(--muted);font-size:10px">'
                   + c + '</td><td style="text-align:right;font-size:10px;color:' + R(al.waehrung_detail[c])
                   + '">' + eur(al.waehrung_detail[c]) + '</td></tr>';
          }).join('')
        + (al.sonstige ? row('Sonstige (netto)', al.sonstige, true, false, R(al.sonstige)) : '')
        + row('Netto allg. Topf', al.netto, false, true, R(al.netto))
        + (t.spillover > 0 ? row('davon gegen Aktiengewinn verrechnet', t.spillover, true, false, 'var(--green)') : '')
        + (al.verlustvortrag > 0 ? row('→ Verlustvortrag (frei verrechenbar)', al.verlustvortrag, true, false, 'var(--red)')
           : (al.steuerbar > 0 ? row('→ steuerpflichtig', al.steuerbar, true, false)
                               : (t.spillover > 0 ? row('→ vollständig verrechnet', 0, true, false) : '')))
        + '</tbody></table>';

    var steuer = document.getElementById('tax3-steuer');
    if (steuer) steuer.innerHTML =
          '<table class="pr-table" style="margin-top:14px"><colgroup><col><col style="width:140px"></colgroup><tbody>'
        + sec('Steuerberechnung', 'ohne Sparer-Pauschbetrag · ohne KiSt')
        + row('Bemessungsgrundlage', t.bemessungsgrundlage, false, true)
        + row('Abgeltungsteuer 25 %', t.abgeltungsteuer, true)
        + row('Solidaritätszuschlag 5,5 %', t.soli, true)
        + row('Steuer brutto', t.steuer_brutto, false, true, 'var(--red)')
        + row('abzgl. anrechenbare ausl. Quellensteuer · Z.41', t.qst_anrechenbar, true, false, 'var(--green)')
        + row('Verbleibende Steuer', t.steuer_netto, false, true, 'var(--red)')
        + ((na.zinsen_gezahlt || na.gebuehren)
            ? sec('nachrichtlich — nicht abzugsfähig (§20 Abs. 9)')
              + row('gezahlte Zinsen', na.zinsen_gezahlt, true, false, 'var(--muted)')
              + row('Gebühren', na.gebuehren, true, false, 'var(--muted)')
            : '')
        + '</tbody></table>';

    _taxXmlRenderJournal(d);
    _taxXmlRenderIncome(d);
}

/** Prüffähiges Journal je Veräußerung: EZB-Rechnung + IBKR-Gegencheck (Handelswährung). */
function _taxXmlRenderJournal(d) {
    var el = document.getElementById('tax3-journal');
    if (!el) return;
    var jr = d.journal || [];
    var n2 = function(v) { return (v || 0).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
    var d4 = function(v) { return v == null ? '' : v.toLocaleString('de-DE', { minimumFractionDigits: 0, maximumFractionDigits: 4 }); };
    var labels = { 'Aktien': 'Aktien-Topf', 'Futures': 'Termingeschäfte', 'Fonds': 'ETF/Fonds', 'Sonstige': 'Sonstige' };

    function block(cat) {
        var rows = jr.filter(function(j) { return j.category === cat; });
        if (!rows.length) return '';
        var sg = rows.reduce(function(s, j) { return s + j.gewinn_eur; }, 0);
        var head = '<tr>'
            + '<th style="text-align:left">Symbol</th><th style="text-align:right">Menge</th>'
            + '<th style="text-align:left">Kauf</th><th style="text-align:right">Kurs</th><th style="text-align:right">FX</th><th style="text-align:right">Anschaffung €</th>'
            + '<th style="text-align:left">Verkauf</th><th style="text-align:right">Kurs</th><th style="text-align:right">FX</th><th style="text-align:right">Erlös €</th>'
            + '<th style="text-align:right">G/V €</th><th style="text-align:right" title="IBKR realisiert, Handelswährung — Gegencheck">IBKR ⓘ</th></tr>';
        var body = rows.map(function(j) {
            return '<tr><td>' + j.symbol + (j.short ? ' <span style="color:var(--muted);font-size:9px">(short)</span>' : '') + '</td>'
                + '<td style="text-align:right">' + d4(j.menge) + '</td>'
                + '<td style="color:var(--muted)">' + j.kauf_datum + '</td>'
                + '<td style="text-align:right">' + d4(j.kauf_kurs) + ' ' + j.currency + '</td>'
                + '<td style="text-align:right;color:var(--muted)">' + d4(j.fx_kauf) + '</td>'
                + '<td style="text-align:right">' + n2(j.anschaffung_eur) + '</td>'
                + '<td style="color:var(--muted)">' + j.verkauf_datum + '</td>'
                + '<td style="text-align:right">' + d4(j.verkauf_kurs) + ' ' + j.currency + '</td>'
                + '<td style="text-align:right;color:var(--muted)">' + d4(j.fx_verkauf) + '</td>'
                + '<td style="text-align:right">' + n2(j.erloes_eur) + '</td>'
                + '<td style="text-align:right;font-variant-numeric:tabular-nums;color:' + (j.gewinn_eur >= 0 ? 'var(--green)' : 'var(--red)') + '">' + n2(j.gewinn_eur) + '</td>'
                + '<td style="text-align:right;color:var(--muted);font-size:9px">' + n2(j.ibkr_pnl_local) + ' ' + j.currency + '</td></tr>';
        }).join('');
        return '<details style="margin-top:10px"' + (cat === 'Aktien' ? ' open' : '') + '><summary style="cursor:pointer;font-size:11px;color:var(--muted)">'
            + (labels[cat] || cat) + ' — ' + rows.length + ' Veräußerungen, Summe G/V ' + n2(sg) + ' €</summary>'
            + '<div style="overflow-x:auto;margin-top:6px"><table class="perf-table" style="min-width:860px;font-size:10px">'
            + '<thead>' + head + '</thead><tbody>' + body + '</tbody></table></div></details>';
    }

    var html = block('Aktien') + block('Futures') + block('Fonds') + block('Sonstige');
    el.innerHTML = html
        ? '<div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin:18px 0 4px;">Prüffähiges Journal je Veräußerung (EZB pro Bein · IBKR-Spalte = Gegencheck in Handelswährung)</div>' + html
        : '';
}

/** Ertrags-Detail: jede Dividende/Zins/Quellensteuer + Devisen-Lots, zur Quelle nachvollziehbar. */
function _taxXmlRenderIncome(d) {
    var el = document.getElementById('tax3-income');
    if (!el) return;
    var inc = d.income_detail || [];
    var fx = d.fx_detail || [];
    var n2 = function(v) { return (v || 0).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
    var d5 = function(v) { return (v || 0).toLocaleString('de-DE', { minimumFractionDigits: 0, maximumFractionDigits: 5 }); };
    var html = '';

    if (inc.length) {
        var rows = inc.slice().sort(function(a, b) { return a.date < b.date ? -1 : 1; }).map(function(c) {
            return '<tr><td style="color:var(--muted)">' + c.date + '</td><td>' + c.type + '</td>'
                + '<td>' + (c.symbol || '') + '</td>'
                + '<td style="text-align:center;color:var(--muted)">' + (c.country || '') + (c.foreign ? '' : ' 🇩🇪') + '</td>'
                + '<td style="text-align:right">' + n2(c.amount_local) + ' ' + c.currency + '</td>'
                + '<td style="text-align:right;color:var(--muted)">' + d5(c.fx) + '</td>'
                + '<td style="text-align:right;font-variant-numeric:tabular-nums">' + n2(c.amount_eur) + ' €</td></tr>';
        }).join('');
        html += '<details style="margin-top:10px"><summary style="cursor:pointer;font-size:11px;color:var(--muted)">'
            + 'Erträge im Detail — ' + inc.length + ' Posten (Dividenden, Zinsen, Quellensteuer)</summary>'
            + '<div style="overflow-x:auto;margin-top:6px"><table class="perf-table" style="min-width:620px;font-size:10px">'
            + '<thead><tr><th style="text-align:left">Datum</th><th style="text-align:left">Art</th><th style="text-align:left">Symbol</th>'
            + '<th>Land</th><th style="text-align:right">Betrag</th><th style="text-align:right">EZB-FX</th><th style="text-align:right">EUR</th></tr></thead>'
            + '<tbody>' + rows + '</tbody></table></div></details>';
    }

    if (fx.length) {
        var s = fx.reduce(function(a, x) { return a + x.realized_eur; }, 0);
        var rows2 = fx.slice().sort(function(a, b) { return a.date < b.date ? -1 : 1; }).map(function(x) {
            return '<tr><td style="color:var(--muted)">' + x.date + '</td><td>' + x.currency + '</td>'
                + '<td style="color:var(--muted);font-size:9px">' + (x.desc || '') + '</td>'
                + '<td style="text-align:right;font-variant-numeric:tabular-nums;color:' + (x.realized_eur >= 0 ? 'var(--green)' : 'var(--red)') + '">' + n2(x.realized_eur) + ' €</td></tr>';
        }).join('');
        html += '<details style="margin-top:10px"><summary style="cursor:pointer;font-size:11px;color:var(--muted)">'
            + 'Devisen (Regel F) im Detail — ' + fx.length + ' FX-Lots, Summe ' + n2(s) + ' € <span style="font-style:italic">(IBKR-realisiert in EUR)</span></summary>'
            + '<div style="overflow-x:auto;margin-top:6px"><table class="perf-table" style="min-width:480px;font-size:10px">'
            + '<thead><tr><th style="text-align:left">Datum</th><th style="text-align:left">Währung</th><th style="text-align:left">Auslöser</th><th style="text-align:right">realisiert €</th></tr></thead>'
            + '<tbody>' + rows2 + '</tbody></table></div></details>';
    }

    el.innerHTML = html
        ? '<div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin:18px 0 4px;">Erträge & Devisen — Drill-down zur Quelle</div>' + html
        : '';
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  STEUER +++ — Konvex-Engine (Anlage KAP / KAP-INV)
 *  Verbraucht /api/tax/report-konvex (tax_engine_konvex.py).
 * ═══════════════════════════════════════════════════════════════════════════ */

var _taxData4 = null;

function taxKonvexUpload(fileList) {
    if (!fileList || !fileList.length) return;
    _taxRun('steuer4', fileList);
}

/**
 * Holt die aktuelle Steuer-Flex-XML direkt von IBKR (konfigurierte query_id_tax),
 * legt sie im Bestand ab und rendert den Konvex-Report fürs laufende Jahr.
 * Der IBKR-Abruf kann ~30 s dauern (SendRequest → Statement-Polling).
 */
async function taxKonvexFetchFlex(btn) {
    var old = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerHTML = '⏳ hole von IBKR …'; }
    _taxSetMsg('tax4-msg', 'Hole aktuelle Flex-XML von IBKR … (kann ~30 s dauern)', '');
    try {
        var res = await fetch('/api/tax/fetch-flex', { method: 'POST' }).then(function (r) { return r.json(); });
        if (res && res.ok) {
            var years = (res.available_years || []).filter(Boolean).join(', ');
            _taxSetMsg('tax4-msg', '✓ IBKR-Abruf · Jahr ' + (res.fetched_year || '') + ' aktualisiert · '
                + years + ' ausgewertet' + (res.account ? ' · Konto ' + res.account : ''), 'ok');
            _TAX_CFG.steuer4.loaded = true;
            taxKonvexRender(res);
            _taxIndicator(_TAX_CFG.steuer4, res.stored_files);
        } else {
            _taxSetMsg('tax4-msg', 'Fehler: ' + ((res && res.error) || 'unbekannt'), 'err');
        }
    } catch (e) {
        _taxSetMsg('tax4-msg', 'Fehler: ' + e.message, 'err');
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = old; }
    }
}

function taxKonvexRender(data) {
    _taxData4 = data;
    var box = document.getElementById('tax4-result');
    if (box) box.style.display = '';
    var sel = document.getElementById('tax4-year-select');
    if (sel) {
        sel.innerHTML = (data.available_years || []).map(function(y) {
            return '<option value="' + y + '"' + (y === data.year ? ' selected' : '') + '>' + y + '</option>';
        }).join('');
    }
    taxKonvexSelectYear(data.year);
}

function taxKonvexSelectYear(year) {
    if (!_taxData4 || !_taxData4.years || !_taxData4.years[year]) return;
    _taxKonvexRenderYear(_taxData4.years[year]);
}

/** Lädt den vollständigen PDF-Steuerbericht für das gewählte Jahr (serverseitig erzeugt). */
async function taxKonvexPdf() {
    var sel = document.getElementById('tax4-year-select');
    var year = sel ? sel.value : (_taxData4 && _taxData4.year);
    if (!year) return;
    var btn = document.getElementById('tax4-pdf-btn');
    var old = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerHTML = '⏳ erstelle …'; }
    try {
        var resp = await fetch('/api/tax/report-konvex-pdf?year=' + encodeURIComponent(year));
        if (!resp.ok) {
            var e = await resp.json().catch(function() { return {}; });
            throw new Error(e.error || ('HTTP ' + resp.status));
        }
        var blob = await resp.blob();
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url; a.download = 'IBKR-Steuer-Report_' + year + '.pdf';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
    } catch (err) {
        var msg = document.getElementById('tax4-msg');
        if (msg) { msg.textContent = 'PDF-Fehler: ' + err.message; msg.className = 'settings-msg err'; }
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = old; }
    }
}

function _taxKonvexRenderYear(d) {
    var t = d.tax || {}, z = d.zeile || {}, tp = d.toepfe || {},
        ak = tp.aktien || {}, al = tp.allg || {}, ki = tp.kap_inv || {},
        z22 = tp.z22_components || {},
        inc = d.income || {}, kap = d.kap_inv || {}, fx = d.fx || {}, fl = d.flags || {};
    var eur = function(v) { return (v == null ? '—' : v.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €'); };
    var R = function(v) { return (v || 0) >= 0 ? 'var(--green)' : 'var(--red)'; };
    var card = function(label, val, accent) {
        return '<div class="tax-card"><div class="tc-label">' + label + '</div>'
             + '<div class="tc-val" style="color:' + (accent || 'var(--text)') + '">' + eur(val) + '</div></div>';
    };

    // ── Warnungen / Hinweise ────────────────────────────────────────────────
    var warn = document.getElementById('tax4-warn');
    if (warn) {
        var w = '';
        var box = function(color, label, text) {
            return '<div style="background:rgba(0,0,0,.04);border-left:3px solid ' + color
                 + ';border-radius:8px;padding:8px 12px;margin-bottom:8px;font-size:11px;color:var(--muted);line-height:1.5;">'
                 + '<b style="color:' + color + '">' + label + '</b> ' + text + '</div>';
        };
        if (fl.has_trade_price === false)
            w += box('#fbbf24', 'Hinweis:', 'Flex Query ohne <code>tradePrice</code> — Stillhalterprämien über Tagesschlusskurs genähert. Für genauere Werte: Trade-Confirmation-Felder in der Flex Query aktivieren.');
        if ((fl.stillhalter_unmatched || []).length)
            w += box('#fb923c', 'Stillhalter:', (fl.stillhalter_unmatched || []).length + ' Assignment(s) ohne gefundenen Eröffnungsverkauf — Vorjahres-XML hochladen, sonst landet die Prämie in Topf 1 statt Topf 2.');
        if ((fl.zufluss_unmatched || []).length)
            w += box('#fb923c', 'Zufluss:', (fl.zufluss_unmatched || []).length + ' Glattstellung(en) ohne Eröffnungs-SELL — ohne Vorjahres-XML droht Doppelbesteuerung der Prämie.');
        if (fx.has_negative_balance)
            w += box('#a855f7', 'Devisen:', 'Zeitweise negativer Fremdwährungssaldo (Margin) erkannt — FX-Margin-Korrektur ' + (fl.fx_margin_correction ? 'aktiv' : 'inaktiv') + '.');
        warn.innerHTML = w;
    }

    // ── Kennzahl-Karten ─────────────────────────────────────────────────────
    var cardsEl = document.getElementById('tax4-cards');
    if (cardsEl) cardsEl.innerHTML =
          card('Bemessungsgrundlage', t.bemessungsgrundlage, 'var(--accent)')
        + card('Abgeltungst. + Soli', t.steuer_brutto, 'var(--red)')
        + card('Anrechenb. ausl. QSt', t.qst_anrechenbar, 'var(--green)')
        + card('Verbleibende Steuer', t.steuer_netto, 'var(--red)');

    var sec = function(label, note) {
        return '<tr class="pr-section"><td colspan="2">' + label
             + (note ? ' <span style="font-weight:400;text-transform:none;letter-spacing:0">— ' + note + '</span>' : '') + '</td></tr>';
    };
    var row = function(label, val, indent, strong, color) {
        return '<tr class="pr-row"' + (strong ? ' style="font-weight:700"' : '') + '>'
             + '<td style="' + (indent ? 'padding-left:18px;color:var(--muted)' : '') + '">' + label + '</td>'
             + '<td style="text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums;' + (color ? 'color:' + color : '') + '">' + eur(val) + '</td></tr>';
    };

    // ── Offizielle Anlage-KAP-Zeilen (autoritativ aus der Engine) ────────────
    var zeilen = document.getElementById('tax4-zeilen');
    var zrow = function(line, label, val, color) {
        return '<tr class="pr-row"><td style="width:60px;color:var(--muted)">Zeile ' + line + '</td>'
             + '<td>' + label + '</td>'
             + '<td style="text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums;' + (color ? 'color:' + color : '') + '">' + eur(val) + '</td></tr>';
    };
    if (zeilen) zeilen.innerHTML =
          '<div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin:16px 0 4px;">Anlage KAP / KAP-INV — Eintragungshilfe</div>'
        + '<table class="pr-table"><colgroup><col style="width:60px"><col><col style="width:140px"></colgroup><tbody>'
        + zrow('7',  'Inländische Kapitalerträge mit Steuerabzug', z.z7)
        + zrow('19', 'Ausländische Kapitalerträge (Netto-Saldo)', z.z19, R(z.z19))
        + zrow('20', 'darin: Gewinne aus Aktienveräußerungen', z.z20, 'var(--green)')
        + zrow('22', 'Verluste ohne Aktien (Termingeschäfte etc.)', z.z22, 'var(--red)')
        + zrow('23', 'Verluste aus Aktienveräußerungen', z.z23, 'var(--red)')
        + zrow('37', 'Kapitalertragsteuer (inländisch)', z.z37)
        + zrow('38', 'Solidaritätszuschlag (inländisch)', z.z38)
        + zrow('41', 'Anrechenbare ausländische Quellensteuer', z.z41, 'var(--green)')
        + (z.kap_inv_net != null ? '<tr class="pr-row"><td style="width:60px;color:var(--muted)">KAP-INV</td>'
            + '<td>Investmenterträge netto (nach Teilfreistellung)</td>'
            + '<td style="text-align:right;font-variant-numeric:tabular-nums;color:' + R(z.kap_inv_net) + '">' + eur(z.kap_inv_net) + '</td></tr>' : '')
        + '</tbody></table>'
        + (((z22.termingeschaefte || 0) + (z22.waehrung || 0) + (z22.sonstige || 0)) > 0
            ? '<div style="font-size:10px;color:var(--muted);margin:4px 0 0;padding-left:60px;line-height:1.5">'
              + '↳ <b>Zeile 22</b> bündelt alle Nicht-Aktien-Verluste: '
              + 'Termingeschäfte ' + eur(z22.termingeschaefte)
              + ' + Devisen (Regel F) ' + eur(z22.waehrung)
              + (z22.sonstige ? ' + Sonstige ' + eur(z22.sonstige) : '')
              + (z22.rest ? ' + Korrektur ' + eur(z22.rest) : '')
              + ' = ' + eur(z22.total)
              + '</div>'
            : '');

    // ── Zwei Töpfe (§20 Abs. 6) ─────────────────────────────────────────────
    var sp = t._spillover != null ? t._spillover : (tp.spillover || 0);
    var toepfe = document.getElementById('tax4-toepfe');
    if (toepfe) toepfe.innerHTML =
          '<table class="pr-table" style="margin-top:14px"><colgroup><col><col style="width:140px"></colgroup><tbody>'
        + sec('Aktien-Topf', '§20 Abs. 6 S.4 — nur untereinander verrechenbar · BVerfG 2 BvL 3/21')
        + row('Aktiengewinne · Z.20', ak.gewinn, true, false, 'var(--green)')
        + row('Aktienverluste · Z.23', -(ak.verlust || 0), true, false, 'var(--red)')
        + (ak.tageskurs_korrektur
            ? '<tr class="pr-row"><td style="padding-left:18px;color:var(--muted);font-size:10px;font-style:italic">'
              + 'inkl. Tageskurs-Korrektur §20 Abs. 4 (Erlös/Kosten je zum eigenen FX-Kurs; '
              + 'IBKR-Roh-Saldo ' + eur((ak.netto || 0) - (ak.tageskurs_korrektur || 0)) + ')</td>'
              + '<td style="text-align:right;color:var(--muted);font-size:10px">' + eur(ak.tageskurs_korrektur) + '</td></tr>'
            : '')
        + row('Netto Aktien-Topf', ak.netto, false, true, R(ak.netto))
        + (ak.verlustvortrag > 0
              ? row('→ Verlustvortrag (nur ggü. Aktiengewinnen)', ak.verlustvortrag, true, false, 'var(--red)')
              : (sp > 0
                    ? row('abzgl. allgemeine Verluste (Überlauf)', -sp, true, false, 'var(--red)')
                      + row('→ steuerpflichtig', ak.steuerbar, true, true)
                    : row('→ steuerpflichtig', ak.steuerbar, true, false)))
        + sec('Allgemeiner Topf', 'Anlage KAP — Z.19 / Verluste Z.22 · ohne Investmentfonds')
        + row('Termingeschäfte (Optionen + Futures)', al.termingeschaefte, true, false, R(al.termingeschaefte))
        + row('Devisen (Regel F)', al.waehrung, true, false, R(al.waehrung))
        + (al.sonstige ? row('Sonstige (T-Bills, Anleihen …)', al.sonstige, true, false, R(al.sonstige)) : '')
        + row('Ausländische Dividenden · Z.19', al.dividenden, true)
        + (al.dividenden_de ? row('Inländische Dividenden (auch Z.7)', al.dividenden_de, true, false, 'var(--muted)') : '')
        + row('Zinsen', al.zinsen, true)
        + (al.korrektur ? row('Tageskurs-/Zufluss-Korrektur', al.korrektur, true, false, 'var(--muted)') : '')
        + row('Netto allg. Topf', al.netto, false, true, R(al.netto))
        + (sp > 0 ? row('davon gegen Aktiengewinn verrechnet', sp, true, false, 'var(--green)') : '')
        + (al.verlustvortrag > 0 ? row('→ Verlustvortrag (frei verrechenbar)', al.verlustvortrag, true, false, 'var(--red)')
           : (al.steuerbar > 0 ? row('→ steuerpflichtig', al.steuerbar, true, false)
                               : (sp > 0 ? row('→ vollständig verrechnet', 0, true, false) : '')))
        + sec('Anlage KAP-INV', 'Investmentfonds — eigener Verrechnungskreis (§20 InvStG)')
        + row('Netto KAP-INV (nach Teilfreistellung)', ki.netto, true, false, R(ki.netto))
        + (ki.verlustvortrag > 0 ? row('→ Verlustvortrag KAP-INV', ki.verlustvortrag, true, false, 'var(--red)')
                                 : row('→ steuerpflichtig', ki.steuerbar, true, false))
        + '</tbody></table>';

    // ── Abgeltungsteuer ─────────────────────────────────────────────────────
    var steuer = document.getElementById('tax4-steuer');
    if (steuer) steuer.innerHTML =
          '<table class="pr-table" style="margin-top:14px"><colgroup><col><col style="width:140px"></colgroup><tbody>'
        + sec('Steuerberechnung', 'ohne Sparer-Pauschbetrag · ohne KiSt')
        + row('Bemessungsgrundlage (Aktien + Allg. + KAP-INV)', t.bemessungsgrundlage, false, true)
        + row('Abgeltungsteuer 25 %', t.abgeltungsteuer, true)
        + row('Solidaritätszuschlag 5,5 %', t.soli, true)
        + row('Steuer brutto', t.steuer_brutto, false, true, 'var(--red)')
        + row('abzgl. anrechenbare ausl. Quellensteuer · Z.41', t.qst_anrechenbar, true, false, 'var(--green)')
        + row('Verbleibende Steuer', t.steuer_netto, false, true, 'var(--red)')
        + '</tbody></table>';

    _taxKonvexRenderJournal(d.journal || {});
    _taxKonvexRenderKapInv(kap);
    _taxKonvexRenderFx(fx);
    _taxKonvexRenderIncome(inc, fl);
}

/** Prüffähiges Trade-Journal je Topf/Wertpapier — entspricht dem Konvex-Excel-Export. */
function _taxKonvexRenderJournal(j) {
    var el = document.getElementById('tax4-journal');
    if (!el) return;
    var n2 = function(v) { return (v == null ? '' : v.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })); };
    var d4 = function(v) { return (v == null ? '' : v.toLocaleString('de-DE', { minimumFractionDigits: 0, maximumFractionDigits: 4 })); };
    var col = function(v) { return (v || 0) >= 0 ? 'var(--green)' : 'var(--red)'; };
    var esc = function(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };

    var head = '<tr><th>Datum</th><th>K/V</th><th>Stk.</th><th>Kurs</th><th>Kostenb.</th>'
        + '<th>Erlöse</th><th>G/V lok.</th><th>Komm.</th><th>Whr.</th><th>FX</th><th>G/V €</th><th>Anmerkung</th></tr>';

    function rowHtml(r) {
        var korr = r.source === 'tageskurs_korrektur';
        return '<tr class="' + (korr ? 'jr-row-korr' : '') + '">'
            + '<td>' + r.datum + '</td>'
            + '<td>' + (r.kv || '') + '</td>'
            + '<td>' + (r.stk != null ? r.stk : '') + '</td>'
            + '<td>' + d4(r.kurs) + '</td>'
            + '<td>' + n2(r.kostenbasis) + '</td>'
            + '<td>' + n2(r.erloese) + '</td>'
            + '<td>' + n2(r.gv_orig) + '</td>'
            + '<td>' + n2(r.kommission) + '</td>'
            + '<td>' + (r.waehrung || '') + '</td>'
            + '<td>' + d4(r.fx) + '</td>'
            + '<td style="font-weight:600;color:' + (korr ? 'var(--muted)' : col(r.gv_eur)) + '">' + n2(r.gv_eur) + '</td>'
            + '<td style="font-size:8.5px;color:var(--muted)">' + esc(r.anmerkung) + '</td></tr>';
    }

    function groupHtml(g) {
        var lbl = esc(g.key) + (g.desc ? ' · ' + esc(g.desc) : '') + (g.isin ? ' <span style="color:var(--muted)">' + g.isin + '</span>' : '');
        return '<details class="jr-grp"><summary><span>' + lbl + '</span>'
            + '<span style="color:' + col(g.total) + ';font-weight:600">' + n2(g.total) + ' €</span></summary>'
            + '<div class="jr-tablewrap"><table class="jr-table"><thead>' + head + '</thead><tbody>'
            + g.rows.map(rowHtml).join('')
            + '<tr class="jr-subtotal"><td colspan="10">Zwischensumme ' + esc(g.key) + '</td>'
            + '<td style="color:' + col(g.total) + '">' + n2(g.total) + '</td><td></td></tr>'
            + '</tbody></table></div></details>';
    }

    var html = '';
    ['Topf1', 'Topf2', 'KAP-INV'].forEach(function(k) {
        var blk = j[k];
        if (!blk || !blk.groups.length) return;
        html += '<div class="jr-topf"><div class="jr-topf-head"><span>' + esc(blk.label) + '</span>'
            + '<span style="color:' + col(blk.total) + '">Summe ' + n2(blk.total) + ' €</span></div>'
            + blk.groups.map(groupHtml).join('') + '</div>';
    });

    el.innerHTML = html
        ? '<div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin:4px 0 2px;">'
          + 'Prüffähiges Journal je Veräußerung (= Konvex-Excel-Export · Tageskurs-Korrektur je Lot)</div>' + html
        : '';
}

/** Anlage KAP-INV: je Fonds mit InvStG-Teilfreistellung. */
function _taxKonvexRenderKapInv(kap) {
    var el = document.getElementById('tax4-kapinv');
    if (!el) return;
    var rows = kap.by_isin || [];
    if (!rows.length) { el.innerHTML = ''; return; }
    var n2 = function(v) { return (v == null ? '—' : v.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })); };
    var cls = { aktienfonds: 'Aktienfonds (30 %)', mischfonds: 'Mischfonds (15 %)',
                immobilienfonds: 'Immobilienfonds (60/80 %)', sonstiger_fonds: 'Sonstiger Fonds (0 %)',
                ausland_immobilienfonds: 'Auslands-Immo. (80 %)' };
    var R = function(v) { return (v || 0) >= 0 ? 'var(--green)' : 'var(--red)'; };
    var body = rows.map(function(f) {
        var net = (f.gain || 0) + (f.loss || 0) + (f.div || 0);
        var netTax = (f.gain_taxable || 0) + (f.loss_taxable || 0) + (f.div_taxable || 0);
        return '<tr><td style="font-family:monospace;font-size:9px">' + f.isin + '</td>'
            + '<td style="color:var(--muted)">' + (cls[f.classification] || f.classification || '—') + '</td>'
            + '<td style="text-align:right">' + (f.tfs_rate != null ? (f.tfs_rate * 100).toFixed(0) + ' %' : '—') + '</td>'
            + '<td style="text-align:right;color:' + R(net) + '">' + n2(net) + '</td>'
            + '<td style="text-align:right;font-weight:600;color:' + R(netTax) + '">' + n2(netTax) + '</td></tr>';
    }).join('');
    var unknown = (kap.unknown_isins || []).length
        ? '<div style="font-size:10px;color:#fb923c;margin-top:6px">⚠️ ' + kap.unknown_isins.length
          + ' ISIN(s) ohne hinterlegte Klassifizierung → als „sonstiger Fonds" (0 % Teilfreistellung) behandelt: '
          + kap.unknown_isins.join(', ') + '. Bei einem Aktien-/Mischfonds wird zu viel besteuert.</div>'
        : '';
    el.innerHTML =
        '<details style="margin-top:16px" open><summary style="cursor:pointer;font-size:11px;color:var(--muted)">'
        + 'Anlage KAP-INV — ' + rows.length + ' Investmentfonds, netto (n. Teilfreistellung) ' + n2(kap.net_taxable) + ' €</summary>'
        + '<div style="overflow-x:auto;margin-top:6px"><table class="perf-table" style="min-width:560px;font-size:10px">'
        + '<thead><tr><th style="text-align:left">ISIN</th><th style="text-align:left">Klasse (Teilfreist.)</th>'
        + '<th style="text-align:right">TFS</th><th style="text-align:right">G/V brutto €</th>'
        + '<th style="text-align:right" title="nach Teilfreistellung">steuerpflichtig €</th></tr></thead>'
        + '<tbody>' + body + '</tbody></table></div>' + unknown + '</details>';
}

/** Devisen (Regel F) je Währung — IBKR-realisiert, FIFO über die Historie. */
function _taxKonvexRenderFx(fx) {
    var el = document.getElementById('tax4-fx');
    if (!el) return;
    var res = fx.results || {};
    var ccys = Object.keys(res);
    if (!ccys.length) { el.innerHTML = ''; return; }
    var n2 = function(v) { return (v == null ? '—' : v.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })); };
    var R = function(v) { return (v || 0) >= 0 ? 'var(--green)' : 'var(--red)'; };
    var body = ccys.sort().map(function(c) {
        var r = res[c];
        return '<tr><td><b>' + c + '</b></td>'
            + '<td style="text-align:right;color:var(--green)">' + n2(r.gain) + '</td>'
            + '<td style="text-align:right;color:var(--red)">' + n2(r.loss) + '</td>'
            + '<td style="text-align:right;font-weight:600;color:' + R(r.net) + '">' + n2(r.net) + '</td>'
            + '<td style="text-align:right;color:var(--muted)">' + (r.disposals || 0) + '</td>'
            + '<td style="text-align:right;color:var(--muted)">' + (r.days_negative || 0) + '</td></tr>';
    }).join('');
    el.innerHTML =
        '<details style="margin-top:10px"><summary style="cursor:pointer;font-size:11px;color:var(--muted)">'
        + 'Devisen (Regel F) je Währung — Netto ' + n2(fx.net) + ' € <span style="font-style:italic">(§20 Abs. 2 Nr. 7, FIFO)</span></summary>'
        + '<div style="overflow-x:auto;margin-top:6px"><table class="perf-table" style="min-width:480px;font-size:10px">'
        + '<thead><tr><th style="text-align:left">Währung</th><th style="text-align:right">Gewinn €</th>'
        + '<th style="text-align:right">Verlust €</th><th style="text-align:right">Netto €</th>'
        + '<th style="text-align:right" title="Veräußerungen">Verk.</th>'
        + '<th style="text-align:right" title="Tage mit negativem Saldo">Tage neg.</th></tr></thead>'
        + '<tbody>' + body + '</tbody></table></div></details>';
}

/** Erträge / Quellensteuer — DE vs. Ausland. */
function _taxKonvexRenderIncome(inc, fl) {
    var el = document.getElementById('tax4-income');
    if (!el) return;
    var n2 = function(v) { return (v == null ? '—' : v.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })); };
    var line = function(label, val, color) {
        return '<tr><td>' + label + '</td><td style="text-align:right;font-variant-numeric:tabular-nums;'
             + (color ? 'color:' + color : '') + '">' + n2(val) + ' €</td></tr>';
    };
    el.innerHTML =
        '<details style="margin-top:10px"><summary style="cursor:pointer;font-size:11px;color:var(--muted)">'
        + 'Erträge & Quellensteuer im Überblick</summary>'
        + '<div style="overflow-x:auto;margin-top:6px"><table class="perf-table" style="min-width:360px;font-size:10px"><tbody>'
        + line('Dividenden gesamt', inc.dividends)
        + line('— davon inländisch (Z.7)', inc.dividends_de, 'var(--muted)')
        + line('— davon ausländisch (Z.19)', inc.dividends_foreign, 'var(--muted)')
        + line('Zinsen', inc.interest)
        + line('gezahlte Zinsen (nicht abzugsfähig §20 Abs. 9)', inc.interest_paid, 'var(--muted)')
        + line('Ausländische Quellensteuer (anrechenbar)', inc.wht_foreign, 'var(--green)')
        + line('Inländische Quellensteuer', inc.wht_domestic, 'var(--muted)')
        + '</tbody></table></div>'
        + (fl && fl.funds_processed ? '<div style="font-size:9px;color:var(--muted);margin-top:4px">Plausibilität: '
            + fl.funds_processed + ' Cash-Transaktionen verarbeitet.</div>' : '')
        + '</details>';
}

/** Rendert ein Steuerjahr im PwC-Report-Stil (Klammern = negativ). */
function _taxRenderYear(d, filesYears) {
    // Beträge mit Minuszeichen (de-DE setzt das Minus automatisch)
    var pwc = function(v) {
        if (v == null) return '—';
        return v.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
    };
    var card = function(label, val, accent) {
        return '<div class="tax-card"><div class="tc-label">' + label + '</div>'
             + '<div class="tc-val" style="color:' + (accent || 'var(--text)') + '">' + pwc(val) + '</div></div>';
    };
    var cardsEl = document.getElementById('tax-cards');
    if (cardsEl) cardsEl.innerHTML =
          card('Ausländ. Kapitalerträge (Z.19)', d.line19_foreign, (d.line19_foreign || 0) < 0 ? 'var(--red)' : 'var(--green)')
        + card('Aktiengewinne (Z.20)', d.line20_aktien_gewinn, 'var(--green)')
        + card('Aktienverluste (Z.23)', d.line23_aktien_verlust, 'var(--red)')
        + card('Nicht-Aktien-Verluste (Z.22)', d.line22_sonstige_verlust, 'var(--red)');

    // PwC-Stil-Tabelle: [Zeile] [Bezeichnung] [Betrag]
    var r = function(line, label, val, indent, strong) {
        return '<tr class="pr-row"' + (strong ? ' style="font-weight:600"' : '') + '>'
             + '<td style="width:54px;color:var(--muted)">' + (line ? 'Zeile ' + line : '') + '</td>'
             + '<td style="' + (indent ? 'padding-left:16px;color:var(--muted)' : '') + '">' + label + '</td>'
             + '<td style="text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums">' + pwc(val) + '</td></tr>';
    };
    var sec = function(label) { return '<tr class="pr-section"><td colspan="3">' + label + '</td></tr>'; };

    var kap = document.getElementById('tax-kap');
    if (kap) kap.innerHTML =
          '<table class="pr-table" style="margin-top:14px"><colgroup><col style="width:54px"><col><col style="width:120px"></colgroup><tbody>'
        + sec('Kapitalerträge mit deutschem Steuerabzug')
        + r('7', 'Kapitalerträge', d.line7_inland_abgeltung)
        + sec('Kapitalerträge ohne deutschen Steuerabzug')
        + r('18', 'Inländische Kapitalerträge', d.line18_inland)
        + r('19', 'Ausländische Kapitalerträge', d.line19_foreign, false, true)
        + r('20', 'darin: Gewinne aus Aktienveräußerung', d.line20_aktien_gewinn, true)
        + r('22', 'darin: Verluste aus Nicht-Aktien', d.line22_sonstige_verlust, true)
        + r('23', 'darin: Verluste aus Aktienveräußerung', d.line23_aktien_verlust, true)
        + sec('Erträge (Detail)')
        + r('', 'Dividenden (gesamt)', d.dividends_eur)
        + r('', 'Zinsen', d.interest_eur)
        + r('', 'Anrechenbare ausländische Quellensteuer', d.withholding_eur)
        + r('', 'Termingeschäfte — Gewinne', d.futures_gewinn, true)
        + r('', 'Termingeschäfte — Verluste', d.futures_verlust, true)
        + '</tbody></table>';

    _taxRenderPositions(d.positions || []);

    var bd = document.getElementById('tax-breakdown');
    if (bd) bd.innerHTML =
          '<p class="settings-hint" style="margin-top:12px">Hochgeladene Jahre: <b>'
        + (filesYears || []).filter(Boolean).join(', ') + '</b> · Zeile 18 wird (mangels '
        + 'Emittenten-Klassifikation) nicht zuverlässig berechnet.</p>';
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  Gespeicherte Steuer-Dateien — Auto-Laden beim Öffnen + Verwaltung
 *  ----------------------------------------------------------------------------
 *  Hochgeladene IBKR-Statements werden serverseitig pro User gespeichert (Sorte
 *  "csv" für Steuer/Steuer +, "xml" für Steuer ++/Steuer +++). Beim Öffnen einer
 *  Seite (onShow) wird der gespeicherte Bestand automatisch ausgewertet, sodass
 *  kein erneuter Upload nötig ist. Upload und Auto-Laden teilen sich _taxRun().
 * ═══════════════════════════════════════════════════════════════════════════ */

var _TAX_CFG = {
    steuer4: { ep: '/api/tax/report-konvex', kind: 'xml', msg: 'tax4-msg', ind: 'tax4-stored', render: taxKonvexRender, loaded: false }
};

function _taxSetMsg(id, t, c) {
    var m = document.getElementById(id);
    if (m) { m.textContent = t; m.className = 'settings-msg ' + (c || ''); }
}

/** Zeigt „💾 N gespeicherte Datei(en) … · löschen" oder blendet aus. */
function _taxIndicator(cfg, files) {
    var el = document.getElementById(cfg.ind);
    if (!el) return;
    if (!files || !files.length) { el.style.display = 'none'; el.innerHTML = ''; return; }
    el.style.display = '';
    var esc = function (s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
    var chips = files.map(function (f) {
        return '<span class="tax-file-chip">📄 ' + esc(f)
            + '<a href="#" title="Diese Datei vom Server löschen" '
            + 'onclick="_taxDeleteFile(\'' + cfg.kind + '\',\'' + esc(f) + '\');return false;" '
            + 'class="tax-file-x">✕</a></span>';
    }).join('');
    el.innerHTML = '<div style="margin-bottom:4px">💾 <b>' + files.length
        + '</b> gespeicherte XML-Datei(en) auf dem Server '
        + '<a href="#" onclick="_taxClearStored(\'' + cfg.kind + '\');return false;" '
        + 'style="color:var(--red);font-size:10px;margin-left:6px">alle löschen</a></div>'
        + '<div class="tax-file-list">' + chips + '</div>'
        + '<div style="font-size:10px;color:var(--muted);margin-top:4px">Einzelne Jahres-XML zum '
        + 'Aktualisieren einfach neu hochladen (gleicher Name wird überschrieben, andere bleiben).</div>';
}

/** Sorten-Schwestern (gleiche Sorte) finden — für gemeinsame Indikator-/Status-Updates. */
function _taxSiblings(kind) {
    return Object.keys(_TAX_CFG).filter(function (k) { return _TAX_CFG[k].kind === kind; });
}

/**
 * Wertet aus. fileList = FileList → Upload (speichert serverseitig);
 * null → gespeicherten Bestand laden (Auto-Laden beim Öffnen).
 */
async function _taxRun(key, fileList) {
    var cfg = _TAX_CFG[key];
    if (!cfg) return;
    var files = fileList ? Array.prototype.slice.call(fileList) : [];
    var fd = new FormData();
    files.forEach(function (f) { fd.append('files', f); });
    _taxSetMsg(cfg.msg, files.length ? ('Verarbeite ' + files.length + ' Datei(en) …')
                                     : 'Lade gespeicherte Dateien … (kann kurz dauern)', '');
    try {
        var res = await fetch(cfg.ep, { method: 'POST', body: fd }).then(function (r) { return r.json(); });
        if (res && res.ok) {
            var src = res.source === 'upload' ? 'hochgeladen' : 'Server-Speicher';
            var years = (res.available_years || res.files_years || []).filter(Boolean).join(', ');
            _taxSetMsg(cfg.msg, '✓ ' + years + ' ausgewertet (' + src + ')'
                + (res.account ? ' · Konto ' + res.account : ''), 'ok');
            cfg.loaded = true;
            cfg.render(res);
            // Indikator auf allen Schwester-Seiten der Sorte aktualisieren
            _taxSiblings(cfg.kind).forEach(function (k) { _taxIndicator(_TAX_CFG[k], res.stored_files); });
        } else if (res && res.no_files) {
            _taxSetMsg(cfg.msg, 'Keine gespeicherten Dateien — bitte XML hochladen.', '');
            _taxSiblings(cfg.kind).forEach(function (k) {
                _TAX_CFG[k].loaded = false;
                _taxIndicator(_TAX_CFG[k], []);
                var box = document.getElementById(_TAX_CFG[k].ind.replace('-stored', '-result'));
                if (box) box.style.display = 'none';
            });
        } else {
            _taxSetMsg(cfg.msg, 'Fehler: ' + ((res && res.error) || 'unbekannt'), 'err');
        }
    } catch (e) {
        _taxSetMsg(cfg.msg, 'Fehler: ' + e.message, 'err');
    }
}

/** onShow-Hook: lädt den gespeicherten Bestand einmal pro Session automatisch. */
function taxAutoload(key) {
    var cfg = _TAX_CFG[key];
    if (!cfg || cfg.loaded) return;
    _taxRun(key, null);
}

/** Löscht den gespeicherten Bestand einer Sorte (xml|csv) → betrifft beide Seiten. */
async function _taxClearStored(kind) {
    if (!window.confirm('Alle gespeicherten ' + kind.toUpperCase() + '-Dateien auf dem Server löschen?')) return;
    try { await fetch('/api/tax/files?kind=' + encodeURIComponent(kind), { method: 'DELETE' }); }
    catch (e) { /* still UI zurücksetzen */ }
    _taxSiblings(kind).forEach(function (k) {
        var c = _TAX_CFG[k];
        c.loaded = false;
        _taxIndicator(c, []);
        _taxSetMsg(c.msg, 'Gespeicherte Dateien gelöscht.', '');
        var box = document.getElementById(c.ind.replace('-stored', '-result'));
        if (box) box.style.display = 'none';
    });
}

/** Löscht eine einzelne gespeicherte Datei und rechnet aus dem Rest neu. */
async function _taxDeleteFile(kind, name) {
    if (!window.confirm('Datei „' + name + '" vom Server löschen?')) return;
    try {
        await fetch('/api/tax/files?kind=' + encodeURIComponent(kind) + '&name=' + encodeURIComponent(name),
                    { method: 'DELETE' });
    } catch (e) { /* weiter, UI aktualisiert über _taxRun */ }
    var keys = _taxSiblings(kind);
    keys.forEach(function (k) { _TAX_CFG[k].loaded = false; });
    // Neu auswerten aus dem verbleibenden Bestand (aktualisiert Liste + Ergebnisse)
    _taxRun(keys[0] || 'steuer4', null);
}

/* ───────────────────────────────────────────────────────────────────────────
 *  SCREENER — Sektor-Screening (Finviz + yfinance), Background-Job + Polling
 * ─────────────────────────────────────────────────────────────────────────── */

var _SCR = {
    inited:    false,
    jobId:     null,
    pollTimer: null,
    indexes:   [],   // alle verfügbaren Indizes
    defaults:  ['Russell 2000'],
    filters:        [],   // Katalog [{group, items:[{code,label}]}]
    filterDefaults: [],   // voreingestellte Filter-Codes
    legend:         [],   // Finviz-Code-Referenz [{group, items:[{code,desc}]}]
    results:   {},   // letztes fertiges Ergebnis  { sector: [tickers] }
};

async function screenerInit() {
    if (_SCR.inited) return;
    _SCR.inited = true;
    try {
        var cfg = await fetch('/api/screener/config').then(function (r) { return r.json(); });
        _SCR.indexes        = cfg.indexes || [];
        _SCR.filters        = cfg.filters || [];
        _SCR.filterDefaults = cfg.filter_defaults || [];
        _SCR.legend         = cfg.legend || [];
    } catch (e) {
        _SCR.indexes = ['S&P 500', 'NASDAQ 100', 'DJIA', 'Russell 2000'];
    }
    var box = document.getElementById('scr-indexes');
    if (!box) return;
    box.innerHTML = '';
    _SCR.indexes.forEach(function (name) {
        var id = 'scr-idx-' + name.replace(/[^a-zA-Z0-9]/g, '');
        var lbl = document.createElement('label');
        lbl.innerHTML = '<input type="checkbox" id="' + id + '" data-idx="' + name + '"'
            + (_SCR.defaults.indexOf(name) >= 0 ? ' checked' : '') + '> '
            + name;
        box.appendChild(lbl);
    });

    // Filter-Katalog gruppiert rendern (Defaults vorausgewählt)
    var fbox = document.getElementById('scr-filters');
    if (fbox) {
        var esc = function (s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); };
        fbox.innerHTML = _SCR.filters.map(function (grp) {
            var checks = grp.items.map(function (it) {
                var on = _SCR.filterDefaults.indexOf(it.code) >= 0 ? ' checked' : '';
                return '<label title="' + esc(it.code) + '"><input type="checkbox" data-filter="'
                    + esc(it.code) + '"' + on + '> ' + esc(it.label) + '</label>';
            }).join('');
            return '<div class="scr-filter-grp"><span class="scr-filter-gname">' + esc(grp.group)
                + '</span><div class="scr-checks">' + checks + '</div></div>';
        }).join('');
    }

    // Finviz-Code-Legende rechts (Codes klickbar → ins Eigenfilter-Feld)
    var lbox = document.getElementById('scr-legend');
    if (lbox) {
        var escl = function (s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); };
        lbox.innerHTML = _SCR.legend.map(function (grp, gi) {
            var rows = grp.items.map(function (it) {
                return '<div class="scr-leg-row">'
                    + '<code class="scr-leg-code" data-code="' + escl(it.code) + '" title="Zum Eigenfilter hinzufügen">'
                    + escl(it.code) + '</code>'
                    + '<span class="scr-leg-desc">' + escl(it.desc) + '</span></div>';
            }).join('');
            return '<details class="scr-leg-grp"' + (gi === 0 ? ' open' : '') + '>'
                + '<summary>' + escl(grp.group) + '</summary>' + rows + '</details>';
        }).join('');
        lbox.querySelectorAll('.scr-leg-code').forEach(function (el) {
            el.addEventListener('click', function () { _scrAddCustomCode(el.dataset.code); });
        });
    }

    // Live-Hint für MarktCap
    function updateHint() {
        var mn = parseFloat(document.getElementById('scr-cap-min').value) || 0;
        var mx = parseFloat(document.getElementById('scr-cap-max').value) || 0;
        var unit = document.getElementById('scr-cap-unit').value;
        var hint = document.getElementById('scr-cap-hint');
        if (mn === 0 && mx === 0) {
            hint.textContent = '↳ 0 = keine Grenze → alle MarktCaps';
            hint.style.color = '';
        } else if (mn > 0 && mx > 0 && mn >= mx) {
            hint.textContent = '⚠ Min muss kleiner sein als Max';
            hint.style.color = 'var(--red)';
        } else {
            var parts = [];
            if (mn > 0) parts.push('≥ ' + mn + ' ' + unit);
            if (mx > 0) parts.push('≤ ' + mx + ' ' + unit);
            hint.textContent = '↳ Filter: ' + parts.join('  &  ');
            hint.style.color = '';
        }
    }
    ['scr-cap-min', 'scr-cap-max', 'scr-cap-unit'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.addEventListener('input', updateHint);
        if (el) el.addEventListener('change', updateHint);
    });
    updateHint();
}

function _scrSetState(label, cls) {
    var el = document.getElementById('scr-state');
    if (!el) return;
    el.textContent = label;
    el.className = 'settings-badge ' + (cls || '');
}

function _scrMsg(text, cls) {
    var el = document.getElementById('scr-msg');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'settings-msg' + (cls ? ' ' + cls : '');
}

function _scrSelectedIndexes() {
    var out = [];
    document.querySelectorAll('#scr-indexes input[type="checkbox"]').forEach(function (cb) {
        if (cb.checked) out.push(cb.dataset.idx);
    });
    return out;
}

/** Gewählte Katalog-Filter + eigene Finviz-Codes (kommagetrennt) → Liste. */
function _scrSelectedFilters() {
    var out = [];
    document.querySelectorAll('#scr-filters input[type="checkbox"]').forEach(function (cb) {
        if (cb.checked) out.push(cb.dataset.filter);
    });
    var custom = document.getElementById('scr-filters-custom');
    if (custom && custom.value) {
        custom.value.split(/[,\s]+/).forEach(function (c) {
            c = c.trim().toLowerCase();
            if (c && out.indexOf(c) < 0) out.push(c);
        });
    }
    return out;
}

/** Hängt einen Finviz-Code an das Eigenfilter-Feld an (Klick aus der Legende). */
function _scrAddCustomCode(code) {
    var inp = document.getElementById('scr-filters-custom');
    if (!inp) return;
    var parts = inp.value.split(/[,\s]+/).map(function (s) { return s.trim(); }).filter(Boolean);
    if (parts.indexOf(code) < 0) parts.push(code);
    inp.value = parts.join(', ');
    inp.focus();
}

async function screenerStart() {
    var indexes = _scrSelectedIndexes();
    if (!indexes.length) {
        _scrMsg('Mindestens einen Index auswählen', 'err');
        return;
    }
    var mn = parseFloat(document.getElementById('scr-cap-min').value) || 0;
    var mx = parseFloat(document.getElementById('scr-cap-max').value) || 0;
    if (mn > 0 && mx > 0 && mn >= mx) {
        _scrMsg('Min muss kleiner sein als Max', 'err');
        return;
    }

    _scrMsg('');
    document.getElementById('scr-btn-run').disabled = true;
    document.getElementById('scr-btn-export').disabled = true;
    document.getElementById('scr-btn-baskets').disabled = true;
    document.getElementById('scr-log-card').style.display = '';
    document.getElementById('scr-results-card').style.display = 'none';
    document.getElementById('scr-log').textContent = '';
    document.getElementById('scr-progress-wrap').style.display = '';
    document.getElementById('scr-progress-bar').style.width = '0%';
    _scrSetState('läuft …', 'run');

    var body = {
        indexes:  indexes,
        cap_min:  mn,
        cap_max:  mx,
        unit:     document.getElementById('scr-cap-unit').value,
        filters:  _scrSelectedFilters(),
    };

    try {
        var res = await fetch('/api/screener/run', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }).then(function (r) { return r.json(); });

        if (!res.ok) {
            _scrSetState('Fehler', 'err');
            _scrMsg(res.error || 'Start fehlgeschlagen', 'err');
            document.getElementById('scr-btn-run').disabled = false;
            return;
        }
        _SCR.jobId = res.job_id;
        _scrPoll();
    } catch (e) {
        _scrSetState('Fehler', 'err');
        _scrMsg('Netzwerkfehler: ' + e, 'err');
        document.getElementById('scr-btn-run').disabled = false;
    }
}

async function _scrPoll() {
    if (!_SCR.jobId) return;
    try {
        var s = await fetch('/api/screener/status/' + _SCR.jobId)
            .then(function (r) { return r.json(); });
        if (!s.ok) {
            _scrSetState('Fehler', 'err');
            _scrMsg(s.error || 'Job verloren', 'err');
            document.getElementById('scr-btn-run').disabled = false;
            return;
        }

        // Log
        document.getElementById('scr-log').textContent = (s.log || []).join('\n');
        var log = document.getElementById('scr-log');
        log.scrollTop = log.scrollHeight;

        // Progress
        var pct = Math.round((s.progress || 0) * 100);
        document.getElementById('scr-progress-bar').style.width = pct + '%';

        if (s.status === 'running') {
            _SCR.pollTimer = setTimeout(_scrPoll, 1500);
            return;
        }

        if (s.status === 'error') {
            _scrSetState('Fehler', 'err');
            _scrMsg(s.error || 'Screening fehlgeschlagen', 'err');
            document.getElementById('scr-btn-run').disabled = false;
            return;
        }

        // done
        _scrSetState('fertig', 'ok');
        _scrMsg('Screening abgeschlossen', 'ok');
        _SCR.results = s.results || {};
        document.getElementById('scr-btn-run').disabled = false;
        document.getElementById('scr-btn-export').disabled = false;
        document.getElementById('scr-btn-baskets').disabled = false;
        _scrRenderResults(_SCR.results);
    } catch (e) {
        _SCR.pollTimer = setTimeout(_scrPoll, 3000);
    }
}

function _scrRenderResults(results) {
    var card = document.getElementById('scr-results-card');
    var wrap = document.getElementById('scr-results');
    var badge = document.getElementById('scr-result-count');
    wrap.innerHTML = '';
    var sectors = Object.keys(results);
    var total = 0;
    sectors.forEach(function (name) {
        var tickers = results[name] || [];
        if (!tickers.length) return;
        total += tickers.length;
        var sec = document.createElement('div');
        sec.className = 'scr-sector';
        var head = document.createElement('div');
        head.className = 'scr-sector-head';
        head.innerHTML =
            '<span class="scr-sector-name">' + name + '</span>' +
            '<span class="scr-sector-count">' + tickers.length + '</span>';
        var list = document.createElement('div');
        list.className = 'scr-ticker-list';
        tickers.forEach(function (t) {
            var chip = document.createElement('span');
            chip.className = 'scr-ticker';
            chip.textContent = t;
            list.appendChild(chip);
        });
        sec.appendChild(head);
        sec.appendChild(list);
        wrap.appendChild(sec);
    });
    badge.textContent = total + ' Ticker';
    card.style.display = total ? '' : 'none';
}

function screenerExport() {
    if (!_SCR.jobId) return;
    window.location.href = '/api/screener/export/' + _SCR.jobId;
}

/* Legt pro Sektor einen Basket an (equal weight, qty=1 je Ticker).
   Name: "Screener {Sektor} {YYYY-MM-DD}". Existiert ein Basket mit
   identischem Namen, werden dessen Gewichte überschrieben. */
async function screenerToBaskets() {
    var results = _SCR.results || {};
    var sectors = Object.keys(results).filter(function (s) {
        return (results[s] || []).length > 0;
    });
    if (!sectors.length) {
        _scrMsg('Kein Ergebnis zum Übernehmen', 'err');
        return;
    }

    var d = new Date();
    var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
    var datum = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());

    // Bestehende Baskets nach Name indexieren (für Overwrite)
    var byName = {};
    Object.keys(baskets).forEach(function (id) {
        if (baskets[id] && baskets[id].name) byName[baskets[id].name] = id;
    });

    var created = 0, updated = 0, firstId = null;
    sectors.forEach(function (sector, i) {
        var tickers = results[sector];
        var weights = {};
        tickers.forEach(function (t) { weights[t] = 1; });

        var name = 'Screener ' + sector + ' ' + datum;
        var existingId = byName[name];
        if (existingId) {
            baskets[existingId].weights = weights;
            updated++;
            if (!firstId) firstId = existingId;
        } else {
            var id = 'basket_' + (Date.now() + i);  // +i = Kollisionen vermeiden
            baskets[id] = {
                name: name,
                weights: weights,
                period: 180, tf: '1D',
                perfSinceDate: '',
                indicators: { ma50: false, ma200: false, reg: false },
                logScale: false,
            };
            created++;
            if (!firstId) firstId = id;
        }
    });

    try {
        await saveBasketsToServer();
        if (typeof renderBasketSelect === 'function') renderBasketSelect();
        var summary = [];
        if (created) summary.push(created + ' neu');
        if (updated) summary.push(updated + ' aktualisiert');
        _scrMsg('Baskets: ' + summary.join(', '), 'ok');
    } catch (e) {
        _scrMsg('Speichern fehlgeschlagen: ' + e, 'err');
    }
}
