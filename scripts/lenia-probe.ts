/**
 * Lenia probe: a CPU reference of the Lenia rule used by the GPU world (src/client/lenia), for tuning.
 *   npx tsx scripts/lenia-probe.ts [steps] [W] [H] [outDir]
 * LENIA env JSON overrides the parameters. Prints mass/activity over time and writes PNG snapshots.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const steps = Number(process.argv[2] ?? 1500);
const W = Number(process.argv[3] ?? 256);
const H = Number(process.argv[4] ?? 128);
const outDir = process.argv[5] ?? '';

const P = {
  R: 13, dt: 0.1,
  muLo: 0.14, muHi: 0.16, sigLo: 0.014, sigHi: 0.016, // parameter field range ("laws" vary across space)
  fieldScale: 80, // cells per noise feature of the parameter field
  seeds: 12, // initial noise patches
  rainEvery: 50, // steps between new noise patches
  patch: 20, // patch size
  amp: 1, // max value in a patch
  regen: 0, // nutrient regrowth rate toward 1 (0 = no nutrient field: growth is free)
  eat: 0, // nutrient used per unit of living matter
  starve: 0, // decay when the nutrient under matter runs out
  ...JSON.parse(process.env.LENIA ?? '{}'),
};

let s0 = 0x9e3779b9, s1 = 0x243f6a88, s2 = 0xb7e15162, s3 = Number(process.env.SEED ?? 1);
function rnd(): number {
  const t = (((s0 + s1) | 0) + s3) | 0;
  s3 = (s3 + 1) | 0; s0 = s1 ^ (s1 >>> 9); s1 = (s2 + (s2 << 3)) | 0; s2 = (s2 << 21) | (s2 >>> 11); s2 = (s2 + t) | 0;
  return (t >>> 0) / 4294967296;
}
for (let i = 0; i < 20; i++) rnd();

// Kernel: a smooth ring (exponential bump over r in (0,1)), normalised to sum 1.
const R = P.R;
const kOff: number[] = [];
const kW: number[] = [];
let kSum = 0;
for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
  const r = Math.hypot(dx, dy) / R;
  if (r <= 0 || r >= 1) continue;
  const w = Math.exp(4 - 1 / (r * (1 - r)));
  if (w < 1e-6) continue;
  kOff.push(dx, dy); kW.push(w); kSum += w;
}
for (let i = 0; i < kW.length; i++) kW[i] /= kSum;

// Smooth value-noise parameter field in [0,1].
function noiseField(scale: number): Float32Array {
  const gw = Math.ceil(W / scale) + 1, gh = Math.ceil(H / scale) + 1;
  const g = Float32Array.from({ length: gw * gh }, () => rnd());
  const f = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const fx = x / scale, fy = y / scale, ix = Math.floor(fx), iy = Math.floor(fy);
    const tx = fx - ix, ty = fy - iy, sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
    const a = g[iy * gw + ix], b = g[iy * gw + ix + 1], c = g[(iy + 1) * gw + ix], d = g[(iy + 1) * gw + ix + 1];
    f[y * W + x] = (a + (b - a) * sx) + ((c + (d - c) * sx) - (a + (b - a) * sx)) * sy;
  }
  return f;
}
const field = noiseField(P.fieldScale);
const mu = field.map((v) => P.muLo + (P.muHi - P.muLo) * v);
const sig = field.map((v) => P.sigLo + (P.sigHi - P.sigLo) * v);

let A = new Float32Array(W * H);
let B = new Float32Array(W * H);
const F = new Float32Array(W * H).fill(1); // nutrient
let prevSnap = new Float32Array(W * H);
function drop(): void {
  const cx = Math.floor(rnd() * W), cy = Math.floor(rnd() * H), n = P.patch;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const dx = (x - n / 2) / (n / 2), dy = (y - n / 2) / (n / 2);
    if (dx * dx + dy * dy > 1) continue;
    A[((cy + y) % H) * W + ((cx + x) % W)] = rnd() * P.amp;
  }
}
for (let i = 0; i < P.seeds; i++) drop();

function step(): void {
  const n = kW.length;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let u = 0;
    for (let k = 0; k < n; k++) {
      let xx = x + kOff[2 * k], yy = y + kOff[2 * k + 1];
      if (xx < 0) xx += W; else if (xx >= W) xx -= W;
      if (yy < 0) yy += H; else if (yy >= H) yy -= H;
      u += A[yy * W + xx] * kW[k];
    }
    const i = y * W + x, d = u - mu[i];
    let g = 2 * Math.exp(-(d * d) / (2 * sig[i] * sig[i])) - 1;
    if (P.regen) { if (g > 0) g *= F[i]; g -= P.starve * (1 - F[i]); } // growth needs nutrient; starving matter decays
    const v = A[i] + P.dt * g;
    if (P.regen) F[i] = Math.min(1, Math.max(0, F[i] + P.dt * (P.regen * (1 - F[i]) - P.eat * A[i] * F[i])));
    B[i] = v < 0 ? 0 : v > 1 ? 1 : v;
  }
  [A, B] = [B, A];
}

function png(file: string): void {
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W * 3 + 1)] = 0;
    for (let x = 0; x < W; x++) {
      const v = A[y * W + x], o = y * (W * 3 + 1) + 1 + x * 3;
      raw[o] = Math.round(255 * Math.min(1, v * 1.2)); raw[o + 1] = Math.round(255 * v * v); raw[o + 2] = Math.round(80 * field[y * W + x] + 40 * v);
    }
  }
  const crcT = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
  const crc = (b: Buffer) => { let c = -1; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

const t0 = Date.now();
for (let s = 1; s <= steps; s++) {
  step();
  if (P.rainEvery && s % P.rainEvery === 0) drop();
  if (s % Math.max(1, Math.floor(steps / 10)) === 0) {
    let mass = 0, active = 0, change = 0, food = 0;
    for (let i = 0; i < A.length; i++) { const v = A[i]; mass += v; if (v > 0.1) active++; change += Math.abs(v - prevSnap[i]); food += F[i]; }
    prevSnap = A.slice();
    console.log(`step ${s}  mass ${mass.toFixed(0)}  active ${((100 * active) / (W * H)).toFixed(1)}%  change ${(change / Math.max(1, mass)).toFixed(2)}  food ${(food / A.length).toFixed(2)}`);
    if (outDir) { fs.mkdirSync(outDir, { recursive: true }); png(path.join(outDir, `s${s}.png`)); }
  }
}
console.log(`${((Date.now() - t0) / steps).toFixed(1)} ms/step`);
