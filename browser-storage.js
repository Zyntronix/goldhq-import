const DB_NAME = 'eagler26';
const DB_VERSION = 1;
const FILE_STORE = 'entries';
const META_STORE = 'metadata';
const COOKIE_STORE = 'cookies';
const LARGE_FILE_BYTES = 512 * 1024;

const state = globalThis.__eaglerStorage = {
  ready: false, persistent: false, health: 'opening', error: null, readOnly: false, db: null,
  tabId: crypto.randomUUID(), owner: null, channel: null, lockRelease: null,
  files: new Map(), dirty: new Map(), volatile: new Set(), flushPromise: null,
  metrics: {openMs: 0, hydrationMs: 0, bytesLoaded: 0, writes: 0, flushMs: 0}
};

function normalize(path) {
  if (typeof path !== 'string') throw new TypeError('path must be a string');
  const parts = path.replaceAll('\\', '/').split('/');
  const out = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') throw new Error('path traversal rejected');
    out.push(part);
  }
  return out.join('/');
}
function request(req) { return new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); }); }
function transaction(store, mode = 'readonly') { return state.db.transaction(store, mode).objectStore(store); }
function bytes(value) { return value instanceof Uint8Array ? value : new Uint8Array(value); }

async function open() {
  const started = performance.now();
  if (!globalThis.indexedDB) throw new Error('IndexedDB is unavailable');
  const req = indexedDB.open(DB_NAME, DB_VERSION);
  req.onupgradeneeded = event => {
    const db = req.result;
    const entries = db.objectStoreNames.contains(FILE_STORE) ? req.transaction.objectStore(FILE_STORE) : db.createObjectStore(FILE_STORE, {keyPath: 'path'});
    if (!entries.indexNames.contains('parent')) entries.createIndex('parent', 'parent', {unique: false});
    if (!entries.indexNames.contains('modifiedTime')) entries.createIndex('modifiedTime', 'modifiedTime', {unique: false});
    if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE, {keyPath: 'key'});
    if (!db.objectStoreNames.contains(COOKIE_STORE)) {
      const cookies = db.createObjectStore(COOKIE_STORE, {keyPath: 'key'});
      cookies.createIndex('expiresAt', 'expiresAt', {unique: false});
    }
  };
  state.db = await request(req);
  if (navigator.locks?.request) {
    await new Promise(resolve => {
      navigator.locks.request('eagler26-write-owner', {ifAvailable: true}, lock => {
        if (!lock) { state.readOnly = true; resolve(); return; }
        state.owner = 'navigator.locks';
        resolve();
        return new Promise(release => { state.lockRelease = release; });
      });
    });
  }
  const metadata = state.db.transaction(META_STORE, 'readonly').objectStore(META_STORE);
  const format = await request(metadata.get('vfs-format'));
  if (format && format.value !== 1) throw new Error(`Unsupported Eagler26 VFS format ${format.value}; data was preserved`);
  if (!format) {
    const tx = state.db.transaction(META_STORE, 'readwrite');
    tx.objectStore(META_STORE).put({key: 'vfs-format', value: 1, schemaVersion: DB_VERSION});
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
  }
  if (!state.owner && globalThis.BroadcastChannel) {
    state.owner = 'broadcast-channel';
    state.channel = new BroadcastChannel('eagler26-storage');
    state.channel.onmessage = event => { if (event.data?.type === 'writer' && event.data.tabId !== state.tabId) state.readOnly = true; };
    state.channel.postMessage({type: 'writer', tabId: state.tabId});
  }
  state.metrics.openMs = performance.now() - started;
  const hydrationStarted = performance.now();
  const all = await request(transaction(FILE_STORE).getAll());
  for (const entry of all) {
    // Every Eagler26 page on file:// shares this database; skip records this build cannot read instead of failing
    // startup with "Cannot read properties of null (reading 'type')".
    if (!entry || typeof entry !== 'object' || typeof entry.path !== 'string') continue;
    if (entry.type === 'file' && entry.bytes && entry.bytes.byteLength <= LARGE_FILE_BYTES) {
      state.files.set(entry.path, new Uint8Array(entry.bytes));
      state.metrics.bytesLoaded += entry.bytes.byteLength;
    } else state.files.set(entry.path, entry);
  }
  state.metrics.hydrationMs = performance.now() - hydrationStarted;
  state.ready = true;
  state.health = state.readOnly ? 'read-only' : 'persistent';
  // Ask for persistent storage without waiting: Firefox shows a permission prompt and its promise stays pending until
  // the player answers it (forever when the prompt is ignored), which used to hold the boot at "Opening storage".
  try {
    if (navigator.storage?.persist) navigator.storage.persist().then(v => { state.persistent = !!v; }, error => { state.persistent = false; state.error = String(error); });
  } catch (error) { state.persistent = false; state.error = String(error); }
  return state;
}

async function read(path) {
  const key = normalize(path);
  const cached = state.files.get(key);
  if (cached instanceof Uint8Array) return new Uint8Array(cached);
  const entry = cached || await request(transaction(FILE_STORE).get(key));
  if (!entry || entry.type !== 'file') return null;
  const value = bytes(entry.bytes);
  if (value.byteLength <= LARGE_FILE_BYTES) state.files.set(key, new Uint8Array(value));
  return new Uint8Array(value);
}
function mark(path, value) {
  const key = normalize(path);
  state.files.set(key, value instanceof Uint8Array ? new Uint8Array(value) : value);
  if (state.readOnly) return;
  state.dirty.set(key, value);
  scheduleFlush();
}
function write(path, value) { const data = bytes(value); mark(path, data); return true; }
function remove(path) { const key = normalize(path); state.files.delete(key); if (state.volatile.delete(key)) return; state.dirty.set(key, null); scheduleFlush(); }
function scheduleFlush() { if (!state.flushPromise) state.flushPromise = Promise.resolve().then(flush); }
async function flush() {
  const started = performance.now();
  const changes = [...state.dirty.entries()];
  if (state.readOnly) { state.dirty.clear(); state.flushPromise = null; return; }
  if (changes.length) {
    const tx = state.db.transaction(FILE_STORE, 'readwrite'); const store = tx.objectStore(FILE_STORE);
    for (const [path, value] of changes) {
      if (value === null) store.delete(path);
      else if (value.type === 'directory') {
        store.put({path, parent: value.parent || (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''), name: value.name || path.slice(path.lastIndexOf('/') + 1), type: 'directory', size: 0, modifiedTime: value.modifiedTime || Date.now()});
      } else {
        const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
        const name = path.slice(path.lastIndexOf('/') + 1);
        store.put({path, parent, name, type: 'file', bytes: value.buffer, size: value.byteLength, modifiedTime: Date.now()});
      }
    }
    try {
      await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || new Error('storage transaction aborted')); });
    } catch (error) {
      state.health = error?.name === 'QuotaExceededError' ? 'quota-error' : 'error';
      state.error = String(error);
      throw error;
    }
    for (const [path] of changes) if (state.dirty.get(path) === changes.find(item => item[0] === path)?.[1]) state.dirty.delete(path);
    state.metrics.writes += changes.length;
  }
  state.metrics.flushMs = performance.now() - started;
  state.flushPromise = null;
}

function list(path) {
  const parent = normalize(path); const result = new Set();
  for (const key of state.files.keys()) if (key.startsWith(parent ? parent + '/' : '') && !key.slice(parent ? parent.length + 1 : 0).includes('/')) result.add(key.slice(parent ? parent.length + 1 : 0));
  return [...result].sort();
}
function isFile(path) { return state.files.get(normalize(path)) instanceof Uint8Array || state.files.get(normalize(path))?.type === 'file'; }
function isDirectory(path) {
  const key = normalize(path);
  if (!key) return true;
  if (state.files.get(key)?.type === 'directory') return true; // empty directory (mkdirs)
  for (const candidate of state.files.keys()) if (candidate.startsWith(key + '/')) return true;
  return false;
}
function size(path) { const value = state.files.get(normalize(path)); return value instanceof Uint8Array ? value.byteLength : Number(value?.size || 0); }
function modified(path) { return Number(state.files.get(normalize(path))?.modifiedTime || 0); }
function ensureParent(path) { const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''; if (parent && !isDirectory(parent)) mkdirs(parent); }
function mkdirs(path) { const key = normalize(path); if (!key) return true; const pieces = key.split('/'); for (let i = 1; i <= pieces.length; i++) state.files.set(pieces.slice(0, i).join('/'), {type: 'directory', path: pieces.slice(0, i).join('/'), modifiedTime: Date.now()}); return true; }
function mkdir(path, name) { const base = normalize(path); return mkdirs(base ? base + '/' + name : name); }
function createFile(path, name) { const key = normalize(path ? path + '/' + name : name); ensureParent(key); if (state.files.has(key)) return false; mark(key, new Uint8Array(0)); return true; }
function move(from, to) {
  const source = normalize(from); const target = normalize(to); const value = state.files.get(source); if (!value) return false;
  ensureParent(target);
  // A large file hydrated at boot is an entry object ({bytes: ArrayBuffer}); persist its bytes, not an empty file.
  const data = value instanceof Uint8Array ? value : value.type === 'file' && value.bytes ? new Uint8Array(value.bytes) : value;
  state.files.set(target, data); state.files.delete(source); state.volatile.delete(source);
  state.dirty.set(source, null); state.dirty.set(target, data instanceof Uint8Array || data.type === 'directory' ? data : new Uint8Array(0));
  scheduleFlush(); return true;
}
function setModified(path, time) { const key = normalize(path); const value = state.files.get(key); if (!value) return false; if (value instanceof Uint8Array) { state.files.set(key, {type: 'file', bytes: value.buffer, size: value.byteLength, modifiedTime: time}); } else value.modifiedTime = time; return true; }
// Volatile files (downloaded server packs, see browser-packs.js) are visible to Java like any file but never reach
// IndexedDB; their bytes are kept by reference, not copied.
function mountVolatile(path, value) { const key = normalize(path); ensureParent(key); state.files.set(key, bytes(value)); state.volatile.add(key); }
function unmountVolatile(path) { const key = normalize(path); if (!state.volatile.delete(key)) return false; state.files.delete(key); return true; }
// A view (no copy) of bytes [offset, offset + length) of a file, clamped to its size; null if it does not exist.
function readRange(path, offset, length) {
  const value = state.files.get(normalize(path));
  const data = value instanceof Uint8Array ? value : value?.bytes ? new Uint8Array(value.bytes) : null;
  if (!data) return null;
  const start = Math.min(Math.max(0, offset), data.byteLength);
  return data.subarray(start, Math.min(data.byteLength, start + Math.max(0, length)));
}
function readBytes(path) { const value = state.files.get(normalize(path)); return value instanceof Uint8Array ? new Uint8Array(value) : value?.bytes ? new Uint8Array(value.bytes) : null; }
function writeBytes(path, value) { const key = normalize(path); ensureParent(key); mark(key, bytes(value)); }
function removePath(path) { const key = normalize(path); let changed = false; for (const candidate of [...state.files.keys()]) if (candidate === key || candidate.startsWith(key + '/')) { state.files.delete(candidate); if (!state.volatile.delete(candidate)) state.dirty.set(candidate, null); changed = true; } scheduleFlush(); return changed; }
const storageApi = {normalize, read, write, remove, list, flush: () => flush(), exists: async p => (await read(p)) !== null};

function readText(path) {
  const value = state.files.get(normalize(path));
  if (!(value instanceof Uint8Array)) return null;
  return new TextDecoder().decode(value);
}
function writeText(path, value) { write(path, new TextEncoder().encode(value)); }
function has(path) { return state.files.has(normalize(path)); }
storageApi.readText = readText;
storageApi.writeText = writeText;
storageApi.has = has;
storageApi.isFile = isFile;
storageApi.isDirectory = isDirectory;
storageApi.list = list;
storageApi.readBytes = readBytes;
storageApi.readRange = readRange;
storageApi.mountVolatile = mountVolatile;
storageApi.unmountVolatile = unmountVolatile;
storageApi.writeBytes = writeBytes;
storageApi.mkdir = mkdir;
storageApi.mkdirs = mkdirs;
storageApi.createFile = createFile;
storageApi.move = move;
storageApi.size = size;
storageApi.modified = modified;
storageApi.setModified = setModified;
storageApi.remove = removePath;
storageApi.profile = {
  read: () => readText('profile/profile.json'),
  write: value => writeText('profile/profile.json', value)
};
storageApi.cookies = {
  put: async (origin, data, expiresAt = 0, persistent = true) => {
    const tx = state.db.transaction(COOKIE_STORE, 'readwrite');
    tx.objectStore(COOKIE_STORE).put({key: origin, origin, data: bytes(data).buffer, expiresAt, persistent});
    return new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
  },
  get: async origin => {
    const store = transaction(COOKIE_STORE); const value = await request(store.get(origin));
    if (!value || (value.expiresAt && value.expiresAt <= Date.now())) { if (value) transaction(COOKIE_STORE, 'readwrite').delete(origin); return null; }
    return new Uint8Array(value.data);
  },
  remove: async origin => request(transaction(COOKIE_STORE, 'readwrite').delete(origin))
};

globalThis.__eaglerStorageApi = storageApi;
globalThis.__eaglerStorageOpen = open;
globalThis.__eaglerStorageEstimate = async () => navigator.storage?.estimate ? navigator.storage.estimate() : null;
globalThis.__eaglerStorageRequestPersistence = async () => navigator.storage?.persist ? navigator.storage.persist() : false;
addEventListener('pagehide', () => { if (state.ready) void flush(); });
addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && state.ready) void flush(); });
