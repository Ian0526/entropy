/**
 * Generations-rule probe ("B…/S…/C…": Life-like rules with C-2 dying states between alive and dead).
 *   npx tsx scripts/generations-probe.ts <rule> [steps] [W] [H] [outFile]
 * GEN env JSON: { density, rainEvery, rainR }. Writes a PNG of the final state.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';

const ruleStr = process.argv[2] ?? 'B2/S345/C4';
const steps = Number(process.argv[3] ?? 500);
const W = Number(process.argv[4] ?? 256);
const H = Number(process.argv[5] ?? 160);
const out = process.argv[6] ?? '';
const P = { density: 0.35, rainEvery: 0, rainR: 6, ...JSON.parse(process.env.GEN ?? '{}') };

const m = /B(\d*)\/S(\d*)\/C(\d+)/i.exec(ruleStr)!;
const born = new Uint8Array(9), surv = new Uint8Array(9);
for (const c of m[1]) born[+c] = 1;
for (const c of m[2]) surv[+c] = 1;
const C = Number(m[3]);

let seed = Number(process.env.SEED ?? 3) >>> 0;
const rnd = () => ((seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0), seed / 4294967296);
let A = new Uint8Array(W * H), B = new Uint8Array(W * H);
for (let i = 0; i < A.length; i++) A[i] = rnd() < P.density ? 1 : 0;
function rain(): void {
  const cx = Math.floor(rnd() * W), cy = Math.floor(rnd() * H), r = P.rainR;
  for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) if (x * x + y * y <= r * r && rnd() < 0.5) A[((cy + y + H) % H) * W + ((cx + x + W) % W)] = 1;
}
const counts: number[] = [];
for (let s = 1; s <= steps; s++) {
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && A[((y + dy + H) % H) * W + ((x + dx + W) % W)] === 1) n++;
    const i = y * W + x, v = A[i];
    B[i] = v === 0 ? (born[n] ? 1 : 0) : v === 1 ? (surv[n] ? 1 : C > 2 ? 2 : 0) : v + 1 >= C ? 0 : v + 1;
  }
  [A, B] = [B, A];
  if (P.rainEvery && s % P.rainEvery === 0) rain();
  if (s % (steps / 5) === 0) { let a = 0; for (const v of A) if (v) a++; counts.push(Math.round((1000 * a) / A.length) / 10); }
}
console.log(`${ruleStr}: occupied % over time ${counts.join(' ')}`);
if (out) {
  const S = 2, raw = Buffer.alloc((W * S * 3 + 1) * H * S);
  for (let y = 0; y < H * S; y++) for (let x = 0; x < W * S; x++) {
    const v = A[Math.floor(y / S) * W + Math.floor(x / S)], o = y * (W * S * 3 + 1) + 1 + x * 3;
    const c = v === 0 ? [4, 8, 20] : v === 1 ? [255, 220, 140] : (() => { const t = (v - 1) / (C - 1); return [Math.round(220 * (1 - t) + 30 * t), Math.round(90 * (1 - t) + 40 * t), Math.round(60 * (1 - t) + 120 * t)]; })();
    raw[o] = c[0]; raw[o + 1] = c[1]; raw[o + 2] = c[2];
  }
  const T = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
  const crc = (b: Buffer) => { let c = -1; for (const x of b) c = T[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const h = Buffer.alloc(13); h.writeUInt32BE(W * S, 0); h.writeUInt32BE(H * S, 4); h[8] = 8; h[9] = 2;
  fs.writeFileSync(out, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', h), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}
