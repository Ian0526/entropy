import { useEffect, useRef, useState } from 'react';
import { Box, ChevronLeft, ChevronRight, Cloud, Cpu, Dna, Layers, MessageSquareText, RotateCcw, SlidersHorizontal, Square } from 'lucide-react';
import { DEFAULT_PARAMS, type SimParams, type WorldId } from '../engine/protocol';
import { LAYERS, type LayerWeights } from '../client/state';
import type { SourceKind } from '../client/useSimulation';
import { cx, Glass, Pill, SectionTitle, Slider } from './ui';

export function WorldToggle({ world, setWorld, compact }: { world: WorldId; setWorld: (w: WorldId) => void; compact?: boolean }) {
  return (
    <div className={cx('grid grid-cols-2 gap-1 rounded-xl border border-slate-800 bg-slate-900/60 p-1', compact && 'pointer-events-auto')}>
      {([
        ['2d', compact ? '2D' : 'Flat world', Square, 'The original 2D petri dish (256×256)'],
        ['3d', compact ? '3D' : 'Deep space', Box, 'A 3D void with drifting nutrient nebulae (64³)'],
      ] as const).map(([k, label, Icon, hint]) => (
        <button
          key={k}
          type="button"
          title={hint}
          onClick={() => setWorld(k)}
          className={cx(
            'flex items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium transition',
            world === k ? 'bg-emerald-300 text-slate-950' : 'text-slate-400 hover:text-slate-100',
          )}
        >
          <Icon size={13} />
          {label}
        </button>
      ))}
    </div>
  );
}

export function SourceToggle({ kind, setKind }: { kind: SourceKind; setKind: (k: SourceKind) => void }) {
  return (
    <div className="grid grid-cols-2 gap-1 rounded-xl border border-slate-800 bg-slate-900/60 p-1">
      {([
        ['cloud', 'Shared Cloud', Cloud, 'Authoritative universe on the Railway vCPU, fed by the server ANU cron'],
        ['local', 'Local Sandbox', Cpu, 'Runs in your browser WebWorker, seeded from the server quantum pool'],
      ] as const).map(([k, label, Icon, hint]) => (
        <button
          key={k}
          type="button"
          title={hint}
          onClick={() => setKind(k)}
          className={cx(
            'flex items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium transition',
            kind === k ? 'bg-slate-100 text-slate-900' : 'text-slate-400 hover:text-slate-100',
          )}
        >
          <Icon size={13} />
          {label}
        </button>
      ))}
    </div>
  );
}

export function LayerToggles({ layers, setLayers, compact }: {
  layers: LayerWeights;
  setLayers: (l: LayerWeights) => void;
  compact?: boolean;
}) {
  const toggle = (i: number, solo: boolean) => {
    if (solo) {
      setLayers(LAYERS.map((_, j): number => (j === i ? 1 : 0)) as LayerWeights);
      return;
    }
    const next = layers.map((v, j): number => (j === i ? (v > 0 ? 0 : 1) : v)) as LayerWeights;
    setLayers(next.some((v) => v > 0) ? next : layers);
  };
  return (
    <div className={cx('flex gap-1.5', compact ? 'flex-nowrap' : 'flex-wrap')}>
      {LAYERS.map((l) => (
        <Pill
          key={l.id}
          active={layers[l.id] > 0}
          onClick={() => toggle(l.id, false)}
          title={`${l.label} — key ${l.key} solo, Shift+${l.key} blend`}
        >
          <span className={cx('font-mono text-[10px] opacity-60', l.color)}>{l.key}</span>
          {l.short}
        </Pill>
      ))}
    </div>
  );
}

export function BlendSliders({ layers, setLayers }: { layers: LayerWeights; setLayers: (l: LayerWeights) => void }) {
  const active = layers.filter((v) => v > 0).length;
  if (active < 2) return null;
  return (
    <div className="mt-2 space-y-0.5">
      {LAYERS.map((l) =>
        layers[l.id] > 0 ? (
          <Slider
            key={l.id}
            label={`${l.short} blend`}
            value={layers[l.id]}
            min={0.05}
            max={1}
            step={0.05}
            display={`${Math.round(layers[l.id] * 100)}%`}
            onChange={(v) => {
              const n = [...layers] as LayerWeights;
              n[l.id] = v;
              setLayers(n);
            }}
          />
        ) : null,
      )}
    </div>
  );
}

export function PhysicsControls({ params, onChange, onReset }: {
  params: SimParams | undefined;
  onChange: (p: Partial<SimParams>) => void;
  onReset: () => void;
}) {
  const [local, setLocal] = useState<SimParams>(params ?? DEFAULT_PARAMS);
  const touched = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (params && Date.now() - touched.current > 1500) setLocal(params);
  }, [params]);

  const set = (k: keyof SimParams, v: number) => {
    touched.current = Date.now();
    setLocal((cur) => ({ ...cur, [k]: v }));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => onChange({ [k]: v }), 80);
  };

  return (
    <div>
      <SectionTitle
        icon={<SlidersHorizontal size={13} className="text-emerald-300" />}
        right={
          <button type="button" onClick={onReset} className="flex items-center gap-1 text-[11px] text-slate-500 hover:text-rose-300" title="Re-seed the universe from the ancestor genome">
            <RotateCcw size={11} /> Reset
          </button>
        }
      >
        Physics
      </SectionTitle>
      <Slider label="Metabolic Decay" value={local.metabolicDecay} min={0.1} max={4} step={0.05}
        display={`${local.metabolicDecay.toFixed(2)}×`} hint="Multiplier on per-tissue maintenance cost (entropic bleed)"
        onChange={(v) => set('metabolicDecay', v)} />
      <Slider label="Mutation Rate μ" value={local.mutationRate} min={0} max={0.5} step={0.005}
        display={local.mutationRate.toFixed(3)} hint="Per-division probability of quantum bit-flips / Gaussian field nudges"
        onChange={(v) => set('mutationRate', v)} />
      <Slider label="Signal Speed" value={local.signalSpeed} min={1} max={8} step={1}
        display={`${local.signalSpeed} hops/tick`} hint="Relay sub-steps per tick through living tissue (growth is 1 cell/tick)"
        onChange={(v) => set('signalSpeed', v)} />
      <Slider label="Food Scarcity" value={local.foodScarcity} min={0} max={1} step={0.01}
        display={`${Math.round(local.foodScarcity * 100)}%`} hint="Suppresses nutrient pocket regeneration"
        onChange={(v) => set('foodScarcity', v)} />
      <Slider label="Poisson Phase Rate λ" value={local.phaseRate} min={0.1} max={6} step={0.1}
        display={`${local.phaseRate.toFixed(1)} → p=${(1 - Math.exp(-local.phaseRate)).toFixed(2)}`} hint="Asynchronous update clock: probability a cell acts per tick"
        onChange={(v) => set('phaseRate', v)} />
    </div>
  );
}

/** Desktop left floating dock. */
export default function ControlDrawer(props: {
  world: WorldId;
  setWorld: (w: WorldId) => void;
  onOpenBuilder: () => void;
  kind: SourceKind;
  setKind: (k: SourceKind) => void;
  params: SimParams | undefined;
  onParams: (p: Partial<SimParams>) => void;
  onReset: () => void;
  layers: LayerWeights;
  setLayers: (l: LayerWeights) => void;
  status: string;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="pointer-events-none absolute left-4 top-4 bottom-24 z-20 hidden w-[300px] flex-col lg:flex">
      <Glass className={cx('flex min-h-0 flex-col overflow-hidden transition-all', open ? 'w-[300px]' : 'w-[52px]')}>
        <div className="flex items-center justify-between gap-2 border-b border-slate-800/80 px-3 py-2.5">
          {open && (
            <div className="flex items-center gap-2">
              <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-400 to-fuchsia-500">
                <Dna size={16} className="text-slate-950" />
              </div>
              <div>
                <div className="text-sm font-semibold tracking-tight text-slate-100">TuringLife</div>
                <div className="text-[10px] uppercase tracking-widest text-slate-500">
                  {props.status === 'online' ? 'thermodynamic automaton' : props.status}
                </div>
              </div>
            </div>
          )}
          <div className="flex items-center gap-0.5">
            {open && (
              <button type="button" onClick={props.onOpenBuilder} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-emerald-300" title="Builder: suggest a change or ask a question">
                <MessageSquareText size={16} />
              </button>
            )}
            <button type="button" onClick={() => setOpen(!open)} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white" title={open ? 'Collapse' : 'Expand'}>
              {open ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}
            </button>
          </div>
        </div>
        {open && (
          <div className="tl-scroll min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
            <WorldToggle world={props.world} setWorld={props.setWorld} />
            <SourceToggle kind={props.kind} setKind={props.setKind} />
            <PhysicsControls params={props.params} onChange={props.onParams} onReset={props.onReset} />
            <div>
              <SectionTitle icon={<Layers size={13} className="text-cyan-300" />}>Microscope Layers</SectionTitle>
              <LayerToggles layers={props.layers} setLayers={props.setLayers} />
              <BlendSliders layers={props.layers} setLayers={props.setLayers} />
              <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
                Keys <kbd>1</kbd>–<kbd>4</kbd> solo a layer, <kbd>Shift</kbd>+key blends. Wheel zooms, drag pans, double-click fits, <kbd>Space</kbd> pauses.
              </p>
            </div>
          </div>
        )}
      </Glass>
    </div>
  );
}
