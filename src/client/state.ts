import { Biohazard, Crosshair, Eraser, Hand, Radiation, Sprout, Zap, BrickWall, type LucideIcon } from 'lucide-react';
import type { ToolKind } from '../engine/protocol';

export type LayerWeights = [number, number, number, number];

export const LAYERS: { id: number; key: string; label: string; short: string; color: string }[] = [
  { id: 0, key: '1', label: 'Composite Bio-View', short: 'Bio', color: 'text-emerald-300' },
  { id: 1, key: '2', label: 'Neural / Signal', short: 'Neural', color: 'text-cyan-300' },
  { id: 2, key: '3', label: 'Thermodynamic Heatmap', short: 'Thermo', color: 'text-rose-300' },
  { id: 3, key: '4', label: 'Lineage X-Ray', short: 'Lineage', color: 'text-violet-300' },
];

export interface ToolDef {
  id: ToolKind;
  label: string;
  hint: string;
  key: string;
  icon: LucideIcon;
  accent: string;
}

export const TOOLS: ToolDef[] = [
  { id: 'inspect', label: 'Inspect / Pan', hint: 'Tap a cell to inspect · drag to pan (2D) or orbit (3D)', key: 'I', icon: Hand, accent: 'bg-slate-200 text-slate-900' },
  { id: 'poke', label: 'Poke / Damage', hint: 'Wound tissue — watch it heal', key: 'P', icon: Zap, accent: 'bg-amber-400 text-slate-950' },
  { id: 'mutagen', label: 'Quantum Mutagen', hint: 'Irradiate genomes with quantum bit-flips', key: 'M', icon: Radiation, accent: 'bg-lime-400 text-slate-950' },
  { id: 'wall', label: 'Wall Barrier', hint: 'Draw inert terrain', key: 'B', icon: BrickWall, accent: 'bg-slate-400 text-slate-950' },
  { id: 'erase', label: 'Erase Barrier', hint: 'Remove terrain', key: 'X', icon: Eraser, accent: 'bg-slate-500 text-white' },
  { id: 'food', label: 'Food Dropper', hint: 'Seed nutrient', key: 'F', icon: Sprout, accent: 'bg-emerald-400 text-slate-950' },
  { id: 'predator', label: 'Predator Injector', hint: 'Spawn an apex predator colony', key: 'K', icon: Biohazard, accent: 'bg-rose-500 text-white' },
];

export const INSPECT_ICON = Crosshair;

/** Same HSV mapping as the shader's lineage colour (s = 0.68, v = 1). */
export function hueToCss(hue: number, s = 0.68, v = 1): string {
  const h = (hue / 255) * 6;
  const k = (n: number) => Math.min(1, Math.max(0, Math.abs(((h + n) % 6) - 3) - 1));
  const c = (n: number) => Math.round(v * (1 - s + s * k(n)) * 255);
  return `rgb(${c(0)}, ${c(4)}, ${c(2)})`;
}

export function fmt(n: number, digits = 0): string {
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (Math.abs(n) >= 1e4) return `${(n / 1e3).toFixed(1)}k`;
  return n.toFixed(digits);
}

export function ago(ts: number, now = Date.now()): string {
  if (!ts) return 'never';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s ago`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`;
}
