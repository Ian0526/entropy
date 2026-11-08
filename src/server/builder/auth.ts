/**
 * Two locks:
 *  - People: SITE_PASSWORD gates the whole site (pages, WebSocket, API, Builder). Unlocking sets a
 *    cookie holding an HMAC of the password, keyed by SITE_SESSION_SECRET (rotating it signs everyone
 *    out). With no password the site is open, but Builder refuses everyone: it runs on the owner's plan.
 *  - The worker on the owner's PC: `Authorization: Bearer <BUILDER_WORKER_TOKEN>`.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const ACCESS_COOKIE = 'tl_access';
export const ACCESS_MAX_AGE_S = 60 * 60 * 24 * 30;

const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest();
/** Hashing both sides first keeps the constant-time compare from leaking the length. */
const same = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

export function accessToken(password: string, secret?: string): string {
  return createHmac('sha256', secret ? `secret:${secret}` : `password:${password}`).update(`turinglife:${password}`).digest('hex');
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

export type PersonAuth = 'ok' | 'unconfigured' | 'locked';

export function personAuth(cookieHeader: string | undefined, env: NodeJS.ProcessEnv = process.env): PersonAuth {
  const password = env.SITE_PASSWORD;
  if (!password) return 'unconfigured';
  const cookie = readCookie(cookieHeader, ACCESS_COOKIE);
  return cookie !== undefined && same(cookie, accessToken(password, env.SITE_SESSION_SECRET)) ? 'ok' : 'locked';
}

export function checkPassword(attempt: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  const password = env.SITE_PASSWORD;
  return !!password && typeof attempt === 'string' && same(attempt, password);
}

export type WorkerAuth = 'ok' | 'unconfigured' | 'denied';

export function workerAuth(header: string | undefined, token: string | undefined = process.env.BUILDER_WORKER_TOKEN): WorkerAuth {
  if (!token) return 'unconfigured';
  if (!header?.startsWith('Bearer ')) return 'denied';
  return same(header.slice('Bearer '.length), token) ? 'ok' : 'denied';
}

/** Counts wrong passwords per visitor so the unlock form can't be guessed at full speed. In memory. */
export function createGuessLimiter(opts: { maxFailures: number; windowMs: number; clock?: () => number }) {
  const clock = opts.clock ?? Date.now;
  const failures = new Map<string, { count: number; since: number }>();
  const current = (who: string) => {
    const f = failures.get(who);
    if (f && clock() - f.since > opts.windowMs) {
      failures.delete(who);
      return undefined;
    }
    return f;
  };
  return {
    blocked: (who: string) => (current(who)?.count ?? 0) >= opts.maxFailures,
    fail: (who: string) => {
      const f = current(who);
      failures.set(who, f ? { ...f, count: f.count + 1 } : { count: 1, since: clock() });
    },
    succeed: (who: string) => void failures.delete(who),
  };
}

export const UNLOCK_PATH = '/unlock';
/** Reachable without the password: health checks, the worker (own token), the unlock page and its assets. */
const OPEN = [/^\/health$/, /^\/unlock$/, /^\/api\/session(\/|$)/, /^\/api\/worker\//, /^\/assets\//, /^\/favicon/];

export type GateDecision = 'allow' | 'unlock' | 'deny';

export function gateDecision(req: { url: string; method: string; cookie: string | undefined; accept?: string }, env: NodeJS.ProcessEnv = process.env): GateDecision {
  if (!env.SITE_PASSWORD) return 'allow';
  const pathOnly = req.url.split('?')[0];
  if (OPEN.some((r) => r.test(pathOnly))) return 'allow';
  if (personAuth(req.cookie, env) === 'ok') return 'allow';
  const page = req.method === 'GET' && !pathOnly.startsWith('/api/') && pathOnly !== '/ws' && (req.accept ?? '').includes('text/html');
  return page ? 'unlock' : 'deny';
}
