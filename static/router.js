/**
 * router.js — Seiten-Navigation (SPA)
 * ====================================
 * Lädt NACH shared.js + desktop.js.
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │  NEUE SEITE HINZUFÜGEN = 2 HANDGRIFFE:                               │
 * │  1. In desktop.html:  <section id="view-XXX" class="page">…</section>│
 * │  2. Hier in PAGES:    { id: 'XXX', label: '…', icon: '…' }           │
 * │  → Nav-Button + Routing (#/XXX) entstehen automatisch.              │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * onShow(): optionaler Hook, läuft jedes Mal beim Anzeigen der Seite.
 *   Wichtig für den Chart: in versteckter Sektion kann er seine Größe
 *   nicht messen → beim Zurückwechseln fitChart() aufrufen.
 */

'use strict';

var PAGES = [
    {
        id: 'charts', label: 'Charts', icon: '📈',
        onShow: function () { if (typeof fitChart === 'function') fitChart(); }
    },
    {
        id: 'ibkr', label: 'IBKR', icon: '📋',
        // Neu rendern, damit der Depotwert die aktuellsten Live-Kurse nutzt
        onShow: function () { if (typeof ibkrRenderTable === 'function') ibkrRenderTable(); }
    },
    {
        id: 'konten', label: 'Konten', icon: '🏦',
        // Lädt Konten, Vermögensübersicht und Verlauf; schreibt den Tagesstand fort
        onShow: function () { if (typeof kontenLoad === 'function') kontenLoad(); }
    },
    {
        id: 'steuer4', label: 'IBKR Steuer Report', icon: '🏛️',
        // Gespeicherte XMLs beim Öffnen automatisch auswerten (einmal/Session)
        onShow: function () { if (typeof taxStoreInit === 'function') taxStoreInit(); }
    },
    {
        id: 'screener', label: 'Screener', icon: '🔍',
        onShow: function () { if (typeof screenerInit === 'function') screenerInit(); }
    },
    {
        id: 'settings', label: 'Einstellungen', icon: '⚙',
        onShow: function () { if (typeof settingsLoad === 'function') settingsLoad(); }
    },
    {
        id: 'log', label: 'Protokoll', icon: '🧾',
        // renderLog() überspringt versteckte Seiten — beim Öffnen einmal nachziehen
        onShow: function () { if (typeof renderLog === 'function') renderLog(true); }
    },
    {
        id: 'hilfe', label: 'Hilfe', icon: '❓',
        // Verzeichnis wird beim ersten Öffnen aus den Karten gebaut
        onShow: function () { if (typeof helpInit === 'function') helpInit(); }
    }
];

function _routerBuildNav() {
    var nav = document.getElementById('main-nav');
    if (!nav) return;
    nav.innerHTML = '';
    PAGES.forEach(function (p) {
        var a = document.createElement('a');
        a.href = '#/' + p.id;
        a.id = 'nav-' + p.id;
        a.className = 'nav-tab';
        a.textContent = (p.icon ? p.icon + ' ' : '') + p.label;
        nav.appendChild(a);
    });
}

function _routerShow(id) {
    var page = null;
    for (var i = 0; i < PAGES.length; i++) {
        if (PAGES[i].id === id) { page = PAGES[i]; break; }
    }
    if (!page) page = PAGES[0];

    PAGES.forEach(function (p) {
        var on  = (p.id === page.id);
        var sec = document.getElementById('view-' + p.id);
        var nav = document.getElementById('nav-'  + p.id);
        if (sec) sec.classList.toggle('active', on);
        if (nav) nav.classList.toggle('active', on);
    });

    if (page.onShow) {
        try { page.onShow(); }
        catch (e) { console.error('onShow ' + page.id + ' fehlgeschlagen:', e); }
    }
}

function _routerRoute() {
    var id = (location.hash || '').replace(/^#\/?/, '') || PAGES[0].id;
    _routerShow(id);
}

function initRouter() {
    _routerBuildNav();
    window.addEventListener('hashchange', _routerRoute);
    _routerRoute();
}

// desktop.js startup() läuft synchron vor diesem Script (Reihenfolge im HTML).
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initRouter);
} else {
    initRouter();
}
