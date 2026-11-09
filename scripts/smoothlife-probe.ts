/**
 * SmoothLife probe (Rafler 2011, discrete-time "L" rule): a CPU reference for tuning.
 *   npx tsx scripts/smoothlife-probe.ts [steps] [W] [H] [outDir]
 * SL env JSON overrides parameters. Prints mass/activity and writes PNG snapshots.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const steps = Number(process.argv[2] ?? 300);
const W = Number(process.argv[3] ?? 192);
const H = Number(process.argv[4] ?? 128);
const outDir = process.argv[5] ?? '';
const P = {
  ra: 12, ratio: 3, b1: 0.278, b2: 0.365, d1: 0.267, d2: 0.445, an: 0.028, am: 0.147,
  dt: 1, // 1 = discrete SmoothLife; <1 = smooth time stepping toward S
  splats: 30, splatR: 1, // splat radius in units of ra
  fill: 1, // fraction of a splat's cells set (the rest stay empty): grainy noise splats when < 1
  rainEvery: 0, // steps between new splats (0 = none)
  ...JSON.parse(process.env.SL ?? '{}'),
};
let seed = Number(process.env.SEED ?? 7) >>> 0;
const rnd = () => ((seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0), seed / 4294967296);

// Inner disk (radius ri) and outer annulus (ri..ra), antialiased over one cell.
const ra = P.ra, ri = ra / P.ratio, b = 1;
const off: number[] = [], wi: number[] = [], wo: number[] = [];
let si = 0, so = 0;
const R = Math.ceil(ra + b);
for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
  const l = Math.hypot(dx, dy);
  const inner = l < ri - b / 2 ? 1 : l > ri + b / 2 ? 0 : (ri + b / 2 - l) / b;
  const outerDisk = l < ra - b / 2 ? 1 : l > ra + b / 2 ? 0 : (ra + b / 2 - l) / b;
  const outer = outerDisk - inner;
  if (inner <= 0 && outer <= 0) continue;
  off.push(dx, dy); wi.push(inner); wo.push(outer); si += inner; so += outer;
}
for (let k = 0; k < wi.length; k++) { wi[k] /= si; wo[k] /= so; }

const s1 = (x: number, a: number, al: number) => 1 / (1 + Math.exp(-(x - a) * 4 / al));
const s2 = (x: number, a: number, bb: number) => s1(x, a, P.an) * (1 - s1(x, bb, P.an));
const sm = (x: number, y: number, m: number) => { const t = s1(m, 0.5, P.am); return x * (1 - t) + y * t; };
const S = (n: number, m: number) => s2(n, sm(P.b1, P.d1, m), sm(P.b2, P.d2, m));

let A = new Float32Array(W * H), B = new Float32Array(W * H);
let prev = new Float32Array(W * H);
function splat(): void {
  const cx = rnd() * W, cy = rnd() * H, r = ra * P.splatR;
  for (let y = Math.floor(cy - r); y <= cy + r; y++) for (let x = Math.floor(cx - r); x <= cx + r; x++) {
    if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
    A[((y % H) + H) % H * W + ((x % W) + W) % W] = rnd() < P.fill ? 1 : 0;
  }
}
for (let i = 0; i < P.splats; i++) splat();

function step(): void {
  const n = wi.length;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let m = 0, nn = 0;
    for (let k = 0; k < n; k++) {
      let xx = x + off[2 * k], yy = y + off[2 * k + 1];
      if (xx < 0) xx += W; else if (xx >= W) xx -= W;
      if (yy < 0) yy += H; else if (yy >= H) yy -= H;
      const v = A[yy * W + xx]; m += v * wi[k]; nn += v * wo[k];
    }
    const i = y * W + x, t = S(nn, m);
    B[i] = P.dt >= 1 ? t : Math.min(1, Math.max(0, A[i] + P.dt * (2 * t - 1)));
  }
  [A, B] = [B, A];
}

function png(file: string): void {
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = A[y * W + x], o = y * (W * 3 + 1) + 1 + x * 3;
    raw[o] = 255 * v; raw[o + 1] = 200 * v * v; raw[o + 2] = 40 + 60 * v;
  }
  const T = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
  const crc = (bb: Buffer) => { let c = -1; for (const x of bb) c = T[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const h = Buffer.alloc(13); h.writeUInt32BE(W, 0); h.writeUInt32BE(H, 4); h[8] = 8; h[9] = 2;
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', h), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

for (let s = 1; s <= steps; s++) {
  step();
  if (P.rainEvery && s % P.rainEvery === 0) splat();
  if (s % Math.max(1, Math.floor(steps / 10)) === 0) {
    let mass = 0, change = 0;
    for (let i = 0; i < A.length; i++) { mass += A[i]; change += Math.abs(A[i] - prev[i]); }
    prev = A.slice();
    console.log(`step ${s}  mass ${mass.toFixed(0)}  cover ${((100 * mass) / A.length).toFixed(1)}%  change ${(change / Math.max(1, mass)).toFixed(2)}`);
    if (outDir) { fs.mkdirSync(outDir, { recursive: true }); png(path.join(outDir, `s${s}.png`)); }
  }
}
