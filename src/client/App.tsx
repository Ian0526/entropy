import { useCallback, useEffect, useRef, useState } from 'react';
import type { InspectResult, SimParams, SpeedMode, ToolKind } from '../engine/protocol';
import { useSimulation } from './useSimulation';
import { TOOLS, type LayerWeights } from './state';
import SimulationCanvas from '../components/SimulationCanvas';
import SimulationCanvas3D from '../components/SimulationCanvas3D';
import ControlDrawer, { BlendSliders, LayerToggles, PhysicsControls, SourceToggle, WorldToggle } from '../components/ControlDrawer';
import QuantumEntropyHUD from '../components/QuantumEntropyHUD';
import OrganismInspector from '../components/OrganismInspector';
import TelemetryPanel from '../components/TelemetryPanel';
import ActionBar, { PlayButton, SpeedControl, ToolPalette } from '../components/ActionBar';
import { BottomSheet, MobileHUD, MobileToolbar, type SheetTab } from '../components/MobileLayout';
import { Glass } from '../components/ui';
import { BuilderChat } from './builder/BuilderChat';

export default function App() {
  const sim = useSimulation();
  const t = sim.telemetry;
  const [tool, setTool] = useState<ToolKind>('inspect');
  const [brushRadius, setBrushRadius] = useState(3);
  const [strength, setStrength] = useState(0.8);
  const [layers, setLayers] = useState<LayerWeights>([1, 0, 0, 0]);
  const [fps, setFps] = useState(0);
  const [selected, setSelected] = useState<{ x: number; y: number; z: number } | null>(null);
  const [inspectData, setInspectData] = useState<InspectResult | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [builderOpen, setBuilderOpen] = useState(() => new URLSearchParams(window.location.search).has('builder'));
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has('builder')) window.history.replaceState(null, '', '/');
  }, []);
  const openBuilder = useCallback(() => setBuilderOpen(true), []);
  const closeBuilder = useCallback(() => setBuilderOpen(false), []);
  const [sheetTab, setSheetTab] = useState<SheetTab>('physics');
  const [optimistic, setOptimistic] = useState<{ running?: boolean; speed?: SpeedMode; at: number }>({ at: 0 });

  // Telemetry is authoritative, but reflect local clicks immediately for ~1.5 s.
  const fresh = Date.now() - optimistic.at < 1500;
  const running = fresh && optimistic.running !== undefined ? optimistic.running : t?.running ?? true;
  const speed = fresh && optimistic.speed ? optimistic.speed : t?.speed ?? '1x';

  const setRunning = useCallback((r: boolean) => {
    setOptimistic((o) => ({ ...o, running: r, at: Date.now() }));
    sim.send({ type: 'control', running: r });
  }, [sim]);
  const setSpeed = useCallback((s: SpeedMode) => {
    setOptimistic((o) => ({ ...o, speed: s, at: Date.now() }));
    sim.send({ type: 'control', speed: s });
  }, [sim]);
  const onParams = useCallback((p: Partial<SimParams>) => sim.send({ type: 'params', params: p }), [sim]);
  const onReset = useCallback(() => {
    sim.send({ type: 'reset' });
    setSelected(null);
    setInspectData(null);
  }, [sim]);

  const builderOpenRef = useRef(builderOpen);
  builderOpenRef.current = builderOpen;
  const runningRef = useRef(running);
  runningRef.current = running;

  const onPaint = useCallback((x: number, y: number, z = 0) => {
    sim.send({ type: 'tool', tool, x, y, z, radius: brushRadius, strength });
  }, [sim, tool, brushRadius, strength]);

  const onInspect = useCallback(async (x: number, y: number, z = 0) => {
    setSelected({ x, y, z });
    const d = await sim.inspect(x, y, z);
    setInspectData(d);
    if (window.matchMedia('(max-width: 1023px)').matches) {
      setSheetTab('inspector');
      setSheetOpen(true);
    }
  }, [sim]);

  // Live-track the selected cell.
  useEffect(() => {
    if (!selected) return;
    const id = setInterval(async () => {
      const d = await sim.inspect(selected.x, selected.y, selected.z);
      if (d) setInspectData(d);
    }, 1000);
    return () => clearInterval(id);
  }, [selected, sim]);

  // Drop selection when switching universes.
  useEffect(() => {
    setSelected(null);
    setInspectData(null);
  }, [sim.kind, sim.world]);

  // Hotkeys.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      // Only text entry swallows hotkeys; range sliders keep focus after dragging and must not.
      const typing = el?.tagName === 'TEXTAREA' || (el?.tagName === 'INPUT' && (el as HTMLInputElement).type !== 'range');
      if (typing || e.metaKey || e.ctrlKey || e.altKey || builderOpenRef.current) return;
      const code = e.code;
      const digit = code.startsWith('Digit') ? Number(code.slice(5)) : NaN;
      if (digit >= 1 && digit <= 4) {
        const i = digit - 1;
        if (e.shiftKey) {
          setLayers((l) => {
            const n = [...l] as LayerWeights;
            n[i] = n[i] > 0 ? 0 : 1;
            return n.some((v) => v > 0) ? n : l;
          });
        } else {
          setLayers([0, 1, 2, 3].map((j) => (j === i ? 1 : 0)) as LayerWeights);
        }
        e.preventDefault();
        return;
      }
      if (code === 'Space') {
        e.preventDefault();
        setRunning(!runningRef.current);
        return;
      }
      if (e.key === '[') setBrushRadius((r) => Math.max(0, r - 1));
      else if (e.key === ']') setBrushRadius((r) => Math.min(16, r + 1));
      else if (e.key === 'Escape') {
        setSelected(null);
        setInspectData(null);
      } else {
        const td = TOOLS.find((x) => x.key.toLowerCase() === e.key.toLowerCase());
        if (td) setTool(td.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setRunning]);

  const clearSelection = () => {
    setSelected(null);
    setInspectData(null);
  };

  const quantum = (
    <QuantumEntropyHUD entropy={t?.entropy} jumpTrail={t?.jumpTrail ?? []} sourceKind={sim.kind} getPool={sim.getPool} resync={sim.resync} />
  );
  const inspector = <OrganismInspector data={inspectData} onClose={clearSelection} tracking={!!selected} />;
  const telemetry = <TelemetryPanel t={t} history={sim.history} fps={fps} />;

  return (
    <div className="relative h-[100dvh] w-[100dvw] overflow-hidden bg-[#02040b] text-slate-200">
      {sim.world === '3d' ? (
        <SimulationCanvas3D
          key={`3d-${sim.kind}`}
          frameRef={sim.frameRef}
          layers={layers}
          tool={tool}
          brushRadius={brushRadius}
          selected={selected}
          onPaint={onPaint}
          onInspect={onInspect}
          onFps={setFps}
          onUnsupported={() => sim.setWorld('2d')}
        />
      ) : (
        <SimulationCanvas
          key={`2d-${sim.kind}`}
          frameRef={sim.frameRef}
          layers={layers}
          tool={tool}
          brushRadius={brushRadius}
          selected={selected}
          onPaint={onPaint}
          onInspect={onInspect}
          onFps={setFps}
        />
      )}

      {sim.status !== 'online' && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
          <div className="rounded-xl border border-slate-800 bg-slate-950/80 px-4 py-2 text-sm text-slate-300 backdrop-blur">
            {sim.status === 'connecting'
              ? sim.kind === 'cloud' ? `Connecting to the shared ${sim.world === '3d' ? '3D' : '2D'} universe…` : 'Booting local sandbox…'
              : 'Connection lost — reconnecting…'}
          </div>
        </div>
      )}
      {sim.notice && (
        <div className="pointer-events-none absolute left-1/2 top-20 z-30 -translate-x-1/2 lg:top-4">
          <div className="rounded-xl border border-amber-400/40 bg-amber-500/10 px-4 py-2 text-xs text-amber-100 backdrop-blur">{sim.notice}</div>
        </div>
      )}

      {/* ---------------- Desktop (lg+) ---------------- */}
      <ControlDrawer
        kind={sim.kind}
        setKind={sim.setKind}
        world={sim.world}
        setWorld={sim.setWorld}
        onOpenBuilder={openBuilder}
        params={t?.params}
        onParams={onParams}
        onReset={onReset}
        layers={layers}
        setLayers={setLayers}
        status={sim.status}
      />
      <div className="pointer-events-none absolute right-4 top-4 bottom-24 z-20 hidden w-[340px] lg:flex">
        <Glass className="tl-scroll flex min-h-0 w-full flex-col gap-5 overflow-y-auto p-4">
          {telemetry}
          <div className="h-px bg-slate-800" />
          {quantum}
          <div className="h-px bg-slate-800" />
          {inspector}
        </Glass>
      </div>
      <ActionBar
        running={running}
        onToggleRun={() => setRunning(!running)}
        speed={speed}
        setSpeed={setSpeed}
        tool={tool}
        setTool={setTool}
        brushRadius={brushRadius}
        setBrushRadius={setBrushRadius}
        strength={strength}
        setStrength={setStrength}
      />

      {/* ---------------- Mobile (< lg) ---------------- */}
      <MobileHUD fps={fps} tps={t?.tps ?? 0} population={t?.population ?? 0} mode={t?.entropy.mode} onOpenBuilder={openBuilder} />
      {builderOpen && <BuilderChat onClose={closeBuilder} />}
      <MobileToolbar onOpenSheet={() => setSheetOpen(true)}>
        <div className="tl-scroll flex items-center gap-2 overflow-x-auto pb-1">
          <PlayButton running={running} onToggle={() => setRunning(!running)} />
          <WorldToggle world={sim.world} setWorld={sim.setWorld} compact />
          <ToolPalette tool={tool} setTool={setTool} size="sm" />
        </div>
        <div className="tl-scroll mt-1.5 overflow-x-auto">
          <LayerToggles layers={layers} setLayers={setLayers} compact />
        </div>
      </MobileToolbar>
      <BottomSheet open={sheetOpen} setOpen={setSheetOpen} tab={sheetTab} setTab={setSheetTab}>
        {sheetTab === 'physics' && (
          <div className="space-y-4">
            <WorldToggle world={sim.world} setWorld={sim.setWorld} />
            <SourceToggle kind={sim.kind} setKind={sim.setKind} />
            <div className="flex items-center justify-between gap-2">
              <SpeedControl speed={speed} setSpeed={setSpeed} />
              <label className="flex flex-1 items-center gap-2 text-[11px] text-slate-400">
                Brush r={brushRadius}
                <input type="range" className="tl-range flex-1" min={0} max={16} value={brushRadius}
                  style={{ ['--pct' as string]: `${(brushRadius / 16) * 100}%` }}
                  onChange={(e) => setBrushRadius(Number(e.target.value))} />
              </label>
            </div>
            <PhysicsControls params={t?.params} onChange={onParams} onReset={onReset} />
            <BlendSliders layers={layers} setLayers={setLayers} />
          </div>
        )}
        {sheetTab === 'quantum' && quantum}
        {sheetTab === 'inspector' && inspector}
        {sheetTab === 'stats' && telemetry}
      </BottomSheet>
    </div>
  );
}
