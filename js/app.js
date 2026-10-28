/* MAYA LIVE TRACKING - Phase 2: live GPS ride tracking.

   What this file does:
   - switches between the five sections, draws the gauge ticks, shows the map (as in Phase 1)
   - asks for location ONLY after you tap Start ride (never on page load)
   - tracks the ride with navigator.geolocation.watchPosition()
   - shows GPS speed, estimated distance and elapsed time
   - stops everything cleanly when you tap End ride

   It does NOT use Firebase, logins, cloud storage, external APIs or live sharing.
   Nothing is saved anywhere: ride numbers disappear when you start a new ride or reload.

   FILTERING ASSUMPTIONS (all distances are estimates, not odometer readings):
   1. A reading is ignored if its coordinates or accuracy are missing or impossible.
   2. A reading whose accuracy is worse than 50 m is "weak". It is not used for
      distance, and its speed is not shown (the speed shows "--").
   3. A reading worse than 200 m is not drawn on the map at all.
   4. Distance only counts when you have moved further than the GPS error margin
      (the average accuracy of the two readings, and never less than 5 m). Smaller
      movements are treated as GPS drift and ignored. The reference point stays put,
      so slow real movement still adds up once it passes the threshold.
   5. If the phone reports a speed below 0.5 m/s (about 1.8 km/h), you are treated as
      stationary and no distance is added.
   6. A jump faster than 70 m/s (252 km/h), or more than 200 m in under 3 seconds,
      is treated as a GPS glitch and ignored. After 3 glitches in a row the new position
      is accepted as the new reference point (no distance added), so one real gap, such as
      a tunnel, cannot block tracking for good.
   7. Readings that are not newer than the reference reading are ignored.
   8. If no reading arrives for 10 seconds, the screen says the GPS signal is lost and
      the speed shows "--". Distance and time keep their last values. */
(function () {
  "use strict";

  /* ---------- Settings ---------- */
  var MAX_ACCURACY_M = 50;
  var MAX_DISPLAY_ACCURACY_M = 200;
  var MAX_SPEED_MS = 70;
  var MAX_JUMP_M = 200;
  var MAX_JUMP_SECONDS = 3;
  var OUTLIERS_BEFORE_RESET = 3;
  var MIN_MOVE_M = 5;
  var STATIONARY_MS = 0.5;
  var STALE_AFTER_MS = 10000;
  var EARTH_RADIUS_M = 6371000;
  var GEO_OPTIONS = { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 };

  var HINT_IDLE = "Tap Start ride. Your phone will ask for permission to use your location.";
  var HINT_RIDING = "Ride in progress. Keep this page open and the screen on, because phones may pause GPS when the screen locks.";

  var VIEWS = ["ride", "history", "garage", "safety", "settings"];
  var navButtons = document.querySelectorAll("[data-view]");
  var map = null;

  /* ---------- Ride state ---------- */
  var state = "idle";          /* "idle" or "riding" */
  var watchId = null;
  var timerId = null;
  var rideStartMs = 0;
  var distanceM = 0;
  var anchor = null;           /* last accepted reference reading */
  var outliers = 0;
  var lastFixAt = 0;           /* when the last usable reading arrived */
  var hasMarker = false;
  var marker = null;
  var accuracyCircle = null;
  var lastPan = null;
  var gpsKey = "";
  var supported = ("geolocation" in navigator);

  /* ---------- Page elements ---------- */
  var speedEl = document.getElementById("speed");
  var speedNum = speedEl ? speedEl.querySelector(".speed-num") : null;
  var speedNote = document.querySelector(".speed-note");
  var chips = document.querySelectorAll(".chips .chip");
  var gpsChip = chips[0] || null;
  var readoutNums = document.querySelectorAll(".readouts .num");
  var distNum = readoutNums[0] || null;
  var timeNum = readoutNums[1] || null;
  var startBtn = document.querySelector(".btn.start");
  var endBtn = document.querySelector(".btn.end");
  var hintEl = document.getElementById("ctl-hint");
  var overlay = document.querySelector(".map-overlay");
  var overlayTitle = document.querySelector(".overlay-title");
  var overlayText = document.querySelector(".overlay-text");

  /* ---------- Small helpers ---------- */
  function setText(el, text) {
    /* Replace the plain text inside an element but keep child elements (like the dot). */
    if (!el) { return; }
    var nodes = el.childNodes;
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].nodeType === 3 && nodes[i].nodeValue.trim() !== "") {
        nodes[i].nodeValue = text;
        return;
      }
    }
    el.appendChild(document.createTextNode(text));
  }

  function pad(n) { return (n < 10 ? "0" : "") + n; }

  function formatTime(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    return pad(Math.floor(s / 3600)) + ":" + pad(Math.floor((s % 3600) / 60)) + ":" + pad(s % 60);
  }

  function haversine(lat1, lng1, lat2, lng2) {
    var rad = Math.PI / 180;
    var dLat = (lat2 - lat1) * rad;
    var dLng = (lng2 - lng1) * rad;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  /* ---------- Screen updates ---------- */
  function showSpeed(kmh) {
    if (speedNum) { speedNum.textContent = (kmh === null) ? "--" : String(Math.round(kmh)); }
    if (speedNote) {
      var sr = speedNote.querySelector(".sr-only");
      if (sr) { sr.textContent = (kmh === null) ? "Speed is not available. " : "Speed from GPS. "; }
    }
  }

  function showDistance() {
    if (distNum) { distNum.textContent = anchor ? (distanceM / 1000).toFixed(2) : "--"; }
  }

  function showTime(ms) {
    if (timeNum) { timeNum.textContent = (ms === null) ? "--:--:--" : formatTime(ms); }
  }

  function setHint(text) { setText(hintEl, text); }

  function setOverlay(visible, title, text) {
    if (!overlay) { return; }
    overlay.hidden = !visible;
    if (visible) {
      if (overlayTitle) { overlayTitle.textContent = title; }
      if (overlayText) { overlayText.textContent = text; }
    }
  }

  function setGpsStatus(key, text) {
    /* key: off, waiting, live, weak, lost */
    if (key === gpsKey && gpsChip && gpsChip.getAttribute("data-text") === text) { return; }
    gpsKey = key;
    if (gpsChip) {
      setText(gpsChip, text);
      gpsChip.setAttribute("data-text", text);
      var dot = gpsChip.querySelector(".dot");
      if (dot) {
        if (key === "live") {
          dot.style.background = "#E4C56A";
          dot.style.boxShadow = "0 0 8px rgba(228,197,106,.6)";
        } else if (key === "waiting" || key === "weak" || key === "lost") {
          dot.style.background = "transparent";
          dot.style.boxShadow = "inset 0 0 0 2px #C9A44C";
        } else {
          dot.style.background = "";
          dot.style.boxShadow = "";
        }
      }
    }
    if (speedNote) { setText(speedNote, key === "live" ? "GPS live" : text.split(",")[0]); }
  }

  function updateButtons() {
    if (startBtn) { startBtn.disabled = (state !== "idle") || !supported; }
    if (endBtn) { endBtn.disabled = (state !== "riding"); }
  }

  function removeMarker() {
    if (map && marker) { map.removeLayer(marker); }
    if (map && accuracyCircle) { map.removeLayer(accuracyCircle); }
    marker = null;
    accuracyCircle = null;
    hasMarker = false;
    lastPan = null;
  }

  function updateMarker(lat, lng, acc) {
    if (!map || !window.L) { return; }
    var ll = [lat, lng];
    if (!marker) {
      accuracyCircle = L.circle(ll, {
        radius: acc, color: "#C9A44C", weight: 1, fillColor: "#C9A44C", fillOpacity: 0.08, interactive: false
      }).addTo(map);
      marker = L.circleMarker(ll, {
        radius: 9, color: "#080909", weight: 3, fillColor: "#E4C56A", fillOpacity: 1, interactive: false
      }).addTo(map);
      map.setView(ll, 16);
      lastPan = ll;
    } else {
      marker.setLatLng(ll);
      accuracyCircle.setLatLng(ll);
      accuracyCircle.setRadius(acc);
      /* Only re-centre when you have moved a little, so the map does not jitter. */
      if (!lastPan || haversine(lastPan[0], lastPan[1], lat, lng) >= 5) {
        map.panTo(ll, { animate: true, duration: 0.5 });
        lastPan = ll;
      }
    }
    hasMarker = true;
  }

  /* ---------- Location readings ---------- */
  function readSpeedKmh(coords) {
    var s = coords.speed;
    if (typeof s === "number" && isFinite(s) && s >= 0) { return s * 3.6; }
    return null;   /* unavailable: never invent a speed */
  }

  function onPosition(pos) {
    if (state !== "riding") { return; }   /* a late reading after End ride */
    var c = pos.coords;
    var lat = c.latitude, lng = c.longitude, acc = c.accuracy;
    if (typeof lat !== "number" || typeof lng !== "number" || typeof acc !== "number" ||
        !isFinite(lat) || !isFinite(lng) || !isFinite(acc) ||
        Math.abs(lat) > 90 || Math.abs(lng) > 180 || acc < 0) { return; }

    var now = Date.now();
    var t = (typeof pos.timestamp === "number" && pos.timestamp > 0) ? pos.timestamp : now;
    var good = acc <= MAX_ACCURACY_M;
    lastFixAt = now;

    if (good) {
      setGpsStatus("live", "GPS live, accurate to " + Math.round(acc) + " m");
    } else {
      setGpsStatus("weak", "GPS weak, accurate to only " + Math.round(acc) + " m");
    }
    setHint(HINT_RIDING);

    if (acc <= MAX_DISPLAY_ACCURACY_M) {
      updateMarker(lat, lng, acc);
      setOverlay(false);
    } else if (!hasMarker) {
      setOverlay(true, "GPS signal is weak",
        "Your position is too uncertain to show (about " + Math.round(acc) + " m). Move to an open area.");
    }

    showSpeed(good ? readSpeedKmh(c) : null);

    if (!good) { return; }

    if (!anchor) {
      anchor = { lat: lat, lng: lng, t: t, acc: acc };
      showDistance();
      return;
    }

    var dt = (t - anchor.t) / 1000;
    if (dt <= 0) { return; }
    var d = haversine(anchor.lat, anchor.lng, lat, lng);

    if (d / dt > MAX_SPEED_MS || (dt < MAX_JUMP_SECONDS && d > MAX_JUMP_M)) {
      outliers++;
      if (outliers >= OUTLIERS_BEFORE_RESET) {
        anchor = { lat: lat, lng: lng, t: t, acc: acc };
        outliers = 0;
      }
      return;
    }
    outliers = 0;

    var threshold = Math.max(MIN_MOVE_M, (acc + anchor.acc) / 2);
    var reported = c.speed;
    var stationary = (typeof reported === "number" && isFinite(reported) && reported < STATIONARY_MS);
    if (d >= threshold && !stationary) {
      distanceM += d;
      anchor = { lat: lat, lng: lng, t: t, acc: acc };
      showDistance();
    }
  }

  function onError(err) {
    if (state !== "riding") { return; }

    if (err.code === 1) {   /* permission denied */
      var hadData = (anchor !== null);
      var elapsed = Date.now() - rideStartMs;
      stopTracking();
      state = "idle";
      removeMarker();
      showSpeed(null);
      if (hadData) { showTime(elapsed); } else { showDistance(); showTime(null); }
      setGpsStatus("off", "GPS not connected");
      setOverlay(true, "Location is blocked",
        "Allow location for this site in your browser settings, then tap Start ride again.");
      setHint("Location access was blocked, so the ride was stopped. Allow location for this site in your browser settings, then tap Start ride again.");
      updateButtons();
      return;
    }

    var msg;
    if (err.code === 3) {
      msg = "GPS is taking too long to respond. Keep trying outdoors with a clear view of the sky.";
    } else {
      msg = "Your phone cannot find a GPS position. Move to an open area and check that location services are on.";
    }
    showSpeed(null);
    setHint(msg);
    if (lastFixAt > 0) {
      setGpsStatus("lost", "GPS signal lost");
    } else {
      setGpsStatus("waiting", "Waiting for GPS");
      if (!hasMarker) { setOverlay(true, "Still waiting for GPS", msg); }
    }
  }

  /* ---------- Ride control ---------- */
  function tick() {
    if (state !== "riding") { return; }
    var now = Date.now();
    showTime(now - rideStartMs);
    if (lastFixAt > 0 && now - lastFixAt > STALE_AFTER_MS) {
      showSpeed(null);
      setGpsStatus("lost", "GPS signal lost");
    }
  }

  function stopTracking() {
    if (watchId !== null) {
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
    }
    if (timerId !== null) {
      clearInterval(timerId);
      timerId = null;
    }
  }

  function startRide() {
    if (state !== "idle" || watchId !== null || timerId !== null) { return; }   /* no double starts */

    if (!supported) {
      setHint("This browser cannot share its location, so ride tracking is not available here.");
      return;
    }

    state = "riding";
    rideStartMs = Date.now();
    distanceM = 0;
    anchor = null;
    outliers = 0;
    lastFixAt = 0;
    removeMarker();
    showSpeed(null);
    showDistance();
    showTime(0);
    setGpsStatus("waiting", "Waiting for GPS");
    setOverlay(true, "Waiting for GPS",
      "Allow location access if your phone asks. This can take up to a minute.");
    setHint(HINT_RIDING);
    updateButtons();

    try {
      /* The permission prompt appears here, only after you tapped Start ride. */
      watchId = navigator.geolocation.watchPosition(onPosition, onError, GEO_OPTIONS);
      timerId = setInterval(tick, 1000);
    } catch (e) {
      stopTracking();
      state = "idle";
      setGpsStatus("off", "GPS not connected");
      setOverlay(true, "GPS is not available", "Location only works on secure (https) pages in a supported browser.");
      setHint("Could not start GPS. Location only works on secure (https) pages in a supported browser.");
      showTime(null);
      updateButtons();
    }
  }

  function endRide() {
    if (state !== "riding") { return; }
    var elapsed = Date.now() - rideStartMs;
    var hadData = (anchor !== null);
    stopTracking();
    state = "idle";
    showTime(elapsed);
    showDistance();
    showSpeed(null);
    removeMarker();
    setGpsStatus("off", "GPS not connected");
    setOverlay(true, "Ride ended", "Tap Start ride to begin a new ride.");
    setHint(hadData
      ? "Ride ended. About " + (distanceM / 1000).toFixed(2) + " km in " + formatTime(elapsed) + " (GPS estimate)."
      : "Ride ended. No accurate GPS position was recorded.");
    updateButtons();
  }

  if (startBtn) { startBtn.addEventListener("click", startRide); }
  if (endBtn) { endBtn.addEventListener("click", endRide); }

  /* ---------- Section switching (unchanged from Phase 1) ---------- */
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

  /* ---------- Gauge tick marks (unchanged from Phase 1) ---------- */
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

  /* ---------- Map (initialization unchanged from Phase 1) ---------- */
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

  /* ---------- Start (no location is requested here) ---------- */
  if (hintEl) { hintEl.setAttribute("aria-live", "polite"); }
  buildTicks();
  buildMap();
  showView(window.location.hash.replace("#", ""), false);

  if (!supported) {
    setHint("This browser cannot share its location, so ride tracking is not available here.");
    setOverlay(true, "Location is not available", "Try a current version of Chrome, Safari, Edge or Firefox.");
  } else if (window.isSecureContext === false) {
    setHint("Location only works on secure (https) pages. Open the GitHub Pages link instead of a local file.");
    setOverlay(true, "Secure page needed", "Open this page from its https:// link to use GPS.");
  } else {
    setHint(HINT_IDLE);
    setOverlay(true, "GPS is not connected", "Tap Start ride to show your position here.");
  }
  updateButtons();
})();
