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
    // doubles/channels/wedges: Formationen an (1) oder aus (0)
    var DEFAULTS = { minTouches: 3, levels: 3, trendlines: 2, tolerance: 0.6,
                     doubles: 1, channels: 1, wedges: 1 };
    // Formationen (Kanal, Keil, Dreieck) nur in den jüngsten Kerzen suchen
    var PATTERN_WINDOW = { '1D': 150, '1W': 104, '1M': 60 };

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

    // ── Formationen ─────────────────────────────────────────────────────────

    /**
     * Doppeltop (isTop) bzw. Doppelboden: zwei ähnlich hohe Spitzen mit deutlichem
     * Tal dazwischen, davor ein Anstieg (beim Boden ein Fall), danach nicht über die
     * Spitzen hinaus. Schließt der Kurs jenseits der Nackenlinie, gilt sie als
     * bestätigt. Liefert die jüngste gültige oder null.
     */
    function doubleTop(b, pivots, isTop, tol, k, last, lookback) {
        var lt = Math.log(1 + tol);
        var minSep = 2 * k, maxSep = Math.round(lookback / 4);
        var best = null;
        for (var a = 0; a < pivots.length; a++) {
            for (var c = a + 1; c < pivots.length; c++) {
                var p1 = pivots[a], p2 = pivots[c], sep = p2.i - p1.i;
                if (sep < minSep || sep > maxSep) continue;
                if (last - p2.i > sep) continue;                                  // zu lange her
                if (Math.abs(Math.log(p2.price / p1.price)) > 2 * lt) continue;    // ungleich hoch
                var ext   = isTop ? Math.max(p1.price, p2.price) : Math.min(p1.price, p2.price);
                var inner = isTop ? Math.min(p1.price, p2.price) : Math.max(p1.price, p2.price);
                // Zwischen den Spitzen kein höheres Hoch; das Tal ist die Nackenlinie
                var neck = isTop ? Infinity : -Infinity, iv = p1.i, ok = true;
                for (var i = p1.i + 1; i < p2.i; i++) {
                    if (isTop ? b[i].high > ext : b[i].low < ext) { ok = false; break; }
                    if (isTop ? b[i].low < neck : b[i].high > neck) { neck = isTop ? b[i].low : b[i].high; iv = i; }
                }
                if (!ok || Math.abs(Math.log(inner / neck)) < 2.5 * lt) continue; // Tal zu flach
                var came = false;
                for (var j = Math.max(0, p1.i - sep); j < p1.i && !came; j++) {
                    if (isTop ? b[j].low <= neck : b[j].high >= neck) came = true;
                }
                if (!came) continue;
                var failed = false, confirmed = false;
                for (var m = p2.i + 1; m <= last && !failed; m++) {
                    var cl = b[m].close;
                    if (isTop ? cl > ext * (1 + tol) : cl < ext * (1 - tol)) failed = true;
                    else if (isTop ? cl < neck * (1 - tol) : cl > neck * (1 + tol)) confirmed = true;
                }
                if (failed) continue;
                // Heutiger Kurs relativ zur Nackenlinie, in Höhen der Formation (+ = Richtung Spitzen).
                // Offen erst, wenn er von der 2. Spitze mind. halb zurückgekommen ist; bestätigt nur,
                // bis das Kursziel (eine Höhe jenseits der Nackenlinie) erreicht ist.
                var h = Math.abs(Math.log(inner / neck));
                var pos = Math.log(b[last].close / neck) / h * (isTop ? 1 : -1);
                if (confirmed ? pos < -1 : pos > 0.5) continue;
                if (!best || p2.i > best.p2.i) best = { p1: p1, p2: p2, iv: iv, neck: neck, ext: ext, confirmed: confirmed };
            }
        }
        if (!best) return null;
        return {
            type: isTop ? 'double-top' : 'double-bottom',
            label: (isTop ? 'Doppeltop' : 'Doppelboden') + (best.confirmed ? ' ✓' : ' (offen)'),
            segs: [
                { i1: best.p1.i, p1: best.p1.price, i2: best.iv,   p2: best.neck },
                { i1: best.iv,   p1: best.neck,     i2: best.p2.i, p2: best.p2.price },
                { i1: best.p1.i, p1: best.neck,     i2: last,      p2: best.neck, neck: true },
            ],
            labelAt: { i: best.p1.i, price: best.ext, below: !isTop },
        };
    }

    /** Kandidaten für die obere (isUpper) bzw. untere Begrenzung einer Formation. */
    function boundLines(b, pivots, isUpper, tol, k, last, log, from) {
        var lt = Math.log(1 + tol);
        var fwd = log ? Math.log : function(v) { return v; };
        var margin = function(y) { return log ? lt : tol * Math.abs(y); };
        var minSpan = Math.max(2 * k, Math.round((last - from) / 6));
        var pts = pivots.filter(function(p) { return p.i >= from; });
        var out = [];
        for (var a = 0; a < pts.length; a++) {
            for (var c = a + 1; c < pts.length; c++) {
                var p1 = pts[a], p2 = pts[c];
                if (p2.i - p1.i < minSpan) continue;
                var y1 = fwd(p1.price), slope = (fwd(p2.price) - y1) / (p2.i - p1.i);
                var broken = false;
                for (var i = p1.i; i <= last && !broken; i++) {
                    var y = y1 + slope * (i - p1.i), cl = fwd(b[i].close);
                    if (isUpper ? cl > y + margin(y) : cl < y - margin(y)) broken = true;
                }
                if (broken) continue;
                var hits = [];
                pts.forEach(function(p) {
                    if (p.i < p1.i) return;
                    var y = y1 + slope * (p.i - p1.i);
                    if (Math.abs(fwd(p.price) - y) <= margin(y)) hits.push(p.i);
                });
                out.push({ i1: p1.i, y1: y1, slope: slope, hits: hits,
                           touches: hits.length, lastTouch: hits[hits.length - 1] });
            }
        }
        out.sort(function(x, y) { return (y.touches - x.touches) || (y.lastTouch - x.lastTouch); });
        return out.slice(0, 12);
    }

    /**
     * Kanal (parallele Begrenzungen) oder Keil/Dreieck (zulaufend) in den jüngsten
     * Kerzen. Obere Linie aus Hochs, untere aus Tiefs, beide seitdem ungebrochen.
     * Innerhalb der Formation je Seite mind. 2, zusammen mind. 5 Berührungen, und der
     * Kurs muss mind. zweimal zwischen oben und unten gewechselt haben — sonst trägt
     * eine Seite die Formation nicht. Liefert die beste erlaubte Formation oder null.
     */
    function channelOrWedge(b, piv, tol, k, last, log, win, allowChannel, allowWedge) {
        var lt = Math.log(1 + tol);
        var inv = log ? Math.exp : function(v) { return v; };
        var from = Math.max(0, last - win);
        var U = boundLines(b, piv.highs, true,  tol, k, last, log, from);
        var L = boundLines(b, piv.lows,  false, tol, k, last, log, from);
        var val = function(ln, i) { return inv(ln.y1 + ln.slope * (i - ln.i1)); };
        var best = null;
        U.forEach(function(u) {
            L.forEach(function(l) {
                // Die Formation beginnt erst, wenn beide Seiten (ab diesem Beginn) berührt wurden —
                // schrittweise, weil ein späterer Beginn frühere Berührungen der anderen Seite wegnimmt
                var s = Math.max(u.i1, l.i1);
                for (var it = 0; it < 4; it++) {
                    var fu = u.hits.filter(function(i) { return i >= s - k; });
                    var fl = l.hits.filter(function(i) { return i >= s - k; });
                    if (!fu.length || !fl.length) return;
                    var ns = Math.max(s, fu[0], fl[0]);
                    if (ns === s) break;
                    s = ns;
                }
                if (last - s < 4 * k) return;
                var inU = u.hits.filter(function(i) { return i >= s - k; });
                var inL = l.hits.filter(function(i) { return i >= s - k; });
                if (inU.length < 2 || inL.length < 2 || inU.length + inL.length < 5) return;
                var seq = inU.map(function(i) { return [i, 'u']; }).concat(inL.map(function(i) { return [i, 'l']; }))
                             .sort(function(x, y) { return x[0] - y[0]; });
                var switches = 0;
                for (var q = 1; q < seq.length; q++) if (seq[q][1] !== seq[q - 1][1]) switches++;
                if (switches < 2) return;
                // Keine Seite darf über weite Strecken unberührt bleiben (z.B. nach einer Kurslücke)
                var maxGap = function(hits) {
                    var g = 0, prev = s;
                    hits.concat([last]).forEach(function(i) { g = Math.max(g, i - prev); prev = Math.max(prev, i); });
                    return g;
                };
                if (Math.max(maxGap(inU), maxGap(inL)) > 0.7 * (last - s)) return;
                var uS = val(u, s), lS = val(l, s), uE = val(u, last), lE = val(l, last);
                if (!(lS > 0 && lE > 0) || uS <= lS || uE <= lE) return;
                var wS = Math.log(uS / lS), wE = Math.log(uE / lE);
                if (wS < 3 * lt) return;                                   // zu eng
                var r = wE / wS;
                var cu = Math.log(uE / uS), cl = Math.log(lE / lS);         // Veränderung je Linie
                var flat = Math.max(2 * lt, 0.12 * wS);                     // „flach“: kaum Steigung
                var type = null, label = null, channel = false;
                if (r > 0.85 && r < 1.18) {          // Breite bleibt etwa gleich → parallel
                    channel = true;
                    var dir = (cu + cl) / 2;
                    if (dir > flat)       { type = 'channel-up';   label = 'Kanal aufwärts'; }
                    else if (dir < -flat) { type = 'channel-down'; label = 'Kanal abwärts'; }
                    else                  { type = 'channel';      label = 'Seitwärtskanal'; }
                } else if (r < 0.6 && r > 0.05) {
                    var uFlat = Math.abs(cu) < flat, lFlat = Math.abs(cl) < flat;
                    if (uFlat && cl > 0)              { type = 'triangle-asc';  label = 'Aufsteigendes Dreieck'; }
                    else if (lFlat && cu < 0)         { type = 'triangle-desc'; label = 'Absteigendes Dreieck'; }
                    else if (cu < 0 && cl > 0)        { type = 'triangle';      label = 'Dreieck'; }
                    else if (cu > 0 && cl > 0)        { type = 'wedge-up';      label = 'Steigender Keil'; }
                    else if (cu < 0 && cl < 0)        { type = 'wedge-down';    label = 'Fallender Keil'; }
                }
                if (!type || (channel ? !allowChannel : !allowWedge)) return;
                var score = inU.length + inL.length + switches / 2
                          + 2 * Math.max(u.lastTouch, l.lastTouch) / last + (last - s) / win;
                if (!best || score > best.score) {
                    best = { score: score, type: type, label: label,
                             segs: [{ i1: s, p1: uS, i2: last, p2: uE }, { i1: s, p1: lS, i2: last, p2: lE }],
                             labelAt: { i: s, price: uS } };
                }
            });
        });
        return best;
    }

    /**
     * bars: [{time, open, high, low, close}] aufsteigend. tf: '1D' | '1W' | '1M'.
     * log: true bei logarithmischer Preisachse (Trendlinien dann im Log-Raum).
     * from: erste sichtbare Kerze (Zeit). Erkannt wird auf der ganzen Historie
     *   (sonst hätte z.B. ein 6-Monats-Wochenchart zu wenig Kerzen), die Linien
     *   beginnen aber frühestens hier — davor hat der Chart keine Kerzen, an denen
     *   eine Zeichnung verankert werden könnte.
     * opts: { minTouches, levels, trendlines, tolerance, doubles, channels, wedges } —
     *   fehlende Werte = Vorgabe; doubles/channels/wedges 0/1 schalten Formationen.
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
        if (!bars || bars.length < 4 * prm.k + 10) return { levels: [], trendlines: [], patterns: [] };
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

        // Formationen: Strecken wie oben in den sichtbaren Bereich kürzen
        out.patterns = [];
        var addPattern = function(p) {
            if (!p) return;
            var segs = [];
            p.segs.forEach(function(sg) {
                var i1 = sg.i1, p1 = sg.p1;
                if (sg.i2 <= vis) return;
                if (i1 < vis) {
                    var f = (vis - sg.i1) / (sg.i2 - sg.i1);
                    p1 = log ? Math.exp(Math.log(sg.p1) + f * (Math.log(sg.p2) - Math.log(sg.p1)))
                             : sg.p1 + f * (sg.p2 - sg.p1);
                    i1 = vis;
                }
                if (sg.i2 <= i1) return;
                segs.push({ time1: t(i1), price1: p1, time2: t(sg.i2), price2: sg.p2, neck: !!sg.neck });
            });
            if (!segs.length) return;
            out.patterns.push({ type: p.type, label: p.label, segs: segs,
                                labelTime: t(Math.max(p.labelAt.i, vis)),
                                labelPrice: p.labelAt.price * (p.labelAt.below ? 1 - 2 * tol : 1 + 2 * tol) });
        };
        if (o.doubles) {
            addPattern(doubleTop(b, piv.highs, true,  tol, prm.k, last, prm.lookback));
            addPattern(doubleTop(b, piv.lows,  false, tol, prm.k, last, prm.lookback));
        }
        if (o.channels || o.wedges) {
            var win = PATTERN_WINDOW[tf] || PATTERN_WINDOW['1D'];
            addPattern(channelOrWedge(b, piv, tol, prm.k, last, !!log, win, !!o.channels, !!o.wedges));
        }
        return out;
    }

    var api = { detect: detect, findPivots: findPivots, DEFAULTS: DEFAULTS };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.AutoLines = api;
})(this);
