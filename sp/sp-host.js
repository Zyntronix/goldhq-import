// Eagler26 integrated server: page-side host for the server worker (ES module).
//
// Owns the worker's lifecycle from the page: creation (URL worker or blob: worker), the init handshake, request/
// response with per-request timeouts, liveness (Java heartbeats + JS pings), crash and termination bookkeeping and
// a bounded log ring. Every failure ends in a FAILED (or STOPPED) state and rejects pending requests: a page waiting
// on the server never waits forever. Worker.terminate() fires no event, so termination is recorded here explicitly.
//
// This is the lifecycle/debug protocol. The Minecraft packet transport (Stage 2) is a separate MessageChannel per
// player: openPlayerChannel() returns the page end as a sp-local-socket.js socket (globalThis.EaglerLocalSocket must
// be loaded on the page). When the worker fails or is terminated every open socket is closed as "peer lost".

export const STATES = ['UNINITIALIZED', 'LOADING_RUNTIME', 'BOOTSTRAPPING', 'READY', 'LOADING_WORLD', 'RUNNING', 'SAVING', 'STOPPING', 'STOPPED', 'FAILED'];

const TRANSITIONS = {
  UNINITIALIZED: ['LOADING_RUNTIME'],
  LOADING_RUNTIME: ['BOOTSTRAPPING'],
  BOOTSTRAPPING: ['READY'],
  READY: ['LOADING_WORLD', 'STOPPED'],
  LOADING_WORLD: ['RUNNING', 'STOPPING', 'STOPPED'],
  RUNNING: ['SAVING', 'STOPPING'],
  SAVING: ['RUNNING', 'STOPPING'],
  STOPPING: ['STOPPED'],
  STOPPED: ['LOADING_WORLD'],
  FAILED: []
};

export class ServerHostError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.name = 'ServerHostError';
    this.code = code;
    Object.assign(this, extra || {});
  }
}

export class IntegratedServerHost {
  /**
   * @param {object} options
   *   workerUrl      URL of sp-server-worker.js (URL mode)
   *   storageUrl     URL of sp-storage.js (URL mode; default: next to the worker)
   *   blobSources    {storage: string, localSocket: string, durable: string, worker: string} -> blob: worker (offline)
   *   heartbeatTimeoutMs  liveness deadline (default 6000)
   *   startupHeartbeatTimeoutMs  deadline while loading the runtime, bootstrapping or loading a world (default: same)
   *   logLimit       bounded log ring size (default 2000)
   *   onEvent        (event) => void for every state/phase/progress/log/fatal/heartbeat message
   */
  constructor(options) {
    this.options = {heartbeatTimeoutMs: 6000, logLimit: 2000, ...options};
    this.state = 'UNINITIALIZED';
    this.stateHistory = [];
    this.transitionAnomalies = [];
    this.phases = [];
    this.logs = [];
    this.logsDropped = 0;
    this.lastHeartbeat = null;
    this.lastMessageAt = 0;
    this.failure = null;
    this.pending = new Map();
    this.nextId = 1;
    this.worker = null;
    this.watchdog = 0;
    this.blobUrl = null;
    this.events = [];
    this.sockets = new Set();
  }

  emit(event) {
    if (this.options.onEvent) {
      try { this.options.onEvent(event); } catch (error) { console.error('onEvent listener failed', error); }
    }
  }

  setState(next, detail, source) {
    if (next === this.state) return;
    const allowed = TRANSITIONS[this.state] || [];
    if (next !== 'FAILED' && !allowed.includes(next)) {
      this.transitionAnomalies.push({from: this.state, to: next, source, at: performance.now()});
    }
    this.stateHistory.push({from: this.state, to: next, detail, source, at: Math.round(performance.now())});
    this.state = next;
    this.emit({type: 'state', state: next, detail, source});
    if (next === 'FAILED') this.rejectAll('FAILED', 'server failed: ' + (detail || 'unknown'));
  }

  /** Creates the worker and resolves once Java reports READY (or rejects on FAILED/timeout). */
  start(init, timeoutMs = 120000) {
    if (this.worker) return Promise.reject(new ServerHostError('INVALID_STATE', 'worker already started'));
    let worker;
    if (this.options.blobSources) {
      const b = this.options.blobSources;
      const source = [b.storage, b.localSocket, b.durable, b.worker].filter(Boolean).join('\n;\n');
      this.blobUrl = URL.createObjectURL(new Blob([source], {type: 'text/javascript'}));
      worker = new Worker(this.blobUrl, {name: 'eagler26-integrated-server'});
    } else {
      worker = new Worker(this.options.workerUrl, {name: 'eagler26-integrated-server'});
    }
    this.worker = worker;
    this.lastMessageAt = performance.now();
    worker.onmessage = event => this.onMessage(event.data);
    worker.onerror = event => {
      event.preventDefault();
      this.fail('WORKER_ERROR', 'worker error: ' + (event.message || 'unknown') + (event.filename ? ' at ' + event.filename + ':' + event.lineno : ''));
    };
    worker.onmessageerror = () => this.fail('WORKER_ERROR', 'worker message could not be deserialized');
    this.watchdog = setInterval(() => this.checkLiveness(), 1000);
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        const error = new ServerHostError('TIMEOUT', 'server did not become READY within ' + timeoutMs + ' ms (state ' + this.state + ')');
        this.fail('INIT_TIMEOUT', error.message);
        reject(error);
      }, timeoutMs);
      const listener = event => {
        if (event.type !== 'state') return;
        if (event.state === 'READY') { cleanup(); resolve(this.lastReady); }
        else if (event.state === 'FAILED') { cleanup(); reject(new ServerHostError('FAILED', this.failure ? this.failure.message : event.detail, {failure: this.failure})); }
      };
      const cleanup = () => { clearTimeout(timer); this.readyListeners.delete(listener); };
      this.readyListeners.add(listener);
    });
    const transfer = [];
    if (init.wasm && init.wasm.bytes) transfer.push(init.wasm.bytes);
    if (init.assets && init.assets.buffer && init.transferAssets) transfer.push(init.assets.buffer);
    const near = name => this.options.workerUrl ? new URL(name, this.options.workerUrl).href : undefined;
    const storageScriptUrl = this.options.storageUrl || near('sp-storage.js');
    worker.postMessage({type: 'init', storageScriptUrl, localSocketScriptUrl: near('sp-local-socket.js'), durableScriptUrl: near('sp-durable.js'),
      ...init, transferAssets: undefined}, transfer);
    return ready;
  }

  get readyListeners() {
    if (!this._readyListeners) this._readyListeners = new Set();
    return this._readyListeners;
  }

  onMessage(m) {
    this.lastMessageAt = performance.now();
    switch (m.type) {
      case 'state':
        this.setState(m.state, m.detail, 'worker');
        for (const listener of [...this.readyListeners]) listener({type: 'state', state: m.state, detail: m.detail});
        break;
      case 'phase':
        this.phases.push({phase: m.phase, detail: m.detail, sinceStartMs: m.sinceStartMs, workerMs: m.workerMs, pageMs: Math.round(performance.now())});
        this.emit({type: 'phase', ...m});
        break;
      case 'ready':
        this.lastReady = m;
        this.emit({type: 'ready', ...m});
        break;
      case 'heartbeat':
        this.lastHeartbeat = {...m, receivedAt: performance.now()};
        this.emit({type: 'heartbeat', ...m});
        break;
      case 'progress':
        this.emit({type: 'progress', ...m});
        break;
      case 'log':
        this.logsDropped += m.dropped || 0;
        for (const entry of m.entries) {
          this.logs.push(entry);
          if (this.logs.length > this.options.logLimit) { this.logs.shift(); this.logsDropped++; }
        }
        this.emit({type: 'log', entries: m.entries, dropped: m.dropped});
        break;
      case 'fatal':
        this.failure = {code: 'SERVER_FATAL', message: m.message, stack: m.stack, lastPhase: m.lastPhase};
        this.emit({type: 'fatal', ...m});
        break;
      case 'workerError':
        this.emit({type: 'workerError', ...m});
        // An uncaught error inside the worker (e.g. a Wasm trap in a fiber) ends the runtime.
        this.fail('WORKER_ERROR', 'uncaught worker error: ' + m.message, m.stack);
        break;
      case 'reply':
      case 'pong':
      case 'exported':
      case 'stats':
      case 'hostReply':
        this.settle(m);
        break;
      case 'selftest':
        this.emit({type: 'selftest', ...m});
        break;
      default:
        this.emit({type: 'unknown', message: m});
    }
  }

  settle(m) {
    const entry = this.pending.get(m.id);
    if (!entry) return; // late reply after a timeout: ignored, already reported
    this.pending.delete(m.id);
    clearTimeout(entry.timer);
    if (m.type === 'reply' && !m.ok) entry.reject(new ServerHostError(m.code || 'ERROR', m.error || 'request failed', {state: m.state, reply: m}));
    else if (m.type === 'hostReply' && !m.ok) entry.reject(new ServerHostError(m.code || 'ERROR', m.error, {reply: m}));
    else entry.resolve(m.type === 'reply' ? m.result : m);
  }

  send(message, timeoutMs) {
    if (!this.worker) return Promise.reject(new ServerHostError('NOT_STARTED', 'worker not started'));
    if (this.state === 'FAILED') return Promise.reject(new ServerHostError('FAILED', 'server failed: ' + (this.failure && this.failure.message)));
    const id = 'r' + this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ServerHostError('TIMEOUT', `${message.cmd || message.type} timed out after ${timeoutMs} ms (state ${this.state})`));
      }, timeoutMs);
      this.pending.set(id, {resolve, reject, timer, what: message.cmd || message.type});
      this.worker.postMessage({...message, id});
    });
  }

  /** A lifecycle command handled by Java (status, diagnostics, startWorld, generate, save, stop, inject, ...). */
  request(cmd, args = {}, timeoutMs = 30000) {
    return this.send({type: 'command', cmd, args}, timeoutMs);
  }

  /**
   * Opens one Minecraft connection to the running world: a MessageChannel whose far end the worker hands to Java.
   * Resolves with the page end (a sp-local-socket.js socket, same shape as the WebSocket facade).
   */
  async openPlayerChannel(timeoutMs = 10000) {
    if (!globalThis.EaglerLocalSocket) throw new ServerHostError('UNAVAILABLE', 'sp-local-socket.js is not loaded on this page');
    if (!this.worker) throw new ServerHostError('NOT_STARTED', 'worker not started');
    const channel = new MessageChannel();
    const id = 'r' + this.nextId++;
    const reply = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new ServerHostError('TIMEOUT', 'openPlayerChannel timed out')); }, timeoutMs);
      this.pending.set(id, {resolve, reject, timer, what: 'openPlayerChannel'});
    });
    this.worker.postMessage({type: 'openPlayerChannel', id}, [channel.port2]);
    try {
      await reply;
    } catch (error) {
      channel.port1.close();
      throw error;
    }
    const socket = globalThis.EaglerLocalSocket.create(channel.port1, 'client');
    this.sockets.add(socket);
    socket.onclose = () => this.sockets.delete(socket);
    return socket;
  }

  async listWorlds(timeoutMs = 15000) { return this.send({type: 'listWorlds'}, timeoutMs); }
  async deleteWorld(levelId, timeoutMs = 15000) { return this.send({type: 'deleteWorld', levelId}, timeoutMs); }
  /** Retries the durable commit of the open world (after a failed save, e.g. once quota is freed). */
  async persist(timeoutMs = 60000) { return this.send({type: 'persist'}, timeoutMs); }
  async transportStats(timeoutMs = 5000) { return (await this.send({type: 'transportStats'}, timeoutMs)).sockets; }

  ping(timeoutMs = 3000) { return this.send({type: 'ping'}, timeoutMs); }
  storageStats(timeoutMs = 5000) { return this.send({type: 'storageStats'}, timeoutMs); }
  agentStats(timeoutMs = 5000) { return this.send({type: 'agentStats'}, timeoutMs); }
  setFault(name, value, timeoutMs = 5000) { return this.send({type: 'setFault', name, value}, timeoutMs); }
  /** Server-written files under prefix as [{path, bytes: ArrayBuffer}] (transferred out of the worker). */
  async exportFiles(prefix, timeoutMs = 60000) { return (await this.send({type: 'exportFiles', prefix}, timeoutMs)).files; }

  checkLiveness() {
    if (!this.worker || this.state === 'FAILED' || this.state === 'STOPPED' && !this.worker) return;
    const silentMs = performance.now() - this.lastMessageAt;
    // Startup (runtime load, bootstrap, world loading) runs long uninterrupted vanilla segments; on a slow or busy
    // device they can exceed the running-world deadline. startupHeartbeatTimeoutMs (when set) applies there instead.
    const starting = this.state === 'LOADING_RUNTIME' || this.state === 'BOOTSTRAPPING' || this.state === 'LOADING_WORLD';
    const limit = starting && this.options.startupHeartbeatTimeoutMs ? Math.max(this.options.heartbeatTimeoutMs, this.options.startupHeartbeatTimeoutMs)
      : this.options.heartbeatTimeoutMs;
    if (silentMs > limit) {
      this.fail('HEARTBEAT_LOST', `no message from the server worker for ${Math.round(silentMs)} ms (state ${this.state})`);
    }
  }

  fail(code, message, stack) {
    if (this.state === 'FAILED') return;
    this.failure = this.failure && this.failure.code === 'SERVER_FATAL' ? this.failure : {code, message, stack};
    this.setState('FAILED', message, 'host');
    this.dispose();
  }

  rejectAll(code, message) {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new ServerHostError(code, `${entry.what}: ${message}`));
      this.pending.delete(id);
    }
  }

  /** Releases the worker. Pending requests are rejected; the state becomes STOPPED (clean) unless already FAILED. */
  terminate(reason = 'terminated by the page') {
    if (!this.worker) return;
    // READY (runtime up, no world) and STOPPED hold nothing that could be lost: releasing the worker is a clean stop.
    // Anywhere else (loading, a world open, saving, stopping) the termination aborts work and is a failure.
    const clean = this.state === 'READY' || this.state === 'STOPPED' || this.state === 'UNINITIALIZED' || this.state === 'FAILED';
    const from = this.state;
    this.dispose();
    this.rejectAll('TERMINATED', reason);
    if (!clean) this.fail('TERMINATED', reason + ' while ' + from);
    else if (from === 'READY') this.setState('STOPPED', reason, 'host');
    this.emit({type: 'terminated', reason});
  }

  dispose() {
    for (const socket of [...this.sockets]) socket.peerLost(this.failure ? 'integrated server failed: ' + this.failure.message : 'integrated server stopped');
    this.sockets.clear();
    clearInterval(this.watchdog);
    this.watchdog = 0;
    if (this.worker) {
      this.worker.onmessage = null;
      this.worker.onerror = null;
      this.worker.terminate();
      this.worker = null;
    }
    if (this.blobUrl) { URL.revokeObjectURL(this.blobUrl); this.blobUrl = null; }
  }

  snapshot() {
    return {state: this.state, stateHistory: this.stateHistory, transitionAnomalies: this.transitionAnomalies, phases: this.phases,
      lastHeartbeat: this.lastHeartbeat, failure: this.failure, pending: [...this.pending.values()].map(p => p.what),
      logCount: this.logs.length, logsDropped: this.logsDropped, workerAlive: !!this.worker};
  }
}
