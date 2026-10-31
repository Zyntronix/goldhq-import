// Eagler26 singleplayer, Stage 2: the local Minecraft packet transport between the client page and the integrated
// server worker. Classic script (importScripts in the worker, `import` side effect on the page, concatenated into the
// offline blob worker); defines globalThis.EaglerLocalSocket.
//
// One MessageChannel per player connection, separate from the worker's lifecycle protocol. Each end wraps its
// MessagePort in an object with the same shape as the client's WebSocket facade (src/web/browser-ws.js), so the
// patched net.minecraft.network.Connection drives it through com.astra.teavm.BrowserWebSocket unchanged:
//   state (2 OPEN, 3 CLOSED), stateName, sendBinary(Uint8Array), nextBinary() -> Uint8Array|null, cancel(),
//   reconnect() -> false, stage(), and the close/traffic facts (opened, closeCode, closeReason, wasClean, ...).
// A frame is exactly one vanilla packet as the protocol codec writes it (VarInt id + body): no length prefix, no
// compression, no encryption, no Eagler or Via framing. Nothing here touches GoldProxy, WebSockets or ViaEagler.
//
// Port messages (structured clone; frame buffers are TRANSFERRED, never copied a second time):
//   {t:'f', at, frames:[ArrayBuffer...]}   frames in send order (one batch per microtask)
//   {t:'a', bytes}                          receiver consumed `bytes` (credit return for the in-flight window)
//   {t:'c', reason, code}                   orderly close; sent after every frame queued before it
// Ordering: a MessagePort delivers in order; batches are posted in order; a close is posted after the last batch.
// Backpressure: bytes sent but not yet consumed by the peer are "in flight". Above SOFT_WINDOW the socket reports
// writable=false (diagnostics; vanilla's chunk sender already paces itself on client acks). Above HARD_WINDOW the
// peer is not keeping up at all and the connection is closed with code 4008 rather than buffering without bound.
// Close: after a LOCAL close (cancel, overload, send failure) nothing more is sent or delivered: queued inbound frames
// are dropped and later sendBinary calls are ignored. After a PEER close (or peer loss) frames that arrived before it
// stay readable, as TCP delivers data sent before a FIN: the server's disconnect packet (the kick reason) is the last
// frame before its close, and Connection.tick drains every queued frame before it looks at the socket state.
(function () {
  'use strict';
  const SOFT_WINDOW = 8 * 1024 * 1024;
  const HARD_WINDOW = 96 * 1024 * 1024;
  const ACK_EVERY = 256 * 1024;
  const LATENCY_RING = 512;
  const clock = () => performance.timeOrigin + performance.now();

  function create(port, side, options = {}) {
    const hardWindow = options.hardWindow || HARD_WINDOW;
    const inbound = [];
    let inHead = 0;
    let outFrames = [];
    let outBytes = 0;
    let flushQueued = false;
    let unacked = 0;
    const latencies = new Float64Array(LATENCY_RING);
    let latencyCount = 0;
    const s = {
      side, state: 2, stateName: 'OPEN', opened: true, error: null, closeCode: 0, closeReason: '', wasClean: false, sawError: false,
      rxBytes: 0, txBytes: 0, rxFrames: 0, txFrames: 0, rxBatches: 0, txBatches: 0,
      inFlight: 0, maxInFlight: 0, writable: true, maxInboundDepth: 0, lastStage: null, createdAt: clock(),
      onclose: null
    };

    function flush() {
      flushQueued = false;
      if (!outFrames.length) return;
      const frames = outFrames;
      outFrames = [];
      s.inFlight += outBytes;
      outBytes = 0;
      if (s.inFlight > s.maxInFlight) s.maxInFlight = s.inFlight;
      s.writable = s.inFlight < SOFT_WINDOW;
      s.txBatches++;
      try {
        port.postMessage({t: 'f', at: clock(), frames}, frames);
      } catch (error) {
        closeLocal(1011, 'local transport send failed: ' + (error && error.message || error), false, true);
        return;
      }
      if (s.inFlight > hardWindow) {
        closeLocal(4008, `local transport overloaded: ${s.inFlight} bytes unconsumed by the ${side === 'client' ? 'server' : 'client'}`, false, true);
      }
    }

    // notifyPeer = this end initiated the close (drop what is queued); false = the peer closed or vanished (keep it).
    function closeLocal(code, reason, clean, notifyPeer) {
      if (s.state === 3) return;
      if (notifyPeer) {
        if (clean) flush(); // frames queued before an orderly close still go out first
        if (s.state === 3) return; // that flush hit the hard window and already closed (4008)
        try { port.postMessage({t: 'c', code, reason}); } catch {}
      }
      s.state = 3;
      s.stateName = 'CLOSED';
      s.wasPeerClose = !notifyPeer;
      s.closeCode = code;
      s.closeReason = reason;
      s.wasClean = !!clean;
      if (!clean) { s.sawError = true; s.error = reason; }
      outFrames = [];
      if (notifyPeer) {
        inbound.length = 0;
        inHead = 0;
      }
      port.onmessage = null;
      try { port.close(); } catch {}
      if (typeof s.onclose === 'function') { try { s.onclose(s); } catch {} }
    }

    port.onmessage = event => {
      const m = event.data;
      if (s.state !== 2 || !m) return;
      if (m.t === 'f') {
        s.rxBatches++;
        const lag = clock() - m.at;
        latencies[latencyCount++ % LATENCY_RING] = lag;
        for (const buffer of m.frames) {
          inbound.push(new Uint8Array(buffer));
          s.rxBytes += buffer.byteLength;
          s.rxFrames++;
        }
        const depth = inbound.length - inHead;
        if (depth > s.maxInboundDepth) s.maxInboundDepth = depth;
        if (typeof s.onframes === 'function') s.onframes();
      } else if (m.t === 'a') {
        s.inFlight = Math.max(0, s.inFlight - m.bytes);
        s.writable = s.inFlight < SOFT_WINDOW;
      } else if (m.t === 'c') {
        closeLocal(m.code || 1000, m.reason || 'closed by peer', m.code === 1000 || !m.code, false);
      }
    };
    if (port.start) port.start();

    s.sendBinary = value => {
      if (s.state !== 2) return; // as Netty: a write to a closed channel is dropped, the close handler disconnects
      const frame = value.slice(); // own, exactly-sized buffer: the source may alias a reused Java scratch array
      outFrames.push(frame.buffer);
      outBytes += frame.byteLength;
      s.txBytes += frame.byteLength;
      s.txFrames++;
      if (!flushQueued) { flushQueued = true; queueMicrotask(flush); }
    };
    s.nextBinary = () => {
      if (s.state !== 2 && !s.wasPeerClose) return null;
      if (inHead >= inbound.length) {
        if (inHead) { inbound.length = 0; inHead = 0; }
        return null;
      }
      const frame = inbound[inHead];
      inbound[inHead++] = undefined;
      unacked += frame.byteLength;
      if (s.state === 2 && (unacked >= ACK_EVERY || inHead >= inbound.length)) {
        try { port.postMessage({t: 'a', bytes: unacked}); } catch {}
        unacked = 0;
      }
      return frame;
    };
    s.pending = () => inbound.length - inHead;
    s.sendString = () => { throw new Error('the local transport carries binary packet frames only'); };
    s.nextString = () => null;
    s.cancel = () => closeLocal(1000, 'closed by ' + side, true, true);
    /** The other end is gone without a close message (worker terminated or crashed, page unloaded). */
    s.peerLost = reason => closeLocal(1006, reason || 'peer lost', false, false);
    s.reconnect = () => false;
    s.stage = (name, detail) => { s.lastStage = String(name) + (detail ? ' ' + detail : ''); };
    s.latency = () => {
      const n = Math.min(latencyCount, LATENCY_RING);
      if (!n) return {samples: 0};
      const sorted = Array.from(latencies.subarray(0, n)).sort((a, b) => a - b);
      const at = p => +sorted[Math.min(n - 1, Math.floor(p * n))].toFixed(3);
      return {samples: latencyCount, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: at(1)};
    };
    s.metrics = () => ({side, state: s.stateName, rxBytes: s.rxBytes, txBytes: s.txBytes, rxFrames: s.rxFrames, txFrames: s.txFrames,
      rxBatches: s.rxBatches, txBatches: s.txBatches, inFlight: s.inFlight, maxInFlight: s.maxInFlight, writable: s.writable,
      inboundDepth: s.pending(), maxInboundDepth: s.maxInboundDepth, batchLatencyMs: s.latency(), closeCode: s.closeCode, closeReason: s.closeReason});
    return s;
  }

  globalThis.EaglerLocalSocket = {create, SOFT_WINDOW, HARD_WINDOW};
})();
