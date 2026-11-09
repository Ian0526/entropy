/**
 * Morpho probe: CPU (FFT) reference of the multi-channel Lenia world in src/client/morpho, used to
 * check that a regime lives: neither dies out nor floods, and keeps moving.
 *   npx tsx scripts/morpho-probe.ts <regime> [steps] [W] [H] [out.png]
 * W and H must be powers of two. Prints coverage / activity every 50 steps.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { growth, kernelWeights, regimeById } from '../src/client/morpho/regimes';

const ov = JSON.parse(process.env.MORPHO ?? '{}');
const reg = { ...regimeById(process.argv[2]), ...ov, kernels: regimeById(process.argv[2]).kernels.map((k, i) => ({ ...k, ...(ov.k ?? {}), ...(ov['k' + i] ?? {}) })) };
const steps = Number(process.argv[3] ?? 1000);
const W = Number(process.argv[4] ?? 256);
const H = Number(process.argv[5] ?? 256);
const out = process.argv[6] ?? '';
const N = W * H;

let s0 = 0x9e3779b9, s1 = 0x243f6a88, s2 = 0xb7e15162, s3 = Number(process.env.SEED ?? 1);
function rnd(): number {
  const t = (((s0 + s1) | 0) + s3) | 0;
  s3 = (s3 + 1) | 0; s0 = s1 ^ (s1 >>> 9); s1 = (s2 + (s2 << 3)) | 0; s2 = (s2 << 21) | (s2 >>> 11); s2 = (s2 + t) | 0;
  return (t >>> 0) / 4294967296;
}
for (let i = 0; i < 20; i++) rnd();

// ---- 2D FFT (radix-2, in place on separate re/im arrays) ----
function fft1(re: Float64Array, im: Float64Array, off: number, stride: number, n: number, inv: boolean) {
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const a = off + i * stride, b = off + j * stride;
      [re[a], re[b]] = [re[b], re[a]];
      [im[a], im[b]] = [im[b], im[a]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (2 * Math.PI / len) * (inv ? 1 : -1);
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = off + (i + k) * stride, b = off + (i + k + len / 2) * stride;
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}
function fft2(re: Float64Array, im: Float64Array, inv: boolean) {
  for (let y = 0; y < H; y++) fft1(re, im, y * W, 1, W, inv);
  for (let x = 0; x < W; x++) fft1(re, im, x, W, H, inv);
  if (inv) for (let i = 0; i < N; i++) { re[i] /= N; im[i] /= N; }
}

// Kernel spectra, kernels centred on (0,0) with wraparound.
const R = reg.R;
const kSpec = reg.kernels.map((k) => {
  const w = kernelWeights(R, k);
  const re = new Float64Array(N), im = new Float64Array(N);
  const n = 2 * R + 1;
  for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
    re[((dy + H) % H) * W + ((dx + W) % W)] = w[(dy + R) * n + dx + R];
  }
  fft2(re, im, false);
  return { re, im };
});

const A = [new Float32Array(N), new Float32Array(N), new Float32Array(N)];
const used = [0, 1, 2].map((c) => reg.kernels.some((k) => k.c1 === c));
const nUsed = used.filter(Boolean).length;
const chanAmp = () => used.map((u) => (u ? (ov.amp ?? 1) * (0.5 + 0.5 * rnd()) : 0));

function seedPatch(cx: number, cy: number) {
  const s = Math.round(R * (ov.patch ?? 1));
  const amp = chanAmp();
  for (let y = -s; y < s; y++) for (let x = -s; x < s; x++) {
    const i = (((cy + y) % H + H) % H) * W + (((cx + x) % W + W) % W);
    for (let c = 0; c < 3; c++) A[c][i] = Math.max(A[c][i], rnd() * amp[c]);
  }
}
function seedRing(cx: number, cy: number) {
  const m = [3, 4, 5, 6, 8][Math.floor(rnd() * 5)];
  const r0 = R * (ov.r0 ?? 0.5 + rnd() * 0.5), wdt = R * (ov.w ?? 0.2), ph = rnd() * 6.283;
  const amp = chanAmp();
  const s = Math.ceil(r0 + 3 * wdt);
  for (let y = -s; y <= s; y++) for (let x = -s; x <= s; x++) {
    const r = Math.hypot(x, y), f = Math.atan2(y, x);
    // Concentric: the main ring plus a fainter one at half its radius, both modulated by cos(mφ).
    const prof = Math.exp(-((r - r0) ** 2) / (2 * wdt * wdt)) + 0.6 * Math.exp(-((r - r0 / 2) ** 2) / (2 * wdt * wdt));
    const v = Math.min(1, prof) * (0.7 + 0.3 * Math.cos(m * f + ph));
    const i = (((cy + y) % H + H) % H) * W + (((cx + x) % W + W) % W);
    for (let c = 0; c < 3; c++) A[c][i] = Math.min(1, A[c][i] + v * amp[c]);
  }
}
// Sparse: a handful of clusters (6 per 256×256), the rest of the world empty.
const seeds = ov.seeds ?? Math.max(3, Math.round((6 * N) / 65536));
for (let i = 0; i < seeds; i++) (reg.seed === 'rings' ? seedRing : seedPatch)(Math.floor(rnd() * W), Math.floor(rnd() * H));
// Mass homeostasis: while coverage is above target, μ creeps up (starving the weakest matter).
const target = ov.target ?? 0.18;
let dmu = ov.dmu ?? 0;

const fre = [0, 1, 2].map(() => new Float64Array(N));
const fim = [0, 1, 2].map(() => new Float64Array(N));
const re = new Float64Array(N), im = new Float64Array(N);
const dA = [new Float32Array(N), new Float32Array(N), new Float32Array(N)];
const dt = 1 / reg.T;

function step() {
  for (let c = 0; c < 3; c++) {
    for (let i = 0; i < N; i++) { fre[c][i] = A[c][i]; fim[c][i] = 0; }
    fft2(fre[c], fim[c], false);
  }
  for (const d of dA) d.fill(0);
  reg.kernels.forEach((k, j) => {
    const ks = kSpec[j], ar = fre[k.c0], ai = fim[k.c0];
    for (let i = 0; i < N; i++) { re[i] = ar[i] * ks.re[i] - ai[i] * ks.im[i]; im[i] = ar[i] * ks.im[i] + ai[i] * ks.re[i]; }
    fft2(re, im, true);
    const d = dA[k.c1];
    for (let i = 0; i < N; i++) d[i] += k.h * growth(re[i], k.m + dmu, k.s);
  });
  for (let c = 0; c < 3; c++) for (let i = 0; i < N; i++) A[c][i] = Math.min(1, Math.max(0, A[c][i] + dt * dA[c][i]));
}

let prev = new Float32Array(N);
const t0 = Date.now();
for (let t = 1; t <= steps; t++) {
  step();
  if (t % 30 === 0 && !ov.nofeedback) {
    let cov = 0;
    for (let i = 0; i < N; i++) if ((A[0][i] + A[1][i] + A[2][i]) / nUsed > 0.1) cov++;
    if (cov / N > target) dmu += 0.002;
    else if (cov / N < target * 0.6) dmu = Math.max(0, dmu - 0.001);
  }
  if (t % 50 === 0) {
    let cov = 0, mass = 0, act = 0;
    for (let i = 0; i < N; i++) {
      const m = (A[0][i] + A[1][i] + A[2][i]) / nUsed;
      mass += m; if (m > 0.1) cov++; act += Math.abs(m - prev[i]); prev[i] = m;
    }
    console.log(`t=${t} cover=${(cov / N * 100).toFixed(1)}% mass=${(mass / N).toFixed(3)} activity=${(act / N * 1000).toFixed(2)} dmu=${dmu.toFixed(3)}`);
    if (cov === 0) break;
  }
}
console.log(`${((Date.now() - t0) / steps).toFixed(1)} ms/step`);

if (out) {
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W * 3 + 1)] = 0;
    for (let x = 0; x < W; x++) for (let c = 0; c < 3; c++) raw[y * (W * 3 + 1) + 1 + x * 3 + c] = Math.round(A[c][y * W + x] * 255);
  }
  const crc = (b: Buffer) => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  fs.writeFileSync(out, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}
