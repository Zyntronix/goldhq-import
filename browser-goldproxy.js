// GoldProxy transport: Minecraft Java over a GoldProxy gateway (WSS -> Cloudflare Worker -> TCP).
//
// Presents the same polled socket object as browser-ws.js (state, nextBinary, sendBinary, stage, cancel,
// close facts), so the Java Connection drives it unchanged. The difference is underneath:
//   - the WebSocket speaks GoldProxy control protocol v1 (text = control, binary = raw TCP bytes);
//   - this module owns the TCP byte stream: AES/CFB8 (when Java enables it) and VarInt length framing;
//   - each nextBinary() is one Minecraft packet frame body WITHOUT its length prefix. With compression on,
//     the body still starts with the VarInt data length: Java (Connection) owns compression, so it applies the
//     threshold exactly when it handles LoginCompression, with no race against frames already queued here.
// Packet contents are never inspected here. Gateway credentials travel in the first control frame only.

import { AesCfb8 } from './browser-aes-cfb8.js?v=0.9900';
import { createReconnectTracker, reconnectPolicy } from './goldproxy-reconnect.js?v=0.9900';

const SUBPROTOCOL = 'goldproxy.v1';
const MAX_FRAME = 2 * 1024 * 1024 + 8; // Minecraft caps packets at 2^21 bytes (3-byte VarInt length)
const MAX_MESSAGE = 64 * 1024; // outbound WebSocket message size (well under the gateway's inbound cap)
const MAX_STAGES = 16;
const states = ['CLOSED', 'CONNECTING', 'OPEN', 'FAILED'];

// Gateway close codes (goldproxy/src/control.ts) -> names, for when the error text frame was lost.
const CLOSE_NAMES = {
  4000: 'PROTOCOL_ERROR', 4001: 'UNSUPPORTED_VERSION', 4003: 'UNAUTHORIZED', 4029: 'RATE_LIMITED', 4030: 'OVERLOADED',
  4100: 'BAD_DESTINATION', 4101: 'DESTINATION_NOT_ALLOWED', 4102: 'PORT_BLOCKED', 4103: 'ADDRESS_BLOCKED',
  4104: 'DNS_FAILED', 4200: 'CONNECT_FAILED', 4201: 'CONNECT_TIMEOUT', 4008: 'OPEN_TIMEOUT', 4300: 'NOT_MINECRAFT',
  4009: 'MESSAGE_TOO_LARGE', 4010: 'BACKPRESSURE', 4011: 'IDLE_TIMEOUT', 4012: 'SESSION_LIMIT', 4500: 'INTERNAL',
};

// Player-facing explanations per gateway error code (stage-aware failure UX).
const EXPLAIN = {
  UNAUTHORIZED: 'GoldProxy rejected this session (missing or expired access token).',
  RATE_LIMITED: 'Too many connection attempts through GoldProxy. Wait a moment and try again.',
  OVERLOADED: 'GoldProxy is busy. Try again in a few seconds.',
  BAD_DESTINATION: 'That server address is not valid.',
  DESTINATION_NOT_ALLOWED: 'GoldProxy does not allow connections to this server during the beta.',
  PORT_BLOCKED: 'GoldProxy does not allow that port.',
  ADDRESS_BLOCKED: "GoldProxy can't connect to that address because it points to a private or reserved network.",
  DNS_FAILED: 'The server name could not be resolved.',
  CONNECT_FAILED: 'GoldProxy could not open a connection to the server (offline, firewalled or wrong port).',
  CONNECT_TIMEOUT: 'The server did not accept a connection in time.',
  NOT_MINECRAFT: 'The connection did not start with a Minecraft handshake.',
  IDLE_TIMEOUT: 'The connection was idle for too long.',
  BACKPRESSURE: 'The server stopped reading data from this connection.',
};

/** Global gateway settings: deploy config (__eaglerConfig.goldProxy), overridable per browser via localStorage. */
export function goldProxySettings() {
  const config = globalThis.__eaglerConfig?.goldProxy ?? {};
  let local = {};
  try { local = JSON.parse(globalThis.localStorage?.getItem('eagler26.goldproxy') || '{}'); } catch {}
  return {
    gateway: local.gateway ?? config.gateway ?? null,
    token: local.token ?? config.token ?? null,
    tokenUrl: local.tokenUrl ?? config.tokenUrl ?? null,
    autoToken: (local.autoToken ?? config.autoToken) !== false,
  };
}

/** wss://host/v1/connect -> https://host/v1/token (ws:// -> http://). Null when the gateway URL is not recognisable. */
export function tokenUrlFor(gateway) {
  try {
    const u = new URL(gateway);
    if (u.protocol !== 'wss:' && u.protocol !== 'ws:') return null;
    u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
    u.pathname = u.pathname.replace(/\/v1\/connect$/, '') + '/v1/token';
    u.search = ''; u.hash = '';
    return u.toString();
  } catch { return null; }
}

// Server error code -> gateway-style code, so the reconnect policy and the disconnect screen treat an issuer refusal
// exactly like a gateway refusal. Anything unexpected (network, 5xx) is retryable NETWORK.
const TOKEN_ERRORS = { RATE_LIMITED: 'RATE_LIMITED', DESTINATION_NOT_ALLOWED: 'DESTINATION_NOT_ALLOWED', PORT_BLOCKED: 'PORT_BLOCKED',
  BAD_DESTINATION: 'BAD_DESTINATION', ORIGIN_NOT_ALLOWED: 'UNAUTHORIZED', NOT_FOUND: 'UNAUTHORIZED' };

/** Requests a fresh short-lived, destination-scoped token. Never cached: every session (and reconnect) asks again. */
async function requestToken(url, host, port, signal, fetchImpl = globalThis.fetch) {
  let res;
  try {
    res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ host, port }),
      credentials: 'omit', cache: 'no-store', signal });
  } catch (e) {
    if (signal?.aborted) throw Object.assign(new Error('cancelled'), { cancelled: true });
    throw Object.assign(new Error('could not reach GoldProxy'), { code: 'NETWORK' });
  }
  let body = null;
  try { body = await res.json(); } catch {}
  if (res.ok && body && typeof body.token === 'string') return body.token;
  throw Object.assign(new Error(body?.message || `token request failed (${res.status})`), { code: TOKEN_ERRORS[body?.error] ?? (res.status >= 500 || res.status === 0 ? 'NETWORK' : 'UNAUTHORIZED') });
}

function writeVarInt(out, offset, value) {
  let v = value >>> 0;
  do { let b = v & 0x7f; v >>>= 7; if (v) b |= 0x80; out[offset++] = b; } while (v);
  return offset;
}

function varIntSize(value) {
  return value < 0x80 ? 1 : value < 0x4000 ? 2 : value < 0x200000 ? 3 : value < 0x10000000 ? 4 : 5;
}

/**
 * @param {{gateway:string, token?:string|null, host:string, port:number, srv?:boolean, diagnostics?:boolean,
 *          createSocket?:(url:string, protocols:string[])=>WebSocket, timeoutMs?:number}} o
 */
export function openGoldProxySocket(o) {
  const result = {
    kind: 'goldproxy', state: 1, stateName: 'CONNECTING', endpoint: o.gateway, error: null, closeCode: 0, closeReason: '',
    wasClean: false, opened: false, sawError: false, done: false, strings: [], binary: [],
    rxBytes: 0, txBytes: 0, rxFrames: 0, txFrames: 0, lastRxAt: 0, lastTxAt: 0, lastStage: 'WS_CONNECTING', stages: [],
    createdAt: performance.now(), ready: null, gatewayError: null, gatewayEnd: null, encrypted: false,
  };
  const log = (event, detail = '') => { if (o.diagnostics !== false) console.log(`[GoldProxy] ${event}${detail ? ` ${detail}` : ''}`); };

  // Inbound stream assembly: a growable buffer, read from `head`, compacted when it is mostly consumed.
  let buf = new Uint8Array(64 * 1024);
  let head = 0, tail = 0;
  let lastFrameTail = new Uint8Array(0); // diagnostics only: the end of the previous frame
  let decrypt = null, encrypt = null;
  // Flow control: bytes sitting in `binary` (decoded but not taken by Java) are not acknowledged, so a stalled
  // game thread pushes back on the gateway instead of growing this queue. Partial-frame bytes ARE acknowledged,
  // so one packet larger than the window can never deadlock the stream.
  let queuedWire = 0, received = 0, acked = 0, windowBytes = 0;
  const queuedSizes = [];

  liveSockets++;
  const setState = (state, error = null) => {
    const wasDone = result.done;
    result.state = state;
    result.stateName = states[state];
    result.error = error;
    result.done = state === 0 || state === 3;
    if (result.done && !wasDone) liveSockets--;
  };

  const create = o.createSocket ?? ((url, protocols) => new WebSocket(url, protocols));
  let ws = null;
  let sessionToken = o.token ?? null;
  let tokenAbort = null;
  const needToken = !o.token && !o.createSocket && o.autoToken !== false && !!tokenUrlFor(o.gateway);

  const timeout = setTimeout(() => { if (result.state === 1) fail('timeout'); }, o.timeoutMs ?? 10000);

  function fail(error) {
    if (result.done) return;
    log('ERROR', error);
    setState(3, error);
    clearTimeout(timeout);
    try { tokenAbort?.abort(); } catch {}
    try { ws?.close(1000); } catch {}
  }

  function ackIfNeeded() {
    if (!windowBytes || !ws || ws.readyState !== 1) return;
    const consumed = received - queuedWire;
    if (consumed - acked >= windowBytes >> 2) {
      acked = consumed;
      ws.send(JSON.stringify({ t: 'ack', n: acked }));
    }
  }

  function feed(chunk) {
    if (decrypt) decrypt.update(chunk);
    const need = tail + chunk.length;
    if (need > buf.length) {
      const live = tail - head;
      if (live + chunk.length <= buf.length && head > 0) {
        buf.copyWithin(0, head, tail);
      } else {
        const next = new Uint8Array(Math.max(buf.length * 2, live + chunk.length));
        next.set(buf.subarray(head, tail));
        buf = next;
      }
      tail = live; head = 0;
    }
    buf.set(chunk, tail);
    tail += chunk.length;
    // Split complete frames.
    for (;;) {
      let len = 0, shift = 0, p = head, complete = false;
      while (p < tail && shift < 35) {
        const b = buf[p++];
        len |= (b & 0x7f) << shift;
        shift += 7;
        if (!(b & 0x80)) { complete = true; break; }
      }
      if (!complete) { if (shift >= 35 || p - head > 3) return protocolError('bad frame length'); break; }
      if (len < 0 || len > MAX_FRAME) return protocolError('frame too large: ' + len);
      // Vanilla rejects zero-length frames ("Frame length cannot be zero"): one here means the stream desynced.
      if (len === 0) {
        const at = received - (tail - head);
        log('zero-length frame', `streamOffset=${at} frames=${result.rxFrames} chunk=${chunk.length} prev=${Array.from(lastFrameTail).join(',')} next=${Array.from(buf.subarray(head, Math.min(tail, head + 24))).join(',')}`);
        return protocolError('zero-length frame at stream offset ' + at);
      }
      if (tail - p < len) break;
      const frame = buf.slice(p, p + len); // owned copy, as browser-ws.js guarantees
      lastFrameTail = frame.subarray(Math.max(0, len - 16));
      const wire = p + len - head;
      head = p + len;
      result.binary.push(frame);
      queuedSizes.push(wire);
      queuedWire += wire;
      result.rxFrames++;
    }
    if (head === tail) head = tail = 0;
  }

  function protocolError(why) {
    log('stream error', why);
    result.gatewayError = { code: 'CLIENT_STREAM', stage: 'stream', msg: why };
    result.closeReason = 'Invalid data from server: ' + why;
    fail('stream-error');
  }

  function wire() {
    ws.onopen = () => {
      if (result.done) return;
      // The socket counts as OPEN as soon as the open request is sent: the gateway buffers the Minecraft handshake
      // and login start while it resolves and dials, which saves one gateway round trip on every join.
      ws.send(JSON.stringify({ t: 'open', v: 1, token: sessionToken ?? undefined, host: o.host, port: o.port, srv: o.srv !== false }));
      result.opened = true;
      setState(2);
      result.stage('GOLDPROXY_OPEN');
      clearTimeout(timeout);
    };

    ws.onmessage = ({ data }) => {
      if (result.done) return;
      if (typeof data === 'string') {
        let msg;
        try { msg = JSON.parse(data); } catch { return; }
        if (msg.t === 'ready') {
          result.ready = msg;
          windowBytes = msg.window | 0;
          result.stage('GOLDPROXY_READY', `${msg.ip}:${msg.port} dns=${msg.dnsMs}ms connect=${msg.connectMs}ms`);
        } else if (msg.t === 'error') {
          result.gatewayError = { code: String(msg.code), stage: String(msg.stage), msg: String(msg.msg ?? '') };
        } else if (msg.t === 'end') {
          result.gatewayEnd = { reason: String(msg.reason), rx: msg.rx, tx: msg.tx };
        } else if (msg.t === 'pong') {
          result.onpong?.(msg.id);
        }
        return;
      }
      const chunk = new Uint8Array(data);
      result.rxBytes += chunk.length;
      received += chunk.length;
      result.lastRxAt = performance.now();
      feed(chunk);
      ackIfNeeded();
    };

    ws.onerror = () => { result.sawError = true; if (result.state === 1) fail('connection-error'); };

    ws.onclose = (event = {}) => {
      let EXPLAIN_OVERRIDE = null;
      clearTimeout(timeout);
      if (result.done) return;
      result.closeCode = Number(event.code ?? 0);
      result.wasClean = !!event.wasClean;
      const err = result.gatewayError ?? (CLOSE_NAMES[result.closeCode] ? { code: CLOSE_NAMES[result.closeCode], stage: 'unknown', msg: String(event.reason ?? '') } : null);
      if (err && !result.gatewayError) result.gatewayError = err;
      if (err?.code === 'ADDRESS_BLOCKED' && /cloudflare/i.test(err.msg ?? '')) {
      // Servers fronted by Cloudflare (Spectrum etc.) cannot be dialed from a Cloudflare Worker at all.
      EXPLAIN_OVERRIDE = "GoldProxy can't reach this server because it uses Cloudflare protection. This is a technical limit, not a problem with your connection or account. Try another server, or ask the server's staff for a direct address.";
    }
    result.closeReason = EXPLAIN_OVERRIDE ? EXPLAIN_OVERRIDE : err ? `${EXPLAIN[err.code] ?? err.code}${err.msg && !EXPLAIN[err.code] ? ` (${err.msg})` : ''}`
        : result.gatewayEnd ? (result.gatewayEnd.reason === 'backend_eof' ? 'The server closed the connection.' : `Connection ended (${result.gatewayEnd.reason}).`)
        : String(event.reason ?? '');
      log('CLOSE', `code ${result.closeCode} ${err ? err.code + '@' + err.stage : result.gatewayEnd?.reason ?? ''}`);
      setState(0, result.closeReason || null);
    };
  }

  function startSocket() {
    try {
      if (!o.gateway) throw new Error('GoldProxy gateway is not configured');
      ws = create(o.gateway, [SUBPROTOCOL]);
      ws.binaryType = 'arraybuffer';
    } catch (e) {
      result.closeReason = String(e?.message ?? e);
      clearTimeout(timeout);
      setState(3, result.closeReason);
      return;
    }
    wire();
  }

  if (!needToken) {
    startSocket();
  } else {
    // Automatic public access: ask the gateway's issuer for a short-lived token scoped to this destination.
    tokenAbort = new AbortController();
    const url = o.tokenUrl || tokenUrlFor(o.gateway);
    requestToken(url, o.host, o.port, tokenAbort.signal, o.fetchImpl).then((token) => {
      if (result.done) return;
      sessionToken = token;
      startSocket();
    }, (e) => {
      if (result.done || e?.cancelled) return;
      const code = e.code || 'NETWORK';
      result.gatewayError = { code, stage: 'token', msg: String(e.message ?? '') };
      result.closeReason = EXPLAIN[code] ?? (code === 'NETWORK' ? 'GoldProxy could not be reached. Check your connection and try again.' : String(e.message));
      log('TOKEN', `${code} ${e.message}`);
      clearTimeout(timeout);
      setState(3, result.closeReason);
    });
  }

  result.sendBinary = (body) => {
    if (result.state !== 2) throw new Error('GoldProxy socket is not open');
    const len = body.length;
    const frame = new Uint8Array(varIntSize(len) + len);
    frame.set(body, writeVarInt(frame, 0, len));
    if (encrypt) encrypt.update(frame);
    // The gateway caps one WebSocket message (256 KiB by default); the stream has no message boundaries, so a
    // large packet (book edits, big plugin payloads) is simply sent in slices.
    if (frame.length <= MAX_MESSAGE) ws.send(frame);
    else for (let i = 0; i < frame.length; i += MAX_MESSAGE) ws.send(frame.subarray(i, i + MAX_MESSAGE));
    result.txBytes += frame.length; result.txFrames++; result.lastTxAt = performance.now();
  };
  result.sendString = () => { throw new Error('GoldProxy carries no text frames'); };
  result.nextString = () => null;
  result.nextBinary = () => {
    const frame = result.binary.shift();
    if (frame === undefined) return null;
    queuedWire -= queuedSizes.shift();
    ackIfNeeded();
    return frame;
  };
  /** Minecraft encryption: called by Java right after it sent the encryption response (16-byte shared secret). */
  result.setEncryption = (secret) => {
    const key = new Uint8Array(secret);
    if (head !== tail) throw new Error('unexpected server data before encryption was enabled');
    decrypt = new AesCfb8(key, true);
    encrypt = new AesCfb8(key, false);
    result.encrypted = true;
    result.stage('ENCRYPTED');
  };
  result.ping = (id) => { if (ws?.readyState === 1) ws.send(JSON.stringify({ t: 'ping', id })); };
  result.cancel = () => {
    if (result.done) return;
    clearTimeout(timeout);
    try { tokenAbort?.abort(); } catch {}
    try { if (ws?.readyState === 1) ws.send(JSON.stringify({ t: 'close' })); } catch {}
    try { ws?.close(1000); } catch {}
    setState(0, 'cancelled');
  };
  result.reconnect = () => false; // every attempt is a fresh session (new token check, new TCP connection)
  return attach(result);
}

function attach(result) {
  result.stage ??= (name, detail = '') => {
    const stage = String(name);
    if (stage === result.lastStage && !detail) return;
    result.lastStage = stage;
    if (result.stages.length < MAX_STAGES) result.stages.push({ stage, t: Math.round(performance.now() - result.createdAt) });
    console.log(`[GoldProxy] STAGE ${detail ? `${stage} ${detail}` : stage}`);
  };
  result.sendBinary ??= () => { throw new Error('GoldProxy socket is not open'); };
  result.nextBinary ??= () => null;
  result.nextString ??= () => null;
  result.cancel ??= () => {};
  result.reconnect ??= () => false;
  result.setEncryption ??= () => { throw new Error('not connected'); };
  return result;
}

// Sockets not yet closed (leak checks: 1 while playing, 0 after leaving).
let liveSockets = 0;

// Automatic reconnection policy (goldproxy-reconnect.js), configured by __eaglerConfig.goldProxy.reconnect.
const reconnect = createReconnectTracker(() => reconnectPolicy(globalThis.__eaglerConfig?.goldProxy?.reconnect));

globalThis.__eaglerGoldProxy = {
  open: openGoldProxySocket,
  settings: goldProxySettings,
  liveSockets: () => liveSockets,
  reconnect,
};
