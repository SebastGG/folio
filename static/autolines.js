/**
 * Auto-Linien: erkennt Unterstützungen/Widerstände und Trendlinien aus Kerzen.
 *
 * Reine Berechnung ohne DOM/Chart — desktop.js zeichnet das Ergebnis. Läuft auch
 * unter Node (module.exports), damit man es an echten Kursdaten prüfen kann.
 *
 * Vorgehen:
 *   1. Pivots: Hoch/Tief, das innerhalb von k Kerzen links und rechts extrem ist.
 *   2. Toleranz: 0,6 × mittlere relative Tagesspanne (ATR/Close) — passt sich der
 *      Schwankungsbreite des Werts an.
 *   3. Horizontale Zonen: Pivots (Hochs UND Tiefs, Rollen tauschen) mit ähnlichem
 *      Preis bündeln; ab 3 Berührungen eine Linie. Unter Kurs = Unterstützung.
 *   4. Trendlinien: Paare von Tief- (bzw. Hoch-)Pivots verbinden — im Log-Preis bei
 *      Log-Skala, sonst linear, damit die gezeichnete Gerade durch die Punkte läuft; gilt,
 *      wenn seitdem kein Schlusskurs deutlich durchgebrochen ist und mind. 3 Pivots
 *      die Linie berühren.
 */
(function(root) {
    'use strict';

    // Je Zeitrahmen: Pivot-Fenster k und betrachtete Kerzen
    var TF_PARAMS = {
        '1D': { k: 5, lookback: 500 },
        '1W': { k: 3, lookback: 260 },
        '1M': { k: 2, lookback: 180 },
    };
    // Vorgaben; in den Einstellungen änderbar (opts von detect)
    var DEFAULTS = { minTouches: 3, levels: 3, trendlines: 2, tolerance: 0.6 };

    function findPivots(bars, k) {
        var highs = [], lows = [];
        for (var i = k; i < bars.length - k; i++) {
            var isHigh = true, isLow = true;
            for (var j = i - k; j <= i + k && (isHigh || isLow); j++) {
                if (j === i) continue;
                if (bars[j].high > bars[i].high) isHigh = false;
                if (bars[j].low  < bars[i].low)  isLow  = false;
            }
            if (isHigh) highs.push({ i: i, price: bars[i].high });
            if (isLow)  lows.push({ i: i, price: bars[i].low });
        }
        return { highs: highs, lows: lows };
    }

    // Mittlere relative Spanne (True Range / Close) als Maß für „nah beieinander"
    function relativeRange(bars) {
        var sum = 0, n = 0;
        for (var i = 1; i < bars.length; i++) {
            var pc = bars[i - 1].close;
            var tr = Math.max(bars[i].high - bars[i].low,
                              Math.abs(bars[i].high - pc), Math.abs(bars[i].low - pc));
            if (bars[i].close > 0) { sum += tr / bars[i].close; n++; }
        }
        return n ? sum / n : 0.02;
    }

    function levels(bars, piv, tol, last, o) {
        var pts = piv.highs.concat(piv.lows).sort(function(a, b) { return a.price - b.price; });
        var clusters = [], cur = null;
        pts.forEach(function(p) {
            if (cur && p.price <= cur.mean * (1 + tol)) {
                cur.pts.push(p);
                cur.mean = cur.pts.reduce(function(s, q) { return s + q.price; }, 0) / cur.pts.length;
            } else {
                cur = { pts: [p], mean: p.price };
                clusters.push(cur);
            }
        });
        var close = bars[last].close;
        var out = clusters.filter(function(c) { return c.pts.length >= o.minTouches; }).map(function(c) {
            var first = Math.min.apply(null, c.pts.map(function(p) { return p.i; }));
            var lastTouch = Math.max.apply(null, c.pts.map(function(p) { return p.i; }));
            // Jüngere Berührungen zählen mehr (0,5 … 1,0 je Berührung)
            var score = c.pts.reduce(function(s, p) { return s + 0.5 + 0.5 * p.i / last; }, 0);
            return {
                kind: c.mean < close ? 'support' : 'resistance',
                price: c.mean, touches: c.pts.length, from: first, lastTouch: lastTouch, score: score,
            };
        });
        // Zu weit vom Kurs entfernte Zonen spielen keine Rolle
        out = out.filter(function(l) { return Math.abs(Math.log(l.price / close)) < 0.35; });
        var pick = function(kind) {
            return out.filter(function(l) { return l.kind === kind; })
                      .sort(function(a, b) { return b.score - a.score; })
                      .slice(0, o.levels);
        };
        return pick('support').concat(pick('resistance'));
    }

    function trendlines(bars, pivots, kind, tol, k, last, log, o) {
        var isSup = kind === 'support';
        var lt = Math.log(1 + tol);
        var fwd = log ? Math.log : function(v) { return v; };
        var inv = log ? Math.exp : function(v) { return v; };
        // Erlaubter Abstand zur Linie: im Log-Raum konstant, linear relativ zum Linienwert
        var margin = function(y) { return log ? lt : tol * Math.abs(y); };
        var minSpan = Math.max(2 * k, Math.round(bars.length / 20));
        var cands = [];
        for (var a = 0; a < pivots.length; a++) {
            for (var b = a + 1; b < pivots.length; b++) {
                var p1 = pivots[a], p2 = pivots[b];
                if (p2.i - p1.i < minSpan) continue;   // kurze Basis → wackelige Verlängerung
                var y1 = fwd(p1.price), y2 = fwd(p2.price);
                var slope = (y2 - y1) / (p2.i - p1.i);
                var at = function(i) { return y1 + slope * (i - p1.i); };
                // Seit dem ersten Punkt kein deutlicher Schluss jenseits der Linie
                var broken = false;
                for (var i = p1.i; i <= last && !broken; i++) {
                    var c = fwd(bars[i].close), y = at(i);
                    if (isSup ? c < y - margin(y) : c > y + margin(y)) broken = true;
                }
                if (broken) continue;
                var touches = 0, lastTouch = p2.i;
                pivots.forEach(function(p) {
                    if (p.i < p1.i) return;
                    var y = at(p.i);
                    if (Math.abs(fwd(p.price) - y) <= margin(y)) {
                        touches++;
                        if (p.i > lastTouch) lastTouch = p.i;
                    }
                });
                if (touches < o.minTouches) continue;
                // Aktuell zu weit weg → nicht mehr relevant
                var yNow = inv(at(last));
                if (!(yNow > 0) || Math.abs(Math.log(bars[last].close / yNow)) > 0.25) continue;
                cands.push({
                    kind: kind, i1: p1.i, i2: p2.i,
                    price1: p1.price, price2: p2.price, now: yNow, y1: y1, slope: slope,
                    touches: touches, lastTouch: lastTouch,
                    score: touches + 2 * lastTouch / last + (p2.i - p1.i) / last,
                });
            }
        }
        cands.sort(function(a, b) { return b.score - a.score; });
        // Fast gleiche Linien (gleiche Steigung, gleicher Wert heute) nur einmal
        var picked = [];
        cands.forEach(function(c) {
            if (picked.length >= o.trendlines) return;
            var dup = picked.some(function(p) { return Math.abs(Math.log(c.now / p.now)) < 2 * lt; });
            if (!dup) picked.push(c);
        });
        return picked;
    }

    /**
     * bars: [{time, open, high, low, close}] aufsteigend. tf: '1D' | '1W' | '1M'.
     * log: true bei logarithmischer Preisachse (Trendlinien dann im Log-Raum).
     * from: erste sichtbare Kerze (Zeit). Erkannt wird auf der ganzen Historie
     *   (sonst hätte z.B. ein 6-Monats-Wochenchart zu wenig Kerzen), die Linien
     *   beginnen aber frühestens hier — davor hat der Chart keine Kerzen, an denen
     *   eine Zeichnung verankert werden könnte.
     * opts: { minTouches, levels, trendlines, tolerance } — fehlende Werte = Vorgabe.
     *   levels/trendlines: höchstens so viele je Seite (0 = keine);
     *   tolerance: Faktor auf die mittlere relative Kerzenspanne.
     * Liefert { levels: [...], trendlines: [...] } mit Zeitstempeln statt Indizes;
     * jede Linie endet an der letzten Kerze (time2/price2 bzw. timeEnd).
     */
    function detect(bars, tf, log, from, opts) {
        var o = {};
        Object.keys(DEFAULTS).forEach(function(key) {
            var v = opts ? Number(opts[key]) : NaN;
            o[key] = isFinite(v) && opts[key] !== null && opts[key] !== '' ? v : DEFAULTS[key];
        });
        o.minTouches = Math.max(2, Math.round(o.minTouches));
        var prm = TF_PARAMS[tf] || TF_PARAMS['1D'];
        if (!bars || bars.length < 4 * prm.k + 10) return { levels: [], trendlines: [] };
        var b = bars.slice(-prm.lookback);
        var last = b.length - 1;
        var tol = o.tolerance * relativeRange(b);
        var piv = findPivots(b, prm.k);
        var t = function(i) { return b[i].time; };
        // Index der ersten sichtbaren Kerze
        var vis = 0;
        if (from) { while (vis < last && b[vis].time < from) vis++; }
        var out = { tol: tol, levels: [], trendlines: [] };
        levels(b, piv, tol, last, o).forEach(function(l) {
            var start = Math.max(l.from, vis);
            if (start >= last) return;
            out.levels.push({ kind: l.kind, price: l.price, touches: l.touches,
                              time: t(start), timeEnd: t(last) });
        });
        trendlines(b, piv.lows, 'support', tol, prm.k, last, !!log, o)
            .concat(trendlines(b, piv.highs, 'resistance', tol, prm.k, last, !!log, o))
            .forEach(function(l) {
                var priceAt = function(i) {
                    var y = l.y1 + l.slope * (i - l.i1);
                    return log ? Math.exp(y) : y;
                };
                // Anker vor dem sichtbaren Bereich entlang der Linie nach rechts schieben;
                // Ende immer an der letzten Kerze
                var i1 = Math.max(l.i1, vis), i2 = last;
                if (i2 <= i1) return;   // nur eine Kerze sichtbar
                out.trendlines.push({ kind: l.kind, touches: l.touches,
                                      time1: t(i1), price1: priceAt(i1), time2: t(i2), price2: priceAt(i2) });
            });
        return out;
    }

    var api = { detect: detect, findPivots: findPivots, DEFAULTS: DEFAULTS };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.AutoLines = api;
})(this);
