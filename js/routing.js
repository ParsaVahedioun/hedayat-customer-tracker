/* ==========================================================================
   Hedayat Customer Tracker — js/routing.js
   --------------------------------------------------------------------------
   Driving directions drawn INSIDE the Leaflet map (no Google Maps redirect).

   Uses the public OSRM demo server directly over `fetch` — no extra library,
   no API key. Requests are plain OSRM v1:
       GET /route/v1/driving/{lon},{lat};{lon},{lat}?overview=full&geometries=geojson&steps=true
   The server sends `Access-Control-Allow-Origin: *`, so this works from any
   http(s) origin. (Over `file://` the browser blocks cross-origin fetch —
   the app tells the user to open the folder through a small static server.)

   Origin is resolved in this order:
     1. the rep's GPS position (if already known / granted)
     2. otherwise the rep picks the start point by clicking the map

   Loaded after app.js; registers itself through window.Hedayat.
   ========================================================================== */
'use strict';

const Routing = (function () {

  let routeLayer = null;      // L.LayerGroup holding the casing + main polyline
  let originMarker = null;
  let destMarker = null;
  let meMarker = null;
  let me = null;              // L.LatLng of the rep's current position
  let picking = null;         // { cb } while waiting for a map click
  let busy = false;           // guard against overlapping OSRM requests
  let seq = 0;                // request sequence, so a stale reply is ignored

  /* ------------------------------------------------------ Persian manoeuvres */
  const MANEUVER = {
    depart:            'حرکت از مبدأ',
    arrive:            'رسیدن به مقصد',
    turn:              'بپیچید',
    'new name':        'ادامه دهید',
    continue:          'ادامه دهید',
    merge:             'ادغام شوید',
    'on ramp':         'وارد بزرگراه شوید',
    'off ramp':        'از بزرگراه خارج شوید',
    fork:              'در دوراهی',
    'end of road':     'انتهای خیابان',
    roundabout:        'از میدان',
    rotary:            'از میدان',
    'roundabout turn': 'در میدان',
    'exit roundabout': 'از میدان خارج شوید',
    'exit rotary':     'از میدان خارج شوید',
    notification:      'توجه'
  };

  const MODIFIER = {
    left:         'به چپ',
    right:        'به راست',
    'slight left':  'کمی به چپ',
    'slight right': 'کمی به راست',
    'sharp left':   'به چپ تند',
    'sharp right':  'به راست تند',
    straight:     'مستقیم',
    uturn:        'دور بزنید'
  };

  function maneuverText(step) {
    const m = (step && step.maneuver) || {};
    const type = m.type || '';
    const mod = MODIFIER[m.modifier] || '';

    if (type === 'depart') return 'حرکت از مبدأ';
    if (type === 'arrive') return 'رسیدن به مقصد';
    if (type === 'roundabout' || type === 'rotary' || type === 'roundabout turn') {
      const exit = m.exit ? ('خروجی ' + toFa(m.exit)) : '';
      return ['از میدان', exit, mod].filter(Boolean).join(' ');
    }
    const base = MANEUVER[type] || 'ادامه دهید';
    return mod ? base + ' ' + mod : base;
  }

  /* ----------------------------------------------------------- formatting */
  function faNum(text) { return toFa(String(text).replace('.', '٫')); }

  function fmtDistance(m) {
    if (m === null || m === undefined || isNaN(m)) return '—';
    if (m < 1000) return faNum(Math.round(m)) + ' متر';
    const km = m / 1000;
    return faNum(km < 10 ? km.toFixed(1) : Math.round(km)) + ' کیلومتر';
  }

  function fmtDuration(sec) {
    if (sec === null || sec === undefined || isNaN(sec)) return '—';
    const min = Math.max(1, Math.round(sec / 60));
    if (min < 60) return faNum(min) + ' دقیقه';
    const h = Math.floor(min / 60);
    const r = min % 60;
    return faNum(h) + ' ساعت' + (r ? ' و ' + faNum(r) + ' دقیقه' : '');
  }

  /* ------------------------------------------------------- pick-on-the-map */
  function showPickBanner(text) {
    $('pick-banner-text').textContent = text;
    $('pick-banner').hidden = false;
    state.map.getContainer().classList.add('pick-mode');
  }

  function hidePickBanner() {
    $('pick-banner').hidden = true;
    state.map.getContainer().classList.remove('pick-mode');
  }

  function pickPoint(message, cb) {
    cancelPick();
    picking = { cb: cb };
    showPickBanner(message);
    state.map.once('click', onPick);
  }

  function onPick(e) {
    const cb = picking && picking.cb;
    picking = null;
    hidePickBanner();
    if (cb) cb(e.latlng);
  }

  function cancelPick() {
    if (!picking) { hidePickBanner(); return false; }
    state.map.off('click', onPick);
    picking = null;
    hidePickBanner();
    return true;
  }

  function isPicking() { return !!picking; }

  /* ------------------------------------------------------------ my position */
  function showMe(latlng, accuracy) {
    if (meMarker) state.map.removeLayer(meMarker);
    meMarker = L.marker(latlng, {
      icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }),
      title: 'موقعیت من',
      zIndexOffset: 1200
    }).addTo(state.map);
    meMarker.bindPopup('موقعیت فعلی شما' +
      (accuracy ? ' <span style="direction:ltr;display:inline-block">(±' + toFa(Math.round(accuracy)) + ' m)</span>' : ''));
    meMarker.openPopup();
  }

  function locate(silent, cb) {
    if (!navigator.geolocation) {
      if (!silent) toast('این مرورگر از موقعیت مکانی پشتیبانی نمی‌کند.');
      if (cb) cb(null);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      function (pos) {
        me = L.latLng(pos.coords.latitude, pos.coords.longitude);
        showMe(me, pos.coords.accuracy);
        state.map.setView(me, Math.max(state.map.getZoom(), 15), { animate: true });
        if (cb) cb(me);
      },
      function (err) {
        const denied = err && err.code === 1;
        if (!silent) {
          toast(denied ? 'دسترسی به موقعیت مکانی رد شد — می‌توانید نقطه شروع را روی نقشه بزنید.'
                       : 'دریافت موقعیت مکانی ناموفق بود — نقطه شروع را روی نقشه بزنید.');
        }
        if (cb) cb(null);
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 }
    );
  }

  /* ---------------------------------------------------------------- drawing */
  function clearDrawing() {
    if (routeLayer) { state.map.removeLayer(routeLayer); routeLayer = null; }
    if (originMarker) { state.map.removeLayer(originMarker); originMarker = null; }
    if (destMarker) { state.map.removeLayer(destMarker); destMarker = null; }
  }

  function endpointMarker(latlng, cls, title) {
    return L.marker(latlng, {
      icon: L.divIcon({ className: '', html: '<div class="' + cls + '"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }),
      title: title,
      zIndexOffset: 1100
    });
  }

  function drawRoute(route, from, to) {
    clearDrawing();

    const coords = (route.geometry && route.geometry.coordinates ? route.geometry.coordinates : [])
      .map(p => [p[1], p[0]]);
    if (!coords.length) throw new Error('empty geometry');

    // featureGroup (not layerGroup) so getBounds() is available for fitBounds
    routeLayer = L.featureGroup();
    // white casing first, coloured line on top — reads well over busy tiles
    L.polyline(coords, { color: '#ffffff', weight: 9, opacity: .85, lineJoin: 'round', lineCap: 'round' }).addTo(routeLayer);
    L.polyline(coords, { color: CONFIG.routing.lineColor, weight: 5, opacity: .95, lineJoin: 'round', lineCap: 'round' }).addTo(routeLayer);

    originMarker = endpointMarker(from, 'route-from', 'نقطه شروع').addTo(routeLayer);
    destMarker = endpointMarker(to, 'route-to', 'نقطه پایان').addTo(routeLayer);

    state.map.addLayer(routeLayer);
    state.map.fitBounds(routeLayer.getBounds(), { padding: [55, 55], animate: true });
  }

  /* ---------------------------------------------------------------- panel */
  function renderPanel(route, fromLabel, toLabel) {
    $('route-dist').textContent = fmtDistance(route.distance);
    $('route-time').textContent = fmtDuration(route.duration);

    $('route-fromto').innerHTML =
      '<span class="route-pt"><i class="route-dot from"></i>' + esc(fromLabel) + '</span>' +
      '<span class="route-arrow">⟵</span>' +
      '<span class="route-pt"><i class="route-dot to"></i>' + esc(toLabel) + '</span>';

    const steps = [];
    (route.legs || []).forEach(leg => (leg.steps || []).forEach(s => steps.push(s)));

    $('route-steps').innerHTML = steps.length
      ? steps.map((s, i) => {
          const name = s.name ? ' — ' + esc(s.name) : '';
          return '<div class="route-step">' +
            '<span class="step-n">' + toFa(i + 1) + '</span>' +
            '<span class="step-body">' +
              '<span class="step-text">' + esc(maneuverText(s)) + name + '</span>' +
              '<span class="step-meta">' + fmtDistance(s.distance) + '</span>' +
            '</span>' +
          '</div>';
        }).join('')
      : '<p class="route-note">جزئیات نوبت‌به‌نوبت برای این مسیر در دسترس نیست.</p>';

    $('route-panel').hidden = false;
  }

  function clear() {
    seq++;                       // invalidate any in-flight request
    clearDrawing();
    $('route-panel').hidden = true;
    $('btn-route-clear').hidden = true;
  }

  /* --------------------------------------------------------------- request */
  async function requestRoute(from, to) {
    const base = CONFIG.routing.serviceUrl.replace(/\/+$/, '');
    const url = base + '/' + CONFIG.routing.profile + '/' +
      from.lng.toFixed(6) + ',' + from.lat.toFixed(6) + ';' +
      to.lng.toFixed(6) + ',' + to.lat.toFixed(6) +
      '?overview=full&geometries=geojson&steps=true&alternatives=false';

    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), 20000) : null;

    let doc;
    try {
      const res = await fetch(url, { signal: controller ? controller.signal : undefined });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      doc = await res.json();
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (doc.code !== 'Ok' || !doc.routes || !doc.routes.length) {
      throw new Error('OSRM: ' + (doc.code || 'no route'));
    }
    return doc.routes[0];
  }

  async function run(from, fromLabel, to, toLabel) {
    if (busy) { toast('یک مسیر در حال محاسبه است…'); return; }
    busy = true;
    const mySeq = ++seq;
    toast('در حال محاسبه مسیر…');

    try {
      const route = await requestRoute(from, to);
      if (mySeq !== seq) return;                 // a newer request superseded us
      drawRoute(route, from, to);
      renderPanel(route, fromLabel, toLabel);
      $('btn-route-clear').hidden = false;
    } catch (err) {
      if (mySeq !== seq) return;
      console.error('[routing]', err);
      const offline = location.protocol === 'file:';
      toast(offline
        ? 'برای مسیریابی باید برنامه از طریق آدرس http باز شود (فایل مستقیم پشتیبانی نمی‌شود).'
        : 'محاسبه مسیر ناموفق بود — اتصال اینترنت را بررسی کنید.');
    } finally {
      busy = false;
    }
  }

  /* ------------------------------------------------------------ entry points */

  /** Route from the rep's position (or a picked start) to a customer. */
  function toCustomer(c) {
    if (!c || c.lat === null || c.lng === null) {
      toast('این مشتری موقعیت ثبت‌شده ندارد.');
      return;
    }
    closeModals();

    const target = L.latLng(c.lat, c.lng);
    const destLabel = c.name || c.companyName || c.customerCode || 'مقصد';

    if (me) { run(me, 'موقعیت من', target, destLabel); return; }

    toast('موقعیت شما در حال دریافت است…');
    locate(true, function (pos) {
      if (pos) {
        run(pos, 'موقعیت من', target, destLabel);
      } else {
        pickPoint('نقطه شروع مسیر را روی نقشه انتخاب کنید', function (start) {
          run(start, 'نقطه شروع', target, destLabel);
        });
      }
    });
  }

  /** Two-click flow from the toolbar: start point, then destination. */
  function startPick() {
    closeModals();
    if (me) {
      pickPoint('نقطه پایان مسیر را روی نقشه انتخاب کنید', function (end) {
        run(me, 'موقعیت من', end, 'نقطه پایان');
      });
      toast('از موقعیت فعلی شما مسیریابی می‌شود.');
      return;
    }
    pickPoint('نقطه شروع مسیر را روی نقشه انتخاب کنید', function (start) {
      pickPoint('نقطه پایان مسیر را روی نقشه انتخاب کنید', function (end) {
        run(start, 'نقطه شروع', end, 'نقطه پایان');
      });
    });
  }

  function init() {
    $('btn-route').addEventListener('click', startPick);
    $('btn-route-clear').addEventListener('click', function () { clear(); toast('مسیر پاک شد.'); });
    $('route-close').addEventListener('click', clear);
    $('btn-my-location').addEventListener('click', function () { locate(false, null); });
    $('pick-cancel').addEventListener('click', function () { cancelPick(); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && picking) cancelPick();
    });
  }

  return {
    init: init,
    toCustomer: toCustomer,
    startPick: startPick,
    locate: locate,
    pickPoint: pickPoint,
    cancelPick: cancelPick,
    isPicking: isPicking,
    clear: clear,
    fmtDistance: fmtDistance,
    fmtDuration: fmtDuration
  };
})();

Hedayat.route = Routing;

Hedayat.register({
  name: 'routing',
  init() {
    Routing.init();
  }
});
