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
var chart, csSeries, volSeries, ma50S, ma200S, regS, regUS, regLS, ghostSeries, etfSeries;
var _ibkrCostLine      = null;   // Einstandskurs-Preislinie (wird pro Ticker neu gesetzt)
var _markersPlugin     = null;   // Chart-Primitive für die Trade-Pfeile
var _tradeMarkerData   = [];     // [{date, isBuy, qty, price, label}] — je Tag+Richtung
var _showTradeMarkers  = true;   // Toggle-Zustand
var _earningsPlugin    = null;   // Chart-Primitive für die Earnings-Linien
var _earningsData      = [];     // [{time, date, future, eps_est, eps_act}] — gesnappt, sichtbar
var _earningsRaw       = [];     // Rohdaten vom Backend zum aktuellen Ticker
var _earningsSym       = null;   // Ticker, zu dem _earningsRaw gehört
var _earningsReq       = 0;      // Race-Schutz (nur letzte Anfrage zählt)
var _showEarnings      = true;   // Toggle-Zustand Earnings-Linien
var _ghostDates        = [];     // zuletzt erzeugte Zukunfts-Datumswerte (Snapping künftiger Termine)
var _showSectorEtf     = false;  // Sektor-ETF-Overlay (relative Stärke), pro Basket gespeichert
var _etfDataCache      = {};     // ETF-Symbol → [{time, close}] (on-demand geladen)
var _etfSymbol         = null;   // aktuell overlaytes ETF-Symbol
var _etfCandles        = [];     // Tagesdaten des aktuellen ETFs (für Rebasing bei Zoom/Pan)
var _sectorEtfReq      = 0;      // Race-Schutz für async ETF-Laden
var _savedTimeRange    = null;   // Sichtbarer Zeitausschnitt beim Ticker-Wechsel

// Als Datum merken, nicht als Balken-Index: Zeitraum und Kerzenbreite gelten
// beim neuen Ticker sonst nur auf dem Papier (siehe clampVisibleRange).
function saveChartRange() {
    if (!chart) return;
    var r = chart.timeScale().getVisibleRange();
    if (!r) return;
    var from = chartTimeToStr(r.from), to = chartTimeToStr(r.to);
    if (from && to) _savedTimeRange = { from: from, to: to };
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
    chartPrefsChanged();
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

/**
 * Volumenprofil über einen Satz Kerzen: das Volumen jeder Kerze wird linear über
 * ihre High-Low-Spanne auf die Preiszeilen verteilt. Reines Rechnen, kein Zeichnen.
 * Gibt null zurück, wenn sich kein Profil bilden lässt.
 */
function computeVolumeProfile(candles, numBuckets) {
    if (!candles || !candles.length || !(numBuckets > 0)) return null;
    var priceMin = Infinity, priceMax = -Infinity;
    candles.forEach(function(c) {
        if (c.low  < priceMin) priceMin = c.low;
        if (c.high > priceMax) priceMax = c.high;
    });
    if (!(priceMin < priceMax)) return null;
    var bucketSize = (priceMax - priceMin) / numBuckets;
    var volumes = new Float64Array(numBuckets);
    candles.forEach(function(c) {
        var vol = c.volume || 0;
        if (!vol) return;
        var cRng = c.high - c.low;
        if (!(cRng > 0)) {
            // Kerze ohne Spanne (z.B. Handelsstopp): ganzes Volumen in ihre Zeile
            var idx = Math.min(numBuckets - 1, Math.max(0, Math.floor((c.close - priceMin) / bucketSize)));
            volumes[idx] += vol;
            return;
        }
        for (var i = 0; i < numBuckets; i++) {
            var bLow = priceMin + i * bucketSize, bHigh = bLow + bucketSize;
            var oLow = Math.max(c.low, bLow), oHigh = Math.min(c.high, bHigh);
            if (oHigh > oLow) volumes[i] += vol * (oHigh - oLow) / cRng;
        }
    });
    var maxVol = 0, pocIdx = 0;
    for (var j = 0; j < numBuckets; j++) {
        if (volumes[j] > maxVol) { maxVol = volumes[j]; pocIdx = j; }
    }
    if (!maxVol) return null;
    return { volumes: volumes, priceMin: priceMin, priceMax: priceMax,
             bucketSize: bucketSize, maxVol: maxVol, pocIdx: pocIdx };
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

    // Datenbasis sind die TAGESKERZEN, nicht die aggregierten des Timeframes.
    // Das Profil beschreibt den sichtbaren Preisbereich, nicht die Kerzenbreite:
    // aus einer Wochenkerze wüsste man nur „irgendwo zwischen Wochenhoch und
    // -tief", das Volumen würde über die ganze Spanne verschmiert und die POC
    // sprang beim Umschalten des Timeframes. allCandles liegt ohnehin geladen vor.
    var base = (typeof allCandles !== 'undefined' && allCandles && allCandles.length)
        ? allCandles : _lastCandles;
    var visCan = base.filter(function(c) { return c.time >= fromStr && c.time <= toStr; });
    if (!visCan.length) return;

    // Zeilenauflösung an die Bildhöhe koppeln (~6 px je Zeile) statt fester 24.
    // Sonst wird bei Wochen-/Monatskerzen — wo der Zeitraum und damit die
    // Preisspanne viel grösser ist — jede Zeile zu einem fetten Klotz.
    var priceMin = Infinity, priceMax = -Infinity;
    visCan.forEach(function(c) {
        if (c.low  < priceMin) priceMin = c.low;
        if (c.high > priceMax) priceMax = c.high;
    });
    if (!(priceMin < priceMax)) return;
    var yTopPx = csSeries.priceToCoordinate(priceMax);
    var yBotPx = csSeries.priceToCoordinate(priceMin);
    var pxSpan = (yTopPx !== null && yBotPx !== null) ? Math.abs(yBotPx - yTopPx) : canvas.height;
    var NUM_BUCKETS = Math.max(20, Math.min(100, Math.round(pxSpan / 6)));

    var profile = computeVolumeProfile(visCan, NUM_BUCKETS);
    if (!profile) return;
    var volumes = profile.volumes, maxVol = profile.maxVol, pocIdx = profile.pocIdx;
    var bucketSize = profile.bucketSize;
    priceMin = profile.priceMin; priceMax = profile.priceMax;

    var priceScaleW = 58;
    var maxBarW = Math.min(canvas.width * 0.15, 120);
    var barRight = canvas.width - priceScaleW;
    var barColor = chartColor('vrvpBar', 'vrvpAlpha');
    var pocColor = hexToRgba(chartColorValue('vrvpPoc'),
                             Math.min(1, chartColorValue('vrvpAlpha') + 0.25));
    for (var i = 0; i < NUM_BUCKETS; i++) {
        var bLow = priceMin + i * bucketSize, bHigh = bLow + bucketSize;
        var yTop    = csSeries.priceToCoordinate(bHigh);
        var yBottom = csSeries.priceToCoordinate(bLow);
        if (yTop === null || yBottom === null) continue;
        var barH = Math.max(1, Math.abs(yBottom - yTop) - 1);
        var barW = (volumes[i] / maxVol) * maxBarW;
        ctx.fillStyle = i === pocIdx ? pocColor : barColor;
        ctx.fillRect(barRight - barW, Math.min(yTop, yBottom), barW, barH);
    }
    var pocMid = priceMin + (pocIdx + 0.5) * bucketSize;
    var pocY   = csSeries.priceToCoordinate(pocMid);
    if (pocY !== null) {
        ctx.fillStyle = hexToRgba(chartColorValue('vrvpPoc'), 0.95);
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

// ── Protokoll-Seite ─────────────────────────────────────────────────────────
// logIt() (shared.js) ruft renderLog() nach jedem Eintrag. Damit ein Refresh mit
// hunderten Zeilen die Oberfläche nicht ausbremst, wird pro Frame nur einmal
// gezeichnet — und gar nicht, solange die Seite versteckt ist.

var _logRaf     = null;
var _LOG_HINTS  = {
    1: 'nur Fehler', 2: '+ Warnungen', 3: '+ Ergebnisse', 4: '+ Aktionen',
    5: '+ Teilschritte', 6: '+ Abrufe gebündelt', 7: '+ jeder Abruf',
    8: '+ Zeichnen', 9: '+ Zwischenwerte', 10: 'alles'
};

function renderLog(force) {
    var page = document.getElementById('view-log');
    if (!page) return;
    if (!force && !page.classList.contains('active')) return;   // versteckt → beim Öffnen via onShow
    if (_logRaf) return;
    _logRaf = requestAnimationFrame(function() { _logRaf = null; _renderLogNow(); });
}

function _renderLogNow() {
    var body = document.getElementById('logBody');
    if (!body) return;

    // Bedienelemente an den aktuellen Detailgrad angleichen
    var rng = document.getElementById('logLevelRange');
    var num = document.getElementById('logLevelNum');
    if (rng && String(rng.value) !== String(logLevel)) rng.value = logLevel;
    if (num && String(num.value) !== String(logLevel)) num.value = logLevel;
    var hint = document.getElementById('logLevelHint');
    if (hint) hint.textContent = _LOG_HINTS[logLevel] || '';

    var q = ((document.getElementById('logFilter') || {}).value || '').trim().toLowerCase();
    var shown = logEntries.filter(function(e) {
        if (e.lvl > logLevel) return false;
        if (!q) return true;
        return e.msg.toLowerCase().indexOf(q) >= 0 || e.tag.toLowerCase().indexOf(q) >= 0;
    });

    var cnt = document.getElementById('logCount');
    if (cnt) cnt.textContent = shown.length + ' / ' + logEntries.length + ' Zeilen';

    if (!shown.length) {
        body.innerHTML = '<div class="log-empty">Keine Einträge für Detailgrad ' + logLevel
            + (q ? ' und Filter „' + escHtml(q) + '"' : '') + '.</div>';
        return;
    }

    var html = shown.map(function(e) {
        var cls = e.lvl === 1 ? ' lvl-err' : e.lvl === 2 ? ' lvl-warn' : e.lvl >= 7 ? ' lvl-deep' : '';
        var t = e.t;
        var hhmmss = String(t.getHours()).padStart(2, '0') + ':'
                   + String(t.getMinutes()).padStart(2, '0') + ':'
                   + String(t.getSeconds()).padStart(2, '0') + '.'
                   + String(t.getMilliseconds()).padStart(3, '0');
        return '<div class="log-row' + cls + '">'
             + '<span class="log-time">' + hhmmss + '</span>'
             + '<span class="log-lv">' + e.lvl + '</span>'
             + '<span class="log-tag">' + escHtml(e.tag) + '</span>'
             + '<span class="log-msg">' + escHtml(e.msg) + '</span>'
             + '</div>';
    }).join('');
    body.innerHTML = html;

    var auto = document.getElementById('logAutoscroll');
    if (!auto || auto.checked) body.scrollTop = body.scrollHeight;
}

/** Sichtbare Zeilen in die Zwischenablage — für Rückfragen/Fehlersuche. */
function copyLog() {
    var text = logEntries.filter(function(e) { return e.lvl <= logLevel; }).map(function(e) {
        return e.t.toISOString() + '  [' + e.lvl + '] ' + (e.tag || '-') + ': ' + e.msg;
    }).join('\n');
    var done = function(ok) {
        logIt(1, 'Log', ok ? 'Protokoll kopiert' : 'Kopieren fehlgeschlagen — Text manuell markieren');
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function() { done(true); }, function() { done(false); });
    } else {
        done(false);
    }
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

    // Sektor-ETF-Overlay: eigene LINKE Preisskala (LWC zeichnet pro Seite nur eine
    // Achse; rechts liegen die Kerzen). Dadurch skaliert der ETF unabhängig von den
    // Kerzen und ist per Maus an der linken Achse zieh-/skalierbar. Standardmäßig leer.
    etfSeries = chart.addSeries(LightweightCharts.LineSeries, {
        color: '#e91e63', lineWidth: 2, lineStyle: 0,
        priceScaleId: 'left',
        lastValueVisible: true, priceLineVisible: false, crosshairMarkerVisible: false,
    });
    // Linke Achse: autoskaliert + maus-skalierbar; nur sichtbar wenn das Overlay aktiv ist.
    chart.priceScale('left').applyOptions({ visible: false, autoScale: true, borderVisible: false });

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
 * Fasst die IBKR-Trades des aktuellen Tickers zu Markergruppen zusammen —
 * eine je Handelstag und Richtung, mit mengengewichtetem Ausführungskurs und
 * Bestandslabel. Reines Rechnen, kein Zeichnen.
 */
function _tradeMarkerGroups() {
    var groups = [];
    if (_showTradeMarkers && currentView !== 'index' && ibkrTrades && ibkrTrades.length > 0) {
        // Partial fills aggregieren: ein Marker pro Tag + Richtung.
        // Auswahl und Bestandsanker kommen aus shared.js, damit die Pfeile im Chart
        // und die Tabelle im Trade-Fenster nie auseinanderlaufen.
        var relevantTrades = ibkrStockTrades(currentView);

        // Laufenden Bestand ab erster Transaktion berechnen — Startwert ist das,
        // was vor dem ersten bekannten Trade schon im Depot lag (siehe
        // ibkrCarryInQty). Dadurch endet der Verlauf immer auf dem echten Bestand.
        var runningQty = ibkrCarryInQty(currentView);

        // Pro Tag laufenden Bestand ermitteln
        var dateRunning = {};
        var tradeDates  = [];
        relevantTrades.forEach(function(t) {
            if (tradeDates.indexOf(t.trade_date) < 0) tradeDates.push(t.trade_date);
        });
        tradeDates.forEach(function(date) {
            relevantTrades.filter(function(t) { return t.trade_date === date; }).forEach(function(t) {
                var buy = (t.action || '').toUpperCase().indexOf('BUY') >= 0;
                runningQty += buy ? Math.abs(t.adj_quantity || 0) : -Math.abs(t.adj_quantity || 0);
            });
            dateRunning[date] = runningQty;
        });

        // Teilausführungen je Tag+Richtung zusammenfassen. Der Kurs wird dabei
        // mengengewichtet gemittelt — das ist die Höhe, auf der die Pfeilspitze sitzt.
        // Gerechnet wird mit adj_price/adj_quantity: die Kerzen sind split-bereinigt,
        // der Ausführungskurs aus dem Flex-Report ist es nicht. Ein Kauf vor einem
        // 4:1-Split saß sonst viermal zu hoch — Chart richtig, Pfeil daneben.
        var agg = {};
        relevantTrades.forEach(function(t) {
            if (!t.trade_date) return;
            var isBuy = (t.action || '').toUpperCase().indexOf('BUY') >= 0;
            var key = t.trade_date + (isBuy ? '_B' : '_S');
            if (!agg[key]) agg[key] = { date: t.trade_date, isBuy: isBuy, qty: 0, notional: 0 };
            var q = Math.abs(t.adj_quantity || 0);
            agg[key].qty      += q;
            agg[key].notional += q * (t.adj_price || 0);
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
            groups.push({
                date:  g.date,
                isBuy: g.isBuy,
                qty:   g.qty,
                price: g.qty > 0 ? g.notional / g.qty : 0,   // Ø-Ausführungskurs
                label: label
            });
        });
        groups.sort(function(a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
    }
    return groups;
}

/**
 * Setzt die Trade-Marker neu. Gezeichnet wird über ein Chart-Primitive
 * (siehe _makeTradeMarkerPrimitive) — nicht über createSeriesMarkers, weil dessen
 * Pfeile nur über/unter der Kerze sitzen können. Die Pfeilspitze soll aber genau
 * auf dem Ausführungskurs liegen, und dafür braucht es die Preis-Koordinate.
 */
function refreshTradeMarkers() {
    if (!csSeries) return;
    _tradeMarkerData = _tradeMarkerGroups();
    logIt(8, 'Chart', 'Trade-Marker: ' + _tradeMarkerData.length + ' Gruppen für ' + currentView);
    try {
        if (!_markersPlugin) {
            _markersPlugin = _makeTradeMarkerPrimitive();
            csSeries.attachPrimitive(_markersPlugin);
        }
        if (_markersPlugin.requestUpdate) _markersPlugin.requestUpdate();
    } catch (e) {
        logIt(1, 'Chart', 'Trade-Marker fehlgeschlagen: ' + e.message);
    }
}

/**
 * Ordnet ein Trade-Datum der Kerze zu, in die es fällt.
 * Nötig, weil bei Wochen-/Monats-Timeframe (und an Feiertagen) kein Balken mit
 * exakt diesem Datum existiert — timeToCoordinate() liefert dort nichts.
 * Rückgabe: Zeitschlüssel eines vorhandenen Balkens oder null.
 */
function _snapTradeTime(date) {
    var bars = _lastCandles;
    if (!bars || !bars.length) return null;
    if (date < bars[0].time) return null;                       // vor dem Chartbeginn
    var lo = 0, hi = bars.length - 1, best = 0;
    while (lo <= hi) {                                          // letzter Balken mit time <= date
        var mid = (lo + hi) >> 1;
        if (bars[mid].time <= date) { best = mid; lo = mid + 1; }
        else hi = mid - 1;
    }
    return bars[best].time;
}

/**
 * Chart-Primitive, das die Trade-Pfeile zeichnet.
 * Vorteil gegenüber einem eigenen Canvas-Overlay: das Chart ruft draw() bei JEDER
 * Änderung auf — auch beim Ziehen der Preisachse, was kein Zeitbereichs-Ereignis
 * auslöst. Die Pfeile bleiben dadurch immer auf ihrem Kurs kleben.
 */
function _makeTradeMarkerPrimitive() {
    var _update = null;
    return {
        attached: function(param) { _update = param.requestUpdate; },
        detached: function() { _update = null; },
        updateAllViews: function() {},
        requestUpdate: function() { if (_update) _update(); },
        paneViews: function() {
            return [{
                zOrder: function() { return 'top'; },
                renderer: function() { return { draw: _drawTradeMarkers }; }
            }];
        }
    };
}

function _drawTradeMarkers(target) {
    if (!_tradeMarkerData.length || !csSeries || !chart) return;
    target.useMediaCoordinateSpace(function(scope) {
        var ctx = scope.context;
        var ts  = chart.timeScale();

        var HEAD_H = 11;   // Länge der Pfeilspitze
        var HEAD_W = 5;    // halbe Breite der Pfeilspitze
        var SHAFT  = 9;    // Länge des Schafts hinter der Spitze
        var TICK   = 8;    // halbe Breite des Kursstrichs auf Ausführungshöhe

        ctx.save();
        ctx.font = '10px ui-monospace, Menlo, Consolas, monospace';
        ctx.textAlign = 'center';

        _tradeMarkerData.forEach(function(g) {
            var barTime = _snapTradeTime(g.date);
            if (barTime === null) return;
            var x = ts.timeToCoordinate(barTime);
            var y = csSeries.priceToCoordinate(g.price);
            if (x === null || y === null) return;
            if (x < -40 || x > scope.mediaSize.width + 40) return;   // außerhalb des Sichtbereichs

            var col  = g.isBuy ? '#00b8d4' : '#e05a00';   // gegenüber Cyan/Orange abgedunkelt: auf hellem Grund lesbar
            var dir  = g.isBuy ? 1 : -1;                  // Kauf: Schaft unterhalb, Spitze zeigt nach oben
            var tipY = y;                                 // <<< Pfeilspitze exakt auf dem Ausführungskurs
            var baseY = tipY + dir * HEAD_H;
            var endY  = baseY + dir * SHAFT;

            // Feiner Kursstrich auf Ausführungshöhe — macht das Ablesen eindeutig
            ctx.strokeStyle = col;
            ctx.globalAlpha = 0.55;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(x - TICK, tipY);
            ctx.lineTo(x + TICK, tipY);
            ctx.stroke();
            ctx.globalAlpha = 1;

            // Schaft
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(x, baseY);
            ctx.lineTo(x, endY);
            ctx.stroke();

            // Pfeilspitze (Dreieck, Spitze auf tipY)
            ctx.fillStyle = col;
            ctx.beginPath();
            ctx.moveTo(x, tipY);
            ctx.lineTo(x - HEAD_W, baseY);
            ctx.lineTo(x + HEAD_W, baseY);
            ctx.closePath();
            ctx.fill();

            // Beschriftung hinter dem Schaft, mit Hinterlegung gegen Kerzen/Gitter
            var ty = endY + dir * 11;
            var w  = ctx.measureText(g.label).width;
            ctx.fillStyle = 'rgba(255,255,255,0.82)';
            if (document.documentElement.getAttribute('data-theme') === 'dark') {
                ctx.fillStyle = 'rgba(20,21,26,0.82)';
            }
            ctx.fillRect(x - w / 2 - 3, ty - 8, w + 6, 12);
            ctx.fillStyle = col;
            ctx.fillText(g.label, x, ty + 2);
        });

        ctx.restore();
    });
}

// ── Earnings-Linien ──────────────────────────────────────────────────────────────
// Vertikale gestrichelte Linien an den Earnings-Terminen (Quartalszahlen). Nur bei
// Einzelaktien. Vergangene Termine dezent, der nächste (künftige) in Akzentfarbe.
// Gezeichnet über ein Chart-Primitive (wie die Trade-Marker), damit die Linien bei
// jeder Chart-Änderung — auch Preisachsen-Ziehen — an der richtigen Stelle bleiben.

/**
 * Ordnet ein Earnings-Datum dem nächstgelegenen vorhandenen Achsenpunkt zu
 * (Kerzen + Ghost-Zukunftstage). timeToCoordinate() liefert nur für tatsächliche
 * Achsenpunkte etwas — Earnings fallen sonst auf Wochenenden/Feiertage oder hinter
 * den letzten Balken in die Zukunft.
 */
function _snapEarningsTime(date) {
    var bars = _lastCandles;
    if (!bars || !bars.length) return null;
    // Vergangenheit / innerhalb der Kerzen: Balken, in den der Termin fällt (wie Trades)
    if (date <= bars[bars.length - 1].time) {
        if (date < bars[0].time) return null;   // vor dem Chartbeginn
        return _snapTradeTime(date);
    }
    // Zukunft: nächstgelegener Ghost-Tag
    if (!_ghostDates.length || date > _ghostDates[_ghostDates.length - 1]) return null;
    var best = _ghostDates[0], bestDiff = Infinity, tMs = new Date(date).getTime();
    for (var i = 0; i < _ghostDates.length; i++) {
        var diff = Math.abs(new Date(_ghostDates[i]).getTime() - tMs);
        if (diff < bestDiff) { bestDiff = diff; best = _ghostDates[i]; }
    }
    return best;
}

/**
 * Baut _earningsData (gesnappte, sichtbare Termine) neu auf und stößt das
 * Neuzeichnen an. Bei Index-Ansicht oder ausgeschaltetem Toggle → leer.
 */
function refreshEarnings() {
    if (!csSeries) return;
    _earningsData = [];
    var show = _showEarnings && currentView !== 'index' && _earningsSym === currentView;
    if (show) {
        _earningsRaw.forEach(function(e) {
            var t = _snapEarningsTime(e.date);
            if (t === null) return;
            _earningsData.push({ time: t, date: e.date, future: !!e.future,
                                 eps_est: e.eps_est, eps_act: e.eps_act });
        });
    }
    try {
        if (!_earningsPlugin) {
            _earningsPlugin = _makeEarningsPrimitive();
            csSeries.attachPrimitive(_earningsPlugin);
        }
        if (_earningsPlugin.requestUpdate) _earningsPlugin.requestUpdate();
    } catch (e) {
        logIt(1, 'Chart', 'Earnings-Linien fehlgeschlagen: ' + e.message);
    }
}

function _makeEarningsPrimitive() {
    var _update = null;
    return {
        attached: function(param) { _update = param.requestUpdate; },
        detached: function() { _update = null; },
        updateAllViews: function() {},
        requestUpdate: function() { if (_update) _update(); },
        paneViews: function() {
            return [{
                zOrder: function() { return 'normal'; },   // über den Kerzen, unter den Trade-Pfeilen
                renderer: function() { return { draw: _drawEarnings }; }
            }];
        }
    };
}

function _drawEarnings(target) {
    if (!_earningsData.length || !csSeries || !chart) return;
    var dark = document.documentElement.getAttribute('data-theme') === 'dark';
    target.useMediaCoordinateSpace(function(scope) {
        var ctx = scope.context;
        var ts  = chart.timeScale();
        var H   = scope.mediaSize.height;
        ctx.save();
        ctx.font = '9px ui-monospace, Menlo, Consolas, monospace';
        ctx.textAlign = 'center';

        _earningsData.forEach(function(e) {
            var x = ts.timeToCoordinate(e.time);
            if (x === null) return;
            if (x < -20 || x > scope.mediaSize.width + 20) return;   // außerhalb des Sichtbereichs

            var col = e.future
                ? (dark ? 'rgba(245,166,35,0.9)'  : 'rgba(214,137,0,0.95)')    // kommender Termin: Akzent
                : (dark ? 'rgba(150,160,185,0.5)' : 'rgba(90,100,120,0.42)');  // vergangene: dezent

            // Gestrichelte vertikale Linie (Label unten frei lassen)
            ctx.strokeStyle = col;
            ctx.lineWidth = e.future ? 1.4 : 1;
            ctx.setLineDash(e.future ? [5, 3] : [3, 3]);
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, H - 13);
            ctx.stroke();
            ctx.setLineDash([]);

            // Kleines "E"-Label unten knapp über der Zeitleiste, mit Hinterlegung
            var label = 'E';
            var w = ctx.measureText(label).width;
            ctx.fillStyle = dark ? 'rgba(20,21,26,0.85)' : 'rgba(255,255,255,0.85)';
            ctx.fillRect(x - w / 2 - 3, H - 12, w + 6, 12);
            ctx.fillStyle = col;
            ctx.fillText(label, x, H - 3);
        });

        ctx.restore();
    });
}

/** Holt die Earnings-Termine (serverseitig gecacht) und zeichnet die Linien. */
async function fetchEarnings(sym) {
    var req = ++_earningsReq;
    try {
        var res = await fetch('/api/earnings/' + encodeURIComponent(sym))
                        .then(function(r) { return r.json(); });
        if (req !== _earningsReq || currentView !== sym) return;   // Ansicht hat gewechselt
        _earningsRaw = (res && res.ok && res.earnings) ? res.earnings : [];
        _earningsSym = sym;
        refreshEarnings();
    } catch (e) {
        if (req === _earningsReq && currentView === sym) {
            _earningsRaw = []; _earningsSym = sym; refreshEarnings();
        }
    }
}

/** Toolbar-Toggle: Earnings-Linien ein/ausblenden. */
function toggleEarnings(btn) {
    _showEarnings = !_showEarnings;
    if (btn) btn.classList.toggle('active', _showEarnings);
    chartPrefsChanged();
    refreshEarnings();
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
        if (etfSeries) { try { etfSeries.setData([]); } catch(e) {} _setEtfAxisVisible(false); }
        return;
    }

    // IBKR Einstandskurs + Trade-Marker
    refreshIbkrCostLine(colored);
    refreshTradeMarkers();
    refreshSectorEtf();   // Sektor-ETF-Overlay (falls aktiv)

    // Ghost-Serie: Zukunftsdaten für Zeitachsenbeschriftung
    if (ghostSeries && colored.length) {
        var lastC    = colored[colored.length - 1];
        var count    = currentTF === '1W' ? 52 : currentTF === '1M' ? 12 : 252;
        var fDates   = generateFutureDates(lastC.time, currentTF, count);
        _ghostDates  = fDates;   // für das Snapping künftiger Earnings-Termine
        try {
            ghostSeries.setData(fDates.map(function(d) { return { time: d, value: lastC.close }; }));
        } catch(e) {}
    }

    // Earnings-Linien (nach Ghost-Daten: künftige Termine brauchen die Zukunftsachse)
    refreshEarnings();

    // Volumen
    if (volSeries && volAgg.length) {
        var cmap = {};
        colored.forEach(function(c) { cmap[c.time] = c.color; });
        // Index-View: normiert (Durchschnitt=100), da Volumen dort eine gewichtete Hilfsgröße ist.
        // Ticker-View: echtes Volumen in Stückzahl (wie TradingView).
        var volUp   = chartColor('volUp',   'volAlpha');
        var volDown = chartColor('volDown', 'volAlpha');
        var volColor = function(t) { return cmap[t] === '#2d8a4e' ? volUp : volDown; };
        var volData;
        if (currentView === 'index') {
            var volSum = volAgg.reduce(function(s, v) { return s + (v.volume || 0); }, 0);
            var volAvg = volSum / volAgg.length || 1;
            volData = volAgg.map(function(v) {
                return {
                    time:  v.time,
                    value: (v.volume || 0) / volAvg * 100,
                    color: volColor(v.time),
                };
            });
        } else {
            volData = volAgg.map(function(v) {
                return {
                    time:  v.time,
                    value: v.volume || 0,
                    color: volColor(v.time),
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

    // Sichtbaren Zeitausschnitt wiederherstellen (Ticker-Wechsel) oder einpassen.
    // Das Fenster wird auf die Daten des neuen Tickers begrenzt, inklusive der
    // Ghost-Tage rechts — sonst rutscht der Ausschnitt beim Wechsel nach links.
    if (_savedTimeRange !== null) {
        var _want = _savedTimeRange;
        _savedTimeRange = null;
        var _last = (_ghostDates && _ghostDates.length)
            ? _ghostDates[_ghostDates.length - 1]
            : colored[colored.length - 1].time;
        var _range = clampVisibleRange(_want, colored[0].time, _last);
        // Preisachse für den neuen Ticker einmal neu einpassen. Ohne das bliebe die
        // Skala des vorherigen stehen (autoScale wird nach jedem Einpassen wieder
        // abgeschaltet, damit gezogene Achsen halten) — beim Sprung von einem
        // 90-Dollar- auf einen 500-Dollar-Wert läge der Kurs dann ausserhalb des Bildes.
        csSeries.priceScale().applyOptions({ autoScale: true });
        if (etfSeries) { try { etfSeries.priceScale().applyOptions({ autoScale: true }); } catch(e) {} }
        requestAnimationFrame(function() {
            if (!chart) return;
            if (_range) {
                try { chart.timeScale().setVisibleRange(_range); } catch(e) { fitWithFuture(); }
            } else {
                fitWithFuture();
            }
            requestAnimationFrame(function() {
                if (csSeries) try { csSeries.priceScale().applyOptions({ autoScale: false }); } catch(e) {}
            });
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
    // Sektor-ETF (eigene linke Achse) ebenfalls neu einpassen — autoScale wieder an,
    // falls der Nutzer die Achse zuvor manuell gezogen hatte.
    if (etfSeries) { try { etfSeries.priceScale().applyOptions({ autoScale: true }); } catch(e) {} }
    var candles = allCandles;
    if (!candles || !candles.length) { chart.timeScale().fitContent(); return; }
    var toDate   = candles[candles.length - 1].time;
    var fromDate;
    if (currentPeriod > 0) {
        var cut = new Date();
        cut.setDate(cut.getDate() - currentPeriod);
        // gleiche Kante wie applyPeriod(): bei Wochen-/Monatskerzen der Anfang der
        // angeschnittenen Periode, sonst stünde die erste Kerze halb im Bild
        fromDate = (typeof periodStartFor === 'function')
            ? periodStartFor(cut.toISOString().slice(0, 10), currentTF)
            : cut.toISOString().slice(0, 10);
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

    // Die übrigen Chart-Schalter — sie gelten ebenfalls benutzerweit und werden
    // beim Start aus der Config geladen, also hier mitgezogen.
    var bvrvp = document.getElementById('bvrvp');
    if (bvrvp) bvrvp.classList.toggle('ind-active', !!_vrvpEnabled);
    var btrd = document.getElementById('btn-trades-toggle');
    if (btrd) btrd.classList.toggle('active', !!_showTradeMarkers);
    var bearn = document.getElementById('btn-earnings');
    if (bearn) bearn.classList.toggle('active', !!_showEarnings);

    // Sektor-ETF-Button an den (in loadBasketState geladenen) Zustand angleichen.
    updateSectorEtfBadge(_showSectorEtf ? 'pending' : null);
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

    // Im IBKR-Basket zusätzlich Depotanteil und Positionsgröße je Ticker
    var ibkrVals = ibkrWatchlistValues();

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

        // Zweite Zeile links: "4,2 % · 12.300 €". Der Betrag verschwindet per
        // Container-Abfrage, sobald das Fenster zu schmal wird.
        var metaHtml = '';
        if (ibkrVals && ibkrVals.value[sym] !== undefined) {
            var val   = ibkrVals.value[sym];
            var share = ibkrVals.depot ? (val / ibkrVals.depot * 100) : null;
            metaHtml = '<div class="wl-meta">'
                + (share !== null
                    ? '<span class="wl-share">' + share.toLocaleString('de-DE', {
                          minimumFractionDigits: 1, maximumFractionDigits: 1 }) + '&nbsp;%</span>'
                    : '')
                + '<span class="wl-size"> · ' + Math.round(val).toLocaleString('de-DE') + '&nbsp;€</span>'
                + '</div>';
        }

        div.innerHTML = '<div class="wl-left">'
            + '<div class="wl-sym">' + logoHtml + sym + '</div>'
            + metaHtml
            + '</div>'
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

/** Aktualisiert Wasserzeichen, Stammdaten- und Trade-Fenster zur aktuellen Ansicht. */
function updateChartMeta() {
    if (typeof currentView === 'undefined') return;
    if (currentView === 'index') {
        var name = (typeof baskets !== 'undefined' && baskets[currentBasket])
            ? baskets[currentBasket].name : 'Index';
        setChartWatermark(name);
        renderTickerInfo(null);            // Stammdaten nur für Einzelaktien
        renderTickerTradesPane(null);
        _earningsRaw = []; _earningsSym = null; refreshEarnings();   // keine Earnings im Index
    } else {
        setChartWatermark(currentView);
        renderTickerTradesPane(currentView);
        if (_tickerInfoCache[currentView]) {
            renderTickerInfo(_tickerInfoCache[currentView]);
        } else {
            renderTickerInfo({ loading: true, symbol: currentView });
            fetchTickerInfo(currentView);
        }
        // Earnings-Termine: aus Cache neu zeichnen oder frisch holen
        if (_earningsSym === currentView) refreshEarnings();
        else fetchEarnings(currentView);
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
        if (_showSectorEtf) refreshSectorEtf();   // Sektor jetzt bekannt → Overlay auflösen
    } catch (e) {
        if (req === _tickerInfoReq && currentView === sym) renderTickerInfo({ error: true, symbol: sym });
    }
}

/** Rendert das Stammdaten-Fenster. null → Platzhalter (Index-Ansicht).
    Die eigenen Trades stehen in einem eigenen Fenster (renderTickerTradesPane),
    damit sie sichtbar bleiben, wenn die Stammdaten zugeklappt sind. */
function renderTickerInfo(d) {
    var el = document.getElementById('ticker-info');
    if (!el) return;
    if (!d)        { el.innerHTML = '<div class="ti-loading">Einzelaktie wählen für Stammdaten.</div>'; return; }
    if (d.loading) { el.innerHTML = '<div class="ti-loading">Lade Stammdaten …</div>'; return; }
    if (d.error)   { el.innerHTML = '<div class="ti-loading">Keine Stammdaten verfügbar</div>'; return; }

    var esc = escHtml;
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

/** Rendert das Trade-Fenster unter den Stammdaten. null → Platzhalter. */
function renderTickerTradesPane(sym) {
    var el = document.getElementById('ticker-trades');
    if (!el) return;
    if (!sym || sym === 'index') {
        el.innerHTML = '<div class="ti-loading">Einzelaktie wählen für eigene Trades.</div>';
        return;
    }
    var html = renderTickerTrades(sym);
    el.innerHTML = html || '<div class="ti-loading">Keine eigenen Trades zu '
                         + escHtml(sym) + '.</div>';
}

/**
 * Eigene IBKR-Trades des angezeigten Tickers als HTML-Block für das Trade-Fenster.
 * Zuordnung über ibkrTradeYahoo() (ISIN vor Symbol) — dieselbe Logik wie die
 * Chart-Marker, damit Tabelle und Pfeile nie auseinanderlaufen.
 * Gibt '' zurück, wenn es zu diesem Ticker nichts zu zeigen gibt.
 */
function renderTickerTrades(sym) {
    // Dieselbe Auswahl wie die Chart-Pfeile (shared.js), damit beide dasselbe zeigen.
    var mine = ibkrStockTrades(sym).reverse();   // neueste zuerst
    if (!mine.length) return '';

    // Kennzahlen über alle Trades: Stückzahl, Volumen, Ø-Kurs je Richtung.
    // Split-bereinigt (adj_*), damit Stückzahlen aus verschiedenen Epochen
    // überhaupt addierbar sind und der Ø-Kurs auf derselben Skala liegt wie
    // Chart und Einstandslinie. Der Gegenwert bleibt davon unberührt.
    var buyQty = 0, sellQty = 0, buyVal = 0, sellVal = 0, feeEur = 0;
    var hasSplit = false;
    mine.forEach(function(t) {
        var q = Math.abs(t.adj_quantity || 0);
        var p = t.adj_price || 0;
        if (Math.abs((t.split_factor || 1) - 1) > 1e-9) hasSplit = true;
        feeEur += Math.abs(t.commission || 0) * (t.fx_rate || 1);
        if ((t.action || '').toUpperCase().indexOf('BUY') >= 0) { buyQty += q; buyVal += q * p; }
        else { sellQty += q; sellVal += q * p; }
    });
    var cur  = tickerCurrencies[sym] || '';
    var curS = tickerCurSymbol(sym);
    var f2   = function(v) { return Number(v).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
    var fq   = function(v) { return v === Math.floor(v) ? String(v) : f2(v); };

    // Bestand ist der echte IBKR-Stand, nicht „Käufe minus Verkäufe": reicht die
    // Flex-Historie nicht weit genug zurück, ergäbe die Differenz Unsinn (z.B. -4
    // für eine glatt geschlossene Position). carryIn ≠ 0 zeigt genau diese Lücke an.
    var qty     = ibkrCurrentQty(sym);
    var carryIn = ibkrCarryInQty(sym);

    // Split-Verhältnis lesbar machen: 4 → „4:1", 0.1 → „1:10"
    var splitLabel = function(f) {
        return f >= 1 ? (Math.round(f * 100) / 100) + ':1' : '1:' + (Math.round(100 / f) / 100);
    };

    var head = '<div class="tt-head">'
        + '<span class="tt-title">Eigene Trades (' + mine.length + ')</span>'
        + (hasSplit ? '<span class="tt-kpi tt-adj" title="Dieser Ticker hatte einen Split. '
                      + 'Stückzahlen und Ø-Kurse oben sind auf die heutige Skala gerechnet, '
                      + 'die Tabelle unten zeigt die historisch gehandelten Werte.">'
                      + '↕ split-bereinigt</span>' : '')
        + (buyQty  ? '<span class="tt-kpi"><b style="color:var(--green)">Kauf</b> ' + fq(buyQty)
                     + ' Ø ' + curS + f2(buyVal / buyQty) + '</span>' : '')
        + (sellQty ? '<span class="tt-kpi"><b style="color:var(--red)">Verkauf</b> ' + fq(sellQty)
                     + ' Ø ' + curS + f2(sellVal / sellQty) + '</span>' : '')
        + '<span class="tt-kpi">Bestand ' + fq(qty) + '</span>'
        + (Math.abs(carryIn) > 1e-9
            ? '<span class="tt-kpi" title="Vor dem ältesten hier gelisteten Trade lagen bereits '
              + fq(carryIn) + ' Stück im Depot — die Flex-Historie reicht nicht weiter zurück.">'
              + '⚠ Vorbestand ' + fq(carryIn) + '</span>' : '')
        + (feeEur ? '<span class="tt-kpi">Gebühren ' + f2(feeEur) + ' €</span>' : '')
        + '</div>';

    var rows = mine.map(function(t) {
        var isBuy = (t.action || '').toUpperCase().indexOf('BUY') >= 0;
        var q     = Math.abs(t.quantity || 0);
        var valEur = Math.abs(t.value || 0) * (t.fx_rate || 1);
        // Bei Trades von vor einem Split zusätzlich den Wert auf heutiger Skala
        // zeigen — sonst widerspricht die Zeile scheinbar dem Chart.
        var sf    = t.split_factor || 1;
        var split = Math.abs(sf - 1) > 1e-9;
        var tip   = split ? ' title="Nach ' + splitLabel(sf) + '-Split: heute '
                            + fq(Math.abs(t.adj_quantity || 0)) + ' Stück zu '
                            + curS + f2(t.adj_price || 0) + '"' : '';
        return '<tr' + tip + '>'
            + '<td class="tt-date">' + escHtml((t.trade_date || '').slice(0, 10)) + '</td>'
            + '<td class="tt-act" style="color:' + (isBuy ? 'var(--green)' : 'var(--red)') + '">'
            +   (isBuy ? 'Kauf' : 'Verkauf') + '</td>'
            + '<td class="tt-num">' + fq(q)
            +   (split ? ' <span class="tt-adj">(' + fq(Math.abs(t.adj_quantity || 0)) + ')</span>' : '')
            + '</td>'
            + '<td class="tt-num">' + curS + f2(t.price || 0)
            +   (split ? ' <span class="tt-adj">(' + curS + f2(t.adj_price || 0) + ')</span>' : '')
            + '</td>'
            + '<td class="tt-num">' + f2(valEur) + ' €</td>'
            + '<td class="tt-sym">' + escHtml(t.symbol || '') + (cur ? ' · ' + escHtml(cur) : '') + '</td>'
            + '</tr>';
    }).join('');

    return '<div class="ti-trades">' + head
         + '<table class="tt-table"><thead><tr>'
         + '<th>Datum</th><th>Art</th><th class="tt-num">Anz.</th>'
         + '<th class="tt-num">Kurs</th><th class="tt-num">Wert</th><th>IBKR-Symbol</th>'
         + '</tr></thead><tbody>' + rows + '</tbody></table></div>';
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

// ── Layout: Größen + geschlossene Fenster ──────────────────────────────────
// _layout reist als Teil der Server-Config mit (shared.js → /api/config):
//   { rightColW: 300, panes: { 'r-perf': { h: 200, hidden: false }, … } }
// Frühere Konfigurationen kannten nur feste Schlüssel (rPerfH, stammH, …) —
// die werden beim ersten Laden einmalig übersetzt.
// Die Variable _layout selbst steht in shared.js (Mobile reicht sie durch).

/* Alle schließ- und größenveränderbaren Fenster der Chart-Seite, in DOM-Reihenfolge
   je Spalte. #r-watch trägt keine feste Höhe, es füllt seine Spalte aus. */
var LAYOUT_PANES_LEFT  = ['r-stammdaten', 'r-trades'];
var LAYOUT_PANES_RIGHT = ['r-watch', 'r-perf', 'r-notes', 'r-import'];
var LAYOUT_PANES       = LAYOUT_PANES_LEFT.concat(LAYOUT_PANES_RIGHT);

/* Übersetzung der alten, festen Layout-Schlüssel auf die Fenster-IDs. */
var _LAYOUT_LEGACY_H = {
    'r-stammdaten': 'stammH', 'r-perf': 'rPerfH',
    'r-notes': 'rNotesH', 'r-import': 'rImportH',
};

function _isResizer(el) {
    return !!el && (el.classList.contains('lv-resizer') || el.classList.contains('rv-resizer'));
}

/* Mindesthöhe eines Fensters — steht als data-min-h im HTML. */
function _paneMinH(el) {
    return parseInt((el && el.getAttribute('data-min-h')) || '', 10) || 60;
}

/* Elastisch = wächst mit der Spalte, bekommt deshalb nie eine feste Höhe. */
function _paneFlex(el) {
    return !!el && parseFloat(getComputedStyle(el).flexGrow || '0') > 0;
}

function _paneHidden(id) {
    var p = (_layout.panes || {})[id];
    return !!(p && p.hidden);
}

function _paneName(id) {
    var el = document.getElementById(id);
    return (el && el.getAttribute('data-pane-name')) || id;
}

/* Nächster sichtbarer Nachbar eines Trenners (dir -1 = oben, +1 = unten).
   Geschlossene Fenster werden übersprungen, damit ein Trenner immer die
   beiden Fenster bewegt, die tatsächlich an ihm hängen. */
function _neighborPane(res, dir) {
    var el = dir < 0 ? res.previousElementSibling : res.nextElementSibling;
    while (el) {
        if (!_isResizer(el) && el.style.display !== 'none') return el;
        el = dir < 0 ? el.previousElementSibling : el.nextElementSibling;
    }
    return null;
}

function saveLayout() {
    var rc    = document.getElementById('right-col');
    var panes = {};
    LAYOUT_PANES.forEach(function (id) {
        var el = document.getElementById(id);
        if (!el) return;
        var prev   = (_layout.panes || {})[id] || {};
        var hidden = !!prev.hidden;
        // Höhe nur messen, solange das Fenster offen ist — sonst die gemerkte behalten.
        var h = prev.h != null ? prev.h : null;
        if (!hidden && !_paneFlex(el)) h = el.offsetHeight;
        panes[id] = { h: h, hidden: hidden };
    });
    var w = _layout.rightColW != null ? _layout.rightColW : null;
    if (rc && rc.style.display !== 'none' && rc.offsetWidth > 0) w = rc.offsetWidth;
    _layout = { rightColW: w, panes: panes };
    saveBasketsToServer();
}

function loadLayout() {
    var lay = _layout || {};
    if (!lay.panes) {                       // alte Konfiguration übersetzen
        lay.panes = {};
        Object.keys(_LAYOUT_LEGACY_H).forEach(function (id) {
            var v = lay[_LAYOUT_LEGACY_H[id]];
            if (v != null) lay.panes[id] = { h: v, hidden: false };
        });
        _layout = lay;
    }
    var rc = document.getElementById('right-col');
    if (lay.rightColW != null && rc) rc.style.width = lay.rightColW + 'px';
    LAYOUT_PANES.forEach(function (id) {
        var el = document.getElementById(id);
        var p  = lay.panes[id];
        if (!el || !p || p.h == null || _paneFlex(el)) return;
        el.style.height = p.h + 'px';
    });
    applyPaneVisibility();
}

/* Setzt die Sichtbarkeit aller Fenster und räumt hinterher auf: Trenner ohne
   zwei Nachbarn verschwinden, eine leere rechte Spalte gibt ihre Breite an den
   Chart ab, und je Spalte füllt ein Fenster den Rest aus. */
function applyPaneVisibility() {
    LAYOUT_PANES.forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.style.display = _paneHidden(id) ? 'none' : '';
    });

    var rightCol   = document.getElementById('right-col');
    var colRes     = document.getElementById('col-resizer');
    var rightEmpty = LAYOUT_PANES_RIGHT.every(_paneHidden);
    if (rightCol) rightCol.style.display = rightEmpty ? 'none' : '';
    if (colRes)   colRes.style.display   = rightEmpty ? 'none' : '';

    _syncGrow(LAYOUT_PANES_RIGHT);
    _syncResizers(document.getElementById('left-col'));
    if (!rightEmpty) _syncResizers(rightCol);

    renderHiddenPaneInfo();
    if (typeof chart !== 'undefined' && chart) fitChart();
}

/* Je Lücke zwischen zwei sichtbaren Fenstern bleibt genau ein Trenner stehen.
   Wichtig, wenn mittendrin ein Fenster geschlossen ist: sonst stünden dessen
   beide Trenner direkt übereinander und würden dasselbe Paar bewegen. */
function _syncResizers(col) {
    if (!col) return;
    var seenPane = false;   // liegt oberhalb überhaupt ein sichtbares Fenster?
    var claimed  = false;   // ist der Trenner dieser Lücke schon vergeben?
    var trailing = null;    // Trenner ohne Fenster darunter → am Ende ausblenden
    Array.prototype.forEach.call(col.children, function (el) {
        if (_isResizer(el)) {
            var take = seenPane && !claimed;
            el.style.display = take ? '' : 'none';
            if (take) { claimed = true; trailing = el; }
            return;
        }
        if (el.style.display === 'none') return;   // geschlossenes Fenster überspringen
        seenPane = true;
        claimed  = false;                          // ab hier beginnt die nächste Lücke
        trailing = null;
    });
    if (trailing) trailing.style.display = 'none';
}

/* Ohne elastisches Fenster bliebe unten in der Spalte Luft — dann wächst das
   unterste sichtbare Fenster. #r-watch ist von Haus aus elastisch. */
function _syncGrow(ids) {
    var visible = [];
    ids.forEach(function (id) {
        var el = document.getElementById(id);
        if (!el) return;
        el.classList.remove('pane-grow');
        if (!_paneHidden(id)) visible.push(el);
    });
    if (!visible.length) return;
    var natural = document.getElementById(ids[0]);
    if (natural && !_paneHidden(ids[0])) return;   // #r-watch offen → nichts zu tun
    var last = visible[visible.length - 1];
    last.classList.add('pane-grow');
    last.style.height = '';
}

/* Schließt ein Fenster (× in der Kopfzeile). Die Höhe wird gemerkt, damit sie
   beim Wiederöffnen noch stimmt. */
function hidePane(id) {
    if (!_layout.panes) _layout.panes = {};
    var p  = _layout.panes[id] || (_layout.panes[id] = {});
    var el = document.getElementById(id);
    if (el && !p.hidden && !_paneFlex(el)) p.h = el.offsetHeight;
    p.hidden = true;
    applyPaneVisibility();
    saveLayout();
    logIt(3, 'Layout', 'Fenster „' + _paneName(id) + '" geschlossen');
}

/* Öffnet alle Fenster wieder und setzt sämtliche Größen auf die Vorgabe zurück.
   Knopf auf der Einstellungsseite. */
async function restoreLayout(btn) {
    var label = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '…'; }
    LAYOUT_PANES.forEach(function (id) {
        var el = document.getElementById(id);
        if (!el) return;
        el.style.display = '';
        el.style.height  = '';
        el.classList.remove('pane-grow');
    });
    var rc = document.getElementById('right-col');
    if (rc) { rc.style.display = ''; rc.style.width = ''; }
    _layout = { rightColW: null, panes: {} };
    applyPaneVisibility();
    try {
        await saveBasketsToServer();
        logIt(3, 'Layout', 'Alle Fenster geöffnet, Größen zurückgesetzt');
    } catch (e) {
        logIt(1, 'Layout', 'Zurücksetzen konnte nicht gespeichert werden: ' + e.message);
    }
    if (btn) { btn.disabled = false; btn.textContent = label; }
}

/* Zeigt auf der Einstellungsseite, welche Fenster gerade geschlossen sind. */
function renderHiddenPaneInfo() {
    var el = document.getElementById('set-hidden-panes');
    if (!el) return;
    var names = LAYOUT_PANES.filter(_paneHidden).map(_paneName);
    el.textContent = names.length ? names.join(' · ') : 'keine — alle Fenster offen';
}

(function() {
    /* Senkrechter Trenner. Er greift sich beim Anfassen seine beiden nächsten
       sichtbaren Nachbarn — dadurch stimmt er auch, wenn dazwischen ein Fenster
       geschlossen ist. Ein elastisches Fenster (Chart, Watchlist, unterstes
       Fenster einer Spalte) bekommt nie eine feste Höhe, es folgt von selbst. */
    function makeVResizer(res) {
        var drag = false, startY = 0, above = null, below = null,
            aboveH = 0, belowH = 0, aboveFlex = false, belowFlex = false, inLeft = false;

        res.addEventListener('mousedown', function(e) {
            above = _neighborPane(res, -1);
            below = _neighborPane(res, +1);
            if (!above || !below) return;
            aboveFlex = _paneFlex(above);
            belowFlex = _paneFlex(below);
            if (aboveFlex && belowFlex) return;        // beide elastisch → nichts zu ziehen
            inLeft = res.classList.contains('lv-resizer');
            drag = true; startY = e.clientY;
            aboveH = above.offsetHeight; belowH = below.offsetHeight;
            res.classList.add('dragging');
            document.body.style.userSelect = 'none'; document.body.style.cursor = 'row-resize';
            e.preventDefault();
        });

        window.addEventListener('mousemove', function(e) {
            if (!drag) return;
            var d    = e.clientY - startY;
            var minA = _paneMinH(above), minB = _paneMinH(below);
            var colH = (res.parentElement ? res.parentElement.clientHeight : 0) - res.offsetHeight;
            if (aboveFlex) {
                below.style.height = Math.max(minB, Math.min(colH - minA, belowH - d)) + 'px';
            } else if (belowFlex) {
                above.style.height = Math.max(minA, Math.min(colH - minB, aboveH + d)) + 'px';
            } else {
                var dd = Math.max(minA - aboveH, Math.min(belowH - minB, d));
                above.style.height = (aboveH + dd) + 'px';
                below.style.height = (belowH - dd) + 'px';
            }
            if (inLeft) fitChart();
        });

        window.addEventListener('mouseup', function() {
            if (!drag) return;
            drag = false; res.classList.remove('dragging');
            document.body.style.userSelect = ''; document.body.style.cursor = '';
            saveLayout();
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

    // ── Vertikal: alle Trenner beider Spalten, Nachbarn ergeben sich aus dem DOM ──
    document.querySelectorAll('.lv-resizer, .rv-resizer').forEach(makeVResizer);
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
    logIt(1, 'Start', 'Folio startet — Protokoll-Detailgrad ' + logLevel + ' (Seite „Protokoll")');
    renderLog(true);   // Schieberegler/Zahlenfeld auf den gespeicherten Wert stellen

    initChart();
    initDrawingManager();
    loadLayout();  // Layout wiederherstellen nachdem Chart initialisiert
    fitChart();
    logIt(5, 'Start', 'Chart und Zeichenwerkzeuge bereit');

    var doneStart = logTimer(4, 'Start', 'Startsequenz');
    loadConfig().then(function() {
        return loadDbTickers();
    }).then(function() {
        return loadData();
    }).then(function() {
        doneStart();
        loadDrawings();
        loadNotes();
        ibkrLoadIsinMap().then(function() {
            ibkrLoadPositions().then(function() { return ibkrLoadCash(); }).then(function() {
                ibkrRenderTable(); refreshIbkrCostLine(_lastCandles); renderPerfTable();
                ibkrLoadSectors().then(function() { ibkrRenderTable(); });
            });
            // Trades treffen erst NACH loadData() ein — Stammdaten-Fenster und
            // Chart-Marker deshalb hier noch einmal nachziehen.
            ibkrLoadTrades().then(function() {
                ibkrRenderTrades();
                refreshTradeMarkers();
                updateChartMeta();
            });
        });
        // Chart-Schalter aus der Config: VRVP braucht den fertig geladenen Chart,
        // deshalb erst hier und nicht schon in syncUIState(). Nicht über togVRVP(),
        // sonst stünde der Speichern-Knopf gleich beim Start auf „ungespeichert".
        if (((appearance || {}).chart || {}).vrvp && !_vrvpEnabled) {
            _vrvpEnabled = true;
            var vbtn = document.getElementById('bvrvp');
            if (vbtn) vbtn.classList.add('ind-active');
            _initVRVP();
        }
        var tbtn = document.getElementById('btn-trades-toggle');
        if (tbtn) tbtn.classList.toggle('active', _showTradeMarkers);
        var ebtn = document.getElementById('btn-earnings');
        if (ebtn) ebtn.classList.toggle('active', _showEarnings);
        updateSectorEtfBadge(_showSectorEtf ? 'pending' : null);
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

/**
 * Depotgröße in Base — dieselbe Rechnung wie "NET Gesamt" im Portfolio-Report:
 * Long + Cash + Short. Bezugsgröße für den Anteil einer Position am Depot.
 */
function ibkrDepotTotal(ccyFx) {
    var cashBase = (ibkrCash || []).find(function(c) { return c.currency === 'BASE'; });
    var total    = cashBase ? (cashBase.ending_cash || 0) : 0;
    (ibkrPositions || []).forEach(function(p) {
        total += ibkrLiveValue(p, ccyFx);
    });
    return total;
}

/**
 * Wert und Depotanteil je Yahoo-Symbol für die Watchlist des IBKR-Baskets.
 * Mehrere IBKR-Positionen können auf dasselbe Symbol zeigen (z. B. Teilbestände
 * aus verschiedenen Konten) — die werden addiert.
 * @returns {?Object} { value: {sym: Betrag}, depot: Zahl } oder null.
 */
function ibkrWatchlistValues() {
    var b = baskets[currentBasket];
    if (!b || !b.ibkrManaged) return null;
    if (!ibkrPositions || !ibkrPositions.length) return null;

    var ccyFx = ibkrCcyFx();
    var value = {};
    ibkrPositions.forEach(function(p) {
        var sym = ibkrPosYahoo(p);
        if (!sym) return;
        value[sym] = (value[sym] || 0) + ibkrLiveValue(p, ccyFx);
    });

    var depot = ibkrDepotTotal(ccyFx);
    return { value: value, depot: depot };
}

function renderPortfolioReport() {
    var el = document.getElementById('portfolioReport');
    if (!el) return;

    var cashBase = (ibkrCash || []).find(function(c) { return c.currency === 'BASE'; });
    var cashEur  = cashBase ? (cashBase.ending_cash || 0) : 0;

    // Währung→Base aus IBKRs eigenen FX-Raten (konsistent mit Positions-Bewertung)
    var ccyFx = ibkrCcyFx();

    // LONG/SHORT/EXPOSURE beziehen sich auf das IBKR-Depot — seit den weiteren
    // Konten stehen in ibkrPositions auch fremde Depots (Feld `account`). Die
    // kommen unten als eigener Block „WEITERE KONTEN" dazu, damit „NET Gesamt"
    // dieselbe Bedeutung behält wie vorher.
    var ibkrPos = ibkrPositionsIbkr();

    var longG = {}, shortG = {};
    ibkrPos.forEach(function(p) {
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
    ibkrPos.forEach(function(p) {
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

    // WEITERE KONTEN — Girokonten, fremde Depots, Sachwerte, Darlehen.
    // Kommt aus kontenState (Seite „Konten"); ohne angelegte Konten unverändert.
    var weitere = (kontenState.accounts || []).filter(function(a) { return !a.archived; });
    if (weitere.length) {
        h += '<tr class="pr-section"><td colspan="3">WEITERE KONTEN</td></tr>';
        var summeWeitere = 0;
        weitere.forEach(function(a) {
            var wert = kontoWert(a);
            summeWeitere += a.kind === 'darlehen' ? -wert : wert;
            h += '<tr class="pr-row"><td>' + escHtml(a.name)
                + ' <span style="color:var(--muted);font-size:9px">' + KONTO_ARTEN[a.kind] + '</span></td>'
                + '<td style="color:' + (a.kind === 'darlehen' ? 'var(--red)' : 'var(--text)') + '">'
                + fmt(a.kind === 'darlehen' ? -wert : wert) + '</td><td>—</td></tr>';
        });
        h += '<tr class="pr-total"><td>Vermögen gesamt</td>'
            + '<td style="color:' + gc(netTotal + summeWeitere) + '">' + fmt(netTotal + summeWeitere) + '</td>'
            + '<td>—</td></tr>';
    }

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
            // Positionen aus einem weiteren Depot (Seite „Konten") kenntlich machen
            if (p.account && p.account !== 'IBKR') {
                provBadge += ' <span class="k-badge" title="Depot: ' + escHtml(p.account) + '">'
                           + esc(p.account) + '</span>';
            }
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

// GICS-Sektor (yfinance) → repräsentativer SPDR Select Sector ETF (US). Dient als
// Sektor-Proxy für das relative-Stärke-Overlay. Bei Bedarf hier um EU-ETFs erweitern.
var SECTOR_ETF = {
    'Technology':             'XLK',
    'Financial Services':     'XLF',
    'Financial':              'XLF',
    'Healthcare':             'XLV',
    'Consumer Cyclical':      'XLY',
    'Communication Services': 'XLC',
    'Energy':                 'XLE',
    'Industrials':            'XLI',
    'Consumer Defensive':     'XLP',
    'Basic Materials':        'XLB',
    'Real Estate':            'XLRE',
    'Utilities':              'XLU',
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
                updateChartMeta();   // Trade-Fenster unter dem Chart nachziehen
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
    chartPrefsChanged();
    refreshTradeMarkers();
}

// ── Sektor-ETF-Overlay (Sektor-Vergleich) ────────────────────────────────────
// Zeigt beim Betrachten einer Einzelaktie den passenden Sektor-ETF als Linie auf
// einer EIGENEN linken Achse (unabhängig autoskaliert, per Maus skalierbar).
// Vergleich der relativen Stärke über den Kurvenverlauf. Toggle pro Basket
// gespeichert (showSectorEtf).

function toggleSectorEtf(btn) {
    _showSectorEtf = !_showSectorEtf;
    if (btn) btn.classList.toggle('active', _showSectorEtf);
    chartPrefsChanged();   // benutzerweit (appearance.chart), speichert sich selbst
    refreshSectorEtf();
}

// Setzt Beschriftung/Zustand des Toolbar-Buttons. arg: ETF-Symbol | 'none' | 'pending' | null.
function updateSectorEtfBadge(arg) {
    var btn = document.getElementById('btn-sector-etf');
    if (!btn) return;
    btn.classList.toggle('active', _showSectorEtf);
    var label = '📊 Sektor-ETF';
    if (_showSectorEtf) {
        if (arg && arg !== 'none' && arg !== 'pending') label = '📊 ' + arg;
        else if (arg === 'none') label = '📊 ETF –';   // Sektor bekannt, aber kein ETF (z.B. ETF/Future)
    }
    btn.textContent = label;
}

// Zeigt/versteckt die linke ETF-Achse (nur sichtbar wenn Overlay aktiv gezeichnet).
function _setEtfAxisVisible(v) {
    if (!chart) return;
    try { chart.priceScale('left').applyOptions({ visible: v }); } catch(e) {}
}

// Leert das ETF-Overlay und blendet die linke Achse aus.
function _clearSectorEtf() {
    _etfSymbol = null; _etfCandles = [];
    try { etfSeries.setData([]); } catch(e) {}
    _setEtfAxisVisible(false);
}

// Voller Refresh: Sektor→ETF auflösen, ETF-Daten (gecacht) laden, dann zeichnen.
async function refreshSectorEtf() {
    if (!etfSeries) return;
    // Aus / Index / keine Kerzen → Overlay leeren
    if (!_showSectorEtf || currentView === 'index' || !_lastCandles || !_lastCandles.length) {
        _clearSectorEtf();
        updateSectorEtfBadge(null);
        return;
    }
    var sector = (_tickerInfoCache[currentView] && _tickerInfoCache[currentView].sector)
                 || ibkrSectors[currentView] || null;
    var etf = sector ? SECTOR_ETF[sector] : null;
    // Kein Sektor bekannt → evtl. lädt fetchTickerInfo noch; ruft refreshSectorEtf erneut.
    if (!sector) { _clearSectorEtf(); updateSectorEtfBadge('pending'); return; }
    // Sektor ohne ETF-Mapping, oder man betrachtet den ETF selbst → kein Overlay.
    if (!etf || etf.toUpperCase() === currentView.toUpperCase()) {
        _clearSectorEtf();
        updateSectorEtfBadge(etf ? null : 'none');
        return;
    }
    updateSectorEtfBadge(etf);
    var req  = ++_sectorEtfReq;
    var data = _etfDataCache[etf];
    if (!data) {
        try {
            var r   = await fetch('/api/prices/ensure/' + encodeURIComponent(etf), { cache: 'no-store' });
            var raw = await r.json();
            data = (raw || []).map(function(d) { return { time: d.date, close: d.close }; })
                              .filter(function(d) { return d.close != null; });
            _etfDataCache[etf] = data;
        } catch(e) { data = []; }
    }
    // Ansicht/Toggle inzwischen gewechselt? → Ergebnis verwerfen.
    if (req !== _sectorEtfReq || !_showSectorEtf || currentView === 'index') return;
    _etfSymbol  = etf;
    _etfCandles = data;
    _renderSectorEtf();
}

// Zeichnet die ETF-Linie mit ECHTEN ETF-Kursen auf der eigenen linken Achse.
// Kein Rebasing — die unabhängige, maus-skalierbare Achse sorgt dafür, dass ETF und
// Aktie trotz unterschiedlicher Größenordnung beide den vollen vertikalen Raum
// nutzen; der Vergleich der relativen Stärke erfolgt über den Kurvenverlauf.
function _renderSectorEtf() {
    if (!etfSeries) return;
    if (!_showSectorEtf || !_etfCandles || !_etfCandles.length || !_lastCandles || !_lastCandles.length) {
        _clearSectorEtf();
        return;
    }
    // ETF-Tagesschluss je Kerzenzeit (letzter Schluss am/vor der Kerzenzeit; TF-agnostisch).
    var line = [], j = 0, last = null;
    _lastCandles.forEach(function(cd) {
        while (j < _etfCandles.length && _etfCandles[j].time <= cd.time) { last = _etfCandles[j].close; j++; }
        if (last > 0) line.push({ time: cd.time, value: last });
    });
    try { etfSeries.setData(line); } catch(e) {}
    _setEtfAxisVisible(line.length > 0);
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
    // Chart-Hintergrund: freie Farbe des Nutzers, sonst die Theme-Fläche (CSS-Vorgabe).
    if (a.chartBg) {
        root.style.setProperty('--chart-bg', a.chartBg);
        root.style.setProperty('--chart-fg', _isDarkColor(a.chartBg) ? '#e9e7e2' : '#1a1a18');
    } else {
        root.style.removeProperty('--chart-bg');
        root.style.removeProperty('--chart-fg');
    }
    applyChartTheme();
    renderAppearanceControls();
}

/* Hell oder dunkel? Wahrgenommene Helligkeit eines #rrggbb-Werts.
   Entscheidet, ob im Chart hell oder dunkel beschriftet wird. */
function _isDarkColor(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
    if (!m) return false;
    var n = parseInt(m[1], 16);
    var r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return (0.299 * r + 0.587 * g + 0.114 * b) < 140;
}

// Chart-Farben (Text + Gitter) an Theme und gewählten Chart-Hintergrund angleichen.
function applyChartTheme() {
    if (typeof chart === 'undefined' || !chart) return;
    var cs  = getComputedStyle(document.documentElement);
    var bg  = (appearance && appearance.chartBg) || '';
    // Ohne eigene Farbe zählt das Theme, sonst die Helligkeit der gewählten Fläche.
    var dark = bg ? _isDarkColor(bg) : (appearance && appearance.theme === 'dark');
    var txt  = bg ? (dark ? '#e9e7e2' : '#1a1a18')
                  : (cs.getPropertyValue('--text').trim() || '#1a1a18');
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
    [['ap-theme', 'theme'], ['ap-contrast', 'contrast'], ['ap-fontSize', 'fontSize'],
     ['ap-accent', 'accent'], ['ap-chartBg', 'chartBg']]
        .forEach(function(pair) {
            var grp = document.getElementById(pair[0]);
            if (!grp) return;
            var cur = (appearance && appearance[pair[1]]) || '';
            grp.querySelectorAll('.seg-btn').forEach(function(btn) {
                btn.classList.toggle('active', btn.getAttribute('data-v') === cur);
            });
        });
    // Farbfeld auf den aktuellen Wert stellen — auch wenn er von keinem Knopf stammt.
    var pick = document.getElementById('ap-chartBg-custom');
    if (pick) {
        var cur = (appearance && appearance.chartBg) || '';
        pick.value = /^#[0-9a-f]{6}$/i.test(cur) ? cur
            : (getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#ffffff');
    }
    // Volumen- und Profilfarben (Vorgabe, wenn nichts gewählt wurde)
    ['volUp', 'volDown', 'vrvpBar', 'vrvpPoc'].forEach(function(key) {
        var el = document.getElementById('ap-' + key);
        if (el) el.value = chartColorValue(key);
    });
    ['volAlpha', 'vrvpAlpha'].forEach(function(key) {
        var el = document.getElementById('ap-' + key);
        if (el) el.value = Math.round(chartColorValue(key) * 100);
        var lab = document.getElementById('ap-' + key + '-val');
        if (lab) lab.textContent = Math.round(chartColorValue(key) * 100) + ' %';
    });
}

/**
 * Farbe oder Deckkraft für Volumen/Volumenprofil setzen.
 * `commit=false` beim Ziehen des Reglers — nur anwenden, damit man das Ergebnis
 * sofort sieht, ohne bei jedem Zwischenschritt zum Server zu schreiben.
 * `commit=true` beim Loslassen speichert.
 */
async function setChartColor(key, value, commit) {
    if (!appearance) appearance = {};
    appearance[key] = (key.slice(-5) === 'Alpha') ? Number(value) : value;
    var lab = document.getElementById('ap-' + key + '-val');
    if (lab) lab.textContent = Math.round(chartColorValue(key) * 100) + ' %';
    refreshChartColors();
    if (commit) await saveAppearanceToServer();
}

/** Volumen- und Profilfarben zurück auf die Vorgaben. */
async function resetChartColors() {
    if (!appearance) appearance = {};
    Object.keys(CHART_COLOR_DEFAULTS).forEach(function(k) { delete appearance[k]; });
    renderAppearanceControls();
    refreshChartColors();
    await saveAppearanceToServer();
}

/**
 * Chart neu zeichnen, nachdem sich eine Farbe geändert hat. Die Volumenfarbe
 * steckt in den Balkendaten selbst, deshalb muss die Reihe neu gesetzt werden —
 * das erledigt applyPeriod(). Das VRVP-Overlay malt auf sein eigenes Canvas.
 */
function refreshChartColors() {
    if (typeof applyPeriod === 'function') applyPeriod();
    if (_vrvpEnabled) _scheduleVRVP();
}

// Einstellung ändern → anwenden + pro Nutzer speichern.
async function setAppearance(key, value) {
    if (!appearance) appearance = {};
    appearance[key] = value;
    applyAppearance();
    // Eigener Endpunkt statt der ganzen Config: sonst gingen beim Umschalten des
    // Themes auch Gewichte mit raus, die noch gar nicht gespeichert werden sollten.
    await saveAppearanceToServer();
}

/** Lädt eingeloggten User + IBKR-Konfigurationsstatus in die Settings-Seite. */
async function settingsLoad() {
    renderAppearanceControls();
    renderHiddenPaneInfo();
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

/* Die Upload-Funktion dieser Seite ist entfallen — die Seite „Steuer" gibt es
   nicht mehr (Nachfolger: IBKR Steuer Report). Der Rest ist toter Code. */

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

/* Zustand der Steuer-Seite: abgelegte Dateien, Jahre, PDF-Abschnittsauswahl.
   Gerechnet wird NUR auf Knopfdruck — beim Öffnen der Seite wird lediglich der
   Dateibestand geladen (die Engine braucht je Jahr einige Sekunden). */
var _TAX4 = { files: [], available: [], cached: [], inited: false,
              sections: [], selSections: null };

function _taxEsc(s) {
    return (s == null ? '' : String(s)).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Lädt beim Öffnen der Seite nur den Dateibestand + die PDF-Abschnittsliste. */
async function taxStoreInit(force) {
    if (_TAX4.inited && !force) return;
    _TAX4.inited = true;
    try {
        var r = await fetch('/api/tax/files?kind=xml').then(function (x) { return x.json(); });
        if (r && r.ok) _taxApplyStore(r);
    } catch (e) {
        _taxSetMsg('tax4-msg', 'Bestand konnte nicht geladen werden: ' + e.message, 'err');
    }
    _taxLoadPdfSections();
}

/** Übernimmt Dateiliste + gecachte Jahre aus einer Server-Antwort und rendert. */
function _taxApplyStore(r) {
    if (r.files) _TAX4.files = r.files;
    if (r.cached_years) _TAX4.cached = r.cached_years;
    _TAX4.available = _TAX4.files.map(function (f) { return f.year; })
        .filter(function (y, i, a) { return y && a.indexOf(y) === i; }).sort();
    _taxRenderTree();
    _taxRenderRunYears();
}

function _taxFmtSize(b) {
    if (b == null) return '';
    return b > 1048576 ? (b / 1048576).toFixed(1).replace('.', ',') + ' MB'
                       : Math.max(1, Math.round(b / 1024)) + ' KB';
}

/** Dateibaum: Jahr → abgelegte XMLs (mit Zeitraum, Größe, Ablagedatum, Löschen). */
function _taxRenderTree() {
    var el = document.getElementById('tax4-tree');
    if (!el) return;
    if (!_TAX4.files.length) {
        el.innerHTML = '<div class="tax-tree-empty">Noch keine Statements abgelegt — '
            + 'XMLs hochladen oder von IBKR holen.</div>';
        return;
    }
    var byYear = {};
    _TAX4.files.forEach(function (f) {
        var y = f.year || 'ohne Jahr';
        (byYear[y] = byYear[y] || []).push(f);
    });
    var years = Object.keys(byYear).sort().reverse();
    var acct = '';
    _TAX4.files.forEach(function (f) { acct = acct || f.account_name || f.account_id || ''; });
    var html = '<div class="tax-tree-head">🗂️ <b>' + _TAX4.files.length + '</b> Statement(s) auf dem Server'
        + (acct ? ' · Konto ' + _taxEsc(acct) : '')
        + '<a href="#" class="tax-tree-clear" onclick="_taxClearStored(\'xml\');return false;">alle löschen</a></div>';
    years.forEach(function (y) {
        var done = _TAX4.cached.indexOf(y) >= 0;
        html += '<details class="tax-tree-year" open><summary>'
            + '<span class="tt-year">' + _taxEsc(y) + '</span>'
            + '<span class="tt-count">' + byYear[y].length + ' Datei(en)</span>'
            + '<span class="tt-state ' + (done ? 'ok' : '') + '">' + (done ? '✓ gerechnet' : 'nicht gerechnet') + '</span>'
            + '</summary>';
        byYear[y].forEach(function (f) {
            var zeit = (f.from_date && f.to_date) ? (f.from_date + ' – ' + f.to_date) : '';
            var abg = f.mtime ? new Date(f.mtime * 1000).toLocaleDateString('de-DE') : '';
            html += '<div class="tax-file-row">'
                + '<span class="tf-name">📄 ' + _taxEsc(f.name) + '</span>'
                + '<span class="tf-meta">' + _taxEsc(zeit) + '</span>'
                + '<span class="tf-meta">' + _taxFmtSize(f.size) + '</span>'
                + '<span class="tf-meta">abgelegt ' + abg + '</span>'
                + '<a href="#" class="tf-del" title="Diese Datei vom Server löschen" '
                + 'onclick="_taxDeleteFile(\'xml\',\'' + _taxEsc(f.name) + '\');return false;">✕</a>'
                + '</div>';
        });
        html += '</details>';
    });
    el.innerHTML = html;
}

/** Jahres-Auswahl für „Report erstellen" (alle Jahre + jedes einzelne Jahr). */
function _taxRenderRunYears() {
    var sel = document.getElementById('tax4-run-year');
    if (!sel) return;
    var prev = sel.value;
    var years = _TAX4.available.slice().reverse();
    sel.innerHTML = years.map(function (y) {
        return '<option value="' + y + '">' + y + (_TAX4.cached.indexOf(y) >= 0 ? ' ✓' : '') + '</option>';
    }).join('') + '<option value="all">alle Jahre' + (years.length ? ' (' + years.length + ')' : '') + '</option>';
    if (prev && Array.prototype.some.call(sel.options, function (o) { return o.value === prev; })) sel.value = prev;
    var hint = document.getElementById('tax4-run-hint');
    if (hint) hint.textContent = years.length
        ? 'bereits gerechnete Jahre (✓) kommen sofort aus dem Zwischenspeicher'
        : '';
    var btn = document.getElementById('tax4-run-btn');
    if (btn) btn.disabled = !years.length;
}

/** Upload: Dateien nur ablegen — die Berechnung startest du danach selbst. */
async function taxKonvexUpload(fileList) {
    if (!fileList || !fileList.length) return;
    var files = Array.prototype.slice.call(fileList);
    var fd = new FormData();
    files.forEach(function (f) { fd.append('files', f); });
    _taxSetMsg('tax4-msg', 'Lege ' + files.length + ' Datei(en) ab …', '');
    try {
        var res = await fetch('/api/tax/upload?kind=xml', { method: 'POST', body: fd })
            .then(function (r) { return r.json(); });
        if (res && res.ok) {
            _taxApplyStore(res);
            _taxSetMsg('tax4-msg', '✓ ' + res.added + ' Datei(en) abgelegt — jetzt „Report erstellen" wählen.', 'ok');
        } else {
            _taxSetMsg('tax4-msg', 'Fehler: ' + ((res && res.error) || 'unbekannt'), 'err');
        }
    } catch (e) {
        _taxSetMsg('tax4-msg', 'Fehler: ' + e.message, 'err');
    }
}

/** Rechnet den Report — für das gewählte Jahr oder alle Jahre. */
async function taxKonvexRun(btn) {
    var sel = document.getElementById('tax4-run-year');
    var y = sel ? sel.value : '';
    if (!_TAX4.files.length) {
        _taxSetMsg('tax4-msg', 'Keine abgelegten Dateien — bitte XML hochladen.', '');
        return;
    }
    var label = (y === 'all') ? 'alle Jahre' : ('Jahr ' + y);
    var old = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerHTML = '⏳ rechne …'; }
    _taxSetMsg('tax4-msg', 'Rechne ' + label + ' … (beim ersten Mal einige Sekunden je Jahr, '
        + 'danach aus dem Zwischenspeicher)', '');
    try {
        var res = await fetch('/api/tax/report-konvex?year=' + encodeURIComponent(y), { method: 'POST' })
            .then(function (r) { return r.json(); });
        if (res && res.ok) {
            _taxKonvexApply(res);
            var neu = (res.recomputed || []).length;
            _taxSetMsg('tax4-msg', '✓ ' + (res.computed_years || []).join(', ') + ' ausgewertet'
                + (neu ? ' (' + neu + ' neu gerechnet)' : ' (aus dem Zwischenspeicher)')
                + (res.account ? ' · Konto ' + res.account : ''), 'ok');
        } else if (res && res.no_files) {
            _taxSetMsg('tax4-msg', 'Keine abgelegten Dateien — bitte XML hochladen.', '');
        } else {
            _taxSetMsg('tax4-msg', 'Fehler: ' + ((res && res.error) || 'unbekannt'), 'err');
        }
    } catch (e) {
        _taxSetMsg('tax4-msg', 'Fehler: ' + e.message, 'err');
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = old; }
    }
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
            _taxKonvexApply(res);
            _taxSetMsg('tax4-msg', '✓ IBKR-Abruf · Jahr ' + (res.fetched_year || '') + ' aktualisiert und gerechnet'
                + (res.account ? ' · Konto ' + res.account : ''), 'ok');
        } else {
            _taxSetMsg('tax4-msg', 'Fehler: ' + ((res && res.error) || 'unbekannt'), 'err');
        }
    } catch (e) {
        _taxSetMsg('tax4-msg', 'Fehler: ' + e.message, 'err');
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = old; }
    }
}

/**
 * Übernimmt ein Rechen-Ergebnis: gerechnete Jahre werden gesammelt (bereits
 * gerechnete bleiben erhalten), Dateibaum/Jahresauswahl aktualisiert, Jahr gerendert.
 */
function _taxKonvexApply(res) {
    if (!_taxData4) _taxData4 = { years: {} };
    var ys = res.years || {};
    Object.keys(ys).forEach(function (y) { _taxData4.years[y] = ys[y]; });
    if (res.account) _taxData4.account = res.account;
    if (res.available_years) _TAX4.available = res.available_years;
    if (res.cached_years) _TAX4.cached = res.cached_years;
    if (res.files) _TAX4.files = res.files;
    _taxRenderTree();
    _taxRenderRunYears();
    var box = document.getElementById('tax4-result');
    if (box) box.style.display = '';
    _taxRenderYearSelect(res.year);
    if (_taxData4.years[res.year]) _taxKonvexRenderYear(_taxData4.years[res.year]);
}

/** Jahres-Selektor über dem Ergebnis — noch nicht gerechnete Jahre sind markiert. */
function _taxRenderYearSelect(sel) {
    var el = document.getElementById('tax4-year-select');
    if (!el) return;
    var years = (_TAX4.available.length ? _TAX4.available
                                        : Object.keys((_taxData4 || {}).years || {})).slice().reverse();
    el.innerHTML = years.map(function (y) {
        var have = _taxData4 && _taxData4.years && _taxData4.years[y];
        return '<option value="' + y + '"' + (y === sel ? ' selected' : '') + '>'
            + y + (have ? '' : ' · noch nicht gerechnet') + '</option>';
    }).join('');
}

/** Jahreswechsel: schon gerechnet → sofort rendern, sonst nachrechnen (meist Cache). */
async function taxKonvexSelectYear(year) {
    if (!year) return;
    if (_taxData4 && _taxData4.years && _taxData4.years[year]) {
        _taxRenderYearSelect(year);
        _taxKonvexRenderYear(_taxData4.years[year]);
        return;
    }
    _taxSetMsg('tax4-msg', 'Rechne Jahr ' + year + ' …', '');
    try {
        var res = await fetch('/api/tax/report-konvex?year=' + encodeURIComponent(year), { method: 'POST' })
            .then(function (r) { return r.json(); });
        if (res && res.ok) {
            _taxKonvexApply(res);
            _taxSetMsg('tax4-msg', '✓ ' + year + ' ausgewertet'
                + ((res.recomputed || []).length ? '' : ' (aus dem Zwischenspeicher)'), 'ok');
        } else {
            _taxSetMsg('tax4-msg', 'Fehler: ' + ((res && res.error) || 'unbekannt'), 'err');
        }
    } catch (e) {
        _taxSetMsg('tax4-msg', 'Fehler: ' + e.message, 'err');
    }
}

/* ── PDF-Abschnitte (welche Teile der Bericht enthalten soll) ───────────────── */

var _TAX_PDF_LS = 'folio.tax4.pdfSections';

async function _taxLoadPdfSections() {
    if (!_TAX4.sections.length) {
        try {
            var r = await fetch('/api/tax/pdf-sections').then(function (x) { return x.json(); });
            if (!r || !r.ok) return;
            _TAX4.sections = r.sections || [];
            var saved = null;
            try { saved = JSON.parse(localStorage.getItem(_TAX_PDF_LS) || 'null'); } catch (e) { saved = null; }
            _TAX4.selSections = (saved && saved.length) ? saved : (r.defaults || []).slice();
        } catch (e) { return; }
    }
    _taxRenderPdfSections();
}

function _taxRenderPdfSections() {
    var el = document.getElementById('tax4-pdf-sections');
    if (!el) return;
    var sel = _TAX4.selSections || [];
    el.innerHTML = _TAX4.sections.map(function (s) {
        return '<label class="pdf-opt"><input type="checkbox" value="' + _taxEsc(s.key) + '"'
            + (sel.indexOf(s.key) >= 0 ? ' checked' : '')
            + ' onchange="taxPdfSectionToggle(this)"> ' + _taxEsc(s.label) + '</label>';
    }).join('');
}

function taxPdfSectionToggle(cb) {
    var sel = (_TAX4.selSections || []).slice();
    var i = sel.indexOf(cb.value);
    if (cb.checked && i < 0) sel.push(cb.value);
    if (!cb.checked && i >= 0) sel.splice(i, 1);
    _TAX4.selSections = sel;
    try { localStorage.setItem(_TAX_PDF_LS, JSON.stringify(sel)); } catch (e) { /* egal */ }
}

function taxPdfSectionsAll(on) {
    _TAX4.selSections = on ? _TAX4.sections.map(function (s) { return s.key; }) : [];
    try { localStorage.setItem(_TAX_PDF_LS, JSON.stringify(_TAX4.selSections)); } catch (e) { /* egal */ }
    _taxRenderPdfSections();
}

/** Lädt den PDF-Steuerbericht für das gewählte Jahr (serverseitig erzeugt). */
async function taxKonvexPdf() {
    var sel = document.getElementById('tax4-year-select');
    var year = sel ? sel.value : (_taxData4 && _taxData4.year);
    if (!year) return;
    var btn = document.getElementById('tax4-pdf-btn');
    var old = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerHTML = '⏳ erstelle …'; }
    try {
        // leere Auswahl bewusst als "-" senden (sonst würde der Server alles nehmen)
        var secs = _TAX4.selSections ? (_TAX4.selSections.join(',') || '-') : '';
        var resp = await fetch('/api/tax/report-konvex-pdf?year=' + encodeURIComponent(year)
            + (secs ? '&sections=' + encodeURIComponent(secs) : ''));
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
 *  Abgelegte Steuer-Dateien — Verwaltung (Dateibaum)
 *  ----------------------------------------------------------------------------
 *  Die IBKR-Statements liegen serverseitig pro User (Sorte "xml"). Beim Öffnen
 *  der Seite wird NUR der Bestand geladen (taxStoreInit); gerechnet wird auf
 *  Knopfdruck über taxKonvexRun() — je Jahr oder für alle Jahre.
 * ═══════════════════════════════════════════════════════════════════════════ */

function _taxSetMsg(id, t, c) {
    var m = document.getElementById(id);
    if (m) { m.textContent = t; m.className = 'settings-msg ' + (c || ''); }
}

/** Löscht den gesamten abgelegten Bestand (inkl. gerechneter Ergebnisse). */
async function _taxClearStored(kind) {
    if (!window.confirm('Alle abgelegten ' + kind.toUpperCase() + '-Dateien auf dem Server löschen?')) return;
    try {
        var res = await fetch('/api/tax/files?kind=' + encodeURIComponent(kind), { method: 'DELETE' })
            .then(function (r) { return r.json(); });
        _TAX4.files = (res && res.files) || [];
        _TAX4.cached = (res && res.cached_years) || [];
    } catch (e) {
        _TAX4.files = []; _TAX4.cached = [];
    }
    _taxData4 = null;
    _TAX4.available = [];
    _taxRenderTree();
    _taxRenderRunYears();
    var box = document.getElementById('tax4-result');
    if (box) box.style.display = 'none';
    _taxSetMsg('tax4-msg', 'Abgelegte Dateien gelöscht.', '');
}

/** Löscht eine einzelne abgelegte Datei (ohne neu zu rechnen). */
async function _taxDeleteFile(kind, name) {
    if (!window.confirm('Datei „' + name + '" vom Server löschen?')) return;
    try {
        var res = await fetch('/api/tax/files?kind=' + encodeURIComponent(kind)
            + '&name=' + encodeURIComponent(name), { method: 'DELETE' })
            .then(function (r) { return r.json(); });
        if (res && res.ok) _taxApplyStore(res);
    } catch (e) {
        _taxSetMsg('tax4-msg', 'Fehler beim Löschen: ' + e.message, 'err');
        return;
    }
    // Der Bestand hat sich geändert → bisherige Ergebnisse gelten nicht mehr.
    _taxData4 = null;
    var box = document.getElementById('tax4-result');
    if (box) box.style.display = 'none';
    _taxSetMsg('tax4-msg', 'Datei gelöscht — Report bei Bedarf neu erstellen.', '');
}

/* ───────────────────────────────────────────────────────────────────────────
 *  SCREENER — Sektor-Screening (Finviz + yfinance), Background-Job + Polling
 * ─────────────────────────────────────────────────────────────────────────── */

var _SCR = {
    inited:    false,
    jobId:     null,
    polling:   false,   // verhindert zwei parallele Poll-Schleifen
    pollTimer: null,
    indexes:   [],   // alle verfügbaren Indizes
    defaults:  ['Russell 2000'],
    filters:        [],   // Katalog [{group, items:[{code,label}]}]
    filterDefaults: [],   // voreingestellte Filter-Codes
    legend:         [],   // Finviz-Code-Referenz [{group, items:[{code,desc}]}]
    results:   {},   // letztes fertiges Ergebnis  { sector: [tickers] }
};

async function screenerInit() {
    if (_SCR.inited) { screenerResume(); return; }
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

    // Zuletzt benutzte Einstellungen über die Vorauswahl legen (serverseitig je
    // Benutzer), danach das automatische Speichern anhängen — in dieser
    // Reihenfolge, sonst würde das Anwenden selbst als Änderung gespeichert.
    try {
        var sres = await fetch('/api/screener/settings');
        if (!sres.ok) throw new Error('HTTP ' + sres.status);
        var saved = await sres.json();
        if (_scrApplySettings(saved)) logIt(6, 'Screener', 'Gespeicherte Einstellungen geladen');
        else logIt(6, 'Screener', 'Keine gespeicherten Einstellungen — Vorauswahl aktiv');
    } catch (e) {
        logIt(1, 'Screener', 'Einstellungen laden fehlgeschlagen: ' + e.message);
        _scrMsg('⚠ Gespeicherte Einstellungen konnten nicht geladen werden: ' + e.message, 'err');
    }
    _scrWireSettingsAutosave();

    updateHint();
    _scrUpdateMergeBtn();
    screenerBlacklistLoad();
    screenerResume();
}

/**
 * Hängt die Oberfläche wieder an ein Screening, das noch im Hintergrund läuft.
 * Nötig nach einem Neuladen der Seite: die Job-ID lebt dann nur noch serverseitig
 * (data/{user}/last_screener_job.json). Jobs verfallen nach 30 Minuten — meldet
 * der Server keinen, ist schlicht nichts wiederaufzunehmen.
 */
async function screenerResume() {
    if (_SCR.polling || _SCR.jobId) return;
    if (!document.getElementById('scr-btn-run')) return;   // Screener-Seite fehlt
    var jobId;
    try {
        var r = await fetch('/api/screener/last').then(function (r) { return r.json(); });
        jobId = r && r.ok ? r.job_id : null;
    } catch (e) {
        return;   // kein Netz → nichts zu tun, der nächste Seitenaufruf versucht es erneut
    }
    if (!jobId || _SCR.polling || _SCR.jobId) return;

    _SCR.jobId = jobId;
    // Oberfläche in den Lauf-Zustand versetzen; _scrPoll füllt Log und Balken.
    document.getElementById('scr-btn-run').disabled     = true;
    document.getElementById('scr-btn-export').disabled  = true;
    document.getElementById('scr-btn-baskets').disabled = true;
    document.getElementById('scr-log-card').style.display     = '';
    document.getElementById('scr-results-card').style.display = 'none';
    document.getElementById('scr-progress-wrap').style.display = '';
    _scrSetState('läuft …', 'run');
    _scrMsg('Laufendes Screening wieder aufgenommen');
    logIt(3, 'Screener', 'An laufendes Screening angehängt (' + jobId + ')');
    _scrPoll();
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

/** Katalog-Haken allein (ohne Eigenfilter) — so werden sie auch gespeichert. */
function _scrCheckedCatalogFilters() {
    var out = [];
    document.querySelectorAll('#scr-filters input[type="checkbox"]').forEach(function (cb) {
        if (cb.checked) out.push(cb.dataset.filter);
    });
    return out;
}

/** Eigenfilter-Feld als Liste. */
function _scrCustomFilters() {
    var inp = document.getElementById('scr-filters-custom');
    if (!inp || !inp.value) return [];
    var out = [];
    inp.value.split(/[,\s]+/).forEach(function (c) {
        c = c.trim().toLowerCase();
        if (c && out.indexOf(c) < 0) out.push(c);
    });
    return out;
}

/** Aktueller Formularzustand als Objekt für /api/screener/settings. */
function _scrCollectSettings() {
    var num = function (id) { return parseFloat((document.getElementById(id) || {}).value) || 0; };
    var unitEl = document.getElementById('scr-cap-unit');
    return {
        indexes: _scrSelectedIndexes(),
        cap_min: num('scr-cap-min'),
        cap_max: num('scr-cap-max'),
        unit:    unitEl ? unitEl.value : 'Mrd $',
        filters: _scrCheckedCatalogFilters(),
        custom:  _scrCustomFilters(),
    };
}

/**
 * Gespeicherte Einstellungen ins Formular schreiben. Ein leeres Objekt (noch nie
 * gespeichert) lässt die Vorauswahl aus screener.py stehen — deshalb wird jedes
 * Feld einzeln geprüft und nicht pauschal überschrieben.
 */
function _scrApplySettings(st) {
    if (!st || typeof st !== 'object' || !Object.keys(st).length) return false;
    if (Array.isArray(st.indexes)) {
        document.querySelectorAll('#scr-indexes input[type="checkbox"]').forEach(function (cb) {
            cb.checked = st.indexes.indexOf(cb.dataset.idx) >= 0;
        });
    }
    if (Array.isArray(st.filters)) {
        document.querySelectorAll('#scr-filters input[type="checkbox"]').forEach(function (cb) {
            cb.checked = st.filters.indexOf(cb.dataset.filter) >= 0;
        });
    }
    var cust = document.getElementById('scr-filters-custom');
    if (cust && Array.isArray(st.custom)) cust.value = st.custom.join(', ');
    var mn = document.getElementById('scr-cap-min');
    var mx = document.getElementById('scr-cap-max');
    var un = document.getElementById('scr-cap-unit');
    if (mn && st.cap_min != null) mn.value = st.cap_min;
    if (mx && st.cap_max != null) mx.value = st.cap_max;
    if (un && st.unit) un.value = st.unit;
    return true;
}

var _scrSaveTimer = null;

/**
 * Speichert die Einstellungen kurz nach der letzten Änderung. Gesammelt, weil
 * beim Tippen im Eigenfilter-Feld sonst pro Zeichen geschrieben würde.
 */
function _scrSettingsChanged() {
    clearTimeout(_scrSaveTimer);
    _scrSaveTimer = setTimeout(_scrSaveSettings, 800);
}

/** Kurze Rückmeldung in der Screener-Statuszeile, die sich selbst wieder aufräumt. */
function _scrFlash(text, cls, ms) {
    _scrMsg(text, cls);
    setTimeout(function () {
        var el = document.getElementById('scr-msg');
        if (el && el.textContent === text) _scrMsg('', '');
    }, ms || 2500);
}

async function _scrSaveSettings() {
    _scrSaveTimer = null;
    try {
        var r = await fetch('/api/screener/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(_scrCollectSettings()),
        });
        // fetch wirft bei 4xx/5xx NICHT — sonst meldet die Oberfläche „gespeichert",
        // obwohl der Server nichts geschrieben hat.
        if (!r.ok) {
            var detail = '';
            try { detail = (await r.json()).error || ''; } catch (e) { detail = ''; }
            var msg = 'Einstellungen konnten nicht gespeichert werden (HTTP ' + r.status
                + (detail ? ': ' + detail : '') + ')';
            logIt(1, 'Screener', msg);
            _scrMsg('⚠ ' + msg, 'err');
            return;
        }
        logIt(7, 'Screener', 'Einstellungen gespeichert');
        _scrFlash('✓ Einstellungen gespeichert', 'ok');
    } catch (e) {
        logIt(1, 'Screener', 'Einstellungen speichern fehlgeschlagen: ' + e.message);
        _scrMsg('⚠ Einstellungen speichern fehlgeschlagen: ' + e.message, 'err');
    }
}

/**
 * Noch offene Änderung sofort wegschreiben, wenn die Seite verlassen/versteckt
 * wird — sonst geht verloren, was keine 800 ms alt ist (F5 direkt nach dem Klick).
 * sendBeacon läuft auch noch, wenn das Dokument schon abgebaut wird.
 */
function _scrFlushSettings() {
    if (!_scrSaveTimer) return;
    clearTimeout(_scrSaveTimer);
    _scrSaveTimer = null;
    try {
        var body = new Blob([JSON.stringify(_scrCollectSettings())], { type: 'application/json' });
        if (!navigator.sendBeacon || !navigator.sendBeacon('/api/screener/settings', body)) {
            _scrSaveSettings();
        }
    } catch (e) {
        logIt(2, 'Screener', 'Einstellungen beim Verlassen nicht gesichert: ' + e.message);
    }
}

/** Zurück auf die Vorgaben aus screener.py — gespeicherte Datei löschen und neu aufbauen. */
async function screenerResetSettings() {
    // Eine noch offene Autosave-Änderung darf nach dem Löschen nicht nachträglich
    // wieder auf den Server laufen.
    clearTimeout(_scrSaveTimer);
    _scrSaveTimer = null;
    var failed = '';
    try {
        var r = await fetch('/api/screener/settings', { method: 'DELETE' });
        if (!r.ok) failed = 'HTTP ' + r.status;
    } catch (e) { failed = e.message; }
    document.querySelectorAll('#scr-indexes input[type="checkbox"]').forEach(function (cb) {
        cb.checked = _SCR.defaults.indexOf(cb.dataset.idx) >= 0;
    });
    document.querySelectorAll('#scr-filters input[type="checkbox"]').forEach(function (cb) {
        cb.checked = _SCR.filterDefaults.indexOf(cb.dataset.filter) >= 0;
    });
    var cust = document.getElementById('scr-filters-custom');
    if (cust) cust.value = '';
    ['scr-cap-min', 'scr-cap-max'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.value = 0;
    });
    var un = document.getElementById('scr-cap-unit');
    if (un) un.value = 'Mrd $';
    var hintEl = document.getElementById('scr-cap-hint');
    if (hintEl) { hintEl.textContent = '↳ 0 = keine Grenze → alle MarktCaps'; hintEl.style.color = ''; }
    if (failed) {
        logIt(1, 'Screener', 'Gespeicherte Einstellungen konnten nicht gelöscht werden: ' + failed);
        _scrMsg('⚠ Formular zurückgesetzt, aber der Server hat die gespeicherten '
            + 'Einstellungen nicht gelöscht (' + failed + ')', 'err');
    } else {
        _scrMsg('Einstellungen auf die Vorgaben zurückgesetzt', 'ok');
    }
}

/** Hängt das automatische Speichern an alle Eingabefelder des Screeners. */
function _scrWireSettingsAutosave() {
    ['scr-indexes', 'scr-filters'].forEach(function (id) {
        var box = document.getElementById(id);
        if (box) box.addEventListener('change', _scrSettingsChanged);
    });
    var cust = document.getElementById('scr-filters-custom');
    if (cust) cust.addEventListener('input', _scrSettingsChanged);
    ['scr-cap-min', 'scr-cap-max', 'scr-cap-unit'].forEach(function (id) {
        var el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('input', _scrSettingsChanged);
        el.addEventListener('change', _scrSettingsChanged);
    });
    // Offene Änderung sichern, bevor die Seite weg ist (Neuladen, Tab-Wechsel, Schließen)
    window.addEventListener('pagehide', _scrFlushSettings);
    window.addEventListener('beforeunload', _scrFlushSettings);
    document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden') _scrFlushSettings();
    });
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
    _scrRenderBlocked(null);            // Hinweis des letzten Laufs wegräumen
    document.getElementById('scr-log').textContent = '';
    document.getElementById('scr-progress-wrap').style.display = '';
    document.getElementById('scr-progress-bar').style.width = '0%';
    _scrSetState('läuft …', 'run');

    // Beim Start festhalten, was gerade eingestellt ist — sonst ginge eine
    // Änderung verloren, die keine 800 ms alt ist (siehe _scrSettingsChanged).
    clearTimeout(_scrSaveTimer);
    _scrSaveTimer = null;
    _scrSaveSettings();

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
        clearTimeout(_SCR.pollTimer);   // eine eventuell wieder aufgenommene Schleife ablösen
        _SCR.jobId = res.job_id;
        _scrPoll();
    } catch (e) {
        _scrSetState('Fehler', 'err');
        _scrMsg('Netzwerkfehler: ' + e, 'err');
        document.getElementById('scr-btn-run').disabled = false;
    }
}

async function _scrPoll() {
    if (!_SCR.jobId) { _SCR.polling = false; return; }
    _SCR.polling = true;
    try {
        var s = await fetch('/api/screener/status/' + _SCR.jobId)
            .then(function (r) { return r.json(); });
        if (!s.ok) {
            // Job ist weg (Neustart oder 30-Min-Ablauf) — Kennung fallen lassen,
            // sonst blockiert sie jedes spätere Wiederanhängen.
            _SCR.jobId = null;
            _SCR.polling = false;
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
            _SCR.polling = false;
            _scrSetState('Fehler', 'err');
            _scrMsg(s.error || 'Screening fehlgeschlagen', 'err');
            document.getElementById('scr-btn-run').disabled = false;
            return;
        }

        // done
        _SCR.polling = false;
        _scrSetState('fertig', 'ok');
        _scrMsg('Screening abgeschlossen', 'ok');
        _SCR.results = s.results || {};
        document.getElementById('scr-btn-run').disabled = false;
        document.getElementById('scr-btn-export').disabled = false;
        document.getElementById('scr-btn-baskets').disabled = false;
        _scrRenderResults(_SCR.results);
        _scrRenderBlocked(s.blocked);
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

/* Legt pro Sektor **einen festen** Basket an: "Screener {Sektor}".
   Jeder weitere Lauf schreibt die Gewichte desselben Baskets neu, statt mit
   jedem Datum einen weiteren anzulegen — die Chart-Einstellungen des Baskets
   und die Blacklist-Historie bleiben so über die Läufe hinweg erhalten.
   Baskets aus der alten, datierten Benennung werden einmalig übernommen. */
async function screenerToBaskets() {
    var results = _SCR.results || {};
    var sectors = Object.keys(results).filter(function (s) {
        return (results[s] || []).length > 0;
    });
    if (!sectors.length) {
        _scrMsg('Kein Ergebnis zum Übernehmen', 'err');
        return;
    }

    // Bestehende Baskets nach Name indexieren (für Overwrite)
    var byName = {};
    Object.keys(baskets).forEach(function (id) {
        if (baskets[id] && baskets[id].name) byName[baskets[id].name] = id;
    });
    var alteDatierte = _screenerDatierteBaskets();

    var created = 0, updated = 0, migriert = 0, firstId = null, aktivBetroffen = false;
    sectors.forEach(function (sector, i) {
        var tickers = results[sector];
        var weights = {};
        tickers.forEach(function (t) { weights[t] = 1; });

        var name = 'Screener ' + sector;
        var existingId = byName[name];

        // Übergang von der alten Benennung: gibt es den festen Basket noch
        // nicht, wird der jüngste datierte dieses Sektors umbenannt und
        // weitergenutzt — sonst stünde er als Leiche daneben.
        if (!existingId) {
            var alt = _screenerJuengsterDatierter(alteDatierte, sector);
            if (alt) {
                existingId = alt;
                baskets[alt].name = name;
                delete alteDatierte[alt];
                migriert++;
            }
        }

        if (existingId) {
            baskets[existingId].weights = weights;
            updated++;
            if (existingId === currentBasket) aktivBetroffen = true;
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
                showIndex: false,   // Screener-Baskets standardmäßig nicht als Index anzeigen
            };
            created++;
            if (!firstId) firstId = id;
        }
    });

    var geloescht = _screenerLoescheDatierteReste(alteDatierte);

    try {
        // 'screener' = kein Blacklist-Protokoll für diesen Schreibvorgang,
        // siehe saveBasketsToServer() in shared.js.
        await saveBasketsToServer('screener');
        if (aktivBetroffen && baskets[currentBasket]) {
            // Anzeige-Weights mitziehen, bevor switchBasket() sie über
            // saveCurrentBasketState() wieder mit dem alten Stand überschreibt.
            WEIGHTS = Object.assign({}, baskets[currentBasket].weights || {});
            await switchBasket(currentBasket);
        }
        if (typeof renderBasketSelect === 'function') renderBasketSelect();
        _scrUpdateMergeBtn();
        var summary = [];
        if (created)   summary.push(created + ' neu');
        if (updated)   summary.push(updated + ' aktualisiert');
        if (migriert)  summary.push(migriert + ' übernommen');
        if (geloescht) summary.push(geloescht + ' alte gelöscht');
        _scrMsg('Baskets: ' + summary.join(', '), 'ok');
    } catch (e) {
        _scrMsg('Speichern fehlgeschlagen: ' + e, 'err');
    }
}

/* Baskets aus der alten Benennung "Screener {Sektor} {YYYY-MM-DD}".
   @returns {Object} {basket_id: {sektor, datum}} */
function _screenerDatierteBaskets() {
    var out = {};
    Object.keys(baskets).forEach(function (id) {
        var name = (baskets[id] || {}).name || '';
        if (name.indexOf(SCREENER_BASKET_PREFIX) !== 0) return;
        var rest  = name.slice(SCREENER_BASKET_PREFIX.length);
        var datum = rest.slice(-10);
        if (rest.length < 12 || !/^\d{4}-\d{2}-\d{2}$/.test(datum)) return;
        out[id] = { sektor: rest.slice(0, -11), datum: datum };
    });
    return out;
}

/* Die id des jüngsten datierten Baskets eines Sektors — oder null. */
function _screenerJuengsterDatierter(datierte, sektor) {
    var best = null;
    Object.keys(datierte).forEach(function (id) {
        if (datierte[id].sektor !== sektor) return;
        if (!best || datierte[id].datum > datierte[best].datum) best = id;
    });
    return best;
}

/* Löscht die übrig gebliebenen datierten Baskets — nur nach Rückfrage, es sind
   Baskets des Benutzers. Der gerade angezeigte bleibt in jedem Fall stehen.
   @returns {number} Anzahl der gelöschten Baskets. */
function _screenerLoescheDatierteReste(datierte) {
    var reste = Object.keys(datierte).filter(function (id) { return id !== currentBasket; });
    if (!reste.length) return 0;
    var namen = reste.map(function (id) { return baskets[id].name; }).sort();
    var liste = namen.slice(0, 12).join('\n  • ');
    if (namen.length > 12) liste += '\n  … und ' + (namen.length - 12) + ' weitere';
    if (!confirm('Der Screener schreibt jetzt in feste Baskets ohne Datum.\n\n'
                 + namen.length + ' alte datierte Basket'
                 + (namen.length === 1 ? '' : 's') + ' löschen?\n\n  • ' + liste)) {
        return 0;
    }
    reste.forEach(function (id) { delete baskets[id]; });
    logIt(3, 'Screener', reste.length + ' alte datierte Screener-Baskets gelöscht');
    return reste.length;
}

/* Führt die datierten Baskets auf die festen Namen zusammen, ohne dass dafür ein
   Screening laufen muss: je Sektor wird der jüngste umbenannt, der Rest kann weg.
   Die Gewichte bleiben unangetastet — umbenannt wird nur. */
async function screenerMergeDated() {
    var datierte = _screenerDatierteBaskets();
    if (!Object.keys(datierte).length) {
        _scrMsg('Keine datierten Screener-Baskets vorhanden', 'err');
        _scrUpdateMergeBtn();
        return;
    }

    var belegt = {};
    Object.keys(baskets).forEach(function (id) {
        if (baskets[id] && baskets[id].name) belegt[baskets[id].name] = id;
    });

    var sektoren = [];
    Object.keys(datierte).forEach(function (id) {
        if (sektoren.indexOf(datierte[id].sektor) === -1) sektoren.push(datierte[id].sektor);
    });

    var migriert = 0;
    sektoren.forEach(function (sektor) {
        var name = SCREENER_BASKET_PREFIX + sektor;
        if (belegt[name]) return;   // fester Basket existiert schon → der datierte ist Altlast
        var alt = _screenerJuengsterDatierter(datierte, sektor);
        if (!alt) return;
        baskets[alt].name = name;
        belegt[name] = alt;
        delete datierte[alt];
        migriert++;
    });

    var geloescht = _screenerLoescheDatierteReste(datierte);
    if (!migriert && !geloescht) {
        _scrMsg('Nichts geändert', 'ok');
        return;
    }

    try {
        await saveBasketsToServer('screener');
        if (typeof renderBasketSelect === 'function') renderBasketSelect();
        if (typeof updateChartTitle   === 'function') updateChartTitle();
        var summary = [];
        if (migriert)  summary.push(migriert + ' umbenannt');
        if (geloescht) summary.push(geloescht + ' gelöscht');
        logIt(3, 'Screener', 'Datierte Baskets zusammengeführt: ' + summary.join(', '));
        _scrMsg('Baskets: ' + summary.join(', '), 'ok');
    } catch (e) {
        _scrMsg('Speichern fehlgeschlagen: ' + e, 'err');
    }
    _scrUpdateMergeBtn();
}

/* Übergangshilfe: der Knopf zeigt sich nur, solange es überhaupt noch Baskets
   mit Datum im Namen gibt. */
function _scrUpdateMergeBtn() {
    var btn = document.getElementById('scr-btn-merge');
    if (!btn) return;
    var anzahl = Object.keys(_screenerDatierteBaskets()).length;
    btn.style.display = anzahl ? '' : 'none';
    btn.textContent   = '⇄ ' + anzahl + ' datierte Basket' + (anzahl === 1 ? '' : 's')
                      + ' zusammenführen';
}

/* Namenspräfix, unter dem screenerToBaskets() seine Baskets anlegt. */
var SCREENER_BASKET_PREFIX = 'Screener ';

function _screenerBasketIds() {
    return Object.keys(baskets).filter(function (id) {
        return ((baskets[id] || {}).name || '').indexOf(SCREENER_BASKET_PREFIX) === 0;
    });
}

/* Entfernt alle vom Screener angelegten Baskets auf einmal — sonst muss jeder
   einzeln über das ×-Symbol weg. Handarbeit gelöschte Baskets sind nicht
   wiederherstellbar, deshalb Rückfrage mit vollständiger Liste. */
async function screenerDeleteBaskets() {
    var ids = _screenerBasketIds();
    if (!ids.length) {
        _scrMsg('Keine Screener-Baskets vorhanden', 'err');
        return;
    }

    var namen = ids.map(function (id) { return baskets[id].name; }).sort();
    var liste = namen.slice(0, 12).join('\n  • ');
    if (namen.length > 12) liste += '\n  … und ' + (namen.length - 12) + ' weitere';
    if (!confirm(namen.length + ' Screener-Basket' + (namen.length === 1 ? '' : 's')
                 + ' unwiderruflich löschen?\n\n  • ' + liste)) {
        return;
    }

    var warAktiv = ids.indexOf(currentBasket) !== -1;
    ids.forEach(function (id) { delete baskets[id]; });
    logIt(3, 'Screener', namen.length + ' Screener-Baskets gelöscht');

    // Ohne Basket ist die App nicht bedienbar — dann einen leeren anlegen,
    // genau wie loadConfig() es beim ersten Start tut.
    if (!Object.keys(baskets).length) {
        var neu = 'basket_' + Date.now();
        baskets[neu] = {
            name: 'Mein Portfolio', weights: {}, period: 180, tf: '1D',
            perfSinceDate: '', indicators: { ma50: false, ma200: false, reg: false },
            logScale: false,
        };
        logIt(2, 'Screener', 'Alle Baskets waren Screener-Baskets — leeres „Mein Portfolio" angelegt');
    }

    try {
        if (warAktiv) {
            currentBasket = Object.keys(baskets)[0];
            await saveBasketsToServer();
            await switchBasket(currentBasket);   // lädt Gewichte, Chart und Watchlist neu
        } else {
            await saveBasketsToServer();
        }
        if (typeof renderBasketSelect === 'function') renderBasketSelect();
        _scrMsg(namen.length + ' Basket' + (namen.length === 1 ? '' : 's') + ' gelöscht', 'ok');
    } catch (e) {
        logIt(1, 'Screener', 'Löschen konnte nicht gespeichert werden: ' + e.message);
        _scrMsg('Speichern fehlgeschlagen: ' + e, 'err');
    }
}


/* ───────────────────────────────────────────────────────────────────────────
 *  SCREENER — Blacklist
 *
 *  Die Einträge entstehen nicht hier, sondern serverseitig beim Speichern der
 *  Config: was aus einem Screener-Basket verschwindet, hat der Benutzer beim
 *  Chart-Durchgang aussortiert (main.py: _screener_protokolliere_entfernte).
 *  Diese Seite zeigt das Ergebnis und gibt einzelne Werte wieder frei.
 * ─────────────────────────────────────────────────────────────────────────── */

/* Kleiner Bauhelfer — folio hat keinen globalen, und der Abschnitt braucht ein
   Dutzend Elemente. Gleiche Machart wie _scrRenderResults(). */
function _scrEl(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
}

function _scrBlMsg(text, art) {
    var el = document.getElementById('scr-bl-msg');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'settings-msg' + (art ? ' ' + art : '');
}

async function screenerBlacklistLoad() {
    var liste = document.getElementById('scr-bl-list');
    if (!liste) return;
    try {
        var d = await fetch('/api/screener/blacklist').then(function (r) { return r.json(); });
    } catch (e) {
        _scrBlMsg('Blacklist nicht erreichbar', 'err');
        return;
    }
    var cd = document.getElementById('scr-bl-cooldown');
    var ak = document.getElementById('scr-bl-active');
    if (cd) cd.value = d.cooldown_months || 6;
    if (ak) ak.checked = d.active !== false;

    document.getElementById('scr-bl-count').textContent =
        (d.count || 0) + (d.count === 1 ? ' Wert' : ' Werte');

    liste.innerHTML = '';
    if (!d.count) {
        liste.appendChild(_scrEl('div', 'settings-hint',
            'Noch nichts gesperrt. Entferne einen Wert aus einem Screener-Basket — '
            + 'er steht dann hier.'));
        return;
    }
    (d.entries || []).forEach(function (e) {
        var alter = (e.age_days === null || e.age_days === undefined) ? ''
            : (e.age_days < 30 ? e.age_days + ' Tage'
                               : Math.floor(e.age_days / 30) + ' Mon.');
        var item = _scrEl('span', 'scr-bl-item');
        item.title = (e.from ? 'entfernt aus: ' + e.from + '\n' : '') + 'gesperrt seit ' + e.date;
        item.appendChild(_scrEl('span', 'scr-bl-tick', e.ticker));
        item.appendChild(_scrEl('span', 'scr-bl-age', alter));
        var x = _scrEl('button', 'scr-bl-x', '×');
        x.type  = 'button';
        x.title = e.ticker + ' wieder zulassen';
        x.onclick = function () { screenerBlacklistFree(e.ticker); };
        item.appendChild(x);
        liste.appendChild(item);
    });
}

/** Sperrzeit und Ein/Aus — wird bei jeder Änderung der beiden Felder gerufen. */
async function screenerBlacklistSave() {
    var cd = document.getElementById('scr-bl-cooldown');
    var ak = document.getElementById('scr-bl-active');
    var body = {
        cooldown_months: Math.max(1, Math.min(parseInt(cd && cd.value, 10) || 6, 120)),
        active: !!(ak && ak.checked),
    };
    try {
        var r = await fetch('/api/screener/blacklist', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }).then(function (r) { return r.json(); });
        if (!r.ok) { _scrBlMsg(r.error || 'Speichern fehlgeschlagen', 'err'); return; }
        if (cd) cd.value = r.cooldown_months;      // serverseitig begrenzt
        _scrBlMsg('gespeichert', 'ok');
        // Die Sperrzeit entscheidet, was noch wirksam ist — Liste neu holen.
        screenerBlacklistLoad();
    } catch (e) {
        _scrBlMsg('Speichern fehlgeschlagen: ' + e, 'err');
    }
}

/** Einen Wert wieder zulassen (Whitelist). */
async function screenerBlacklistFree(ticker) {
    try {
        var r = await fetch('/api/screener/blacklist/' + encodeURIComponent(ticker),
                            { method: 'DELETE' }).then(function (r) { return r.json(); });
        if (!r.ok) { _scrBlMsg(r.error || 'Freigeben fehlgeschlagen', 'err'); return; }
        logIt(3, 'Screener', ticker + ' wieder zugelassen');
        _scrBlMsg(ticker + ' wieder zugelassen', 'ok');
        screenerBlacklistLoad();
    } catch (e) {
        _scrBlMsg('Freigeben fehlgeschlagen: ' + e, 'err');
    }
}

async function screenerBlacklistClear() {
    var anzahl = (document.getElementById('scr-bl-count') || {}).textContent || '';
    if (!confirm('Alle gesperrten Werte wieder zulassen (' + anzahl + ')?\n\n'
               + 'Beim nächsten Screening können sie wieder in den Baskets landen.')) return;
    try {
        var r = await fetch('/api/screener/blacklist', { method: 'DELETE' })
                        .then(function (r) { return r.json(); });
        if (!r.ok) { _scrBlMsg(r.error || 'Leeren fehlgeschlagen', 'err'); return; }
        logIt(3, 'Screener', 'Blacklist geleert (' + r.removed + ')');
        _scrBlMsg(r.removed + ' wieder zugelassen', 'ok');
        screenerBlacklistLoad();
    } catch (e) {
        _scrBlMsg('Leeren fehlgeschlagen: ' + e, 'err');
    }
}

/** Hinweis über den Ergebnissen: was die Blacklist aus diesem Lauf ferngehalten hat. */
function _scrRenderBlocked(blocked) {
    var box = document.getElementById('scr-blocked');
    if (!box) return;
    if (!blocked || !blocked.length) { box.style.display = 'none'; box.innerHTML = ''; return; }
    box.innerHTML = '';
    box.appendChild(_scrEl('span', 'scr-blocked-head',
        '🚫 ' + blocked.length + ' gesperrt, nicht in den Baskets:'));
    box.appendChild(_scrEl('span', 'scr-blocked-list', blocked.join(', ')));
    box.style.display = '';
}

// ╔══════════════════════════════════════════════════════════╗
// ║  HILFE-SEITE                                              ║
// ╚══════════════════════════════════════════════════════════╝
// Das Verzeichnis entsteht aus den Karten selbst (data-t), damit eine neue
// Karte im HTML genügt und hier nichts nachgepflegt werden muss.

var _helpBuilt = false;

function helpInit() {
    if (_helpBuilt) return;
    var toc = document.getElementById('help-toc');
    if (!toc) return;
    toc.innerHTML = '';
    _helpCards().forEach(function (card) {
        var b = document.createElement('button');
        b.type = 'button';
        b.textContent = card.getAttribute('data-t') || card.id;
        b.setAttribute('data-for', card.id);
        b.onclick = function () { helpGoto(card.id); };
        toc.appendChild(b);
    });
    _helpBuilt = true;
    _helpMarkActive();
    var body = document.getElementById('helpBody');
    if (body) body.addEventListener('scroll', _helpMarkActive, { passive: true });
}

function _helpCards() {
    return Array.prototype.slice.call(document.querySelectorAll('#helpBody .help-card'));
}

function helpGoto(id) {
    var card = document.getElementById(id);
    if (card) card.scrollIntoView({ block: 'start' });
}

/* Hebt im Verzeichnis die Karte hervor, die gerade oben im Blick ist. */
function _helpMarkActive() {
    var body = document.getElementById('helpBody');
    if (!body) return;
    var grenze = body.getBoundingClientRect().top + 40;
    var aktiv = null;
    _helpCards().forEach(function (card) {
        if (card.style.display === 'none') return;
        if (card.getBoundingClientRect().top <= grenze) aktiv = card.id;
    });
    if (!aktiv) {
        var sichtbar = _helpCards().filter(function (c) { return c.style.display !== 'none'; });
        aktiv = sichtbar.length ? sichtbar[0].id : null;
    }
    document.querySelectorAll('#help-toc button').forEach(function (b) {
        b.classList.toggle('active', b.getAttribute('data-for') === aktiv);
    });
}

/* Blendet Karten aus, die den Suchbegriff nicht enthalten — Verzeichnis mit. */
function helpFilter(q) {
    var such = (q || '').trim().toLowerCase();
    var treffer = 0;
    _helpCards().forEach(function (card) {
        var passt = !such || (card.textContent || '').toLowerCase().indexOf(such) !== -1;
        card.style.display = passt ? '' : 'none';
        var b = document.querySelector('#help-toc button[data-for="' + card.id + '"]');
        if (b) b.style.display = passt ? '' : 'none';
        if (passt) treffer++;
    });
    var leer = document.getElementById('help-nohit');
    if (leer) leer.style.display = treffer ? 'none' : '';
    _helpMarkActive();
}

// ╔══════════════════════════════════════════════════════════╗
// ║ 17. KONTEN & VERMÖGEN                                     ║
// ╚══════════════════════════════════════════════════════════╝
//
// Alles außerhalb von IBKR: Girokonten, Tagesgeld, weitere Depots (Baader/
// Smartbroker), Darlehen und Sachwerte. Der Zustand liegt in `kontenState`
// (shared.js), damit der Portfolio-Report ihn auch ohne geöffnete Seite kennt.
//
// Die Wertpapiere eines weiteren Depots landen über /api/ibkr/positions in
// `ibkrPositions` und werden dadurch überall mitbewertet; das Feld `account`
// sagt, aus welchem Depot eine Zeile stammt.

var _kontenOffen   = null;   // id des gerade bearbeiteten Kontos ('' = neues)
var _kontenVorschau = null;  // Ergebnis des letzten Import-Probelaufs
var _wealthChart   = null;   // Lightweight-Charts-Instanz der Verlaufskurve
var _wealthSeries  = {};     // { schluessel: Serie }
var _wealthZeitraum = 'alles';
var _wealthKonto   = '';     // '' = Gesamtvermögen, sonst Konto-id

/** IBKR-Depotwert mit Live-Kursen — dieselbe Rechnung wie „NET Gesamt". */
function kontenIbkrLive() {
    var ccyFx = ibkrCcyFx();
    var cashBase = (ibkrCash || []).find(function(c) { return c.currency === 'BASE'; });
    var total = cashBase ? (cashBase.ending_cash || 0) : 0;
    ibkrPositionsIbkr().forEach(function(p) { total += ibkrLiveValue(p, ccyFx); });
    return total;
}

/** Lädt Konten, Vermögensübersicht und Verlauf und zeichnet die Seite neu. */
async function kontenLoad() {
    var fertig = logTimer(4, 'Konten', 'Konten laden');
    try {
        var daten = await kontenLaden();
        kontenState.accounts = daten.accounts || [];
        logIt(3, 'Konten', kontenState.accounts.length + ' Konten geladen');

        // Der Server kennt nur den Stand vom letzten Sync — den Live-Wert
        // rechnen wir hier und geben ihn mit, damit auch die Fortschreibung stimmt.
        var live = (ibkrPositions || []).length ? kontenIbkrLive() : null;
        kontenState.summary = await vermoegenLaden(live);
        kontenState.verlauf = await vermoegenVerlaufLaden();
        logIt(5, 'Konten', 'Verlauf: ' + kontenState.verlauf.length + ' Tage');
    } catch (e) {
        logIt(1, 'Konten', 'Laden fehlgeschlagen: ' + e.message);
    }
    fertig();
    renderKonten();
}

/** Zeichnet Übersicht, Liste, Formular und Kurve. */
function renderKonten() {
    renderVermoegensKacheln();
    renderKontenListe();
    renderWealthKontoWahl();
    renderWealthChart();
    if (_kontenOffen !== null) renderKontenFormular();
}

/** Füllt das Auswahlfeld über der Kurve mit den angelegten Konten. */
function renderWealthKontoWahl() {
    var el = document.getElementById('wealthKontoWahl');
    if (!el) return;
    var h = '<option value="">Gesamtvermögen</option>';
    (kontenState.accounts || []).forEach(function(a) {
        h += '<option value="' + a.id + '"' + (_wealthKonto === a.id ? ' selected' : '') + '>'
           + escHtml(a.name) + '</option>';
    });
    el.innerHTML = h;
}

// ── Vermögensübersicht ───────────────────────────────────────────────────────

function renderVermoegensKacheln() {
    var el = document.getElementById('vermoegenKacheln');
    if (!el) return;
    var s = kontenState.summary;
    if (!s) { el.innerHTML = '<div class="v-hint">Noch keine Daten.</div>'; return; }

    // Depots live nachrechnen (der Server kennt nur den Importstand)
    var depots = 0, guthaben = 0, sachwerte = 0, schulden = 0;
    (kontenState.accounts || []).forEach(function(a) {
        if (a.archived) return;
        var w = kontoWert(a);
        if      (a.kind === 'depot')    depots    += w;
        else if (a.kind === 'sachwert') sachwerte += w;
        else if (a.kind === 'darlehen') schulden  += w;
        else                            guthaben  += w;
    });
    var ibkr  = (ibkrPositions || []).length ? kontenIbkrLive() : (s.ibkr || 0);
    var total = ibkr + depots + guthaben + sachwerte - schulden;

    var kachel = function(titel, wert, klasse) {
        return '<div class="v-kachel ' + (klasse || '') + '">'
             + '<div class="v-kachel-t">' + titel + '</div>'
             + '<div class="v-kachel-w">' + fmtEur(wert) + '</div></div>';
    };
    var h = '<div class="v-kacheln">';
    h += kachel('IBKR-Depot', ibkr);
    if (depots)    h += kachel('Weitere Depots', depots);
    if (guthaben)  h += kachel('Guthaben', guthaben);
    if (sachwerte) h += kachel('Sachwerte', sachwerte);
    if (schulden)  h += kachel('Schulden', -schulden, 'v-minus');
    h += '</div>';
    h += '<div class="v-gesamt"><span>Vermögen gesamt</span><b>' + fmtEur(total) + '</b></div>';

    // Veränderung gegenüber Vormonat und Jahresanfang
    var reihe = kontenState.verlauf || [];
    if (reihe.length > 1) {
        var heute = reihe[reihe.length - 1];
        var teile = [];
        var vgl = function(label, ab) {
            var frueher = null;
            for (var i = 0; i < reihe.length; i++) { if (reihe[i].date <= ab) frueher = reihe[i]; }
            if (!frueher || !frueher.total) return;
            var d = (heute.total || 0) - frueher.total;
            var p = d / Math.abs(frueher.total) * 100;
            teile.push('<span>' + label + ' <b style="color:' + (d >= 0 ? 'var(--green)' : 'var(--red)') + '">'
                + fmtEurSign(d) + ' (' + (d >= 0 ? '+' : '') + p.toFixed(1) + '%)</b></span>');
        };
        var d30 = new Date(); d30.setMonth(d30.getMonth() - 1);
        vgl('30 Tage', d30.toISOString().slice(0, 10));
        vgl('seit 1.1.', new Date().getFullYear() + '-01-01');
        if (teile.length) h += '<div class="v-delta">' + teile.join('') + '</div>';
    }
    el.innerHTML = h;
}

// ── Kontenliste ──────────────────────────────────────────────────────────────

function renderKontenListe() {
    var el = document.getElementById('kontenListe');
    if (!el) return;
    var accs = kontenState.accounts || [];
    var h = '<table class="konten-tab"><thead><tr>'
          + '<th>Konto</th><th>Institut</th><th>Art</th><th style="text-align:right">Wert</th>'
          + '<th>Stand</th><th></th></tr></thead><tbody>';

    // IBKR steht mit in der Liste, obwohl es kein Konto in `accounts` ist —
    // sonst fehlt in der Aufstellung ausgerechnet der größte Posten. Gepflegt
    // wird es nicht hier, sondern über den Flex-Sync; darum kein „Bearbeiten".
    var ibkrPos  = ibkrPositionsIbkr();
    var ibkrWert = ibkrPos.length ? kontenIbkrLive()
                                  : ((kontenState.summary || {}).ibkr || 0);
    if (ibkrWert || ibkrPos.length) {
        h += '<tr>'
           + '<td><b>IBKR-Depot</b>'
           + (ibkrPos.length ? ' <span class="k-badge">' + ibkrPos.length + ' Titel</span>' : '')
           + (ibkrPos.length ? ' <span class="k-badge">live</span>' : '')
           + '</td>'
           + '<td style="color:var(--muted)">Interactive Brokers</td>'
           + '<td style="color:var(--muted)">Depot</td>'
           + '<td style="text-align:right">' + fmtEur(ibkrWert) + '</td>'
           + '<td style="color:var(--muted);font-size:10px">'
           + escHtml(ibkrLastSync ? String(ibkrLastSync).slice(0, 10) : '—') + '</td>'
           + '<td style="text-align:right"><button class="refresh-btn k-mini" '
           + 'onclick="location.hash=\'#/ibkr\'">Öffnen</button></td>'
           + '</tr>';
    }

    accs.forEach(function(a) {
        var w = kontoWert(a);
        var minus = a.kind === 'darlehen';
        h += '<tr' + (a.archived ? ' style="opacity:.5"' : '') + '>'
           + '<td><b>' + escHtml(a.name) + '</b>'
           + (a.kind === 'depot' && a.positions_count
                ? ' <span class="k-badge">' + a.positions_count + ' Titel</span>' : '')
           + (a.archived ? ' <span class="k-badge">stillgelegt</span>' : '')
           + '</td>'
           + '<td style="color:var(--muted)">' + escHtml(a.institute || '—') + '</td>'
           + '<td style="color:var(--muted)">' + (KONTO_ARTEN[a.kind] || a.kind) + '</td>'
           + '<td style="text-align:right;color:' + (minus ? 'var(--red)' : 'var(--text)') + '">'
           + fmtEur(minus ? -w : w) + '</td>'
           + '<td style="color:var(--muted);font-size:10px">' + escHtml(a.balance_date || '—') + '</td>'
           + '<td style="text-align:right"><button class="refresh-btn k-mini" onclick="kontenFormOeffnen(\''
           + a.id + '\')">Bearbeiten</button></td>'
           + '</tr>';
        // Darlehen mit zugeordnetem Sachwert: Nettoposition darunter
        if (a.kind === 'darlehen' && a.asset_id) {
            var obj = accs.find(function(x) { return x.id === a.asset_id; });
            if (obj) {
                var netto = kontoWert(obj) - w;
                h += '<tr class="k-unterzeile"><td colspan="3">↳ zusammen mit '
                   + escHtml(obj.name) + '</td>'
                   + '<td style="text-align:right;color:' + (netto >= 0 ? 'var(--green)' : 'var(--red)') + '">'
                   + fmtEur(netto) + '</td><td colspan="2"></td></tr>';
            }
        }
    });
    h += '</tbody></table>';
    if (!accs.length) {
        h += '<div class="v-hint">Daneben ist noch nichts angelegt. '
           + '„Konto anlegen" öffnet das Formular.</div>';
    }
    el.innerHTML = h;
}

// ── Formular ─────────────────────────────────────────────────────────────────

function kontenFormOeffnen(id) {
    _kontenOffen = id === undefined ? '' : id;
    _kontenVorschau = null;
    renderKontenFormular();
    var el = document.getElementById('kontenForm');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function kontenFormSchliessen() {
    _kontenOffen = null;
    _kontenVorschau = null;
    _umsatzVorschau = null;
    _umsatzQuelle   = null;
    var el = document.getElementById('kontenForm');
    if (el) el.innerHTML = '';
}

function renderKontenFormular() {
    var el = document.getElementById('kontenForm');
    if (!el) return;
    var a = (kontenState.accounts || []).find(function(x) { return x.id === _kontenOffen; })
            || { id: '', kind: 'giro', currency: 'EUR', fx_rate: 1 };
    var neu = !a.id;

    var feld = function(id, label, wert, typ, hint) {
        return '<label class="settings-field"><span>' + label + '</span>'
             + '<input id="' + id + '" type="' + (typ || 'text') + '" value="'
             + escHtml(wert == null ? '' : wert) + '"'
             + (hint ? ' placeholder="' + escHtml(hint) + '"' : '') + '></label>';
    };

    var h = '<div class="settings-card">';
    h += '<h2 class="settings-h">' + (neu ? 'Konto anlegen' : escHtml(a.name))
       + '<span class="settings-badge">' + (KONTO_ARTEN[a.kind] || a.kind) + '</span></h2>';

    h += '<label class="settings-field"><span>Art</span><select id="k-kind" onchange="renderKontenFormularFelder()">';
    Object.keys(KONTO_ARTEN).forEach(function(k) {
        h += '<option value="' + k + '"' + (a.kind === k ? ' selected' : '') + '>' + KONTO_ARTEN[k] + '</option>';
    });
    h += '</select></label>';

    h += feld('k-name', 'Name', a.name, 'text', 'z. B. GLS Girokonto');
    h += feld('k-institute', 'Institut', a.institute, 'text', 'z. B. GLS Bank');
    h += '<div id="k-typfelder"></div>';
    h += feld('k-note', 'Notiz', a.note);

    h += '<div class="settings-actions">'
       + '<button class="refresh-btn" onclick="kontenSpeichernKlick(this)">Speichern</button>'
       + (neu ? '' : '<button class="refresh-btn" onclick="kontenLoeschenKlick(\'' + a.id + '\')">Löschen</button>')
       + '<button class="refresh-btn" onclick="kontenFormSchliessen()">Schließen</button>'
       + '<span id="k-msg" class="settings-msg"></span></div>';
    h += '<input type="hidden" id="k-id" value="' + escHtml(a.id || '') + '">';
    h += '</div>';

    // Depot: Depotauszug + Positionen; alles außer Sachwert: Umsätze; jedes Konto: Verlauf
    var mitUmsatz = KONTO_UMSATZ_ARTEN.indexOf(a.kind) >= 0;
    if (!neu) {
        if (a.kind === 'depot') h += '<div class="settings-card" id="k-import-karte"></div>';
        if (mitUmsatz)          h += '<div class="settings-card" id="k-umsatz-karte"></div>';
        if (a.kind === 'depot') h += '<div class="settings-card" id="k-rueck-karte"></div>';
        h += '<div class="settings-card" id="k-verlauf-karte"></div>';
    }
    el.innerHTML = h;
    renderKontenFormularFelder();
    if (!neu) {
        if (a.kind === 'depot') renderKontenImportKarte(a);
        if (mitUmsatz)          renderKontenUmsatzKarte(a);
        if (a.kind === 'depot') renderRueckrechnungKarte(a);
        renderKontenVerlaufKarte(a);
    }
}

/** Die art-abhängigen Felder — hängt an der Auswahl „Art". */
function renderKontenFormularFelder() {
    var el = document.getElementById('k-typfelder');
    if (!el) return;
    var kind = (document.getElementById('k-kind') || {}).value || 'giro';
    var a = (kontenState.accounts || []).find(function(x) { return x.id === _kontenOffen; }) || {};

    var feld = function(id, label, wert, hint) {
        return '<label class="settings-field"><span>' + label + '</span>'
             + '<input id="' + id + '" type="text" value="' + escHtml(wert == null ? '' : wert) + '"'
             + (hint ? ' placeholder="' + escHtml(hint) + '"' : '') + '></label>';
    };
    var h = '';
    if (kind === 'sachwert') {
        h += feld('k-valuation', 'Geschätzter Verkaufserlös (€)', a.valuation, 'z. B. 285000');
        h += feld('k-valuation-date', 'Schätzung vom', a.valuation_date || heuteIso(), 'JJJJ-MM-TT');
    } else {
        var label = kind === 'darlehen' ? 'Restschuld (€, positiv)'
                  : kind === 'depot'    ? 'Verrechnungskonto (€)' : 'Saldo (€)';
        h += feld('k-balance', label, a.balance, '0');
        h += feld('k-balance-date', 'Stand vom', a.balance_date || heuteIso(), 'JJJJ-MM-TT');
    }
    if (kind === 'darlehen') {
        h += feld('k-interest', 'Zinssatz (% p. a.)', a.interest, 'z. B. 3,4');
        h += feld('k-rate', 'Monatliche Rate (€)', a.rate, 'z. B. 950');
        h += feld('k-fixed-until', 'Zinsbindung bis', a.fixed_until, 'JJJJ-MM-TT');
        // Prognose rechnet bei jeder Eingabe mit
        h = h.replace(/<input id="k-(balance|interest|rate|fixed-until)"/g,
                      '<input oninput="renderTilgungsVorschau()" id="k-$1"');
        h += '<label class="settings-field"><span>Zugeordneter Sachwert</span><select id="k-asset">'
           + '<option value="">— keiner —</option>';
        (kontenState.accounts || []).filter(function(x) { return x.kind === 'sachwert'; })
            .forEach(function(x) {
                h += '<option value="' + x.id + '"' + (a.asset_id === x.id ? ' selected' : '') + '>'
                   + escHtml(x.name) + '</option>';
            });
        h += '</select></label>';
    }
    if (kind !== 'sachwert') {
        h += '<label class="settings-field"><span>Währung</span><input id="k-currency" type="text" value="'
           + escHtml(a.currency || 'EUR') + '" style="max-width:80px"></label>';
        h += feld('k-fx', 'Kurs zu Euro (1 bei Euro-Konten)', a.fx_rate == null ? 1 : a.fx_rate);
    }
    el.innerHTML = h;

    // Tilgungsvorschau, sobald Restschuld, Zins und Rate stehen
    if (kind === 'darlehen') renderTilgungsVorschau();
}

/** Restschuld-Prognose aus Rate und Zinssatz (Annuität, monatlich). Liest die Felder. */
function renderTilgungsVorschau() {
    var el = document.getElementById('k-typfelder');
    if (!el) return;
    var rest = zahl((document.getElementById('k-balance') || {}).value);
    var zins = zahl((document.getElementById('k-interest') || {}).value);
    var rate = zahl((document.getElementById('k-rate') || {}).value);
    if (!rest || !rate) return;

    var monate = 0, r = Math.abs(rest), zinsSumme = 0;
    var m = zins / 100 / 12;
    while (r > 0 && monate < 720) {
        var z = r * m;
        if (rate <= z) { monate = -1; break; }    // Rate deckt nicht mal die Zinsen
        zinsSumme += z;
        r = r + z - rate;
        monate++;
    }
    var h = '<div class="k-prognose">';
    if (monate < 0) {
        h += 'Die Rate deckt die Zinsen nicht — die Schuld wächst.';
    } else {
        var fertig = new Date();
        fertig.setMonth(fertig.getMonth() + monate);
        h += 'Bei ' + fmtEur(rate) + ' im Monat und ' + (zins || 0).toString().replace('.', ',')
           + ' % getilgt in <b>' + Math.floor(monate / 12) + ' J ' + (monate % 12) + ' M</b> (bis '
           + fertig.toISOString().slice(0, 7).replace('-', '/') + '), Zinsen zusammen '
           + fmtEur(zinsSumme) + '.';
        var bis = (document.getElementById('k-fixed-until') || {}).value;
        if (bis && /^\d{4}-\d{2}-\d{2}$/.test(bis)) {
            var bisM = Math.max(0, Math.round((new Date(bis) - new Date()) / (1000 * 3600 * 24 * 30.44)));
            var rr = Math.abs(rest);
            for (var i = 0; i < bisM && rr > 0; i++) { rr = rr + rr * m - rate; }
            h += '<br>Restschuld am Ende der Zinsbindung: <b>' + fmtEur(Math.max(0, rr)) + '</b>.';
        }
    }
    h += '</div>';
    var alt = el.querySelector('.k-prognose');
    if (alt) alt.outerHTML = h; else el.insertAdjacentHTML('beforeend', h);
}

async function kontenSpeichernKlick(btn) {
    var msg = document.getElementById('k-msg');
    var setMsg = function(t, c) { if (msg) { msg.textContent = t; msg.className = 'settings-msg ' + (c || ''); } };
    var wert = function(id) { var e = document.getElementById(id); return e ? e.value : ''; };

    var konto = {
        id:        wert('k-id'),
        kind:      wert('k-kind'),
        name:      wert('k-name'),
        institute: wert('k-institute'),
        note:      wert('k-note'),
        currency:  wert('k-currency') || 'EUR',
        fx_rate:   wert('k-fx') || 1,
        balance:      wert('k-balance'),
        balance_date: wert('k-balance-date'),
        valuation:      wert('k-valuation'),
        valuation_date: wert('k-valuation-date'),
        interest:    wert('k-interest'),
        rate:        wert('k-rate'),
        fixed_until: wert('k-fixed-until'),
        asset_id:    wert('k-asset')
    };
    if (konto.kind === 'sachwert') konto.balance_date = konto.valuation_date;
    if (!konto.name.trim()) { setMsg('Name fehlt', 'err'); return; }

    btn.disabled = true;
    var alt = btn.textContent;
    btn.textContent = 'Speichere…';
    try {
        var res = await kontenSpeichern(konto);
        if (res.ok) {
            setMsg('✓ Gespeichert', 'ok');
            logIt(3, 'Konten', 'Konto „' + konto.name + '" gespeichert');
            _kontenOffen = res.account.id;
            await kontenLoad();
        } else {
            setMsg('Fehler: ' + (res.error || 'unbekannt'), 'err');
            logIt(1, 'Konten', 'Speichern fehlgeschlagen: ' + (res.error || '?'));
        }
    } catch (e) {
        setMsg('Verbindungsfehler: ' + e.message, 'err');
        logIt(1, 'Konten', 'Speichern fehlgeschlagen: ' + e.message);
    } finally {
        btn.disabled = false;
        btn.textContent = alt;
    }
}

async function kontenLoeschenKlick(id) {
    var a = (kontenState.accounts || []).find(function(x) { return x.id === id; });
    if (!confirm('Konto „' + (a ? a.name : id) + '" mit Verlauf und Positionen löschen?')) return;
    var res = await kontenLoeschen(id);
    if (res.ok) {
        logIt(3, 'Konten', 'Konto gelöscht');
        kontenFormSchliessen();
        await kontenLoad();
    }
}

// ── Verlauf eines Kontos ─────────────────────────────────────────────────────

async function renderKontenVerlaufKarte(a) {
    var el = document.getElementById('k-verlauf-karte');
    if (!el) return;
    var reihe = [];
    try { reihe = await kontenVerlaufLaden(a.id); } catch (e) { /* leer lassen */ }

    var h = '<h2 class="settings-h">Verlauf</h2>'
          + '<p class="settings-hint">Jeder gespeicherte Stand landet hier. Ältere Stände '
          + 'kannst du nachtragen — die Vermögenskurve reicht dann weiter zurück.</p>';
    h += '<div class="k-verlauf-eingabe">'
       + '<input id="k-v-datum" type="text" placeholder="JJJJ-MM-TT" value="' + heuteIso() + '">'
       + '<input id="k-v-wert" type="text" placeholder="Betrag">'
       + '<button class="refresh-btn k-mini" onclick="kontenVerlaufKlick(\'' + a.id + '\', this)">Eintragen</button>'
       + '<span id="k-v-msg" class="settings-msg"></span></div>';
    if (reihe.length) {
        // Vollständig, nur scrollbar — nach einem Stapel Auszüge muss sich jeder
        // Monatsstand nachschlagen lassen, nicht nur die letzten vierzig.
        h += '<p class="settings-hint">' + reihe.length + ' Stände von '
           + escHtml(reihe[0].date) + ' bis ' + escHtml(reihe[reihe.length - 1].date) + '.</p>'
           + '<div class="k-umsatz-liste"><table class="konten-tab k-verlauf-tab"><tbody>';
        reihe.slice().reverse().forEach(function(r) {
            h += '<tr><td>' + escHtml(r.date) + '</td>'
               + '<td style="text-align:right">' + fmtEur(r.value, 2) + '</td>'
               + '<td style="text-align:right"><button class="refresh-btn k-mini" onclick="kontenVerlaufWeg(\''
               + a.id + '\',\'' + r.date + '\')">×</button></td></tr>';
        });
        h += '</tbody></table></div>';
    }
    el.innerHTML = h;
}

async function kontenVerlaufKlick(id, btn) {
    var datum = (document.getElementById('k-v-datum') || {}).value || '';
    var wert  = (document.getElementById('k-v-wert') || {}).value || '';
    var msg   = document.getElementById('k-v-msg');
    var setMsg = function(t, c) { if (msg) { msg.textContent = t; msg.className = 'settings-msg ' + (c || ''); } };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(datum.trim())) { setMsg('Datum als JJJJ-MM-TT', 'err'); return; }
    btn.disabled = true;
    try {
        var res = await kontenVerlaufSetzen(id, datum.trim(), wert);
        if (res.ok) {
            setMsg('✓', 'ok');
            logIt(3, 'Konten', 'Stand ' + datum + ' eingetragen');
            await kontenLoad();
        } else {
            setMsg(res.error || 'Fehler', 'err');
        }
    } catch (e) {
        setMsg('Fehler: ' + e.message, 'err');
    } finally {
        btn.disabled = false;
    }
}

async function kontenVerlaufWeg(id, datum) {
    await kontenVerlaufSetzen(id, datum, null);
    logIt(3, 'Konten', 'Stand ' + datum + ' entfernt');
    await kontenLoad();
}

// ── Depotauszug einlesen ─────────────────────────────────────────────────────

async function renderKontenImportKarte(a) {
    var el = document.getElementById('k-import-karte');
    if (!el) return;
    var h = '<h2 class="settings-h">Depotauszug einlesen</h2>'
          + '<p class="settings-hint">Die Bestandsdatei aus dem Online-Banking hier ablegen — '
          + 'CSV mit Semikolon, Komma oder Tabulator, mit Kopfzeile. Erkannt werden ISIN, '
          + 'Bezeichnung, Stück, Einstand, Kurs, Wert und Währung. Wer lieber kopiert, klappt '
          + 'das Feld darunter auf.</p>'
          + '<input type="file" id="k-depot-datei" class="k-datei" '
          + 'accept=".csv,.txt,.tsv,text/csv,text/plain" '
          + 'onchange="kontenDepotDatei(\'' + a.id + '\')">'
          + '<details class="k-einfuegen"><summary>… oder Tabelle einfügen</summary>'
          + '<textarea id="k-import-text" class="k-import-feld" rows="6" '
          + 'placeholder="ISIN;Bezeichnung;Stück;Einstand;Kurs;Wert&#10;DE0007164600;SAP SE;40;98,50;215,30;8612,00"></textarea>'
          + '<div class="settings-actions"><button class="refresh-btn k-mini" id="k-depot-pruef" '
          + 'onclick="kontenImportPruefen(\'' + a.id + '\', this)">Prüfen</button></div>'
          + '</details>'
          + '<div class="settings-actions"><span id="k-import-msg" class="settings-msg"></span></div>'
          + '<div id="k-import-vorschau"></div>';
    el.innerHTML = h;
    renderDepotPositionen(a);
}

/**
 * Datei als Text lesen. Deutsche Bankexporte kommen mal in UTF-8 (oft mit BOM),
 * mal in Windows-1252 — wird eine 1252-Datei als UTF-8 gelesen, zerfallen die
 * Umlaute. `fatal: true` lässt den ersten Versuch scheitern statt still zu raten.
 */
async function dateiText(datei) {
    var puffer = await datei.arrayBuffer();
    var text;
    try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(puffer);
    } catch (e) {
        text = new TextDecoder('windows-1252').decode(puffer);
    }
    return text.replace(/^﻿/, '');
}

/** Depotauszug aus einer Datei: einlesen, ins Feld legen, gleich prüfen. */
async function kontenDepotDatei(id) {
    var feld = document.getElementById('k-depot-datei');
    if (!feld || !feld.files || !feld.files.length) return;
    var msg = document.getElementById('k-import-msg');
    try {
        var text = await dateiText(feld.files[0]);
        var ta = document.getElementById('k-import-text');
        if (ta) ta.value = text;
        logIt(4, 'Konten', 'Depotauszug ' + feld.files[0].name + ' gelesen ('
              + text.length + ' Zeichen)');
        await kontenImportPruefen(id, document.getElementById('k-depot-pruef')
                                      || { disabled: false });
    } catch (e) {
        if (msg) { msg.textContent = 'Datei nicht lesbar: ' + e.message; msg.className = 'settings-msg err'; }
    }
}

async function kontenImportPruefen(id, btn) {
    var text = (document.getElementById('k-import-text') || {}).value || '';
    var msg  = document.getElementById('k-import-msg');
    var setMsg = function(t, c) { if (msg) { msg.textContent = t; msg.className = 'settings-msg ' + (c || ''); } };
    if (!text.trim()) { setMsg('Nichts eingefügt', 'err'); return; }
    btn.disabled = true;
    setMsg('Prüfe…', 'run');
    try {
        var res = await kontenImport(id, text);
        if (!res.ok) { setMsg(res.error || 'Nicht erkannt', 'err'); return; }
        _kontenVorschau = res;
        setMsg('', '');
        logIt(3, 'Konten', res.positionen.length + ' Positionen erkannt (' + res.trennzeichen + ')');
        renderImportVorschau(id, res);
    } catch (e) {
        setMsg('Fehler: ' + e.message, 'err');
    } finally {
        btn.disabled = false;
    }
}

function renderImportVorschau(id, res) {
    var el = document.getElementById('k-import-vorschau');
    if (!el) return;
    var h = '<p class="settings-hint">Erkannt: <b>' + res.positionen.length + ' Positionen</b>, '
          + 'Trennzeichen ' + res.trennzeichen + '.</p>';
    (res.hinweise || []).forEach(function(w) {
        h += '<p class="settings-hint" style="color:var(--red)">⚠ ' + escHtml(w) + '</p>';
    });
    h += '<table class="konten-tab"><thead><tr><th>ISIN</th><th>Bezeichnung</th>'
       + '<th style="text-align:right">Stück</th><th style="text-align:right">Einstand</th>'
       + '<th style="text-align:right">Kurs</th><th style="text-align:right">Wert</th></tr></thead><tbody>';
    res.positionen.slice(0, 50).forEach(function(p) {
        h += '<tr><td>' + escHtml(p.isin || '—') + '</td><td>' + escHtml(p.name || '—') + '</td>'
           + '<td style="text-align:right">' + (p.quantity || 0) + '</td>'
           + '<td style="text-align:right">' + (p.cost_basis_price == null ? '—' : p.cost_basis_price) + '</td>'
           + '<td style="text-align:right">' + (p.mark_price == null ? '—' : p.mark_price) + '</td>'
           + '<td style="text-align:right">' + (p.position_value == null ? '—' : fmtEur(p.position_value, 2)) + '</td></tr>';
    });
    h += '</tbody></table>';
    if (res.positionen.length > 50) h += '<p class="settings-hint">… und ' + (res.positionen.length - 50) + ' weitere</p>';
    h += '<div class="settings-actions">'
       + '<button class="refresh-btn" onclick="kontenImportUebernehmen(\'' + id + '\', this)">Übernehmen</button>'
       + '<span class="settings-hint" style="margin:0">ersetzt die bisherigen Positionen des Depots</span></div>';
    el.innerHTML = h;
}

async function kontenImportUebernehmen(id, btn) {
    if (!_kontenVorschau) return;
    var text = (document.getElementById('k-import-text') || {}).value || '';
    btn.disabled = true;
    btn.textContent = 'Übernehme…';
    try {
        var res = await kontenImport(id, text, _kontenVorschau.positionen);
        if (res.ok) {
            logIt(3, 'Konten', res.count + ' Positionen übernommen, '
                  + (res.isin_aufgeloest || 0) + ' ISIN aufgelöst, Depotwert ' + fmtEur(res.wert));
            _kontenVorschau = null;
            await ibkrLoadPositions();     // Positionen erscheinen sofort überall
            await kontenLoad();
            ibkrRenderTable();
        } else {
            logIt(1, 'Konten', 'Übernehmen fehlgeschlagen: ' + (res.error || '?'));
        }
    } catch (e) {
        logIt(1, 'Konten', 'Übernehmen fehlgeschlagen: ' + e.message);
    } finally {
        btn.disabled = false;
        btn.textContent = 'Übernehmen';
    }
}

/** Die aktuell gespeicherten Positionen eines Depotkontos. */
function renderDepotPositionen(a) {
    var eigene = (ibkrPositions || []).filter(function(p) { return p.account === a.name; });
    if (!eigene.length) return;
    var ccyFx = ibkrCcyFx();
    var h = '<h2 class="settings-h" style="margin-top:18px">Bestand (' + eigene.length + ')</h2>';
    h += '<table class="konten-tab"><thead><tr><th>Titel</th><th>ISIN</th>'
       + '<th style="text-align:right">Stück</th><th style="text-align:right">Wert</th></tr></thead><tbody>';
    eigene.forEach(function(p) {
        var ysym = ibkrPosYahoo(p);
        h += '<tr><td>' + escHtml(p.name || ysym || p.symbol)
           + (ysym && ysym !== p.symbol ? ' <span style="color:var(--accent);font-size:10px">→' + escHtml(ysym) + '</span>' : '')
           + '</td><td style="color:var(--muted)">' + escHtml(p.isin || '—') + '</td>'
           + '<td style="text-align:right">' + (p.quantity || 0) + '</td>'
           + '<td style="text-align:right">' + fmtEur(ibkrLiveValue(p, ccyFx)) + '</td></tr>';
    });
    h += '</tbody></table>';
    var el = document.getElementById('k-import-karte');
    if (el) el.insertAdjacentHTML('beforeend', h);
}

// ── Kontoumsätze einlesen (camt / CSV) ───────────────────────────────────────
// camt ist der gute Weg: die Datei bringt ihre Salden mit, daraus entsteht der
// Tagesverlauf und damit die Vermögenskurve. Die GLS liefert ein ZIP mit einer
// XML je Abruftag — das geht unausgepackt hinein. CSV bleibt für alles, was nur
// das anbietet (Smartbroker).
//
// Vorschau und Übernehmen laden denselben Stapel zweimal hoch; der Server hält
// zwischen den Aufrufen nichts vor, was ablaufen könnte.

var _umsatzVorschau = null;   // Ergebnis des letzten Probelaufs
var _umsatzQuelle   = null;   // { dateien: FileList } oder { text: '…' }

function renderKontenUmsatzKarte(a) {
    var el = document.getElementById('k-umsatz-karte');
    if (!el) return;
    _umsatzVorschau = null;
    _umsatzQuelle   = null;
    var depot = a.kind === 'depot';

    var h = '<h2 class="settings-h">Umsätze einlesen</h2>'
          + '<p class="settings-hint">'
          + (depot
             ? 'Buchungen des <b>Verrechnungskontos</b> — bei Smartbroker/Baader die '
               + 'monatlichen <b>Kontoauszüge als PDF</b>, gern alle auf einmal. Der Depotwert '
               + 'selbst kommt aus dem Depotauszug darüber; aus den Umsätzen wird nur der '
               + 'Verrechnungsstand nachgezogen, damit die Wertpapiere nicht rückwirkend aus '
               + 'der Kurve fallen.'
             : 'Am besten <b>camt</b> aus dem Online-Banking — gern das ganze ZIP der Bank '
               + '(eine Datei je Tag), mehrere Dateien auf einmal gehen auch. Die Salden aus '
               + 'der Datei ergeben den Tagesverlauf und damit die Vermögenskurve. '
               + 'CSV geht ebenso, braucht für den Verlauf aber die Spalte „Saldo nach Buchung“. '
               + 'Ein <b>Kontoauszug als PDF</b> wird auch gelesen.')
          + '</p>'
          + '<input type="file" id="k-umsatz-datei" class="k-datei" multiple '
          + 'accept=".zip,.xml,.csv,.txt,.pdf,application/zip,text/xml,text/csv,application/pdf" '
          + 'onchange="kontenUmsatzPruefen(\'' + a.id + '\')">'
          + '<details class="k-einfuegen"><summary>… oder Tabelle einfügen</summary>'
          + '<textarea id="k-umsatz-text" class="k-import-feld" rows="5" '
          + 'placeholder="Buchungstag;Verwendungszweck;Betrag;Saldo nach Buchung&#10;'
          + '12.09.2026;Gehalt;1.200,00;3.450,00"></textarea>'
          + '<div class="settings-actions"><button class="refresh-btn k-mini" '
          + 'onclick="kontenUmsatzTextPruefen(\'' + a.id + '\', this)">Prüfen</button></div>'
          + '</details>'
          + '<div class="settings-actions"><span id="k-umsatz-msg" class="settings-msg"></span></div>'
          + '<div id="k-umsatz-vorschau"></div>'
          + '<div id="k-umsatz-liste"></div>';
    el.innerHTML = h;
    renderUmsatzListe(a);
}

function _umsatzMsg(t, c) {
    var el = document.getElementById('k-umsatz-msg');
    if (el) { el.textContent = t; el.className = 'settings-msg ' + (c || ''); }
}

async function kontenUmsatzPruefen(id) {
    var feld = document.getElementById('k-umsatz-datei');
    if (!feld || !feld.files || !feld.files.length) return;
    _umsatzQuelle = { dateien: feld.files };
    await _umsatzProbe(id, function() { return kontenUmsaetzeDateien(id, feld.files, false); });
}

async function kontenUmsatzTextPruefen(id, btn) {
    var text = (document.getElementById('k-umsatz-text') || {}).value || '';
    if (!text.trim()) { _umsatzMsg('Nichts eingefügt', 'err'); return; }
    _umsatzQuelle = { text: text };
    btn.disabled = true;
    await _umsatzProbe(id, function() { return kontenUmsaetzeText(id, text, false); });
    btn.disabled = false;
}

/** Gemeinsamer Ablauf für beide Wege: prüfen, melden, Vorschau zeichnen. */
async function _umsatzProbe(id, lauf) {
    _umsatzMsg('Lese…', 'run');
    try {
        var res = await lauf();
        if (!res.ok) {
            _umsatzMsg(res.error || 'Nicht erkannt', 'err');
            _umsatzVorschau = null;
            var v = document.getElementById('k-umsatz-vorschau');
            if (v) v.innerHTML = '';
            return;
        }
        _umsatzVorschau = res;
        _umsatzMsg('', '');
        logIt(3, 'Konten', res.umsaetze.length + ' Buchungen erkannt (' + res.quelle
              + (res.dateien ? ', ' + res.dateien + ' Dateien' : '') + ')');
        renderUmsatzVorschau(id, res);
    } catch (e) {
        _umsatzMsg('Fehler: ' + e.message, 'err');
    }
}

function renderUmsatzVorschau(id, res) {
    var el = document.getElementById('k-umsatz-vorschau');
    if (!el) return;
    var u = res.umsaetze || [];
    var ohneSaldo = u.filter(function(x) { return x.saldo == null; }).length;

    var h = '<p class="settings-hint">Erkannt: <b>' + u.length + ' Buchungen</b>'
          + (res.dateien > 1 ? ' aus ' + res.dateien + ' Dateien' : '')
          + ' (' + escHtml(res.quelle) + ')'
          + (res.von ? ', ' + escHtml(res.von) + ' bis ' + escHtml(res.bis) : '')
          + (u.length ? ', Saldenänderung <b>' + fmtEurSign(res.summe || 0) + '</b>' : '')
          + (res.doppelt ? ', ' + res.doppelt + ' doppelte übersprungen' : '') + '.</p>';
    (res.hinweise || []).forEach(function(w) {
        h += '<p class="settings-hint" style="color:var(--red)">⚠ ' + escHtml(w) + '</p>';
    });
    if (ohneSaldo) {
        h += '<p class="settings-hint" style="color:var(--red)">⚠ ' + ohneSaldo
           + ' Buchungen ohne Saldo — diese Tage kommen nicht in die Kurve.</p>';
    }

    // Anfangs- und Schlusssalden der Dateien. In einem buchungsfreien Monat ist
    // das alles, was der Auszug hergibt — dann muss es erst recht dastehen.
    if ((res.salden || []).length) {
        h += '<p class="settings-hint">Salden aus den Dateien: '
           + res.salden.map(function(s) {
                 return escHtml(s[0]) + ' <b>' + fmtEur(s[1], 2) + '</b>';
             }).join(' · ') + '</p>';
    }

    // Was jede einzelne Datei beigetragen hat. Bei zwanzig Monatsauszügen ist
    // das die einzige Möglichkeit nachzusehen, ob wirklich jeder angekommen ist.
    if ((res.protokoll || []).length > 1) {
        h += '<h2 class="settings-h" style="margin-top:16px">Dateien (' + res.protokoll.length + ')</h2>'
           + '<table class="konten-tab k-umsatz-tab"><thead><tr><th>Datei</th><th>Art</th>'
           + '<th style="text-align:right">Buchungen</th><th>Zeitraum</th>'
           + '<th>Salden</th></tr></thead><tbody>';
        res.protokoll.forEach(function(d) {
            h += '<tr' + (d.fehler ? ' style="color:var(--red)"' : '') + '>'
               + '<td>' + escHtml(d.datei) + '</td>'
               + '<td style="color:var(--muted)">' + escHtml(d.fehler ? '—' : (d.quelle || '')) + '</td>'
               + '<td style="text-align:right">' + (d.fehler ? '—' : d.buchungen) + '</td>'
               + '<td style="color:var(--muted)">'
               + escHtml(d.fehler ? d.fehler : (d.von ? d.von + ' – ' + d.bis : 'keine Buchungen')) + '</td>'
               + '<td style="color:var(--muted)">'
               + (d.salden || []).map(function(s) {
                     return escHtml(s[0]) + ' ' + fmtEur(s[1], 2);
                 }).join('<br>') + '</td></tr>';
        });
        h += '</tbody></table>';
    }

    if (u.length) {
        h += '<table class="konten-tab k-umsatz-tab"><thead><tr><th>Tag</th><th>Wer</th>'
           + '<th>Zweck</th><th style="text-align:right">Betrag</th>'
           + '<th style="text-align:right">Saldo</th></tr></thead><tbody>';
        u.slice(-60).reverse().forEach(function(x) {
            h += _umsatzZeile(x);
        });
        h += '</tbody></table>';
        if (u.length > 60) h += '<p class="settings-hint">… und ' + (u.length - 60) + ' weitere</p>';
    }

    h += '<div class="settings-actions">'
       + '<button class="refresh-btn" onclick="kontenUmsatzUebernehmen(\'' + id + '\', this)">Übernehmen</button>'
       + '<span class="settings-hint" style="margin:0">schon vorhandene Buchungen werden übersprungen</span></div>';
    el.innerHTML = h;
}

/**
 * Eine Zeile — gleich für Vorschau und gespeicherte Liste. Stückzahl und ISIN
 * stehen mit dabei: nur so ist nachvollziehbar, woraus der Bestandsverlauf
 * gerechnet wird. Die Herkunftsdatei ebenso, damit sich ein Stapel Auszüge
 * abhaken lässt.
 */
function _umsatzZeile(x) {
    var b = x.amount || 0;
    var stueck = x.quantity
        ? '<span class="k-badge">' + (x.quantity > 0 ? '+' : '') + zahlKurz(x.quantity)
          + ' Stk</span>' : '';
    return '<tr><td>' + escHtml(x.date || '') + '</td>'
         + '<td>' + escHtml(x.name || x.kind || '—') + stueck
         + (x.isin ? '<br><span style="color:var(--muted);font-size:10px">'
                     + escHtml(x.isin) + '</span>' : '') + '</td>'
         + '<td class="k-umsatz-zweck" title="' + escHtml(x.purpose || '') + '">'
         + escHtml(x.purpose || '')
         + (x.datei ? '<br><span style="color:var(--muted);font-size:10px">'
                      + escHtml(x.datei) + '</span>' : '') + '</td>'
         + '<td style="text-align:right;color:' + (b >= 0 ? 'var(--green)' : 'var(--red)') + '">'
         + fmtEurSign(b) + '</td>'
         + '<td style="text-align:right;color:var(--muted)">'
         + (x.saldo == null ? '—' : fmtEur(x.saldo, 2)) + '</td></tr>';
}

/** Stückzahl ohne überflüssige Nullen: 35, 1,5, 0,125 */
function zahlKurz(v) {
    var n = Math.abs(Number(v) || 0);
    return (Math.round(n * 1000) / 1000).toLocaleString('de-DE');
}

async function kontenUmsatzUebernehmen(id, btn) {
    if (!_umsatzVorschau || !_umsatzQuelle) return;
    btn.disabled = true;
    btn.textContent = 'Übernehme…';
    try {
        var res = _umsatzQuelle.dateien
            ? await kontenUmsaetzeDateien(id, _umsatzQuelle.dateien, true)
            : await kontenUmsaetzeText(id, _umsatzQuelle.text, true);
        if (res.ok) {
            logIt(3, 'Konten', res.neu + ' Buchungen übernommen, ' + res.bekannt
                  + ' schon bekannt, ' + res.tage + ' Tage im Verlauf'
                  + (res.saldo == null ? '' : ', Stand ' + fmtEur(res.saldo)));
            _umsatzVorschau = null;
            _umsatzQuelle   = null;
            await kontenLoad();      // zeichnet Karte, Liste und Kurve neu
        } else {
            logIt(1, 'Konten', 'Übernehmen fehlgeschlagen: ' + (res.error || '?'));
            _umsatzMsg(res.error || 'Fehler', 'err');
        }
    } catch (e) {
        logIt(1, 'Konten', 'Übernehmen fehlgeschlagen: ' + e.message);
        _umsatzMsg('Fehler: ' + e.message, 'err');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Übernehmen';
    }
}

/** Die schon gespeicherten Buchungen eines Kontos. */
async function renderUmsatzListe(a) {
    var el = document.getElementById('k-umsatz-liste');
    if (!el) return;
    var daten = { umsaetze: [], anzahl: 0 };
    // Alle holen, nicht nur die jüngsten hundert: nach einem Stapel Monats-
    // auszüge will man nachsehen können, ob jede Buchung angekommen ist.
    try { daten = await kontenUmsaetzeLaden(a.id, 2000); }
    catch (e) { return; }
    if (!daten.anzahl) { el.innerHTML = ''; return; }

    var h = '<h2 class="settings-h" style="margin-top:18px">Buchungen (' + daten.anzahl + ')</h2>';
    // Je Herkunftsdatei eine Zeile zum Abhaken
    var jeDatei = {};
    (daten.umsaetze || []).forEach(function(x) {
        var d = x.datei || '—';
        jeDatei[d] = (jeDatei[d] || 0) + 1;
    });
    var namen = Object.keys(jeDatei).sort();
    if (namen.length > 1) {
        h += '<p class="settings-hint">Aus ' + namen.length + ' Dateien: '
           + namen.map(function(n) {
                 return escHtml(n) + ' (' + jeDatei[n] + ')';
             }).join(' · ') + '</p>';
    }
    h += '<div class="k-umsatz-liste"><table class="konten-tab k-umsatz-tab">'
       + '<thead><tr><th>Tag</th><th>Wer</th>'
       + '<th>Zweck</th><th style="text-align:right">Betrag</th>'
       + '<th style="text-align:right">Saldo</th></tr></thead><tbody>';
    (daten.umsaetze || []).forEach(function(x) { h += _umsatzZeile(x); });
    h += '</tbody></table></div>';
    if (daten.anzahl > (daten.umsaetze || []).length) {
        h += '<p class="settings-hint">… ' + (daten.anzahl - daten.umsaetze.length)
           + ' ältere Buchungen werden nicht angezeigt</p>';
    }
    h += '<div class="settings-actions"><button class="refresh-btn k-mini" '
       + 'onclick="kontenUmsaetzeWeg(\'' + a.id + '\')">Buchungen verwerfen</button>'
       + '<span class="settings-hint" style="margin:0">der eingetragene Verlauf bleibt stehen</span></div>';
    el.innerHTML = h;
}

// ── Depotverlauf rückwärts rechnen ───────────────────────────────────────────
// Was heute im Depot liegt, sagt der Depotauszug; was früher drinlag, steht
// nirgends. Es lässt sich aber ausrechnen: Bestand heute minus alle Käufe und
// Verkäufe danach, bewertet mit den Kursen aus folios Datenbank.

function renderRueckrechnungKarte(a) {
    var el = document.getElementById('k-rueck-karte');
    if (!el) return;
    el.innerHTML = '<h2 class="settings-h">Depotverlauf zurückrechnen</h2>'
        + '<p class="settings-hint">Aus dem heutigen Bestand und den Käufen und Verkäufen '
        + 'in den Buchungen entsteht der Depotwert für jeden Tag rückwärts — bewertet mit '
        + 'den Kursen, die folio ohnehin hat. Ohne das beginnt die Kurve eines Depots erst '
        + 'heute. <b>Erst prüfen</b>: die Rechnung sagt selbst, ob sie aufgeht.</p>'
        + '<div class="settings-actions">'
        + '<button class="refresh-btn" onclick="kontenRueckKlick(\'' + a.id + '\', this, false)">Prüfen</button>'
        + '<span id="k-rueck-msg" class="settings-msg"></span></div>'
        + '<div id="k-rueck-ergebnis"></div>';
}

async function kontenRueckKlick(id, btn, schreiben) {
    var msg = document.getElementById('k-rueck-msg');
    var setMsg = function(t, c) { if (msg) { msg.textContent = t; msg.className = 'settings-msg ' + (c || ''); } };
    btn.disabled = true;
    setMsg(schreiben ? 'Schreibe…' : 'Rechne…', 'run');
    try {
        var res = await kontenRueckrechnung(id, schreiben);
        if (!res.ok) { setMsg(res.error || 'Fehler', 'err'); return; }
        setMsg('', '');
        logIt(3, 'Konten', (schreiben ? 'Verlauf geschrieben: ' : 'Probe: ')
              + res.tage + ' Tage, ' + res.trades + ' Buchungen, ' + res.titel + ' Titel');
        renderRueckErgebnis(id, res, schreiben);
        if (schreiben) await kontenLoad();
    } catch (e) {
        setMsg('Fehler: ' + e.message, 'err');
    } finally {
        btn.disabled = false;
    }
}

function renderRueckErgebnis(id, res, geschrieben) {
    var el = document.getElementById('k-rueck-ergebnis');
    if (!el) return;
    var h = '<p class="settings-hint">' + res.tage + ' Tage von ' + escHtml(res.von) + ' bis '
          + escHtml(res.bis) + ', aus ' + res.trades + ' Wertpapierbuchungen über '
          + res.titel + ' Titel.</p>';
    if (res.heute_auszug == null) {
        // Kein Depotauszug eingelesen — der Bestand kommt allein aus den Buchungen
        h += '<div class="k-prognose">Heute errechnet <b>' + fmtEur(res.heute_errechnet, 2)
           + '</b> · Bestand aus den Buchungen aufgebaut, kein Depotauszug zum Abgleich.</div>';
    } else {
        var stimmt = Math.abs((res.heute_errechnet || 0) - (res.heute_auszug || 0)) < 0.01;
        h += '<div class="k-prognose">Heute errechnet <b>' + fmtEur(res.heute_errechnet, 2)
           + '</b> · laut Depotauszug <b>' + fmtEur(res.heute_auszug, 2) + '</b>'
           + (stimmt ? ' <span style="color:var(--green)">✓ deckungsgleich</span>'
                     : ' <span style="color:var(--red)">Abweichung '
                       + fmtEurSign((res.heute_errechnet || 0) - (res.heute_auszug || 0), 2)
                       + '</span>') + '</div>';
    }
    // Woraus sich der heutige Wert zusammensetzt — besonders wichtig, wenn der
    // Bestand allein aus den Buchungen stammt.
    if ((res.bestand || []).length) {
        h += '<table class="konten-tab k-umsatz-tab"><thead><tr><th>ISIN</th><th>Symbol</th>'
           + '<th style="text-align:right">Stück</th><th style="text-align:right">Kurs</th>'
           + '<th style="text-align:right">Wert</th></tr></thead><tbody>';
        res.bestand.forEach(function(b) {
            h += '<tr><td>' + escHtml(b.isin) + '</td>'
               + '<td style="color:var(--muted)">' + escHtml(b.symbol || '— kein Kurssymbol') + '</td>'
               + '<td style="text-align:right">' + zahlKurz(b.stueck) + '</td>'
               + '<td style="text-align:right;color:var(--muted)">'
               + (b.kurs ? fmtEur(b.kurs, 2) : '—') + '</td>'
               + '<td style="text-align:right"><b>' + fmtEur(b.wert, 2) + '</b></td></tr>';
        });
        h += '</tbody></table>';
    }
    (res.warnungen || []).forEach(function(w) {
        h += '<p class="settings-hint" style="color:var(--red)">⚠ ' + escHtml(w) + '</p>';
    });
    // Die letzten Tage zum Draufschauen
    var reihe = (res.reihe || []).slice(-14).reverse();
    if (reihe.length) {
        h += '<table class="konten-tab k-umsatz-tab"><thead><tr><th>Tag</th>'
           + '<th style="text-align:right">Wertpapiere</th>'
           + '<th style="text-align:right">Verrechnungskonto</th>'
           + '<th style="text-align:right">Zusammen</th></tr></thead><tbody>';
        reihe.forEach(function(x) {
            h += '<tr><td>' + escHtml(x.date) + '</td>'
               + '<td style="text-align:right">' + fmtEur(x.wertpapiere, 2) + '</td>'
               + '<td style="text-align:right;color:var(--muted)">' + fmtEur(x.bargeld, 2) + '</td>'
               + '<td style="text-align:right"><b>' + fmtEur(x.total, 2) + '</b></td></tr>';
        });
        h += '</tbody></table>';
    }
    if (!geschrieben) {
        h += '<div class="settings-actions">'
           + '<button class="refresh-btn" onclick="kontenRueckKlick(\'' + id + '\', this, true)">'
           + 'In den Verlauf schreiben</button>'
           + '<span class="settings-hint" style="margin:0">ersetzt die Stände dieses Kontos '
           + 'im gerechneten Zeitraum</span></div>';
    } else {
        h += '<p class="settings-hint" style="color:var(--green)">✓ In den Verlauf geschrieben.</p>';
    }
    el.innerHTML = h;
}

async function kontenUmsaetzeWeg(id) {
    var a = (kontenState.accounts || []).find(function(x) { return x.id === id; });
    if (!confirm('Alle gespeicherten Buchungen von „' + (a ? a.name : id) + '" verwerfen?\n\n'
                 + 'Der Verlauf des Kontos bleibt erhalten.')) return;
    await kontenUmsaetzeLoeschen(id);
    logIt(3, 'Konten', 'Buchungen verworfen');
    await kontenLoad();
}

// ── Vermögenskurve ───────────────────────────────────────────────────────────
// Gestapelte Flächen (kumuliert gerechnet, die größte zuerst hinzugefügt, damit
// sie hinten liegt) plus die Linie „Vermögen gesamt" nach Abzug der Schulden.

function wealthZeitraum(v) {
    _wealthZeitraum = v;
    document.querySelectorAll('#wealthZeitraum button').forEach(function(b) {
        b.classList.toggle('active', b.getAttribute('data-z') === v);
    });
    renderWealthChart();
}

async function wealthKonto(v) {
    _wealthKonto = v;
    var a = (kontenState.accounts || []).find(function(x) { return x.id === v; });
    if (a && !a._verlauf) {
        try { a._verlauf = await kontenVerlaufLaden(v); }
        catch (e) { logIt(1, 'Konten', 'Verlauf nicht ladbar: ' + e.message); }
    }
    renderWealthChart();
}

function renderWealthChart() {
    var box = document.getElementById('wealthChart');
    if (!box || typeof LightweightCharts === 'undefined') return;
    var reihe = (kontenState.verlauf || []).slice();

    // Zeitraum abschneiden
    if (_wealthZeitraum !== 'alles' && reihe.length) {
        var ab = new Date();
        ab.setMonth(ab.getMonth() - ({ '1m': 1, '6m': 6, '1j': 12 }[_wealthZeitraum] || 12));
        var abStr = ab.toISOString().slice(0, 10);
        reihe = reihe.filter(function(r) { return r.date >= abStr; });
    }

    var leer = document.getElementById('wealthLeer');
    if (reihe.length < 2) {
        if (leer) {
            leer.style.display = '';
            leer.textContent = reihe.length
                ? 'Erst ein Datenpunkt — ab dem zweiten Tag entsteht die Kurve. '
                + 'Ältere Stände kannst du beim jeweiligen Konto nachtragen.'
                : 'Noch kein Verlauf. Lege ein Konto an oder trage frühere Stände nach.';
        }
        box.style.display = 'none';
        return;
    }
    if (leer) leer.style.display = 'none';
    box.style.display = '';

    if (!_wealthChart) {
        _wealthChart = LightweightCharts.createChart(box, {
            width: box.clientWidth, height: box.clientHeight,
            layout: {
                background: { color: 'transparent' },
                textColor: getComputedStyle(document.documentElement).getPropertyValue('--text').trim() || '#1a1a18',
                fontFamily: "-apple-system, BlinkMacSystemFont, 'Trebuchet MS', Roboto, Ubuntu, Arial, sans-serif"
            },
            grid: { vertLines: { color: 'rgba(0,0,0,0.05)' }, horzLines: { color: 'rgba(0,0,0,0.05)' } },
            timeScale: { borderVisible: false, timeVisible: false },
            rightPriceScale: { borderVisible: false },
            crosshair: { mode: LightweightCharts.CrosshairMode.Normal }
        });
        // Reihenfolge: die oberste Fläche zuerst, damit die kleineren davor liegen.
        [['ibkr', 'rgba(41,98,255,.35)', '#2962ff'],
         ['depots', 'rgba(45,138,78,.35)', '#2d8a4e'],
         ['sachwerte', 'rgba(245,166,35,.35)', '#f5a623'],
         ['guthaben', 'rgba(155,89,182,.35)', '#9b59b6']].forEach(function(s) {
            _wealthSeries[s[0]] = _wealthChart.addSeries(LightweightCharts.AreaSeries, {
                topColor: s[1], bottomColor: 'rgba(0,0,0,0)', lineColor: s[2], lineWidth: 1,
                priceLineVisible: false, lastValueVisible: false
            });
        });
        _wealthSeries.total = _wealthChart.addSeries(LightweightCharts.LineSeries, {
            color: '#c0392b', lineWidth: 2, priceLineVisible: false, lastValueVisible: true
        });
        new ResizeObserver(function() {
            if (_wealthChart) _wealthChart.applyOptions({ width: box.clientWidth, height: box.clientHeight });
        }).observe(box);
    }

    var daten = wealthSerien(reihe, _wealthKonto);
    Object.keys(daten).forEach(function(k) { _wealthSeries[k].setData(daten[k]); });
    _wealthChart.timeScale().fitContent();
    logIt(8, 'Konten', 'Vermögenskurve gezeichnet (' + reihe.length + ' Punkte)');
}

/**
 * Die fünf Datenreihen der Kurve — reine Rechnung, ohne Chart.
 *
 * Die Flächen sind KUMULIERT (guthaben unten, darauf sachwerte, depots, ibkr):
 * Lightweight Charts stapelt nicht von selbst, jede Fläche startet bei null und
 * würde die kleineren sonst verdecken. Die Linie `total` zieht die Schulden ab
 * und läuft deshalb unter den Flächen, wenn mehr Schuld als Vermögen da ist.
 *
 * @param {Array} reihe  Tagesreihe aus /api/vermoegen/verlauf
 * @param {string} konto Konto-id für die Einzelansicht, '' = Gesamtvermögen
 */
function wealthSerien(reihe, konto) {
    if (konto) {
        // Einzelkonto: nur eine Linie, die Flächen bleiben leer
        return { guthaben: [], sachwerte: [], depots: [], ibkr: [],
                 total: _wealthKontoReihe(konto) };
    }
    var kum = function(felder) {
        return reihe.map(function(r) {
            var v = 0;
            felder.forEach(function(f) { v += r[f] || 0; });
            return { time: r.date, value: v };
        });
    };
    return {
        guthaben:  kum(['guthaben']),
        sachwerte: kum(['guthaben', 'sachwerte']),
        depots:    kum(['guthaben', 'sachwerte', 'depots']),
        ibkr:      kum(['guthaben', 'sachwerte', 'depots', 'ibkr']),
        total:     reihe.map(function(r) { return { time: r.date, value: r.total || 0 }; })
    };
}

/** Verlauf eines einzelnen Kontos aus dem zuletzt geladenen Gesamtverlauf. */
function _wealthKontoReihe(id) {
    var a = (kontenState.accounts || []).find(function(x) { return x.id === id; });
    if (!a || !a._verlauf) return [];
    return a._verlauf.map(function(r) { return { time: r.date, value: r.value || 0 }; });
}

// ── kleine Helfer ────────────────────────────────────────────────────────────

function heuteIso() {
    var d = new Date();
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

/** '1.234,56' → 1234.56 (dasselbe Verständnis wie _de_num im Backend). */
function zahl(v) {
    if (v == null || v === '') return 0;
    var s = String(v).replace(/[^\d,.\-]/g, '');
    if (s.indexOf(',') > -1 && s.indexOf('.') > -1) {
        s = s.lastIndexOf(',') > s.lastIndexOf('.')
            ? s.replace(/\./g, '').replace(',', '.')
            : s.replace(/,/g, '');
    } else if (s.indexOf(',') > -1) {
        s = s.replace(',', '.');
    }
    return parseFloat(s) || 0;
}
