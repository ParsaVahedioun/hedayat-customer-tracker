/* ==========================================================================
   Hedayat Customer Tracker — app.js  (core)
   Vanilla JS + Leaflet + OpenStreetMap + MarkerCluster + LocalStorage.
   No frameworks, no backend, no build step.

   Feature modules live in js/ and plug into this core through window.Hedayat:
     js/store.js    — reps, rep-added customers, marketing edits, notes
     js/routing.js  — in-map driving directions (OSRM)
     js/editor.js   — rep login, add-customer form, notes UI
   ========================================================================== */
'use strict';

/* ==========================================================================
   0. MODULE REGISTRY — how js/*.js plug into the core
   ========================================================================== */
const Hedayat = window.Hedayat = {
  modules: [],       // { name, init, afterData, onRebuild, extraCustomers }
  enrichHooks: [],   // fn(customer) — layer extra data onto every customer

  register(mod) {
    if (mod && this.modules.indexOf(mod) === -1) this.modules.push(mod);
    return this;
  },
  onEnrich(fn) {
    if (typeof fn === 'function') this.enrichHooks.push(fn);
    return this;
  },

  store: null,       // set by js/store.js
  route: null,       // set by js/routing.js
  editor: null       // set by js/editor.js
};

/* ==========================================================================
   1. CONFIG — everything tweakable lives here
   ========================================================================== */
const CONFIG = {
  // Swap this for an API endpoint later; loadCustomers() is the only reader.
  dataUrl: 'data/customers.json',

  mapCenter: [32.65, 53.60],   // Iran
  mapZoom: 5,
  tileUrl: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
  tileAttribution: 'داده‌های نقشه © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',

  clusterThreshold: 60,        // switch to MarkerCluster above this many markers
  pageSize: 60,                // customer-list rendering chunk

  storageKey: 'hedayat.coords.v1',

  // In-map driving directions. The public OSRM demo server needs no API key
  // and sends permissive CORS headers.
  routing: {
    serviceUrl: 'https://router.project-osrm.org/route/v1',
    profile: 'driving',
    lineColor: '#2563eb'
  },

  // Follow-up workflow offered to the sales rep.
  followUps: ['در انتظار تماس', 'تماس گرفته شد', 'علاقه‌مند', 'خرید کرد', 'منصرف شد', 'بدون پاسخ'],

  // Marker colour per customer category — change freely.
  markerColors: {
    '12':     '#dc2626',   // بدهکاران
    '22':     '#2563eb',   // مشتریان قبلی
    'org':    '#7c3aed',   // سازمانی (منطقه ۲۱)
    'local':  '#0d9488',   // ثبت‌شده توسط بازاریاب
    'unknown':'#94a3b8'    // نوع نامشخص
  }
};

/* ==========================================================================
   2. CUSTOMER CODE REFERENCE DATA
   The code is a 10-digit account code read LEFT -> RIGHT by fixed position:
       1 2 | 0 0 | 0 1 | 0 0 0 2
       type   pad   region  serial
   ========================================================================== */
const CUSTOMER_TYPES = {
  '12': 'بدهکاران',
  '22': 'مشتریان قبلی'
};

const REGION_CODES = {
  '01': 'اصفهان - منطقه 01', '02': 'اصفهان - منطقه 02', '03': 'اصفهان - منطقه 03',
  '04': 'اصفهان - منطقه 04', '05': 'اصفهان - منطقه 05', '06': 'اصفهان - منطقه 06',
  '07': 'اصفهان - منطقه 07', '08': 'اصفهان - منطقه 08', '09': 'اصفهان - منطقه 09',
  '10': 'اصفهان - منطقه 10', '11': 'اصفهان - منطقه 11', '12': 'اصفهان - منطقه 12',
  '13': 'اصفهان - منطقه 13', '14': 'اصفهان - منطقه 14', '15': 'اصفهان - منطقه 15',
  '16': 'محور اصفهان 16', '17': 'محور اصفهان 17', '18': 'محور اصفهان 18', '19': 'محور اصفهان 19',
  '20': 'متفرقه', '21': 'سازمانی', '22': 'تهران', '23': 'قم', '24': 'مرکزی', '25': 'یزد',
  '26': 'چهارمحال و بختیاری', '27': 'ساری', '28': 'مشهد', '29': 'ایلام', '30': 'سمنان',
  '31': 'کردستان', '32': 'خوزستان', '33': 'آذربایجان شرقی', '34': 'آذربایجان غربی',
  '35': 'سیستان و بلوچستان', '36': 'فارس', '37': 'لرستان', '38': 'کرج', '39': 'بندرعباس',
  '40': 'قزوین', '41': 'اردبیل', '42': 'کهگیلویه و بویراحمد', '43': 'بوشهر', '44': 'همدان',
  '45': 'زنجان', '46': 'کرمانشاه', '60': 'فضای مجازی'
};

const REGION_GROUPS = [
  { label: 'اصفهان',        codes: range(1, 15) },
  { label: 'محورهای اصفهان', codes: ['16', '17', '18', '19'] },
  { label: 'سایر مناطق',    codes: range(20, 46).concat(['60']) }
];

function range(a, b) {
  const out = [];
  for (let i = a; i <= b; i++) out.push(String(i).padStart(2, '0'));
  return out;
}

/* ==========================================================================
   3. THE PARSER — single source of truth for customer codes
   Nothing else in the app may split a customer code.
   ========================================================================== */
function parseCustomerCode(code) {
  const c = String(code === null || code === undefined ? '' : code).trim();  // String() first
  const valid = /^\d{10}$/.test(c);
  if (!valid) {
    return { code: c, valid: false, customerTypeCode: '', customerType: 'نامشخص',
             regionCode: '', regionName: 'نامشخص', serial: '' };
  }
  const typeCode = c.slice(0, 2);      // chars 1-2
  const regionCode = c.slice(4, 6);    // chars 5-6  (chars 3-4 are the "00" pad)
  return {
    code: c,
    valid: true,
    customerTypeCode: typeCode,
    customerType: CUSTOMER_TYPES[typeCode] || 'نامشخص',
    regionCode: regionCode,
    regionName: REGION_CODES[regionCode] || 'نامشخص',
    serial: c.slice(6, 10)
  };
}

/* ==========================================================================
   4. small helpers
   ========================================================================== */
const FA_DIGITS = ['۰','۱','۲','۳','۴','۵','۶','۷','۸','۹'];

function toFa(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/[0-9]/g, d => FA_DIGITS[+d]);
}
function normalizeFa(str) {
  return String(str === null || str === undefined ? '' : str)
    .replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[يى]/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/\u200c/g, ' ')
    .toLowerCase()
    .trim();
}
function debounce(fn, wait) {
  let t;
  return function () {
    const args = arguments;
    clearTimeout(t);
    t = setTimeout(() => fn.apply(null, args), wait);
  };
}
function esc(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function $(id) { return document.getElementById(id); }

const PLACEHOLDER = 'ثبت نشده';
function orDash(v) { return (v === null || v === undefined || v === '') ? PLACEHOLDER : v; }

/* ==========================================================================
   5. STATE
   Every customer gets a stable `uid`:
     imported records  ->  "c:<customerCode>"   (so old deep links still work)
     rep-added records ->  "n:<generated id>"
   uid is the key for markers, coordinate overrides and the active row.
   ========================================================================== */
const state = {
  raw: [],            // customers exactly as loaded (imported only)
  all: [],            // enriched customers (imported + rep-added)
  filtered: [],
  overrides: {},      // { uid: {lat,lng} } from LocalStorage
  query: '',
  filters: { province: '', city: '', region: '', regionCode: '', type: '', sales: '',
             location: '', followUp: '', source: '' },
  rendered: 0,
  activeKey: null,
  pinKey: null,       // a just-added record, pinned to the top of the list
  quality: null,
  map: null,
  markerLayer: null,
  markers: new Map(), // uid -> L.Marker
  useCluster: false
};

/* ==========================================================================
   6. LocalStorage — manual coordinate overrides only (JSON is never written)
   ========================================================================== */
function loadOverrides() {
  try {
    const raw = localStorage.getItem(CONFIG.storageKey);
    const doc = raw ? JSON.parse(raw) : {};
    const migrated = {};
    Object.keys(doc || {}).forEach(key => {
      // v1 stored bare customer codes; v2 keys everything by uid
      migrated[/^[cn]:/.test(key) ? key : 'c:' + key] = doc[key];
    });
    state.overrides = migrated;
  } catch (e) {
    console.warn('overrides unreadable', e);
    state.overrides = {};
  }
}
function saveOverrides() {
  try { localStorage.setItem(CONFIG.storageKey, JSON.stringify(state.overrides)); }
  catch (e) { console.warn('overrides not saved', e); }
}

/* ==========================================================================
   7. DATA
   ========================================================================== */
async function loadCustomers() {
  // Preferred path: the JSON file (this is the seam to replace with an API).
  try {
    const res = await fetch(CONFIG.dataUrl, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const doc = await res.json();
    return Array.isArray(doc) ? doc : (doc.customers || []);
  } catch (err) {
    // Fallback for file:// where fetch of a local JSON is blocked by the browser.
    if (window.CUSTOMERS_DATA) {
      console.warn('fetch failed — using embedded dataset (data/customers.js)', err);
      const doc = window.CUSTOMERS_DATA;
      return Array.isArray(doc) ? doc : (doc.customers || []);
    }
    throw err;
  }
}

function customerUid(raw) {
  if (raw.uid) return String(raw.uid);
  const code = String(raw.customerCode === null || raw.customerCode === undefined ? '' : raw.customerCode).trim();
  return (raw.isLocal ? 'n:' : 'c:') + code;
}

function enrich(raw) {
  const isLocal = !!raw.isLocal;
  const code = String(raw.customerCode === null || raw.customerCode === undefined ? '' : raw.customerCode).trim();
  const uid = customerUid(raw);

  const parsed = parseCustomerCode(code);   // parser is authoritative
  const override = state.overrides[uid];
  let lat = raw.latitude, lng = raw.longitude, status = raw.locationStatus || 'unknown';

  if (override && Number.isFinite(override.lat) && Number.isFinite(override.lng)) {
    lat = override.lat; lng = override.lng; status = 'manual';
  }
  const hasLocation = Number.isFinite(lat) && Number.isFinite(lng) &&
                      Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

  // A rep-added record may have no accounting code at all. Only then do we fall
  // back to the region the rep picked — a real code always wins.
  const pickedRegion = (isLocal && REGION_CODES[raw.regionCode]) ? String(raw.regionCode) : '';

  const c = Object.assign({}, raw, {
    uid: uid,
    isLocal: isLocal,
    customerCode: code,
    hasAccountingCode: !isLocal || code !== '',
    parsed: parsed,
    customerTypeCode: parsed.customerTypeCode,
    customerType: parsed.valid ? parsed.customerType : (isLocal ? 'مشتری جدید' : parsed.customerType),
    regionCode: parsed.valid ? parsed.regionCode : pickedRegion,
    regionName: parsed.valid ? parsed.regionName : (REGION_CODES[pickedRegion] || 'نامشخص'),
    lat: hasLocation ? lat : null,
    lng: hasLocation ? lng : null,
    locationStatus: hasLocation ? status : 'unknown',
    isManual: !!(override && hasLocation),
    warnings: Array.isArray(raw.warnings) ? raw.warnings.slice() : []
  });

  // js/store.js layers rep edits + notes on top here
  Hedayat.enrichHooks.forEach(fn => {
    try { fn(c); } catch (e) { console.warn('enrich hook failed', e); }
  });

  c.category = isLocal ? 'local' : markerCategory(c);
  c.hasAddress = !!(c.address && String(c.address).trim());
  c.searchBlob = normalizeFa([
    c.customerCode, c.name, c.companyName, c.nameRaw, c.phone, c.mobile,
    c.address, c.city, c.province, c.regionCode, c.regionName, c.serial,
    c.salesType, c.followUp, c.addedBy,
    (c.notes || []).map(n => n.text).join(' ')
  ].join(' '));
  return c;
}

function markerCategory(c) {
  if (c.regionCode === '21') return 'org';
  if (CONFIG.markerColors[c.customerTypeCode]) return c.customerTypeCode;
  return 'unknown';
}

function findByKey(key) {
  if (!key) return null;
  return state.all.find(c => c.uid === key) ||
         state.all.find(c => c.customerCode === key) ||
         null;
}

/* ==========================================================================
   8. MAP
   ========================================================================== */
function initMap() {
  state.map = L.map('map', { center: CONFIG.mapCenter, zoom: CONFIG.mapZoom, zoomControl: true });
  L.tileLayer(CONFIG.tileUrl, { attribution: CONFIG.tileAttribution, maxZoom: 19 }).addTo(state.map);
  state.markerLayer = L.markerClusterGroup({
    showCoverageOnHover: false,
    maxClusterRadius: 55,
    spiderfyOnMaxZoom: true,
    chunkedLoading: true
  });
  state.map.addLayer(state.markerLayer);
}

function pinIcon(c) {
  const color = CONFIG.markerColors[c.category] || CONFIG.markerColors.unknown;
  const manual = c.isManual ? ' pin-manual' : '';
  const local = c.isLocal ? ' pin-local' : '';
  return L.divIcon({
    className: '',
    html: `<div class="pin${manual}${local}" style="background:${color}"></div>`,
    iconSize: [20, 20],
    iconAnchor: c.isLocal ? [10, 10] : [10, 20],
    popupAnchor: c.isLocal ? [0, -12] : [0, -18]
  });
}

function renderMarkers() {
  const map = state.map;
  map.removeLayer(state.markerLayer);
  state.markers.clear();

  const located = state.filtered.filter(c => c.lat !== null);
  state.useCluster = located.length > CONFIG.clusterThreshold;

  state.markerLayer = state.useCluster
    ? L.markerClusterGroup({ showCoverageOnHover: false, maxClusterRadius: 55, chunkedLoading: true })
    : L.layerGroup();

  const markers = [];
  located.forEach(c => {
    const m = L.marker([c.lat, c.lng], { icon: pinIcon(c), title: c.name || c.customerCode || c.uid });
    m.bindPopup(popupHtml(c), { minWidth: 240 });
    m.on('popupopen', () => setActive(c.uid, false));
    state.markers.set(c.uid, m);
    markers.push(m);
  });
  state.markerLayer.addLayers ? state.markerLayer.addLayers(markers) : markers.forEach(m => state.markerLayer.addLayer(m));
  map.addLayer(state.markerLayer);

  const hint = $('map-hint');
  const localCount = located.filter(c => c.isLocal).length;
  if (!located.length) {
    hint.hidden = false;
    hint.innerHTML = state.filtered.length
      ? 'برای مشتریان این فهرست مختصاتی ثبت نشده است.'
      : 'مشتری‌ای برای نمایش روی نقشه وجود ندارد.';
  } else {
    hint.hidden = false;
    hint.innerHTML = `${toFa(located.length)} نشانگر روی نقشه` +
      (state.useCluster ? ' (خوشه‌بندی فعال)' : '') +
      (localCount ? ` — ${toFa(localCount)} ثبت بازاریاب` : '');
  }
}

function popupHtml(c) {
  const codeCell = c.customerCode
    ? `<span style="direction:ltr;display:inline-block">${esc(c.customerCode)}</span>`
    : '<span class="popup-muted">بدون کد حساب</span>';

  const rows = [
    ['کد مشتری', codeCell],
    ['نوع مشتری', esc(c.customerType)],
    ['منطقه', esc(c.regionName) + (c.regionCode ? ` (${toFa(c.regionCode)})` : '')],
    ['استان / شهر', esc(orDash(c.province)) + ' / ' + esc(orDash(c.city))],
    ['تماس', esc(orDash(c.mobile || c.phone))],
    ['آدرس', esc(orDash(c.address))],
    ['مانده حساب', c.balance === null || c.balance === undefined ? PLACEHOLDER : toFa(c.balance)],
    ['نوع فروش', esc(orDash(c.salesType))]
  ];
  if (c.followUp) rows.push(['وضعیت پیگیری', esc(c.followUp)]);
  if (c.noteCount) rows.push(['یادداشت بازاریاب', toFa(c.noteCount) + ' مورد']);
  if (c.isLocal) rows.push(['ثبت‌کننده', esc(orDash(c.addedBy))]);

  return `
    <div class="popup">
      <div class="popup-title">${esc(c.name || c.companyName || c.customerCode || 'بدون نام')}</div>
      <div class="popup-sub">
        ${esc(c.companyName || c.nameRaw || '')}
        ${c.isLocal ? '<span class="tag tag-local">ثبت بازاریاب</span>' : ''}
      </div>
      <dl class="popup-rows">
        ${rows.map(r => `<dt>${r[0]}</dt><dd>${r[1]}</dd>`).join('')}
      </dl>
      <div class="popup-actions">
        <button type="button" class="btn btn-primary" data-detail="${esc(c.uid)}">مشاهده جزئیات</button>
        ${c.lat !== null ? `<button type="button" class="btn" data-route="${esc(c.uid)}">مسیریابی</button>` : ''}
      </div>
    </div>`;
}

function fitBounds(customers, animate) {
  const located = customers.filter(c => c.lat !== null);
  if (!located.length) return false;
  state.map.fitBounds(L.latLngBounds(located.map(c => [c.lat, c.lng])),
    { padding: [40, 40], animate: !!animate });
  return true;
}

function focusCustomer(key, openPopup) {
  const c = findByKey(key);
  if (!c) return;
  setActive(c.uid, true);
  if (c.lat === null) {
    toast('این مشتری مختصات ثبت‌شده ندارد. از «جزئیات» می‌توانید موقعیت را دستی وارد کنید.');
    return;
  }
  state.map.flyTo([c.lat, c.lng], Math.max(state.map.getZoom(), 15), { duration: .7 });
  if (openPopup !== false) {
    const m = state.markers.get(c.uid);
    if (!m) return;
    setTimeout(() => {
      // a rebuild may have swapped the marker layer in the meantime
      if (state.markers.get(c.uid) !== m || !state.markerLayer) return;
      try {
        if (state.markerLayer.zoomToShowLayer) state.markerLayer.zoomToShowLayer(m, () => m.openPopup());
        else m.openPopup();
      } catch (e) { console.warn('popup focus failed', e); }
    }, 750);
  }
}

/* ==========================================================================
   9. FILTERS / SEARCH
   ========================================================================== */
function buildFilterOptions() {
  // keep whatever the user already selected (this runs again after a rebuild)
  const keep = {};
  ['f-province', 'f-city', 'f-region', 'f-region-code', 'f-type', 'f-sales'].forEach(id => { keep[id] = $(id).value; });

  const provinces = new Set(), cities = new Set(), types = new Set(), sales = new Set();
  state.all.forEach(c => {
    if (c.province && c.province !== 'نامشخص') provinces.add(c.province);
    if (c.city) cities.add(c.city);
    if (c.customerType) types.add(c.customerType);
    if (c.salesType) sales.add(c.salesType);
  });
  fillSelect($('f-province'), [...provinces].sort((a, b) => a.localeCompare(b, 'fa')), 'همه');
  fillSelect($('f-city'), [...cities].sort((a, b) => a.localeCompare(b, 'fa')), 'همه');
  fillSelect($('f-type'), [...types].sort(), 'همه');
  fillSelect($('f-sales'), [...sales].sort(), 'همه');

  // Region filter — grouped exactly like the brief (اصفهان / محورها / سایر)
  const regionSelect = $('f-region');
  regionSelect.innerHTML = '<option value="">همه مناطق</option>';
  REGION_GROUPS.forEach(group => {
    const og = document.createElement('optgroup');
    og.label = group.label;
    group.codes.forEach(code => {
      if (!REGION_CODES[code]) return;
      og.appendChild(new Option(`${toFa(code)} — ${REGION_CODES[code]}`, code));
    });
    regionSelect.appendChild(og);
  });

  const codeSelect = $('f-region-code');
  codeSelect.innerHTML = '<option value="">همه کدها</option>';
  Object.keys(REGION_CODES).forEach(code => {
    codeSelect.appendChild(new Option(`${toFa(code)} — ${REGION_CODES[code]}`, code));
  });

  Object.keys(keep).forEach(id => { $(id).value = keep[id]; });
}

function fillSelect(select, values, allLabel) {
  select.innerHTML = `<option value="">${allLabel}</option>`;
  values.forEach(v => select.appendChild(new Option(v, v)));
}

function readFilters(fromUser) {
  // any deliberate filter/search action drops the "just added" pin
  if (fromUser) state.pinKey = null;
  state.filters = {
    province: $('f-province').value,
    city: $('f-city').value,
    region: $('f-region').value,
    regionCode: $('f-region-code').value,
    type: $('f-type').value,
    sales: $('f-sales').value,
    location: $('f-location').value,
    followUp: $('f-followup').value,
    source: $('f-source').value
  };
  state.query = $('search').value;
}

function applyFilters() {
  const f = state.filters;
  const q = normalizeFa(state.query);
  const myRepName = Hedayat.store ? Hedayat.store.repName() : '';

  state.filtered = state.all.filter(c => {
    if (f.province && c.province !== f.province) return false;
    if (f.city && c.city !== f.city) return false;
    const regionWanted = f.region || f.regionCode;
    if (regionWanted && c.regionCode !== regionWanted) return false;
    if (f.type && c.customerType !== f.type) return false;
    if (f.sales && c.salesType !== f.sales) return false;

    if (f.location === 'has' && c.lat === null) return false;
    if (f.location === 'none' && c.lat !== null) return false;
    if (f.location === 'approximate' && !(c.lat !== null && c.locationStatus === 'approximate')) return false;
    if (f.location === 'manual' && !(c.isManual || c.isLocal)) return false;

    if (f.followUp === '__none__') { if (c.followUp) return false; }
    else if (f.followUp && c.followUp !== f.followUp) return false;

    if (f.source === 'imported' && c.isLocal) return false;
    if (f.source === 'local' && !c.isLocal) return false;
    if (f.source === 'noted' && !c.noteCount) return false;
    if (f.source === 'mine' && (!c.isLocal || c.addedBy !== myRepName)) return false;

    if (q && c.searchBlob.indexOf(q) === -1) return false;
    return true;
  });

  // If the query is exactly a customer code, jump straight to it.
  const rawQuery = normalizeFa(state.query);
  if (/^\d{6,10}$/.test(rawQuery)) {
    const exact = state.all.find(c => c.customerCode === rawQuery);
    if (exact && state.filtered.some(c => c.uid === exact.uid)) {
      focusCustomer(exact.uid, true);
    }
  }

  // a freshly added customer sits at the top of the list so the rep sees it
  if (state.pinKey) {
    const i = state.filtered.findIndex(c => c.uid === state.pinKey);
    if (i > 0) state.filtered.unshift(state.filtered.splice(i, 1)[0]);
  }

  state.rendered = 0;
  $('customer-list').innerHTML = '';
  renderList();
  renderMarkers();
  renderChips();
  $('result-count').textContent = toFa(state.filtered.length);
}

/* ==========================================================================
   10. RENDER — dashboard / legend / chips / list
   ========================================================================== */
function renderStats() {
  const all = state.all;
  const count = pred => all.filter(pred).length;
  const withLoc = count(c => c.lat !== null);
  const regions = new Set(all.filter(c => c.regionCode).map(c => c.regionCode));
  const provinces = new Set(all.filter(c => c.province && c.province !== 'نامشخص').map(c => c.province));
  const invalid = count(c => c.hasAccountingCode && !c.parsed.valid);

  const cards = [
    { label: 'تعداد کل مشتریان', value: all.length, accent: '#2563eb' },
    { label: 'بدهکاران', value: count(c => c.customerTypeCode === '12'), accent: CONFIG.markerColors['12'] },
    { label: 'مشتریان قبلی', value: count(c => c.customerTypeCode === '22'), accent: CONFIG.markerColors['22'] },
    { label: 'دارای موقعیت', value: withLoc, accent: '#15803d' },
    { label: 'بدون موقعیت', value: all.length - withLoc, accent: '#b45309' },
    { label: 'ثبت بازاریاب', value: count(c => c.isLocal), accent: CONFIG.markerColors.local },
    { label: 'یادداشت‌دار', value: count(c => c.noteCount > 0), accent: '#4f46e5' },
    { label: 'تعداد مناطق', value: regions.size, accent: '#0891b2' },
    { label: 'تعداد استان‌ها', value: provinces.size, accent: '#7c3aed' },
    { label: 'کد نامعتبر', value: invalid, accent: '#94a3b8' }
  ];
  $('dashboard').innerHTML = cards.map(c => `
    <div class="stat" style="--accent:${c.accent}">
      <span class="stat-label">${c.label}</span>
      <div class="stat-value">${toFa(c.value)}</div>
    </div>`).join('');
}

function renderLegend() {
  const items = [
    { label: 'بدهکاران', color: CONFIG.markerColors['12'] },
    { label: 'مشتریان قبلی', color: CONFIG.markerColors['22'] },
    { label: 'سازمانی', color: CONFIG.markerColors.org },
    { label: 'ثبت بازاریاب', color: CONFIG.markerColors.local },
    { label: 'نامشخص', color: CONFIG.markerColors.unknown }
  ];
  $('legend').innerHTML = items.map(i =>
    `<span class="legend-item"><span class="legend-dot" style="background:${i.color}"></span>${i.label}</span>`
  ).join('');
}

function renderChips() {
  const f = state.filters;
  const chips = [];
  const add = (key, label, value) => chips.push({ key, label, value });
  if (state.query) add('query', 'جستجو', state.query);
  if (f.province) add('province', 'استان', f.province);
  if (f.city) add('city', 'شهر', f.city);
  if (f.region || f.regionCode) add('region', 'منطقه', REGION_CODES[f.region || f.regionCode] || '');
  if (f.type) add('type', 'نوع', f.type);
  if (f.sales) add('sales', 'نوع فروش', f.sales);
  if (f.location) add('location', 'موقعیت', $('f-location').selectedOptions[0].textContent);
  if (f.followUp) add('followUp', 'پیگیری', f.followUp === '__none__' ? 'بدون وضعیت' : f.followUp);
  if (f.source) add('source', 'منبع', $('f-source').selectedOptions[0].textContent);

  $('active-chips').innerHTML = chips.map(c =>
    `<span class="chip">${esc(c.label)}: ${esc(c.value)}<button type="button" data-clear-chip="${c.key}" title="حذف">&times;</button></span>`
  ).join('');
}

function renderList() {
  const list = $('customer-list');
  const slice = state.filtered.slice(state.rendered, state.rendered + CONFIG.pageSize);
  const html = slice.map(c => {
    const tagLoc = c.lat === null
      ? '<span class="tag tag-noloc">بدون موقعیت</span>'
      : (c.isLocal
          ? '<span class="tag tag-local">ثبت بازاریاب</span>'
          : `<span class="tag tag-loc">${c.isManual ? 'موقعیت دستی' : 'تقریبی'}</span>`);
    const tagFollow = c.followUp ? `<span class="tag tag-follow">${esc(c.followUp)}</span>` : '';
    const tagNotes = c.noteCount ? `<span class="tag tag-note">${toFa(c.noteCount)} یادداشت</span>` : '';

    return `
      <article class="cust-card${state.activeKey === c.uid ? ' is-active' : ''}${c.isLocal ? ' is-local' : ''}"
               data-uid="${esc(c.uid)}"
               style="--accent:${CONFIG.markerColors[c.category]}"
               role="listitem" tabindex="0">
        <div class="cust-top">
          <span class="cust-name">${esc(c.name || c.customerCode || 'بدون نام')}</span>
          <span class="cust-code">${esc(c.customerCode || '—')}</span>
        </div>
        ${c.companyName ? `<div class="cust-company">${esc(c.companyName)}</div>` : ''}
        <div class="cust-meta">
          <span class="tag">${esc(c.customerType)}</span>
          <span class="tag tag-region">${esc(c.regionName)}</span>
          ${c.city ? `<span class="tag">${esc(c.city)}</span>` : ''}
          ${c.province && c.province !== 'نامشخص' ? `<span class="tag">${esc(c.province)}</span>` : ''}
          ${tagLoc}
          ${tagFollow}
          ${tagNotes}
        </div>
      </article>`;
  }).join('');

  list.insertAdjacentHTML('beforeend', html);
  state.rendered += slice.length;

  $('btn-more').hidden = state.rendered >= state.filtered.length;
  $('list-empty').hidden = state.filtered.length !== 0;
}

function setActive(uid, scroll) {
  state.activeKey = uid;
  document.querySelectorAll('.cust-card.is-active').forEach(el => el.classList.remove('is-active'));
  const card = document.querySelector(`.cust-card[data-uid="${uid}"]`);
  if (!card) return;
  card.classList.add('is-active');
  if (!scroll) return;

  // scroll ONLY the list — scrollIntoView() would also scroll the whole page
  const list = $('customer-list');
  if (!list || !list.contains(card)) return;
  const lr = list.getBoundingClientRect();
  const cr = card.getBoundingClientRect();
  if (cr.top < lr.top) list.scrollTop -= (lr.top - cr.top) + 8;
  else if (cr.bottom > lr.bottom) list.scrollTop += (cr.bottom - lr.bottom) + 8;
}

/* ==========================================================================
   11. CUSTOMER DETAIL
   ========================================================================== */
function openDetail(key) {
  const c = findByKey(key);
  if (!c) return;
  state.activeKey = c.uid;

  $('detail-sub').textContent = c.companyName || c.nameRaw || (c.isLocal ? 'ثبت‌شده توسط بازاریاب' : '');

  const rows = [
    ['نام مشتری', c.name, false],
    ['نام فروشگاه', c.companyName, false],
    ['Customer Code', c.customerCode || 'بدون کد حساب', !!c.customerCode, 'mono'],
    ['Customer Type', `${c.customerType}${c.customerTypeCode ? ' (' + toFa(c.customerTypeCode) + ')' : ''}`, false],
    ['Region Code', c.regionCode ? toFa(c.regionCode) : 'نامشخص', false],
    ['Region Name', c.regionName, false],
    ['استان', c.province, false],
    ['شهر', c.city, false],
    ['تلفن', c.phone, true],
    ['موبایل', c.mobile, true],
    ['مانده حساب', c.balance === null || c.balance === undefined ? '' : toFa(c.balance), false],
    ['نوع فروش', c.salesType, false],
    ['وضعیت پیگیری', c.followUp, false],
    ['منبع رکورد', c.isLocal ? 'ثبت بازاریاب' : 'فایل اکسل', false],
    ['ثبت‌کننده', c.isLocal ? c.addedBy : '', false],
    ['وضعیت موقعیت', locationLabel(c), false],
    ['Latitude', c.lat === null ? '' : c.lat, true, 'mono'],
    ['Longitude', c.lng === null ? '' : c.lng, true, 'mono']
  ];

  $('detail-body').innerHTML = `
    <div class="detail-grid">
      ${rows.map(r => `
        <div class="detail-item">
          <span class="k">${r[0]}</span>
          <span class="v${r[2] ? ' ltr' : ''}${r[3] ? ' ' + r[3] : ''}">${esc(orDash(r[1]))}</span>
        </div>`).join('')}
      <div class="detail-item full">
        <span class="k">آدرس</span>
        <span class="v">${esc(orDash(c.address))}</span>
      </div>
    </div>

    ${c.warnings.length ? `<div class="editor"><h3>هشدارهای کیفیت داده</h3>
      <ul style="margin:0;padding-inline-start:18px;font-size:12px">${c.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''}

    <div id="detail-extra"></div>

    <div class="editor">
      <h3>اصلاح دستی موقعیت (ذخیره در LocalStorage)</h3>
      <div class="editor-row">
        <label>Latitude<input type="number" step="0.000001" id="edit-lat" value="${c.lat === null ? '' : c.lat}"></label>
        <label>Longitude<input type="number" step="0.000001" id="edit-lng" value="${c.lng === null ? '' : c.lng}"></label>
        <button type="button" class="btn btn-primary" id="edit-save">ذخیره موقعیت</button>
        <button type="button" class="btn" id="edit-clear">حذف موقعیت دستی</button>
      </div>
      <p class="editor-note">فایل data/customers.json هرگز تغییر نمی‌کند؛ فقط بازنویسی محلی ذخیره می‌شود.</p>
    </div>`;

  const tel = c.mobile || c.phone;
  $('detail-actions').innerHTML = `
    <button type="button" class="btn" id="act-call" ${tel ? '' : 'disabled'}>تماس</button>
    <button type="button" class="btn btn-primary" id="act-route" ${c.lat === null ? 'disabled' : ''}>مسیریابی روی نقشه</button>
    <button type="button" class="btn" id="act-copy-addr" ${c.address ? '' : 'disabled'}>کپی آدرس</button>
    <button type="button" class="btn" id="act-copy-code" ${c.customerCode ? '' : 'disabled'}>کپی کد مشتری</button>
    <button type="button" class="btn" id="act-show-map" ${c.lat === null ? 'disabled' : ''}>نمایش روی نقشه</button>`;

  $('detail-modal').hidden = false;

  // --- actions ---
  $('act-call').onclick = () => { if (tel) window.location.href = 'tel:' + tel; };
  $('act-route').onclick = () => {
    if (c.lat === null) return;
    // Prefer routing inside the map; fall back to Google Maps if the module is missing.
    if (Hedayat.route) { Hedayat.route.toCustomer(c); return; }
    window.open(`https://www.google.com/maps/dir/?api=1&destination=${c.lat},${c.lng}`, '_blank', 'noopener');
  };
  $('act-copy-addr').onclick = () => copy(c.address, 'آدرس کپی شد');
  $('act-copy-code').onclick = () => copy(c.customerCode, 'کد مشتری کپی شد');
  $('act-show-map').onclick = () => { closeModals(); focusCustomer(c.uid, true); };
  $('edit-save').onclick = () => {
    const lat = parseFloat($('edit-lat').value);
    const lng = parseFloat($('edit-lng').value);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      toast('مختصات وارد‌شده معتبر نیست.');
      return;
    }
    state.overrides[c.uid] = { lat: lat, lng: lng };
    saveOverrides();
    rebuild();
    toast('موقعیت ذخیره شد.');
    openDetail(c.uid);
  };
  $('edit-clear').onclick = () => {
    delete state.overrides[c.uid];
    saveOverrides();
    rebuild();
    toast('بازنویسی دستی حذف شد.');
    openDetail(c.uid);
  };

  // let feature modules (js/editor.js) inject their own panels + footer buttons
  document.dispatchEvent(new CustomEvent('hedayat:detail-open', {
    detail: { uid: c.uid, customer: c }
  }));
}

function locationLabel(c) {
  if (c.lat === null) return 'بدون موقعیت';
  if (c.isLocal) return c.isManual ? 'ثبت بازاریاب (اصلاح‌شده دستی)' : 'ثبت دستی توسط بازاریاب روی نقشه';
  if (c.isManual) return 'موقعیت دستی (ثبت‌شده در مرورگر)';
  return 'تقریبی — ژئوکد شده از آدرس (' + (c.geoPrecision || '—') + ')';
}

/* ==========================================================================
   12. DATA QUALITY
   ========================================================================== */
function computeQuality() {
  const all = state.all;
  const codeCount = {};
  all.forEach(c => {
    if (!c.hasAccountingCode) return;
    codeCount[c.customerCode] = (codeCount[c.customerCode] || 0) + 1;
  });

  // A rep-added record with no accounting code is not "bad data" — it simply is
  // not in the ledger yet. Code checks only run once a code exists.
  const groups = [
    { key: 'invalid-code', label: 'کد مشتری نامعتبر',            severity: 'danger', items: all.filter(c => c.hasAccountingCode && !c.parsed.valid) },
    { key: 'len',          label: 'طول کد مشتری ≠ ۱۰ رقم',       severity: 'danger', items: all.filter(c => c.hasAccountingCode && c.customerCode.length !== 10) },
    { key: 'alpha',        label: 'کد مشتری دارای حرف',          severity: 'danger', items: all.filter(c => c.hasAccountingCode && !/^\d+$/.test(c.customerCode)) },
    { key: 'region',       label: 'کد منطقه نامعتبر',            severity: 'warn',   items: all.filter(c => c.parsed.valid && !REGION_CODES[c.regionCode]) },
    { key: 'type',         label: 'نوع مشتری نامعتبر',           severity: 'warn',   items: all.filter(c => c.hasAccountingCode && !CUSTOMER_TYPES[c.customerTypeCode]) },
    { key: 'coords',       label: 'مختصات نامعتبر',              severity: 'danger', items: all.filter(c => (c.latitude !== null && c.latitude !== undefined) && (Math.abs(c.latitude) > 90 || Math.abs(c.longitude) > 180)) },
    { key: 'noloc',        label: 'مشتری بدون موقعیت',           severity: 'warn',   items: all.filter(c => c.lat === null) },
    { key: 'noaddr',       label: 'آدرس ثبت‌نشده',               severity: 'warn',   items: all.filter(c => !c.hasAddress) },
    { key: 'conflict',     label: 'استان آدرس با کد منطقه ناسازگار', severity: 'warn', items: all.filter(c => c.warnings.includes('استان آدرس با کد منطقه هم‌خوانی ندارد')) },
    { key: 'duplicate',    label: 'مشتری تکراری (کد یکسان)',     severity: 'danger', items: all.filter(c => c.hasAccountingCode && codeCount[c.customerCode] > 1) },
    { key: 'local-noloc',  label: 'ثبت بازاریاب بدون موقعیت',     severity: 'danger', items: all.filter(c => c.isLocal && c.lat === null) },
    { key: 'local-nocode', label: 'ثبت بازاریاب بدون کد حساب',    severity: 'warn',   items: all.filter(c => c.isLocal && !c.customerCode) },
    { key: 'local-nofollow', label: 'ثبت بازاریاب بدون وضعیت پیگیری', severity: 'warn', items: all.filter(c => c.isLocal && !c.followUp) }
  ];
  return groups;
}

function openQuality() {
  const groups = computeQuality();
  const totalIssues = groups.reduce((s, g) => s + g.items.length, 0);
  $('quality-count').textContent = toFa(totalIssues);

  const summary = groups.filter(g => g.items.length).map(g => `
    <div class="q-card">
      <div class="n" style="color:${g.severity === 'danger' ? 'var(--danger)' : 'var(--warn)'}">${toFa(g.items.length)}</div>
      <div class="l">${g.label}</div>
    </div>`).join('');

  const sections = groups.filter(g => g.items.length).map(g => {
    const shown = g.items.slice(0, 25);
    return `
      <div class="q-section">
        <h3><span class="badge ${g.severity === 'danger' ? 'badge-danger' : 'badge-warn'}">${toFa(g.items.length)}</span> ${g.label}</h3>
        <div class="q-list">
          ${shown.map(c => `
            <div class="q-row" data-uid="${esc(c.uid)}">
              <div>
                <div>${esc(c.name || c.nameRaw || c.customerCode || 'بدون نام')}</div>
                <div class="sub">کد: ${esc(c.customerCode || '—')} — ${esc(c.regionName)}</div>
              </div>
              <div class="sub">${esc(c.province || '')}</div>
            </div>`).join('')}
          ${g.items.length > shown.length ? `<div class="q-more">و ${toFa(g.items.length - shown.length)} مورد دیگر…</div>` : ''}
        </div>
      </div>`;
  }).join('');

  $('quality-body').innerHTML = `
    <div class="q-summary">${summary || '<div class="q-card"><div class="n" style="color:var(--ok)">۰</div><div class="l">هیچ مشکل داده‌ای یافت نشد</div></div>'}</div>
    ${sections}
    <div class="q-section">
      <button type="button" class="btn" id="reset-overrides">پاک کردن موقعیت‌های دستی (LocalStorage)</button>
    </div>`;

  $('reset-overrides').onclick = () => {
    state.overrides = {};
    saveOverrides();
    rebuild();
    openQuality();
    toast('موقعیت‌های دستی پاک شد.');
  };
  $('quality-modal').hidden = false;
}

/* ==========================================================================
   13. misc UI
   ========================================================================== */
let toastTimer;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3000);
}
function copy(text, msg) {
  if (!text) return;
  const done = () => toast(msg);
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
}
function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); done(); } catch (e) { toast('کپی ناموفق بود'); }
  document.body.removeChild(ta);
}
function closeModals() {
  document.querySelectorAll('.modal-backdrop').forEach(m => { m.hidden = true; });
}

/* ==========================================================================
   14. EVENTS
   ========================================================================== */
function wireEvents() {
  const onFilterChange = () => { readFilters(true); applyFilters(); };
  ['f-province', 'f-city', 'f-type', 'f-sales', 'f-location', 'f-followup', 'f-source'].forEach(id => {
    $(id).addEventListener('change', onFilterChange);
  });
  // region + region-code stay in sync
  $('f-region').addEventListener('change', e => { $('f-region-code').value = e.target.value; onFilterChange(); });
  $('f-region-code').addEventListener('change', e => { $('f-region').value = e.target.value; onFilterChange(); });

  const onSearch = debounce(() => { readFilters(true); applyFilters(); }, 220);
  $('search').addEventListener('input', () => {
    $('clear-search').hidden = !$('search').value;
    onSearch();
  });
  $('clear-search').addEventListener('click', () => {
    $('search').value = ''; $('clear-search').hidden = true; readFilters(true); applyFilters();
  });

  $('btn-reset-filters').addEventListener('click', () => {
    ['f-province', 'f-city', 'f-region', 'f-region-code', 'f-type', 'f-sales',
     'f-location', 'f-followup', 'f-source'].forEach(id => { $(id).value = ''; });
    $('search').value = ''; $('clear-search').hidden = true;
    readFilters(true); applyFilters();
  });

  $('btn-more').addEventListener('click', renderList);

  // list card click / keyboard
  $('customer-list').addEventListener('click', e => {
    const card = e.target.closest('.cust-card');
    if (!card) return;
    const uid = card.dataset.uid;
    focusCustomer(uid, true);
    openDetail(uid);
  });
  $('customer-list').addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const card = e.target.closest('.cust-card');
    if (!card) return;
    e.preventDefault();
    focusCustomer(card.dataset.uid, true);
    openDetail(card.dataset.uid);
  });

  // popup actions / chips / quality rows (delegated)
  document.addEventListener('click', e => {
    const btn = e.target.closest('[data-detail]');
    if (btn) { openDetail(btn.dataset.detail); return; }

    const routeBtn = e.target.closest('[data-route]');
    if (routeBtn) {
      const c = findByKey(routeBtn.dataset.route);
      if (c && Hedayat.route) Hedayat.route.toCustomer(c);
      return;
    }

    const chip = e.target.closest('[data-clear-chip]');
    if (chip) { clearChip(chip.dataset.clearChip); return; }

    const qrow = e.target.closest('.q-row');
    if (qrow) { closeModals(); focusCustomer(qrow.dataset.uid, true); return; }

    if (e.target.closest('[data-close-modal]')) { closeModals(); }
  });
  document.querySelectorAll('.modal-backdrop').forEach(m => {
    m.addEventListener('mousedown', e => { if (e.target === m) closeModals(); });
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModals(); });

  $('btn-quality').addEventListener('click', openQuality);
  $('btn-fit').addEventListener('click', () => { fitBounds(state.all, true); });
  $('btn-fit-results').addEventListener('click', () => {
    if (!fitBounds(state.filtered, true)) toast('نتیجه‌ای با موقعیت وجود ندارد.');
  });

  initFilterToggle();
}

/* ==========================================================================
   14b. COLLAPSIBLE FILTER PANEL
   The filters take a lot of vertical room; on shorter screens they collapse so
   the customer list stays reachable. The choice is remembered per browser.
   ========================================================================== */
function initFilterToggle() {
  const panel = $('filters-panel');
  const btn = $('btn-toggle-filters');
  if (!panel || !btn) return;

  const KEY = 'hedayat.ui.filtersOpen';
  let stored = null;
  try { stored = localStorage.getItem(KEY); } catch (e) { stored = null; }
  // first visit: open on tall screens, collapsed on laptops
  let open = (stored === null) ? (window.innerHeight >= 880) : (stored === '1');

  function apply() {
    panel.classList.toggle('is-collapsed', !open);
    btn.textContent = open ? 'بستن' : 'نمایش فیلترها';
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    try { localStorage.setItem(KEY, open ? '1' : '0'); } catch (e) { /* ignore */ }
  }

  btn.addEventListener('click', () => { open = !open; apply(); });
  apply();
}

function clearChip(key) {
  if (key === 'query') { $('search').value = ''; $('clear-search').hidden = true; }
  else if (key === 'region') { $('f-region').value = ''; $('f-region-code').value = ''; }
  else if (key === 'location') { $('f-location').value = ''; }
  else if (key === 'province') { $('f-province').value = ''; }
  else if (key === 'city') { $('f-city').value = ''; }
  else if (key === 'type') { $('f-type').value = ''; }
  else if (key === 'sales') { $('f-sales').value = ''; }
  else if (key === 'followUp') { $('f-followup').value = ''; }
  else if (key === 'source') { $('f-source').value = ''; }
  readFilters(true); applyFilters();
}

/* ==========================================================================
   15. DEEP LINKS — shareable URLs like ?q=مشهد  ?region=28  ?code=1200010002
   ========================================================================== */
function readDeepLink() {
  const p = new URLSearchParams(location.search);
  const region = p.get('region');
  return {
    q: p.get('q') || '',
    province: p.get('province') || '',
    city: p.get('city') || '',
    type: p.get('type') || '',
    sales: p.get('sales') || '',
    loc: p.get('loc') || '',
    region: (region && REGION_CODES[region]) ? region : '',
    code: p.get('code') || ''
  };
}

// Must run AFTER buildFilterOptions(), otherwise the selects have no matching
// <option> yet and assigning .value is silently ignored.
function applyDeepLink(dl) {
  if (!dl) return;
  $('search').value = dl.q;
  $('clear-search').hidden = !dl.q;
  $('f-province').value = dl.province;
  $('f-city').value = dl.city;
  $('f-type').value = dl.type;
  $('f-sales').value = dl.sales;
  $('f-location').value = dl.loc;
  $('f-region').value = dl.region;
  $('f-region-code').value = dl.region;
}

/* ==========================================================================
   16. BOOT
   ========================================================================== */
function rebuild(deepLink) {
  // imported dataset + whatever the feature modules contribute (rep records)
  let raw = state.raw;
  Hedayat.modules.forEach(m => {
    if (!m.extraCustomers) return;
    try {
      const extra = m.extraCustomers();
      if (extra && extra.length) raw = raw.concat(extra);
    } catch (e) { console.warn('[module ' + m.name + '] extraCustomers failed', e); }
  });

  state.all = raw.map(enrich);
  buildFilterOptions();
  applyDeepLink(deepLink);
  readFilters();
  applyFilters();
  renderStats();
  state.quality = computeQuality();
  $('quality-count').textContent = toFa(state.quality.reduce((s, g) => s + g.items.length, 0));

  Hedayat.modules.forEach(m => {
    if (!m.onRebuild) return;
    try { m.onRebuild(); } catch (e) { console.warn('[module ' + m.name + '] onRebuild failed', e); }
  });
}

function runModuleHook(hook, label) {
  Hedayat.modules.forEach(m => {
    if (!m[hook]) return;
    try { m[hook](); }
    catch (e) { console.error('[module ' + m.name + '] ' + label + ' failed', e); }
  });
}

async function boot() {
  initMap();
  renderLegend();
  loadOverrides();

  // modules must be initialised before the first rebuild so their data is merged
  runModuleHook('init', 'init');

  try {
    state.raw = await loadCustomers();
  } catch (err) {
    $('list-empty').hidden = false;
    $('list-empty').textContent = 'بارگذاری داده مشتریان ناموفق بود. فایل data/customers.json را بررسی کنید.';
    console.error(err);
    return;
  }

  wireEvents();
  const deepLink = readDeepLink();
  rebuild(deepLink);

  runModuleHook('afterData', 'afterData');

  if (deepLink.code) { focusCustomer(deepLink.code, true); openDetail(deepLink.code); }
  else {
    // frame the actual dataset instead of a hard-coded centre/zoom
    if (!fitBounds(state.all, false)) state.map.setView(CONFIG.mapCenter, CONFIG.mapZoom);
    $('map-hint').hidden = false;
    $('map-hint').innerHTML = 'نقشه آماده است — از فیلترها، جستجو یا «افزودن مشتری» استفاده کنید.';
  }
}

document.addEventListener('DOMContentLoaded', boot);
