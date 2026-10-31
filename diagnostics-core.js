// Eagler26 beta diagnostics core.
//
// Pure module (no DOM access) shared by the browser client (browser-diagnostics.js), the Node
// tests (scripts/diagnostics/) and the reference diagnostics server (tools/diagnostics-server/),
// which re-sanitizes every upload with the same rules. Everything here is bounded: ring buffers
// for events/errors/performance samples, per-name rate limits, size caps on every string, object
// and payload. Sanitization is centralized: callers pass raw values and the core redacts them.
// See docs/BETA_DIAGNOSTICS.md for the schema and the privacy rules.

export const SCHEMA_VERSION = 1;
export const REDACTED = '[REDACTED]';

export const LIMITS = Object.freeze({
  events: 1000,               // event ring
  errors: 50,                 // distinct recent errors (repeats bump a counter)
  perfSamples: 180,           // 15 minutes at one sample per 5 s
  stringChars: 500,           // default cap for any string value
  messageChars: 500,
  stackChars: 4000,
  stackFrames: 30,
  dataBytes: 2048,            // serialized size cap of one event's metadata
  depth: 5,
  keys: 40,
  arrayItems: 40,
  eventsPerNamePerMinute: 60,
  errorsPerMinute: 30,
  payloadBytes: 256 * 1024,   // upload body cap
  beaconBytes: 60 * 1024,     // navigator.sendBeacon body cap (browsers allow ~64 KiB)
  uploadEvents: 400,
});

export const CATEGORIES = Object.freeze(['lifecycle', 'browser', 'renderer', 'performance', 'memory', 'network', 'protocol',
  'audio', 'resource_pack', 'skins', 'storage', 'input', 'watchdog', 'wasm', 'javascript', 'error', 'diagnostics']);
export const SEVERITIES = Object.freeze(['debug', 'info', 'warn', 'error', 'fatal']);
const CATEGORY_SET = new Set(CATEGORIES);
const SEVERITY_RANK = Object.fromEntries(SEVERITIES.map((s, i) => [s, i]));

// ---------------------------------------------------------------------------------------------
// Sanitization
// ---------------------------------------------------------------------------------------------

// Keys whose values are never kept, whatever their type. Matched on the lower-cased key with
// separators removed, so authToken, auth_token, X-Auth-Token and AUTH-TOKEN all match.
const SENSITIVE_KEY_PARTS = /(password|passwd|passphrase|pwd|secret|token|apikey|accesskey|privatekey|authorization|authkey|authcode|authheader|cookie|credential|signature|sessionkey|sessionsecret|sessioncookie|otp|totp|pincode)/;
const SENSITIVE_KEY_EXACT = new Set(['pass', 'pw', 'auth', 'jwt', 'sid', 'ticket', 'nonce', 'salt']);
// Short names that are only secret-shaped as URL query parameters (?key=, ?code=, ?sig=).
const SENSITIVE_PARAM_EXACT = new Set(['key', 'code', 'sig', 'state', 'k', 'hash', 'hmac']);

export function isSensitiveKey(key) {
  const k = String(key).toLowerCase().replace(/[-_. ]/g, '');
  return SENSITIVE_KEY_EXACT.has(k) || SENSITIVE_KEY_PARTS.test(k);
}

function isSensitiveParam(key) {
  return isSensitiveKey(key) || SENSITIVE_PARAM_EXACT.has(String(key).toLowerCase());
}

// Chat commands whose arguments are credentials (auth plugins) or private/raw chat. The command
// name is kept (useful: "the tester ran /login"), everything after it on the line is dropped.
// Namespaced forms (/authme:login) are covered. The command must start the text or follow
// whitespace/punctuation, so URL paths such as https://host/l/x are not treated as commands.
const SENSITIVE_COMMANDS = ['login', 'log', 'l', 'register', 'reg', 'changepassword', 'changepass', 'changepw', 'cp',
  'unregister', 'unreg', 'email', 'premium', '2fa', 'totp', 'authme', 'auth', 'pin', 'passwd', 'password',
  'msg', 'tell', 'w', 'whisper', 'm', 'r', 'reply', 'pm', 'dm', 'mail', 't', 'me', 'say', 'teammsg', 'tm'];
const COMMAND_RE = new RegExp(`(^|[\\s"'\`([{<>:,;=|])\\/((?:[a-z0-9_.-]+:)?(?:${SENSITIVE_COMMANDS.join('|')}))(?=\\s|$)[^\\n]*`, 'gim');
// Bracketed runs are only IPv6 hosts or an earlier redaction marker, so re-redacting is idempotent.
const URL_RE = /\b(?:https?|wss?|ftp):\/\/(?:[^\s"'<>\\()[\]]|\[[0-9A-Fa-f:.]+\]|\[REDACTED(?:_[A-Z]+)?\])+/gi;
const DATA_URL_RE = /\bdata:[a-z0-9.+/-]*(?:;[a-z0-9=.+-]*)*,[^\s"')]*/gi;
const HEADER_RE = /\b(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|x-access-token)\s*:\s*[^\n]*/gi;
const BEARER_RE = /\b(bearer|basic|digest)\s+[A-Za-z0-9._~+/=-]{6,}/gi;
// Key and email patterns start only at a token boundary and bound their repetition, so long
// runs of word characters cannot cause quadratic backtracking.
const KV_RE = /(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]{0,40}?(?:password|passwd|passphrase|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|auth[_-]?(?:token|key|code)|session[_-]?(?:token|secret|key)|cookie|credential)[A-Za-z0-9_.-]{0,40})(["']?\s*[=:]\s*)(?!\[REDACTED)("[^"]*"|'[^']*'|[^\s,;&}"'\]]+)/gi;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g;
const EMAIL_RE = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}/g;
const BLOB_RE = /(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{96,}={0,2}/g;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u2028\u2029]/g;

function looksLikeToken(value) {
  const v = String(value);
  if (v.length > 128) return true;
  return v.length >= 20 && /^[A-Za-z0-9._~+/=-]+$/.test(v) && /[0-9]/.test(v) && /[A-Za-z]/.test(v);
}

/** Removes credentials, fragments and secret-looking query values from one URL. */
export function redactUrl(raw) {
  const text = String(raw);
  try {
    const url = new URL(text);
    url.username = '';
    url.password = '';
    url.hash = '';
    const entries = [...url.searchParams];
    if (entries.length) {
      const next = new URLSearchParams();
      for (const [k, v] of entries) next.append(k, isSensitiveParam(k) || looksLikeToken(v) ? 'REDACTED' : v);
      url.search = next.toString();
    }
    return url.href.replace(/=REDACTED\b/g, `=${REDACTED}`);
  } catch {
    return text.replace(/\/\/[^/@\s]*@/, '//').replace(/[?#].*$/, '?[REDACTED_QUERY]');
  }
}

// Exact secrets the client saw typed (auth command arguments), stored only as 64-bit FNV-1a
// hashes; any whitespace-delimited token hashing to one is removed from every string. This is
// defense in depth for a server echoing a password back (for example in a kick message).
const secretHashes = new Set();
function hashToken(s) {
  let a = 0x811c9dc5, b = 0x9747b28c ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 16777619);
    b = Math.imul(b ^ c, 0x5bd1e995);
  }
  return (a >>> 0).toString(36) + ':' + (b >>> 0).toString(36);
}
const TOKEN_RE = /[^\s"'`,()[\]{}<>]{3,256}/g;
export function registerSecret(value) {
  if (typeof value !== 'string') return 0;
  let added = 0;
  for (const word of value.split(/\s+/)) {
    if (word.length < 3 || word.length > 256) continue;
    if (!secretHashes.has(hashToken(word))) { secretHashes.add(hashToken(word)); added++; }
    const trimmed = word.replace(/[.:;!?]+$/, '');
    if (trimmed.length >= 3 && trimmed !== word) secretHashes.add(hashToken(trimmed));
    if (secretHashes.size > 256) break;
  }
  return added;
}
export function clearRegisteredSecrets() { secretHashes.clear(); }
function scrubRegisteredSecrets(s) {
  if (!secretHashes.size) return s;
  return s.replace(TOKEN_RE, t => {
    if (secretHashes.has(hashToken(t))) return REDACTED;
    const trimmed = t.replace(/[.:;!?]+$/, '');
    return trimmed !== t && secretHashes.has(hashToken(trimmed)) ? REDACTED + t.slice(trimmed.length) : t;
  });
}

/** Redacts every known secret shape from free text and caps its length. */
export function redactText(value, maxChars = LIMITS.stringChars) {
  let s = typeof value === 'string' ? value : String(value);
  // Bound regex work on huge inputs first; every rule below still applies to what is kept.
  if (s.length > maxChars * 4 + 64) s = s.slice(0, maxChars * 4 + 64);
  s = s.replace(CONTROL_RE, '');
  s = s.replace(DATA_URL_RE, 'data:[REDACTED]');
  s = s.replace(URL_RE, m => redactUrl(m));
  s = s.replace(COMMAND_RE, (m, pre, cmd) => `${pre}/${cmd} ${REDACTED}`);
  s = s.replace(HEADER_RE, (m, name) => `${name}: ${REDACTED}`);
  s = s.replace(BEARER_RE, (m, kind) => `${kind} ${REDACTED}`);
  s = s.replace(KV_RE, (m, key, sep) => `${key}${sep}${REDACTED}`);
  s = s.replace(JWT_RE, '[REDACTED_JWT]');
  s = s.replace(EMAIL_RE, '[REDACTED_EMAIL]');
  s = s.replace(BLOB_RE, m => `[REDACTED_BLOB ${m.length}]`);
  s = scrubRegisteredSecrets(s);
  if (s.length > maxChars) s = `${s.slice(0, maxChars)}…[+${s.length - maxChars}]`;
  return s;
}

/** Bounded, redacted stack trace: at most LIMITS.stackFrames lines and LIMITS.stackChars chars. */
export function boundStack(stack) {
  if (stack == null) return null;
  const lines = String(stack).slice(0, LIMITS.stackChars * 2).split('\n');
  const kept = lines.slice(0, LIMITS.stackFrames).map(line => redactText(line.trimEnd(), 300));
  if (lines.length > LIMITS.stackFrames) kept.push(`… ${lines.length - LIMITS.stackFrames} more frames`);
  let out = kept.join('\n');
  if (out.length > LIMITS.stackChars) out = `${out.slice(0, LIMITS.stackChars)}…`;
  return out;
}

function cleanKey(key) {
  return String(key).replace(CONTROL_RE, '').slice(0, 64);
}

/**
 * Deep-copies any value into a JSON-safe, bounded, redacted form. Binary data never keeps its
 * contents (only its size), functions and symbols are dropped, cycles and excess depth are cut.
 */
export function sanitizeValue(value, options = {}) {
  const maxString = options.maxString ?? LIMITS.stringChars;
  const seen = new WeakSet();
  const walk = (v, depth) => {
    if (v === null || v === undefined) return null;
    switch (typeof v) {
      case 'string': return redactText(v, maxString);
      case 'number': return Number.isFinite(v) ? (Number.isInteger(v) ? v : Math.round(v * 1000) / 1000) : null;
      case 'boolean': return v;
      case 'bigint': return v.toString();
      case 'function': case 'symbol': return undefined;
      default: break;
    }
    if (depth >= LIMITS.depth) return '[depth]';
    if (seen.has(v)) return '[circular]';
    if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.toISOString() : null;
    if (typeof ArrayBuffer !== 'undefined' && (v instanceof ArrayBuffer || ArrayBuffer.isView(v))) return `[binary ${v.byteLength} bytes]`;
    if (typeof Blob !== 'undefined' && v instanceof Blob) return `[blob ${v.size} bytes]`;
    if (v instanceof Error || (typeof v.message === 'string' && typeof v.stack === 'string')) {
      return {name: redactText(v.name || 'Error', 80), message: redactText(v.message, LIMITS.messageChars), stack: boundStack(v.stack)};
    }
    if (typeof v.nodeType === 'number' && typeof v.nodeName === 'string') return `[node ${redactText(v.nodeName, 32)}]`;
    seen.add(v);
    if (Array.isArray(v)) {
      const out = [];
      for (let i = 0; i < v.length && i < LIMITS.arrayItems; i++) {
        let item;
        try { item = walk(v[i], depth + 1); } catch { item = '[unreadable]'; }
        out.push(item === undefined ? null : item);
      }
      if (v.length > LIMITS.arrayItems) out.push(`[+${v.length - LIMITS.arrayItems} more]`);
      return out;
    }
    const out = {};
    let count = 0, extra = 0;
    let keys;
    try { keys = Object.keys(v); } catch { return '[unreadable]'; }
    for (const key of keys) {
      if (count >= LIMITS.keys) { extra++; continue; }
      const k = cleanKey(key);
      if (isSensitiveKey(k)) { out[k] = REDACTED; count++; continue; }
      let item;
      try { item = walk(v[key], depth + 1); } catch { item = '[unreadable]'; }
      if (item === undefined) continue;
      out[k] = item;
      count++;
    }
    if (extra) out['…'] = `+${extra} keys`;
    return out;
  };
  try {
    const result = walk(value, 0);
    return result === undefined ? null : result;
  } catch {
    return '[unserializable]';
  }
}

/** sanitizeValue plus a serialized-size cap (oversized metadata becomes a truncated preview). */
export function sanitizeData(value, maxBytes = LIMITS.dataBytes) {
  const clean = sanitizeValue(value);
  let json;
  try { json = JSON.stringify(clean); } catch { return '[unserializable]'; }
  if (json === undefined || json.length <= maxBytes) return clean;
  return {truncated: true, bytes: json.length, preview: json.slice(0, Math.max(64, maxBytes - 128))};
}

export function sanitizeUsername(name) {
  return typeof name === 'string' && /^[A-Za-z0-9_]{1,16}$/.test(name) ? name : null;
}

export function sanitizeSessionId(id) {
  return typeof id === 'string' && /^E26-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/.test(id) ? id : null;
}

// Crockford base32 (no I, L, O, U) so IDs survive being read aloud or retyped.
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function createSessionId(randomBytes) {
  const bytes = randomBytes(12);
  let out = '';
  for (let i = 0; i < 12; i++) out += CROCKFORD[bytes[i] & 31];
  return `E26-${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}`;
}

// ---------------------------------------------------------------------------------------------
// Bounded storage
// ---------------------------------------------------------------------------------------------

export class RingBuffer {
  constructor(capacity) {
    this.capacity = Math.max(1, capacity | 0);
    this.items = new Array(this.capacity);
    this.start = 0;
    this.length = 0;
    this.total = 0;
  }
  push(item) {
    this.total++;
    if (this.length < this.capacity) {
      this.items[(this.start + this.length) % this.capacity] = item;
      this.length++;
    } else {
      this.items[this.start] = item;
      this.start = (this.start + 1) % this.capacity;
    }
    return item;
  }
  get dropped() { return this.total - this.length; }
  toArray() {
    const out = new Array(this.length);
    for (let i = 0; i < this.length; i++) out[i] = this.items[(this.start + i) % this.capacity];
    return out;
  }
  last(n = 1) {
    const all = this.toArray();
    return all.slice(Math.max(0, all.length - n));
  }
  find(predicate) {
    for (let i = this.length - 1; i >= 0; i--) {
      const item = this.items[(this.start + i) % this.capacity];
      if (predicate(item)) return item;
    }
    return null;
  }
  clear() {
    this.items = new Array(this.capacity);
    this.start = 0;
    this.length = 0;
  }
}

const round1 = v => Math.round(v * 10) / 10;
const round2 = v => Math.round(v * 100) / 100;
const iso = ms => { try { return new Date(ms).toISOString(); } catch { return null; } };

function stats(values) {
  const a = values.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const at = p => a[Math.min(a.length - 1, Math.floor(a.length * p))];
  return {avg: round2(a.reduce((x, y) => x + y, 0) / a.length), min: round2(a[0]), p50: round2(at(0.5)), p95: round2(at(0.95)), max: round2(a[a.length - 1])};
}

// ---------------------------------------------------------------------------------------------
// Diagnostics store
// ---------------------------------------------------------------------------------------------

/**
 * Terrain GPU memory section of a bundle (V0.501). `terrain` is __eaglerRenderer.terrainMemory
 * (published by the Java renderer, see SectionRenderDispatcher.appendTerrainMemory) and `perf` is
 * __eaglerPerf (all WebGL buffers, counted at bufferData). Bytes are exact; "allocated" is GPU
 * buffer storage, "used" is mesh data actually uploaded into it. Pure: shared with Node tests.
 */
export function summarizeTerrainMemory(terrain, perf, pool, nowMs) {
  if (!terrain || !terrain.totals) {
    return perf ? {available: false, gpu: {totalBufferBytes: perf.gpuBufferBytes ?? null, bufferObjects: perf.gpuBuffers ?? null}} : null;
  }
  const t = terrain.totals;
  const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const pct = (used, allocated) => (allocated > 0 ? Math.round(used * 1000 / allocated) / 10 : 100);
  const layers = {};
  for (const [name, l] of Object.entries(terrain.layers || {})) {
    const v = l.vertex || {}, i = l.index || {};
    layers[name] = {
      allocatedBytes: num(l.heapBytes), usedBytes: num(l.requestedBytes), blockBytes: num(l.blockBytes),
      efficiencyPct: pct(num(l.requestedBytes), num(l.heapBytes)),
      vertexAllocatedBytes: num(v.heapBytes), vertexUsedBytes: num(v.requestedBytes),
      indexAllocatedBytes: num(i.heapBytes), indexUsedBytes: num(i.requestedBytes),
      heaps: num(v.heaps) + num(i.heaps), vertexHeapSize: num(v.heapSize), indexHeapSize: num(i.heapSize),
      allocations: num(v.allocations) + num(i.allocations),
      largestVertexAllocation: num(l.largestVertexAllocation), largestIndexAllocation: num(l.largestIndexAllocation),
      freeBlocks: num(v.freeBlocks) + num(i.freeBlocks), largestFreeBlock: Math.max(num(v.largestFreeBlock), num(i.largestFreeBlock)),
      stagedBytes: num(v.stagedBytes) + num(i.stagedBytes),
      peakAllocatedBytes: num(v.peakHeapBytes) + num(i.peakHeapBytes),
      heapsCreated: num(v.heapsCreated) + num(i.heapsCreated), heapsDestroyed: num(v.heapsDestroyed) + num(i.heapsDestroyed),
      uploadedBytes: num(v.uploadedBytes) + num(i.uploadedBytes),
    };
  }
  const states = {};
  for (const [name, st] of Object.entries(terrain.states || {})) {
    states[name] = {allocations: num(st.allocations), bytes: num(st.blockBytes), usedBytes: num(st.requestedBytes)};
  }
  const p = terrain.produced || {};
  let producedVertex = 0, producedIndex = 0, meshes = 0;
  const producedLayers = {};
  for (const [name, l] of Object.entries(p.layers || {})) {
    producedVertex += num(l.vertexBytes); producedIndex += num(l.indexBytes); meshes += num(l.meshes);
    producedLayers[name] = {meshes: num(l.meshes), vertexBytes: num(l.vertexBytes), indexBytes: num(l.indexBytes), maxBytes: num(l.maxBytes)};
  }
  const nonEmpty = num(p.sections) - num(p.emptySections);
  const totalBuffer = perf ? num(perf.gpuBufferBytes) : null;
  return {
    available: true,
    ageMs: typeof nowMs === 'number' && typeof terrain.at === 'number' ? Math.round(nowMs - terrain.at) : null,
    frame: terrain.frame ?? null, trackedSections: terrain.trackedSections ?? null,
    gpu: {
      totalBufferBytes: totalBuffer, bufferObjects: perf ? num(perf.gpuBuffers) : null,
      terrainAllocatedBytes: num(t.heapBytes), terrainUsedBytes: num(t.requestedBytes), terrainBlockBytes: num(t.blockBytes),
      terrainEfficiencyPct: pct(num(t.requestedBytes), num(t.heapBytes)),
      terrainBufferObjects: num(t.bufferObjects), terrainAllocations: num(t.allocations),
      allocatorSlackBytes: num(t.allocatorSlackBytes), terrainFreeBytes: num(t.freeBytes),
      otherBufferBytes: totalBuffer === null ? null : Math.max(0, totalBuffer - num(t.heapBytes)),
    },
    // V0.509 packing aggregates (non-solid = CUTOUT + TRANSLUCENT); null on builds before V0.509.
    packing: terrain.aggregate ? {
      terrainGpuAllocatedBytes: num(terrain.aggregate.terrainGpuAllocatedBytes), terrainGpuUsedBytes: num(terrain.aggregate.terrainGpuUsedBytes),
      terrainGpuWasteBytes: num(terrain.aggregate.terrainGpuWasteBytes), terrainGpuPackingPct: num(terrain.aggregate.terrainGpuPackingPct),
      nonSolidAllocatedBytes: num(terrain.aggregate.nonSolidAllocatedBytes), nonSolidUsedBytes: num(terrain.aggregate.nonSolidUsedBytes),
      nonSolidWasteBytes: num(terrain.aggregate.nonSolidWasteBytes), nonSolidPackingPct: num(terrain.aggregate.nonSolidPackingPct),
      terrainBufferCount: num(terrain.aggregate.terrainBufferCount),
    } : null,
    vertex: {allocatedBytes: num(t.vertexHeapBytes), usedBytes: num(t.vertexRequestedBytes), blockBytes: num(t.vertexBlockBytes)},
    index: {allocatedBytes: num(t.indexHeapBytes), usedBytes: num(t.indexRequestedBytes), blockBytes: num(t.indexBlockBytes)},
    layers, states,
    largestSections: (terrain.largestSections || []).slice(0, 5).map(x => ({
      bytes: num(x.bytes), state: x.state ?? null, section: Array.isArray(x.section) ? x.section.join(',') : null,
      layerIndices: Object.entries(x.layers || {}).map(([k, v]) => `${k}:${v}`).join(' '),
    })),
    produced: {
      sections: num(p.sections), emptySections: num(p.emptySections), layerMeshes: meshes,
      vertexBytes: producedVertex, indexBytes: producedIndex,
      avgSectionBytes: nonEmpty > 0 ? Math.round((producedVertex + producedIndex) / nonEmpty) : 0,
      maxSectionBytes: num(p.maxSectionBytes), resorts: num(p.resorts), resortIndexBytes: num(p.resortIndexBytes),
      sectionBytesHistogram: p.sectionBytesHistogram || {}, layers: producedLayers,
    },
    cpu: {
      stagingCapacityBytes: num(terrain.staging?.capacityBytes), stagingPeakBytes: num(terrain.staging?.peakBytes),
      stagingPendingBytes: num(terrain.staging?.pendingBytes),
      sectionBufferPacks: pool ? (pool.allocated ?? null) : null, sectionBufferPackBytes: pool ? (pool.packBytes ?? null) : null,
      // V0.509: bytes the open section builder packs really hold (Wasm-GC heap arrays / linear blocks).
      packHeapBytes: terrain.packs ? num(terrain.packs.heapBytes) : null, packLinearBytes: terrain.packs ? num(terrain.packs.linearBytes) : null,
      builderHeapBytes: terrain.packs ? num(terrain.packs.allBuildersHeapBytes) : null,
      builderLinearBytes: terrain.packs ? num(terrain.packs.allBuildersLinearBytes) : null,
      builderGrows: terrain.packs ? num(terrain.packs.builderGrows) : null,
    },
  };
}

/**
 * Creates the diagnostics store. Every public method is fail-safe: it never throws into callers
 * and never recurses into itself (an error raised while recording is dropped).
 */
export function createDiagnostics(options = {}) {
  const now = options.now || (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  const wallNow = options.wallNow || (() => Date.now());
  const randomBytes = options.randomBytes || (n => {
    const out = new Uint8Array(n);
    if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(out);
    else for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
    return out;
  });
  const enabled = options.enabled !== false;
  let build = sanitizeValue(options.build || {}) || {};
  const startMono = now();
  const startWall = wallNow();

  const state = {
    enabled,
    sessionId: createSessionId(randomBytes),
    username: null,
    reportNumber: null,
    seq: 0,
    events: new RingBuffer(options.eventCapacity || LIMITS.events),
    errors: new RingBuffer(options.errorCapacity || LIMITS.errors),
    perf: new RingBuffer(options.perfCapacity || LIMITS.perfSamples),
    counts: Object.fromEntries(SEVERITIES.map(s => [s, 0])),
    errorTotal: 0,
    suppressed: Object.create(null),
    rateWindow: Object.create(null),
    errorWindow: {start: 0, count: 0, suppressed: 0},
    providers: new Map(),
    recording: false,
    listeners: [],
  };

  const mono = () => round1(now() - startMono);

  function rateLimited(key) {
    const t = now();
    let w = state.rateWindow[key];
    if (!w || t - w.start >= 60000) {
      if (w && w.suppressed) state.suppressed[key] = (state.suppressed[key] || 0) + w.suppressed;
      w = state.rateWindow[key] = {start: t, count: 0, suppressed: 0};
      // Keep the window table bounded: drop stale entries once it grows.
      const keys = Object.keys(state.rateWindow);
      if (keys.length > 512) for (const k of keys) if (t - state.rateWindow[k].start >= 60000) delete state.rateWindow[k];
    }
    if (++w.count > LIMITS.eventsPerNamePerMinute) { w.suppressed++; return true; }
    return false;
  }

  function cleanName(name) {
    return redactText(String(name ?? 'event'), 64).replace(/[^\w.:/ -]/g, '_') || 'event';
  }

  function record(category, severity, name, data) {
    if (!state.enabled || state.recording) return null;
    state.recording = true;
    try {
      const cat = CATEGORY_SET.has(category) ? category : 'javascript';
      const sev = SEVERITY_RANK[severity] !== undefined ? severity : 'info';
      const evName = cleanName(name);
      if (rateLimited(`${cat}/${evName}`)) return null;
      const event = {seq: ++state.seq, t: iso(wallNow()), mono: mono(), cat, sev, name: evName};
      if (data !== undefined && data !== null) event.data = sanitizeData(data);
      state.events.push(event);
      state.counts[sev]++;
      for (const listener of state.listeners) { try { listener(event); } catch { /* listener errors are dropped */ } }
      return event;
    } catch {
      return null;
    } finally {
      state.recording = false;
    }
  }

  /** Records an error (deduplicated: a repeat bumps count/lastAt) plus a matching event. */
  function captureError(source, error, extra = {}) {
    if (!state.enabled || state.recording) return null;
    let entry = null;
    state.recording = true;
    try {
      const t = now();
      if (t - state.errorWindow.start >= 60000) state.errorWindow = {start: t, count: 0, suppressed: state.errorWindow.suppressed};
      if (++state.errorWindow.count > LIMITS.errorsPerMinute) { state.errorWindow.suppressed++; return null; }
      let message, stack, name;
      if (error && typeof error === 'object') {
        name = error.name;
        message = error.message ?? error.reason ?? String(error);
        stack = error.stack;
      } else message = String(error);
      message = redactText(message ?? 'unknown error', LIMITS.messageChars);
      stack = boundStack(extra.stack ?? stack);
      const src = cleanName(source || 'unknown');
      const firstFrame = stack ? stack.split('\n').find(l => /\bat\b|@|wasm/.test(l)) || '' : '';
      const key = `${src}|${message}|${firstFrame}`;
      const existing = state.errors.find(e => e.key === key);
      state.errorTotal++;
      const severity = SEVERITY_RANK[extra.severity] !== undefined ? extra.severity : 'error';
      if (existing) {
        existing.count++;
        existing.lastAt = iso(wallNow());
        existing.lastMono = mono();
        existing.lastSeq = ++state.seq;
        entry = existing;
      } else {
        entry = {key, seq: ++state.seq, lastSeq: state.seq, t: iso(wallNow()), mono: mono(), source: src, severity,
          name: name ? redactText(name, 80) : null, message, stack, count: 1, lastAt: null, lastMono: null};
        if (extra.data !== undefined) entry.data = sanitizeData(extra.data);
        state.errors.push(entry);
      }
    } catch {
      entry = null;
    } finally {
      state.recording = false;
    }
    if (entry && entry.count === 1) {
      record(extra.category && CATEGORY_SET.has(extra.category) ? extra.category : 'error', entry.severity, `error:${entry.source}`,
        {message: entry.message, name: entry.name});
    }
    return entry;
  }

  function addPerfSample(sample) {
    if (!state.enabled) return null;
    const clean = sanitizeValue(sample);
    if (!clean || typeof clean !== 'object') return null;
    clean.t = iso(wallNow());
    clean.mono = mono();
    return state.perf.push(clean);
  }

  function performanceSummary() {
    const samples = state.perf.toArray();
    const pick = k => samples.map(s => s[k]).filter(Number.isFinite);
    const fps = stats(pick('fps'));
    return {
      samples: samples.length,
      windowSeconds: samples.length ? round1((samples[samples.length - 1].mono - samples[0].mono) / 1000 + (samples[0].windowSeconds || 0)) : 0,
      fps, onePercentLowFps: stats(pick('onePercentLowFps')),
      frameTimeP95Ms: stats(pick('frameP95Ms')), frameTimeMaxMs: stats(pick('frameMaxMs')),
      tickMs: stats(pick('tickMs')), renderMs: stats(pick('renderMs')),
      heapMiB: stats(pick('heapMiB')), gpuBufferMiB: stats(pick('gpuBufferMiB')), textureMiB: stats(pick('textureMiB')),
      chunkCompileMs: stats(pick('chunkCompileMs')), chunkQueue: stats(pick('chunkScheduled')),
      last: samples.length ? samples[samples.length - 1] : null,
    };
  }

  function registerProvider(name, fn) {
    if (typeof fn === 'function') state.providers.set(String(name), fn);
  }

  // Extra sections of the exported bundle's "performance" object (V0.503: "breakdown"), sanitized like providers.
  const perfSections = new Map();
  function registerPerformanceSection(name, fn) {
    if (typeof fn === 'function' && !['summary', 'history'].includes(String(name))) perfSections.set(String(name), fn);
  }
  function performanceSections() {
    const out = {};
    for (const [name, fn] of perfSections) {
      try { out[name] = sanitizeValue(fn(), {maxString: 300}); } catch (error) { out[name] = {sectionError: String(error?.message || error)}; }
    }
    return out;
  }

  function getSnapshot() {
    const snapshot = {
      schemaVersion: SCHEMA_VERSION,
      capturedAt: iso(wallNow()),
      build,
      session: {sessionId: state.sessionId, reportNumber: state.reportNumber, username: state.username, startedAt: iso(startWall), uptimeMs: Math.round(now() - startMono),
        diagnosticsEnabled: state.enabled},
      counts: {events: state.events.total, eventsDropped: state.events.dropped, errors: state.errorTotal, bySeverity: {...state.counts},
        suppressedByName: sanitizeValue(state.suppressed), errorsSuppressed: state.errorWindow.suppressed},
    };
    for (const [name, fn] of state.providers) {
      if (name in snapshot) continue;
      let value;
      try { value = fn(); } catch (error) { value = {providerError: String(error?.message || error)}; }
      snapshot[name] = sanitizeValue(value, {maxString: 300});
    }
    return snapshot;
  }

  const publicError = e => {
    const {key, ...rest} = e;
    return rest;
  };
  const getEvents = (options = {}) => {
    let list = state.events.toArray();
    if (options.sinceSeq) list = list.filter(e => e.seq > options.sinceSeq);
    if (options.category) list = list.filter(e => e.cat === options.category);
    if (options.minSeverity) list = list.filter(e => SEVERITY_RANK[e.sev] >= (SEVERITY_RANK[options.minSeverity] ?? 0));
    if (options.limit) list = list.slice(-options.limit);
    return list.map(e => ({...e}));
  };
  const getRecentErrors = (limit = LIMITS.errors) => state.errors.last(limit).map(publicError);

  function summaryLines(snapshot, perf) {
    const lines = [];
    const b = snapshot.build || {};
    const env = snapshot.environment || {};
    const game = snapshot.game || {};
    const net = snapshot.network || {};
    lines.push(`${b.name || 'Eagler26'} ${b.version || '?'}${b.gitRevision ? ` (${b.gitRevision})` : ''}, ` +
      `${snapshot.session.reportNumber ? `report #${snapshot.session.reportNumber}, ` : ''}session ${snapshot.session.sessionId}` +
      `${snapshot.session.username ? ` user ${snapshot.session.username}` : ''}, uptime ${Math.round(snapshot.session.uptimeMs / 60000)} min`);
    if (b.offline) {
      const o = b.offline, a = o.audio || {};
      lines.push(`Offline build ${o.minecraftVersion || '?'} ${o.eaglerVersion || '?'}, format ${o.formatVersion ?? '?'}, profile ${o.profileName || '?'}` +
        `${o.profileHash ? ` (${o.profileHash})` : ''}: singleplayer ${o.singleplayer ? 'yes' : 'no'}, SFX ${a.sfx || '?'}, music ${a.music || '?'}, records ${a.records || '?'}`);
    }
    if (env.browser || env.webgl) lines.push(`Browser ${env.browser || '?'} on ${env.platform || '?'}; GPU ${env.webgl?.renderer || 'unknown'}`);
    lines.push(`State: screen ${game.screen || '?'}, ${game.connected ? `connected to ${game.serverHost || '?'} (${game.connectionPhase || '?'})` : 'not connected'}` +
      `${game.dimension ? `, ${game.dimension}` : ''}`);
    if (perf.fps) lines.push(`Performance: avg ${perf.fps.avg} FPS (min ${perf.fps.min}), frame p95 ${perf.frameTimeP95Ms?.avg ?? '?'} ms, heap max ${perf.heapMiB?.max ?? '?'} MiB`);
    const pb = snapshot.perfBreakdown;
    if (pb && typeof pb === 'object') {
      const act = pb.ablations?.active;
      if (Array.isArray(act) && act.length) lines.push(`DIAGNOSTIC ABLATIONS ACTIVE: ${act.join(', ')} (not a normal client)`);
      const w = pb.last60s;
      if (w && w.frames) lines.push(`Breakdown (60 s): ${w.fps} FPS, frame ${w.frame?.totalMs} ms = runTick ${w.frame?.runTickMs} (tick ${w.frame?.tickMs}, ` +
        `render ${w.frame?.renderMs}) + pump ${w.frame?.pumpMs} + compile ${w.frame?.compileSlackMs} + sleep ${w.frame?.sleepMs}; ` +
        `GPU busy at frame end ${w.gpu?.busyAtEndPct ?? 'n/a'} %; ` +
        `players visible ${w.counts?.visiblePlayers ?? '?'}`);
    }
    if (snapshot.perfAbba && snapshot.perfAbba.status) lines.push(`ABBA test: ${snapshot.perfAbba.status}, ${snapshot.perfAbba.completed}/${snapshot.perfAbba.tests} done`);
    lines.push(`Errors: ${snapshot.counts.errors} (${snapshot.counts.bySeverity.fatal} fatal); disconnects ${net.disconnects ?? 0}` +
      `${net.lastDisconnectReason ? `, last reason "${net.lastDisconnectReason}"` : ''}; watchdog stalls ${snapshot.watchdog?.stalls ?? 0}`);
    const lastError = state.errors.last(1)[0];
    if (lastError) lines.push(`Last error [${lastError.source}]: ${lastError.message}`);
    return lines;
  }

  /** The exportable bundle: self-describing so it can be pasted straight into a coding agent. */
  function buildBundle(options = {}) {
    const snapshot = getSnapshot();
    const perf = performanceSummary();
    return {
      kind: 'eagler26-diagnostic-bundle',
      schemaVersion: SCHEMA_VERSION,
      generatedAt: iso(wallNow()),
      summary: summaryLines(snapshot, perf),
      howToRead: 'Eagler26 is a browser (TeaVM Wasm-GC + WebGL2) port of Minecraft Java 26.2. "snapshot" is the client state when this ' +
        'bundle was generated; "events" is a bounded chronological timeline (mono = ms since page load); "errors" are deduplicated ' +
        'recent failures with bounded stacks; "performance.history" holds one aggregate sample per 5 s (V0.503: its "bd" block is the ' +
        'per-category frame breakdown); "performance.breakdown" (when present) attributes frame time to tick/render/GPU categories, ' +
        'lists active diagnostic ablations and ABBA test results (see docs/V0_503_S330_BOTTLENECK_ISOLATION.md). All strings were redacted ' +
        'client-side (passwords, auth commands, private chat, tokens, cookies, URL secrets); packet payloads are never recorded.',
      privacy: {redacted: true, rules: 'eagler26-diagnostics-redaction-v1', packetPayloads: false, chat: false},
      session: snapshot.session,
      build: snapshot.build,
      snapshot,
      performance: {summary: perf, history: state.perf.toArray(), ...performanceSections()},
      errors: getRecentErrors(),
      events: getEvents({limit: options.maxEvents || LIMITS.events}),
    };
  }

  const cursors = {eventSeq: 0, errorSeq: 0, perfMono: -1};

  /**
   * The next upload body: everything recorded since the last acknowledged upload, trimmed to
   * maxBytes (oldest events go first, then performance samples, then snapshot sections).
   */
  function buildUploadPayload(reason, maxBytes = LIMITS.payloadBytes) {
    const snapshot = getSnapshot();
    let events = getEvents({sinceSeq: cursors.eventSeq});
    let droppedEvents = 0;
    if (events.length > LIMITS.uploadEvents) { droppedEvents = events.length - LIMITS.uploadEvents; events = events.slice(-LIMITS.uploadEvents); }
    let perfSamples = state.perf.toArray().filter(s => s.mono > cursors.perfMono);
    const errors = state.errors.toArray().filter(e => e.lastSeq > cursors.errorSeq).map(publicError);
    const marks = {
      eventSeq: events.length ? events[events.length - 1].seq : cursors.eventSeq,
      errorSeq: state.seq,
      perfMono: perfSamples.length ? perfSamples[perfSamples.length - 1].mono : cursors.perfMono,
    };
    const payload = {
      kind: 'eagler26-diagnostics-upload',
      schemaVersion: SCHEMA_VERSION,
      sessionId: state.sessionId,
      username: state.username,
      reason: cleanName(reason || 'periodic'),
      sentAt: iso(wallNow()),
      build,
      snapshot,
      performanceSummary: performanceSummary(),
      performanceSamples: perfSamples,
      errors,
      events,
      dropped: {events: droppedEvents + state.events.dropped},
      truncated: false,
    };
    let json = JSON.stringify(payload);
    const shrinkSteps = [
      () => { payload.events = payload.events.slice(Math.floor(payload.events.length / 2)); },
      () => { payload.events = payload.events.slice(Math.floor(payload.events.length / 2)); },
      () => { payload.performanceSamples = payload.performanceSamples.slice(-12); },
      () => { payload.errors = payload.errors.slice(-10).map(e => ({...e, stack: e.stack ? e.stack.slice(0, 800) : null})); },
      () => { for (const k of ['renderer', 'audio', 'skins', 'resourcePacks']) if (payload.snapshot[k]) payload.snapshot[k] = '[omitted: payload size]'; },
      () => { payload.events = payload.events.slice(-20); payload.performanceSamples = []; },
      () => { payload.snapshot = {session: snapshot.session, build, counts: snapshot.counts}; payload.errors = payload.errors.slice(-3); },
    ];
    for (const step of shrinkSteps) {
      if (json.length <= maxBytes) break;
      step();
      payload.truncated = true;
      json = JSON.stringify(payload);
    }
    if (json.length > maxBytes) return null;
    return {payload, json, marks};
  }

  function acknowledgeUpload(marks) {
    cursors.eventSeq = Math.max(cursors.eventSeq, marks.eventSeq);
    cursors.errorSeq = Math.max(cursors.errorSeq, marks.errorSeq);
    cursors.perfMono = Math.max(cursors.perfMono, marks.perfMono);
  }

  function clearLocalHistory() {
    state.events.clear();
    state.errors.clear();
    state.perf.clear();
    state.suppressed = Object.create(null);
    cursors.eventSeq = state.seq;
    cursors.errorSeq = state.seq;
    cursors.perfMono = mono();
    return true;
  }

  return {
    get enabled() { return state.enabled; },
    get sessionId() { return state.sessionId; },
    get username() { return state.username; },
    get reportNumber() { return state.reportNumber; },
    /** Report number assigned by the diagnostics server to this session (shown to testers). */
    setReportNumber(value) {
      if (Number.isSafeInteger(value) && value > 0) state.reportNumber = value;
      return state.reportNumber;
    },
    get build() { return build; },
    setBuild(partial) { build = sanitizeValue({...build, ...partial}) || build; return build; },
    startedAt: startWall,
    mono,
    setUsername(name) {
      const clean = sanitizeUsername(name);
      if (clean !== state.username) state.username = clean;
      return clean;
    },
    record, captureError, addPerfSample, performanceSummary, registerProvider, registerPerformanceSection, getSnapshot, getEvents, getRecentErrors,
    buildBundle, buildUploadPayload, acknowledgeUpload, clearLocalHistory,
    onEvent(fn) { if (typeof fn === 'function') state.listeners.push(fn); },
    get cursors() { return {...cursors}; },
    stats() {
      return {events: state.events.length, eventsTotal: state.events.total, errors: state.errors.length, perfSamples: state.perf.length,
        rateWindows: Object.keys(state.rateWindow).length, seq: state.seq};
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------------------------

/**
 * Optional, fail-open uploader. Without an endpoint (or when disabled) it never makes a request.
 * One request at a time, a timeout on each, exponential backoff after failures, a per-hour cap,
 * and batching: each upload carries only what was recorded since the last acknowledged one.
 */
export class DiagnosticsUploader {
  constructor(core, options = {}) {
    this.core = core;
    this.endpoint = typeof options.endpoint === 'string' && /^https?:\/\//i.test(options.endpoint) ? options.endpoint : null;
    this.fetch = options.fetch || (typeof fetch === 'function' ? (...a) => fetch(...a) : null);
    this.sendBeacon = options.sendBeacon || null;
    this.setTimeout = options.setTimeout || ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeout = options.clearTimeout || (id => clearTimeout(id));
    this.now = options.now || (() => Date.now());
    this.intervalMs = Math.max(60000, options.intervalMs ?? 300000);
    this.timeoutMs = Math.max(1000, options.timeoutMs ?? 10000);
    this.maxPerHour = Math.max(1, options.maxPerHour ?? 20);
    this.minGapMs = options.minGapMs ?? 30000;
    this.isAllowed = options.isAllowed || (() => true);
    this.maxBytes = options.maxBytes || LIMITS.payloadBytes;
    // Optional: resolves when the page is idle, so payloads are built outside game frames.
    this.idle = options.idle || null;
    this.timer = null;
    this.pendingTimer = null;
    this.sentTimes = [];
    this.state = {endpointConfigured: !!this.endpoint, reportNumber: null, uploads: 0, failures: 0, consecutiveFailures: 0, lastAttemptAt: null,
      lastSuccessAt: null, lastStatus: null, lastError: null, lastReason: null, backoffUntil: 0, inFlight: false, skipped: 0, lastSkip: null};
  }

  get active() { return !!(this.endpoint && this.fetch && this.core.enabled && this.isAllowed()); }

  start() {
    if (!this.endpoint || this.timer) return;
    const tick = () => {
      this.timer = this.setTimeout(tick, this.intervalMs);
      void this.flush('periodic');
    };
    this.timer = this.setTimeout(tick, this.intervalMs);
  }

  stop() {
    if (this.timer) this.clearTimeout(this.timer);
    if (this.pendingTimer) this.clearTimeout(this.pendingTimer);
    this.timer = this.pendingTimer = null;
  }

  /** Schedules a soon upload (serious error, disconnect); coalesces bursts into one request. */
  request(reason, delayMs = 5000) {
    if (!this.active || this.pendingTimer) return false;
    const last = this.state.lastAttemptAt || 0;
    const wait = Math.max(delayMs, last + this.minGapMs - this.now());
    this.pendingTimer = this.setTimeout(() => { this.pendingTimer = null; void this.flush(reason); }, wait);
    return true;
  }

  skip(why) {
    this.state.skipped++;
    this.state.lastSkip = why;
    return {ok: false, skipped: why};
  }

  withinHourlyCap() {
    const t = this.now();
    this.sentTimes = this.sentTimes.filter(x => t - x < 3600000);
    return this.sentTimes.length < this.maxPerHour;
  }

  async flush(reason = 'manual') {
    if (!this.endpoint) return this.skip('no-endpoint');
    if (!this.core.enabled) return this.skip('disabled');
    if (!this.isAllowed()) return this.skip('opted-out');
    if (!this.fetch) return this.skip('no-fetch');
    if (this.state.inFlight) return this.skip('in-flight');
    if (this.now() < this.state.backoffUntil) return this.skip('backoff');
    if (!this.withinHourlyCap()) return this.skip('hourly-cap');
    this.state.inFlight = true;
    if (this.idle) { try { await this.idle(); } catch { /* build anyway */ } }
    let built;
    try { built = this.core.buildUploadPayload(reason, this.maxBytes); } catch { built = null; }
    if (!built) { this.state.inFlight = false; return this.skip('payload-too-large'); }
    this.state.lastAttemptAt = this.now();
    this.state.lastReason = reason;
    this.sentTimes.push(this.now());
    let timeoutId = null;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    try {
      const timeout = new Promise((_, reject) => {
        // Reject first so the race reports 'timeout' rather than the fetch's abort error.
        timeoutId = this.setTimeout(() => { reject(new Error('timeout')); try { controller?.abort(); } catch { /* ignore */ } }, this.timeoutMs);
      });
      // text/plain keeps this a CORS "simple request" (no preflight) and matches sendBeacon.
      // keepalive only while the tab is being hidden: keepalive requests share a 64 KiB in-flight
      // quota per page, and Chrome rejects further ones outright ("Failed to fetch") once it is used.
      const keepalive = /^hidden/.test(reason) && built.json.length < 60000;
      const response = await Promise.race([this.fetch(this.endpoint, {
        method: 'POST', body: built.json, headers: {'Content-Type': 'text/plain;charset=UTF-8'},
        credentials: 'omit', mode: 'cors', cache: 'no-store', keepalive, signal: controller?.signal,
      }), timeout]);
      this.state.lastStatus = response?.status ?? null;
      // Always drain the (small) body: an unread response keeps the request counted as in flight.
      let text = null;
      try { text = await Promise.race([response?.text?.(), timeout]); } catch { /* the status decides success */ }
      if (!response || !response.ok) throw new Error(`HTTP ${response?.status ?? 'error'}`);
      this.core.acknowledgeUpload(built.marks);
      try {
        const reply = typeof text === 'string' && text.length < 4096 ? JSON.parse(text) : null;
        if (reply && Number.isSafeInteger(reply.reportNumber)) this.state.reportNumber = this.core.setReportNumber?.(reply.reportNumber) ?? reply.reportNumber;
      } catch { /* a non-JSON reply is fine */ }
      this.state.uploads++;
      this.state.consecutiveFailures = 0;
      this.state.backoffUntil = 0;
      this.state.lastSuccessAt = this.now();
      this.state.lastError = null;
      return {ok: true, status: response.status, bytes: built.json.length, events: built.payload.events.length};
    } catch (error) {
      this.state.failures++;
      this.state.consecutiveFailures++;
      this.state.lastError = redactText(error?.message || String(error), 120);
      const backoff = Math.min(30 * 60000, 60000 * 2 ** Math.min(5, this.state.consecutiveFailures - 1));
      this.state.backoffUntil = this.now() + backoff;
      this.core.record('diagnostics', 'warn', 'upload-failed', {error: this.state.lastError, status: this.state.lastStatus, retryInMs: backoff});
      return {ok: false, error: this.state.lastError};
    } finally {
      if (timeoutId !== null) this.clearTimeout(timeoutId);
      this.state.inFlight = false;
    }
  }

  /** Best-effort final upload when the page is going away (small payload, no response). */
  beacon(reason = 'pagehide') {
    if (!this.active || !this.sendBeacon) return false;
    let built;
    try { built = this.core.buildUploadPayload(reason, LIMITS.beaconBytes); } catch { built = null; }
    if (!built) return false;
    try {
      const queued = this.sendBeacon(this.endpoint, built.json);
      if (queued) this.core.acknowledgeUpload(built.marks);
      return !!queued;
    } catch {
      return false;
    }
  }
}
