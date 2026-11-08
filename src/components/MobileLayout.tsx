import { useState, type ReactNode } from 'react';
import { ChevronDown, Dna, MessageSquareText, SlidersHorizontal } from 'lucide-react';
import type { EntropyTelemetry } from '../engine/QuantumEntropy';
import { fmt } from '../client/state';
import { QuantumBadge } from './QuantumEntropyHUD';
import { cx } from './ui';

/** Compact top HUD bar (< lg). */
export function MobileHUD({ fps, tps, population, mode, onOpenBuilder }: { fps: number; tps: number; population: number; mode: EntropyTelemetry['mode'] | undefined; onOpenBuilder: () => void }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-20 lg:hidden" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
      <div className="pointer-events-auto mx-2 mt-2 flex items-center gap-2 rounded-2xl border border-slate-800 bg-slate-950/80 px-3 py-2 backdrop-blur-md">
        <Dna size={16} className="shrink-0 text-emerald-300" />
        <div className="flex min-w-0 flex-1 items-center gap-3 font-mono text-[11px] tabular-nums text-slate-300">
          <span><span className="text-slate-500">FPS</span> {fps.toFixed(0)}</span>
          <span><span className="text-slate-500">T/s</span> {tps.toFixed(0)}</span>
          <span><span className="text-slate-500">Pop</span> {fmt(population)}</span>
        </div>
        <QuantumBadge mode={mode} compact />
        <button type="button" onClick={onOpenBuilder} className="shrink-0 rounded-lg p-1 text-slate-400 active:text-emerald-300" title="Builder" aria-label="Builder">
          <MessageSquareText size={16} />
        </button>
      </div>
    </div>
  );
}

export type SheetTab = 'physics' | 'quantum' | 'inspector' | 'stats';

/** Slide-up bottom sheet with tabbed content (< lg). */
export function BottomSheet({ open, setOpen, tab, setTab, children }: {
  open: boolean;
  setOpen: (o: boolean) => void;
  tab: SheetTab;
  setTab: (t: SheetTab) => void;
  children: ReactNode;
}) {
  const [dragY, setDragY] = useState<number | null>(null);
  const [startY, setStartY] = useState(0);
  return (
    <div className="lg:hidden">
      <div
        className={cx('fixed inset-0 z-30 bg-black/40 transition-opacity', open ? 'opacity-100' : 'pointer-events-none opacity-0')}
        onClick={() => setOpen(false)}
      />
      <div
        className="fixed inset-x-0 bottom-0 z-40 flex max-h-[78dvh] flex-col rounded-t-3xl border-t border-slate-800 bg-slate-950/95 backdrop-blur-md transition-transform duration-300"
        style={{
          transform: open ? `translateY(${dragY ?? 0}px)` : 'translateY(100%)',
          transitionDuration: dragY !== null ? '0ms' : undefined,
          paddingBottom: 'env(safe-area-inset-bottom)',
        }}
      >
        <div
          className="flex cursor-grab touch-none flex-col items-center pb-1 pt-2"
          onPointerDown={(e) => {
            (e.target as HTMLElement).setPointerCapture(e.pointerId);
            setStartY(e.clientY);
            setDragY(0);
          }}
          onPointerMove={(e) => dragY !== null && setDragY(Math.max(0, e.clientY - startY))}
          onPointerUp={() => {
            if ((dragY ?? 0) > 80) setOpen(false);
            setDragY(null);
          }}
        >
          <div className="h-1.5 w-10 rounded-full bg-slate-700" />
        </div>
        <div className="flex items-center gap-1 px-3 pb-2">
          {([['physics', 'Physics'], ['quantum', 'Quantum'], ['inspector', 'Inspector'], ['stats', 'Stats']] as [SheetTab, string][]).map(([k, l]) => (
            <button key={k} type="button" onClick={() => setTab(k)}
              className={cx('flex-1 rounded-lg py-1.5 text-xs font-medium', tab === k ? 'bg-slate-100 text-slate-900' : 'text-slate-400')}>
              {l}
            </button>
          ))}
          <button type="button" onClick={() => setOpen(false)} className="ml-1 rounded-lg p-1.5 text-slate-400" aria-label="Close sheet">
            <ChevronDown size={18} />
          </button>
        </div>
        <div className="tl-scroll min-h-0 flex-1 overflow-y-auto px-4 pb-4">{children}</div>
      </div>
    </div>
  );
}

/** Bottom thumb-zone toolbar (< lg). */
export function MobileToolbar({ children, onOpenSheet }: { children: ReactNode; onOpenSheet: () => void }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 lg:hidden" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
      <div className="pointer-events-auto mx-2 mb-2 rounded-2xl border border-slate-800 bg-slate-950/85 p-2 backdrop-blur-md">
        {children}
        <button type="button" onClick={onOpenSheet}
          className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl bg-slate-900 py-2 text-xs font-medium text-slate-300">
          <SlidersHorizontal size={14} /> Physics · Quantum Pool · Inspector
        </button>
      </div>
    </div>
  );
}
