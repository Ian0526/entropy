/**
 * 2D simplex noise (Gustavson / Perlin 2001) with a quantum-seeded permutation table.
 * Allocation-free after construction; returns values in roughly [-1, 1].
 */
import type { QuantumEntropyEngine } from './QuantumEntropy';

const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;
const GRAD_X = new Float32Array([1, -1, 1, -1, 1, -1, 0, 0, 0.7071, -0.7071, 0.7071, -0.7071]);
const GRAD_Y = new Float32Array([1, 1, -1, -1, 0, 0, 1, -1, 0.7071, 0.7071, -0.7071, -0.7071]);

export class SimplexNoise2D {
  private perm = new Uint8Array(512);
  private permMod12 = new Uint8Array(512);

  constructor(q: QuantumEntropyEngine) {
    this.reseed(q);
  }

  reseed(q: QuantumEntropyEngine): void {
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = q.nextUint32() % (i + 1);
      const t = p[i];
      p[i] = p[j];
      p[j] = t;
    }
    for (let i = 0; i < 512; i++) {
      this.perm[i] = p[i & 255];
      this.permMod12[i] = this.perm[i] % 12;
    }
  }

  noise(xin: number, yin: number): number {
    const perm = this.perm;
    const pm = this.permMod12;
    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const x0 = xin - (i - t);
    const y0 = yin - (j - t);
    const i1 = x0 > y0 ? 1 : 0;
    const j1 = 1 - i1;
    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;
    const ii = i & 255;
    const jj = j & 255;

    let n0 = 0;
    let n1 = 0;
    let n2 = 0;
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 > 0) {
      const g = pm[ii + perm[jj]];
      t0 *= t0;
      n0 = t0 * t0 * (GRAD_X[g] * x0 + GRAD_Y[g] * y0);
    }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 > 0) {
      const g = pm[ii + i1 + perm[jj + j1]];
      t1 *= t1;
      n1 = t1 * t1 * (GRAD_X[g] * x1 + GRAD_Y[g] * y1);
    }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 > 0) {
      const g = pm[ii + 1 + perm[jj + 1]];
      t2 *= t2;
      n2 = t2 * t2 * (GRAD_X[g] * x2 + GRAD_Y[g] * y2);
    }
    return 70 * (n0 + n1 + n2);
  }
}

// -----------------------------------------------------------------------------
// 3D simplex noise (Gustavson), same quantum-seeded permutation scheme.
// -----------------------------------------------------------------------------
const F3 = 1 / 3;
const G3 = 1 / 6;
const G3X = new Float32Array([1, -1, 1, -1, 1, -1, 1, -1, 0, 0, 0, 0]);
const G3Y = new Float32Array([1, 1, -1, -1, 0, 0, 0, 0, 1, -1, 1, -1]);
const G3Z = new Float32Array([0, 0, 0, 0, 1, 1, -1, -1, 1, 1, -1, -1]);

export class SimplexNoise3D {
  private perm = new Uint8Array(512);
  private permMod12 = new Uint8Array(512);

  constructor(q: QuantumEntropyEngine) {
    this.reseed(q);
  }

  reseed(q: QuantumEntropyEngine): void {
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = q.nextUint32() % (i + 1);
      const t = p[i];
      p[i] = p[j];
      p[j] = t;
    }
    for (let i = 0; i < 512; i++) {
      this.perm[i] = p[i & 255];
      this.permMod12[i] = this.perm[i] % 12;
    }
  }

  noise(xin: number, yin: number, zin: number): number {
    const perm = this.perm;
    const pm = this.permMod12;
    const s = (xin + yin + zin) * F3;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const k = Math.floor(zin + s);
    const t = (i + j + k) * G3;
    const x0 = xin - (i - t);
    const y0 = yin - (j - t);
    const z0 = zin - (k - t);
    let i1: number, j1: number, k1: number, i2: number, j2: number, k2: number;
    if (x0 >= y0) {
      if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
      else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
      else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
    } else if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
    else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
    else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
    const x1 = x0 - i1 + G3, y1 = y0 - j1 + G3, z1 = z0 - k1 + G3;
    const x2 = x0 - i2 + 2 * G3, y2 = y0 - j2 + 2 * G3, z2 = z0 - k2 + 2 * G3;
    const x3 = x0 - 1 + 3 * G3, y3 = y0 - 1 + 3 * G3, z3 = z0 - 1 + 3 * G3;
    const ii = i & 255;
    const jj = j & 255;
    const kk = k & 255;
    let n = 0;
    let c = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
    if (c > 0) {
      const g = pm[ii + perm[jj + perm[kk]]];
      c *= c;
      n += c * c * (G3X[g] * x0 + G3Y[g] * y0 + G3Z[g] * z0);
    }
    c = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
    if (c > 0) {
      const g = pm[ii + i1 + perm[jj + j1 + perm[kk + k1]]];
      c *= c;
      n += c * c * (G3X[g] * x1 + G3Y[g] * y1 + G3Z[g] * z1);
    }
    c = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
    if (c > 0) {
      const g = pm[ii + i2 + perm[jj + j2 + perm[kk + k2]]];
      c *= c;
      n += c * c * (G3X[g] * x2 + G3Y[g] * y2 + G3Z[g] * z2);
    }
    c = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
    if (c > 0) {
      const g = pm[ii + 1 + perm[jj + 1 + perm[kk + 1]]];
      c *= c;
      n += c * c * (G3X[g] * x3 + G3Y[g] * y3 + G3Z[g] * z3);
    }
    return 32 * n;
  }
}
