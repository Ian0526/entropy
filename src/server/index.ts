/**
 * TuringLife web server: the Morphogenesis preview/lab site, plus the quantum-entropy pool the
 * world draws its random numbers from.
 *
 *   GET /                    the lab (live preview, settings, download link for the desktop app)
 *   GET /api/quantum/pool    the current pool of quantum random uint16s and where they came from
 *   GET /health              for Railway's health check
 *
 * The desktop app (desktop/) doesn't need this server: it carries the same web page and fetches
 * quantum numbers itself.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { QuantumEntropyEngine } from '../engine/QuantumEntropy';
import { anuAqnProvider, anuLegacyProvider, lfdrProvider, qrngApiProvider, type QrngProvider } from '../engine/QrngProviders';

// Local secrets (QRNGAPI_KEY etc.) come from a git-ignored .env; on Railway use service variables.
if (existsSync('.env')) process.loadEnvFile('.env');

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '0.0.0.0';
const INTERVAL_ENV = process.env.QRNG_INTERVAL_MS ?? process.env.ANU_INTERVAL_MS;
const QRNG_INTERVAL_MS = INTERVAL_ENV ? clampInt(INTERVAL_ENV, 10_000, 90 * 24 * 3600_000, 60_000) : undefined;
const QRNG_MONTHLY = process.env.QRNG_MONTHLY_REQUESTS ? clampInt(process.env.QRNG_MONTHLY_REQUESTS, 1, 10_000_000, 10) : undefined;

function clampInt(v: string | undefined, lo: number, hi: number, d: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d;
}

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, bodyLimit: 16 * 1024, trustProxy: true, disableRequestLogging: true });
const log = (m: string) => app.log.info(m);

// ---- quantum entropy ----------------------------------------------------------------
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

// ---- HTTP -----------------------------------------------------------------------
app.addHook('onSend', async (req, reply, payload) => {
  if (!reply.hasHeader('Cache-Control')) {
    // Hashed assets are immutable; the HTML shell must always revalidate so deploys take effect.
    reply.header('Cache-Control', req.url.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
  }
  return payload;
});

app.get('/health', async () => ({ ok: true, entropyMode: entropy.telemetry().mode, uptimeSec: Math.round(process.uptime()) }));

app.get('/api/quantum/pool', async (_req, reply) => {
  reply.header('Cache-Control', 'no-store');
  // Anyone may read it (the desktop app's page and forks of it included).
  reply.header('Access-Control-Allow-Origin', '*');
  return { pool: Array.from(entropy.snapshot()), telemetry: entropy.telemetry() };
});

const clientDir = path.resolve(process.cwd(), 'dist/client');
if (existsSync(clientDir)) {
  await app.register(fastifyStatic, { root: clientDir, wildcard: false, cacheControl: false });
  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !/^\/(api|assets)(\/|$)/.test(req.url)) {
      reply.header('Cache-Control', 'no-cache');
      return reply.sendFile('index.html');
    }
    return reply.code(404).send({ error: 'not found' });
  });
} else {
  app.log.warn(`no client build at ${clientDir}: run "npm run build:client" (or use the Vite dev server)`);
}

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${signal} received, shutting down`);
  entropy.stopCron();
  await app.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: PORT, host: HOST });
log(`TuringLife listening on http://${HOST}:${PORT}`);
