/**
 * Upstream quantum-randomness providers for the QuantumEntropyEngine harvester.
 *
 * Every provider turns one HTTP request into a batch of uint16 samples and reports
 * whether those samples came from physical quantum hardware. Batches that are not
 * hardware-derived (e.g. a provider's software simulator) are never presented as
 * quantum entropy.
 */

export type ProviderId = 'lfdr' | 'qrngapi' | 'anu-aqn' | 'anu-legacy';

export type ProviderResult =
  | { ok: true; values: Uint16Array; source: string; hardware: boolean; status: number }
  | { ok: false; status: number; error: string; quotaExhausted?: boolean; authFailed?: boolean };

export interface PrecheckResult {
  hardwareAvailable: boolean;
  detail: string;
}

export interface QrngProvider {
  readonly id: ProviderId;
  readonly label: string;
  /** uint16 samples delivered per request. */
  readonly samplesPerRequest: number;
  /** Default monthly request allowance (free tier), Infinity if unmetered. */
  readonly defaultMonthlyRequests: number;
  /** Minimum spacing between requests the provider tolerates. */
  readonly minSpacingMs: number;
  fetch(signal: AbortSignal): Promise<ProviderResult>;
  /** Optional cheap check that does not spend entropy quota. */
  precheck?(signal: AbortSignal): Promise<PrecheckResult>;
}

async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function hexToUint16(hex: string): Uint16Array | null {
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 4 !== 0) return null;
  const out = new Uint16Array(hex.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 4, i * 4 + 4), 16);
  return out;
}

function numericArray(data: unknown): Uint16Array | null {
  if (!Array.isArray(data) || data.length === 0) return null;
  const out = new Uint16Array(data.length);
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    out[i] = v & 0xffff;
  }
  return out;
}

const errorText = (body: Record<string, unknown> | null, status: number) =>
  String(body?.message ?? body?.error ?? `HTTP ${status}`);

// -----------------------------------------------------------------------------
// qrngapi.com — GET /api/random?bytes=1..1024&format=hex, header X-API-Key: qnrk_…
// Response: { data: "<hex>", bytes, format, method, source, proof{…} }
// -----------------------------------------------------------------------------
export function qrngApiProvider(opts: { apiKey: string; method?: string; baseUrl?: string }): QrngProvider {
  const base = (opts.baseUrl ?? 'https://qrngapi.com').replace(/\/$/, '');
  const method = opts.method ?? 'auto';
  const headers = { 'X-API-Key': opts.apiKey, Accept: 'application/json' };
  return {
    id: 'qrngapi',
    label: 'qrngapi.com',
    samplesPerRequest: 512, // 1024 bytes → 512 × uint16 (half the pool per request)
    defaultMonthlyRequests: 10, // free tier: 10 KB/month at 1 KB/request
    minSpacingMs: 6_000, // free tier: 10 requests/minute
    async precheck(signal) {
      const res = await fetch(`${base}/api/methods`, { headers, signal });
      const body = await readJson(res);
      if (!res.ok || !body) return { hardwareAvailable: false, detail: `methods check failed (${errorText(body, res.status)})` };
      const hw = Array.isArray(body.hardware) ? (body.hardware as unknown[]).map(String) : [];
      if (method === 'simulator') return { hardwareAvailable: false, detail: 'simulator method selected' };
      if (method !== 'auto' && !hw.includes(method)) {
        return { hardwareAvailable: false, detail: `hardware method "${method}" not online (online: ${hw.join(', ') || 'none'})` };
      }
      return hw.length > 0
        ? { hardwareAvailable: true, detail: `hardware online: ${hw.join(', ')}` }
        : { hardwareAvailable: false, detail: 'provider reports no hardware quantum source online' };
    },
    async fetch(signal) {
      const url = `${base}/api/random?bytes=1024&format=hex${method !== 'auto' ? `&method=${encodeURIComponent(method)}` : ''}`;
      const res = await fetch(url, { headers, signal });
      const body = await readJson(res);
      if (!res.ok || !body) {
        const msg = errorText(body, res.status);
        return {
          ok: false,
          status: res.status,
          error: msg,
          authFailed: res.status === 401 || res.status === 403,
          quotaExhausted: res.status === 402 || /quota|limit exceeded|insufficient/i.test(msg),
        };
      }
      const values = typeof body.data === 'string' ? hexToUint16(body.data) : null;
      if (!values || values.length === 0) return { ok: false, status: -1, error: 'malformed qrngapi payload' };
      const source = String(body.source ?? body.method ?? 'unknown');
      return { ok: true, values, source, hardware: source !== 'simulator' && source !== 'unknown', status: res.status };
    },
  };
}

// -----------------------------------------------------------------------------
// ANU Quantum Numbers (AWS) — GET https://api.quantumnumbers.anu.edu.au?length=&type=, x-api-key
// -----------------------------------------------------------------------------
export function anuAqnProvider(opts: { apiKey: string }): QrngProvider {
  return {
    id: 'anu-aqn',
    label: 'ANU Quantum Numbers',
    samplesPerRequest: 1024,
    defaultMonthlyRequests: 100, // trial tier: 100 requests/month, 1 request/second
    minSpacingMs: 1_000,
    async fetch(signal) {
      const res = await fetch('https://api.quantumnumbers.anu.edu.au/?length=1024&type=uint16', {
        headers: { 'x-api-key': opts.apiKey },
        signal,
      });
      const body = await readJson(res);
      if (!res.ok || !body) {
        const msg = errorText(body, res.status);
        return { ok: false, status: res.status, error: msg, authFailed: res.status === 403 && /forbidden/i.test(msg), quotaExhausted: /quota|limit/i.test(msg) };
      }
      const values = body.success === true ? numericArray(body.data) : null;
      if (!values) return { ok: false, status: -1, error: 'malformed ANU payload' };
      return { ok: true, values, source: 'anu-vacuum', hardware: true, status: res.status };
    },
  };
}

// -----------------------------------------------------------------------------
// LfD QRNG (OTH Regensburg, Laboratory for Digitalisation) — keyless, backed by an
// ID Quantique Quantis PCIe card. GET https://lfdr.de/qrng_api/qrng?length=<bytes>&format=HEX
// Response: { qrn: "<hex>", length }. 500 = device unavailable. No published quota → be polite.
// -----------------------------------------------------------------------------
export function lfdrProvider(opts: { baseUrl?: string } = {}): QrngProvider {
  const base = (opts.baseUrl ?? 'https://lfdr.de').replace(/\/$/, '');
  return {
    id: 'lfdr',
    label: 'LfD QRNG (ID Quantique)',
    samplesPerRequest: 1024, // 2048 bytes → one full pool refill
    defaultMonthlyRequests: Infinity,
    minSpacingMs: 120_000, // self-imposed courtesy limit for a free academic service
    async fetch(signal) {
      const res = await fetch(`${base}/qrng_api/qrng?length=2048&format=HEX`, { headers: { Accept: 'application/json' }, signal });
      const body = await readJson(res);
      if (!res.ok || !body) return { ok: false, status: res.status, error: errorText(body, res.status) };
      const values = typeof body.qrn === 'string' && body.qrn.length === 4096 ? hexToUint16(body.qrn) : null;
      if (!values) return { ok: false, status: -1, error: 'malformed LfD payload' };
      return { ok: true, values, source: 'quantis-pcie', hardware: true, status: res.status };
    },
  };
}

// -----------------------------------------------------------------------------
// Legacy QRNG@ANU — being retired by ANU; kept as a keyless fallback.
// -----------------------------------------------------------------------------
export function anuLegacyProvider(opts: { url?: string } = {}): QrngProvider {
  const url = opts.url ?? 'https://qrng.anu.edu.au/API/jsonI.php';
  return {
    id: 'anu-legacy',
    label: 'QRNG@ANU (legacy)',
    samplesPerRequest: 1024,
    defaultMonthlyRequests: Infinity,
    minSpacingMs: 61_000, // ~1 request/minute
    async fetch(signal) {
      const res = await fetch(`${url}?length=1024&type=uint16`, { signal });
      const body = await readJson(res);
      if (!res.ok || !body) return { ok: false, status: res.status, error: errorText(body, res.status) };
      const values = body.success === true ? numericArray(body.data) : null;
      if (!values) return { ok: false, status: -1, error: 'malformed ANU payload' };
      return { ok: true, values, source: 'anu-vacuum', hardware: true, status: res.status };
    },
  };
}
