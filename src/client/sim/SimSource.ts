import type { ClientMsg, InspectResult, SimTelemetry } from '../../engine/protocol';

export type ConnectionStatus = 'connecting' | 'online' | 'offline';

export interface SimSourceEvents {
  onFrame(frame: Uint8Array, width: number, height: number, depth: number, tick: number): void;
  onTelemetry(t: SimTelemetry): void;
  onInspect(id: number, data: InspectResult | null): void;
  onStatus(s: ConnectionStatus): void;
  onNotice(message: string): void;
}

export interface ResyncResult {
  ok: boolean;
  cooldownMs: number;
  reason?: string;
}

export interface SimSource {
  readonly kind: 'cloud' | 'local';
  send(msg: ClientMsg): void;
  /** Current 1024-slot quantum pool (for the HUD visualizer). */
  getPool(): Promise<Uint16Array | null>;
  resync(): Promise<ResyncResult>;
  /** Hand a consumed frame buffer back to its producer for reuse (local mode). */
  recycle(frame: Uint8Array): void;
  dispose(): void;
}

/** Inflate a deflate-raw payload using the native streaming decompressor. */
export async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function fetchServerPool(): Promise<{ pool: Uint16Array; telemetry: SimTelemetry['entropy'] } | null> {
  try {
    const res = await fetch('/api/quantum/pool', { cache: 'no-store' });
    if (!res.ok) return null;
    const json = (await res.json()) as { pool: number[]; telemetry: SimTelemetry['entropy'] };
    if (!Array.isArray(json.pool) || json.pool.length === 0) return null;
    return { pool: Uint16Array.from(json.pool), telemetry: json.telemetry };
  } catch {
    return null;
  }
}
