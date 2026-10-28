/* MAYA LIVE TRACKING - Phase 2b: GPS ride tracking plus working History, Garage, Safety and Settings.

   What this file does:
   - switches between the five sections, draws the gauge ticks, shows the map
   - asks for location ONLY after you tap Start ride (never on page load)
   - tracks the ride with navigator.geolocation.watchPosition()
   - shows GPS speed, estimated distance and elapsed time
   - History: lists finished rides while the page stays open (NOT saved: a refresh erases them)
   - Garage: shows the bike details and this page visit's ride totals
   - Safety: emergency contacts, saved in this browser's localStorage on this phone only
   - Settings: units (metric or imperial) and "keep screen on", saved in localStorage

   It does NOT use Firebase, logins, cloud storage, external APIs or live sharing.
   The only things stored are your settings and emergency contacts, on this phone, in this
   browser. Ride history is never stored.

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
      the speed shows "--". Distance and time keep their last values.
   9. A ride is added to History only if at least one accurate position was recorded.
      Average speed includes stops, and is shown only for rides of 100 m and 30 seconds or more. */
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
  var KM_TO_MI = 0.621371;
  var MAX_CONTACTS = 3;
  var MAX_RIDES = 50;
  var STORE_SETTINGS = "mayaTracker.settings";
  var STORE_CONTACTS = "mayaTracker.contacts";
  var GEO_OPTIONS = { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 };

  var HINT_IDLE = "Tap Start ride. Your phone will ask for permission to use your location.";
  var HINT_RIDING = "Ride in progress. Keep this page open and the screen on, because phones may pause GPS when the screen locks.";

  var VIEWS = ["ride", "history", "garage", "safety", "settings"];
  var navButtons = document.querySelectorAll("[data-view]");
  var map = null;

  /* ---------- Saved preferences and in-memory lists ---------- */
  var settings = { units: "metric", wakeLock: true };
  var contacts = [];
  var rides = [];              /* finished rides; kept in memory only */

  /* ---------- Ride state ---------- */
  var state = "idle";          /* "idle" or "riding" */
  var watchId = null;
  var timerId = null;
  var rideStartMs = 0;
  var distanceM = 0;
  var topSpeedKmh = null;
  var lastSpeedKmh = null;
  var anchor = null;           /* last accepted reference reading */
  var outliers = 0;
  var lastFixAt = 0;           /* when the last usable reading arrived */
  var hasMarker = false;
  var marker = null;
  var accuracyCircle = null;
  var lastPan = null;
  var gpsKey = "";
  var wakeLock = null;
  var wakeLockPending = false;
  var supported = ("geolocation" in navigator);

  /* ---------- Page elements ---------- */
  var speedEl = document.getElementById("speed");
  var speedNum = speedEl ? speedEl.querySelector(".speed-num") : null;
  var speedUnitEl = speedEl ? speedEl.querySelector(".speed-unit") : null;
  var speedNote = document.querySelector(".speed-note");
  var chips = document.querySelectorAll(".chips .chip");
  var gpsChip = chips[0] || null;
  var readoutNums = document.querySelectorAll(".readouts .num");
  var distNum = readoutNums[0] || null;
  var timeNum = readoutNums[1] || null;
  var distUnitEl = document.querySelector(".readouts .unit");
  var startBtn = document.querySelector(".btn.start");
  var endBtn = document.querySelector(".btn.end");
  var hintEl = document.getElementById("ctl-hint");
  var previewNote = document.querySelector(".preview-note");
  var overlay = document.querySelector(".map-overlay");
  var overlayTitle = document.querySelector(".overlay-title");
  var overlayText = document.querySelector(".overlay-text");

  var histCount = document.getElementById("hist-count");
  var histDist = document.getElementById("hist-dist");
  var histTime = document.getElementById("hist-time");
  var histEmpty = document.getElementById("hist-empty");
  var rideList = document.getElementById("ride-list");
  var histClear = document.getElementById("hist-clear");
  var garageSession = document.getElementById("garage-session");
  var contactList = document.getElementById("contact-list");
  var contactEmpty = document.getElementById("contact-empty");
  var contactForm = document.getElementById("contact-form");
  var contactName = document.getElementById("contact-name");
  var contactPhone = document.getElementById("contact-phone");
  var contactAdd = document.getElementById("contact-add");
  var contactMsg = document.getElementById("contact-msg");
  var setMetric = document.getElementById("set-metric");
  var setImperial = document.getElementById("set-imperial");
  var setAwake = document.getElementById("set-awake");
  var awakeNote = document.getElementById("awake-note");
  var setReset = document.getElementById("set-reset");
  var setErase = document.getElementById("set-erase");
  var settingsMsg = document.getElementById("settings-msg");

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

  function make(tag, className, text) {
    var e = document.createElement(tag);
    if (className) { e.className = className; }
    if (text !== undefined) { e.textContent = text; }
    return e;
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

  /* ---------- Browser storage (settings and contacts only) ---------- */
  function readStore(key) {
    try {
      var raw = window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function writeStore(key, value) {
    try { window.localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch (e) { return false; }
  }
  function removeStore(key) {
    try { window.localStorage.removeItem(key); } catch (e) { /* nothing to do */ }
  }

  function loadSettings() {
    var s = readStore(STORE_SETTINGS);
    if (s && (s.units === "metric" || s.units === "imperial")) { settings.units = s.units; }
    if (s && typeof s.wakeLock === "boolean") { settings.wakeLock = s.wakeLock; }
  }

  function loadContacts() {
    var list = readStore(STORE_CONTACTS);
    contacts = [];
    if (Array.isArray(list)) {
      list.forEach(function (c) {
        if (c && typeof c.name === "string" && typeof c.phone === "string" && contacts.length < MAX_CONTACTS) {
          contacts.push({ name: c.name.slice(0, 40), phone: c.phone.slice(0, 20) });
        }
      });
    }
  }

  /* ---------- Units ---------- */
  function isImperial() { return settings.units === "imperial"; }
  function speedUnit() { return isImperial() ? "mph" : "km/h"; }
  function distUnit() { return isImperial() ? "mi" : "km"; }
  function toSpeed(kmh) { return isImperial() ? kmh * KM_TO_MI : kmh; }
  function toDist(m) { return isImperial() ? (m / 1000) * KM_TO_MI : m / 1000; }
  function fmtDist(m) { return toDist(m).toFixed(2); }
  function fmtSpeed(kmh) { return (kmh === null) ? "--" : Math.round(toSpeed(kmh)) + " " + speedUnit(); }

  /* ---------- Screen updates (Ride) ---------- */
  function showSpeed(kmh) {
    lastSpeedKmh = kmh;
    if (speedNum) { speedNum.textContent = (kmh === null) ? "--" : String(Math.round(toSpeed(kmh))); }
    if (speedNote) {
      var sr = speedNote.querySelector(".sr-only");
      if (sr) { sr.textContent = (kmh === null) ? "Speed is not available. " : "Speed from GPS. "; }
    }
  }

  function showDistance() {
    if (distNum) { distNum.textContent = anchor ? fmtDist(distanceM) : "--"; }
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

  /* ---------- Keep the screen on during a ride (optional) ---------- */
  function wantsWakeLock() { return settings.wakeLock && ("wakeLock" in navigator); }

  function requestWakeLock() {
    if (!wantsWakeLock() || state !== "riding" || wakeLock !== null || wakeLockPending) { return; }
    wakeLockPending = true;
    try {
      navigator.wakeLock.request("screen").then(function (sentinel) {
        wakeLockPending = false;
        if (state !== "riding" || !wantsWakeLock()) { sentinel.release(); return; }
        wakeLock = sentinel;
        sentinel.addEventListener("release", function () { if (wakeLock === sentinel) { wakeLock = null; } });
      }).catch(function () { wakeLockPending = false; });
    } catch (e) { wakeLockPending = false; }
  }

  function releaseWakeLock() {
    if (wakeLock) {
      try { wakeLock.release(); } catch (e) { /* already released */ }
      wakeLock = null;
    }
  }

  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) { requestWakeLock(); }   /* the browser drops it when the page is hidden */
  });

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

    var speed = good ? readSpeedKmh(c) : null;
    showSpeed(speed);
    if (speed !== null && speed <= MAX_SPEED_MS * 3.6 && (topSpeedKmh === null || speed > topSpeedKmh)) {
      topSpeedKmh = speed;
    }

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
    releaseWakeLock();
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
    topSpeedKmh = null;
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
      requestWakeLock();
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
    var endMs = Date.now();
    var elapsed = endMs - rideStartMs;
    var hadData = (anchor !== null);
    stopTracking();
    state = "idle";
    showTime(elapsed);
    showDistance();
    showSpeed(null);
    removeMarker();
    setGpsStatus("off", "GPS not connected");
    setOverlay(true, "Ride ended", "Tap Start ride to begin a new ride.");
    if (hadData) {
      addRideRecord(endMs, elapsed);
      setHint("Ride ended. About " + fmtDist(distanceM) + " " + distUnit() + " in " + formatTime(elapsed) +
        " (GPS estimate). See it in History until you refresh the page.");
    } else {
      setHint("Ride ended. No accurate GPS position was recorded, so it was not added to History.");
    }
    updateButtons();
  }

  if (startBtn) { startBtn.addEventListener("click", startRide); }
  if (endBtn) { endBtn.addEventListener("click", endRide); }

  /* ---------- History and Garage ---------- */
  function addRideRecord(endMs, durationMs) {
    var avg = (distanceM >= 100 && durationMs >= 30000) ? (distanceM / (durationMs / 1000)) * 3.6 : null;
    rides.unshift({
      startMs: rideStartMs, endMs: endMs, durationMs: durationMs,
      distanceM: distanceM, topKmh: topSpeedKmh, avgKmh: avg
    });
    if (rides.length > MAX_RIDES) { rides.length = MAX_RIDES; }
    renderHistory();
    renderGarage();
  }

  function fmtWhen(ms, long) {
    try {
      return new Date(ms).toLocaleString(undefined, long
        ? { dateStyle: "medium", timeStyle: "short" }
        : { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
    } catch (e) { return new Date(ms).toString(); }
  }

  function detailItem(label, value) {
    var d = make("div");
    d.appendChild(make("dt", "", label));
    d.appendChild(make("dd", "", value));
    return d;
  }

  function renderHistory() {
    if (!rideList) { return; }
    while (rideList.firstChild) { rideList.removeChild(rideList.firstChild); }
    var totalM = 0, totalMs = 0;

    rides.forEach(function (r) {
      totalM += r.distanceM;
      totalMs += r.durationMs;

      var li = make("li");
      var details = make("details");
      var summary = make("summary");
      summary.appendChild(make("span", "ride-when", fmtWhen(r.startMs, false)));
      summary.appendChild(make("span", "ride-sum", fmtDist(r.distanceM) + " " + distUnit() + ", " + formatTime(r.durationMs)));
      details.appendChild(summary);

      var grid = make("dl", "ride-facts");
      grid.appendChild(detailItem("Started", fmtWhen(r.startMs, true)));
      grid.appendChild(detailItem("Ended", fmtWhen(r.endMs, true)));
      grid.appendChild(detailItem("Ride time", formatTime(r.durationMs)));
      grid.appendChild(detailItem("Distance", fmtDist(r.distanceM) + " " + distUnit()));
      grid.appendChild(detailItem("Average speed", fmtSpeed(r.avgKmh)));
      grid.appendChild(detailItem("Top GPS speed", fmtSpeed(r.topKmh)));
      details.appendChild(grid);
      details.appendChild(make("p", "ride-foot",
        "Distance and speeds are GPS estimates. Average speed includes stops. This ride is erased when you refresh the page."));

      li.appendChild(details);
      rideList.appendChild(li);
    });

    if (histCount) { histCount.textContent = String(rides.length); }
    if (histDist) { histDist.textContent = fmtDist(totalM); }
    if (histTime) { histTime.textContent = formatTime(totalMs); }
    if (histEmpty) { histEmpty.hidden = rides.length > 0; }
    if (histClear) { histClear.hidden = rides.length === 0; }
  }

  function renderGarage() {
    if (!garageSession) { return; }
    if (rides.length === 0) {
      garageSession.textContent = "No rides finished yet";
      return;
    }
    var totalM = 0;
    rides.forEach(function (r) { totalM += r.distanceM; });
    garageSession.textContent = rides.length + (rides.length === 1 ? " ride, " : " rides, ") +
      fmtDist(totalM) + " " + distUnit() + " (GPS estimate)";
  }

  if (histClear) {
    histClear.addEventListener("click", function () {
      rides = [];
      renderHistory();
      renderGarage();
    });
  }

  /* ---------- Safety: emergency contacts ---------- */
  function setContactMsg(text) { if (contactMsg) { contactMsg.textContent = text || ""; } }

  function cleanPhone(raw) {
    var plus = /^\s*\+/.test(raw);
    return (plus ? "+" : "") + raw.replace(/\D/g, "");
  }

  function renderContacts() {
    if (!contactList) { return; }
    while (contactList.firstChild) { contactList.removeChild(contactList.firstChild); }

    contacts.forEach(function (c, i) {
      var li = make("li");
      var info = make("div", "contact-info");
      info.appendChild(make("div", "contact-name", c.name));
      info.appendChild(make("div", "contact-phone", c.phone));
      li.appendChild(info);

      var call = make("a", "mini call", "Call");
      call.href = "tel:" + cleanPhone(c.phone);
      call.setAttribute("aria-label", "Call " + c.name);
      li.appendChild(call);

      var remove = make("button", "mini", "Remove");
      remove.type = "button";
      remove.setAttribute("aria-label", "Remove " + c.name);
      remove.addEventListener("click", function () { removeContact(i); });
      li.appendChild(remove);

      contactList.appendChild(li);
    });

    if (contactEmpty) { contactEmpty.hidden = contacts.length > 0; }
    if (contactAdd) { contactAdd.disabled = contacts.length >= MAX_CONTACTS; }
  }

  function addContact() {
    var name = contactName ? contactName.value.trim() : "";
    var phone = contactPhone ? contactPhone.value.trim() : "";
    var digits = phone.replace(/\D/g, "").length;

    if (contacts.length >= MAX_CONTACTS) { setContactMsg("You can save up to " + MAX_CONTACTS + " contacts. Remove one first."); return; }
    if (name === "") { setContactMsg("Please enter a name."); return; }
    if (!/^[\d\s+\-().]+$/.test(phone) || digits < 5 || digits > 15) {
      setContactMsg("Please enter a valid phone number, for example +91 98765 43210.");
      return;
    }

    contacts.push({ name: name.slice(0, 40), phone: phone.slice(0, 20) });
    var saved = writeStore(STORE_CONTACTS, contacts);
    if (contactName) { contactName.value = ""; }
    if (contactPhone) { contactPhone.value = ""; }
    renderContacts();
    setContactMsg(saved
      ? "Saved on this phone."
      : "Could not save on this phone (private browsing can block this). It will be lost when you refresh.");
  }

  function removeContact(index) {
    contacts.splice(index, 1);
    if (contacts.length === 0) { removeStore(STORE_CONTACTS); } else { writeStore(STORE_CONTACTS, contacts); }
    renderContacts();
    setContactMsg("Contact removed.");
  }

  if (contactForm) {
    contactForm.addEventListener("submit", function (ev) { ev.preventDefault(); addContact(); });
  }

  /* ---------- Settings ---------- */
  function setSettingsMsg(text) { if (settingsMsg) { settingsMsg.textContent = text || ""; } }

  function syncSettingsControls() {
    if (setMetric) { setMetric.checked = !isImperial(); }
    if (setImperial) { setImperial.checked = isImperial(); }
    if (setAwake) { setAwake.checked = settings.wakeLock; }
  }

  function applyUnits() {
    if (speedUnitEl) { speedUnitEl.textContent = speedUnit(); }
    if (distUnitEl) { distUnitEl.textContent = distUnit(); }
    Array.prototype.forEach.call(document.querySelectorAll(".js-dist-unit"), function (e) { e.textContent = distUnit(); });
    buildTicks();
    showSpeed(lastSpeedKmh);
    showDistance();
    renderHistory();
    renderGarage();
  }

  function saveSettings() {
    return writeStore(STORE_SETTINGS, settings);
  }

  function onUnitsChange() {
    settings.units = (setImperial && setImperial.checked) ? "imperial" : "metric";
    var ok = saveSettings();
    applyUnits();
    setSettingsMsg(ok ? "Saved on this phone." : "Could not save on this phone. This will reset when you refresh.");
  }

  if (setMetric) { setMetric.addEventListener("change", onUnitsChange); }
  if (setImperial) { setImperial.addEventListener("change", onUnitsChange); }

  if (setAwake) {
    setAwake.addEventListener("change", function () {
      settings.wakeLock = setAwake.checked;
      var ok = saveSettings();
      if (state === "riding") {
        if (settings.wakeLock) { requestWakeLock(); } else { releaseWakeLock(); }
      }
      setSettingsMsg(ok ? "Saved on this phone." : "Could not save on this phone. This will reset when you refresh.");
    });
  }

  if (setReset) {
    setReset.addEventListener("click", function () {
      settings = { units: "metric", wakeLock: true };
      removeStore(STORE_SETTINGS);
      syncSettingsControls();
      applyUnits();
      if (state === "riding") { requestWakeLock(); }
      setSettingsMsg("Settings reset.");
    });
  }

  if (setErase) {
    setErase.addEventListener("click", function () {
      if (!window.confirm("Erase your saved settings and emergency contacts from this phone?")) { return; }
      removeStore(STORE_SETTINGS);
      removeStore(STORE_CONTACTS);
      settings = { units: "metric", wakeLock: true };
      contacts = [];
      syncSettingsControls();
      applyUnits();
      renderContacts();
      if (state === "riding") { requestWakeLock(); }
      setSettingsMsg("Saved settings and emergency contacts were erased.");
      setContactMsg("");
    });
  }

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

  /* ---------- Gauge tick marks (Phase 1 look; the scale follows your units) ---------- */
  function buildTicks() {
    var group = document.getElementById("ticks");
    if (!group) { return; }
    while (group.firstChild) { group.removeChild(group.firstChild); }

    var NS = "http://www.w3.org/2000/svg";
    var cx = 150, cy = 150, outer = 104;
    var MAX = isImperial() ? 100 : 160;          /* top of the scale */
    var STEP = isImperial() ? 5 : 10;            /* small tick every STEP */
    var MAJOR = isImperial() ? 10 : 20;          /* long gold tick every MAJOR */
    var LABEL = isImperial() ? 20 : 40;          /* number every LABEL */

    for (var v = 0; v <= MAX; v += STEP) {
      var major = (v % MAJOR === 0);
      var angle = (135 + (v / MAX) * 270) * Math.PI / 180;
      var len = major ? 12 : 6;
      var delay = Math.round((v / MAX) * 160 * 3) + "ms";
      var line = document.createElementNS(NS, "line");
      line.setAttribute("x1", (cx + Math.cos(angle) * outer).toFixed(2));
      line.setAttribute("y1", (cy + Math.sin(angle) * outer).toFixed(2));
      line.setAttribute("x2", (cx + Math.cos(angle) * (outer - len)).toFixed(2));
      line.setAttribute("y2", (cy + Math.sin(angle) * (outer - len)).toFixed(2));
      line.setAttribute("stroke", major ? "#C9A44C" : "#4a4a4a");
      line.setAttribute("stroke-width", major ? "2" : "1.5");
      line.setAttribute("stroke-linecap", "round");
      line.setAttribute("class", "tick");
      line.style.animationDelay = delay;
      group.appendChild(line);

      if (v % LABEL === 0) {
        var label = document.createElementNS(NS, "text");
        label.setAttribute("x", (cx + Math.cos(angle) * 84).toFixed(2));
        label.setAttribute("y", (cy + Math.sin(angle) * 84 + 4).toFixed(2));
        label.setAttribute("text-anchor", "middle");
        label.setAttribute("fill", "#9a9a9a");
        label.setAttribute("font-size", "12");
        label.setAttribute("class", "tick");
        label.style.animationDelay = delay;
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
  loadSettings();
  loadContacts();
  syncSettingsControls();

  if (hintEl) { hintEl.setAttribute("aria-live", "polite"); }
  if (previewNote) { previewNote.textContent = "Live GPS ride tracking. Figures are estimates and are not saved after you refresh."; }
  if (setAwake && !("wakeLock" in navigator)) {
    setAwake.disabled = true;
    if (awakeNote) { awakeNote.textContent = "This browser cannot keep the screen on. Keep it awake yourself while riding."; }
  }

  buildMap();
  applyUnits();
  renderContacts();
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
