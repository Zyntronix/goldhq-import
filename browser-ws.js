// Shared browser WebSocket transport. Java polls this object; browser events never
// call into a raw Wasm export, and every binary frame owns a copied Uint8Array.
//
// Close semantics: an error before OPEN fails the socket at once (browsers only ever report 1006
// there). An error after OPEN waits for the close event, so the close code, wasClean and the
// protocol stage reached (stage(), set by the Java connection code) survive for diagnostics. 1006 is
// produced by the browser for a connection that dropped without a close frame, never by the peer.
const states = ['CLOSED', 'CONNECTING', 'OPEN', 'FAILED'];
const MAX_STAGES = 16;

// Page scheme class for diagnostics: hosted pages are https, offline builds are file:// (Origin: null).
export function launchOrigin() {
  const scheme = globalThis.location?.protocol;
  return scheme === 'https:' ? 'https' : scheme === 'file:' ? 'file' : scheme === 'http:' ? 'http' : 'other';
}

function endpoint(address) {
  if (typeof address !== 'string' || /[\s\\#@]/.test(address)) throw new Error('Invalid address');
  const url = new URL(address.includes('://') ? address : `wss://${address}`);
  if (!['ws:', 'wss:'].includes(url.protocol) || !url.hostname || url.username || url.password) throw new Error('Invalid WebSocket address');
  if (globalThis.location?.protocol === 'https:' && url.protocol !== 'wss:') throw new Error('Secure pages require wss://');
  return url.href;
}

export function openBrowserSocket(address, options = {}) {
  const result = {state: 1, stateName: 'CONNECTING', endpoint: null, error: null, closeCode: 0, closeReason: '', wasClean: false,
    opened: false, sawError: false, strings: [], binary: [], done: false,
    lastRxAt: 0, lastTxAt: 0, rxBytes: 0, txBytes: 0, rxFrames: 0, txFrames: 0, lastStage: 'WS_CONNECTING', stages: [],
    launchOrigin: launchOrigin(), createdAt: 0,
    onopen: null, onstring: null, onbinary: null, onerror: null, onclose: null};
  let socket = null;
  let generation = 0;
  let timer = null;
  let errorTimer = null;
  const log = (event, detail = '') => {
    if (options.diagnostics !== false) console.log(`[R9] ${event}${detail ? ` ${detail}` : ''}`);
  };
  // Beta diagnostics: connection metadata only (never frame contents); status pings are skipped.
  const diag = (event, data) => {
    if (options.diagnostics !== false) try { globalThis.__eaglerDiagnostics?.socket?.(event, data); } catch {}
  };
  const setState = (state, error = null) => {
    result.state = state;
    result.stateName = states[state];
    result.error = error;
    result.done = state === 0 || state === 3;
  };
  const detach = () => {
    clearTimeout(timer);
    clearTimeout(errorTimer);
    timer = null;
    errorTimer = null;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
      try { socket.close(); } catch {}
      socket = null;
    }
  };
  const fail = (error) => {
    if (result.state === 0 || result.state === 3) return;
    log('ERROR', error);
    diag('error', {error: String(error), stage: result.lastStage, opened: result.opened});
    setState(3, error);
    detach();
    result.onerror?.(error);
    options.onerror?.(error, result);
  };
  const connect = () => {
    const current = ++generation;
    detach();
    result.strings.length = 0;
    result.binary.length = 0;
    Object.assign(result, {closeCode: 0, closeReason: '', wasClean: false, opened: false, sawError: false, rxBytes: 0, txBytes: 0,
      rxFrames: 0, txFrames: 0, lastStage: 'WS_CONNECTING', createdAt: performance.now()});
    result.stages.length = 0;
    try {
      result.endpoint = endpoint(address);
      setState(1, null);
       log('endpoint =', result.endpoint);
      diag('connect', {endpoint: result.endpoint, launchOrigin: result.launchOrigin});
      log('WS creating');
      socket = new WebSocket(result.endpoint);
      socket.binaryType = 'arraybuffer';
      socket.onopen = () => {
        if (current !== generation || result.state !== 1) return;
        setState(2);
        result.opened = true;
        result.stage('WS_OPEN');
         clearTimeout(timer);
         timer = null;
         log('WS OPEN');
         diag('open');
        result.onopen?.(result);
        options.onopen?.(result);
      };
      socket.onmessage = ({data}) => {
        if (current !== generation || result.state !== 2) return;
        if (typeof data === 'string') {
          result.strings.push(data);
          log('RX text', `${data.length} bytes`);
          result.onstring?.(data, result);
          options.onstring?.(data, result);
        } else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
          const copy = data instanceof ArrayBuffer
            ? new Uint8Array(data.slice(0))
            : new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
          result.binary.push(copy);
           result.lastRxAt = performance.now(); result.rxBytes += copy.byteLength; result.rxFrames++;
          result.onbinary?.(copy, result);
          options.onbinary?.(copy, result);
        } else fail('unsupported-frame');
      };
       socket.onerror = () => {
         if (current !== generation) return;
         log('WS ERROR');
         result.sawError = true;
         if (result.state !== 2) { fail('connection-error'); return; }
         // After OPEN the close event follows with the code: report the error to callback users now,
         // but keep the socket state until the close (bounded) so pollers see code, wasClean and stage.
         diag('error', {error: 'connection-error', stage: result.lastStage, opened: true});
         result.onerror?.('connection-error');
         options.onerror?.('connection-error', result);
         errorTimer ??= setTimeout(() => { if (current === generation) fail('connection-error'); }, 2000);
       };
       socket.onclose = (event = {}) => {
         if (current !== generation || result.state === 0 || result.state === 3) return;
          result.closeCode = Number(event.code ?? 0);
          result.closeReason = String(event.reason ?? '');
          result.wasClean = !!event.wasClean;
          log('WS CLOSE', `code ${event.code ?? 0} ${event.reason ?? ''}`.trim() + ` clean=${result.wasClean} stage=${result.lastStage}`);
          diag('close', {closeCode: result.closeCode, reason: result.closeReason, wasClean: result.wasClean, sawError: result.sawError,
            stage: result.lastStage, rxBytes: result.rxBytes, txBytes: result.txBytes, rxFrames: result.rxFrames, txFrames: result.txFrames});
         setState(0, result.closeReason || null);
        detach();
        result.onclose?.(result);
        options.onclose?.(result);
      };
      const timeout = options.timeoutMs ?? 10000;
      if (timeout > 0) timer = setTimeout(() => fail('timeout'), timeout);
    } catch { fail('invalid-address'); }
  };
  result.sendString = (value) => {
    if (result.state !== 2) throw new Error('WebSocket is not open');
    const text = String(value);
    socket.send(text);
    log('TX text', `${text.length} bytes`);
  };
  result.sendBinary = (value) => {
    if (result.state !== 2) throw new Error('WebSocket is not open');
    const copy = value instanceof Uint8Array ? new Uint8Array(value) : new Uint8Array(value);
    socket.send(copy);
    result.lastTxAt = performance.now(); result.txBytes += copy.byteLength; result.txFrames++;
  };
  // Protocol stage reached on this socket (WS_OPEN, EAGLER_NEGOTIATION, ..., PLAY). Called on stage
  // changes only, never per packet; kept with the socket so close/error diagnostics carry it.
  result.stage = (name, detail = '') => {
    const stage = String(name);
    if (stage === result.lastStage && !detail) return;
    result.lastStage = stage;
    if (result.stages.length < MAX_STAGES) result.stages.push({stage, t: Math.round(performance.now() - result.createdAt)});
    log('STAGE', detail ? `${stage} ${detail}` : stage);
    diag('stage', {stage, detail: detail ? String(detail) : undefined});
  };
  result.nextString = () => result.strings.shift() ?? null;
  result.nextBinary = () => result.binary.shift() ?? null;
  result.cancel = () => {
    if (result.state === 0) return;
    if (result.state === 3) {
      ++generation;
      detach();
      return;
    }
    ++generation;
     log('WS CLOSE', 'code 1000 cancelled');
    diag('close', {closeCode: 1000, reason: 'cancelled', cancelled: true, stage: result.lastStage, rxBytes: result.rxBytes, txBytes: result.txBytes});
    setState(0, 'cancelled');
    detach();
    result.onclose?.(result);
    options.onclose?.(result);
  };
  result.reconnect = () => {
    if (result.state !== 0 && result.state !== 3) return false;
    connect();
    return true;
  };
  connect();
  return result;
}

globalThis.__eaglerBrowserSocket = {open: openBrowserSocket};
