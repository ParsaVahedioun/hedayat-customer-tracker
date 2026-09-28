/* ==========================================================================
   Hedayat Customer Tracker — js/store.js
   --------------------------------------------------------------------------
   Local data layer for everything the sales rep (بازاریاب) creates:
     • the rep profile itself
     • customers the rep adds manually on the map
     • marketing info (phone / follow-up status / address) edited by the rep
     • free-text notes, kept as an append-only timeline

   Everything lives in LocalStorage. `data/customers.json` is NEVER written.
   Loaded after app.js; registers itself through window.Hedayat.
   ========================================================================== */
'use strict';

const Store = (function () {

  const KEYS = {
    rep:       'hedayat.rep.v1',
    reps:      'hedayat.reps.v1',
    customers: 'hedayat.local.customers.v1',
    edits:     'hedayat.edits.v1'
  };

  let rep = null;        // { name, code, regionCode, at }
  let reps = [];         // known reps, most recent first
  let customers = [];    // rep-added customers (raw records with uid)
  let edits = {};        // { uid: { fields:{}, notes:[], updatedAt } }

  /* ---------------------------------------------------------------- storage */
  function read(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      const val = JSON.parse(raw);
      return (val === null || val === undefined) ? fallback : val;
    } catch (e) {
      console.warn('[store] unreadable', key, e);
      return fallback;
    }
  }

  function write(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      console.warn('[store] not saved', key, e);
      toast('ذخیره‌سازی در مرورگر ناموفق بود — حافظه مرورگر پر است؟');
      return false;
    }
  }

  function nowISO() { return new Date().toISOString(); }

  function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function load() {
    rep = read(KEYS.rep, null);
    if (rep && typeof rep !== 'object') rep = null;

    reps = read(KEYS.reps, []);
    if (!Array.isArray(reps)) reps = [];

    customers = read(KEYS.customers, []);
    if (!Array.isArray(customers)) customers = [];

    edits = read(KEYS.edits, {});
    if (typeof edits !== 'object' || edits === null || Array.isArray(edits)) edits = {};
  }

  /* ------------------------------------------------------------ rep profile */
  function getRep() { return rep; }

  function setRep(next) {
    const name = next && next.name ? String(next.name).trim() : '';
    if (!name) { rep = null; write(KEYS.rep, null); return null; }

    rep = {
      name: name,
      code: String(next.code || '').trim(),
      regionCode: String(next.regionCode || ''),
      at: nowISO()
    };
    write(KEYS.rep, rep);

    const entry = { name: rep.name, code: rep.code, regionCode: rep.regionCode, lastSeen: rep.at };
    const i = reps.findIndex(r => r.name === rep.name && (r.code || '') === rep.code);
    if (i === -1) reps.unshift(entry); else reps[i] = Object.assign({}, reps[i], entry);
    reps = reps.slice(0, 12);
    write(KEYS.reps, reps);

    return rep;
  }

  function logout() {
    rep = null;
    write(KEYS.rep, null);
  }

  function listReps() { return reps.slice(); }

  function repName() { return rep ? rep.name : ''; }

  /* --------------------------------------------------------- local customers */
  function localCustomers() { return customers.slice(); }

  function addLocalCustomer(input) {
    const uid = 'n:' + newId();
    const c = {
      uid: uid,
      localId: uid.slice(2),
      isLocal: true,
      source: 'rep',
      customerCode: String(input.customerCode || '').trim(),
      name: String(input.name || '').trim(),
      companyName: String(input.companyName || '').trim(),
      phone: String(input.phone || '').trim(),
      mobile: String(input.mobile || '').trim(),
      province: String(input.province || '').trim(),
      city: String(input.city || '').trim(),
      regionCode: String(input.regionCode || '').trim(),
      address: String(input.address || '').trim(),
      salesType: String(input.salesType || '').trim(),
      latitude: Number(input.latitude),
      longitude: Number(input.longitude),
      locationStatus: 'manual',
      geoPrecision: 'ثبت دستی توسط بازاریاب',
      warnings: [],
      addedBy: rep ? rep.name : '',
      addedByCode: rep ? rep.code : '',
      addedAt: nowISO()
    };

    customers.push(c);
    write(KEYS.customers, customers);

    if (input.note && String(input.note).trim()) addNote(uid, input.note);
    if (input.followUp) setEdit(uid, { followUp: input.followUp });

    return c;
  }

  function removeLocalCustomer(custUid) {
    const before = customers.length;
    customers = customers.filter(c => c.uid !== custUid);
    if (customers.length === before) return false;
    write(KEYS.customers, customers);
    if (edits[custUid]) { delete edits[custUid]; write(KEYS.edits, edits); }
    return true;
  }

  function hasLocalCustomerWithCode(code) {
    const wanted = String(code || '').trim();
    if (!wanted) return false;
    return customers.some(c => c.customerCode === wanted);
  }

  /* ------------------------------------------- edits (info + notes timeline) */
  function emptyEdit() { return { fields: {}, notes: [], updatedAt: '' }; }

  function getEdit(custUid) {
    const e = edits[custUid];
    if (!e) return emptyEdit();
    return {
      fields: Object.assign({}, e.fields || {}),
      notes: Array.isArray(e.notes) ? e.notes.slice() : [],
      updatedAt: e.updatedAt || ''
    };
  }

  function setEdit(custUid, patch) {
    if (!custUid) return emptyEdit();
    const e = edits[custUid] || emptyEdit();
    e.fields = Object.assign({}, e.fields, patch || {});
    Object.keys(e.fields).forEach(k => {
      const v = e.fields[k];
      if (v === '' || v === null || v === undefined) delete e.fields[k];
    });
    e.notes = Array.isArray(e.notes) ? e.notes : [];
    e.updatedAt = nowISO();
    edits[custUid] = e;
    write(KEYS.edits, edits);
    return e;
  }

  function addNote(custUid, text) {
    const body = String(text || '').trim();
    if (!custUid || !body) return null;
    const e = edits[custUid] || emptyEdit();
    const note = {
      id: 'n' + newId(),
      text: body,
      rep: rep ? rep.name : '',
      repCode: rep ? rep.code : '',
      at: nowISO()
    };
    e.notes = (Array.isArray(e.notes) ? e.notes : []).concat([note]);
    e.fields = e.fields || {};
    e.updatedAt = note.at;
    edits[custUid] = e;
    write(KEYS.edits, edits);
    return note;
  }

  function deleteNote(custUid, noteId) {
    const e = edits[custUid];
    if (!e || !Array.isArray(e.notes)) return false;
    const before = e.notes.length;
    e.notes = e.notes.filter(n => n.id !== noteId);
    if (e.notes.length === before) return false;
    e.updatedAt = nowISO();
    edits[custUid] = e;
    write(KEYS.edits, edits);
    return true;
  }

  function counts() {
    const noted = Object.keys(edits).filter(k => (edits[k].notes || []).length > 0).length;
    return { local: customers.length, noted: noted };
  }

  /* ------------------------------------------------------- export / import */
  function exportBundle() {
    return {
      app: 'hedayat-customer-tracker',
      version: 2,
      exportedAt: nowISO(),
      rep: rep,
      customers: customers,
      edits: edits
    };
  }

  /**
   * Merge an exported bundle into the local store.
   * Records are matched by uid, so importing twice is safe (idempotent).
   */
  function importBundle(bundle) {
    if (!bundle || bundle.app !== 'hedayat-customer-tracker') {
      return { ok: false, reason: 'فایل متعلق به این برنامه نیست.' };
    }
    const incoming = Array.isArray(bundle.customers) ? bundle.customers : [];
    const incomingEdits = (bundle.edits && typeof bundle.edits === 'object') ? bundle.edits : {};

    let addedCustomers = 0, updatedCustomers = 0;
    const index = {};
    customers.forEach(c => { index[c.uid] = c; });

    incoming.forEach(c => {
      if (!c || !c.uid) return;
      if (index[c.uid]) { Object.assign(index[c.uid], c); updatedCustomers++; }
      else { customers.push(c); index[c.uid] = c; addedCustomers++; }
    });

    let mergedNotes = 0;
    Object.keys(incomingEdits).forEach(k => {
      const src = incomingEdits[k] || {};
      const dst = edits[k] || emptyEdit();
      dst.fields = Object.assign({}, dst.fields || {}, src.fields || {});
      const have = {};
      (dst.notes || []).forEach(n => { have[n.id] = true; });
      (src.notes || []).forEach(n => {
        if (!n || !n.id || have[n.id]) return;
        dst.notes = (dst.notes || []).concat([n]);
        have[n.id] = true;
        mergedNotes++;
      });
      if (!dst.updatedAt || (src.updatedAt && src.updatedAt > dst.updatedAt)) dst.updatedAt = src.updatedAt || dst.updatedAt;
      edits[k] = dst;
    });

    write(KEYS.customers, customers);
    write(KEYS.edits, edits);

    return {
      ok: true,
      addedCustomers: addedCustomers,
      updatedCustomers: updatedCustomers,
      mergedNotes: mergedNotes,
      total: customers.length
    };
  }

  function clearAll() {
    customers = [];
    edits = {};
    write(KEYS.customers, customers);
    write(KEYS.edits, edits);
  }

  /* ------------------------------------------------------------- file output */
  function stamp() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
  }

  function download(filename, text, mime) {
    const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function exportJSON() {
    const bundle = exportBundle();
    download('hedayat-rep-data-' + stamp() + '.json', JSON.stringify(bundle, null, 2), 'application/json;charset=utf-8');
    return bundle;
  }

  function csvCell(v) {
    const s = (v === null || v === undefined) ? '' : String(v);
    return '"' + s.replace(/"/g, '""') + '"';
  }

  /**
   * CSV of every record the reps touched (added or annotated) — the file to
   * hand to management. UTF-8 BOM so Excel renders Persian correctly.
   */
  function exportCSV() {
    const rows = [['کد مشتری', 'نام مشتری', 'فروشگاه', 'موبایل', 'تلفن', 'استان', 'شهر',
                   'کد منطقه', 'منطقه', 'آدرس', 'نوع فروش', 'وضعیت پیگیری',
                   'آخرین یادداشت', 'تعداد یادداشت', 'بازاریاب', 'تاریخ ثبت',
                   'Latitude', 'Longitude', 'نوع رکورد']];

    state.all.filter(c => c.isLocal || c.noteCount > 0 || c.editedAt).forEach(c => {
      const last = c.notes && c.notes.length ? c.notes[c.notes.length - 1] : null;
      rows.push([
        c.customerCode,
        c.name || '',
        c.companyName || '',
        c.mobile || '',
        c.phone || '',
        c.province || '',
        c.city || '',
        c.regionCode || '',
        c.regionName || '',
        c.address || '',
        c.salesType || '',
        c.followUp || '',
        last ? last.text : '',
        (c.notes || []).length,
        c.addedBy || (last ? last.rep : ''),
        c.addedAt || (last ? last.at : ''),
        c.lat === null ? '' : c.lat,
        c.lng === null ? '' : c.lng,
        c.isLocal ? 'ثبت بازاریاب' : 'داده اصلی + یادداشت'
      ]);
    });

    const csv = '\ufeff' + rows.map(r => r.map(csvCell).join(',')).join('\r\n');
    download('hedayat-rep-report-' + stamp() + '.csv', csv, 'text/csv;charset=utf-8');
    return rows.length - 1;
  }

  return {
    KEYS: KEYS,
    load: load,
    getRep: getRep,
    setRep: setRep,
    logout: logout,
    listReps: listReps,
    repName: repName,
    localCustomers: localCustomers,
    addLocalCustomer: addLocalCustomer,
    removeLocalCustomer: removeLocalCustomer,
    hasLocalCustomerWithCode: hasLocalCustomerWithCode,
    getEdit: getEdit,
    setEdit: setEdit,
    addNote: addNote,
    deleteNote: deleteNote,
    counts: counts,
    exportBundle: exportBundle,
    importBundle: importBundle,
    exportJSON: exportJSON,
    exportCSV: exportCSV,
    clearAll: clearAll,
    stamp: stamp
  };
})();

/* ---------------------------------------------------------------- register */
Hedayat.store = Store;

Hedayat.register({
  name: 'store',

  init() {
    Store.load();
  },

  // rep-added customers are appended to the imported dataset on every rebuild
  extraCustomers() {
    return Store.localCustomers();
  }
});

/* Apply rep edits (marketing fields + notes) on top of every customer. */
Hedayat.onEnrich(function (c) {
  const ed = Store.getEdit(c.uid);

  c.notes = ed.notes;
  c.noteCount = ed.notes.length;
  c.editedAt = ed.updatedAt;

  const f = ed.fields;
  if (f.followUp) c.followUp = f.followUp;
  if (f.mobile) c.mobile = f.mobile;
  if (f.phone) c.phone = f.phone;
  if (f.address) c.address = f.address;
  if (f.salesType) c.salesType = f.salesType;
  if (f.province) c.province = f.province;
  if (f.city) c.city = f.city;

  c.hasAddress = !!(c.address && String(c.address).trim());
});
