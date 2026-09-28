(function(){
  "use strict";

  var canvas = document.getElementById('globe-canvas');
  var ctx = canvas ? canvas.getContext('2d') : null;
  if (!ctx || typeof d3 === 'undefined') {
    document.getElementById('loading').style.display = 'none';
    document.getElementById('fallback').style.display = 'flex';
    return;
  }

  // ---------- Embedded data ----------
  var BORDERS_GEOJSON = null; // loaded asynchronously at startup, see loadBorders()
  function loadBorders() {
    fetch('borders.geojson.json')
      .then(function(r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function(data) {
        BORDERS_GEOJSON = data;
        redraw();
      })
      .catch(function(err) {
        console.warn('Impossibile caricare borders.geojson.json:', err);
      });
  }
  var EMBEDDED_TLE_LINE1 = "1 37788U 11044A   26269.28502736  .00000669  00000-0  10271-3 0  9996";
  var EMBEDDED_TLE_LINE2 = "2 37788  98.2562 169.2756 0034710 155.5748 325.9277 14.76668736811440";
  var ITALIAN_MONTHS = ['gen','feb','mar','apr','mag','giu','lug','ago','set','ott','nov','dic'];
  var tleMeta = { source: 'embedded', epochDate: null };
  var NORAD_ID = "37788";
  var EARTH_RADIUS_KM = 6371;
  var TLE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // update at least once a day
  var TLE_STORAGE_KEY = "paolomonti37788_tle_v1";
  var TLE_ENDPOINT = "https://celestrak.org/NORAD/elements/gp.php?CATNR=" + NORAD_ID + "&FORMAT=tle";

  // ---------- Projection ----------
  var width = window.innerWidth, height = window.innerHeight;
  var dpr = Math.min(window.devicePixelRatio || 1, 2);

  var projection = d3.geoOrthographic()
    .clipAngle(90)
    .precision(0.4);

  var pathGen = d3.geoPath(projection, ctx);
  var graticule = d3.geoGraticule().step([15, 15]);
  var sphereGeo = { type: "Sphere" };

  function sizeCanvas() {
    width = window.innerWidth; height = window.innerHeight;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var scale = Math.min(width, height) * 0.42;
    projection.scale(scale).translate([width / 2, height / 2]);
  }
  sizeCanvas();

  // ---------- Rotation state (degrees): lambda = yaw, phi = pitch ----------
  var rot = { lambda: 18, phi: -18 };
  projection.rotate([rot.lambda, rot.phi, 0]);

  function centerRotationFor(lat, lon) {
    return { lambda: -lon, phi: -lat };
  }
  function shortestDeltaDeg(current, target) {
    var d = (target - current) % 360;
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    return d;
  }

  // ---------- Follow-satellite mode ----------
  var followSat = false;

  var anim = null;
  function goTo(lat, lon, duration, onDone) {
    var t = centerRotationFor(lat, lon);
    var dLambda = shortestDeltaDeg(rot.lambda, t.lambda);
    anim = {
      startLambda: rot.lambda, startPhi: rot.phi,
      endLambda: rot.lambda + dLambda, endPhi: Math.max(-90, Math.min(90, t.phi)),
      t0: performance.now(), dur: duration || 1400,
      onDone: onDone || null
    };
    requestAnimationFrame(animStep);
  }
  function easeInOutCubic(x) { return x < 0.5 ? 4*x*x*x : 1 - Math.pow(-2*x+2, 3)/2; }
  function animStep() {
    if (!anim) return;
    var t = (performance.now() - anim.t0) / anim.dur;
    var finished = t >= 1;
    if (finished) {
      rot.lambda = anim.endLambda; rot.phi = anim.endPhi;
    } else {
      var e = easeInOutCubic(t);
      rot.lambda = anim.startLambda + (anim.endLambda - anim.startLambda) * e;
      rot.phi = anim.startPhi + (anim.endPhi - anim.startPhi) * e;
    }
    projection.rotate([rot.lambda, rot.phi, 0]);
    redraw();
    if (finished) {
      var cb = anim.onDone;
      anim = null;
      if (cb) cb();
    } else {
      requestAnimationFrame(animStep);
    }
  }

  function nudgeTowardsSatellite() {
    if (!currentSat.valid) return;
    var t = centerRotationFor(currentSat.lat, currentSat.lon);
    rot.lambda += shortestDeltaDeg(rot.lambda, t.lambda);
    rot.phi = Math.max(-90, Math.min(90, t.phi));
    projection.rotate([rot.lambda, rot.phi, 0]);
  }

  // ---------- Satellite propagation ----------
  var satrec = satellite.twoline2satrec(EMBEDDED_TLE_LINE1, EMBEDDED_TLE_LINE2);
  var orbitPeriodMin = (2 * Math.PI) / satrec.no; // minutes
  tleMeta.epochDate = parseTLEEpoch(EMBEDDED_TLE_LINE1);
  updateTLEInfoUI();
  console.info('[Paolo Monti 37788] TLE incorporato in uso, epoca ' + formatEpoch(tleMeta.epochDate) + ':\n' + EMBEDDED_TLE_LINE1 + '\n' + EMBEDDED_TLE_LINE2);
  var currentSat = { lat: 0, lon: 0, altKm: 0, velKmS: 0, valid: false };
  var userLoc = { lat: 0, lon: 0, valid: false };

  function computeAt(date) {
    var pv = satellite.propagate(satrec, date);
    if (!pv || !pv.position) return null;
    var gmst = satellite.gstime(date);
    var geo = satellite.eciToGeodetic(pv.position, gmst);
    return {
      lat: satellite.degreesLat(geo.latitude),
      lon: satellite.degreesLong(geo.longitude),
      altKm: geo.height
    };
  }

  function updateSatellite() {
    var now = new Date();
    var pv = satellite.propagate(satrec, now);
    if (!pv || !pv.position) { currentSat.valid = false; return; }
    var gmst = satellite.gstime(now);
    var geo = satellite.eciToGeodetic(pv.position, gmst);
    var lat = satellite.degreesLat(geo.latitude);
    var lon = satellite.degreesLong(geo.longitude);
    var altKm = geo.height;
    var vel = pv.velocity;
    var speed = vel ? Math.sqrt(vel.x*vel.x + vel.y*vel.y + vel.z*vel.z) : 0;
    currentSat.lat = lat; currentSat.lon = lon; currentSat.altKm = altKm; currentSat.velKmS = speed;
    currentSat.valid = true;

    document.getElementById('info-latlon').textContent = lat.toFixed(1) + '°, ' + lon.toFixed(1) + '°';
    document.getElementById('info-alt').textContent = altKm.toFixed(0) + ' km';
    document.getElementById('info-vel').textContent = speed.toFixed(2) + ' km/s';
  }

  // ---------- Orbit trail ----------
  // "past" = where the satellite has been (trailing behind) = 3/4 orbit, drawn intense/solid.
  // "future" = where it is heading (ahead) = half an orbit, drawn bold/dotted.
  // Each sample is {lon, lat, t} (t = Date) so any point can be tapped to reveal its time.
  var orbitPastCoords = [];
  var orbitFutureCoords = [];
  function rebuildOrbitTrail() {
    var now = new Date();
    var stepMin = Math.max(0.4, orbitPeriodMin / 140);
    orbitPastCoords = [];
    orbitFutureCoords = [];
    var pastMin = orbitPeriodMin * 0.75;
    var futureMin = orbitPeriodMin * 0.5;
    for (var m = -pastMin; m <= 0; m += stepMin) {
      var t = new Date(now.getTime() + m * 60000);
      var p = computeAt(t);
      if (p) orbitPastCoords.push({ lon: p.lon, lat: p.lat, t: t });
    }
    for (var m2 = 0; m2 <= futureMin; m2 += stepMin) {
      var t2 = new Date(now.getTime() + m2 * 60000);
      var f = computeAt(t2);
      if (f) orbitFutureCoords.push({ lon: f.lon, lat: f.lat, t: t2 });
    }
  }

  function toLineString(coords) {
    return { type: 'LineString', coordinates: coords.map(function(c){ return [c.lon, c.lat]; }) };
  }

  function haversineKm(lat1, lon1, lat2, lon2) {
    var R = 6371, toRad = Math.PI / 180;
    var dLat = (lat2 - lat1) * toRad, dLon = (lon2 - lon1) * toRad;
    var a = Math.sin(dLat/2)*Math.sin(dLat/2) +
            Math.cos(lat1*toRad)*Math.cos(lat2*toRad)*Math.sin(dLon/2)*Math.sin(dLon/2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  // Extended future trail shown after centering on the user's own position:
  // walks the ground track orbit by orbit, tracking each orbit's closest approach
  // to that location; keeps extending while each orbit gets closer than the last,
  // and stops right after the first orbit that is worse than its predecessor —
  // i.e. one orbit past the true closest-approach orbit.
  var extendedFutureCoords = [];
  var showExtendedTrail = false;
  function getActiveFutureCoords() {
    return (showExtendedTrail && extendedFutureCoords.length > 1) ? extendedFutureCoords : orbitFutureCoords;
  }
  function computeExtendedFutureTrail(userLat, userLon) {
    var now = new Date();
    var stepMin = Math.max(0.4, orbitPeriodMin / 140);
    var maxOrbits = 20; // safety cap (~1.3 days) — a real close pass should resolve well before this
    var samples = [];
    var prevOrbitMin = Infinity;
    var cutIdx = null;

    for (var k = 0; k < maxOrbits; k++) {
      var segStart = k * orbitPeriodMin;
      var segEnd = (k + 1) * orbitPeriodMin;
      var orbitMin = Infinity;
      for (var m = segStart; m < segEnd; m += stepMin) {
        var t = new Date(now.getTime() + m * 60000);
        var p = computeAt(t);
        if (!p) continue;
        var dist = haversineKm(userLat, userLon, p.lat, p.lon);
        samples.push({ lon: p.lon, lat: p.lat, t: t });
        if (dist < orbitMin) orbitMin = dist;
      }
      if (k > 0 && orbitMin > prevOrbitMin) {
        // this orbit is farther than the previous one: we've passed the closest
        // approach — this whole orbit is already included, so stop here.
        cutIdx = samples.length - 1;
        break;
      }
      prevOrbitMin = orbitMin;
    }
    if (cutIdx === null) cutIdx = samples.length - 1; // cap reached without a reversal; show what we have
    return samples.slice(0, cutIdx + 1);
  }

  // ---------- TLE live refresh (best-effort, at least once/day) ----------
  function parseTLEEpoch(line1) {
    try {
      var yy = parseInt(line1.substring(18, 20), 10);
      var year = yy < 57 ? 2000 + yy : 1900 + yy;
      var dayFrac = parseFloat(line1.substring(20, 32));
      var ms = Date.UTC(year, 0, 1) + (dayFrac - 1) * 86400000;
      return new Date(ms);
    } catch (e) { return null; }
  }
  function formatEpoch(d) {
    if (!d) return '—';
    return d.getUTCDate() + ' ' + ITALIAN_MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
  }
  function updateTLEInfoUI() {
    var el = document.getElementById('info-tle-age');
    if (!el) return;
    var label = formatEpoch(tleMeta.epochDate);
    el.textContent = label + (tleMeta.source === 'live' ? ' · live' : ' · offline');
    el.title = tleMeta.source === 'live'
      ? 'TLE scaricato da CelesTrak in questa sessione'
      : 'TLE incorporato nella pagina (nessun aggiornamento di rete riuscito finora)';
  }

  function loadStoredTLE() {
    try {
      var raw = localStorage.getItem(TLE_STORAGE_KEY);
      if (!raw) return null;
      var obj = JSON.parse(raw);
      if (obj && obj.line1 && obj.line2 && obj.fetchedAt) return obj;
    } catch (e) {}
    return null;
  }
  function storeTLE(line1, line2) {
    try {
      localStorage.setItem(TLE_STORAGE_KEY, JSON.stringify({ line1: line1, line2: line2, fetchedAt: Date.now() }));
    } catch (e) {}
  }
  function applyTLE(line1, line2, source) {
    try {
      var newRec = satellite.twoline2satrec(line1, line2);
      satrec = newRec;
      orbitPeriodMin = (2 * Math.PI) / satrec.no;
      tleMeta.source = source || 'embedded';
      tleMeta.epochDate = parseTLEEpoch(line1);
      updateTLEInfoUI();
      updateSatellite();
      rebuildOrbitTrail();
      redraw();
      console.info('[Paolo Monti 37788] TLE attivo (' + tleMeta.source + '), epoca ' + formatEpoch(tleMeta.epochDate) + ':\n' + line1 + '\n' + line2);
    } catch (e) {
      console.warn('[Paolo Monti 37788] TLE non valido, ignorato:', e.message);
    }
  }
  function fetchFreshTLE() {
    if (!('fetch' in window)) return;
    console.info('[Paolo Monti 37788] tentativo di aggiornamento TLE da ' + TLE_ENDPOINT);
    fetch(TLE_ENDPOINT, { cache: 'no-store' }).then(function(res){
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.text();
    }).then(function(text){
      var lines = text.split('\n').map(function(l){ return l.replace(/\r/g, ''); }).filter(function(l){ return l.trim().length > 0; });
      var l1 = null, l2 = null;
      for (var i = 0; i < lines.length; i++) {
        if (lines[i].charAt(0) === '1' && lines[i].indexOf(NORAD_ID) !== -1) l1 = lines[i];
        if (lines[i].charAt(0) === '2' && lines[i].indexOf(NORAD_ID) !== -1) l2 = lines[i];
      }
      if (l1 && l2) {
        storeTLE(l1, l2);
        applyTLE(l1, l2, 'live');
        console.info('[Paolo Monti 37788] TLE aggiornato con successo da CelesTrak.');
      } else {
        console.warn('[Paolo Monti 37788] risposta ricevuta ma TLE non trovato nel testo (formato inatteso).');
      }
    }).catch(function(err){
      console.warn('[Paolo Monti 37788] aggiornamento TLE fallito (rete, CORS o server non raggiungibile): ' + err.message + ' — resto sul dato precedente.');
    });
  }
  function initTLE() {
    var stored = loadStoredTLE();
    if (stored) {
      applyTLE(stored.line1, stored.line2, 'live');
      if (Date.now() - stored.fetchedAt >= TLE_MAX_AGE_MS) fetchFreshTLE();
    } else {
      fetchFreshTLE();
    }
  }
  setInterval(function(){
    var stored = loadStoredTLE();
    if (!stored || Date.now() - stored.fetchedAt >= TLE_MAX_AGE_MS) fetchFreshTLE();
  }, 60 * 60 * 1000); // check hourly, fetch at least daily

  // ---------- Drawing ----------
  var userLabelEl = document.getElementById('user-label');

  // Satellite marker: rendered as a "$" glyph, oriented along the satellite's
  // direction of travel (same convention as the previous pictogram icon).
  function drawSatelliteIcon(x, y, angleRad, sizePx, color) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angleRad);
    ctx.fillStyle = color;
    ctx.font = '700 ' + Math.round(sizePx) + 'px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('$', 0, 0);
    ctx.restore();
  }

  function drawMarker(lat, lon, altKm, color, radiusPx) {
    var p = projection([lon, lat]);
    if (!p) return null;
    var cx = width / 2, cy = height / 2;
    var dx = p[0] - cx, dy = p[1] - cy;
    var dist = Math.hypot(dx, dy);
    var ux = dist > 1e-3 ? dx / dist : 0;
    var uy = dist > 1e-3 ? dy / dist : -1;
    var scaleR = projection.scale();
    var altFrac = altKm ? (altKm / EARTH_RADIUS_KM) : 0;
    var offset = Math.min(scaleR * 0.4, scaleR * altFrac * 0.6);
    var mx = p[0] + ux * offset, my = p[1] + uy * offset;

    if (offset > 1) {
      ctx.beginPath();
      ctx.moveTo(p[0], p[1]);
      ctx.lineTo(mx, my);
      ctx.strokeStyle = 'rgba(255,255,255,0.45)';
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(p[0], p[1], 3, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.arc(mx, my, radiusPx, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();

    return { x: mx, y: my };
  }

  function positionLabel(el, screenPt) {
    if (!screenPt) { el.style.display = 'none'; return; }
    el.style.left = screenPt.x + 'px';
    el.style.top = screenPt.y + 'px';
    el.style.display = 'block';
  }

  function redraw() {
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);

    // globe limb
    ctx.beginPath(); pathGen(sphereGeo);
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // graticule
    ctx.beginPath(); pathGen(graticule());
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // equator, slightly brighter
    ctx.beginPath();
    pathGen({ type: 'LineString', coordinates: d3.range(-180, 181, 4).map(function(l){ return [l, 0]; }) });
    ctx.strokeStyle = 'rgba(255,255,255,0.32)';
    ctx.stroke();

    // country borders (drawn once the external GeoJSON file has loaded)
    if (BORDERS_GEOJSON) {
      ctx.beginPath(); pathGen(BORDERS_GEOJSON);
      ctx.strokeStyle = 'rgba(255,255,255,0.92)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // orbit trail: behind (intense, solid) = where it has been for 3/4 orbit;
    // ahead (bold, dotted) = where it is heading — half an orbit normally, or an
    // extended path to the 2nd closest approach to the user's location, on request.
    var activeFutureCoords = getActiveFutureCoords();
    if (activeFutureCoords.length > 1) {
      ctx.beginPath();
      pathGen(toLineString(activeFutureCoords));
      ctx.setLineDash([2, 3]);
      ctx.strokeStyle = 'rgba(255,110,90,0.9)';
      ctx.lineWidth = 1.8;
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (orbitPastCoords.length > 1) {
      ctx.beginPath();
      pathGen(toLineString(orbitPastCoords));
      ctx.strokeStyle = 'rgba(255,59,48,0.95)';
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }

    // satellite icon, oriented along its direction of travel
    if (currentSat.valid) {
      var satScreen = projection([currentSat.lon, currentSat.lat]);
      if (satScreen) {
        var heading = 0;
        if (orbitFutureCoords.length > 1) {
          var h0 = projection([orbitFutureCoords[0].lon, orbitFutureCoords[0].lat]);
          var h1 = projection([orbitFutureCoords[1].lon, orbitFutureCoords[1].lat]);
          if (h0 && h1 && (h0[0] !== h1[0] || h0[1] !== h1[1])) {
            heading = Math.atan2(h1[1] - h0[1], h1[0] - h0[0]);
          }
        }
        var iconSize = Math.max(16, Math.min(30, projection.scale() * 0.09));
        drawSatelliteIcon(satScreen[0], satScreen[1], heading + Math.PI / 2, iconSize, '#ffffff');
      }
    }

    // user location marker
    var userPt = userLoc.valid ? drawMarker(userLoc.lat, userLoc.lon, 0, '#ffffff', 3) : null;
    positionLabel(userLabelEl, userPt);
  }

  updateSatellite();
  rebuildOrbitTrail();
  redraw();
  initTLE();
  loadBorders();

  var btnSat = document.getElementById('btn-sat');
  function btnSatActive(on) {
    if (on) btnSat.classList.add('active');
    else btnSat.classList.remove('active');
  }

  // startup: center on satellite and start following it in real time
  followSat = true;
  btnSatActive(true);
  goTo(currentSat.lat, currentSat.lon, 2200);

  setInterval(function(){
    updateSatellite();
    rebuildOrbitTrail();
    if (followSat && !anim) nudgeTowardsSatellite();
    if (!anim) redraw();
  }, 1000);

  // ---------- Drag interaction ----------
  var dragging = false, lastX = 0, lastY = 0;
  var downX = 0, downY = 0;
  var SENS = 0.24; // degrees per pixel
  var TAP_MOVE_THRESHOLD = 6; // px — below this, treat a pointer up as a tap, not a drag
  canvas.style.touchAction = 'none';
  canvas.style.cursor = 'grab';

  canvas.addEventListener('pointerdown', function(e){
    canvas.setPointerCapture(e.pointerId);
    dragging = true; lastX = e.clientX; lastY = e.clientY;
    downX = e.clientX; downY = e.clientY;
    anim = null;
    if (followSat) { followSat = false; btnSatActive(false); }
    canvas.style.cursor = 'grabbing';
  });
  canvas.addEventListener('pointermove', function(e){
    if (!dragging) return;
    var dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    rot.lambda += dx * SENS;
    rot.phi = Math.max(-90, Math.min(90, rot.phi - dy * SENS));
    projection.rotate([rot.lambda, rot.phi, 0]);
    redraw();
  });
  function stopDrag(e){
    dragging = false; canvas.style.cursor = 'grab';
    if (e && Math.hypot(e.clientX - downX, e.clientY - downY) < TAP_MOVE_THRESHOLD) {
      handleTrailTap(e.clientX, e.clientY);
    }
  }
  window.addEventListener('pointerup', stopDrag);
  canvas.addEventListener('pointercancel', stopDrag);

  // ---------- Tap/click on the trail: reveal the date/time at that point ----------
  var trailTooltipEl = document.getElementById('trail-tooltip');
  var trailTooltipTimer = null;
  function formatDateTime(d) {
    if (!d) return '—';
    try {
      return d.toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch (e) { return d.toString(); }
  }
  function handleTrailTap(clientX, clientY) {
    var rect = canvas.getBoundingClientRect();
    var px = clientX - rect.left, py = clientY - rect.top;
    var HIT_RADIUS = 14;
    var best = null, bestDist = HIT_RADIUS;
    var pools = [orbitPastCoords, getActiveFutureCoords()];
    for (var pi = 0; pi < pools.length; pi++) {
      var pool = pools[pi];
      for (var i = 0; i < pool.length; i++) {
        var s = projection([pool[i].lon, pool[i].lat]);
        if (!s) continue;
        var d = Math.hypot(s[0] - px, s[1] - py);
        if (d < bestDist) { bestDist = d; best = { screen: s, t: pool[i].t }; }
      }
    }
    if (trailTooltipTimer) { clearTimeout(trailTooltipTimer); trailTooltipTimer = null; }
    if (best) {
      trailTooltipEl.textContent = formatDateTime(best.t);
      trailTooltipEl.style.left = (rect.left + best.screen[0]) + 'px';
      trailTooltipEl.style.top = (rect.top + best.screen[1]) + 'px';
      trailTooltipEl.classList.add('show');
      trailTooltipTimer = setTimeout(function(){ trailTooltipEl.classList.remove('show'); }, 4500);
    } else {
      trailTooltipEl.classList.remove('show');
    }
  }

  canvas.addEventListener('wheel', function(e){
    e.preventDefault();
    var s = projection.scale();
    s = Math.max(width * 0.18, Math.min(width * 0.9, s - e.deltaY * 0.6));
    projection.scale(s);
    redraw();
  }, { passive: false });

  var pinchDist = null;
  canvas.addEventListener('touchstart', function(e){
    if (e.touches.length === 2) {
      pinchDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      if (followSat) { followSat = false; btnSatActive(false); }
    }
  }, { passive: true });
  canvas.addEventListener('touchmove', function(e){
    if (e.touches.length === 2 && pinchDist !== null) {
      var d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      var s = projection.scale() * (d / pinchDist);
      s = Math.max(width * 0.18, Math.min(width * 0.9, s));
      projection.scale(s);
      pinchDist = d;
      redraw();
    }
  }, { passive: true });

  function onResize(){ sizeCanvas(); redraw(); }
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onResize);

  // ---------- Buttons ----------
  btnSat.addEventListener('click', function(){
    followSat = true;
    btnSatActive(true);
    showExtendedTrail = false;
    extendedFutureCoords = [];
    goTo(currentSat.lat, currentSat.lon, 1400);
  });

  var geoMsgEl = document.getElementById('geo-msg');
  var geoMsgTimer = null;
  function flashMsg(text) {
    geoMsgEl.textContent = text;
    geoMsgEl.classList.add('show');
    if (geoMsgTimer) clearTimeout(geoMsgTimer);
    geoMsgTimer = setTimeout(function(){ geoMsgEl.classList.remove('show'); }, 3800);
  }

  var btnGeo = document.getElementById('btn-geo');
  if (!('geolocation' in navigator)) {
    btnGeo.disabled = true;
    btnGeo.title = 'Geolocalizzazione non disponibile in questo browser';
  }
  btnGeo.addEventListener('click', function(){
    if (!('geolocation' in navigator)) return;
    btnGeo.disabled = true;
    navigator.geolocation.getCurrentPosition(function(pos){
      btnGeo.disabled = false;
      followSat = false;
      btnSatActive(false);
      userLoc.lat = pos.coords.latitude;
      userLoc.lon = pos.coords.longitude;
      userLoc.valid = true;
      extendedFutureCoords = computeExtendedFutureTrail(userLoc.lat, userLoc.lon);
      showExtendedTrail = true;
      goTo(userLoc.lat, userLoc.lon, 1400);
    }, function(err){
      btnGeo.disabled = false;
      if (err.code === err.PERMISSION_DENIED) {
        flashMsg('Permesso di geolocalizzazione negato.');
      } else {
        flashMsg('Posizione non disponibile al momento.');
      }
    }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 });
  });

  document.getElementById('loading').style.opacity = '0';
  setTimeout(function(){ document.getElementById('loading').style.display = 'none'; }, 400);
})();
