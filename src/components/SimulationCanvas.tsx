import { useEffect, useRef, type MutableRefObject } from 'react';
import type { ToolKind } from '../engine/protocol';
import type { FrameStore } from '../client/useSimulation';
import { createRenderer, type Camera, type Renderer } from '../client/sim/renderer';
import type { LayerWeights } from '../client/state';

interface Props {
  frameRef: MutableRefObject<FrameStore>;
  layers: LayerWeights;
  tool: ToolKind;
  brushRadius: number;
  selected: { x: number; y: number } | null;
  onPaint: (x: number, y: number) => void;
  onInspect: (x: number, y: number) => void;
  onFps: (fps: number) => void;
  onRenderer?: (kind: Renderer['kind']) => void;
  /** Fill the screen with one copy of the world (cropping a sliver if the aspect differs), refitting on resize. */
  cover?: boolean;
}

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 64;

/**
 * Full-bleed microscope viewport. Rendering runs on requestAnimationFrame (60 FPS)
 * independent of simulation ticks; all pointer input is unified through Pointer
 * Events (mouse, pen, touch) with `touch-action: none`.
 */
export default function SimulationCanvas(props: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  useEffect(() => {
    const canvas = canvasRef.current!;
    const renderer = createRenderer(canvas);
    propsRef.current.onRenderer?.(renderer.kind);
    const cam: Camera = { cx: 128, cy: 128, zoom: 3 };
    let fitted = false;
    let gridW = 0;
    let gridH = 0;
    let lastVersion = -1;
    let raf = 0;
    let cssW = 1;
    let cssH = 1;
    const hover = { x: 0, y: 0, inside: false };

    const fit = () => {
      if (!gridW) return;
      cam.cx = gridW / 2;
      cam.cy = gridH / 2;
      cam.zoom = propsRef.current.cover
        ? Math.max(cssW / gridW, cssH / gridH)
        : Math.max(MIN_ZOOM, Math.min(cssW / gridW, cssH / gridH) * 0.98);
    };

    const resize = () => {
      const r = canvas.getBoundingClientRect();
      cssW = Math.max(1, r.width);
      cssH = Math.max(1, r.height);
      renderer.resize(cssW, cssH, Math.min(window.devicePixelRatio || 1, 2));
      if (propsRef.current.cover) fitted = false;
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();

    const toWorld = (sx: number, sy: number) => ({
      x: (sx - cssW / 2) / cam.zoom + cam.cx,
      y: (sy - cssH / 2) / cam.zoom + cam.cy,
    });
    const wrapCell = (w: { x: number; y: number }) => ({
      x: ((Math.floor(w.x) % gridW) + gridW) % gridW,
      y: ((Math.floor(w.y) % gridH) + gridH) % gridH,
    });
    const local = (e: PointerEvent | WheelEvent) => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const zoomAt = (sx: number, sy: number, factor: number) => {
      const before = toWorld(sx, sy);
      cam.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, cam.zoom * factor));
      const after = toWorld(sx, sy);
      cam.cx += before.x - after.x;
      cam.cy += before.y - after.y;
    };

    // ---- frame / FPS loop -------------------------------------------------------
    let frames = 0;
    let fpsT = performance.now();
    const t0 = performance.now();
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const fs = propsRef.current.frameRef.current;
      if (fs.version !== lastVersion && fs.data && fs.depth <= 1) {
        lastVersion = fs.version;
        if (fs.width !== gridW || fs.height !== gridH) {
          gridW = fs.width;
          gridH = fs.height;
          fitted = false;
        }
        renderer.setFrame(fs.data, fs.width, fs.height);
      }
      if (!fitted && gridW) {
        fit();
        fitted = true;
      }
      const p = propsRef.current;
      let brush = null;
      if (p.tool !== 'inspect' && hover.inside && gridW) {
        const c = wrapCell(toWorld(hover.x, hover.y));
        brush = { x: c.x + 0.5, y: c.y + 0.5, radius: p.tool === 'predator' ? Math.max(2, Math.min(4, p.brushRadius)) : p.brushRadius };
      } else if (p.tool === 'inspect' && p.selected) {
        brush = { x: p.selected.x + 0.5, y: p.selected.y + 0.5, radius: 1.5 };
      }
      renderer.draw(cam, p.layers, brush, (performance.now() - t0) / 1000);
      frames++;
      const now = performance.now();
      if (now - fpsT >= 500) {
        p.onFps((frames * 1000) / (now - fpsT));
        frames = 0;
        fpsT = now;
      }
    };
    raf = requestAnimationFrame(loop);

    // ---- pointer interaction ----------------------------------------------------
    type Mode = 'idle' | 'pan' | 'paint' | 'pinch';
    const pts = new Map<number, { x: number; y: number }>();
    let mode: Mode = 'idle';
    let downAt = { x: 0, y: 0, t: 0 };
    let moved = 0;
    let lastPaint = { x: -9999, y: -9999, t: 0 };
    let pinch = { dist: 1, zoom: 1, wx: 0, wy: 0 };
    let lastTap = 0;

    const paintAt = (sx: number, sy: number, force = false) => {
      if (!gridW) return;
      const c = wrapCell(toWorld(sx, sy));
      const now = performance.now();
      const p = propsRef.current;
      const step = Math.max(1, p.brushRadius * 0.75);
      const dx = c.x - lastPaint.x;
      const dy = c.y - lastPaint.y;
      if (!force && dx * dx + dy * dy < step * step && now - lastPaint.t < 120) return;
      if (!force && now - lastPaint.t < 30) return;
      lastPaint = { x: c.x, y: c.y, t: now };
      p.onPaint(c.x, c.y);
    };

    const pinchState = () => {
      const [a, b] = [...pts.values()];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      return { mid, dist: Math.hypot(a.x - b.x, a.y - b.y) || 1 };
    };

    const onDown = (e: PointerEvent) => {
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        // Pointer already gone (e.g. very fast tap); interaction still works without capture.
      }
      const p = local(e);
      pts.set(e.pointerId, p);
      if (pts.size === 2) {
        const s = pinchState();
        const w = toWorld(s.mid.x, s.mid.y);
        pinch = { dist: s.dist, zoom: cam.zoom, wx: w.x, wy: w.y };
        mode = 'pinch';
        return;
      }
      if (pts.size > 2) return;
      downAt = { x: p.x, y: p.y, t: performance.now() };
      moved = 0;
      const panButton = e.button === 1 || e.button === 2;
      if (propsRef.current.tool === 'inspect' || panButton) mode = 'pan';
      else {
        mode = 'paint';
        paintAt(p.x, p.y, true);
      }
    };

    const onMove = (e: PointerEvent) => {
      const p = local(e);
      hover.x = p.x;
      hover.y = p.y;
      hover.inside = true;
      const prev = pts.get(e.pointerId);
      if (!prev) return;
      pts.set(e.pointerId, p);
      if (mode === 'pinch' && pts.size >= 2) {
        const s = pinchState();
        cam.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, pinch.zoom * (s.dist / pinch.dist)));
        // Keep the world point that was under the fingers' midpoint pinned beneath it.
        cam.cx = pinch.wx - (s.mid.x - cssW / 2) / cam.zoom;
        cam.cy = pinch.wy - (s.mid.y - cssH / 2) / cam.zoom;
        return;
      }
      const dx = p.x - prev.x;
      const dy = p.y - prev.y;
      moved += Math.abs(dx) + Math.abs(dy);
      if (mode === 'pan') {
        cam.cx -= dx / cam.zoom;
        cam.cy -= dy / cam.zoom;
      } else if (mode === 'paint') {
        paintAt(p.x, p.y);
      }
    };

    const onUp = (e: PointerEvent) => {
      const p = local(e);
      const wasMode = mode;
      pts.delete(e.pointerId);
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
      if (pts.size === 1 && wasMode === 'pinch') {
        mode = 'pan'; // continue as a one-finger pan
        moved = 999;
        return;
      }
      if (pts.size > 0) return;
      mode = 'idle';
      if (e.pointerType !== 'mouse') hover.inside = false;
      const quick = performance.now() - downAt.t < 350;
      if (wasMode === 'pan' && moved < 8 && quick && e.button !== 2 && gridW) {
        const now = performance.now();
        if (now - lastTap < 300) {
          fit(); // double-tap / double-click → fit universe
          lastTap = 0;
          return;
        }
        lastTap = now;
        const c = wrapCell(toWorld(p.x, p.y));
        propsRef.current.onInspect(c.x, c.y);
      }
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = local(e);
      const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      zoomAt(p.x, p.y, Math.exp(-delta * 0.0015));
    };
    const onLeave = () => {
      hover.inside = false;
    };
    const onContext = (e: Event) => e.preventDefault();

    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLInputElement | null;
      if (el?.tagName === 'TEXTAREA' || (el?.tagName === 'INPUT' && el.type !== 'range')) return;
      if (e.key === '0') fit();
      else if (e.key === '=' || e.key === '+') zoomAt(cssW / 2, cssH / 2, 1.25);
      else if (e.key === '-') zoomAt(cssW / 2, cssH / 2, 0.8);
    };

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('contextmenu', onContext);
    window.addEventListener('keydown', onKey);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('contextmenu', onContext);
      window.removeEventListener('keydown', onKey);
      renderer.dispose();
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 h-full w-full cursor-crosshair"
      style={{ touchAction: 'none', width: '100dvw', height: '100dvh' }}
    />
  );
}
