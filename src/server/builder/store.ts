/**
 * Builder request queue, kept on disk so it survives restarts and redeploys (on Railway, point
 * BUILDER_DATA_DIR at a mounted volume). Requests live in one JSON file; photos and screenshots,
 * which are heavy, sit in a folder per request so progress updates never rewrite them.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { branchFor, type BuilderImage, type BuilderJob, type BuilderMessage, type CodeProposal, type RequestRow, type RequestStatus, type RequestSummary } from './types';

/** A worker that hasn't checked in for this long is treated as off. */
export const WORKER_OFFLINE_MS = 60_000;
const MAX_PROGRESS = 200;
const DAY_MS = 24 * 60 * 60 * 1000;
const BUSY: RequestStatus[] = ['running', 'merging'];
const CAN_FOLLOW_UP: RequestStatus[] = ['proposed', 'done', 'applied', 'failed', 'cancelled'];
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_IMAGES = 3;

type Row = RequestRow;

/** Keeps only images in a form the agent can read. Anything else is dropped. */
export function readImages(raw: unknown): BuilderImage[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((i): i is BuilderImage => typeof i?.base64 === 'string' && IMAGE_TYPES.includes(i?.mediaType))
    .slice(0, MAX_IMAGES)
    .map((i) => ({ mediaType: i.mediaType, base64: i.base64 }));
}

export class BuilderStore {
  private rows = new Map<string, Row>();
  private workerSeen = 0;
  private readonly file: string;

  constructor(private readonly dir: string, private readonly now: () => number = Date.now) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'requests.json');
    if (fs.existsSync(this.file)) {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Row[];
      for (const r of saved) this.rows.set(r.id, r);
    }
  }

  // ---- persistence -----------------------------------------------------------
  private save(): void {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...this.rows.values()]));
    fs.renameSync(tmp, this.file);
  }

  private blobDir(id: string): string {
    return path.join(this.dir, id);
  }

  private writeBlobs(id: string, prefix: 'image' | 'shot', items: string[]): void {
    const dir = this.blobDir(id);
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(dir)) if (f.startsWith(`${prefix}-`)) fs.rmSync(path.join(dir, f));
    items.forEach((b64, i) => fs.writeFileSync(path.join(dir, `${prefix}-${i}`), Buffer.from(b64, 'base64')));
  }

  private readBlob(id: string, prefix: 'image' | 'shot', n: number): Buffer | null {
    const f = path.join(this.blobDir(id), `${prefix}-${n}`);
    return Number.isInteger(n) && n >= 0 && fs.existsSync(f) ? fs.readFileSync(f) : null;
  }

  private setImages(row: Row, images: BuilderImage[]): void {
    this.writeBlobs(row.id, 'image', images.map((i) => i.base64));
    row.imageTypes = images.map((i) => i.mediaType);
  }

  private update(row: Row, values: Partial<Row>): Row {
    Object.assign(row, values, { updatedAt: this.now() });
    this.save();
    return row;
  }

  private images(row: Row): BuilderImage[] {
    const out: BuilderImage[] = [];
    row.imageTypes.forEach((mediaType, i) => {
      const b = this.readBlob(row.id, 'image', i);
      if (b) out.push({ mediaType, base64: b.toString('base64') });
    });
    return out;
  }

  // ---- reads -----------------------------------------------------------------
  get(id: string): RequestRow | undefined {
    const r = this.rows.get(id);
    return r ? structuredClone(r) : undefined;
  }

  /** What the page sees of one request. */
  summary(id: string): RequestSummary | undefined {
    const r = this.rows.get(id);
    if (!r) return undefined;
    const { imageTypes, ...rest } = structuredClone(r);
    return { ...rest, hasImages: imageTypes.length > 0 };
  }

  list(): RequestSummary[] {
    return [...this.rows.values()].sort((a, b) => b.createdAt - a.createdAt).map((r) => this.summary(r.id)!);
  }

  shot(id: string, n: number): Buffer | null {
    return this.rows.has(id) ? this.readBlob(id, 'shot', n) : null;
  }

  spentLastDay(): number {
    const since = this.now() - DAY_MS;
    let sum = 0;
    for (const r of this.rows.values()) if (r.updatedAt >= since) sum += r.costUsd;
    return sum;
  }

  workerOnline(): boolean {
    return this.workerSeen > 0 && this.now() - this.workerSeen < WORKER_OFFLINE_MS;
  }

  // ---- a person acts ---------------------------------------------------------
  create(prompt: string, images: BuilderImage[] = []): RequestSummary {
    const t = this.now();
    const row: Row = {
      id: randomBytes(6).toString('hex'),
      status: 'queued',
      title: prompt.trim().slice(0, 80),
      messages: [{ role: 'person', text: prompt, at: t }],
      progress: [],
      imageTypes: [],
      shotCount: 0,
      proposal: null,
      sessionId: null,
      costUsd: 0,
      error: null,
      cancelRequested: false,
      createdAt: t,
      updatedAt: t,
    };
    this.rows.set(row.id, row);
    this.setImages(row, images);
    this.save();
    return this.summary(row.id)!;
  }

  /** Asks for more on the same request. A proposal still waiting is dropped, since the agent will replace it. */
  followUp(id: string, text: string, images: BuilderImage[] = []): boolean {
    const row = this.rows.get(id);
    if (!row || !CAN_FOLLOW_UP.includes(row.status)) return false;
    const msg: BuilderMessage = { role: 'person', text, at: this.now() };
    this.setImages(row, images);
    this.writeBlobs(id, 'shot', []);
    this.update(row, { status: 'queued', messages: [...row.messages, msg], proposal: null, shotCount: 0, error: null, cancelRequested: false });
    return true;
  }

  /** Stops a request. One that's running ends when the worker next reports in. */
  cancel(id: string): boolean {
    const row = this.rows.get(id);
    if (!row) return false;
    if (row.status === 'queued') return !!this.update(row, { status: 'cancelled' });
    if (row.status === 'running') return !!this.update(row, { cancelRequested: true });
    return false;
  }

  /** Queues an approved code change. The worker merges and pushes it, which deploys it. */
  approve(id: string): boolean {
    const row = this.rows.get(id);
    if (row?.status !== 'proposed' || !row.proposal) return false;
    this.update(row, { status: 'merge_queued' });
    return true;
  }

  // ---- the worker acts -------------------------------------------------------
  /** The worker's poll: records that it's alive and hands over the oldest work, one piece at a time. */
  claimNext(dailyUsd: number): BuilderJob | null {
    this.workerSeen = this.now();
    const rows = [...this.rows.values()];
    if (rows.some((r) => BUSY.includes(r.status))) return null;
    const oldest = (s: RequestStatus) => rows.filter((r) => r.status === s).sort((a, b) => a.updatedAt - b.updatedAt)[0];
    const merge = oldest('merge_queued');
    if (merge) {
      this.update(merge, { status: 'merging' });
      return { kind: 'merge', id: merge.id, branch: branchFor(merge.id) };
    }
    if (this.spentLastDay() >= dailyUsd) return null;
    const run = oldest('queued');
    if (!run) return null;
    this.update(run, { status: 'running', progress: [] });
    const said = run.messages.filter((m) => m.role === 'person').at(-1)?.text ?? '';
    return { kind: 'run', id: run.id, prompt: said, sessionId: run.sessionId, images: this.images(run), branch: branchFor(run.id) };
  }

  /** What the worker reports during a run. The reply says whether a person asked to stop. */
  progress(id: string, report: { lines?: string[]; sessionId?: string; costUsd?: number }): { cancel: boolean } | null {
    const row = this.rows.get(id);
    if (!row) return null;
    const lines = Array.isArray(report.lines) ? report.lines.filter((l) => typeof l === 'string').map((l) => l.slice(0, 300)) : [];
    this.update(row, {
      progress: [...row.progress, ...lines].slice(-MAX_PROGRESS),
      ...(typeof report.sessionId === 'string' ? { sessionId: report.sessionId } : {}),
      // Claude Code reports the whole conversation's running total, so this replaces the figure.
      ...(typeof report.costUsd === 'number' && Number.isFinite(report.costUsd) ? { costUsd: Math.max(row.costUsd, report.costUsd) } : {}),
    });
    return { cancel: row.cancelRequested };
  }

  propose(id: string, proposal: CodeProposal, shots: string[]): boolean {
    const row = this.rows.get(id);
    if (!row) return false;
    const clean = shots.filter((s) => typeof s === 'string').slice(0, 4);
    this.writeBlobs(id, 'shot', clean);
    this.update(row, { proposal, shotCount: clean.length });
    return true;
  }

  /** Ends a run. With no proposal waiting, there's nothing to approve. */
  finish(id: string, result: { summary?: string; error?: string }): boolean {
    const row = this.rows.get(id);
    if (!row) return false;
    const messages = result.summary ? [...row.messages, { role: 'builder' as const, text: result.summary.slice(0, 20_000), at: this.now() }] : row.messages;
    const status: RequestStatus = row.cancelRequested ? 'cancelled' : result.error ? 'failed' : row.proposal ? 'proposed' : 'done';
    this.setImages(row, []);
    this.update(row, { status, messages, error: result.error?.slice(0, 4000) ?? null, cancelRequested: false });
    return true;
  }

  merged(id: string, error?: string): boolean {
    const row = this.rows.get(id);
    if (!row) return false;
    this.update(row, error ? { status: 'failed', error: error.slice(0, 4000) } : { status: 'applied' });
    return true;
  }

  /** On a worker restart nothing is really running any more. Work is marked failed, never silently resumed. */
  failInterrupted(): number {
    let n = 0;
    for (const r of this.rows.values()) {
      if (!BUSY.includes(r.status)) continue;
      Object.assign(r, { status: 'failed', error: 'The worker restarted during this request.', cancelRequested: false, updatedAt: this.now() });
      n++;
    }
    if (n) this.save();
    return n;
  }
}
