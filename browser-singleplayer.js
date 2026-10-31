// Eagler26 singleplayer (beta): the page side of the integrated server for the real client.
//
// Loaded by client.js on every launch (unless ?sp=off or __eaglerConfig.singleplayer.enabled === false). Loading it
// only defines the API below: the server Worker, its Wasm and the asset archive are fetched when a world is opened.
// The game shows a BETA warning before the world list (SingleplayerBetaScreen).
//
// Owns one IntegratedServerHost (src/server/web/sp-host.js: the server Worker) and exposes a polling API to Java
// (com.astra.eagler.sp.BrowserSingleplayer, which cannot await promises) as globalThis.__eaglerSingleplayer:
//   status()                      JSON text: {phase, message, error, worlds, worldsLoaded, openWorld, lastSave, ...}
//   refreshWorlds()               starts listing the saved worlds (IndexedDB, via the worker)
//   start(json)                   starts (boots the worker if needed) and opens a world, then a player channel
//   takeSocket()                  the client end of the player channel once ready (once), else null
//   save()                        vanilla save + durable commit of the open world (also every 5 min and when hidden)
//   liveStats(afterSeq)           JSON text for the F3 server panel: TPS/MSPT, chunks, Worker load, new tick samples
// The Minecraft connection itself is the vanilla client Connection over the returned socket (sp-local-socket.js).
// Leaving the world closes that socket; this module then stops the server, which saves, and reports the result.
// Nothing here talks to GoldProxy, a WebSocket or ViaEagler.
import './sp/sp-local-socket.js';
import './sp/sp-durable.js';
import {IntegratedServerHost} from './sp/sp-host.js';

// The sp* query parameters are test and benchmark overrides (artifact locations, dev commands, seeds, distances). They
// apply only on a local development host: on the public site a crafted link must not point the server Worker at
// another origin's scripts (importScripts runs them with this origin) or turn on dev commands.
const DEV_HOST = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) || location.hostname.endsWith('.localhost');
const params = DEV_HOST ? new URLSearchParams(location.search) : new URLSearchParams();
const config = globalThis.__eaglerConfig?.singleplayer || {};
const serverBase = new URL(params.get('spServerBase') || config.serverBase || '../../build/teavm/server/', import.meta.url).href;
const assetBase = new URL(params.get('spAssetBase') || config.assetBase || '../../build/browser-assets/', import.meta.url).href;
const workerUrl = new URL('./sp/sp-server-worker.js', import.meta.url).href;
// Offline single-file build (scripts/offline): file:// pages cannot start file or module Workers or fetch local files from
// a Worker, so the server Worker is a blob: Worker built from embedded sources, and the Wasm, the TeaVM runtime and the
// asset archive are read here (the bootstrap answers fetch for eagler26/...) and posted to it (docs/singleplayer/06).
const OFFLINE = globalThis.__eaglerOffline || null;
async function offlineArtifacts() {
  const get = async key => {
    const r = await fetch('eagler26/' + key);
    if (!r.ok) throw new Error('offline resource ' + key + ' unavailable (HTTP ' + r.status + ')');
    return r;
  };
  const [storage, localSocket, durable, worker, runtime, wasm, idx, bin] = await Promise.all([
    get('sp/src/sp-storage.js').then(r => r.text()), get('sp/src/sp-local-socket.js').then(r => r.text()),
    get('sp/src/sp-durable.js').then(r => r.text()), get('sp/src/sp-server-worker.js').then(r => r.text()),
    get('sp/wasm/eagler26-server.wasm-runtime.js').then(r => r.text()), get('sp/wasm/eagler26-server.wasm').then(r => r.arrayBuffer()),
    get('assets/assets.idx').then(r => r.json()), get('assets/assets.bin').then(r => r.arrayBuffer())]);
  return {blobSources: {storage, localSocket, durable, worker}, runtime, wasm, idx, bin};
}
const AUTOSAVE_MS = Number(params.get('spAutosaveMs') || 300000);

const s = {
  phase: 'idle',            // idle | booting | ready | starting | connecting | playing | saving | error
  message: '',
  error: null,
  worlds: [],
  worldsLoaded: false,
  worldsVersion: 0,         // incremented by every completed listing (the vanilla world list waits for a newer one)
  worldsError: null,
  storage: null,
  openWorld: null,
  lastSave: null,
  saving: false,
  starts: 0,
  timings: {},
};
let host = null;
let socket = null;          // client end, waiting for Java
let liveSocket = null;      // client end in use by the Minecraft connection
let autosaveTimer = 0;
let busy = null;

function set(phase, message, error = null) {
  s.phase = phase;
  s.message = message || '';
  s.error = error;
}

function describe(error) {
  if (!error) return 'unknown error';
  return (error.code ? error.code + ': ' : '') + (error.message || String(error));
}

async function ensureHost() {
  if (host && host.state !== 'FAILED' && host.worker) return host;
  const offlineSources = OFFLINE ? await offlineArtifacts() : null;
  host = new IntegratedServerHost({
    ...(offlineSources ? {blobSources: offlineSources.blobSources} : {workerUrl}),
    // A crashed Worker is reported at once (error event); the heartbeat deadline only catches hangs. One uninterrupted
    // vanilla segment (a chunk generated synchronously for a far teleport) can keep the Worker's event loop busy for
    // seconds, and declaring the server dead loses the world's unsaved changes: allow 30 s (vanilla's own server
    // watchdog allows 60 s per tick). The test harness keeps sp-host's 6 s default for its fault-injection suite.
    heartbeatTimeoutMs: Number(params.get('spHeartbeatTimeoutMs') || 30000),
    startupHeartbeatTimeoutMs: 120000, // bootstrap/world start are long single segments; the start request times out at 180 s anyway
    onEvent(event) {
      if (event.type === 'heartbeat') recordLive(event);
      if (event.type === 'phase' && (s.phase === 'starting' || s.phase === 'booting')) s.message = 'Preparing world: ' + event.phase;
      else if (event.type === 'progress' && s.phase === 'starting' && event.op && event.op.startsWith('load:')) {
        s.message = `Preparing spawn area (${event.done ?? 0}/${event.total ?? '?'})`;
        s.progress = {stage: event.op.slice('load:'.length), done: event.done ?? 0, total: event.total ?? 0};
      } else if (event.type === 'log') {
        // Server WARN/ERROR lines (with stacks) go to the page console: the dev's only view into the worker.
        for (const e of event.entries) if (e.level >= 3) console.log(`[sp-server ${e.levelName}] ${e.logger}: ${e.message}${e.stack ? '\n' + e.stack : ''}`);
      } else if (event.type === 'fatal') {
        console.log(`[sp-server FATAL] ${event.message}\n${event.stack || ''}`);
      } else if (event.type === 'state' && event.state === 'FAILED') {
        stopAutosave();
        set('error', 'The integrated server failed', host && host.failure ? host.failure.message : event.detail);
        s.openWorld = null;
      }
    }
  });
  set('booting', 'Starting the integrated server');
  const t = performance.now();
  await host.start({
    // devCommands (inspect, runCommand) only for automated tests (?spTest=1).
    config: {workers: '2', maxWorkers: '32', futureFailureLog: 'warn', devCommands: params.get('spTest') === '1' ? 'true' : 'false',
      // Diagnosis (?spDebugParks=1): stacks of server-thread waits longer than 500 ms (perf command, timing.longParkStacks).
      debugParks: params.get('spDebugParks') === '1' ? 'true' : 'false',
      // A/B switch (?spPriorityResume=off): the server thread's resumes run ahead of queued worldgen fibers.
      priorityResume: params.get('spPriorityResume') || 'on'},
    ...(offlineSources
      ? {wasm: {bytes: offlineSources.wasm}, runtime: {source: offlineSources.runtime},
        assets: {index: offlineSources.idx, buffer: offlineSources.bin}, transferAssets: true}
      : {wasm: {url: serverBase + 'eagler26-server.wasm'},
        runtime: {url: serverBase + 'eagler26-server.wasm-runtime.js'},
        assets: {idxUrl: assetBase + 'assets.idx', binUrl: assetBase + 'assets.bin'}})
  }, 180000);
  s.timings.bootMs = Math.round(performance.now() - t);
  set('ready', 'Integrated server ready');
  return host;
}

// The world list and deletion read IndexedDB directly from the page (sp-durable.js, the same store the Worker commits
// to): the menus never need the integrated server, which is started only to play and released afterwards (Stage 3:
// a Worker kept alive in the menus holds hundreds of MiB, see docs/singleplayer/15-performance-memory-analysis.md).
let pageDurable = null;
function durableStore() {
  if (!pageDurable) pageDurable = globalThis.EaglerSpDurable.open().catch(error => { pageDurable = null; throw error; });
  return pageDurable;
}

async function refreshWorlds() {
  try {
    const api = await durableStore();
    const [records, estimate, persisted] = await Promise.all([api.listWorlds(), api.estimate(), api.persisted()]);
    s.worlds = records.map(({sizes, ...w}) => w);
    s.storage = {estimate: estimate && {usage: estimate.usage, quota: estimate.quota}, persisted};
    s.worldsLoaded = true;
    s.worldsError = null;
    s.worldsVersion++;
    if (s.phase === 'ready' || s.phase === 'idle') set('ready', s.worlds.length ? '' : 'No saved worlds yet');
  } catch (error) {
    s.worldsError = describe(error);
    s.worldsVersion++;
    set('error', 'Could not list saved worlds', describe(error));
  }
}

async function start(json) {
  const a = JSON.parse(json);
  s.starts++;
  set('starting', 'Preparing world'); // synchronously: the loading screen must never see a previous error
  s.progress = null;
  hostSettingsKey = ''; // a new world starts unpaused (the server resets clientPaused on startWorld)
  s.lastSave = null;
  try {
    const h = await ensureHost();
    set('starting', 'Preparing world');
    const t = performance.now();
    const result = await h.request('startWorld', {
      levelId: a.levelId, create: a.create, levelName: a.levelName, seed: params.get('spSeed') || a.seed, gameType: a.gameType || 'survival',
      // Vanilla Create World screen options (Stage 3); absent for existing worlds.
      hardcore: a.hardcore, difficulty: a.difficulty, allowCommands: a.allowCommands, worldPreset: a.worldPreset,
      generateStructures: a.generateStructures, bonusChest: a.bonusChest, gameRules: a.gameRules,
      profileName: a.profileName, profileId: a.profileId,
      // Benchmarks (dev only): ?spView=N&spSim=N override the client's render/simulation distance for the server.
      renderDistance: params.has('spView') ? Number(params.get('spView')) : a.renderDistance,
      simulationDistance: params.has('spSim') ? Number(params.get('spSim')) : a.simulationDistance
    }, 600000);
    s.timings.startWorldMs = Math.round(performance.now() - t);
    s.openWorld = {levelId: result.levelId, levelName: result.levelName, existing: result.existing, seed: result.seed, durable: result.durable || null,
      loadedFromStorage: result.loadedFromStorage || null};
    if (result.durable && result.durable.committed === false) {
      // The world runs, but it could not be written to browser storage: say so instead of pretending it is safe.
      s.lastSave = {ok: false, at: Date.now(), error: result.durable.code + ': ' + result.durable.error};
    }
    set('connecting', 'Joining world');
    const t2 = performance.now();
    socket = await h.openPlayerChannel();
    s.timings.channelMs = Math.round(performance.now() - t2);
  } catch (error) {
    set('error', 'Could not start the world', describe(error));
    if (host && (host.state === 'RUNNING' || host.state === 'LOADING_WORLD')) await stopWorld('start-failed').catch(() => {});
  }
}

function takeSocket() {
  if (!socket) return null;
  const taken = socket;
  socket = null;
  liveSocket = taken;
  set('playing', '');
  const userClose = taken.onclose;
  taken.onclose = closed => {
    if (userClose) userClose(closed);
    if (liveSocket === taken) {
      liveSocket = null;
      // The client left (or the server closed the connection): stop the world, which saves it.
      void stopWorld(closed.side === 'client' && closed.wasClean ? 'left' : 'connection-closed');
    }
  };
  startAutosave();
  return taken;
}

async function save(reason = 'manual') {
  if (!host || host.state !== 'RUNNING' || s.saving) return null;
  s.saving = true;
  const t = performance.now();
  try {
    // Vanilla's periodic autosave does not flush (saveEverything(true, false, false)): chunk compression and region
    // writes continue on the IO worker instead of stopping the server thread for seconds. Saves that must be complete
    // (tab hidden, manual) flush; leaving the world stops the server, which always flushes.
    const result = await host.request('save', {flush: reason !== 'autosave'}, 180000);
    s.lastSave = {ok: true, reason, at: Date.now(), ms: Math.round(performance.now() - t), durable: result.durable || null};
  } catch (error) {
    s.lastSave = {ok: false, reason, at: Date.now(), error: describe(error)};
  } finally {
    s.saving = false;
  }
  return s.lastSave;
}

async function stopWorld(reason) {
  stopAutosave();
  if (!host || !(host.state === 'RUNNING' || host.state === 'SAVING' || host.state === 'LOADING_WORLD')) {
    // Nothing to stop (the server already failed or stopped): end the phase so the saving screen does not wait.
    if (s.phase === 'playing' || s.phase === 'connecting' || s.phase === 'starting') {
      if (host && host.state === 'FAILED') set('error', 'The integrated server failed', host.failure ? host.failure.message : 'server failed');
      else set('ready', '');
    }
    return;
  }
  if (busy) return busy;
  set('saving', 'Saving world');
  const t = performance.now();
  busy = (async () => {
    try {
      const result = await host.request('stop', {}, 180000);
      s.lastSave = {ok: true, reason, at: Date.now(), ms: Math.round(performance.now() - t), durable: result.durable || null, stopped: true};
      releaseHost('world closed');
      set('ready', s.openWorld && s.openWorld.levelId.startsWith('sp-test-') ? 'World closed (temporary world: not kept)' : 'World saved');
    } catch (error) {
      s.lastSave = {ok: false, reason, at: Date.now(), error: describe(error), stopped: host.state === 'STOPPED'};
      set('error', 'The world was NOT saved', describe(error));
    } finally {
      s.openWorld = null;
      busy = null;
      void refreshWorlds();
    }
  })();
  return busy;
}

// The world is saved and closed: release the Worker and its heap (vanilla frees its integrated server on leaving).
// The next world starts a new one. ?spKeepWorker=1 keeps it alive (Stage 2 behavior, for comparisons).
function releaseHost(reason) {
  if (!host || params.get('spKeepWorker') === '1') return;
  if (host.state !== 'STOPPED' && host.state !== 'READY') return;
  const h = host;
  host = null;
  s.timings.releasedWorker = (s.timings.releasedWorker || 0) + 1;
  h.terminate(reason);
}

function startAutosave() {
  stopAutosave();
  autosaveTimer = setInterval(() => { if (s.phase === 'playing') void save('autosave'); }, AUTOSAVE_MS);
}

function stopAutosave() {
  if (autosaveTimer) clearInterval(autosaveTimer);
  autosaveTimer = 0;
}

// A hidden tab may be discarded or closed without notice: save while it still runs. (Nothing can be awaited on
// pagehide; changes after the last completed save are lost if the tab is killed. Documented in 13-stage2-gameplay.md.)
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && s.phase === 'playing') void save('hidden'); });

async function deleteWorld(levelId) {
  s.deleting = levelId;
  try {
    if (!/^sp-world-/.test(levelId)) throw new Error('not a saved world id: ' + levelId);
    if (s.openWorld && s.openWorld.levelId === levelId) throw new Error('the world is open');
    const api = await durableStore();
    const lock = await api.lockWorld(levelId); // held by the server while the world is open, in any tab
    if (!lock) throw new Error('the world is open in another tab or window');
    try { await api.deleteWorld(levelId); } finally { lock.release(); }
    s.lastDelete = {ok: true, levelId};
  } catch (error) {
    s.lastDelete = {ok: false, levelId, error: describe(error)};
  } finally {
    s.deleting = null;
    await refreshWorlds();
  }
}

// Vanilla IntegratedServer reads the client's pause state and view/simulation distance every tick; the Worker server
// gets them as host settings whenever they change (Minecraft.tick, browser singleplayer only).
let hostSettingsKey = '';
function setHostSettings(json) {
  if (json === hostSettingsKey || !host || host.state !== 'RUNNING') return;
  hostSettingsKey = json;
  const settings = JSON.parse(json);
  if (params.has('spView')) settings.renderDistance = Number(params.get('spView')); // benchmark overrides (dev only)
  if (params.has('spSim')) settings.simulationDistance = Number(params.get('spSim'));
  void host.request('setHostSettings', settings, 10000).catch(() => { hostSettingsKey = ''; });
}

// F3 server panel (Stage 3): the latest heartbeat's live figures and every tick duration since, read by Java
// (BrowserSingleplayer.liveStats) a few times a second. `sampleSeq` numbers the samples so a reader gets each once.
const live = {beat: null, at: 0, samples: [], sampleSeq: 0};
function recordLive(event) {
  if (!event.live) return;
  live.beat = event;
  live.at = performance.now();
  for (const ms of event.live.ticks || []) {
    live.samples.push(ms);
    live.sampleSeq++;
  }
  if (live.samples.length > 600) live.samples.splice(0, live.samples.length - 600);
}
function liveStats(afterSeq) {
  const b = live.beat;
  if (!b || !host || host.state !== 'RUNNING') return '{}';
  const l = b.live;
  const fresh = Math.max(0, Math.min(live.samples.length, live.sampleSeq - afterSeq));
  return JSON.stringify({
    seq: live.sampleSeq, ticks: live.samples.slice(live.samples.length - fresh), ageMs: Math.round(performance.now() - live.at),
    paused: !!b.paused, tps1: l.w1.tps, tps5: l.w5.tps, msptAvg: l.w5.msptAvg, msptP95: l.w5.msptP95, msptMax: l.w5.msptMax,
    chunks: l.chunks, entities: l.entities, players: b.players, pendingChunkTasks: b.pendingChunkTasks,
    workerBusyPct: l.workerBusyPct ?? null, storeBytes: l.storeBytes ?? null, storeFiles: l.storeFiles ?? null,
    jsHeapBytes: performance.memory ? performance.memory.usedJSHeapSize : null
  });
}

globalThis.__eaglerSingleplayer = {
  version: 2,
  deleteWorld: levelId => { void deleteWorld(levelId); },
  setHostSettings,
  status: () => JSON.stringify(s),
  liveStats: afterSeq => liveStats(Number(afterSeq) || 0),
  refreshWorlds: () => { void refreshWorlds(); },
  start: json => { void start(json); },
  takeSocket,
  save: () => { void save('manual'); },
  // Test and diagnostics access (not used by Java).
  debug: {
    get host() { return host; },
    get liveSocket() { return liveSocket; },
    state: () => s,
    stopWorld,
    save,
    async metrics() {
      return {page: liveSocket ? liveSocket.metrics() : null, worker: host && host.worker ? await host.transportStats().catch(e => String(e)) : null,
        server: host && host.state === 'RUNNING' ? await host.request('status').catch(e => String(e)) : null};
    }
  }
};
console.log('[Eagler26] singleplayer (beta) available; server artifacts: ' + serverBase);
