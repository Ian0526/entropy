/**
 * Authoritative simulation worker (Node worker_threads).
 *
 * Owns the SimulationCore whose grid lives in a SharedArrayBuffer allocated by the
 * main thread, and a QuantumEntropyEngine attached to the main thread's entropy pool.
 * The main thread never blocks on simulation work: it only forwards pre-compressed
 * binary frames and JSON telemetry to WebSocket clients.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { deflateRawSync } from 'node:zlib';
import { QuantumEntropyEngine } from '../engine/QuantumEntropy';
import { HDR, SimulationCore } from '../engine/SimulationCore';
import {
  FRAME_DELTA, FRAME_HEADER_BYTES, FRAME_KEY, LAYER_COUNT, SPEED_TPS, writeFrameHeader,
  type ClientMsg, type SimTelemetry, type SpeedMode,
} from '../engine/protocol';
import { SPEED_CODES, type WorkerInbound, type WorkerOutbound } from './workerProtocol';

if (!parentPort) throw new Error('simWorker must run inside worker_threads');
const port = parentPort;

const { entropySab, gridSab, width, height } = workerData as {
  entropySab: SharedArrayBuffer;
  gridSab: SharedArrayBuffer;
  width: number;
  height: number;
};

const entropy = new QuantumEntropyEngine(entropySab);
const sim = new SimulationCore(width, height, entropy, gridSab);
const header = sim.header;

const FRAME_INTERVAL_MS = 50; //       ≤ 20 binary frames/s
const KEYFRAME_EVERY = 60; //          frames
const TELEMETRY_MIN_MS = 150;
const TELEMETRY_MAX_MS = 1000;

const frameLen = SimulationCore.frameBytes(width, height);
let cur = new Uint8Array(frameLen);
let prev = new Uint8Array(frameLen);
const xor = new Uint8Array(frameLen);
let seq = 0;
let framesSinceKey = KEYFRAME_EVERY;
let keyRequested = true;
let dirty = true;
let lastFrameAt = 0;
let lastTelemetryAt = 0;
let lastTelemetryTick = -1;

const jumpTrail: number[] = [];
let tpsEma = 0;
let tickMsEma = 0;
let tickWindowStart = performance.now();
let ticksInWindow = 0;
let acc = 0;
let lastLoop = performance.now();

function post(msg: WorkerOutbound, transfer?: ArrayBuffer[]): void {
  if (transfer) port.postMessage(msg, transfer);
  else port.postMessage(msg);
}

function speedOf(code: number): SpeedMode {
  return (Object.keys(SPEED_CODES) as SpeedMode[]).find((k) => SPEED_CODES[k] === code) ?? '1x';
}

function emitFrame(now: number): void {
  sim.packFrame(cur);
  const key = keyRequested || framesSinceKey >= KEYFRAME_EVERY;
  let payload: Buffer;
  if (key) {
    payload = deflateRawSync(cur, { level: 1 });
    framesSinceKey = 0;
    keyRequested = false;
  } else {
    for (let i = 0; i < frameLen; i++) xor[i] = cur[i] ^ prev[i];
    payload = deflateRawSync(xor, { level: 1 });
    framesSinceKey++;
  }
  seq = (seq + 1) >>> 0;
  const packet = new Uint8Array(FRAME_HEADER_BYTES + payload.length);
  writeFrameHeader(new DataView(packet.buffer), {
    kind: key ? FRAME_KEY : FRAME_DELTA,
    width, height, layers: LAYER_COUNT,
    running: Atomics.load(header, HDR.RUNNING) === 1,
    seq, tick: sim.tick,
  });
  packet.set(payload, FRAME_HEADER_BYTES);
  Atomics.store(header, HDR.SEQ, seq | 0);
  post({ type: 'frame', seq, key, buffer: packet.buffer }, [packet.buffer]);
  const t = prev;
  prev = cur;
  cur = t;
  lastFrameAt = now;
  dirty = false;
}

function emitTelemetry(now: number): void {
  const speed = speedOf(Atomics.load(header, HDR.SPEED));
  const data: SimTelemetry = {
    ...sim.stats,
    topSpecies: sim.stats.topSpecies.slice(),
    source: 'cloud',
    width, height,
    tps: tpsEma,
    tickMs: tickMsEma,
    running: Atomics.load(header, HDR.RUNNING) === 1,
    speed,
    params: { ...sim.params },
    entropy: entropy.telemetry(),
    jumpTrail: jumpTrail.slice(),
    clients: 0,
    serverTime: Date.now(),
  };
  post({ type: 'telemetry', data });
  lastTelemetryAt = now;
  lastTelemetryTick = sim.tick;
}

function runTick(): void {
  const t0 = performance.now();
  sim.step();
  const dt = performance.now() - t0;
  tickMsEma = tickMsEma ? tickMsEma * 0.95 + dt * 0.05 : dt;
  ticksInWindow++;
  jumpTrail.push(entropy.currentJumpIdx);
  if (jumpTrail.length > 32) jumpTrail.shift();
  dirty = true;
}

function loop(): void {
  const now = performance.now();
  const running = Atomics.load(header, HDR.RUNNING) === 1;
  const speed = speedOf(Atomics.load(header, HDR.SPEED));

  if (running) {
    const budgetEnd = now + 14;
    if (speed === 'max') {
      do runTick();
      while (performance.now() < budgetEnd && performance.now() - lastFrameAt < FRAME_INTERVAL_MS);
      acc = 0;
    } else {
      acc += ((now - lastLoop) * SPEED_TPS[speed]) / 1000;
      if (acc > 8) acc = 8; // don't spiral after a stall
      while (acc >= 1 && performance.now() < budgetEnd) {
        runTick();
        acc -= 1;
      }
    }
  } else {
    acc = 0;
  }
  lastLoop = now;

  const t = performance.now();
  if (t - tickWindowStart >= 500) {
    const inst = (ticksInWindow * 1000) / (t - tickWindowStart);
    tpsEma = tpsEma ? tpsEma * 0.6 + inst * 0.4 : inst;
    ticksInWindow = 0;
    tickWindowStart = t;
  }
  if ((dirty || keyRequested) && t - lastFrameAt >= FRAME_INTERVAL_MS) emitFrame(t);
  const sinceTel = t - lastTelemetryAt;
  if ((sim.tick - lastTelemetryTick >= 10 && sinceTel >= TELEMETRY_MIN_MS) || sinceTel >= TELEMETRY_MAX_MS) emitTelemetry(t);
  Atomics.store(header, HDR.HEARTBEAT, (Date.now() / 1000) | 0);

  if (running && speed === 'max') setImmediate(loop);
  else setTimeout(loop, 4);
}

port.on('message', (msg: WorkerInbound) => {
  switch (msg.type) {
    case 'client': {
      const m: ClientMsg = msg.msg;
      if (m.type === 'tool') {
        sim.applyTool(m.tool, m.x, m.y, m.radius, m.strength);
        dirty = true;
      } else if (m.type === 'params') {
        sim.setParams(m.params);
      } else if (m.type === 'reset') {
        sim.reset();
        keyRequested = true;
        dirty = true;
      }
      break;
    }
    case 'inspect':
      post({ type: 'inspect', ticket: msg.ticket, data: sim.inspect(msg.x, msg.y) });
      break;
    case 'needKey':
      keyRequested = true;
      break;
  }
});

post({ type: 'ready', width, height });
loop();
