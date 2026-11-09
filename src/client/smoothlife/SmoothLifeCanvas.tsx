import { useEffect, useRef } from 'react';
import { DEFAULT_SMOOTHLIFE, SmoothLifeGL } from './SmoothLifeGL';
import { QuantumDice } from './quantumDice';

/**
 * Full-screen SmoothLife world fed by quantum rain. The world is shaped like the canvas, one cell
 * per `cellPx` screen pixels, and restarts if the canvas changes shape (e.g. when the wallpaper
 * window is stretched across the desktop right after it opens).
 */
export default function SmoothLifeCanvas({ cellPx = 4, stepsPerSecond = 24 }: { cellPx?: number; stepsPerSecond?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current!;
    const dice = new QuantumDice();
    let sim: SmoothLifeGL;
    try {
      sim = new SmoothLifeGL(canvas, DEFAULT_SMOOTHLIFE, dice.next);
    } catch (err) {
      console.error('SmoothLife unavailable:', err);
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
      if (acc >= 1) acc = 0; // fell behind: drop steps rather than spiral
      sim.draw(canvas.width, canvas.height, acc);
      raf = requestAnimationFrame(frame);
    };

    // Wait for the first quantum batch (or its failure) so the opening splats come from it.
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
  }, [cellPx, stepsPerSecond]);

  return <canvas ref={ref} className="absolute inset-0 h-full w-full" />;
}
