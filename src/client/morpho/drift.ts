/**
 * Drift: smooth, endless randomisation of the look, colours and physics. A target is drawn at random
 * (a look preset jittered within sane ranges, a palette, possibly hue-rotated, and physics
 * overrides), and every value eases toward it over `period` seconds; then the next target is drawn
 * from where it landed. Nothing ever jumps: colours blend, sliders glide.
 * Parts switched off follow the viewer's own settings (also eased, so turning drift off glides back).
 */
import type { Regime } from './regimes';
import {
  driftRange, fromHex, LOOKS, OPTIC_KEYS, PALETTES, PHYSICS_KEYS,
  type DisplaySettings, type MorphoSettings, type PhysicsOverrides, type Rgb,
} from './settings';

type Physics = Required<PhysicsOverrides>;
interface State { display: DisplaySettings; physics: Physics; speed: number }
const KEYS = OPTIC_KEYS;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerpRgb = (a: Rgb, b: Rgb, t: number): Rgb => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Rotates a colour's hue by `deg` (rotation about the grey axis). */
function hueRotate(c: Rgb, deg: number): Rgb {
  const a = (deg * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a), k = (1 - cos) / 3, s = Math.sqrt(1 / 3) * sin;
  const [r, g, b] = c;
  return [
    clamp01(r * (cos + k) + g * (k - s) + b * (k + s)),
    clamp01(r * (k + s) + g * (cos + k) + b * (k - s)),
    clamp01(r * (k - s) + g * (k + s) + b * (cos + k)),
  ];
}

export const physicsOf = (reg: Regime, o: PhysicsOverrides): Physics => ({
  speciation: o.speciation ?? reg.speciation ?? 0,
  curl: o.curl ?? reg.curl ?? 0,
  swirl: o.swirl ?? reg.swirl,
  vortexMu: o.vortexMu ?? reg.vortexMu ?? 0,
});

function blend(a: State, b: State, t: number): State {
  const display = { ...b.display };
  for (const k of KEYS) (display[k] as number) = lerp(a.display[k] as number, b.display[k] as number, t);
  display.colours = [0, 1, 2].map((i) => lerpRgb(a.display.colours[i], b.display.colours[i], t)) as [Rgb, Rgb, Rgb];
  display.background = lerpRgb(a.display.background, b.display.background, t);
  display.haloColour = lerpRgb(a.display.haloColour, b.display.haloColour, t);
  const physics = {} as Physics;
  for (const k of PHYSICS_KEYS) physics[k] = lerp(a.physics[k], b.physics[k], t);
  return { display, physics, speed: lerp(a.speed, b.speed, t) };
}

export class Drifter {
  private from: State | null = null;
  private to: State | null = null;
  private start = 0;
  private dur = 1;
  /** Whether it is driving the world (drifting, or still gliding back to the viewer's settings). */
  active = false;
  /** 0–1: how much flow (curl, swirl, vortex μ) drift may add; the load guard lowers it. */
  physicsCap = 1;

  constructor(private readonly rand: () => number) {}

  private target(from: State, s: MorphoSettings, own: Physics): State {
    const q = this.rand, dr = s.drift;
    const display = { ...s.display };
    if (dr.look) {
      const anchor = LOOKS[Math.floor(q() * LOOKS.length)].display;
      for (const k of KEYS) {
        const [lo, hi] = driftRange(dr, k);
        const base = (anchor[k] as number | undefined) ?? (from.display[k] as number);
        (display[k] as number) = Math.min(hi, Math.max(lo, base + (q() - 0.5) * 0.5 * (hi - lo)));
      }
    }
    if (dr.colours) {
      const p = PALETTES[Math.floor(q() * PALETTES.length)];
      const rot = q() < 0.5 ? q() * 360 : 0;
      display.colours = p.colours.map((c) => hueRotate(fromHex(c), rot)) as [Rgb, Rgb, Rgb];
      display.haloColour = hueRotate(fromHex(p.halo), rot);
      display.background = fromHex(p.background);
    }
    // Physics: anywhere in its range; the flow terms often rest at their minimum, and the load
    // guard's cap pulls their top down.
    const cap = this.physicsCap;
    const pick = (k: string, restChance: number, capped: boolean) => {
      const [lo, hi] = driftRange(dr, k);
      const top = capped ? lo + (hi - lo) * cap : hi;
      return q() < restChance ? lo : lo + q() * (top - lo);
    };
    const physics: Physics = dr.physics ? {
      speciation: pick('speciation', 0, false),
      curl: pick('curl', 0.4, true),
      swirl: pick('swirl', 0.5, true),
      vortexMu: pick('vortexMu', 0.4, true),
    } : own;
    const [slo, shi] = driftRange(dr, 'speed');
    const speed = dr.speed ? slo + q() * (shi - slo) : s.speed;
    return { display, physics, speed };
  }

  /**
   * The display and physics for this moment. `now` in ms; `own` is the viewer's physics for the
   * current regime (their overrides over the regime's values).
   */
  sample(now: number, s: MorphoSettings, own: Physics): State | null {
    const on = s.drift.enabled;
    if (!on && !this.active) return null;
    const mine: State = { display: s.display, physics: own, speed: s.speed };
    if (!this.from || !this.to) {
      this.from = mine;
      this.to = this.target(mine, s, own);
      this.start = now;
      this.dur = s.drift.period * 1000;
      this.active = true;
    }
    let t = (now - this.start) / this.dur;
    if (t >= 1) {
      this.from = this.to;
      if (!on) { this.active = false; this.from = this.to = null; return mine; }
      this.to = this.target(this.from, s, own);
      this.start = now;
      this.dur = s.drift.period * 1000;
      t = 0;
    }
    const e = t * t * t * (t * (t * 6 - 15) + 10);
    return blend(this.from, this.to, e);
  }

  /** Drift was switched off: glide from wherever it is back to the viewer's settings in 3 s. */
  release(now: number, s: MorphoSettings, own: Physics): void {
    if (!this.active || !this.from || !this.to) return;
    const t = Math.min(1, (now - this.start) / this.dur);
    this.from = blend(this.from, this.to, t * t * t * (t * (t * 6 - 15) + 10));
    this.to = { display: s.display, physics: own, speed: s.speed };
    this.start = now;
    this.dur = 3000;
  }

  /** The viewer changed a setting: the next target starts from here (the current one keeps going). */
  reset(): void {
    this.from = this.to = null;
    this.active = false;
  }
}
