import { Microscope, X } from 'lucide-react';
import type { InspectResult } from '../engine/protocol';
import { hueToCss } from '../client/state';
import { cx, SectionTitle } from './ui';

const SOMA_NAMES = ['Empty', 'Core / Metabolic', 'Armor / Wall', 'Sensor / Cilia'];
const SOMA_COLORS = ['bg-slate-600', 'bg-emerald-400', 'bg-slate-300', 'bg-amber-300'];

/** Bit ranges of the 64-bit genome (global bit index → field), for the bit-grid legend. */
const FIELDS: { name: string; from: number; to: number; color: string }[] = [
  { name: 'harvest', from: 0, to: 5, color: '#34d399' },
  { name: 'emit', from: 6, to: 11, color: '#22d3ee' },
  { name: 'divide', from: 12, to: 17, color: '#a3e635' },
  { name: 'chemo·food', from: 18, to: 23, color: '#fbbf24' },
  { name: 'chemo·signal', from: 24, to: 29, color: '#f472b6' },
  { name: 'motility', from: 30, to: 31, color: '#fb923c' },
  { name: 'kin hash', from: 32, to: 47, color: '#a78bfa' },
  { name: 'pump', from: 48, to: 53, color: '#60a5fa' },
  { name: 'aggression', from: 54, to: 59, color: '#f87171' },
  { name: 'sensor·bias', from: 60, to: 61, color: '#fde047' },
  { name: 'armor·bias', from: 62, to: 63, color: '#cbd5e1' },
];
const fieldOf = (bit: number) => FIELDS.find((f) => bit >= f.from && bit <= f.to)!;

function Bar({ label, value, min = 0, max = 1, signed, color = 'bg-emerald-400' }: {
  label: string; value: number; min?: number; max?: number; signed?: boolean; color?: string;
}) {
  const t = (value - min) / (max - min);
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span className="w-[86px] shrink-0 text-slate-400">{label}</span>
      <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-slate-800">
        {signed ? (
          <div className={cx('absolute top-0 h-full', color)}
            style={{ left: `${Math.min(50, t * 100)}%`, width: `${Math.abs(t - 0.5) * 100}%` }} />
        ) : (
          <div className={cx('h-full rounded-full', color)} style={{ width: `${Math.max(0, Math.min(1, t)) * 100}%` }} />
        )}
        {signed && <div className="absolute left-1/2 top-0 h-full w-px bg-slate-500" />}
      </div>
      <span className="w-10 text-right font-mono tabular-nums text-slate-200">{value.toFixed(2)}</span>
    </div>
  );
}

export default function OrganismInspector({ data, onClose, tracking }: {
  data: InspectResult | null;
  onClose: () => void;
  tracking: boolean;
}) {
  if (!data) {
    return (
      <div>
        <SectionTitle icon={<Microscope size={13} className="text-amber-300" />}>Organism Inspector</SectionTitle>
        <p className="text-[11px] leading-relaxed text-slate-500">
          Select the <span className="text-slate-300">Inspect / Pan</span> tool and tap any cell to read its 64-bit genome, epigenetic register and kin-connected body.
        </p>
      </div>
    );
  }
  const g = data.genome;
  const bits: number[] = [];
  if (g) for (let b = 0; b < 64; b++) bits.push(b < 32 ? (g.words[0] >>> b) & 1 : (g.words[1] >>> (b - 32)) & 1);
  const cl = data.cluster;

  return (
    <div>
      <SectionTitle
        icon={<Microscope size={13} className="text-amber-300" />}
        right={
          <div className="flex items-center gap-2">
            {tracking && <span className="text-[10px] uppercase tracking-wider text-emerald-400">live</span>}
            <button type="button" onClick={onClose} className="text-slate-500 hover:text-white" title="Clear selection"><X size={13} /></button>
          </div>
        }
      >
        Organism Inspector
      </SectionTitle>

      <div className="mb-2 flex items-center justify-between text-xs">
        <span className="font-mono text-slate-400">({data.x}, {data.y}{data.z ? `, ${data.z}` : ''})</span>
        <span className="flex items-center gap-1.5 text-slate-200">
          <span className={cx('h-2 w-2 rounded-full', SOMA_COLORS[data.somatic])} />
          {data.wall ? 'Wall terrain' : SOMA_NAMES[data.somatic]}
        </span>
      </div>

      {!data.alive ? (
        <div className="space-y-1">
          <Bar label="Ambient food" value={data.food} color="bg-emerald-500" />
          <Bar label="Signal A" value={data.signalA} color="bg-cyan-400" />
          <Bar label="Signal B" value={data.signalB} color="bg-pink-400" />
          <p className="pt-1 text-[11px] text-slate-500">No living cell here.</p>
        </div>
      ) : (
        <div className="space-y-2.5">
          <div className="space-y-1">
            <Bar label="Energy E" value={data.energy} color={data.energy < 0.15 ? 'bg-rose-500' : 'bg-cyan-400'} />
            <Bar label="Food F" value={data.food} color="bg-emerald-500" />
            <Bar label="Signal A" value={data.signalA} color="bg-cyan-300" />
            <Bar label="Signal B" value={data.signalB} color="bg-pink-400" />
          </div>

          <div className="flex items-center gap-2 text-[11px]">
            <span className="text-slate-400">Epigenetic</span>
            <span className={cx('rounded px-1.5 py-0.5 font-mono', data.epigenetic.damaged ? 'bg-rose-500/20 text-rose-200' : 'bg-slate-800 text-slate-500')}>
              b0 damaged
            </span>
            <span className={cx('rounded px-1.5 py-0.5 font-mono', data.epigenetic.starving ? 'bg-amber-500/20 text-amber-200' : 'bg-slate-800 text-slate-500')}>
              b1 starving
            </span>
            <span className="ml-auto font-mono text-slate-500">age {data.age}</span>
          </div>

          {g && (
            <div>
              <div className="mb-1 flex items-center justify-between text-[11px]">
                <span className="text-slate-400">Genome</span>
                <span className="font-mono text-slate-200">0x{g.hex}</span>
              </div>
              <div className="grid grid-cols-16 gap-[2px]" style={{ gridTemplateColumns: 'repeat(16, minmax(0, 1fr))' }}>
                {bits.map((b, i) => {
                  const f = fieldOf(i);
                  return (
                    <div key={i} title={`bit ${i} · ${f.name}`} className="h-2.5 rounded-[2px]"
                      style={{ background: b ? f.color : 'rgba(51,65,85,0.5)', opacity: b ? 0.95 : 1 }} />
                  );
                })}
              </div>
              <div className="mt-1.5 space-y-1">
                <Bar label="Harvest gain" value={g.harvestGain} min={0.5} max={1.5} />
                <Bar label="Emit thresh." value={g.emitThreshold} color="bg-cyan-400" />
                <Bar label="Divide thresh." value={g.divideThreshold} color="bg-lime-400" />
                <Bar label="Chemo · food" value={g.chemoFood} min={-1} max={1} signed color="bg-amber-400" />
                <Bar label="Chemo · signal" value={g.chemoSignal} min={-1} max={1} signed color="bg-pink-400" />
                <Bar label="Motility" value={g.motility} color="bg-orange-400" />
                <Bar label="Pump strength" value={g.pumpStrength} color="bg-blue-400" />
                <Bar label="Aggression" value={g.aggression} color="bg-rose-500" />
                <Bar label="Sensor bias" value={g.sensorBias} color="bg-yellow-300" />
                <Bar label="Armor bias" value={g.armorBias} color="bg-slate-300" />
              </div>
              <div className="mt-2 flex items-center justify-between text-[11px]">
                <span className="flex items-center gap-1.5 text-slate-400">
                  <span className="h-2.5 w-2.5 rounded-sm" style={{ background: hueToCss(((((g.kinHash >>> 8) & 0xff) * 157) + 23) & 255) }} />
                  Kin hash <span className="font-mono text-slate-200">{g.kinHash.toString(16).padStart(4, '0')}</span>
                </span>
                <span className="text-slate-400">
                  Δ ancestor <span className="font-mono text-violet-300">{data.ancestorDistance} bits</span>
                  <span className="ml-1 text-slate-500">({data.relationToAncestor})</span>
                </span>
              </div>
            </div>
          )}

          {cl && (
            <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-2">
              <div className="mb-1 flex justify-between text-[11px]">
                <span className="text-slate-400">Kin-connected body</span>
                <span className="font-mono text-slate-100">{cl.size}{cl.truncated ? '+' : ''} cells</span>
              </div>
              <div className="flex h-2 overflow-hidden rounded-full bg-slate-800">
                <div className="bg-emerald-400" style={{ width: `${(cl.core / cl.size) * 100}%` }} title={`core ${cl.core}`} />
                <div className="bg-slate-300" style={{ width: `${(cl.armor / cl.size) * 100}%` }} title={`armor ${cl.armor}`} />
                <div className="bg-amber-300" style={{ width: `${(cl.sensor / cl.size) * 100}%` }} title={`sensor ${cl.sensor}`} />
              </div>
              <div className="mt-1 flex justify-between font-mono text-[10px] text-slate-500">
                <span>core {cl.core} · armor {cl.armor} · sensor {cl.sensor}</span>
                <span>Ē {cl.meanEnergy.toFixed(2)}</span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
