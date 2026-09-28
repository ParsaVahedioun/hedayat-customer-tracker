/* ==========================================================================
   Hedayat Customer Tracker — js/editor.js
   --------------------------------------------------------------------------
   Everything the sales rep types:

     1. Rep profile        — name + staff code + area (no password, it is only
                             a label on the records the rep creates)
     2. Add a customer     — pick the spot on the map, fill the form, save
     3. Marketing info     — phone / follow-up status / address / sales type
                             edited on ANY customer (imported or rep-added)
     4. Notes              — append-only timeline per customer
     5. Export / import    — JSON (full backup) and CSV (report for management)

   Loaded after app.js and store.js; registers itself through window.Hedayat.
   ========================================================================== */
'use strict';

const Editor = (function () {

  let draft = null;          // { lat, lng } of the spot picked on the map
  let addOpen = false;

  /* ------------------------------------------------------------- utilities */
  function hide(id) { $(id).hidden = true; }

  function faDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    try {
      return d.toLocaleDateString('fa-IR', { year: 'numeric', month: '2-digit', day: '2-digit' }) +
             ' — ' + d.toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' });
    } catch (e) {
      return d.toISOString().slice(0, 16).replace('T', ' ');
    }
  }

  function pickOnMap(message, cb) {
    if (Hedayat.route) return Hedayat.route.pickPoint(message, cb);
    toast(message);
    state.map.once('click', e => cb(e.latlng));
  }

  /* ---------------------------------------------------------- select filling */
  function fillRegionSelect(sel, emptyLabel) {
    sel.innerHTML = '<option value="">' + esc(emptyLabel) + '</option>';
    REGION_GROUPS.forEach(group => {
      const og = document.createElement('optgroup');
      og.label = group.label;
      group.codes.forEach(code => {
        if (!REGION_CODES[code]) return;
        og.appendChild(new Option(toFa(code) + ' — ' + REGION_CODES[code], code));
      });
      sel.appendChild(og);
    });
  }

  function followUpOptions(selected) {
    return ['<option value="">ثبت نشده</option>'].concat(
      CONFIG.followUps.map(v =>
        '<option value="' + esc(v) + '"' + (v === selected ? ' selected' : '') + '>' + esc(v) + '</option>')
    ).join('');
  }

  function fillFollowUpFilter() {
    const sel = $('f-followup');
    const keep = sel.value;
    sel.innerHTML = '<option value="">همه</option><option value="__none__">بدون وضعیت</option>' +
      CONFIG.followUps.map(v => '<option value="' + esc(v) + '">' + esc(v) + '</option>').join('');
    sel.value = keep;
  }

  function fillDatalists() {
    const provinces = new Set(), cities = new Set(), sales = new Set();
    state.all.forEach(c => {
      if (c.province && c.province !== 'نامشخص') provinces.add(c.province);
      if (c.city) cities.add(c.city);
      if (c.salesType) sales.add(c.salesType);
    });
    const fill = (id, set) => {
      $(id).innerHTML = [...set]
        .sort((a, b) => a.localeCompare(b, 'fa'))
        .map(v => '<option value="' + esc(v) + '"></option>').join('');
    };
    fill('dl-province', provinces);
    fill('dl-city', cities);
    fill('dl-sales', sales);
  }

  /* ------------------------------------------------------------ rep profile */
  function requireRep() {
    if (Store.getRep()) return true;
    toast('برای ثبت اطلاعات، ابتدا نام بازاریاب را وارد کنید.');
    openRepModal();
    return false;
  }

  function renderRepUI() {
    const rep = Store.getRep();
    const counts = Store.counts();

    $('rep-chip-name').textContent = rep ? rep.name : 'ورود بازاریاب';
    $('btn-rep').classList.toggle('is-set', !!rep);
    $('rep-panel').classList.toggle('is-set', !!rep);

    if (rep) {
      const region = (rep.regionCode && REGION_CODES[rep.regionCode]) ? REGION_CODES[rep.regionCode] : 'بدون منطقه';
      $('rep-panel-name').textContent = rep.name;
      $('rep-panel-meta').textContent =
        (rep.code ? rep.code + ' · ' : '') + region + ' · ' +
        toFa(counts.local) + ' ثبت · ' + toFa(counts.noted) + ' یادداشت';
    } else {
      $('rep-panel-name').textContent = 'ورود بازاریاب';
      $('rep-panel-meta').textContent = 'برای ثبت مشتری یا یادداشت، نام خود را وارد کنید';
    }

    $('btn-show-mine').disabled = !rep;
  }

  function openRepModal() {
    const rep = Store.getRep();
    $('rep-name').value = rep ? rep.name : '';
    $('rep-code').value = rep ? rep.code : '';

    if (!$('rep-region').options.length) fillRegionSelect($('rep-region'), 'ثبت نشده');
    $('rep-region').value = (rep && rep.regionCode) ? rep.regionCode : '';

    const known = Store.listReps();
    $('rep-known').innerHTML = known.length
      ? '<span class="rep-known-label">بازاریاب‌های قبلی:</span>' +
        known.map(r =>
          '<button type="button" class="rep-pill" data-rep="' + esc(r.name) + '"' +
          ' data-rep-code="' + esc(r.code || '') + '"' +
          ' data-rep-region="' + esc(r.regionCode || '') + '">' + esc(r.name) + '</button>'
        ).join('')
      : '';

    $('rep-logout').hidden = !rep;
    $('rep-modal').hidden = false;
    setTimeout(() => $('rep-name').focus(), 60);
  }

  function saveRep() {
    const name = $('rep-name').value.trim();
    if (!name) { toast('نام بازاریاب را وارد کنید.'); $('rep-name').focus(); return; }
    Store.setRep({ name: name, code: $('rep-code').value.trim(), regionCode: $('rep-region').value });
    hide('rep-modal');
    renderRepUI();
    toast('خوش آمدید، ' + name + '!');
  }

  function logoutRep() {
    Store.logout();
    hide('rep-modal');
    renderRepUI();
    toast('از پروفایل بازاریاب خارج شدید.');
  }

  /* ---------------------------------------------------------- add customer */
  function startAdd() {
    if (!requireRep()) return;
    if (Hedayat.route && Hedayat.route.isPicking()) Hedayat.route.cancelPick();
    closeModals();
    toast('محل مشتری را روی نقشه انتخاب کنید.');
    pickOnMap('محل مشتری جدید را روی نقشه انتخاب کنید', function (latlng) {
      draft = { lat: latlng.lat, lng: latlng.lng };
      openAddModal();
    });
  }

  function updateCoordChip() {
    const lat = parseFloat($('a-lat').value);
    const lng = parseFloat($('a-lng').value);
    const ok = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
    $('add-coord-chip').innerHTML = ok
      ? '<span class="coord-ok">موقعیت انتخاب‌شده روی نقشه:</span>' +
        '<span class="coord-val" dir="ltr">' + lat.toFixed(6) + ' , ' + lng.toFixed(6) + '</span>'
      : '<span class="coord-bad">هنوز موقعیتی روی نقشه انتخاب نشده است — دکمه «تغییر موقعیت روی نقشه» را بزنید.</span>';
  }

  function openAddModal() {
    addOpen = true;
    fillDatalists();
    if (!$('a-region').options.length) fillRegionSelect($('a-region'), 'ثبت نشده');
    if (!$('a-followup').options.length) $('a-followup').innerHTML = followUpOptions('');

    $('a-lat').value = draft ? draft.lat.toFixed(6) : '';
    $('a-lng').value = draft ? draft.lng.toFixed(6) : '';
    updateCoordChip();

    const rep = Store.getRep();
    $('add-rep-note').textContent = rep ? ('ثبت به نام ' + rep.name) : '';
    $('add-modal').hidden = false;
    setTimeout(() => $('a-name').focus(), 60);
  }

  function collectAddForm() {
    return {
      name: $('a-name').value.trim(),
      companyName: $('a-shop').value.trim(),
      customerCode: normalizeFa($('a-code').value).replace(/\s+/g, ''),
      mobile: normalizeFa($('a-mobile').value).replace(/\s+/g, ''),
      phone: normalizeFa($('a-phone').value).replace(/\s+/g, ''),
      province: $('a-province').value.trim(),
      city: $('a-city').value.trim(),
      regionCode: $('a-region').value,
      address: $('a-address').value.trim(),
      salesType: $('a-sales').value.trim(),
      followUp: $('a-followup').value,
      note: $('a-note').value.trim(),
      latitude: parseFloat($('a-lat').value),
      longitude: parseFloat($('a-lng').value)
    };
  }

  function restoreAddForm(v) {
    $('a-name').value = v.name || '';
    $('a-shop').value = v.companyName || '';
    $('a-code').value = v.customerCode || '';
    $('a-mobile').value = v.mobile || '';
    $('a-phone').value = v.phone || '';
    $('a-province').value = v.province || '';
    $('a-city').value = v.city || '';
    $('a-region').value = v.regionCode || '';
    $('a-address').value = v.address || '';
    $('a-sales').value = v.salesType || '';
    $('a-followup').value = v.followUp || '';
    $('a-note').value = v.note || '';
    $('a-lat').value = draft ? draft.lat.toFixed(6) : '';
    $('a-lng').value = draft ? draft.lng.toFixed(6) : '';
    updateCoordChip();
  }

  function repick() {
    const keep = collectAddForm();
    hide('add-modal');
    pickOnMap('محل جدید مشتری را روی نقشه انتخاب کنید', function (latlng) {
      draft = { lat: latlng.lat, lng: latlng.lng };
      restoreAddForm(keep);
      $('add-modal').hidden = false;
    });
  }

  function resetFiltersAfterAdd(uid) {
    if (state.filtered.some(c => c.uid === uid)) return;
    ['f-province', 'f-city', 'f-region', 'f-region-code', 'f-type', 'f-sales',
     'f-location', 'f-followup', 'f-source'].forEach(id => { $(id).value = ''; });
    $('search').value = '';
    $('clear-search').hidden = true;
    readFilters();
    applyFilters();
  }

  function saveAdd() {
    if (!requireRep()) return;
    const d = collectAddForm();

    if (!d.name) { toast('نام مشتری را وارد کنید.'); $('a-name').focus(); return; }

    if (!Number.isFinite(d.latitude) || !Number.isFinite(d.longitude) ||
        Math.abs(d.latitude) > 90 || Math.abs(d.longitude) > 180) {
      toast('موقعیت مشتری انتخاب نشده است — «تغییر موقعیت روی نقشه» را بزنید.');
      return;
    }

    // The accounting code is never guessed or corrected — only warned about.
    if (d.customerCode) {
      if (!/^\d{10}$/.test(d.customerCode)) {
        if (!confirm('کد واردشده ۱۰ رقمی نیست و با قالب کد حساب هم‌خوانی ندارد.\nبا همین شکل ذخیره شود؟')) return;
      } else if (state.all.some(c => c.customerCode === d.customerCode)) {
        if (!confirm('مشتری‌ای با این کد حساب از قبل در فهرست وجود دارد.\nبا این حال ثبت شود؟')) return;
      }
    }

    const created = Store.addLocalCustomer(d);
    addOpen = false;
    draft = null;
    closeModals();

    state.pinKey = created.uid;   // show it at the top of the sidebar list
    rebuild();
    renderRepUI();
    resetFiltersAfterAdd(created.uid);

    focusCustomer(created.uid, true);
    openDetail(created.uid);
    toast('مشتری «' + created.name + '» ثبت شد.');
  }

  /* ------------------------------------------- marketing info + notes panel */
  function notesHtml(notes) {
    if (!notes.length) return '<p class="note-empty">هنوز یادداشتی برای این مشتری ثبت نشده است.</p>';
    return notes.slice().reverse().map(n =>
      '<div class="note-item">' +
        '<div class="note-head">' +
          '<span class="note-rep">' + esc(n.rep || 'نامشخص') + '</span>' +
          '<span class="note-date">' + esc(faDate(n.at)) + '</span>' +
          '<button type="button" class="icon-btn note-del" data-del-note="' + esc(n.id) + '" title="حذف یادداشت">&times;</button>' +
        '</div>' +
        '<div class="note-text">' + esc(n.text) + '</div>' +
      '</div>'
    ).join('');
  }

  function renderDetailPanel(c) {
    const host = $('detail-extra');
    if (!host) return;

    const ed = Store.getEdit(c.uid);
    const f = ed.fields;
    const rep = Store.getRep();

    host.innerHTML =
      '<div class="editor">' +
        '<h3>اطلاعات بازاریابی <span class="badge badge-muted">ذخیره در مرورگر</span></h3>' +
        '<div class="form-grid compact">' +
          '<label class="form-field"><span>موبایل</span>' +
            '<input type="text" id="m-mobile" dir="ltr" value="' + esc(f.mobile || c.mobile || '') + '"></label>' +
          '<label class="form-field"><span>تلفن ثابت</span>' +
            '<input type="text" id="m-phone" dir="ltr" value="' + esc(f.phone || c.phone || '') + '"></label>' +
          '<label class="form-field"><span>وضعیت پیگیری</span>' +
            '<select id="m-followup">' + followUpOptions(f.followUp || c.followUp || '') + '</select></label>' +
          '<label class="form-field"><span>نوع فروش</span>' +
            '<input type="text" id="m-sales" value="' + esc(f.salesType || c.salesType || '') + '"></label>' +
          '<label class="form-field full"><span>آدرس</span>' +
            '<textarea id="m-address" rows="2">' + esc(f.address || c.address || '') + '</textarea></label>' +
        '</div>' +
        '<div class="editor-actions">' +
          '<button type="button" class="btn btn-primary" id="m-save">ذخیره اطلاعات</button>' +
          '<button type="button" class="btn" id="m-reset">بازگردانی مقادیر اصلی</button>' +
        '</div>' +
        '<p class="editor-note">این مقادیر روی داده اصلی اکسل سوار می‌شوند؛ فایل ' +
          '<span dir="ltr">data/customers.json</span> هرگز تغییر نمی‌کند.</p>' +
      '</div>' +

      '<div class="editor">' +
        '<h3>یادداشت‌های بازاریاب <span class="badge badge-ok">' + toFa(ed.notes.length) + '</span></h3>' +
        '<div class="note-list">' + notesHtml(ed.notes) + '</div>' +
        '<textarea id="m-new-note" rows="2" placeholder="یادداشت جدید: نتیجه تماس، سفارش احتمالی، آدرس دقیق‌تر…"></textarea>' +
        '<div class="editor-actions">' +
          '<button type="button" class="btn btn-primary" id="m-add-note">افزودن یادداشت</button>' +
          '<span class="foot-note">' +
            (rep ? 'ثبت به نام ' + esc(rep.name) : 'برای درج نام شما، پروفایل بازاریاب را وارد کنید') +
          '</span>' +
        '</div>' +
      '</div>';

    /* --- marketing info --- */
    $('m-save').onclick = function () {
      Store.setEdit(c.uid, {
        mobile: normalizeFa($('m-mobile').value).trim(),
        phone: normalizeFa($('m-phone').value).trim(),
        followUp: $('m-followup').value,
        salesType: $('m-sales').value.trim(),
        address: $('m-address').value.trim()
      });
      rebuild();
      openDetail(c.uid);
      toast('اطلاعات بازاریابی ذخیره شد.');
    };

    $('m-reset').onclick = function () {
      if (!confirm('مقادیر بازاریابی این مشتری به حالت اولیه برگردد؟\n(یادداشت‌ها حذف نمی‌شوند)')) return;
      Store.setEdit(c.uid, { mobile: '', phone: '', followUp: '', salesType: '', address: '' });
      rebuild();
      openDetail(c.uid);
      toast('مقادیر بازاریابی به حالت اولیه برگشت.');
    };

    /* --- notes --- */
    $('m-add-note').onclick = function () {
      if (!requireRep()) return;
      const text = $('m-new-note').value;
      if (!text.trim()) { toast('متن یادداشت خالی است.'); $('m-new-note').focus(); return; }
      Store.addNote(c.uid, text);
      rebuild();
      openDetail(c.uid);
      toast('یادداشت ثبت شد.');
    };

    host.querySelectorAll('[data-del-note]').forEach(btn => {
      btn.onclick = function () {
        if (!confirm('این یادداشت حذف شود؟')) return;
        Store.deleteNote(c.uid, btn.dataset.delNote);
        rebuild();
        openDetail(c.uid);
        toast('یادداشت حذف شد.');
      };
    });

    /* --- footer: delete a rep-added customer --- */
    if (c.isLocal) {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn btn-danger';
      del.textContent = 'حذف ثبت بازاریاب';
      del.onclick = function () {
        if (!confirm('این مشتری که توسط بازاریاب ثبت شده حذف شود؟\n(فقط از همین مرورگر حذف می‌شود و قابل بازگشت نیست)')) return;
        Store.removeLocalCustomer(c.uid);
        closeModals();
        rebuild();
        renderRepUI();
        toast('ثبت بازاریاب حذف شد.');
      };
      $('detail-actions').appendChild(del);
    }
  }

  /* ------------------------------------------------------- export / import */
  function dataStat(label, value) {
    return '<div class="data-stat"><span class="k">' + esc(label) + '</span>' +
           '<span class="v">' + esc(value) + '</span></div>';
  }

  function openDataModal() {
    const rep = Store.getRep();
    const counts = Store.counts();
    const withNotes = state.all.filter(c => c.noteCount > 0).length;
    const manual = Object.keys(state.overrides).length;

    $('data-stats').innerHTML =
      dataStat('مشتری ثبت‌شده', toFa(counts.local)) +
      dataStat('مشتری یادداشت‌دار', toFa(withNotes)) +
      dataStat('موقعیت دستی', toFa(manual)) +
      dataStat('بازاریاب فعلی', rep ? rep.name : 'وارد نشده');

    $('data-modal').hidden = false;
  }

  function clearLocal() {
    if (!confirm('همه مشتری‌های ثبت‌شده، یادداشت‌ها و اطلاعات بازاریابی این مرورگر پاک شود؟')) return;
    if (!confirm('این کار قابل بازگشت نیست. اگر پشتیبان نگرفته‌اید ابتدا «خروجی JSON» بگیرید.\nادامه می‌دهید؟')) return;
    Store.clearAll();
    rebuild();
    renderRepUI();
    openDataModal();
    toast('داده‌های بازاریاب پاک شد.');
  }

  function showMine() {
    const rep = Store.getRep();
    if (!rep) { openRepModal(); return; }
    $('f-source').value = 'mine';
    readFilters();
    applyFilters();
    const n = state.filtered.length;
    toast(n ? (toFa(n) + ' مشتری ثبت‌شده به نام ' + rep.name)
            : 'شما هنوز مشتری‌ای ثبت نکرده‌اید.');
  }

  function exportJSON() {
    const bundle = Store.exportJSON();
    const n = (bundle.customers || []).length;
    toast(n ? ('خروجی JSON با ' + toFa(n) + ' مشتری ثبت‌شده ساخته شد.')
            : 'خروجی ساخته شد (هنوز مشتری‌ای ثبت نشده است).');
  }

  function exportCSV() {
    const n = Store.exportCSV();
    toast(n ? (toFa(n) + ' رکورد در فایل CSV ذخیره شد.')
            : 'رکوردی از بازاریاب ثبت نشده است — فایل خالی ساخته شد.');
  }

  function importJSON() { $('import-file').click(); }

  function onImportFile(ev) {
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function () {
      let bundle;
      try { bundle = JSON.parse(String(reader.result)); }
      catch (e) { toast('فایل خوانده نشد — ساختار JSON نامعتبر است.'); return; }

      const r = Store.importBundle(bundle);
      if (!r.ok) { toast(r.reason); return; }

      rebuild();
      renderRepUI();
      openDataModal();
      toast('ورود داده انجام شد: ' + toFa(r.addedCustomers) + ' مشتری جدید، ' +
            toFa(r.updatedCustomers) + ' به‌روزرسانی، ' + toFa(r.mergedNotes) + ' یادداشت.');
    };
    reader.onerror = function () { toast('خواندن فایل ناموفق بود.'); };
    reader.readAsText(file);
    ev.target.value = '';
  }

  /* -------------------------------------------------------------- lifecycle */
  function init() {
    $('btn-rep').addEventListener('click', openRepModal);
    $('btn-rep-change').addEventListener('click', openRepModal);
    $('rep-save').addEventListener('click', saveRep);
    $('rep-logout').addEventListener('click', logoutRep);

    $('rep-known').addEventListener('click', function (e) {
      const pill = e.target.closest('[data-rep]');
      if (!pill) return;
      $('rep-name').value = pill.dataset.rep;
      $('rep-code').value = pill.dataset.repCode || '';
      $('rep-region').value = pill.dataset.repRegion || '';
    });

    $('btn-add-customer').addEventListener('click', startAdd);
    $('btn-add-customer-map').addEventListener('click', startAdd);
    $('a-save').addEventListener('click', saveAdd);
    $('a-cancel').addEventListener('click', function () { addOpen = false; closeModals(); });
    $('a-repick').addEventListener('click', repick);
    $('a-lat').addEventListener('input', updateCoordChip);
    $('a-lng').addEventListener('input', updateCoordChip);

    $('btn-show-mine').addEventListener('click', showMine);
    $('btn-rep-data').addEventListener('click', openDataModal);
    $('btn-export-json').addEventListener('click', exportJSON);
    $('btn-export-csv').addEventListener('click', exportCSV);
    $('btn-import-json').addEventListener('click', importJSON);
    $('btn-clear-local').addEventListener('click', clearLocal);
    $('import-file').addEventListener('change', onImportFile);

    document.addEventListener('hedayat:detail-open', function (e) {
      if (e.detail && e.detail.customer) renderDetailPanel(e.detail.customer);
    });
  }

  function afterData() {
    fillFollowUpFilter();
    fillDatalists();
    fillRegionSelect($('a-region'), 'ثبت نشده');
    fillRegionSelect($('rep-region'), 'ثبت نشده');
    renderRepUI();

    // Ask who the rep is, but only once per browser — management can still
    // browse the map without ever filling this in.
    if (!Store.getRep() && !localStorage.getItem('hedayat.rep.prompted')) {
      try { localStorage.setItem('hedayat.rep.prompted', '1'); } catch (e) { /* ignore */ }
      setTimeout(openRepModal, 900);
    }
  }

  return {
    init: init,
    afterData: afterData,
    renderRepUI: renderRepUI,
    startAdd: startAdd,
    openRepModal: openRepModal,
    renderDetailPanel: renderDetailPanel
  };
})();

Hedayat.editor = Editor;

Hedayat.register({
  name: 'editor',
  init() { Editor.init(); },
  afterData() { Editor.afterData(); },
  onRebuild() { Editor.renderRepUI(); }
});
