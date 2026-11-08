/**
 * Local Sandbox Mode: offloads the simulation to a browser WebWorker whose
 * QuantumEntropyEngine is seeded from the server's latest ANU pool snapshot.
 */
import { DEFAULT_PARAMS, type ClientMsg, type SimParams, type WorldId } from '../../engine/protocol';
import { fetchServerPool, type ResyncResult, type SimSource, type SimSourceEvents } from './SimSource';
import type { LocalInbound, LocalOutbound } from './localWorker';

const LOCAL_RESYNC_COOLDOWN_MS = 15_000;

export class LocalSource implements SimSource {
  readonly kind = 'local' as const;
  private worker: Worker;
  private poolWaiters: ((p: Uint16Array) => void)[] = [];
  private lastResync = 0;

  constructor(private readonly ev: SimSourceEvents, opts: { world?: WorldId; params?: SimParams } = {}) {
    this.worker = new Worker(new URL('./localWorker.ts', import.meta.url), { type: 'module', name: 'turinglife-sandbox' });
    this.worker.onmessage = (e: MessageEvent<LocalOutbound>) => this.onMessage(e.data);
    this.worker.onerror = (e) => ev.onNotice(`Sandbox worker error: ${e.message}`);
    ev.onStatus('connecting');
    void (async () => {
      const snap = await fetchServerPool();
      if (!snap) ev.onNotice('Server quantum pool unavailable — sandbox bootstrapped from local CSPRNG');
      this.post({
        type: 'init',
        world: opts.world ?? '2d',
        // The 3D sandbox is a little smaller than the cloud one so it runs smoothly on phones too.
        width: opts.world === '3d' ? 48 : 256,
        height: opts.world === '3d' ? 48 : 256,
        depth: opts.world === '3d' ? 48 : 1,
        pool: snap?.pool ?? null,
        entropy: snap?.telemetry ?? null,
        params: opts.params ?? DEFAULT_PARAMS,
      });
      ev.onStatus('online');
    })();
  }

  private post(m: LocalInbound, transfer: Transferable[] = []): void {
    this.worker.postMessage(m, transfer);
  }

  private onMessage(m: LocalOutbound): void {
    switch (m.type) {
      case 'frame':
        this.ev.onFrame(new Uint8Array(m.buffer), m.width, m.height, m.depth, m.tick);
        break;
      case 'telemetry':
        this.ev.onTelemetry(m.data);
        break;
      case 'inspect':
        this.ev.onInspect(m.id, m.data);
        break;
      case 'pool':
        for (const w of this.poolWaiters.splice(0)) w(m.pool);
        break;
    }
  }

  send(msg: ClientMsg): void {
    this.post({ type: 'client', msg });
  }

  getPool(): Promise<Uint16Array | null> {
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), 2000);
      this.poolWaiters.push((p) => {
        clearTimeout(t);
        resolve(p);
      });
      this.post({ type: 'getPool' });
    });
  }

  async resync(): Promise<ResyncResult> {
    const wait = this.lastResync + LOCAL_RESYNC_COOLDOWN_MS - Date.now();
    if (wait > 0) return { ok: false, cooldownMs: wait, reason: 'cooldown' };
    this.lastResync = Date.now();
    const snap = await fetchServerPool();
    if (!snap) return { ok: false, cooldownMs: LOCAL_RESYNC_COOLDOWN_MS, reason: 'server-unreachable' };
    this.post({ type: 'seedPool', pool: snap.pool, entropy: snap.telemetry });
    return { ok: true, cooldownMs: LOCAL_RESYNC_COOLDOWN_MS };
  }

  recycle(frame: Uint8Array): void {
    const buf = frame.buffer as ArrayBuffer;
    if (buf.byteLength > 0) this.post({ type: 'recycle', buffer: buf }, [buf]);
  }

  dispose(): void {
    this.worker.terminate();
  }
}
