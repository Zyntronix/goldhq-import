// AES-128/CFB8 stream cipher for Minecraft Java protocol encryption (key = IV = shared secret).
// WebCrypto has no CFB8 mode, so this is a table-driven AES block encryptor (CFB uses the forward cipher
// in both directions). One block operation per byte: ~16x the cost of CTR, acceptable for Minecraft rates.

const SBOX = new Uint8Array(256);
const T0 = new Uint32Array(256), T1 = new Uint32Array(256), T2 = new Uint32Array(256), T3 = new Uint32Array(256);
(() => {
  // Generate the S-box from GF(2^8) inverses (no hard-coded tables to mistype).
  const exp = new Uint8Array(256), log = new Uint8Array(256);
  for (let i = 0, x = 1; i < 255; i++) { exp[i] = x; log[x] = i; x ^= (x << 1) ^ (x & 0x80 ? 0x11b : 0); x &= 0xff; }
  for (let i = 0; i < 256; i++) {
    let inv = i === 0 ? 0 : exp[(255 - log[i]) % 255];
    let s = inv;
    for (let r = 0; r < 4; r++) { inv = ((inv << 1) | (inv >> 7)) & 0xff; s ^= inv; }
    SBOX[i] = s ^ 0x63;
  }
  for (let i = 0; i < 256; i++) {
    const s = SBOX[i];
    const s2 = ((s << 1) ^ (s & 0x80 ? 0x11b : 0)) & 0xff;
    const s3 = s2 ^ s;
    const t = ((s2 << 24) | (s << 16) | (s << 8) | s3) >>> 0;
    T0[i] = t;
    T1[i] = ((t >>> 8) | (t << 24)) >>> 0;
    T2[i] = ((t >>> 16) | (t << 16)) >>> 0;
    T3[i] = ((t >>> 24) | (t << 8)) >>> 0;
  }
})();

function expandKey128(key) {
  const w = new Uint32Array(44);
  for (let i = 0; i < 4; i++) w[i] = ((key[4 * i] << 24) | (key[4 * i + 1] << 16) | (key[4 * i + 2] << 8) | key[4 * i + 3]) >>> 0;
  let rcon = 1;
  for (let i = 4; i < 44; i++) {
    let t = w[i - 1];
    if (i % 4 === 0) {
      t = ((SBOX[(t >>> 16) & 255] << 24) | (SBOX[(t >>> 8) & 255] << 16) | (SBOX[t & 255] << 8) | SBOX[t >>> 24]) ^ (rcon << 24);
      rcon = ((rcon << 1) ^ (rcon & 0x80 ? 0x11b : 0)) & 0xff;
    }
    w[i] = (w[i - 4] ^ t) >>> 0;
  }
  return w;
}

/** Encrypts the 16-byte block in `inp` into `out` (both Uint8Array, may alias). */
function encryptBlock(w, inp, out) {
  let s0 = (((inp[0] << 24) | (inp[1] << 16) | (inp[2] << 8) | inp[3]) ^ w[0]) >>> 0;
  let s1 = (((inp[4] << 24) | (inp[5] << 16) | (inp[6] << 8) | inp[7]) ^ w[1]) >>> 0;
  let s2 = (((inp[8] << 24) | (inp[9] << 16) | (inp[10] << 8) | inp[11]) ^ w[2]) >>> 0;
  let s3 = (((inp[12] << 24) | (inp[13] << 16) | (inp[14] << 8) | inp[15]) ^ w[3]) >>> 0;
  let k = 4;
  for (let r = 1; r < 10; r++) {
    const t0 = T0[s0 >>> 24] ^ T1[(s1 >>> 16) & 255] ^ T2[(s2 >>> 8) & 255] ^ T3[s3 & 255] ^ w[k++];
    const t1 = T0[s1 >>> 24] ^ T1[(s2 >>> 16) & 255] ^ T2[(s3 >>> 8) & 255] ^ T3[s0 & 255] ^ w[k++];
    const t2 = T0[s2 >>> 24] ^ T1[(s3 >>> 16) & 255] ^ T2[(s0 >>> 8) & 255] ^ T3[s1 & 255] ^ w[k++];
    const t3 = T0[s3 >>> 24] ^ T1[(s0 >>> 16) & 255] ^ T2[(s1 >>> 8) & 255] ^ T3[s2 & 255] ^ w[k++];
    s0 = t0 >>> 0; s1 = t1 >>> 0; s2 = t2 >>> 0; s3 = t3 >>> 0;
  }
  const f = (a, b, c, d, key) => (((SBOX[a >>> 24] << 24) | (SBOX[(b >>> 16) & 255] << 16) | (SBOX[(c >>> 8) & 255] << 8) | SBOX[d & 255]) ^ key) >>> 0;
  const o0 = f(s0, s1, s2, s3, w[40]), o1 = f(s1, s2, s3, s0, w[41]), o2 = f(s2, s3, s0, s1, w[42]), o3 = f(s3, s0, s1, s2, w[43]);
  out[0] = o0 >>> 24; out[1] = o0 >>> 16; out[2] = o0 >>> 8; out[3] = o0;
  out[4] = o1 >>> 24; out[5] = o1 >>> 16; out[6] = o1 >>> 8; out[7] = o1;
  out[8] = o2 >>> 24; out[9] = o2 >>> 16; out[10] = o2 >>> 8; out[11] = o2;
  out[12] = o3 >>> 24; out[13] = o3 >>> 16; out[14] = o3 >>> 8; out[15] = o3;
}

/** CFB8 state for one direction. `decrypt` selects which byte (cipher text) feeds the shift register. */
export class AesCfb8 {
  constructor(key, decrypt) {
    if (!(key instanceof Uint8Array) || key.length !== 16) throw new Error('AES-128 key must be 16 bytes');
    this.w = expandKey128(key);
    this.iv = new Uint8Array(key); // Minecraft uses the shared secret as the IV
    this.block = new Uint8Array(16);
    this.decrypt = decrypt;
  }

  /** Transforms `data` in place and returns it. */
  update(data) {
    const { w, iv, block, decrypt } = this;
    for (let i = 0; i < data.length; i++) {
      encryptBlock(w, iv, block);
      const input = data[i];
      const output = input ^ block[0];
      iv.copyWithin(0, 1);
      iv[15] = decrypt ? input : output;
      data[i] = output;
    }
    return data;
  }
}
