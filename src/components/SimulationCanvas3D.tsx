import { useEffect, useRef, type MutableRefObject } from 'react';
import type { ToolKind } from '../engine/protocol';
import type { FrameStore } from '../client/useSimulation';
import { cameraBasis, createRenderer3D, pickVoxel, type Brush3D, type Camera3D } from '../client/sim/renderer3d';
import type { LayerWeights } from '../client/state';

interface Props {
  frameRef: MutableRefObject<FrameStore>;
  layers: LayerWeights;
  tool: ToolKind;
  brushRadius: number;
  selected: { x: number; y: number; z: number } | null;
  onPaint: (x: number, y: number, z: number) => void;
  onInspect: (x: number, y: number, z: number) => void;
  onFps: (fps: number) => void;
  onUnsupported?: () => void;
}

const IDLE_SPIN_MS = 6000;

/**
 * 3D viewport: orbit camera around the world box, raymarched by Renderer3D.
 * Drag (Inspect tool, or right/middle button) orbits; Shift-drag or two fingers pan;
 * wheel/pinch zooms; a tap inspects the cell under the pointer; with a paint tool the
 * brush sits on the first cell the pointer ray meets, or mid-space at the orbit depth.
 * The view slowly drifts round when left alone.
 */
export default function SimulationCanvas3D(props: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  useEffect(() => {
    const canvas = canvasRef.current!;
    const renderer = createRenderer3D(canvas);
    if (!renderer) {
      propsRef.current.onUnsupported?.();
      return;
    }
    const cam: Camera3D = { tx: 32, ty: 32, tz: 32, yaw: 0.7, pitch: 0.42, dist: 120, fov: (50 * Math.PI) / 180 };
    let dims = [0, 0, 0];
    let fitted = false;
    let lastVersion = -1;
    let raf = 0;
    let cssW = 1;
    let cssH = 1;
    let lastInteract = performance.now();
    const hover = { x: 0, y: 0, inside: false, dirty: false };
    let hoverPick: { x: number; y: number; z: number } | null = null;

    const fit = () => {
      if (!dims[0]) return;
      cam.tx = dims[0] / 2;
      cam.ty = dims[1] / 2;
      cam.tz = dims[2] / 2;
      cam.dist = Math.max(dims[0], dims[1], dims[2]) * 1.85 * Math.max(1, cssH / cssW);
      cam.pitch = 0.42;
    };
    const maxDist = () => Math.max(dims[0], dims[1], dims[2], 16) * 4;

    const resize = () => {
      const r = canvas.getBoundingClientRect();
      cssW = Math.max(1, r.width);
      cssH = Math.max(1, r.height);
      renderer.resize(cssW, cssH, Math.min(window.devicePixelRatio || 1, 2));
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();

    const local = (e: PointerEvent | WheelEvent) => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const pick = (sx: number, sy: number) => {
      const fs = propsRef.current.frameRef.current;
      if (!fs.data || !dims[0]) return null;
      return pickVoxel(fs.data, dims[0], dims[1], dims[2], cam, sx, sy, cssW, cssH);
    };
    const zoom = (factor: number) => {
      cam.dist = Math.min(maxDist(), Math.max(4, cam.dist * factor));
    };
    const orbit = (dx: number, dy: number) => {
      cam.yaw -= dx * 0.006;
      cam.pitch = Math.max(-1.45, Math.min(1.45, cam.pitch + dy * 0.006));
    };
    const pan = (dx: number, dy: number) => {
      const b = cameraBasis(cam);
      const k = (cam.dist * 2 * Math.tan(cam.fov / 2)) / cssH;
      cam.tx += (-b.right[0] * dx + b.up[0] * dy) * k;
      cam.ty += (-b.right[1] * dx + b.up[1] * dy) * k;
      cam.tz += (-b.right[2] * dx + b.up[2] * dy) * k;
    };

    // ---- render loop ------------------------------------------------------------
    let frames = 0;
    let fpsT = performance.now();
    const t0 = performance.now();
    let lastT = t0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const now = performance.now();
      const dt = Math.min(0.1, (now - lastT) / 1000);
      lastT = now;
      const fs = propsRef.current.frameRef.current;
      if (fs.version !== lastVersion && fs.data && fs.depth > 1) {
        lastVersion = fs.version;
        if (fs.width !== dims[0] || fs.height !== dims[1] || fs.depth !== dims[2]) {
          dims = [fs.width, fs.height, fs.depth];
          fitted = false;
        }
        renderer.setFrame(fs.data, fs.width, fs.height, fs.depth);
        hover.dirty = true;
      }
      if (!fitted && dims[0]) {
        fit();
        fitted = true;
      }
      if (mode === 'idle' && now - lastInteract > IDLE_SPIN_MS) cam.yaw += dt * 0.06;

      const p = propsRef.current;
      let brush: Brush3D | null = null;
      if (p.tool !== 'inspect' && hover.inside) {
        if (hover.dirty) {
          hoverPick = pick(hover.x, hover.y);
          hover.dirty = false;
        }
        if (hoverPick) brush = { ...hoverPick, radius: p.tool === 'predator' ? Math.max(2, Math.min(4, p.brushRadius)) : p.brushRadius };
      }
      renderer.draw(cam, p.layers, brush, p.tool === 'inspect' ? p.selected : null, (now - t0) / 1000);
      frames++;
      if (now - fpsT >= 500) {
        p.onFps((frames * 1000) / (now - fpsT));
        frames = 0;
        fpsT = now;
      }
    };
    raf = requestAnimationFrame(loop);

    // ---- pointer interaction ----------------------------------------------------
    type Mode = 'idle' | 'orbit' | 'pan' | 'paint' | 'pinch';
    const pts = new Map<number, { x: number; y: number }>();
    let mode: Mode = 'idle';
    let downAt = { x: 0, y: 0, t: 0 };
    let moved = 0;
    let lastPaint = { x: -9999, y: -9999, z: -9999, t: 0 };
    let pinch = { dist: 1, camDist: 1, mid: { x: 0, y: 0 } };
    let lastTap = 0;

    const paintAt = (sx: number, sy: number, force = false) => {
      const c = pick(sx, sy);
      if (!c) return;
      const now = performance.now();
      const p = propsRef.current;
      const step = Math.max(1, p.brushRadius * 0.75);
      const d2 = (c.x - lastPaint.x) ** 2 + (c.y - lastPaint.y) ** 2 + (c.z - lastPaint.z) ** 2;
      if (!force && d2 < step * step && now - lastPaint.t < 120) return;
      if (!force && now - lastPaint.t < 30) return;
      lastPaint = { x: c.x, y: c.y, z: c.z, t: now };
      p.onPaint(c.x, c.y, c.z);
    };
    const pinchState = () => {
      const [a, b] = [...pts.values()];
      return { mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, dist: Math.hypot(a.x - b.x, a.y - b.y) || 1 };
    };

    const onDown = (e: PointerEvent) => {
      lastInteract = performance.now();
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        // Pointer already gone; interaction still works without capture.
      }
      const p = local(e);
      pts.set(e.pointerId, p);
      if (pts.size === 2) {
        const s = pinchState();
        pinch = { dist: s.dist, camDist: cam.dist, mid: s.mid };
        mode = 'pinch';
        return;
      }
      if (pts.size > 2) return;
      downAt = { x: p.x, y: p.y, t: performance.now() };
      moved = 0;
      const navButton = e.button === 1 || e.button === 2;
      if (e.shiftKey || e.button === 1) mode = 'pan';
      else if (propsRef.current.tool === 'inspect' || navButton) mode = 'orbit';
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
      hover.dirty = true;
      const prev = pts.get(e.pointerId);
      if (!prev) return;
      lastInteract = performance.now();
      pts.set(e.pointerId, p);
      if (mode === 'pinch' && pts.size >= 2) {
        const s = pinchState();
        cam.dist = Math.min(maxDist(), Math.max(4, pinch.camDist * (pinch.dist / s.dist)));
        pan(s.mid.x - pinch.mid.x, s.mid.y - pinch.mid.y);
        pinch.mid = s.mid;
        return;
      }
      const dx = p.x - prev.x;
      const dy = p.y - prev.y;
      moved += Math.abs(dx) + Math.abs(dy);
      if (mode === 'orbit') orbit(dx, dy);
      else if (mode === 'pan') pan(dx, dy);
      else if (mode === 'paint') paintAt(p.x, p.y);
    };

    const onUp = (e: PointerEvent) => {
      const p = local(e);
      const wasMode = mode;
      pts.delete(e.pointerId);
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
      if (pts.size === 1 && wasMode === 'pinch') {
        mode = 'orbit';
        moved = 999;
        return;
      }
      if (pts.size > 0) return;
      mode = 'idle';
      lastInteract = performance.now();
      if (e.pointerType !== 'mouse') hover.inside = false;
      const quick = performance.now() - downAt.t < 350;
      if ((wasMode === 'orbit' || wasMode === 'pan') && moved < 8 && quick && e.button !== 2) {
        const now = performance.now();
        if (now - lastTap < 300) {
          fit();
          lastTap = 0;
          return;
        }
        lastTap = now;
        const c = pick(p.x, p.y);
        if (c?.hit) propsRef.current.onInspect(c.x, c.y, c.z);
      }
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      lastInteract = performance.now();
      const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      zoom(Math.exp(delta * 0.0012));
    };
    const onLeave = () => {
      hover.inside = false;
    };
    const onContext = (e: Event) => e.preventDefault();
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLInputElement | null;
      if (el?.tagName === 'TEXTAREA' || (el?.tagName === 'INPUT' && el.type !== 'range')) return;
      lastInteract = performance.now();
      if (e.key === '0') fit();
      else if (e.key === '=' || e.key === '+') zoom(0.8);
      else if (e.key === '-') zoom(1.25);
      else if (e.key === 'ArrowLeft') orbit(-30, 0);
      else if (e.key === 'ArrowRight') orbit(30, 0);
      else if (e.key === 'ArrowUp') orbit(0, -30);
      else if (e.key === 'ArrowDown') orbit(0, 30);
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
