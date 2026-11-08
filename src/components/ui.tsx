import type { ReactNode } from 'react';

export function cx(...c: (string | false | null | undefined)[]): string {
  return c.filter(Boolean).join(' ');
}

export function Glass({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cx(
        'pointer-events-auto rounded-2xl border border-slate-800 bg-slate-950/80 shadow-2xl shadow-black/40 backdrop-blur-md',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function SectionTitle({ icon, children, right }: { icon?: ReactNode; children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-2 flex items-center justify-between gap-2">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">
        {icon}
        {children}
      </div>
      {right}
    </div>
  );
}

export function Slider(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display?: string;
  hint?: string;
  onChange: (v: number) => void;
}) {
  const pct = ((props.value - props.min) / (props.max - props.min)) * 100;
  return (
    <label className="block select-none py-1.5" title={props.hint}>
      <div className="mb-1 flex items-baseline justify-between text-xs">
        <span className="text-slate-300">{props.label}</span>
        <span className="font-mono tabular-nums text-emerald-300">{props.display ?? props.value}</span>
      </div>
      <input
        type="range"
        className="tl-range w-full"
        style={{ ['--pct' as string]: `${pct}%` }}
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
    </label>
  );
}

export function Pill({ active, onClick, children, title, className }: {
  active?: boolean;
  onClick?: () => void;
  children: ReactNode;
  title?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cx(
        'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
        active
          ? 'border-emerald-400/60 bg-emerald-400/15 text-emerald-200'
          : 'border-slate-700/80 bg-slate-900/60 text-slate-400 hover:border-slate-600 hover:text-slate-200',
        className,
      )}
    >
      {children}
    </button>
  );
}

export function IconButton({ onClick, title, children, active, className, disabled }: {
  onClick?: () => void;
  title: string;
  children: ReactNode;
  active?: boolean;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
      className={cx(
        'inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border transition-all disabled:opacity-40',
        active ? 'border-transparent shadow-lg' : 'border-slate-800 bg-slate-900/70 text-slate-300 hover:bg-slate-800 hover:text-white',
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Stat({ label, value, tone = 'text-slate-100' }: { label: string; value: ReactNode; tone?: string }) {
  return (
    <div className="rounded-lg border border-slate-800/80 bg-slate-900/50 px-2.5 py-1.5">
      <div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className={cx('font-mono text-sm tabular-nums', tone)}>{value}</div>
    </div>
  );
}

export function Sparkline({ data, color, height = 28, label, value }: {
  data: number[];
  color: string;
  height?: number;
  label: string;
  value: string;
}) {
  const w = 200;
  let path = '';
  let area = '';
  if (data.length > 1) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of data) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    const span = hi - lo || 1;
    const pts = data.map((v, i) => `${((i / (data.length - 1)) * w).toFixed(1)},${(height - 2 - ((v - lo) / span) * (height - 4)).toFixed(1)}`);
    path = `M${pts.join(' L')}`;
    area = `${path} L${w},${height} L0,${height} Z`;
  }
  return (
    <div>
      <div className="flex items-baseline justify-between text-[11px]">
        <span className="text-slate-400">{label}</span>
        <span className="font-mono tabular-nums" style={{ color }}>{value}</span>
      </div>
      <svg viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" className="mt-0.5 h-7 w-full">
        {area && <path d={area} fill={color} opacity={0.12} />}
        {path && <path d={path} fill="none" stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />}
      </svg>
    </div>
  );
}
