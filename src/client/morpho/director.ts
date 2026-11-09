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
 */
import type { FieldStats, MorphoGL } from './MorphoGL';
import { REGIMES, type Regime } from './regimes';

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
    this.sim.setRegime({ ...reg, kernels });
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

  private shift(reason: string): void {
    const others = REGIMES.filter((r) => r.id !== this.sim.regime.id);
    const next = others[Math.floor(this.rand() * others.length)];
    this.log(reason);
    this.setRegime(next, 0.01, true);
  }

  /** Call once per simulation step. */
  tick(): void {
    this.step++;
    this.sinceShift++;
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
      if (this.crowded >= 3 && this.auto) this.shift('crowding persists');
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
    if (this.auto && this.sinceShift > 7200 && this.rand() < 0.05) this.shift('regime drift');
  }
}
