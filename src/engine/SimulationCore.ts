/**
 * SimulationCore — thermodynamic, mutable-genome cellular automaton.
 *
 * Every per-cell quantity is a flat TypedArray (Structure-of-Arrays) carved out of
 * one contiguous (Shared)ArrayBuffer so the hot loops stream linearly through L1/L2
 * and the main thread can attach read-only views without copying.
 *
 * World topology: torus (W × H, wrap-around) with a 4-neighbourhood, or a 3-torus
 * (W × H × D) with a 6-neighbourhood. Cell index i = (z·H + y)·W + x.
 *
 * Tick pipeline
 *   1. absorbQuantumSeed()       quantum indeterminism enters the SFC32 sponge
 *   2. food regeneration         drifting, tileable simplex pockets
 *   3. signal propagation        `signalSpeed` relay sub-steps through living tissue
 *   4. asynchronous cell pass    quantum-shuffled order, Poisson phase clocks
 *        maintenance → harvest → emission → predation → division | motility → epigenetics → death
 *   5. metabolic routing         conservative pairwise (Jacobi) energy pumping between kin
 *   6. flux & statistics
 */
import { QuantumEntropyEngine } from './QuantumEntropy';
import { SimplexNoise2D, SimplexNoise3D } from './SimplexNoise';
import {
  aggression, armorBias, chemoFood, chemoSignal, decodeGenome, divideThreshold, emitThreshold, gKin,
  harvestGain, kinRelation, makeAncestor, makePredator, motility, mutateInPlace, popcount32, pumpStrength,
  sensorBias,
} from './Genome';
import {
  DEFAULT_PARAMS, LAYER, LAYER_COUNT, sanitizeParams,
  type ClusterStats, type InspectResult, type SimParams, type SimStats, type SpeciesStat, type ToolKind,
} from './protocol';

export const SOMA = { EMPTY: 0, CORE: 1, ARMOR: 2, SENSOR: 3 } as const;
export const EPI_DAMAGED = 1;
export const EPI_STARVING = 2;

// ---- thermodynamic constants (per tick unless noted) ------------------------
/** Maintenance cost by somatic type: Armor is cheapest, Sensors are the most expensive. */
const DECAY = new Float32Array([0, 0.0035, 0.0012, 0.0055]);
/** Fraction of the local food tile harvested per action, by somatic type. */
const HARVEST = new Float32Array([0, 0.1, 0, 0.04]);
const HARVEST_EFFICIENCY = 0.9; //   10 % of harvested food is lost as heat
const REPLICATION_COST = 0.06; //    energy dissipated by one division
const SIGNAL_COST = REPLICATION_COST * 0.05; // emitting a signal costs 5 % of replication
const MOVE_COST = 0.004;
const ATTACK_COST = 0.001;
const PREDATION_EFFICIENCY = 0.75;
const BODY_MASS_RETURN = 0.15; //    structural mass returned to food on death
const FOOD_BASE_REGEN = 0.013;
/** Ecology tunables (exported so the headless probe in scripts/ecology.ts can sweep them). */
export const ECO = {
  /** Fraction of the regrowth rate that applies everywhere, so open space is never fully barren. */
  baseFood: 0.05,
  /** Food lost per tick outside of regrowth. */
  evaporation: 0.0025,
  /** Multiplier on how fast the nutrient pockets drift. */
  drift: 0.2,
  /** Maintenance multiplier for starving cells (dormancy). */
  starvingDecay: 0.85,
  /** A cell only divides if its tile holds at least this much food (0 = off). */
  divideFoodMin: 0,
  /** 3D nutrient clouds: base noise frequency, contrast gain, threshold, and founder colonies. */
  cloudFreq: 0.05,
  cloudGain: 2.6,
  cloudCut: 0.1,
  founders3d: 14,
  /** Background food in the 3D void (leaner than 2D, so space reads as mostly empty). */
  baseFood3d: 0.05,
};
const NOISE_CELL = 8; //             coarse food-noise lattice spacing (cells)
const SIGNAL_A_DECAY = 0.9; //       per tick
const SIGNAL_B_DECAY = 0.86;
const SIGNAL_HOP = 0.86; //          attenuation per relay hop
const KEY_SPECIES_MIN = 4; //        cells needed for a kin hash to count as a species

/** Byte layout of the shared grid buffer. */
export interface GridLayout {
  bytes: number;
  offsets: Record<string, number>;
}

const HEADER_WORDS = 16;
export const HDR = { TICK: 0, POPULATION: 1, RUNNING: 2, SPEED: 3, HEARTBEAT: 4, SEQ: 5 } as const;

function align(n: number, a: number): number {
  return (n + a - 1) & ~(a - 1);
}

export function gridLayout(W: number, H: number, D = 1): GridLayout {
  const N = W * H * D;
  const offsets: Record<string, number> = {};
  let o = 0;
  const take = (name: string, bytes: number) => {
    o = align(o, 8);
    offsets[name] = o;
    o += bytes;
  };
  take('header', HEADER_WORDS * 4);
  take('somatic', N);
  take('terrain', N);
  take('epi', N);
  take('energy', N * 4);
  take('energyPrev', N * 4);
  take('flux', N * 4);
  take('food', N * 4);
  take('pocket', N * 4);
  take('sigA', N * 4);
  take('sigB', N * 4);
  take('genome', N * 8);
  take('birth', N * 4);
  take('ancestor', 8);
  return { bytes: align(o, 8), offsets };
}

export class SimulationCore {
  readonly W: number;
  readonly H: number;
  /** Depth: 1 for the flat world, > 1 for the 3D world. */
  readonly D: number;
  readonly N: number;
  /** Neighbours per cell: 4 (2D) or 6 (3D). The first K/2 point forward (+x, +y[, +z]). */
  readonly K: number;
  readonly buffer: SharedArrayBuffer | ArrayBuffer;
  params: SimParams = { ...DEFAULT_PARAMS };

  // ---- shared SoA views -------------------------------------------------------
  readonly header: Int32Array;
  readonly somatic: Uint8Array;
  readonly terrain: Uint8Array;
  readonly epi: Uint8Array;
  readonly energy: Float32Array;
  readonly energyPrev: Float32Array;
  readonly flux: Float32Array;
  readonly food: Float32Array;
  readonly pocket: Float32Array;
  readonly sigA: Float32Array;
  readonly sigB: Float32Array;
  readonly genome: Uint32Array;
  readonly birth: Uint32Array;
  readonly ancestor: Uint32Array;

  // ---- private scratch (never shared) -----------------------------------------
  private readonly nbr: Int32Array; //      K neighbours per cell: +x, +y, (+z), -x, -y, (-z)
  private readonly order: Uint32Array;
  private readonly tmpA: Float32Array;
  private readonly tmpB: Float32Array;
  private readonly dE: Float32Array;
  private readonly speciesCount = new Uint32Array(65536);
  private readonly speciesTouched = new Uint16Array(65536);
  private readonly coarse: Float32Array;
  private readonly cw: number;
  private readonly ch: number;
  private readonly cd: number;
  private visit: Uint32Array | null = null;
  private visitGen = 0;
  private queue: Int32Array | null = null;

  private readonly q: QuantumEntropyEngine;
  private noiseA: SimplexNoise2D;
  private noiseB: SimplexNoise2D;
  private noiseA3: SimplexNoise3D | null = null;
  private noiseB3: SimplexNoise3D | null = null;
  private driftAx = 0;
  private driftAy = 0;
  private driftAz = 0;
  private driftBx = 0;
  private driftBy = 0;
  private driftBz = 0;
  private lowPopTicks = 0;

  tick = 0;
  stats: SimStats;

  constructor(W: number, H: number, entropy: QuantumEntropyEngine, shared?: SharedArrayBuffer | ArrayBuffer, attach = false, D = 1) {
    this.W = W;
    this.H = H;
    this.D = Math.max(1, D | 0);
    this.N = W * H * this.D;
    this.K = this.D > 1 ? 6 : 4;
    this.q = entropy;
    const L = gridLayout(W, H, this.D);
    this.buffer = shared ?? (typeof SharedArrayBuffer !== 'undefined' ? new SharedArrayBuffer(L.bytes) : new ArrayBuffer(L.bytes));
    if (this.buffer.byteLength < L.bytes) throw new Error(`grid buffer too small: ${this.buffer.byteLength} < ${L.bytes}`);
    const b = this.buffer;
    const N = this.N;
    const off = L.offsets;
    this.header = new Int32Array(b, off.header, HEADER_WORDS);
    this.somatic = new Uint8Array(b, off.somatic, N);
    this.terrain = new Uint8Array(b, off.terrain, N);
    this.epi = new Uint8Array(b, off.epi, N);
    this.energy = new Float32Array(b, off.energy, N);
    this.energyPrev = new Float32Array(b, off.energyPrev, N);
    this.flux = new Float32Array(b, off.flux, N);
    this.food = new Float32Array(b, off.food, N);
    this.pocket = new Float32Array(b, off.pocket, N);
    this.sigA = new Float32Array(b, off.sigA, N);
    this.sigB = new Float32Array(b, off.sigB, N);
    this.genome = new Uint32Array(b, off.genome, N * 2);
    this.birth = new Uint32Array(b, off.birth, N);
    this.ancestor = new Uint32Array(b, off.ancestor, 2);

    const K = this.K;
    const Dd = this.D;
    this.nbr = new Int32Array(N * K);
    const idx = (x: number, y: number, z: number) => (z * H + y) * W + x;
    for (let z = 0; z < Dd; z++) {
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const k = idx(x, y, z) * K;
          const xp = (x + 1) % W, xm = (x - 1 + W) % W, yp = (y + 1) % H, ym = (y - 1 + H) % H;
          if (K === 4) {
            this.nbr[k] = idx(xp, y, z);
            this.nbr[k + 1] = idx(x, yp, z);
            this.nbr[k + 2] = idx(xm, y, z);
            this.nbr[k + 3] = idx(x, ym, z);
          } else {
            const zp = (z + 1) % Dd, zm = (z - 1 + Dd) % Dd;
            this.nbr[k] = idx(xp, y, z);
            this.nbr[k + 1] = idx(x, yp, z);
            this.nbr[k + 2] = idx(x, y, zp);
            this.nbr[k + 3] = idx(xm, y, z);
            this.nbr[k + 4] = idx(x, ym, z);
            this.nbr[k + 5] = idx(x, y, zm);
          }
        }
      }
    }
    this.order = new Uint32Array(N);
    this.tmpA = new Float32Array(N);
    this.tmpB = new Float32Array(N);
    this.dE = new Float32Array(N);
    this.cw = Math.ceil(W / NOISE_CELL);
    this.ch = Math.ceil(H / NOISE_CELL);
    this.cd = this.D > 1 ? Math.ceil(this.D / NOISE_CELL) : 1;
    this.coarse = new Float32Array(this.cw * this.ch * this.cd);
    this.noiseA = new SimplexNoise2D(entropy);
    this.noiseB = new SimplexNoise2D(entropy);
    if (this.D > 1) {
      this.noiseA3 = new SimplexNoise3D(entropy);
      this.noiseB3 = new SimplexNoise3D(entropy);
    }
    this.stats = this.emptyStats();

    if (!attach) this.reset();
    else this.tick = Atomics.load(this.header, HDR.TICK);
  }

  private emptyStats(): SimStats {
    return {
      tick: 0, population: 0, core: 0, armor: 0, sensor: 0, births: 0, deaths: 0, predations: 0,
      species: 0, meanEnergy: 0, totalFood: 0, meanDistance: 0, topSpecies: [],
    };
  }

  setParams(p: Partial<SimParams>): void {
    this.params = sanitizeParams(p, this.params);
  }

  // ===========================================================================
  // Initialisation
  // ===========================================================================

  reset(): void {
    const q = this.q;
    this.somatic.fill(0);
    this.terrain.fill(0);
    this.epi.fill(0);
    this.energy.fill(0);
    this.energyPrev.fill(0);
    this.flux.fill(0);
    this.sigA.fill(0);
    this.sigB.fill(0);
    this.genome.fill(0);
    this.birth.fill(0);
    this.tick = 0;
    Atomics.store(this.header, HDR.TICK, 0);
    this.noiseA.reseed(q);
    this.noiseB.reseed(q);
    this.noiseA3?.reseed(q);
    this.noiseB3?.reseed(q);
    // Quantum symmetry breaking: drift directions of the two nutrient pocket fields.
    const a1 = q.nextFloat() * Math.PI * 2;
    const a2 = a1 + Math.PI * (0.5 + q.nextFloat());
    this.driftAx = Math.cos(a1) * 0.0008 * ECO.drift;
    this.driftAy = Math.sin(a1) * 0.0008 * ECO.drift;
    this.driftBx = Math.cos(a2) * 0.0013 * ECO.drift;
    this.driftBy = Math.sin(a2) * 0.0013 * ECO.drift;
    if (this.D > 1) {
      // Tilt both drift directions out of the plane by a quantum-chosen elevation.
      const e1 = (q.nextFloat() - 0.5) * Math.PI;
      const e2 = (q.nextFloat() - 0.5) * Math.PI;
      this.driftAx *= Math.cos(e1);
      this.driftAy *= Math.cos(e1);
      this.driftAz = Math.sin(e1) * 0.0008 * ECO.drift;
      this.driftBx *= Math.cos(e2);
      this.driftBy *= Math.cos(e2);
      this.driftBz = Math.sin(e2) * 0.0013 * ECO.drift;
    }
    this.updatePockets();
    for (let i = 0; i < this.N; i++) this.food[i] = Math.min(1, this.pocket[i] * 0.9 + 0.05);

    const [a0, a1w] = makeAncestor(q.nextUint32() & 0xffff);
    this.ancestor[0] = a0;
    this.ancestor[1] = a1w;
    this.seedFounders(this.D > 1 ? ECO.founders3d : 10);
    this.stats = this.emptyStats();
    this.refreshStats();
    this.collectSpecies();
  }

  /** Place founder colonies, descended from the seed ancestor, on the richest food spots. */
  private seedFounders(count: number): void {
    const q = this.q;
    const W = this.W;
    const H = this.H;
    const picks: number[] = [];
    const WH = W * H;
    const minDist = Math.max(this.D > 1 ? 10 : 12, Math.min(W, H, this.D > 1 ? this.D : Infinity) / 6);
    for (let attempt = 0; attempt < 400 && picks.length < count; attempt++) {
      let best = -1;
      let bestF = -1;
      for (let s = 0; s < 12; s++) {
        const i = q.nextInt(this.N);
        if (this.terrain[i] === 0 && this.food[i] > bestF) {
          bestF = this.food[i];
          best = i;
        }
      }
      if (best < 0) continue;
      const bx = best % W;
      const by = ((best / W) | 0) % H;
      const bz = (best / WH) | 0;
      let ok = true;
      for (const p of picks) {
        let dx = Math.abs((p % W) - bx);
        let dy = Math.abs((((p / W) | 0) % H) - by);
        let dz = Math.abs(((p / WH) | 0) - bz);
        dx = Math.min(dx, W - dx);
        dy = Math.min(dy, H - dy);
        dz = Math.min(dz, this.D - dz);
        if (dx * dx + dy * dy + dz * dz < minDist * minDist) {
          ok = false;
          break;
        }
      }
      if (ok) picks.push(best);
    }
    for (const p of picks) {
      // Each founder lineage differs from the ancestor by a couple of kin-hash bits + light mutation.
      const g0 = this.ancestor[0];
      let g1 = this.ancestor[1];
      g1 = (g1 ^ (1 << (q.nextUint32() & 15)) ^ (1 << (q.nextUint32() & 15))) >>> 0;
      this.stampDisk(p % W, ((p / W) | 0) % H, 3, g0, g1, 0.7, false, (p / WH) | 0);
    }
  }

  /** Write a disk of fresh cells sharing a genome (mutated lightly per cell). */
  /** A disk (2D) or ball (3D) of founder cells centred on (cx, cy, cz). */
  private stampDisk(cx: number, cy: number, r: number, g0: number, g1: number, e: number, predator: boolean, cz = 0): number {
    const q = this.q;
    let placed = 0;
    const rz = this.D > 1 ? r : 0;
    for (let dz = -rz; dz <= rz; dz++)
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > r * r) continue;
        const x = (cx + dx + this.W) % this.W;
        const y = (cy + dy + this.H) % this.H;
        const z = (cz + dz + this.D) % this.D;
        const i = (z * this.H + y) * this.W + x;
        if (this.terrain[i]) continue;
        this.somatic[i] = d2 >= (r - 1) * (r - 1)
          ? (predator || q.nextFloat() < 0.5 ? SOMA.SENSOR : SOMA.ARMOR)
          : SOMA.CORE;
        this.energy[i] = e;
        this.energyPrev[i] = e;
        this.genome[i * 2] = g0;
        this.genome[i * 2 + 1] = g1;
        mutateInPlace(this.genome, i * 2, this.params.mutationRate * 0.5, q);
        // Keep the founder's kin hash intact so the colony recognises itself.
        this.genome[i * 2 + 1] = ((this.genome[i * 2 + 1] & 0xffff0000) | (g1 & 0xffff)) >>> 0;
        this.epi[i] = 0;
        this.birth[i] = this.tick;
        placed++;
      }
    }
    return placed;
  }

  // ===========================================================================
  // Food field: drifting, tileable simplex pockets on a coarse lattice
  // ===========================================================================

  private sampleTileable(n: SimplexNoise2D, x: number, y: number, pw: number, ph: number, freq: number, ox: number, oy: number): number {
    // Bilinear blend of four offset samples → seamless on the torus.
    const u = x / pw;
    const v = y / ph;
    const a = n.noise((x + ox) * freq, (y + oy) * freq);
    const b = n.noise((x - pw + ox) * freq, (y + oy) * freq);
    const c = n.noise((x + ox) * freq, (y - ph + oy) * freq);
    const d = n.noise((x - pw + ox) * freq, (y - ph + oy) * freq);
    return (1 - u) * (1 - v) * a + u * (1 - v) * b + (1 - u) * v * c + u * v * d;
  }

  private sampleTileable3(n: SimplexNoise3D, x: number, y: number, z: number, pw: number, ph: number, pd: number, f: number, ox: number, oy: number, oz: number): number {
    // Trilinear blend of eight offset samples → seamless on the 3-torus.
    const u = x / pw;
    const v = y / ph;
    const w = z / pd;
    const X0 = (x + ox) * f, X1 = (x - pw + ox) * f;
    const Y0 = (y + oy) * f, Y1 = (y - ph + oy) * f;
    const Z0 = (z + oz) * f, Z1 = (z - pd + oz) * f;
    const a = (1 - u) * n.noise(X0, Y0, Z0) + u * n.noise(X1, Y0, Z0);
    const b = (1 - u) * n.noise(X0, Y1, Z0) + u * n.noise(X1, Y1, Z0);
    const c = (1 - u) * n.noise(X0, Y0, Z1) + u * n.noise(X1, Y0, Z1);
    const d = (1 - u) * n.noise(X0, Y1, Z1) + u * n.noise(X1, Y1, Z1);
    return (1 - w) * ((1 - v) * a + v * b) + w * ((1 - v) * c + v * d);
  }

  /** 3D nutrient clouds: drifting quantum-seeded simplex nebulae on a coarse lattice, trilinearly upsampled. */
  private updatePockets3(): void {
    const { cw, ch, cd, W, H, D } = this;
    const pw = cw * NOISE_CELL, ph = ch * NOISE_CELL, pd = cd * NOISE_CELL;
    const t = this.tick;
    const nA = this.noiseA3!;
    const nB = this.noiseB3!;
    const c = this.coarse;
    for (let cz = 0; cz < cd; cz++) {
      for (let cy = 0; cy < ch; cy++) {
        for (let cx = 0; cx < cw; cx++) {
          const x = cx * NOISE_CELL, y = cy * NOISE_CELL, z = cz * NOISE_CELL;
          const n1 = this.sampleTileable3(nA, x, y, z, pw, ph, pd, ECO.cloudFreq, t * this.driftAx * 60, t * this.driftAy * 60, t * this.driftAz * 60);
          const n2 = this.sampleTileable3(nB, x, y, z, pw, ph, pd, ECO.cloudFreq * 2.3, t * this.driftBx * 60, t * this.driftBy * 60, t * this.driftBz * 60);
          let v = (n1 * 0.7 + n2 * 0.3) * ECO.cloudGain - ECO.cloudCut;
          v = v < 0 ? 0 : v > 1 ? 1 : v;
          c[(cz * ch + cy) * cw + cx] = v * Math.sqrt(v);
        }
      }
    }
    const inv = 1 / NOISE_CELL;
    const pocket = this.pocket;
    let i = 0;
    for (let z = 0; z < D; z++) {
      const fz = z * inv, z0 = Math.floor(fz) % cd, z1 = (z0 + 1) % cd, tz = fz - Math.floor(fz);
      for (let y = 0; y < H; y++) {
        const fy = y * inv, y0 = Math.floor(fy) % ch, y1 = (y0 + 1) % ch, ty = fy - Math.floor(fy);
        const r00 = (z0 * ch + y0) * cw, r01 = (z0 * ch + y1) * cw, r10 = (z1 * ch + y0) * cw, r11 = (z1 * ch + y1) * cw;
        for (let x = 0; x < W; x++, i++) {
          const fx = x * inv, x0 = Math.floor(fx) % cw, x1 = (x0 + 1) % cw, tx = fx - Math.floor(fx);
          const a = c[r00 + x0] + (c[r00 + x1] - c[r00 + x0]) * tx;
          const b = c[r01 + x0] + (c[r01 + x1] - c[r01 + x0]) * tx;
          const e = c[r10 + x0] + (c[r10 + x1] - c[r10 + x0]) * tx;
          const f = c[r11 + x0] + (c[r11 + x1] - c[r11 + x0]) * tx;
          const lo = a + (b - a) * ty;
          const hi = e + (f - e) * ty;
          pocket[i] = lo + (hi - lo) * tz;
        }
      }
    }
  }

  private updatePockets(): void {
    if (this.D > 1) return this.updatePockets3();
    const cw = this.cw;
    const ch = this.ch;
    const pw = cw * NOISE_CELL;
    const ph = ch * NOISE_CELL;
    const t = this.tick;
    const oAx = t * this.driftAx * 60;
    const oAy = t * this.driftAy * 60;
    const oBx = t * this.driftBx * 60;
    const oBy = t * this.driftBy * 60;
    for (let cy = 0; cy < ch; cy++) {
      for (let cx = 0; cx < cw; cx++) {
        const x = cx * NOISE_CELL;
        const y = cy * NOISE_CELL;
        const n1 = this.sampleTileable(this.noiseA, x, y, pw, ph, 0.022, oAx, oAy);
        const n2 = this.sampleTileable(this.noiseB, x, y, pw, ph, 0.05, oBx, oBy);
        // Tileable blending flattens contrast, so re-stretch before thresholding into pockets.
        let v = (n1 * 0.7 + n2 * 0.3) * 2.1 - 0.05;
        v = v < 0 ? 0 : v > 1 ? 1 : v;
        this.coarse[cy * cw + cx] = v * Math.sqrt(v);
      }
    }
    // Bilinear upsample (wrapping) into the per-cell pocket field.
    const W = this.W;
    const H = this.H;
    const inv = 1 / NOISE_CELL;
    for (let y = 0; y < H; y++) {
      const fy = y * inv;
      const y0 = Math.floor(fy) % ch;
      const y1 = (y0 + 1) % ch;
      const ty = fy - Math.floor(fy);
      for (let x = 0; x < W; x++) {
        const fx = x * inv;
        const x0 = Math.floor(fx) % cw;
        const x1 = (x0 + 1) % cw;
        const tx = fx - Math.floor(fx);
        const c = this.coarse;
        const top = c[y0 * cw + x0] * (1 - tx) + c[y0 * cw + x1] * tx;
        const bot = c[y1 * cw + x0] * (1 - tx) + c[y1 * cw + x1] * tx;
        this.pocket[y * W + x] = top * (1 - ty) + bot * ty;
      }
    }
  }

  private regenerateFood(): void {
    if ((this.tick & 1) === 0) this.updatePockets();
    const regen = FOOD_BASE_REGEN * (1 - 0.85 * this.params.foodScarcity);
    const food = this.food;
    const pocket = this.pocket;
    const terrain = this.terrain;
    const base = this.D > 1 ? ECO.baseFood3d : ECO.baseFood;
    for (let i = 0; i < this.N; i++) {
      if (terrain[i]) {
        food[i] = 0;
        continue;
      }
      const f = food[i];
      // Logistic regrowth inside pockets, slow evaporation outside them.
      food[i] = f + regen * (base + (1 - base) * pocket[i]) * (1 - f) - f * ECO.evaporation;
    }
  }

  // ===========================================================================
  // Signal propagation: relay waves through living tissue, `signalSpeed` hops per tick
  // ===========================================================================

  /**
   * Relay waves only travel through living tissue, so the sub-steps visit just the live cells
   * (`live[0..m)`), Jacobi-style. Signal left in the void bleeds out at 0.4 per sub-step.
   */
  private propagateSignals(live: Uint32Array, m: number): void {
    const steps = this.params.signalSpeed;
    const K = this.K;
    const N = this.N;
    const nbr = this.nbr;
    const som = this.somatic;
    const a = this.sigA;
    const b = this.sigB;
    const na = this.tmpA;
    const nb = this.tmpB;
    for (let s = 0; s < steps; s++) {
      for (let q = 0; q < m; q++) {
        const i = live[q];
        const k = i * K;
        let ma = a[i];
        let mb = b[i];
        for (let d = 0; d < K; d++) {
          const j = nbr[k + d];
          if (som[j] === 0) continue;
          const va = a[j] * SIGNAL_HOP;
          const vb = b[j] * SIGNAL_HOP;
          if (va > ma) ma = va;
          if (vb > mb) mb = vb;
        }
        na[i] = ma;
        nb[i] = mb;
      }
      for (let q = 0; q < m; q++) {
        const i = live[q];
        a[i] = na[i];
        b[i] = nb[i];
      }
    }
    // Per-tick decay; the void also loses 0.4 per sub-step. Tiny values are flushed to zero
    // (decaying Float32s would otherwise become denormals, which are very slow).
    const bleed = Math.pow(0.4, steps);
    const voidA = SIGNAL_A_DECAY * bleed;
    const voidB = SIGNAL_B_DECAY * bleed;
    for (let i = 0; i < N; i++) {
      const va = a[i];
      const vb = b[i];
      if (va === 0 && vb === 0) continue;
      const live = som[i] !== 0;
      const x = va * (live ? SIGNAL_A_DECAY : voidA);
      const y = vb * (live ? SIGNAL_B_DECAY : voidB);
      a[i] = x < 1e-4 ? 0 : x;
      b[i] = y < 1e-4 ? 0 : y;
    }
  }

  // ===========================================================================
  // Cell helpers
  // ===========================================================================

  private kinNeighbours(n: number, kin: number, exclude: number): number {
    const K = this.K;
    const k = n * K;
    let c = 0;
    for (let d = 0; d < K; d++) {
      const j = this.nbr[k + d];
      if (j !== exclude && this.somatic[j] !== 0 && kinRelation(kin, this.genome[j * 2 + 1] & 0xffff) < 2) c++;
    }
    return c;
  }

  private killCell(i: number): void {
    const e = this.energy[i];
    const f = this.food[i] + BODY_MASS_RETURN + (e > 0 ? e * 0.5 : 0);
    this.food[i] = f > 1 ? 1 : f;
    this.somatic[i] = 0;
    this.energy[i] = 0;
    this.epi[i] = 0;
    this.stats.deaths++;
  }

  private moveCell(from: number, to: number): void {
    this.somatic[to] = this.somatic[from];
    this.energy[to] = this.energy[from];
    this.energyPrev[to] = this.energyPrev[from];
    this.epi[to] = this.epi[from];
    this.genome[to * 2] = this.genome[from * 2];
    this.genome[to * 2 + 1] = this.genome[from * 2 + 1];
    this.flux[to] = this.flux[from];
    this.birth[to] = this.tick;
    this.somatic[from] = 0;
    this.energy[from] = 0;
    this.epi[from] = 0;
  }

  // ===========================================================================
  // Tick
  // ===========================================================================

  step(): void {
    const q = this.q;
    q.absorbQuantumSeed();
    this.tick = (this.tick + 1) >>> 0;
    const tick = this.tick;
    this.stats.births = 0;
    this.stats.deaths = 0;
    this.stats.predations = 0;

    this.regenerateFood();

    const N = this.N;
    const som = this.somatic;
    const energy = this.energy;
    const food = this.food;
    const sigA = this.sigA;
    const sigB = this.sigB;
    const genome = this.genome;
    const epi = this.epi;
    const terrain = this.terrain;
    const nbr = this.nbr;
    const birth = this.birth;
    const P = this.params;
    const K = this.K;
    const phaseP = 1 - Math.exp(-P.phaseRate);
    const decayMul = P.metabolicDecay;
    const mu = P.mutationRate;

    // ---- gather live cells, then a quantum Fisher–Yates shuffle → unbiased async order
    const order = this.order;
    let m = 0;
    for (let i = 0; i < N; i++) if (som[i] !== 0) order[m++] = i;
    this.propagateSignals(order, m);
    for (let k = m - 1; k > 0; k--) {
      const j = q.nextInt(k + 1);
      const t = order[k];
      order[k] = order[j];
      order[j] = t;
    }

    for (let k = 0; k < m; k++) {
      let i = order[k];
      const t = som[i];
      if (t === 0 || birth[i] === tick) continue; // died, moved, or born during this tick
      const w0 = genome[i * 2];
      const w1 = genome[i * 2 + 1];
      const kin = w1 & 0xffff;
      const epBefore = epi[i];
      let ep = epBefore;
      const starving = (ep & EPI_STARVING) !== 0;
      const damaged = (ep & EPI_DAMAGED) !== 0;

      // -- 1. maintenance: entropic bleed (always, independent of the phase clock)
      let e = energy[i] - DECAY[t] * decayMul * (starving ? ECO.starvingDecay : 1);

      // -- Poisson phase clock: does this cell act during this tick?
      if (q.nextFloat() < phaseP) {
        const nk = i * K;

        // -- 2. harvest
        const hg = HARVEST[t] * harvestGain(w0) * (starving ? 1.2 : 1);
        const h = food[i] * hg;
        if (h > 0) {
          food[i] -= h;
          e += h * HARVEST_EFFICIENCY;
          // "Mouth" edges also graze one adjacent open tile, feeding the body via routing.
          const g = nbr[nk + (q.nextUint32() % K)];
          if (som[g] === 0 && terrain[g] === 0) {
            const hn = food[g] * hg * 0.6;
            food[g] -= hn;
            e += hn * HARVEST_EFFICIENCY;
          }
        }

        // -- 3. signal emission (nervous system)
        if (t === SOMA.SENSOR && e > emitThreshold(w0)) {
          const s = food[i] * 1.6 + 0.1;
          if (s > sigA[i]) sigA[i] = s > 1 ? 1 : s;
          e -= SIGNAL_COST;
        }
        if (damaged || starving) {
          const s = damaged ? 0.9 : 0.45;
          if (s > sigB[i]) sigB[i] = s;
          e -= SIGNAL_COST;
        }

        // -- 4. predation on a random neighbour
        const agr = aggression(w1);
        const r = q.nextUint32();
        const target = nbr[nk + (r % K)];
        if (agr > 0.05 && som[target] !== 0 && ((r >>> 2) & 1023) < agr * 1024) {
          const tk = genome[target * 2 + 1] & 0xffff;
          if (kinRelation(kin, tk) === 2) {
            const armored = som[target] === SOMA.ARMOR;
            let drain = (0.04 + 0.12 * agr) * (armored ? 0.25 : 1) * (t === SOMA.SENSOR ? 1.3 : 1);
            const et = energy[target];
            if (drain > et) drain = et;
            energy[target] = et - drain;
            e += drain * PREDATION_EFFICIENCY - ATTACK_COST;
            epi[target] |= EPI_DAMAGED;
            if (sigB[target] < 1) sigB[target] = 1;
            this.stats.predations++;
            if (energy[target] <= 0) this.killCell(target);
          }
        }

        // -- 5. division (or, failing that, motility)
        let divided = false;
        const cf = chemoFood(w0) * (starving ? 1.6 : 1);
        const cs = chemoSignal(w0);
        if (e > divideThreshold(w0) + REPLICATION_COST && food[i] >= ECO.divideFoodMin) {
          let best = -1;
          let bestScore = -1e9;
          for (let d = 0; d < K; d++) {
            const n = nbr[nk + d];
            if (som[n] !== 0 || terrain[n] !== 0) continue;
            const score = cf * (food[n] - food[i]) * 4 + cs * (sigA[n] - sigA[i]) * 2
              + 0.35 * this.kinNeighbours(n, kin, i) // wound-filling / compactness → homeostatic healing
              + q.nextFloat() * 0.3;
            if (score > bestScore) {
              bestScore = score;
              best = n;
            }
          }
          if (best >= 0) {
            const avail = e - REPLICATION_COST;
            const half = avail * 0.5;
            e = half;
            // Differentiation: alarm signals & damage memory → armor; exposed edges → sensors.
            const alarm = sigB[i] + (damaged ? 0.5 : 0);
            const pArmor = Math.min(0.85, 0.06 + armorBias(w1) * 0.3 + alarm * 0.55);
            const edge = this.kinNeighbours(best, kin, i) <= 1 ? 1 : 0.25;
            const pSensor = Math.min(0.9 - pArmor, 0.05 + sensorBias(w1) * 0.35 * edge);
            const roll = q.nextFloat();
            som[best] = roll < pArmor ? SOMA.ARMOR : roll < pArmor + pSensor ? SOMA.SENSOR : SOMA.CORE;
            energy[best] = half;
            this.energyPrev[best] = half;
            genome[best * 2] = w0;
            genome[best * 2 + 1] = w1;
            mutateInPlace(genome, best * 2, mu, q);
            epi[best] = ep & EPI_DAMAGED; // damage memory is epigenetically inherited
            birth[best] = tick;
            this.flux[best] = 0;
            this.stats.births++;
            divided = true;
          }
        }

        // -- 6. re-differentiation (homeostasis): armor up under threat, relax when calm
        if (!divided && q.nextFloat() < 0.01) {
          if (t === SOMA.CORE && sigB[i] > 0.5) som[i] = SOMA.ARMOR;
          else if (t === SOMA.ARMOR && sigB[i] < 0.05 && !damaged) som[i] = SOMA.CORE;
        }

        // -- 7. motility: cilia crawl up the food / signal gradient, staying attached to kin
        if (!divided && t === SOMA.SENSOR) {
          const mot = motility(w0);
          if (mot > 0 && q.nextFloat() < mot * 0.25) {
            let best = -1;
            let bestGain = 0.01;
            for (let d = 0; d < K; d++) {
              const n = nbr[nk + d];
              if (som[n] !== 0 || terrain[n] !== 0) continue;
              const gain = cf * (food[n] - food[i]) + cs * (sigA[n] - sigA[i]) * 0.5;
              if (gain > bestGain) {
                bestGain = gain;
                best = n;
              }
            }
            if (best >= 0) {
              const attached = this.kinNeighbours(i, kin, -1) === 0 || this.kinNeighbours(best, kin, i) > 0;
              if (attached) {
                energy[i] = e - MOVE_COST;
                this.moveCell(i, best);
                i = best;
                e = energy[i];
              }
            }
          }
        }

        // -- 8. epigenetic register update (2 bits, never touches the genome)
        if (damaged && q.nextFloat() < 0.012) ep &= ~EPI_DAMAGED;
      }

      if (e < 0.15) ep |= EPI_STARVING;
      else if (e > 0.4) ep &= ~EPI_STARVING;
      // Keep damage that a predator inflicted on this cell earlier in this same tick.
      const freshDamage = epi[i] & ~epBefore & EPI_DAMAGED;
      epi[i] = ep | freshDamage;

      if (e <= 0) {
        energy[i] = 0;
        this.killCell(i);
      } else {
        energy[i] = e;
      }
    }

    this.routeEnergy();
    this.finishTick();
  }

  /**
   * Metabolic routing — conservative pairwise pumping between adjacent kin cells.
   * Flux = k·(Eᵢ − Eⱼ) [equalisation] + k·β·(Bⱼ − Bᵢ) [pump toward alarm/need].
   * Computed Jacobi-style into dE so there is no sweep-direction bias, and each pair's
   * flux is bounded by 20 % of the donor so energies can never go negative.
   */
  private routeEnergy(): void {
    const N = this.N;
    const som = this.somatic;
    const energy = this.energy;
    const genome = this.genome;
    const sigB = this.sigB;
    const nbr = this.nbr;
    const dE = this.dE;
    const K = this.K;
    const FWD = K >> 1; // forward neighbours only, so each pair is visited once
    dE.fill(0);
    for (let i = 0; i < N; i++) {
      if (som[i] === 0) continue;
      const wi = genome[i * 2 + 1];
      const ki = wi & 0xffff;
      const pi = pumpStrength(wi);
      const ei = energy[i];
      for (let d = 0; d < FWD; d++) {
        const j = nbr[i * K + d];
        if (som[j] === 0) continue;
        const wj = genome[j * 2 + 1];
        if (kinRelation(ki, wj & 0xffff) === 2) continue;
        const k = (pi + pumpStrength(wj)) * 0.1;
        const ej = energy[j];
        let f = k * (ei - ej) + k * 0.15 * (sigB[j] - sigB[i]);
        const maxOut = ei * 0.2;
        const maxIn = ej * 0.2;
        if (f > maxOut) f = maxOut;
        else if (f < -maxIn) f = -maxIn;
        dE[i] -= f;
        dE[j] += f;
      }
    }
    const food = this.food;
    for (let i = 0; i < N; i++) {
      if (som[i] === 0) continue;
      let e = energy[i] + dE[i];
      if (e > 1) {
        // Saturation overflow is not destroyed: it spills back into the environment.
        const spill = food[i] + (e - 1);
        food[i] = spill > 1 ? 1 : spill;
        e = 1;
      }
      energy[i] = e;
    }
  }

  private finishTick(): void {
    const N = this.N;
    const som = this.somatic;
    const energy = this.energy;
    const prev = this.energyPrev;
    const flux = this.flux;
    let pop = 0;
    let core = 0;
    let armor = 0;
    let sensor = 0;
    let sumE = 0;
    let sumF = 0;
    let sumD = 0;
    const a0 = this.ancestor[0];
    const a1 = this.ancestor[1];
    const g = this.genome;
    for (let i = 0; i < N; i++) {
      sumF += this.food[i];
      const t = som[i];
      if (t === 0) {
        flux[i] *= 0.8;
        continue;
      }
      const e = energy[i];
      flux[i] = flux[i] * 0.85 + (e - prev[i]) * 0.15;
      prev[i] = e;
      pop++;
      sumE += e;
      if (t === SOMA.CORE) core++;
      else if (t === SOMA.ARMOR) armor++;
      else sensor++;
      sumD += popcount32(g[i * 2] ^ a0) + popcount32(g[i * 2 + 1] ^ a1);
    }
    const s = this.stats;
    s.tick = this.tick;
    s.population = pop;
    s.core = core;
    s.armor = armor;
    s.sensor = sensor;
    s.meanEnergy = pop ? sumE / pop : 0;
    s.totalFood = sumF;
    s.meanDistance = pop ? sumD / pop : 0;
    if (this.tick % 10 === 0) this.collectSpecies();

    Atomics.store(this.header, HDR.TICK, this.tick | 0);
    Atomics.store(this.header, HDR.POPULATION, pop);

    // Abiogenesis: if life collapses, a quantum symmetry-breaking event re-seeds founders.
    if (pop < 6) {
      if (++this.lowPopTicks > 60) {
        this.lowPopTicks = 0;
        this.seedFounders(6);
      }
    } else {
      this.lowPopTicks = 0;
    }
  }

  private refreshStats(): void {
    let pop = 0;
    let core = 0;
    let armor = 0;
    let sensor = 0;
    let sumE = 0;
    let sumF = 0;
    for (let i = 0; i < this.N; i++) {
      sumF += this.food[i];
      const t = this.somatic[i];
      if (!t) continue;
      pop++;
      sumE += this.energy[i];
      if (t === 1) core++;
      else if (t === 2) armor++;
      else sensor++;
    }
    Object.assign(this.stats, {
      tick: this.tick, population: pop, core, armor, sensor,
      meanEnergy: pop ? sumE / pop : 0, totalFood: sumF,
    });
  }

  private collectSpecies(): void {
    const cnt = this.speciesCount;
    const touched = this.speciesTouched;
    let nt = 0;
    const g = this.genome;
    for (let i = 0; i < this.N; i++) {
      if (this.somatic[i] === 0) continue;
      const k = g[i * 2 + 1] & 0xffff;
      if (cnt[k] === 0) touched[nt++] = k;
      cnt[k]++;
    }
    let species = 0;
    const top: SpeciesStat[] = [];
    for (let t = 0; t < nt; t++) {
      const k = touched[t];
      const c = cnt[k];
      if (c >= KEY_SPECIES_MIN) {
        species++;
        if (top.length < 6 || c > top[top.length - 1].count) {
          top.push({ kin: k, count: c, hue: SimulationCore.hueOf(k) });
          top.sort((a, b) => b.count - a.count);
          if (top.length > 6) top.pop();
        }
      }
      cnt[k] = 0;
    }
    this.stats.species = species;
    this.stats.topSpecies = top;
  }

  /** Lineage hue (0–255): driven by the high kin-hash bits so close kin share a colour. */
  static hueOf(kin: number): number {
    return (Math.imul((kin >>> 8) & 0xff, 157) + 23) & 255;
  }

  // ===========================================================================
  // Perturbation tools
  // ===========================================================================

  applyTool(tool: ToolKind, cx: number, cy: number, radius: number, strength: number, cz = 0): void {
    const q = this.q;
    const W = this.W;
    const H = this.H;
    const D = this.D;
    cx = Math.floor(((cx % W) + W) % W);
    cy = Math.floor(((cy % H) + H) % H);
    cz = Math.floor((((Number.isFinite(cz) ? cz : 0) % D) + D) % D);
    const r = Math.max(0, Math.min(32, Math.round(radius)));
    strength = Math.max(0, Math.min(1, strength));
    if (tool === 'inspect') return;
    if (tool === 'predator') {
      const [p0, p1] = makePredator(q.nextUint32() & 0xffff);
      this.stampDisk(cx, cy, Math.max(2, Math.min(r, 4)), p0, p1, 0.85, true, cz);
      return;
    }
    const rz = D > 1 ? Math.min(r, 16) : 0;
    for (let dz = -rz; dz <= rz; dz++)
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > r * r) continue;
        const falloff = r > 0 ? 1 - Math.sqrt(d2) / (r + 1) : 1;
        const i = (((((cz + dz) % D) + D) % D) * H + ((cy + dy + H) % H)) * W + ((cx + dx + W) % W);
        switch (tool) {
          case 'poke': {
            if (this.somatic[i] === 0) break;
            const e = this.energy[i] - strength * falloff * 0.9;
            this.epi[i] |= EPI_DAMAGED;
            this.sigB[i] = 1;
            if (e <= 0 || d2 === 0) this.killCell(i);
            else this.energy[i] = e;
            break;
          }
          case 'mutagen': {
            if (this.somatic[i] === 0 || q.nextFloat() > 0.3 + 0.6 * falloff) break;
            const flips = 1 + Math.floor(strength * 5 * q.nextFloat());
            for (let f = 0; f < flips; f++) {
              const bit = q.nextUint32() & 63;
              const w = i * 2 + (bit >> 5);
              this.genome[w] = (this.genome[w] ^ (1 << (bit & 31))) >>> 0;
            }
            this.sigA[i] = 1;
            break;
          }
          case 'wall':
            if (this.somatic[i] !== 0) this.killCell(i);
            this.terrain[i] = 1;
            this.food[i] = 0;
            break;
          case 'erase':
            this.terrain[i] = 0;
            break;
          case 'food': {
            if (this.terrain[i]) break;
            const f = this.food[i] + strength * falloff * 0.8;
            this.food[i] = f > 1 ? 1 : f;
            break;
          }
        }
      }
    }
  }

  // ===========================================================================
  // Inspection
  // ===========================================================================

  inspect(x: number, y: number, z = 0): InspectResult {
    const W = this.W;
    const H = this.H;
    const D = this.D;
    x = Math.floor(((x % W) + W) % W);
    y = Math.floor(((y % H) + H) % H);
    z = Math.floor((((Number.isFinite(z) ? z : 0) % D) + D) % D);
    const i = (z * H + y) * W + x;
    const alive = this.somatic[i] !== 0;
    const w0 = this.genome[i * 2];
    const w1 = this.genome[i * 2 + 1];
    const dist = alive ? popcount32(w0 ^ this.ancestor[0]) + popcount32(w1 ^ this.ancestor[1]) : 0;
    const rel = kinRelation(gKin(w1), gKin(this.ancestor[1]));
    return {
      x, y, z, alive,
      wall: this.terrain[i] !== 0,
      somatic: this.somatic[i],
      energy: this.energy[i],
      food: this.food[i],
      signalA: this.sigA[i],
      signalB: this.sigB[i],
      flux: this.flux[i],
      age: alive ? (this.tick - this.birth[i]) >>> 0 : 0,
      epigenetic: { damaged: (this.epi[i] & EPI_DAMAGED) !== 0, starving: (this.epi[i] & EPI_STARVING) !== 0, raw: this.epi[i] & 3 },
      genome: alive ? decodeGenome(w0, w1) : null,
      ancestorDistance: dist,
      relationToAncestor: rel === 0 ? 'self' : rel === 1 ? 'kin' : 'foreign',
      cluster: alive ? this.floodCluster(i) : null,
    };
  }

  /** BFS over the kin-connected body containing cell `start` (capped at 8192 cells). */
  private floodCluster(start: number): ClusterStats {
    const N = this.N;
    if (!this.visit) this.visit = new Uint32Array(N);
    if (!this.queue) this.queue = new Int32Array(N);
    const visit = this.visit;
    const queue = this.queue;
    this.visitGen = (this.visitGen + 1) >>> 0;
    if (this.visitGen === 0) {
      visit.fill(0);
      this.visitGen = 1;
    }
    const gen = this.visitGen;
    const kin = this.genome[start * 2 + 1] & 0xffff;
    const LIMIT = 8192;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    visit[start] = gen;
    let core = 0;
    let armor = 0;
    let sensor = 0;
    let sumE = 0;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    const K = this.K;
    const WH = this.W * this.H;
    let truncated = false;
    while (head < tail) {
      const c = queue[head++];
      const t = this.somatic[c];
      if (t === SOMA.CORE) core++;
      else if (t === SOMA.ARMOR) armor++;
      else sensor++;
      sumE += this.energy[c];
      const cx = c % this.W;
      const cy = ((c / this.W) | 0) % this.H;
      const cz = (c / WH) | 0;
      if (cz < minZ) minZ = cz;
      if (cz > maxZ) maxZ = cz;
      if (cx < minX) minX = cx;
      if (cy < minY) minY = cy;
      if (cx > maxX) maxX = cx;
      if (cy > maxY) maxY = cy;
      for (let d = 0; d < K; d++) {
        const n = this.nbr[c * K + d];
        if (visit[n] === gen || this.somatic[n] === 0) continue;
        if (kinRelation(kin, this.genome[n * 2 + 1] & 0xffff) === 2) continue;
        visit[n] = gen;
        if (tail >= LIMIT) {
          truncated = true;
          continue;
        }
        queue[tail++] = n;
      }
    }
    const size = tail;
    return {
      size, core, armor, sensor,
      meanEnergy: size ? sumE / size : 0,
      totalEnergy: sumE,
      bbox: [minX, minY, maxX, maxY],
      zRange: [minZ, maxZ],
      truncated,
    };
  }

  // ===========================================================================
  // Frame packing (planar quantised layers for rendering & streaming)
  // ===========================================================================

  static frameBytes(W: number, H: number, D = 1): number {
    return W * H * D * LAYER_COUNT;
  }

  packFrame(out: Uint8Array): void {
    const N = this.N;
    const tick = this.tick;
    const a0 = this.ancestor[0];
    const a1 = this.ancestor[1];
    const g = this.genome;
    const oS = LAYER.STATE * N;
    const oE = LAYER.ENERGY * N;
    const oF = LAYER.FOOD * N;
    const oA = LAYER.SIGNAL_A * N;
    const oB = LAYER.SIGNAL_B * N;
    const oX = LAYER.FLUX * N;
    const oH = LAYER.HUE * N;
    const oD = LAYER.DISTANCE * N;
    for (let i = 0; i < N; i++) {
      const t = this.somatic[i];
      const ep = this.epi[i];
      out[oS + i] = t | (this.terrain[i] << 2) | ((ep & 3) << 3) | (t !== 0 && this.birth[i] === tick ? 32 : 0);
      out[oF + i] = (this.food[i] * 255 + 0.5) | 0;
      const sa = this.sigA[i];
      const sb = this.sigB[i];
      out[oA + i] = sa >= 1 ? 255 : (sa * 255) | 0;
      out[oB + i] = sb >= 1 ? 255 : (sb * 255) | 0;
      let fx = (this.flux[i] * 4000) | 0;
      fx = fx < -127 ? -127 : fx > 127 ? 127 : fx;
      out[oX + i] = 128 + fx;
      if (t !== 0) {
        out[oE + i] = (this.energy[i] * 255 + 0.5) | 0;
        const w1 = g[i * 2 + 1];
        out[oH + i] = SimulationCore.hueOf(w1 & 0xffff);
        const d = (popcount32(g[i * 2] ^ a0) + popcount32(w1 ^ a1)) * 4;
        out[oD + i] = d > 255 ? 255 : d;
      } else {
        out[oE + i] = 0;
        out[oH + i] = 0;
        out[oD + i] = 0;
      }
    }
  }
}
