// V0.508 terrain meshing worker (see E26WorkerMeshing.java for the protocol and the coverage rules).
//
// A port of vanilla 26.2's section tesselation for block models: SectionCompiler's block loop, ModelBlockRenderer
// (tesselateAmbientOcclusion / tesselateFlat / putQuadWithTint), BlockModelLighter (prepareQuadAmbientOcclusion,
// prepareQuadFlat, prepareQuadShape), Block.shouldRenderFace with the skipRendering overrides, BlockStateModel part
// selection (SingleThreadedRandomSource, WeightedList, MultiPartModel), BlockBehaviour offsets, Mth.getSeed,
// VertexConsumer.putBlockBakedQuad (BLOCK format) and VisGraph. Every float operation is rounded to f32
// (Math.fround) in Java's evaluation order, every long operation is 64-bit (BigInt), so the vertex bytes equal the
// Java compile's. The main thread checks that with ?perf.meshVerify=1.
//
// Messages in: reset {gen, ao, cutoutLeaves, mangrove}, define {gen, words}, job {...}, cancel {id}.
// Message out: result {id, gen, ok, verts[3], layers[3] (transferred), visMode, visCount, vis, spriteCount, sprites, ms}.

const f = Math.fround;
const F_AIR = 1, F_SOLID_RENDER = 2, F_RENDER_MODEL = 4, F_COLLISION_FULL = 8, F_VIEW_BLOCKING = 16, F_EMISSIVE = 32, F_LEAVES = 64,
  F_FLUID = 512, F_SOLID = 1 << 12, F_BLOCKS_MOTION = 1 << 13, F_ICE = 1 << 14, F_OVERLAY_TARGET = 1 << 15, F_PARTIAL_FACES = 1 << 16;
// Direction ordinal: DOWN UP NORTH SOUTH WEST EAST.
const DX = [0, 0, 0, 0, -1, 1], DY = [-1, 1, 0, 0, 0, 0], DZ = [0, 0, -1, 1, 0, 0];
// BlockModelLighter.AdjacencyInfo / AmbientVertexRemap (generated from the Java source).
const ADJ = [{"corners": [4, 5, 2, 3], "w": [[10, 3, 10, 9, 4, 9, 4, 3], [10, 2, 10, 8, 4, 8, 4, 2], [11, 2, 11, 8, 5, 8, 5, 2], [11, 3, 11, 9, 5, 9, 5, 3]]}, {"corners": [5, 4, 2, 3], "w": [[5, 3, 5, 9, 11, 9, 11, 3], [5, 2, 5, 8, 11, 8, 11, 2], [4, 2, 4, 8, 10, 8, 10, 2], [4, 3, 4, 9, 10, 9, 10, 3]]}, {"corners": [1, 0, 5, 4], "w": [[1, 10, 1, 4, 7, 4, 7, 10], [1, 11, 1, 5, 7, 5, 7, 11], [0, 11, 0, 5, 6, 5, 6, 11], [0, 10, 0, 4, 6, 4, 6, 10]]}, {"corners": [4, 5, 0, 1], "w": [[1, 10, 7, 10, 7, 4, 1, 4], [0, 10, 6, 10, 6, 4, 0, 4], [0, 11, 6, 11, 6, 5, 0, 5], [1, 11, 7, 11, 7, 5, 1, 5]]}, {"corners": [1, 0, 2, 3], "w": [[1, 3, 1, 9, 7, 9, 7, 3], [1, 2, 1, 8, 7, 8, 7, 2], [0, 2, 0, 8, 6, 8, 6, 2], [0, 3, 0, 9, 6, 9, 6, 3]]}, {"corners": [0, 1, 2, 3], "w": [[6, 3, 6, 9, 0, 9, 0, 3], [6, 2, 6, 8, 0, 8, 0, 2], [7, 2, 7, 8, 1, 8, 1, 2], [7, 3, 7, 9, 1, 9, 1, 3]]}];
const REMAP = [[0, 1, 2, 3], [2, 3, 0, 1], [3, 0, 1, 2], [0, 1, 2, 3], [3, 0, 1, 2], [1, 2, 3, 0]];
const EPS_MIN = f(1.0E-4), EPS_MAX = f(0.9999);

// ---- tables ------------------------------------------------------------------------------------------------------
let gen = -1, ao = true, cutoutLeaves = true, mangroveId = -1;
let T = null;
function newTables() {
  const n = 1 << 15;
  return {
    size: n, flags: new Int32Array(n), blockId: new Int32Array(n), emission: new Uint8Array(n), dampening: new Uint8Array(n),
    shade: new Float32Array(n), faceOcc: new Int32Array(n), skip: new Uint8Array(n), offType: new Int8Array(n), maxH: new Float32Array(n),
    maxV: new Float32Array(n), seedMode: new Uint8Array(n), seedDx: new Int8Array(n), seedDz: new Int8Array(n), tints: new Uint8Array(n),
    node: new Int32Array(n).fill(-1), fluid: new Int32Array(n).fill(-1), sturdy: new Uint8Array(n), tintKinds: new Int32Array(n), nodes: [], parts: [], fluids: [],
    biomes: [],
    SIN: null, ASIN: null, COS: null,
  };
}
function grow(id) {
  if (id < T.size) return;
  let n = T.size;
  while (n <= id) n *= 2;
  for (const k of ['flags', 'blockId', 'emission', 'dampening', 'shade', 'faceOcc', 'skip', 'offType', 'maxH', 'maxV', 'seedMode', 'seedDx', 'seedDz', 'tints', 'node', 'fluid', 'sturdy', 'tintKinds']) {
    const a = new T[k].constructor(n);
    if (k === 'node' || k === 'fluid') a.fill(-1);
    a.set(T[k]);
    T[k] = a;
  }
  T.size = n;
}
const bitsToDouble = (() => { const u = new Uint32Array(2), d = new Float64Array(u.buffer); return (hi, lo) => { u[1] = hi >>> 0; u[0] = lo >>> 0; return d[0]; }; })();
const doubleBits = (() => { const d = new Float64Array(1), u = new Uint32Array(d.buffer); return v => { d[0] = v; return [u[1], u[0]]; }; })();
const bitsToFloat = (() => { const i = new Int32Array(1), fl = new Float32Array(i.buffer); return b => { i[0] = b; return fl[0]; }; })();

function define(words) {
  let i = 0;
  while (i < words.length) {
    const tag = words[i++];
    if (tag === 1) {
      const id = words[i++];
      grow(id);
      T.flags[id] = words[i++]; T.blockId[id] = words[i++]; T.emission[id] = words[i++]; T.dampening[id] = words[i++];
      T.shade[id] = bitsToFloat(words[i++]); T.faceOcc[id] = words[i++]; T.skip[id] = words[i++]; T.offType[id] = words[i++];
      T.maxH[id] = bitsToFloat(words[i++]); T.maxV[id] = bitsToFloat(words[i++]); T.seedMode[id] = words[i++];
      T.seedDx[id] = words[i++]; T.seedDz[id] = words[i++]; T.tints[id] = words[i++]; T.node[id] = words[i++];
      T.fluid[id] = words[i++]; T.sturdy[id] = words[i++]; T.tintKinds[id] = words[i++];
    } else if (tag === 2) {
      const id = words[i++], kind = words[i++], n = words[i++];
      if (kind === 0) T.nodes[id] = {kind, part: words[i++], random: false};
      else if (kind === 1) {
        const total = words[i++], weights = [], children = [];
        for (let k = 0; k < n; k++) { weights.push(words[i++]); children.push(words[i++]); }
        T.nodes[id] = {kind, total, weights, children, random: true};
      } else {
        const children = [];
        for (let k = 0; k < n; k++) children.push(words[i++]);
        T.nodes[id] = {kind, children, random: true};
      }
    } else if (tag === 3) {
      const id = words[i++], useAO = words[i++] !== 0;
      const counts = [];
      for (let g = 0; g < 7; g++) counts.push(words[i++]);
      const groups = [];
      for (let g = 0; g < 7; g++) {
        const qs = [];
        for (let q = 0; q < counts[g]; q++) {
          const pos = new Float32Array(12);
          for (let k = 0; k < 12; k++) pos[k] = bitsToFloat(words[i++]);
          const uv = new Int32Array(8);
          for (let k = 0; k < 8; k++) uv[k] = words[i++];
          qs.push({pos, uv, dir: words[i++], tint: words[i++], shadeDir: words[i++], emission: words[i++], layer: words[i++], sprite: words[i++]});
        }
        groups.push(qs);
      }
      T.parts[id] = {useAO, groups};
    } else if (tag === 4) {
      const id = words[i++];
      const fl = {family: words[i++], amount: words[i++], falling: words[i++] !== 0, layer: words[i++], tinted: words[i++] !== 0, tintKind: words[i++], sprites: []};
      fl.height = f(fl.amount / 9.0);
      for (let k = 0; k < 3; k++) {
        const present = words[i++] !== 0;
        const sp = {u0: bitsToFloat(words[i++]), u1: bitsToFloat(words[i++]), v0: bitsToFloat(words[i++]), v1: bitsToFloat(words[i++]), id: words[i++]};
        fl.sprites.push(present ? sp : null);
      }
      T.fluids[id] = fl;
    } else if (tag === 5) {
      const n = words[i++];
      T.SIN = new Float32Array(n);
      for (let k = 0; k < n; k++) T.SIN[k] = bitsToFloat(words[i++]);
    } else if (tag === 6) {
      const n = words[i++];
      T.ASIN = new Float64Array(n); T.COS = new Float64Array(n);
      for (let k = 0; k < n; k++) { T.ASIN[k] = bitsToDouble(words[i++], words[i++]); T.COS[k] = bitsToDouble(words[i++], words[i++]); }
    } else if (tag === 7) {
      const id = words[i++];
      T.biomes[id] = {grassKind: words[i++], grass: words[i++], foliage: words[i++], dry: words[i++], water: words[i++]};
    } else {
      throw new Error('mesh worker: bad definition tag ' + tag);
    }
  }
}

// ---- Java arithmetic ---------------------------------------------------------------------------------------------
const MASK48 = (1n << 48n) - 1n, MULT = 0x5DEECE66Dn;
let rngSeed = 0n;
function setSeed(seed) { rngSeed = (seed ^ MULT) & MASK48; }
function next(bits) { rngSeed = (rngSeed * MULT + 11n) & MASK48; return Number(BigInt.asIntN(32, rngSeed >> BigInt(48 - bits))); }
function nextInt(bound) {
  if ((bound & bound - 1) === 0) return Math.floor(bound * next(31) / 2147483648);
  let sample, modulo;
  do { sample = next(31); modulo = sample % bound; } while (((sample - modulo + (bound - 1)) | 0) < 0);
  return modulo;
}
function nextLong() { const upper = next(32), lower = next(32); return BigInt.asIntN(64, (BigInt(upper) << 32n) + BigInt(lower)); }
// Mth.getSeed(x, y, z): x * 3129871 is an int product; the rest is long.
function getSeed(x, y, z) {
  let s = BigInt(Math.imul(x, 3129871)) ^ (BigInt(z) * 116129781n) ^ BigInt(y);
  s = BigInt.asIntN(64, s);
  s = BigInt.asIntN(64, s * s * 42317861n + s * 11n);
  return s >> 16n;
}

// ---- job state -----------------------------------------------------------------------------------------------------
let S, L, TINT, OX, OY, OZ, CARD, FACES;
// Snapshot box: x, y, z in -2..17 (20^3).
const idx = (x, y, z) => (x + 2) + (y + 2) * 20 + (z + 2) * 400;
// Vertex output per layer (BLOCK format, 7 words per vertex).
const out = [0, 1, 2].map(() => ({i32: new Int32Array(1 << 16), n: 0}));
function reserve(layer, words) {
  const o = out[layer];
  if (o.n + words > o.i32.length) {
    let len = o.i32.length * 2;
    while (o.n + words > len) len *= 2;
    const a = new Int32Array(len);
    a.set(o.i32.subarray(0, o.n));
    o.i32 = a;
  }
  const at = o.n;
  o.n += words;
  return at;
}
const f32view = new Float32Array(1), i32view = new Int32Array(f32view.buffer);
const floatBits = v => { f32view[0] = v; return i32view[0]; };
let spriteSeen, spriteList;

// QuadInstance
const color = new Int32Array(4), light = new Int32Array(4);
// BlockModelLighter scratch
const faceShape = new Float32Array(12);
let faceCubic = false, facePartial = false;

function getLightCoords(state, x, y, z) {
  if (T.flags[state] & F_EMISSIVE) return 15728880;
  const packed = L[idx(x, y, z)];
  const block = packed >> 4 & 15, em = T.emission[state];
  return block < em ? (packed & 0xFF0000 | em << 4) : packed;
}
const stateAt = (x, y, z) => S[idx(x, y, z)];
const as8 = v => Math.floor(f(v * 255.0));
const gray = b => { const c = as8(b); return (255 << 24 | (c & 255) << 16 | (c & 255) << 8 | c & 255) | 0; };
const clamp01 = v => Math.min(1.0, Math.max(v, 0.0));
function multiplyColor(lhs, rhs) {
  if (lhs === -1) return rhs;
  if (rhs === -1) return lhs;
  const a = Math.trunc((lhs >>> 24) * (rhs >>> 24) / 255), r = Math.trunc((lhs >> 16 & 255) * (rhs >> 16 & 255) / 255);
  const g = Math.trunc((lhs >> 8 & 255) * (rhs >> 8 & 255) / 255), b = Math.trunc((lhs & 255) * (rhs & 255) / 255);
  return ((a & 255) << 24 | (r & 255) << 16 | (g & 255) << 8 | b & 255) | 0;
}
function scaleRGB(c, s) {
  const r = Math.min(255, Math.max(0, Math.trunc(f((c >> 16 & 255) * s)))), g = Math.min(255, Math.max(0, Math.trunc(f((c >> 8 & 255) * s))));
  const b = Math.min(255, Math.max(0, Math.trunc(f((c & 255) * s))));
  return ((c >>> 24 & 255) << 24 | r << 16 | g << 8 | b) | 0;
}
const sky = p => p >> 20 & 15, blk = p => p >> 4 & 15;
function smoothBlend(n1, n2, n3, center) {
  if (sky(center) > 2 || blk(center) > 2) {
    if (n1 === 0) n1 = center; else if (sky(n1) === 0) n1 |= center & 0xFF0000;
    if (n2 === 0) n2 = center; else if (sky(n2) === 0) n2 |= center & 0xFF0000;
    if (n3 === 0) n3 = center; else if (sky(n3) === 0) n3 |= center & 0xFF0000;
  }
  return (n1 + n2 + n3 + center | 0) >> 2 & 16711935;
}
function smoothWeightedBlend(c1, c2, c3, c4, w1, w2, w3, w4) {
  const s = Math.trunc(f(f(f(f((c1 >> 16 & 255) * w1) + f((c2 >> 16 & 255) * w2)) + f((c3 >> 16 & 255) * w3)) + f((c4 >> 16 & 255) * w4)));
  const b = Math.trunc(f(f(f(f((c1 & 255) * w1) + f((c2 & 255) * w2)) + f((c3 & 255) * w3)) + f((c4 & 255) * w4)));
  return b & 255 | (s & 255) << 16;
}
function withEmission(lc, e) {
  if (e === 0) return lc;
  return Math.max(blk(lc), e) << 4 | Math.max(sky(lc), e) << 20;
}

function prepareQuadShape(state, q, withAO) {
  let minX = f(32.0), minY = f(32.0), minZ = f(32.0), maxX = f(-32.0), maxY = f(-32.0), maxZ = f(-32.0);
  const p = q.pos;
  for (let i = 0; i < 4; i++) {
    const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
    minX = Math.min(minX, x); minY = Math.min(minY, y); minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); maxZ = Math.max(maxZ, z);
  }
  if (withAO) {
    faceShape[4] = minX; faceShape[5] = maxX; faceShape[0] = minY; faceShape[1] = maxY; faceShape[2] = minZ; faceShape[3] = maxZ;
    faceShape[10] = f(1.0 - minX); faceShape[11] = f(1.0 - maxX); faceShape[6] = f(1.0 - minY); faceShape[7] = f(1.0 - maxY);
    faceShape[8] = f(1.0 - minZ); faceShape[9] = f(1.0 - maxZ);
  }
  const d = q.dir;
  facePartial = d <= 1 ? (minX >= EPS_MIN || minZ >= EPS_MIN || maxX <= EPS_MAX || maxZ <= EPS_MAX)
    : d <= 3 ? (minX >= EPS_MIN || minY >= EPS_MIN || maxX <= EPS_MAX || maxY <= EPS_MAX)
    : (minY >= EPS_MIN || minZ >= EPS_MIN || maxY <= EPS_MAX || maxZ <= EPS_MAX);
  const full = (T.flags[state] & F_COLLISION_FULL) !== 0;
  switch (d) {
    case 0: faceCubic = minY === maxY && (minY < EPS_MIN || full); break;
    case 1: faceCubic = minY === maxY && (maxY > EPS_MAX || full); break;
    case 2: faceCubic = minZ === maxZ && (minZ < EPS_MIN || full); break;
    case 3: faceCubic = minZ === maxZ && (maxZ > EPS_MAX || full); break;
    case 4: faceCubic = minX === maxX && (minX < EPS_MIN || full); break;
    default: faceCubic = minX === maxX && (maxX > EPS_MAX || full);
  }
}

function prepareAO(state, x, y, z, q) {
  prepareQuadShape(state, q, true);
  const d = q.dir, info = ADJ[d], c = info.corners;
  const bx = faceCubic ? x + DX[d] : x, by = faceCubic ? y + DY[d] : y, bz = faceCubic ? z + DZ[d] : z;
  const cx = i => bx + DX[c[i]], cy = i => by + DY[c[i]], cz = i => bz + DZ[c[i]];
  const s0 = stateAt(cx(0), cy(0), cz(0)), light0 = getLightCoords(s0, cx(0), cy(0), cz(0)), shade0 = T.shade[s0];
  const s1 = stateAt(cx(1), cy(1), cz(1)), light1 = getLightCoords(s1, cx(1), cy(1), cz(1)), shade1 = T.shade[s1];
  const s2 = stateAt(cx(2), cy(2), cz(2)), light2 = getLightCoords(s2, cx(2), cy(2), cz(2)), shade2 = T.shade[s2];
  const s3 = stateAt(cx(3), cy(3), cz(3)), light3 = getLightCoords(s3, cx(3), cy(3), cz(3)), shade3 = T.shade[s3];
  // 26.3 BlockModelLighter: corner occlusion is BlockState.isLightPermeable() = !solidRender || lightDampening == 0.
  const trans = i => { const st = stateAt(cx(i) + DX[d], cy(i) + DY[d], cz(i) + DZ[d]); return (T.flags[st] & F_SOLID_RENDER) === 0 || T.dampening[st] === 0; };
  const t0 = trans(0), t1 = trans(1), t2 = trans(2), t3 = trans(3);
  const diag = (a, b) => { const px = cx(a) + DX[c[b]], py = cy(a) + DY[c[b]], pz = cz(a) + DZ[c[b]], st = stateAt(px, py, pz); return [T.shade[st], getLightCoords(st, px, py, pz)]; };
  let sc02, lc02, sc03, lc03, sc12, lc12, sc13, lc13;
  if (!t2 && !t0) { sc02 = shade0; lc02 = light0; } else [sc02, lc02] = diag(0, 2);
  if (!t3 && !t0) { sc03 = shade0; lc03 = light0; } else [sc03, lc03] = diag(0, 3);
  if (!t2 && !t1) { sc12 = shade0; lc12 = light0; } else [sc12, lc12] = diag(1, 2);
  if (!t3 && !t1) { sc13 = shade0; lc13 = light0; } else [sc13, lc13] = diag(1, 3);
  let lightCenter = getLightCoords(state, x, y, z);
  const nx = x + DX[d], ny = y + DY[d], nz = z + DZ[d], nextState = stateAt(nx, ny, nz);
  if (faceCubic || (T.flags[nextState] & F_SOLID_RENDER) === 0) lightCenter = getLightCoords(nextState, nx, ny, nz);
  const shadeCenter = faceCubic ? T.shade[stateAt(bx, by, bz)] : T.shade[state];
  const r = REMAP[d];
  const t1s = f(f(f(f(shade3 + shade0) + sc03) + shadeCenter) * 0.25), t2s = f(f(f(f(shade2 + shade0) + sc02) + shadeCenter) * 0.25);
  const t3s = f(f(f(f(shade2 + shade1) + sc12) + shadeCenter) * 0.25), t4s = f(f(f(f(shade3 + shade1) + sc13) + shadeCenter) * 0.25);
  if (facePartial) {
    const w = info.w;
    const vw = v => [f(faceShape[w[v][0]] * faceShape[w[v][1]]), f(faceShape[w[v][2]] * faceShape[w[v][3]]),
      f(faceShape[w[v][4]] * faceShape[w[v][5]]), f(faceShape[w[v][6]] * faceShape[w[v][7]])];
    const W = [vw(0), vw(1), vw(2), vw(3)];
    for (let v = 0; v < 4; v++) {
      const [a, b, cc, dd] = W[v];
      color[r[v]] = gray(clamp01(f(f(f(f(t1s * a) + f(t2s * b)) + f(t3s * cc)) + f(t4s * dd))));
    }
    const tc1 = smoothBlend(light3, light0, lc03, lightCenter), tc2 = smoothBlend(light2, light0, lc02, lightCenter);
    const tc3 = smoothBlend(light2, light1, lc12, lightCenter), tc4 = smoothBlend(light3, light1, lc13, lightCenter);
    for (let v = 0; v < 4; v++) light[r[v]] = smoothWeightedBlend(tc1, tc2, tc3, tc4, W[v][0], W[v][1], W[v][2], W[v][3]);
  } else {
    light[r[0]] = smoothBlend(light3, light0, lc03, lightCenter);
    light[r[1]] = smoothBlend(light2, light0, lc02, lightCenter);
    light[r[2]] = smoothBlend(light2, light1, lc12, lightCenter);
    light[r[3]] = smoothBlend(light3, light1, lc13, lightCenter);
    color[r[0]] = gray(t1s); color[r[1]] = gray(t2s); color[r[2]] = gray(t3s); color[r[3]] = gray(t4s);
  }
  // 26.3 getDirectionalBrightness: shadeDirectionOverride (sent as 1 + ordinal, 0 = none) else the quad's face.
  const scale = q.shadeDir ? CARD[q.shadeDir - 1] : CARD[d];
  for (let v = 0; v < 4; v++) color[v] = scaleRGB(color[v], scale);
}

function prepareFlat(state, x, y, z, lightCoords, q) {
  if (lightCoords === -1) {
    prepareQuadShape(state, q, false);
    const d = q.dir;
    lightCoords = faceCubic ? getLightCoords(state, x + DX[d], y + DY[d], z + DZ[d]) : getLightCoords(state, x, y, z);
  }
  light[0] = light[1] = light[2] = light[3] = lightCoords;
  const g = gray(q.shadeDir ? CARD[q.shadeDir - 1] : CARD[q.dir]);
  color[0] = color[1] = color[2] = color[3] = g;
}

function putQuad(state, x, y, z, fx, fy, fz, q) {
  if (q.tint !== -1) {
    const tc = q.tint < T.tints[state] ? blockTint(state, q.tint, x, y, z) : -1;
    for (let v = 0; v < 4; v++) color[v] = multiplyColor(color[v], tc);
  }
  if (q.sprite >= 0 && !spriteSeen.has(q.sprite)) { spriteSeen.add(q.sprite); spriteList.push(q.sprite); }
  const layer = !cutoutLeaves && (T.flags[state] & F_LEAVES) ? 0 : q.layer;
  const o = out[layer];
  const at = reserve(layer, 28);
  const a = o.i32, p = q.pos;
  for (let v = 0; v < 4; v++) {
    const k = at + v * 7;
    a[k] = floatBits(f(p[v * 3] + fx));
    a[k + 1] = floatBits(f(p[v * 3 + 1] + fy));
    a[k + 2] = floatBits(f(p[v * 3 + 2] + fz));
    const c = color[v];
    a[k + 3] = c & -16711936 | (c & 0xFF0000) >>> 16 | (c & 0xFF) << 16;
    a[k + 4] = q.uv[v * 2];
    a[k + 5] = q.uv[v * 2 + 1];
    a[k + 6] = withEmission(light[v], q.emission);
  }
}

function shouldRenderFace(state, d, x, y, z) {
  if (T.flags[state] & F_PARTIAL_FACES) {
    // Blocks with partial own faces: the main thread's Block.shouldRenderFace result (bit 6 = present). The buffer
    // is reused between jobs, so only these blocks' entries are current.
    const m = FACES ? FACES[x + y * 16 + z * 256] : 0;
    if (!(m & 64)) throw new Error('partial-face block without a face mask');
    return (m >> d & 1) !== 0;
  }
  const n = stateAt(x + DX[d], y + DY[d], z + DZ[d]);
  const occ = T.faceOcc[n] >> ((d ^ 1) * 2) & 3;
  if (occ === 1) return false;
  const rule = T.skip[state];
  if (rule === 1 && T.blockId[n] === T.blockId[state]) return false;
  if (rule === 2 && !cutoutLeaves && (T.flags[n] & F_LEAVES)) return false;
  if (rule === 3 && T.blockId[n] === mangroveId && d <= 1) return false;
  if (occ === 0) return true;
  const own = T.faceOcc[state] >> (d * 2) & 3;
  if (own === 0) return true;
  return occ === 3;
}

function collect(nodeId, parts) {
  const node = T.nodes[nodeId];
  if (node.kind === 0) parts.push(T.parts[node.part]);
  else if (node.kind === 1) {
    let sel = nextInt(node.total);
    for (let k = 0; k < node.children.length; k++) {
      sel -= node.weights[k];
      if (sel < 0) { collect(node.children[k], parts); return; }
    }
    throw new Error('weighted selection exceeded total');
  } else {
    const seed = nextLong();
    for (const child of node.children) { setSeed(seed); collect(child, parts); }
  }
}
const parts = [];

function tesselateBlock(state, x, y, z) {
  const nodeId = T.node[state];
  if (nodeId < 0) throw new Error('state without model ' + state);
  const node = T.nodes[nodeId];
  parts.length = 0;
  if (node.random) {
    const wx = OX + x, wy = OY + y, wz = OZ + z, mode = T.seedMode[state];
    setSeed(mode === 1 ? getSeed(wx, wy - 1, wz) : getSeed(wx + T.seedDx[state], wy, wz + T.seedDz[state]));
  }
  collect(nodeId, parts);
  if (parts.length === 0) return;
  let ox = 0, oy = 0, oz = 0;
  const type = T.offType[state];
  if (type > 0) {
    const seed = getSeed(OX + x, 0, OZ + z), mh = T.maxH[state];
    const n0 = Number(seed & 15n), n8 = Number(seed >> 8n & 15n), n4 = Number(seed >> 4n & 15n);
    // Mth.clamp(double, double, double): value < min ? min : Math.min(value, max).
    const clampD = (v, lo, hi) => v < lo ? lo : Math.min(v, hi);
    ox = clampD((f(n0 / 15.0) - 0.5) * 0.5, -mh, mh);
    oz = clampD((f(n8 / 15.0) - 0.5) * 0.5, -mh, mh);
    if (type === 2) oy = (f(n4 / 15.0) - 1.0) * T.maxV[state];
  }
  const fx = f(x + f(ox)), fy = f(y + f(oy)), fz = f(z + f(oz));
  let cacheValid = 0, cache = 0;
  const useAO = ao && T.emission[state] === 0 && parts[0].useAO;
  for (const part of parts) {
    for (let d = 0; d < 6; d++) {
      const mask = 1 << d;
      const valid = (cacheValid & mask) !== 0;
      let render = (cache & mask) !== 0;
      if (!valid || render) {
        const quads = part.groups[d];
        if (quads.length) {
          if (!valid) {
            render = shouldRenderFace(state, d, x, y, z);
            cacheValid |= mask;
            if (render) cache |= mask;
          }
          if (render) {
            if (useAO) {
              for (const q of quads) { prepareAO(state, x, y, z, q); putQuad(state, x, y, z, fx, fy, fz, q); }
            } else {
              const lc = getLightCoords(state, x + DX[d], y + DY[d], z + DZ[d]);
              for (const q of quads) { prepareFlat(state, x, y, z, lc, q); putQuad(state, x, y, z, fx, fy, fz, q); }
            }
          }
        }
      }
    }
    for (const q of part.groups[6]) {
      if (useAO) prepareAO(state, x, y, z, q); else prepareFlat(state, x, y, z, -1, q);
      putQuad(state, x, y, z, fx, fy, fz, q);
    }
  }
}

// ---- biome tint (ClientLevel.calculateBlockTint, BiomeManager.getBiome, BiomeColors resolvers) --------------------
// Tint kinds: 0 = value from the main thread, 1 grass, 3 grass of the block below, 4 foliage, 5 dry foliage, 6 water.
let BIO = null;
function blockTint(state, index, x, y, z) {
  const kind = T.tintKinds[state] >> index * 4 & 15;
  if (kind === 0) return TINT[(x + y * 16 + z * 256) * 3 + index];
  return kind === 3 ? biomeTint(1, OX + x, OY + y - 1, OZ + z) : biomeTint(kind, OX + x, OY + y, OZ + z);
}
// LinearCongruentialGenerator.next(rval, c) = rval * (rval * 6364136223846793005 + 1442695040888963407) + c (64-bit).
const lcg = (r, c) => BigInt.asIntN(64, r * BigInt.asIntN(64, r * 6364136223846793005n + 1442695040888963407n) + c);
const fiddle = r => { const u = Number(((r >> 24n) % 1024n + 1024n) % 1024n) / 1024.0; return (u - 0.5) * 0.9; };
// Per job caches (typed arrays over the snapshot's grids): corner fiddles by quart cell, biome by block position.
function cornerFiddle(cx, cy, cz) {
  const gx = cx - BIO.qx0, gy = cy - BIO.qy0, gz = cz - BIO.qz0;
  if (gx < 0 || gy < 0 || gz < 0 || gx >= BIO.nx || gy >= BIO.ny || gz >= BIO.nz) throw new Error('fiddle corner outside the snapshot grid');
  const k = (gx + gy * BIO.nx + gz * BIO.nx * BIO.ny) * 3, F = BIO.fid;
  if (!Number.isNaN(F[k])) return k;
  const X = BigInt(cx), Y = BigInt(cy), Z = BigInt(cz), seed = BIO.seed;
  let r = seed;
  r = lcg(r, X); r = lcg(r, Y); r = lcg(r, Z); r = lcg(r, X); r = lcg(r, Y); r = lcg(r, Z);
  F[k] = fiddle(r); r = lcg(r, seed);
  F[k + 1] = fiddle(r); r = lcg(r, seed);
  F[k + 2] = fiddle(r);
  return k;
}
function getBiome(wx, wy, wz) {
  const bi = (wx - BIO.bx0) + (wz - BIO.bz0) * BIO.bw + (wy - BIO.by0) * BIO.bw * BIO.bw;
  const inBox = wx >= BIO.bx0 && wz >= BIO.bz0 && wy >= BIO.by0 && wx - BIO.bx0 < BIO.bw && wz - BIO.bz0 < BIO.bw && wy - BIO.by0 < 17;
  if (inBox) { const c = BIO.bcache[bi]; if (c >= 0) return T.biomes[c]; }
  const id = getBiomeId(wx, wy, wz);
  if (inBox) BIO.bcache[bi] = id;
  return T.biomes[id];
}
function getBiomeId(wx, wy, wz) {
  const ax = wx - 2, ay = wy - 2, az = wz - 2;
  const px = ax >> 2, py = ay >> 2, pz = az >> 2;
  const fx = (ax & 3) / 4.0, fy = (ay & 3) / 4.0, fz = (az & 3) / 4.0;
  let minI = 0, min = Infinity;
  for (let i = 0; i < 8; i++) {
    const xe = (i & 4) === 0, ye = (i & 2) === 0, ze = (i & 1) === 0;
    const cx = xe ? px : px + 1, cy = ye ? py : py + 1, cz = ze ? pz : pz + 1;
    const dx = xe ? fx : fx - 1.0, dy = ye ? fy : fy - 1.0, dz = ze ? fz : fz - 1.0;
    const k = cornerFiddle(cx, cy, cz), F = BIO.fid;
    const a = dz + F[k + 2], b = dy + F[k + 1], c = dx + F[k];
    const next = a * a + b * b + c * c;
    if (min > next) { minI = i; min = next; }
  }
  const bx = (minI & 4) === 0 ? px : px + 1, by = (minI & 2) === 0 ? py : py + 1, bz = (minI & 1) === 0 ? pz : pz + 1;
  const gx = bx - BIO.qx0, gy = by - BIO.qy0, gz = bz - BIO.qz0;
  if (gx < 0 || gy < 0 || gz < 0 || gx >= BIO.nx || gy >= BIO.ny || gz >= BIO.nz) throw new Error('biome outside the snapshot grid');
  return BIO.grid[gx + gy * BIO.nx + gz * BIO.nx * BIO.ny];
}
function resolve(kind, b, x, z) {
  if (kind === 1) {
    if (b.grassKind === 0) return b.grass;
    const sx = x - BIO.sx0, sz = z - BIO.sz0;
    if (!BIO.swamp || sx < 0 || sz < 0 || sx >= BIO.sw || sz >= BIO.sw) throw new Error('swamp column outside the snapshot');
    return BIO.swamp[sx + sz * BIO.sw] ? -11766212 : -9801671;
  }
  return kind === 4 ? b.foliage : kind === 5 ? b.dry : b.water;
}
const KIND_SLOT = [-1, 0, -1, -1, 1, 2, 3];
function biomeTint(kind, wx, wy, wz) {
  if (!BIO) throw new Error('biome tint without biome data');
  // Cache by (kind, section-local x, y in -1..15, z); tints are only asked for there.
  const lx = wx - OX, ly = wy - OY + 1, lz = wz - OZ, slot = KIND_SLOT[kind];
  const ti = lx >= 0 && lx < 16 && lz >= 0 && lz < 16 && ly >= 0 && ly < 17 && slot >= 0 ? ((slot * 17 + ly) * 16 + lz) * 16 + lx : -1;
  if (ti >= 0 && BIO.tset[ti]) return BIO.tval[ti];
  const r = BIO.radius;
  let color;
  if (r === 0) color = resolve(kind, getBiome(wx, wy, wz), wx, wz);
  else {
    const count = (r * 2 + 1) * (r * 2 + 1);
    let tr = 0, tg = 0, tb = 0;
    for (let z = wz - r; z <= wz + r; z++) for (let x = wx - r; x <= wx + r; x++) {
      const c = resolve(kind, getBiome(x, wy, z), x, z);
      tr += c >> 16 & 255; tg += c >> 8 & 255; tb += c & 255;
    }
    color = (255 << 24 | (Math.trunc(tr / count) & 255) << 16 | (Math.trunc(tg / count) & 255) << 8 | Math.trunc(tb / count) & 255) | 0;
  }
  if (ti >= 0) { BIO.tset[ti] = 1; BIO.tval[ti] = color; }
  return color;
}

// ---- fluids (FluidRenderer) ------------------------------------------------------------------------------------------
// A section the port cannot render exactly (a partial occlusion shape next to a fluid face) is handed back to Java.
class Bail extends Error {}
const famOf = st => { const fs = T.fluid[st]; return fs < 0 ? 0 : T.fluids[fs].family; };
const ownHeight = st => { const fs = T.fluid[st]; return fs < 0 ? 0 : T.fluids[fs].height; };
function occludedByState(d, height, st) {
  const occ = T.faceOcc[st] >> ((d ^ 1) * 2) & 3;
  if (occ === 0) return false;
  if (occ === 1) return d !== 1 || height === 1.0;
  throw new Bail('partial occluder next to a fluid face');
}
const occludedBySelf = (st, d) => occludedByState(d ^ 1, 1.0, st);
const fluidFaceVisible = (fam, st, d, nst) => famOf(nst) !== fam && !occludedBySelf(st, d);
function fluidHeight(fam, x, y, z, st) {
  if (famOf(st) === fam) return famOf(stateAt(x, y + 1, z)) === fam ? 1.0 : ownHeight(st);
  return (T.flags[st] & F_SOLID) === 0 ? 0.0 : -1.0;
}
function addWeighted(w, h) {
  if (h >= f(0.8)) { w[0] = f(w[0] + f(h * 10.0)); w[1] = f(w[1] + 10.0); }
  else if (h >= 0.0) { w[0] = f(w[0] + h); w[1] = f(w[1] + 1); }
}
function averageHeight(fam, hSelf, h2, h1, cx, cy, cz) {
  if (!(h1 >= 1.0) && !(h2 >= 1.0)) {
    const w = [0, 0];
    if (h1 > 0.0 || h2 > 0.0) {
      const hc = fluidHeight(fam, cx, cy, cz, stateAt(cx, cy, cz));
      if (hc >= 1.0) return 1.0;
      addWeighted(w, hc);
    }
    addWeighted(w, hSelf); addWeighted(w, h1); addWeighted(w, h2);
    return f(w[0] / w[1]);
  }
  return 1.0;
}
// LightCoordsUtil.getLightCoords(level, pos) (state at pos) and FluidRenderer.getLightCoords (max with the block above).
const lightAt = (x, y, z) => getLightCoords(stateAt(x, y, z), x, y, z);
function fluidLight(x, y, z) {
  const a = lightAt(x, y, z), b = lightAt(x, y + 1, z);
  return Math.max(blk(a), blk(b)) << 4 | Math.max(sky(a), sky(b)) << 20;
}
// Direction.Plane.HORIZONTAL order: NORTH EAST SOUTH WEST.
const HORIZONTAL = [2, 5, 3, 4];
function isSolidFace(fam, x, y, z, d) {
  const st = stateAt(x, y, z);
  if (famOf(st) === fam) return false;
  if (d === 1) return true;
  if (T.flags[st] & F_ICE) return false;
  return (T.sturdy[st] >> d & 1) !== 0;
}
function normalize(v) {
  const dist = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  return dist < f(1.0E-5) ? [0, 0, 0] : [v[0] / dist, v[1] / dist, v[2] / dist];
}
function getFlow(st, x, y, z) {
  const fam = famOf(st), own = ownHeight(st);
  let fx = 0.0, fz = 0.0;
  for (const d of HORIZONTAL) {
    const nx = x + DX[d], nz = z + DZ[d], nst = stateAt(nx, y, nz), nfam = famOf(nst);
    if (nfam === 0 || nfam === fam) {
      let nh = ownHeight(nst), dist = 0;
      if (nh === 0.0) {
        if ((T.flags[nst] & F_BLOCKS_MOTION) === 0) {
          const bst = stateAt(nx, y - 1, nz), bfam = famOf(bst);
          if (bfam === 0 || bfam === fam) {
            nh = ownHeight(bst);
            if (nh > 0.0) dist = f(own - f(nh - f(0.8888889)));
          }
        }
      } else if (nh > 0.0) dist = f(own - nh);
      if (dist !== 0) { fx += f(DX[d] * dist); fz += f(DZ[d] * dist); }
    }
  }
  let flow = [fx, 0.0, fz];
  if (T.fluids[T.fluid[st]].falling) {
    for (const d of HORIZONTAL) {
      const px = x + DX[d], pz = z + DZ[d];
      if (isSolidFace(fam, px, y, pz, d) || isSolidFace(fam, px, y + 1, pz, d)) {
        const n = normalize(flow);
        flow = [n[0] + 0.0, n[1] + -6.0, n[2] + 0.0];
        break;
      }
    }
  }
  return normalize(flow);
}
const FRAC_BIAS = bitsToDouble(0x42B00000, 0x00000000);
function fastInvSqrt(x) {
  const xhalf = 0.5 * x;
  const [hi, lo] = doubleBits(x);
  let i = BigInt.asIntN(64, (BigInt(hi) << 32n) | BigInt(lo));
  i = BigInt.asIntN(64, 6910469410427058090n - (i >> 1n));
  const u = BigInt.asUintN(64, i);
  const y = bitsToDouble(Number(u >> 32n), Number(u & 0xFFFFFFFFn));
  return y * (1.5 - xhalf * y * y);
}
function atan2(y, x) {
  const d2 = x * x + y * y;
  if (Number.isNaN(d2)) return NaN;
  const negY = y < 0.0; if (negY) y = -y;
  const negX = x < 0.0; if (negX) x = -x;
  const steep = y > x; if (steep) { const t = x; x = y; y = t; }
  const rinv = fastInvSqrt(d2);
  x *= rinv; y *= rinv;
  const yp = FRAC_BIAS + y;
  const index = doubleBits(yp)[1] | 0;
  const phi = T.ASIN[index], cPhi = T.COS[index], sPhi = yp - FRAC_BIAS;
  const sd = y * cPhi - x * sPhi;
  const dd = (6.0 + sd * sd) * sd * 0.16666666666666666;
  let theta = phi + dd;
  if (steep) theta = Math.PI / 2 - theta;
  if (negX) theta = Math.PI - theta;
  if (negY) theta = -theta;
  return theta;
}
const sinIndex = v => { const t = Math.trunc(v); return ((t % 65536) + 65536) % 65536; };
const mthSin = i => T.SIN[sinIndex(i * 10430.378350470453)];
const mthCos = i => T.SIN[sinIndex(i * 10430.378350470453 + 16384.0)];
const spriteU = (sp, o) => f(sp.u0 + f(f(sp.u1 - sp.u0) * o));
const spriteV = (sp, o) => f(sp.v0 + f(f(sp.v1 - sp.v0) * o));
function fluidVertex(layer, x, y, z, c, u, v, l) {
  const at = reserve(layer, 7), a = out[layer].i32;
  a[at] = floatBits(x); a[at + 1] = floatBits(y); a[at + 2] = floatBits(z);
  a[at + 3] = c & -16711936 | (c & 0xFF0000) >>> 16 | (c & 0xFF) << 16;
  a[at + 4] = floatBits(u); a[at + 5] = floatBits(v); a[at + 6] = l;
}
function addFace(layer, v, c, l, back) {
  for (let k = 0; k < 4; k++) fluidVertex(layer, v[k][0], v[k][1], v[k][2], c, v[k][3], v[k][4], l);
  if (back) for (const k of [0, 3, 2, 1]) fluidVertex(layer, v[k][0], v[k][1], v[k][2], c, v[k][3], v[k][4], l);
}
function backwardUpFace(fam, x, y, z) {
  for (let ox = -1; ox <= 1; ox++) for (let oz = -1; oz <= 1; oz++) {
    const st = stateAt(x + ox, y, z + oz);
    if (famOf(st) !== fam && (T.flags[st] & F_SOLID_RENDER) === 0) return true;
  }
  return false;
}
function tesselateFluid(st, x, y, z) {
  const fl = T.fluids[T.fluid[st]], fam = fl.family;
  const sDown = stateAt(x, y - 1, z), sUp = stateAt(x, y + 1, z), sN = stateAt(x, y, z - 1), sS = stateAt(x, y, z + 1);
  const sW = stateAt(x - 1, y, z), sE = stateAt(x + 1, y, z);
  const renderUp = famOf(sUp) !== fam;
  const renderDown = fluidFaceVisible(fam, st, 0, sDown) && !occludedByState(0, f(0.8888889), sDown);
  const renderNorth = fluidFaceVisible(fam, st, 2, sN), renderSouth = fluidFaceVisible(fam, st, 3, sS);
  const renderWest = fluidFaceVisible(fam, st, 4, sW), renderEast = fluidFaceVisible(fam, st, 5, sE);
  if (!(renderUp || renderDown || renderEast || renderWest || renderNorth || renderSouth)) return;
  const layer = fl.layer;
  const tint = !fl.tinted ? -1 : fl.tintKind !== 0 ? biomeTint(fl.tintKind, OX + x, OY + y, OZ + z) : TINT[(x + y * 16 + z * 256) * 3 + 2];
  const hSelf = fluidHeight(fam, x, y, z, st);
  let hNE, hNW, hSE, hSW;
  if (hSelf >= 1.0) { hNE = hNW = hSE = hSW = 1.0; }
  else {
    const hN = fluidHeight(fam, x, y, z - 1, sN), hS = fluidHeight(fam, x, y, z + 1, sS), hE = fluidHeight(fam, x + 1, y, z, sE), hW = fluidHeight(fam, x - 1, y, z, sW);
    hNE = averageHeight(fam, hSelf, hN, hE, x + 1, y, z - 1);
    hNW = averageHeight(fam, hSelf, hN, hW, x - 1, y, z - 1);
    hSE = averageHeight(fam, hSelf, hS, hE, x + 1, y, z + 1);
    hSW = averageHeight(fam, hSelf, hS, hW, x - 1, y, z + 1);
  }
  const X = f(x), Y = f(y), Z = f(z), offs = f(0.001);
  const bottomOffs = renderDown ? offs : 0.0;
  if (renderUp && !occludedByState(1, Math.min(Math.min(hNW, hSW), Math.min(hSE, hNE)), sUp)) {
    hNW = f(hNW - offs); hSW = f(hSW - offs); hSE = f(hSE - offs); hNE = f(hNE - offs);
    const flow = getFlow(st, x, y, z);
    let u00, u01, u10, u11, v00, v01, v10, v11;
    if (flow[0] === 0.0 && flow[2] === 0.0) {
      const sp = fl.sprites[0];
      u00 = sp.u0; v00 = sp.v0; u01 = u00; v01 = sp.v1; u10 = sp.u1; v10 = v01; u11 = u10; v11 = v00;
    } else {
      const angle = f(f(atan2(flow[2], flow[0])) - f(Math.PI / 2));
      const sn = f(mthSin(angle) * 0.25), cs = f(mthCos(angle) * 0.25);
      const sp = fl.sprites[1];
      u00 = spriteU(sp, f(0.5 + f(-cs - sn))); v00 = spriteV(sp, f(0.5 + f(-cs + sn)));
      u01 = spriteU(sp, f(0.5 + f(-cs + sn))); v01 = spriteV(sp, f(0.5 + f(cs + sn)));
      u10 = spriteU(sp, f(0.5 + f(cs + sn))); v10 = spriteV(sp, f(0.5 + f(cs - sn)));
      u11 = spriteU(sp, f(0.5 + f(cs - sn))); v11 = spriteV(sp, f(0.5 + f(-cs - sn)));
    }
    const topLight = fluidLight(x, y, z), topColor = scaleRGB(tint, CARD[1]);
    addFace(layer, [[f(X + 0.0), f(Y + hNW), f(Z + 0.0), u00, v00], [f(X + 0.0), f(Y + hSW), f(Z + 1.0), u01, v01],
      [f(X + 1.0), f(Y + hSE), f(Z + 1.0), u10, v10], [f(X + 1.0), f(Y + hNE), f(Z + 0.0), u11, v11]], topColor, topLight, backwardUpFace(fam, x, y + 1, z));
  }
  if (renderDown) {
    const sp = fl.sprites[0];
    const belowLight = fluidLight(x, y - 1, z), belowColor = scaleRGB(tint, CARD[0]);
    const yb = f(Y + bottomOffs);
    addFace(layer, [[X, yb, Z, sp.u0, sp.v0], [f(X + 1.0), yb, Z, sp.u1, sp.v0], [f(X + 1.0), yb, f(Z + 1.0), sp.u1, sp.v1], [X, yb, f(Z + 1.0), sp.u0, sp.v1]],
      belowColor, belowLight, false);
  }
  const sideLight = fluidLight(x, y, z);
  for (const d of HORIZONTAL) {
    let hh0, hh1, x0, z0, x1, z1, cond, fst;
    if (d === 2) { hh0 = hNW; hh1 = hNE; x0 = X; x1 = f(X + 1.0); z0 = f(Z + offs); z1 = f(Z + offs); cond = renderNorth; fst = sN; }
    else if (d === 3) { hh0 = hSE; hh1 = hSW; x0 = f(X + 1.0); x1 = X; z0 = f(f(Z + 1.0) - offs); z1 = f(f(Z + 1.0) - offs); cond = renderSouth; fst = sS; }
    else if (d === 4) { hh0 = hSW; hh1 = hNW; x0 = f(X + offs); x1 = f(X + offs); z0 = f(Z + 1.0); z1 = Z; cond = renderWest; fst = sW; }
    else { hh0 = hNE; hh1 = hSE; x0 = f(f(X + 1.0) - offs); x1 = f(f(X + 1.0) - offs); z0 = Z; z1 = f(Z + 1.0); cond = renderEast; fst = sE; }
    if (cond && !occludedByState(d, Math.max(hh0, hh1), fst)) {
      let sp = fl.sprites[1], overlay = false;
      if (fl.sprites[2] && (T.flags[fst] & F_OVERLAY_TARGET)) { sp = fl.sprites[2]; overlay = true; }
      const u0 = spriteU(sp, 0.0), u1 = spriteU(sp, f(0.5));
      const v01 = spriteV(sp, f(f(1.0 - hh0) * 0.5)), v02 = spriteV(sp, f(f(1.0 - hh1) * 0.5)), v1 = spriteV(sp, f(0.5));
      const shadeSide = d <= 3 ? CARD[2] : CARD[4];
      const faceColor = scaleRGB(tint, f(CARD[1] * shadeSide));
      const yb = f(Y + bottomOffs);
      addFace(layer, [[x0, f(Y + hh0), z0, u0, v01], [x1, f(Y + hh1), z1, u1, v02], [x1, yb, z1, u1, v1], [x0, yb, z0, u0, v1]], faceColor, sideLight, !overlay);
    }
  }
}

// ---- VisGraph ------------------------------------------------------------------------------------------------------
const visBits = new Uint8Array(4096);
let visEmpty = 4096;
const EDGES = (() => {
  const r = [];
  for (let x = 0; x < 16; x++) for (let y = 0; y < 16; y++) for (let z = 0; z < 16; z++)
    if (x === 0 || x === 15 || y === 0 || y === 15 || z === 0 || z === 15) r.push(x | y << 8 | z << 4);
  return r;
})();
const queue = new Int32Array(4096);
function floodFill(start) {
  let edges = 0, head = 0, tail = 0;
  queue[tail++] = start;
  visBits[start] = 1;
  while (head < tail) {
    const i = queue[head++];
    const x = i & 15, y = i >> 8 & 15, z = i >> 4 & 15;
    if (x === 0) edges |= 1 << 4; else if (x === 15) edges |= 1 << 5;
    if (y === 0) edges |= 1 << 0; else if (y === 15) edges |= 1 << 1;
    if (z === 0) edges |= 1 << 2; else if (z === 15) edges |= 1 << 3;
    const nb = [y === 0 ? -1 : i - 256, y === 15 ? -1 : i + 256, z === 0 ? -1 : i - 16, z === 15 ? -1 : i + 16, x === 0 ? -1 : i - 1, x === 15 ? -1 : i + 1];
    for (let k = 0; k < 6; k++) { const j = nb[k]; if (j >= 0 && !visBits[j]) { visBits[j] = 1; queue[tail++] = j; } }
  }
  return edges;
}

// ---- jobs ----------------------------------------------------------------------------------------------------------
const cancelled = new Set();
let lastFluid = -1;
function runJob(job) {
  S = job.states; L = job.light; TINT = job.tint; OX = job.ox; OY = job.oy; OZ = job.oz; FACES = job.faces;
  BIO = job.biomes || null;
  if (BIO) {
    BIO.seed = BigInt.asIntN(64, (BigInt(BIO.seedHi) << 32n) | BigInt(BIO.seedLo >>> 0));
    BIO.fid = new Float64Array(3 * BIO.nx * BIO.ny * BIO.nz).fill(NaN);
    BIO.bw = 16 + 2 * BIO.radius; BIO.bx0 = OX - BIO.radius; BIO.bz0 = OZ - BIO.radius; BIO.by0 = OY - 1;
    BIO.bcache = new Int16Array(BIO.bw * BIO.bw * 17).fill(-1);
    BIO.tset = new Uint8Array(4 * 17 * 16 * 16); BIO.tval = new Int32Array(4 * 17 * 16 * 16);
  }
  CARD = job.cardinal.map(v => f(v));
  for (const o of out) o.n = 0;
  spriteSeen = new Set(); spriteList = [];
  visBits.fill(0); visEmpty = 4096; lastFluid = -1;
  for (let z = 0; z < 16; z++) for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const state = S[idx(x, y, z)], fl = T.flags[state];
    if (fl & F_AIR) continue;
    if (fl & F_SOLID_RENDER) { visBits[x | y << 8 | z << 4] = 1; visEmpty--; }
    if (fl & F_FLUID) {
      const fs = T.fluid[state];
      if (fs !== lastFluid) {
        // SectionCompiler notes the fluid model's sprites whenever the fluid state changes (still, flowing, overlay).
        lastFluid = fs;
        for (const sp of T.fluids[fs].sprites) if (sp && sp.id >= 0 && !spriteSeen.has(sp.id)) { spriteSeen.add(sp.id); spriteList.push(sp.id); }
      }
      tesselateFluid(state, x, y, z);
    }
    if (fl & F_RENDER_MODEL) tesselateBlock(state, x, y, z);
  }
  let visMode = 2;
  const vis = [];
  if (4096 - visEmpty < 256) visMode = 0;
  else if (visEmpty === 0) visMode = 1;
  else for (const i of EDGES) if (!visBits[i]) vis.push(floodFill(i));
  const layers = [], verts = [], transfer = [];
  for (const o of out) {
    if (o.n === 0) { layers.push(null); verts.push(0); continue; }
    const buf = o.i32.slice(0, o.n).buffer;
    layers.push(buf); verts.push(o.n / 7); transfer.push(buf);
  }
  return {msg: {type: 'result', id: job.id, gen: job.gen, ok: 1, verts, layers, visMode, visCount: vis.length, vis,
    spriteCount: spriteList.length, sprites: spriteList}, transfer};
}

self.onmessage = e => {
  const d = e.data;
  if (d.type === 'reset') { gen = d.gen; ao = d.ao; cutoutLeaves = d.cutoutLeaves; mangroveId = d.mangrove; T = newTables(); cancelled.clear(); return; }
  if (d.type === 'define') { if (d.gen === gen) define(d.words); return; }
  if (d.type === 'cancel') { cancelled.add(d.id); return; }
  if (d.type === 'job') {
    if (cancelled.delete(d.id)) { self.postMessage({type: 'result', id: d.id, gen: d.gen, ok: 0, skipped: 1}); return; }
    if (d.gen !== gen || !T) { self.postMessage({type: 'result', id: d.id, gen: d.gen, ok: 0, error: 'mesh worker tables of another generation'}); return; }
    const t0 = performance.now();
    try {
      const {msg, transfer} = runJob(d);
      msg.ms = performance.now() - t0;
      self.postMessage(msg, transfer);
    } catch (error) {
      if (error instanceof Bail) self.postMessage({type: 'result', id: d.id, gen: d.gen, ok: 0, bail: String(error.message)});
      else self.postMessage({type: 'result', id: d.id, gen: d.gen, ok: 0, error: String(error && error.stack || error)});
    }
  }
};
