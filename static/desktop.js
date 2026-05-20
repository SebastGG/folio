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
var _ibkrCostLine = null;  // Einstandskurs-Preislinie (wird pro Ticker neu gesetzt)

// Drawing Manager
var drawingManager   = null;  // LightweightChartsDrawing.DrawingManager Instanz
var _drawSelected    = null;  // aktuell ausgewählte Zeichnung (für Tastatur-Löschung)
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
        timeScale: { borderVisible: false, timeVisible: false, rightOffset: 12 },
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

function refreshIbkrCostLine(colored) {
    if (!csSeries) return;
    if (_ibkrCostLine) { try { csSeries.removePriceLine(_ibkrCostLine); } catch(e) {} _ibkrCostLine = null; }
    if (!colored || !colored.length || !ibkrPositions || !ibkrPositions.length) return;
    var cbPrice = 0;
    if (currentView !== 'index') {
        var pos = ibkrPositions.find(function(p) { return p.symbol === currentView; });
        if (pos && pos.cost_basis_price > 0) cbPrice = pos.cost_basis_price;
    } else {
        var totalCost = 0, totalValue = 0;
        ibkrPositions.forEach(function(p) {
            if ((WEIGHTS[p.symbol] || 0) > 0) {
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
function renderDesktopChart(colored, volAgg, agg, regResult) {
    if (!chart || !csSeries) return;

    // Kerzen
    csSeries.setData(colored);

    // IBKR Einstandskurs
    refreshIbkrCostLine(colored);

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

    // LogReg
    applyLogReg(regResult, regS, regUS, regLS);

    // Log-Skala
    chart.applyOptions({ rightPriceScale: { mode: logScale ? 1 : 0 } });

    // Fit + Zeitachse 1 Jahr in die Zukunft verlängern
    fitWithFuture();

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
    if (!chart) return;
    chart.timeScale().fitContent();
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
    if (drawingManager && typeof drawingManager.setVisible === 'function') {
        drawingManager.setVisible(_drawVisible);
    }
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

    // Disable chart panning while dragging a drawing anchor
    _dmContainer.addEventListener('mousedown', function(e) {
        if (!drawingManager) return;
        var rect = _dmContainer.getBoundingClientRect();
        var pt = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        if (drawingManager.hitTestAnchor(pt) !== null) {
            chart.applyOptions({ handleScroll: false, handleScale: false });
        }
    }, true);
    var _reenableScroll = function() {
        chart.applyOptions({ handleScroll: true, handleScale: true });
    };
    _dmContainer.addEventListener('mouseup', _reenableScroll, true);
    _dmContainer.addEventListener('mouseleave', _reenableScroll, true);

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
            try { return new Cls(d.id, d.anchors || [], d.style || {}, d.options || {}); }
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
    [['panel-resizer-1', 'panel-notes',   'panel-perf'],
     ['panel-resizer-2', 'panel-perf',    'panel-import'],
     ['panel-resizer-3', 'panel-import',  'panel-ibkr']].forEach(function(cfg) {
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
    if ((e.key === 'Delete' || e.key === 'Backspace') && _drawSelected) {
        if (drawingManager) drawingManager.removeDrawing(_drawSelected.id);
        _drawSelected = null;
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
        ibkrLoadPositions().then(function() { return ibkrLoadCash(); }).then(function() {
            ibkrRenderTable(); refreshIbkrCostLine(_lastCandles); renderPerfTable();
        });
        ibkrLoadTrades().then(function() { ibkrRenderTrades(); });
    });
})();

// ╔══════════════════════════════════════════════════════════╗
// ║ 12. IBKR POSITIONEN (Desktop)                             ║
// ╚══════════════════════════════════════════════════════════╝

function ibkrRenderTable() {
    var tbody = document.getElementById('ibkrBody');
    var tfoot = document.getElementById('ibkrFoot');
    if (!tbody) return;

    var cashItems = (ibkrCash || []).filter(function(c) { return c.currency !== 'BASE'; });
    var cashBase  = (ibkrCash || []).find(function(c)   { return c.currency === 'BASE'; });
    var hasPosns  = ibkrPositions && ibkrPositions.length > 0;
    var hasCash   = cashItems.length > 0;

    if (!hasPosns && !hasCash) {
        tbody.innerHTML = '<tr><td colspan="7" style="padding:16px;color:var(--muted);text-align:center;">Keine Positionen — Sync drücken oder IBKR konfigurieren (⚙ Einst.)</td></tr>';
        if (tfoot) tfoot.innerHTML = '';
        return;
    }

    var sectionHdr = function(label) {
        return '<tr style="background:var(--surface);">'
            + '<td colspan="7" style="font-weight:700;font-size:9px;text-transform:uppercase;'
            + 'letter-spacing:.06em;color:var(--muted);padding:3px 6px;">' + label + '</td></tr>';
    };

    var html = '', totalPnl = 0, totalValue = 0, totalCost = 0, totalValueEur = 0, totalCostEur = 0, totalPnlEur = 0;

    // ── Positionen ─────────────────────────────────────────────
    if (hasPosns) {
        html += sectionHdr('Positionen');
        ibkrPositions.forEach(function(p) {
            var fx       = p.fx_rate_to_base || 1.0;
            var pnlMoney = (p.position_value || 0) - (p.cost_basis_money || 0);
            var cbmEur   = (p.cost_basis_money || 0) * fx;
            var pvEur    = (p.position_value  || 0) * fx;
            var pnlEur   = pnlMoney * fx;
            var pnlPct   = p.cost_basis_money ? pnlMoney / Math.abs(p.cost_basis_money) * 100 : 0;
            totalPnl      += pnlMoney;
            totalValue    += (p.position_value || 0);
            totalCost     += (p.cost_basis_money || 0);
            totalValueEur += pvEur;
            totalCostEur  += cbmEur;
            totalPnlEur   += pnlEur;
            var pColor = pnlEur >= 0 ? '#2d8a4e' : '#c0392b';
            var qty    = p.quantity || 0;
            html += '<tr>'
                + '<td style="font-weight:500">' + p.symbol + '</td>'
                + '<td style="color:var(--muted)">' + (p.asset_class || '-') + '</td>'
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
                + '<td style="font-weight:500">' + c.currency + '</td>'
                + '<td style="color:var(--muted)">Cash</td>'
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
        var tPnlPct    = totalCost    ? totalPnl    / Math.abs(totalCost)    * 100 : 0;
        var tPnlPctEur = totalCostEur ? totalPnlEur / Math.abs(totalCostEur) * 100 : 0;
        var tc = totalPnlEur >= 0 ? '#2d8a4e' : '#c0392b';
        footHtml += '<tr style="border-top:2px solid var(--border);background:var(--bg);">'
            + '<td style="font-weight:700">Assets</td><td></td><td></td>'
            + '<td style="font-weight:700">' + totalCostEur.toFixed(0) + ' €</td>'
            + '<td style="font-weight:700">' + totalValueEur.toFixed(0) + ' €</td>'
            + '<td style="font-weight:700;color:' + tc + '">' + (totalPnlEur >= 0 ? '+' : '') + totalPnlEur.toFixed(2) + ' €</td>'
            + '<td style="font-weight:700;color:' + tc + '">' + (tPnlPctEur  >= 0 ? '+' : '') + tPnlPctEur.toFixed(2)  + '%</td>'
            + '</tr>';
    }
    if (cashBase) {
        var cb = cashBase.ending_cash || 0;
        footHtml += '<tr style="border-top:1px solid var(--border);background:var(--bg);">'
            + '<td style="font-weight:700">Cash (Basis)</td><td colspan="3"></td>'
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
                + '<td style="font-weight:700;font-size:11px;">SUMME</td><td colspan="2"></td>'
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
}

async function ibkrSync() {
    var btn = document.getElementById('ibkrSyncBtn');
    if (btn) { btn.textContent = '...'; btn.disabled = true; }
    try {
        var result = await ibkrDoSync();
        if (result.ok) {
            ibkrLastSync = result.last_sync;
            await ibkrLoadPositions();
            await ibkrLoadCash();
            ibkrRenderTable();
            refreshIbkrCostLine(_lastCandles);
            renderPerfTable();
            await ibkrLoadTrades();
            ibkrRenderTrades();
        } else {
            alert('IBKR Sync Fehler: ' + (result.error || 'Unbekannter Fehler'));
        }
    } catch(e) {
        alert('Verbindungsfehler: ' + e.message);
    } finally {
        if (btn) { btn.textContent = '↻ Sync'; btn.disabled = false; }
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
    ibkrTrades.filter(function(t) { return (t.asset_class || '').toUpperCase() === 'STK'; }).forEach(function(t) {
        var fx      = t.fx_rate || 1;
        var valEur  = Math.abs(t.value || 0) * fx;
        var comEur  = Math.abs(t.commission || 0) * fx;
        var isBuy   = (t.action || '').toUpperCase().indexOf('BUY') >= 0;
        var actColor = isBuy ? '#2d8a4e' : '#c0392b';
        var actLabel = isBuy ? 'K' : 'V';
        html += '<tr>'
            + '<td style="color:var(--muted)">' + (t.trade_date || '').slice(0, 10) + '</td>'
            + '<td style="font-weight:500">' + (t.symbol || '') + '</td>'
            + '<td style="color:' + actColor + ';font-weight:700;text-align:center">' + actLabel + '</td>'
            + '<td style="text-align:right">' + Math.abs(t.quantity || 0) + '</td>'
            + '<td style="text-align:right">' + (t.price || 0).toFixed(2) + '</td>'
            + '<td style="text-align:right;font-weight:500">' + valEur.toFixed(0) + ' €</td>'
            + '<td style="text-align:right;color:var(--muted)">' + comEur.toFixed(2) + ' €</td>'
            + '</tr>';
    });
    tbody.innerHTML = html;
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

// Flyouts und Modal bei Klick außerhalb schließen
document.addEventListener('click', function(e) {
    if (!e.target.closest || !e.target.closest('.draw-sidebar')) {
        document.querySelectorAll('.draw-group').forEach(function(g) { g.classList.remove('open'); });
    }
    var modal = document.getElementById('ibkrModal');
    if (modal && modal.style.display === 'flex' && e.target === modal) {
        ibkrCloseSettings();
    }
});
