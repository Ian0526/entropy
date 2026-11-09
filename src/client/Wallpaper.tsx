import { useEffect } from 'react';
import { useSimulation } from './useSimulation';
import type { LayerWeights } from './state';
import type { WorldId } from '../engine/protocol';
import SimulationCanvas from '../components/SimulationCanvas';
import SimulationCanvas3D from '../components/SimulationCanvas3D';
import SmoothLifeCanvas from './smoothlife/SmoothLifeCanvas';
import GenerationsCanvas from './generations/GenerationsCanvas';
import MorphoCanvas from './morpho/MorphoCanvas';

const LAYERS: LayerWeights = [1, 0, 0, 0];
const noop = () => {};

/**
 * /wallpaper: a world alone, full screen, no UI, nothing saved. Made to sit behind the desktop
 * icons (scripts/wallpaper).
 *   ?world=morpho[&regime=…][&auto=0]  the Morphogenesis world (GPU); auto=0 keeps it on one regime
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
      {world === 'morpho' ? <MorphoCanvas regime={q.get('regime') ?? undefined} auto={q.get('auto') !== '0'} cellPx={Number(q.get('cell')) || 4} />
        : world === 'machines' ? <GenerationsCanvas rule={q.get('rule') ?? 'bombers'} cellPx={Number(q.get('cell')) || 5} />
        : world === 'life' ? <SmoothLifeCanvas />
        : <EcosystemWallpaper world={world === '3d' ? '3d' : '2d'} />}
    </div>
  );
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
