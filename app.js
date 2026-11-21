/* 武汉大功率机车检修段 · 询价比价系统手机端B1
   导入电脑端「比价信息表」→ 逐项填询价结果（可拍照/换算）→ 导出回传包。 */
'use strict';

const APP_TITLE = '询价比价系统手机端B1';
const DB_NAME = 'canteen-compare-b1';
const DB_VERSION = 1;
const STORE_KV = 'kv';
const STORE_ITEMS = 'items';
const STORE_PHOTOS = 'photos';
const MAX_PHOTO_BYTES = 12 * 1024 * 1024;
const THUMB_EDGE = 360;

const state = {
  sheet: null,
  items: [],
  photos: [],
  settings: { operator: '' },
  view: 'home',
  filter: '',
  busy: false,
  viewer: null,
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtQty(v) {
  const n = Number(v || 0);
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000);
}
function money(v) {
  if (v === null || v === undefined || v === '') return '—';
  return '¥' + Number(v).toFixed(2);
}
function nowText(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}
function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}
function trunc2(value) {
  const n = Number(value || 0);
  return Math.floor(n * 100 + 1e-9) / 100;
}
function safePart(text) {
  return String(text || '').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60);
}

/* ------------------------------ 存储 ------------------------------ */
let dbPromise = null;
function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_KV)) db.createObjectStore(STORE_KV);
      if (!db.objectStoreNames.contains(STORE_ITEMS)) db.createObjectStore(STORE_ITEMS, { keyPath: 'seq' });
      if (!db.objectStoreNames.contains(STORE_PHOTOS)) {
        const store = db.createObjectStore(STORE_PHOTOS, { keyPath: 'id', autoIncrement: true });
        store.createIndex('kind', 'kind');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}
async function dbAll(store) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}
async function dbPut(store, value, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const os = tx.objectStore(store);
    if (key === undefined) os.put(value);
    else os.put(value, key);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}
async function dbGet(store, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function dbDel(store, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}
async function dbClear(store) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).clear();
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}
async function persistSheet() {
  await dbPut(STORE_KV, state.sheet, 'sheet');
}
async function persistItem(item) {
  await dbPut(STORE_ITEMS, item);
}

/* ------------------------------ UI 基础 ------------------------------ */
function toast(message, kind = '') {
  const root = $('#toast');
  root.textContent = message;
  root.className = 'toast show' + (kind ? ' ' + kind : '');
  root.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { root.hidden = true; root.className = 'toast'; }, 2600);
}
function busy(text) {
  state.busy = true;
  $('#busy-text').textContent = text || '处理中…';
  $('#busy').hidden = false;
}
function unbusy() {
  state.busy = false;
  $('#busy').hidden = true;
}
function openModal(html) {
  $('#modal-root').innerHTML = `<div class="modal-mask" data-close-modal></div><div class="modal-sheet" role="dialog">${html}</div>`;
}
function closeModal() { $('#modal-root').innerHTML = ''; }

/* ------------------------------ 导入 / 导出 ------------------------------ */
async function importWorkbook(file) {
  busy('正在解析比价信息表…');
  try {
    const buffer = await file.arrayBuffer();
    const parsed = CanteenCompareWorkbook.parseCompareWorkbook(new Uint8Array(buffer));
    const existing = state.sheet;
    if (existing && existing.sheetNo !== parsed.sheet.sheetNo && state.items.some((i) => i.inquiry !== null && i.inquiry !== '')) {
      if (!window.confirm(`当前比价单 ${existing.sheetNo} 已填了询价，导入 ${parsed.sheet.sheetNo} 会清空，继续吗？`)) return;
    }
    await dbClear(STORE_ITEMS);
    await dbClear(STORE_PHOTOS);
    state.sheet = parsed.sheet;
    state.items = parsed.items;
    state.photos = [];
    await persistSheet();
    for (const item of state.items) await persistItem(item);
    state.view = 'home';
    render();
    toast(`已导入 ${parsed.sheet.sheetNo}，共 ${parsed.items.length} 项`, 'ok');
  } catch (err) {
    toast(err.message || '导入失败', 'error');
  } finally {
    unbusy();
  }
}

async function exportPackage() {
  if (!state.sheet) return;
  busy('正在生成回传包…');
  try {
    const stampText = stamp();
    const items = state.items.slice().sort((a, b) => a.seq - b.seq);
    const xlsx = CanteenCompareWorkbook.buildCompareWorkbook(state.sheet, items, nowText());
    const base = `${stampText}-${state.sheet.sheetNo}`;
    const chunks = [];
    let resolveZip;
    let rejectZip;
    const done = new Promise((resolve, reject) => { resolveZip = resolve; rejectZip = reject; });
    const zip = new fflate.Zip((err, chunk, final) => {
      if (err) { rejectZip(err); return; }
      if (chunk) chunks.push(chunk);
      if (final) resolveZip(new Blob(chunks, { type: 'application/zip' }));
    });
    const addEntry = (name, bytes) => {
      if (!bytes || !bytes.length) return;
      const entry = new fflate.ZipPassThrough(name);
      zip.add(entry);
      entry.push(bytes, true);
    };
    addEntry(`比价信息表_${state.sheet.sheetNo}.xlsx`, new Uint8Array(xlsx));
    const perLine = {};
    let extraCount = 0;
    const photos = state.photos.slice();
    for (let i = 0; i < photos.length; i++) {
      const photo = photos[i];
      $('#busy-text').textContent = `正在打包照片 ${i + 1}/${photos.length}…`;
      let blob = photo.blob;
      if (!blob) continue;
      if (blob.size > MAX_PHOTO_BYTES) blob = await compressPhoto(blob);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const ext = photo.ext || 'jpg';
      if (photo.kind === 'extra') {
        extraCount += 1;
        addEntry(`补拍/${base}-补-${extraCount}.${ext}`, bytes);
      } else {
        perLine[photo.seq] = (perLine[photo.seq] || 0) + 1;
        const line = String(photo.seq).padStart(2, '0');
        addEntry(`照片/${base}-${line}-${perLine[photo.seq]}.${ext}`, bytes);
      }
    }
    zip.end();
    const blob = await done;
    state.lastBlob = blob; // 便于再次下载/排查，不写入本地存储
    const name = `比价回传_${state.sheet.sheetNo}.zip`;
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    state.lastExport = { name, at: nowText(), photos: state.photos.length };
    render();
    toast('回传包已生成', 'ok');
  } catch (err) {
    toast(err.message || '导出失败', 'error');
  } finally {
    unbusy();
  }
}

async function compressPhoto(blob) {
  const img = await decodeImage(blob);
  const w = img.width || img.naturalWidth;
  const h = img.height || img.naturalHeight;
  const scale = Math.min(1, 2400 / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  if (img.close) img.close();
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
}

/* ------------------------------ 照片 ------------------------------ */
function decodeImage(blob) {
  return new Promise((resolve, reject) => {
    if (window.createImageBitmap) {
      createImageBitmap(blob).then(resolve, () => {
        const img = new Image();
        const url = URL.createObjectURL(blob);
        img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片无法读取')); };
        img.src = url;
      });
      return;
    }
    const img = new Image();
    const url = URL.createObjectURL(blob);
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片无法读取')); };
    img.src = url;
  });
}

async function makeThumb(blob) {
  const img = await decodeImage(blob);
  const w = img.width || img.naturalWidth;
  const h = img.height || img.naturalHeight;
  const scale = Math.min(1, THUMB_EDGE / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  if (img.close) img.close();
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8));
}

async function addPhotos(files, target) {
  const list = Array.from(files || []);
  if (!list.length) return;
  busy(`正在保存照片 0/${list.length}…`);
  let added = 0;
  try {
    for (let i = 0; i < list.length; i++) {
      const file = list[i];
      if (file.size > MAX_PHOTO_BYTES) { toast(`${file.name} 超过 12MB，已跳过`, 'error'); continue; }
      $('#busy-text').textContent = `正在保存照片 ${i + 1}/${list.length}…`;
      let blob = file;
      let ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
      if (!/^(jpg|jpeg|png|webp)$/.test(ext)) ext = 'jpg';
      const thumb = await makeThumb(blob);
      const photo = {
        kind: target.kind,
        seq: target.seq || null,
        blob,
        thumb,
        ext: ext === 'jpeg' ? 'jpg' : ext,
        createdAt: nowText(),
      };
      await dbPut(STORE_PHOTOS, photo);
      added += 1;
    }
    state.photos = await dbAll(STORE_PHOTOS);
    render();
    toast(`已添加 ${added} 张照片`, 'ok');
  } catch (err) {
    toast(err.message || '照片保存失败', 'error');
  } finally {
    unbusy();
  }
}

function photosFor(seq) {
  return state.photos.filter((p) => p.kind === 'item' && p.seq === seq);
}
function extraPhotos() {
  return state.photos.filter((p) => p.kind === 'extra');
}

/* ------------------------------ 业务动作 ------------------------------ */
async function setInquiry(seq, value) {
  const item = state.items.find((i) => i.seq === seq);
  if (!item) return;
  const text = String(value == null ? '' : value).trim();
  if (text === '') item.inquiry = null;
  else {
    const n = Number(text.replace(/,/g, ''));
    if (!Number.isFinite(n) || n < 0) { toast('询价结果要填数字', 'error'); return; }
    item.inquiry = Math.round(n * 100) / 100;
  }
  await persistItem(item);
}

function openConvert(seq) {
  const item = state.items.find((i) => i.seq === seq);
  if (!item) return;
  openModal(`
    <div class="sheet-head"><h3>单位价格换算</h3><button class="icon-btn" data-close-x>×</button></div>
    <p class="muted">第 ${item.seq} 项 · ${esc(item.name)}</p>
    <div class="grid2">
      <label class="field"><span>金额（元）</span><input id="cv-amount" class="input" type="number" inputmode="decimal" step="0.01" placeholder="例如 12.5"></label>
      <label class="field"><span>克数（g）</span><input id="cv-grams" class="input" type="number" inputmode="decimal" step="1" placeholder="例如 400"></label>
    </div>
    <div class="calc-box"><span>500g 单价</span><strong id="cv-result">—</strong></div>
    <div class="modal-actions">
      <button class="btn" data-close-x>取消</button>
      <button class="btn primary" id="cv-fill">填入询价结果</button>
    </div>`);
  const calc = () => {
    const amount = Number($('#cv-amount').value);
    const grams = Number($('#cv-grams').value);
    if (!amount || !grams || grams <= 0) { $('#cv-result').textContent = '—'; return null; }
    const price = trunc2((amount / grams) * 500);
    $('#cv-result').textContent = '¥' + price.toFixed(2);
    return price;
  };
  $('#cv-amount').oninput = calc;
  $('#cv-grams').oninput = calc;
  $('#cv-fill').onclick = async () => {
    const price = calc();
    if (price === null) { toast('先填金额和克数', 'error'); return; }
    await setInquiry(item.seq, price);
    closeModal();
    render();
    toast(`已填入 ¥${price.toFixed(2)}`, 'ok');
  };
}

/* ------------------------------ 视图 ------------------------------ */
function topbar() {
  const hasSheet = Boolean(state.sheet);
  $('#top-location').hidden = !hasSheet;
  if (hasSheet) {
    $('#top-location-code').textContent = state.sheet.sheetNo;
  }
  $('#back-btn').hidden = state.view === 'home';
}

function render() {
  topbar();
  const view = $('#view');
  if (!state.sheet) { view.innerHTML = homeEmpty(); bindHomeEmpty(); return; }
  if (state.view === 'list') { view.innerHTML = listView(); bindList(); }
  else { view.innerHTML = homeView(); bindHome(); }
}

function homeEmpty() {
  return `
    <section class="hero">
      <div class="hero-logo">比</div>
      <h1>${APP_TITLE}</h1>
      <p class="muted">导入电脑端下发的比价信息表，逐项填写询价结果</p>
      <button class="btn primary block" data-action="pick-note">导入比价信息表</button>
      <p class="hint">文件由电脑端「比价信息表」页生成，文件名类似 比价信息表_BJ2026….xlsx</p>
    </section>`;
}

function bindHomeEmpty() {
  $('[data-action="pick-note"]').onclick = () => $('#file-note').click();
}

function homeView() {
  const filled = state.items.filter((i) => i.inquiry !== null && i.inquiry !== '').length;
  const photos = state.photos.length;
  return `
    <section class="card">
      <div class="card-title-row">
        <h2 class="mono">${esc(state.sheet.sheetNo)}</h2>
        <span class="badge">${filled}/${state.items.length} 已填</span>
      </div>
      <p class="muted">${esc(state.sheet.period || '')} · 折扣率 ${Number(state.sheet.discount || 0).toFixed(2)}</p>
      <div class="stat-row">
        <div><strong>${state.items.length}</strong><span>商品</span></div>
        <div><strong>${filled}</strong><span>已填询价</span></div>
        <div><strong>${photos}</strong><span>照片</span></div>
      </div>
      <button class="btn primary block" data-action="start">开始填写</button>
      <button class="btn block" data-action="export">导出回传包</button>
      <button class="btn block ghost" data-action="pick-note">更换比价单</button>
    </section>
    <section class="card">
      <label class="field"><span>验收人 / 操作员</span>
        <input class="input" id="operator" value="${esc(state.settings.operator)}" placeholder="例如 张三"></label>
      <p class="hint">回传包只写入「询价结果」，照片放在 照片/ 与 补拍/ 两个文件夹。</p>
    </section>`;
}

function bindHome() {
  $('[data-action="start"]').onclick = () => { state.view = 'list'; render(); };
  $('[data-action="export"]').onclick = exportPackage;
  $('[data-action="pick-note"]').onclick = () => $('#file-note').click();
  const op = $('#operator');
  op.onchange = async () => {
    state.settings.operator = op.value.trim();
    await dbPut(STORE_KV, state.settings, 'settings');
  };
}

function listView() {
  const q = state.filter.trim().toLowerCase();
  const items = state.items
    .filter((i) => !q || i.name.toLowerCase().includes(q))
    .sort((a, b) => a.seq - b.seq);
  const filled = state.items.filter((i) => i.inquiry !== null && i.inquiry !== '').length;
  return `
    <div class="freeze-bar">
      <div class="search-box"><input id="q" type="search" placeholder="搜索品名 / 序号" value="${esc(state.filter)}"></div>
      <button class="btn small" data-action="extra-photo">补拍</button>
    </div>
    <p class="list-meter">已填 ${filled}/${state.items.length}${q ? ` · 命中 ${items.length}` : ''}</p>
    <div class="item-list">${items.map(itemCard).join('') || '<div class="empty">没有匹配的商品</div>'}</div>
    <div class="bottom-bar"><button class="btn primary block" data-action="home">完成，去导出</button></div>`;
}

function itemCard(item) {
  const photos = photosFor(item.seq);
  const filled = item.inquiry !== null && item.inquiry !== '';
  return `
    <article class="item ${filled ? 'done' : ''}" data-seq="${item.seq}">
      <div class="item-head">
        <span class="line-no">${item.seq}</span>
        <div class="item-title"><strong>${esc(item.name)}</strong>
          <span class="muted">${esc(item.unit)} · 实送 ${fmtQty(item.qty)} · 报单价 ${money(item.basePrice)}</span></div>
      </div>
      <div class="item-row">
        <label class="inquiry"><span>询价结果</span>
          <input class="input" type="number" inputmode="decimal" step="0.01" min="0" data-inquiry="${item.seq}"
            value="${filled ? item.inquiry : ''}" placeholder="填单价"></label>
        <button class="btn small" data-convert="${item.seq}">换算</button>
        <button class="btn small icon" data-photo="${item.seq}">拍照${photos.length ? ' ' + photos.length : ''}</button>
      </div>
      ${photos.length ? `<div class="thumb-row">${photos.map((p) => `<img src="${p.thumbUrl || ''}" data-view="${p.id}" alt="">`).join('')}</div>` : ''}
    </article>`;
}

function bindList() {
  $('#q').oninput = (ev) => {
    state.filter = ev.target.value;
    const list = $('.item-list');
    if (!list) return;
    const q = state.filter.trim().toLowerCase();
    const items = state.items.filter((i) => !q || i.name.toLowerCase().includes(q)).sort((a, b) => a.seq - b.seq);
    list.innerHTML = items.map(itemCard).join('') || '<div class="empty">没有匹配的商品</div>';
    const meter = $('.list-meter');
    if (meter) {
      const filled = state.items.filter((i) => i.inquiry !== null && i.inquiry !== '').length;
      meter.textContent = `已填 ${filled}/${state.items.length}${q ? ` · 命中 ${items.length}` : ''}`;
    }
    paintThumbs();
  };
  $$('[data-inquiry]').forEach((input) => {
    input.onchange = async () => {
      await setInquiry(Number(input.dataset.inquiry), input.value);
      paintThumbs();
      const meter = $('.list-meter');
      const filled = state.items.filter((i) => i.inquiry !== null && i.inquiry !== '').length;
      if (meter) meter.textContent = `已填 ${filled}/${state.items.length}`;
      input.closest('.item').classList.toggle('done', filled > 0 && input.value !== '');
    };
  });
  $$('[data-convert]').forEach((btn) => { btn.onclick = () => openConvert(Number(btn.dataset.convert)); });
  $$('[data-photo]').forEach((btn) => {
    btn.onclick = () => { $('#file-photo').dataset.seq = btn.dataset.photo; $('#file-photo').click(); };
  });
  const extra = $('[data-action="extra-photo"]');
  if (extra) extra.onclick = () => { $('#file-photo').dataset.seq = ''; $('#file-photo').click(); };
  const home = $('[data-action="home"]');
  if (home) home.onclick = () => { state.view = 'home'; render(); };
  paintThumbs();
}

function paintThumbs() {
  for (const img of $$('[data-view]')) {
    const photo = state.photos.find((p) => String(p.id) === img.dataset.view);
    if (!photo) continue;
    if (!photo.thumbUrl) photo.thumbUrl = URL.createObjectURL(photo.thumb || photo.blob);
    img.src = photo.thumbUrl;
  }
}

/* ------------------------------ 事件绑定 ------------------------------ */
function bindGlobal() {
  $('#file-note').onchange = (ev) => {
    const file = ev.target.files[0];
    ev.target.value = '';
    if (file) importWorkbook(file);
  };
  $('#file-photo').onchange = (ev) => {
    const files = Array.from(ev.target.files || []);
    const seq = ev.target.dataset.seq;
    ev.target.value = '';
    const target = seq ? { kind: 'item', seq: Number(seq) } : { kind: 'extra', seq: null };
    if (files.length) addPhotos(files, target);
  };
  document.addEventListener('click', (ev) => {
    if (ev.target.closest('[data-close-modal]') || ev.target.closest('[data-close-x]')) { closeModal(); return; }
    const back = ev.target.closest('#back-btn');
    if (back) { state.view = 'home'; closeModal(); render(); return; }
    const view = ev.target.closest('[data-view]');
    if (view) {
      const photo = state.photos.find((p) => String(p.id) === view.dataset.view);
      if (photo) {
        const url = URL.createObjectURL(photo.blob);
        openModal(`<div class="sheet-head"><h3>照片</h3><button class="icon-btn" data-close-x>×</button></div>
          <img class="photo-big" src="${url}" alt="">
          <div class="modal-actions"><button class="btn danger" id="del-photo">删除这张</button></div>`);
        $('#del-photo').onclick = async () => {
          await dbDel(STORE_PHOTOS, photo.id);
          state.photos = await dbAll(STORE_PHOTOS);
          closeModal();
          render();
        };
      }
    }
  });
  const version = document.querySelector('meta[name="app-version"]');
  if (version) version.content = '20261121033941-d72fd133';
}

async function init() {
  try {
    const settings = await dbGet(STORE_KV, 'settings');
    if (settings) state.settings = Object.assign(state.settings, settings);
    const sheet = await dbGet(STORE_KV, 'sheet');
    if (sheet) {
      state.sheet = sheet;
      state.items = (await dbAll(STORE_ITEMS)).sort((a, b) => a.seq - b.seq);
      state.photos = await dbAll(STORE_PHOTOS);
    }
  } catch (err) {
    toast('本地数据读取失败：' + (err.message || ''), 'error');
  }
  bindGlobal();
  render();
}

init();
