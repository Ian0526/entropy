/**
 * TuringLife server — Fastify HTTP + WebSocket bridge + ANU QRNG cron.
 *
 * Main thread responsibilities (kept deliberately light so Railway health checks
 * never stall): entropy harvesting, HTTP/static serving, and fan-out of frames that
 * the simulation worker has already packed, XOR-delta'd and deflated.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import { QuantumEntropyEngine } from '../engine/QuantumEntropy';
import { anuAqnProvider, anuLegacyProvider, lfdrProvider, qrngApiProvider, type QrngProvider } from '../engine/QrngProviders';
import { gridLayout, HDR } from '../engine/SimulationCore';
import {
  DEFAULT_PARAMS, LAYER_COUNT, sanitizeParams,
  type ClientMsg, type ServerMsg, type SimTelemetry, type SpeedMode, type ToolKind,
} from '../engine/protocol';
import { SPEED_CODES, type WorkerInbound, type WorkerOutbound } from './workerProtocol';
import { registerBuilder } from './builder/routes';
import { BuilderStore } from './builder/store';

// ---- configuration ------------------------------------------------------------
// Local secrets (QRNGAPI_KEY etc.) come from a git-ignored .env; on Railway use service variables.
if (existsSync('.env')) process.loadEnvFile('.env');

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '0.0.0.0';
const GRID_W = clampInt(process.env.GRID_W, 64, 1024, 256);
const GRID_H = clampInt(process.env.GRID_H, 64, 1024, 256);
const INTERVAL_ENV = process.env.QRNG_INTERVAL_MS ?? process.env.ANU_INTERVAL_MS;
const QRNG_INTERVAL_MS = INTERVAL_ENV ? clampInt(INTERVAL_ENV, 10_000, 90 * 24 * 3600_000, 60_000) : undefined;
const QRNG_MONTHLY = process.env.QRNG_MONTHLY_REQUESTS ? clampInt(process.env.QRNG_MONTHLY_REQUESTS, 1, 10_000_000, 10) : undefined;
const MAX_BUFFERED = 4 * 1024 * 1024;
const RESET_COOLDOWN_MS = 20_000;
const TOOLS: ToolKind[] = ['inspect', 'poke', 'mutagen', 'wall', 'erase', 'food', 'predator'];

function clampInt(v: string | undefined, lo: number, hi: number, d: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d;
}

// trustProxy: Railway's edge sets X-Forwarded-For/Proto (used for the unlock rate limit and Secure cookies).
const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, bodyLimit: 16 * 1024, trustProxy: true, disableRequestLogging: true });
const log = (m: string) => app.log.info(m);

// ---- quantum entropy (shared with the worker) -------------------------------------
/**
 * QRNG_PROVIDER: auto (default) | lfdr | qrngapi | anu | anu-legacy | none
 *   auto → LfD QRNG (keyless Quantis hardware). Keyed providers must be named explicitly.
 */
function selectProvider(): QrngProvider | null {
  const want = (process.env.QRNG_PROVIDER ?? 'auto').toLowerCase();
  if (want === 'none' || process.env.ANU_DISABLED === '1') return null;
  if (want === 'auto' || want === 'lfdr') return lfdrProvider({ baseUrl: process.env.LFDR_URL || undefined });
  const qKey = process.env.QRNGAPI_KEY?.trim();
  const aKey = process.env.ANU_API_KEY?.trim();
  if (want === 'qrngapi') {
    if (!qKey) throw new Error('QRNG_PROVIDER=qrngapi requires QRNGAPI_KEY');
    return qrngApiProvider({ apiKey: qKey, method: process.env.QRNGAPI_METHOD || 'auto' });
  }
  if (want === 'anu') {
    if (!aKey) throw new Error('QRNG_PROVIDER=anu requires ANU_API_KEY');
    return anuAqnProvider({ apiKey: aKey });
  }
  return anuLegacyProvider({ url: process.env.ANU_URL || undefined });
}

const entropy = new QuantumEntropyEngine();
entropy.configureHarvester({
  provider: selectProvider(),
  intervalMs: QRNG_INTERVAL_MS,
  monthlyRequests: QRNG_MONTHLY,
  acceptSimulator: process.env.QRNG_ACCEPT_SIMULATOR === '1',
  log,
});
{
  const h = entropy.harvesterInfo();
  log(`[quantum] provider: ${h.provider}; interval ${(entropy.baseIntervalMs() / 3600_000).toFixed(2)} h; `
    + `budget ${h.budgetTotal ?? 'unmetered'} req/month; simulator data ${h.acceptSimulator ? 'ACCEPTED (labelled simulated)' : 'rejected'}`);
}
entropy.startCron();

// ---- shared grid + worker supervisor ----------------------------------------------
const gridSab = new SharedArrayBuffer(gridLayout(GRID_W, GRID_H).bytes);
const gridHeader = new Int32Array(gridSab, 0, 16);
Atomics.store(gridHeader, HDR.RUNNING, 1);
Atomics.store(gridHeader, HDR.SPEED, SPEED_CODES['1x']);

const here = fileURLToPath(import.meta.url);
const isTs = here.endsWith('.ts');
const workerFile = path.join(path.dirname(here), isTs ? 'simWorker.ts' : 'simWorker.js');

let worker: Worker;
let latestTelemetry: SimTelemetry | null = null;
let workerStartedAt = Date.now();

interface Client {
  ws: WebSocket;
  id: number;
  synced: boolean;
  lastSeq: number;
  tokens: number;
  lastRefill: number;
}
const clients = new Set<Client>();
let nextClientId = 1;
let nextTicket = 1;
const pendingInspect = new Map<number, { client: Client; id: number }>();
let lastResetAt = 0;

function spawnWorker(): void {
  workerStartedAt = Date.now();
  worker = new Worker(workerFile, {
    workerData: { entropySab: entropy.sab, gridSab, width: GRID_W, height: GRID_H },
    execArgv: isTs ? ['--import', 'tsx'] : undefined,
  });
  worker.on('message', onWorkerMessage);
  worker.on('error', (err) => app.log.error({ err }, 'simulation worker crashed'));
  worker.on('exit', (code) => {
    if (shuttingDown) return;
    app.log.warn(`simulation worker exited (${code}); respawning in 1s`);
    setTimeout(spawnWorker, 1000);
  });
}

function toWorker(msg: WorkerInbound): void {
  worker.postMessage(msg);
}

function sendJson(c: Client, msg: ServerMsg): void {
  if (c.ws.readyState === 1) c.ws.send(JSON.stringify(msg));
}

function onWorkerMessage(msg: WorkerOutbound): void {
  switch (msg.type) {
    case 'ready':
      log(`simulation worker ready (${msg.width}×${msg.height})`);
      break;
    case 'frame': {
      const buf = Buffer.from(msg.buffer);
      let needKey = false;
      for (const c of clients) {
        if (c.ws.readyState !== 1) continue;
        const congested = c.ws.bufferedAmount > MAX_BUFFERED;
        if (msg.key) {
          if (congested) {
            c.synced = false;
            needKey = true;
            continue;
          }
          c.ws.send(buf, { binary: true });
          c.synced = true;
          c.lastSeq = msg.seq;
        } else if (c.synced && !congested && c.lastSeq === ((msg.seq - 1) >>> 0)) {
          c.ws.send(buf, { binary: true });
          c.lastSeq = msg.seq;
        } else {
          // Missed a delta (backpressure or just joined): wait for the next keyframe.
          c.synced = false;
          needKey = true;
        }
      }
      if (needKey) toWorker({ type: 'needKey' });
      break;
    }
    case 'telemetry': {
      msg.data.clients = clients.size;
      // Provider strings/budget live on the main-thread harvester, not in shared memory.
      msg.data.entropy = { ...msg.data.entropy, ...entropy.harvesterInfo() };
      latestTelemetry = msg.data;
      const json = JSON.stringify({ type: 'telemetry', data: msg.data } satisfies ServerMsg);
      for (const c of clients) if (c.ws.readyState === 1 && c.ws.bufferedAmount < MAX_BUFFERED) c.ws.send(json);
      break;
    }
    case 'inspect': {
      const p = pendingInspect.get(msg.ticket);
      if (!p) break;
      pendingInspect.delete(msg.ticket);
      sendJson(p.client, { type: 'inspect', id: p.id, data: msg.data });
      break;
    }
  }
}

// ---- client message validation ---------------------------------------------------
function takeToken(c: Client, cost = 1): boolean {
  const now = Date.now();
  c.tokens = Math.min(60, c.tokens + ((now - c.lastRefill) / 1000) * 40);
  c.lastRefill = now;
  if (c.tokens < cost) return false;
  c.tokens -= cost;
  return true;
}

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

async function onClientMessage(c: Client, raw: string): Promise<void> {
  if (raw.length > 4096) return;
  let m: ClientMsg;
  try {
    m = JSON.parse(raw) as ClientMsg;
  } catch {
    return;
  }
  if (!m || typeof m !== 'object') return;
  switch (m.type) {
    case 'tool':
      if (!TOOLS.includes(m.tool) || !takeToken(c)) return;
      toWorker({
        type: 'client',
        msg: { type: 'tool', tool: m.tool, x: num(m.x), y: num(m.y), radius: num(m.radius, 3), strength: num(m.strength, 0.8) },
      });
      break;
    case 'params':
      if (!takeToken(c) || !m.params || typeof m.params !== 'object') return;
      toWorker({ type: 'client', msg: { type: 'params', params: sanitizeParams(m.params, latestTelemetry?.params ?? DEFAULT_PARAMS) } });
      break;
    case 'control':
      if (typeof m.running === 'boolean') Atomics.store(gridHeader, HDR.RUNNING, m.running ? 1 : 0);
      if (m.speed && m.speed in SPEED_CODES) Atomics.store(gridHeader, HDR.SPEED, SPEED_CODES[m.speed as SpeedMode]);
      break;
    case 'inspect': {
      if (!takeToken(c, 0.5)) return;
      const ticket = nextTicket++;
      pendingInspect.set(ticket, { client: c, id: num(m.id) });
      setTimeout(() => pendingInspect.delete(ticket), 5000);
      toWorker({ type: 'inspect', ticket, x: num(m.x), y: num(m.y) });
      break;
    }
    case 'reset': {
      const now = Date.now();
      if (now - lastResetAt < RESET_COOLDOWN_MS) {
        sendJson(c, { type: 'error', message: `Shared universe reset is on cooldown (${Math.ceil((RESET_COOLDOWN_MS - (now - lastResetAt)) / 1000)}s)` });
        return;
      }
      lastResetAt = now;
      toWorker({ type: 'client', msg: { type: 'reset' } });
      break;
    }
    case 'resync': {
      const r = await entropy.forceResync();
      sendJson(c, { type: 'resync', ...r });
      break;
    }
    case 'needKey':
      c.synced = false;
      toWorker({ type: 'needKey' });
      break;
  }
}

// ---- HTTP -----------------------------------------------------------------------
let shuttingDown = false;

app.addHook('onSend', async (req, reply, payload) => {
  if (!reply.hasHeader('Cache-Control')) {
    // Hashed assets are immutable; the HTML shell must always revalidate so deploys take effect.
    reply.header('Cache-Control', req.url.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
  }
  // Cross-origin isolation → SharedArrayBuffer is available to the browser sandbox too.
  reply.header('Cross-Origin-Opener-Policy', 'same-origin');
  reply.header('Cross-Origin-Embedder-Policy', 'require-corp');
  reply.header('Cross-Origin-Resource-Policy', 'same-origin');
  return payload;
});

await app.register(fastifyWebsocket, { options: { maxPayload: 8 * 1024, perMessageDeflate: false } });

// ---- Builder: plain-words change requests worked by an agent on the owner's PC ----------
const BUILDER_DIR = process.env.BUILDER_DATA_DIR
  || (process.env.RAILWAY_VOLUME_MOUNT_PATH ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'builder') : path.resolve('data/builder'));
registerBuilder(app, new BuilderStore(BUILDER_DIR));
log(`[builder] requests stored in ${BUILDER_DIR}; ${process.env.SITE_PASSWORD ? 'site password ON' : 'site open, Builder off (set SITE_PASSWORD)'}`);

app.get('/health', async (_req, reply) => {
  const beat = Atomics.load(gridHeader, HDR.HEARTBEAT);
  const ageMs = beat ? Date.now() - beat * 1000 : Date.now() - workerStartedAt;
  const healthy = ageMs < 15_000 || Date.now() - workerStartedAt < 15_000;
  reply.code(healthy ? 200 : 503);
  return {
    ok: healthy,
    tick: Atomics.load(gridHeader, HDR.TICK),
    population: Atomics.load(gridHeader, HDR.POPULATION),
    workerHeartbeatAgeMs: ageMs,
    entropyMode: entropy.telemetry().mode,
    clients: clients.size,
    uptimeSec: Math.round(process.uptime()),
  };
});

app.get('/api/telemetry', async () => latestTelemetry);

app.get('/api/quantum/pool', async (_req, reply) => {
  reply.header('Cache-Control', 'no-store');
  return { pool: Array.from(entropy.snapshot()), telemetry: entropy.telemetry() };
});

app.post('/api/quantum/resync', async (_req, reply) => {
  const r = await entropy.forceResync();
  reply.code(r.ok || r.reason !== 'cooldown' ? 200 : 429);
  return r;
});

app.get('/ws', { websocket: true }, (socket) => {
  const c: Client = { ws: socket, id: nextClientId++, synced: false, lastSeq: 0, tokens: 60, lastRefill: Date.now() };
  clients.add(c);
  sendJson(c, { type: 'hello', width: GRID_W, height: GRID_H, layers: LAYER_COUNT });
  if (latestTelemetry) sendJson(c, { type: 'telemetry', data: { ...latestTelemetry, clients: clients.size } });
  toWorker({ type: 'needKey' });
  socket.on('message', (data: Buffer, isBinary: boolean) => {
    if (!isBinary) void onClientMessage(c, data.toString());
  });
  socket.on('close', () => clients.delete(c));
  socket.on('error', () => clients.delete(c));
});

const clientDir = path.resolve(process.cwd(), 'dist/client');
if (existsSync(clientDir)) {
  await app.register(fastifyStatic, {
    root: clientDir,
    wildcard: false,
    cacheControl: false, // set in the onSend hook below
  });
  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !/^\/(api|ws|assets)(\/|$)/.test(req.url)) {
      reply.header('Cache-Control', 'no-cache');
      return reply.sendFile('index.html');
    }
    return reply.code(404).send({ error: 'not found' });
  });
} else {
  app.log.warn(`no client build at ${clientDir} — run "npm run build:client" (or use the Vite dev server)`);
}

spawnWorker();

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${signal} received — shutting down`);
  entropy.stopCron();
  for (const c of clients) c.ws.close(1001, 'server shutting down');
  await app.close();
  await worker.terminate();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: PORT, host: HOST });
log(`TuringLife listening on http://${HOST}:${PORT} — grid ${GRID_W}×${GRID_H}`);
