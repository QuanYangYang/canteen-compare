/* 武汉大功率机车检修段 · 线下比价系统A1
   导入电脑端「比价信息表」→ 逐项填询价结果（可拍照/换算）→ 导出回传包。 */
'use strict';

const APP_TITLE = '线下比价系统A1';
const DB_NAME = 'canteen-compare-b1';
const DB_VERSION = 1;
const STORE_KV = 'kv';
const STORE_ITEMS = 'items';
const STORE_PHOTOS = 'photos';
const MAX_PHOTO_BYTES = 12 * 1024 * 1024;
const THUMB_EDGE = 360;
const OUTSIDE_WAIT_MS = 1500;      // 离开超过 1.5 秒再回来才算"出去截图了"
const PENDING_TTL_MS = 30 * 60 * 1000;

// 内置常用比价应用：安卓用 intent 直接拉起已安装 App，没装自动落网页；iPhone 用通用链接。
const BUILTIN_APPS = [
  { key: 'jd', name: '京东', androidPackage: 'com.jingdong.app.mall', androidPath: 'm.jd.com', https: 'https://m.jd.com' },
  { key: 'pupu', name: '朴朴超市', androidPackage: 'com.pupumall.customer', androidPath: 'www.pupumall.com', https: 'https://www.pupumall.com' },
  { key: 'taobao', name: '淘宝', androidPackage: 'com.taobao.taobao', androidPath: 'm.taobao.com', https: 'https://m.taobao.com' },
];
const LEGACY_SEED_IDS = ['jd', 'taobao', 'meituan', '1688', 'pinduoduo', 'app']; // 旧默认应用，迁移时清掉

const state = {
  sheet: null,
  items: [],
  photos: [],
  apps: [],
  pendingShot: null,
  agent: { url: '', pin: '', keyword: '' },
  waitTask: null,
  pollTimer: null,
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
  syncSoon();
}

/* ------------------------------ 线上比价应用 ------------------------------ */
function normalizeUrl(raw) {
  let text = String(raw || '').trim();
  if (!text) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return text;
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return text; // taobao:// 这类
  return 'https://' + text.replace(/^\/+/, '');
}

async function loadApps() {
  let apps = await dbGet(STORE_KV, 'compare_apps');
  if (!Array.isArray(apps)) apps = [];
  // 迁移：清掉旧版内置的默认应用（京东/淘宝/美团等），只保留用户自己加的
  apps = apps.filter((a) => a && !LEGACY_SEED_IDS.includes(String(a.id || '')));
  state.apps = apps;
  await dbPut(STORE_KV, state.apps, 'compare_apps');
}

function isAndroid() {
  return /Android/i.test(navigator.userAgent || '');
}
function isIOS() {
  return /iPhone|iPad|iPod/i.test(navigator.userAgent || '');
}

// 安卓优先 intent（可拉起已安装 App，未装自动回到网页）；iOS 用通用链接；其余用 https。
function buildLaunchUrl(app) {
  const https = app.url || app.https || '';
  if (!https) return '';
  if (isAndroid() && app.androidPackage) {
    const scheme = /^https?:/i.test(https) ? 'https' : 'https';
    const path = app.androidPath || https.replace(/^https?:\/\//i, '').split('?')[0];
    return `intent://${path}#Intent;scheme=${scheme};package=${app.androidPackage};S.browser_fallback_url=${encodeURIComponent(https)};end`;
  }
  if (isIOS()) return app.iosUrl || https;
  return https;
}

function recentApps() {
  return state.apps
    .slice()
    .sort((a, b) => Number(b.lastUsedAt || 0) - Number(a.lastUsedAt || 0))
    .filter((a) => a.lastUsedAt)
    .slice(0, 3);
}

function builtinAdded(key) {
  return state.apps.some((a) => a.builtinKey === key);
}

async function addBuiltinApp(key, seq) {
  const lib = BUILTIN_APPS.find((b) => b.key === key);
  if (!lib || builtinAdded(key)) return;
  state.apps.push({
    id: 'builtin:' + key,
    builtinKey: key,
    name: lib.name,
    url: lib.https,
    androidPackage: lib.androidPackage,
    androidPath: lib.androidPath,
    okCount: 0,
    failCount: 0,
    createdAt: nowText(),
  });
  await saveApps();
  toast(`已添加「${lib.name}」`, 'ok');
  openOnlineSheet(seq);
}

async function noteLaunchResult(appId, ok) {
  const app = state.apps.find((a) => String(a.id) === String(appId));
  if (!app) return;
  if (ok) app.okCount = Number(app.okCount || 0) + 1;
  else app.failCount = Number(app.failCount || 0) + 1;
  await saveApps();
}


async function saveApps() {
  await dbPut(STORE_KV, state.apps, 'compare_apps');
}

/* ------------------------------ 电脑取图助手 ------------------------------ */
async function loadAgent() {
  const saved = await dbGet(STORE_KV, 'agent');
  if (saved) state.agent = Object.assign(state.agent, saved);
  if (!state.agent.url) {
    const host = location.hostname;
    if (host && host !== 'localhost' && !host.endsWith('github.io')) state.agent.url = location.origin;
  }
}

async function saveAgent() {
  await dbPut(STORE_KV, state.agent, 'agent');
}

function agentPageOrigin() {
  return location.protocol.indexOf('http') === 0 ? location.origin : '';
}

function agentBase() {
  const url = String(state.agent.url || '').trim().replace(/\/+$/, '');
  return url;
}

async function agentFetch(path, opts = {}, timeoutMs = 9000) {
  const base = agentBase();
  if (!base) throw new Error('还没设置取图助手地址');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(base + path, Object.assign({ signal: ctrl.signal }, opts));
  } finally {
    clearTimeout(timer);
  }
}

async function ensureAgentPin() {
  if (state.agent.pin) return true;
  try {
    const res = await agentFetch('/ping', {}, 4000);
    if (res.ok) {
      const data = await res.json();
      if (data && data.pin) {
        state.agent.pin = String(data.pin);
        await saveAgent();
        return true;
      }
    }
  } catch (err) { /* 连不上就让用户手填 */ }
  return false;
}

function openAgentConfig(seq, message) {
  openModal(`
    <div class="sheet-head"><h3>连接电脑取图</h3><button class="icon-btn" data-close-x>×</button></div>
    ${message ? `<p class="notice red">${esc(message)}</p>` : ''}
    <label class="field"><span>取图助手地址</span>
      <input class="input" id="cfg-url" inputmode="url" value="${esc(agentBase() || (location.protocol.indexOf('http') === 0 ? location.origin : ''))}" placeholder="http://192.168.1.10:8770"></label>
    <label class="field"><span>配对码</span>
      <input class="input" id="cfg-pin" inputmode="numeric" value="${esc(state.agent.pin)}" placeholder="电脑助手窗口里显示的 6 位数字"></label>
    <p class="hint">电脑上双击“取图助手.cmd”，窗口第一行会显示端口、配对码和手机访问地址。</p>
    ${agentPageOrigin() ? '' : '<p class="notice red">注意：当前页面是 https 版本，填了也连不上。请先在手机浏览器打开 http://电脑IP:8770/ 再进比价单。</p>'}
    <div class="modal-actions">
      <button class="btn" data-close-x>取消</button>
      <button class="btn primary" id="cfg-save">保存并截图</button>
    </div>`);
  $('#cfg-save').onclick = async () => {
    state.agent.url = ($('#cfg-url').value || '').trim();
    state.agent.pin = ($('#cfg-pin').value || '').trim();
    await saveAgent();
    closeModal();
    startAgentPoll();
    requestAgentShot(seq);
  };
}


function agentSnapshot() {
  const shots = (state.photos || []).filter((p) => p.kind === 'online');
  const photos = (state.photos || []).filter((p) => p.kind !== 'online');
  return {
    sheet_no: state.sheet ? state.sheet.sheetNo : '',
    waitSeq: state.waitTask ? state.waitTask.seq : null,
    items: state.items.map((i) => ({
      seq: i.seq,
      name: i.name,
      unit: i.unit,
      qty: i.qty,
      basePrice: i.basePrice,
      inquiry: i.inquiry,
      photos: photos.filter((p) => Number(p.seq) === Number(i.seq)).length,
      shots: shots.filter((p) => Number(p.seq) === Number(i.seq)).length,
    })),
  };
}

async function syncSheetToAgent() {
  if (!agentBase() || !state.sheet) return;
  if (!(await ensureAgentPin())) return;
  try {
    const snap = agentSnapshot();
    snap.pin = state.agent.pin;
    await agentFetch('/sheet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(snap),
    }, 8000);
    state.lastSync = new Date();
    try { const p = await agentFetch('/ping', {}, 4000); const d = await p.json(); state.agentVersion = d.version || ''; } catch (e) {}
    startAgentPoll();
    updateAgentStatus();
  } catch (err) {
    state.lastSyncError = String((err && err.message) || err);
    updateAgentStatus();
  }
}

function syncSoon() {
  if (state.syncTimer) clearTimeout(state.syncTimer);
  state.syncTimer = setTimeout(() => { state.syncTimer = null; syncSheetToAgent(); }, 600);
}

function updateAgentStatus() {
  const el = document.querySelector('#agent-status');
  if (!el) return;
  if (!agentBase()) { el.textContent = '电脑取图：未配置'; return; }
  const bits = [];
  bits.push(state.lastSync ? '已同步 ' + state.lastSync.toTimeString().slice(0, 8) : '还没同步');
  if (state.waitTask) bits.push('等第 ' + state.waitTask.seq + ' 项截图');
  if (state.agentVersion) bits.push('电脑 ' + state.agentVersion);
  if (state.lastSyncError) bits.push('错误：' + state.lastSyncError);
  el.textContent = '电脑取图：' + bits.join(' · ');
}

async function saveWaitTask(task) {
  if (task) await dbPut(STORE_KV, task, 'wait_task');
  else await dbDel(STORE_KV, 'wait_task');
}

async function restoreWaitTask() {
  const saved = await dbGet(STORE_KV, 'wait_task');
  if (!saved || !saved.seq) return;
  if (Date.now() > Number(saved.until || 0)) { await saveWaitTask(null); return; }
  state.waitTask = { seq: saved.seq, until: saved.until };
  startAgentPoll();
}

async function requestAgentShot(seq) {
  if (!state.agent.url && location.protocol.indexOf('http') === 0) state.agent.url = location.origin;
  if (!agentBase()) { openAgentConfig(seq, '还没有填取图助手地址'); return; }
  if (!(await ensureAgentPin())) { openAgentConfig(seq, '需要配对码：电脑助手窗口里显示的 6 位数字'); return; }
  const item = state.items.find((i) => i.seq === seq) || {};
  try {
    await agentFetch('/task', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: state.agent.pin, seq, name: item.name || '' }),
    }, 8000);
  } catch (err) {
    toast('电脑没收到请求：' + (err.message || err), 'error');
    return;
  }
  state.waitTask = { seq, until: Date.now() + 15 * 60 * 1000 };
  await saveWaitTask(state.waitTask);
  startAgentPoll();
  toast('电脑已收到：把投屏翻到商品页，按 Ctrl+Alt+S（或电脑上点截图）', 'ok');
  render();
}

function startAgentPoll() {
  if (state.pollTimer) return;
  state.pollTimer = setInterval(pollAgentShot, 2000);
  pollAgentShot();
}

function stopAgentPoll() {
  if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
}

async function pollAgentShot() {
  if (!agentBase()) return;
  try {
    const d = await (await agentFetch('/shots', {}, 8000)).json();
    const done = state.doneShots || (state.doneShots = []);
    for (const s of d.shots || []) {
      if (done.indexOf(s.id) >= 0) continue;
      const r = await agentFetch('/shot?id=' + encodeURIComponent(s.id), {}, 20000);
      const blob = await r.blob();
      if (!blob.size) continue;
      const file = new File([blob], '电脑截图.png', { type: 'image/png' });
      await addPhotos([file], { kind: 'online', seq: Number(s.seq || 0), appName: '电脑截图' });
      done.push(s.id);
      await dbPut(STORE_KV, done, 'done_shots');
      agentFetch('/shot/ack', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: state.agent.pin, id: s.id }),
      }).catch(() => {});
      toast(`电脑截图已挂到第 ${s.seq || '?'} 项`, 'ok');
      render();
    }
  } catch (err) { /* 下一轮再试 */ }
  try {
    const c = await (await agentFetch('/commands', {}, 8000)).json();
    for (const cmd of c.commands || []) {
      await setInquiry(Number(cmd.seq), cmd.inquiry == null ? '' : cmd.inquiry);
      agentFetch('/command/ack', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: state.agent.pin, id: cmd.id }),
      }).catch(() => {});
      render();
    }
  } catch (err) { /* 忽略 */ }
}

async function pickAgentWindow() {
  try {
    const res = await agentFetch('/windows');
    const data = await res.json();
    const list = (data.windows || []).filter((w) => (w.width || 0) > 120 && !w.minimized);
    openModal(`
      <div class="sheet-head"><h3>选择投屏窗口</h3><button class="icon-btn" data-close-x>×</button></div>
      <p class="hint">在电脑上把手机投屏打开，然后选它。</p>
      <div class="app-grid">
        ${list.map((w) => `<button class="app-chip" data-win="${esc(w.title)}">${esc(w.title)}<span class="chip-tag">${w.width}×${w.height}</span></button>`).join('') || '<p class="muted">没有可选窗口</p>'}
      </div>`);
    $$('[data-win]').forEach((btn) => {
      btn.onclick = async () => {
        state.agent.keyword = btn.dataset.win;
        await saveAgent();
        try {
          await agentFetch('/window', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ keyword: state.agent.keyword }),
          });
        } catch (err) { /* 本地已保存，下次截图会带上 */ }
        closeModal();
        render();
        toast('投屏窗口已设为：' + state.agent.keyword, 'ok');
      };
    });
  } catch (err) {
    toast('连不上电脑：' + (err.message || err), 'error');
  }
}

async function loadPendingShot() {
  const saved = await dbGet(STORE_KV, 'pending_shot');
  if (!saved) return;
  if (Date.now() - Number(saved.at || 0) > PENDING_TTL_MS) {
    await dbDel(STORE_KV, 'pending_shot');
    return;
  }
  state.pendingShot = saved;
}

async function setPendingShot(pending) {
  state.pendingShot = pending;
  if (pending) await dbPut(STORE_KV, pending, 'pending_shot');
  else await dbDel(STORE_KV, 'pending_shot');
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
async function importFromZip(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const entries = fflate.unzipSync(buf);
  const names = Object.keys(entries).filter((n) => /\.xlsx$/i.test(n) && !n.split('/').pop().startsWith('~$'));
  if (!names.length) throw new Error('压缩包里没有 xlsx');
  const pick = names.find((n) => /比价信息表/.test(n)) || names[0];
  const blob = new Blob([entries[pick]], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  return new File([blob], pick.split('/').pop(), { type: blob.type });
}

async function importWorkbook(file) {
  busy('正在解析比价信息表…');
  try {
    if (/\.zip$/i.test(file.name || '')) file = await importFromZip(file);
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
  syncSheetToAgent();
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
    const photos = state.photos.filter((p) => p.kind !== 'online');
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
  // 能用 createImageBitmap 的浏览器直接在解码时降采样，比"整图解码+画布缩放"快很多
  if (window.createImageBitmap) {
    try {
      const img = await createImageBitmap(blob, { resizeWidth: THUMB_EDGE, resizeQuality: 'medium' });
      const scale = Math.min(1, THUMB_EDGE / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      if (img.close) img.close();
      return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8));
    } catch (err) { /* 落到下面的通用路径 */ }
  }
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

// 一次解码同时产出「存储用大图」和「缩略图」，避免一张照片解码两遍（手机上这一步最费时间）
async function prepareImage(file) {
  let src = file;
  if (window.createImageBitmap) {
    try { src = await createImageBitmap(file); } catch (err) { src = await decodeImage(file); }
  } else {
    src = await decodeImage(file);
  }
  const w = src.width || src.naturalWidth;
  const h = src.height || src.naturalHeight;
  if (!w || !h) throw new Error('图片无法读取');
  const longEdge = Math.max(w, h);
  let blob = file;
  let ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
  if (!/^(jpg|jpeg|png|webp)$/.test(ext)) ext = 'jpg';
  if (longEdge > 2400 || file.size > 1.5 * 1024 * 1024) {
    const scale = Math.min(1, 2400 / longEdge);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    canvas.getContext('2d').drawImage(src, 0, 0, canvas.width, canvas.height);
    const out = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
    if (out && out.size < file.size) { blob = out; ext = 'jpg'; }
  }
  const thumbScale = Math.min(1, THUMB_EDGE / longEdge);
  const thumbCanvas = document.createElement('canvas');
  thumbCanvas.width = Math.max(1, Math.round(w * thumbScale));
  thumbCanvas.height = Math.max(1, Math.round(h * thumbScale));
  thumbCanvas.getContext('2d').drawImage(src, 0, 0, thumbCanvas.width, thumbCanvas.height);
  if (src.close) src.close();
  const thumb = await new Promise((resolve) => thumbCanvas.toBlob(resolve, 'image/jpeg', 0.8));
  return { blob, thumb, ext: ext === 'jpeg' ? 'jpg' : ext };
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
      const prepared = await prepareImage(file);
      const photo = {
        kind: target.kind,
        seq: target.seq || null,
        appName: target.appName || '',
        blob: prepared.blob,
        thumb: prepared.thumb,
        thumbUrl: URL.createObjectURL(prepared.thumb),
        ext: prepared.ext,
        createdAt: nowText(),
      };
      await dbPut(STORE_PHOTOS, photo);
      state.photos.push(photo);
      added += 1;
    }
    render();
    toast(`已添加 ${added} 张照片`, 'ok');
  } catch (err) {
    toast(err.message || '照片保存失败', 'error');
  } finally {
    unbusy();
  }
  syncSoon();
}

function photosFor(seq) {
  return state.photos.filter((p) => p.kind === 'item' && p.seq === seq);
}
function onlinePhotos(seq) {
  return state.photos.filter((p) => p.kind === 'online' && p.seq === seq);
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
  setTimeout(updateAgentStatus, 0);
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
      <p class="hint">回传包写入「询价结果」，照片放在 照片/、补拍/ 两个文件夹。</p>
    </section>
    `;
}

function bindHome() {
  $('[data-action="start"]').onclick = () => { state.view = 'list'; render(); syncSheetToAgent(); };
  $('[data-action="export"]').onclick = exportPackage;
  $('[data-action="pick-note"]').onclick = () => $('#file-note').click();
  const op = $('#operator');
  op.onchange = async () => {
    state.settings.operator = op.value.trim();
    await dbPut(STORE_KV, state.settings, 'settings');
  };
  const saveBtn = $('[data-action="agent-save"]');
  if (saveBtn) saveBtn.onclick = async () => {
    state.agent.url = ($('#agent-url').value || '').trim();
    state.agent.pin = ($('#agent-pin').value || '').trim();
    await saveAgent();
    toast('已保存', 'ok');
  };
  const checkBtn = $('[data-action="agent-check"]');
  if (checkBtn) checkBtn.onclick = async () => {
    if (!agentBase()) { openAgentConfig(0, '先填取图助手地址'); return; }
    await pollAgentShot();
    updateAgentStatus();
    toast('已检查一次', 'ok');
  };
  const winBtn = $('[data-action="agent-window"]');
  if (winBtn) winBtn.onclick = pickAgentWindow;
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
  const shots = onlinePhotos(item.seq);
  const waiting = state.waitTask && Number(state.waitTask.seq) === Number(item.seq);
  const filled = item.inquiry !== null && item.inquiry !== '';
  return `
    <article class="item ${filled ? 'done' : ''}" data-seq="${item.seq}">
      <div class="item-head">
        <span class="line-no">${item.seq}</span>
        <div class="item-title"><strong>${esc(item.name)}</strong>
          <span class="muted">实送 ${fmtQty(item.qty)} ${esc(item.unit)} · 报单价 ${money(item.basePrice)}</span></div>
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
  const extraBtn = $('[data-action="extra-photo"]');
  if (extraBtn) extraBtn.onclick = () => { $('#file-photo').dataset.seq = ''; $('#file-photo').click(); };
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

/* ------------------------------ 线上比价 ------------------------------ */
function openOnlineSheet(seq) {
  const item = state.items.find((i) => i.seq === seq);
  if (!item) return;
  const shots = onlinePhotos(seq);
  const recent = recentApps();
  const builtinCards = BUILTIN_APPS.map((b) => {
    const added = builtinAdded(b.key);
    return `<button class="app-chip ${added ? 'on' : ''}" ${added ? `data-app="builtin:${b.key}"` : `data-builtin="${b.key}"`}>
      ${esc(b.name)}<span class="chip-tag">${added ? '✓' : '＋'}</span></button>`;
  }).join('');
  const myApps = state.apps.filter((a) => !a.builtinKey);
  openModal(`
    <div class="sheet-head"><h3>线上比价</h3><button class="icon-btn" data-close-x>×</button></div>
    <p class="muted">第 ${item.seq} 项 · ${esc(item.name)}</p>
    ${recent.length ? `<p class="sect-title">最近使用</p>
    <div class="app-grid">${recent.map((a) => `<button class="app-chip" data-app="${esc(a.id)}">${esc(a.name)}</button>`).join('')}</div>` : ''}
    <p class="sect-title">常用应用</p>
    <div class="app-grid">${builtinCards}</div>
    <p class="sect-title">我的应用</p>
    <div class="app-grid">
      ${myApps.map((a) => `<button class="app-chip" data-app="${esc(a.id)}">${esc(a.name)}<span class="chip-x" data-del-app="${esc(a.id)}" title="删除">×</span></button>`).join('')}
      <button class="app-chip add" data-add-app>＋ 自定义</button>
    </div>
    <div class="modal-actions" style="margin-top:14px">
      <button class="btn primary" data-upload-shot>上传截图${shots.length ? `（已加 ${shots.length} 张）` : ''}</button>
    </div>
    ${agentBase() && agentPageOrigin() ? `<div class="modal-actions">
      <button class="btn" data-agent-shot>电脑截投屏</button>
    </div>` : `<p class="hint">电脑取图要在电脑助手提供的地址里用：手机浏览器打开 <b>http://电脑IP:8770/</b>，从那里进比价单。</p>`}
    <div class="modal-actions">
      <button class="btn" data-camera-shot>拍照</button>
      <button class="btn" data-close-x>关闭</button>
    </div>
    <p class="hint">点应用直接进 App（没装则打开网页）；截图后切回本页会自动弹出「上传截图」。</p>`);

  const shotInput = $('#file-online');
  const camInput = $('#file-online-cam');
  const launch = (appId) => {
    const app = state.apps.find((a) => String(a.id) === appId);
    if (app) openCompareApp(app, seq);
  };
  $$('[data-app]').forEach((btn) => {
    btn.onclick = (ev) => {
      if (ev.target.closest('[data-del-app]')) return;
      launch(btn.dataset.app);
    };
  });
  $$('[data-builtin]').forEach((btn) => {
    btn.onclick = () => addBuiltinApp(btn.dataset.builtin, seq);
  });
  $$('[data-del-app]').forEach((el) => {
    el.onclick = async (ev) => {
      ev.stopPropagation();
      const app = state.apps.find((a) => String(a.id) === el.dataset.delApp);
      if (!app) return;
      if (!window.confirm(`删除「${app.name}」？`)) return;
      state.apps = state.apps.filter((a) => a.id !== app.id);
      await saveApps();
      openOnlineSheet(seq);
    };
  });
  $('[data-add-app]').onclick = () => openAddApp(seq);
  $('[data-upload-shot]').onclick = () => { shotInput.dataset.seq = String(seq); shotInput.click(); };
  $('[data-camera-shot]').onclick = () => { camInput.dataset.seq = String(seq); camInput.click(); };
  const agentBtn = $('[data-agent-shot]');
  if (agentBtn) agentBtn.onclick = () => { closeModal(); requestAgentShot(seq); };
}

function openAddApp(seq) {
  openModal(`
    <div class="sheet-head"><h3>添加比价应用</h3><button class="icon-btn" data-close-x>×</button></div>
    <label class="field"><span>应用名称</span><input class="input" id="app-name" placeholder="例如 拼多多"></label>
    <label class="field"><span>链接</span><input class="input" id="app-url" inputmode="url" placeholder="https://m.pinduoduo.com"></label>
    <button class="btn small ghost" id="app-paste">从剪贴板粘贴链接</button>
    <p class="hint">填 https:// 开头的网址最稳；App 专用链接（如 taobao://）部分手机会被浏览器拦截。</p>
    <div class="modal-actions">
      <button class="btn" data-close-x>取消</button>
      <button class="btn primary" id="app-save">保存</button>
    </div>`);
  $('#app-paste').onclick = async () => {
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (!text) { toast('剪贴板是空的', 'error'); return; }
      $('#app-url').value = text;
      if (!$('#app-name').value.trim()) {
        try { $('#app-name').value = new URL(normalizeUrl(text)).hostname.replace(/^www\./, ''); } catch (err) { /* ignore */ }
      }
    } catch (err) {
      toast('读不到剪贴板，请手动粘贴', 'error');
    }
  };
  $('#app-save').onclick = async () => {
    const name = $('#app-name').value.trim();
    const url = normalizeUrl($('#app-url').value);
    if (!name) { toast('请填应用名称', 'error'); return; }
    if (!url) { toast('请填链接', 'error'); return; }
    state.apps.push({ id: 'app' + Date.now(), name, url, createdAt: nowText() });
    await saveApps();
    closeModal();
    openOnlineSheet(seq);
    toast(`已添加「${name}」`, 'ok');
  };
}

async function openCompareApp(app, seq) {
  await setPendingShot({ seq, appName: app.name, appId: app.id, at: Date.now(), prompted: false });
  closeModal();
  app.lastUsedAt = Date.now();
  app.lastMode = isAndroid() && app.androidPackage ? 'intent' : (isIOS() ? 'ios' : 'https');
  await saveApps();
  const target = buildLaunchUrl(app);
  let opened = null;
  try {
    opened = window.open(target, '_blank');
  } catch (err) {
    opened = null;
  }
  if (!opened) {
    location.href = target;
    return;
  }
  toast(`正在打开「${app.name}」，截图后切回来`, 'ok');
}

async function maybePromptReturn() {
  const pending = state.pendingShot;
  if (!pending || pending.prompted) return;
  if (state.view !== 'list' || !state.sheet) return;
  const item = state.items.find((i) => i.seq === pending.seq);
  if (!item) return;
  state.pendingShot = Object.assign({}, pending, { prompted: true });
  await dbPut(STORE_KV, state.pendingShot, 'pending_shot');
  flashItem(pending.seq);
  const shots = onlinePhotos(pending.seq);
  openModal(`
    <div class="sheet-head"><h3>已回到比价单</h3><button class="icon-btn" data-close-x>×</button></div>
    <p><strong>第 ${item.seq} 项 · ${esc(item.name)}</strong></p>
    <p class="muted">刚从「${esc(pending.appName || '比价应用')}」回来，截好图了吗？</p>
    <div class="modal-actions">
      <button class="btn primary block" id="return-upload">上传截图${shots.length ? `（已加 ${shots.length} 张）` : ''}</button>
    </div>
    <div class="modal-actions">
      <button class="btn small" id="return-ok">进去了 ✓</button>
      <button class="btn small" id="return-fail">没打开 ✗</button>
      <button class="btn" id="return-close">先不传</button>
    </div>`);
  const markLaunch = async (ok) => {
    if (pending.appId) await noteLaunchResult(pending.appId, ok);
    toast(ok ? '已记住这个应用可以直接打开' : '已记住，下次改用网页打开', 'ok');
  };
  $('#return-ok').onclick = () => markLaunch(true);
  $('#return-fail').onclick = () => markLaunch(false);
  $('#return-upload').onclick = () => {
    const shotInput = $('#file-online');
    shotInput.dataset.seq = String(item.seq);
    shotInput.click();
  };
  $('#return-close').onclick = async () => {
    closeModal();
    await setPendingShot(null);
  };
}

function flashItem(seq) {
  const card = $(`.item[data-seq="${seq}"]`);
  if (!card) return;
  card.scrollIntoView({ block: 'center', behavior: 'smooth' });
  card.classList.add('flash');
  setTimeout(() => card.classList.remove('flash'), 2000);
}

/* ------------------------------ 事件绑定 ------------------------------ */
function bindGlobal() {
  $('#file-note').onchange = (ev) => {
    const file = ev.target.files[0];
    ev.target.value = '';
    if (file) importWorkbook(file);
  };
  $('#file-shot').onchange = async (ev) => {
    const files = Array.from(ev.target.files || []);
    const seq = state.shotSeq;
    ev.target.value = '';
    if (!files.length || !seq) return;
    await addPhotos(files, { kind: 'online', seq });
    render();
  };
  $('#file-photo').onchange = (ev) => {
    const files = Array.from(ev.target.files || []);
    const seq = ev.target.dataset.seq;
    ev.target.value = '';
    const target = seq ? { kind: 'item', seq: Number(seq) } : { kind: 'extra', seq: null };
    if (files.length) addPhotos(files, target);
  };
  const handleShot = async (ev) => {
    const files = Array.from(ev.target.files || []);
    const seq = Number(ev.target.dataset.seq || 0);
    ev.target.value = '';
    if (!files.length || !seq) return;
    const appName = (state.pendingShot && state.pendingShot.appName) || '';
    await addPhotos(files, { kind: 'online', seq, appName });
    await setPendingShot(null);
    openOnlineSheet(seq);
  };
  $('#file-online').onchange = handleShot;
  $('#file-online-cam').onchange = handleShot;
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
          syncSoon();
          render();
        };
      }
    }
  });
  const version = document.querySelector('meta[name="app-version"]');
  if (version) version.content = '20261122131731-ad76c30f';

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { state.awayAt = Date.now(); return; }
    const away = state.awayAt ? Date.now() - state.awayAt : 0;
    state.awayAt = 0;
    if (away >= OUTSIDE_WAIT_MS) maybePromptReturn();
    if (state.waitTask) pollAgentShot();
  });
  window.addEventListener('pageshow', () => { maybePromptReturn(); });
}

async function init() {
  try {
    const settings = await dbGet(STORE_KV, 'settings');
    if (settings) state.settings = Object.assign(state.settings, settings);
    await loadApps();
    await loadAgent();
    await restoreWaitTask();
  if (agentBase()) {
    startAgentPoll();
    setInterval(() => { if (document.visibilityState === 'visible') syncSheetToAgent(); }, 10000);
  }
    await loadPendingShot();
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
