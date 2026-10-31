// Config and diagnostics first so every later import and startup failure is observed.
import { createBootScreen } from './boot-screen.js?v=0.9900';
import './eagler-config.js?v=0.9900';
import './browser-diagnostics.js?v=0.9900';
import './browser-status.js?v=0.9900';
import './browser-ws.js?v=0.9900';
import './browser-goldproxy.js?v=0.9900';
import './browser-audio.js?v=0.9900';
import './browser-packs.js?v=0.9900';
import './browser-mesh.js?v=0.9900';
import { installImports as perfInstallImports } from './browser-perf.js?v=0.9900';

const log = document.querySelector('#log');
const boot = createBootScreen();
const lines = [];
const suppressPageLogging = new URLSearchParams(location.search).get('diagnosticLogging') === '1';
const diagnosticMode = new URLSearchParams(location.search).get('diagnostic') === '1';
// These runtime diagnostics are part of the normal build so a frozen live client
// can be inspected without a special URL or injected harness.
const diagnosticTimingMode = true;
if (suppressPageLogging) console.log('[Eagler26] diagnostic logging enabled: page logging suppressed');
const startedAt = performance.now();
const startup = globalThis.__eaglerStartup = {
  state: 'loading-assets', stage: 'page:loaded', startedAt,
  lastProgressAt: startedAt, lastHeartbeatAt: startedAt,
  heartbeatCount: 0, events: [], error: null
};
globalThis.__eaglerAssetProgress = (loaded, total) => {
  startup.assetProgress = {loaded, total};
  startup.lastProgressAt = performance.now();
};
if (diagnosticTimingMode) {
  globalThis.__eaglerFrameTiming = {
     samples: [], current: null, start(frame) {
       this.current = {frame: Number(frame), startedAt: performance.now()};
       globalThis.__eaglerPerf?.gpuBegin();
    }, pumpComplete() {
      if (this.current) this.current.pumpMs = performance.now() - this.current.startedAt;
    }, tickComplete(renderMs) {
      if (this.current) {
        this.current.tickMs = performance.now() - this.current.startedAt - this.current.pumpMs;
         this.current.renderMs = renderMs;
       }
    }, regionStart(name) {
      if (this.current) this.current[name + 'StartedAt'] = performance.now();
    }, regionEnd(name) {
      if (this.current) {
        const startedAt = this.current[name + 'StartedAt'];
        if (startedAt !== undefined) this.current[name + 'Ms'] = performance.now() - startedAt;
      }
    }, counter(name, delta = 1) {
      if (this.current) this.current[name] = (this.current[name] || 0) + Number(delta);
      this.counters[name] = (this.counters[name] || 0) + Number(delta);
    }, timing(name, milliseconds) {
      if (this.current) this.current[name] = (this.current[name] || 0) + Number(milliseconds);
      this.counters[name] = (this.counters[name] || 0) + Number(milliseconds);
    }, sleep() {
      globalThis.__eaglerPerf?.gpuEnd();
      if (this.current) this.current.sleepAt = performance.now();
    }, resumed() {
      if (this.current) {
        this.current.resumeDelayMs = performance.now() - this.current.startedAt;
        this.current.sleepMs = performance.now() - this.current.sleepAt;
        if (this.samples.length === 10000) this.samples.shift();
         this.current.completedAt = performance.now();
         globalThis.__eaglerPerf?.closeFrame(this.current);
         this.samples.push(this.current);
         this.current = null;
       }
    }, counters: {}
   };
  const watchdogNow = () => performance.now();
  const watchdog = globalThis.__eaglerWatchdog = {
    buildVersion: globalThis.__eaglerBuildVersion || 'V0.99',
    startedAt: watchdogNow(),
    protocolState: 'unknown', currentScreen: 'unknown', clientLevelPresent: false,
    gameTickCount: 0, lastGameTick: 0, renderFrameCount: 0, lastRenderFrame: 0,
    connectionTickCount: 0, lastConnectionTick: 0, jsHeartbeatCount: 0, lastJsHeartbeat: 0,
    packetRxCount: 0, lastPacketRx: 0, packetTxCount: 0, lastPacketTx: 0,
    lastInboundPacket: null, lastOutboundPacket: null, lastRenderBoundary: null, lastTabBoundary: null,
    javaTickAt: 0, frameAt: 0, jsHeartbeatAt: 0,
    tick: 0, frame: 0, screen: 'unknown', protocol: 'unknown', world: false,
    rxAt: 0, txAt: 0, lastRx: null, lastTx: null, lifecycleEvents: [], packets: [],
    heartbeat(tick, frame, screen, protocol, world) {
      const now = watchdogNow(); this.javaTickAt = now; this.frameAt = now;
      this.gameTickCount = Number(tick); this.lastGameTick = now;
      this.renderFrameCount = Number(frame); this.lastRenderFrame = now;
      this.connectionTickCount = Number(tick); this.lastConnectionTick = now;
      this.tick = Number(tick); this.frame = Number(frame); this.screen = String(screen);
      this.currentScreen = String(screen); this.protocol = String(protocol);
      this.protocolState = String(protocol); this.world = !!world; this.clientLevelPresent = !!world;
    },
    packet(direction, packet, protocol, bytes) {
      const now = watchdogNow(); const value = {at: now, ageMs: 0, direction: String(direction),
        packet: String(packet), protocol: String(protocol), bytes: Number(bytes)};
      if (direction === 'RX') { this.rxAt = now; this.lastRx = value; this.packetRxCount++; this.lastPacketRx = now; this.lastInboundPacket = value; }
      else { this.txAt = now; this.lastTx = value; this.packetTxCount++; this.lastPacketTx = now; this.lastOutboundPacket = value; }
      this.packets.push(value); if (this.packets.length > 256) this.packets.shift();
    },
    boundary(name, detail = null) {
      const value = {at: watchdogNow(), name: String(name), detail};
      this.lastRenderBoundary = value;
      if (name === 'TAB') this.lastTabBoundary = value;
    },
    lifecycle(event, detail) {
       this.lifecycleEvents.push({at: watchdogNow(), event: String(event), detail: String(detail)});
       if (this.lifecycleEvents.length > 32) this.lifecycleEvents.shift();
    }
  };
  globalThis.__eaglerDiagnostics?.attachWatchdog?.(watchdog);
  const jsHeartbeat = setInterval(() => { watchdog.jsHeartbeatAt = watchdogNow(); watchdog.jsHeartbeatCount++; watchdog.lastJsHeartbeat = watchdog.jsHeartbeatAt; }, 250);
  globalThis.__eaglerWatchdogInterval = jsHeartbeat;
}
let diagnosticRuntime;
let diagnosticSnapshots = 0;
const recordDiagnosticMemory = async (reason) => {
  if (!diagnosticMode) return;
  const memory = diagnosticRuntime?.exports?.memory;
  const buffer = memory?.buffer;
  const sample = {reason, shapeSnapshots: diagnosticSnapshots,
    runtimeExportsMemoryBuffer: {
      byteLength: buffer?.byteLength,
     constructor: buffer?.constructor?.name
     }};
  startup.runtimeMemory = sample.runtimeExportsMemoryBuffer;
  if (performance.memory) sample.memory = {
    usedJSHeapSize: performance.memory.usedJSHeapSize,
    totalJSHeapSize: performance.memory.totalJSHeapSize,
    jsHeapSizeLimit: performance.memory.jsHeapSizeLimit
  };
  if (typeof performance.userAgentSpecificMemory === 'function') {
    try { sample.userAgentSpecificMemory = await performance.userAgentSpecificMemory(); }
    catch (error) { sample.userAgentSpecificMemoryError = String(error); }
  }
  console.log('[Eagler26] diagnostic memory probe', JSON.stringify(sample));
};
const originalConsoleLog = console.log;
if (diagnosticMode) {
  console.log = (...args) => {
    originalConsoleLog(...args);
    if (String(args[0]).includes('bootstrapTrace shapeCounters')) {
      diagnosticSnapshots++;
      if (diagnosticSnapshots % 500 === 0) recordDiagnosticMemory('shape-snapshot');
    }
  };
}
const write = (line) => {
  if (!suppressPageLogging) {
    lines.push(line);
    if (log) log.textContent = lines.join('\n');
    console.log(line);
  }
};
const stage = (name, state = name) => {
  const now = performance.now();
  startup.stage = name;
  startup.state = state;
  startup.lastProgressAt = now;
  startup.events.push({stage: name, state, elapsedMs: now - startedAt});
  globalThis.__eaglerDiagnostics?.record?.(name.startsWith('wasm') ? 'wasm' : 'lifecycle', 'info', `startup:${name}`, {elapsedMs: Math.round(now - startedAt)});
  write(`[Eagler26] ${name}`);
};
const heartbeat = setInterval(() => {
  startup.lastHeartbeatAt = performance.now();
  startup.heartbeatCount++;
}, 250);
let watchdogReported = false;
const watchdog = setInterval(() => {
  if (!watchdogReported && !startup.terminal && performance.now() - startup.lastProgressAt > 10000) {
    watchdogReported = true;
    startup.state = 'watchdog-timeout';
    startup.watchdog = {stage: startup.stage, elapsedMs: performance.now() - startup.lastProgressAt};
    globalThis.__eaglerDiagnostics?.record?.('watchdog', 'error', 'startup-no-progress', startup.watchdog);
    write(`[Eagler26] watchdog: no progress after ${Math.round(startup.watchdog.elapsedMs)}ms at ${startup.stage}`);
  }
}, 1000);

// Artifact locations: repo layout by default (scripts/serve.mjs); the hosted site's
// eagler-config.js sets client.wasmBase / client.assetBase (same origin or an asset host).
const clientConfig = globalThis.__eaglerConfig?.client || {};
const wasmBase = clientConfig.wasmBase || '/build/teavm/wasm-gc/wasm-gc/';
const assetBase = clientConfig.assetBase || '../../build/browser-assets/';
const runtimeUrl = `${wasmBase}eaglercraft-26.2-client.wasm-runtime.js?v=0.9900`;
const artifactVariant = new URLSearchParams(location.search).get('artifact');
const wasmUrl = `${wasmBase}eaglercraft-26.2-client${
  artifactVariant && /^[a-z0-9.-]+$/i.test(artifactVariant) ? `.${artifactVariant}` : ''
  }.wasm?v=0.9900`;

addEventListener('error', (event) => {
  startup.error = event.error?.stack || event.message;
  startup.state = 'failed';
  write(`[Eagler26] browser error: ${event.message}`);
});
addEventListener('unhandledrejection', (event) => {
  startup.error = String(event.reason?.stack || event.reason);
  startup.state = 'failed';
  write(`[Eagler26] unhandled rejection: ${startup.error}`);
});

try {
  await import('./browser-storage.js?v=0.9900');
  boot.set('storage', 'Opening storage');
  stage('storage:opening', 'opening-storage');
  await globalThis.__eaglerStorageOpen();
  startup.storage = globalThis.__eaglerStorage;
  stage('storage:ready', 'storage-ready');
  // Singleplayer (beta): the page bridge is small and starts nothing until a world is opened (the server Worker and
  // its Wasm load then). ?sp=off leaves it out, which disables the Singleplayer button.
  if (new URLSearchParams(location.search).get('sp') !== 'off' && globalThis.__eaglerConfig?.singleplayer?.enabled !== false) {
    try { await import('./browser-singleplayer.js?v=0.9900'); } catch (error) { write(`[Eagler26] singleplayer unavailable: ${error?.message || error}`); }
  }
  boot.set('runtime', 'Loading the game runtime');
  write(`[Eagler26] loading TeaVM runtime: ${runtimeUrl}`);
  await import(runtimeUrl);
  stage('runtime:loaded', 'runtime-ready');

  write(`[Eagler26] loading Wasm module: ${wasmUrl}`);
  boot.set('wasm', artifactVariant ? `Downloading the game (build ${artifactVariant})` : 'Downloading the game');
  // compileStreaming compiles while the bytes arrive; the step after the last byte is the rest of it.
  const compiled = TeaVM.wasmGC.load(wasmUrl, {installImports: perfInstallImports});
  const waitCompile = setInterval(() => {
    if (boot.downloadsDone?.('.wasm')) { clearInterval(waitCompile); boot.set('compile', 'Compiling the game (this can take a while on slower computers)'); }
  }, 200);
  let runtime;
  try { runtime = await compiled; } finally { clearInterval(waitCompile); }
  diagnosticRuntime = runtime;
  await recordDiagnosticMemory('startup');
  stage('wasm:instantiated', 'wasm-ready');
  boot.set('assets', 'Downloading textures and sounds');
  stage('assets:loading', 'loading-assets');
   const { preloadVanillaAssets, preloadSoundArchive } = await import('./browser-assets.js?v=0.9900');
   await preloadVanillaAssets(`${assetBase}manifest.json?assetRevision=0.5000`);
   await preloadSoundArchive(`${assetBase}sounds.idx?assetRevision=0.5000`);
  stage('assets:ready', 'assets-ready');
  if (typeof runtime.exports.main !== 'function') {
    throw new Error(`TeaVM main export is not callable: ${typeof runtime.exports.main}`);
  }
  boot.set('start', 'Starting Minecraft');
  boot.stopTracking();
  stage('main:entered', 'main-running');
  runtime.exports.main([]);
  stage('main:returned', 'startup-complete');
  startup.terminal = true;
} catch (error) {
  startup.error = error?.stack || String(error);
  startup.state = 'failed';
  startup.terminal = true;
  globalThis.__eaglerDiagnostics?.captureError?.('startup', error, {severity: 'fatal', category: 'lifecycle'});
  write(`[Eagler26] client failed: ${error?.stack || error}`);
  boot.fail(error);
} finally {
  // Keep production diagnostics alive after startup for post-startup freezes.
}
