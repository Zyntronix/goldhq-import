// globalThis.__eaglerDiagnostics — Eagler26 beta diagnostics (browser wiring).
//
// The store, sanitizer and uploader live in diagnostics-core.js; this module connects them to the
// client. It reuses the existing instrumentation instead of adding per-frame work:
//   __eaglerWatchdog (lifecycle + packet hooks), __eaglerFrameTiming / __eaglerPerf (perf samples),
//   __eaglerAudio, __eaglerRenderer, __eaglerRemoteSkins, __eaglerStartup (snapshot sections),
// plus page error / rejection / console / WebGL context events and a 1 Hz stall check. Java calls
// the java* hooks through com.astra.eagler.BrowserDiagnostics; every hook is fail-open.
//
// Console:  __eaglerDiagnostics.getSnapshot() / getEvents() / getRecentErrors() / getSessionId()
//           / exportBundle() / copyBundle() / downloadBundle() / clearLocalHistory() / uploadNow()
import { createDiagnostics, DiagnosticsUploader, redactText, redactUrl, registerSecret, sanitizeValue, summarizeTerrainMemory, SCHEMA_VERSION, LIMITS }
  from './diagnostics-core.js?v=0.9900';

const params = new URLSearchParams(globalThis.location ? location.search : '');
const UPLOAD_PREF_KEY = 'eagler26.diagnostics.upload';
const PERF_SAMPLE_MS = 5000;
const STALL_MS = 5000;
const BLOCKED_MS = 3000;
const SUSPEND_MS = 10 * 60000;

function resolveConfig() {
  const base = globalThis.__eaglerConfig?.diagnostics || {};
  const host = globalThis.location?.hostname || '';
  const loopback = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/.test(host);
  let endpoint = typeof base.endpoint === 'string' && base.endpoint ? base.endpoint : null;
  // Relative endpoints (the hosted site uses /api/diagnostics/v1/ingest) resolve against the page.
  if (endpoint) { try { endpoint = new URL(endpoint, globalThis.location?.href).href; } catch { endpoint = null; } }
  let intervalMs = Number(base.uploadIntervalMs) || 300000;
  // Local testing only: a link must not be able to redirect a deployed client's uploads.
  if (loopback && params.has('diagnosticsEndpoint')) endpoint = params.get('diagnosticsEndpoint') || null;
  if (loopback && params.has('diagnosticsUploadIntervalMs')) intervalMs = Number(params.get('diagnosticsUploadIntervalMs')) || intervalMs;
  return {
    // ?diagnostics=0 (perf baselines) only on local pages: a link must not switch logging off.
    enabled: base.enabled !== false && !(loopback && params.get('diagnostics') === '0'),
    endpoint, intervalMs,
    // Tester opt-out of uploads (the in-game Uploads On/Off button); off by default: every
    // configured client reports. A deploy can allow it with diagnostics.allowOptOut = true.
    allowOptOut: base.allowOptOut === true,
    maxUploadsPerHour: Number(base.maxUploadsPerHour) || 20,
    timeoutMs: Number(base.timeoutMs) || 10000,
    buildId: base.buildId || null, gitRevision: base.gitRevision || null,
  };
}

const readPref = () => { try { return globalThis.localStorage?.getItem(UPLOAD_PREF_KEY) ?? null; } catch { return null; } };
const writePref = value => { try { globalThis.localStorage?.setItem(UPLOAD_PREF_KEY, value); return true; } catch { return false; } };
const shortClass = name => String(name ?? '').replace(/^.*[.$]/, '') || String(name ?? '');
const mib = bytes => (Number.isFinite(bytes) ? Math.round(bytes / 1048576 * 10) / 10 : null);

function browserName(ua) {
  const m = /(Edg|OPR|Firefox|Chrome|CriOS|Version)\/(\d+)/.exec(ua);
  if (!m) return 'unknown';
  const name = {Edg: 'Edge', OPR: 'Opera', CriOS: 'Chrome iOS', Version: /Safari/.test(ua) ? 'Safari' : 'Unknown'}[m[1]] || m[1];
  return `${name} ${m[2]}`;
}

// Offline single-file build (scripts/offline/bootstrap.js sets __eaglerOffline before any client module runs):
// which payload profile this file was packaged with. Null on the hosted client.
function offlineIdentity() {
  const b = globalThis.__eaglerOffline?.build;
  if (!b || typeof b !== 'object') return null;
  const p = b.profile && typeof b.profile === 'object' ? b.profile : null;
  return {formatVersion: b.formatVersion ?? null, offlineBuildId: b.offlineBuildId ?? null, minecraftVersion: b.minecraftVersion ?? null,
    eaglerVersion: b.eaglerVersion ?? null, profileName: b.profileName ?? null, profileHash: b.profileHash ?? null,
    contentId: b.contentId ?? null, singleplayer: p ? !!p.singleplayer : null,
    audio: p && p.audio ? {sfx: p.audio.sfx ?? null, music: p.audio.music ?? null, records: p.audio.records ?? null} : null};
}

function install() {
  const config = resolveConfig();
  if (!config.enabled) {
    // Stub keeps every Java/JS hook a no-op; nothing is recorded, nothing is uploaded.
    const none = () => null;
    return {schemaVersion: SCHEMA_VERSION, enabled: false, getSessionId: none, getSnapshot: none, getEvents: () => [], getRecentErrors: () => [],
      exportBundle: none, copyBundle: none, copySessionId: none, downloadBundle: none, clearLocalHistory: () => false, record: none,
      captureError: none, uploadNow: async () => ({ok: false, skipped: 'disabled'}), getUploadState: none, setUploadsEnabled: () => false,
      attachWatchdog: none, attachGl: none, socket: none, audio: none, javaEvent: none, javaError: none, javaState: none, javaSecret: none,
      supportText: () => 'Diagnostics are disabled.', copyStatus: () => 'disabled', uploadsAllowed: () => false, uploadConfigured: () => false,
      uploadOptOutAllowed: () => false, getReportNumber: () => null};
  }

  const core = createDiagnostics({build: {name: 'Eagler26', version: globalThis.__eaglerBuildVersion || 'V0.99', assetRevision: '0.5000',
    buildId: config.buildId, gitRevision: config.gitRevision, offline: offlineIdentity()}});
  const uploader = new DiagnosticsUploader(core, {
    endpoint: config.endpoint, intervalMs: config.intervalMs, maxPerHour: config.maxUploadsPerHour, timeoutMs: config.timeoutMs,
    isAllowed: () => !config.allowOptOut || readPref() !== 'off',
    idle: typeof requestIdleCallback === 'function' ? () => new Promise(resolve => requestIdleCallback(() => resolve(), {timeout: 2000})) : null,
    sendBeacon: typeof navigator !== 'undefined' && navigator.sendBeacon
      ? (url, body) => navigator.sendBeacon(url, new Blob([body], {type: 'text/plain;charset=UTF-8'})) : null,
  });

  // ------------------------------------------------------------------ state kept for snapshots
  const net = {state: 'idle', endpoint: null, connects: 0, opens: 0, closes: 0, failures: 0, reconnects: 0, serverSwitches: 0,
    transfers: 0, respawns: 0, worldLogins: 0, disconnects: 0, serverDisconnectPackets: 0, lastCloseCode: null, lastCloseReason: null,
    lastDisconnectReason: null, lastConnectFailure: null, lastConnectionTrace: null, launchOrigin: null, lastStage: null, lastCloseStage: null,
    lastCloseClean: null, decodeFailures: 0, protocolErrors: 0, lastOpenAt: null, lastCloseAt: null};
  const packs = {selected: [], serverPushes: 0, downloads: 0, cacheHits: 0, failures: 0, lastServerPack: null, reload: {state: 'none', failures: 0, lastAt: null, lastError: null}};
  const render = {gl: null, contextLost: 0, contextRestored: 0, contextState: 'none', lastContextLostAt: null};
  const watch = {status: 'not-started', stalls: 0, longestStallMs: 0, mainThreadBlocks: 0, longestBlockMs: 0, lastHealthyAt: null,
    stallStartedAt: null, suspends: 0};
  const game = {username: null, serverHost: null, dimension: null, position: null, fps: null, connected: false, gameMode: null, updatedAt: null};
  const copy = {status: 'idle', at: null, bytes: 0};
  // Self-cost accounting: main-thread time spent inside diagnostics (heartbeat, sampling, Java
  // hooks, snapshot/bundle/payload builds, console capture), reported in stats() and snapshots.
  const self = {ms: 0, calls: 0, maxMs: 0, since: performance.now()};
  const timed = fn => {
    const t = performance.now();
    try { return fn(); } finally {
      const dt = performance.now() - t;
      self.ms += dt;
      self.calls++;
      if (dt > self.maxMs) self.maxMs = dt;
    }
  };
  const selfCost = () => {
    const uptime = performance.now() - self.since;
    return {selfTimeMs: Math.round(self.ms * 10) / 10, calls: self.calls, maxCallMs: Math.round(self.maxMs * 100) / 100,
      shareOfUptimePct: uptime > 0 ? Math.round(self.ms / uptime * 100000) / 1000 : 0};
  };
  const buildPayload0 = core.buildUploadPayload;
  core.buildUploadPayload = (...a) => timed(() => buildPayload0(...a));
  let stallOpen = false;
  let visibleSince = typeof document !== 'undefined' && document.visibilityState === 'visible' ? performance.now() : null;

  // ------------------------------------------------------------------ snapshot providers
  const staticEnv = (() => {
    const nav = typeof navigator !== 'undefined' ? navigator : {};
    const ua = String(nav.userAgent || '');
    return {
      userAgent: ua.slice(0, 300), browser: browserName(ua), platform: String(nav.userAgentData?.platform || nav.platform || 'unknown'),
      mobile: !!nav.userAgentData?.mobile, language: String(nav.language || ''), hardwareConcurrency: nav.hardwareConcurrency ?? null,
      deviceMemoryGiB: nav.deviceMemory ?? null,
      capabilities: {
        webgl2: typeof WebGL2RenderingContext !== 'undefined', webAssembly: typeof WebAssembly !== 'undefined',
        wasmExceptions: typeof WebAssembly?.Tag === 'function', jspi: typeof WebAssembly?.Suspending === 'function',
        sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined', crossOriginIsolated: !!globalThis.crossOriginIsolated,
        indexedDB: typeof indexedDB !== 'undefined', audioContext: !!(globalThis.AudioContext || globalThis.webkitAudioContext),
        clipboard: !!nav.clipboard?.writeText, pointerLock: typeof document !== 'undefined' && 'pointerLockElement' in document,
        gamepad: typeof nav.getGamepads === 'function', offscreenCanvas: typeof OffscreenCanvas !== 'undefined',
        performanceMemory: !!performance.memory, secureContext: !!globalThis.isSecureContext,
      },
    };
  })();

  core.registerProvider('environment', () => ({
    ...staticEnv,
    viewport: {width: globalThis.innerWidth ?? null, height: globalThis.innerHeight ?? null},
    screen: {width: globalThis.screen?.width ?? null, height: globalThis.screen?.height ?? null},
    devicePixelRatio: globalThis.devicePixelRatio ?? null,
    online: typeof navigator !== 'undefined' ? navigator.onLine : null,
    visibility: typeof document !== 'undefined' ? document.visibilityState : null,
    focused: typeof document !== 'undefined' && document.hasFocus ? document.hasFocus() : null,
    webgl: render.gl,
    pageUrl: globalThis.location ? redactUrl(location.href) : null,
  }));

  core.registerProvider('game', () => {
    const w = globalThis.__eaglerWatchdog;
    const last = core.performanceSummary().last;
    return {
      screen: w ? shortClass(w.currentScreen) : null, connected: game.connected || !!(w && w.protocolState && !/^(none|unknown)$/.test(w.protocolState)),
      serverHost: game.serverHost, connectionPhase: w?.protocolState ?? null, inWorld: w ? !!w.clientLevelPresent : null,
      dimension: game.dimension, position: game.position, gameMode: game.gameMode,
      fps: game.fps, sampledFps: last?.fps ?? null, frameTimeMs: last?.frameAvgMs ?? null,
      gameTicks: w?.gameTickCount ?? null, renderFrames: w?.renderFrameCount ?? null, stateAgeMs: game.updatedAt ? Math.round(performance.now() - game.updatedAt) : null,
    };
  });

  core.registerProvider('memory', () => {
    const m = performance.memory;
    const p = globalThis.__eaglerPerf;
    return {jsHeapUsedMiB: mib(m?.usedJSHeapSize), jsHeapTotalMiB: mib(m?.totalJSHeapSize), jsHeapLimitMiB: mib(m?.jsHeapSizeLimit),
      gpuBufferMiB: mib(p?.gpuBufferBytes), gpuBuffers: p?.gpuBuffers ?? null, textureMiB: mib(p?.textureBytes), textures: p?.textures ?? null,
      terrainGpuMiB: mib(globalThis.__eaglerRenderer?.terrainMemory?.totals?.heapBytes),
      terrainUsedMiB: mib(globalThis.__eaglerRenderer?.terrainMemory?.totals?.requestedBytes)};
  });

  // Terrain GPU buffer accounting (V0.501): allocated vs used bytes per layer / buffer kind /
  // allocation state, largest sections, mesh bytes produced per compile, CPU staging.
  core.registerProvider('terrainMemory', () => summarizeTerrainMemory(globalThis.__eaglerRenderer?.terrainMemory,
    globalThis.__eaglerPerf, globalThis.__eaglerSectionBufferPoolDiagnostic, performance.now()));

  core.registerProvider('renderer', () => {
    const s = globalThis.__eaglerRenderer?.state;
    return {
      webgl: render.gl, contextState: render.contextState, contextLost: render.contextLost, contextRestored: render.contextRestored,
      lastContextLostAt: render.lastContextLostAt,
      world: s ? {frame: s.frame, viewDistance: s.viewArea?.viewDistance, sections: s.sections, layers: s.layers, level: s.level,
        ageMs: s.at ? Math.round(performance.now() - s.at) : null} : null,
      lastError: globalThis.__eaglerRenderer?.lastRendererError ?? null,
    };
  });

  core.registerProvider('audio', () => {
    const a = globalThis.__eaglerAudio;
    if (!a) return null;
    const out = {};
    for (const [k, v] of Object.entries(a)) if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) out[k] = v;
    out.categoryVolumes = a.categoryVolumes;
    out.topEvents = Object.entries(a.playsByEvent || {}).sort((x, y) => y[1] - x[1]).slice(0, 10);
    out.recentPlays = Array.isArray(a.recentPlays) ? a.recentPlays.slice(-5) : null;
    return out;
  });

  const stripIds = text => String(text).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>');
  core.registerProvider('skins', () => {
    const s = globalThis.__eaglerRemoteSkins;
    return s ? {requests: s.requests, replies: s.replies, forgets: s.forgets, recent: (s.log || []).slice(-10).map(stripIds)} : null;
  });

  core.registerProvider('network', () => {
    const w = globalThis.__eaglerWatchdog;
    return {...net, packetsRx: w?.packetRxCount ?? null, packetsTx: w?.packetTxCount ?? null,
      lastRxPacket: w?.lastInboundPacket ? shortClass(w.lastInboundPacket.packet) : null,
      lastRxAgeMs: w?.lastPacketRx ? Math.round(performance.now() - w.lastPacketRx) : null,
      lastTxPacket: w?.lastOutboundPacket ? shortClass(w.lastOutboundPacket.packet) : null,
      lastDecodeFailure: w?.lastDecodeFailure?.text ?? null};
  });

  core.registerProvider('resourcePacks', () => ({...packs, server: globalThis.__eaglerPacks?.diagnostics?.() ?? null}));

  core.registerProvider('watchdog', () => {
    const w = globalThis.__eaglerWatchdog;
    const t = performance.now();
    return {...watch, lastHealthyAt: watch.lastHealthyAt ? new Date(watch.lastHealthyAt).toISOString() : null,
      stallStartedAt: undefined, tickAgeMs: w?.lastGameTick ? Math.round(t - w.lastGameTick) : null,
      frameAgeMs: w?.lastRenderFrame ? Math.round(t - w.lastRenderFrame) : null, jsHeartbeatAgeMs: w?.lastJsHeartbeat ? Math.round(t - w.lastJsHeartbeat) : null};
  });

  core.registerProvider('startup', () => {
    const s = globalThis.__eaglerStartup;
    return s ? {state: s.state, stage: s.stage, error: s.error, stages: (s.events || []).slice(-12).map(e => `${e.stage}@${Math.round(e.elapsedMs)}ms`)} : null;
  });

  core.registerProvider('storage', () => {
    const s = globalThis.__eaglerStorage;
    if (!s || typeof s !== 'object') return null;
    const out = {};
    for (const [k, v] of Object.entries(s)) if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) out[k] = v;
    return out;
  });

  core.registerProvider('diagnosticsCost', selfCost);

  // V0.503 frame attribution (PerfProbe + perf-breakdown-core): per-category frame/tick/render/GPU times, counts,
  // correlations and active diagnostic ablations; ABBA runner results in their own provider so every window stays
  // within the sanitizer's depth limit after the server re-sanitizes the snapshot.
  core.registerProvider('perfBreakdown', () => {
    const b = globalThis.__eaglerPerf?.breakdown;
    if (!b) return null;
    const {abba, ...rest} = b.section();
    return rest;
  });
  core.registerProvider('perfAbba', () => {
    const a = globalThis.__eaglerPerf?.abba;
    return a && a.state.status !== 'off' ? a.report() : null;
  });
  core.registerPerformanceSection('breakdown', () => globalThis.__eaglerPerf?.breakdown?.section() ?? null);

  core.registerProvider('upload', () => ({...uploader.state, endpointConfigured: !!config.endpoint, allowed: uploader.isAllowed(),
    optOutAllowed: config.allowOptOut,
    intervalMs: config.intervalMs, endpoint: config.endpoint ? redactUrl(config.endpoint).replace(/[?#].*$/, '') : null}));

  // ------------------------------------------------------------------ serious events -> upload soon
  core.onEvent(event => {
    if (event.sev === 'fatal') uploader.request(`fatal:${event.name}`, 1500);
    else if (event.sev === 'error') uploader.request(`serious:${event.name}`, 5000);
  });

  // ------------------------------------------------------------------ page errors
  const isWasmError = (error, message) => (typeof WebAssembly !== 'undefined' && error instanceof WebAssembly.RuntimeError) ||
    /RuntimeError|unreachable|wasm-function|\.wasm/.test(String(message || ''));
  addEventListener('error', event => {
    try {
      if (event.target && event.target !== globalThis && event.target.tagName) {
        // Resource load failure (script/img/audio element): metadata only.
        core.record('browser', 'warn', 'resource-load-failed', {element: event.target.tagName, src: event.target.src || event.target.href || null});
        return;
      }
      const error = event.error;
      core.captureError(isWasmError(error, event.message) ? 'wasm' : 'window', error || event.message,
        {stack: error?.stack, severity: 'error', data: {file: event.filename || null, line: event.lineno || null, column: event.colno || null},
          category: isWasmError(error, event.message) ? 'wasm' : 'javascript'});
    } catch { /* never let diagnostics throw from an error handler */ }
  }, true);
  addEventListener('unhandledrejection', event => {
    try {
      const reason = event.reason;
      core.captureError(isWasmError(reason, reason?.message) ? 'wasm' : 'promise', reason instanceof Error ? reason : String(reason),
        {stack: reason?.stack, severity: 'error', category: 'javascript'});
    } catch { /* ignore */ }
  });
  addEventListener('securitypolicyviolation', event => {
    core.record('browser', 'warn', 'csp-violation', {directive: event.violatedDirective, blocked: event.blockedURI});
  });

  // console.error / console.warn: bounded, redacted events (TeaVM stderr lands in console.error).
  for (const level of ['error', 'warn']) {
    const original = console[level];
    if (typeof original !== 'function') continue;
    console[level] = function (...args) {
      original.apply(this, args);
      const t = performance.now();
      try {
        const text = args.map(a => (a instanceof Error ? `${a.name}: ${a.message}` : typeof a === 'string' ? a : (() => {
          try { return JSON.stringify(a); } catch { return String(a); }
        })())).join(' ');
        core.record('javascript', 'warn', `console.${level}`, {message: text});
      } catch { /* ignore */ }
      self.ms += performance.now() - t;
    };
  }

  // ------------------------------------------------------------------ browser / input lifecycle
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      visibleSince = document.visibilityState === 'visible' ? performance.now() : null;
      core.record('browser', 'info', 'visibility', {state: document.visibilityState});
      if (document.visibilityState === 'hidden') uploader.request('hidden', 2000);
    });
    document.addEventListener('pointerlockerror', () => core.record('input', 'warn', 'pointer-lock-error'));
    document.addEventListener('pointerlockchange', () => core.record('input', 'debug', 'pointer-lock', {locked: !!document.pointerLockElement}));
    document.addEventListener('fullscreenchange', () => core.record('input', 'debug', 'fullscreen', {active: !!document.fullscreenElement}));
  }
  addEventListener('focus', () => core.record('input', 'debug', 'window-focus'));
  addEventListener('blur', () => core.record('input', 'debug', 'window-blur'));
  addEventListener('online', () => core.record('network', 'info', 'browser-online'));
  addEventListener('offline', () => core.record('network', 'warn', 'browser-offline'));
  addEventListener('pagehide', () => {
    core.record('lifecycle', 'info', 'page-hide');
    uploader.beacon('pagehide');
  });

  // ------------------------------------------------------------------ watchdog hooks (Java lifecycle/packets)
  const PACKETS = {
    'net.minecraft.network.protocol.game.ClientboundStartConfigurationPacket': 'server-switch',
    'net.minecraft.network.protocol.common.ClientboundTransferPacket': 'transfer',
    'net.minecraft.network.protocol.game.ClientboundRespawnPacket': 'respawn',
    'net.minecraft.network.protocol.game.ClientboundLoginPacket': 'world-login',
    'net.minecraft.network.protocol.login.ClientboundLoginFinishedPacket': 'login-finished',
    'net.minecraft.network.protocol.configuration.ClientboundFinishConfigurationPacket': 'configuration-finished',
    'net.minecraft.network.protocol.common.ClientboundResourcePackPushPacket': 'server-pack-push',
    'net.minecraft.network.protocol.common.ClientboundDisconnectPacket': 'server-disconnect-packet',
    'net.minecraft.network.protocol.login.ClientboundLoginDisconnectPacket': 'server-disconnect-packet',
  };
  function onPacket(kind, protocol) {
    switch (kind) {
      case 'server-switch': net.serverSwitches++; break;
      case 'transfer': net.transfers++; break;
      case 'respawn': net.respawns++; break;
      case 'world-login': net.worldLogins++; break;
      case 'server-pack-push': packs.serverPushes++; break;
      case 'server-disconnect-packet': net.serverDisconnectPackets++; break;
      default: break;
    }
    core.record(kind === 'server-pack-push' ? 'resource_pack' : 'protocol', 'info', kind, {protocol});
  }
  function onLifecycle(event, detail) {
    switch (event) {
      case 'screen': {
        const [from, to] = detail.split(' -> ');
        if (from !== to) core.record('lifecycle', 'info', 'screen', {from: shortClass(from), to: shortClass(to)});
        break;
      }
      case 'selector-open': core.record('network', 'info', 'connect-start', {endpoint: detail}); break;
      case 'selector-game-transport': core.record('network', 'info', 'game-transport', {endpoint: detail}); break;
      case 'decode-failure':
        net.decodeFailures++;
        net.protocolErrors++;
        core.captureError('protocol', `packet decode failure: ${detail}`, {severity: 'error', category: 'protocol'});
        break;
      case 'eagler-injected': core.record('protocol', 'debug', 'eagler-injected', {detail: stripIds(detail)}); break;
      default: core.record('lifecycle', 'info', event, {detail}); break;
    }
  }
  function attachWatchdog(w) {
    if (!w || w.__diagnosticsAttached) return false;
    w.__diagnosticsAttached = true;
    const lifecycle = w.lifecycle, packet = w.packet;
    if (typeof lifecycle === 'function') {
      w.lifecycle = function (event, detail) {
        lifecycle.call(this, event, detail);
        try { onLifecycle(String(event), String(detail)); } catch { /* ignore */ }
      };
    }
    if (typeof packet === 'function') {
      w.packet = function (direction, name, protocol, bytes) {
        packet.call(this, direction, name, protocol, bytes);
        if (direction === 'RX') {
          const kind = PACKETS[name];
          if (kind !== undefined) try { onPacket(kind, String(protocol)); } catch { /* ignore */ }
        }
      };
    }
    return true;
  }

  // Remote skins: BrowserRemoteSkins reuses this object if it exists; log pushes become events.
  if (!globalThis.__eaglerRemoteSkins) {
    const log = [];
    const push = Array.prototype.push;
    Object.defineProperty(log, 'push', {value(entry) {
      const r = push.call(this, entry);
      try {
        const text = String(entry);
        const kind = text.split(' ', 1)[0];
        const name = {requests: 'request', replies: 'reply', forgets: 'forget'}[kind] || 'other';
        core.record('skins', name === 'reply' ? 'info' : 'debug', `remote-skin-${name}`, {detail: stripIds(text.slice(kind.length + 1))});
      } catch { /* ignore */ }
      return r;
    }});
    globalThis.__eaglerRemoteSkins = {requests: 0, replies: 0, forgets: 0, log};
  }

  // ------------------------------------------------------------------ WebGL
  function attachGl(gl, canvas) {
    try {
      if (!gl || gl.__eaglerDiagnostics) return;
      gl.__eaglerDiagnostics = true;
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      render.gl = {
        version: String(gl.getParameter(gl.VERSION) || ''), glsl: String(gl.getParameter(gl.SHADING_LANGUAGE_VERSION) || ''),
        vendor: String(gl.getParameter(dbg ? dbg.UNMASKED_VENDOR_WEBGL : gl.VENDOR) || ''),
        renderer: String(gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || ''),
        maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE), maxSamples: gl.getParameter(gl.MAX_SAMPLES),
        antialias: !!gl.getContextAttributes()?.antialias, extensions: (gl.getSupportedExtensions() || []).length,
      };
      render.contextState = 'ok';
      core.record('renderer', 'info', 'webgl-context', render.gl);
      canvas?.addEventListener?.('webglcontextlost', () => {
        render.contextLost++;
        render.contextState = 'lost';
        render.lastContextLostAt = new Date().toISOString();
        core.captureError('webgl', 'WebGL context lost', {severity: 'error', category: 'renderer'});
      });
      canvas?.addEventListener?.('webglcontextrestored', () => {
        render.contextRestored++;
        render.contextState = 'restored';
        core.record('renderer', 'warn', 'webgl-context-restored');
      });
    } catch (error) {
      core.record('renderer', 'warn', 'webgl-info-failed', {error: String(error?.message || error)});
    }
  }

  // ------------------------------------------------------------------ WebSocket (browser-ws.js)
  function socket(event, data = {}) {
    switch (event) {
      case 'connect':
        net.connects++;
        if (net.connects > 1) net.reconnects++;
        net.state = 'connecting';
        net.endpoint = data.endpoint ? redactUrl(data.endpoint) : null;
        net.launchOrigin = data.launchOrigin || null;
        net.lastStage = 'WS_CONNECTING';
        core.record('network', 'info', 'socket-connect', {endpoint: net.endpoint, attempt: net.connects, launchOrigin: net.launchOrigin});
        break;
      case 'open':
        net.opens++;
        net.state = 'open';
        net.lastOpenAt = new Date().toISOString();
        core.record('network', 'info', 'socket-open', {endpoint: net.endpoint});
        break;
      case 'close':
        net.closes++;
        net.state = 'closed';
        net.lastCloseAt = new Date().toISOString();
        net.lastCloseCode = Number(data.closeCode) || 0;
        net.lastCloseReason = data.reason ? redactText(data.reason, 200) : null;
        net.lastCloseStage = data.stage || net.lastStage || null;
        net.lastCloseClean = data.wasClean ?? null;
        core.record('network', net.lastCloseCode === 1000 || data.cancelled ? 'info' : 'warn', 'socket-close',
          {closeCode: net.lastCloseCode, reason: net.lastCloseReason, wasClean: data.wasClean, sawError: data.sawError, stage: net.lastCloseStage,
            rxBytes: data.rxBytes, txBytes: data.txBytes, rxFrames: data.rxFrames, txFrames: data.txFrames, cancelled: !!data.cancelled});
        break;
      case 'stage':
        // Connection protocol stage (browser-ws.js stage(), driven by the Java connection code).
        net.lastStage = String(data.stage || '');
        core.record('network', 'info', 'connect-stage', {stage: net.lastStage, detail: data.detail ? redactText(String(data.detail), 200) : undefined});
        break;
      case 'error':
        net.failures++;
        net.state = 'failed';
        core.record('network', 'error', 'socket-error', {error: data.error, endpoint: net.endpoint, stage: data.stage || net.lastStage, opened: data.opened});
        break;
      default: break;
    }
  }

  // ------------------------------------------------------------------ audio (browser-audio.js log hook)
  function audio(kind, message) {
    if (kind === 'error') {
      core.captureError('audio', message, {severity: /creation failed/.test(message) ? 'error' : 'warn', category: 'audio'});
    } else if (kind === 'decode' || kind === 'missing') {
      core.record('audio', 'warn', kind === 'decode' ? 'decode-failed' : 'missing-resource', {message});
    } else if (kind === 'lifecycle') {
      core.record('audio', 'info', 'lifecycle', {message});
    }
  }

  // ------------------------------------------------------------------ Java hooks
  function javaEvent(category, severity, name, detail) {
    name = String(name);
    detail = detail == null ? null : String(detail);
    switch (name) {
      case 'disconnect':
        net.disconnects++;
        net.lastDisconnectReason = detail ? redactText(detail, 200) : null;
        uploader.request('disconnect', 3000);
        break;
      case 'connect-failed':
        net.lastConnectFailure = detail ? redactText(detail, 600) : null;
        break;
      case 'connection-trace':
        // One compact key=value line per connection attempt (EaglerConnectionTrace.summary()).
        net.lastConnectionTrace = detail ? redactText(detail, 600) : null;
        break;
      case 'pack-download': packs.downloads++; packs.lastServerPack = {result: 'downloaded', detail: redactText(detail || '', 200), at: new Date().toISOString()}; break;
      case 'pack-cached': packs.cacheHits++; packs.lastServerPack = {result: 'cached', detail: redactText(detail || '', 200), at: new Date().toISOString()}; break;
      case 'pack-failed': packs.failures++; packs.lastServerPack = {result: 'failed', detail: redactText(detail || '', 200), at: new Date().toISOString()}; break;
      case 'resource-reload':
        packs.reload.state = detail || 'ok';
        packs.reload.lastAt = new Date().toISOString();
        break;
      case 'resource-reload-failed':
        packs.reload.state = 'failed';
        packs.reload.failures++;
        packs.reload.lastAt = new Date().toISOString();
        packs.reload.lastError = detail ? redactText(detail, 200) : null;
        break;
      default: break;
    }
    return core.record(String(category), String(severity), name, detail == null ? undefined : {detail});
  }
  function javaError(source, severity, message, stack) {
    core.captureError(`java:${source}`, String(message), {stack: stack == null ? null : String(stack), severity: String(severity), category: 'error'});
  }
  function javaState(username, serverHost, dimension, x, y, z, fps, packList, connected, gameMode) {
    const t = performance.now();
    const user = core.setUsername(username);
    if (user !== game.username) {
      const first = game.username === null;
      game.username = user;
      core.record('lifecycle', 'info', 'username', {username: user});
      // Every launch registers its session (IGN + report number) as soon as the IGN is known.
      if (first && user) uploader.request('launch', 500);
    }
    const host = serverHost ? redactText(String(serverHost), 200) : null;
    const dim = dimension ? String(dimension).slice(0, 80) : null;
    const isConnected = !!connected;
    if (isConnected !== game.connected) core.record('lifecycle', 'info', isConnected ? 'world-join' : 'world-leave', {server: host ?? game.serverHost});
    else if (isConnected && dim && game.dimension && dim !== game.dimension) core.record('lifecycle', 'info', 'dimension-change', {from: game.dimension, to: dim});
    game.connected = isConnected;
    game.serverHost = host;
    game.dimension = dim;
    game.position = isConnected && Number.isFinite(x) ? {x: Math.round(x), y: Math.round(y), z: Math.round(z)} : null;
    game.fps = Number.isFinite(fps) ? fps : null;
    game.gameMode = gameMode ? String(gameMode).slice(0, 20) : null;
    game.updatedAt = t;
    const list = packList ? String(packList).split('\n').filter(Boolean).slice(0, 20).map(p => redactText(p, 100)) : [];
    if (list.join('\n') !== packs.selected.join('\n')) {
      if (packs.selected.length || list.length > 1) core.record('resource_pack', 'info', 'selection', {packs: list});
      packs.selected = list;
    }
  }
  function javaSecret(value) {
    // Arguments of an auth command the player just sent: remembered only as hashes for scrubbing.
    try { registerSecret(String(value)); } catch { /* ignore */ }
  }

  // ------------------------------------------------------------------ 1 Hz: stall detection, perf samples
  let lastBeat = performance.now();
  let lastPerfAt = performance.now();
  let lastPerfFrame = -1;
  let lastMemoryWarnAt = 0;
  function samplePerf() {
    const samples = globalThis.__eaglerFrameTiming?.samples;
    if (!samples || !samples.length) return;
    let i = samples.length - 1;
    while (i >= 0 && samples[i].frame > lastPerfFrame) i--;
    const s = samples.slice(i + 1);
    if (s.length < 2) return;
    lastPerfFrame = s[s.length - 1].frame;
    const intervals = [];
    for (let k = 1; k < s.length; k++) intervals.push(s[k].startedAt - s[k - 1].startedAt);
    const sorted = intervals.slice().sort((a, b) => a - b);
    const seconds = (s[s.length - 1].startedAt - s[0].startedAt) / 1000;
    const worst = sorted.slice(-Math.max(1, Math.floor(sorted.length / 100)));
    const avg = key => { let sum = 0, n = 0; for (const x of s) { const v = x[key]; if (typeof v === 'number') { sum += v; n++; } } return n ? Math.round(sum / s.length * 100) / 100 : 0; };
    const perf = globalThis.__eaglerPerf;
    const state = globalThis.__eaglerRenderer?.state;
    const heap = performance.memory ? mib(performance.memory.usedJSHeapSize) : null;
    let bd = null;
    try { bd = perf?.breakdown?.compactSince(s[0].startedAt) ?? null; } catch { bd = null; }
    core.addPerfSample({
      windowSeconds: Math.round(seconds * 10) / 10, frames: s.length,
      fps: seconds > 0 ? Math.round((s.length - 1) / seconds * 10) / 10 : null,
      onePercentLowFps: Math.round(1000 / (worst.reduce((a, b) => a + b, 0) / worst.length) * 10) / 10,
      frameAvgMs: Math.round(intervals.reduce((a, b) => a + b, 0) / intervals.length * 100) / 100,
      frameP95Ms: Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] * 100) / 100,
      frameMaxMs: Math.round(sorted[sorted.length - 1] * 100) / 100,
      tickMs: avg('clientTicksMs'), renderMs: avg('renderFrameMs'), runTickMs: avg('runTickMs'), sleepMs: avg('sleepMs'),
      chunkCompileMs: avg('terrainCompileMs'), chunkUploadMs: avg('terrainUploadMs'), chunkScheduled: avg('terrainSectionCompileScheduled'),
      chunkCompleted: avg('terrainSectionCompileCompleted'), compileQueue: state?.sections?.compileQueue ?? null,
      visibleSections: state?.sections?.visible ?? null, drawCalls: Math.round(avg('webglIndexedDrawCalls') + avg('webglDrawCalls')),
      glStateSkipped: avg('glStateSkipped'), heapMiB: heap, gpuBufferMiB: mib(perf?.gpuBufferBytes), textureMiB: mib(perf?.textureBytes),
      terrainGpuMiB: mib(globalThis.__eaglerRenderer?.terrainMemory?.totals?.heapBytes),
      terrainUsedMiB: mib(globalThis.__eaglerRenderer?.terrainMemory?.totals?.requestedBytes),
      bd,
    });
    const limit = performance.memory ? mib(performance.memory.jsHeapSizeLimit) : null;
    if (heap && limit && heap > limit * 0.85 && performance.now() - lastMemoryWarnAt > 300000) {
      lastMemoryWarnAt = performance.now();
      core.record('memory', 'warn', 'heap-near-limit', {heapMiB: heap, limitMiB: limit});
    }
  }
  function beat() {
    const t = performance.now();
    const gap = t - lastBeat;
    lastBeat = t;
    try {
      const visible = typeof document === 'undefined' || document.visibilityState === 'visible';
      if (gap > SUSPEND_MS) {
        watch.suspends++;
        core.record('browser', 'info', 'resumed-after-suspend', {gapMs: Math.round(gap)});
      } else if (gap > BLOCKED_MS && visible) {
        watch.mainThreadBlocks++;
        watch.longestBlockMs = Math.max(watch.longestBlockMs, Math.round(gap));
        core.record('watchdog', 'warn', 'main-thread-blocked', {gapMs: Math.round(gap), screen: shortClass(globalThis.__eaglerWatchdog?.currentScreen)});
      }
      const w = globalThis.__eaglerWatchdog;
      if (w) {
        attachWatchdog(w);
        const version = globalThis.__eaglerBuildVersion;
        if (version && version !== core.build.version) core.setBuild({version});
        if (w.renderFrameCount > 0) {
          const age = t - w.lastRenderFrame;
          const settled = visible && visibleSince !== null && t - visibleSince > STALL_MS + 1000;
          if (age < 1000) {
            watch.lastHealthyAt = Date.now();
            if (stallOpen) {
              const stalled = Math.round(t - watch.stallStartedAt);
              watch.longestStallMs = Math.max(watch.longestStallMs, stalled);
              core.record('watchdog', 'warn', 'game-loop-recovered', {stalledMs: stalled});
              stallOpen = false;
            }
            watch.status = 'healthy';
          } else if (!visible) {
            watch.status = 'hidden';
          } else if (!stallOpen && settled && age > STALL_MS && gap < BLOCKED_MS) {
            stallOpen = true;
            watch.stalls++;
            watch.status = 'stalled';
            watch.stallStartedAt = t - age;
            core.captureError('watchdog', `game loop stalled: no frame for ${Math.round(age)} ms`, {severity: 'error', category: 'watchdog',
              data: {frameAgeMs: Math.round(age), tickAgeMs: Math.round(t - w.lastGameTick), screen: shortClass(w.currentScreen), protocol: w.protocolState,
                lastBoundary: w.lastRenderBoundary?.name ?? null}});
          }
        }
      }
      if (t - lastPerfAt >= PERF_SAMPLE_MS) {
        lastPerfAt = t;
        samplePerf();
      }
    } catch { /* the heartbeat must never die */ }
  }
  setInterval(() => timed(beat), 1000);

  // Storage quota once at startup (metadata only).
  try {
    navigator.storage?.estimate?.().then(e => core.record('storage', 'info', 'estimate', {usageMiB: mib(e.usage), quotaMiB: mib(e.quota)}), () => {});
  } catch { /* ignore */ }

  uploader.start();
  core.record('lifecycle', 'info', 'diagnostics-start', {uploadConfigured: !!config.endpoint, uploadAllowed: readPref() !== 'off', intervalMs: config.intervalMs});

  // ------------------------------------------------------------------ export / support helpers
  const bundleText = () => JSON.stringify(core.buildBundle(), null, 1);
  function copyText(text) {
    copy.status = 'pending';
    copy.at = Date.now();
    copy.bytes = text.length;
    const fallback = () => {
      try {
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand('copy');
        area.remove();
        document.querySelector('canvas')?.focus?.();
        copy.status = ok ? 'copied' : 'failed';
      } catch {
        copy.status = 'failed';
      }
    };
    try {
      if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(() => { copy.status = 'copied'; }, fallback);
      else fallback();
    } catch {
      fallback();
    }
    return copy.status;
  }
  function downloadBundle() {
    try {
      const url = URL.createObjectURL(new Blob([bundleText()], {type: 'application/json'}));
      const a = document.createElement('a');
      a.href = url;
      a.download = `eagler26-diagnostics-${core.sessionId}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      core.record('diagnostics', 'info', 'bundle-downloaded');
      return true;
    } catch {
      return false;
    }
  }
  // The landing page shows the tester's latest report number (same origin, this browser only).
  let rememberedReport = null;
  function rememberSession() {
    const n = uploader.state.reportNumber;
    if (!n || n === rememberedReport) return;
    rememberedReport = n;
    try {
      globalThis.localStorage?.setItem('eagler26.lastSession', JSON.stringify({reportNumber: n, sessionId: core.sessionId,
        username: core.username, at: new Date().toISOString()}));
    } catch { /* storage unavailable: nothing to remember */ }
  }
  setInterval(rememberSession, 5000);
  function uploadStatusText() {
    if (!config.endpoint) return 'Uploads: not configured (diagnostics stay on this device)';
    if (!uploader.isAllowed()) return 'Uploads: off (diagnostics stay on this device)';
    const s = uploader.state;
    if (s.lastSuccessAt) return `Uploads: on, last sent ${Math.max(0, Math.round((Date.now() - s.lastSuccessAt) / 60000))} min ago`;
    if (s.lastError) return `Uploads: on, last attempt failed (${s.lastError})`;
    return 'Uploads: on, nothing sent yet';
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    enabled: true,
    limits: LIMITS,
    getSessionId: () => core.sessionId,
    getReportNumber: () => uploader.state.reportNumber,
    getSnapshot: () => timed(() => core.getSnapshot()),
    getEvents: options => core.getEvents(options),
    getRecentErrors: limit => core.getRecentErrors(limit),
    getPerformanceHistory: () => core.buildBundle().performance.history,
    getPerformanceSummary: () => core.performanceSummary(),
    exportBundle: () => timed(() => core.buildBundle()),
    exportBundleText: bundleText,
    copyBundle: () => { core.record('diagnostics', 'info', 'bundle-copied'); return copyText(bundleText()); },
    copySessionId: () => copyText(core.sessionId),
    copyStatus: () => copy.status,
    downloadBundle,
    clearLocalHistory: () => core.clearLocalHistory(),
    record: (category, severity, name, data) => core.record(category, severity, name, data),
    captureError: (source, error, extra) => core.captureError(source, error, extra),
    uploadNow: (reason = 'manual') => uploader.flush(reason),
    getUploadState: () => ({...uploader.state, allowed: uploader.isAllowed(), optOutAllowed: config.allowOptOut, endpointConfigured: !!config.endpoint}),
    uploadConfigured: () => !!config.endpoint,
    uploadsAllowed: () => uploader.isAllowed(),
    uploadOptOutAllowed: () => config.allowOptOut,
    setUploadsEnabled(on) {
      if (!config.allowOptOut) return false;
      const ok = writePref(on ? 'on' : 'off');
      core.record('diagnostics', 'info', on ? 'uploads-enabled' : 'uploads-disabled');
      return ok;
    },
    supportText: () => uploadStatusText(),
    stats: () => ({...core.stats(), ...selfCost()}),
    attachWatchdog, attachGl, socket, audio,
    javaEvent: (...a) => timed(() => javaEvent(...a)),
    javaError: (...a) => timed(() => javaError(...a)),
    javaState: (...a) => timed(() => javaState(...a)),
    javaSecret,
    sanitize: value => sanitizeValue(value),
  };
}

let api;
try {
  api = install();
} catch (error) {
  // Diagnostics must never stop the game from starting.
  console.log('[Eagler26] diagnostics unavailable:', String(error?.message || error));
  api = {schemaVersion: SCHEMA_VERSION, enabled: false, error: String(error?.message || error)};
}
globalThis.__eaglerDiagnostics = api;
