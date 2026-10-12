/**
 * Heatmap: alle vorhandenen Ticker als Kacheln, eingefärbt nach Kursveränderung.
 *
 * Aufbau wie die Finviz-Map: Gruppen (Sektor oder Basket) als Rechtecke, darin je
 * Ticker eine Kachel. Fläche = Marktkapitalisierung (linear, gedämpft per Wurzel
 * oder gleich groß), Farbe = Veränderung im gewählten Zeitraum.
 *
 * Die Kennzahlen rechnet der Server in einem Abruf für die ganze Kursdatenbank
 * (/api/heatmap). Fehlende Stammdaten (Sektor, Marktkap.) zieht _hmInfosNachladen()
 * einzeln über /api/ticker/info nach — einmal geholt, liegen sie in der Datenbank.
 *
 * Layout und Farben (HeatmapCalc) sind reine Rechnung und laufen auch unter Node
 * (module.exports), der Rest braucht das DOM der Seite #view-heatmap.
 */
(function(root) {
    'use strict';

    // Zeitraum → Ausschlag, ab dem die Farbe voll gesättigt ist (in %). Fest je
    // Zeitraum statt am größten Wert ausgerichtet: sonst färbt ein einzelner
    // Ausreißer alle anderen Kacheln grau, und gleiche Farbe hieße an jedem Tag etwas anderes.
    // Durch 3 teilbar, damit die Legende (Drittel-Stufen) glatte Zahlen zeigt.
    var SKALA = { d1: 3, d5: 6, d22: 9, d66: 15, d126: 24, ytd: 30, d252: 45 };

    // Divergierende Skala: neutrales Grau in der Mitte, Grün/Rot an den Enden wie
    // überall in der App. Je Theme eigene Stufen — hell werden die Enden dunkler,
    // dunkel werden sie heller als die Mitte (Helligkeit steigt mit dem Ausschlag).
    var PALETTE = {
        light: { neutral: '#d5d2ca', plus: '#1d7a43', minus: '#b42f27' },
        dark:  { neutral: '#3a3c44', plus: '#1f8a4c', minus: '#c8372d' },
    };
    // Reines Schwarz, nicht das Text-Schwarz der App (#1a1a18): Am Umschaltpunkt
    // zwischen heller und dunkler Schrift erreicht nur Schwarz/Weiß noch 4,5:1.
    var TEXT_HELL = '#ffffff', TEXT_DUNKEL = '#000000';

    // ── Farbe ────────────────────────────────────────────────────────────────
    function hexRgb(h) {
        h = h.replace('#', '');
        return [0, 2, 4].map(function(i) { return parseInt(h.slice(i, i + 2), 16) / 255; });
    }
    function rgbHex(c) {
        return '#' + c.map(function(v) {
            var n = Math.round(Math.max(0, Math.min(1, v)) * 255);
            return (n < 16 ? '0' : '') + n.toString(16);
        }).join('');
    }
    function lin(c)   { return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
    function delin(c) {
        c = Math.max(0, Math.min(1, c));
        return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    }
    function zuOklab(rgb) {
        var r = lin(rgb[0]), g = lin(rgb[1]), b = lin(rgb[2]);
        var l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
        var m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
        var s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
        return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
                1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
                0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s];
    }
    function ausOklab(L) {
        var l = L[0] + 0.3963377774 * L[1] + 0.2158037573 * L[2];
        var m = L[0] - 0.1055613458 * L[1] - 0.0638541728 * L[2];
        var s = L[0] - 0.0894841775 * L[1] - 1.2914855480 * L[2];
        l = l * l * l; m = m * m * m; s = s * s * s;
        return [delin( 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
                delin(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
                delin(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s)];
    }
    /** Mischung in OKLab: gleichmäßige Helligkeitsstufen statt der Delle der sRGB-Mischung. */
    function mische(a, b, t) {
        var A = zuOklab(hexRgb(a)), B = zuOklab(hexRgb(b));
        return rgbHex(ausOklab([0, 1, 2].map(function(i) { return A[i] + (B[i] - A[i]) * t; })));
    }
    function leuchtdichte(hex) {
        var c = hexRgb(hex).map(lin);
        return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    }
    function kontrast(a, b) {
        var x = leuchtdichte(a), y = leuchtdichte(b);
        return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
    }

    /**
     * Kachelfarbe für eine Veränderung v (in %) bei Vollausschlag skala.
     * → { bg, fg } oder null, wenn es keinen Wert gibt. fg ist die Schrift mit
     * dem höheren Kontrast — die hellen Mittelstufen tragen dunkle Schrift.
     */
    function farbe(v, skala, theme) {
        if (v === null || v === undefined || isNaN(v)) return null;
        var p = PALETTE[theme] || PALETTE.light;
        var t = Math.min(1, Math.abs(v) / (skala || 1));
        var bg = mische(p.neutral, v >= 0 ? p.plus : p.minus, t);
        var fg = kontrast(bg, TEXT_HELL) >= kontrast(bg, TEXT_DUNKEL) ? TEXT_HELL : TEXT_DUNKEL;
        return { bg: bg, fg: fg };
    }

    // ── Layout: Squarified Treemap (Bruls, Huizing, van Wijk 2000) ───────────
    // Legt Rechtecke zeilenweise entlang der kürzeren Seite und nimmt die nächste
    // Kachel nur dann in die Zeile, wenn das schlechteste Seitenverhältnis der Zeile
    // dadurch nicht schlechter wird — so bleiben die Kacheln annähernd quadratisch.
    function schlechtestes(zeile, seite) {
        var s = 0, max = 0, min = Infinity;
        zeile.forEach(function(r) { s += r.a; if (r.a > max) max = r.a; if (r.a < min) min = r.a; });
        var s2 = s * s, q2 = seite * seite;
        return Math.max(q2 * max / s2, s2 / (q2 * min));
    }
    function legeZeile(zeile, rest, out) {
        var s = 0;
        zeile.forEach(function(r) { s += r.a; });
        if (rest.w >= rest.h) {                       // senkrechte Spalte links
            var bw = rest.h > 0 ? s / rest.h : 0, y = rest.y;
            zeile.forEach(function(r) {
                var hh = bw > 0 ? r.a / bw : 0;
                out.push({ item: r.item, x: rest.x, y: y, w: bw, h: hh });
                y += hh;
            });
            rest.x += bw; rest.w = Math.max(0, rest.w - bw);
        } else {                                      // waagerechte Zeile oben
            var bh = rest.w > 0 ? s / rest.w : 0, x = rest.x;
            zeile.forEach(function(r) {
                var ww = bh > 0 ? r.a / bh : 0;
                out.push({ item: r.item, x: x, y: rest.y, w: ww, h: bh });
                x += ww;
            });
            rest.y += bh; rest.h = Math.max(0, rest.h - bh);
        }
    }
    /**
     * items: [{ wert > 0, … }] → [{ item, x, y, w, h }] lückenlos in (x, y, w, h).
     * Einträge ohne positiven Wert fallen heraus.
     */
    function squarify(items, x, y, w, h) {
        var out = [];
        var gueltig = items.filter(function(it) { return it.wert > 0; });
        var summe = gueltig.reduce(function(s, it) { return s + it.wert; }, 0);
        if (!gueltig.length || summe <= 0 || w <= 0 || h <= 0) return out;
        var f = (w * h) / summe;
        var offen = gueltig.map(function(it) { return { item: it, a: it.wert * f }; })
                           .sort(function(a, b) { return b.a - a.a; });
        var rest = { x: x, y: y, w: w, h: h };
        var zeile = [];
        while (offen.length) {
            var seite = Math.min(rest.w, rest.h);
            var kandidat = offen[0];
            if (!zeile.length || schlechtestes(zeile.concat([kandidat]), seite) <= schlechtestes(zeile, seite)) {
                zeile.push(offen.shift());
            } else {
                legeZeile(zeile, rest, out);
                zeile = [];
            }
        }
        if (zeile.length) legeZeile(zeile, rest, out);
        return out;
    }

    /**
     * Schriftgrößen für die Beschriftung einer Kachel w×h mit einem Symbol der
     * Länge len → { sym, chg } (chg = 0: nur der Ticker passt) oder null.
     */
    function beschriftung(w, h, len) {
        var breit = (w - 6) / (len * 0.62 + 0.3);
        var fs = Math.min(22, breit, (h - 4) / 2.25);        // Platz für zwei Zeilen
        if (fs >= 8) {
            var chg = Math.max(8, fs * 0.72);
            return { sym: fs, chg: (w - 6) >= chg * 0.56 * 8 ? chg : 0 };
        }
        fs = Math.min(22, breit, (h - 4) / 1.2);             // nur der Ticker
        return fs >= 7 ? { sym: fs, chg: 0 } : null;
    }

    var api = { SKALA: SKALA, PALETTE: PALETTE, farbe: farbe, mische: mische,
                kontrast: kontrast, zuOklab: zuOklab, squarify: squarify,
                beschriftung: beschriftung };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.HeatmapCalc = api;
})(typeof window !== 'undefined' ? window : this);


// ╔══════════════════════════════════════════════════════════╗
// ║  Seite #view-heatmap                                      ║
// ╚══════════════════════════════════════════════════════════╝

var HM_ZEITRAEUME = [
    { k: 'd1',   l: '1T' }, { k: 'd5',  l: '1W' },  { k: 'd22',  l: '1M' },
    { k: 'd66',  l: '3M' }, { k: 'd126', l: '6M' }, { k: 'ytd',  l: 'YTD' },
    { k: 'd252', l: '1J' },
];
var HM_VORGABE = { quelle: 'alle', zeitraum: 'd1', gruppe: 'sektor', groesse: 'wurzel', ansicht: 'kacheln' };
// Ganze Indizes aus der gemeinsamen Marktdatenbank (markt.py) — Auswahlwert 'idx:<id>'
var HM_INDIZES = [
    { id: 'sp500', name: 'S&P 500' },
    { id: 'ndx',   name: 'Nasdaq-100' },
    { id: 'rut',   name: 'Russell 2000' },
];
// Ab so vielen Kalendertagen Rückstand zum jüngsten Kurs gilt ein Ticker als
// veraltet. 4 lässt Wochenende plus Feiertag an nur einer Börse durchgehen.
var HM_VERALTET_TAGE = 4;

var _HM = {
    bereit:     false,   // Config (Baskets, appearance) geladen — vorher weder zeichnen noch speichern
    daten:      [],      // Antwort von /api/heatmap
    datenFuer:  null,    // zu welcher Quelle daten gehören: '' (Kursdatenbank des Benutzers) oder Index-ID
    markt:      null,    // bei Indexquellen: { stand, live, liste } vom Server
    nachfrage:  null,    // Timer: neu laden, während der Server die Kurse auffrischt
    geladen:    false,
    laedt:      null,    // laufender Abruf (Promise), damit sich Abrufe nicht überholen
    prefs:      null,
    kacheln:    [],      // zuletzt gezeichnete Kacheln (Index = data-i)
    sort:       null,    // Listenansicht: Spalte und Richtung
    sortAuf:    false,
    info:       { lauf: false, fertig: 0, gesamt: 0, fehler: 0, versucht: {} },
    beobachter: null,
};

/** Index-ID der gewählten Quelle ('sp500' …) oder '' für die eigenen Baskets/Kursdatenbank. */
function _hmIndex() {
    var q = _HM.prefs && _HM.prefs.quelle;
    return q && q.indexOf('idx:') === 0 ? q.slice(4) : '';
}

function _hmIndexName(id) {
    var i = HM_INDIZES.filter(function(x) { return x.id === id; })[0];
    return i ? i.name : id;
}

function _hmSichtbar() {
    var s = document.getElementById('view-heatmap');
    return !!(s && s.classList.contains('active'));
}

function _hmPrefsLaden() {
    var gespeichert = (typeof appearance !== 'undefined' && appearance && appearance.heatmap) || {};
    var p = Object.assign({}, HM_VORGABE, gespeichert);
    // Ein gelöschter Basket als Quelle → zurück auf alle (nur angezeigt, nicht gespeichert:
    // laufen die Screener-Baskets nach dem Aufräumen neu an, gilt die Wahl wieder)
    if (p.quelle.indexOf('b:') === 0 && !baskets[p.quelle.slice(2)]) p.quelle = 'alle';
    if (p.quelle === 'screener' && !_screenerBasketIds().length) p.quelle = 'alle';
    return p;
}

/**
 * Aus der Startsequenz (desktop.js), sobald die Config da ist. Wer die Seite
 * direkt über #/heatmap neu lädt, landet in heatmapInit(), bevor es Baskets gibt —
 * das Zeichnen wird dann hier nachgeholt.
 */
function heatmapStartBereit() {
    _HM.bereit = true;
    if (_hmSichtbar()) heatmapInit();
}

/** Eine Auswahl der Toolbar ändern. Gespeichert wird nur, was der Benutzer selbst umstellt. */
function heatmapSetze(schluessel, wert) {
    // Vor dem Laden der Config hieße Speichern: Vorgaben über den echten Stand schreiben
    if (!_HM.bereit) return;
    if (!_HM.prefs) _HM.prefs = _hmPrefsLaden();
    _HM.prefs[schluessel] = wert;
    if (!appearance) appearance = {};
    appearance.heatmap = Object.assign({}, _HM.prefs);
    if (typeof saveAppearanceSoon === 'function') saveAppearanceSoon();
    // Nach einer Zeitraum-Spalte sortiert → die Liste folgt dem neuen Zeitraum
    if (schluessel === 'zeitraum' && HM_ZEITRAEUME.some(function(z) { return z.k === _HM.sort; })) _HM.sort = null;
    heatmapRender();
    if (schluessel === 'quelle') _hmInfosNachladen();
}

// ── Welche Ticker ─────────────────────────────────────────────────────────────

/** Gewichte eines Baskets — für den aktiven der Live-Stand, auch wenn ungespeichert. */
function _hmGewichte(id) {
    return id === currentBasket ? (WEIGHTS || {}) : ((baskets[id] || {}).weights || {});
}

function _hmBasketIds() {
    var q = _HM.prefs.quelle;
    if (q.indexOf('b:') === 0) return baskets[q.slice(2)] ? [q.slice(2)] : [];
    if (q === 'screener') return _screenerBasketIds();   // Name beginnt mit „Screener " (desktop.js)
    return Object.keys(baskets);
}

/** IDs der Baskets, in denen sym steht, nach Namen sortiert (für Tooltip und Sprung). */
function _hmBasketsMit(sym) {
    return Object.keys(baskets).filter(function(id) {
        return Object.prototype.hasOwnProperty.call(_hmGewichte(id), sym);
    }).sort(function(a, b) {
        return (baskets[a].name || a).localeCompare(baskets[b].name || b, undefined, { numeric: true });
    });
}

/**
 * Die anzuzeigenden Ticker → { eintraege: [Datenzeile], ohneKurse: [sym] }.
 * „Alle Baskets" nimmt jeden Ticker, der in irgendeinem Basket steht — auch mit
 * Gewicht 0, denn auch die stehen in der Kursliste. „Ganze Kursdatenbank" zeigt
 * zusätzlich, was nur noch in der Datenbank liegt (Wechselkurse lässt der Server weg).
 */
function _hmAuswahl() {
    var nachT = {};
    _HM.daten.forEach(function(e) { nachT[e.t] = e; });
    // Ganze Kursdatenbank und Indizes: alles, was der Server liefert (er filtert die Indizes)
    if (_HM.prefs.quelle === 'db' || _hmIndex()) return { eintraege: _HM.daten.slice(), ohneKurse: [] };
    var syms = {};
    _hmBasketIds().forEach(function(id) {
        Object.keys(_hmGewichte(id)).forEach(function(s) { syms[s] = true; });
    });
    var eintraege = [], ohne = [];
    Object.keys(syms).forEach(function(s) {
        if (nachT[s]) eintraege.push(nachT[s]); else ohne.push(s);
    });
    return { eintraege: eintraege, ohneKurse: ohne.sort() };
}

function _hmSektor(e) {
    if (!e.info) return 'Ohne Stammdaten';
    if (e.sector) return e.sector;
    var qt = { ETF: 'ETFs', INDEX: 'Indizes', MUTUALFUND: 'Fonds', CRYPTOCURRENCY: 'Krypto',
               FUTURE: 'Futures', CURRENCY: 'Währungen' }[e.qt];
    return qt || 'Ohne Sektor';
}

/** Gruppen → [{ name, eintraege }] je nach Einstellung „Gruppen". */
function _hmGruppen(eintraege) {
    // Schlüssel ≠ Name: zwei Baskets gleichen Namens bleiben zwei Gruppen
    var g = _HM.prefs.gruppe, map = {};
    function rein(schluessel, name, e) {
        (map[schluessel] = map[schluessel] || { name: name, eintraege: [] }).eintraege.push(e);
    }
    if (g === 'basket') {
        var ids = _hmBasketIds();
        eintraege.forEach(function(e) {
            var drin = false;
            ids.forEach(function(id) {
                if (Object.prototype.hasOwnProperty.call(_hmGewichte(id), e.t)) { rein('b:' + id, baskets[id].name || id, e); drin = true; }
            });
            if (!drin) rein('-', 'In keinem Basket', e);
        });
    } else if (g === 'sektor') {
        eintraege.forEach(function(e) { var s = _hmSektor(e); rein(s, s, e); });
    } else {
        eintraege.forEach(function(e) { rein('', '', e); });
    }
    return Object.keys(map).map(function(k) { return map[k]; });
}

/** Flächenwert je Ticker; ohne Marktkap. der Median der übrigen, damit niemand verschwindet. */
function _hmGroessen(eintraege) {
    var art = _HM.prefs.groesse, w = {};
    if (art === 'gleich') { eintraege.forEach(function(e) { w[e.t] = 1; }); return w; }
    var f = art === 'wurzel' ? Math.sqrt : function(x) { return x; };
    var bekannt = eintraege.filter(function(e) { return e.cap_usd > 0; })
                           .map(function(e) { return f(e.cap_usd); }).sort(function(a, b) { return a - b; });
    var median = bekannt.length ? bekannt[Math.floor(bekannt.length / 2)] : 1;
    eintraege.forEach(function(e) { w[e.t] = e.cap_usd > 0 ? f(e.cap_usd) : median; });
    return w;
}

// ── Formatierung ──────────────────────────────────────────────────────────────

function _hmPct(v) {
    if (v === null || v === undefined) return '–';
    var a = Math.abs(v), dez = a >= 100 ? 0 : a >= 10 ? 1 : 2;
    var s = a.toLocaleString('de-DE', { minimumFractionDigits: dez, maximumFractionDigits: dez });
    return (v > 0 ? '+' : v < 0 ? '−' : '±') + s + ' %';
}
function _hmDatum(iso) { return iso ? iso.slice(8, 10) + '.' + iso.slice(5, 7) + '.' + iso.slice(0, 4) : '–'; }
function _hmTage(a, b) { return Math.round((Date.parse(b) - Date.parse(a)) / 86400000); }
function _hmKap(v, ccy) {
    if (!v) return '–';
    var c = (ccy === 'GBp' || ccy === 'GBX') ? 'GBP' : (ccy || '');
    var stufen = [[1e12, 'Bio.'], [1e9, 'Mrd.'], [1e6, 'Mio.']];
    for (var i = 0; i < stufen.length; i++) {
        if (v >= stufen[i][0]) {
            return (v / stufen[i][0]).toLocaleString('de-DE', { maximumFractionDigits: 2 }) + ' ' + stufen[i][1] + ' ' + c;
        }
    }
    return Math.round(v).toLocaleString('de-DE') + ' ' + c;
}
function _hmKurs(e) {
    return e.price.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + (e.ccy ? ' ' + e.ccy : '');
}
function _hmTheme() {
    return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

// ── Toolbar ───────────────────────────────────────────────────────────────────

function _hmToolbar() {
    var sel = document.getElementById('hm-quelle');
    if (sel) {
        var ids = Object.keys(baskets).sort(function(a, b) {
            return (baskets[a].name || a).localeCompare(baskets[b].name || b, undefined, { sensitivity: 'base', numeric: true });
        });
        var nScr = _screenerBasketIds().length;
        var html = '<option value="alle">Alle Baskets</option>'
                 + (nScr ? '<option value="screener">Alle Screener-Baskets (' + nScr + ')</option>' : '')
                 + '<option value="db">Ganze Kursdatenbank</option>'
                 + '<optgroup label="Index (ganzer Markt)">'
                 + HM_INDIZES.map(function(i) { return '<option value="idx:' + i.id + '">' + i.name + '</option>'; }).join('')
                 + '</optgroup>'
                 + '<optgroup label="Ein Basket">'
                 + ids.map(function(id) {
                       return '<option value="b:' + escHtml(id) + '">' + escHtml(baskets[id].name || id) + '</option>';
                   }).join('')
                 + '</optgroup>';
        if (sel.innerHTML !== html) sel.innerHTML = html;
        sel.value = _HM.prefs.quelle;
    }
    ['zeitraum', 'gruppe', 'groesse', 'ansicht'].forEach(function(k) {
        var grp = document.getElementById('hm-' + k);
        if (!grp) return;
        Array.prototype.forEach.call(grp.querySelectorAll('[data-v]'), function(b) {
            b.classList.toggle('active', b.getAttribute('data-v') === _HM.prefs[k]);
        });
    });
    var rb = document.getElementById('hm-refresh');
    if (rb && !rb.disabled) {
        rb.textContent = _hmIndex() ? '↻ Kurse auffrischen' : '↻ Kurse aktualisieren';
        rb.title = _hmIndex()
            ? 'Heutige Kurse aller Indexwerte bei Yahoo nachziehen (Sammelabruf, dauert rund eine Minute)'
            : 'Kurse aller angezeigten Ticker bei Yahoo nachziehen — auch die, die ↻ Refresh nicht anfasst (Gewicht 0, nur in der Datenbank)';
    }
    var g = document.getElementById('hm-groesse-wrap');
    // Größe spielt nur bei den Kacheln eine Rolle
    if (g) g.style.display = _HM.prefs.ansicht === 'liste' ? 'none' : 'contents';
}

// ── Laden ─────────────────────────────────────────────────────────────────────

async function _hmLaden() {
    if (_HM.laedt) return _HM.laedt;
    _HM.laedt = (async function() {
        try {
            var idx = _hmIndex();
            _HM.datenFuer = idx;
            try {
                var r = await fetch('/api/heatmap' + (idx ? '?quelle=' + encodeURIComponent(idx) : ''), { cache: 'no-store' });
                if (!r.ok) throw new Error('HTTP ' + r.status);
                var d = await r.json();
                _HM.daten   = Array.isArray(d.tickers) ? d.tickers : [];
                _HM.markt   = d.markt || null;
                _HM.geladen = true;
                logIt(7, 'Heatmap', _HM.daten.length + ' Ticker mit Kennzahlen geladen' + (idx ? ' (' + _hmIndexName(idx) + ')' : ''));
            } catch (e) {
                _HM.daten = []; _HM.markt = null;   // nicht die Daten der vorigen Quelle stehen lassen
                logIt(1, 'Heatmap', 'Kennzahlen nicht abrufbar: ' + e.message);
                _hmMeldung('Kennzahlen nicht abrufbar: ' + e.message, true);
            }
            // Der Server frischt die Indexkurse gerade auf → gleich noch einmal nachsehen
            clearTimeout(_HM.nachfrage);
            if (_HM.markt && _HM.markt.live) {
                _HM.nachfrage = setTimeout(function() {
                    if (!_hmSichtbar() || !_hmIndex()) return;
                    _hmLaden().then(function() { if (_hmSichtbar()) heatmapRender(); });
                }, 8000);
            }
        } finally {
            _HM.laedt = null;
        }
    })();
    return _HM.laedt;
}

/** Router-Hook: bei jedem Öffnen der Seite. */
async function heatmapInit() {
    if (!_HM.bereit) { _hmMeldung('Lade Baskets…'); return; }
    _HM.prefs = _hmPrefsLaden();
    _HM.hinweis = '';
    _hmToolbar();
    if (!_HM.beobachter && typeof ResizeObserver !== 'undefined') {
        // Meldet höchstens einmal je Frame; die Kacheln liegen absolut in der Fläche
        // und ändern deren Größe nicht — direkt zeichnen ist also schleifenfrei.
        var map = document.getElementById('hm-map');
        _HM.beobachter = new ResizeObserver(function() {
            if (_hmSichtbar() && _HM.prefs && _HM.prefs.ansicht !== 'liste') _hmKachelnZeichnen();
        });
        if (map) _HM.beobachter.observe(map);
    }
    if (_HM.geladen) heatmapRender();    // alten Stand sofort zeigen, frischen nachziehen
    else _hmMeldung('Lade Kennzahlen…');
    await _hmLaden();
    heatmapRender();
    _hmInfosNachladen();
}

/**
 * Fehlende Stammdaten der angezeigten Ticker einzeln holen (3 gleichzeitig).
 * Ohne Sektor landet ein Wert in „Ohne Stammdaten", ohne Marktkap. bekommt er
 * die mittlere Größe. Jeder Ticker wird pro Sitzung nur einmal versucht; nach
 * mehreren Fehlschlägen in Folge (Yahoo drosselt) bricht das Nachladen ab.
 */
async function _hmInfosNachladen() {
    var I = _HM.info;
    // Indexwerte haben ihre Stammdaten von Finviz — für 2000 Werte einzeln Yahoo zu fragen, verbietet sich
    if (I.lauf || !_HM.geladen || _hmIndex()) return;
    var offen = _hmAuswahl().eintraege.filter(function(e) { return !e.info && !I.versucht[e.t]; });
    if (!offen.length) return;
    I.lauf = true; I.fertig = 0; I.fehler = 0; I.gesamt = offen.length;
    var done = logTimer(4, 'Heatmap', 'Stammdaten für ' + offen.length + ' Ticker nachladen');
    var pos = 0, fehlerFolge = 0;

    async function arbeiter() {
        while (pos < offen.length && I.lauf) {
            var sym = offen[pos++].t;
            I.versucht[sym] = true;
            try {
                var r = await fetch('/api/ticker/info/' + encodeURIComponent(sym));
                var d = await r.json();
                if (!r.ok || !d.ok) throw new Error(d.error || ('HTTP ' + r.status));
                fehlerFolge = 0;
            } catch (e) {
                I.fehler++; fehlerFolge++;
                logIt(2, 'Heatmap', sym + ': Stammdaten nicht abrufbar — ' + e.message);
                if (fehlerFolge >= 6 && I.lauf) {
                    I.lauf = false;
                    logIt(2, 'Heatmap', 'Yahoo liefert keine Stammdaten mehr — Nachladen abgebrochen, beim nächsten Öffnen geht es weiter');
                }
            }
            I.fertig++;
            // Zwischendurch frisch laden, damit sich die Sektoren nach und nach füllen
            if (I.fertig % 12 === 0) _hmLaden().then(function() { if (_hmSichtbar()) heatmapRender(); });
            else _hmStatus();
        }
    }
    await Promise.all([arbeiter(), arbeiter(), arbeiter()]);
    var abgebrochen = !I.lauf;
    I.lauf = false;
    // Abgebrochene, nie angefasste Ticker dürfen beim nächsten Öffnen erneut
    offen.slice(pos).forEach(function(e) { delete I.versucht[e.t]; });
    done((I.fertig - I.fehler) + ' geholt, ' + I.fehler + ' fehlgeschlagen' + (abgebrochen ? ', abgebrochen' : ''));
    await _hmLaden();
    if (_hmSichtbar()) heatmapRender();
}

/** Kurse der angezeigten Ticker bei Yahoo nachziehen (gleiches Limit wie ↻ Refresh). */
async function heatmapKurseAktualisieren() {
    var btn = document.getElementById('hm-refresh');
    if (_hmIndex()) {
        // Indexkurse frischt der Server per Sammelabruf auf; die Seite fragt nach, bis er fertig ist
        var hinweis;
        try {
            var rr = await fetch('/api/markt/steuerung', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ aktion: 'live' })
            });
            var dd = await rr.json();
            if (!rr.ok || !dd.ok) throw new Error(dd.error || ('HTTP ' + rr.status));
            hinweis = dd.gestartet ? '⟳ Kurse werden aufgefrischt …' : '✓ Kurse sind gerade erst aufgefrischt worden';
            logIt(4, 'Heatmap', _hmIndexName(_hmIndex()) + ': ' + hinweis);
        } catch (e) {
            hinweis = '✕ Auffrischen fehlgeschlagen: ' + e.message;
            logIt(1, 'Heatmap', hinweis);
        }
        _HM.hinweis = hinweis;
        await _hmLaden();
        heatmapRender();
        return;
    }
    var aus = _hmAuswahl();
    var syms = aus.eintraege.map(function(e) { return e.t; }).concat(aus.ohneKurse);
    if (!syms.length) return;
    if (btn) { btn.disabled = true; btn.textContent = '⟳ ' + syms.length + ' Ticker…'; }
    var done = logTimer(4, 'Heatmap', 'Kurse für ' + syms.length + ' Ticker aktualisieren');
    var msg = '';
    try {
        var r = await fetch('/api/prices/update', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tickers: syms })
        });
        var d = await r.json();
        if (r.status === 429) {
            msg = '⏳ Kurse gerade erst aktualisiert — nächster Versuch in ' + (d.retry_after || 60) + ' s';
            done('Rate-Limit');
        } else {
            var failed = Object.keys(d.failed || {});
            failed.forEach(function(t) { logIt(2, 'Heatmap', t + ': ' + d.failed[t]); });
            msg = '✓ ' + (d.updated || 0) + ' aktualisiert'
                + (failed.length ? ' · ⚠ ' + failed.length + ' fehlgeschlagen (Protokoll)' : '');
            done(msg);
            await _hmLaden();
        }
    } catch (e) {
        msg = '✕ Aktualisieren fehlgeschlagen: ' + e.message;
        logIt(1, 'Heatmap', msg);
        done('Fehler');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '↻ Kurse aktualisieren'; }
    }
    _HM.hinweis = msg;
    heatmapRender();
}

// ── Zeichnen ──────────────────────────────────────────────────────────────────

function _hmMeldung(text, fehler) {
    var map = document.getElementById('hm-map');
    if (map) map.innerHTML = '<div class="hm-meldung' + (fehler ? ' hm-fehler' : '') + '">' + escHtml(text) + '</div>';
}

function heatmapRender() {
    if (!_HM.bereit) return;
    if (!_HM.prefs) _HM.prefs = _hmPrefsLaden();
    // Quelle gewechselt (eigene Daten ↔ Index, Index ↔ Index): erst die passenden Daten holen
    if (_HM.geladen && _HM.datenFuer !== _hmIndex()) {
        _hmToolbar();
        _hmMeldung('Lade Kennzahlen…');
        _hmLaden().then(function() { if (_hmSichtbar()) heatmapRender(); });
        return;
    }
    _hmToolbar();
    _hmStatus();
    _hmLegende();
    var liste = _HM.prefs.ansicht === 'liste';
    var map = document.getElementById('hm-map'), tab = document.getElementById('hm-liste');
    if (map) map.style.display = liste ? 'none' : '';
    if (tab) tab.style.display = liste ? '' : 'none';
    if (liste) _hmListeZeichnen(); else _hmKachelnZeichnen();
}

/** Jüngster Kurstag der Auswahl — Maßstab für „veraltet". */
function _hmJuengster(eintraege) {
    return eintraege.reduce(function(m, e) { return e.last > m ? e.last : m; }, '');
}

function _hmStatus() {
    var el = document.getElementById('hm-info');
    if (!el || !_HM.prefs) return;
    if (!_HM.geladen) { el.textContent = ''; return; }
    var aus = _hmAuswahl(), k = _HM.prefs.zeitraum, E = aus.eintraege;
    var werte = E.map(function(e) { return e[k]; }).filter(function(v) { return v !== null && v !== undefined; });
    var hoch = werte.filter(function(v) { return v > 0; }).length;
    var runter = werte.filter(function(v) { return v < 0; }).length;
    var mittel = werte.length ? werte.reduce(function(s, v) { return s + v; }, 0) / werte.length : null;
    var juengst = _hmJuengster(E);
    var alt = E.filter(function(e) { return _hmTage(e.last, juengst) > HM_VERALTET_TAGE; });

    var teile = ['<b>' + E.length + '</b> Ticker'];
    var M = _hmIndex() ? _HM.markt : null;
    if (M && M.liste && E.length < M.liste) {
        teile[0] = '<b>' + E.length + '</b> von ' + M.liste + ' Werten mit Kursen'
                 + ' <span class="hm-warn" title="Der Marktdaten-Sammler holt die übrigen — Fortschritt auf der Protokoll-Seite">(Sammler läuft)</span>';
    }
    if (werte.length) {
        teile.push('<span class="hm-auf">▲</span> ' + hoch + ' · <span class="hm-ab">▼</span> ' + runter);
        teile.push('Ø <b>' + _hmPct(mittel) + '</b>');
    }
    if (M && M.stand) {
        var t = new Date(M.stand * 1000);
        teile.push('Kurse von ' + t.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }) + ' '
                   + t.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
                   + (M.live ? ' · <span class="hm-warn">werden aufgefrischt …</span>' : ''));
    } else if (juengst) teile.push('Stand ' + _hmDatum(juengst));
    if (alt.length) {
        teile.push('<span class="hm-warn" title="Kurse älter als der jüngste Stand: '
            + escHtml(alt.slice(0, 40).map(function(e) { return e.t + ' (' + _hmDatum(e.last) + ')'; }).join(', '))
            + (alt.length > 40 ? ' …' : '') + '">⚠ ' + alt.length + ' veraltet (schraffiert)</span>');
    }
    if (aus.ohneKurse.length) {
        teile.push('<span class="hm-warn" title="' + escHtml(aus.ohneKurse.join(', ')) + '">'
            + aus.ohneKurse.length + ' ohne Kursdaten</span>');
    }
    var I = _HM.info;
    if (I.lauf) teile.push('Stammdaten ' + I.fertig + '/' + I.gesamt + ' …');
    if (_HM.hinweis) teile.push(escHtml(_HM.hinweis));
    el.innerHTML = teile.join('<span class="hm-trenn">·</span>');
}

function _hmLegende() {
    var el = document.getElementById('hm-legende');
    if (!el || !_HM.prefs) return;
    if (_HM.prefs.ansicht === 'liste') { el.innerHTML = ''; return; }
    var S = HeatmapCalc.SKALA[_HM.prefs.zeitraum], theme = _hmTheme();
    var html = '';
    [-1, -2 / 3, -1 / 3, 0, 1 / 3, 2 / 3, 1].forEach(function(f) {
        var v = f * S, c = HeatmapCalc.farbe(v, S, theme);
        var txt = (v > 0 ? '+' : v < 0 ? '−' : '') + Math.round(Math.abs(v) * 10) / 10;
        html += '<span class="hm-leg-sw" style="background:' + c.bg + ';color:' + c.fg + '">'
              + txt.replace('.', ',') + '</span>';
    });
    el.innerHTML = '<span class="hm-leg-l" title="Ab diesem Ausschlag ist die Farbe voll gesättigt">%</span>' + html;
}

function _hmKachelnZeichnen() {
    var map = document.getElementById('hm-map');
    if (!map || !_HM.geladen) return;
    var W = map.clientWidth, H = map.clientHeight;
    if (W < 20 || H < 20) return;      // versteckt — beim Öffnen kommt die Seite wieder vorbei

    var aus = _hmAuswahl();
    if (!aus.eintraege.length) {
        _hmMeldung(_hmIndex()
            ? 'Für den ' + _hmIndexName(_hmIndex()) + ' liegen noch keine Kurse vor. Der Marktdaten-Sammler holt sie '
              + 'nach dem Start der App nach und nach — den Fortschritt zeigt die Protokoll-Seite.'
            : aus.ohneKurse.length
            ? 'Für diese Ticker liegen noch keine Kurse vor — „↻ Kurse aktualisieren" holt sie.'
            : 'Keine Ticker. Lege Werte in einem Basket an, dann erscheinen sie hier.');
        _HM.kacheln = [];
        return;
    }
    var k = _HM.prefs.zeitraum, S = HeatmapCalc.SKALA[k], theme = _hmTheme();
    var juengst = _hmJuengster(aus.eintraege);
    var groesse = _hmGroessen(aus.eintraege);
    var gruppen = _hmGruppen(aus.eintraege).map(function(g) {
        g.wert = g.eintraege.reduce(function(s, e) { return s + groesse[e.t]; }, 0);
        return g;
    });
    var mitKopf = _HM.prefs.gruppe !== 'keine';
    var KOPF = 18, LUECKE = 2;

    var html = '', kacheln = [];
    HeatmapCalc.squarify(gruppen, 0, 0, W, H).forEach(function(gr) {
        var g = gr.item;
        var x0 = Math.round(gr.x), y0 = Math.round(gr.y);
        var x1 = Math.round(gr.x + gr.w), y1 = Math.round(gr.y + gr.h);
        var gx = x0 + LUECKE, gy = y0 + LUECKE, gw = x1 - x0 - 2 * LUECKE, gh = y1 - y0 - 2 * LUECKE;
        if (gw < 2 || gh < 2) return;
        var kopf = mitKopf && gw >= 40 && gh >= 40 ? KOPF : 0;
        if (kopf) {
            var vals = g.eintraege.map(function(e) { return e[k]; }).filter(function(v) { return v !== null && v !== undefined; });
            var avg = vals.length ? vals.reduce(function(s, v) { return s + v; }, 0) / vals.length : null;
            html += '<div class="hm-grp-h" style="left:' + gx + 'px;top:' + gy + 'px;width:' + gw + 'px"'
                  + ' title="' + escHtml(g.name) + ' — ' + g.eintraege.length + ' Ticker, Ø ' + _hmPct(avg) + '">'
                  + escHtml(g.name) + ' <span class="hm-grp-n">' + g.eintraege.length
                  + (avg !== null ? ' · Ø ' + _hmPct(avg) : '') + '</span></div>';
        }
        var items = g.eintraege.map(function(e) { return { wert: groesse[e.t], e: e, gruppe: g.name }; });
        HeatmapCalc.squarify(items, gx, gy + kopf, gw, gh - kopf).forEach(function(r) {
            var e = r.item.e;
            var l = Math.round(r.x), t = Math.round(r.y);
            var w = Math.round(r.x + r.w) - l - 1, h = Math.round(r.y + r.h) - t - 1;
            if (w < 1 || h < 1) return;
            var veraltet = _hmTage(e.last, juengst) > HM_VERALTET_TAGE;
            var i = kacheln.length;
            r.item.veraltet = veraltet;
            kacheln.push(r.item);
            var c = HeatmapCalc.farbe(e[k], S, theme);
            var cls = 'hm-tile' + (c ? '' : ' hm-leer') + (veraltet ? ' hm-alt' : '');
            var stil = 'left:' + l + 'px;top:' + t + 'px;width:' + w + 'px;height:' + h + 'px;'
                     + (c ? 'background:' + c.bg + ';color:' + c.fg + ';' : '');
            var b = HeatmapCalc.beschriftung(w, h, e.t.length), inhalt = '';
            if (b) {
                inhalt = '<span class="hm-sym" style="font-size:' + b.sym.toFixed(1) + 'px">' + escHtml(e.t) + '</span>';
                if (b.chg) inhalt += '<span class="hm-chg" style="font-size:' + b.chg.toFixed(1) + 'px">' + _hmPct(e[k]) + '</span>';
            }
            html += '<div class="' + cls + '" data-i="' + i + '" style="' + stil + '">' + inhalt + '</div>';
        });
    });
    _HM.kacheln = kacheln;
    map.innerHTML = html;
    logIt(8, 'Heatmap', kacheln.length + ' Kacheln gezeichnet (' + W + '×' + H + ')');
}

// ── Liste ─────────────────────────────────────────────────────────────────────

var HM_SPALTEN = [
    { k: 't',      l: 'Ticker',    txt: true },
    { k: 'name',   l: 'Name',      txt: true },
    { k: '_sek',   l: 'Sektor',    txt: true },
    { k: 'price',  l: 'Kurs' },
].concat(HM_ZEITRAEUME.map(function(z) { return { k: z.k, l: z.l, pct: true }; })).concat([
    { k: 'cap_usd', l: 'Marktkap.' },
    { k: 'last',    l: 'Stand',    txt: true },
]);

function heatmapSortiere(k) {
    var aktiv = _HM.sort || _HM.prefs.zeitraum;
    if (aktiv === k) _HM.sortAuf = !_HM.sortAuf;
    else { _HM.sort = k; _HM.sortAuf = !!(HM_SPALTEN.filter(function(s) { return s.k === k; })[0] || {}).txt; }
    _hmListeZeichnen();
}

function _hmListeZeichnen() {
    var el = document.getElementById('hm-liste');
    if (!el || !_HM.geladen) return;
    var aus = _hmAuswahl();
    var key = _HM.sort || _HM.prefs.zeitraum, auf = _HM.sort ? _HM.sortAuf : false;
    var juengst = _hmJuengster(aus.eintraege);
    var wert = function(e) { return key === '_sek' ? _hmSektor(e) : e[key]; };
    var zeilen = aus.eintraege.slice().sort(function(a, b) {
        var x = wert(a), y = wert(b);
        if (x === null || x === undefined) return 1;      // Leere immer ans Ende
        if (y === null || y === undefined) return -1;
        var r = typeof x === 'string' ? x.localeCompare(y, 'de', { numeric: true }) : x - y;
        return auf ? r : -r;
    });
    var kopf = HM_SPALTEN.map(function(s) {
        var pfeil = s.k === key ? (auf ? ' ▲' : ' ▼') : '';
        return '<th class="' + (s.txt ? 'hm-l' : '') + (s.k === _HM.prefs.zeitraum ? ' hm-akt' : '') + '"'
             + ' onclick="heatmapSortiere(\'' + s.k + '\')">' + s.l + pfeil + '</th>';
    }).join('');
    var rumpf = zeilen.map(function(e) {
        var veraltet = _hmTage(e.last, juengst) > HM_VERALTET_TAGE;
        return '<tr data-t="' + escHtml(e.t) + '">' + HM_SPALTEN.map(function(s) {
            if (s.pct) {
                var v = e[s.k];
                var cls = v > 0 ? 'hm-auf' : v < 0 ? 'hm-ab' : '';
                return '<td class="' + cls + (s.k === _HM.prefs.zeitraum ? ' hm-akt' : '') + '">' + _hmPct(v) + '</td>';
            }
            if (s.k === 't')       return '<td class="hm-l"><b>' + escHtml(e.t) + '</b></td>';
            if (s.k === 'name')    return '<td class="hm-l hm-name">' + escHtml(e.name || '') + '</td>';
            if (s.k === '_sek')    return '<td class="hm-l">' + escHtml(_hmSektor(e)) + '</td>';
            if (s.k === 'price')   return '<td>' + _hmKurs(e) + '</td>';
            if (s.k === 'cap_usd') return '<td>' + _hmKap(e.cap, e.ccy) + '</td>';
            return '<td class="hm-l' + (veraltet ? ' hm-warn' : '') + '">' + _hmDatum(e.last) + '</td>';
        }).join('') + '</tr>';
    }).join('');
    el.innerHTML = '<table class="hm-tab"><thead><tr>' + kopf + '</tr></thead><tbody>' + rumpf + '</tbody></table>';
}

// ── Tooltip und Sprung in den Chart ───────────────────────────────────────────

function _hmTooltip(e, veraltet, ev) {
    var tip = document.getElementById('hm-tip'), body = document.querySelector('#view-heatmap .hm-body');
    if (!tip || !body) return;
    var k = _HM.prefs.zeitraum;
    var kopf = HM_ZEITRAEUME.map(function(z) { return '<span class="' + (z.k === k ? 'hm-akt' : '') + '">' + z.l + '</span>'; }).join('');
    var zahlen = HM_ZEITRAEUME.map(function(z) {
        var v = e[z.k];
        return '<span class="' + (v > 0 ? 'hm-auf' : v < 0 ? 'hm-ab' : '') + (z.k === k ? ' hm-akt' : '') + '">' + _hmPct(v) + '</span>';
    }).join('');
    var sek = [e.sector, e.industry].filter(Boolean).join(' · ') || _hmSektor(e);
    var inB = _hmBasketsMit(e.t).map(function(id) { return baskets[id].name || id; });
    tip.innerHTML = '<div class="hm-tip-h"><b>' + escHtml(e.t) + '</b> ' + escHtml(e.name || '') + '</div>'
        + '<div class="hm-tip-m">' + escHtml(sek) + '</div>'
        + '<div>Kurs <b>' + _hmKurs(e) + '</b> · ' + _hmDatum(e.last)
        + (veraltet ? ' <span class="hm-warn">⚠ veraltet</span>' : '') + '</div>'
        + '<div>Marktkap. ' + _hmKap(e.cap, e.ccy) + '</div>'
        + '<div class="hm-tip-perf">' + kopf + zahlen + '</div>'
        + (inB.length ? '<div class="hm-tip-m">In: ' + escHtml(inB.join(', ')) + '</div>' : '')
        + '<div class="hm-tip-m">Klick öffnet den Chart</div>';
    tip.style.display = 'block';
    var r = body.getBoundingClientRect();
    var x = ev.clientX - r.left + 14, y = ev.clientY - r.top + 14;
    if (x + tip.offsetWidth > r.width - 4)  x = ev.clientX - r.left - tip.offsetWidth - 14;
    if (y + tip.offsetHeight > r.height - 4) y = ev.clientY - r.top - tip.offsetHeight - 14;
    tip.style.left = Math.max(4, x) + 'px';
    tip.style.top  = Math.max(4, y) + 'px';
}

/**
 * Chart des Tickers öffnen — in einem Basket der gewählten Quelle, der ihn enthält,
 * damit er dort markiert in der Kursliste steht: im aktiven, wenn der dazugehört,
 * sonst im ersten nach Namen. Bei „Alle Screener-Baskets" also in seinem
 * Screener-Basket, auch wenn er zusätzlich im aktiven Depot-Basket steht.
 * Ticker, die nur in der Datenbank liegen, öffnen im aktiven Basket.
 */
async function heatmapOeffnen(sym) {
    var q = _HM.prefs.quelle;
    var erlaubt = (q === 'alle' || q === 'db' || _hmIndex()) ? Object.keys(baskets) : _hmBasketIds();
    var mit = _hmBasketsMit(sym).filter(function(id) { return erlaubt.indexOf(id) >= 0; });
    var ziel = mit.indexOf(currentBasket) >= 0 ? null : (mit[0] || null);
    logIt(4, 'Heatmap', sym + ' im Chart öffnen' + (ziel && ziel !== currentBasket ? ' (Basket ' + (baskets[ziel].name || ziel) + ')' : ''));
    location.hash = '#/charts';
    if (ziel && ziel !== currentBasket) await switchBasket(ziel);
    if (currentView !== sym) switchView(sym);
}

function _hmEreignisse() {
    var map = document.getElementById('hm-map'), liste = document.getElementById('hm-liste');
    var tip = document.getElementById('hm-tip');
    if (map && !map._hmEvents) {
        map._hmEvents = true;
        map.addEventListener('mousemove', function(ev) {
            var el = ev.target.closest && ev.target.closest('.hm-tile');
            var it = el ? _HM.kacheln[+el.getAttribute('data-i')] : null;
            if (it) _hmTooltip(it.e, it.veraltet, ev); else if (tip) tip.style.display = 'none';
        });
        map.addEventListener('mouseleave', function() { if (tip) tip.style.display = 'none'; });
        map.addEventListener('click', function(ev) {
            var el = ev.target.closest && ev.target.closest('.hm-tile');
            var it = el ? _HM.kacheln[+el.getAttribute('data-i')] : null;
            if (it) { if (tip) tip.style.display = 'none'; heatmapOeffnen(it.e.t); }
        });
    }
    if (liste && !liste._hmEvents) {
        liste._hmEvents = true;
        liste.addEventListener('click', function(ev) {
            var tr = ev.target.closest && ev.target.closest('tr[data-t]');
            if (tr) heatmapOeffnen(tr.getAttribute('data-t'));
        });
    }
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _hmEreignisse);
    else _hmEreignisse();
}
