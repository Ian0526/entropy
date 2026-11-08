/**
 * QuantumEntropyEngine
 * ---------------------------------------------------------------------------
 * Hybrid entropy pool: a 1024-slot Uint16 ring of genuine quantum vacuum
 * fluctuation samples (ANU QRNG), consumed sequentially while fresh, then
 * re-used through a Nonce-Wrapped Index Jumper with anti-cycle protection
 * that continuously perturbs a 128-bit SFC32 chaotic PRNG.
 *
 * The pool + control words live in a SharedArrayBuffer so that one instance
 * (the HTTP/cron main thread) can harvest from ANU while another instance
 * attached to the same memory (the simulation worker) draws numbers with
 * zero copies and zero heap allocation on the hot path.
 *
 * Isomorphic: runs under Node (worker_threads) and in browsers (WebWorker).
 */

export const POOL_SIZE = 1024; // power of two → modulo is `& POOL_MASK`
export const POOL_MASK = POOL_SIZE - 1;

/** Odd Weyl stride: gcd(953, 1024) = 1, so weylIdx visits every slot once per 1024 steps. */
const WEYL_STRIDE = 953;
/** Re-stir the SFC32 state from the pool every 4096 draws (in addition to once per tick). */
const STIR_MASK = 4095;

// --- SharedArrayBuffer layout ----------------------------------------------
const POOL_BYTES = POOL_SIZE * 2; //  2048 B : Uint16 pool
const CTL_WORDS = 16; //                64 B : Int32 control / telemetry
const F64_WORDS = 4; //                 32 B : Float64 timestamps
const CTL_OFFSET = POOL_BYTES;
const F64_OFFSET = CTL_OFFSET + CTL_WORDS * 4;
export const ENTROPY_SAB_BYTES = F64_OFFSET + F64_WORDS * 8;

/** Int32 control-word indices (all accessed through Atomics). */
export const CTL = {
  FRESH: 0, //         unconsumed fresh quantum values in the current batch
  GENERATION: 1, //    incremented by the harvester each time a new batch lands
  MODE: 2, //          1 = LIVE_QUANTUM, 0 = NONCE_WRAP_SPONGE
  JUMP_IDX: 3,
  NONCE: 4,
  WRAPS: 5,
  WEYL_IDX: 6,
  FETCH_OK: 7,
  FETCH_FAIL: 8,
  ANTI_CYCLE: 9, //    times the anti-recursion guard fired
  BACKOFF_LEVEL: 10,
  LAST_HTTP: 11, //    last HTTP status (0 = network error / timeout, -1 = parse error)
  ORIGIN: 12, //       0 = CSPRNG bootstrap, 1 = hardware QRNG, 2 = seeded snapshot, 3 = provider simulator
  CURSOR: 13, //       (reserved)
  BATCH_START: 14, //  pool index where the latest fresh batch begins
  SIMULATED: 15, //    1 while the fresh batch came from a provider's software simulator
} as const;

const F64 = { LAST_FETCH: 0, NEXT_FETCH: 1, LAST_ATTEMPT: 2, RESYNC_AT: 3 } as const;

/** setTimeout overflows above 2^31-1 ms (~24.8 days). */
const MAX_TIMER_MS = 2_147_000_000;
const MONTH_MS = 30 * 24 * 3600_000;

export type EntropyMode = 'LIVE_QUANTUM' | 'LIVE_SIMULATED' | 'NONCE_WRAP_SPONGE';
export type EntropyOrigin = 'CSPRNG_BOOTSTRAP' | 'QRNG' | 'QRNG_SIMULATOR' | 'SERVER_SNAPSHOT';

export interface HarvesterInfo {
  provider: string; //          e.g. "qrngapi.com", "none"
  lastSource: string; //        upstream-reported source of the last batch ("photon", "simulator", …)
  lastError: string; //         human-readable reason the last attempt did not ingest, '' if it did
  hardwareOnline: boolean | null; // from the provider's free precheck, null if unknown
  budgetUsed: number; //        requests spent this calendar month (UTC)
  budgetTotal: number | null; // monthly request allowance, null = unmetered
  budgetResetAt: number; //     epoch ms of the next monthly reset
  acceptSimulator: boolean;
}

export interface EntropyTelemetry extends HarvesterInfo {
  mode: EntropyMode;
  origin: EntropyOrigin;
  lastFetchTime: number;
  nextFetchTime: number;
  lastAttemptTime: number;
  resyncAvailableAt: number;
  totalWraps: number;
  jumpIdx: number;
  weylIdx: number;
  nonce: number;
  freshRemaining: number;
  fetchOk: number;
  fetchFail: number;
  antiCycleEvents: number;
  lastHttpStatus: number;
  backoffLevel: number;
}

export interface HarvesterOptions {
  /** Upstream provider. Defaults to ANU (AQN if `apiKey` is set, else the legacy endpoint). */
  provider?: QrngProvider | null;
  /** Base cron interval. Default: spread the monthly budget evenly (≥ provider min spacing). */
  intervalMs?: number;
  /** Minimum spacing between any two requests, including manual resyncs. */
  cooldownMs?: number;
  /** Cap for exponential backoff. */
  maxBackoffMs?: number;
  timeoutMs?: number;
  /** Monthly request allowance; defaults to the provider's free tier. */
  monthlyRequests?: number;
  /** Ingest batches the provider labels as simulator output (shown as LIVE_SIMULATED, never as quantum). */
  acceptSimulator?: boolean;
  /** Legacy shorthand: ANU AQN key (used when `provider` is omitted). */
  apiKey?: string;
  /** Legacy shorthand: override the QRNG@ANU legacy endpoint (used when `provider` is omitted). */
  legacyUrl?: string;
  log?: (msg: string) => void;
}

import { anuAqnProvider, anuLegacyProvider, type QrngProvider } from './QrngProviders';

const rotl = (x: number, k: number): number => ((x << k) | (x >>> (32 - k))) >>> 0;

/** Sub-microsecond timing jitter source, chosen once (no per-call branching on platform). */
function makeJitterSource(): () => number {
  const proc = (globalThis as { process?: { hrtime?: { bigint?: () => bigint } } }).process;
  if (proc?.hrtime?.bigint) {
    const hr = proc.hrtime.bigint.bind(proc.hrtime);
    return () => Number(hr() & 0xffffn);
  }
  if (typeof performance !== 'undefined') {
    // performance.now() has µs-ish resolution (coarsened in browsers); take fractional bits.
    return () => ((performance.now() * 1048576) >>> 0) & 0xffff;
  }
  return () => Date.now() & 0xffff;
}

function fillCrypto(target: Uint16Array): void {
  // getRandomValues refuses SharedArrayBuffer-backed views, so fill a private buffer then copy.
  const tmp = new Uint16Array(target.length);
  globalThis.crypto.getRandomValues(tmp);
  target.set(tmp);
}

export class QuantumEntropyEngine {
  readonly POOL_SIZE = POOL_SIZE;
  readonly POOL_MASK = POOL_MASK;
  readonly sab: SharedArrayBuffer | ArrayBuffer;
  readonly pool: Uint16Array;
  private readonly ctl: Int32Array;
  private readonly f64: Float64Array;
  private readonly jitter = makeJitterSource();

  // Consumer-local pointers (mirrored into ctl for telemetry).
  private jumpIdx = 0;
  private prevIdx = -1;
  private weylIdx = 0;
  private nonce = 0;
  private totalWraps = 0;
  private antiCycle = 0;
  private cursor = 0;
  private seenGeneration = 0;
  private draws = 0;

  // 128-bit SFC32 chaotic state (four 32-bit unsigned registers).
  private s0 = 0x9e3779b9;
  private s1 = 0x243f6a88;
  private s2 = 0xb7e15162;
  private s3 = 1;

  // Box–Muller spare.
  private gaussSpare = 0;
  private hasGaussSpare = false;

  // Harvester (main-thread only) state.
  private cronTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;
  private provider: QrngProvider | null = anuLegacyProvider();
  private intervalOverride: number | null = null;
  private cooldownOverride: number | null = null;
  private monthlyOverride: number | null = null;
  private maxBackoffMs = 30 * 60_000;
  private timeoutMs = 8_000;
  private acceptSimulator = false;
  private log: ((m: string) => void) | undefined;
  private writeOffset = 0;
  private budgetMonth = '';
  private budgetUsed = 0;
  private haltedUntil = 0; // auth failure / quota exhaustion pause
  private info: Pick<HarvesterInfo, 'lastSource' | 'lastError' | 'hardwareOnline'> = {
    lastSource: '',
    lastError: '',
    hardwareOnline: null,
  };

  /**
   * @param shared  Existing buffer to attach to (worker side). Omit to create a new one.
   * @param bootstrap  When creating, fill the pool from the platform CSPRNG until ANU answers.
   */
  constructor(shared?: SharedArrayBuffer | ArrayBuffer, bootstrap = true) {
    const owner = !shared;
    this.sab = shared ?? (typeof SharedArrayBuffer !== 'undefined'
      ? new SharedArrayBuffer(ENTROPY_SAB_BYTES)
      : new ArrayBuffer(ENTROPY_SAB_BYTES));
    this.pool = new Uint16Array(this.sab, 0, POOL_SIZE);
    this.ctl = new Int32Array(this.sab, CTL_OFFSET, CTL_WORDS);
    this.f64 = new Float64Array(this.sab, F64_OFFSET, F64_WORDS);

    if (owner && bootstrap) {
      fillCrypto(this.pool);
      Atomics.store(this.ctl, CTL.ORIGIN, 0);
    }
    this.seenGeneration = Atomics.load(this.ctl, CTL.GENERATION);
    // Distinct consumers attached to the same pool must not produce identical streams.
    this.s2 = (this.s2 ^ this.jitter() ^ (Date.now() >>> 0)) >>> 0;
    this.absorbQuantumSeed();
  }

  // ===========================================================================
  // Consumption side (hot path, zero allocation)
  // ===========================================================================

  /** Raw SFC32 round. No re-seed checks, so it is safe to call from absorb(). */
  private step(): number {
    const t = (((this.s0 + this.s1) >>> 0) + this.s3) >>> 0;
    this.s3 = (this.s3 + 1) >>> 0;
    this.s0 = (this.s1 ^ (this.s1 >>> 9)) >>> 0;
    this.s1 = (this.s2 + (this.s2 << 3)) >>> 0;
    this.s2 = ((this.s2 << 21) | (this.s2 >>> 11)) >>> 0;
    this.s2 = (this.s2 + t) >>> 0;
    return t;
  }

  /** XOR/add a 32-bit impulse into all four registers, then diffuse. */
  private mix(impulse: number): void {
    const j = this.jitter();
    const seed = (impulse ^ rotl(this.nonce, 7) ^ j) >>> 0;
    this.s0 = (this.s0 ^ seed) >>> 0;
    this.s1 = (this.s1 + Math.imul(seed, 0x85ebca6b)) >>> 0;
    this.s2 = (this.s2 ^ rotl(Math.imul(seed ^ (seed >>> 16), 0xc2b2ae35) >>> 0, 13)) >>> 0;
    // s3 is the SFC counter; perturb it with an odd value so the counter never stalls.
    this.s3 = (this.s3 + ((seed << 1) | 1)) >>> 0;
    // Warm-up rounds diffuse single-bit quantum differences across all 128 bits.
    this.step();
    this.step();
    this.step();
    this.step();
  }

  /**
   * Nonce-Wrapped Index Jumper with anti-cycle protection.
   * Returns a 32-bit impulse built from two pool reads, the Weyl pointer and the nonce.
   */
  private nonceWrappedJump(): number {
    const L = POOL_SIZE;
    const j = this.jumpIdx;
    const val = this.pool[j];

    // Data-driven jump; the nonce epoch (nonce >>> 10) shifts the whole functional
    // graph every 1024 absorbs so long-period rho-cycles in a static pool cannot persist.
    const raw = j + val + (this.nonce >>> 10);
    let next = raw & POOL_MASK;
    if (raw >= L) this.totalWraps = (this.totalWraps + 1) >>> 0;

    // Anti-recursion guard: self-loop (val ≡ 0 mod L) or 2-step oscillation.
    if (next === j || next === this.prevIdx) {
      // Odd stride is co-prime with L = 2^10, so (j + stride) mod L ≠ j.
      next = (j + ((val + this.nonce) | 1)) & POOL_MASK;
      // `+ 1 + (nonce & 1)` nudges until we also avoid the previous index (≤ 3 iterations).
      while (next === j || next === this.prevIdx) next = (next + 1 + (this.nonce & 1)) & POOL_MASK;
      this.antiCycle = (this.antiCycle + 1) >>> 0;
    }

    this.prevIdx = j;
    this.jumpIdx = next;
    this.weylIdx = (this.weylIdx + WEYL_STRIDE) & POOL_MASK;

    const landed = this.pool[next];
    const weyl = this.pool[this.weylIdx];
    return (((val << 16) | landed) ^ rotl(weyl, (this.nonce & 15) + 8) ^ this.nonce) >>> 0;
  }

  /**
   * Inject quantum indeterminism into the SFC32 state. Call once per simulation tick.
   * While a fresh ANU batch is unconsumed, values are taken sequentially (one per call).
   * Once exhausted (or never delivered because of rate limiting), the nonce-wrapped
   * jumper re-uses the pool without ever locking into a static loop.
   */
  absorbQuantumSeed(): void {
    this.nonce = (this.nonce + 1) >>> 0;

    const gen = Atomics.load(this.ctl, CTL.GENERATION);
    if (gen !== this.seenGeneration) {
      this.seenGeneration = gen;
      // New batch landed: consume it sequentially from where the harvester wrote it.
      this.cursor = Atomics.load(this.ctl, CTL.BATCH_START) & POOL_MASK;
    }

    let impulse: number;
    let fresh = Atomics.load(this.ctl, CTL.FRESH);
    // Claim one fresh value with CAS so concurrent consumers never double-spend.
    while (fresh > 0) {
      const prev = Atomics.compareExchange(this.ctl, CTL.FRESH, fresh, fresh - 1);
      if (prev === fresh) break;
      fresh = prev;
    }

    if (fresh > 0) {
      const v = this.pool[this.cursor];
      this.cursor = (this.cursor + 1) & POOL_MASK;
      // Keep the jumper moving too so the fallback starts from a fresh quantum-derived position.
      this.jumpIdx = (this.jumpIdx ^ v) & POOL_MASK;
      impulse = ((v << 16) | this.pool[this.jumpIdx]) ^ this.nonce;
      Atomics.store(this.ctl, CTL.MODE, fresh - 1 > 0 ? 1 : 0);
    } else {
      impulse = this.nonceWrappedJump();
      Atomics.store(this.ctl, CTL.MODE, 0);
    }

    this.mix(impulse);
    this.publish();
  }

  /** Cheap intra-tick stir: nonce-wrapped jump only, never consumes fresh values. */
  private stir(): void {
    this.nonce = (this.nonce + 1) >>> 0;
    this.mix(this.nonceWrappedJump());
  }

  private publish(): void {
    const c = this.ctl;
    Atomics.store(c, CTL.JUMP_IDX, this.jumpIdx);
    Atomics.store(c, CTL.WEYL_IDX, this.weylIdx);
    Atomics.store(c, CTL.NONCE, this.nonce | 0);
    Atomics.store(c, CTL.WRAPS, this.totalWraps | 0);
    Atomics.store(c, CTL.ANTI_CYCLE, this.antiCycle | 0);
  }

  /** 32-bit unsigned draw. */
  nextUint32(): number {
    this.draws = (this.draws + 1) | 0;
    if ((this.draws & STIR_MASK) === 0) this.stir();
    return this.step();
  }

  /** Uniform float in [0, 1). */
  nextFloat(): number {
    return this.nextUint32() / 4294967296;
  }

  /** Uniform integer in [0, n) for n ≤ 2^32 (multiply-shift, bias < 2^-32·n). */
  nextInt(n: number): number {
    return Math.floor(this.nextFloat() * n);
  }

  /** Standard normal via Box–Muller with cached spare. */
  nextGaussian(): number {
    if (this.hasGaussSpare) {
      this.hasGaussSpare = false;
      return this.gaussSpare;
    }
    let u = this.nextFloat();
    if (u < 1e-12) u = 1e-12;
    const v = this.nextFloat();
    const r = Math.sqrt(-2 * Math.log(u));
    const th = 2 * Math.PI * v;
    this.gaussSpare = r * Math.sin(th);
    this.hasGaussSpare = true;
    return r * Math.cos(th);
  }

  /** Current jump pointer (for the frontend visualizer). */
  get currentJumpIdx(): number {
    return this.jumpIdx;
  }

  // ===========================================================================
  // Harvest side (main thread / cron)
  // ===========================================================================

  configureHarvester(o: HarvesterOptions): void {
    if (o.log) this.log = o.log;
    if (o.timeoutMs !== undefined) this.timeoutMs = o.timeoutMs;
    if (o.maxBackoffMs !== undefined) this.maxBackoffMs = o.maxBackoffMs;
    if (o.intervalMs !== undefined) this.intervalOverride = o.intervalMs;
    if (o.cooldownMs !== undefined) this.cooldownOverride = o.cooldownMs;
    if (o.monthlyRequests !== undefined) this.monthlyOverride = o.monthlyRequests;
    if (o.acceptSimulator !== undefined) this.acceptSimulator = o.acceptSimulator;
    if (o.provider !== undefined) this.provider = o.provider;
    else if (o.apiKey) this.provider = anuAqnProvider({ apiKey: o.apiKey });
    else if (o.legacyUrl) this.provider = anuLegacyProvider({ url: o.legacyUrl });
  }

  /**
   * Write a batch of samples at `offset` (wrapping) and announce it to all attached consumers.
   * origin: 1 = hardware QRNG, 2 = server snapshot, 3 = provider simulator.
   */
  ingest(values: ArrayLike<number>, origin: 1 | 2 | 3 = 1, offset = 0): void {
    const n = Math.min(POOL_SIZE, values.length);
    for (let i = 0; i < n; i++) this.pool[(offset + i) & POOL_MASK] = values[i] & 0xffff;
    Atomics.store(this.ctl, CTL.ORIGIN, origin);
    Atomics.store(this.ctl, CTL.SIMULATED, origin === 3 ? 1 : 0);
    Atomics.store(this.ctl, CTL.BATCH_START, offset & POOL_MASK);
    Atomics.store(this.ctl, CTL.FRESH, n);
    Atomics.store(this.ctl, CTL.MODE, n > 0 ? 1 : 0);
    Atomics.add(this.ctl, CTL.GENERATION, 1);
  }

  /** Overwrite the pool without announcing fresh values (stays in sponge mode). */
  loadPool(values: ArrayLike<number>): void {
    const n = Math.min(POOL_SIZE, values.length);
    for (let i = 0; i < n; i++) this.pool[i] = values[i] & 0xffff;
  }

  /** Copy of the current pool (2 KiB) — used to seed client-side sandboxes. */
  snapshot(): Uint16Array {
    return this.pool.slice();
  }

  // ---- budget & scheduling -----------------------------------------------------

  private monthlyBudget(): number {
    if (!this.provider) return 0;
    return this.monthlyOverride ?? this.provider.defaultMonthlyRequests;
  }

  private static monthKey(t: number): string {
    const d = new Date(t);
    return `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
  }

  private static nextMonthStart(t: number): number {
    const d = new Date(t);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  }

  private rollBudget(now: number): void {
    const k = QuantumEntropyEngine.monthKey(now);
    if (k !== this.budgetMonth) {
      this.budgetMonth = k;
      this.budgetUsed = 0;
      if (this.haltedUntil && this.haltedUntil <= now) this.haltedUntil = 0;
    }
  }

  private budgetLeft(now = Date.now()): number {
    this.rollBudget(now);
    return this.monthlyBudget() - this.budgetUsed;
  }

  /** Base interval: spread the monthly allowance evenly, never faster than the provider allows. */
  baseIntervalMs(): number {
    if (this.intervalOverride !== null) return this.intervalOverride;
    if (!this.provider) return MONTH_MS;
    const budget = this.monthlyBudget();
    const spread = Number.isFinite(budget) && budget > 0 ? MONTH_MS / budget : 60_000;
    return Math.max(this.provider.minSpacingMs, spread);
  }

  private cooldownMs(): number {
    if (this.cooldownOverride !== null) return this.cooldownOverride;
    return Math.max(60_000, this.provider?.minSpacingMs ?? 60_000);
  }

  // ---- fetching --------------------------------------------------------------

  /** Back-compat alias used by tests and older call sites. */
  fetchFromANU(): Promise<boolean> {
    return this.fetchBatch();
  }

  /**
   * One harvest attempt. Never throws. Returns true only if a batch was ingested.
   * Spends budget only when an entropy request is actually sent.
   */
  async fetchBatch(): Promise<boolean> {
    const p = this.provider;
    if (!p || this.inFlight) return false;
    const now = Date.now();
    if (this.haltedUntil > now) {
      this.info.lastError ||= 'harvester halted';
      return false;
    }
    if (this.budgetLeft(now) <= 0) {
      this.info.lastError = `monthly budget used (${this.budgetUsed}/${this.monthlyBudget()} requests)`;
      return false;
    }
    this.inFlight = true;
    this.f64[F64.LAST_ATTEMPT] = now;
    this.f64[F64.RESYNC_AT] = now + this.cooldownMs();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const fail = (status: number, msg: string) => {
      Atomics.store(this.ctl, CTL.LAST_HTTP, status);
      Atomics.add(this.ctl, CTL.FETCH_FAIL, 1);
      Atomics.add(this.ctl, CTL.BACKOFF_LEVEL, 1);
      this.info.lastError = msg;
      this.log?.(`[quantum] ${p.label}: ${msg} — nonce-wrap sponge active`);
      return false;
    };
    try {
      // Free precheck: don't spend scarce quota while the provider has no quantum hardware online.
      if (p.precheck && !this.acceptSimulator) {
        const pc = await p.precheck(controller.signal);
        this.info.hardwareOnline = pc.hardwareAvailable;
        if (!pc.hardwareAvailable) {
          Atomics.store(this.ctl, CTL.LAST_HTTP, 200);
          this.info.lastError = `${pc.detail} — quota preserved`;
          this.log?.(`[quantum] ${p.label}: ${pc.detail}; skipping request (quota preserved)`);
          return false;
        }
      }

      this.budgetUsed++;
      const r = await p.fetch(controller.signal);
      if (!r.ok) {
        if (r.authFailed) {
          this.haltedUntil = Date.now() + 6 * 3600_000;
          return fail(r.status, `API key rejected (${r.error}); retrying in 6h`);
        }
        if (r.quotaExhausted) {
          this.budgetUsed = Math.max(this.budgetUsed, this.monthlyBudget());
          this.haltedUntil = QuantumEntropyEngine.nextMonthStart(Date.now());
          return fail(r.status, `provider quota exhausted (${r.error}); paused until next month`);
        }
        return fail(r.status, r.error);
      }

      this.info.lastSource = r.source;
      if (!r.hardware && !this.acceptSimulator) {
        this.info.hardwareOnline = false;
        Atomics.store(this.ctl, CTL.LAST_HTTP, r.status);
        this.info.lastError = `provider served "${r.source}" (non-quantum) data — rejected`;
        this.log?.(`[quantum] ${p.label}: batch came from "${r.source}", not quantum hardware — rejected`);
        return false;
      }

      // Partial batches (e.g. 512 samples) alternate halves so the whole ring stays fresh over time.
      const offset = r.values.length >= POOL_SIZE ? 0 : this.writeOffset;
      this.ingest(r.values, r.hardware ? 1 : 3, offset);
      this.writeOffset = (offset + r.values.length) & POOL_MASK;
      if (r.hardware) this.info.hardwareOnline = true;
      this.info.lastError = '';
      this.f64[F64.LAST_FETCH] = Date.now();
      Atomics.store(this.ctl, CTL.LAST_HTTP, r.status);
      Atomics.add(this.ctl, CTL.FETCH_OK, 1);
      Atomics.store(this.ctl, CTL.BACKOFF_LEVEL, 0);
      const budget = this.monthlyBudget();
      this.log?.(`[quantum] ${p.label}: ingested ${r.values.length} x uint16 from "${r.source}"`
        + `${r.hardware ? '' : ' (SIMULATED, not quantum)'} [budget ${this.budgetUsed}/${Number.isFinite(budget) ? budget : 'unmetered'}]`);
      return true;
    } catch (err) {
      const aborted = (err as Error).name === 'AbortError';
      return fail(aborted ? 0 : -1, aborted ? `timeout after ${this.timeoutMs} ms` : `network error (${(err as Error).message})`);
    } finally {
      clearTimeout(timeout);
      this.inFlight = false;
    }
  }

  private nextDelay(): number {
    const now = Date.now();
    if (this.haltedUntil > now) return this.haltedUntil - now + 1_000;
    if (this.budgetLeft(now) <= 0) return QuantumEntropyEngine.nextMonthStart(now) - now + 1_000;
    const base = this.baseIntervalMs();
    // No hardware online: re-run the free precheck sooner than the (possibly days-long) interval.
    if (this.info.hardwareOnline === false && !this.acceptSimulator) return Math.min(base, 6 * 3600_000);
    const lvl = Atomics.load(this.ctl, CTL.BACKOFF_LEVEL);
    if (lvl === 0) return base;
    // Exponential backoff from min(base, 60 s), capped at max(maxBackoff, base).
    const jitter = 0.85 + 0.3 * (this.pool[this.jumpIdx] / 65535); // decorrelate retries
    return Math.min(Math.max(this.maxBackoffMs, base), Math.min(base, 60_000) * 2 ** Math.min(lvl, 10) * jitter);
  }

  private schedule(delay: number): void {
    if (this.cronTimer) clearTimeout(this.cronTimer);
    const due = Date.now() + delay;
    this.f64[F64.NEXT_FETCH] = due;
    const arm = (): void => {
      const wait = due - Date.now();
      this.cronTimer = setTimeout(async () => {
        if (Date.now() < due) return arm(); // delays beyond the setTimeout limit are chained
        await this.fetchBatch();
        this.schedule(this.nextDelay());
      }, Math.max(0, Math.min(wait, MAX_TIMER_MS)));
      (this.cronTimer as { unref?: () => void }).unref?.();
    };
    arm();
  }

  /** Start the background cron harvester (first attempt after `initialDelayMs`). */
  startCron(initialDelayMs = 1_500): void {
    if (!this.provider) return;
    this.schedule(initialDelayMs);
  }

  stopCron(): void {
    if (this.cronTimer) clearTimeout(this.cronTimer);
    this.cronTimer = null;
  }

  /** Manual "Force Resync" honoring the shared cooldown and the monthly budget. */
  async forceResync(): Promise<{ ok: boolean; cooldownMs: number; reason?: string }> {
    if (!this.provider) return { ok: false, cooldownMs: 60_000, reason: 'no-provider' };
    const wait = this.f64[F64.RESYNC_AT] - Date.now();
    if (wait > 0) return { ok: false, cooldownMs: wait, reason: 'cooldown' };
    if (this.inFlight) return { ok: false, cooldownMs: this.timeoutMs, reason: 'in-flight' };
    if (this.budgetLeft() <= 0) {
      return { ok: false, cooldownMs: QuantumEntropyEngine.nextMonthStart(Date.now()) - Date.now(), reason: 'budget-exhausted' };
    }
    const ok = await this.fetchBatch();
    if (this.cronTimer) this.schedule(this.nextDelay());
    return { ok, cooldownMs: this.cooldownMs(), reason: ok ? undefined : this.info.lastError || 'upstream-failed' };
  }

  /** Harvester-only fields (strings live on the main thread, not in shared memory). */
  harvesterInfo(): HarvesterInfo {
    const now = Date.now();
    if (this.provider) this.rollBudget(now);
    const budget = this.monthlyBudget();
    return {
      provider: this.provider?.label ?? 'none',
      lastSource: this.info.lastSource,
      lastError: this.info.lastError,
      hardwareOnline: this.info.hardwareOnline,
      budgetUsed: this.budgetUsed,
      budgetTotal: Number.isFinite(budget) ? budget : null,
      budgetResetAt: QuantumEntropyEngine.nextMonthStart(now),
      acceptSimulator: this.acceptSimulator,
    };
  }

  telemetry(): EntropyTelemetry {
    const c = this.ctl;
    const origin = Atomics.load(c, CTL.ORIGIN);
    const fresh = Atomics.load(c, CTL.MODE) === 1 && Atomics.load(c, CTL.FRESH) > 0;
    return {
      ...this.harvesterInfo(),
      mode: !fresh ? 'NONCE_WRAP_SPONGE' : Atomics.load(c, CTL.SIMULATED) === 1 ? 'LIVE_SIMULATED' : 'LIVE_QUANTUM',
      origin: origin === 1 ? 'QRNG' : origin === 2 ? 'SERVER_SNAPSHOT' : origin === 3 ? 'QRNG_SIMULATOR' : 'CSPRNG_BOOTSTRAP',
      lastFetchTime: this.f64[F64.LAST_FETCH],
      nextFetchTime: this.f64[F64.NEXT_FETCH],
      lastAttemptTime: this.f64[F64.LAST_ATTEMPT],
      resyncAvailableAt: this.f64[F64.RESYNC_AT],
      totalWraps: Atomics.load(c, CTL.WRAPS) >>> 0,
      jumpIdx: Atomics.load(c, CTL.JUMP_IDX),
      weylIdx: Atomics.load(c, CTL.WEYL_IDX),
      nonce: Atomics.load(c, CTL.NONCE) >>> 0,
      freshRemaining: Atomics.load(c, CTL.FRESH),
      fetchOk: Atomics.load(c, CTL.FETCH_OK),
      fetchFail: Atomics.load(c, CTL.FETCH_FAIL),
      antiCycleEvents: Atomics.load(c, CTL.ANTI_CYCLE) >>> 0,
      lastHttpStatus: Atomics.load(c, CTL.LAST_HTTP),
      backoffLevel: Atomics.load(c, CTL.BACKOFF_LEVEL),
    };
  }

  /** Overlay externally-known harvest timestamps (used by browser sandboxes mirroring the server). */
  setTimestamps(lastFetch: number, nextFetch: number, resyncAt: number): void {
    this.f64[F64.LAST_FETCH] = lastFetch;
    this.f64[F64.NEXT_FETCH] = nextFetch;
    this.f64[F64.RESYNC_AT] = resyncAt;
  }
}
