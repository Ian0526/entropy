import { Activity } from 'lucide-react';
import type { SimTelemetry } from '../engine/protocol';
import type { History } from '../client/useSimulation';
import { fmt, hueToCss } from '../client/state';
import { SectionTitle, Sparkline, Stat } from './ui';

export default function TelemetryPanel({ t, history, fps }: { t: SimTelemetry | null; history: History; fps: number }) {
  const pop = t?.population ?? 0;
  return (
    <div>
      <SectionTitle
        icon={<Activity size={13} className="text-cyan-300" />}
        right={<span className="font-mono text-[10px] text-slate-500">tick {fmt(t?.tick ?? 0)}</span>}
      >
        Live Telemetry
      </SectionTitle>
      <div className="grid grid-cols-3 gap-1.5">
        <Stat label="Render" value={`${fps.toFixed(0)} fps`} tone={fps >= 55 ? 'text-emerald-300' : 'text-amber-300'} />
        <Stat label="Sim" value={`${(t?.tps ?? 0).toFixed(0)} t/s`} />
        <Stat label="Tick cost" value={`${(t?.tickMs ?? 0).toFixed(1)} ms`} />
        <Stat label="Population" value={fmt(pop)} tone="text-emerald-200" />
        <Stat label="Species" value={t?.species ?? 0} tone="text-violet-200" />
        <Stat label="Mean E" value={(t?.meanEnergy ?? 0).toFixed(3)} tone="text-cyan-200" />
        <Stat label="Births" value={t?.births ?? 0} />
        <Stat label="Deaths" value={t?.deaths ?? 0} />
        <Stat label="Predation" value={t?.predations ?? 0} tone="text-rose-200" />
        <Stat label="Organisms" value={fmt(t?.organisms ?? 0)} tone="text-fuchsia-200" />
        <Stat label="In bodies" value={`${pop ? Math.round(((t?.organismCells ?? 0) / pop) * 100) : 0}%`} tone="text-fuchsia-200" />
        <Stat label="Seeds" value={t?.seeds ?? 0} tone="text-fuchsia-200" />
      </div>
      {t && pop > 0 && (
        <div className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-slate-800" title="Somatic composition">
          <div className="bg-emerald-400" style={{ width: `${(t.core / pop) * 100}%` }} />
          <div className="bg-slate-300" style={{ width: `${(t.armor / pop) * 100}%` }} />
          <div className="bg-amber-300" style={{ width: `${(t.sensor / pop) * 100}%` }} />
        </div>
      )}
      <div className="mt-3 space-y-2">
        <Sparkline label="Population" data={history.population} color="#34d399" value={fmt(pop)} />
        <Sparkline label="Speciation (kin hashes ≥ 4 cells)" data={history.species} color="#a78bfa" value={String(t?.species ?? 0)} />
        <Sparkline label="Phylogenetic drift (bits from ancestor)" data={history.distance} color="#f472b6" value={(t?.meanDistance ?? 0).toFixed(2)} />
      </div>
      {t && t.topSpecies.length > 0 && (
        <div className="mt-3 space-y-1">
          <div className="text-[10px] uppercase tracking-wider text-slate-500">Dominant lineages</div>
          {t.topSpecies.map((s) => (
            <div key={s.kin} className="flex items-center gap-2 text-[11px]">
              <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: hueToCss(s.hue) }} />
              <span className="font-mono text-slate-400">{s.kin.toString(16).padStart(4, '0')}</span>
              <div className="h-1 flex-1 overflow-hidden rounded-full bg-slate-800">
                <div className="h-full rounded-full" style={{ width: `${(s.count / t.topSpecies[0].count) * 100}%`, background: hueToCss(s.hue) }} />
              </div>
              <span className="w-10 text-right font-mono tabular-nums text-slate-300">{fmt(s.count)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
