/* MAYA LIVE TRACKING - Phase 1 (design preview).
   This file does three things only:
   1. switches between the five sections,
   2. draws the tick marks on the speed gauge,
   3. shows a map preview.
   It never asks for your location. GPS arrives in Phase 2. */
(function () {
  "use strict";

  var VIEWS = ["ride", "history", "garage", "safety", "settings"];
  var navButtons = document.querySelectorAll("[data-view]");
  var map = null;

  /* ---------- Section switching ---------- */
  function showView(name, moveFocus) {
    if (VIEWS.indexOf(name) === -1) { name = "ride"; }

    VIEWS.forEach(function (v) {
      var section = document.getElementById("view-" + v);
      if (section) { section.hidden = (v !== name); }
    });

    navButtons.forEach(function (btn) {
      if (btn.getAttribute("data-view") === name) {
        btn.setAttribute("aria-current", "page");
      } else {
        btn.removeAttribute("aria-current");
      }
    });

    /* The map cannot measure itself while hidden, so refresh it when Ride returns. */
    if (name === "ride" && map) {
      setTimeout(function () { map.invalidateSize(); }, 0);
    }

    if (moveFocus) {
      var heading = document.getElementById("h-" + name);
      if (heading) { heading.focus({ preventScroll: true }); }
      window.scrollTo(0, 0);
    }
  }

  navButtons.forEach(function (btn) {
    btn.addEventListener("click", function () {
      var name = btn.getAttribute("data-view");
      if (window.location.hash !== "#" + name) {
        window.location.hash = name;   /* hashchange then shows the section */
      } else {
        showView(name, true);
      }
    });
  });

  window.addEventListener("hashchange", function () {
    showView(window.location.hash.replace("#", ""), true);
  });

  /* ---------- Gauge tick marks (decorative) ---------- */
  function buildTicks() {
    var group = document.getElementById("ticks");
    if (!group) { return; }
    var NS = "http://www.w3.org/2000/svg";
    var cx = 150, cy = 150, outer = 104, MAX = 160;

    for (var v = 0; v <= MAX; v += 10) {
      var major = (v % 20 === 0);
      var angle = (135 + (v / MAX) * 270) * Math.PI / 180;
      var len = major ? 12 : 6;
      var line = document.createElementNS(NS, "line");
      line.setAttribute("x1", (cx + Math.cos(angle) * outer).toFixed(2));
      line.setAttribute("y1", (cy + Math.sin(angle) * outer).toFixed(2));
      line.setAttribute("x2", (cx + Math.cos(angle) * (outer - len)).toFixed(2));
      line.setAttribute("y2", (cy + Math.sin(angle) * (outer - len)).toFixed(2));
      line.setAttribute("stroke", major ? "#C9A44C" : "#4a4a4a");
      line.setAttribute("stroke-width", major ? "2" : "1.5");
      line.setAttribute("stroke-linecap", "round");
      line.setAttribute("class", "tick");
      line.style.animationDelay = (v * 3) + "ms";
      group.appendChild(line);

      if (v % 40 === 0) {
        var label = document.createElementNS(NS, "text");
        label.setAttribute("x", (cx + Math.cos(angle) * 84).toFixed(2));
        label.setAttribute("y", (cy + Math.sin(angle) * 84 + 4).toFixed(2));
        label.setAttribute("text-anchor", "middle");
        label.setAttribute("fill", "#9a9a9a");
        label.setAttribute("font-size", "12");
        label.setAttribute("class", "tick");
        label.style.animationDelay = (v * 3) + "ms";
        label.textContent = String(v);
        group.appendChild(label);
      }
    }
  }

  /* ---------- Map preview (no location, no interaction) ---------- */
  function buildMap() {
    var el = document.getElementById("map");
    if (!el || !window.L) { return; }   /* if the map library is blocked, the placeholder still shows */

    map = L.map(el, {
      zoomControl: false,
      dragging: false,
      touchZoom: false,
      scrollWheelZoom: false,
      doubleClickZoom: false,
      boxZoom: false,
      keyboard: false
    }).setView([20, 0], 2);

    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors"
    }).addTo(map);

    window.addEventListener("resize", function () { map.invalidateSize(); });
  }

  /* ---------- Start ---------- */
  buildTicks();
  buildMap();
  showView(window.location.hash.replace("#", ""), false);
})();
