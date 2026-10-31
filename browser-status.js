import {openBrowserSocket} from './browser-ws.js?v=0.9900';

// Server-list status: Eagler servers (ws/wss MOTD protocol) and ordinary Java servers (java://host[:port], the
// Minecraft status protocol carried over GoldProxy). Browser events never enter Java or a raw Wasm export.
//
// Results are cached per address so leaving and re-entering the list (Add/Edit/Direct Connect menus rebuild the
// whole screen and ping everything again) shows the MOTD and icon at once instead of blanking them:
//   - an answer younger than FRESH_MS is returned without touching the network;
//   - a rate-limited ("blocked"/"locked") re-ping falls back to the last good answer (up to STALE_MS old).
const FRESH_MS = 30_000;
const STALE_MS = 10 * 60_000;
const cache = new Map(); // address -> {status, icon, ping, at}

function cached(address, maxAge) {
  const hit = cache.get(address);
  return hit && Date.now() - hit.at <= maxAge ? hit : null;
}

function remember(address, result) {
  if (!result.status) return;
  cache.set(address, {status: result.status, icon: result.icon, ping: result.ping, at: Date.now()});
  if (cache.size > 64) cache.delete(cache.keys().next().value);
}

function fromCache(hit) {
  return {done: true, status: hit.status, icon: hit.icon, ping: hit.ping, error: null, cancel() {}};
}

export function openStatus(address, timeoutMs = 10000) {
  if (typeof address === 'string') {
    const hit = cached(address, FRESH_MS);
    if (hit) return fromCache(hit);
  }
  const result = openStatusUncached(address, timeoutMs);
  if (typeof address === 'string') {
    // Wrap completion: remember good answers, and answer a rate-limited ping from the last good one.
    let wrapped = false;
    const settle = () => {
      if (wrapped || !result.done) return;
      wrapped = true;
      if (!result.error) remember(address, result);
      else if (result.error === 'rate-limited') {
        const stale = cached(address, STALE_MS);
        if (stale) Object.assign(result, {error: null, status: stale.status, icon: stale.icon, ping: stale.ping});
      }
    };
    return new Proxy(result, {get(target, key) { settle(); return target[key]; }});
  }
  return result;
}

function openStatusUncached(address, timeoutMs) {
  if (typeof address === 'string' && /^java:\/\//i.test(address)) return openJavaStatus(address, timeoutMs);
  const result = {done: false, status: null, icon: null, ping: -1, error: null};
  let socket, sentAt, responseTimer = null;
  const finish = (error = null) => {
    if (result.done) return;
    result.done = true;
    result.error = error;
    clearTimeout(responseTimer);
    responseTimer = null;
    if (socket) {
      socket.cancel();
    }
  };
  result.cancel = () => finish('cancelled');
  try {
    if (typeof address !== 'string' || /[\s\\#@]/.test(address)) throw new Error('Invalid address');
    const url = new URL(address.includes('://') ? address : `wss://${address}`);
    if (!['ws:', 'wss:'].includes(url.protocol) || !url.hostname || url.username || url.password)
      throw new Error('Invalid WebSocket address');
    socket = openBrowserSocket(url.href, {timeoutMs, diagnostics: false});
    socket.onopen = () => {
      if (result.done) return;
       sentAt = performance.now();
       responseTimer = setTimeout(() => finish('timeout'), timeoutMs);
       socket.sendString('Accept: MOTD');
    };
    socket.onstring = (data) => {
      if (result.done) return;
      try {
        if (typeof data === 'string') {
          if (data.length > 65536 || result.status) throw new Error('Invalid status frame');
          if (/^(blocked|locked)$/i.test(data)) return finish('rate-limited');
          const response = JSON.parse(data);
          if (/^(blocked|locked)$/i.test(response.type)) return finish('rate-limited');
          const status = response.data;
          if (String(response.type).toLowerCase() !== 'motd' || !status ||
              !Array.isArray(status.motd) ||
              !status.motd.every(line => typeof line === 'string') ||
              typeof status.icon !== 'boolean' ||
              !Number.isInteger(status.online) || !Number.isInteger(status.max) ||
              status.online < 0 || status.online > 2147483647 || status.max < 0 || status.max > 2147483647 ||
              !Array.isArray(status.players) || status.players.length > 1024 ||
              !status.players.every(player => typeof player === 'string')) throw new Error('Invalid MOTD');
          status.motd = status.motd.slice(0, 2);
          result.status = status;
          result.ping = Math.max(1, Math.round(performance.now() - sentAt));
          if (!status.icon) finish();
        }
      } catch {
        finish('invalid-response');
      }
    };
    socket.onbinary = (data) => {
      if (result.done) return;
      if (!result.status?.icon || data.byteLength !== 64 * 64 * 4) return finish('invalid-response');
      result.icon = new Uint8Array(data);
      finish();
    };
    socket.onerror = (error) => finish(error);
    socket.onclose = () => finish(result.status && !result.status.icon ? null : 'incomplete-response');
  } catch {
    finish('invalid-address');
  }
  return result;
}


// ---------------------------------------------------------------- java:// (Minecraft status over GoldProxy)

const LEGACY_COLORS = {black: '0', dark_blue: '1', dark_green: '2', dark_aqua: '3', dark_red: '4', dark_purple: '5', gold: '6', gray: '7',
  dark_gray: '8', blue: '9', green: 'a', aqua: 'b', red: 'c', light_purple: 'd', yellow: 'e', white: 'f'};
const LEGACY_RGB = {'0': 0x000000, '1': 0x0000aa, '2': 0x00aa00, '3': 0x00aaaa, '4': 0xaa0000, '5': 0xaa00aa, '6': 0xffaa00, '7': 0xaaaaaa,
  '8': 0x555555, '9': 0x5555ff, a: 0x55ff55, b: 0x55ffff, c: 0xff5555, d: 0xff55ff, e: 0xffff55, f: 0xffffff};

function nearestLegacy(hex) {
  const r = (hex >> 16) & 255, g = (hex >> 8) & 255, b = hex & 255;
  let best = 'f', bestD = Infinity;
  for (const [code, rgb] of Object.entries(LEGACY_RGB)) {
    const d = (r - (rgb >> 16)) ** 2 + (g - ((rgb >> 8) & 255)) ** 2 + (b - (rgb & 255)) ** 2;
    if (d < bestD) { bestD = d; best = code; }
  }
  return best;
}

/** Chat component (string | object | array) -> legacy section-sign text, which the client's text renderer understands. */
export function componentToLegacy(node, inherited = {}, depth = 0) {
  if (node == null || depth > 24) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number' || typeof node === 'boolean') return String(node);
  if (Array.isArray(node)) return node.map(n => componentToLegacy(n, inherited, depth + 1)).join('');
  if (typeof node !== 'object') return '';
  const style = {...inherited};
  for (const k of ['bold', 'italic', 'underlined', 'strikethrough', 'obfuscated']) if (typeof node[k] === 'boolean') style[k] = node[k];
  if (typeof node.color === 'string') {
    style.color = LEGACY_COLORS[node.color] ?? (/^#[0-9a-f]{6}$/i.test(node.color) ? nearestLegacy(parseInt(node.color.slice(1), 16)) : style.color);
  }
  let prefix = '';
  if (style.color) prefix += '§' + style.color;
  if (style.bold) prefix += '§l';
  if (style.italic) prefix += '§o';
  if (style.underlined) prefix += '§n';
  if (style.strikethrough) prefix += '§m';
  if (style.obfuscated) prefix += '§k';
  let text = typeof node.text === 'string' ? node.text : '';
  const body = text + (Array.isArray(node.extra) ? node.extra.map(n => componentToLegacy(n, style, depth + 1)).join('') : '');
  // Reset after each styled run so a sibling that sets nothing does not inherit it by accident of the renderer.
  return body ? (prefix ? '§r' + prefix + body : body) : '';
}

const writeVarInt = (out, value) => { let v = value >>> 0; do { let b = v & 0x7f; v >>>= 7; if (v) b |= 0x80; out.push(b); } while (v); };
const encodeString = (out, text) => { const b = new TextEncoder().encode(text); writeVarInt(out, b.length); out.push(...b); };

function readVarInt(buf, pos) {
  let result = 0, shift = 0, p = pos;
  for (;;) {
    if (p >= buf.length || shift > 28) return null;
    const b = buf[p++];
    result |= (b & 0x7f) << shift;
    if (!(b & 0x80)) return {value: result, pos: p};
    shift += 7;
  }
}

async function faviconToRgba(dataUrl) {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl || '');
  if (!m || m[1].length > 200_000) return null;
  try {
    const bytes = Uint8Array.from(atob(m[1].replace(/\s/g, '')), c => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], {type: 'image/png'}));
    const canvas = new OffscreenCanvas(64, 64);
    const ctx = canvas.getContext('2d', {willReadFrequently: true});
    ctx.drawImage(bitmap, 0, 0, 64, 64);
    bitmap.close?.();
    return new Uint8Array(ctx.getImageData(0, 0, 64, 64).data.buffer.slice(0));
  } catch { return null; }
}

function parseJavaAddress(address) {
  const rest = address.slice('java://'.length);
  const m = /^(\[[0-9a-fA-F:.]+\]|[^:/\s]+)(?::(\d{1,5}))?\/?$/.exec(rest);
  if (!m) return null;
  const port = m[2] ? Number(m[2]) : 25565;
  if (port < 1 || port > 65535) return null;
  return {host: m[1].replace(/^\[|\]$/g, ''), port};
}

function openJavaStatus(address, timeoutMs) {
  const result = {done: false, status: null, icon: null, ping: -1, error: null};
  let sock = null, poll = null, timer = null;
  const finish = (error = null) => {
    if (result.done) return;
    result.done = true;
    result.error = error;
    clearInterval(poll);
    clearTimeout(timer);
    try { sock?.cancel(); } catch {}
  };
  result.cancel = () => finish('cancelled');
  const target = parseJavaAddress(address);
  const gp = globalThis.__eaglerGoldProxy;
  if (!target || !gp?.open) { finish('invalid-address'); return result; }
  const {gateway, token} = gp.settings();
  if (!gateway) { finish('invalid-address'); return result; }

  timer = setTimeout(() => finish('timeout'), timeoutMs);
  // GoldProxy socket: fetches its own short-lived token when none is configured, frames/unframes packets for us.
  sock = gp.open({gateway, token, host: target.host, port: target.port, srv: true, diagnostics: false});
  let sent = false, stage = 0, pingSentAt = 0, statusSentAt = 0, statusMs = -1;
  const send = (bytes) => sock.sendBinary(new Uint8Array(bytes));

  poll = setInterval(() => {
    if (result.done) return;
    if (sock.state === 2 && !sent) {
      sent = true;
      const hs = [];
      writeVarInt(hs, 0x00); writeVarInt(hs, 777); encodeString(hs, target.host);
      hs.push((target.port >> 8) & 255, target.port & 255); writeVarInt(hs, 1);
      send(hs);
      send([0x00]); // status request
      statusSentAt = performance.now();
    }
    for (let frame = sock.nextBinary(); frame; frame = sock.nextBinary()) {
      const id = readVarInt(frame, 0);
      if (!id) return finish('invalid-response');
      if (stage === 0 && id.value === 0x00) {
        const len = readVarInt(frame, id.pos);
        if (!len || len.value > 131072 || len.pos + len.value > frame.length) return finish('invalid-response');
        statusMs = Math.max(1, Math.round(performance.now() - statusSentAt));
        let json;
        try { json = JSON.parse(new TextDecoder().decode(frame.subarray(len.pos, len.pos + len.value))); } catch { return finish('invalid-response'); }
        const players = json.players ?? {};
        const lines = componentToLegacy(json.description).split('\n').slice(0, 2);
        result.status = {
          motd: lines.length ? lines : [''],
          // Full chat component for the client's own (26.3) codec: hex colours, gradients, shadow colours, fonts.
          // The legacy lines above stay as the fallback when the codec rejects it.
          motdJson: json.description == null ? null : JSON.stringify(json.description),
          icon: false,
          online: Number.isInteger(players.online) && players.online >= 0 ? players.online : 0,
          max: Number.isInteger(players.max) && players.max >= 0 ? players.max : 0,
          players: Array.isArray(players.sample) ? players.sample.map(p => String(p?.name ?? '')).filter(Boolean).slice(0, 12) : [],
        };
        result.ping = statusMs;
        stage = 1;
        faviconToRgba(json.favicon).then(rgba => {
          if (result.done) return;
          if (rgba) { result.icon = rgba; result.status.icon = true; }
          // Real round trip over the already-open connection (the status request also paid DNS + TCP connect).
          pingSentAt = performance.now();
          const ping = [];
          writeVarInt(ping, 0x01);
          for (let i = 0; i < 8; i++) ping.push(i === 7 ? 1 : 0);
          try { send(ping); } catch { finish(); }
          stage = 2;
        });
      } else if (stage === 2 && id.value === 0x01) {
        result.ping = Math.max(1, Math.round(performance.now() - pingSentAt));
        return finish();
      }
    }
    // The server hangs up right after the pong, so only judge the closed socket once everything it sent was read.
    if (sock.state === 3 || sock.state === 0) {
      if (result.status && stage >= 1) return finish();
      const code = sock.gatewayError?.code;
      return finish(code === 'RATE_LIMITED' ? 'rate-limited' : 'connection-failed');
    }
  }, 20);
  return result;
}

globalThis.__eaglerStatus = {open: openStatus};
