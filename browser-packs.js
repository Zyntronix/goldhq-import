// globalThis.__eaglerPacks: server resource-pack downloads and the server-pack cache (docs/RESOURCE_PACKS.md).
//
// Java (DownloadedPackSource) starts a job per pushed pack and polls it from the client tick; nothing here calls
// back into Wasm. A job: URL checks -> content-addressed cache lookup (when the server sent a SHA-1) -> streaming
// fetch with progress, idle timeout, size limit and an incremental SHA-1 -> hash check -> volatile VFS mount.
// The pack bytes exist once in JS memory (the mount); the Java ZIP reader reads ranges of it on demand.
//
// Cache: IndexedDB "eagler26-packs", store "packs", one record per SHA-1 {sha1, blob, size, host, savedAt, lastUsed}.
// It is separate from the VFS database, so cached server packs are not loaded into memory at boot. LRU eviction
// keeps it under CACHE_QUOTA_BYTES; packs mounted right now are never evicted. User-imported packs live in the VFS
// (eaglercraft/resourcepacks) and are never touched by this cache.

export const LIMITS = Object.freeze({
  maxPackBytes: 256 * 1024 * 1024,   // larger than any server pack vanilla accepts by default (250 MB)
  idleTimeoutMs: 30000,              // no bytes for this long: timeout
  totalTimeoutMs: 10 * 60000,
  retries: 1,                        // network errors, timeouts and HTTP 5xx only
  cacheQuotaBytes: 512 * 1024 * 1024,
  cacheMaxEntries: 32,
});

const DB_NAME = 'eagler26-packs';
const STORE = 'packs';
const MOUNT_DIR = 'eaglercraft/server-packs';

// ---- SHA-1 (streaming; WebCrypto has no incremental digest) ------------------------------------------------------
export class Sha1 {
  constructor() {
    this.h = new Int32Array([0x67452301, 0xefcdab89 | 0, 0x98badcfe | 0, 0x10325476, 0xc3d2e1f0 | 0]);
    this.w = new Int32Array(80);
    this.block = new Uint8Array(64);
    this.used = 0;
    this.length = 0;
  }
  update(data) {
    let i = 0;
    const n = data.length;
    this.length += n;
    if (this.used) {
      const take = Math.min(64 - this.used, n);
      this.block.set(data.subarray(0, take), this.used);
      this.used += take; i = take;
      if (this.used < 64) return this;
      this.compress(this.block, 0);
      this.used = 0;
    }
    for (; i + 64 <= n; i += 64) this.compress(data, i);
    if (i < n) { this.block.set(data.subarray(i), 0); this.used = n - i; }
    return this;
  }
  compress(b, o) {
    const w = this.w;
    for (let t = 0; t < 16; t++, o += 4) w[t] = b[o] << 24 | b[o + 1] << 16 | b[o + 2] << 8 | b[o + 3];
    for (let t = 16; t < 80; t++) { const x = w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16]; w[t] = x << 1 | x >>> 31; }
    let [a, bb, c, d, e] = this.h;
    for (let t = 0; t < 80; t++) {
      let f, k;
      if (t < 20) { f = bb & c | ~bb & d; k = 0x5a827999; }
      else if (t < 40) { f = bb ^ c ^ d; k = 0x6ed9eba1; }
      else if (t < 60) { f = bb & c | bb & d | c & d; k = 0x8f1bbcdc | 0; }
      else { f = bb ^ c ^ d; k = 0xca62c1d6 | 0; }
      const tmp = ((a << 5 | a >>> 27) + f + e + k + w[t]) | 0;
      e = d; d = c; c = bb << 30 | bb >>> 2; bb = a; a = tmp;
    }
    const h = this.h;
    h[0] += a; h[1] += bb; h[2] += c; h[3] += d; h[4] += e;
  }
  hex() {
    const bits = this.length * 8;
    const pad = new Uint8Array(((this.used < 56 ? 56 : 120) - this.used) + 8);
    pad[0] = 0x80;
    const view = new DataView(pad.buffer);
    view.setUint32(pad.length - 8, Math.floor(bits / 0x100000000));
    view.setUint32(pad.length - 4, bits >>> 0);
    const length = this.length;
    this.update(pad);
    this.length = length;
    return [...this.h].map(v => (v >>> 0).toString(16).padStart(8, '0')).join('');
  }
}

// ---- failures -------------------------------------------------------------------------------------------------------
// cls is stable for diagnostics; message is what the in-game toast shows.
class PackError extends Error {
  constructor(cls, message) { super(message); this.cls = cls; }
}
const MESSAGES = {
  'invalid-url': 'Invalid pack URL', 'unsafe-url': 'Pack URL scheme is not allowed',
  'mixed-content': 'Browser blocked the resource host (http:// pack on an https:// page)',
  'insecure-redirect': 'Pack host redirected to insecure http://', 'cors': 'Browser blocked the resource host (no CORS headers)',
  'network': 'Network error', 'timeout': 'Download timed out', 'http': 'HTTP error', 'too-large': 'Pack too large',
  'hash-mismatch': 'Hash mismatch', 'cancelled': 'Cancelled', 'storage': 'Browser storage error', 'internal': 'Download failed',
};
const fail = (cls, detail) => new PackError(cls, detail ? `${MESSAGES[cls]}: ${detail}` : MESSAGES[cls]);
const mb = bytes => `${Math.round(bytes / 1048576)} MB`;
const hostOf = url => { try { return new URL(url).host; } catch { return '?'; } };

/** Throws a PackError unless {@code raw} may be fetched from this page. Exported for tests. */
export function checkUrl(raw, pageProtocol = globalThis.location?.protocol || 'https:') {
  let url;
  try { url = new URL(raw); } catch { throw fail('invalid-url'); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw fail('unsafe-url', url.protocol); // javascript:, data:, file:, blob:
  if (url.username || url.password) throw fail('unsafe-url', 'credentials in URL');
  // An https:// page cannot load http:// content (mixed content); say so instead of a generic network error.
  if (url.protocol === 'http:' && pageProtocol === 'https:') throw fail('mixed-content');
  return url;
}

// ---- cache (IndexedDB) ---------------------------------------------------------------------------------------------
let dbPromise = null;
function db() {
  if (!globalThis.indexedDB) return Promise.reject(fail('storage', 'IndexedDB unavailable'));
  dbPromise ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => { const s = req.result.createObjectStore(STORE, {keyPath: 'sha1'}); s.createIndex('lastUsed', 'lastUsed'); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch(error => { dbPromise = null; throw error; });
  return dbPromise;
}
const done = req => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
const committed = tx => new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || new Error('aborted')); });

async function cacheGet(sha1) {
  const store = (await db()).transaction(STORE, 'readonly').objectStore(STORE);
  const record = await done(store.get(sha1));
  if (!record?.blob) return null;
  const bytes = new Uint8Array(await record.blob.arrayBuffer());
  if (bytes.byteLength !== record.size) return null;
  const tx = (await db()).transaction(STORE, 'readwrite');
  record.lastUsed = Date.now();
  tx.objectStore(STORE).put(record);
  committed(tx).catch(() => {});
  return bytes;
}

async function cachePut(sha1, bytes, host) {
  const database = await db();
  const meta = await done(database.transaction(STORE, 'readonly').objectStore(STORE).getAll());
  // Evict least recently used, never a mounted pack, until the new one fits.
  const keep = new Set(mounts.keys());
  let total = meta.reduce((sum, r) => sum + (r.sha1 === sha1 ? 0 : r.size), 0);
  let count = meta.filter(r => r.sha1 !== sha1).length;
  const victims = [];
  for (const r of meta.filter(r => r.sha1 !== sha1).sort((x, y) => x.lastUsed - y.lastUsed)) {
    if (total + bytes.byteLength <= LIMITS.cacheQuotaBytes && count < LIMITS.cacheMaxEntries) break;
    if (keep.has(r.sha1)) continue;
    victims.push(r.sha1); total -= r.size; count--;
  }
  if (total + bytes.byteLength > LIMITS.cacheQuotaBytes) return {stored: false, reason: 'over cache quota'};
  const tx = database.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  for (const v of victims) store.delete(v);
  store.put({sha1, blob: new Blob([bytes]), size: bytes.byteLength, host, savedAt: Date.now(), lastUsed: Date.now()});
  try { await committed(tx); } catch (error) {
    return {stored: false, reason: error?.name === 'QuotaExceededError' ? 'browser storage quota exceeded' : String(error?.message || error)};
  }
  cacheStats.evictions += victims.length;
  return {stored: true, evicted: victims.length};
}

async function cacheSummary() {
  try {
    const meta = await done((await db()).transaction(STORE, 'readonly').objectStore(STORE).getAll());
    return {entries: meta.length, bytes: meta.reduce((s, r) => s + r.size, 0), quotaBytes: LIMITS.cacheQuotaBytes};
  } catch (error) { return {error: String(error?.message || error)}; }
}

// ---- mounts (pack bytes visible to Java through the VFS, never persisted) -----------------------------------------
const mounts = new Map(); // sha1 -> path
function mount(sha1, bytes) {
  const path = `${MOUNT_DIR}/${sha1}`;
  globalThis.__eaglerStorageApi.mountVolatile(path, bytes);
  mounts.set(sha1, path);
  return '/' + path;
}

// ---- download -------------------------------------------------------------------------------------------------------
async function download(job, url) {
  const controller = new AbortController();
  job.abort = () => controller.abort();
  let idle = null, total = null;
  const kick = () => { clearTimeout(idle); idle = setTimeout(() => { job.timedOut = true; controller.abort(); }, LIMITS.idleTimeoutMs); };
  total = setTimeout(() => { job.timedOut = true; controller.abort(); }, LIMITS.totalTimeoutMs);
  kick();
  try {
    let response;
    try {
      response = await fetch(url.href, {mode: 'cors', credentials: 'omit', cache: 'no-store', redirect: 'follow', signal: controller.signal});
    } catch (error) {
      if (job.cancelled) throw fail('cancelled');
      if (job.timedOut) throw fail('timeout');
      // fetch() rejects alike for CORS and for network failures; an opaque no-cors probe tells them apart.
      const reachable = await fetch(url.href, {mode: 'no-cors', credentials: 'omit', cache: 'no-store', method: 'HEAD'}).then(() => true, () => false);
      throw fail(reachable ? 'cors' : 'network');
    }
    const finalUrl = response.url ? new URL(response.url) : url;
    if (url.protocol === 'https:' && finalUrl.protocol !== 'https:') throw fail('insecure-redirect');
    job.redirected = response.redirected;
    if (!response.ok) throw fail('http', `${response.status}`);
    const declared = Number(response.headers.get('content-length'));
    const known = Number.isFinite(declared) && declared > 0 && !response.headers.get('content-encoding');
    if (known && declared > LIMITS.maxPackBytes) throw fail('too-large', `${mb(declared)} > ${mb(LIMITS.maxPackBytes)}`);
    job.total = known ? declared : -1;
    const hash = new Sha1();
    // Known length: one buffer filled in place. Unknown: chunks, joined once at the end.
    let buffer = known ? new Uint8Array(declared) : null;
    const chunks = [];
    let loaded = 0;
    const reader = response.body.getReader();
    for (;;) {
      let step;
      try { step = await reader.read(); } catch (error) {
        if (job.cancelled) throw fail('cancelled');
        if (job.timedOut) throw fail('timeout');
        throw fail('network', 'connection lost');
      }
      if (step.done) break;
      kick();
      const chunk = step.value;
      if (loaded + chunk.byteLength > LIMITS.maxPackBytes) { controller.abort(); throw fail('too-large', `over ${mb(LIMITS.maxPackBytes)}`); }
      if (buffer && loaded + chunk.byteLength > buffer.byteLength) { // the server sent more than it declared
        chunks.push(buffer.subarray(0, loaded)); buffer = null;
      }
      if (buffer) buffer.set(chunk, loaded); else chunks.push(chunk);
      hash.update(chunk);
      loaded += chunk.byteLength;
      job.loaded = loaded;
    }
    if (buffer && loaded !== buffer.byteLength) buffer = buffer.subarray(0, loaded);
    if (!buffer) {
      buffer = new Uint8Array(loaded);
      let at = 0;
      for (const c of chunks) { buffer.set(c, at); at += c.byteLength; }
    }
    return {bytes: buffer, sha1: hash.hex()};
  } finally {
    clearTimeout(idle); clearTimeout(total);
  }
}

const RETRYABLE = new Set(['network', 'timeout']);

async function run(job, rawUrl, expected) {
  const t0 = performance.now();
  const url = checkUrl(rawUrl);
  if (expected) {
    try {
      const cached = await cacheGet(expected);
      if (cached) {
        job.cacheHit = true;
        job.sha1 = expected;
        job.size = cached.byteLength;
        job.loaded = job.total = cached.byteLength;
        job.path = mount(expected, cached);
        job.downloadMs = Math.round(performance.now() - t0);
        return;
      }
    } catch (error) { job.cacheNote = `cache read failed: ${error?.message || error}`; }
  }
  let result;
  for (let attempt = 0; ; attempt++) {
    try {
      job.attempts = attempt + 1;
      result = await download(job, url);
      break;
    } catch (error) {
      const retry = attempt < LIMITS.retries && !job.cancelled && (RETRYABLE.has(error.cls) || (error.cls === 'http' && /^5/.test(error.message.split(': ')[1] || '')));
      if (!retry) throw error;
      job.loaded = 0; job.timedOut = false;
    }
  }
  job.downloadMs = Math.round(performance.now() - t0);
  job.sha1 = result.sha1;
  job.size = result.bytes.byteLength;
  // The protocol's hash is SHA-1 of the file (vanilla DownloadQueue / HashCode of Hashing.sha1()).
  if (expected && expected !== result.sha1) throw fail('hash-mismatch', `expected ${expected.slice(0, 8)}…, got ${result.sha1.slice(0, 8)}…`);
  job.path = mount(result.sha1, result.bytes);
  // Caching is best effort: a pack that cannot be cached still applies.
  cachePut(result.sha1, result.bytes, url.host).then(r => { job.cached = r.stored; if (!r.stored) job.cacheNote = r.reason; },
    error => { job.cached = false; job.cacheNote = String(error?.message || error); });
}

// ---- API used by DownloadedPackSource -------------------------------------------------------------------------------
const jobs = new Map();
const history = []; // compact per-pack records for diagnostics (no URL paths or queries, no contents)
const cacheStats = {hits: 0, misses: 0, evictions: 0};

function start(token, rawUrl, expectedSha1, packId) {
  const expected = /^[0-9a-f]{40}$/.test(expectedSha1 || '') ? expectedSha1 : null;
  const job = {token, packId: String(packId || ''), host: hostOf(rawUrl), expectedHash: !!expected, state: 'running', loaded: 0, total: -1,
    sha1: null, size: 0, path: null, cacheHit: false, cached: null, cacheNote: null, attempts: 0, error: null, errorClass: null,
    downloadMs: 0, startedAt: Date.now(), cancelled: false, timedOut: false, abort: null};
  jobs.set(token, job);
  run(job, rawUrl, expected).then(() => {
    job.state = 'done';
    if (job.cacheHit) cacheStats.hits++; else cacheStats.misses++;
  }, error => {
    job.state = 'failed';
    job.errorClass = error instanceof PackError ? error.cls : 'internal';
    job.error = error instanceof PackError ? error.message : MESSAGES.internal;
    if (!(error instanceof PackError)) console.warn('[Eagler26] resource pack download failed', error);
  }).finally(() => {
    job.abort = null;
    history.push(record(job));
    if (history.length > 32) history.shift();
  });
}

function record(job) {
  return {source: 'server', packId: job.packId, host: job.host, expectedHash: job.expectedHash, sha1: job.sha1, compressedBytes: job.size,
    cacheHit: job.cacheHit, cached: job.cached, cacheNote: job.cacheNote, attempts: job.attempts, downloadMs: job.downloadMs,
    result: job.state, failureClass: job.errorClass, at: new Date(job.startedAt).toISOString()};
}

function cancelAll() {
  for (const job of jobs.values()) if (job.state === 'running') { job.cancelled = true; job.abort?.(); }
}

/** Unmounts every server pack whose path is not in {@code keep} (absolute VFS paths). */
function releaseExcept(keep) {
  const wanted = new Set([...(keep || [])].map(p => String(p).replace(/^\/+/, '')));
  for (const [sha1, path] of [...mounts]) {
    if (wanted.has(path)) continue;
    globalThis.__eaglerStorageApi.unmountVolatile(path);
    mounts.delete(sha1);
  }
}

// Java adds what only it knows: validation and reload timing, the vanilla compatibility class, the final result.
const NOTE_KEYS = new Set(['validationMs', 'reloadMs', 'compatibility', 'finalResult']);
function note(packId, key, value) {
  if (!NOTE_KEYS.has(key)) return;
  const entry = history.findLast(r => r.packId === packId);
  if (entry) entry[key] = /Ms$/.test(key) ? Number(value) : String(value);
}

const api = {
  LIMITS,
  start,
  state: token => jobs.get(token)?.state || 'failed',
  loaded: token => jobs.get(token)?.loaded || 0,
  total: token => jobs.get(token)?.total ?? -1,
  path: token => jobs.get(token)?.path || null,
  sha1: token => jobs.get(token)?.sha1 || null,
  size: token => jobs.get(token)?.size || 0,
  cacheHit: token => !!jobs.get(token)?.cacheHit,
  error: token => jobs.get(token)?.error || MESSAGES.internal,
  errorClass: token => jobs.get(token)?.errorClass || 'internal',
  forget: token => { jobs.delete(token); },
  cancelAll,
  releaseExcept,
  note,
  mounted: () => [...mounts.values()],
  diagnostics: () => ({limits: LIMITS, cache: {...cacheStats}, mounted: mounts.size, active: [...jobs.values()].filter(j => j.state === 'running').length, recent: history.slice(-12)}),
  cacheSummary,
  clearCache: async () => { const tx = (await db()).transaction(STORE, 'readwrite'); tx.objectStore(STORE).clear(); await committed(tx); },
};
globalThis.__eaglerPacks = api;
