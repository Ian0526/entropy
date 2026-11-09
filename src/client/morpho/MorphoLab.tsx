import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Maximize, Minimize, RotateCcw, Shuffle, Sparkles } from 'lucide-react';
import MorphoCanvas, { type MorphoControl, type MorphoStatus } from './MorphoCanvas';
import { CHANNEL_COLOURS } from './MorphoGL';
import { growth, REGIMES, regimeById, shell, type Regime } from './regimes';
import { cx, Glass, SectionTitle } from '../../components/ui';

const IDLE_MS = 8000;
const css = (c: [number, number, number]) => `rgb(${c.map((v) => Math.round(v * 255)).join(',')})`;
const CH = ['A', 'B', 'C'];

/**
 * /morpho: the Morphogenesis lab. The world fills the screen; the HUD fades out after 8 s without
 * input (and the cursor with it) and comes back on any movement. Screensaver mode (button, F11 or
 * F) goes fullscreen with the HUD hidden. A small watermark always shows the regime, the last
 * nucleated eigenmode and the latest quantum nonce.
 */
export default function MorphoLab() {
  const q = new URLSearchParams(window.location.search);
  const [regime, setRegime] = useState<Regime>(() => regimeById(q.get('regime')));
  const [auto, setAuto] = useState(true);
  const [status, setStatus] = useState<MorphoStatus | null>(null);
  const [idle, setIdle] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const control = useRef<MorphoControl | null>(null);
  const idleTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const wake = useCallback(() => {
    setIdle(false);
    clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => setIdle(true), IDLE_MS);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen().then(() => setIdle(true)).catch(() => setIdle(true));
  }, []);

  useEffect(() => {
    wake();
    const onFs = () => setFullscreen(!!document.fullscreenElement);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F11' || e.key.toLowerCase() === 'f') {
        e.preventDefault();
        toggleFullscreen();
      } else wake();
    };
    window.addEventListener('pointermove', wake);
    window.addEventListener('pointerdown', wake);
    window.addEventListener('keydown', onKey);
    document.addEventListener('fullscreenchange', onFs);
    return () => {
      clearTimeout(idleTimer.current);
      window.removeEventListener('pointermove', wake);
      window.removeEventListener('pointerdown', wake);
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('fullscreenchange', onFs);
    };
  }, [wake, toggleFullscreen]);

  const onStatus = useCallback((s: MorphoStatus) => {
    setStatus(s);
    setRegime((r) => (r.id === s.regime.id ? r : s.regime));
  }, []);

  const pick = (r: Regime) => {
    setRegime(r);
    control.current?.setRegime(r.id);
  };

  return (
    <div className={cx('relative h-[100dvh] w-[100dvw] overflow-hidden bg-[#02040b] text-slate-200', idle && 'cursor-none')}>
      <MorphoCanvas regime={regime.id} auto={auto} cellPx={3} onStatus={onStatus} control={control} />

      <div className={cx('pointer-events-none absolute inset-0 transition-opacity duration-1000', idle ? 'opacity-0' : 'opacity-100')}>
        <div className="absolute left-4 top-4 bottom-4 flex w-[min(340px,calc(100vw-2rem))] flex-col">
          <Glass className={cx('tl-scroll flex min-h-0 flex-col gap-4 overflow-y-auto p-4', idle && 'pointer-events-none')}>
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="text-sm font-semibold tracking-wide text-slate-100">Morphogenesis</div>
                <div className="text-[11px] text-slate-500">multi-channel Lenia · phase field · quantum seeds</div>
              </div>
              <a href="/" className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white" title="Back to TuringLife">
                <ArrowLeft size={16} />
              </a>
            </div>

            <div>
              <SectionTitle>Regime</SectionTitle>
              <div className="space-y-1.5">
                {REGIMES.map((r) => (
                  <button key={r.id} type="button" onClick={() => pick(r)}
                    className={cx('w-full rounded-xl border px-3 py-2 text-left transition',
                      r.id === regime.id ? 'border-emerald-400/60 bg-emerald-400/10' : 'border-slate-800 bg-slate-900/50 hover:border-slate-600')}>
                    <div className="text-xs font-medium text-slate-100">{r.name}</div>
                    {r.id === regime.id && <div className="mt-1 text-[11px] leading-snug text-slate-400">{r.blurb}</div>}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-3 gap-1.5">
              <ActionButton icon={<Sparkles size={13} />} label="Nucleate" title="Drop a quantum harmonic ring seed" onClick={() => control.current?.nucleate()} />
              <ActionButton icon={<RotateCcw size={13} />} label="Reseed" title="Clear the field and seed it afresh" onClick={() => control.current?.reseed()} />
              <ActionButton icon={fullscreen ? <Minimize size={13} /> : <Maximize size={13} />} label="Screensaver" title="Fullscreen, HUD hidden (F / F11)" onClick={toggleFullscreen} />
            </div>
            <label className="flex items-center justify-between gap-2 text-xs text-slate-300">
              <span className="flex items-center gap-1.5"><Shuffle size={13} /> Director drifts between regimes</span>
              <input type="checkbox" checked={auto} onChange={(e) => { setAuto(e.target.checked); control.current?.setAuto(e.target.checked); }} />
            </label>

            <KernelPreview regime={regime} />

            {status && <Vitals status={status} />}
          </Glass>
        </div>
      </div>

      <div className="pointer-events-none absolute bottom-3 right-4 font-mono text-[10px] tracking-wide text-slate-400/50">
        {regime.name}
        {status ? ` · eigenmode m=${status.eigenmode || '–'} · nonce ${status.nonce.toString(16).padStart(8, '0')}` : ''}
      </div>
    </div>
  );
}

function ActionButton({ icon, label, title, onClick }: { icon: React.ReactNode; label: string; title: string; onClick: () => void }) {
  return (
    <button type="button" title={title} onClick={onClick}
      className="flex items-center justify-center gap-1 rounded-lg border border-slate-800 bg-slate-900/60 px-2 py-1.5 text-[11px] text-slate-300 hover:border-slate-600 hover:text-white">
      {icon}{label}
    </button>
  );
}

/** K(r) of every kernel (each scaled to its own peak) and its growth curve G(U). */
function KernelPreview({ regime }: { regime: Regime }) {
  const W = 300, H = 92, pad = 4;
  const kPaths = regime.kernels.map((k) => {
    const pts: number[] = [];
    for (let i = 0; i <= 120; i++) pts.push(shell(k.b, (i / 120) / k.r));
    const peak = Math.max(...pts, 1e-6);
    return pts.map((v, i) => `${i ? 'L' : 'M'}${(pad + (i / 120) * (W - 2 * pad)).toFixed(1)},${(H - pad - (v / peak) * (H - 2 * pad)).toFixed(1)}`).join('');
  });
  const uMax = 0.6;
  const gPaths = regime.kernels.map((k) => {
    let d = '';
    for (let i = 0; i <= 150; i++) {
      const u = (i / 150) * uMax;
      const g = growth(u, k.m, k.s);
      d += `${i ? 'L' : 'M'}${(pad + (i / 150) * (W - 2 * pad)).toFixed(1)},${(H / 2 - g * (H / 2 - pad)).toFixed(1)}`;
    }
    return d;
  });
  const opacity = regime.kernels.length > 4 ? 0.55 : 0.9;
  return (
    <div className="space-y-3">
      <div>
        <SectionTitle right={<span className="text-[10px] text-slate-500">r = 0 … R={regime.R}</span>}>Kernel K(r)</SectionTitle>
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full rounded-lg border border-slate-800 bg-slate-950/60">
          {kPaths.map((d, i) => <path key={i} d={d} fill="none" stroke={css(CHANNEL_COLOURS[regime.kernels[i].c1])} strokeOpacity={opacity} strokeWidth={1.3} />)}
        </svg>
      </div>
      <div>
        <SectionTitle right={<span className="text-[10px] text-slate-500">U = 0 … {uMax}</span>}>Growth G(U)</SectionTitle>
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full rounded-lg border border-slate-800 bg-slate-950/60">
          <line x1={pad} x2={W - pad} y1={H / 2} y2={H / 2} stroke="#334155" strokeDasharray="3 3" />
          {gPaths.map((d, i) => <path key={i} d={d} fill="none" stroke={css(CHANNEL_COLOURS[regime.kernels[i].c1])} strokeOpacity={opacity} strokeWidth={1.3} />)}
        </svg>
      </div>
      <p className="text-[11px] leading-snug text-slate-500">
        Each cell grows only when the ring-weighted mass around it lands inside a growth band (G &gt; 0, above the dashed line)
        and decays everywhere else. A narrow band admits only a few self-consistent shapes; the rings decide which. Colour = the
        channel a kernel feeds ({CH.map((c, i) => <span key={c} style={{ color: css(CHANNEL_COLOURS[i]) }}>{c} </span>)}).
      </p>
    </div>
  );
}

function Vitals({ status }: { status: MorphoStatus }) {
  return (
    <div>
      <SectionTitle>Director</SectionTitle>
      <div className="grid grid-cols-3 gap-2 text-center">
        <Stat label="coverage" value={`${(status.cover * 100).toFixed(1)}%`} />
        <Stat label="activity" value={status.activity.toFixed(1)} />
        <Stat label="quantum" value={`${(status.quantumShare * 100).toFixed(0)}%`} />
      </div>
      <ul className="mt-2 space-y-0.5 font-mono text-[10px] text-slate-500">
        {status.events.map((e) => <li key={`${e.step}-${e.text}`}><span className="text-slate-600">{e.step}</span> {e.text}</li>)}
      </ul>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/50 px-2 py-1.5">
      <div className="text-sm font-semibold text-slate-100">{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
    </div>
  );
}
