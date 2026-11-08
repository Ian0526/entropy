/**
 * The Builder worker: runs on the owner's PC, polls the site for requests, and runs the coding agent
 * (Claude Code, on the owner's plan) on them in a clone kept only for this. Ported from the DIY Builder.
 *
 *   npm run builder                      # normal: the agent is limited to an allow list
 *   npm run builder:full                 # full PC access (web, Chrome, any command); pushes/.env stay blocked
 *
 * Needs BUILDER_URL and BUILDER_WORKER_TOKEN, in the environment or .env.
 * Approving a change makes the worker push it to the default branch, which Railway deploys.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { agentEnv, agentSettings, claudeArgs, loginProblem, mcpConfig, readEvent, wantsSkipPermissions } from './agent';
import { handleRpc, type McpTool } from './mcp';
import type { BuilderImage, BuilderJob } from '../../src/server/builder/types';

const POLL_MS = 2_000;
const FETCH_TIMEOUT_MS = 60_000;
const SHOT_PORT = 3199;
const MAX_SHOTS = 4;
const INPUT_DIR = '.builder-input';
const WINDOWS = process.platform === 'win32';

const log = (line: string) => console.log(`[${new Date().toLocaleTimeString()}] ${line}`);

function killTree(child: ChildProcess) {
  if (!child.pid) return;
  if (WINDOWS) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGINT');
}

async function main() {
  if (fs.existsSync('.env')) process.loadEnvFile('.env');
  const home = process.env.BUILDER_HOME || path.join(os.homedir(), 'turinglife-builder');
  const claudeEnv = agentEnv(process.env, { configDir: process.env.BUILDER_CLAUDE_DIR || undefined });

  const baseUrl = process.env.BUILDER_URL?.replace(/\/+$/, '');
  const token = process.env.BUILDER_WORKER_TOKEN;
  if (!baseUrl || !token) {
    console.error('Set BUILDER_URL and BUILDER_WORKER_TOKEN, in the environment or .env.');
    process.exit(1);
  }
  const problem = loginProblem(spawnSync('claude', ['auth', 'status'], { encoding: 'utf8', env: claudeEnv, shell: WINDOWS }).stdout ?? '');
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
  const model = process.env.BUILDER_MODEL || 'claude-opus-5-5';
  const maxUsd = Number(process.env.BUILDER_MAX_RUN_USD) || 5;
  const runMs = (Number(process.env.BUILDER_RUN_MINUTES) || 30) * 60_000;
  const skipPermissions = wantsSkipPermissions(process.argv, process.env);
  if (skipPermissions) console.warn('Full access is ON: the agent can run commands anywhere on this PC, reach the web and use Chrome.');

  const clone = path.join(home, 'repo');
  const origin = spawnSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).stdout.trim();
  if (!origin) {
    console.error('This folder has no git remote "origin" to clone from.');
    process.exit(1);
  }
  const settingsPath = path.join(home, 'settings.json');
  const mcpPath = path.join(home, 'mcp.json');
  const lockHashPath = path.join(home, 'lock.hash');
  const auth = { Authorization: `Bearer ${token}` };

  const site = async (route: string, body?: object) => {
    const res = await fetch(`${baseUrl}/api/worker/builder/${route}`, {
      method: body ? 'POST' : 'GET',
      headers: body ? { ...auth, 'Content-Type': 'application/json' } : auth,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.status === 204) return null;
    const json = (await res.json()) as Record<string, unknown>;
    if (!res.ok) throw new Error(String(json.error ?? `The site answered ${res.status}.`));
    return json;
  };
  const report = (id: string, body: object) => site(`requests/${id}`, body);

  const git = (...args: string[]) => {
    const out = spawnSync('git', args, { cwd: clone, encoding: 'utf8' });
    if (out.status !== 0) throw new Error(`git ${args[0]} failed: ${(out.stderr || out.stdout).trim().slice(0, 500)}`);
    return out.stdout.trim();
  };
  const hasRemoteBranch = (b: string) => spawnSync('git', ['rev-parse', '--verify', `origin/${b}`], { cwd: clone, stdio: 'ignore' }).status === 0;

  /** Runs a project command with no secrets in its environment, since it runs code the agent wrote. */
  const project = (command: string, extraEnv: Record<string, string> = {}) => {
    const out = spawnSync(command, { cwd: clone, shell: true, encoding: 'utf8', env: { ...agentEnv(process.env), ...extraEnv }, maxBuffer: 64 * 1024 * 1024 });
    return { ok: out.status === 0, output: `${out.stdout}\n${out.stderr}`.trim() };
  };

  function setUp() {
    fs.mkdirSync(home, { recursive: true });
    if (!fs.existsSync(clone)) {
      log(`Cloning into ${clone}.`);
      spawnSync('git', ['clone', origin, clone], { stdio: 'inherit' });
    }
    const exclude = path.join(clone, '.git', 'info', 'exclude');
    if (!fs.readFileSync(exclude, 'utf8').includes(INPUT_DIR)) fs.appendFileSync(exclude, `\n${INPUT_DIR}/\n`);
    fs.writeFileSync(settingsPath, JSON.stringify(agentSettings(skipPermissions), null, 2));
  }

  setUp();
  git('fetch', '--prune', 'origin');
  const main = (spawnSync('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: clone, encoding: 'utf8' }).stdout.trim() || 'origin/main').replace(/^origin\//, '');
  const ahead = () => Number(git('rev-list', '--count', `origin/${main}..HEAD`));

  function installIfNeeded() {
    const hash = createHash('sha256').update(fs.readFileSync(path.join(clone, 'package-lock.json'))).digest('hex');
    if (fs.existsSync(path.join(clone, 'node_modules')) && fs.existsSync(lockHashPath) && fs.readFileSync(lockHashPath, 'utf8') === hash) return;
    log('Installing packages in the clone.');
    const out = project('npm ci');
    if (!out.ok) throw new Error(`npm ci failed: ${out.output.slice(-500)}`);
    fs.writeFileSync(lockHashPath, hash);
  }

  /** Puts the clone on a clean copy of the request's branch, or of the default branch for a new one. */
  function prepare(branch: string) {
    git('fetch', '--prune', 'origin');
    git('checkout', '-B', branch, hasRemoteBranch(branch) ? `origin/${branch}` : `origin/${main}`);
    git('reset', '--hard');
    git('clean', '-fd');
    installIfNeeded();
  }

  function tools(finished: { summary: string; pages: string[] }): Record<string, McpTool> {
    return {
      finish: {
        description: "Say you're done, with a plain summary for the owner (or the answer, for a question). Call this once, last.",
        inputSchema: {
          type: 'object',
          properties: { summary: { type: 'string' }, pages: { type: 'array', items: { type: 'string' }, description: 'Extra paths to screenshot for code changes, such as /?layer=2. "/" is always included.' } },
          required: ['summary'],
        },
        run: async (i) => {
          finished.summary = String(i.summary);
          finished.pages = Array.isArray(i.pages) ? i.pages.map(String) : [];
          return 'Thanks.';
        },
      },
    };
  }

  function serveTools(toolset: Record<string, McpTool>): Promise<Server> {
    const server = createServer((req, res) => {
      if (req.method !== 'POST') return void res.writeHead(405).end();
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        void (async () => {
          const reply = await handleRpc(JSON.parse(Buffer.concat(chunks).toString('utf8')), toolset);
          if (!reply) res.writeHead(202).end();
          else res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(reply));
        })().catch(() => res.writeHead(400).end());
      });
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
  }

  function savePhotos(images: BuilderImage[]): string {
    if (images.length === 0) return '';
    const dir = path.join(clone, INPUT_DIR);
    fs.mkdirSync(dir, { recursive: true });
    const names = images.map((image, i) => {
      const name = `photo-${i + 1}.${image.mediaType.split('/')[1]}`;
      fs.writeFileSync(path.join(dir, name), Buffer.from(image.base64, 'base64'));
      return `${INPUT_DIR}/${name}`;
    });
    return `\n\nImages sent with this request, which you can read: ${names.join(', ')}`;
  }

  function runAgent(id: string, prompt: string, sessionId: string | null): Promise<{ text: string; failed: boolean; sessionId: string | null }> {
    return new Promise((resolve) => {
      const args = claudeArgs({ settingsPath, mcpPath, guidePath: path.join(clone, 'docs', 'builder-guide.md'), model, maxUsd, sessionId, skipPermissions });
      const child = spawn('claude', args, { cwd: clone, env: claudeEnv, shell: WINDOWS, stdio: ['pipe', 'pipe', 'pipe'] });
      child.stdin.end(prompt);
      let session = sessionId;
      let result: { text: string; failed: boolean } | null = null;
      let stopped: string | null = null;
      const stop = (why: string) => {
        stopped = why;
        killTree(child);
      };
      const timer = setTimeout(() => stop(`It ran past the ${runMs / 60_000} minute limit.`), runMs);
      let reporting = Promise.resolve();

      createInterface({ input: child.stdout }).on('line', (line) => {
        const event = readEvent(line);
        if (event.sessionId) session = event.sessionId;
        if (event.result) result = event.result;
        if (event.lines.length === 0 && event.costUsd === undefined && !event.sessionId) return;
        for (const l of event.lines) log(`  ${l}`);
        reporting = reporting
          .then(() => report(id, { action: 'progress', lines: event.lines, sessionId: event.sessionId, costUsd: event.costUsd }))
          .then((reply) => {
            if (reply?.cancel) stop('Stopped by request.');
          })
          .catch((err) => log(`Couldn't report progress: ${err}`));
      });
      let stderr = '';
      child.stderr.on('data', (c: Buffer) => (stderr = (stderr + c.toString()).slice(-2000)));
      child.on('close', () => {
        clearTimeout(timer);
        void reporting.then(() => {
          const done = result as { text: string; failed: boolean } | null;
          if (stopped) resolve({ text: stopped, failed: true, sessionId: session });
          else if (done) resolve({ ...done, sessionId: session });
          else resolve({ text: stderr.trim() || 'The agent stopped without an answer.', failed: true, sessionId: session });
        });
      });
    });
  }

  function checks() {
    for (const [name, command] of [['Types', 'npm run typecheck'], ['Self-test', 'npm run selftest'], ['Build', 'npm run build']]) {
      log(`Checking: ${name}.`);
      const out = project(command);
      if (!out.ok) return { ok: false, text: `${name} failed.\n${out.output.slice(-3000)}` };
    }
    return { ok: true, text: 'Types, self-test and build all passed.' };
  }

  const dirty = () => git('status', '--porcelain').length > 0;
  function commit(title: string) {
    if (!dirty()) return;
    git('add', '-A');
    git('commit', '-m', `builder: ${title.replace(/\s+/g, ' ')}`);
  }

  /** Photographs the change from a local copy of the built app (no quantum fetches, no password). */
  async function screenshots(pages: string[]): Promise<string[]> {
    const { chromium } = await import('playwright');
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'builder-shots-'));
    const server = spawn('node dist/server/index.js', {
      cwd: clone, shell: true, stdio: 'ignore',
      env: { ...agentEnv(process.env), PORT: String(SHOT_PORT), HOST: '127.0.0.1', QRNG_PROVIDER: 'none', BUILDER_DATA_DIR: data, LOG_LEVEL: 'warn' },
    });
    const base = `http://127.0.0.1:${SHOT_PORT}`;
    const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
    try {
      let up = false;
      for (let i = 0; i < 60 && !up; i++) {
        up = await fetch(`${base}/health`).then((r) => r.ok, () => false);
        if (!up) await new Promise((r) => setTimeout(r, 1000));
      }
      if (!up) throw new Error("The local copy didn't start.");
      const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
      const shots: string[] = [];
      for (const url of [...new Set(['/', ...pages])].slice(0, MAX_SHOTS)) {
        await page.goto(base + (url.startsWith('/') ? url : `/${url}`), { waitUntil: 'load', timeout: 60_000 });
        await page.waitForTimeout(5000);
        shots.push((await page.screenshot()).toString('base64'));
      }
      return shots;
    } finally {
      await browser.close();
      killTree(server);
      fs.rmSync(data, { recursive: true, force: true });
    }
  }

  async function handleRun(job: Extract<BuilderJob, { kind: 'run' }>) {
    prepare(job.branch);
    const finished = { summary: '', pages: [] as string[] };
    const server = await serveTools(tools(finished));
    fs.writeFileSync(mcpPath, JSON.stringify(mcpConfig((server.address() as AddressInfo).port)));
    try {
      let run = await runAgent(job.id, job.prompt + savePhotos(job.images), job.sessionId);
      if (run.failed) return report(job.id, { action: 'finish', error: run.text.slice(0, 1000) });
      fs.rmSync(path.join(clone, INPUT_DIR), { recursive: true, force: true });

      commit(job.prompt.slice(0, 60));
      if (ahead() > 0) {
        let verdict = checks();
        if (!verdict.ok) {
          // One chance to fix what it broke, then a person hears about it.
          run = await runAgent(job.id, `The checks failed. Fix this, then call finish again.\n\n${verdict.text}`, run.sessionId);
          commit(`fix: ${job.prompt.slice(0, 55)}`);
          verdict = run.failed ? { ok: false, text: run.text } : checks();
        }
        if (!verdict.ok) return report(job.id, { action: 'finish', error: verdict.text.slice(0, 1000) });
        git('push', '--force', 'origin', `HEAD:refs/heads/${job.branch}`);
        const shots = await screenshots(finished.pages).catch((err) => {
          log(`Couldn't take screenshots: ${err}`);
          return [] as string[];
        });
        await report(job.id, { action: 'propose', branch: job.branch, files: git('diff', '--name-only', `origin/${main}...HEAD`).split('\n').filter(Boolean), checks: verdict.text, shots });
      }
      return report(job.id, { action: 'finish', summary: finished.summary || run.text.slice(0, 4000) });
    } finally {
      server.close();
    }
  }

  async function handleMerge(job: Extract<BuilderJob, { kind: 'merge' }>) {
    prepare(job.branch);
    const tip = git('rev-parse', `origin/${main}`);
    if (git('merge-base', 'HEAD', `origin/${main}`) !== tip) {
      const rebased = spawnSync('git', ['rebase', `origin/${main}`], { cwd: clone, encoding: 'utf8' });
      if (rebased.status !== 0) {
        spawnSync('git', ['rebase', '--abort'], { cwd: clone });
        return report(job.id, { action: 'merged', error: 'The code changed in a way that conflicts with this. Ask for it to be redone.' });
      }
      installIfNeeded();
      const verdict = checks();
      if (!verdict.ok) return report(job.id, { action: 'merged', error: `The code changed, and this no longer passes. ${verdict.text.slice(0, 600)}` });
    }
    git('push', 'origin', `HEAD:${main}`);
    spawnSync('git', ['push', 'origin', '--delete', job.branch], { cwd: clone, stdio: 'ignore' });
    return report(job.id, { action: 'merged' });
  }

  const reset = await site('reset', {});
  if (reset?.failed) log(`Marked ${reset.failed} interrupted request(s) as failed.`);
  log(`Ready. ${baseUrl} → ${model} on your Claude plan, up to about $${maxUsd} of usage a request. Pushes go to ${main}.`);

  for (;;) {
    try {
      const reply = await site('next');
      const job = reply?.job as BuilderJob | undefined;
      if (job) {
        log(`${job.kind === 'run' ? 'Working on' : 'Merging'} ${job.id}.`);
        try {
          if (job.kind === 'run') await handleRun(job);
          else await handleMerge(job);
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          log(`Failed: ${error}`);
          await report(job.id, job.kind === 'run' ? { action: 'finish', error } : { action: 'merged', error }).catch(() => {});
        }
        log('Done.');
        continue;
      }
    } catch (err) {
      log(`Couldn't reach the site: ${err}`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

void main();
