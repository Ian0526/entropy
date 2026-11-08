/**
 * Wire protocol shared by the Node server, the simulation workers and the browser.
 *
 * Binary frame packet (WebSocket binary message / worker transfer):
 *   offset size  field
 *   0      1     magic  0x54 ('T')
 *   1      1     kind   1 = keyframe (deflate-raw), 2 = XOR delta (deflate-raw), 3 = raw (uncompressed)
 *   2      2     width  (LE)
 *   4      2     height (LE)
 *   6      1     layer count
 *   7      1     flags  (bit0 = running)
 *   8      4     sequence number (LE)
 *   12     4     simulation tick (LE)
 *   16     …     payload: `layers` planar W×H Uint8 planes (compressed for kinds 1 & 2)
 */
import type { EntropyTelemetry } from './QuantumEntropy';
import type { DecodedGenome } from './Genome';

export const FRAME_MAGIC = 0x54;
export const FRAME_KEY = 1;
export const FRAME_DELTA = 2;
export const FRAME_RAW = 3;
export const FRAME_HEADER_BYTES = 16;

/** Planar layers, each W×H bytes. */
export const LAYER = {
  STATE: 0, //    bits0-1 somatic, bit2 terrain wall, bit3 epi:damaged, bit4 epi:starving, bit5 just-born
  ENERGY: 1, //   E × 255
  FOOD: 2, //     F × 255
  SIGNAL_A: 3, // nutrient/sensory channel
  SIGNAL_B: 4, // alarm/damage channel
  FLUX: 5, //     128 + metabolic flux (signed)
  HUE: 6, //      lineage hue (from kin hash)
  DISTANCE: 7, // phylogenetic Hamming distance from seed ancestor × 4
} as const;
export const LAYER_COUNT = 8;

export interface FrameHeader {
  kind: number;
  width: number;
  height: number;
  layers: number;
  running: boolean;
  seq: number;
  tick: number;
}

export function writeFrameHeader(dv: DataView, h: FrameHeader): void {
  dv.setUint8(0, FRAME_MAGIC);
  dv.setUint8(1, h.kind);
  dv.setUint16(2, h.width, true);
  dv.setUint16(4, h.height, true);
  dv.setUint8(6, h.layers);
  dv.setUint8(7, h.running ? 1 : 0);
  dv.setUint32(8, h.seq >>> 0, true);
  dv.setUint32(12, h.tick >>> 0, true);
}

export function readFrameHeader(buf: ArrayBuffer): FrameHeader | null {
  if (buf.byteLength < FRAME_HEADER_BYTES) return null;
  const dv = new DataView(buf);
  if (dv.getUint8(0) !== FRAME_MAGIC) return null;
  return {
    kind: dv.getUint8(1),
    width: dv.getUint16(2, true),
    height: dv.getUint16(4, true),
    layers: dv.getUint8(6),
    running: (dv.getUint8(7) & 1) === 1,
    seq: dv.getUint32(8, true),
    tick: dv.getUint32(12, true),
  };
}

// -----------------------------------------------------------------------------

export interface SimParams {
  /** Multiplier on per-type maintenance cost. */
  metabolicDecay: number;
  /** μ — per-division mutation probability (geometric bit-flip chain + Gaussian field nudge). */
  mutationRate: number;
  /** Signal diffusion sub-steps per tick (physical growth is 1 cell/tick). */
  signalSpeed: number;
  /** 0 = lush, 1 = famine. */
  foodScarcity: number;
  /** Poisson clock rate λ: probability a cell acts in a tick is 1 − e^(−λ). */
  phaseRate: number;
}

export const DEFAULT_PARAMS: SimParams = {
  metabolicDecay: 1,
  mutationRate: 0.03,
  signalSpeed: 4,
  foodScarcity: 0.35,
  phaseRate: 2.0,
};

export const PARAM_LIMITS: Record<keyof SimParams, [number, number]> = {
  metabolicDecay: [0.1, 4],
  mutationRate: [0, 0.5],
  signalSpeed: [1, 8],
  foodScarcity: [0, 1],
  phaseRate: [0.1, 6],
};

export function sanitizeParams(p: Partial<SimParams>, base: SimParams = DEFAULT_PARAMS): SimParams {
  const out: SimParams = { ...base };
  for (const k of Object.keys(PARAM_LIMITS) as (keyof SimParams)[]) {
    const v = p[k];
    if (typeof v === 'number' && Number.isFinite(v)) {
      const [lo, hi] = PARAM_LIMITS[k];
      out[k] = Math.min(hi, Math.max(lo, v));
    }
  }
  out.signalSpeed = Math.round(out.signalSpeed);
  return out;
}

export type ToolKind = 'inspect' | 'poke' | 'mutagen' | 'wall' | 'erase' | 'food' | 'predator';
export type SpeedMode = '1x' | '5x' | 'max';
export const SPEED_TPS: Record<SpeedMode, number> = { '1x': 15, '5x': 75, max: Infinity };

export interface SpeciesStat {
  kin: number;
  count: number;
  hue: number;
}

export interface SimStats {
  tick: number;
  population: number;
  core: number;
  armor: number;
  sensor: number;
  births: number;
  deaths: number;
  predations: number;
  species: number;
  meanEnergy: number;
  totalFood: number;
  meanDistance: number;
  topSpecies: SpeciesStat[];
}

export interface SimTelemetry extends SimStats {
  source: 'cloud' | 'local';
  width: number;
  height: number;
  tps: number;
  tickMs: number;
  running: boolean;
  speed: SpeedMode;
  params: SimParams;
  entropy: EntropyTelemetry;
  jumpTrail: number[];
  clients: number;
  serverTime: number;
}

export interface ClusterStats {
  size: number;
  core: number;
  armor: number;
  sensor: number;
  meanEnergy: number;
  totalEnergy: number;
  bbox: [number, number, number, number];
  truncated: boolean;
}

export interface InspectResult {
  x: number;
  y: number;
  alive: boolean;
  wall: boolean;
  somatic: number;
  energy: number;
  food: number;
  signalA: number;
  signalB: number;
  flux: number;
  age: number;
  epigenetic: { damaged: boolean; starving: boolean; raw: number };
  genome: DecodedGenome | null;
  ancestorDistance: number;
  relationToAncestor: 'self' | 'kin' | 'foreign';
  cluster: ClusterStats | null;
}

/** Client → server/worker control messages (JSON). */
export type ClientMsg =
  | { type: 'tool'; tool: ToolKind; x: number; y: number; radius: number; strength: number }
  | { type: 'params'; params: Partial<SimParams> }
  | { type: 'control'; running?: boolean; speed?: SpeedMode }
  | { type: 'inspect'; id: number; x: number; y: number }
  | { type: 'reset' }
  | { type: 'resync' }
  | { type: 'needKey' };

/** Server/worker → client JSON messages. */
export type ServerMsg =
  | { type: 'telemetry'; data: SimTelemetry }
  | { type: 'inspect'; id: number; data: InspectResult | null }
  | { type: 'resync'; ok: boolean; cooldownMs: number; reason?: string }
  | { type: 'hello'; width: number; height: number; layers: number }
  | { type: 'error'; message: string };
