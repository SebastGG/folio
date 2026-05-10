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
var chart, csSeries, volSeries, ma50S, ma200S, regS, regUS, regLS;
var _sincePl = null; // Seit-Datum Plugin

// Zeichnungen
var drawMode      = null;  // 'line'|'trend'|'hline'|'ray'|'rect'|'select'|null
var currentDraw   = null;  // Aktuelle Zeichnung in Bearbeitung
var selectedDraw  = null;  // Ausgewählte Zeichnung im Select-Modus
var _dragHandle   = -1;    // Index des gezogenen Handles (-1 = kein Drag)
var _dragStartX   = 0;
var _dragStartY   = 0;
var canvas, ctx;           // Draw-Canvas Referenzen

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
            fontFamily:  "'JetBrains Mono', monospace",
        },
        grid: {
            vertLines: { color: 'rgba(0,0,0,0.05)' },
            horzLines: { color: 'rgba(0,0,0,0.05)' },
        },
        timeScale: { borderVisible: false, timeVisible: false },
        rightPriceScale: { borderVisible: false },
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
            if (v >= 1e9) return '$' + (v/1e9).toFixed(1) + 'B';
            if (v >= 1e6) return '$' + (v/1e6).toFixed(1) + 'M';
            if (v >= 1e3) return '$' + (v/1e3).toFixed(0) + 'K';
            return '$' + v.toFixed(0);
        };

        var setEl = function(id, val) { var e = document.getElementById(id); if(e) e.textContent = val; };
        setEl('ov-date', param.time);
        setEl('ov',  fmt(bar.open));
        setEl('oh',  fmt(bar.high));
        setEl('ol',  fmt(bar.low));
        setEl('oc',  fmt(bar.close));

        // Volumen aus volSeries
        var volBar = volSeries ? param.seriesData.get(volSeries) : null;
        var vol = volBar ? volBar.value : null;
        setEl('ovol', fmtVol(vol));

        // Volume averaged (20-Tage gleitender Schnitt)
        if (_lastCandles.length > 0) {
            var idx = _lastCandles.findIndex(function(c) { return c.time === param.time; });
            if (idx >= 0) {
                var n = Math.min(20, idx + 1);
                var sum = 0;
                for (var i = idx - n + 1; i <= idx; i++) {
                    var vd = _volumeData[i] || {};
                    sum += vd.volume || 0;
                }
                setEl('ovola', fmtVol(sum / n));
            }
        }
    });

    // Zeichnungen neu zeichnen bei Pan/Zoom
    chart.timeScale().subscribeVisibleTimeRangeChange(function() { redrawAll(); });
}

function fitChart() {
    var container = document.getElementById('chartContainer');
    if (!container || !chart) return;
    var w = container.clientWidth;
    var h = container.clientHeight;
    if (w > 0 && h > 0) chart.applyOptions({ width: w, height: h });
    if (typeof resizeCanvas === 'function') resizeCanvas();
}

// ╔══════════════════════════════════════════════════════════╗
// ║  4. CHART-RENDERING (Interface zu shared.js)             ║
// ╚══════════════════════════════════════════════════════════╝

/**
 * Wird von shared.js applyPeriod() aufgerufen.
 * Rendert Kerzen, Volumen, Indikatoren, LogReg, Seit-Marker.
 */
function renderDesktopChart(colored, volAgg, agg, regResult) {
    if (!chart || !csSeries) return;

    // Kerzen
    csSeries.setData(colored);

    // Volumen
    if (volSeries && volAgg.length) {
        var cmap = {};
        colored.forEach(function(c) { cmap[c.time] = c.color; });
        // Normiert: Durchschnitt = 100, damit Volumen über Zeit vergleichbar bleibt
        var volSum = volAgg.reduce(function(s, v) { return s + (v.volume || 0); }, 0);
        var volAvg = volSum / volAgg.length || 1;
        try {
            volSeries.setData(volAgg.map(function(v) {
                return {
                    time:  v.time,
                    value: (v.volume || 0) / volAvg * 100,
                    color: cmap[v.time] === '#2d8a4e' ? 'rgba(45,138,78,0.4)' : 'rgba(192,57,43,0.4)',
                };
            }));
        } catch(e) {}
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

    // LogReg
    applyLogReg(regResult, regS, regUS, regLS);

    // Log-Skala
    chart.applyOptions({ rightPriceScale: { mode: logScale ? 1 : 0 } });

    // Seit-Datum Marker
    applySinceMarker(agg);

    // Fit
    chart.timeScale().fitContent();

    // Zeichnungen neu zeichnen
    redrawAll();
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

function applySinceMarker(agg) {
    if (!csSeries || !agg.length) return;
    var sinceDate = (document.getElementById('perfSinceDate') || {}).value;
    if (typeof LightweightCharts.createSeriesMarkers !== 'function') return;
    if (_sincePl) { try { _sincePl.setMarkers([]); } catch(e) {} }
    if (!sinceDate) return;
    var bar = agg.find(function(c) { return c.time >= sinceDate; });
    if (!bar) return;
    var marker = [{ time: bar.time, position: 'belowBar', color: '#e67e22', shape: 'arrowUp', text: sinceDate.slice(5), size: 2 }];
    try {
        if (!_sincePl) _sincePl = LightweightCharts.createSeriesMarkers(csSeries, marker);
        else _sincePl.setMarkers(marker);
    } catch(e) {}
}

// ╔══════════════════════════════════════════════════════════╗
// ║  5. WATCHLIST & SIDEBAR                                   ║
// ╚══════════════════════════════════════════════════════════╝

function renderWatchlist() {
    var el = document.getElementById('watchlist');
    if (!el) return;
    el.innerHTML = '';

    // Index-Zeile: immer aus _dataMap berechnen (unabhängig vom aktiven View)
    var idxCandles = buildIndex(_dataMap);
    var idxLast = idxCandles.length ? idxCandles[idxCandles.length - 1] : null;
    var idxPrev = idxCandles.length > 1 ? idxCandles[idxCandles.length - 2] : idxLast;
    var idxChg  = idxLast && idxPrev ? ((idxLast.close - idxPrev.close) / idxPrev.close * 100).toFixed(2) : null;
    var idxActive = currentView === 'index';

    var idxDiv = document.createElement('div');
    idxDiv.className = 'wl-item wl-index' + (idxActive ? ' active' : '');
    idxDiv.innerHTML = '<div class="wl-sym">● ' + (baskets[currentBasket] ? baskets[currentBasket].name : 'Index') + '</div>'
        + '<div class="wl-right">'
        + '<div class="wl-price">' + (idxLast ? '$' + idxLast.close.toFixed(2) : '-') + '</div>'
        + '<div class="wl-chg" style="color:' + (!idxActive && idxChg ? (parseFloat(idxChg) >= 0 ? 'var(--green)' : 'var(--red)') : '') + '">'
        + (idxChg ? (parseFloat(idxChg) >= 0 ? '+' : '') + idxChg + '%' : '-') + '</div>'
        + '</div>';
    idxDiv.onclick = function() { switchView('index'); };
    el.appendChild(idxDiv);

    // Ticker
    Object.keys(WEIGHTS).forEach(function(sym) {
        var p      = perfData[sym];
        var active = currentView === sym;
        var div    = document.createElement('div');
        div.className = 'wl-item' + (active ? ' active' : '');
        var chgColor = p ? (parseFloat(p.d1) >= 0 ? 'var(--green)' : 'var(--red)') : 'var(--muted)';
        div.innerHTML = '<div class="wl-sym">' + sym + '</div>'
            + '<div class="wl-right">'
            + '<div class="wl-price">' + (p ? '$' + p.price.toFixed(2) : '-') + '</div>'
            + '<div class="wl-chg" style="color:' + (!active ? chgColor : 'rgba(255,255,255,0.85)') + '">'
            + (p ? (parseFloat(p.d1) >= 0 ? '+' : '') + p.d1 + '%' : '-') + '</div>'
            + '</div>';
        div.onclick = (function(s) { return function() { switchView(s); }; })(sym);
        if (active) div.scrollIntoView({ block: 'nearest' });
        el.appendChild(div);
    });
}

function renderBasketSelect() {
    var sel = document.getElementById('basketSelect');
    if (!sel) return;
    sel.innerHTML = '';
    Object.keys(baskets).forEach(function(id) {
        var opt = document.createElement('option');
        opt.value = id;
        opt.textContent = baskets[id].name || id;
        opt.selected = id === currentBasket;
        sel.appendChild(opt);
    });
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
    var syms = Object.keys(WEIGHTS);
    if (syms.length === 0) {
        el.innerHTML = '<p style="color:var(--muted);padding:8px;">Noch keine Ticker. Suche unten.</p>';
        return;
    }
    syms.forEach(function(sym) {
        var row = document.createElement('div');
        row.className = 'manage-item';
        row.innerHTML = '<span class="sym-label">' + sym + '</span>'
            + '<input type="number" min="0" value="' + (WEIGHTS[sym] || 0) + '" data-sym="' + sym + '">'
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
    if (currentView === sym) switchView('index');
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
// ║  7. ZEICHNUNGEN (Draw Canvas)                             ║
// ╚══════════════════════════════════════════════════════════╝

function initDrawCanvas() {
    canvas = document.getElementById('drawCanvas');
    if (!canvas) return;
    ctx    = canvas.getContext('2d');
    resizeCanvas();
    canvas.addEventListener('mousedown',    onCanvasMouseDown);
    canvas.addEventListener('mousemove',    onCanvasMove);
    canvas.addEventListener('mouseup',      onCanvasMouseUp);
    canvas.addEventListener('click',        onCanvasClick);
    canvas.addEventListener('dblclick',     onCanvasDbl);
    canvas.addEventListener('contextmenu',  onCanvasContextMenu);
}

function resizeCanvas() {
    var container = document.getElementById('chartContainer');
    if (!canvas || !container) return;
    canvas.width  = container.clientWidth;
    canvas.height = container.clientHeight;
    canvas.style.width  = container.clientWidth  + 'px';
    canvas.style.height = container.clientHeight + 'px';
    redrawAll();
}

// Koordinaten-Konversion (Chart ↔ Canvas)
function p2y(price) {
    if (!csSeries) return 0;
    return csSeries.priceToCoordinate ? csSeries.priceToCoordinate(price) || 0 : 0;
}
function t2x(time) {
    if (!chart) return 0;
    return chart.timeScale().timeToCoordinate ? chart.timeScale().timeToCoordinate(time) || 0 : 0;
}
function y2p(y) {
    if (!chart || !csSeries) return 0;
    return csSeries.coordinateToPrice ? csSeries.coordinateToPrice(y) || 0 : 0;
}
function x2t(x) {
    if (!chart) return null;
    return chart.timeScale().coordinateToTime ? chart.timeScale().coordinateToTime(x) : null;
}

function drawOne(d, preview) {
    if (!ctx || !canvas) return;
    ctx.save();
    ctx.strokeStyle = d.color || '#e67e22';
    ctx.lineWidth   = 1.5;
    ctx.setLineDash(d.type === 'hline' || d.type === 'ray' ? [4, 3] : []);

    var pts = (preview ? d.points.concat([preview]) : d.points).map(function(p) {
        return { x: t2x(p.time), y: p2y(p.price) };
    });

    if (pts.length < 1) { ctx.restore(); return; }

    if (d.type === 'hline') {
        ctx.beginPath();
        ctx.moveTo(0, pts[0].y);
        ctx.lineTo(canvas.width, pts[0].y);
        ctx.stroke();
    } else if (d.type === 'ray' && pts.length >= 2) {
        var dx = pts[1].x - pts[0].x;
        var dy = pts[1].y - pts[0].y;
        var len = Math.sqrt(dx*dx + dy*dy);
        if (len > 0) {
            var ext = 5000;
            ctx.beginPath();
            ctx.moveTo(pts[0].x, pts[0].y);
            ctx.lineTo(pts[0].x + dx / len * ext, pts[0].y + dy / len * ext);
            ctx.stroke();
        }
    } else if (d.type === 'rect' && pts.length >= 2) {
        ctx.fillStyle = (d.color || '#e67e22').replace(')', ',0.07)').replace('rgb', 'rgba');
        var rx = Math.min(pts[0].x, pts[1].x);
        var ry = Math.min(pts[0].y, pts[1].y);
        var rw = Math.abs(pts[1].x - pts[0].x);
        var rh = Math.abs(pts[1].y - pts[0].y);
        ctx.fillRect(rx, ry, rw, rh);
        ctx.strokeRect(rx, ry, rw, rh);
    } else {
        // line / trend
        if (pts.length >= 2) {
            ctx.beginPath();
            ctx.moveTo(pts[0].x, pts[0].y);
            for (var i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
            ctx.stroke();
        }
    }

    // Handles bei ausgewählter Zeichnung
    if (selectedDraw && d.id === selectedDraw.id && !preview) {
        pts.forEach(function(p) {
            ctx.fillStyle = '#2962ff';
            ctx.strokeStyle = 'white';
            ctx.lineWidth = 2;
            ctx.setLineDash([]);
            ctx.beginPath();
            ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
        });
    }
    ctx.restore();
}

function drawPreview(e) {
    if (!currentDraw || !ctx || !canvas) return;
    var rect = canvas.getBoundingClientRect();
    var x = e.clientX - rect.left;
    var y = e.clientY - rect.top;
    var previewPt = { time: x2t(x), price: y2p(y) };
    redrawAll();
    drawOne(currentDraw, previewPt);
}

function redrawAll() {
    if (!ctx || !canvas) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawings.forEach(function(d) { drawOne(d); });
}

function hitTest(x, y, d) {
    var pts = d.points.map(function(p) { return { x: t2x(p.time), y: p2y(p.price) }; });
    if (pts.length === 0) return false;
    if (d.type === 'hline') return Math.abs(y - pts[0].y) < 6;
    for (var i = 0; i < pts.length - 1; i++) {
        var dx = pts[i+1].x - pts[i].x;
        var dy = pts[i+1].y - pts[i].y;
        var len = Math.sqrt(dx*dx + dy*dy);
        if (len === 0) continue;
        var t = ((x-pts[i].x)*dx + (y-pts[i].y)*dy) / (len*len);
        t = Math.max(0, Math.min(1, t));
        var dist = Math.sqrt(Math.pow(x - (pts[i].x + t*dx), 2) + Math.pow(y - (pts[i].y + t*dy), 2));
        if (dist < 6) return true;
    }
    return false;
}

function getHandles(d) {
    return d.points.map(function(p) { return { x: t2x(p.time), y: p2y(p.price) }; });
}

function hitHandle(x, y, d) {
    return getHandles(d).findIndex(function(h) {
        return Math.sqrt((x-h.x)*(x-h.x) + (y-h.y)*(y-h.y)) < 8;
    });
}

function setDraw(type, btn) {
    // Nochmaliger Klick auf aktiven Button → Modus ausschalten
    if (drawMode === type) type = null;
    drawMode = type;
    currentDraw = null;
    document.querySelectorAll('.draw-btn').forEach(function(b) { b.classList.remove('active'); });
    if (type && btn) btn.classList.add('active');
    if (canvas) canvas.style.pointerEvents = type ? 'all' : 'none';
    var hint = document.getElementById('cursorHint');
    if (hint) {
        hint.textContent = type ? 'Klicken zum Zeichnen • Doppelklick beendet • Rechtsklick löscht' : '';
        hint.classList.toggle('show', !!type);
    }
}

function onCanvasMouseDown(e) {
    if (!drawMode) return;
    if (e.button !== 0) return;  // nur linke Maustaste
    if (drawMode === 'select') {
        var rect = canvas.getBoundingClientRect();
        var x = e.clientX - rect.left, y = e.clientY - rect.top;
        // Prüfe ob Handle eines ausgewählten Objekts getroffen
        if (selectedDraw) {
            var hi = hitHandle(x, y, selectedDraw);
            if (hi >= 0) {
                _dragHandle = hi;
                _dragStartX = x; _dragStartY = y;
                return;
            }
        }
        // Neues Objekt auswählen
        var found = drawings.find(function(d) { return hitTest(x, y, d); });
        selectedDraw = found || null;
        _dragHandle = -1;
        redrawAll();
        return;
    }
    var rect = canvas.getBoundingClientRect();
    var x = e.clientX - rect.left;
    var y = e.clientY - rect.top;
    var pt = { time: x2t(x), price: y2p(y) };
    if (!pt.time) return;
    if (!currentDraw) {
        currentDraw = { id: 'draw_' + Date.now(), type: drawMode, points: [pt], color: '#e67e22' };
        // hline braucht nur einen Punkt → sofort finalisieren
        if (drawMode === 'hline') finalizeDraw();
    } else {
        currentDraw.points.push(pt);
        // line, trend, ray, rect → nach 2 Punkten finalisieren
        // (Doppelklick finalisiert auch bei mehr Punkten)
        if (['line','trend','ray','rect'].includes(drawMode) && currentDraw.points.length >= 2) {
            finalizeDraw();
        }
    }
}

function onCanvasMouseUp(e) {
    if (drawMode === 'select' && selectedDraw && _dragHandle >= 0) {
        _dragHandle = -1;
        saveDrawing(selectedDraw);  // Geänderte Position speichern
        redrawAll();
    }
}

function onCanvasClick(e) {
    // Linksklick ohne Zeichenmodus: nichts tun
}

function onCanvasContextMenu(e) {
    e.preventDefault();
    var rect = canvas.getBoundingClientRect();
    var x = e.clientX - rect.left, y = e.clientY - rect.top;
    // Zeichnung unter Cursor löschen
    var idx = drawings.findIndex(function(d) { return hitTest(x, y, d); });
    if (idx >= 0) {
        deleteDrawing(drawings[idx].id);
        drawings.splice(idx, 1);
        redrawAll();
    }
    // Aktive Zeichnung abbrechen
    if (currentDraw) { currentDraw = null; redrawAll(); }
}

function onCanvasDbl(e) {
    if (currentDraw && currentDraw.points.length >= 2) finalizeDraw();
}

function onCanvasMove(e) {
    if (currentDraw) { drawPreview(e); return; }
    if (drawMode === 'select' && selectedDraw && _dragHandle >= 0) {
        var rect = canvas.getBoundingClientRect();
        var x = e.clientX - rect.left;
        var y = e.clientY - rect.top;
        var pt = selectedDraw.points[_dragHandle];
        if (pt) {
            pt.time  = x2t(x) || pt.time;
            pt.price = y2p(y) || pt.price;
            redrawAll();
        }
    }
}

function finalizeDraw() {
    if (!currentDraw || currentDraw.points.length < 1) return;
    drawings.push(currentDraw);
    saveDrawing(currentDraw);
    currentDraw = null;
    setDraw(null, null);  // Zeichenmodus nach Abschluss beenden
    redrawAll();
}

// ╔══════════════════════════════════════════════════════════╗
// ║  8. RESIZER (horizontal + vertikal)                       ║
// ╚══════════════════════════════════════════════════════════╝

// ── Layouts speichern / laden ──
// Gespeichert im globalen layout-Objekt, persistiert via /api/config
var _layout = {};

function saveLayout() {
    var sb = document.getElementById('sidebarPane');
    var ba = document.getElementById('bottomArea');
    var pn = document.getElementById('panel-notes');
    var pp = document.getElementById('panel-perf');
    _layout = {
        sidebarW:    sb ? sb.offsetWidth  : null,
        bottomH:     ba ? ba.offsetHeight : null,
        panelNotesW: pn ? pn.offsetWidth  : null,
        panelPerfW:  pp ? pp.offsetWidth  : null,
    };
    // Layout wird über saveBasketsToServer() persistiert
    saveBasketsToServer();
}

function loadLayout() {
    var lay = _layout || {};
    var sb  = document.getElementById('sidebarPane');
    var ba  = document.getElementById('bottomArea');
    var pn  = document.getElementById('panel-notes');
    var pp  = document.getElementById('panel-perf');
    if (lay.sidebarW    != null && sb) sb.style.width  = lay.sidebarW    + 'px';
    if (lay.bottomH     != null && ba) ba.style.height = lay.bottomH     + 'px';
    if (lay.panelNotesW != null && pn) { pn.style.flex = 'none'; pn.style.width = lay.panelNotesW + 'px'; }
    if (lay.panelPerfW  != null && pp) { pp.style.flex = 'none'; pp.style.width = lay.panelPerfW  + 'px'; }
    if (chart) fitChart();
}

(function() {
    // ── Horizontal: Chart vs Sidebar ──
    var hResizer = document.getElementById('resizer');
    var sidebar  = document.getElementById('sidebarPane');
    if (hResizer && sidebar) {
        var dragging = false, startX = 0, startW = 0;
        hResizer.addEventListener('mousedown', function(e) {
            dragging = true; startX = e.clientX; startW = sidebar.offsetWidth;
            hResizer.classList.add('dragging');
            document.body.style.userSelect = 'none';
            document.body.style.cursor = 'col-resize';
            e.preventDefault();
        });
        window.addEventListener('mousemove', function(e) {
            if (!dragging) return;
            var delta = startX - e.clientX;
            var newW  = Math.max(180, Math.min(500, startW + delta));
            sidebar.style.width = newW + 'px';
            fitChart();
        });
        window.addEventListener('mouseup', function() {
            if (dragging) {
                dragging = false;
                hResizer.classList.remove('dragging');
                document.body.style.userSelect = '';
                document.body.style.cursor = '';
                saveLayout();
            }
        });
    }

    // ── Vertikal: Chart | Bottom-Panels ──
    var vResizer   = document.getElementById('vresizer');
    var chartPane  = document.querySelector('.chart-pane');
    var bottomArea = document.getElementById('bottomArea');
    if (vResizer && chartPane && bottomArea) {
        var vDragging = false, startY = 0, startH = 0;
        vResizer.addEventListener('mousedown', function(e) {
            vDragging = true;
            startY = e.clientY;
            startH = bottomArea.offsetHeight;
            vResizer.classList.add('dragging');
            document.body.style.userSelect = 'none';
            document.body.style.cursor = 'row-resize';
            e.preventDefault();
        });
        window.addEventListener('mousemove', function(e) {
            if (!vDragging) return;
            var delta = startY - e.clientY;
            var newH  = Math.max(80, Math.min(window.innerHeight - 200, startH + delta));
            bottomArea.style.height = newH + 'px';
            fitChart();
        });
        window.addEventListener('mouseup', function() {
            if (vDragging) {
                vDragging = false;
                vResizer.classList.remove('dragging');
                document.body.style.userSelect = '';
                document.body.style.cursor = '';
                saveLayout();
            }
        });
    }

    // ── Panel-Resizer (horizontal zwischen Bottom-Panels) ──
    [['panel-resizer-1', 'panel-notes', 'panel-perf'],
     ['panel-resizer-2', 'panel-perf',  'panel-import']].forEach(function(cfg) {
        var pr   = document.getElementById(cfg[0]);
        var left = document.getElementById(cfg[1]);
        if (!pr || !left) return;
        var pDragging = false, pStartX = 0, pLeftW = 0;
        pr.addEventListener('mousedown', function(e) {
            pDragging = true; pStartX = e.clientX; pLeftW = left.offsetWidth;
            pr.classList.add('dragging');
            document.body.style.userSelect = 'none';
            document.body.style.cursor = 'col-resize';
            e.preventDefault();
        });
        window.addEventListener('mousemove', function(e) {
            if (!pDragging) return;
            var newW = Math.max(80, pLeftW + (e.clientX - pStartX));
            left.style.flex  = 'none';
            left.style.width = newW + 'px';
        });
        window.addEventListener('mouseup', function() {
            if (pDragging) {
                pDragging = false;
                pr.classList.remove('dragging');
                document.body.style.userSelect = '';
                document.body.style.cursor = '';
                saveLayout();
            }
        });
    });
})();

// ╔══════════════════════════════════════════════════════════╗
// ║  9. KEYBOARD NAVIGATION                                   ║
// ╚══════════════════════════════════════════════════════════╝

document.addEventListener('keydown', function(e) {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement && document.activeElement.tagName)) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); navigateWatchlist(+1); }
    if (e.key === 'ArrowUp')   { e.preventDefault(); navigateWatchlist(-1); }
    // Delete/Backspace → ausgewählte Zeichnung löschen
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedDraw) {
        var idx = drawings.findIndex(function(d) { return d.id === selectedDraw.id; });
        if (idx >= 0) {
            deleteDrawing(selectedDraw.id);
            drawings.splice(idx, 1);
            selectedDraw = null;
            redrawAll();
        }
    }
    // Escape → Auswahl aufheben
    if (e.key === 'Escape') { selectedDraw = null; currentDraw = null; setDraw(null, null); redrawAll(); }
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
    initDrawCanvas();
    loadLayout();  // Layout wiederherstellen nachdem Chart initialisiert
    fitChart();

    loadConfig().then(function() {
        return loadDbTickers();
    }).then(function() {
        return loadData();
    }).then(function() {
        loadDrawings();
        loadNotes();
    });
})();
