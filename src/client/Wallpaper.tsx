import { useCallback, useEffect, useRef, useState } from 'react';
import { useSimulation } from './useSimulation';
import type { LayerWeights } from './state';
import type { WorldId } from '../engine/protocol';
import SimulationCanvas from '../components/SimulationCanvas';
import SimulationCanvas3D from '../components/SimulationCanvas3D';
import SmoothLifeCanvas from './smoothlife/SmoothLifeCanvas';
import GenerationsCanvas from './generations/GenerationsCanvas';
import MorphoCanvas, { type MorphoStatus } from './morpho/MorphoCanvas';
import { decodeSettings, DEFAULT_SETTINGS } from './morpho/settings';

const LAYERS: LayerWeights = [1, 0, 0, 0];
const noop = () => {};

/**
 * /wallpaper: a world alone, full screen, no UI, nothing saved. Made to sit behind the desktop
 * icons (scripts/wallpaper).
 *   ?world=morpho[&regime=…][&auto=0][&s=…]  the Morphogenesis world (GPU); auto=0 keeps it on one
 *       regime, s = the lab's settings (look, colours, interaction, physics; settings.ts)
 *   ?world=machines[&rule=bombers|starwars]  a Generations rule fed by quantum rain (GPU, this page)
 *   ?world=life  SmoothLife fed by quantum rain (GPU, this page)
 *   ?world=2d    the TuringLife ecosystem from the local server
 *   ?world=3d    the deep-space world, slowly spinning
 */
export default function Wallpaper() {
  const q = new URLSearchParams(window.location.search);
  const world = q.get('world');
  return (
    <div className="pointer-events-none relative h-[100dvh] w-[100dvw] cursor-none overflow-hidden bg-[#02040b]">
      {world === 'morpho' ? <MorphoWallpaper q={q} />
        : world === 'machines' ? <GenerationsCanvas rule={q.get('rule') ?? 'bombers'} cellPx={Number(q.get('cell')) || 5} />
        : world === 'life' ? <SmoothLifeCanvas />
        : <EcosystemWallpaper world={world === '3d' ? '3d' : '2d'} />}
    </div>
  );
}

function MorphoWallpaper({ q }: { q: URLSearchParams }) {
  // The window title counts pointer events and shows the load guard, so the desktop mouse relay
  // (scripts/wallpaper/mouse.ps1) and the GPU load can be checked from outside: nothing else about
  // this window is visible.
  const vitals = useRef('');
  const holdText = useRef('run');
  const onStatus = useCallback((st: MorphoStatus) => {
    vitals.current = ` · gpu ${st.gpu === null ? 'n/a' : Math.round(st.gpu * 100) + '%'} · steps ${Math.round(st.stepScale * 100)}% · ${st.regime.id}${st.morphingTo ? ' → ' + st.morphingTo : ''}`;
  }, []);
  useEffect(() => {
    let moves = 0, downs = 0, frames = 0, fps = 0, raf = 0;
    const count = () => { frames++; raf = requestAnimationFrame(count); };
    raf = requestAnimationFrame(count);
    const show = () => { document.title = `TuringLife wallpaper · pointer ${moves}/${downs} · ${fps} fps · ${holdText.current}${vitals.current}`; };
    const tick = setInterval(() => { fps = Math.round(frames / 2); frames = 0; show(); }, 2000);
    const mv = () => { moves++; if (moves % 10 === 1) show(); };
    const dn = () => { downs++; show(); };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerdown', dn);
    return () => { clearInterval(tick); cancelAnimationFrame(raf); window.removeEventListener('pointermove', mv); window.removeEventListener('pointerdown', dn); };
  }, []);
  // The PC watcher (scripts/wallpaper/watch.ps1) says when to slow to a crawl.
  const [hold, setHold] = useState<'run' | 'slow'>('run');
  useEffect(() => {
    let stop = false;
    const poll = async () => {
      try {
        const r = await fetch('/api/wallpaper/hold', { cache: 'no-store' });
        if (r.ok) { const h = await r.json(); if (!stop) setHold(h.level === 'slow' ? 'slow' : 'run'); }
      } catch { /* server gone: keep the last state */ }
    };
    void poll();
    const t = setInterval(poll, 2000);
    return () => { stop = true; clearInterval(t); };
  }, []);
  holdText.current = hold;
  const [settings] = useState(() => {
    const base = decodeSettings(q.get('s')) ?? DEFAULT_SETTINGS;
    return { ...base, cellPx: Number(q.get('cell')) || base.cellPx };
  });
  return <MorphoCanvas regime={q.get('regime') ?? undefined} auto={q.get('auto') !== '0'} settings={settings} hold={hold} onStatus={onStatus} />;
}

function EcosystemWallpaper({ world }: { world: WorldId }) {
  const sim = useSimulation({ kind: 'cloud', world });

  // The simulation may have been paused from another tab; a wallpaper always runs.
  useEffect(() => {
    if (sim.telemetry && !sim.telemetry.running) sim.send({ type: 'control', running: true });
  }, [sim, sim.telemetry?.running]);

  return world === '3d' ? (
    <SimulationCanvas3D frameRef={sim.frameRef} layers={LAYERS} tool="inspect" brushRadius={0} selected={null}
      onPaint={noop} onInspect={noop} onFps={noop} />
  ) : (
    <SimulationCanvas frameRef={sim.frameRef} layers={LAYERS} tool="inspect" brushRadius={0} selected={null}
      onPaint={noop} onInspect={noop} onFps={noop} cover />
  );
}
