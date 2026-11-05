'use strict';
/*
 * Rozana Doodh Khata — Gulbahar Dairy
 * - Data sirf is browser ke localStorage mein rehta hai.
 * - Koi innerHTML / inline handler nahi: saara text textContent se render hota hai (XSS-safe).
 * - localStorage / import ka data load par poori tarah validate + sanitize hota hai.
 */
(function () {
  var KEY = 'dairyKhataCustomers'; // purana key, taaki existing data na khoye
  var LIM = {
    nameLen: 60, rateMin: 1, rateMax: 10000, litreMin: 0.05, litreMax: 1000,
    amtMin: 1, amtMax: 10000000, maxCustomers: 1000, maxEntries: 20000, importBytes: 5 * 1024 * 1024
  };
  var SHIFT_ORDER = { Subah: 0, Shaam: 1 };

  var $ = function (id) { return document.getElementById(id); };
  var customers = [];
  var activeId = null;

  /* ---------- helpers ---------- */
  function round2(n) { return Math.round(n * 100) / 100; }
  function money(n) {
    var v = round2(Math.abs(n));
    return '₹' + v.toLocaleString('en-IN', { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 });
  }
  function uid() {
    if (window.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }
  function cleanText(s, max) {
    return String(s == null ? '' : s)
      .replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, '')
      .trim().slice(0, max);
  }
  function inRange(v, min, max) {
    var n = typeof v === 'number' ? v : parseFloat(v);
    return isFinite(n) && n >= min && n <= max ? n : null;
  }
  function isDate(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    var d = new Date(s + 'T00:00:00Z');
    return !isNaN(d) && d.toISOString().slice(0, 10) === s;
  }
  function todayLocal() { // UTC nahi, local date (IST bug fix)
    var d = new Date();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day;
  }
  function phoneDigits(s) {
    var d = String(s == null ? '' : s).replace(/\D/g, '');
    if (d.length === 12 && d.indexOf('91') === 0) d = d.slice(2);
    else if (d.length === 11 && d.charAt(0) === '0') d = d.slice(1);
    return d;
  }
  function validIndianMobile(d) { return /^[6-9]\d{9}$/.test(d); }

  function el(tag, opts, kids) {
    var e = document.createElement(tag);
    opts = opts || {};
    if (opts.cls) e.className = opts.cls;
    if (opts.text != null) e.textContent = opts.text;
    if (opts.attrs) Object.keys(opts.attrs).forEach(function (k) { e.setAttribute(k, opts.attrs[k]); });
    (kids || []).forEach(function (k) { e.appendChild(k); });
    return e;
  }
  function icon(id) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    var use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#' + id);
    svg.appendChild(use);
    return svg;
  }

  /* ---------- UI feedback ---------- */
  var toastTimer;
  function toast(msg, isError) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'toast show' + (isError ? ' error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = 'toast'; }, 3200);
  }
  function confirmBox(title, msg, okLabel) {
    var dlg = $('confirmDialog');
    if (!dlg || typeof dlg.showModal !== 'function') return Promise.resolve(window.confirm(title + '\n' + msg));
    return new Promise(function (resolve) {
      $('confirmTitle').textContent = title;
      $('confirmMsg').textContent = msg;
      $('confirmOk').textContent = okLabel || 'Haan';
      dlg.returnValue = 'cancel';
      dlg.addEventListener('close', function onClose() {
        dlg.removeEventListener('close', onClose);
        resolve(dlg.returnValue === 'ok');
      });
      dlg.showModal();
    });
  }
  function setErr(inputId, msg) {
    var inp = $(inputId), err = $(inputId + 'Err');
    if (err) err.textContent = msg || '';
    if (inp) { if (msg) inp.setAttribute('aria-invalid', 'true'); else inp.removeAttribute('aria-invalid'); }
    return !msg;
  }

  /* ---------- storage + sanitising ---------- */
  function sanitizeEntry(raw, defaultRate) {
    if (!raw || typeof raw !== 'object' || !isDate(raw.date)) return null;
    var id = cleanText(raw.id, 64).replace(/[^\w-]/g, '') || uid();
    if (raw.type === 'milk') {
      var litres = inRange(raw.litres, LIM.litreMin, LIM.litreMax);
      var rate = inRange(raw.rate, LIM.rateMin, LIM.rateMax);
      if (rate === null) rate = defaultRate;
      if (litres === null) return null;
      return {
        id: id, date: raw.date, type: 'milk',
        shift: raw.shift === 'Shaam' ? 'Shaam' : 'Subah',
        litres: litres, rate: rate,
        amount: round2(litres * rate) // hamesha dobara calculate: tampered amount nahi chalega
      };
    }
    if (raw.type === 'payment') {
      var amt = inRange(raw.amount, LIM.amtMin, LIM.amtMax);
      if (amt === null) return null;
      return { id: id, date: raw.date, type: 'payment', amount: round2(amt) };
    }
    return null;
  }
  function sanitizeCustomers(raw) {
    var out = [], seen = {};
    if (!Array.isArray(raw)) return out;
    raw.slice(0, LIM.maxCustomers).forEach(function (c) {
      if (!c || typeof c !== 'object') return;
      var name = cleanText(c.name, LIM.nameLen);
      var rate = inRange(c.defaultRate, LIM.rateMin, LIM.rateMax);
      if (!name || rate === null) return;
      var id = cleanText(c.id, 64).replace(/[^\w-]/g, '') || uid();
      while (seen[id]) id = uid();
      seen[id] = true;
      var entries = [], eseen = {};
      (Array.isArray(c.entries) ? c.entries : []).slice(0, LIM.maxEntries).forEach(function (e) {
        var s = sanitizeEntry(e, rate);
        if (!s) return;
        while (eseen[s.id]) s.id = uid();
        eseen[s.id] = true;
        entries.push(s);
      });
      out.push({ id: id, name: name, phone: phoneDigits(c.phone).slice(0, 15), defaultRate: rate, entries: entries });
    });
    return out;
  }
  function load() {
    var raw = null;
    try { raw = localStorage.getItem(KEY); } catch (e) { $('storageWarn').hidden = false; return []; }
    if (!raw) return [];
    try {
      return sanitizeCustomers(JSON.parse(raw));
    } catch (e) {
      try { localStorage.setItem(KEY + '.corrupt', raw); } catch (e2) { /* ignore */ }
      toast('Purana data padha nahi ja saka; uski copy surakshit rakh di gayi hai.', true);
      return [];
    }
  }
  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(customers));
      $('storageWarn').hidden = true;
      return true;
    } catch (e) {
      $('storageWarn').hidden = false;
      toast('Data save nahi ho paya!', true);
      return false;
    }
  }

  /* ---------- calculations ---------- */
  function totals(c) {
    var debit = 0, credit = 0, litres = 0; // paise mein jodte hain (float error nahi)
    c.entries.forEach(function (e) {
      var p = Math.round(e.amount * 100);
      if (e.type === 'milk') { debit += p; litres += Math.round(e.litres * 100); } else credit += p;
    });
    return { debit: debit / 100, credit: credit / 100, litres: litres / 100, balance: (debit - credit) / 100 };
  }
  function sortedEntries(c) {
    return c.entries.map(function (e, i) { return { e: e, i: i }; }).sort(function (a, b) {
      if (a.e.date !== b.e.date) return a.e.date < b.e.date ? -1 : 1;
      var sa = a.e.type === 'milk' ? SHIFT_ORDER[a.e.shift] : 2;
      var sb = b.e.type === 'milk' ? SHIFT_ORDER[b.e.shift] : 2;
      return sa !== sb ? sa - sb : a.i - b.i;
    }).map(function (x) { return x.e; });
  }
  function active() {
    for (var i = 0; i < customers.length; i++) if (customers[i].id === activeId) return customers[i];
    return null;
  }

  /* ---------- rendering ---------- */
  function renderStats() {
    var due = 0, litres = 0;
    customers.forEach(function (c) { var t = totals(c); due += Math.round(t.balance * 100); litres += Math.round(t.litres * 100); });
    $('statCustomers').textContent = String(customers.length);
    $('statDue').textContent = (due < 0 ? '-' : '') + money(due / 100);
    $('statMilk').textContent = (litres / 100).toLocaleString('en-IN') + ' Ltr';
  }
  function renderSelect() {
    var sel = $('customerSelect');
    sel.textContent = '';
    sel.appendChild(el('option', { text: '— Koi customer select karein —', attrs: { value: '' } }));
    customers.forEach(function (c) {
      var o = el('option', { text: c.name + ' (' + (c.phone || 'Mobile nahi') + ')', attrs: { value: c.id } });
      if (c.id === activeId) o.selected = true;
      sel.appendChild(o);
    });
  }
  function renderPanels() {
    var c = active();
    ['entrySection', 'historySection', 'customerSummary'].forEach(function (id) { $(id).hidden = !c; });
    if (!c) return;
    $('selectedName').textContent = c.name;
    renderLedger();
  }
  function renderLedger() {
    var c = active();
    if (!c) return;
    var body = $('ledgerBody');
    body.textContent = '';
    var run = 0;
    var list = sortedEntries(c);
    if (!list.length) {
      var td = el('td', { cls: 'empty', text: 'Abhi koi entry nahi hai.', attrs: { colspan: '6' } });
      body.appendChild(el('tr', {}, [td]));
    }
    list.forEach(function (e) {
      var isMilk = e.type === 'milk';
      run = Math.round((run + (isMilk ? e.amount : -e.amount)) * 100) / 100;
      var del = el('button', { cls: 'icon-btn', attrs: { type: 'button', 'data-id': e.id, 'aria-label': 'Entry delete karein: ' + e.date } }, [icon('i-trash')]);
      var tag = el('span', { cls: 'tag ' + (isMilk ? 'tag-milk' : 'tag-pay'), text: isMilk ? e.shift : 'Jama (Paid)' });
      var tr = el('tr', {}, [
        el('td', { text: e.date.split('-').reverse().join('-') }),
        el('td', {}, [tag]),
        el('td', { cls: 'num', text: isMilk ? e.litres + ' Ltr' : '—' }),
        el('td', { cls: 'num ' + (isMilk ? 'amt-debit' : 'amt-credit'), text: (isMilk ? '+' : '−') + money(e.amount) }),
        el('td', { cls: 'num', text: (run < 0 ? '−' : '') + money(run) }),
        el('td', {}, [del])
      ]);
      body.appendChild(tr);
    });
    var t = totals(c);
    var box = $('customerSummary');
    box.className = 'balance-box ' + (t.balance > 0 ? 'due' : 'clear');
    $('balanceLabel').textContent = t.balance < 0 ? 'Advance jama' : 'Total unpaid balance';
    $('currentBalance').textContent = money(t.balance);
  }
  function renderAll() { renderStats(); renderSelect(); renderPanels(); }

  /* ---------- actions ---------- */
  function onAddCustomer(ev) {
    ev.preventDefault();
    var name = cleanText($('custName').value, LIM.nameLen);
    var phoneRaw = $('custPhone').value.trim();
    var digits = phoneDigits(phoneRaw);
    var rate = inRange($('custRate').value, LIM.rateMin, LIM.rateMax);
    var ok = true;
    ok = setErr('custName', name ? '' : 'Naam daalna zaroori hai.') && ok;
    ok = setErr('custPhone', !phoneRaw || validIndianMobile(digits) ? '' : '10 ank ka sahi mobile number daalein.') && ok;
    ok = setErr('custRate', rate !== null ? '' : 'Rate ' + LIM.rateMin + ' se ' + LIM.rateMax + ' ke beech hona chahiye.') && ok;
    if (!ok) return;
    if (customers.length >= LIM.maxCustomers) { toast('Customers ki seema poori ho gayi.', true); return; }
    var c = { id: uid(), name: name, phone: phoneRaw ? digits : '', defaultRate: rate, entries: [] };
    customers.push(c);
    if (!save()) { customers.pop(); return; }
    ev.target.reset();
    activeId = c.id;
    renderAll();
    toast('Naya khata ban gaya!');
  }
  function onSwitch() {
    activeId = $('customerSelect').value || null;
    renderPanels();
  }
  function toggleType() {
    var milk = $('entryType').value === 'milk';
    $('milkFields').hidden = !milk;
    $('paymentFields').hidden = milk;
  }
  async function onSaveEntry(ev) {
    ev.preventDefault();
    var c = active();
    if (!c) return;
    var date = $('entryDate').value;
    var type = $('entryType').value;
    var ok = setErr('entryDate', isDate(date) ? '' : 'Sahi tarikh chunein.');
    var entry;
    if (type === 'milk') {
      var litres = inRange($('entryLitres').value, LIM.litreMin, LIM.litreMax);
      ok = setErr('entryLitres', litres !== null ? '' : 'Doodh ' + LIM.litreMin + ' se ' + LIM.litreMax + ' Litre ke beech daalein.') && ok;
      setErr('entryAmount', '');
      if (!ok) return;
      var shift = $('entryShift').value === 'Shaam' ? 'Shaam' : 'Subah';
      var dup = c.entries.some(function (e) { return e.type === 'milk' && e.date === date && e.shift === shift; });
      if (dup && !(await confirmBox('Entry pehle se hai', date.split('-').reverse().join('-') + ' ki ' + shift + ' ki doodh entry pehle se maujood hai. Phir bhi jodein?', 'Haan, jodein'))) return;
      entry = { id: uid(), date: date, type: 'milk', shift: shift, litres: litres, rate: c.defaultRate, amount: round2(litres * c.defaultRate) };
    } else {
      var amt = inRange($('entryAmount').value, LIM.amtMin, LIM.amtMax);
      ok = setErr('entryAmount', amt !== null ? '' : 'Rashi ' + LIM.amtMin + ' se ' + LIM.amtMax.toLocaleString('en-IN') + ' ke beech daalein.') && ok;
      setErr('entryLitres', '');
      if (!ok) return;
      entry = { id: uid(), date: date, type: 'payment', amount: round2(amt) };
    }
    if (c.entries.length >= LIM.maxEntries) { toast('Is customer ki entries ki seema poori ho gayi.', true); return; }
    c.entries.push(entry);
    if (!save()) { c.entries.pop(); return; }
    $('entryLitres').value = '';
    $('entryAmount').value = '';
    renderStats();
    renderLedger();
    toast('Entry save ho gayi.');
  }
  async function onLedgerClick(ev) {
    var btn = ev.target.closest('button[data-id]');
    var c = active();
    if (!btn || !c) return;
    var id = btn.getAttribute('data-id');
    if (!(await confirmBox('Entry hatayein?', 'Kya aap is entry ko hatana chahte hain?', 'Haan, hatayein'))) return;
    var before = c.entries;
    c.entries = c.entries.filter(function (e) { return e.id !== id; });
    if (!save()) { c.entries = before; return; }
    renderStats();
    renderLedger();
    toast('Entry hata di gayi.');
  }
  async function onDeleteCustomer() {
    var c = active();
    if (!c) return;
    if (!(await confirmBox('Poora khata delete karein?', c.name + ' ka poora khata hamesha ke liye hat jayega. Pehle backup le lein.', 'Haan, delete karein'))) return;
    var before = customers;
    customers = customers.filter(function (x) { return x.id !== c.id; });
    if (!save()) { customers = before; return; }
    activeId = null;
    renderAll();
    toast('Khata delete ho gaya.');
  }
  function onBill() {
    var c = active();
    if (!c) return;
    var t = totals(c);
    var lines = [
      '*GULBAHAR DAIRY - KHATA STATEMENT*',
      'Customer: *' + c.name + '*',
      'Total Doodh: *' + t.litres + ' Litres*',
      'Total Bill: ' + money(t.debit),
      'Jama (Paid): ' + money(t.credit),
      '----------------------------------',
      t.balance < 0 ? '*Advance Jama: ' + money(t.balance) + '*' : '*Kul Baki (Balance): ' + money(t.balance) + '*',
      '----------------------------------',
      'Kripya samay par bhugtan karein. Dhanyawad!'
    ];
    var d = phoneDigits(c.phone);
    if (d.length === 10) d = '91' + d;
    var base = 'https://wa.me/' + (/^\d{10,15}$/.test(d) ? d : '');
    var w = window.open(base + '?text=' + encodeURIComponent(lines.join('\n')), '_blank', 'noopener,noreferrer');
    if (!w) toast('Popup block ho gaya. Browser mein popups allow karein.', true);
  }

  /* ---------- backup / restore ---------- */
  function onExport() {
    var payload = JSON.stringify({ app: 'gulbahar-khata', version: 1, exportedAt: new Date().toISOString(), customers: customers }, null, 2);
    var url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
    var a = document.createElement('a');
    a.href = url;
    a.download = 'gulbahar-khata-backup-' + todayLocal() + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    toast('Backup download ho raha hai.');
  }
  async function onImport(ev) {
    var file = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    if (!file) return;
    if (file.size > LIM.importBytes) { toast('File bahut badi hai (max 5 MB).', true); return; }
    try {
      var data = JSON.parse(await file.text());
      var list = sanitizeCustomers(Array.isArray(data) ? data : data && data.customers);
      if (!list.length) { toast('Is file mein koi sahi khata nahi mila.', true); return; }
      var n = list.reduce(function (s, c) { return s + c.entries.length; }, 0);
      if (!(await confirmBox('Backup restore karein?', list.length + ' customer aur ' + n + ' entries mili. Maujooda khata isse badal diya jayega.', 'Haan, restore karein'))) return;
      var before = customers;
      customers = list;
      if (!save()) { customers = before; return; }
      activeId = null;
      renderAll();
      toast('Backup restore ho gaya.');
    } catch (e) {
      toast('File padhi nahi ja saki. Sahi backup file chunein.', true);
    }
  }

  /* ---------- init ---------- */
  function init() {
    customers = load();
    $('entryDate').value = todayLocal();
    $('customerForm').addEventListener('submit', onAddCustomer);
    $('customerSelect').addEventListener('change', onSwitch);
    $('entryType').addEventListener('change', toggleType);
    $('entryForm').addEventListener('submit', onSaveEntry);
    $('ledgerBody').addEventListener('click', onLedgerClick);
    $('deleteCustBtn').addEventListener('click', onDeleteCustomer);
    $('billBtn').addEventListener('click', onBill);
    $('exportBtn').addEventListener('click', onExport);
    $('importBtn').addEventListener('click', function () { $('importFile').click(); });
    $('importFile').addEventListener('change', onImport);
    renderAll();
  }
  init();
})();
