import { useEffect, useRef } from 'react';
import { GenerationsGL, RULES } from './GenerationsGL';
import { QuantumDice } from '../smoothlife/quantumDice';

/**
 * Full-screen Generations world fed by quantum rain: crisp cells, one per `cellPx` screen pixels,
 * shaped like the canvas. Restarts if the canvas changes shape.
 */
export default function GenerationsCanvas({ rule = 'bombers', cellPx = 3, stepsPerSecond = 30 }: { rule?: string; cellPx?: number; stepsPerSecond?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current!;
    const dice = new QuantumDice();
    let sim: GenerationsGL;
    try {
      sim = new GenerationsGL(canvas, RULES[rule] ?? RULES.bombers, dice.next);
    } catch (err) {
      console.error('Generations world unavailable:', err);
      return;
    }
    let raf = 0;
    let acc = 0;
    let last = performance.now();
    let started = false;

    const fit = () => {
      const w = Math.max(1, Math.round(canvas.clientWidth));
      const h = Math.max(1, Math.round(canvas.clientHeight));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      const gw = Math.max(64, Math.round(w / cellPx));
      const gh = Math.max(64, Math.round(h / cellPx));
      if (Math.abs(gw - sim.W) > sim.W * 0.05 || Math.abs(gh - sim.H) > sim.H * 0.05) sim.reset(gw, gh);
    };
    const ro = new ResizeObserver(() => { if (started) fit(); });
    ro.observe(canvas);

    const frame = (now: number) => {
      acc += Math.min(0.25, (now - last) / 1000) * stepsPerSecond;
      last = now;
      let n = 0;
      while (acc >= 1 && n < 3) { sim.advance(); acc -= 1; n++; }
      if (acc >= 1) acc = 0;
      sim.draw(canvas.width, canvas.height);
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
    };
  }, [rule, cellPx, stepsPerSecond]);

  return <canvas ref={ref} className="absolute inset-0 h-full w-full" style={{ imageRendering: 'pixelated' }} />;
}
