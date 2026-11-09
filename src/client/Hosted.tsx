import { useCallback, useEffect, useRef, useState } from 'react';
import MorphoCanvas, { type MorphoControl, type MorphoStatus } from './morpho/MorphoCanvas';
import { REGIMES } from './morpho/regimes';
import {
  decodeSettings, DEFAULT_SETTINGS, DRIFT_RANGES, fromHex, LOOKS, normalise, PALETTES,
  type MorphoSettings, type Rgb,
} from './morpho/settings';

/**
 * The world alone, full window, no UI: what the desktop app (desktop/) shows behind the desktop
 * icons (?view=wallpaper) and as the live preview in its settings window (?view=preview).
 *
 * Inside the app (WebView2) the page is driven by messages from the app:
 *   → { type: 'settings', settings, regime, auto }   the viewer's settings (applied live)
 *   → { type: 'pointer', x, y }                       the desktop mouse, in page pixels
 *   → { type: 'hold', level: 'run' | 'slow' }         slow to a crawl (a game is running)
 *   → { type: 'command', name: 'reseed' | 'nucleate' }
 *   → { type: 'apply', look | palette | code | reset }   presets, an imported code, or defaults
 *   ← { type: 'ready', regimes, looks, palettes, ranges } once listening
 *   ← { type: 'normalised', settings }   every settings message back with all defaults filled in
 *   ← { type: 'changed', settings, regime?, auto? }   the result of an 'apply' (the app saves it)
 *   ← { type: 'status', … } every second
 * Opened in a plain browser it runs on its own: ?regime=…&auto=0&s=… (settings as the lab exports them).
 */

interface HostMessage {
  type: string;
  settings?: unknown;
  regime?: string | null;
  auto?: boolean;
  x?: number;
  y?: number;
  level?: string;
  name?: string;
  look?: string;
  palette?: string;
  code?: string;
  reset?: boolean;
}

interface WebViewBridge {
  postMessage(m: unknown): void;
  addEventListener(t: 'message', f: (e: { data: HostMessage }) => void): void;
  removeEventListener(t: 'message', f: (e: { data: HostMessage }) => void): void;
}
const bridge = (): WebViewBridge | undefined => (window as unknown as { chrome?: { webview?: WebViewBridge } }).chrome?.webview;

export default function Hosted({ view }: { view: 'wallpaper' | 'preview' }) {
  const host = bridge();
  const q = new URLSearchParams(window.location.search);
  // Standalone: start at once from the URL. Hosted: wait for the app's first settings message.
  const [boot, setBoot] = useState<{ regime?: string; auto: boolean } | null>(() =>
    host ? null : { regime: q.get('regime') ?? undefined, auto: q.get('auto') !== '0' });
  const [settings, setSettings] = useState<MorphoSettings>(() => decodeSettings(q.get('s')) ?? DEFAULT_SETTINGS);
  const current = useRef(settings);
  current.current = settings;
  const [hold, setHold] = useState<'run' | 'slow'>('run');
  const control = useRef<MorphoControl | null>(null);
  /** The regime the app last asked for (the world may have drifted on since). */
  const asked = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (!host) return;
    const onMessage = (e: { data: HostMessage }) => {
      const m = e.data;
      if (!m || typeof m !== 'object') return;
      if (m.type === 'settings') {
        const n = normalise(m.settings);
        current.current = n;
        setSettings(n);
        host.postMessage({ type: 'normalised', settings: n });
        const auto = m.auto !== false;
        const regime = m.regime ?? undefined;
        setBoot((b) => b ?? { regime, auto });
        control.current?.setAuto(auto);
        // Only a newly chosen regime moves the world (a drifting world stays where it drifted).
        if (asked.current !== undefined && regime && regime !== asked.current) control.current?.setRegime(regime);
        asked.current = regime ?? null;
      } else if (m.type === 'pointer' && typeof m.x === 'number' && typeof m.y === 'number') {
        control.current?.pointer(m.x, m.y);
      } else if (m.type === 'hold') {
        setHold(m.level === 'slow' ? 'slow' : 'run');
      } else if (m.type === 'apply') {
        const s = current.current;
        let next: MorphoSettings | null = null;
        let extra: { regime?: string; auto?: boolean } = {};
        if (m.reset) next = DEFAULT_SETTINGS;
        else if (m.look) {
          const l = LOOKS.find((x) => x.id === m.look);
          if (l) next = { ...s, display: { ...s.display, ...l.display } };
        } else if (m.palette) {
          const p = PALETTES.find((x) => x.id === m.palette);
          if (p) next = { ...s, display: { ...s.display, colours: p.colours.map(fromHex) as [Rgb, Rgb, Rgb], background: fromHex(p.background), haloColour: fromHex(p.halo) } };
        } else if (m.code) {
          // The lab's settings code: base64url settings, optionally ".regimeId" (pinned).
          const [enc, regime] = m.code.trim().split('.');
          next = decodeSettings(enc);
          if (next) extra = regime ? { regime, auto: false } : { auto: true };
        }
        if (next) {
          current.current = next;
          setSettings(next);
          host.postMessage({ type: 'changed', settings: next, ...extra });
        } else host.postMessage({ type: 'changed', error: 'That code could not be read.' });
      } else if (m.type === 'command') {
        if (m.name === 'reseed') control.current?.reseed();
        else if (m.name === 'nucleate') control.current?.nucleate();
      }
    };
    host.addEventListener('message', onMessage);
    host.postMessage({
      type: 'ready', view,
      regimes: REGIMES.map((r) => ({ id: r.id, name: r.name, blurb: r.blurb })),
      looks: LOOKS.map((l) => ({ id: l.id, name: l.name })),
      palettes: PALETTES.map((p) => ({ id: p.id, name: p.name })),
      ranges: Object.entries(DRIFT_RANGES).map(([key, r]) => ({ key, label: r.label, min: r.range[0], max: r.range[1], limit: r.max, step: r.step })),
    });
    return () => host.removeEventListener('message', onMessage);
  }, [host, view]);

  const lastSent = useRef(0);
  const onStatus = useCallback((s: MorphoStatus) => {
    const now = performance.now();
    if (!host || now - lastSent.current < 1000) return;
    lastSent.current = now;
    host.postMessage({
      type: 'status', view, regime: s.regime.id, regimeName: s.regime.name, morphingTo: s.morphingTo,
      gpu: s.gpu, stepScale: s.stepScale, cover: s.cover, events: s.events.slice(0, 4).map((e) => e.text),
    });
  }, [host, view]);

  return (
    <div className="relative h-[100dvh] w-[100dvw] cursor-default overflow-hidden bg-[#02040b]">
      {boot && <MorphoCanvas regime={boot.regime} auto={boot.auto} settings={settings} hold={hold} onStatus={onStatus} control={control} />}
    </div>
  );
}
