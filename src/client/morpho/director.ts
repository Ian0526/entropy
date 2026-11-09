/**
 * The homeostatic Director keeps an unattended world interesting. Every 30 steps it reads the
 * field's vital signs (coverage and activity) and, using the quantum dice for every choice:
 *  - extinction (coverage < 4%): nucleates fresh seeds: harmonic rings cos(mφ), m ∈ {2,3,4,5,6,8};
 *  - overcrowding (coverage > 65%, or 85% for a lattice regime): erases a few disks, and after
 *    repeated crowding moves to another regime;
 *  - stagnation (activity low for 4 checks, not for lattices): nucleates and erases to stir;
 *  - otherwise drops in an occasional seed, and in auto mode drifts to a new regime every few
 *    minutes with μ nudged ±1% by the dice.
 * It never draws a shape: seeds are blurry rings and noise, and what they become is the physics.
 *
 * Regime changes are morphs, not resets: the law itself is interpolated over ~30 s (see
 * regimes.morphKind), so organisms grow, shrink or dissolve into the new forms. Only when two laws
 * can't share the shader is the world dimmed to black, reseeded and brought back up.
 * A cost cap (set by the load guard in MorphoCanvas) keeps it away from regimes too heavy for the GPU.
 */
import type { FieldStats, MorphoGL } from './MorphoGL';
import { blendRegimes, morphKind, REGIMES, regimeCost, type Regime } from './regimes';
import type { PhysicsOverrides } from './settings';

export interface DirectorEvent { step: number; text: string }

export class Director {
  step = 0;
  stats: FieldStats = { cover: 0, mass: [0, 0, 0], activity: 0 };
  /** Harmonic m of the most recent ring seed (0 if the last seed was a noise patch). */
  eigenmode = 0;
  events: DirectorEvent[] = [];
  auto: boolean;
  private still = 0;
  private crowded = 0;
  private sinceShift = 0;
  /** Growth-centre offset for mass homeostasis. */
  dmu = 0;
  /** Viewer's physics overrides, applied on top of whichever regime is loaded. */
  overrides: PhysicsOverrides = {};
  /** The loaded regime as the physics runs it (jittered μ, before the overrides). */
  private loaded: Regime | null = null;
  /** The regime being morphed toward, if any. */
  morph: { from: Regime; to: Regime; kind: 'pair' | 'union' | 'fade'; step: number; steps: number; seeded: boolean } | null = null;
  /** Regimes costlier than this (regimeCost) are not drifted to. */
  costCap = Infinity;
  /** Steps between regime drifts in auto mode. */
  driftEvery = 7200;

  constructor(private readonly sim: MorphoGL, private readonly rand: () => number, auto: boolean, private readonly onRegime: (r: Regime) => void) {
    this.auto = auto;
  }

  private log(text: string) {
    this.events = [{ step: this.step, text }, ...this.events].slice(0, 8);
  }

  private at(): [number, number] {
    return [this.rand() * this.sim.W, this.rand() * this.sim.H];
  }

  /** Seeds a fresh world in proportion to its area. */
  populate(): void {
    const { W, H, regime } = this.sim;
    const n = Math.max(3, Math.round((W * H) / (regime.R * regime.R * 24)));
    for (let i = 0; i < n; i++) this.nucleate(regime.seed);
    this.log(`seeded ${n} ${regime.seed === 'rings' ? 'harmonic rings' : 'noise patches'}`);
  }

  nucleate(kind = this.sim.regime.seed): void {
    const m = this.sim.seed(...this.at(), kind);
    if (kind === 'rings') this.eigenmode = m;
  }

  /**
   * Loads a regime. With `fresh` the field is cleared and reseeded first: matter grown under one
   * law only lingers as debris under another.
   */
  setRegime(reg: Regime, jitter = 0, fresh = false): void {
    const kernels = jitter ? reg.kernels.map((k) => ({ ...k, m: k.m * (1 + jitter * (this.rand() * 2 - 1)) })) : reg.kernels;
    this.loaded = { ...reg, kernels };
    this.morph = null;
    this.sim.dim = 1;
    this.sim.setRegime({ ...this.loaded, ...this.overrides });
    this.dmu = 0;
    this.sim.setDmu(0);
    if (fresh && this.sim.W) {
      this.sim.reset(this.sim.W, this.sim.H);
      this.populate();
    }
    this.still = 0;
    this.crowded = 0;
    this.sinceShift = 0;
    this.onRegime(reg);
    this.log(`regime → ${reg.name}`);
  }

  /** New overrides take effect at once, on the world as it is. */
  setOverrides(o: PhysicsOverrides): void {
    this.overrides = o;
    if (!this.loaded) return;
    this.sim.setRegime({ ...this.loaded, ...o });
    this.sim.setDmu(this.dmu);
  }

  /** Regimes the drift may move to: affordable, and preferably ones that morph without a fade. */
  private candidates(): Regime[] {
    const cur = this.loaded ?? this.sim.regime;
    const id = this.morph?.to.id ?? this.sim.regime.id;
    let pool = REGIMES.filter((r) => r.id !== id && regimeCost(r) <= this.costCap);
    if (!pool.length) pool = [...REGIMES].filter((r) => r.id !== id).sort((a, b) => regimeCost(a) - regimeCost(b)).slice(0, 1);
    const smooth = pool.filter((r) => morphKind(cur, r));
    return smooth.length && this.rand() < 0.8 ? smooth : pool;
  }

  private shift(reason: string): void {
    const pool = this.candidates();
    const next = pool[Math.floor(this.rand() * pool.length)];
    this.log(reason);
    this.transitionTo(next, 900, 0.01);
  }

  /** Morphs the world into another regime over `steps` steps (see the class comment). */
  transitionTo(reg: Regime, steps = 900, jitter = 0): void {
    const to = jitter ? { ...reg, kernels: reg.kernels.map((k) => ({ ...k, m: k.m * (1 + jitter * (this.rand() * 2 - 1)) })) } : reg;
    const from = this.loaded ?? this.sim.regime;
    if (!from || !this.sim.W) { this.setRegime(to, 0, true); return; }
    const kind = morphKind(from, to) ?? 'fade';
    this.morph = { from, to, kind, step: 0, steps: kind === 'fade' ? 120 : steps, seeded: false };
    this.sinceShift = 0;
    this.log(`morphing → ${reg.name}${kind === 'fade' ? ' (crossfade)' : ''}`);
  }

  /** Lighter regime now, if the current one is over the cost cap. */
  relieve(): void {
    const cur = this.morph?.to ?? this.sim.regime;
    if (regimeCost(cur) > this.costCap) this.shift('GPU load: moving to a lighter regime');
    else if (this.stats.cover > 0.12) {
      for (let i = 0; i < 3; i++) {
        const [x, y] = this.at();
        this.sim.stamp({ kind: 'erase', x, y, size: cur.R * 3 });
      }
      this.log('GPU load: thinned the field');
    }
  }

  private advanceMorph(): void {
    const m = this.morph!;
    m.step++;
    const t = Math.min(1, m.step / m.steps);
    if (m.kind === 'fade') {
      const half = m.steps / 2;
      if (m.step === Math.round(half)) {
        this.setRegime(m.to, 0, true);
        this.morph = m; // setRegime ends any morph; this one still has to fade back in
      }
      this.sim.dim = Math.abs(1 - m.step / half);
      if (t >= 1) { this.sim.dim = 1; this.morph = null; }
      return;
    }
    // A union brings in laws that may need forms of their own: seed a few a third of the way in.
    if (m.kind === 'union' && !m.seeded && t > 0.33) {
      m.seeded = true;
      for (let i = 0; i < 4; i++) this.sim.seed(...this.at(), m.to.seed);
    }
    if (t >= 1) {
      this.morph = null;
      this.setRegime(m.to);
      return;
    }
    if (m.step % 3) return;
    const e = t * t * (3 - 2 * t);
    this.loaded = blendRegimes(m.from, m.to, e, m.kind);
    this.sim.setRegime({ ...this.loaded, ...this.overrides });
    this.sim.setDmu(this.dmu);
  }

  /** Call once per simulation step. */
  tick(): void {
    this.step++;
    this.sinceShift++;
    if (this.morph) this.advanceMorph();
    if (this.step % 30) return;
    const s = (this.stats = this.sim.stats());
    const reg = this.sim.regime;
    const maxCover = reg.lattice ? 0.85 : 0.65;

    // Mass homeostasis: above 18% coverage μ creeps up (starving the weakest matter), and relaxes
    // back once there is room again. Capped, so it nudges a regime rather than replacing it.
    if (!reg.lattice) {
      const before = this.dmu;
      if (s.cover > 0.18) this.dmu = Math.min(0.03, this.dmu + 0.002);
      else if (s.cover < 0.1) this.dmu = Math.max(0, this.dmu - 0.001);
      if (this.dmu !== before) this.sim.setDmu(this.dmu);
    }

    if (s.cover < 0.04) {
      const n = 2 + Math.floor(this.rand() * 3);
      for (let i = 0; i < n; i++) this.nucleate('rings');
      if (reg.seed === 'patches') this.nucleate('patches');
      this.log(`extinction (${(s.cover * 100).toFixed(1)}%): nucleated ${n} rings, m=${this.eigenmode}`);
      return;
    }
    if (s.cover > maxCover) {
      this.crowded++;
      for (let i = 0; i < 4; i++) {
        const [x, y] = this.at();
        this.sim.stamp({ kind: 'erase', x, y, size: reg.R * 3 });
      }
      this.log(`overcrowded (${(s.cover * 100).toFixed(0)}%): cleared 4 voids`);
      if (this.crowded >= 3 && this.auto && !this.morph) this.shift('crowding persists');
      return;
    }
    this.crowded = 0;
    this.still = !reg.lattice && s.activity < 0.6 ? this.still + 1 : 0;
    if (this.still >= 4) {
      this.still = 0;
      const [x, y] = this.at();
      this.sim.stamp({ kind: 'erase', x, y, size: reg.R * 2.5 });
      this.nucleate('rings');
      this.log(`stagnant: stirred, nucleated m=${this.eigenmode}`);
      return;
    }
    // Background rain: an occasional fresh seed so new forms keep arriving.
    if (this.step % 900 === 0) {
      const kind = this.rand() < 0.5 ? 'rings' : reg.seed;
      this.nucleate(kind);
      this.log(kind === 'rings' ? `quantum ring seed, m=${this.eigenmode}` : 'quantum noise seed');
    }
    // About every 4 minutes at 30 steps/s, drift to another regime.
    if (this.auto && !this.morph && this.sinceShift > this.driftEvery && this.rand() < 0.05) this.shift('regime drift');
  }
}
