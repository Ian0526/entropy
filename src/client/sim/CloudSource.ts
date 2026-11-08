/**
 * Shared Cloud Universe: authoritative simulation on the Railway vCPU, streamed as
 * deflate-raw keyframes + XOR deltas over a binary WebSocket.
 */
import { FRAME_DELTA, FRAME_HEADER_BYTES, FRAME_KEY, readFrameHeader, type ClientMsg, type ServerMsg } from '../../engine/protocol';
import { fetchServerPool, inflateRaw, type ResyncResult, type SimSource, type SimSourceEvents } from './SimSource';

export class CloudSource implements SimSource {
  readonly kind = 'cloud' as const;
  private ws: WebSocket | null = null;
  private frame: Uint8Array | null = null;
  private lastSeq = -1;
  private chain: Promise<void> = Promise.resolve();
  private backoff = 500;
  private disposed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private outbox: string[] = [];
  private keyRequestedAt = 0;

  constructor(private readonly ev: SimSourceEvents) {
    this.connect();
  }

  private connect(): void {
    if (this.disposed) return;
    this.ev.onStatus('connecting');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 500;
      this.lastSeq = -1;
      this.frame = null;
      this.ev.onStatus('online');
      for (const m of this.outbox.splice(0)) ws.send(m);
    };
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') this.onJson(e.data);
      else {
        const buf = e.data as ArrayBuffer;
        // Decode strictly in arrival order: deltas depend on their predecessor.
        this.chain = this.chain.then(() => this.onBinary(buf)).catch(() => this.requestKey());
      }
    };
    ws.onclose = () => {
      if (this.disposed) return;
      this.ev.onStatus('offline');
      this.reconnectTimer = setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(10_000, this.backoff * 2);
    };
    ws.onerror = () => ws.close();
  }

  private onJson(raw: string): void {
    let m: ServerMsg;
    try {
      m = JSON.parse(raw) as ServerMsg;
    } catch {
      return;
    }
    if (m.type === 'telemetry') this.ev.onTelemetry(m.data);
    else if (m.type === 'inspect') this.ev.onInspect(m.id, m.data);
    else if (m.type === 'error') this.ev.onNotice(m.message);
  }

  private requestKey(): void {
    const now = performance.now();
    if (now - this.keyRequestedAt < 500) return;
    this.keyRequestedAt = now;
    this.send({ type: 'needKey' });
  }

  private async onBinary(buf: ArrayBuffer): Promise<void> {
    const h = readFrameHeader(buf);
    if (!h) return;
    const payload = new Uint8Array(buf, FRAME_HEADER_BYTES);
    const expected = h.width * h.height * h.layers;
    if (h.kind === FRAME_KEY) {
      const data = await inflateRaw(payload);
      if (data.length !== expected) return this.requestKey();
      this.frame = data;
      this.lastSeq = h.seq;
    } else if (h.kind === FRAME_DELTA) {
      if (!this.frame || this.frame.length !== expected || h.seq !== ((this.lastSeq + 1) >>> 0)) {
        this.requestKey();
        return;
      }
      const delta = await inflateRaw(payload);
      if (delta.length !== expected) return this.requestKey();
      const f = this.frame;
      // XOR-apply 4 bytes at a time when aligned.
      if ((f.byteOffset & 3) === 0 && (delta.byteOffset & 3) === 0 && (expected & 3) === 0) {
        const a = new Uint32Array(f.buffer, f.byteOffset, expected >> 2);
        const b = new Uint32Array(delta.buffer, delta.byteOffset, expected >> 2);
        for (let i = 0; i < a.length; i++) a[i] ^= b[i];
      } else {
        for (let i = 0; i < expected; i++) f[i] ^= delta[i];
      }
      this.lastSeq = h.seq;
    } else {
      return;
    }
    this.ev.onFrame(this.frame, h.width, h.height, h.tick);
  }

  send(msg: ClientMsg): void {
    const s = JSON.stringify(msg);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(s);
    else if (msg.type !== 'tool' && this.outbox.length < 16) this.outbox.push(s);
  }

  async getPool(): Promise<Uint16Array | null> {
    return (await fetchServerPool())?.pool ?? null;
  }

  async resync(): Promise<ResyncResult> {
    try {
      const res = await fetch('/api/quantum/resync', { method: 'POST' });
      return (await res.json()) as ResyncResult;
    } catch {
      return { ok: false, cooldownMs: 5000, reason: 'network' };
    }
  }

  recycle(): void {
    // The cloud frame is decoded in place; nothing to hand back.
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }
}
