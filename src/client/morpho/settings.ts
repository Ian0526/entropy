/**
 * Everything about the Morphogenesis world a viewer can change without touching the physics
 * library: the look (colours, optics), the size of the world on screen, the speed, how the
 * pointer acts on it, and a few physics overrides. Kept as plain data so the lab can save it in
 * localStorage and hand it to the wallpaper as one URL parameter (?s=…).
 */

export type Rgb = [number, number, number];

export interface DisplaySettings {
  /** Channel colours A, B, C, the vacuum and the halo around bodies. */
  colours: [Rgb, Rgb, Rgb];
  background: Rgb;
  haloColour: Rgb;
  /** Upscaling from the grid to the screen: 'bicubic' (smooth Catmull-Rom) or 'bilinear'. */
  filter: 'bicubic' | 'bilinear';
  exposure: number;
  /** Body fill, membrane edge glow, halo strength and halo radius (cells). */
  body: number;
  edge: number;
  halo: number;
  haloRadius: number;
  /** Phase crests inside bodies (the Kuramoto beat). */
  crests: number;
  /** Microscope optics: DIC relief, thin-film iridescence, wet specular, organelle rings, nucleus glow. */
  relief: number;
  iridescence: number;
  specular: number;
  pellicle: number;
  nucleus: number;
  /** Cyan glow where the flow is vortical. */
  vorticity: number;
  /** Per-organism hue shift from the genome (only in regimes with speciation). */
  geneTint: number;
  /** Film tonemap, sensor grain and lens vignette. */
  tonemap: number;
  grain: number;
  vignette: number;
}

export interface InteractionSettings {
  /** What moving the pointer does: drag the liquid, tap the cover slip, or nothing. */
  move: 'stir' | 'ripple' | 'off';
  /** What a click does. */
  click: 'seed' | 'ring' | 'erase' | 'off';
  /** Strength of the stir/ripple and its radius as a multiple of R. */
  strength: number;
  radius: number;
}

/** Physics overrides; undefined keeps the regime's own value. */
export interface PhysicsOverrides {
  speciation?: number;
  curl?: number;
  swirl?: number;
  vortexMu?: number;
}

/**
 * Drift: everything chosen keeps easing toward a new random target (one every `period` seconds),
 * colours and optics included, with no jumps. Regimes drift too if `regimes` is on (as morphs).
 */
export interface DriftSettings {
  enabled: boolean;
  period: number;
  look: boolean;
  colours: boolean;
  physics: boolean;
  regimes: boolean;
  /** Also drift the steps per second (within ranges.speed). */
  speed: boolean;
  /** Your own [min, max] for anything drift moves (see DRIFT_RANGES for the keys and defaults). */
  ranges: Record<string, [number, number]>;
}

/**
 * What drift may move and its default [min, max]: each optical term (narrower than the sliders, so
 * it always stays watchable), the four physics knobs, and steps per second.
 */
export const DRIFT_RANGES: Record<string, { label: string; range: [number, number]; max: number; step: number }> = {
  exposure: { label: 'Exposure', range: [0.7, 1.4], max: 2.5, step: 0.05 },
  body: { label: 'Body fill', range: [0.4, 1.1], max: 1.5, step: 0.05 },
  edge: { label: 'Membrane glow', range: [0.15, 1.2], max: 2, step: 0.05 },
  halo: { label: 'Halo', range: [0.2, 1.3], max: 2, step: 0.05 },
  haloRadius: { label: 'Halo radius', range: [3, 14], max: 20, step: 0.5 },
  crests: { label: 'Phase crests', range: [0, 0.45], max: 1, step: 0.01 },
  geneTint: { label: 'Genome tint', range: [0.2, 0.8], max: 1, step: 0.05 },
  relief: { label: 'DIC relief', range: [0, 1], max: 1, step: 0.05 },
  iridescence: { label: 'Iridescence', range: [0, 0.8], max: 1, step: 0.05 },
  specular: { label: 'Wet highlight', range: [0, 0.8], max: 1.5, step: 0.05 },
  pellicle: { label: 'Pellicle ring', range: [0, 0.5], max: 1, step: 0.05 },
  nucleus: { label: 'Nucleus glow', range: [0, 0.6], max: 1.5, step: 0.05 },
  vorticity: { label: 'Vorticity glow', range: [0, 1.5], max: 2, step: 0.05 },
  tonemap: { label: 'Film tonemap', range: [0, 1], max: 1, step: 0.05 },
  grain: { label: 'Sensor grain', range: [0, 1.5], max: 3, step: 0.05 },
  vignette: { label: 'Lens vignette', range: [0, 1.2], max: 2, step: 0.05 },
  speciation: { label: 'Speciation', range: [0.002, 0.012], max: 0.02, step: 0.001 },
  curl: { label: 'Curl flow', range: [0, 1.3], max: 2, step: 0.05 },
  swirl: { label: 'Phase swirl', range: [0, 0.35], max: 1.5, step: 0.01 },
  vortexMu: { label: 'Vortex μ', range: [0, 0.015], max: 0.03, step: 0.001 },
  speed: { label: 'Steps per second', range: [24, 40], max: 60, step: 1 },
};
export const OPTIC_KEYS = Object.keys(DRIFT_RANGES).slice(0, 16) as (keyof DisplaySettings)[];
export const PHYSICS_KEYS = ['speciation', 'curl', 'swirl', 'vortexMu'] as const;

/** The [min, max] drift uses for a key: the viewer's own if set, else the default. */
export const driftRange = (d: DriftSettings, key: string): [number, number] => {
  const r = d.ranges[key] ?? DRIFT_RANGES[key].range;
  return [Math.min(r[0], r[1]), Math.max(r[0], r[1])];
};

export interface MorphoSettings {
  display: DisplaySettings;
  interaction: InteractionSettings;
  physics: PhysicsOverrides;
  /** Screen pixels per grid cell (smaller = more, smaller organisms, more GPU) and steps per second. */
  cellPx: number;
  speed: number;
  drift: DriftSettings;
  /** The most of the GPU's time the world may take (0–1); above it the load guard backs off. */
  budget: number;
  /** The load guard never runs fewer than this fraction of the steps asked for (it lightens the world instead). */
  minSteps: number;
  /** Blend between the last two steps on every display frame, so motion stays fluid at any step rate. */
  smooth: boolean;
}

export const hex = (c: Rgb) => '#' + c.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');
export const fromHex = (h: string): Rgb => {
  const n = parseInt(h.replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

/** Colour palettes: three channel colours, the vacuum and the halo. */
export const PALETTES: { id: string; name: string; colours: [string, string, string]; background: string; halo: string }[] = [
  { id: 'deep', name: 'Deep space', colours: ['#06b6d4', '#ec4899', '#f59e0b'], background: '#030408', halo: '#1e1b4b' },
  { id: 'darkfield', name: 'Darkfield', colours: ['#7dd3fc', '#fda4af', '#fde68a'], background: '#020305', halo: '#172554' },
  { id: 'fluor', name: 'Fluorescence', colours: ['#22c55e', '#ef4444', '#3b82f6'], background: '#010201', halo: '#052e16' },
  { id: 'ember', name: 'Ember', colours: ['#f97316', '#dc2626', '#facc15'], background: '#070302', halo: '#3b0a0a' },
  { id: 'abyss', name: 'Abyss', colours: ['#2dd4bf', '#818cf8', '#a3e635'], background: '#010409', halo: '#0c4a6e' },
  { id: 'ice', name: 'Ice', colours: ['#e0f2fe', '#93c5fd', '#c4b5fd'], background: '#02040a', halo: '#1e293b' },
];

const deep = PALETTES[0];

/** The original look (as saved with Bioluminescent Protozoa), with the smooth filter. */
const CLASSIC: DisplaySettings = {
  colours: deep.colours.map(fromHex) as [Rgb, Rgb, Rgb],
  background: fromHex(deep.background),
  haloColour: fromHex(deep.halo),
  filter: 'bicubic',
  exposure: 1,
  body: 0.75,
  edge: 0.45,
  halo: 0.8,
  haloRadius: 6,
  crests: 0.12,
  relief: 0,
  iridescence: 0,
  specular: 0,
  pellicle: 0,
  nucleus: 0,
  vorticity: 0,
  geneTint: 0.35,
  tonemap: 0,
  grain: 0,
  vignette: 0,
};

/** Optical-microscope look: DIC relief, iridescent membranes, wet highlights, grain, vignette. */
const MICROSCOPE: Partial<DisplaySettings> = {
  exposure: 0.85, body: 0.7, edge: 0.55, halo: 0.75, haloRadius: 6, crests: 0.22, relief: 1, iridescence: 0.45, specular: 0.45,
  pellicle: 0.2, nucleus: 0.3, vorticity: 1, geneTint: 0.4, tonemap: 1, grain: 1, vignette: 1,
};

// A look sets the optics and leaves the palette alone.
const { colours: _c, background: _b, haloColour: _h, ...CLASSIC_OPTICS } = CLASSIC;

export const LOOKS: { id: string; name: string; display: Partial<DisplaySettings> }[] = [
  { id: 'classic', name: 'Classic glow', display: CLASSIC_OPTICS },
  { id: 'microscope', name: 'Microscope', display: MICROSCOPE },
  { id: 'neon', name: 'Neon', display: { body: 0.45, edge: 1.2, halo: 1.1, haloRadius: 8, crests: 0.3, relief: 0, iridescence: 0.2, specular: 0, pellicle: 0.4, nucleus: 0.2, vorticity: 0.5, tonemap: 1, grain: 0, vignette: 0.5 } },
  { id: 'soft', name: 'Soft', display: { body: 0.9, edge: 0.15, halo: 0.5, haloRadius: 10, crests: 0.08, relief: 0.4, iridescence: 0, specular: 0.15, pellicle: 0, nucleus: 0.15, vorticity: 0, tonemap: 1, grain: 0.5, vignette: 0.6 } },
];

export const DEFAULT_SETTINGS: MorphoSettings = {
  display: CLASSIC,
  interaction: { move: 'stir', click: 'seed', strength: 1, radius: 0.6 },
  physics: {},
  cellPx: 3,
  speed: 30,
  drift: { enabled: false, period: 45, look: true, colours: true, physics: true, regimes: true, speed: false, ranges: {} },
  budget: 0.45,
  minSteps: 0.7,
  smooth: true,
};

/** Fills in anything missing (older saves, hand-written URLs) from the defaults. */
export function normalise(s: unknown): MorphoSettings {
  const o = (s && typeof s === 'object' ? s : {}) as Partial<MorphoSettings>;
  const num = (v: unknown, d: number, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  const d = DEFAULT_SETTINGS;
  const disp = { ...d.display, ...(o.display ?? {}) } as DisplaySettings;
  const physics: PhysicsOverrides = {};
  for (const k of ['speciation', 'curl', 'swirl', 'vortexMu'] as const) {
    const v = o.physics?.[k];
    if (typeof v === 'number' && Number.isFinite(v)) physics[k] = v;
  }
  return {
    display: disp,
    interaction: { ...d.interaction, ...(o.interaction ?? {}) },
    physics,
    cellPx: num(o.cellPx, d.cellPx, 1.5, 8),
    speed: num(o.speed, d.speed, 1, 60),
    drift: {
      ...d.drift, ...(o.drift ?? {}), period: num(o.drift?.period, d.drift.period, 5, 600),
      ranges: Object.fromEntries(Object.entries(o.drift?.ranges ?? {}).filter(([k, v]) =>
        k in DRIFT_RANGES && Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === 'number' && Number.isFinite(x)))),
    },
    budget: num(o.budget, d.budget, 0.1, 0.95),
    minSteps: num(o.minSteps, d.minSteps, 0.2, 1),
    smooth: typeof o.smooth === 'boolean' ? o.smooth : d.smooth,
  };
}

const KEY = 'morpho.settings';
export function loadSettings(): MorphoSettings {
  try {
    return normalise(JSON.parse(localStorage.getItem(KEY) ?? 'null'));
  } catch {
    return normalise(null);
  }
}
export function saveSettings(s: MorphoSettings): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private mode */ }
}

/** Settings as a compact URL-safe string (JSON, base64url) for ?s=… and the wallpaper script. */
export function encodeSettings(s: MorphoSettings): string {
  const round = (v: unknown): unknown =>
    typeof v === 'number' ? Math.round(v * 1000) / 1000 : Array.isArray(v) ? v.map(round)
      : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, round(x)])) : v;
  const b64 = btoa(JSON.stringify(round(s)));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
/** Reads a settings code. A pinned regime may follow after a dot ("code.regimeId"); see codeRegime. */
export function decodeSettings(str: string | null): MorphoSettings | null {
  if (!str) return null;
  try {
    return normalise(JSON.parse(atob(str.split('.')[0].replace(/-/g, '+').replace(/_/g, '/'))));
  } catch {
    return null;
  }
}
