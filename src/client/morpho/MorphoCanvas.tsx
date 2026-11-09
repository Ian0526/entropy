import { useEffect, useRef } from 'react';
import { MorphoGL } from './MorphoGL';
import { Director, type DirectorEvent } from './director';
import { regimeById, regimeCost, type Regime } from './regimes';
import { Drifter, physicsOf } from './drift';
import { DEFAULT_SETTINGS, type MorphoSettings } from './settings';
import { QuantumDice } from '../smoothlife/quantumDice';

export interface MorphoStatus {
  regime: Regime;
  cover: number;
  activity: number;
  mass: [number, number, number];
  eigenmode: number;
  nonce: number;
  quantumShare: number;
  events: DirectorEvent[];
  step: number;
  /** Share of the GPU's time the world takes (null if the browser can't time it). */
  gpu: number | null;
  /** Fraction of the asked-for steps per second the load guard allows. */
  stepScale: number;
  /** The regime being morphed toward, if any. */
  morphingTo: string | null;
  /** The display as it is drawn right now (drift moves it). */
  display: MorphoSettings['display'];
}

/** Imperative handle for the lab's buttons. */
export interface MorphoControl {
  setRegime(id: string): void;
  reseed(): void;
  nucleate(): void;
  setAuto(auto: boolean): void;
}

/** Pointer events over these (the lab's panels and controls) don't touch the world. */
const UI = 'button,a,input,select,textarea,label,[data-hud]';
const RIPPLE_MS = 120;

/**
 * Full-screen Morphogenesis world: GPU multi-channel Lenia + phase field, run by the Director and
 * fed by the quantum dice. The grid is shaped like the canvas (one cell per `cellPx` pixels).
 * The pointer acts on it as settings.interaction says: moving stirs the liquid (or taps the cover
 * slip), clicking seeds, nucleates or erases. Settings can change while it runs.
 *
 * Drift (settings.drift) eases the look, colours and physics toward random targets without end,
 * and lets the Director morph between regimes. A load guard keeps the world inside its GPU budget
 * (settings.budget): it measures the GPU time of each frame and, when over, first runs fewer steps
 * per second, then thins the field, avoids heavy regimes and damps the flow drift adds; it lets
 * everything back as load falls.
 */
export default function MorphoCanvas({ regime, auto = true, settings = DEFAULT_SETTINGS, hold = 'run', onStatus, control }: {
  regime?: string;
  auto?: boolean;
  settings?: MorphoSettings;
  /**
   * From outside (the wallpaper's PC watcher): 'slow' while a game or heavy load runs: about 1–2
   * steps and 5 pictures a second, a negligible share of the GPU, but still alive.
   */
  hold?: 'run' | 'slow';
  onStatus?: (s: MorphoStatus) => void;
  control?: React.MutableRefObject<MorphoControl | null>;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const holdRef = useRef(hold);
  holdRef.current = hold;
  const initial = useRef({ regime, auto });
  const live = useRef<{ sim: MorphoGL; director: Director; fit: () => void; redraw: () => void } | null>(null);

  useEffect(() => {
    const canvas = ref.current!;
    const dice = new QuantumDice();
    let sim: MorphoGL;
    try {
      sim = new MorphoGL(canvas, dice.next);
    } catch (err) {
      console.error('Morphogenesis world unavailable:', err);
      return;
    }
    sim.display = settingsRef.current.display;
    let current = regimeById(initial.current.regime);
    let userAuto = initial.current.auto;
    const director = new Director(sim, dice.next, userAuto, (r) => { current = r; });
    director.overrides = settingsRef.current.physics;
    director.setRegime(current);
    let raf = 0;
    let acc = 0;
    let last = performance.now();
    let lastStatus = 0;
    let started = false;
    let dirty = true;

    const fit = () => {
      if (!started) return;
      const cellPx = settingsRef.current.cellPx;
      const w = Math.max(1, Math.round(canvas.clientWidth));
      const h = Math.max(1, Math.round(canvas.clientHeight));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      const gw = Math.max(96, Math.round(w / cellPx));
      const gh = Math.max(96, Math.round(h / cellPx));
      dirty = true;
      if (Math.abs(gw - sim.W) > sim.W * 0.05 || Math.abs(gh - sim.H) > sim.H * 0.05) {
        sim.reset(gw, gh);
        director.populate();
      }
    };
    const ro = new ResizeObserver(fit);
    ro.observe(canvas);
    live.current = { sim, director, fit, redraw: () => { dirty = true; } };

    if (control) control.current = {
      setRegime: (id) => director.transitionTo(regimeById(id), 300),
      reseed: () => { sim.reset(sim.W, sim.H); director.populate(); },
      nucleate: () => director.nucleate('rings'),
      setAuto: (a) => { userAuto = a; },
    };

    // The pointer, in grid cells. Movement is gathered per frame and applied as one stamp.
    const toGrid = (e: PointerEvent): [number, number] => {
      const r = canvas.getBoundingClientRect();
      return [((e.clientX - r.left) / r.width) * sim.W, ((e.clientY - r.top) / r.height) * sim.H];
    };
    let ptr: [number, number] | null = null;
    let drag: [number, number] = [0, 0];
    let lastRipple = 0;
    const overUi = (e: PointerEvent) => e.target instanceof Element && !!e.target.closest(UI);
    const onMove = (e: PointerEvent) => {
      if (!started || !sim.W) return;
      const p = toGrid(e);
      if (ptr && !overUi(e)) { drag[0] += p[0] - ptr[0]; drag[1] += p[1] - ptr[1]; }
      ptr = p;
    };
    const onLeave = () => { ptr = null; drag = [0, 0]; };
    const onDown = (e: PointerEvent) => {
      if (!started || !sim.W || e.button !== 0 || overUi(e)) return;
      const [x, y] = toGrid(e);
      const { click } = settingsRef.current.interaction;
      if (click === 'seed') {
        // A noise patch usually dissolves in a few steps; a copy of a living organism lives on.
        const src = sim.findLife();
        if (src) sim.stamp({ kind: 'clone', x, y, size: sim.regime.R * 1.6, drag: [src[0] - x, src[1] - y] });
        else sim.seed(x, y);
      }
      else if (click === 'ring') { director.eigenmode = sim.seed(x, y, 'rings'); }
      else if (click === 'erase') sim.stamp({ kind: 'erase', x, y, size: sim.regime.R * 2 });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerdown', onDown);
    document.documentElement.addEventListener('pointerleave', onLeave);

    const agitate = (now: number) => {
      const it = settingsRef.current.interaction;
      const [dx, dy] = drag;
      drag = [0, 0];
      if (!ptr || it.move === 'off' || (dx === 0 && dy === 0)) return;
      const R = sim.regime.R;
      const size = Math.max(2, R * it.radius);
      if (it.move === 'stir') {
        // Drag the liquid with the pointer, at most half a radius a frame.
        const k = 0.6 * it.strength, cap = size * 0.5;
        const len = Math.hypot(dx, dy) * k;
        const sc = len > cap ? cap / len : 1;
        sim.stamp({ kind: 'stir', x: ptr[0], y: ptr[1], size, drag: [dx * k * sc, dy * k * sc] });
      } else if (now - lastRipple > RIPPLE_MS) {
        // Tap the cover slip: a faint ring of mass (decays in empty space) and a phase kick.
        lastRipple = now;
        const a = 0.08 * it.strength;
        const amp = sim.used.map((u) => (u ? a : 0)) as [number, number, number];
        sim.stamp({ kind: 'ripple', x: ptr[0], y: ptr[1], size, width: 2, m: 3, phase: 0.25 * it.strength * dice.next(), amp, winding: 1 });
      }
    };

    // Drift and the load guard.
    const drifter = new Drifter(dice.next);
    let wasDrifting = false;
    let driftSpeed: number | null = null;
    let lastDraw = 0;
    let frameNo = 0;
    let stepScale = 1;
    let gpu: number | null = null;
    let gpuNs = 0, gpuSince = performance.now();
    let overFor = 0, underFor = 0, lastGuard = performance.now();
    let dropped = 0, frames = 0;

    const guard = (now: number) => {
      const ns = sim.gpuNs();
      if (ns !== null) gpuNs += ns;
      if (now - gpuSince < 1000) return;
      const s = settingsRef.current;
      const dt = (now - lastGuard) / 1000;
      lastGuard = now;
      if (sim.canTime) {
        const share = gpuNs / 1e6 / (now - gpuSince);
        gpu = gpu === null ? share : gpu * 0.6 + share * 0.4;
      } else {
        // No GPU timer: falling behind on steps is the only sign of overload.
        gpu = null;
      }
      gpuNs = 0;
      gpuSince = now;
      const over = gpu !== null ? gpu > s.budget : frames > 0 && dropped / frames > 0.2;
      const under = gpu !== null ? gpu < s.budget * 0.7 : dropped === 0;
      dropped = frames = 0;
      if (over) {
        overFor += dt;
        underFor = 0;
        const floor = s.minSteps;
        stepScale = Math.max(floor, stepScale * 0.85);
        // Fewer steps (down to the viewer's floor) hasn't done it: lighten the world itself.
        if (stepScale <= floor + 0.01 && overFor > 4) {
          overFor = 0;
          director.costCap = Math.min(director.costCap, regimeCost(sim.regime) * 0.8);
          drifter.physicsCap = Math.max(0.2, drifter.physicsCap * 0.7);
          director.relieve();
        }
      } else if (under) {
        underFor += dt;
        overFor = 0;
        stepScale = Math.min(1, stepScale * 1.05 + 0.01);
        if (underFor > 30) {
          underFor = 0;
          director.costCap = director.costCap * 1.25 > 4 * regimeCost(sim.regime) ? Infinity : director.costCap * 1.25;
          drifter.physicsCap = Math.min(1, drifter.physicsCap + 0.1);
        }
      } else {
        overFor = underFor = 0;
      }
    };

    const drift = (now: number) => {
      const s = settingsRef.current;
      if (s.drift.enabled !== wasDrifting) {
        if (!s.drift.enabled) drifter.release(now, s, physicsOf(current, s.physics));
        wasDrifting = s.drift.enabled;
      }
      director.auto = userAuto || (s.drift.enabled && s.drift.regimes);
      director.driftEvery = s.drift.enabled && s.drift.regimes ? Math.max(600, s.drift.period * s.speed * 2) : 7200;
      const st = drifter.sample(now, s, physicsOf(current, s.physics));
      driftSpeed = st ? st.speed : null;
      if (!st) return;
      sim.display = st.display;
      dirty = true;
      if (frameNo % 4 === 0) director.setOverrides(s.drift.physics || drifter.active ? st.physics : s.physics);
      if (!drifter.active) { sim.display = s.display; director.setOverrides(s.physics); }
    };

    const frame = (now: number) => {
      const held = holdRef.current;
      frameNo++;
      const slow = held === 'slow' ? 0.05 : 1;
      acc += Math.min(0.25, (now - last) / 1000) * (driftSpeed ?? settingsRef.current.speed) * stepScale * slow;
      last = now;
      agitate(now);
      drift(now);
      let n = 0;
      sim.beginTiming();
      while (acc >= 1 && n < 3) { sim.advance(); director.tick(); acc -= 1; n++; }
      frames++;
      if (acc >= 1) { acc = 0; dropped++; }
      // Smooth motion: every display frame (at most 60 a second) shows the world part way from the
      // previous step to the current one, so it glides at any step rate. Otherwise the picture only
      // changes when the world steps.
      if (settingsRef.current.smooth) {
        if (now - lastDraw > (held === 'slow' ? 195 : 15)) { lastDraw = now; sim.draw(canvas.width, canvas.height, Math.min(1, acc)); dirty = false; }
      } else if (n > 0 || dirty) { sim.draw(canvas.width, canvas.height); dirty = false; }
      sim.endTiming();
      guard(now);
      if (onStatusRef.current && now - lastStatus > 500) {
        lastStatus = now;
        const st = director.stats;
        const total = dice.counts.quantum + dice.counts.seeded;
        onStatusRef.current({
          regime: current, cover: st.cover, activity: st.activity, mass: st.mass, eigenmode: director.eigenmode,
          nonce: dice.lastQuantum, quantumShare: total ? dice.counts.quantum / total : 0, events: director.events, step: director.step,
          gpu, stepScale, morphingTo: director.morph?.to.name ?? null, display: sim.display,
        });
      }
      raf = requestAnimationFrame(frame);
    };

    void dice.start().finally(() => {
      started = true;
      fit();
      raf = requestAnimationFrame(frame);
    });

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerdown', onDown);
      document.documentElement.removeEventListener('pointerleave', onLeave);
      dice.stop();
      live.current = null;
      if (control) control.current = null;
    };
  }, [control]);

  // Live changes: the look redraws at once, physics overrides apply to the world as it is, and a
  // new cell size refits the grid (a fresh world if the size changes).
  useEffect(() => {
    const l = live.current;
    if (!l) return;
    l.sim.display = settings.display;
    l.redraw();
  }, [settings.display]);
  useEffect(() => { live.current?.director.setOverrides(settings.physics); }, [settings.physics]);
  useEffect(() => { live.current?.fit(); }, [settings.cellPx]);

  return <canvas ref={ref} className="absolute inset-0 h-full w-full" />;
}
