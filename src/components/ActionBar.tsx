import { Gauge, Pause, Play } from 'lucide-react';
import type { SpeedMode, ToolKind } from '../engine/protocol';
import { TOOLS } from '../client/state';
import { cx, Glass, IconButton } from './ui';

export function ToolPalette({ tool, setTool, size = 'md' }: { tool: ToolKind; setTool: (t: ToolKind) => void; size?: 'md' | 'sm' }) {
  return (
    <div className="flex items-center gap-1.5">
      {TOOLS.map((t) => {
        const Icon = t.icon;
        const active = tool === t.id;
        return (
          <IconButton
            key={t.id}
            title={`${t.label} (${t.key}) — ${t.hint}`}
            active={active}
            onClick={() => setTool(t.id)}
            className={cx(active && t.accent, size === 'sm' && 'h-11 w-11')}
          >
            <Icon size={18} />
          </IconButton>
        );
      })}
    </div>
  );
}

export function SpeedControl({ speed, setSpeed }: { speed: SpeedMode; setSpeed: (s: SpeedMode) => void }) {
  return (
    <div className="flex rounded-xl border border-slate-800 bg-slate-900/70 p-0.5">
      {(['1x', '5x', 'max'] as SpeedMode[]).map((s) => (
        <button
          key={s}
          type="button"
          onClick={() => setSpeed(s)}
          className={cx(
            'rounded-lg px-2.5 py-1.5 text-xs font-semibold transition',
            speed === s ? 'bg-cyan-400 text-slate-950' : 'text-slate-400 hover:text-white',
          )}
        >
          {s === 'max' ? (
            <span className="flex items-center gap-1"><Gauge size={12} />Max vCPU</span>
          ) : s}
        </button>
      ))}
    </div>
  );
}

export function PlayButton({ running, onToggle }: { running: boolean; onToggle: () => void }) {
  return (
    <IconButton
      title={running ? 'Pause (Space)' : 'Play (Space)'}
      active
      onClick={onToggle}
      className={running ? 'bg-slate-100 text-slate-900' : 'bg-emerald-400 text-slate-950'}
    >
      {running ? <Pause size={18} /> : <Play size={18} />}
    </IconButton>
  );
}

/** Desktop bottom floating action bar. */
export default function ActionBar(props: {
  running: boolean;
  onToggleRun: () => void;
  speed: SpeedMode;
  setSpeed: (s: SpeedMode) => void;
  tool: ToolKind;
  setTool: (t: ToolKind) => void;
  brushRadius: number;
  setBrushRadius: (r: number) => void;
  strength: number;
  setStrength: (s: number) => void;
}) {
  const active = TOOLS.find((t) => t.id === props.tool)!;
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-4 z-20 hidden justify-center lg:flex">
      <Glass className="flex items-center gap-3 px-3 py-2.5">
        <PlayButton running={props.running} onToggle={props.onToggleRun} />
        <SpeedControl speed={props.speed} setSpeed={props.setSpeed} />
        <div className="h-8 w-px bg-slate-800" />
        <div className="flex flex-col gap-1">
          <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">Turing Perturbation Tools</span>
          <ToolPalette tool={props.tool} setTool={props.setTool} />
        </div>
        <div className="h-8 w-px bg-slate-800" />
        <div className="w-36">
          <div className="flex justify-between text-[10px] text-slate-500">
            <span>Brush</span><span className="font-mono text-slate-300">r={props.brushRadius}</span>
          </div>
          <input type="range" className="tl-range w-full" min={0} max={16} step={1} value={props.brushRadius}
            style={{ ['--pct' as string]: `${(props.brushRadius / 16) * 100}%` }}
            onChange={(e) => props.setBrushRadius(Number(e.target.value))} />
          <div className="flex justify-between text-[10px] text-slate-500">
            <span>Strength</span><span className="font-mono text-slate-300">{Math.round(props.strength * 100)}%</span>
          </div>
          <input type="range" className="tl-range w-full" min={0.05} max={1} step={0.05} value={props.strength}
            style={{ ['--pct' as string]: `${((props.strength - 0.05) / 0.95) * 100}%` }}
            onChange={(e) => props.setStrength(Number(e.target.value))} />
        </div>
        <div className="hidden w-40 text-[11px] leading-snug text-slate-400 xl:block">
          <div className="font-medium text-slate-200">{active.label}</div>
          {active.hint}
        </div>
      </Glass>
    </div>
  );
}
