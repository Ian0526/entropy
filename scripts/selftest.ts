/**
 * Headless verification of the QuantumEntropyEngine and SimulationCore.
 *   npm run selftest
 */
import { QuantumEntropyEngine, POOL_SIZE } from '../src/engine/QuantumEntropy';
import { SimulationCore } from '../src/engine/SimulationCore';
import { LAYER_COUNT } from '../src/engine/protocol';

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!cond) failures++;
}

// ---- 1. PRNG statistics -------------------------------------------------------
{
  const q = new QuantumEntropyEngine();
  const n = 2_000_000;
  let sum = 0;
  const buckets = new Uint32Array(16);
  let ones = 0;
  const t0 = performance.now();
  for (let i = 0; i < n; i++) {
    const u = q.nextUint32();
    sum += u / 4294967296;
    buckets[u >>> 28]++;
    ones += u & 1;
  }
  const ns = ((performance.now() - t0) * 1e6) / n;
  const mean = sum / n;
  let chi = 0;
  const exp = n / 16;
  for (const b of buckets) chi += ((b - exp) * (b - exp)) / exp;
  check('uniform mean ≈ 0.5', Math.abs(mean - 0.5) < 0.002, mean.toFixed(5));
  check('chi² (15 dof) < 37.7 (p=0.001)', chi < 37.7, chi.toFixed(2));
  check('LSB balance', Math.abs(ones / n - 0.5) < 0.002, (ones / n).toFixed(5));
  console.log(`      nextUint32 ≈ ${ns.toFixed(2)} ns/draw (includes loop overhead)`);
}

// ---- 2. Anti-cycle guard on pathological pools ------------------------------------
{
  for (const [label, fill] of [['all-zero pool', 0], ['all-1024 pool', 1024], ['all-65535 pool', 65535]] as const) {
    const q = new QuantumEntropyEngine();
    q.pool.fill(fill);
    const visited = new Set<number>();
    let prev = -1;
    let prev2 = -1;
    let stuck = false;
    for (let i = 0; i < 5000; i++) {
      q.absorbQuantumSeed();
      const j = q.currentJumpIdx;
      if (j === prev || j === prev2) stuck = true;
      prev2 = prev;
      prev = j;
      visited.add(j);
    }
    const t = q.telemetry();
    check(`${label}: no self-loop / 2-cycle`, !stuck, `distinct idx=${visited.size}, antiCycle=${t.antiCycleEvents}`);
    // Outputs must still differ even though the pool is constant.
    const outs = new Set<number>();
    for (let i = 0; i < 1000; i++) outs.add(q.nextUint32());
    check(`${label}: PRNG output non-degenerate`, outs.size > 995, `${outs.size}/1000 unique`);
  }
}

// ---- 3. Fresh batch consumption & mode switching ---------------------------------
{
  const harvester = new QuantumEntropyEngine();
  const consumer = new QuantumEntropyEngine(harvester.sab);
  check('initial mode is sponge', harvester.telemetry().mode === 'NONCE_WRAP_SPONGE');
  const batch = new Uint16Array(POOL_SIZE);
  crypto.getRandomValues(batch);
  harvester.ingest(batch);
  check('ingest → LIVE_QUANTUM', consumer.telemetry().mode === 'LIVE_QUANTUM');
  for (let i = 0; i < POOL_SIZE - 1; i++) consumer.absorbQuantumSeed();
  check('still live with 1 fresh left', harvester.telemetry().freshRemaining === 1 && harvester.telemetry().mode === 'LIVE_QUANTUM');
  consumer.absorbQuantumSeed();
  check('exhausted → NONCE_WRAP_SPONGE', harvester.telemetry().mode === 'NONCE_WRAP_SPONGE');
  check('shared pool is zero-copy', harvester.pool.buffer === consumer.pool.buffer);
}

// ---- 4. Simulation dynamics ---------------------------------------------------------
{
  const q = new QuantumEntropyEngine();
  const sim = new SimulationCore(256, 256, q);
  const frame = new Uint8Array(SimulationCore.frameBytes(256, 256));
  check('frame size', frame.length === 256 * 256 * LAYER_COUNT);
  const startPop = sim.stats.population;
  console.log(`      founders: ${startPop} cells`);
  let totalMs = 0;
  const TICKS = 1500;
  let maxPop = 0;
  let minAfter = Infinity;
  for (let t = 1; t <= TICKS; t++) {
    const t0 = performance.now();
    sim.step();
    totalMs += performance.now() - t0;
    const s = sim.stats;
    maxPop = Math.max(maxPop, s.population);
    if (t > 300) minAfter = Math.min(minAfter, s.population);
    if (t % 150 === 0) {
      console.log(
        `      t=${String(t).padStart(4)} pop=${String(s.population).padStart(6)} core=${s.core} armor=${s.armor} sensor=${s.sensor}`
        + ` sp=${s.species} E̅=${s.meanEnergy.toFixed(3)} food=${s.totalFood.toFixed(0)} dist=${s.meanDistance.toFixed(2)}`
        + ` births=${s.births} deaths=${s.deaths} pred=${s.predations}`,
      );
    }
    // energy invariants
    if (t % 100 === 0) {
      let bad = 0;
      for (let i = 0; i < sim.N; i++) {
        const e = sim.energy[i];
        if (!(e >= 0 && e <= 1) || (sim.somatic[i] && e === 0)) bad++;
        const f = sim.food[i];
        if (!(f >= 0 && f <= 1.0001)) bad++;
      }
      if (bad) check(`energy/food bounds @${t}`, false, `${bad} bad cells`);
    }
  }
  const msPerTick = totalMs / TICKS;
  console.log(`      ${msPerTick.toFixed(2)} ms/tick → ${(1000 / msPerTick).toFixed(0)} ticks/s single-core`);
  check('life grew', maxPop > startPop * 3, `max=${maxPop}`);
  check('life persists after warm-up', minAfter > 50, `min=${minAfter}`);
  check('speciation happened', sim.stats.species >= 1 && sim.stats.meanDistance > 0, `species=${sim.stats.species}`);

  const t0 = performance.now();
  sim.packFrame(frame);
  console.log(`      packFrame ${(performance.now() - t0).toFixed(2)} ms`);

  // Tools
  const live = sim.somatic.findIndex((s) => s !== 0);
  if (live >= 0) {
    const x = live % 256;
    const y = (live / 256) | 0;
    const info = sim.inspect(x, y);
    check('inspect live cell', info.alive && info.genome !== null && (info.cluster?.size ?? 0) >= 1, `cluster=${info.cluster?.size}`);
    sim.applyTool('poke', x, y, 4, 1);
    check('poke kills centre cell', sim.somatic[live] === 0);
  }
  sim.applyTool('wall', 10, 10, 3, 1);
  check('wall placed', sim.terrain[10 * 256 + 10] === 1 && sim.food[10 * 256 + 10] === 0);
  sim.applyTool('predator', 128, 128, 3, 1);
  check('predator injected', sim.somatic[128 * 256 + 128] !== 0 && (sim.inspect(128, 128).genome?.aggression ?? 0) > 0.9);
}

// ---- 5. Harvester against a mock ANU endpoint (success, 429, malformed) -------------
{
  const { createServer } = await import('node:http');
  let behaviour: 'ok' | '429' | 'bad' = 'ok';
  const server = createServer((_req, res) => {
    if (behaviour === '429') {
      res.writeHead(429).end('Too Many Requests');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    if (behaviour === 'bad') res.end('{"success":false}');
    else res.end(JSON.stringify({ type: 'uint16', length: 1024, data: Array.from({ length: 1024 }, (_, i) => (i * 7919) & 0xffff), success: true }));
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  const q = new QuantumEntropyEngine();
  q.configureHarvester({ legacyUrl: `http://127.0.0.1:${port}/API/jsonI.php`, cooldownMs: 0, apiKey: undefined });
  check('mock ANU success → true', (await q.fetchFromANU()) === true);
  let t = q.telemetry();
  check('mock ANU → LIVE_QUANTUM, origin QRNG', t.mode === 'LIVE_QUANTUM' && t.origin === 'QRNG' && t.freshRemaining === 1024);
  check('pool holds ANU samples', q.pool[3] === ((3 * 7919) & 0xffff));
  behaviour = '429';
  check('mock 429 → false', (await q.fetchFromANU()) === false);
  t = q.telemetry();
  check('429 recorded + backoff raised', t.lastHttpStatus === 429 && t.backoffLevel === 1 && t.fetchFail === 1);
  check('fresh batch survives a 429', t.mode === 'LIVE_QUANTUM' && t.freshRemaining === 1024);
  behaviour = 'bad';
  check('malformed payload → false', (await q.fetchFromANU()) === false && q.telemetry().lastHttpStatus === -1);
  behaviour = 'ok';
  await q.fetchFromANU();
  check('success resets backoff', q.telemetry().backoffLevel === 0);
  server.close();
}

// ---- 6. qrngapi.com provider against a mock (precheck, simulator, budget, auth) -----
{
  const { createServer } = await import('node:http');
  const { qrngApiProvider } = await import('../src/engine/QrngProviders');
  let hardware: string[] = [];
  let source = 'simulator';
  let randomCalls = 0;
  let status = 200;
  let lastKey = '';
  const hex = Array.from({ length: 1024 }, (_, i) => ((i * 37) & 0xff).toString(16).padStart(2, '0')).join('');
  const server = createServer((req, res) => {
    lastKey = String(req.headers['x-api-key'] ?? '');
    res.setHeader('content-type', 'application/json');
    if (req.url?.startsWith('/api/methods')) {
      res.end(JSON.stringify({ available: ['auto', ...hardware, 'simulator'], hardware, simulator: { available: true } }));
      return;
    }
    randomCalls++;
    if (status !== 200) {
      res.writeHead(status).end(JSON.stringify({ error: status === 403 ? 'Forbidden' : 'Monthly quota exceeded' }));
      return;
    }
    res.end(JSON.stringify({ data: hex, bytes: 1024, format: 'hex', method: source, source }));
  });
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const mk = (accept = false, monthly?: number) => {
    const q = new QuantumEntropyEngine();
    q.configureHarvester({ provider: qrngApiProvider({ apiKey: 'qnrk_test', baseUrl: base }), cooldownMs: 0, acceptSimulator: accept, monthlyRequests: monthly });
    return q;
  };

  let q = mk();
  check('qrngapi: no hardware → skip without spending', (await q.fetchBatch()) === false && randomCalls === 0 && q.telemetry().budgetUsed === 0);
  check('qrngapi: API key sent as X-API-Key', lastKey === 'qnrk_test');
  check('qrngapi: free-tier schedule = 3 days', Math.round(q.baseIntervalMs() / 3600_000) === 72, `${(q.baseIntervalMs() / 3600_000).toFixed(1)} h`);

  hardware = ['photon'];
  source = 'simulator'; // provider claims hardware but serves simulator output
  check('qrngapi: simulator batch rejected', (await q.fetchBatch()) === false && q.telemetry().mode === 'NONCE_WRAP_SPONGE'
    && q.telemetry().lastError.includes('non-quantum'), q.telemetry().lastError);

  source = 'photon';
  check('qrngapi: hardware batch ingested', (await q.fetchBatch()) === true);
  let t = q.telemetry();
  check('qrngapi: 512 fresh samples, LIVE_QUANTUM', t.mode === 'LIVE_QUANTUM' && t.freshRemaining === 512 && t.origin === 'QRNG');
  check('qrngapi: hex decoded big-endian into first half', q.pool[1] === ((((2 * 37) & 0xff) << 8) | ((3 * 37) & 0xff)));
  await q.fetchBatch();
  check('qrngapi: second batch lands in the other half', q.pool[512 + 1] === q.pool[1] && q.telemetry().budgetUsed === 3);

  q = mk(true);
  source = 'simulator';
  await q.fetchBatch();
  check('qrngapi: accepted simulator labelled LIVE_SIMULATED, not quantum', q.telemetry().mode === 'LIVE_SIMULATED' && q.telemetry().origin === 'QRNG_SIMULATOR');

  q = mk(false, 2);
  source = 'photon';
  await q.fetchBatch();
  await q.fetchBatch();
  const callsBefore = randomCalls;
  check('qrngapi: budget exhausted → no request sent', (await q.fetchBatch()) === false && randomCalls === callsBefore
    && q.telemetry().lastError.includes('budget'), q.telemetry().lastError);
  check('qrngapi: resync refuses when budget exhausted', (await q.forceResync()).reason === 'budget-exhausted');

  q = mk();
  status = 403;
  await q.fetchBatch();
  check('qrngapi: 403 → key rejected, harvester halted', q.telemetry().lastError.includes('API key rejected'));
  const c403 = randomCalls;
  await q.fetchBatch();
  check('qrngapi: halted harvester sends nothing', randomCalls === c403);

  q = mk();
  status = 429;
  await q.fetchBatch();
  check('qrngapi: quota message → paused until next month', q.telemetry().lastError.includes('quota exhausted'), q.telemetry().lastError);
  server.close();
}

// ---- 7. LfD QRNG provider against a mock ----------------------------------------
{
  const { createServer } = await import('node:http');
  const { lfdrProvider } = await import('../src/engine/QrngProviders');
  let status = 200;
  let lastUrl = '';
  const hex = Array.from({ length: 2048 }, (_, i) => ((i * 53 + 7) & 0xff).toString(16).padStart(2, '0')).join('');
  const server = createServer((req, res) => {
    lastUrl = req.url ?? '';
    res.setHeader('content-type', 'application/json');
    if (status !== 200) return void res.writeHead(status).end(JSON.stringify({ error: 'Failed to read device' }));
    res.end(JSON.stringify({ length: 2048, qrn: hex }));
  });
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const q = new QuantumEntropyEngine();
  q.configureHarvester({ provider: lfdrProvider({ baseUrl: base }), cooldownMs: 0 });
  check('lfdr: unmetered, 2-minute courtesy interval', q.telemetry().budgetTotal === null && q.baseIntervalMs() === 120_000, `${q.baseIntervalMs()} ms`);
  check('lfdr: batch ingested', (await q.fetchBatch()) === true && lastUrl === '/qrng_api/qrng?length=2048&format=HEX', lastUrl);
  const t = q.telemetry();
  check('lfdr: full 1024-sample pool, LIVE_QUANTUM', t.mode === 'LIVE_QUANTUM' && t.freshRemaining === 1024 && t.origin === 'QRNG');
  check('lfdr: hex decoded big-endian', q.pool[3] === ((((6 * 53 + 7) & 0xff) << 8) | ((7 * 53 + 7) & 0xff)));
  status = 500;
  check('lfdr: device error → no ingest, backoff', (await q.fetchBatch()) === false && q.telemetry().backoffLevel > 0);
  server.close();
}

// ---- 8. Builder: password gate, worker token, request queue, agent stream ------------
{
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { accessToken, gateDecision, personAuth, workerAuth, ACCESS_COOKIE } = await import('../src/server/builder/auth');
  const { BuilderStore } = await import('../src/server/builder/store');
  const { readEvent, agentEnv, agentSettings } = await import('./builder/agent');

  const env = { SITE_PASSWORD: 'hunter2', SITE_SESSION_SECRET: 's' } as NodeJS.ProcessEnv;
  const cookie = `${ACCESS_COOKIE}=${accessToken('hunter2', 's')}`;
  const g = (url: string, c?: string, accept = 'text/html') => gateDecision({ url, method: 'GET', cookie: c, accept }, env);
  check('gate: open site when no password', gateDecision({ url: '/', method: 'GET', cookie: undefined }, {} as NodeJS.ProcessEnv) === 'allow');
  check('gate: page redirects to unlock', g('/') === 'unlock' && g('/builder') === 'unlock');
  check('gate: API, WebSocket and telemetry denied', g('/api/telemetry', undefined, '*/*') === 'deny' && g('/ws', undefined, '*/*') === 'deny' && g('/api/builder', undefined, '*/*') === 'deny');
  check('gate: health, unlock, assets and worker stay open', ['/health', '/unlock?next=/', '/assets/x.js', '/api/worker/builder/next', '/api/session/unlock'].every((u) => g(u) === 'allow'));
  check('gate: right cookie unlocks everything', g('/', cookie) === 'allow' && g('/ws', cookie, '*/*') === 'allow');
  check('gate: wrong cookie or rotated secret refused', personAuth(`${ACCESS_COOKIE}=nope`, env) === 'locked' && personAuth(cookie, { ...env, SITE_SESSION_SECRET: 't' }) === 'locked');
  check('worker token: unconfigured / wrong / right', workerAuth('Bearer x', undefined) === 'unconfigured' && workerAuth('Bearer x', 'y') === 'denied' && workerAuth('Bearer y', 'y') === 'ok');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'builder-test-'));
  let t = 1_000_000;
  const store = new BuilderStore(dir, () => t);
  const img = { mediaType: 'image/png' as const, base64: Buffer.from('png!').toString('base64') };
  const a = store.create('Make it stable', [img]);
  t += 10;
  const b = store.create('Why is it green?');
  check('queue: worker online only after polling', !store.workerOnline());
  const job1 = store.claimNext(20);
  check('queue: oldest first, with photos and branch', job1?.kind === 'run' && job1.id === a.id && job1.images[0]?.base64 === img.base64 && job1.branch === `agent/${a.id}`);
  check('queue: one at a time', store.claimNext(20) === null && store.workerOnline());
  check('queue: progress keeps running cost total', store.progress(a.id, { lines: ['Reading x'], costUsd: 1.5, sessionId: 'S' })?.cancel === false && store.get(a.id)?.costUsd === 1.5);
  store.propose(a.id, { branch: `agent/${a.id}`, files: ['src/x.ts'], checks: 'ok' }, [Buffer.from('shot').toString('base64')]);
  store.finish(a.id, { summary: 'Done it.' });
  check('queue: code change → proposed, screenshot stored', store.get(a.id)?.status === 'proposed' && store.shot(a.id, 0)?.toString() === 'shot');
  const job2 = store.claimNext(20);
  store.finish(b.id, { summary: 'It is food.' });
  check('queue: question → done with answer', job2?.id === b.id && store.get(b.id)?.status === 'done' && store.get(b.id)?.messages.at(-1)?.text === 'It is food.');
  check('queue: approve → merge before new runs', store.approve(a.id) && store.claimNext(20)?.kind === 'merge');
  store.merged(a.id);
  check('queue: merged → applied', store.get(a.id)?.status === 'applied');
  check('queue: follow-up resumes the session', store.followUp(a.id, 'Also X') && store.claimNext(20)?.kind === 'run' && store.get(a.id)?.sessionId === 'S');
  check('queue: cancel flag reaches the worker', store.cancel(a.id) && store.progress(a.id, {})?.cancel === true);
  check('queue: daily limit pauses new runs', (() => { store.finish(a.id, {}); store.followUp(b.id, 'more'); return store.claimNext(1) === null; })());
  const reloaded = new BuilderStore(dir, () => t);
  check('queue: survives a restart', reloaded.list().length === 2 && reloaded.get(a.id)?.status === 'cancelled');
  reloaded.claimNext(100);
  check('queue: restart marks running work failed', reloaded.failInterrupted() === 1 && reloaded.get(b.id)?.status === 'failed');
  fs.rmSync(dir, { recursive: true, force: true });

  const ev = readEvent(JSON.stringify({ type: 'assistant', session_id: 'abc', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm run selftest' } }] } }));
  const res = readEvent(JSON.stringify({ type: 'result', subtype: 'error_max_budget_usd', total_cost_usd: 5 }));
  check('agent: stream events read', ev.sessionId === 'abc' && ev.lines[0] === 'Running the self-test' && res.result?.failed === true && res.costUsd === 5 && readEvent('garbage').lines.length === 0);
  const aEnv = agentEnv({ PATH: '/bin', BUILDER_WORKER_TOKEN: 'secret', RAILWAY_TOKEN: 'r', QRNGAPI_KEY: 'k' }, {});
  check('agent: no secrets in its environment', aEnv.PATH === '/bin' && !('BUILDER_WORKER_TOKEN' in aEnv) && !('RAILWAY_TOKEN' in aEnv) && !('QRNGAPI_KEY' in aEnv));
  check('agent: cannot push, even with full access', agentSettings(true).permissions.deny.includes('Bash(git push*)') && agentSettings(true).permissions.deny.includes('Read(**/.env*)'));
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
