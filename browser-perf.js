// window.__eaglerPerf — bounded performance profiler (R9.7).
//
// Always on (cheap): windowed frame statistics over __eaglerFrameTiming samples, live GPU
// buffer / texture byte accounting, per-frame zone times when ?perfZones=1 (BrowserZoneProfiler).
// Opt-in because counting itself costs: ?perfGl=1 counts every WebGL2 call per frame and per
// method; ?perfInterop=1 counts every JS<->Wasm import call (JSBody etc.) per frame.
import { installGlStateCache } from './browser-gl-state.js?v=0.9900';
import { createBreakdown } from './perf-breakdown-core.js?v=0.9900';
const params = new URLSearchParams(location.search);
const countGl = params.get('perfGl') === '1';
const countInterop = params.get('perfInterop') === '1';
// V0.503: ?perf.gpu=1 splits each frame's GPU time into segments (terrain / entity features / sky / GUI / ...,
// see PerfProbe GPU groups); it replaces the V0.502 whole-frame timer (TIME_ELAPSED queries cannot nest).
const gpuSegments = params.get('perf.gpu') === '1';
// V0.502: ?gpuTimer=1 measures each frame's GPU time with EXT_disjoint_timer_query_webgl2 (async, fail-open:
// unsupported or any error disables it; disjoint results are dropped). Results lag a few frames.
const gpuTimer = params.get('gpuTimer') === '1' && !gpuSegments;

// ---- V0.503 diagnostic ablation control (PerfAblation.java reads it) ---------------------------------------------
// Switches come only from this page's URL (?perf.noPlayerRender=1) or live calls (ABBA runner, automation);
// nothing is stored, so a reload without the parameter is a normal client.
const ABLATIONS = ['noTerrainRender', 'noChunkCompile', 'noEntityRender', 'noEntityTick', 'noPlayerRender', 'noPlayerTick',
  'noBlockEntityRender', 'noBlockEntityTick', 'noParticlesRender', 'noParticlesTick', 'noAnimateTick', 'noClouds', 'noWeather',
  'noSky', 'noShadows', 'noNameplates', 'noArmorLayers', 'noHeldItems', 'noCapes', 'noCustomSkins', 'noEntityTrace',
  // V0.504 optimization switches: B = the pre-V0.504 (vanilla) code path, for in-session A/B of each retained change.
  'noAnimateTickOpt', 'noTraceOpt', 'noUploadOpt', 'noVertexOpt',
  // V0.505 optimization switches (same convention).
  'noModelMathOpt', 'noVertexWriteOpt', 'noHeightOpt', 'noTextVertexOpt',
  // V0.506 Lithium-derived CPU switches (same convention; index >= 29 travels in mask2()).
  'noWorldAccessOpt', 'noInterpolationOpt', 'noArmorStandPushOpt',
  // V0.506 super-wave: coarse architecture-family switches (B = whole family off).
  'noLithiumWave', 'noSodiumWave', 'noImmediateWave', 'noMemoryWave', 'noEntityCullingWave',
  // V0.506 optional wave F: linear-memory staged vertices (B = V0.505f heap byte[] staging path).
  'noLinearVertexWave',
  // V0.507 S330 GPU/frame wave (index >= 38). mediumPrecision / fastLeavesTest are tests (B = test on); mediumPrecision
  // and the default-framebuffer part of noTileGpuWave apply at bootstrap (URL flag + page load).
  'noRetainedHud', 'noTileGpuWave', 'mediumPrecision', 'noVignetteTest', 'noMenuBlurTest', 'fastLeavesTest', 'noLinearTerrainWave',
  // V0.508 native-quality wave (index >= 45). fancyFoliageReorderTest (V0.509: the V0.508 foliage reorder as an opt-in
  // test, B = reorder on) recompiles all sections when it flips; noWorkerMeshing applies to compiles scheduled after the change.
  'noNativeGpuWave', 'fancyFoliageReorderTest', 'noFullRetainedHud', 'noWorkerMeshing',
  // V0.509 buffer-packing / TeaVM hot-path wave (index >= 49). noPackingWave applies to packs created after the change.
  'noPackingWave', 'noTeaVmWave', 'noExactGpuWave',
  // V0.509 RC micro pass (index 52): B = the v0509e path of the switchable RC changes.
  'noRcWave'];
// URL aliases (V0.507 test matrix names -> existing switches).
const ALIASES = {noCloudsTest: 'noClouds'};
// V0.507 internal world render scale: ?perf.renderScale=0.5..1 (live: __eaglerPerfControl.setRenderScale(x)).
// Percent works too (perf.renderScale=50): the site's /play redirect forwards only [A-Za-z0-9,] values before V0.507.
const clampScale = v => { let x = Number(v); if (x > 1 && x <= 100) x /= 100; return Number.isFinite(x) && x >= 0.25 && x < 1 ? Math.round(x * 1000) / 1000 : 1; };
// ABBA pseudo-variants that set the render scale for their B windows.
const SCALE_VARIANTS = {renderScale75: 0.75, renderScale50: 0.5};
// V0.504 variants: JS-side behaviour switches that are not ablations (nothing is skipped; a different code path runs).
// B = the variant on. schedLate = the V0.504 late-frame scheduler (a vsync frame that overran the display interval
// continues without waiting for requestAnimationFrame; see BrowserFrameYield.java). Opt-in until the S330 shows a win.
const VARIANTS = ['schedLate', ...Object.keys(SCALE_VARIANTS)];
const control = globalThis.__eaglerPerfControl = {
  variants: Object.fromEntries(VARIANTS.filter(v => params.get(`perf.${v}`) === '1').map(v => [v, true])),
  setVariant(name, on) { if (SCALE_VARIANTS[name]) { this.setRenderScale(on ? SCALE_VARIANTS[name] : this.renderScaleUrl); return; } const v = !!on; if (!!this.variants[name] !== v) { if (v) this.variants[name] = true; else delete this.variants[name]; this.changes++; } },
  names: ABLATIONS.slice(), flags: Object.create(null), source: Object.create(null), probe: params.get('perf.probe') !== '0',
  renderScale: clampScale(params.get('perf.renderScale')), renderScaleUrl: clampScale(params.get('perf.renderScale')),
  setRenderScale(v) { const x = clampScale(v); if (x !== this.renderScale) { this.renderScale = x; this.dirty = true; this.changes++; } },
  dirty: true, unknownUrlFlags: [], changes: 0, keepActive: params.get('perf.keepActive') === '1', keepActiveUrl: params.get('perf.keepActive') === '1',
  bind(names) {
    // Java is the source of the names; keep URL flags that match, report the rest.
    this.names = names;
    for (const k of Object.keys(this.flags)) if (!names.includes(k)) { delete this.flags[k]; this.unknownUrlFlags.push(k); }
    this.dirty = true;
  },
  mask() {
    let m = 0;
    this.names.forEach((n, i) => { if (this.flags[n] && i < 29) m |= 1 << i; });
    if (!this.probe) m |= 1 << 30;
    if (this.keepActive || this.keepActiveUrl) m |= 1 << 29;
    return m;
  },
  // V0.505: switches with index >= 29 (bits 29/30 of mask() are keepActive/probe) travel in a second word.
  mask2() {
    let m = 0;
    this.names.forEach((n, i) => { if (this.flags[n] && i >= 29) m |= 1 << (i - 29); });
    return m;
  },
  set(name, on, source = 'live') {
    if (!this.names.includes(name)) throw new Error(`unknown ablation ${name}`);
    const v = !!on;
    if (!!this.flags[name] === v) return;
    if (v) { this.flags[name] = true; this.source[name] = source; } else { delete this.flags[name]; delete this.source[name]; }
    this.dirty = true;
    this.changes++;
  },
  setKeepActive(on) { if (this.keepActive !== !!on) { this.keepActive = !!on; this.dirty = true; } },
  setProbe(on) { if (this.probe !== !!on) { this.probe = !!on; this.dirty = true; this.changes++; } },
  clearAll() { for (const n of Object.keys(this.flags)) this.set(n, false); for (const v of Object.keys(this.variants)) this.setVariant(v, false); this.setProbe(true); },
  active() { return this.names.filter(n => this.flags[n]).concat(VARIANTS.filter(v => this.variants[v]))
    .concat(this.renderScale < 1 ? [`renderScale=${this.renderScale}`] : []); },
  stateKey() { const a = this.active().join(','); return this.probe ? a : (a ? a + '|probeOff' : 'probeOff'); },
};
for (const [key, value] of params) {
  if (!key.startsWith('perf.')) continue;
  const name = ALIASES[key.slice(5)] || key.slice(5);
  if (!name.startsWith('no') && !ABLATIONS.includes(name)) continue;
  if (value === '1') { control.flags[name] = true; control.source[name] = 'url'; }
  if (!ABLATIONS.includes(name)) control.unknownUrlFlags.push(name);
}
const breakdown = createBreakdown();
// ---- V0.507 tile-GPU counters and helpers ------------------------------------------------------------------------
// Fed by WebGL2RenderPass (bindAttachments), the encoder clears, the render-scale blit and the present blit. A
// "switch" is a change of the draw framebuffer; a "re-entry" is a switch back to a framebuffer already drawn this
// frame (on a tile GPU: its tiles are stored to memory and loaded again). lastPass = the framebuffer-cache entry
// ({framebuffer, colors, depth, levels, depthLevel}) of the last render pass.
const passStats = globalThis.__eaglerPassStats = {passes: 0, switches: 0, reentries: 0, binds: 0, invalidates: 0, last: undefined,
  seen: new Set(), lastPass: null,
  note(fb, entry) {
    if (entry) { this.passes++; this.lastPass = entry; } else this.binds++;
    if (fb !== this.last) {
      this.switches++;
      const re = !!(fb && this.seen.has(fb));
      if (re) this.reentries++;
      if (fb) this.seen.add(fb);
      this.last = fb;
      if (this.trace) this.trace.push(this.describe(fb, entry, re));
    }
  },
  // Diagnostics: __eaglerPassStats.traceNext(frames) records every draw-framebuffer switch of the next frames
  // (framebuffer id, attachment byte sizes, pass or clear/blit, re-entry) into .traces; nothing is kept otherwise.
  trace: null, traces: [], traceFrames: 0, fbIds: new WeakMap(), nextFbId: 1,
  traceNext(frames = 1) { this.traces = []; this.traceFrames = Math.max(1, Math.min(10, frames)); this.trace = []; return 'tracing'; },
  describe(fb, entry, re) {
    if (!fb) return re ? 'default*' : 'default';
    let id = this.fbIds.get(fb); if (!id) { id = this.nextFbId++; this.fbIds.set(fb, id); }
    const size = t => (t && t.__eaglerBytes) ? Math.round(t.__eaglerBytes / 1024) + 'K' : '?';
    const e = entry || (globalThis.__eaglerFramebufferCache || []).find(x => x.framebuffer === fb);
    return `${entry ? 'pass' : 'bind'}#${id}${re ? '*' : ''}[${e ? e.colors.map(size).join('+') + (e.depth ? '|d' + size(e.depth) : '') : '-'}]`;
  },
  take() {
    if (this.trace && this.traceFrames > 0) { this.traces.push(this.trace.join(' > ')); this.trace = --this.traceFrames > 0 ? [] : null; }
    const r = {passes: this.passes, passSwitches: this.switches, fbReentries: this.reentries, fbBinds: this.binds, invalidates: this.invalidates};
    this.passes = this.switches = this.reentries = this.binds = this.invalidates = 0; this.seen.clear();
    return r;
  },
};
// Tile-GPU wave: the depth of the last render pass is dead once a frame's drawing into it is over (the world before
// the render-scale upscale, the GUI before present): invalidate it so a tile GPU does not write it back to memory.
globalThis.__eaglerInvalidateLastDepth = gl => {
  const e = passStats.lastPass;
  if (!globalThis.__eaglerE26TileWave || !e || !e.depth || !gl.invalidateFramebuffer) return;
  gl.bindFramebuffer(gl.FRAMEBUFFER, e.framebuffer);
  gl.invalidateFramebuffer(gl.FRAMEBUFFER, [gl.DEPTH_ATTACHMENT]);
  passStats.invalidates++;
  if (passStats.last !== e.framebuffer) { passStats.last = e.framebuffer; }
};
// Tile-GPU wave: a clear of attachments the current render pass already holds happens inside that framebuffer instead
// of switching to a clear-only framebuffer (a depth-only one for depth clears) and back. Returns the framebuffer or null.
globalThis.__eaglerClearTarget = (color, depth, needColor, needDepth) => {
  if (!globalThis.__eaglerE26TileWave) return null;
  const ok = x => x && x.levels === 0 && x.depthLevel === 0 && x.colors.length === 1 && (!needDepth || x.depth === depth)
    && (needColor ? x.colors[0] === color : (!color || x.colors[0] === color));
  let e = passStats.lastPass;
  if (!(ok(e) && e.framebuffer === passStats.last)) {
    // Otherwise a render-pass framebuffer holding these attachments (the one the next pass will bind), not a
    // clear-only framebuffer (a depth-only one for depth clears) that forces a switch there and back.
    e = null;
    for (const x of globalThis.__eaglerFramebufferCache || []) if (ok(x)) { e = x; break; }
    if (!e) return null;
  }
  passStats.note(e.framebuffer, null);
  return e.framebuffer;
};
// V0.503 GPU-bound probe (always on, non-blocking, ?perf.fence=0 disables): a fence after each frame's work; it is
// polled when the next frame starts (after the yield) and when that frame's CPU work is done. A fence still
// unsignaled at the second poll means the GPU had not finished frame N when the CPU had already produced frame N+1:
// the GPU (or the GPU process) is the bottleneck. Sync status only changes between tasks, which frames are.
const fence = {enabled: params.get('perf.fence') !== '0', current: null, busyAtStart: 0, busyAtEnd: 0, error: null};
function fenceStart() {
  const g = perf.gl;
  if (!fence.enabled || !g || !fence.current) return;
  try { fence.busyAtStart = g.getSyncParameter(fence.current, g.SYNC_STATUS) === g.SIGNALED ? 0 : 1; } catch (e) { fence.enabled = false; fence.error = String(e); }
}
function fenceEnd() {
  const g = perf.gl;
  if (!fence.enabled || !g || !g.fenceSync) return;
  try {
    if (fence.current) {
      fence.busyAtEnd = g.getSyncParameter(fence.current, g.SYNC_STATUS) === g.SIGNALED ? 0 : 1;
      g.deleteSync(fence.current);
    }
    fence.current = g.fenceSync(g.SYNC_GPU_COMMANDS_COMPLETE, 0);
  } catch (e) { fence.enabled = false; fence.error = String(e); fence.current = null; }
}
const memoryInfo = typeof performance !== 'undefined' && !!performance.memory;
let javaFrame = null, javaFresh = false, jsSelf = 0, breakdownError = null;
const frameGpu = ms => { const g = new Array((perf.breakdownNames?.gpu || ['other']).length).fill(0); g[0] = ms; return g; };
const perf = globalThis.__eaglerPerf = {
  countGl, countInterop,
  gpuBufferBytes: 0, gpuBuffers: 0, textureBytes: 0, textures: 0,
  glCallsByName: Object.create(null), interopByName: Object.create(null),
  frameGl: 0, frameInterop: 0,
  // V0.509 (?perfInterop=1 only): TypedArray objects created per frame (constructors, subarray, slice) and the bytes
  // they copy (constructor from an array/buffer view, slice) — the Wasm<->JS bulk-data traffic next to the call count.
  frameTypedArrays: 0, frameTypedArrayBytes: 0, typedArraysByKind: Object.create(null), interopTick: 0, interopCallers: Object.create(null),
  gpu: {enabled: gpuTimer, ext: null, active: null, pending: [], lastMs: null, disjoint: 0, results: 0, error: null},
  gpuBegin() {
    fenceStart();
    if (gpuSegments) return segBegin();
    const t = this.gpu, g = this.gl;
    if (!t.enabled || !g || t.active) return;
    try {
      if (t.ext === null) t.ext = g.getExtension('EXT_disjoint_timer_query_webgl2') || false;
      if (!t.ext) { t.enabled = false; t.error = 'unsupported'; return; }
      const q = g.createQuery();
      g.beginQuery(t.ext.TIME_ELAPSED_EXT, q);
      t.active = q;
    } catch (e) { t.enabled = false; t.error = String(e); }
  },
  gpuEnd() {
    fenceEnd();
    if (gpuSegments) return segEnd();
    const t = this.gpu, g = this.gl;
    if (!t.enabled || !g || !t.active) return;
    try {
      g.endQuery(t.ext.TIME_ELAPSED_EXT);
      t.pending.push(t.active);
      t.active = null;
      while (t.pending.length) {
        const q = t.pending[0];
        if (!g.getQueryParameter(q, g.QUERY_RESULT_AVAILABLE)) break;
        const disjoint = g.getParameter(t.ext.GPU_DISJOINT_EXT);
        const ns = g.getQueryParameter(q, g.QUERY_RESULT);
        g.deleteQuery(q);
        t.pending.shift();
        if (disjoint) { t.disjoint++; breakdown.addGpu('disjoint'); } else { t.lastMs = ns / 1e6; t.results++; }
      }
      if (t.pending.length > 8) { for (const q of t.pending) g.deleteQuery(q); t.pending = []; }
    } catch (e) { t.enabled = false; t.error = String(e); }
  },
  zones(json) {
    const t = globalThis.__eaglerFrameTiming;
    if (t && t.current) t.current.zones = json;
  },
  gpuMark(group) { if (gpuSegments) segMark(group); },
  // V0.503 frame attribution (PerfProbe): category names/parents once, then one Int32Array view per frame
  // (a view into Wasm linear memory: copied here, consumed by closeFrame).
  nowCallUs: null,
  breakdownSchema(names, parents, counts, gpu) {
    breakdown.setSchema(names, parents, counts, gpu);
    this.breakdownNames = {names, parents, counts, gpu};
  },
  breakdownFrame(view) {
    const t0 = performance.now();
    if (!javaFrame || javaFrame.length !== view.length) javaFrame = new Int32Array(view.length);
    javaFrame.set(view);
    javaFresh = true;
    jsSelf += performance.now() - t0;
  },
  // Called by __eaglerFrameTiming when a frame sample completes.
  closeFrame(sample) {
    const t0 = performance.now();
    const cache = this.gl && this.gl.__eaglerStateCache;
    if (cache) { sample.glStateSkipped = cache.skipped; cache.skipped = 0; }
    if (countGl) { sample.glCalls = this.frameGl; this.frameGl = 0; }
    if (countInterop) {
      sample.interopCalls = this.frameInterop; this.frameInterop = 0;
      sample.typedArrays = this.frameTypedArrays; this.frameTypedArrays = 0;
      sample.typedArrayBytes = this.frameTypedArrayBytes; this.frameTypedArrayBytes = 0;
    }
    if (this.gpu.lastMs !== null) { sample.gpuMs = this.gpu.lastMs; this.gpu.lastMs = null; if (gpuTimer) breakdown.addGpu(frameGpu(sample.gpuMs)); }
    try {
      const y = globalThis.__eaglerYield;
      const done = sample.completedAt || performance.now();
      breakdown.addFrame({
        startedAt: sample.startedAt, completedAt: sample.completedAt, pumpMs: sample.pumpMs, runTickMs: sample.runTickMs, backgroundMs: sample.backgroundMs, sleepMs: sample.sleepMs,
        yieldDelayMs: y ? y.delay : 0, rafWaitMs: y && y.rafAt && y.rafReqAt ? y.rafAt - y.rafReqAt : 0,
        rafLateMs: y && y.rafAt && y.rafTs ? Math.max(0, y.rafAt - y.rafTs) : 0, resumeMs: y && y.goAt ? Math.max(0, done - y.goAt) : 0,
        jsSelfMs: jsSelf, visibleSections: sample.terrainVisibleSections || 0, glCalls: sample.glCalls || 0, multiDraws: sample.webglMultiDrawCalls || 0,
        heapBytes: memoryInfo ? performance.memory.usedJSHeapSize : undefined,
        gpuBusyAtStart: fence.busyAtStart, gpuBusyAtEnd: fence.busyAtEnd, fenceProbe: fence.enabled && !!perf.gl, lateSched: !!(y && y.late),
        ...passStats.take(), renderScale: globalThis.__eaglerRenderScaleCurrent || 1, hudHits: sample.hudCacheHits || 0, hudMisses: sample.hudCacheMisses || 0,
      }, javaFresh ? javaFrame : null, control.stateKey());
    } catch (e) { breakdownError = String(e); }
    javaFresh = false;
    jsSelf = performance.now() - t0;
  },
  // Statistics for frames with frame number > fromFrame (default: last `frames` samples).
  report({fromFrame = -1, frames = 600, zones = true} = {}) {
    const all = globalThis.__eaglerFrameTiming?.samples || [];
    const s = fromFrame >= 0 ? all.filter(x => x.frame > fromFrame) : all.slice(-frames);
    if (s.length < 3) return {frames: s.length};
    const interval = [];
    for (let i = 1; i < s.length; i++) interval.push(s[i].startedAt - s[i - 1].startedAt);
    const col = k => s.map(x => x[k] || 0);
    const stats = v => {
      const a = v.slice().sort((x, y) => x - y), n = a.length, at = p => a[Math.min(n - 1, Math.floor(n * p))];
      return {avg: +(a.reduce((x, y) => x + y, 0) / n).toFixed(3), median: +at(0.5).toFixed(3), p95: +at(0.95).toFixed(3),
        p99: +at(0.99).toFixed(3), max: +a[n - 1].toFixed(3)};
    };
    const duration = (s[s.length - 1].startedAt - s[0].startedAt) / 1000;
    const sortedIv = interval.slice().sort((x, y) => y - x), worst = sortedIv.slice(0, Math.max(1, Math.floor(sortedIv.length / 100)));
    const out = {
      frames: s.length, seconds: +duration.toFixed(2), fps: +((s.length - 1) / duration).toFixed(2),
      onePercentLowFps: +(1000 / (worst.reduce((x, y) => x + y, 0) / worst.length)).toFixed(2),
      frameTimeMs: stats(interval),
      pumpMs: stats(col('pumpMs')), runTickMs: stats(col('runTickMs')), clientTicksMs: stats(col('clientTicksMs')),
      renderFrameMs: stats(col('renderFrameMs')), texturesMs: stats(col('texturesMs')), sleepMs: stats(col('sleepMs')),
      terrainCompileMs: stats(col('terrainCompileMs')), terrainUploadMs: stats(col('terrainUploadMs')),
      gpuMs: s.some(x => x.gpuMs !== undefined) ? stats(s.filter(x => x.gpuMs !== undefined).map(x => x.gpuMs)) : null,
      gpuTimer: {enabled: this.gpu.enabled, results: this.gpu.results, disjoint: this.gpu.disjoint, error: this.gpu.error},
      perFrame: Object.fromEntries(['webglIndexedDrawCalls', 'webglDrawCalls', 'webglIndexedDrawIndexCount', 'webglDrawVertexCount',
        'webglAllBufferSubDataCalls', 'webglAllBufferSubDataBytes', 'webglRenderPassSetPipelineCalls', 'webglRenderPassBindTextureCalls',
        'webglRenderPassSetUniformCalls', 'webglTextureSourceUploadCalls', 'webglTexelBufferUploads', 'terrainSectionCompileCompleted',
        'terrainSectionCompileScheduled', 'terrainVisibleSections', 'terrainDrawsPrepared', 'webglBatchedDrawCalls', 'webglBatchCalls', 'webglMultiDrawCalls', 'terrainQuadIndexDraws', 'terrainVisibleHoles',
        'glCalls', 'interopCalls', 'typedArrays', 'typedArrayBytes'].map(k => [k, stats(col(k)).avg])),
      glStateSkipped: stats(col('glStateSkipped')).avg,
      memory: {jsHeapMiB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
        gpuBufferMiB: +(this.gpuBufferBytes / 1048576).toFixed(1), gpuBuffers: this.gpuBuffers,
        textureMiB: +(this.textureBytes / 1048576).toFixed(1), textures: this.textures},
    };
    if (zones) {
      const acc = Object.create(null); let zf = 0;
      for (const x of s) if (x.zones) { zf++; const z = JSON.parse(x.zones); for (const k in z) acc[k] = (acc[k] || 0) + z[k][0]; }
      if (zf) out.zonesMsPerFrame = Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, +(v / zf).toFixed(3)])
        .filter(([, v]) => v >= 0.05).sort((a, b) => b[1] - a[1]).slice(0, 60));
    }
    if (countGl) out.glTopCalls = Object.entries(this.glCallsByName).sort((a, b) => b[1] - a[1]).slice(0, 30);
    if (countInterop) out.interopTop = Object.entries(this.interopByName).sort((a, b) => b[1] - a[1]).slice(0, 30);
    if (countInterop) out.typedArraysByKind = Object.entries(this.typedArraysByKind).sort((a, b) => b[1] - a[1]).slice(0, 20);
    if (countInterop) out.interopCallers = Object.entries(this.interopCallers).sort((a, b) => b[1] - a[1]).slice(0, 40);
    return out;
  },
  resetCallTables() { this.glCallsByName = Object.create(null); this.interopByName = Object.create(null); this.typedArraysByKind = Object.create(null); this.interopCallers = Object.create(null); },
};

// ---- V0.503 GPU segment timers (?perf.gpu=1) --------------------------------------------------------------------
// One TIME_ELAPSED query per segment; PerfProbe switches segments at zone boundaries (gpuMark). Results are read
// asynchronously (never waited for); a frame is summed per GPU group once all its queries are available; any
// GPU_DISJOINT drops the pending frames. Unsupported / failing -> disabled with the reason in the bundle.
const seg = {enabled: gpuSegments, ext: null, error: null, frame: null, current: -1, pending: [], pool: [], frames: 0, disjoint: 0, capped: 0};
const MAX_SEGMENTS = 96;
function segQuery(g) { return seg.pool.pop() || g.createQuery(); }
function segStart(group) {
  const g = perf.gl, f = seg.frame;
  if (f.q.length >= MAX_SEGMENTS) { seg.capped++; return; }
  const q = segQuery(g);
  g.beginQuery(seg.ext.TIME_ELAPSED_EXT, q);
  f.q.push(q); f.g.push(group); seg.current = group;
}
function segBegin() {
  const g = perf.gl;
  if (!seg.enabled || !g || seg.frame) return;
  try {
    if (seg.ext === null) seg.ext = g.getExtension('EXT_disjoint_timer_query_webgl2') || false;
    if (!seg.ext) { seg.enabled = false; seg.error = 'EXT_disjoint_timer_query_webgl2 unsupported'; return; }
    seg.frame = {q: [], g: []};
    segStart(0);
  } catch (e) { seg.enabled = false; seg.error = String(e); seg.frame = null; }
}
function segMark(group) {
  const g = perf.gl, f = seg.frame;
  if (!seg.enabled || !f || group === seg.current || f.q.length >= MAX_SEGMENTS) return;
  try { g.endQuery(seg.ext.TIME_ELAPSED_EXT); segStart(group); } catch (e) { seg.enabled = false; seg.error = String(e); }
}
function segEnd() {
  const g = perf.gl, f = seg.frame;
  if (!seg.enabled || !f) return;
  try {
    g.endQuery(seg.ext.TIME_ELAPSED_EXT);
    seg.frame = null; seg.current = -1;
    seg.pending.push(f);
    const n = (perf.breakdownNames?.gpu || []).length || 16;
    while (seg.pending.length) {
      const p = seg.pending[0];
      let ready = true;
      for (let i = p.q.length - 1; i >= 0; i--) if (!g.getQueryParameter(p.q[i], g.QUERY_RESULT_AVAILABLE)) { ready = false; break; }
      if (!ready) break;
      seg.pending.shift();
      const disjoint = g.getParameter(seg.ext.GPU_DISJOINT_EXT);
      const sums = new Array(n).fill(0);
      for (let i = 0; i < p.q.length; i++) { if (!disjoint) sums[p.g[i]] += g.getQueryParameter(p.q[i], g.QUERY_RESULT) / 1e6; seg.pool.push(p.q[i]); }
      if (disjoint) { seg.disjoint++; breakdown.addGpu('disjoint'); } else { seg.frames++; breakdown.addGpu(sums); }
    }
    if (seg.pending.length > 6) { for (const p of seg.pending) for (const q of p.q) g.deleteQuery(q); seg.pending = []; }
    if (seg.pool.length > 4 * MAX_SEGMENTS) for (const q of seg.pool.splice(2 * MAX_SEGMENTS)) g.deleteQuery(q);
  } catch (e) { seg.enabled = false; seg.error = String(e); }
}

// ---- V0.503 breakdown API (diagnostics provider, perf samples, automation) ------------------------------------------
function gpuInfo() {
  const g = perf.gl;
  let supported = null, counterBits = null;
  try {
    if (g) {
      supported = (g.getSupportedExtensions() || []).includes('EXT_disjoint_timer_query_webgl2');
      if (supported && (seg.ext || perf.gpu.ext)) counterBits = g.getQuery((seg.ext || perf.gpu.ext).TIME_ELAPSED_EXT, (seg.ext || perf.gpu.ext).QUERY_COUNTER_BITS_EXT);
    }
  } catch { /* ignore */ }
  return {supported, counterBits,
    mode: gpuSegments ? (seg.enabled ? 'segments' : 'failed') : gpuTimer ? (perf.gpu.enabled ? 'frame' : 'failed') : 'off',
    error: gpuSegments ? seg.error : gpuTimer ? perf.gpu.error : null,
    note: gpuSegments ? 'segments: GPU time per group from TIME_ELAPSED queries switched at render-phase boundaries; entity and block-entity models share entityFeatures'
      : gpuTimer ? 'frame: whole-frame GPU time only (reported as totalMs/otherMs)' : 'GPU timing off: add ?perf.gpu=1 to the URL'};
}
function extraFor() {
  const gi = gpuInfo();
  return {gpuSupported: gi.supported, gpuMode: gi.mode, gpuNote: gi.error ? `${gi.note} (error: ${gi.error})` : gi.note,
    nowCallUs: perf.nowCallUs, glCounting: countGl};
}
perf.breakdown = {
  core: breakdown, control,
  /** `performance.breakdown` for the last `seconds` (default 30). */
  summary(seconds = 30) {
    const now = performance.now();
    return breakdown.summarize(breakdown.range(now - seconds * 1000), extraFor());
  },
  summaryRange(from, to) { return breakdown.summarize(breakdown.range(from, to), extraFor()); },
  compactSince(from) { const list = breakdown.range(from); return list.length ? breakdown.compact(list) : null; },
  correlations() { return breakdown.correlations(breakdown.bins); },
  gpu: gpuInfo,
  /** The diagnostics bundle section (also the snapshot provider). */
  section() {
    const renderer = globalThis.__eaglerRenderer;
    return {
      version: 1, build: globalThis.__eaglerBuildVersion || null,
      ablations: {active: control.active(), sources: {...control.source}, probe: control.probe, liveChanges: control.changes,
        keepActive: control.keepActive || control.keepActiveUrl,
        unknownUrlFlags: control.unknownUrlFlags.slice(0, 10), available: control.names.length},
      lowEndRenderer: renderer?.features ? {...renderer.features} : null,
      // V0.507 S330 GPU/frame wave: render scale, canvas context attributes, last framebuffer-switch traces.
      v507: {renderScale: control.renderScale, renderScaleInEffect: globalThis.__eaglerRenderScaleCurrent || 1,
        contextDepth: perf.contextAttributes?.depth ?? null, contextStencil: perf.contextAttributes?.stencil ?? null,
        contextAntialias: perf.contextAttributes?.antialias ?? null, contextDesynchronized: perf.contextAttributes?.desynchronized ?? null,
        tileWave: !!globalThis.__eaglerE26TileWave, passTraces: passStats.traces.slice(0, 3)},
      gpu: {...gpuInfo(), segmentFrames: seg.frames, disjointFrames: seg.disjoint, cappedFrames: seg.capped, fenceProbe: fence.enabled, fenceError: fence.error},
      self: {nowCallUs: perf.nowCallUs === null ? null : Math.round(perf.nowCallUs * 1000) / 1000, error: breakdownError, frames: breakdown.frames},
      last10s: this.summary(10), last60s: this.summary(60),
      normal: breakdown.summarize(breakdown.bins.filter(b => b.state === ''), extraFor()),
      correlation: this.correlations(),
      abba: abba.report(),
    };
  },
};

// ---- V0.503 in-page ABBA runner (?perf.abba=<ablation[,ablation...]|suite>) --------------------------------------------
// For each ablation: A (normal) / B (ablation on) / B / A windows of ?perf.abbaWindow seconds (default 15; the first
// 3 s of each window are discarded), after ?perf.abbaDelay seconds in a world (default 20). Same session, so run-order
// drift hits A and B alike; A2 - A1 reports that drift. The tester only has to stand still.
const SUITES = {
  standing: ['noTerrainRender', 'noEntityRender', 'noEntityTick', 'noAnimateTick', 'noBlockEntityRender', 'noBlockEntityTick',
    'noParticlesRender', 'noParticlesTick', 'noSky', 'noClouds', 'noWeather', 'noChunkCompile'],
  players: ['noPlayerRender', 'noPlayerTick', 'noEntityRender', 'noNameplates', 'noShadows', 'noArmorLayers', 'noHeldItems', 'noCapes', 'noCustomSkins',
    'noEntityTrace'],
  quick: ['noTerrainRender', 'noEntityRender', 'noEntityTick', 'noAnimateTick', 'noPlayerRender'],
  overhead: ['probe'],
  // V0.504: each retained optimization against its pre-V0.504 path (B = old path), plus the opt-in late-frame
  // scheduler (B = late path on). Positive delta.frameMs = the optimization saves that much.
  v0504: ['schedLate', 'noAnimateTickOpt', 'noUploadOpt', 'noVertexOpt', 'noTraceOpt'],
  sched: ['schedLate', 'schedLate'],
  // V0.505: each retained known-bottleneck optimization against its pre-V0.505 path (B = old path).
  v0505: ['noModelMathOpt', 'noVertexWriteOpt', 'noHeightOpt', 'noTextVertexOpt'],
  // V0.506: each retained Lithium-derived optimization against its V0.505 path (B = old path).
  v0506: ['noWorldAccessOpt', 'noInterpolationOpt', 'noArmorStandPushOpt'],
  // V0.506 super-wave: each architecture family against the build without it (B = family off).
  v0506w: ['noLithiumWave', 'noSodiumWave', 'noImmediateWave', 'noMemoryWave', 'noEntityCullingWave', 'noLinearVertexWave'],
  // V0.507 S330 GPU/frame suite (live switches only; mediumPrecision and the default-framebuffer part of the tile wave
  // need their own page loads, see docs/V0_507_S330_GPU_FRAME_ARCHITECTURE.md). Render scale first: it decides
  // whether the S330 is fill/bandwidth bound.
  // V0.508 standing waves, each against the build without it (B = wave off); render scale stays a diagnostic.
  // fancyFoliageReorderTest (recompiles every section when flipped) and noWorkerMeshing (compile only) need page loads.
  v0508: ['noNativeGpuWave', 'noFullRetainedHud', 'renderScale50'],
  // V0.509 live families (B = family off): TeaVM hot paths, exact GPU (entity-outline skip), retained HUD phase 1+2.
  // noPackingWave only applies to section packs created after page load (use its own link).
  v0509: ['noTeaVmWave', 'noExactGpuWave', 'noFullRetainedHud', 'renderScale50'],
  v0509rc: ['noRcWave'],
  gpu: ['renderScale50', 'renderScale75', 'schedLate', 'noRetainedHud', 'noTileGpuWave', 'noClouds', 'noVignetteTest', 'noMenuBlurTest',
    'fastLeavesTest', 'noLinearTerrainWave'],
};
const abba = (() => {
  const spec = params.get('perf.abba');
  const windowS = Math.max(6, Math.min(120, Number(params.get('perf.abbaWindow')) || 15));
  const delayS = Math.max(0, Math.min(600, Number(params.get('perf.abbaDelay') ?? 45)));
  const discardS = Math.min(3, windowS / 3);
  // Suites expand to their ablations; an ablation named twice runs twice (repeat blocks for noisy cases).
  const list = !spec ? [] : spec.split(',').flatMap(x => SUITES[x] || [x])
    .filter(x => x === 'probe' || ABLATIONS.includes(x) || VARIANTS.includes(x)).slice(0, 32);
  const state = {spec: spec || null, list, windowS, delayS, status: list.length ? 'waiting-for-world' : 'off', index: 0, phase: -1,
    phaseStart: 0, worldSince: 0, results: [], windows: [], startedAt: null, finishedAt: null, uploaded: null,
    manual: params.get('perf.abbaStart') === 'manual', go: false};
  const PHASES = ['A1', 'B1', 'B2', 'A2'];
  const apply = (ablation, on) => (ablation === 'probe' ? control.setProbe(!on) : VARIANTS.includes(ablation) ? control.setVariant(ablation, on)
    : control.set(ablation, on, 'abba'));
  const inWorld = () => { const w = globalThis.__eaglerWatchdog; return !!(w && w.clientLevelPresent && (w.currentScreen === 'null' || w.currentScreen === 'none')); };
  function finishWindow() {
    const ablation = state.list[state.index], now = performance.now();
    const from = state.phaseStart + discardS * 1000;
    const stats = breakdown.windowStats(breakdown.range(from, now));
    stats.interrupted = !!state.interrupted;
    const r = state.current || (state.current = {ablation, windows: {}});
    r.windows[PHASES[state.phase]] = stats;
  }
  function finishAblation() {
    const r = state.current;
    state.current = null;
    const w = r.windows, avg = k => {
      const a = [w.A1?.[k], w.A2?.[k]].filter(Number.isFinite), b = [w.B1?.[k], w.B2?.[k]].filter(Number.isFinite);
      return [a.length ? a.reduce((x, y) => x + y) / a.length : null, b.length ? b.reduce((x, y) => x + y) / b.length : null];
    };
    const d = k => { const [a, b] = avg(k); return a === null || b === null ? null : Math.round((b - a) * 100) / 100; };
    const [aFrame] = avg('frameMs');
    const [aPlayers] = avg('renderedPlayers');
    r.delta = {fps: d('fps'), frameMs: d('frameMs'), p95Ms: d('p95Ms'), runTickMs: d('runTickMs'), tickMs: d('tickMs'), renderMs: d('renderMs'),
      sleepMs: d('sleepMs'), rafWaitMs: d('rafWaitMs'), guiRenderMs: d('guiRenderMs'), gpuMs: d('gpuMs'), draws: d('draws'), entityDraws: d('entityDraws'), allocMBPerSec: d('allocMBPerSec'),
      savedPct: aFrame && d('frameMs') !== null ? Math.round(-d('frameMs') / aFrame * 1000) / 10 : null};
    r.driftFrameMs = w.A1 && w.A2 && Number.isFinite(w.A1.frameMs) && Number.isFinite(w.A2.frameMs) ? Math.round((w.A2.frameMs - w.A1.frameMs) * 100) / 100 : null;
    if (aPlayers > 0 && /Player|Nameplates|Shadows|Armor|HeldItems|Capes|Skins/.test(r.ablation)) {
      r.perRenderedPlayer = {frameMs: r.delta.frameMs === null ? null : Math.round(-r.delta.frameMs / aPlayers * 100) / 100,
        draws: r.delta.draws === null ? null : Math.round(-r.delta.draws / aPlayers * 10) / 10,
        gpuMs: r.delta.gpuMs === null ? null : Math.round(-r.delta.gpuMs / aPlayers * 100) / 100, players: Math.round(aPlayers * 100) / 100};
    }
    r.interrupted = Object.values(w).some(x => x.interrupted);
    // Quality: the A1 -> A2 drift must be small next to the effect, else the block is not trustworthy.
    const effect = Math.abs(r.delta.frameMs ?? 0), drift = Math.abs(r.driftFrameMs ?? 0);
    const capped = Object.values(w).some(x => x.fpsThrottledPct > 0);
    r.quality = r.interrupted ? 'interrupted' : capped ? 'fpsCapped' : r.driftFrameMs === null ? 'incomplete'
      : drift <= Math.max(1, 0.5 * effect, 0.03 * (aFrame || 0)) ? 'ok' : 'drifting';
    state.results.push(r);
    try {
      globalThis.__eaglerDiagnostics?.record?.('performance', 'info', 'abba-result', {ablation: r.ablation, windowS, delta: r.delta,
        driftFrameMs: r.driftFrameMs, quality: r.quality, A1: [w.A1?.fps, w.A1?.frameMs, w.A1?.gpuMs], B1: [w.B1?.fps, w.B1?.frameMs, w.B1?.gpuMs],
        B2: [w.B2?.fps, w.B2?.frameMs, w.B2?.gpuMs], A2: [w.A2?.fps, w.A2?.frameMs, w.A2?.gpuMs], players: w.A1?.renderedPlayers ?? null,
        interrupted: r.interrupted});
    } catch { /* diagnostics are optional */ }
  }
  function step() {
    if (state.status === 'off' || state.status === 'done') return;
    const now = performance.now();
    if (state.status === 'waiting-for-world') {
      if (!inWorld()) { state.worldSince = 0; return; }
      if (!state.worldSince) state.worldSince = now;
      if (state.manual ? !state.go : now - state.worldSince < delayS * 1000) return;
      state.status = 'running'; state.startedAt = new Date().toISOString(); state.index = 0; state.phase = -1;
      control.setKeepActive(true);
    }
    if (!inWorld()) state.interrupted = true;
    if (state.phase >= 0 && now - state.phaseStart < windowS * 1000) return;
    if (state.phase >= 0) finishWindow();
    state.phase++;
    if (state.phase === 4) {
      finishAblation();
      state.phase = 0; state.index++;
    }
    if (state.index >= state.list.length) {
      apply(state.list[state.list.length - 1], false);
      control.setKeepActive(false);
      state.status = 'done'; state.finishedAt = new Date().toISOString();
      try { globalThis.__eaglerDiagnostics?.record?.('performance', 'info', 'abba-complete', {tests: state.results.length, spec: state.spec}); } catch { /* ignore */ }
      try { state.uploaded = globalThis.__eaglerDiagnostics?.uploadNow?.('abba-complete') ? 'requested' : 'unavailable'; } catch { state.uploaded = 'failed'; }
      return;
    }
    state.interrupted = false;
    apply(state.list[state.index], PHASES[state.phase][0] === 'B');
    state.phaseStart = now;
  }
  if (list.length) setInterval(() => { try { step(); } catch (e) { state.status = 'error'; state.error = String(e); } }, 250);
  return {
    state,
    /** Automation (?perf.abbaStart=manual): start once the harness has settled the world. */
    start() { state.go = true; },
    report() {
      return {status: state.status, spec: state.spec, windowS, delayS, discardS, tests: state.list.length, completed: state.results.length,
        startedAt: state.startedAt, finishedAt: state.finishedAt, error: state.error || null,
        results: state.results.map(r => ({ablation: r.ablation, quality: r.quality, delta: r.delta, driftFrameMs: r.driftFrameMs, perRenderedPlayer: r.perRenderedPlayer || null,
          interrupted: r.interrupted, A1: r.windows.A1, B1: r.windows.B1, B2: r.windows.B2, A2: r.windows.A2}))};
    },
    progress() {
      if (state.status !== 'running') return null;
      const phase = PHASES[state.phase] || '';
      return {ablation: state.list[state.index], phase, test: state.index + 1, tests: state.list.length,
        seconds: Math.min(windowS, Math.floor((performance.now() - state.phaseStart) / 1000)), windowS};
    },
  };
})();
perf.abba = abba;

// ---- V0.503 on-screen notice while diagnostics modes are active (no DevTools needed) --------------------------------
(() => {
  if (typeof document === 'undefined' || params.get('perf.overlay') === '0') return;
  const wanted = () => params.get('perf.overlay') === '1' || control.active().length || !control.probe || abba.state.status !== 'off' || gpuSegments;
  let el = null;
  const render = () => {
    if (!wanted()) { if (el) el.style.display = 'none'; return; }
    if (!el) {
      el = document.createElement('div');
      el.id = 'eagler-perf-overlay';
      el.style.cssText = 'position:fixed;top:6px;right:6px;z-index:9999;pointer-events:none;max-width:46vw;padding:6px 9px;border-radius:6px;'
        + 'background:rgba(120,0,0,.78);color:#fff;font:12px/1.35 monospace;white-space:pre-wrap;text-shadow:0 1px 1px #000';
      (document.body || document.documentElement).appendChild(el);
    }
    el.style.display = '';
    const last = breakdown.bins.length ? breakdown.summarize(breakdown.bins.slice(-3)) : null;
    const lines = [`Eagler26 ${globalThis.__eaglerBuildVersion || ''} PERFORMANCE DIAGNOSTIC MODE`];
    const active = control.active();
    if (active.length) lines.push(`Ablation ON: ${active.join(', ')}`);
    if (!control.probe) lines.push('Frame probe OFF');
    if (gpuSegments) lines.push(`GPU timing: ${gpuInfo().mode}${seg.error ? ` (${seg.error})` : ''}`);
    const s = abba.state, p = abba.progress();
    if (s.status === 'waiting-for-world') lines.push(`ABBA test (${s.list.length} parts): join the world, stand still, close menus. Starts ${s.delayS} s after that.`);
    else if (p) lines.push(`ABBA ${p.test}/${p.tests} ${p.ablation}: ${p.phase} (${p.phase[0] === 'B' ? 'OFF-switch active' : 'normal'}) ${p.seconds}/${p.windowS} s`, 'Stand still. Do not open menus.');
    else if (s.status === 'done') {
      const n = globalThis.__eaglerDiagnostics?.getReportNumber?.();
      lines.push(`ABBA done (${s.results.length} tests). Results ${s.uploaded === 'requested' ? 'uploaded' : 'saved'}${n ? `: report #${n}` : ''}.`);
    } else if (s.status === 'error') lines.push(`ABBA error: ${s.error}`);
    if (last) lines.push(`FPS ${last.fps ?? '?'} | frame ${last.frame.totalMs ?? '?'} ms | players ${last.counts.visiblePlayers ?? '?'} | entities ${last.counts.visibleEntities ?? '?'}`);
    el.textContent = lines.join('\n');
  };
  setInterval(() => { try { render(); } catch { /* never break the page */ } }, 500);
})();

// GPU memory accounting + optional call counting on the WebGL2 context the client creates.
const bytesPerTexel = f => ({0x8058: 4, 0x881A: 8, 0x8814: 16, 0x81A6: 4, 0x88F0: 4, 0x8CAC: 4, 0x8229: 1, 0x8231: 1, 0x822B: 2, 0x8C43: 4})[f] || 4;
function instrument(gl) {
  if (gl.__eaglerPerf) return gl;
  gl.__eaglerPerf = true;
  perf.gl = gl;
  const bufferData = gl.bufferData, deleteBuffer = gl.deleteBuffer, texStorage2D = gl.texStorage2D, texImage2D = gl.texImage2D, deleteTexture = gl.deleteTexture;
  const bound = target => gl.getParameter(target === gl.ELEMENT_ARRAY_BUFFER ? gl.ELEMENT_ARRAY_BUFFER_BINDING : target === gl.UNIFORM_BUFFER
    ? gl.UNIFORM_BUFFER_BINDING : target === gl.COPY_WRITE_BUFFER ? gl.COPY_WRITE_BUFFER_BINDING : target === gl.COPY_READ_BUFFER ? gl.COPY_READ_BUFFER_BINDING : gl.ARRAY_BUFFER_BINDING);
  gl.bufferData = function (target, data) {
    bufferData.apply(this, arguments);
    const b = bound(target);
    if (b) { const size = typeof data === 'number' ? data : data.byteLength; perf.gpuBufferBytes += size - (b.__eaglerBytes || 0); if (b.__eaglerBytes === undefined) perf.gpuBuffers++; b.__eaglerBytes = size; }
  };
  gl.deleteBuffer = function (b) { if (b && b.__eaglerBytes !== undefined) { perf.gpuBufferBytes -= b.__eaglerBytes; perf.gpuBuffers--; b.__eaglerBytes = undefined; } return deleteBuffer.call(this, b); };
  const texTarget = target => gl.getParameter(target === gl.TEXTURE_CUBE_MAP ? gl.TEXTURE_BINDING_CUBE_MAP : gl.TEXTURE_BINDING_2D);
  gl.texStorage2D = function (target, levels, format, w, h) {
    texStorage2D.apply(this, arguments);
    const t = texTarget(target);
    if (t) { const size = Math.round(w * h * bytesPerTexel(format) * (levels > 1 ? 4 / 3 : 1) * (target === gl.TEXTURE_CUBE_MAP ? 6 : 1)); perf.textureBytes += size - (t.__eaglerBytes || 0); if (t.__eaglerBytes === undefined) perf.textures++; t.__eaglerBytes = size; }
  };
  gl.texImage2D = function (target, level, format, w, h) {
    texImage2D.apply(this, arguments);
    if (level === 0 && typeof w === 'number' && arguments.length >= 9) {
      const t = texTarget(target);
      if (t && !t.__eaglerImmutable) { const size = w * h * bytesPerTexel(format); perf.textureBytes += size - (t.__eaglerBytes || 0); if (t.__eaglerBytes === undefined) perf.textures++; t.__eaglerBytes = size; }
    }
  };
  gl.deleteTexture = function (t) { if (t && t.__eaglerBytes !== undefined) { perf.textureBytes -= t.__eaglerBytes; perf.textures--; t.__eaglerBytes = undefined; } return deleteTexture.call(this, t); };
  if (countGl) {
    const proto = Object.getPrototypeOf(gl);
    for (const name of Object.getOwnPropertyNames(proto)) {
      let fn;
      try { fn = gl[name]; } catch { continue; }
      if (typeof fn !== 'function' || name === 'constructor') continue;
      gl[name] = function () { perf.frameGl++; perf.glCallsByName[name] = (perf.glCallsByName[name] || 0) + 1; return fn.apply(this, arguments); };
    }
  }
  return gl;
}
const getContext = HTMLCanvasElement.prototype.getContext;
// V0.507 tile-GPU wave (bootstrap part): the game only blits its final image into the canvas' default framebuffer,
// so that framebuffer carries no depth/stencil (?perf.noTileGpuWave=1 keeps the browser default depth buffer).
// ?perf.desync=1 (scheduler diagnostic) asks for a low-latency desynchronized canvas.
const tileWaveBoot = params.get('perf.noTileGpuWave') !== '1', desyncCanvas = params.get('perf.desync') === '1';
HTMLCanvasElement.prototype.getContext = function (kind, attrs) {
  if (kind === 'webgl2' && this.id === 'game-canvas' && !this.__eaglerCtx) {
    attrs = Object.assign({}, attrs);
    if (tileWaveBoot) { attrs.depth = false; attrs.stencil = false; }
    if (desyncCanvas) attrs.desynchronized = true;
  }
  const ctx = getContext.call(this, kind, attrs);
  if (kind === 'webgl2' && ctx && this.id === 'game-canvas' && !this.__eaglerCtx) {
    this.__eaglerCtx = true;
    try { const a = ctx.getContextAttributes() || {}; perf.contextAttributes = {depth: !!a.depth, stencil: !!a.stencil, antialias: !!a.antialias, desynchronized: !!a.desynchronized, requested: attrs}; } catch {}
  }
  if (kind === 'webgl2' && ctx) try { globalThis.__eaglerDiagnostics?.attachGl?.(ctx, this); } catch {}
  // Counting (innermost) sees only the calls the state cache lets through to WebGL.
  return kind === 'webgl2' && ctx ? installGlStateCache(instrument(ctx)) : ctx;
};

// TeaVM load option: wraps every function import with a counter when ?perfInterop=1.
export function installImports(importObj) {
  // V0.502: JsScratch hands packed draw data over through Wasm linear memory; keep a cached Int32Array view of it
  // (rebuilt when the memory grows and its buffer changes).
  const linear = importObj.teavmMemory && importObj.teavmMemory.linearMemory;
  if (linear) {
    let view = null;
    globalThis.__eaglerScratch = (address, n) => {
      const buffer = linear();
      if (!view || view.buffer !== buffer) view = new Int32Array(buffer);
      return view.subarray(address >> 2, (address >> 2) + n);
    };
    // V0.504 JsBytes.transientView: byte view of the reused upload block (consumed synchronously by bufferSubData).
    let bytes = null;
    globalThis.__eaglerScratchBytes = (address, n) => {
      const buffer = linear();
      if (!bytes || bytes.buffer !== buffer) bytes = new Uint8Array(buffer);
      return bytes.subarray(address, address + n);
    };
    // V0.509 packing diagnostics: current size of Wasm linear memory (TeaVM runtime heap for linear builders/arenas).
    globalThis.__eaglerLinearBytes = () => linear().byteLength;
  }
  if (!countInterop) return;
  // V0.509: TypedArray creation counting (profiling mode only; the proxies themselves cost).
  for (const name of ['Uint8Array', 'Int8Array', 'Uint16Array', 'Int16Array', 'Uint32Array', 'Int32Array', 'Float32Array', 'Float64Array']) {
    const Ctor = globalThis[name];
    if (typeof Ctor !== 'function') continue;
    const note = (kind, bytes) => { perf.frameTypedArrays++; perf.frameTypedArrayBytes += bytes; perf.typedArraysByKind[kind] = (perf.typedArraysByKind[kind] || 0) + 1; };
    globalThis[name] = new Proxy(Ctor, {construct(target, args, nt) {
      const a = Reflect.construct(target, args, nt);
      const src = args[0];
      note(`${name}(${src instanceof ArrayBuffer ? 'buffer' : typeof src === 'number' ? 'length' : 'copy'})`,
        src instanceof ArrayBuffer || typeof src === 'number' ? 0 : a.byteLength);
      return a;
    }});
    const proto = Ctor.prototype, sub = proto.subarray, slice = proto.slice;
    proto.subarray = function () { note(`${name}.subarray`, 0); return sub.apply(this, arguments); };
    proto.slice = function () { const r = slice.apply(this, arguments); note(`${name}.slice`, r.byteLength); return r; };
  }
  for (const module of Object.keys(importObj)) {
    const table = importObj[module];
    if (!table || typeof table !== 'object') continue;
    for (const name of Object.keys(table)) {
      const fn = table[name];
      if (typeof fn !== 'function') continue;
      const key = module + '.' + name;
      // V0.509: every 32nd call also records its innermost Java caller (first TeaVM frame, "Class::method", in the
      // JS stack): TeaVM's generic JSO imports (callFunctionN, wrapInt, ...) do not name the @JSBody behind them.
      table[name] = function () {
        perf.frameInterop++; perf.interopByName[key] = (perf.interopByName[key] || 0) + 1;
        if ((++perf.interopTick & 31) === 0) {
          const st = new Error().stack || '';
          const m = /at ([^\s(]+::[^\s(]+)/.exec(st);
          const caller = m ? m[1].replace(/^.*\.([^.]+::)/, '$1') : '(js)';
          perf.interopCallers[caller] = (perf.interopCallers[caller] || 0) + 32;
        }
        return fn.apply(this, arguments);
      };
    }
  }
}
