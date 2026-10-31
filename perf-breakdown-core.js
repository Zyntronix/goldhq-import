// V0.503 frame-attribution aggregator (S330 bottleneck isolation).
//
// Pure module (no DOM, no WebGL): browser-perf.js feeds it one record per frame (Java PerfProbe categories and
// counts, JS frame-timing regions, the yield breakdown) and GPU timer results when they arrive; it keeps bounded
// one-second bins (15 minutes) and turns any time range of bins into the `performance.breakdown` schema of the
// diagnostics bundle, the compact per-5-s sample block, correlations and ABBA window statistics. The Node tests
// (scripts/diagnostics/test-breakdown.mjs) drive it with synthetic frames.
//
// Every value is a per-frame average in ms (or a count per frame) unless its name says otherwise. Categories are
// inclusive; "other" fields are parent minus measured children. Nothing here sees packet contents, chat, skins
// or credentials: only timings and counts.

export const BREAKDOWN_VERSION = 1;
export const BIN_MS = 1000;
export const MAX_BINS = 900;

// Frame-level slots measured in JS (before the Java categories).
const FRAME_SLOTS = ['interval', 'pump', 'runTick', 'background', 'sleep', 'yieldDelay', 'rafWait', 'rafLate', 'resume', 'unexplained', 'jsSelf', 'sections', 'glCalls', 'multiDraws',
  'heapGrowth', 'heapDrops', 'heapReclaimed', 'heapSamples', 'heapBytes', 'fenceFrames', 'gpuBusyStart', 'gpuBusyEnd', 'lateSched',
  // V0.507 tile-GPU counters (per frame): render passes opened, draw-framebuffer changes, returns to a framebuffer
  // already drawn this frame (tile store + reload on a tile GPU), other framebuffer binds (clears/blits/present),
  // invalidated attachments, and the world render scale in effect.
  'passes', 'passSwitches', 'fbReentries', 'fbBinds', 'invalidates', 'renderScale', 'hudHits', 'hudMisses'];
const F = Object.fromEntries(FRAME_SLOTS.map((k, i) => [k, i]));

const round = (v, d = 2) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);

export function createBreakdown(options = {}) {
  const maxBins = options.maxBins || MAX_BINS;
  let schema = null;          // {names, parents, counts, gpu, index}
  let layout = null;          // offsets into a bin's sums
  const bins = [];            // oldest first
  let bin = null;
  let lastState = '';
  let totalFrames = 0;
  let lastStartedAt = null;
  let lastHeap = null;

  function setSchema(names, parents, counts, gpu) {
    const index = Object.fromEntries(names.map((n, i) => [n, i]));
    schema = {names, parents, counts, gpu, index, countIndex: Object.fromEntries(counts.map((n, i) => [n, i]))};
    const K = names.length, C = counts.length, G = gpu.length;
    layout = {K, C, G, cat: FRAME_SLOTS.length, draws: FRAME_SLOTS.length + K, hits: FRAME_SLOTS.length + 2 * K,
      count: FRAME_SLOTS.length + 3 * K, gpu: FRAME_SLOTS.length + 3 * K + C, size: FRAME_SLOTS.length + 3 * K + C + G};
    bins.length = 0;
    bin = null;
  }

  function newBin(t, state) {
    const size = layout ? layout.size : FRAME_SLOTS.length;
    bin = {t, end: t, state, frames: 0, probeFrames: 0, gpuFrames: 0, gpuDisjoint: 0, sums: new Float64Array(size), iv: [], maxIv: 0};
    bins.push(bin);
    if (bins.length > maxBins) bins.shift();
    return bin;
  }

  /**
   * One completed frame. `frame` = {startedAt, pumpMs, runTickMs, backgroundMs, sleepMs, yieldDelayMs, rafWaitMs,
   * rafLateMs, resumeMs, jsSelfMs}; `java` = the Int32Array PerfProbe published for it (or null when the probe is
   * off); `state` = a string naming the ablation / ABBA state (a change starts a new bin).
   */
  function addFrame(frame, java, state = '') {
    const t = frame.startedAt;
    // The frame's own duration (start of its loop iteration -> resumed after its yield). Pairing a frame's work with
    // the start-to-start interval of the previous frame would misattribute single long frames.
    const interval = Number.isFinite(frame.completedAt) ? frame.completedAt - t : lastStartedAt === null ? null : t - lastStartedAt;
    lastStartedAt = t;
    // Skip the first frame and frames whose yield was a suspension (hidden tab / sleeping device), not slow frames.
    if (interval === null || !(interval > 0) || (frame.sleepMs || 0) > 2000) return;
    if (!bin || state !== lastState || t - bin.t >= BIN_MS) newBin(t, state);
    lastState = state;
    const s = bin.sums;
    const measured = (frame.pumpMs || 0) + (frame.runTickMs || 0) + (frame.backgroundMs || 0) + (frame.sleepMs || 0);
    s[F.interval] += interval;
    s[F.pump] += frame.pumpMs || 0;
    s[F.runTick] += frame.runTickMs || 0;
    s[F.background] += frame.backgroundMs || 0;
    s[F.sleep] += frame.sleepMs || 0;
    s[F.yieldDelay] += frame.yieldDelayMs || 0;
    s[F.rafWait] += frame.rafWaitMs || 0;
    s[F.rafLate] += frame.rafLateMs || 0;
    s[F.resume] += frame.resumeMs || 0;
    s[F.unexplained] += Math.max(0, interval - measured);
    s[F.jsSelf] += frame.jsSelfMs || 0;
    s[F.sections] += frame.visibleSections || 0;
    s[F.glCalls] += frame.glCalls || 0;
    s[F.multiDraws] += frame.multiDraws || 0;
    if (frame.lateSched) s[F.lateSched]++;
    s[F.passes] += frame.passes || 0;
    s[F.passSwitches] += frame.passSwitches || 0;
    s[F.fbReentries] += frame.fbReentries || 0;
    s[F.fbBinds] += frame.fbBinds || 0;
    s[F.invalidates] += frame.invalidates || 0;
    s[F.renderScale] += frame.renderScale || 1;
    s[F.hudHits] += frame.hudHits || 0;
    s[F.hudMisses] += frame.hudMisses || 0;
    // Allocation / GC estimate from performance.memory.usedJSHeapSize (Wasm-GC objects live in the same V8 heap):
    // growth between samples approximates allocation (a lower bound: intervals containing a GC net out), a drop
    // is a garbage collection. The value updates every ~50 ms in Chrome, so this is per window, not per frame.
    if (frame.fenceProbe) {
      s[F.fenceFrames]++;
      s[F.gpuBusyStart] += frame.gpuBusyAtStart ? 1 : 0;
      s[F.gpuBusyEnd] += frame.gpuBusyAtEnd ? 1 : 0;
    }
    const h = frame.heapBytes;
    if (Number.isFinite(h) && h > 0) {
      if (lastHeap !== null) {
        const dh = h - lastHeap;
        if (dh > 0) s[F.heapGrowth] += dh;
        else if (dh < 0) { s[F.heapDrops]++; s[F.heapReclaimed] -= dh; }
      }
      lastHeap = h;
      s[F.heapSamples]++;
      s[F.heapBytes] += h;
    }
    bin.iv.push(interval);
    if (interval > bin.maxIv) bin.maxIv = interval;
    bin.frames++;
    bin.end = t;
    totalFrames++;
    if (java && layout && java[2] === layout.K && java[3] === layout.C) {
      const K = layout.K, C = layout.C, H = 4;
      for (let i = 0; i < K; i++) {
        s[layout.cat + i] += java[H + i] / 1000;
        s[layout.draws + i] += java[H + K + i];
        s[layout.hits + i] += java[H + 2 * K + i];
      }
      for (let i = 0; i < C; i++) s[layout.count + i] += java[H + 3 * K + i];
      bin.probeFrames++;
    }
  }

  /** GPU segment results for one frame (ms per GPU group), or {disjoint:true}. Attributed to the current bin. */
  function addGpu(msPerGroup) {
    if (!bin || !layout) return;
    if (msPerGroup === 'disjoint') { bin.gpuDisjoint++; return; }
    for (let i = 0; i < layout.G && i < msPerGroup.length; i++) bin.sums[layout.gpu + i] += msPerGroup[i];
    bin.gpuFrames++;
  }

  const range = (from = -Infinity, to = Infinity, filter = null) => bins.filter(b => b.t >= from && b.t < to && (!filter || filter(b)));

  // Sums a list of bins into one aggregate.
  function merge(list) {
    const size = layout ? layout.size : FRAME_SLOTS.length;
    const agg = {frames: 0, probeFrames: 0, gpuFrames: 0, gpuDisjoint: 0, sums: new Float64Array(size), iv: [], seconds: 0, states: new Set()};
    for (const b of list) {
      agg.frames += b.frames;
      agg.probeFrames += b.probeFrames;
      agg.gpuFrames += b.gpuFrames;
      agg.gpuDisjoint += b.gpuDisjoint;
      for (let i = 0; i < size && i < b.sums.length; i++) agg.sums[i] += b.sums[i];
      for (const v of b.iv) agg.iv.push(v);
      agg.states.add(b.state);
    }
    agg.seconds = agg.sums[F.interval] / 1000;
    return agg;
  }

  function accessors(agg) {
    const pf = agg.frames || 1, jf = agg.probeFrames || 0, gf = agg.gpuFrames || 0;
    const frameAvg = k => agg.frames ? agg.sums[F[k]] / pf : null;
    const cat = name => {
      if (!layout || !jf) return null;
      const i = schema.index[name];
      return i === undefined ? null : agg.sums[layout.cat + i] / jf;
    };
    const draws = name => (!layout || !jf || schema.index[name] === undefined ? null : agg.sums[layout.draws + schema.index[name]] / jf);
    const hits = name => (!layout || !jf || schema.index[name] === undefined ? null : agg.sums[layout.hits + schema.index[name]] / jf);
    const count = name => (!layout || !jf || schema.countIndex[name] === undefined ? null : agg.sums[layout.count + schema.countIndex[name]] / jf);
    const gpu = name => {
      if (!layout || !gf) return null;
      const i = schema.gpu.indexOf(name);
      return i < 0 ? null : agg.sums[layout.gpu + i] / gf;
    };
    return {frameAvg, cat, draws, hits, count, gpu};
  }

  function percentile(values, p) {
    if (!values.length) return null;
    const a = values.slice().sort((x, y) => x - y);
    return a[Math.min(a.length - 1, Math.floor(a.length * p))];
  }

  const sum = (...v) => (v.some(x => x === null) ? null : v.reduce((a, b) => a + b, 0));
  const diff = (a, ...b) => (a === null || b.some(x => x === null) ? null : Math.max(0, a - b.reduce((x, y) => x + y, 0)));

  /** The `performance.breakdown` schema for a set of bins. */
  function summarize(list, extra = {}) {
    const agg = merge(list);
    const {frameAvg, cat, draws, count, gpu, hits} = accessors(agg);
    const fps = agg.seconds > 0 ? (agg.frames / agg.seconds) : null;
    const frame = {
      totalMs: round(frameAvg('interval')), p50Ms: round(percentile(agg.iv, 0.5)), p95Ms: round(percentile(agg.iv, 0.95)),
      maxMs: round(agg.iv.length ? Math.max(...agg.iv) : null),
      pumpMs: round(frameAvg('pump')), runTickMs: round(frameAvg('runTick')), tickMs: round(cat('tickAll')), renderMs: round(cat('render')),
      inputMs: round(cat('input')), packetsMs: round(cat('packets')), soundMouseMs: round(cat('soundMouse')), postRenderMs: round(cat('postRender')),
      runTickOtherMs: round(diff(cat('runTick'), cat('input'), cat('packets'), cat('tickAll'), cat('soundMouse'), cat('render'), cat('postRender'))),
      compileSlackMs: round(frameAvg('background')), sleepMs: round(frameAvg('sleep')), yieldRequestedMs: round(frameAvg('yieldDelay')),
      rafWaitMs: round(frameAvg('rafWait')), rafLateMs: round(frameAvg('rafLate')), resumeMs: round(frameAvg('resume')),
      presentationWaitMs: round(diff(frameAvg('sleep'), frameAvg('yieldDelay'))),
      unexplainedMs: round(frameAvg('unexplained')), clientTicksPerFrame: round(count('clientTicks'), 3),
      // V0.504: share of frames that overran the refresh interval and continued without waiting for rAF.
      lateSchedPct: agg.frames ? round(100 * agg.sums[F.lateSched] / agg.frames, 1) : null,
      // Vanilla inactivity limiter (FramerateLimitTracker): cap in effect and share of frames it throttled.
      fpsLimit: round(count('fpsLimit'), 0), fpsThrottledPct: count('fpsThrottled') === null ? null : round(100 * count('fpsThrottled'), 1),
      longAfkPct: count('longAfk') === null ? null : round(100 * count('longAfk'), 1),
    };
    const heapN = agg.sums[F.heapSamples];
    const memory = heapN ? {
      allocMBPerSec: round(agg.sums[F.heapGrowth] / 1048576 / (agg.seconds || 1), 1), allocKBPerFrame: round(agg.sums[F.heapGrowth] / 1024 / (agg.frames || 1), 0),
      gcPerSec: round(agg.sums[F.heapDrops] / (agg.seconds || 1), 2), reclaimedMBPerSec: round(agg.sums[F.heapReclaimed] / 1048576 / (agg.seconds || 1), 1),
      heapAvgMiB: round(agg.sums[F.heapBytes] / heapN / 1048576, 0),
      note: 'from performance.memory.usedJSHeapSize (JS + Wasm-GC heap); alloc is a lower bound, gc = heap drops',
    } : null;
    const entities = cat('t.entities'), local = cat('t.playerLocal'), remote = cat('t.playerRemote');
    const tick = {
      networkMs: round(cat('t.gameMode')), levelMs: round(cat('t.level')), entityMs: round(entities), playerMs: round(remote),
      localPlayerMs: round(local), otherEntitiesMs: round(diff(entities, local, remote)), blockEntityMs: round(cat('t.blockEntities')),
      animateTickMs: round(cat('t.animateTick')), particlesMs: round(cat('t.particles')), weatherMs: round(cat('t.weather')),
      chunksMs: round(cat('t.chunks')), soundMs: round(cat('t.sound')), texturesMs: round(cat('textures')), guiMs: round(cat('t.gui')),
      rendererMaintenanceMs: round(cat('t.gameRenderer')), biomeMs: null,
      otherMs: round(diff(cat('clientTick'), cat('t.gameMode'), cat('t.gui'), cat('t.gameRenderer'), entities, cat('t.blockEntities'),
        cat('t.sound'), cat('t.level'), cat('t.animateTick'), cat('t.particles'))),
      tickTotalMs: round(cat('clientTick')),
    };
    const xEnt = cat('x.entities'), xPl = cat('x.player'), sEnt = cat('s.entities'), sPl = cat('s.player');
    const fModel = cat('f.model'), fName = cat('f.nameTag'), fShadow = cat('f.shadow'), fItem = cat('f.item'), fOther = cat('f.other');
    const render = {
      terrainPrepMs: round(cat('terrainPrep')), terrainSubmitMs: round(sum(cat('terrainSolid'), cat('terrainTranslucent'))),
      terrainSolidMs: round(cat('terrainSolid')), translucentMs: round(cat('terrainTranslucent')),
      entityMs: round(sum(xEnt, sEnt, fModel, fName, fShadow, fItem, fOther)),
      playerMs: round(sum(xPl, sPl)), mobMs: round(sum(diff(xEnt, xPl), diff(sEnt, sPl))),
      blockEntityMs: round(sum(cat('x.blockEntities'), cat('s.blockEntities'))),
      particleMs: round(sum(cat('x.particles'), cat('s.particles'), cat('f.particle'))),
      skyMs: round(cat('e.sky')), cloudMs: round(cat('e.clouds')), weatherMs: round(cat('e.weather')),
      // guiMs = GUI extract (inside extractMs) + GUI render: it overlaps extractMs. V0.504 adds the two parts and the
      // level share of extraction so the overlap can be removed (guiRenderMs + extractMs has no double counting).
      guiMs: round(sum(cat('r.gui'), cat('x.gui'))), guiExtractMs: round(cat('x.gui')), guiRenderMs: round(cat('r.gui')),
      extractLevelMs: round(cat('x.level')), handMs: round(cat('r.hand')), nameplateMs: round(fName), shadowMs: round(fShadow),
      updateMs: round(cat('r.update')), lightMs: round(cat('r.light')), extractMs: round(cat('r.extract')),
      extractEntitiesMs: round(xEnt), extractPlayersMs: round(xPl), extractSectionsMs: round(cat('x.sections')),
      submitMs: round(cat('submit')), submitEntitiesMs: round(sEnt), submitPlayersMs: round(sPl),
      prepareFeaturesMs: round(cat('prepare')), executeMs: round(cat('execute')), setupMs: round(cat('r.setup')),
      compileMs: round(cat('compile')), uploadMs: round(cat('upload')), occlusionMs: round(cat('occlusion')), presentMs: round(cat('r.present')),
      otherMs: round(diff(cat('render'), cat('r.update'), cat('r.extract'), cat('r.world'), cat('r.gui'), cat('r.present'))),
    };
    const features = {modelMs: round(fModel), nameTagMs: round(fName), textMs: round(cat('f.text')), shadowMs: round(fShadow),
      itemMs: round(fItem), particleMs: round(cat('f.particle')), blockMs: round(cat('f.block')), otherMs: round(fOther)};
    const featureDraws = sum(draws('f.model'), draws('f.nameTag'), draws('f.text'), draws('f.shadow'), draws('f.item'), draws('f.other'));
    const counts = {
      loadedEntities: round(count('entitiesLoaded'), 1), tickedEntities: round(count('entitiesTicked'), 1),
      visibleEntities: round(count('entitiesVisible'), 1), renderedEntities: round(count('entitiesRendered'), 1),
      loadedPlayers: round(count('playersLoaded'), 1), tickedPlayers: round(count('playersTicked'), 1),
      visiblePlayers: round(count('playersVisible'), 2), renderedPlayers: round(count('playersRendered'), 2),
      blockEntities: round(count('blockEntitiesRendered'), 1), particles: round(count('particles'), 0),
      visibleSections: round(frameAvg('sections'), 1), terrainGlMultiDraws: round(frameAvg('multiDraws'), 1), terrainDraws: round(sum(draws('terrainSolid'), draws('terrainTranslucent')), 1),
      entityDraws: round(featureDraws, 1), totalDraws: round(count('draws'), 1),
      glCalls: extra.glCounting ? round(frameAvg('glCalls'), 0) : null,
      renderPasses: round(frameAvg('passes'), 1), renderPassSwitches: round(frameAvg('passSwitches'), 1),
      framebufferReentries: round(frameAvg('fbReentries'), 1), framebufferBinds: round(frameAvg('fbBinds'), 1),
      invalidatedAttachments: round(frameAvg('invalidates'), 1), renderScale: round(frameAvg('renderScale'), 3),
      hudCacheHits: round(frameAvg('hudHits'), 1), hudCacheMisses: round(frameAvg('hudMisses'), 1),
    };
    const gpuTotal = layout && agg.gpuFrames ? schema.gpu.reduce((a, name) => a + (gpu(name) || 0), 0) : null;
    const gpuOut = {
      supported: extra.gpuSupported ?? null, mode: extra.gpuMode ?? 'off', frames: agg.gpuFrames, disjoint: agg.gpuDisjoint,
      totalMs: round(gpuTotal), terrainMs: round(gpu('terrain')), entityMs: round(gpu('entityFeatures')), labelMs: round(gpu('labelFeatures')),
      particleMs: round(gpu('particles')), blockMs: round(gpu('blockFeatures')), skyMs: round(gpu('sky')), cloudsMs: round(gpu('clouds')),
      weatherMs: round(gpu('weather')), handMs: round(gpu('hand')), guiMs: round(gpu('gui')), texturesMs: round(gpu('textures')),
      presentMs: round(gpu('present')), otherMs: round(gpu('other')), playerMs: null, blockEntityMs: null, frameTotalMs: extra.gpuFrameMs ?? null,
      // Fence probe: % of frames where the previous frame's GPU work was still running after the next frame's CPU work
      // (busyAtEndPct high = GPU-bound) or when the next frame started after the yield (busyAtStartPct).
      busyAtStartPct: agg.sums[F.fenceFrames] ? round(100 * agg.sums[F.gpuBusyStart] / agg.sums[F.fenceFrames], 1) : null,
      busyAtEndPct: agg.sums[F.fenceFrames] ? round(100 * agg.sums[F.gpuBusyEnd] / agg.sums[F.fenceFrames], 1) : null,
      spanNote: 'timer values are GPU timeline spans: they include GPU idle time while the CPU is still submitting, so on a CPU-bound frame they approach the CPU time; use busyAtEndPct and ablation deltas for GPU-boundness',
      note: extra.gpuNote ?? null,
    };
    const self = {
      timerCallsPerFrame: round(count('timerCalls'), 1), zonesPerFrame: round(count('zones'), 1), gpuMarksPerFrame: round(count('gpuMarks'), 1),
      jsMsPerFrame: round(frameAvg('jsSelf'), 3), probeFrames: agg.probeFrames,
      estimatedMsPerFrame: extra.nowCallUs != null && count('timerCalls') !== null ? round(count('timerCalls') * extra.nowCallUs / 1000 + (frameAvg('jsSelf') || 0), 3) : null,
    };
    return {
      version: BREAKDOWN_VERSION, windowSeconds: round(agg.seconds, 1), frames: agg.frames, fps: round(fps), probe: agg.probeFrames > 0,
      states: [...agg.states].filter(Boolean).slice(0, 8),
      frame, tick, render, features, gpu: gpuOut, counts, memory, self,
      hitsPerFrame: {clientTicks: round(hits('clientTick'), 2), playerTicks: round(hits('t.playerRemote'), 2), playerExtracts: round(hits('x.player'), 2)},
    };
  }

  /** Compact per-sample block (5-s diagnostics samples): the numbers most needed later, within sanitizer limits. */
  function compact(list) {
    const b = summarize(list);
    const pick = (o, keys) => Object.fromEntries(keys.map(k => [k, o[k]]));
    return {
      st: b.states.join('|') || null, fr: pick(b.frame, ['totalMs', 'p95Ms', 'runTickMs', 'tickMs', 'renderMs', 'compileSlackMs', 'sleepMs', 'rafWaitMs', 'unexplainedMs',
        'fpsLimit', 'fpsThrottledPct', 'lateSchedPct']),
      tk: pick(b.tick, ['networkMs', 'levelMs', 'entityMs', 'playerMs', 'blockEntityMs', 'animateTickMs', 'particlesMs', 'soundMs', 'texturesMs', 'otherMs']),
      rd: pick(b.render, ['terrainPrepMs', 'terrainSubmitMs', 'entityMs', 'playerMs', 'mobMs', 'blockEntityMs', 'particleMs', 'skyMs', 'cloudMs', 'weatherMs',
        'guiMs', 'guiExtractMs', 'guiRenderMs', 'extractLevelMs', 'handMs', 'nameplateMs', 'shadowMs', 'lightMs', 'extractMs', 'prepareFeaturesMs', 'compileMs', 'otherMs']),
      gp: b.gpu.frames ? pick(b.gpu, ['totalMs', 'terrainMs', 'entityMs', 'labelMs', 'particleMs', 'guiMs', 'otherMs', 'busyAtEndPct']) : {busyAtEndPct: b.gpu.busyAtEndPct},
      n: pick(b.counts, ['loadedEntities', 'visibleEntities', 'visiblePlayers', 'renderedPlayers', 'blockEntities', 'particles', 'terrainDraws', 'entityDraws', 'totalDraws']),
      mem: b.memory ? pick(b.memory, ['allocMBPerSec', 'gcPerSec']) : null,
      self: b.self.timerCallsPerFrame,
    };
  }

  // ---- correlations -----------------------------------------------------------------------------------------------
  function linear(xs, ys) {
    const n = xs.length;
    if (n < 5) return {n, r: null, slope: null, intercept: null};
    let mx = 0, my = 0;
    for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
    mx /= n; my /= n;
    let sxx = 0, syy = 0, sxy = 0;
    for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
    if (sxx === 0) return {n, r: null, slope: null, intercept: round(my), note: 'x constant'};
    const slope = sxy / sxx;
    return {n, r: syy > 0 ? round(sxy / Math.sqrt(sxx * syy), 3) : null, slope: round(slope, 3), intercept: round(my - slope * mx)};
  }

  /** Per-second correlations over unablated bins (the first 2 s after any state change are skipped). */
  function correlations(list) {
    const usable = [];
    let prevState = null, since = 0;
    for (const b of list) {
      if (b.state !== prevState) { prevState = b.state; since = b.t; }
      if (b.state === '' && b.t - since >= 2000 && b.frames >= 2 && b.probeFrames) usable.push(b);
    }
    const rows = usable.map(b => {
      const agg = merge([b]);
      const {frameAvg, cat, count, gpu} = accessors(agg);
      return {
        frameMs: frameAvg('interval'), fps: agg.seconds > 0 ? agg.frames / agg.seconds : 0,
        visiblePlayers: count('playersVisible'), renderedPlayers: count('playersRendered'), visibleEntities: count('entitiesVisible'),
        tickedEntities: count('entitiesTicked'), particles: count('particles'), sections: frameAvg('sections'),
        playerRenderMs: sum(cat('x.player'), cat('s.player')), featureModelMs: cat('f.model'), entityTickMs: cat('t.entities'),
        terrainPrepMs: cat('terrainPrep'), terrainSubmitMs: sum(cat('terrainSolid'), cat('terrainTranslucent')), animateTickMs: cat('t.animateTick'),
        gpuEntityMs: agg.gpuFrames ? gpu('entityFeatures') : null, gpuMs: agg.gpuFrames ? schema.gpu.reduce((a, n) => a + (gpu(n) || 0), 0) : null,
      };
    });
    const pair = (x, y) => {
      const ok = rows.filter(r => Number.isFinite(r[x]) && Number.isFinite(r[y]));
      return linear(ok.map(r => r[x]), ok.map(r => r[y]));
    };
    const buckets = [[0, 0.5, '0'], [0.5, 1.5, '1'], [1.5, 2.5, '2'], [2.5, 4.5, '3-4'], [4.5, 8.5, '5-8'], [8.5, Infinity, '9+']].map(([lo, hi, label]) => {
      const rs = rows.filter(r => r.visiblePlayers !== null && r.visiblePlayers >= lo && r.visiblePlayers < hi);
      if (!rs.length) return null;
      const avg = k => { const v = rs.map(r => r[k]).filter(Number.isFinite); return v.length ? round(v.reduce((a, b) => a + b, 0) / v.length) : null; };
      return {players: label, seconds: rs.length, fps: avg('fps'), frameMs: avg('frameMs'), playerRenderMs: avg('playerRenderMs'),
        featureModelMs: avg('featureModelMs'), entityTickMs: avg('entityTickMs'), gpuMs: avg('gpuMs'), visibleEntities: avg('visibleEntities')};
    }).filter(Boolean);
    return {
      seconds: rows.length, note: 'per-second bins without ablations; r = Pearson correlation, slope in y-units per x-unit',
      frameMsVsVisiblePlayers: pair('visiblePlayers', 'frameMs'), fpsVsVisiblePlayers: pair('visiblePlayers', 'fps'),
      playerRenderMsVsVisiblePlayers: pair('visiblePlayers', 'playerRenderMs'), featureModelMsVsRenderedPlayers: pair('renderedPlayers', 'featureModelMs'),
      entityTickMsVsTickedEntities: pair('tickedEntities', 'entityTickMs'), frameMsVsVisibleEntities: pair('visibleEntities', 'frameMs'),
      terrainPrepMsVsVisibleSections: pair('sections', 'terrainPrepMs'), terrainSubmitMsVsVisibleSections: pair('sections', 'terrainSubmitMs'),
      animateTickMsVsParticles: pair('particles', 'animateTickMs'), gpuEntityMsVsRenderedPlayers: pair('renderedPlayers', 'gpuEntityMs'),
      gpuMsVsVisiblePlayers: pair('visiblePlayers', 'gpuMs'),
      byVisiblePlayers: buckets,
    };
  }

  /** Small statistics block for one ABBA window. */
  function windowStats(list) {
    const b = summarize(list);
    // (sanitizer: <= 40 keys per object and no nesting below this level, the server re-sanitizes ABBA results.)
    // V0.507 dropped gpuEntityMs (no GPU timers on the S330), playerTick/RenderMs, visiblePlayers, networkMs and gcPerSec
    // from the windows (they stay in the breakdown bins) for the render-pass, presentation, scale and HUD-cache fields.
    return {seconds: b.windowSeconds, frames: b.frames, fps: b.fps, frameMs: b.frame.totalMs, p95Ms: b.frame.p95Ms, runTickMs: b.frame.runTickMs,
      tickMs: b.tick.tickTotalMs, renderMs: b.frame.renderMs, sleepMs: b.frame.sleepMs, compileSlackMs: b.frame.compileSlackMs,
      entityTickMs: b.tick.entityMs, animateTickMs: b.tick.animateTickMs,
      terrainMs: b.render.terrainSubmitMs, entityRenderMs: b.render.entityMs, featureModelMs: b.features.modelMs,
      gpuMs: b.gpu.totalMs, gpuBusyAtEndPct: b.gpu.busyAtEndPct, draws: b.counts.totalDraws, entityDraws: b.counts.entityDraws,
      renderedPlayers: b.counts.renderedPlayers, visibleEntities: b.counts.visibleEntities,
      texturesMs: b.tick.texturesMs, tickOtherMs: b.tick.otherMs, extractMs: b.render.extractMs,
      prepareFeaturesMs: b.render.prepareFeaturesMs, terrainPrepMs: b.render.terrainPrepMs,
      guiExtractMs: b.render.guiExtractMs, guiRenderMs: b.render.guiRenderMs,
      allocMBPerSec: b.memory?.allocMBPerSec ?? null, unexplainedMs: b.frame.unexplainedMs,
      fpsThrottledPct: b.frame.fpsThrottledPct, rafWaitMs: b.frame.rafWaitMs, lateSchedPct: b.frame.lateSchedPct,
      presentationWaitMs: b.frame.presentationWaitMs, visibleSections: b.counts.visibleSections, passSwitches: b.counts.renderPassSwitches,
      fbReentries: b.counts.framebufferReentries, renderScale: b.counts.renderScale, hudCacheHits: b.counts.hudCacheHits};
  }

  return {
    setSchema, addFrame, addGpu, range, summarize, compact, correlations, windowStats,
    get bins() { return bins; },
    get schema() { return schema; },
    get frames() { return totalFrames; },
    get currentState() { return lastState; },
  };
}
