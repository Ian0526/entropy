import { fetchServerPool } from '../sim/SimSource';

/**
 * Random numbers for the SmoothLife rain. Fresh values from the server's quantum pool (LfD QRNG)
 * are used first, each exactly once. When they run out before the next batch arrives, an SFC32
 * generator seeded from the last batch fills in, its state re-mixed with every new batch and with
 * timing jitter. The pool is re-read every minute; a batch is only treated as fresh if it changed.
 */
export class QuantumDice {
  private fresh: Uint16Array = new Uint16Array(0);
  private i = 0;
  private lastHash = 0;
  private s = new Uint32Array([0x9e3779b9, 0x243f6a88, 0xb7e15162, 1]);
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Values drawn straight from the quantum pool vs from the seeded generator, for the curious. */
  readonly counts = { quantum: 0, seeded: 0 };
  /** The last raw 32-bit draw that came straight from the quantum pool (shown as a nonce). */
  lastQuantum = 0;

  constructor() {
    const jitter = Math.floor(performance.now() * 1000) >>> 0;
    this.s[3] ^= jitter;
    for (let k = 0; k < 12; k++) this.sfc();
  }

  async start(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), 60_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async refresh(): Promise<void> {
    const snap = await fetchServerPool();
    if (!snap) return;
    let h = 2166136261;
    for (const v of snap.pool) h = Math.imul(h ^ v, 16777619);
    h >>>= 0;
    if (h === this.lastHash) return;
    this.lastHash = h;
    this.fresh = snap.pool;
    this.i = 0;
    // Absorb the batch into the generator so the fallback also descends from quantum bits.
    for (let k = 0; k < snap.pool.length; k += 4) {
      this.s[0] ^= snap.pool[k] | (snap.pool[k + 1] << 16);
      this.s[1] ^= snap.pool[k + 2] | (snap.pool[k + 3] << 16);
      this.sfc();
    }
  }

  private sfc(): number {
    const s = this.s;
    const t = (((s[0] + s[1]) >>> 0) + s[3]) >>> 0;
    s[3] = (s[3] + 1) >>> 0;
    s[0] = s[1] ^ (s[1] >>> 9);
    s[1] = (s[2] + (s[2] << 3)) >>> 0;
    s[2] = ((s[2] << 21) | (s[2] >>> 11)) >>> 0;
    s[2] = (s[2] + t) >>> 0;
    return t;
  }

  /** A number in [0,1). */
  next = (): number => {
    if (this.i + 1 < this.fresh.length) {
      this.counts.quantum++;
      const v = (this.fresh[this.i] << 16) | this.fresh[this.i + 1];
      this.i += 2;
      this.lastQuantum = v >>> 0;
      return (v >>> 0) / 4294967296;
    }
    this.counts.seeded++;
    return this.sfc() / 4294967296;
  };
}
