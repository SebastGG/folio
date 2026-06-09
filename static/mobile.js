/**
 * mobile.js — Mobile UI
 * ======================
 * Lädt NACH shared.js.
 * Enthält: Navigation, Mobile-Chart, Screens, Positionierung.
 * Enthält NICHT: Berechnungen, API-Calls (→ shared.js)
 *
 * !! REFACTORING-REGEL !!
 * Bestehenden Code ÄNDERN, keinen neuen Code hinzufügen.
 * Neue Screen? → Case in mNav() hinzufügen + Screen-Funktion anpassen.
 *
 * Schnittstelle zu shared.js:
 *   renderMobileChart(colored, volAgg, agg, regResult) ← von applyPeriod() aufgerufen
 *   showLoading(msg) / hideLoading()                   ← von loadIndexData() aufgerufen
 *   renderWatchlist()                                  ← von loadData() aufgerufen
 *   renderBasketSelect()                               ← von loadConfig() aufgerufen
 *   updateChartTitle()                                 ← von switchView() aufgerufen
 */

'use strict';

// ╔══════════════════════════════════════════════════════════╗
// ║  1. STATE (nur Mobile)                                    ║
// ╚══════════════════════════════════════════════════════════╝

var mChart    = null;   // LWC Chart-Instanz
var mCs       = null;   // Candlestick Series
var mVol      = null;   // Volume Series
var mMa50     = null;   // MA50 Series
var mMa200    = null;   // MA200 Series
var mReg      = null;   // LogReg Series
var mRegU     = null;   // LogReg Upper Band
var mRegL     = null;   // LogReg Lower Band
var _mIbkrCostLine  = null; // Einstandskurs-Preislinie
var _mMarkersPlugin = null; // LWC v5 SeriesMarkers-Plugin

var mCurrentScreen     = 'chart'; // Aktiver Screen
var _mSavedLogicalRange = null;  // Gespeicherter Zoom beim Ticker-Wechsel

function saveMobileChartRange() {
    if (!mChart) return;
    var r = mChart.timeScale().getVisibleLogicalRange();
    if (r) _mSavedLogicalRange = r;
}

// Positionen (berechnet nach Layout-Init)
var _mHeaderH = 48;  // Header-Höhe
var _mNavTop  = 0;   // Nav-Position von oben

// ╔══════════════════════════════════════════════════════════╗
// ║  2. LAYOUT-INIT                                           ║
// ╚══════════════════════════════════════════════════════════╝

/**
 * Positioniert Nav und Screens dynamisch.
 * Berücksichtigt Browser-Toolbar (Firefox Android ~50px am unteren Rand).
 */
function mLayout() {
    var nav = document.getElementById('m-nav');
    if (!nav) return;

    // Nav-Position: 80px vom echten Viewport-Boden
    var navBottom = 80;
    nav.style.bottom = navBottom + 'px';
    _mNavTop = window.innerHeight - navBottom - 60; // 60 = Nav-Höhe

    // Screens: zwischen Header-Ende und Nav-Anfang
    var screenTop    = _mHeaderH;
    var screenBottom = window.innerHeight - _mNavTop;

    document.querySelectorAll('.m-screen').forEach(function(s) {
        s.style.top    = screenTop + 'px';
        s.style.bottom = screenBottom + 'px';
    });

    // Chart-Wrap
    var wrap = document.getElementById('m-chart-wrap');
    if (wrap) {
        wrap.style.top    = screenTop + 'px';
        wrap.style.bottom = screenBottom + 'px';
    }

    // Mobile Chart Größe anpassen
    fitMobileChart();
}

// ╔══════════════════════════════════════════════════════════╗
// ║  3. LOADING (Interface zu shared.js)                      ║
// ╚══════════════════════════════════════════════════════════╝

function showLoading(msg) {
    // Auf Mobile: Nachricht im Chart-Bereich zeigen
    var el = document.getElementById('m-loading-text');
    if (el) el.textContent = msg || 'Lade...';
    var overlay = document.getElementById('m-loading');
    if (overlay) overlay.style.display = 'flex';
}

function hideLoading() {
    var overlay = document.getElementById('m-loading');
    if (overlay) overlay.style.display = 'none';
}

// ╔══════════════════════════════════════════════════════════╗
// ║  4. BOTTOM NAVIGATION                                     ║
// ╚══════════════════════════════════════════════════════════╝

/**
 * Wechselt zwischen den 6 Screens.
 * Screens werden per CSS .active gesteuert.
 */
function mNav(screen, btn) {
    mCurrentScreen = screen;

    // Nav-Buttons
    document.querySelectorAll('.m-nav-btn').forEach(function(b) {
        b.classList.remove('active');
    });
    if (btn) btn.classList.add('active');

    // Alle Screens ausblenden
    document.querySelectorAll('.m-screen').forEach(function(s) {
        s.classList.remove('active');
    });

    // Chart-Wrap verstecken (außer bei 'chart')
    var wrap = document.getElementById('m-chart-wrap');
    if (screen === 'chart') {
        if (wrap) wrap.style.display = 'flex';
        if (!mChart) {
            setTimeout(initMobileChart, 100);
        } else {
            setTimeout(function() {
                fitMobileChart();
                if (mChart) {
                    mChart.timeScale().fitContent();
                    var mRightBars = currentTF === '1W' ? 52 : currentTF === '1M' ? 12 : 252;
                    var mRange = mChart.timeScale().getVisibleLogicalRange();
                    if (mRange) mChart.timeScale().setVisibleLogicalRange({ from: mRange.from, to: mRange.to + mRightBars });
                }
            }, 50);
        }
    } else {
        if (wrap) wrap.style.display = 'none';
        var el = document.getElementById('m-screen-' + screen);
        if (el) el.classList.add('active');

        // Screen-Inhalte rendern
        if (screen === 'watch')   renderMobileWatchlist();
        if (screen === 'perf')    renderMobilePerf();
        if (screen === 'notes')   syncMobileNotes();
        if (screen === 'ind')     syncMobileInd();
        if (screen === 'manage')  renderMobileManage();
        if (screen === 'ibkr')    { mIbkrRenderTable(); mIbkrRenderTrades(); }
        if (screen === 'search')  { renderMobileManage(); document.getElementById('m-search-input') && (document.getElementById('m-search-input').value='') && (document.getElementById('m-search-results').innerHTML=''); }
    }
}

// ╔══════════════════════════════════════════════════════════╗
// ║  5. MOBILE CHART                                          ║
// ╚══════════════════════════════════════════════════════════╝

function initMobileChart() {
    var div = document.getElementById('m-chart-div');
    if (!div || mChart) {
        if (mChart) { fitMobileChart(); syncMobileChart(); }
        return;
    }

    var textColor = getComputedStyle(document.documentElement)
        .getPropertyValue('--text').trim() || '#1a1a18';

    mChart = LightweightCharts.createChart(div, {
        width:  div.clientWidth  || window.innerWidth,
        height: div.clientHeight || 300,
        layout: {
            background: { color: 'transparent' },
            textColor:  textColor,
            fontFamily: "-apple-system, BlinkMacSystemFont, 'Trebuchet MS', Roboto, Ubuntu, Arial, sans-serif",
        },
        grid: {
            vertLines: { color: 'rgba(0,0,0,0.05)' },
            horzLines: { color: 'rgba(0,0,0,0.05)' },
        },
        timeScale: { borderVisible: false, timeVisible: false, rightOffset: 12, fixLeftEdge: false, fixRightEdge: false },
        rightPriceScale: { borderVisible: false },
        crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    });

    mVol = mChart.addSeries(LightweightCharts.HistogramSeries, {
        color: '#2d8a4e',
        priceFormat: { type: 'volume' },
        priceScaleId: 'vol',
        lastValueVisible: false,
        priceLineVisible: false,
    });
    mChart.priceScale('vol').applyOptions({
        scaleMargins: { top: 0.85, bottom: 0 },
        borderVisible: false,
    });

    mCs = mChart.addSeries(LightweightCharts.CandlestickSeries, {
        upColor:        '#2d8a4e', downColor:       '#c0392b',
        borderUpColor:  '#2d8a4e', borderDownColor: '#c0392b',
        wickUpColor:    '#2d8a4e', wickDownColor:   '#c0392b',
    });

    mMa50  = mChart.addSeries(LightweightCharts.LineSeries, { color: '#2962ff', lineWidth: 1, visible: false, priceLineVisible: false, lastValueVisible: false });
    mMa200 = mChart.addSeries(LightweightCharts.LineSeries, { color: '#f5a623', lineWidth: 1, visible: false, priceLineVisible: false, lastValueVisible: false });
    mReg   = mChart.addSeries(LightweightCharts.LineSeries, { color: '#9b59b6', lineWidth: 2, visible: false, priceLineVisible: false, lastValueVisible: false });
    mRegU  = mChart.addSeries(LightweightCharts.LineSeries, { color: '#9b59b6', lineWidth: 1, visible: false, priceLineVisible: false, lastValueVisible: false, lineStyle: 2 });
    mRegL  = mChart.addSeries(LightweightCharts.LineSeries, { color: '#9b59b6', lineWidth: 1, visible: false, priceLineVisible: false, lastValueVisible: false, lineStyle: 2 });

    new ResizeObserver(fitMobileChart).observe(div);

    // Initiale Daten laden falls vorhanden
    if (_lastCandles && _lastCandles.length > 0) syncMobileChart();
}

function fitMobileChart() {
    if (!mChart) return;
    var div = document.getElementById('m-chart-div');
    var wrap = document.getElementById('m-chart-wrap');
    if (!div || !wrap) return;
    var w = wrap.clientWidth;
    var h = wrap.clientHeight;
    if (w > 0 && h > 0) {
        mChart.applyOptions({ width: w, height: h });
    }
}

function syncMobileChart() {
    if (!mChart || !mCs || !_lastCandles.length) return;

    mCs.setData(_lastCandles);

    if (mVol && _volumeData.length) {
        var cmap = {};
        _lastCandles.forEach(function(c) { cmap[c.time] = c.color; });
        try {
            mVol.setData(_volumeData.map(function(v) {
                return {
                    time: v.time, value: v.volume || 0,
                    color: cmap[v.time] === '#2d8a4e' ? 'rgba(45,138,78,0.4)' : 'rgba(192,57,43,0.4)',
                };
            }));
        } catch(e) {}
    }

    if (mMa50)  { mMa50.applyOptions({ visible: indicators.ma50 });  if (indicators.ma50)  mMa50.setData(calcMA(_lastCandles, 50)); }
    if (mMa200) { mMa200.applyOptions({ visible: indicators.ma200 }); if (indicators.ma200) mMa200.setData(calcMA(_lastCandles, 200)); }

    if (mChart) mChart.applyOptions({ rightPriceScale: { mode: logScale ? 1 : 0 } });
    if (mChart) {
        mChart.timeScale().fitContent();
        var mRightBars = currentTF === '1W' ? 52 : currentTF === '1M' ? 12 : 252;
        var mRange = mChart.timeScale().getVisibleLogicalRange();
        if (mRange) mChart.timeScale().setVisibleLogicalRange({ from: mRange.from, to: mRange.to + mRightBars });
    }
    fitMobileChart();
}

function refreshMobileIbkrCostLine(colored) {
    if (!mCs) return;
    if (_mIbkrCostLine) { try { mCs.removePriceLine(_mIbkrCostLine); } catch(e) {} _mIbkrCostLine = null; }
    if (!colored || !colored.length || !ibkrPositions || !ibkrPositions.length) return;
    var cbPrice = 0;
    if (currentView !== 'index') {
        var pos = ibkrPositions.find(function(p) { return ibkrPosYahoo(p) === currentView || p.symbol === currentView; });
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
        _mIbkrCostLine = mCs.createPriceLine({
            price: cbPrice, color: '#e67e22', lineWidth: 1, lineStyle: 2,
            axisLabelVisible: true, title: 'Einstand',
        });
    }
}

function refreshMobileTradeMarkers() {
    if (!mCs) return;
    var markers = [];
    if (currentView !== 'index' && ibkrTrades && ibkrTrades.length > 0) {
        var relevantTrades = ibkrTrades.filter(function(t) {
            return ibkrTradeYahoo(t) === currentView && (t.asset_class || '').toUpperCase() === 'STK';
        }).sort(function(a, b) { return a.trade_date < b.trade_date ? -1 : a.trade_date > b.trade_date ? 1 : 0; });
        var posRow = ibkrPositions && ibkrPositions.find(function(p) {
            return ibkrPosYahoo(p) === currentView || p.symbol === currentView;
        });
        var currentQty = posRow ? posRow.quantity : null;
        var totalTraded = relevantTrades.reduce(function(s, t) {
            return s + ((t.action || '').toUpperCase().indexOf('BUY') >= 0 ? Math.abs(t.quantity || 0) : -Math.abs(t.quantity || 0));
        }, 0);
        var runningQty = currentQty !== null ? currentQty - totalTraded : null;
        var dateRunning = {};
        relevantTrades.forEach(function(t) {
            if (!t.trade_date || runningQty === null) return;
            var buy = (t.action || '').toUpperCase().indexOf('BUY') >= 0;
            runningQty += buy ? Math.abs(t.quantity || 0) : -Math.abs(t.quantity || 0);
            dateRunning[t.trade_date] = runningQty;
        });
        var agg = {};
        relevantTrades.forEach(function(t) {
            if (!t.trade_date) return;
            var isBuy = (t.action || '').toUpperCase().indexOf('BUY') >= 0;
            var key = t.trade_date + (isBuy ? '_B' : '_S');
            if (!agg[key]) agg[key] = { date: t.trade_date, isBuy: isBuy, qty: 0 };
            agg[key].qty += Math.abs(t.quantity || 0);
        });
        var fmt = function(n) { return n === Math.floor(n) ? n : n.toFixed(1); };
        Object.keys(agg).forEach(function(k) {
            var g = agg[k];
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
        if (!_mMarkersPlugin) {
            _mMarkersPlugin = LightweightCharts.createSeriesMarkers(mCs, markers);
        } else {
            _mMarkersPlugin.setMarkers(markers);
        }
    } catch(e) { console.warn('refreshMobileTradeMarkers:', e); }
}

/**
 * Wird von shared.js applyPeriod() aufgerufen.
 * Rendert Mobile-Chart mit gefärbten Kerzen + Indikatoren.
 */
function renderMobileChart(colored, volAgg, agg, regResult) {
    if (!mChart || !mCs) return;

    // Reg-Serien zuerst updaten (siehe renderDesktopChart)
    if (mReg) {
        if (regResult) {
            mReg.applyOptions({ visible: true, title: 'ARR: ' + regResult.arr + '%' });
            mReg.setData(regResult.reg);
            if (mRegU) { mRegU.applyOptions({ visible: true }); mRegU.setData(regResult.upper); }
            if (mRegL) { mRegL.applyOptions({ visible: true }); mRegL.setData(regResult.lower); }
        } else {
            [mReg, mRegU, mRegL].forEach(function(s) { if (s) s.applyOptions({ visible: false }); });
        }
    }

    mCs.setData(colored);

    // IBKR Einstandskurs + Trade-Marker
    refreshMobileIbkrCostLine(colored);
    refreshMobileTradeMarkers();

    if (mVol && volAgg.length) {
        var cmap = {};
        colored.forEach(function(c) { cmap[c.time] = c.color; });
        var mVolData;
        if (currentView === 'index') {
            var mVolSum = volAgg.reduce(function(s, v) { return s + (v.volume || 0); }, 0);
            var mVolAvg = mVolSum / volAgg.length || 1;
            mVolData = volAgg.map(function(v) {
                return {
                    time: v.time, value: (v.volume || 0) / mVolAvg * 100,
                    color: cmap[v.time] === '#2d8a4e' ? 'rgba(45,138,78,0.4)' : 'rgba(192,57,43,0.4)',
                };
            });
        } else {
            mVolData = volAgg.map(function(v) {
                return {
                    time: v.time, value: v.volume || 0,
                    color: cmap[v.time] === '#2d8a4e' ? 'rgba(45,138,78,0.4)' : 'rgba(192,57,43,0.4)',
                };
            });
        }
        try { mVol.setData(mVolData); } catch(e) {}
    }

    if (mMa50)  { mMa50.applyOptions({ visible: indicators.ma50 });   if (indicators.ma50)  mMa50.setData(calcMA(agg, 50)); }
    if (mMa200) { mMa200.applyOptions({ visible: indicators.ma200 });  if (indicators.ma200) mMa200.setData(calcMA(agg, 200)); }

    if (mChart) mChart.applyOptions({ rightPriceScale: { mode: logScale ? 1 : 0 } });
    if (_mSavedLogicalRange !== null) {
        var _mRangeToRestore = _mSavedLogicalRange;
        _mSavedLogicalRange = null;
        if (mChart) requestAnimationFrame(function() {
            try { mChart.timeScale().setVisibleLogicalRange(_mRangeToRestore); } catch(e) { if (mChart) mChart.timeScale().fitContent(); }
        });
    } else {
        if (mChart) mChart.timeScale().fitContent();
    }
    fitMobileChart();

    // Aktiven Screen ggf. aktualisieren
    if (mCurrentScreen === 'watch') renderMobileWatchlist();
    if (mCurrentScreen === 'perf')  renderMobilePerf();
}

// ╔══════════════════════════════════════════════════════════╗
// ║  6. SCREEN-FUNKTIONEN                                     ║
// ╚══════════════════════════════════════════════════════════╝

// ── Watchlist ──────────────────────────────────────────────
function renderMobileWatchlist() {
    var el = document.getElementById('m-watchlist');
    if (!el) return;
    el.innerHTML = '';

    // Einheitliche Item-Erstellung für Index + Ticker
    function addItem(sym, name, price, chgPct, isActive, onClick) {
        var div = document.createElement('div');
        div.className = 'm-wl-item' + (isActive ? ' m-active' : '');
        var chgColor = 'var(--muted)';
        if (!isActive && chgPct !== null) {
            chgColor = parseFloat(chgPct) >= 0 ? 'var(--green)' : 'var(--red)';
        }
        div.innerHTML = '<div class="m-wl-sym">' + name + '</div>'
            + '<div class="m-wl-right">'
            + '<div class="m-wl-price">' + (price || '-') + '</div>'
            + '<div class="m-wl-chg" style="color:' + (isActive ? 'rgba(255,255,255,0.9)' : chgColor) + '">'
            + (chgPct !== null ? (parseFloat(chgPct) >= 0 ? '+' : '') + chgPct + '%' : '-')
            + '</div></div>';
        div.onclick = onClick;
        el.appendChild(div);
    }

    // Index (nur wenn für diesen Basket aktiviert)
    if (basketShowIndex()) {
        var last = allCandles.length ? allCandles[allCandles.length - 1] : null;
        var prev = allCandles.length > 1 ? allCandles[allCandles.length - 2] : last;
        var idxChg = last && prev ? ((last.close - prev.close) / prev.close * 100).toFixed(2) : null;
        addItem(
            'index',
            '● ' + (baskets[currentBasket] ? baskets[currentBasket].name : 'Index'),
            last ? '$' + last.close.toFixed(2) : '-',
            idxChg,
            currentView === 'index',
            function() { switchView('index'); mNav('chart', document.getElementById('mnav-chart')); }
        );
    }

    // Ticker
    Object.keys(WEIGHTS).forEach(function(sym) {
        var p = perfData[sym];
        addItem(
            sym, sym,
            p ? '$' + p.price.toFixed(2) : '-',
            p ? p.d1 : null,
            currentView === sym,
            function() { switchView(sym); mNav('chart', document.getElementById('mnav-chart')); }
        );
    });
}

// ── Performance ────────────────────────────────────────────
function renderMobilePerf() {
    var mSort = document.getElementById('m-perf-sort-mobile');
    var dSort = document.getElementById('perfSort');
    if (mSort && dSort) dSort.value = mSort.value;

    var mb = document.getElementById('m-perf-body');
    var mf = document.getElementById('m-perf-foot');
    if (!mb) return;

    buildPerfData();

    var sortVal = (mSort || {}).value || 'alpha';

    var fmt = function(v) {
        if (v === null || v === undefined || v === 'n/a') return '<td style="color:var(--muted)">-</td>';
        var n = parseFloat(v);
        var color = n >= 0 ? '#2d8a4e' : '#c0392b';
        return '<td style="color:' + color + '">' + (n >= 0 ? '+' : '') + n.toFixed(2) + '%</td>';
    };

    var ibkrMap = {};
    (ibkrPositions || []).forEach(function(p) { ibkrMap[p.symbol] = p; });
    var ibkrPnlPct = function(sym) {
        var pos = ibkrMap[sym];
        if (!pos || !(pos.cost_basis_price > 0)) return null;
        return ((pos.mark_price - pos.cost_basis_price) / pos.cost_basis_price * 100).toFixed(2);
    };

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

    var syms = Object.keys(perfData);
    if (syms.length === 0) {
        mb.innerHTML = '<tr><td colspan="6" style="padding:16px;color:var(--muted);text-align:center;">Keine Daten — Refresh drücken</td></tr>';
        return;
    }

    var sortKey = { alpha: null, '1d': 'd1', '1m': 'd22', ytd: 'ytd', ibkr: '_ibkr' }[sortVal];
    if (sortKey === '_ibkr') {
        syms.sort(function(a, b) { return parseFloat(ibkrPnlPct(b) || 0) - parseFloat(ibkrPnlPct(a) || 0); });
    } else {
        syms.sort(function(a, b) {
            if (!sortKey) return a.localeCompare(b);
            return parseFloat(perfData[b][sortKey] || 0) - parseFloat(perfData[a][sortKey] || 0);
        });
    }

    var html = '';
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
            + '<td>$' + posValue.toFixed(0) + '</td>'
            + fmt(ibkrPnlPct(sym)) + fmt(p.d1) + fmt(p.ytd)
            + '</tr>';
    });
    mb.innerHTML = html;

    if (mf && totalValue > 0) {
        var totalChg  = ((totalValue - totalPrevValue) / totalPrevValue * 100).toFixed(2);
        var chgColor  = parseFloat(totalChg) >= 0 ? '#2d8a4e' : '#c0392b';
        var ibkrColor = idxIbkrPnl ? (parseFloat(idxIbkrPnl) >= 0 ? '#2d8a4e' : '#c0392b') : '';
        mf.innerHTML = '<tr style="border-top:2px solid var(--border)">'
            + '<td style="font-weight:700">TOTAL</td><td></td>'
            + '<td style="font-weight:700">$' + totalValue.toFixed(0) + '</td>'
            + (idxIbkrPnl ? '<td style="font-weight:700;color:' + ibkrColor + '">' + (parseFloat(idxIbkrPnl)>=0?'+':'') + idxIbkrPnl + '%</td>' : '<td>-</td>')
            + '<td style="font-weight:700;color:' + chgColor + '">' + (parseFloat(totalChg)>=0?'+':'') + totalChg + '%</td>'
            + '<td></td>'
            + '</tr>';
    }
}

// ── Notizen ────────────────────────────────────────────────
function syncMobileNotes() {
    var src = document.getElementById('notesArea');
    var dst = document.getElementById('m-notes-area');
    if (src && dst) dst.value = src.value || '';
}

function syncUIState() { syncMobileInd(); }

// ── Indikatoren ────────────────────────────────────────────
function syncMobileInd() {
    var activeStyle   = 'font-family:inherit;font-size:12px;padding:12px 18px;border:1px solid #555;background:#555;color:white;cursor:pointer;border-radius:4px;touch-action:manipulation;min-height:44px;';
    var inactiveStyle = 'font-family:inherit;font-size:12px;padding:12px 18px;border:1px solid var(--border);background:var(--bg);color:var(--text);cursor:pointer;border-radius:4px;touch-action:manipulation;min-height:44px;';

    // Zeitraum
    var pMap = { 30: '1M', 90: '3M', 180: '6M', 365: '1J', 0: 'All' };
    document.querySelectorAll('.m-period-btn').forEach(function(b) {
        b.style.cssText = b.textContent.trim() === (pMap[currentPeriod] || 'All') ? activeStyle : inactiveStyle;
    });

    // TF
    var tMap = { '1D': '1T', '1W': '1W', '1M': '1M' };
    document.querySelectorAll('.m-tf-btn').forEach(function(b) {
        b.style.cssText = b.textContent.trim() === (tMap[currentTF] || '1T') ? activeStyle : inactiveStyle;
    });

    // Indikatoren
    ['ma50', 'ma200', 'reg'].forEach(function(k) {
        var btn = document.getElementById('m-ind-' + k);
        if (btn) btn.style.cssText = indicators[k] ? activeStyle : inactiveStyle;
    });

    // Log-Skala
    var lb = document.getElementById('m-ind-log');
    if (lb) lb.style.cssText = logScale ? activeStyle : inactiveStyle;
}

// ── Einstellungen ──────────────────────────────────────────
function renderMobileManage() {
    var el = document.getElementById('m-manage-content');
    if (!el) return;
    el.innerHTML = '';

    // Index-toggle header
    var header = document.createElement('div');
    header.style.cssText = 'padding:4px 0 10px;border-bottom:1px solid var(--border);margin-bottom:10px;';
    var showIdx = basketShowIndex();
    header.innerHTML = '<label style="display:flex;align-items:center;gap:8px;font-size:12px;cursor:pointer;">'
        + '<input type="checkbox" id="m-chk-show-index"' + (showIdx ? ' checked' : '') + '>'
        + 'Index anzeigen</label>';
    header.querySelector('input').onchange = function() {
        baskets[currentBasket].showIndex = this.checked;
        markUnsaved();
        if (!this.checked && currentView === 'index') switchView(Object.keys(WEIGHTS)[0] || 'index');
        renderMobileWatchlist();
    };
    el.appendChild(header);

    var syms = Object.keys(WEIGHTS);
    if (syms.length === 0) {
        var empty = document.createElement('p');
        empty.style.cssText = 'color:var(--muted);padding:12px;';
        empty.textContent = 'Noch keine Ticker. Desktop → Verwaltung nutzen.';
        el.appendChild(empty);
        return;
    }

    syms.forEach(function(sym) {
        var row = document.createElement('div');
        row.className = 'm-manage-item';
        row.innerHTML = '<span class="m-manage-sym">' + sym + '</span>'
            + '<input class="m-manage-input" type="number" min="0" value="' + (WEIGHTS[sym] || 0) + '" data-sym="' + sym + '">'
            + '<button class="m-manage-del" onclick="mRemoveTicker(\'' + sym + '\')">×</button>';
        var input = row.querySelector('input');
        input.oninput = function() {
            var v = parseInt(this.value, 10);
            WEIGHTS[sym] = isNaN(v) ? 0 : v;
            markUnsaved();
        };
        el.appendChild(row);
    });
}

function mRemoveTicker(sym) {
    delete WEIGHTS[sym];
    markUnsaved();
    renderMobileManage();
    if (currentView === sym) switchView(basketShowIndex() ? 'index' : (Object.keys(WEIGHTS)[0] || 'index'));
    else loadData();
}

// ╔══════════════════════════════════════════════════════════╗
// ║  7. INTERFACE-FUNKTIONEN (von shared.js aufgerufen)       ║
// ╚══════════════════════════════════════════════════════════╝

function renderWatchlist() {
    renderMobileWatchlist();
}

function renderBasketSelect() {
    var mSel = document.getElementById('m-basket-select');
    var dSel = document.getElementById('basketSelect');  // hidden stub
    if (!mSel) return;
    mSel.innerHTML = '';
    var sortedIds = Object.keys(baskets).sort(function(a, b) {
        return (baskets[a].name || a).localeCompare(baskets[b].name || b, undefined, { sensitivity: 'base', numeric: true });
    });
    sortedIds.forEach(function(id) {
        var opt = document.createElement('option');
        opt.value = id;
        opt.textContent = baskets[id].name || id;
        opt.selected = id === currentBasket;
        mSel.appendChild(opt);
    });
    // Auch den hidden basketSelect füllen (für saveAll etc.)
    if (dSel) dSel.innerHTML = mSel.innerHTML;
    updateChartTitle();
}

function updateChartTitle() {
    // Kein sichtbarer Chart-Title auf Mobile — Basket-Select zeigt den Namen
}

// ╔══════════════════════════════════════════════════════════╗
// ║  8. STARTUP                                               ║
// ╚══════════════════════════════════════════════════════════╝

/**
 * Mobile-Startup-Sequenz:
 * 1. Layout positionieren
 * 2. Config laden
 * 3. Daten laden
 * 4. Chart initialisieren
 * 5. Notizen laden
 */

// ╔══════════════════════════════════════════════════════════╗
// ║  9. IBKR POSITIONEN (Mobile)                              ║
// ╚══════════════════════════════════════════════════════════╝

function mIbkrRenderTrades() {
    var tbody = document.getElementById('m-ibkr-trades-body');
    if (!tbody) return;
    if (!ibkrTrades || ibkrTrades.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="padding:10px;color:var(--muted);text-align:center;">Keine Trades</td></tr>';
        return;
    }
    var html = '';
    var shownTrades = ibkrTrades.filter(function(t) {
        var c = (t.asset_class || '').toUpperCase();
        return c === 'STK' || c === 'FUT';
    });
    if (shownTrades.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="padding:10px;color:var(--muted);text-align:center;">Keine Trades — Sync durchführen</td></tr>';
        return;
    }
    shownTrades.forEach(function(t) {
        var fx      = t.fx_rate || 1;
        var valEur  = Math.abs(t.value || 0) * fx;
        var isBuy   = (t.action || '').toUpperCase().indexOf('BUY') >= 0;
        var actColor = isBuy ? '#2d8a4e' : '#c0392b';
        var isFut    = (t.asset_class || '').toUpperCase() === 'FUT';
        html += '<tr>'
            + '<td style="color:var(--muted)">' + (t.trade_date || '').slice(0, 10) + '</td>'
            + '<td style="font-weight:500">' + (t.symbol || '') + (isFut ? ' <span style="font-size:8px;color:var(--muted)">FUT</span>' : '') + '</td>'
            + '<td style="color:' + actColor + ';font-weight:700;text-align:center">' + (isBuy ? 'K' : 'V') + '</td>'
            + '<td style="text-align:right">' + Math.abs(t.quantity || 0) + '</td>'
            + '<td style="text-align:right;font-weight:500">' + valEur.toFixed(0) + ' €</td>'
            + '</tr>';
    });
    tbody.innerHTML = html;
}

function mIbkrRenderTable() {
    var tbody = document.getElementById('m-ibkr-body');
    var tfoot = document.getElementById('m-ibkr-foot');
    var syncEl = document.getElementById('m-ibkr-last-sync');
    if (!tbody) return;

    if (!ibkrPositions || ibkrPositions.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="padding:16px;color:var(--muted);text-align:center;">Keine Positionen — Sync drücken</td></tr>';
        if (tfoot) tfoot.innerHTML = '';
        return;
    }

    var html = '', totalPnl = 0, totalValue = 0, totalCost = 0;
    ibkrPositions.forEach(function(p) {
        var fx       = p.fx_rate_to_base || 1.0;
        var pnlMoney = (p.position_value || 0) - (p.cost_basis_money || 0);
        var cbmEur   = (p.cost_basis_money || 0) * fx;
        var pvEur    = (p.position_value  || 0) * fx;
        var pnlEur   = pnlMoney * fx;
        var pnlPct   = p.cost_basis_money ? pnlMoney / Math.abs(p.cost_basis_money) * 100 : 0;
        totalPnl   += pnlEur;
        totalValue += pvEur;
        totalCost  += cbmEur;
        var pc = pnlEur >= 0 ? '#2d8a4e' : '#c0392b';
        var qty = p.quantity || 0;
        html += '<tr>'
            + '<td style="font-weight:500">' + p.symbol + (p.provisional ? ' <span title="inkl. heutiger Trades (vorläufig)" style="font-size:8px;color:var(--accent);font-weight:700">•heute</span>' : '') + '</td>'
            + '<td>' + (qty % 1 !== 0 ? qty.toFixed(4) : qty) + '</td>'
            + '<td>' + cbmEur.toFixed(0) + '</td>'
            + '<td>' + pvEur.toFixed(0) + '</td>'
            + '<td style="color:' + pc + '">' + (pnlEur >= 0 ? '+' : '') + pnlEur.toFixed(0) + '</td>'
            + '<td style="color:' + pc + '">' + (pnlPct >= 0 ? '+' : '') + pnlPct.toFixed(1)  + '%</td>'
            + '</tr>';
    });
    tbody.innerHTML = html;

    if (tfoot && totalValue !== 0) {
        var tPnlPct = totalCost ? totalPnl / Math.abs(totalCost) * 100 : 0;
        var tc = totalPnl >= 0 ? '#2d8a4e' : '#c0392b';
        tfoot.innerHTML = '<tr style="border-top:2px solid var(--border)">'
            + '<td style="font-weight:700">TOTAL</td><td></td>'
            + '<td style="font-weight:700">' + totalCost.toFixed(0) + '</td>'
            + '<td style="font-weight:700">' + totalValue.toFixed(0) + '</td>'
            + '<td style="font-weight:700;color:' + tc + '">' + (totalPnl  >= 0 ? '+' : '') + totalPnl.toFixed(0)  + '</td>'
            + '<td style="font-weight:700;color:' + tc + '">' + (tPnlPct   >= 0 ? '+' : '') + tPnlPct.toFixed(1)   + '%</td>'
            + '</tr>';
    }

    if (syncEl && ibkrLastSync) {
        syncEl.textContent = ibkrLastSync.slice(0, 16).replace('T', ' ') + ' UTC';
    }
}


async function mIbkrSync(btn) {
    if (btn) { btn.textContent = '...'; btn.disabled = true; }
    try {
        var result = await ibkrDoSync();
        if (result.ok) {
            ibkrLastSync = result.last_sync;
            await ibkrLoadIsinMap();
            await ibkrLoadPositions();
            mIbkrRenderTable();
            refreshMobileIbkrCostLine(_lastCandles);
            renderMobilePerf();
            await ibkrLoadTrades();
            mIbkrRenderTrades();
            refreshMobileTradeMarkers();
        } else {
            alert('IBKR Sync Fehler: ' + (result.error || 'Unbekannt'));
        }
    } catch(e) {
        alert('Verbindungsfehler: ' + e.message);
    } finally {
        if (btn) { btn.textContent = '↻ Sync IBKR'; btn.disabled = false; }
    }
}

function mIbkrExport() {
    if (!ibkrPositions || ibkrPositions.length === 0) {
        alert('Keine IBKR Positionen. Bitte zuerst synchronisieren.');
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

// ── Ticker Suche ───────────────────────────────────────────
function mOnSearch(val) {
    var res = document.getElementById('m-search-results');
    if (!res) return;
    if (!val || val.length < 1) { res.innerHTML = ''; return; }
    fetch('/api/search/' + encodeURIComponent(val))
        .then(function(r) { return r.json(); })
        .then(function(data) {
            res.innerHTML = data.slice(0, 8).map(function(d) {
                var already = WEIGHTS[d.symbol] !== undefined;
                return '<div style="display:flex;align-items:center;justify-content:space-between;padding:12px;border-bottom:1px solid var(--border);">'
                    + '<div><div style="font-weight:600;font-size:13px;">' + d.symbol + '</div>'
                    + '<div style="font-size:10px;color:var(--muted)">' + (d.name || '') + '</div></div>'
                    + (already
                        ? '<span style="color:var(--muted);font-size:10px;">bereits vorhanden</span>'
                        : '<button data-s="' + d.symbol + '" onclick="mAddTicker(this.getAttribute(\'data-s\'))" style="background:var(--accent);color:white;border:none;padding:8px 16px;cursor:pointer;font-family:inherit;font-size:12px;touch-action:manipulation;">+ Hinzufügen</button>')
                    + '</div>';
            }).join('') || '<p style="padding:12px;color:var(--muted);">Keine Ergebnisse</p>';
        })
        .catch(function() { res.innerHTML = ''; });
}

async function mAddTicker(sym) {
    if (WEIGHTS[sym] !== undefined) return;
    WEIGHTS[sym] = 1;
    markUnsaved();
    await fetch('/api/prices/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tickers: [sym] })
    });
    await loadData();
    renderMobileManage();
    var inp = document.getElementById('m-search-input');
    if (inp && inp.value) mOnSearch(inp.value);
}

(function mobileStartup() {
    // Layout nach erstem Paint positionieren
    requestAnimationFrame(function() {
        requestAnimationFrame(function() {
            mLayout();

            // Notes Textarea → sync beim Tippen
            var mNotes = document.getElementById('m-notes-area');
            if (mNotes) {
                mNotes.addEventListener('input', function() {
                    var dNotes = document.getElementById('notesArea');
                    if (dNotes) dNotes.value = mNotes.value;
                    clearTimeout(window._mNotesTimer);
                    window._mNotesTimer = setTimeout(saveNotes, 2000);
                });
            }

            // Chart-Screen als Standard
            var chartWrap = document.getElementById('m-chart-wrap');
            if (chartWrap) chartWrap.style.display = 'flex';
            var chartBtn = document.getElementById('mnav-chart');
            if (chartBtn) chartBtn.classList.add('active');

            // Daten laden
            loadConfig().then(function() {
                return loadDbTickers();
            }).then(function() {
                return loadData();
            }).then(function() {
                loadNotes();
                syncMobileNotes();
                initMobileChart();
                syncMobileInd();
                ibkrLoadIsinMap().then(function() {
                    ibkrLoadPositions().then(function() { refreshMobileIbkrCostLine(_lastCandles); renderMobilePerf(); });
                    ibkrLoadTrades().then(function() { mIbkrRenderTrades(); refreshMobileTradeMarkers(); });
                });
            });
        });
    });

    // Orientation/Resize → Layout neu berechnen
    window.addEventListener('resize', function() {
        mLayout();
        fitMobileChart();
    });
})();
