/**
 * Multi-channel Lenia "regimes": the physics of the Morphogenesis world, as data.
 *
 * Three continuous fields A, B, C in [0,1]. Each kernel k reads one channel (c0) through a
 * concentric-ring kernel K_k and writes growth into one channel (c1):
 *
 *   U_k = K_k * A_c0                         (convolution over a disk of radius R·r_k)
 *   G_k = 2·exp(-(U_k - μ_k)² / 2σ_k²) - 1   (narrow bell: only a thin band of U grows)
 *   A_c += dt · Σ_{k: c1 = c} h_k · G_k       (then clamped to [0,1])
 *
 * K_k is a sum of Gaussian shells: ring i of B sits at radius (i + ½)/B of the kernel and is
 * weighted β_i; K is normalised to sum 1. No shape is built in anywhere: polygons, gliders and
 * lattices are whatever patterns happen to be stable under these ring/band balances.
 * scripts/morpho-probe.ts runs the same math on the CPU (FFT) to check a regime stays alive.
 */

export interface KernelSpec {
  /** Ring heights β_i, innermost first. */
  b: number[];
  /** Kernel radius as a fraction of the regime's R. */
  r: number;
  /** Growth centre μ and width σ. */
  m: number;
  s: number;
  /** Growth weight. */
  h: number;
  /** Source and target channel (0 = A, 1 = B, 2 = C). */
  c0: number;
  c1: number;
}

export interface Regime {
  id: string;
  name: string;
  blurb: string;
  /** Kernel radius in cells (may be fractional mid-transition), and time resolution (dt = 1/T). */
  R: number;
  T: number;
  kernels: KernelSpec[];
  /** How the world is seeded: noise patches, or quantum harmonic rings cos(mφ). */
  seed: 'patches' | 'rings';
  /** Phase dynamics: natural frequency, Kuramoto coupling, and swirl (advection along ∇⊥θ). */
  omega: number;
  sync: number;
  swirl: number;
  /** Flow along R·(flow·∇G + curl·(U_A − U_B)·∇⊥U); both default to 0. */
  flow?: number;
  curl?: number;
  /** Per-organism μ spread (genome g shifts μ by ±speciation and scales the curl by g). */
  speciation?: number;
  /** μ lowered by this much per unit |vorticity|·R. */
  vortexMu?: number;
  /** A crystal regime: dense and still is its healthy state, so the Director tolerates both. */
  lattice?: boolean;
}

/** Ring width of every shell, in units of the shell spacing (Lenia's "bell(·, 0.5, 0.15)"). */
export const SHELL_WIDTH = 0.15;

const bell = (x: number, m: number, s: number) => Math.exp(-((x - m) ** 2) / (2 * s * s));

/** K(ρ) for ρ = distance / (R·r) in [0,1). */
export function shell(b: number[], rho: number): number {
  if (rho <= 0 || rho >= 1) return 0;
  const B = b.length;
  const i = Math.min(B - 1, Math.floor(rho * B));
  return b[i] * bell((rho * B) % 1, 0.5, SHELL_WIDTH);
}

export const growth = (u: number, m: number, s: number) => 2 * bell(u, m, s) - 1;

/** The kernel's reach in whole cells (R may be fractional). */
export const reach = (R: number) => Math.ceil(R - 1e-6);

/** Normalised weights of kernel k over the (2⌈R⌉+1)² square of offsets, row-major from (-⌈R⌉,-⌈R⌉). */
export function kernelWeights(Rf: number, k: KernelSpec): Float32Array {
  const R = reach(Rf);
  const n = 2 * R + 1;
  const w = new Float32Array(n * n);
  let sum = 0;
  for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
    const v = shell(k.b, Math.hypot(dx, dy) / (Rf * k.r));
    w[(dy + R) * n + dx + R] = v;
    sum += v;
  }
  if (sum > 0) for (let i = 0; i < w.length; i++) w[i] /= sum;
  return w;
}

/**
 * The regime library. "Aquarium" is Bert Chan's multi-channel Lenia set (Lenia notebook), in
 * which three-colour creatures with bilateral and radial bodies swim, collide and bounce. The
 * others were tuned with scripts/morpho-probe.ts to sit between dying out and flooding.
 */
export const REGIMES: Regime[] = [
  {
    // Saved as it ran on the desktop on 2026-11-08 (wallpaper: -Regime protozoa -CellPx 3).
    id: 'protozoa', name: 'Bioluminescent Protozoa', seed: 'patches', R: 12, T: 2, omega: 0.02, sync: 0.4, swirl: 0,
    blurb: 'Bert Chan\'s "aquarium": three species coupled by 15 cross-channel kernels. Nucleated cells wrapped in shells of another species drift, bond into chains and colonies, and bounce apart.',
    kernels: [
      { b: [1], m: 0.272, s: 0.0595, h: 0.138, r: 0.91, c0: 0, c1: 0 },
      { b: [1], m: 0.349, s: 0.1585, h: 0.48, r: 0.62, c0: 0, c1: 0 },
      { b: [1, 1 / 4], m: 0.2, s: 0.0332, h: 0.284, r: 0.5, c0: 0, c1: 0 },
      { b: [0, 1], m: 0.114, s: 0.0528, h: 0.256, r: 0.97, c0: 1, c1: 1 },
      { b: [1], m: 0.447, s: 0.0777, h: 0.5, r: 0.72, c0: 1, c1: 1 },
      { b: [5 / 6, 1], m: 0.247, s: 0.0342, h: 0.622, r: 0.8, c0: 1, c1: 1 },
      { b: [1], m: 0.21, s: 0.0617, h: 0.35, r: 0.96, c0: 2, c1: 2 },
      { b: [1], m: 0.462, s: 0.1192, h: 0.218, r: 0.56, c0: 2, c1: 2 },
      { b: [1], m: 0.446, s: 0.1793, h: 0.556, r: 0.78, c0: 2, c1: 2 },
      { b: [11 / 12, 1], m: 0.327, s: 0.1408, h: 0.344, r: 0.79, c0: 0, c1: 1 },
      { b: [3 / 4, 1], m: 0.476, s: 0.0995, h: 0.456, r: 0.5, c0: 0, c1: 2 },
      { b: [11 / 12, 1], m: 0.379, s: 0.0697, h: 0.67, r: 0.72, c0: 1, c1: 0 },
      { b: [1], m: 0.262, s: 0.0877, h: 0.42, r: 0.68, c0: 1, c1: 2 },
      { b: [1 / 6, 1, 0], m: 0.412, s: 0.1101, h: 0.43, r: 0.82, c0: 2, c1: 0 },
      { b: [1], m: 0.201, s: 0.0786, h: 0.278, r: 0.82, c0: 2, c1: 1 },
    ],
  },
  {
    id: 'gliders', name: 'Glider Chains', seed: 'rings', R: 13, T: 10, omega: 0.03, sync: 0.6, swirl: 0,
    blurb: 'The Orbium law: one ring, one narrow band (μ 0.15, σ 0.015). Rings break into bilateral crescents that glide nose to tail as beaded chains.',
    kernels: [{ b: [1], m: 0.15, s: 0.015, h: 1, r: 1, c0: 0, c1: 0 }],
  },
  {
    id: 'radiolaria', name: 'Lobed Radiolarians', seed: 'patches', R: 13, T: 2, omega: 0.02, sync: 0.5, swirl: 0,
    blurb: 'Three shells weighted ½, 1, ⅔ (the Hydrogeminium law). Matter gathers into membraned cells that bud lobes, pulse and divide.',
    kernels: [{ b: [1 / 2, 1, 2 / 3], m: 0.26, s: 0.037, h: 1, r: 1, c0: 0, c1: 0 }],
  },
  {
    id: 'orbits', name: 'Orbital Binaries', seed: 'rings', R: 13, T: 10, omega: 0.05, sync: 1.2, swirl: 0.9,
    blurb: 'Gliders whose phase winds around them: the swirl term pushes matter along ∇⊥θ, so neighbours lock phase and circle each other.',
    kernels: [
      { b: [1], m: 0.15, s: 0.016, h: 0.8, r: 1, c0: 0, c1: 0 },
      { b: [1], m: 0.15, s: 0.016, h: 0.8, r: 1, c0: 1, c1: 1 },
      { b: [0, 1], m: 0.12, s: 0.04, h: 0.2, r: 1, c0: 0, c1: 1 },
      { b: [0, 1], m: 0.12, s: 0.04, h: 0.2, r: 1, c0: 1, c1: 0 },
    ],
  },
  {
    id: 'cymatics', name: 'Cymatic Lattice', seed: 'patches', R: 22, T: 5, omega: 0.08, sync: 1.5, swirl: 0.25, lattice: true,
    blurb: 'A broad band (σ 0.06) on a two-shell kernel: matter can tile but not swim, so two species interlock into a crystal of spots while phase waves run through it.',
    kernels: [
      { b: [1, 0.3], m: 0.18, s: 0.06, h: 1, r: 1, c0: 0, c1: 0 },
      { b: [0.2, 1], m: 0.18, s: 0.05, h: 0.6, r: 0.8, c0: 0, c1: 2 },
      { b: [1], m: 0.25, s: 0.08, h: 0.6, r: 0.5, c0: 2, c1: 2 },
    ],
  },
];

/**
 * Molecular Web: the Protozoa law at twice the scale (R 24), with every μ raised 0.02 (at R 24 the
 * unshifted law slowly floods; +0.01…+0.03 keeps organisms isolated, +0.036 dies), per-organism
 * genomes spreading μ ±0.01 and setting the spin, and the curl/vorticity flow switched on.
 */
const protozoa = REGIMES.find((r) => r.id === 'protozoa')!;
REGIMES.splice(1, 0, {
  ...protozoa,
  id: 'web', name: 'Molecular Web', R: 24,
  kernels: protozoa.kernels.map((k) => ({ ...k, m: k.m + 0.02 })),
  speciation: 0.01, curl: 1.35, flow: 0, vortexMu: 0.015,
  blurb: 'The Protozoa law at twice the scale. Each organism carries its own quantum genome: a slightly different law and its own spin, clockwise or counter-clockwise, driven by curl flow along the field.',
});

/**
 * Protozoa under the microscope: the same law at R 16 (μ +0.007 so the larger kernel doesn't flood),
 * with a touch of curl, swirl and speciation, so each colony gets its own hue and slowly rotates
 * while keeping Protozoa's chains and bounces.
 */
REGIMES.splice(1, 0, {
  ...protozoa,
  id: 'protozoa-hd', name: 'Protozoa · Microscope', R: 16, omega: 0.025, sync: 0.45, swirl: 0.08,
  kernels: protozoa.kernels.map((k) => ({ ...k, m: k.m + 0.007 })),
  speciation: 0.006, curl: 0.45, vortexMu: 0.008,
  blurb: 'Protozoa a third larger, each colony with its own genome: its own hue, a slightly different law, and a gentle spin from curl flow. Chains and bounces as in Protozoa.',
});

const ALIASES: Record<string, string> = { aquarium: 'protozoa' };
export const regimeById = (id: string | null | undefined) => {
  const key = id ? ALIASES[id] ?? id : id;
  return REGIMES.find((r) => r.id === key) ?? REGIMES[0];
};

/** Relative GPU cost of a regime's field pass per occupied cell: the taps in its disk, times kernel groups. */
export const regimeCost = (r: Regime) => r.R * r.R * Math.ceil(r.kernels.length / 4);

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const sameShape = (a: KernelSpec, b: KernelSpec) =>
  a.c0 === b.c0 && a.c1 === b.c1 && a.b.length === b.b.length;

/**
 * How two regimes can be morphed into each other:
 *  - 'pair': the same kernels in the same order (the Protozoa family): every number is interpolated,
 *    R included, so organisms grow or shrink into the new law;
 *  - 'union': both kernel sets fit in the shader at once: the old kernels' growth weights fade out
 *    while the new ones fade in, each at its own absolute radius;
 *  - null: neither; the world has to be dimmed, cleared and reseeded.
 */
export function morphKind(a: Regime, b: Regime, maxKernels = 16): 'pair' | 'union' | null {
  if (a.kernels.length === b.kernels.length && a.kernels.every((k, i) => sameShape(k, b.kernels[i]))) return 'pair';
  if (a.kernels.length + b.kernels.length <= maxKernels) return 'union';
  return null;
}

/** The law a fraction t of the way from a to b (see morphKind). */
export function blendRegimes(a: Regime, b: Regime, t: number, kind: 'pair' | 'union'): Regime {
  const num = (x: number | undefined, y: number | undefined) => lerp(x ?? 0, y ?? 0, t);
  const base: Regime = {
    ...(t < 0.5 ? a : b),
    omega: lerp(a.omega, b.omega, t), sync: lerp(a.sync, b.sync, t), swirl: lerp(a.swirl, b.swirl, t),
    flow: num(a.flow, b.flow), curl: num(a.curl, b.curl), speciation: num(a.speciation, b.speciation), vortexMu: num(a.vortexMu, b.vortexMu),
    T: lerp(a.T, b.T, t),
  };
  if (kind === 'pair') {
    return {
      ...base,
      R: lerp(a.R, b.R, t),
      kernels: a.kernels.map((k, i) => {
        const o = b.kernels[i];
        return { ...k, b: k.b.map((v, j) => lerp(v, o.b[j], t)), r: lerp(k.r, o.r, t), m: lerp(k.m, o.m, t), s: lerp(k.s, o.s, t), h: lerp(k.h, o.h, t) };
      }),
    };
  }
  // Union: one R that reaches both sets; each kernel keeps its own absolute radius.
  const R = Math.max(a.R, b.R);
  return {
    ...base,
    R,
    kernels: [
      ...a.kernels.map((k) => ({ ...k, r: (k.r * a.R) / R, h: k.h * (1 - t) })),
      ...b.kernels.map((k) => ({ ...k, r: (k.r * b.R) / R, h: k.h * t })),
    ],
  };
}
