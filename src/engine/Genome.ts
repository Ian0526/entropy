/**
 * 64-bit genome, packed into two Uint32 words per cell (stride 2).
 *
 *  Word 0                                   Word 1
 *  bits  0-5   harvestGain      (6)         bits  0-15  kinHash        (16)
 *  bits  6-11  emitThreshold    (6)         bits 16-21  pumpStrength   (6)
 *  bits 12-17  divideThreshold  (6)         bits 22-27  aggression     (6)
 *  bits 18-23  chemoFood        (6, signed) bits 28-29  sensorBias     (2)
 *  bits 24-29  chemoSignal      (6, signed) bits 30-31  armorBias      (2)
 *  bits 30-31  motility         (2)
 *
 * Word 2 — the developmental program ("dev" word, stored in its own array):
 *  bits  0-3   turingGain     (4)  activator self-production of the Turing pair
 *  bits  4-7   turingRange    (4)  inhibitor diffusion (pattern wavelength)
 *  bits  8-11  adultSize      (4)  max divisions from the zygote (2 … 17)
 *  bits 12-14  growLow        (3)  growth directions when the activator is low: forward | back | sideways
 *  bits 15-17  growHigh       (3)  growth directions when the activator is high
 *  bits 18-25  typeTable      (8)  4 × 2-bit cell type for (activator high?, edge?): 0 legacy roll, 1 core, 2 armor, 3 sensor
 *  bits 26-29  seedRate       (4)  how readily mature cells release a single-cell seed
 *  bit  30     developmental  (1)  1 = bounded organism with a body plan; 0 = open-ended colony (legacy)
 *  bit  31     axisMode       (1)  0 = children keep the parent's axis (bilateral); 1 = axis follows growth (radial)
 *
 * Every accessor is a branch-free shift/mask so it can be inlined in the hot loop.
 */
import type { QuantumEntropyEngine } from './QuantumEntropy';

const M6 = 0x3f;

// ---- raw field access -------------------------------------------------------
export const gHarvest = (w0: number) => w0 & M6;
export const gEmit = (w0: number) => (w0 >>> 6) & M6;
export const gDivide = (w0: number) => (w0 >>> 12) & M6;
export const gChemoFood = (w0: number) => (w0 >>> 18) & M6;
export const gChemoSignal = (w0: number) => (w0 >>> 24) & M6;
export const gMotility = (w0: number) => (w0 >>> 30) & 3;
export const gKin = (w1: number) => w1 & 0xffff;
export const gPump = (w1: number) => (w1 >>> 16) & M6;
export const gAggression = (w1: number) => (w1 >>> 22) & M6;
export const gSensorBias = (w1: number) => (w1 >>> 28) & 3;
export const gArmorBias = (w1: number) => (w1 >>> 30) & 3;

// ---- developmental word (w2) -------------------------------------------------
export const DEV_FWD = 1;
export const DEV_BACK = 2;
export const DEV_SIDE = 4;
export const isDevelopmental = (w2: number) => ((w2 >>> 30) & 1) === 1;
export const axisFollowsGrowth = (w2: number) => ((w2 >>> 31) & 1) === 1;
export const turingGain = (w2: number) => 0.7 + (w2 & 15) * 0.04; //               0.7 … 1.3
export const turingRange = (w2: number) => 0.12 + ((w2 >>> 4) & 15) * 0.008; //     0.12 … 0.24 (2D)
export const adultSize = (w2: number) => 2 + ((w2 >>> 8) & 15); //                  2 … 17
export const growMask = (w2: number, high: boolean) => (w2 >>> (high ? 15 : 12)) & 7;
/** Cell type for (activator high, at an edge): 0 = legacy probabilistic roll, else SOMA code. */
export const typeFor = (w2: number, high: boolean, edge: boolean) => (w2 >>> (18 + ((high ? 2 : 0) | (edge ? 1 : 0)) * 2)) & 3;
export const seedRate = (w2: number) => 0.02 + ((w2 >>> 26) & 15) * 0.02; //       0.02 … 0.32 per mature action

export function packDev(f: {
  gain: number; range: number; size: number; growLow: number; growHigh: number;
  types: [number, number, number, number]; seed: number; developmental: boolean; radial: boolean;
}): number {
  return (
    ((f.gain & 15) |
      ((f.range & 15) << 4) |
      ((f.size & 15) << 8) |
      ((f.growLow & 7) << 12) |
      ((f.growHigh & 7) << 15) |
      ((f.types[0] & 3) << 18) | ((f.types[1] & 3) << 20) | ((f.types[2] & 3) << 22) | ((f.types[3] & 3) << 24) |
      ((f.seed & 15) << 26) |
      ((f.developmental ? 1 : 0) << 30) |
      ((f.radial ? 1 : 0) << 31)) >>>
    0
  );
}

/**
 * A starter body plan: grow in every direction where the activator is low, only along the axis
 * where it peaks; core tissue, with sensors on the edge wherever the activator peaks (Turing spots),
 * a mid-sized adult that sheds seeds. Evolution takes it from there.
 */
export function makeBodyPlan(): number {
  return packDev({
    gain: 8, range: 15, size: 7, growLow: DEV_FWD | DEV_BACK | DEV_SIDE, growHigh: DEV_FWD | DEV_BACK,
    types: [1, 1, 1, 3], seed: 6, developmental: true, radial: false,
  });
}

/** Mutate the developmental word: geometric bit flips plus an occasional ±1..2 nudge of a 4-bit field. */
const DEV_FIELD_SHIFTS = [0, 4, 8, 26];
export function mutateDev(dev: Uint32Array, i: number, mu: number, q: QuantumEntropyEngine): void {
  while (q.nextFloat() < mu) dev[i] = (dev[i] ^ (1 << (q.nextUint32() & 31))) >>> 0;
  if (q.nextFloat() < mu) {
    const sh = DEV_FIELD_SHIFTS[q.nextUint32() & 3];
    const cur = (dev[i] >>> sh) & 15;
    let nv = Math.round(cur + q.nextGaussian() * 1.5);
    nv = nv < 0 ? 0 : nv > 15 ? 15 : nv;
    dev[i] = ((dev[i] & ~(15 << sh)) | (nv << sh)) >>> 0;
  }
}

// ---- phenotype mapping -----------------------------------------------------
export const harvestGain = (w0: number) => 0.5 + gHarvest(w0) / 63; //            0.5 … 1.5
export const emitThreshold = (w0: number) => 0.15 + (gEmit(w0) / 63) * 0.75; //    0.15 … 0.9
export const divideThreshold = (w0: number) => 0.35 + (gDivide(w0) / 63) * 0.5; // 0.35 … 0.85
export const chemoFood = (w0: number) => (gChemoFood(w0) - 31.5) / 31.5; //        -1 … 1
export const chemoSignal = (w0: number) => (gChemoSignal(w0) - 31.5) / 31.5; //    -1 … 1
export const motility = (w0: number) => gMotility(w0) / 3; //                       0 … 1
export const pumpStrength = (w1: number) => gPump(w1) / 63; //                      0 … 1
export const aggression = (w1: number) => gAggression(w1) / 63; //                  0 … 1
export const sensorBias = (w1: number) => gSensorBias(w1) / 3;
export const armorBias = (w1: number) => gArmorBias(w1) / 3;

/** Hamming weight of a 32-bit integer (SWAR). */
export function popcount32(x: number): number {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return Math.imul(x, 0x01010101) >>> 24;
}

/** Kin-recognition: 0 = self (identical hash), 1 = kin (≤ KIN_RADIUS bits apart), 2 = foreign. */
export const KIN_RADIUS = 2;
export function kinRelation(kinA: number, kinB: number): 0 | 1 | 2 {
  if (kinA === kinB) return 0;
  return popcount32((kinA ^ kinB) & 0xffff) <= KIN_RADIUS ? 1 : 2;
}

export function packWord0(f: {
  harvest: number; emit: number; divide: number; chemoFood: number; chemoSignal: number; motility: number;
}): number {
  return (
    ((f.harvest & M6) |
      ((f.emit & M6) << 6) |
      ((f.divide & M6) << 12) |
      ((f.chemoFood & M6) << 18) |
      ((f.chemoSignal & M6) << 24) |
      ((f.motility & 3) << 30)) >>>
    0
  );
}

export function packWord1(f: { kin: number; pump: number; aggression: number; sensor: number; armor: number }): number {
  return (
    ((f.kin & 0xffff) |
      ((f.pump & M6) << 16) |
      ((f.aggression & M6) << 22) |
      ((f.sensor & 3) << 28) |
      ((f.armor & 3) << 30)) >>>
    0
  );
}

/** The canonical "seed ancestor" phenotype every universe starts from. */
export function makeAncestor(kin: number): [number, number] {
  return [
    packWord0({ harvest: 34, emit: 30, divide: 30, chemoFood: 50, chemoSignal: 44, motility: 1 }),
    packWord1({ kin, pump: 40, aggression: 8, sensor: 1, armor: 1 }),
  ];
}

/** Apex-predator archetype for the Predator Injector tool. */
export function makePredator(kin: number): [number, number] {
  return [
    packWord0({ harvest: 6, emit: 50, divide: 22, chemoFood: 20, chemoSignal: 58, motility: 3 }),
    packWord1({ kin, pump: 55, aggression: 63, sensor: 3, armor: 0 }),
  ];
}

/**
 * Quantum-seeded mutation operating in place on genome[base], genome[base+1].
 *  - Geometric number of single-bit flips (each extra flip with probability μ).
 *  - With probability μ, one 6-bit quantitative field receives a Gaussian nudge (σ = 2.5 steps).
 */
const FIELD_SHIFTS = [0, 6, 12, 18, 24, 16 + 32, 22 + 32]; // ≥32 → word 1
export function mutateInPlace(genome: Uint32Array, base: number, mu: number, q: QuantumEntropyEngine): boolean {
  let changed = false;
  while (q.nextFloat() < mu) {
    const bit = q.nextUint32() & 63;
    if (bit < 32) genome[base] = (genome[base] ^ (1 << bit)) >>> 0;
    else genome[base + 1] = (genome[base + 1] ^ (1 << (bit - 32))) >>> 0;
    changed = true;
  }
  if (q.nextFloat() < mu) {
    const s = FIELD_SHIFTS[q.nextUint32() % FIELD_SHIFTS.length];
    const w = s >= 32 ? base + 1 : base;
    const sh = s & 31;
    const cur = (genome[w] >>> sh) & M6;
    let nv = Math.round(cur + q.nextGaussian() * 2.5);
    nv = nv < 0 ? 0 : nv > 63 ? 63 : nv;
    genome[w] = ((genome[w] & ~(M6 << sh)) | (nv << sh)) >>> 0;
    changed = true;
  }
  return changed;
}

export interface DecodedGenome {
  hex: string;
  words: [number, number];
  harvestGain: number;
  emitThreshold: number;
  divideThreshold: number;
  chemoFood: number;
  chemoSignal: number;
  motility: number;
  kinHash: number;
  pumpStrength: number;
  aggression: number;
  sensorBias: number;
  armorBias: number;
  /** Developmental program (word 2). */
  dev: {
    word: number;
    developmental: boolean;
    radial: boolean;
    adultSize: number;
    turingGain: number;
    turingRange: number;
    growLow: number;
    growHigh: number;
    types: [number, number, number, number];
    seedRate: number;
  };
}

export function decodeGenome(w0: number, w1: number, w2 = 0): DecodedGenome {
  return {
    hex: (w1 >>> 0).toString(16).padStart(8, '0') + (w0 >>> 0).toString(16).padStart(8, '0'),
    words: [w0 >>> 0, w1 >>> 0],
    harvestGain: harvestGain(w0),
    emitThreshold: emitThreshold(w0),
    divideThreshold: divideThreshold(w0),
    chemoFood: chemoFood(w0),
    chemoSignal: chemoSignal(w0),
    motility: motility(w0),
    kinHash: gKin(w1),
    pumpStrength: pumpStrength(w1),
    aggression: aggression(w1),
    sensorBias: sensorBias(w1),
    armorBias: armorBias(w1),
    dev: {
      word: w2 >>> 0,
      developmental: isDevelopmental(w2),
      radial: axisFollowsGrowth(w2),
      adultSize: adultSize(w2),
      turingGain: turingGain(w2),
      turingRange: turingRange(w2),
      growLow: growMask(w2, false),
      growHigh: growMask(w2, true),
      types: [typeFor(w2, false, false), typeFor(w2, false, true), typeFor(w2, true, false), typeFor(w2, true, true)],
      seedRate: seedRate(w2),
    },
  };
}
