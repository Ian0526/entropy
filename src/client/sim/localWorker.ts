/// <reference lib="webworker" />
/**
 * Local Sandbox: the full SimulationCore + QuantumEntropyEngine running inside a
 * browser WebWorker, seeded from the server's latest quantum pool snapshot.
 * Frames are posted as raw planar buffers (transferred, then recycled → zero GC churn).
 */
import { QuantumEntropyEngine } from '../../engine/QuantumEntropy';
import { SimulationCore } from '../../engine/SimulationCore';
import { SPEED_TPS, type ClientMsg, type SimParams, type SimTelemetry, type SpeedMode, type WorldId } from '../../engine/protocol';
import type { EntropyTelemetry } from '../../engine/QuantumEntropy';

export type LocalInbound =
  | { type: 'init'; world: WorldId; width: number; height: number; depth: number; pool: Uint16Array | null; entropy: EntropyTelemetry | null; params: SimParams }
  | { type: 'client'; msg: ClientMsg }
  | { type: 'seedPool'; pool: Uint16Array; entropy: EntropyTelemetry | null }
  | { type: 'recycle'; buffer: ArrayBuffer }
  | { type: 'getPool' };

export type LocalOutbound =
  | { type: 'frame'; buffer: ArrayBuffer; width: number; height: number; depth: number; tick: number }
  | { type: 'telemetry'; data: SimTelemetry }
  | { type: 'inspect'; id: number; data: ReturnType<SimulationCore['inspect']> }
  | { type: 'pool'; pool: Uint16Array };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

let sim: SimulationCore | null = null;
let entropy: QuantumEntropyEngine | null = null;
let running = true;
let speed: SpeedMode = '1x';
let world: WorldId = '2d';
const spare: ArrayBuffer[] = [];
let frameBytes = 0;
let dirty = true;
let lastFrame = 0;
let lastTel = 0;
let lastTelTick = -1;
let acc = 0;
let lastLoop = performance.now();
let tpsEma = 0;
let tickMsEma = 0;
let winStart = performance.now();
let winTicks = 0;
const jumpTrail: number[] = [];

function post(msg: LocalOutbound, transfer: Transferable[] = []): void {
  ctx.postMessage(msg, transfer);
}

function seed(pool: Uint16Array | null, ent: EntropyTelemetry | null): void {
  if (!entropy) return;
  if (pool && pool.length) {
    // Only claim LIVE quantum consumption if the server's pool really came from ANU;
    // a CSPRNG-bootstrapped snapshot is loaded as sponge material instead.
    if (ent?.origin === 'QRNG') entropy.ingest(pool, 2);
    else entropy.loadPool(pool);
    for (let i = 0; i < 8; i++) entropy.absorbQuantumSeed();
  }
  if (ent) entropy.setTimestamps(ent.lastFetchTime, ent.nextFetchTime, Date.now() + 15_000);
  else entropy.setTimestamps(0, 0, Date.now() + 15_000);
}

function emitFrame(now: number): void {
  if (!sim) return;
  const buf = spare.pop() ?? new ArrayBuffer(frameBytes);
  sim.packFrame(new Uint8Array(buf));
  post({ type: 'frame', buffer: buf, width: sim.W, height: sim.H, depth: sim.D, tick: sim.tick }, [buf]);
  lastFrame = now;
  dirty = false;
}

function emitTelemetry(now: number): void {
  if (!sim || !entropy) return;
  post({
    type: 'telemetry',
    data: {
      ...sim.stats,
      topSpecies: sim.stats.topSpecies.slice(),
      source: 'local',
      world,
      width: sim.W,
      height: sim.H,
      depth: sim.D,
      tps: tpsEma,
      tickMs: tickMsEma,
      running,
      speed,
      params: { ...sim.params },
      entropy: entropy.telemetry(),
      jumpTrail: jumpTrail.slice(),
      clients: 1,
      serverTime: Date.now(),
    },
  });
  lastTel = now;
  lastTelTick = sim.tick;
}

function loop(): void {
  if (!sim || !entropy) return;
  const now = performance.now();
  if (running) {
    const end = now + 12;
    const tick = () => {
      const t0 = performance.now();
      sim!.step();
      const dt = performance.now() - t0;
      tickMsEma = tickMsEma ? tickMsEma * 0.95 + dt * 0.05 : dt;
      winTicks++;
      jumpTrail.push(entropy!.currentJumpIdx);
      if (jumpTrail.length > 32) jumpTrail.shift();
      dirty = true;
    };
    if (speed === 'max') {
      do tick();
      while (performance.now() < end && performance.now() - lastFrame < 33);
    } else {
      acc = Math.min(8, acc + ((now - lastLoop) * SPEED_TPS[speed]) / 1000);
      while (acc >= 1 && performance.now() < end) {
        tick();
        acc -= 1;
      }
    }
  } else acc = 0;
  lastLoop = now;
  const t = performance.now();
  if (t - winStart >= 500) {
    const inst = (winTicks * 1000) / (t - winStart);
    tpsEma = tpsEma ? tpsEma * 0.6 + inst * 0.4 : inst;
    winTicks = 0;
    winStart = t;
  }
  if (dirty && t - lastFrame >= 33) emitFrame(t);
  if ((sim.tick - lastTelTick >= 10 && t - lastTel >= 150) || t - lastTel >= 1000) emitTelemetry(t);
  setTimeout(loop, running && speed === 'max' ? 0 : 4);
}

ctx.onmessage = (e: MessageEvent<LocalInbound>) => {
  const m = e.data;
  switch (m.type) {
    case 'init': {
      entropy = new QuantumEntropyEngine();
      seed(m.pool, m.entropy);
      world = m.world;
      sim = new SimulationCore(m.width, m.height, entropy, undefined, false, m.depth);
      sim.setParams(m.params);
      frameBytes = SimulationCore.frameBytes(m.width, m.height, m.depth);
      lastLoop = performance.now();
      emitTelemetry(lastLoop);
      loop();
      break;
    }
    case 'seedPool':
      seed(m.pool, m.entropy);
      break;
    case 'recycle':
      if (m.buffer.byteLength === frameBytes && spare.length < 3) spare.push(m.buffer);
      break;
    case 'getPool':
      if (entropy) post({ type: 'pool', pool: entropy.snapshot() });
      break;
    case 'client': {
      if (!sim) break;
      const c = m.msg;
      if (c.type === 'tool') sim.applyTool(c.tool, c.x, c.y, c.radius, c.strength, c.z ?? 0);
      else if (c.type === 'params') sim.setParams(c.params);
      else if (c.type === 'control') {
        if (typeof c.running === 'boolean') running = c.running;
        if (c.speed) speed = c.speed;
        emitTelemetry(performance.now());
      } else if (c.type === 'reset') sim.reset();
      else if (c.type === 'inspect') post({ type: 'inspect', id: c.id, data: sim.inspect(c.x, c.y, c.z ?? 0) });
      dirty = true;
      break;
    }
  }
};
