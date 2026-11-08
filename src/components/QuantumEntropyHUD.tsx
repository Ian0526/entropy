import { useEffect, useRef, useState } from 'react';
import { Atom, RefreshCw } from 'lucide-react';
import type { EntropyTelemetry } from '../engine/QuantumEntropy';
import type { ResyncResult } from '../client/sim/SimSource';
import { ago, fmt } from '../client/state';
import { cx, SectionTitle } from './ui';

export function QuantumBadge({ mode, provider, compact }: {
  mode: EntropyTelemetry['mode'] | undefined;
  provider?: string;
  compact?: boolean;
}) {
  const name = !provider || provider === 'none' ? 'QRNG' : provider.startsWith('QRNG@ANU') || provider.startsWith('ANU') ? 'ANU QRNG' : provider;
  const style = mode === 'LIVE_QUANTUM'
    ? 'border-emerald-400/50 bg-emerald-400/10 text-emerald-200'
    : mode === 'LIVE_SIMULATED'
      ? 'border-amber-400/50 bg-amber-500/10 text-amber-200'
      : 'border-fuchsia-400/50 bg-fuchsia-500/10 text-fuchsia-200';
  const [full, short, title] = mode === 'LIVE_QUANTUM'
    ? [`🟢 ${name} Direct`, '🟢 QRNG Direct', 'Fresh hardware quantum samples are being consumed sequentially']
    : mode === 'LIVE_SIMULATED'
      ? [`🟡 ${name} Simulator (non-quantum)`, '🟡 Simulated', 'The provider served software-simulator output (QRNG_ACCEPT_SIMULATOR=1). It is NOT quantum entropy.']
      : ['🟣 Quantum Nonce-Wrap Sponge (Fallback Active)', '🟣 Nonce Sponge', 'No fresh hardware batch: the pool is re-used via nonce-wrapped index jumping into SFC32'];
  return (
    <span className={cx('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold whitespace-nowrap', style)} title={title}>
      {compact ? short : full}
    </span>
  );
}

function PoolRing({ pool, entropy, trail }: { pool: Uint16Array | null; entropy: EntropyTelemetry | undefined; trail: number[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const data = useRef({ pool, entropy, trail });
  data.current = { pool, entropy, trail };

  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext('2d')!;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const S = 188;
    canvas.width = S * dpr;
    canvas.height = S * dpr;
    let raf = 0;
    let hop = 0;
    let lastTrailKey = '';
    let lastT = performance.now();

    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      const dt = (now - lastT) / 1000;
      lastT = now;
      const { pool: pl, entropy: en, trail: tr } = data.current;
      const key = tr.join(',');
      if (key !== lastTrailKey) {
        lastTrailKey = key;
        hop = Math.max(0, tr.length - 12);
      }
      // Replay recent jumps at ~24 hops/s so the pointer visibly hops between indices.
      hop = Math.min(tr.length - 1, hop + dt * 24);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, S, S);
      const c = S / 2;
      const R0 = 54;
      const R1 = 84;
      const live = en?.mode === 'LIVE_QUANTUM';
      const ang = (i: number) => (i / 1024) * Math.PI * 2 - Math.PI / 2;

      // Radial bars: each of the 1024 slots, length ∝ quantum value.
      if (pl) {
        ctx.lineWidth = 1;
        for (let i = 0; i < 1024; i++) {
          const a = ang(i);
          const v = pl[i] / 65535;
          const r2 = R0 + 4 + v * (R1 - R0 - 6);
          ctx.strokeStyle = live ? `rgba(52,211,153,${0.18 + v * 0.5})` : `rgba(217,70,239,${0.16 + v * 0.45})`;
          ctx.beginPath();
          ctx.moveTo(c + Math.cos(a) * R0, c + Math.sin(a) * R0);
          ctx.lineTo(c + Math.cos(a) * r2, c + Math.sin(a) * r2);
          ctx.stroke();
        }
      }
      // Fresh-batch gauge (outer arc).
      const fresh = (en?.freshRemaining ?? 0) / 1024;
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(51,65,85,0.6)';
      ctx.beginPath();
      ctx.arc(c, c, R1 + 5, 0, Math.PI * 2);
      ctx.stroke();
      if (fresh > 0) {
        ctx.strokeStyle = 'rgba(52,211,153,0.95)';
        ctx.beginPath();
        ctx.arc(c, c, R1 + 5, -Math.PI / 2, -Math.PI / 2 + fresh * Math.PI * 2);
        ctx.stroke();
      }

      // Jump chords (most recent brightest).
      const h = Math.floor(hop);
      const start = Math.max(0, h - 10);
      for (let k = start; k < h; k++) {
        const a1 = ang(tr[k]);
        const a2 = ang(tr[k + 1]);
        const alpha = 0.15 + 0.75 * ((k - start + 1) / (h - start + 1));
        ctx.strokeStyle = `rgba(250,232,255,${alpha})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(c + Math.cos(a1) * (R0 - 2), c + Math.sin(a1) * (R0 - 2));
        ctx.quadraticCurveTo(c, c, c + Math.cos(a2) * (R0 - 2), c + Math.sin(a2) * (R0 - 2));
        ctx.stroke();
      }
      // Weyl anti-cycle pointer.
      if (en) {
        const aw = ang(en.weylIdx);
        ctx.fillStyle = 'rgba(56,189,248,0.9)';
        ctx.beginPath();
        ctx.arc(c + Math.cos(aw) * (R1 + 5), c + Math.sin(aw) * (R1 + 5), 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
      // Current jumpIdx glow.
      const cur = tr.length ? tr[Math.max(0, h)] : en?.jumpIdx ?? 0;
      const aj = ang(cur);
      const jx = c + Math.cos(aj) * (R0 - 2);
      const jy = c + Math.sin(aj) * (R0 - 2);
      const g = ctx.createRadialGradient(jx, jy, 0, jx, jy, 10);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(0.35, live ? 'rgba(52,211,153,0.8)' : 'rgba(232,121,249,0.8)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(jx, jy, 10, 0, Math.PI * 2);
      ctx.fill();

      // Centre readout.
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(148,163,184,0.9)';
      ctx.font = '600 9px ui-sans-serif, system-ui';
      ctx.fillText('JUMP IDX', c, c - 12);
      ctx.fillStyle = '#f8fafc';
      ctx.font = '600 20px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillText(String(cur).padStart(4, '0'), c, c + 8);
      ctx.fillStyle = 'rgba(148,163,184,0.75)';
      ctx.font = '9px ui-monospace, monospace';
      ctx.fillText(`nonce ${((en?.nonce ?? 0) >>> 0).toString(16).padStart(8, '0')}`, c, c + 22);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  return <canvas ref={ref} className="h-[188px] w-[188px]" aria-label="Quantum pool ring-buffer visualizer" />;
}

export default function QuantumEntropyHUD(props: {
  entropy: EntropyTelemetry | undefined;
  jumpTrail: number[];
  sourceKind: 'cloud' | 'local';
  getPool: () => Promise<Uint16Array | null>;
  resync: () => Promise<ResyncResult>;
}) {
  const { entropy } = props;
  const [pool, setPool] = useState<Uint16Array | null>(null);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [localCooldownUntil, setLocalCooldownUntil] = useState(0);
  const getPoolRef = useRef(props.getPool);
  getPoolRef.current = props.getPool;

  // Refresh the pool snapshot periodically and whenever a new batch lands.
  const batchKey = `${entropy?.fetchOk}-${entropy?.origin}-${props.sourceKind}`;
  useEffect(() => {
    let alive = true;
    const pull = async () => {
      const p = await getPoolRef.current();
      if (alive && p) setPool(p);
    };
    void pull();
    const id = setInterval(pull, 10_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [batchKey]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const cooldownUntil = Math.max(entropy?.resyncAvailableAt ?? 0, localCooldownUntil);
  const cooldown = Math.max(0, Math.ceil((cooldownUntil - now) / 1000));

  const onResync = async () => {
    setBusy(true);
    setMsg(null);
    const r = await props.resync();
    setBusy(false);
    setLocalCooldownUntil(Date.now() + r.cooldownMs);
    setMsg(r.ok ? 'Fresh quantum batch ingested'
      : r.reason === 'cooldown' ? 'Rate-limit cooldown active'
        : r.reason === 'budget-exhausted' ? 'Monthly request budget used — sponge holds until it resets'
          : `No batch ingested (${r.reason ?? 'error'}) — sponge holds`);
    const p = await props.getPool();
    if (p) setPool(p);
  };

  const http = entropy?.lastHttpStatus ?? 0;
  const statusText = !entropy || (entropy.fetchOk + entropy.fetchFail === 0 && !entropy.lastError)
    ? 'awaiting first harvest'
    : entropy.lastError ? 'see note'
      : http === 200 ? 'HTTP 200' : http === 429 ? 'HTTP 429 rate-limited' : http === 0 ? 'timeout / network' : http === -1 ? 'malformed payload' : `HTTP ${http}`;
  const budget = entropy && entropy.provider !== 'none'
    ? entropy.budgetTotal === null ? 'unmetered' : `${entropy.budgetUsed} / ${entropy.budgetTotal} req`
    : '—';
  const budgetSpent = !!entropy && entropy.budgetTotal !== null && entropy.budgetUsed >= entropy.budgetTotal;
  const hw = entropy?.hardwareOnline;
  const originText = entropy?.origin === 'QRNG' ? 'Hardware QRNG'
    : entropy?.origin === 'QRNG_SIMULATOR' ? 'Simulator!'
      : entropy?.origin === 'SERVER_SNAPSHOT' ? 'Snapshot' : 'CSPRNG boot';
  const nextIn = (ts: number) => {
    const s = Math.max(0, Math.ceil((ts - now) / 1000));
    return s >= 86400 ? `${(s / 86400).toFixed(1)}d` : s >= 3600 ? `${(s / 3600).toFixed(1)}h` : s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
  };

  return (
    <div>
      <SectionTitle icon={<Atom size={13} className="text-fuchsia-300" />}>Quantum Core</SectionTitle>
      <QuantumBadge mode={entropy?.mode} provider={entropy?.provider} />
      <div className="mt-2 flex flex-col items-center gap-2">
        <PoolRing pool={pool} entropy={entropy} trail={props.jumpTrail} />
        <dl className="grid w-full grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
          {[
            ['Provider', entropy?.provider ?? '—'],
            ['Hardware', hw === true ? 'online' : hw === false ? 'offline' : 'unknown'],
            ['Pool origin', originText],
            ['Last fetch', ago(entropy?.lastFetchTime ?? 0, now)],
            ['Next cron', entropy?.nextFetchTime ? nextIn(entropy.nextFetchTime) : props.sourceKind === 'local' ? 'server-side' : '—'],
            ['Budget', budget],
            ['Upstream', statusText],
            ['Fresh left', `${entropy?.freshRemaining ?? 0} / 1024`],
            ['Nonce wraps', fmt(entropy?.totalWraps ?? 0)],
            ['Anti-cycle', fmt(entropy?.antiCycleEvents ?? 0)],
            ['Jump index', String(entropy?.jumpIdx ?? 0)],
            ['Fetch ok/fail', `${entropy?.fetchOk ?? 0} / ${entropy?.fetchFail ?? 0}`],
          ].map(([k, v]) => (
            <div key={k} className="flex min-w-0 justify-between gap-2">
              <dt className="shrink-0 text-slate-500">{k}</dt>
              <dd className="truncate font-mono tabular-nums text-slate-200">{v}</dd>
            </div>
          ))}
        </dl>
      </div>
      {entropy?.lastError && (
        <p className="mt-2 rounded-lg border border-amber-400/30 bg-amber-500/10 px-2.5 py-1.5 text-[11px] leading-snug text-amber-100" title="Last harvest attempt">
          {entropy.lastError}
        </p>
      )}
      <button
        type="button"
        onClick={onResync}
        disabled={busy || cooldown > 0 || (props.sourceKind === 'cloud' && budgetSpent) || entropy?.provider === 'none'}
        className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl border border-fuchsia-400/40 bg-fuchsia-500/10 px-3 py-2 text-xs font-semibold text-fuchsia-100 transition hover:bg-fuchsia-500/20 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <RefreshCw size={14} className={busy ? 'animate-spin' : ''} />
        {props.sourceKind === 'local'
          ? cooldown > 0 ? `Re-seed from Server Pool (cooldown ${cooldown}s)` : 'Re-seed from Server Quantum Pool'
          : budgetSpent ? `Budget used — resets in ${nextIn(entropy!.budgetResetAt)}`
            : cooldown > 0 ? `Force QRNG Resync (cooldown ${nextIn(cooldownUntil)})` : 'Force QRNG Resync (spends 1 request)'}
      </button>
      {msg && <p className="mt-1.5 text-center text-[11px] text-slate-400">{msg}</p>}
    </div>
  );
}
