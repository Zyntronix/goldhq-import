// V0.508 worker terrain meshing: the main-thread side of E26WorkerMeshing.java (the kernel is mesh-worker.js).
//
// Worker count: ?perf.meshWorkers=<0..4>; by default 1 on machines reporting <= 4 hardware threads (a 4-thread
// Chromebook also runs Chrome's GPU process, compositor and the game's main thread) and 2 above. 0 = no workers
// (every section compiles on the main thread, like ?perf.noWorkerMeshing=1). Jobs in flight per worker:
// ?perf.meshInFlight (default 3): enough to keep a worker busy while the main thread installs results, few enough
// that a job never waits long behind others (the compile queue keeps choosing visible sections first).
// No SharedArrayBuffer: jobs and results are transferred ArrayBuffers; state definitions are copied to every worker.

const params = new URLSearchParams(location.search);
const threads = navigator.hardwareConcurrency || 2;
const requested = params.has('perf.meshWorkers') ? Number(params.get('perf.meshWorkers')) : NaN;
const count = Number.isFinite(requested) ? Math.max(0, Math.min(4, requested | 0)) : (threads <= 4 ? 1 : 2);
const inFlightCap = Math.max(1, Math.min(16, Number(params.get('perf.meshInFlight')) || 3));

const mesh = globalThis.__eaglerMesh = {
  count, inFlightCap, threads, workers: [], inFlight: [], results: [], ready: false, failed: null, gen: -1, config: null, defs: [],
  owner: new Map(), submittedAt: new Map(),
  // V0.509: jobBytes = snapshot bytes sent, resultBytes = mesh bytes received (exact-size vertex buffers per layer).
  stats: {jobs: 0, results: 0, failures: 0, skipped: 0, workerMs: 0, maxWorkerMs: 0, lastError: null, jobBytes: 0, resultBytes: 0, failureReasons: {}},
  canSubmit() {
    this.sweep();
    if (!this.ready) return false;
    for (let i = 0; i < this.inFlight.length; i++) if (this.inFlight[i] < this.inFlightCap) return true;
    return false;
  },
  reset(gen, ao, cutoutLeaves, mangrove) {
    this.gen = gen;
    this.config = {type: 'reset', gen, ao, cutoutLeaves, mangrove};
    this.defs = [];
    this.results.length = 0;
    for (const w of this.workers) w.postMessage(this.config);
  },
  define(gen, words) {
    this.defs.push(words);
    for (const w of this.workers) w.postMessage({type: 'define', gen, words});
  },
  submit(job) {
    let best = -1;
    for (let i = 0; i < this.inFlight.length; i++) if (this.inFlight[i] < this.inFlightCap && (best < 0 || this.inFlight[i] < this.inFlight[best])) best = i;
    if (best < 0) best = 0;
    this.inFlight[best]++;
    this.owner.set(job.id, best);
    this.submittedAt.set(job.id, performance.now());
    this.stats.jobs++;
    this.stats.jobBytes += job.states.byteLength + job.light.byteLength + job.tint.byteLength + (job.faces ? job.faces.byteLength : 0);
    job.type = 'job';
    this.workers[best].postMessage(job, job.faces ? [job.states.buffer, job.light.buffer, job.tint.buffer, job.faces.buffer] : [job.states.buffer, job.light.buffer, job.tint.buffer]);
  },
  cancel(id) {
    const i = this.owner.get(id);
    if (i !== undefined) this.workers[i].postMessage({type: 'cancel', id});
  },
  // A job whose worker died or that got no answer for 15 s fails: the main thread compiles that section in Java.
  fail(id, reason) {
    const i = this.owner.get(id);
    if (i !== undefined) this.inFlight[i] = Math.max(0, this.inFlight[i] - 1);
    this.owner.delete(id);
    this.submittedAt.delete(id);
    this.stats.failures++;
    this.stats.failureReasons['main: ' + reason] = (this.stats.failureReasons['main: ' + reason] || 0) + 1;
    if (!this.stats.lastError) this.stats.lastError = reason;
    this.results.push({type: 'result', id, gen: this.gen, ok: 0, error: reason});
  },
  sweep() {
    if (this.submittedAt.size === 0) return;
    const now = performance.now();
    for (const [id, at] of this.submittedAt) if (now - at > 15000) this.fail(id, 'mesh worker timeout');
  },
  describe() {
    return {workers: this.count, ready: this.ready, failed: this.failed, threads: this.threads, inFlightCap: this.inFlightCap,
      inFlight: this.inFlight.slice(), queued: this.results.length, ...this.stats};
  },
};

function onMessage(index, d) {
  if (!d || d.type !== 'result') return;
  mesh.inFlight[index] = Math.max(0, mesh.inFlight[index] - 1);
  mesh.owner.delete(d.id);
  mesh.submittedAt.delete(d.id);
  if (d.skipped) { mesh.stats.skipped++; return; }
  if (!d.ok) {
    mesh.stats.failures++;
    // V0.509: failures by reason (bail = the worker declined a section it cannot mesh exactly -> Java compile).
    const reason = d.bail ? 'bail: ' + String(d.bail).slice(0, 60) : d.error ? 'error: ' + String(d.error).split('\n')[0].slice(0, 60) : 'other';
    mesh.stats.failureReasons[reason] = (mesh.stats.failureReasons[reason] || 0) + 1;
    if (d.error && !mesh.stats.lastError) { mesh.stats.lastError = String(d.error).slice(0, 400); console.warn('[E26 mesh worker]', d.error); }
  } else {
    mesh.stats.results++;
    if (d.layers) for (const b of d.layers) if (b) mesh.stats.resultBytes += b.byteLength;
    mesh.stats.workerMs += d.ms || 0;
    mesh.stats.maxWorkerMs = Math.max(mesh.stats.maxWorkerMs, d.ms || 0);
  }
  mesh.results.push(d);
}

try {
  for (let i = 0; i < count; i++) {
    const w = new Worker(new URL('./mesh-worker.js?v=0.9900', import.meta.url), {type: 'module', name: `eagler-mesh-${i}`});
    w.onmessage = e => onMessage(i, e.data);
    w.onerror = e => {
      mesh.ready = false;
      mesh.failed = String(e.message || e);
      console.warn('[E26 mesh worker] failed:', mesh.failed);
      for (const [id, owner] of [...mesh.owner]) if (owner === i) mesh.fail(id, 'mesh worker error: ' + mesh.failed);
    };
    mesh.workers.push(w);
    mesh.inFlight.push(0);
  }
  mesh.ready = count > 0;
} catch (error) {
  mesh.ready = false;
  mesh.failed = String(error);
}
