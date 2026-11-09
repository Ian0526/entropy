import { useState } from 'react';
import { Check, Copy, Gauge, RotateCcw, Waves } from 'lucide-react';
import { Pill, SectionTitle, Slider } from '../../components/ui';
import type { Regime } from './regimes';
import { DOWNLOAD_URL } from '../links';
import {
  DEFAULT_SETTINGS, DRIFT_RANGES, driftRange, encodeSettings, fromHex, hex, LOOKS, PALETTES,
  type DisplaySettings, type DriftSettings, type InteractionSettings, type MorphoSettings, type PhysicsOverrides, type Rgb,
} from './settings';

type Set = (s: MorphoSettings) => void;

/** The Look tab: presets, colours and every optical term. */
export function LookPanel({ settings, onChange }: { settings: MorphoSettings; onChange: Set }) {
  const d = settings.display;
  const set = (p: Partial<DisplaySettings>) => onChange({ ...settings, display: { ...d, ...p } });
  const sl = (key: keyof DisplaySettings, label: string, max: number, hint?: string, min = 0, step = 0.01) => (
    <Slider key={key} label={label} min={min} max={max} step={step} value={d[key] as number} hint={hint}
      display={(d[key] as number).toFixed(step < 0.1 ? 2 : 1)} onChange={(v) => set({ [key]: v } as Partial<DisplaySettings>)} />
  );
  return (
    <div className="space-y-4">
      {settings.drift.enabled && (settings.drift.look || settings.drift.colours) && (
        <p className="rounded-lg border border-sky-500/30 bg-sky-500/10 px-2.5 py-1.5 text-[11px] leading-snug text-sky-200">
          Drift is on and is easing the {[settings.drift.look && 'optics', settings.drift.colours && 'colours'].filter(Boolean).join(' and ')} on its own.
          These are your own settings, which it glides back to when you turn it off (Controls → Drift).
        </p>
      )}
      <div>
        <SectionTitle>Look</SectionTitle>
        <div className="flex flex-wrap gap-1.5">
          {LOOKS.map((l) => <Pill key={l.id} onClick={() => set(l.display)}>{l.name}</Pill>)}
        </div>
      </div>
      <div>
        <SectionTitle>Palette</SectionTitle>
        <div className="grid grid-cols-2 gap-1.5">
          {PALETTES.map((p) => (
            <button key={p.id} type="button" onClick={() => set({ colours: p.colours.map(fromHex) as [Rgb, Rgb, Rgb], background: fromHex(p.background), haloColour: fromHex(p.halo) })}
              className="flex items-center gap-2 rounded-lg border border-slate-800 px-2 py-1.5 text-left text-[11px] text-slate-300 hover:border-slate-600"
              style={{ background: p.background }}>
              <span className="flex">{p.colours.map((c) => <span key={c} className="-mr-1 h-3.5 w-3.5 rounded-full border border-black/40" style={{ background: c }} />)}</span>
              <span className="ml-1">{p.name}</span>
            </button>
          ))}
        </div>
        <div className="mt-2 grid grid-cols-5 gap-1.5 text-center text-[10px] text-slate-500">
          {(['A', 'B', 'C'] as const).map((n, i) => (
            <ColourInput key={n} label={n} value={d.colours[i]} onChange={(c) => {
              const colours = [...d.colours] as [Rgb, Rgb, Rgb];
              colours[i] = c;
              set({ colours });
            }} />
          ))}
          <ColourInput label="vacuum" value={d.background} onChange={(c) => set({ background: c })} />
          <ColourInput label="halo" value={d.haloColour} onChange={(c) => set({ haloColour: c })} />
        </div>
      </div>
      <div>
        <SectionTitle right={
          <div className="flex gap-1">
            {(['bicubic', 'bilinear'] as const).map((f) => <Pill key={f} active={d.filter === f} onClick={() => set({ filter: f })} className="px-2 py-0.5 text-[10px]">{f}</Pill>)}
          </div>
        }>Light</SectionTitle>
        {sl('exposure', 'Exposure', 2.5, undefined, 0.2)}
        {sl('body', 'Body fill', 1.5, 'Translucent cytoplasm')}
        {sl('edge', 'Membrane glow', 2, 'Light along steep edges of mass')}
        {sl('halo', 'Halo', 2, 'Glow in the water around organisms')}
        {sl('haloRadius', 'Halo radius (cells)', 20, undefined, 1, 0.5)}
        {sl('crests', 'Phase crests', 1, 'The oscillator beat inside bodies')}
        {sl('geneTint', 'Genome tint', 1, 'Per-organism hue (regimes with speciation)')}
      </div>
      <div>
        <SectionTitle>Microscope optics</SectionTitle>
        {sl('relief', 'DIC relief', 1, 'Shade mass as a 3D thickness map lit from the upper left')}
        {sl('iridescence', 'Iridescence', 1, 'Thin-film colours on membranes')}
        {sl('specular', 'Wet highlight', 1.5)}
        {sl('pellicle', 'Pellicle ring', 1, 'A bright contour where the body thins out')}
        {sl('nucleus', 'Nucleus glow', 1.5, 'Glow in the densest cores')}
        {sl('vorticity', 'Vorticity glow', 2, 'Cyan where the flow spins (regimes with curl)')}
        {sl('tonemap', 'Film tonemap', 1)}
        {sl('grain', 'Sensor grain', 3)}
        {sl('vignette', 'Lens vignette', 2)}
      </div>
    </div>
  );
}

function ColourInput({ label, value, onChange }: { label: string; value: Rgb; onChange: (c: Rgb) => void }) {
  return (
    <label className="flex flex-col items-center gap-0.5">
      <input type="color" value={hex(value)} onChange={(e) => onChange(fromHex(e.target.value))}
        className="h-7 w-full cursor-pointer rounded border border-slate-700 bg-transparent" />
      {label}
    </label>
  );
}

/** The Controls tab: size and speed, the pointer, physics overrides, and the wallpaper command. */
export function ControlsPanel({ settings, onChange, regime, auto }: { settings: MorphoSettings; onChange: Set; regime: Regime; auto: boolean }) {
  const it = settings.interaction;
  const setIt = (p: Partial<InteractionSettings>) => onChange({ ...settings, interaction: { ...it, ...p } });
  const ph = settings.physics;
  const setPh = (k: keyof PhysicsOverrides, v: number | undefined) => {
    const next = { ...ph };
    if (v === undefined) delete next[k]; else next[k] = v;
    onChange({ ...settings, physics: next });
  };
  const phys = (k: keyof PhysicsOverrides, label: string, max: number, step: number, hint: string) => {
    const own = regime[k] ?? 0;
    const v = ph[k] ?? own;
    return (
      <div key={k} className="flex items-end gap-1">
        <div className="flex-1">
          <Slider label={label + (ph[k] === undefined ? '' : ' •')} min={0} max={max} step={step} value={v} hint={hint}
            display={v.toFixed(3)} onChange={(x) => setPh(k, x)} />
        </div>
        <button type="button" title={`Back to the regime's own value (${own})`} onClick={() => setPh(k, undefined)}
          className="mb-1.5 rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-slate-200 disabled:opacity-30" disabled={ph[k] === undefined}>
          <RotateCcw size={12} />
        </button>
      </div>
    );
  };

  const [copied, setCopied] = useState(false);
  // A settings code the desktop app imports (Import code); a pinned regime rides along after a dot.
  const code = encodeSettings(settings) + (auto ? '' : `.${regime.id}`);
  const copy = () => {
    void navigator.clipboard.writeText(code).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  };

  const dr = settings.drift;
  const setDr = (p: Partial<DriftSettings>) => onChange({ ...settings, drift: { ...dr, ...p } });
  const check = (key: 'look' | 'colours' | 'physics' | 'regimes' | 'speed', label: string) => (
    <label key={key} className="flex items-center gap-1.5 text-[11px] text-slate-300">
      <input type="checkbox" checked={dr[key]} onChange={(e) => setDr({ [key]: e.target.checked })} />{label}
    </label>
  );

  return (
    <div className="space-y-4">
      <div>
        <SectionTitle icon={<Waves size={12} />} right={
          <Pill active={dr.enabled} onClick={() => setDr({ enabled: !dr.enabled })} className="px-2.5 py-0.5 text-[11px]">{dr.enabled ? 'On' : 'Off'}</Pill>
        }>Drift</SectionTitle>
        <p className="mb-1.5 text-[11px] leading-snug text-slate-500">
          Endless smooth randomisation: every chosen part eases toward a new random target, colours blending and sliders gliding, and regimes morph into each other instead of resetting.
        </p>
        <div className="grid grid-cols-2 gap-1">
          {check('look', 'Optics')}
          {check('colours', 'Colours')}
          {check('physics', 'Physics (flow, vortices)')}
          {check('regimes', 'Regimes (morphs)')}
          {check('speed', 'Speed')}
        </div>
        <Slider label="Seconds per change" min={10} max={300} step={5} value={dr.period} display={`${dr.period}s`}
          hint="How long each glide toward a new random target takes" onChange={(v) => setDr({ period: v })} />
        <details className="mt-1 rounded-lg border border-slate-800 bg-slate-900/40 px-2 py-1.5">
          <summary className="cursor-pointer text-[11px] text-slate-300">Ranges (min – max drift may use)</summary>
          <div className="mt-1.5 space-y-1.5">
            {Object.entries(DRIFT_RANGES).map(([key, info]) => (
              <RangeRow key={key} label={info.label} max={info.max} step={info.step} value={driftRange(dr, key)}
                custom={key in dr.ranges}
                onChange={(r) => setDr({ ranges: { ...dr.ranges, [key]: r } })}
                onReset={() => { const next = { ...dr.ranges }; delete next[key]; setDr({ ranges: next }); }} />
            ))}
          </div>
        </details>
      </div>
      <div>
        <SectionTitle icon={<Gauge size={12} />}>GPU budget</SectionTitle>
        <Slider label="Most of the GPU the world may use" min={0.15} max={0.9} step={0.05} value={settings.budget}
          display={`${Math.round(settings.budget * 100)}%`}
          hint="Above it, the world first runs fewer steps per second, then thins out, avoids heavy regimes and calms the flow; all comes back as load falls"
          onChange={(v) => onChange({ ...settings, budget: v })} />
        <Slider label="Lowest step rate it may drop to" min={0.2} max={1} step={0.05} value={settings.minSteps}
          display={`${Math.round(settings.minSteps * 100)}%`}
          hint="Below this it stops slowing the world and lightens it instead (thins the field, picks lighter regimes, calms the flow)"
          onChange={(v) => onChange({ ...settings, minSteps: v })} />
        <label className="mt-1 flex items-center justify-between gap-2 text-[11px] text-slate-300"
          title="Blend between the last two steps on every display frame (up to 60 fps), so motion stays fluid even at a low step rate">
          Smooth motion (interpolated frames)
          <input type="checkbox" checked={settings.smooth} onChange={(e) => onChange({ ...settings, smooth: e.target.checked })} />
        </label>
      </div>
      <div>
        <SectionTitle>Size &amp; speed</SectionTitle>
        <Slider label="Pixels per cell" min={1.5} max={6} step={0.5} value={settings.cellPx} display={`${settings.cellPx}px`}
          hint="Smaller = a zoomed-out world with more organisms (more GPU). Changing it starts a fresh world."
          onChange={(v) => onChange({ ...settings, cellPx: v })} />
        <Slider label="Steps per second" min={2} max={60} step={1} value={settings.speed} display={`${settings.speed}`}
          onChange={(v) => onChange({ ...settings, speed: v })} />
      </div>
      <div>
        <SectionTitle>Pointer</SectionTitle>
        <div className="mb-1 text-[11px] text-slate-500">Moving</div>
        <div className="flex flex-wrap gap-1.5">
          <Pill active={it.move === 'stir'} onClick={() => setIt({ move: 'stir' })} title="Drag the liquid along with the pointer">Stir</Pill>
          <Pill active={it.move === 'ripple'} onClick={() => setIt({ move: 'ripple' })} title="Tap the cover slip: phase kicks and faint rings that make colonies flex and recoil">Ripple</Pill>
          <Pill active={it.move === 'off'} onClick={() => setIt({ move: 'off' })}>Off</Pill>
        </div>
        <div className="mb-1 mt-2 text-[11px] text-slate-500">Clicking</div>
        <div className="flex flex-wrap gap-1.5">
          <Pill active={it.click === 'seed'} onClick={() => setIt({ click: 'seed' })} title="A new organism: a copy of a living one (or a seed of the regime's own kind if nothing lives)">Seed</Pill>
          <Pill active={it.click === 'ring'} onClick={() => setIt({ click: 'ring' })} title="A quantum harmonic ring cos(mφ)">Ring</Pill>
          <Pill active={it.click === 'erase'} onClick={() => setIt({ click: 'erase' })}>Erase</Pill>
          <Pill active={it.click === 'off'} onClick={() => setIt({ click: 'off' })}>Off</Pill>
        </div>
        <Slider label="Strength" min={0.1} max={3} step={0.05} value={it.strength} display={it.strength.toFixed(2)} onChange={(v) => setIt({ strength: v })} />
        <Slider label="Reach (× R)" min={0.2} max={2} step={0.05} value={it.radius} display={it.radius.toFixed(2)} onChange={(v) => setIt({ radius: v })} />
      </div>
      <div>
        <SectionTitle right={<span className="text-[10px] text-slate-500">• = overridden</span>}>Physics</SectionTitle>
        {phys('speciation', 'Speciation (μ spread)', 0.02, 0.001, 'Each organism gets its own genome: its hue, a shifted μ and the sign of its spin')}
        {phys('curl', 'Curl flow', 2, 0.01, 'Rotational flow along the field: organisms spin and swim')}
        {phys('swirl', 'Phase swirl', 1.5, 0.01, 'Advection along the phase gradient: phase-locked neighbours orbit')}
        {phys('vortexMu', 'Vortex μ', 0.03, 0.001, 'Vortical flow lowers μ, so corners and roll-ups grow')}
        <p className="text-[11px] leading-snug text-slate-500">Overrides apply to every regime, the Director's drifts included. Big values can flood or kill a world; the Director will reseed it.</p>
      </div>
      <div>
        <SectionTitle>Desktop wallpaper</SectionTitle>
        <p className="mb-1.5 text-[11px] leading-snug text-slate-500">
          <a href={DOWNLOAD_URL} className="text-emerald-300 hover:underline">Download the Windows app</a> to run this world behind
          your desktop icons. To take these settings along{auto ? '' : ` (pinned to ${regime.name})`}, copy this code and use
          Import code in the app.
        </p>
        <div className="max-h-20 overflow-y-auto break-all rounded-lg border border-slate-800 bg-slate-950/70 p-2 font-mono text-[10px] text-slate-400">{code}</div>
        <div className="mt-1.5 flex gap-1.5">
          <Pill onClick={copy}>{copied ? <Check size={12} /> : <Copy size={12} />}{copied ? 'Copied' : 'Copy settings code'}</Pill>
          <Pill onClick={() => onChange(DEFAULT_SETTINGS)} title="Every setting back to its default">
            <RotateCcw size={12} />Reset all
          </Pill>
        </div>
      </div>
    </div>
  );
}

/** A [min, max] pair as two sliders on one row. */
function RangeRow({ label, max, step, value, custom, onChange, onReset }: {
  label: string; max: number; step: number; value: [number, number]; custom: boolean;
  onChange: (r: [number, number]) => void; onReset: () => void;
}) {
  const fmt = (v: number) => (step < 0.01 ? v.toFixed(3) : step < 0.1 ? v.toFixed(2) : v.toFixed(1));
  const [lo, hi] = value;
  return (
    <div>
      <div className="flex items-baseline justify-between text-[11px]">
        <span className={custom ? 'text-sky-300' : 'text-slate-400'}>{label}</span>
        <span className="flex items-center gap-1 font-mono text-[10px] text-emerald-300">
          {fmt(lo)} – {fmt(hi)}
          <button type="button" title="Back to the default range" onClick={onReset} disabled={!custom}
            className="rounded p-0.5 text-slate-500 hover:text-slate-200 disabled:opacity-30"><RotateCcw size={10} /></button>
        </span>
      </div>
      <div className="flex gap-1.5">
        <input type="range" className="tl-range w-full" min={0} max={max} step={step} value={lo}
          style={{ ['--pct' as string]: `${(lo / max) * 100}%` }}
          onChange={(e) => onChange([Math.min(Number(e.target.value), hi), hi])} />
        <input type="range" className="tl-range w-full" min={0} max={max} step={step} value={hi}
          style={{ ['--pct' as string]: `${(hi / max) * 100}%` }}
          onChange={(e) => onChange([lo, Math.max(Number(e.target.value), lo)])} />
      </div>
    </div>
  );
}
