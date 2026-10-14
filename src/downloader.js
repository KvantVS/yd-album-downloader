'use strict';

/* =========================================================================
 * Настройки
 * ========================================================================= */
// Порядок попыток. DEFAULT не описан в задаче — ставим последним запасным вариантом.
const SIZE_ORDER = ['ORIGINAL', 'XXXL', 'XXL', 'XL', 'L', 'M', 'S', 'XS', 'XXS', 'XXXS', 'DEFAULT'];
const CONCURRENCY = 3;        // одновременных скачиваний
const ALBUMS_PAGE = 40;       // amount для albums-list: Диск разрешает только 40
let itemsPageSize = 200;      // amount для album-with-items: разрешено 200 (если сервер не примет — откат на 40)
const ITEMS_PAGE_FALLBACK = 40;
const OPEN_TIMEOUT = 4000;    // мс: если файл не начал отдаваться за 4 с — размер считаем недоступным
const STALL_TIMEOUT = 20000;  // мс: если после начала скачивания данные не приходят 20 с — обрыв

/* =========================================================================
 * Утилиты
 * ========================================================================= */
const $ = (id) => document.getElementById(id);

// Запрещённые символы Windows/macOS/Linux + управляющие символы → "_"
function sanitize(name, maxLen = 150) {
  let s = String(name ?? '').normalize('NFC').replace(/[<>:"\/\\|?*\u0000-\u001F\u007F]/g, '_');
  s = s.replace(/^ +/, (m) => '_'.repeat(m.length));
  if (s.length > maxLen) s = s.slice(0, maxLen);
  s = s.replace(/[. ]+$/, (m) => '_'.repeat(m.length)); // Windows не любит точку/пробел в конце
  if (!s) s = '_';
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i.test(s)) s = '_' + s;
  return s;
}

function splitName(name) {
  const i = name.lastIndexOf('.');
  return i > 0 && i < name.length - 1 ? [name.slice(0, i), name.slice(i + 1)] : [name, ''];
}

const TYPE_EXT = {
  'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'image/gif': 'gif', 'image/heic': 'heic', 'image/heif': 'heif', 'image/avif': 'avif', 'image/bmp': 'bmp'
};
const extFromType = (t) => TYPE_EXT[(t || '').split(';')[0].trim().toLowerCase()] || '';

const normUrl = (u) => (u.startsWith('//') ? 'https:' + u : u);

function parseAlbumLines(text) {
  const out = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const bar = line.lastIndexOf('|');
    const name = bar >= 0 ? line.slice(0, bar).trim() : '';
    const link = (bar >= 0 ? line.slice(bar + 1) : line).trim();
    const clean = link.split(/[?#]/)[0].replace(/\/+$/, '');
    const id = clean.split('/').pop();
    if (id) out.push({ id: decodeURIComponent(id), name });
  }
  return out;
}

/* =========================================================================
 * IndexedDB: журнал по каждому файлу + сохранённый дескриптор папки
 * ========================================================================= */
let dbPromise;
function db() {
  return dbPromise || (dbPromise = new Promise((resolve, reject) => {
    const r = indexedDB.open('ydAlbumDownloader', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('items', { keyPath: 'key' }).createIndex('albumId', 'albumId');
      d.createObjectStore('kv');
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }));
}
function tx(store, mode, fn) {
  return db().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req && req.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}
const putItem = (rec) => tx('items', 'readwrite', (s) => s.put(rec));
const allItems = () => tx('items', 'readonly', (s) => s.getAll());
const albumItems = (id) => tx('items', 'readonly', (s) => s.index('albumId').getAll(id));
const clearItems = () => tx('items', 'readwrite', (s) => s.clear());
const kvGet = (k) => tx('kv', 'readonly', (s) => s.get(k));
const kvSet = (k, v) => tx('kv', 'readwrite', (s) => s.put(v, k));

/* =========================================================================
 * Журнал на экране
 * ========================================================================= */
const logEl = $('log');
function log(msg, cls = '') {
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = `${new Date().toLocaleTimeString()}  ${msg}`;
  logEl.appendChild(line);
  while (logEl.childNodes.length > 1500) logEl.removeChild(logEl.firstChild);
  logEl.scrollTop = logEl.scrollHeight;
}

/* =========================================================================
 * Папка назначения
 * ========================================================================= */
let rootDir = null;

async function showDir() {
  if (!rootDir) {
    $('dirName').textContent = 'папка не выбрана';
    $('grantDir').hidden = true;
    return;
  }
  const perm = await rootDir.queryPermission({ mode: 'readwrite' });
  $('dirName').textContent = rootDir.name;
  $('grantDir').hidden = perm === 'granted';
}

async function ensurePermission() {
  if (!rootDir) throw new Error('Сначала выберите папку для сохранения');
  if ((await rootDir.queryPermission({ mode: 'readwrite' })) === 'granted') return;
  if ((await rootDir.requestPermission({ mode: 'readwrite' })) !== 'granted') {
    throw new Error('Нет доступа к папке');
  }
  await showDir();
}

$('pickDir').onclick = async () => {
  try {
    rootDir = await window.showDirectoryPicker({ mode: 'readwrite', id: 'yd-albums' });
    await kvSet('rootDir', rootDir);
    await showDir();
  } catch (e) {
    if (e.name !== 'AbortError') log('Не удалось выбрать папку: ' + e.message, 'bad');
  }
};
$('grantDir').onclick = async () => {
  try { await ensurePermission(); } catch (e) { log(e.message, 'bad'); }
};

/* =========================================================================
 * Запросы к Яндекс.Диску
 * ========================================================================= */
const BASE = 'https://disk.yandex.ru';
let session = null;

const normLogin = (l) => String(l || '').trim().toLowerCase().replace(/-/g, '.'); // у Яндекса «.» и «-» в логине равнозначны

// Логин того, кто сейчас вошёл в браузере (cookie yandex_login; читается только она)
async function getCurrentLogin() {
  try {
    const c = await chrome.cookies.get({ url: BASE + '/', name: 'yandex_login' });
    return c?.value ? decodeURIComponent(c.value) : null;
  } catch { return null; }
}

// Все пары {uid, login}, найденные в JSON внутри <script> (там могут быть и другие пользователи, например семья)
function collectUsers(html) {
  const found = [];
  const visit = (o, depth) => {
    if (!o || typeof o !== 'object' || depth > 14) return;
    if (Array.isArray(o)) { o.forEach((v) => visit(v, depth + 1)); return; }
    if (/^\d{3,}$/.test(String(o.uid ?? '')) && typeof o.login === 'string') {
      found.push({ uid: String(o.uid), login: o.login });
    }
    for (const v of Object.values(o)) visit(v, depth + 1);
  };
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html'); // скрипты при этом не выполняются
    for (const sc of doc.querySelectorAll('script')) {
      const t = (sc.textContent || '').trim();
      if (t[0] !== '{' && t[0] !== '[') continue;
      try { visit(JSON.parse(t), 0); } catch { /* не JSON — пропускаем */ }
    }
  } catch { /* ignore */ }
  if (!found.length) { // запасной вариант: плоский объект {…"uid":…,"login":……} прямо в тексте страницы
    for (const m of html.matchAll(/\{[^{}]*\}/g)) {
      const obj = m[0];
      const l = obj.match(/"login"\s*:\s*"([^"]+)"/);
      const u = obj.match(/"uid"\s*:\s*"?(\d{3,})"?/);
      if (l && u) found.push({ uid: u[1], login: l[1] }); // uid и login строго из одного объекта
    }
  }
  return found;
}

// uid берём только если он точно принадлежит тому, кто вошёл
function pickUid(users, login) {
  if (login) {
    const mine = users.find((u) => normLogin(u.login) === normLogin(login));
    if (mine) return mine.uid;
  }
  const uniq = [...new Set(users.map((u) => u.uid))];
  return !login && uniq.length === 1 ? uniq[0] : null; // несколько пользователей и логин неизвестен — не гадаем
}

const makeConnectionId = (uid, sk) => {
  const ts = String(sk || '').split(':')[1];
  return uid && ts ? `${uid}${ts}110` : undefined; // так формирует сам Диск: uid + метка времени из sk + «110»
};

async function getSession(force = false) {
  if (session && !force) return session;
  const res = await fetch(BASE + '/client/albums', { credentials: 'include' });
  const html = await res.text();
  // sk лежит в JSON внутри <script>: "sk":"…"
  const m = html.match(/"sk"\s*:\s*"([0-9a-f]{16,}:\d+)"/i) || html.match(/"sk"\s*:\s*"([^"]+)"/);
  if (!m) throw new Error('Не найден токен sk. Войдите в Яндекс.Диск в этом браузере и обновите страницу расширения');
  const sk = m[1];
  const uid = pickUid(collectUsers(html), await getCurrentLogin());
  if (!session || force) log(uid ? 'Сессия получена: sk и uid найдены на странице' : 'Сессия получена: sk найден, uid определить не удалось (запросы пойдут без connection_id)', uid ? '' : 'warn');
  return (session = { sk, uid, connectionId: makeConnectionId(uid, sk) });
}

// Формат тела взят из DevTools: {sk, connection_id, apiMethod, requestParams}
async function modelsRequest(apiMethod, requestParams, retried = false) {
  const { sk, connectionId } = await getSession();
  const res = await fetch(`https://disk.yandex.ru/models-v2?m=${apiMethod}`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'Accept': '*/*',
      'X-Requested-With': 'XMLHttpRequest',
      'X-Retpath-Y': 'https://disk.yandex.ru/client/albums'
    },
    body: JSON.stringify({ sk, connection_id: connectionId, apiMethod, requestParams })
  });
  if (!res.ok) {
    if (!retried && (res.status === 400 || res.status === 403)) { // возможно, протух sk
      await getSession(true);
      return modelsRequest(apiMethod, requestParams, true);
    }
    throw new Error('HTTP ' + res.status);
  }
  const data = await res.json();
  if (data && !Array.isArray(data) && data.error) throw new Error('API: ' + JSON.stringify(data.error).slice(0, 200));
  return data;
}

// Список альбомов: ответ — просто массив. Обычные альбомы (album_type=null) и геоальбомы ('geo') запрашиваются отдельно.
async function fetchAlbumList() {
  const out = new Map();
  let ownerUid = null;
  for (const type of [null, 'geo']) {
    for (let offset = 0; ; ) {
      let list;
      try {
        list = await modelsRequest('mpfs/albums-list', { offset, amount: ALBUMS_PAGE, album_type: type });
      } catch (e) {
        if (type === null) throw e;
        log(`Список альбомов «${type}»: ${e.message}`, 'warn');
        break;
      }
      if (!Array.isArray(list) || !list.length) break;
      let added = 0;
      for (const a of list) {
        if (!a?.id || out.has(a.id)) continue;
        ownerUid = ownerUid || a.user?.uid || a.uid || null;
        out.set(a.id, { id: a.id, title: a.title || a.id, type: a.album_type || type || '' });
        added++;
      }
      if (!added) break;
      offset += list.length;
    }
  }
  // Перепроверка: владелец альбомов — точно текущий пользователь. Если uid со страницы не совпал, доверяем ответу API.
  if (ownerUid && session && session.uid !== String(ownerUid)) {
    log('uid со страницы не совпал с владельцем альбомов — использую uid из ответа API', 'warn');
    session.uid = String(ownerUid);
    session.connectionId = makeConnectionId(session.uid, session.sk);
  }
  return [...out.values()];
}

const itemName = (r) => r.name || r.meta?.name || r.meta?.file_name || '';
const itemKey = (r) => String(
  r.id ?? r.resource_id ?? r.meta?.resource_id ?? r.path ?? r.meta?.path ?? `${itemName(r)}:${r.meta?.etime ?? ''}`
);
function isVideo(r) {
  const mt = r.meta?.mediatype || r.meta?.media_type || r.media_type;
  const mime = r.meta?.mimetype || r.mimetype || '';
  return mt === 'video' || /^video\//i.test(mime);
}

// Пагинация (по HAR): первая страница — load_album_data=true; следующие — load_album_data=false
// и last_item_id = itemId последнего фото предыдущей страницы.
async function fetchAlbum(albumId) {
  const seen = new Set();
  const items = [];
  let title = null;
  let lastItemId = null;
  for (let page = 1; ; page++) {
    const makeParams = (amount) => {
      const p = { album_id: albumId, amount, load_album_data: page === 1 };
      if (lastItemId) p.last_item_id = lastItemId;
      return p;
    };
    let data;
    try {
      data = await modelsRequest('mpfs/album-with-items', makeParams(itemsPageSize));
    } catch (e) {
      if (page === 1 && itemsPageSize > ITEMS_PAGE_FALLBACK) {
        log(`Сервер не принял amount=${itemsPageSize} (${e.message}), перехожу на ${ITEMS_PAGE_FALLBACK}`, 'warn');
        itemsPageSize = ITEMS_PAGE_FALLBACK;
        data = await modelsRequest('mpfs/album-with-items', makeParams(itemsPageSize));
      } else throw e;
    }
    title = title || data?.album?.title || null;
    const list = data?.resources ?? [];
    let added = 0;
    for (const r of list) {
      const k = itemKey(r);
      if (seen.has(k)) continue;
      seen.add(k);
      items.push(r);
      added++;
    }
    if (page > 1) log(`  страница ${page}: получено ${list.length}, новых ${added}`);
    if (!list.length) break;
    if (!added) {
      log('Сервер вернул уже полученные фото — остановил листание альбома', 'warn');
      break;
    }
    lastItemId = list[list.length - 1].itemId;
    if (!lastItemId) {
      log('У последнего фото нет itemId — не могу запросить следующую страницу', 'warn');
      break;
    }
  }
  return { items, title };
}

// OPEN_TIMEOUT — на получение ответа (файл «открылся»), STALL_TIMEOUT — на паузу между кусками данных.
// Так большой оригинал на медленном канале не отваливается, а недоступный размер отсеивается за 4 секунды.
async function fetchBlob(url) {
  const ctrl = new AbortController();
  let reason = '';
  const abort = (r) => { reason = r; ctrl.abort(); };
  let timer = setTimeout(() => abort(`нет ответа за ${OPEN_TIMEOUT / 1000} с`), OPEN_TIMEOUT);
  try {
    const res = await fetch(normUrl(url), { credentials: 'include', cache: 'no-store', signal: ctrl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const type = res.headers.get('content-type') || '';
    if (/text\/html|application\/json/i.test(type)) throw new Error('получен не файл (' + type + ')');

    const chunks = [];
    let received = 0;
    const reader = res.body.getReader();
    for (;;) {
      clearTimeout(timer);
      timer = setTimeout(() => abort('данные перестали поступать'), STALL_TIMEOUT);
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
    }
    if (!received) throw new Error('пустой файл');
    const cl = Number(res.headers.get('content-length'));
    if (cl && !res.headers.get('content-encoding') && cl !== received) {
      throw new Error(`файл скачан не полностью (${received} из ${cl})`);
    }
    return { blob: new Blob(chunks, { type }), type };
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? (reason || 'прервано') : e.message);
  } finally {
    clearTimeout(timer);
  }
}

/* =========================================================================
 * Список альбомов
 * ========================================================================= */
let albumList = [];            // [{id, title, type}]
const selected = new Set();    // id выбранных альбомов

function updateCount() {
  $('albumCount').textContent = albumList.length ? `выбрано ${selected.size} из ${albumList.length}` : '';
}

function renderAlbums() {
  const box = $('albumList');
  const q = $('albumFilter').value.trim().toLowerCase();
  box.textContent = '';
  const shown = albumList.filter((a) => !q || a.title.toLowerCase().includes(q));
  if (!shown.length) {
    const p = document.createElement('p');
    p.className = 'muted empty';
    p.textContent = albumList.length ? 'Ничего не найдено' : 'Нажмите «Загрузить список альбомов».';
    box.append(p);
  }
  for (const a of shown) {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = selected.has(a.id);
    cb.onchange = () => {
      cb.checked ? selected.add(a.id) : selected.delete(a.id);
      updateCount();
      kvSet('selected', [...selected]);
    };
    const name = document.createElement('span');
    name.textContent = a.title;
    label.append(cb, name);
    if (a.type === 'geo') {
      const k = document.createElement('span');
      k.className = 'kind';
      k.textContent = 'геоальбом';
      label.append(k);
    }
    box.append(label);
  }
  updateCount();
}

$('albumFilter').oninput = renderAlbums;
$('selAll').onclick = () => {
  const q = $('albumFilter').value.trim().toLowerCase();
  albumList.filter((a) => !q || a.title.toLowerCase().includes(q)).forEach((a) => selected.add(a.id));
  kvSet('selected', [...selected]);
  renderAlbums();
};
$('selNone').onclick = () => { selected.clear(); kvSet('selected', []); renderAlbums(); };

$('loadAlbums').onclick = async () => {
  $('loadAlbums').disabled = true;
  try {
    log('Загружаю список альбомов…');
    albumList = await fetchAlbumList();
    for (const id of [...selected]) if (!albumList.some((a) => a.id === id)) selected.delete(id);
    await kvSet('albumList', albumList);
    await kvSet('selected', [...selected]);
    log(`Найдено альбомов: ${albumList.length}`, 'ok');
    renderAlbums();
  } catch (e) {
    log('Не удалось получить список альбомов — ' + e.message, 'bad');
  } finally {
    $('loadAlbums').disabled = false;
  }
};

/* =========================================================================
 * Скачивание
 * ========================================================================= */
let stopFlag = false;
let running = false;
let done = 0, total = 0;

function setProgress() {
  $('barFill').style.width = total ? `${Math.round((done / total) * 100)}%` : '0';
  $('progressText').textContent = total ? `${done} из ${total}` : '';
}

async function pool(tasks, n, worker) {
  let i = 0;
  const run = async () => {
    while (!stopFlag && i < tasks.length) await worker(tasks[i++]);
  };
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, run));
}

async function writeFile(dirHandle, fileName, blob) {
  const fh = await dirHandle.getFileHandle(fileName, { create: true });
  const w = await fh.createWritable();
  try { await w.write(blob); } finally { await w.close(); }
}

async function handlePhoto(ctx, t) {
  const { dirHandle, albumId, albumName, dirName } = ctx;
  const { r, key, baseName, prev } = t;
  const label = `[${albumName}] ${itemName(r) || key}`;

  // Сколько размеров пробовать: при повторе — только лучше, чем уже скачано
  const prevRank = prev && prev.status !== 'failed' ? SIZE_ORDER.indexOf(prev.size) : SIZE_ORDER.length;
  const limit = prevRank < 0 ? SIZE_ORDER.length : prevRank;

  const sizes = new Map((r.meta?.sizes || []).map((s) => [s.name, s.url]));
  const errors = [];
  let got = null, gotSize = null;

  for (let i = 0; i < limit && !stopFlag; i++) {
    const sizeName = SIZE_ORDER[i];
    const url = sizes.get(sizeName);
    if (!url) { errors.push(`${sizeName}: нет ссылки`); continue; }
    try {
      got = await fetchBlob(url);
      gotSize = sizeName;
      break;
    } catch (e) {
      errors.push(`${sizeName}: ${e.message}`);
    }
  }

  if (stopFlag && !got) return;

  const base = {
    key, albumId, albumName, dir: dirName, itemKey: itemKey(r), baseName, time: new Date().toISOString()
  };

  if (!got) {
    if (prev && prev.status === 'fallback') {
      log(`${label}: размер лучше ${prev.size} получить не удалось, оставлен ${prev.size}`, 'warn');
    } else {
      await putItem({ ...base, fileName: prev?.fileName || '', status: 'failed', size: '', error: errors.join('; ') });
      log(`${label}: НЕ СКАЧАНО (${errors.join('; ')})`, 'bad');
    }
  } else {
    const [, origExt] = splitName(itemName(r));
    let ext = origExt;
    if (gotSize !== 'ORIGINAL' || !ext) ext = extFromType(got.type) || ext || 'jpg';
    ext = ext.replace(/[^A-Za-z0-9]/g, '') || 'jpg';
    const fileName = `${baseName}.${ext}`;
    try {
      await writeFile(dirHandle, fileName, got.blob);
      if (prev?.fileName && prev.fileName !== fileName) {
        await dirHandle.removeEntry(prev.fileName).catch(() => {});
      }
      const status = gotSize === 'ORIGINAL' ? 'original' : 'fallback';
      await putItem({ ...base, fileName, status, size: gotSize, error: '' });
      log(`${label}: ${gotSize}`, status === 'original' ? 'ok' : 'warn');
    } catch (e) {
      await putItem({ ...base, fileName: prev?.fileName || '', status: prev?.status || 'failed', size: prev?.size || '', error: 'Ошибка записи: ' + e.message });
      log(`${label}: ошибка записи на диск — ${e.message}`, 'bad');
    }
  }
  done++;
  setProgress();
  scheduleStats();
}

// mode: 'new' — только новые фото; 'retry' — только фото, скачанные не в ORIGINAL или не скачанные
async function prepareAlbum(ref, mode, rootHandle) {
  const { items, title } = await fetchAlbum(ref.id);
  const prevRecords = await albumItems(ref.id);
  const prevByKey = new Map(prevRecords.map((p) => [p.key, p]));
  const albumName = ref.name || prevRecords[0]?.albumName || title || ref.id;
  const dirName = prevRecords[0]?.dir || sanitize(albumName);
  if (dirName !== albumName) log(`Название папки «${albumName}» → «${dirName}»`);
  const dirHandle = await rootHandle.getDirectoryHandle(dirName, { create: true });

  const used = new Set(prevRecords.map((p) => p.baseName.toLowerCase()));
  const tasks = [];
  let videos = 0, skipped = 0;

  items.forEach((r, idx) => {
    const key = `${ref.id}|${itemKey(r)}`;
    const prev = prevByKey.get(key);

    if (isVideo(r)) {
      videos++;
      if (!prev) putItem({ key, albumId: ref.id, albumName, dir: dirName, itemKey: itemKey(r), baseName: '', fileName: '',
        status: 'video', size: '', error: '', time: new Date().toISOString() });
      return;
    }
    if (mode === 'new' && prev) { skipped++; return; }
    if (mode === 'retry' && (!prev || prev.status === 'original')) { skipped++; return; }

    let baseName = prev?.baseName;
    if (!baseName) {
      const [b] = splitName(itemName(r) || `photo_${idx + 1}`);
      const clean = sanitize(b);
      baseName = clean;
      for (let n = 2; used.has(baseName.toLowerCase()); n++) baseName = `${clean} (${n})`;
      used.add(baseName.toLowerCase());
    }
    tasks.push({ r, key, baseName, prev });
  });

  log(`Альбом «${albumName}»: всего ${items.length}, к скачиванию ${tasks.length}, пропущено ${skipped}, видео ${videos}`);
  return { ctx: { dirHandle, albumId: ref.id, albumName, dirName }, tasks };
}

async function runJob(mode) {
  if (running) return;
  try {
    await ensurePermission();
    const refMap = new Map();
    for (const a of albumList) if (selected.has(a.id)) refMap.set(a.id, { id: a.id, name: a.title });
    for (const r of parseAlbumLines($('albums').value)) if (!refMap.has(r.id)) refMap.set(r.id, r);
    let refs = [...refMap.values()];
    if (!refs.length && mode === 'retry') {
      const ids = new Map();
      (await allItems()).forEach((i) => ids.set(i.albumId, i.albumName));
      refs = [...ids].map(([id, name]) => ({ id, name }));
    }
    if (!refs.length) throw new Error('Отметьте хотя бы один альбом в списке');

    running = true; stopFlag = false; done = 0; total = 0; setProgress();
    setButtons();
    log(mode === 'retry' ? '— Повторное скачивание —' : '— Скачивание —');

    // Сначала собираем задачи по всем альбомам, чтобы показать общий прогресс
    const jobs = [];
    for (const ref of refs) {
      if (stopFlag) break;
      try {
        const job = await prepareAlbum(ref, mode, rootDir);
        jobs.push(job);
        total += job.tasks.length;
        setProgress();
      } catch (e) {
        log(`Альбом ${ref.id}: не удалось получить список — ${e.message}`, 'bad');
      }
    }
    for (const { ctx, tasks } of jobs) {
      await pool(tasks, CONCURRENCY, (t) => handlePhoto(ctx, t));
    }
    log(stopFlag ? 'Остановлено' : 'Готово', stopFlag ? 'warn' : 'ok');
  } catch (e) {
    log(e.message, 'bad');
  } finally {
    running = false;
    setButtons();
    scheduleStats(true);
  }
}

function setButtons() {
  $('start').disabled = running;
  $('retry').disabled = running;
  $('stop').disabled = !running;
}
$('start').onclick = () => runJob('new');
$('retry').onclick = () => runJob('retry');
$('stop').onclick = () => { stopFlag = true; log('Останавливаю…', 'warn'); };

/* =========================================================================
 * Статистика
 * ========================================================================= */
let statsTimer = null;
function scheduleStats(now) {
  if (now) { clearTimeout(statsTimer); statsTimer = null; renderStats(); return; }
  if (!statsTimer) statsTimer = setTimeout(() => { statsTimer = null; renderStats(); }, 400);
}

function td(text, cls, title) {
  const c = document.createElement('td');
  c.textContent = text;
  if (cls) c.className = cls;
  if (title) c.title = title;
  return c;
}

async function renderStats() {
  const items = await allItems();
  const albums = new Map();
  for (const i of items) {
    if (!albums.has(i.albumId)) {
      albums.set(i.albumId, { name: i.albumName, original: 0, fallback: 0, failed: 0, video: 0, sizes: {} });
    }
    const a = albums.get(i.albumId);
    if (i.status === 'original') a.original++;
    else if (i.status === 'fallback') { a.fallback++; a.sizes[i.size] = (a.sizes[i.size] || 0) + 1; }
    else if (i.status === 'failed') a.failed++;
    else if (i.status === 'video') a.video++;
  }

  const body = $('stats').tBodies[0];
  const foot = $('stats').tFoot;
  body.textContent = '';
  foot.textContent = '';
  const sum = { all: 0, original: 0, fallback: 0, failed: 0, video: 0 };

  const sizeTitle = (sizes) => SIZE_ORDER.filter((s) => sizes[s]).map((s) => `${s}: ${sizes[s]}`).join(', ');

  for (const a of albums.values()) {
    const all = a.original + a.fallback + a.failed;
    const tr = document.createElement('tr');
    tr.append(
      td(a.name), td(all), td(a.original, 'ok'),
      td(a.fallback, a.fallback ? 'warn' : '', sizeTitle(a.sizes)),
      td(a.failed, a.failed ? 'bad' : ''), td(a.video)
    );
    body.append(tr);
    sum.all += all; sum.original += a.original; sum.fallback += a.fallback; sum.failed += a.failed; sum.video += a.video;
  }
  if (!albums.size) {
    const tr = document.createElement('tr');
    const c = td('Пока пусто — укажите альбом и нажмите «Скачать»');
    c.colSpan = 6; c.className = 'muted';
    tr.append(c); body.append(tr);
    return;
  }
  const tr = document.createElement('tr');
  tr.append(td('Итого'), td(sum.all), td(sum.original, 'ok'), td(sum.fallback, sum.fallback ? 'warn' : ''),
    td(sum.failed, sum.failed ? 'bad' : ''), td(sum.video));
  foot.append(tr);
}

/* =========================================================================
 * Экспорт и очистка
 * ========================================================================= */
$('exportCsv').onclick = async () => {
  const items = await allItems();
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['Альбом', 'Папка', 'Файл', 'Статус', 'Размер', 'Ошибка', 'Время', 'ID'];
  const rows = items.map((i) => [i.albumName, i.dir, i.fileName, i.status, i.size, i.error, i.time, i.itemKey].map(esc).join(','));
  const csv = '\ufeff' + [head.map(esc).join(','), ...rows].join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `yd-albums-log-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};

$('clearDb').onclick = async () => {
  if (!confirm('Удалить журнал и статистику? Скачанные файлы на диске останутся.')) return;
  await clearItems();
  log('База очищена');
  scheduleStats(true);
};

/* =========================================================================
 * Старт
 * ========================================================================= */
(async () => {
  setButtons();
  try { rootDir = (await kvGet('rootDir')) || null; } catch { rootDir = null; }
  await showDir();
  try {
    albumList = (await kvGet('albumList')) || [];
    (await kvGet('selected') || []).forEach((id) => selected.add(id));
  } catch { albumList = []; }
  renderAlbums();
  await renderStats();
})();
