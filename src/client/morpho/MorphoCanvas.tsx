import { useEffect, useRef } from 'react';
import { MorphoGL } from './MorphoGL';
import { Director, type DirectorEvent } from './director';
import { regimeById, type Regime } from './regimes';
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
}

/** Imperative handle for the lab's buttons. */
export interface MorphoControl {
  setRegime(id: string): void;
  reseed(): void;
  nucleate(): void;
  setAuto(auto: boolean): void;
}

/**
 * Full-screen Morphogenesis world: GPU multi-channel Lenia + phase field, run by the Director and
 * fed by the quantum dice. The grid is shaped like the canvas (one cell per `cellPx` pixels).
 */
export default function MorphoCanvas({ regime, auto = true, cellPx = 3, stepsPerSecond = 30, onStatus, control }: {
  regime?: string;
  auto?: boolean;
  cellPx?: number;
  stepsPerSecond?: number;
  onStatus?: (s: MorphoStatus) => void;
  control?: React.MutableRefObject<MorphoControl | null>;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;
  const initial = useRef({ regime, auto });

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
    let current = regimeById(initial.current.regime);
    const director = new Director(sim, dice.next, initial.current.auto, (r) => { current = r; });
    director.setRegime(current);
    let raf = 0;
    let acc = 0;
    let last = performance.now();
    let lastStatus = 0;
    let started = false;
    let dirty = true;

    const fit = () => {
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
    const ro = new ResizeObserver(() => { if (started) fit(); });
    ro.observe(canvas);

    if (control) control.current = {
      setRegime: (id) => director.setRegime(regimeById(id), 0, true),
      reseed: () => { sim.reset(sim.W, sim.H); director.populate(); },
      nucleate: () => director.nucleate('rings'),
      setAuto: (a) => { director.auto = a; },
    };

    const frame = (now: number) => {
      acc += Math.min(0.25, (now - last) / 1000) * stepsPerSecond;
      last = now;
      let n = 0;
      while (acc >= 1 && n < 3) { sim.advance(); director.tick(); acc -= 1; n++; }
      if (acc >= 1) acc = 0;
      // The picture only changes when the world steps; on a 60–144 Hz display most frames don't.
      if (n > 0 || dirty) { sim.draw(canvas.width, canvas.height); dirty = false; }
      if (onStatusRef.current && now - lastStatus > 500) {
        lastStatus = now;
        const st = director.stats;
        const total = dice.counts.quantum + dice.counts.seeded;
        onStatusRef.current({
          regime: current, cover: st.cover, activity: st.activity, mass: st.mass, eigenmode: director.eigenmode,
          nonce: dice.lastQuantum, quantumShare: total ? dice.counts.quantum / total : 0, events: director.events, step: director.step,
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
      dice.stop();
      if (control) control.current = null;
    };
  }, [cellPx, stepsPerSecond, control]);

  return <canvas ref={ref} className="absolute inset-0 h-full w-full" />;
}
