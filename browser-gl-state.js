// WebGL2 redundant-state elimination (R9.7).
//
// The WebGL2 backend re-issues its full binding state for every draw (program, uniform block
// indices/bindings/ranges, samplers, textures, vertex attributes, capabilities): ~23k WebGL calls
// per frame, each crossing Blink's bindings and validation. This layer wraps the context so a call
// whose requested state equals the tracked current state is skipped. It sits on the context object,
// so every caller goes through it and the tracked state cannot drift from what was issued.
// Deleting an object scrubs every tracked binding that references it (forcing a real re-bind).
// Queries are never cached except pure per-program ones (block indices, uniform locations).
// Disable with ?glCache=0.
export function installGlStateCache(gl) {
  if (gl.__eaglerStateCache || new URLSearchParams(location.search).get('glCache') === '0') return gl;
  const n = name => gl[name].bind(gl);
  const raw = {};
  for (const k of ['useProgram', 'activeTexture', 'bindTexture', 'bindSampler', 'enable', 'disable', 'depthFunc', 'depthMask',
    'colorMask', 'blendFuncSeparate', 'blendEquationSeparate', 'polygonOffset', 'bindBufferRange', 'bindBufferBase', 'bindBuffer',
    'uniformBlockBinding', 'uniform1i', 'enableVertexAttribArray', 'disableVertexAttribArray', 'vertexAttribDivisor',
    'vertexAttribPointer', 'vertexAttribIPointer', 'getUniformBlockIndex', 'getUniformLocation', 'deleteTexture', 'deleteSampler',
    'deleteBuffer', 'deleteProgram', 'bindVertexArray', 'scissor', 'viewport', 'bindFramebuffer', 'deleteFramebuffer']) raw[k] = n(k);
  const TEX2D = gl.TEXTURE_2D, CUBE = gl.TEXTURE_CUBE_MAP, ARRAY = gl.ARRAY_BUFFER, UBO = gl.UNIFORM_BUFFER, ELEM = gl.ELEMENT_ARRAY_BUFFER;
  const s = gl.__eaglerStateCache = {
    program: undefined, unit: undefined, tex2d: [], cube: [], sampler: [], caps: new Map(), depthFunc: undefined, depthMask: undefined,
    colorMask: '', blendFunc: '', blendEq: '', offset: '', ubo: [], arrayBuffer: undefined, attrEnabled: [], attrDivisor: [], attrPtr: [],
    scissor: '', viewport: '', skipped: 0, elem: undefined, fbDraw: undefined, fbRead: undefined,
  };
  const FB = gl.FRAMEBUFFER, DFB = gl.DRAW_FRAMEBUFFER, RFB = gl.READ_FRAMEBUFFER;
  const skip = () => { s.skipped++; };
  gl.useProgram = p => { if (s.program === p) return skip(); s.program = p; raw.useProgram(p); };
  // V0.509 RC: redundant framebuffer binds are filtered like the other bindings (every render pass, clear and present binds
  // its framebuffer; consecutive passes into the same target re-bind it: ~14 per standing frame, ~40 with entities).
  // Attachment changes do not need a rebind. Deleting the bound framebuffer resets the tracked binding to the default (null).
  // ?perf.noRcWave=1 (live) forwards every call as before.
  gl.bindFramebuffer = (target, f) => {
    if (globalThis.__eaglerE26Rc !== false) {
      if (target === FB) { if (s.fbDraw === f && s.fbRead === f) return skip(); s.fbDraw = s.fbRead = f; }
      else if (target === DFB) { if (s.fbDraw === f) return skip(); s.fbDraw = f; }
      else if (target === RFB) { if (s.fbRead === f) return skip(); s.fbRead = f; }
    } else { s.fbDraw = s.fbRead = undefined; }
    raw.bindFramebuffer(target, f);
  };
  gl.deleteFramebuffer = f => { if (s.fbDraw === f) s.fbDraw = null; if (s.fbRead === f) s.fbRead = null; raw.deleteFramebuffer(f); };
  gl.activeTexture = u => { if (s.unit === u) return skip(); s.unit = u; raw.activeTexture(u); };
  gl.bindTexture = (target, t) => {
    const table = target === TEX2D ? s.tex2d : target === CUBE ? s.cube : null;
    const u = s.unit === undefined ? -1 : s.unit;
    if (table && s.unit !== undefined && table[u] === t) return skip();
    if (table) table[u] = t;
    raw.bindTexture(target, t);
  };
  gl.bindSampler = (u, smp) => { if (s.sampler[u] === smp && smp !== undefined) return skip(); s.sampler[u] = smp; raw.bindSampler(u, smp); };
  gl.enable = cap => { if (s.caps.get(cap) === true) return skip(); s.caps.set(cap, true); raw.enable(cap); };
  gl.disable = cap => { if (s.caps.get(cap) === false) return skip(); s.caps.set(cap, false); raw.disable(cap); };
  gl.depthFunc = f => { if (s.depthFunc === f) return skip(); s.depthFunc = f; raw.depthFunc(f); };
  gl.depthMask = m => { m = !!m; if (s.depthMask === m) return skip(); s.depthMask = m; raw.depthMask(m); };
  // V0.509: tracked as numbers (these run for most draws; the former string keys allocated on every call). Same
  // equality: every argument compared by value (colorMask by truthiness, as before).
  const cm = [], bf = [], be = [], po = [], sc = [], vp = [];
  gl.colorMask = (r, g, b, a) => { const k = (r ? 1 : 0) | (g ? 2 : 0) | (b ? 4 : 0) | (a ? 8 : 0); if (s.colorMask === k) return skip(); s.colorMask = k; raw.colorMask(r, g, b, a); };
  const same4 = (t, a, b, c, d) => { if (t.length && t[0] === a && t[1] === b && t[2] === c && t[3] === d) return true; t[0] = a; t[1] = b; t[2] = c; t[3] = d; return false; };
  const same2 = (t, a, b) => { if (t.length && t[0] === a && t[1] === b) return true; t[0] = a; t[1] = b; return false; };
  gl.blendFuncSeparate = (a, b, c, d) => { if (same4(bf, a, b, c, d)) return skip(); raw.blendFuncSeparate(a, b, c, d); };
  gl.blendEquationSeparate = (a, b) => { if (same2(be, a, b)) return skip(); raw.blendEquationSeparate(a, b); };
  gl.polygonOffset = (f, u) => { if (same2(po, f, u)) return skip(); raw.polygonOffset(f, u); };
  gl.scissor = (x, y, w, h) => { if (same4(sc, x, y, w, h)) return skip(); raw.scissor(x, y, w, h); };
  gl.viewport = (x, y, w, h) => { if (same4(vp, x, y, w, h)) return skip(); raw.viewport(x, y, w, h); };
  // Indexed uniform-buffer ranges. bindBufferRange/Base also rebind the generic UNIFORM_BUFFER point,
  // which is not tracked (bindBuffer is forwarded unconditionally except ARRAY_BUFFER).
  gl.bindBufferRange = (target, i, b, o, z) => {
    if (target === UBO) {
      const e = s.ubo[i];
      if (e && e.b === b && e.o === o && e.z === z) return skip();
      // V0.509 RC: the tracking record is updated in place (a missed bind used to allocate a new one: ~120 per frame).
      if (e) { e.b = b; e.o = o; e.z = z; } else s.ubo[i] = {b, o, z};
    }
    if (target === UBO) gen[UBO] = b;
    raw.bindBufferRange(target, i, b, o, z);
  };
  gl.bindBufferBase = (target, i, b) => { if (target === UBO) { s.ubo[i] = undefined; gen[UBO] = b; } raw.bindBufferBase(target, i, b); };
  // V0.509 RC: the other generic binding points (UNIFORM_BUFFER, COPY_READ/WRITE, PIXEL_UNPACK) are filtered too: every
  // gl.bufferSubData/copy is preceded by a bindBuffer of its target, often of the buffer already bound there (~13 filtered per
  // frame). bindBufferRange/Base also bind the generic UNIFORM_BUFFER point (tracked below when they reach the browser).
  // ?perf.noRcWave=1 (live) forwards everything and forgets the tracked state.
  let gen = Object.create(null);
  gl.bindBuffer = (target, b) => {
    if (target === ARRAY) { if (s.arrayBuffer === b) return skip(); s.arrayBuffer = b; }
    else if (target === ELEM) s.elem = b;
    else if (globalThis.__eaglerE26Rc !== false) { if (gen[target] === b) return skip(); gen[target] = b; }
    else gen = Object.create(null);
    raw.bindBuffer(target, b);
  };
  // V0.508 native GPU wave: every draw stamps the buffers it reads (bound uniform ranges, enabled attribute buffers,
  // element buffer) with the frame number (gl.__e26Frame, advanced at present). A write into a stamped buffer within
  // the last frames renames it first (globalThis.__eaglerE26Buffers.rename): on a tile GPU the draws of the frame being
  // built (and of the frames still in flight) have not read it yet, so an in-place write forces the driver to copy
  // the buffer or flush the pending tiles.
  const mark = () => {
    const F = gl.__e26Frame | 0;
    for (let i = 0; i < s.ubo.length; i++) { const e = s.ubo[i]; if (e) e.b.__u = F; }
    for (let i = 0; i < s.attrPtr.length; i++) { const e = s.attrPtr[i]; if (e && e.b && s.attrEnabled[i]) e.b.__u = F; }
    if (s.elem) s.elem.__u = F;
  };
  for (const k of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements']) {
    const f = gl[k].bind(gl);
    gl[k] = (a, b, c, d, e, f2) => { mark(); return f(a, b, c, d, e, f2); };
  }
  const md = gl.getExtension('WEBGL_multi_draw');
  if (md) for (const k of ['multiDrawElementsWEBGL', 'multiDrawArraysWEBGL', 'multiDrawElementsInstancedWEBGL', 'multiDrawArraysInstancedWEBGL']) {
    if (typeof md[k] !== 'function') continue;
    const f = md[k].bind(md);
    md[k] = (...a) => { mark(); return f(...a); };
  }
  gl.uniformBlockBinding = (p, idx, binding) => {
    const m = p.__eaglerBlockBinding || (p.__eaglerBlockBinding = []);
    if (m[idx] === binding) return skip();
    m[idx] = binding; raw.uniformBlockBinding(p, idx, binding);
  };
  // uniform1i targets the current program; cache the value on the location object (locations are per program).
  gl.uniform1i = (loc, v) => { if (loc && loc.__eaglerI === v) return skip(); if (loc) loc.__eaglerI = v; raw.uniform1i(loc, v); };
  gl.enableVertexAttribArray = i => { if (s.attrEnabled[i] === true) return skip(); s.attrEnabled[i] = true; raw.enableVertexAttribArray(i); };
  gl.disableVertexAttribArray = i => { if (s.attrEnabled[i] === false) return skip(); s.attrEnabled[i] = false; raw.disableVertexAttribArray(i); };
  gl.vertexAttribDivisor = (i, d) => { if (s.attrDivisor[i] === d) return skip(); s.attrDivisor[i] = d; raw.vertexAttribDivisor(i, d); };
  gl.vertexAttribPointer = (i, size, type, norm, stride, offset) => {
    const e = s.attrPtr[i];
    if (e && e.b === s.arrayBuffer && e.f === 0 && e.size === size && e.type === type && e.norm === !!norm && e.stride === stride && e.offset === offset) return skip();
    if (e) { e.b = s.arrayBuffer; e.f = 0; e.size = size; e.type = type; e.norm = !!norm; e.stride = stride; e.offset = offset; }
    else s.attrPtr[i] = {b: s.arrayBuffer, f: 0, size, type, norm: !!norm, stride, offset};
    raw.vertexAttribPointer(i, size, type, norm, stride, offset);
  };
  gl.vertexAttribIPointer = (i, size, type, stride, offset) => {
    const e = s.attrPtr[i];
    if (e && e.b === s.arrayBuffer && e.f === 1 && e.size === size && e.type === type && e.stride === stride && e.offset === offset) return skip();
    if (e) { e.b = s.arrayBuffer; e.f = 1; e.size = size; e.type = type; e.norm = false; e.stride = stride; e.offset = offset; }
    else s.attrPtr[i] = {b: s.arrayBuffer, f: 1, size, type, norm: false, stride, offset};
    raw.vertexAttribIPointer(i, size, type, stride, offset);
  };
  gl.getUniformBlockIndex = (p, name) => {
    const m = p.__eaglerBlockIndex || (p.__eaglerBlockIndex = new Map());
    let v = m.get(name);
    if (v === undefined) { v = raw.getUniformBlockIndex(p, name); m.set(name, v); } else skip();
    return v;
  };
  gl.getUniformLocation = (p, name) => {
    const m = p.__eaglerLocation || (p.__eaglerLocation = new Map());
    let v = m.get(name);
    if (v === undefined) { v = raw.getUniformLocation(p, name); m.set(name, v); } else skip();
    return v;
  };
  const scrub = (arr, obj) => { for (let i = 0; i < arr.length; i++) if (arr[i] === obj) arr[i] = undefined; };
  gl.deleteTexture = t => { scrub(s.tex2d, t); scrub(s.cube, t); raw.deleteTexture(t); };
  gl.deleteSampler = x => { scrub(s.sampler, x); raw.deleteSampler(x); };
  gl.deleteBuffer = b => {
    if (s.arrayBuffer === b) s.arrayBuffer = undefined;
    if (s.elem === b) s.elem = undefined;
    for (let i = 0; i < s.ubo.length; i++) if (s.ubo[i] && s.ubo[i].b === b) s.ubo[i] = undefined;
    for (let i = 0; i < s.attrPtr.length; i++) if (s.attrPtr[i] && s.attrPtr[i].b === b) s.attrPtr[i] = undefined;
    for (const k in gen) if (gen[k] === b) gen[k] = null;
    raw.deleteBuffer(b);
  };
  gl.deleteProgram = p => { if (s.program === p) s.program = undefined; raw.deleteProgram(p); };
  // Vertex array objects carry their own attribute/element state: drop the attribute cache on switch.
  gl.bindVertexArray = v => { s.attrEnabled = []; s.attrDivisor = []; s.attrPtr = []; s.elem = undefined; raw.bindVertexArray(v); };
  return gl;
}

// V0.508 native GPU wave: buffer renaming. A logical buffer (WebGL2Buffer id) keeps a pool of spare GL buffers; a
// write into a buffer that a draw read within the last IN_FLIGHT frames moves the logical buffer to a spare that no
// draw read for longer (or a new one), carrying the old contents over (from the CPU shadow when the caller passes it,
// else a GPU copy, nothing when the write covers the whole buffer). Buffers over MAX_BYTES (the terrain heaps) are
// never renamed. Returns the GL buffer the write must go to.
const IN_FLIGHT = 2, MAX_BYTES = 1 << 20, MAX_SPARES = 6;
globalThis.__eaglerE26Buffers = {
  renames: 0,
  inUse(gl, b) {
    return !!(globalThis.__eaglerE26NativeWave && b && b.__u !== undefined && (gl.__e26Frame | 0) - b.__u <= IN_FLIGHT
      && b.__eaglerSize <= MAX_BYTES);
  },
  rename(gl, b, target, size, id, full, gpuCopy) {
    const F = gl.__e26Frame | 0;
    const pools = gl.__e26Pools || (gl.__e26Pools = new Map());
    let pool = pools.get(id);
    if (!pool) pools.set(id, pool = []);
    let h = null;
    for (let i = 0; i < pool.length; i++) if (pool[i].__u === undefined || F - pool[i].__u > IN_FLIGHT) { h = pool.splice(i, 1)[0]; break; }
    if (!h) {
      if (pool.length >= MAX_SPARES) return b;
      h = gl.createBuffer();
      gl.bindBuffer(target, h);
      gl.bufferData(target, size, gl.DYNAMIC_DRAW);
    }
    if (full) { gl.bindBuffer(gl.COPY_WRITE_BUFFER, h); gl.bufferSubData(gl.COPY_WRITE_BUFFER, 0, full); }
    else if (gpuCopy) {
      gl.bindBuffer(gl.COPY_READ_BUFFER, b); gl.bindBuffer(gl.COPY_WRITE_BUFFER, h);
      gl.copyBufferSubData(gl.COPY_READ_BUFFER, gl.COPY_WRITE_BUFFER, 0, 0, size);
    }
    pool.push(b);
    h.__eaglerId = id; h.__eaglerSize = size;
    const registry = globalThis.__eaglerBuffers;
    if (registry) registry.set(id, h);
    this.renames++;
    const d = globalThis.__eaglerFrameTiming;
    if (d) d.counter('e26BufferRenames');
    return h;
  },
  // Frees the spares of a logical buffer being deleted.
  release(gl, id) {
    const pool = gl.__e26Pools && gl.__e26Pools.get(id);
    if (!pool) return;
    gl.__e26Pools.delete(id);
    for (const x of pool) gl.deleteBuffer(x);
  },
};
