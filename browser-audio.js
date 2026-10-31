// Web Audio output layer for Minecraft's SoundEngine overlay.
//
// Java keeps vanilla sound selection, volume/pitch math, tick/loop/delay
// bookkeeping and resource resolution. This module replaces only the OpenAL
// Library/Channel layer: one shared AudioContext, per-SoundSource gain nodes,
// voices that mirror OpenAL source state, and a bounded decoded-buffer cache.
//
// Graph: voice source -> voice gain -> [panner] -> category gain -> master gain -> destination

// SoundSource ordinal order (net.minecraft.sounds.SoundSource).
export const CATEGORIES = ['master', 'music', 'record', 'weather', 'block', 'hostile', 'neutral', 'player', 'ambient', 'voice', 'ui'];
// Library.init with OpenAL Soft's usual 255 sources: sqrt(255) clamped to [2, 8]
// streaming channels, the remainder clamped to [8, 255] static channels.
export const MAX_STATIC_VOICES = 247;
export const MAX_STREAMING_VOICES = 8;
export const DECODED_BUDGET_BYTES = 96 * 1024 * 1024;
const LOG_LIMITS = {lifecycle: 64, missing: 24, decode: 24, error: 24, voices: 8};
const RECENT_LIMIT = 32;
const GESTURES = ['pointerdown', 'mousedown', 'keydown', 'touchend', 'click'];

const logCounts = new Map();
function log(kind, message) {
  const count = (logCounts.get(kind) || 0) + 1;
  logCounts.set(kind, count);
  const limit = LOG_LIMITS[kind] ?? 16;
  if (count <= limit) try { globalThis.__eaglerDiagnostics?.audio?.(kind, String(message)); } catch {}
  if (count <= limit) console.log(`[AUDIO] ${message}`);
  else if (count === limit + 1) console.log(`[AUDIO] further ${kind} messages suppressed`);
}

// Pure helpers, exported for tests.
export function linearAttenuationGain(distance, maxDistance) {
  // AL_LINEAR_DISTANCE_CLAMPED with reference distance 0 and rolloff 1.
  if (!(maxDistance > 0)) return 1;
  return 1 - Math.min(Math.max(distance, 0), maxDistance) / maxDistance;
}

export function relativeToWorld(listener, x, y, z) {
  // OpenAL listener space: +X right, +Y up, -Z forward. right = forward x up.
  const {fx, fy, fz, ux, uy, uz} = listener;
  const rx = fy * uz - fz * uy, ry = fz * ux - fx * uz, rz = fx * uy - fy * ux;
  return [
    listener.x + x * rx + y * ux - z * fx,
    listener.y + x * ry + y * uy - z * fy,
    listener.z + x * rz + y * uz - z * fz
  ];
}

export function playbackPosition(voice, now, duration) {
  const position = voice.offset + Math.max(0, now - voice.startedAt) * voice.pitch;
  if (!(duration > 0)) return 0;
  return voice.looping ? position % duration : Math.min(position, duration);
}

export function decodedSize(buffer) {
  return buffer.length * buffer.numberOfChannels * 4;
}

// Bounded LRU of decoded AudioBuffers with in-flight request coalescing.
export class DecodedCache {
  constructor(budgetBytes = DECODED_BUDGET_BYTES) {
    this.budgetBytes = budgetBytes;
    this.entries = new Map();
    this.pending = new Map();
    this.failed = new Map();
    this.bytes = 0;
    this.clock = 0;
    this.evictions = 0;
  }
  known(key) { return this.entries.has(key) || this.pending.has(key) || this.failed.has(key); }
  // load(): Promise<AudioBuffer>; a rejection is remembered until invalidate().
  get(key, load, onFailure) {
    const hit = this.entries.get(key);
    if (hit) { hit.lastUsed = ++this.clock; return Promise.resolve(hit.buffer); }
    if (this.failed.has(key)) return Promise.resolve(null);
    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight;
    const promise = Promise.resolve().then(load).then(buffer => {
      this.put(key, buffer);
      return buffer;
    }, error => {
      this.failed.set(key, error);
      onFailure?.(error);
      return null;
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }
  put(key, buffer) {
    const old = this.entries.get(key);
    if (old) this.bytes -= old.size;
    const size = decodedSize(buffer);
    this.entries.set(key, {buffer, size, lastUsed: ++this.clock, users: old?.users || 0});
    this.bytes += size;
    this.evict();
  }
  retain(key) { const entry = this.entries.get(key); if (entry) entry.users++; }
  release(key) { const entry = this.entries.get(key); if (entry && entry.users > 0) entry.users--; }
  evict() {
    while (this.bytes > this.budgetBytes) {
      let victimKey = null, victim = null;
      for (const [key, entry] of this.entries) {
        if (entry.users === 0 && (!victim || entry.lastUsed < victim.lastUsed)) { victimKey = key; victim = entry; }
      }
      if (!victim) return;
      this.entries.delete(victimKey);
      this.bytes -= victim.size;
      this.evictions++;
    }
  }
  // Drops entries whose identity may have changed with the resource state.
  invalidate(keep = () => false) {
    for (const [key, entry] of this.entries) {
      if (!keep(key)) { this.entries.delete(key); this.bytes -= entry.size; }
    }
    this.failed.clear();
  }
}

class AudioUnavailableError extends Error {}

function createBackend() {
  const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
  let ctx = null;
  let master = null;
  let categoryNodes = [];
  let hrtf = false;
  let resumePending = false;
  const voices = new Map();
  let nextVoiceId = 1;
  let staticVoices = 0;
  let streamingVoices = 0;
  const cache = new DecodedCache();
  const listener = {x: 0, y: 0, z: 0, fx: 0, fy: 0, fz: -1, ux: 0, uy: 1, uz: 0};

  const diag = globalThis.__eaglerAudio = {
    backend: 'webaudio', supported: !!Context, contextState: 'none', sampleRate: 0, hrtf: false,
    activeSources: 0, liveVoices: 0, staticVoices: 0, streamingVoices: 0,
    cachedBuffers: 0, cachedBytes: 0, pendingDecodes: 0, cacheEvictions: 0,
    totalPlays: 0, totalStops: 0, totalReleased: 0, decodeFailures: 0, missingResources: 0, excludedPlays: 0,
    skippedWhileSuspended: 0, voicesRejected: 0, nodesCreated: 0, nodesDisconnected: 0,
    currentListenerPosition: [0, 0, 0], masterVolume: 1, categoryVolumes: Object.fromEntries(CATEGORIES.map(name => [name, 1])),
    lastSoundEvent: null, lastResolvedResource: null, lastError: null, resumedBy: null, recentPlays: [], playsByEvent: {},
    // Media element source nodes are pooled for the page lifetime (at most 8).
    archiveMode: 'unknown', streamElementsUnlocked: 0, streamPoolNodes: 0,
    // Bounded snapshot of live voices for runtime inspection.
    voices(limit = 64) {
      const result = [];
      for (const voice of voices.values()) {
        if (result.length >= limit) break;
        const dx = voice.relative ? voice.x : voice.x - listener.x, dy = voice.relative ? voice.y : voice.y - listener.y, dz = voice.relative ? voice.z : voice.z - listener.z;
        const distance = Math.hypot(dx, dy, dz);
        // Signed projection onto the listener's right vector: > 0 means the source is to the right.
        const {fx, fy, fz, ux, uy, uz} = listener;
        const right = voice.relative ? voice.x : dx * (fy * uz - fz * uy) + dy * (fz * ux - fx * uz) + dz * (fx * uy - fy * ux);
        result.push({
          id: voice.id, state: voice.state, resource: voice.cacheKey, category: CATEGORIES[voice.category],
          streaming: voice.streaming, looping: voice.looping, relative: voice.relative, channels: voice.channels,
          spatial: !!voice.panner, volume: voice.volume, gainParam: voice.gain.gain.value, pitch: voice.pitch,
          playbackRate: voice.node ? voice.node.playbackRate.value : voice.element ? voice.element.playbackRate : null,
          position: [voice.x, voice.y, voice.z],
          maxDistance: voice.maxDistance, distance, right, deferred: voice.deferred, stopReason: voice.stopReason || null,
          media: voice.element ? {readyState: voice.element.readyState, networkState: voice.element.networkState, paused: voice.element.paused, currentTime: voice.element.currentTime, error: voice.element.error?.code ?? null} : null,
          attenuation: voice.panner ? (voice.maxDistance > 0 ? linearAttenuationGain(distance, voice.maxDistance) : 1) : 1
        });
      }
      return result;
    }
  };
  const refresh = () => {
    diag.liveVoices = voices.size;
    diag.staticVoices = staticVoices;
    diag.streamingVoices = streamingVoices;
    let active = 0;
    for (const voice of voices.values()) if (voice.state === 'pending' || voice.state === 'playing' || voice.state === 'paused') active++;
    diag.activeSources = active;
    diag.cachedBuffers = cache.entries.size;
    diag.cachedBytes = cache.bytes;
    diag.pendingDecodes = cache.pending.size;
    diag.cacheEvictions = cache.evictions;
  };
  const fail = (message, error) => {
    diag.lastError = `${message}: ${error?.message || error}`;
    log('error', diag.lastError);
  };

  function onStateChange() {
    diag.contextState = ctx.state;
    log('lifecycle', `state=${ctx.state}`);
    if (ctx.state === 'running') {
      for (const voice of voices.values()) if (voice.deferred) startDeferred(voice);
    }
  }

  function tryResume(reason) {
    if (!ctx || ctx.state === 'running' || ctx.state === 'closed' || resumePending) return;
    resumePending = true;
    ctx.resume().then(() => {
      resumePending = false;
      diag.resumedBy = reason;
      log('lifecycle', reason === 'sticky-activation' ? 'resumed after earlier user activation' : `resumed by user gesture (${reason})`);
    }, error => {
      resumePending = false;
      fail('resume failed', error);
    });
  }
  // Streamed sounds use pooled media elements. Strict autoplay policies
  // (Safari, Chrome's user-gesture-required mode) unlock each element only by
  // playing it inside a user gesture, so free pool elements are unlocked with a
  // silent clip on gestures and reused; the pool size matches the stream limit.
  const streamPool = [];
  let silentUrl = null;
  function silentClip() {
    if (silentUrl) return silentUrl;
    const bytes = new Uint8Array(46);
    const view = new DataView(bytes.buffer);
    const text = (offset, value) => [...value].forEach((c, i) => { bytes[offset + i] = c.charCodeAt(0); });
    text(0, 'RIFF'); view.setUint32(4, 38, true); text(8, 'WAVE'); text(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, 8000, true); view.setUint32(28, 16000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    text(36, 'data'); view.setUint32(40, 2, true);
    return silentUrl = URL.createObjectURL(new Blob([bytes], {type: 'audio/wav'}));
  }
  function newPoolEntry() {
    const entry = {element: new Audio(), node: null, busy: false, unlocked: false, unlocking: false};
    entry.element.preload = 'auto';
    streamPool.push(entry);
    return entry;
  }
  function unlockPool() {
    while (streamPool.length < MAX_STREAMING_VOICES) newPoolEntry();
    for (const entry of streamPool) {
      if (entry.busy || entry.unlocked || entry.unlocking) continue;
      entry.unlocking = true;
      entry.element.src = silentClip();
      const attempt = entry.element.play();
      Promise.resolve(attempt).then(() => { entry.unlocked = true; }, () => {}).finally(() => {
        entry.unlocking = false;
        if (!entry.busy) { entry.element.pause(); entry.element.removeAttribute('src'); entry.element.load(); }
        diag.streamElementsUnlocked = streamPool.filter(e => e.unlocked).length;
      });
    }
  }
  function acquireStreamElement() {
    const free = streamPool.filter(e => !e.busy && !e.unlocking);
    const entry = free.find(e => e.unlocked) || free[0] || newPoolEntry();
    entry.busy = true;
    if (!entry.node) { entry.node = ctx.createMediaElementSource(entry.element); diag.nodesCreated++; diag.streamPoolNodes++; }
    return entry;
  }
  function releaseStreamElement(entry) {
    const element = entry.element;
    element.onended = element.onerror = null;
    element.pause();
    element.removeAttribute('src');
    element.load();
    entry.node.disconnect();
    entry.busy = false;
  }

  const onGesture = event => {
    tryResume(event.type);
    unlockPool();
    if (ctx?.state === 'running') {
      for (const voice of voices.values()) if (voice.deferred && voice.element) startDeferred(voice);
    }
  };
  for (const type of GESTURES) addEventListener(type, onGesture, {capture: true, passive: true});

  function init(useHrtf) {
    hrtf = !!useHrtf;
    diag.hrtf = hrtf;
    if (ctx) return true;
    if (new URLSearchParams(globalThis.location?.search || '').get('audio') === '0') {
      log('lifecycle', 'disabled by ?audio=0; sounds disabled');
      return false;
    }
    if (!Context) {
      log('lifecycle', 'Web Audio is unavailable in this browser; sounds disabled');
      return false;
    }
    try {
      ctx = new Context({latencyHint: 'interactive'});
      master = ctx.createGain();
      master.connect(ctx.destination);
      categoryNodes = CATEGORIES.map(() => { const node = ctx.createGain(); node.connect(master); return node; });
      ctx.onstatechange = onStateChange;
      diag.sampleRate = ctx.sampleRate;
      diag.contextState = ctx.state;
      log('lifecycle', `context created sampleRate=${ctx.sampleRate}`);
      log('lifecycle', `state=${ctx.state}`);
      if (ctx.state !== 'running' && navigator.userActivation?.hasBeenActive) tryResume('sticky-activation');
      return true;
    } catch (error) {
      ctx = null;
      fail('AudioContext creation failed', error);
      return false;
    }
  }

  function setParam(param, value) {
    if (param.value === value) return;
    if (ctx.state === 'running') param.setTargetAtTime(value, ctx.currentTime, 0.01);
    else param.value = value;
  }

  function setCategoryGain(index, gain) {
    if (!ctx) return;
    const node = index === -1 ? master : categoryNodes[index];
    if (!node) return;
    setParam(node.gain, gain);
    if (index === -1) diag.masterVolume = gain;
    else diag.categoryVolumes[CATEGORIES[index]] = gain;
  }

  function setAudioParam3(target, names, fallback, values) {
    if (target[names[0]]) {
      for (let i = 0; i < names.length; i++) if (target[names[i]].value !== values[i]) target[names[i]].value = values[i];
    } else {
      target[fallback](...values);
    }
  }

  function setListener(x, y, z, fx, fy, fz, ux, uy, uz) {
    if (!ctx) return;
    Object.assign(listener, {x, y, z, fx, fy, fz, ux, uy, uz});
    const l = ctx.listener;
    setAudioParam3(l, ['positionX', 'positionY', 'positionZ'], 'setPosition', [x, y, z]);
    if (l.forwardX) {
      const values = [fx, fy, fz, ux, uy, uz];
      ['forwardX', 'forwardY', 'forwardZ', 'upX', 'upY', 'upZ'].forEach((name, i) => { if (l[name].value !== values[i]) l[name].value = values[i]; });
    } else {
      l.setOrientation(fx, fy, fz, ux, uy, uz);
    }
    diag.currentListenerPosition = [x, y, z];
    diag.currentListenerOrientation = [fx, fy, fz, ux, uy, uz];
    for (const voice of voices.values()) if (voice.relative && voice.panner) placePanner(voice);
  }

  function isZeroPosition(voice) { return voice.x === 0 && voice.y === 0 && voice.z === 0; }

  function placePanner(voice) {
    const [x, y, z] = voice.relative ? relativeToWorld(listener, voice.x, voice.y, voice.z) : [voice.x, voice.y, voice.z];
    setAudioParam3(voice.panner, ['positionX', 'positionY', 'positionZ'], 'setPosition', [x, y, z]);
  }

  function configurePanner(voice) {
    const panner = voice.panner;
    panner.panningModel = hrtf ? 'HRTF' : 'equalpower';
    panner.distanceModel = 'linear';
    panner.refDistance = 0;
    // AL_NONE keeps directional panning but disables distance attenuation.
    panner.maxDistance = voice.maxDistance > 0 ? voice.maxDistance : 10000;
    panner.rolloffFactor = voice.maxDistance > 0 ? 1 : 0;
    placePanner(voice);
  }

  // OpenAL spatializes only mono sources; multichannel buffers play unattenuated.
  function updateRouting(voice) {
    const spatial = voice.channels === 1 && !(voice.relative && isZeroPosition(voice));
    if (spatial === !!voice.panner) {
      if (voice.panner) configurePanner(voice);
      return;
    }
    const target = categoryNodes[voice.category];
    voice.gain.disconnect();
    if (spatial) {
      voice.panner = ctx.createPanner();
      diag.nodesCreated++;
      configurePanner(voice);
      voice.gain.connect(voice.panner);
      voice.panner.connect(target);
    } else {
      voice.panner.disconnect();
      diag.nodesDisconnected++;
      voice.panner = null;
      voice.gain.connect(target);
    }
  }

  function createVoice(streaming) {
    if (!ctx) return -1;
    if (streaming ? streamingVoices >= MAX_STREAMING_VOICES : staticVoices >= MAX_STATIC_VOICES) {
      diag.voicesRejected++;
      log('voices', `voice pool exhausted streaming=${streaming}`);
      return -1;
    }
    const voice = {
      id: nextVoiceId++, streaming: !!streaming, state: 'idle', category: 0, volume: 1, pitch: 1,
      x: 0, y: 0, z: 0, relative: false, maxDistance: 0, looping: false, channels: 0,
      gain: ctx.createGain(), panner: null, node: null, buffer: null, cacheKey: null,
      element: null, poolEntry: null, url: null, deferred: false,
      offset: 0, startedAt: 0, loadToken: 0
    };
    diag.nodesCreated++;
    voice.gain.connect(categoryNodes[0]);
    voices.set(voice.id, voice);
    if (voice.streaming) streamingVoices++; else staticVoices++;
    refresh();
    return voice.id;
  }

  function setCategory(voice, index) {
    if (voice.category === index || !categoryNodes[index]) return;
    voice.category = index;
    (voice.panner || voice.gain).disconnect();
    (voice.panner || voice.gain).connect(categoryNodes[index]);
  }

  function finish(voice, reason) {
    if (voice.state === 'stopped') return;
    voice.state = 'stopped';
    voice.deferred = false;
    voice.loadToken++;
    stopNode(voice);
    stopElement(voice);
    diag.totalStops++;
    voice.stopReason = reason;
    refresh();
  }

  function stopNode(voice) {
    const node = voice.node;
    if (!node) return;
    voice.node = null;
    node.onended = null;
    try { node.stop(); } catch {}
    node.disconnect();
    diag.nodesDisconnected++;
  }

  function stopElement(voice) {
    if (!voice.element) return;
    releaseStreamElement(voice.poolEntry);
    URL.revokeObjectURL(voice.url);
    voice.element = voice.poolEntry = voice.url = null;
  }

  function startNode(voice, offset) {
    const node = ctx.createBufferSource();
    diag.nodesCreated++;
    node.buffer = voice.buffer;
    node.loop = voice.looping;
    node.playbackRate.value = voice.pitch;
    node.connect(voice.gain);
    node.onended = () => {
      if (voice.node !== node) return;
      finish(voice, 'ended');
    };
    node.start(0, offset);
    voice.node = node;
    voice.offset = offset;
    voice.startedAt = ctx.currentTime;
    voice.state = 'playing';
    refresh();
  }

  function startDeferred(voice) {
    voice.deferred = false;
    if (voice.state !== 'pending') return;
    if (voice.element) playElement(voice);
    else if (voice.buffer) startNode(voice, 0);
  }

  function playElement(voice) {
    const element = voice.element;
    element.play().then(() => {
      if (voice.element === element && voice.state === 'pending') { voice.state = 'playing'; refresh(); }
    }, error => {
      if (voice.element !== element) return;
      if (error?.name === 'NotAllowedError') { voice.deferred = true; return; }
      fail(`stream playback failed resource=${voice.cacheKey}`, error);
      finish(voice, 'stream-failed');
    });
  }

  // Suspended with no gesture in flight: one-shots would pile up and burst on
  // resume, so they are skipped. Looping and streamed sounds wait instead.
  function mustDefer(voice) { return ctx.state !== 'running'; }
  function shouldSkip(voice) { return ctx.state !== 'running' && !resumePending && !voice.looping && !voice.streaming; }

  function toArrayBuffer(bytes) {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }

  function decode(data) {
    return new Promise((resolve, reject) => {
      const result = ctx.decodeAudioData(data, resolve, reject);
      if (result && typeof result.then === 'function') result.then(resolve, reject);
    });
  }

  async function readResource(archiveKey, bytes) {
    if (bytes) return toArrayBuffer(bytes);
    const archive = globalThis.__eaglerSoundArchive;
    if (!archive || !archive.has(archiveKey)) throw new AudioUnavailableError(`missing sound resource ${archiveKey}`);
    // Left out of this offline build on purpose: read() rejects with error.excluded, which callers keep quiet.
    const data = await archive.read(archiveKey);
    diag.archiveMode = archive.mode;
    return data;
  }

  function loadBuffer(cacheKey, archiveKey, bytes) {
    return cache.get(cacheKey, async () => {
      let data;
      try {
        data = await readResource(archiveKey, bytes);
      } catch (error) {
        error.missing = true;
        throw error;
      }
      return decode(data);
    }, error => {
      if (error?.excluded) {
        diag.excludedPlays++;
      } else if (error?.missing) {
        diag.missingResources++;
        log('missing', `missing sound resource ${cacheKey}: ${error.message || error}`);
      } else {
        diag.decodeFailures++;
        log('decode', `decode failed resource=${cacheKey}: ${error?.message || error}`);
      }
      refresh();
    });
  }

  function play(id, cacheKey, archiveKey, bytes, eventName) {
    const voice = voices.get(id);
    if (!voice || voice.state !== 'idle') return;
    voice.state = 'pending';
    voice.cacheKey = cacheKey;
    diag.totalPlays++;
    diag.lastSoundEvent = eventName;
    if (eventName in diag.playsByEvent || Object.keys(diag.playsByEvent).length < 256) diag.playsByEvent[eventName] = (diag.playsByEvent[eventName] || 0) + 1;
    diag.lastResolvedResource = cacheKey;
    diag.recentPlays.push({event: eventName, resource: cacheKey, category: CATEGORIES[voice.category], at: Math.round(performance.now())});
    if (diag.recentPlays.length > RECENT_LIMIT) diag.recentPlays.shift();
    if (shouldSkip(voice)) {
      diag.skippedWhileSuspended++;
      finish(voice, 'suspended');
      return;
    }
    const token = ++voice.loadToken;
    if (voice.streaming) {
      readResource(archiveKey, bytes).then(data => {
        if (voice.loadToken !== token || voice.state !== 'pending') return;
        voice.url = URL.createObjectURL(new Blob([data], {type: 'audio/ogg'}));
        voice.poolEntry = acquireStreamElement();
        const element = voice.element = voice.poolEntry.element;
        element.loop = voice.looping;
        element.preservesPitch = false;
        element.playbackRate = voice.pitch;
        element.src = voice.url;
        voice.poolEntry.node.connect(voice.gain);
        voice.channels = 1; // unknown until decoded; positional streams (records) are mono
        updateRouting(voice);
        element.onended = () => { if (voice.element === element) finish(voice, 'ended'); };
        element.onerror = () => {
          if (voice.element !== element) return;
          diag.decodeFailures++;
          log('decode', `decode failed resource=${cacheKey}: media element error ${element.error?.code}`);
          finish(voice, 'decode-failed');
        };
        if (mustDefer(voice)) voice.deferred = true;
        else playElement(voice);
      }, error => {
        if (voice.loadToken !== token) return;
        if (error?.excluded) {
          diag.excludedPlays++;
          finish(voice, 'excluded');
          return;
        }
        diag.missingResources++;
        log('missing', `missing sound resource ${cacheKey}: ${error?.message || error}`);
        finish(voice, 'missing');
      });
    } else {
      loadBuffer(cacheKey, archiveKey, bytes).then(buffer => {
        if (voice.loadToken !== token || voice.state !== 'pending') return;
        if (!buffer) { finish(voice, 'unavailable'); return; }
        voice.buffer = buffer;
        voice.channels = buffer.numberOfChannels;
        cache.retain(cacheKey);
        updateRouting(voice);
        if (mustDefer(voice)) voice.deferred = true;
        else startNode(voice, 0);
      });
    }
    refresh();
  }

  function pause(id) {
    const voice = voices.get(id);
    if (!voice || voice.state !== 'playing') return;
    if (voice.element) {
      voice.element.pause();
    } else {
      voice.offset = playbackPosition(voice, ctx.currentTime, voice.buffer.duration);
      stopNode(voice);
    }
    voice.state = 'paused';
    refresh();
  }

  function unpause(id) {
    const voice = voices.get(id);
    if (!voice || voice.state !== 'paused') return;
    if (voice.element) {
      voice.state = 'pending';
      playElement(voice);
    } else {
      startNode(voice, voice.offset);
    }
  }

  function stop(id) {
    const voice = voices.get(id);
    if (voice) finish(voice, 'stopped');
  }

  function release(id) {
    const voice = voices.get(id);
    if (!voice) return;
    finish(voice, voice.stopReason || 'released');
    if (voice.buffer) cache.release(voice.cacheKey);
    voice.buffer = null;
    voice.gain.disconnect();
    diag.nodesDisconnected++;
    if (voice.panner) { voice.panner.disconnect(); diag.nodesDisconnected++; voice.panner = null; }
    voices.delete(id);
    if (voice.streaming) streamingVoices--; else staticVoices--;
    diag.totalReleased++;
    refresh();
  }

  function isStopped(id) {
    const voice = voices.get(id);
    return !voice || voice.state === 'stopped';
  }

  function setVolume(id, volume) {
    const voice = voices.get(id);
    if (!voice || voice.volume === volume) return;
    voice.volume = volume;
    setParam(voice.gain.gain, volume);
  }

  function setPitch(id, pitch) {
    const voice = voices.get(id);
    if (!voice || voice.pitch === pitch) return;
    if (voice.node && voice.buffer) {
      voice.offset = playbackPosition(voice, ctx.currentTime, voice.buffer.duration);
      voice.startedAt = ctx.currentTime;
      voice.node.playbackRate.setValueAtTime(pitch, ctx.currentTime);
    }
    voice.pitch = pitch;
    if (voice.element) voice.element.playbackRate = pitch;
  }

  function setPosition(id, x, y, z) {
    const voice = voices.get(id);
    if (!voice || (voice.x === x && voice.y === y && voice.z === z)) return;
    voice.x = x; voice.y = y; voice.z = z;
    if (voice.channels) updateRouting(voice);
  }

  function configure(id, category, volume, pitch, maxDistance, looping, relative, x, y, z) {
    const voice = voices.get(id);
    if (!voice) return;
    setCategory(voice, category);
    voice.gain.gain.value = voice.volume = volume;
    voice.pitch = pitch;
    voice.maxDistance = maxDistance;
    voice.looping = !!looping;
    voice.relative = !!relative;
    voice.x = x; voice.y = y; voice.z = z;
  }

  function preload(cacheKey, archiveKey, bytes) {
    if (!ctx) return;
    loadBuffer(cacheKey, archiveKey, bytes).then(refresh);
    refresh();
  }

  function shutdown() {
    for (const id of [...voices.keys()]) release(id);
  }

  function invalidateResources() {
    // Vanilla archive bytes never change; pack-provided identities might.
    cache.invalidate(key => key.startsWith('vanilla:'));
    refresh();
  }

  function debugString() {
    return `Sounds: ${staticVoices}/${MAX_STATIC_VOICES} + ${streamingVoices}/${MAX_STREAMING_VOICES}`;
  }

  const guard = (name, fn, fallback) => (...args) => {
    try { return fn(...args); }
    catch (error) { fail(name, error); return fallback; }
  };
  return {
    init: guard('init', init, false),
    createVoice: guard('createVoice', createVoice, -1),
    configure: guard('configure', configure),
    play: guard('play', play),
    stop: guard('stop', stop),
    pause: guard('pause', pause),
    unpause: guard('unpause', unpause),
    release: guard('release', release),
    isStopped: guard('isStopped', isStopped, true),
    setVolume: guard('setVolume', setVolume),
    setPitch: guard('setPitch', setPitch),
    setPosition: guard('setPosition', setPosition),
    setListener: guard('setListener', setListener),
    setCategoryGain: guard('setCategoryGain', setCategoryGain),
    isKnown: guard('isKnown', key => cache.known(key), false),
    preload: guard('preload', preload),
    shutdown: guard('shutdown', shutdown),
    invalidateResources: guard('invalidateResources', invalidateResources),
    debugString: guard('debugString', debugString, 'Sounds: unavailable'),
    get context() { return ctx; },
    // Read-only access for runtime checks (analyser taps); not used by Java.
    get masterNode() { return master; },
    categoryNode: index => categoryNodes[index] || null,
    get listener() { return {...listener}; }
  };
}

if (typeof window !== 'undefined' && !globalThis.__eaglerAudioBackend) {
  globalThis.__eaglerAudioBackend = createBackend();
}
