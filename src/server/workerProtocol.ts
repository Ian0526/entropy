import type { ClientMsg, InspectResult, SimTelemetry, SpeedMode } from '../engine/protocol';

/** Speed mode ↔ Int32 code stored in the shared grid header (HDR.SPEED). */
export const SPEED_CODES: Record<SpeedMode, number> = { '1x': 0, '5x': 1, max: 2 };

export type WorkerInbound =
  | { type: 'client'; msg: ClientMsg }
  | { type: 'inspect'; ticket: number; x: number; y: number; z: number }
  | { type: 'needKey' }
  /** How many clients watch this world; with none, frames aren't packed or compressed. */
  | { type: 'viewers'; n: number };

export type WorkerOutbound =
  | { type: 'ready'; width: number; height: number; depth: number }
  | { type: 'frame'; seq: number; key: boolean; buffer: ArrayBuffer }
  | { type: 'telemetry'; data: SimTelemetry }
  | { type: 'inspect'; ticket: number; data: InspectResult };
