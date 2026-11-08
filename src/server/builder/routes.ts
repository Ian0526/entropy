/** Builder HTTP routes: /api/builder/* for people (password), /api/worker/builder/* for the PC worker (token). */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ACCESS_COOKIE, ACCESS_MAX_AGE_S, accessToken, checkPassword, createGuessLimiter, gateDecision, personAuth, UNLOCK_PATH, workerAuth } from './auth';
import { readImages, type BuilderStore } from './store';

const MAX_BODY = 12 * 1024 * 1024;
const MAX_TEXT = 8000;
const dailyLimitUsd = () => Number(process.env.BUILDER_DAILY_USD) || 20;

type Body = Record<string, unknown> | null | undefined;
const text = (v: unknown) => (typeof v === 'string' ? v.trim().slice(0, MAX_TEXT) : '');

export function registerBuilder(app: FastifyInstance, store: BuilderStore): void {
  const guesses = createGuessLimiter({ maxFailures: 8, windowMs: 15 * 60_000 });

  // Site-wide password gate (runs before every route, including /ws upgrades and static files).
  app.addHook('onRequest', async (req, reply) => {
    const decision = gateDecision({ url: req.url, method: req.method, cookie: req.headers.cookie, accept: req.headers.accept });
    if (decision === 'allow') return;
    reply.header('Cache-Control', 'no-store');
    if (decision === 'unlock') return reply.redirect(`${UNLOCK_PATH}?next=${encodeURIComponent(req.url)}`);
    return reply.code(401).send({ error: 'Locked. Enter the site password first.' });
  });

  const person = async (req: FastifyRequest, reply: FastifyReply) => {
    const state = personAuth(req.headers.cookie);
    if (state === 'ok') return;
    reply.header('Cache-Control', 'no-store');
    return state === 'unconfigured'
      ? reply.code(503).send({ error: 'Builder is off: set SITE_PASSWORD on the server.' })
      : reply.code(401).send({ error: 'Unlock Builder first.' });
  };

  const worker = async (req: FastifyRequest, reply: FastifyReply) => {
    const state = workerAuth(req.headers.authorization);
    if (state === 'ok') return;
    return state === 'unconfigured'
      ? reply.code(503).send({ error: 'Builder worker is not configured: set BUILDER_WORKER_TOKEN.' })
      : reply.code(401).send({ error: 'Wrong or missing worker token.' });
  };

  // ---- session ---------------------------------------------------------------
  app.get('/api/session', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const state = personAuth(req.headers.cookie);
    return { configured: state !== 'unconfigured', unlocked: state === 'ok' };
  });

  app.post('/api/session/unlock', async (req, reply) => {
    const who = req.ip;
    if (guesses.blocked(who)) return reply.code(429).send({ error: 'Too many tries. Wait a few minutes.' });
    const body = req.body as Body;
    if (!checkPassword(body?.password)) {
      guesses.fail(who);
      return reply.code(401).send({ error: 'That password is wrong.' });
    }
    guesses.succeed(who);
    const secure = req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https';
    const token = accessToken(process.env.SITE_PASSWORD!, process.env.SITE_SESSION_SECRET);
    reply.header('Set-Cookie', `${ACCESS_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${ACCESS_MAX_AGE_S}${secure ? '; Secure' : ''}`);
    return { ok: true };
  });

  app.post('/api/session/lock', async (_req, reply) => {
    reply.header('Set-Cookie', `${ACCESS_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    return { ok: true };
  });

  // ---- requests (people) -----------------------------------------------------
  app.get('/api/builder', { preHandler: person }, async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { requests: store.list(), workerOnline: store.workerOnline(), spentUsd: store.spentLastDay(), dailyLimitUsd: dailyLimitUsd() };
  });

  app.post('/api/builder', { preHandler: person, bodyLimit: MAX_BODY }, async (req, reply) => {
    const body = req.body as Body;
    const prompt = text(body?.prompt);
    if (!prompt) return reply.code(400).send({ error: "Say what you'd like done." });
    const row = store.create(prompt, readImages(body?.images));
    return reply.code(201).send({ id: row.id });
  });

  app.post<{ Params: { id: string } }>('/api/builder/:id', { preHandler: person, bodyLimit: MAX_BODY }, async (req, reply) => {
    const { id } = req.params;
    const body = req.body as Body;
    switch (body?.action) {
      case 'follow-up': {
        const said = text(body.text);
        if (!said) return reply.code(400).send({ error: "Say what you'd like changed." });
        return store.followUp(id, said, readImages(body.images)) ? { request: store.summary(id) } : reply.code(409).send({ error: "It's still working on this one." });
      }
      case 'cancel':
        return store.cancel(id) ? { request: store.summary(id) } : reply.code(409).send({ error: "There's nothing to stop." });
      case 'approve':
        return store.approve(id) ? { ok: true } : reply.code(409).send({ error: "There's nothing to approve." });
      default:
        return reply.code(400).send({ error: 'Unknown action.' });
    }
  });

  app.get<{ Params: { id: string; n: string } }>('/api/builder/:id/shots/:n', { preHandler: person }, async (req, reply) => {
    const shot = store.shot(req.params.id, Number(req.params.n));
    if (!shot) return reply.code(404).send({ error: 'No such screenshot.' });
    reply.header('Cache-Control', 'private, max-age=3600').type('image/png');
    return reply.send(shot);
  });

  // ---- worker ----------------------------------------------------------------
  app.get('/api/worker/builder/next', { preHandler: worker }, async (_req, reply) => {
    const job = store.claimNext(dailyLimitUsd());
    return job ? { job } : reply.code(204).send();
  });

  app.post('/api/worker/builder/reset', { preHandler: worker }, async () => ({ failed: store.failInterrupted() }));

  app.post<{ Params: { id: string } }>('/api/worker/builder/requests/:id', { preHandler: worker, bodyLimit: MAX_BODY }, async (req, reply) => {
    const { id } = req.params;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
    let ok: boolean;
    switch (b.action) {
      case 'progress': {
        const r = store.progress(id, { lines: strings(b.lines), sessionId: b.sessionId as string | undefined, costUsd: b.costUsd as number | undefined });
        return r ?? reply.code(404).send({ error: 'No such request.' });
      }
      case 'propose':
        ok = store.propose(id, { branch: String(b.branch ?? ''), files: strings(b.files).slice(0, 500), checks: String(b.checks ?? '').slice(0, 4000) }, strings(b.shots));
        break;
      case 'finish':
        ok = store.finish(id, { summary: typeof b.summary === 'string' ? b.summary : undefined, error: typeof b.error === 'string' ? b.error : undefined });
        break;
      case 'merged':
        ok = store.merged(id, typeof b.error === 'string' ? b.error : undefined);
        break;
      default:
        return reply.code(400).send({ error: 'Unknown action.' });
    }
    return ok ? { ok: true } : reply.code(404).send({ error: 'No such request.' });
  });
}
