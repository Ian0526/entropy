# TuringLife

A thermodynamic, mutable-genome cellular automaton built to show emergent agency, homeostatic healing and sensory-driven foraging. Mutation, the asynchronous update order and symmetry breaking all draw on a **hybrid quantum-entropy pool**: hardware QRNG samples (LfD / ID Quantique by default) feed an SFC32 chaotic sponge through a nonce-wrapped index jumper.

It ships as a single repo for **Railway** (CPU-only vCPUs): a Fastify server plus a `worker_threads` simulation worker, with a React 19 + WebGL2 frontend that works on desktop and mobile.

```
npm install
npm run dev        # server :8080 (tsx watch) + Vite :5173 with /ws and /api proxied
npm run selftest   # PRNG statistics, anti-cycle guard, mock-ANU harvester, 1500-tick dynamics
npm run build && npm start   # production: http://localhost:8080
```

## Layout

| Path | Purpose |
|---|---|
| `src/engine/QuantumEntropy.ts` | ANU cron harvester (exponential backoff on 429/timeout, cooldown-guarded manual resync), `Uint16Array(1024)` ring in a `SharedArrayBuffer`, sequential fresh consumption, nonce-wrapped jumper with odd-stride/`+1+(nonce&1)` anti-cycle guard + Weyl pointer + nonce-epoch drift, SFC32 sponge with hrtime jitter. Zero-allocation `nextUint32/nextFloat/nextGaussian`. |
| `src/engine/SimulationCore.ts` | Structure-of-Arrays grid (one contiguous buffer, shareable), torus world, full tick pipeline, tools, inspector (kin-connected BFS), planar frame packing. |
| `src/engine/Genome.ts` | 64-bit genome bit layout, phenotype decoding, kin recognition (Hamming ≤ 2 on 16-bit kin hash), quantum mutation. |
| `src/engine/SimplexNoise.ts` | Quantum-seeded 2D simplex for drifting, tileable food pockets. |
| `src/engine/protocol.ts` | Binary frame header, layers, params, JSON message types (shared by every runtime). |
| `src/server/index.ts` | Fastify HTTP/WS, ANU cron, worker supervisor (auto-respawn), per-client delta sync and backpressure, rate limiting, COOP/COEP headers, static hosting. |
| `src/server/simWorker.ts` | Authoritative tick loop (1x = 15 t/s, 5x = 75 t/s, Max vCPU = 14 ms time-sliced bursts), XOR-delta + deflate-raw frames compressed **once** for all clients. |
| `src/client/sim/*` | `CloudSource` (WebSocket, in-order inflate and delta apply), `LocalSource` + `localWorker` (browser sandbox seeded from the server pool, transferable frame recycling), WebGL2 renderer with a Canvas2D fallback. |
| `src/components/*` | `SimulationCanvas`, `QuantumEntropyHUD`, `ControlDrawer`, `OrganismInspector`, `TelemetryPanel`, `ActionBar`, `MobileLayout`. |

## Physics in brief

* **Cell state (SoA):** `somatic` (empty/core/armor/sensor), `energy`, `ambientFood`, `signalA` (nutrient), `signalB` (alarm), a 64-bit `genome` (2 × u32), a 2-bit `epigenetic` register (damaged/starving), plus terrain, flux and birth tick.
* **Thermodynamics:** maintenance cost by tissue type (armor < core < sensor). Harvesting is 90% efficient. Division burns 0.06 energy, and emitting a signal costs 5% of that. Dead cells return body mass to the food field. Energy above 1.0 spills back into food instead of disappearing.
* **Asynchrony:** each tick does a quantum Fisher–Yates shuffle of the live cells and gives every cell a Poisson phase clock (`p = 1 − e^(−λ)`).
* **Nervous system:** signals move by relay waves through living tissue only, `signalSpeed` hops per tick (4× the 1-cell/tick growth speed by default).
* **Metabolic routing:** Jacobi-style pairwise pumping between kin cells. It moves energy from high E to low E and toward alarm signals, conserves energy exactly, and caps outflow at 20% of the donor so no energy goes negative.
* **Healing and foraging:** division targets are scored by food and signal gradients and by how many kin neighbours the target has, so wounds fill in. Alarm signals and damage memory push newborn cells toward armor. Cilia cells crawl up food gradients while staying attached to kin.
* **Predation:** aggression drains energy from foreign neighbours. Armor resists. Damage sets the epigenetic bit, which children inherit.
* **Food field (the green glow):** two quantum-seeded simplex noise fields drift slowly in different directions, forming nutrient pockets where food regrows logistically; 5% of the regrowth applies everywhere, so open space is lean but never barren. Pockets drift at a pace colonies can follow, which keeps populations stable (no boom-and-bust). Tunables live in `ECO` in `SimulationCore.ts`; measure changes with `npm run ecology`.
* **Abiogenesis:** if the population collapses, a quantum event seeds new founder colonies.

## Wire format

Binary frames have a 16-byte header (`magic, kind, W, H, layers, flags, seq, tick`) followed by 8 planar W×H byte layers: state bits, energy, food, signal A, signal B, flux, lineage hue and ancestor distance. Keyframes and XOR deltas are deflate-raw compressed in the worker, and the browser inflates them with the native `DecompressionStream`. JSON telemetry is sent every 10 ticks (between 150 ms and 1 s apart).

HTTP: `GET /health`, `GET /api/telemetry`, `GET /api/quantum/pool`, `POST /api/quantum/resync`, `GET /ws`.

## Railway

`railway.json` builds the `Dockerfile` (a multi-stage `node:22-bookworm-slim` image running as a non-root user) and health-checks `/health`. That endpoint reads the worker's heartbeat from shared memory and returns 503 if the heartbeat is more than 15 s old.

| Env var | Default | |
|---|---|---|
| `PORT` | 8080 | set by Railway |
| `SITE_PASSWORD` | — | password for the whole site (sim, WebSocket, API, Builder). Unset = open site, Builder off |
| `SITE_SESSION_SECRET` | — | signs the unlock cookie; rotate it to sign everyone out |
| `BUILDER_WORKER_TOKEN` | — | shared secret for the Builder worker on your PC |
| `BUILDER_DAILY_USD` | 20 | Builder pauses new runs after this much estimated plan usage in 24 h |
| `BUILDER_DATA_DIR` | volume `/builder` or `./data/builder` | where Builder requests are stored (needs a Railway volume to survive redeploys) |
| `GRID_W` / `GRID_H` | 256 | 64–1024 |
| `QRNG_PROVIDER` | `auto` | `lfdr` \| `qrngapi` \| `anu` \| `anu-legacy` \| `none`. `auto` = `lfdr`: the keyless [LfD QRNG](https://lfdr.de/QRNG/) at OTH Regensburg (ID Quantique Quantis PCIe), 2048 bytes = a full pool every 2 min. Keyed providers must be named explicitly |
| `LFDR_URL` | `https://lfdr.de` | override the LfD base URL |
| `QRNGAPI_KEY` | — | qrngapi.com key (`qnrk_…`), sent as `X-API-Key` |
| `QRNGAPI_METHOD` | `auto` | hardware method to request (see `GET https://qrngapi.com/api/methods`) |
| `ANU_API_KEY` | — | ANU Quantum Numbers key, sent as `x-api-key` |
| `ANU_URL` | legacy `jsonI.php` | override the legacy endpoint |
| `QRNG_ACCEPT_SIMULATOR` | `0` | `1` = ingest batches the provider labels `simulator`. They show as **SIMULATED**, never as quantum |
| `QRNG_MONTHLY_REQUESTS` | provider free tier | qrngapi 10 (10 KB/month), ANU 100, legacy unmetered |
| `QRNG_INTERVAL_MS` | budget ÷ month | defaults to spreading the budget evenly (qrngapi: 72 h, ANU: 7.2 h, legacy: 61 s) |

Locally, put secrets in a git-ignored `.env` (see `.env.example`); the server loads it on start. On Railway, set them as service variables. `.env` is excluded from the Docker image.

**How harvesting behaves:**
- **Precheck:** before spending quota, the qrngapi provider calls the free `/api/methods` endpoint. It sends no entropy request while no hardware source is online, and re-checks every 6 h.
- **Simulator batches:** batches whose `source` is `simulator` are rejected unless `QRNG_ACCEPT_SIMULATOR=1` is set.
- **Partial batches:** a 1024-byte request yields 512 samples, so consecutive batches fill alternating halves of the pool.
- **Budget:** the monthly budget counts manual resyncs too, and resets on the 1st of each month (UTC). It is held in memory, so a restart resets the counter. The provider's own quota responses still pause the harvester until next month.
- **Rejected key:** a 401/403 halts harvesting for 6 h.

## Builder

Builder is a chat at `/builder` (the speech-bubble button in the app) where you suggest changes or ask questions in plain words. A coding agent (Claude Code, on your own Claude plan) runs on your PC and works on them in a clone kept only for it (`~/turinglife-builder/repo`), on an `agent/<id>` branch. Ported from the DIY site's Builder.

- **Questions** get an answer in the chat.
- **Changes** are committed by the worker, which then runs `typecheck`, `selftest` and `build` (the agent gets one chance to fix failures) and screenshots the app from a local build. The proposal waits for you. **Approve** makes the worker push to `main`, and Railway redeploys. Follow-ups continue the same agent session.
- The agent never sees the worker token, the Railway token or `.env`, and it can't push. Each request is capped at about $5 of usage and $20 a day (estimates of plan usage, not charges). A run is stopped after 30 minutes.

To run the worker, add `BUILDER_URL` (the site's URL) and `BUILDER_WORKER_TOKEN` to `.env`, make sure Claude Code is signed in to your plan, then run:

```
npm run builder        # agent limited to an allow list (edit files, run checks, read git)
npm run builder:full   # full PC access: any command, the web, Chrome. Pushing and .env stay blocked
```

Optional settings: `BUILDER_MODEL` (default `claude-opus-5-5`), `BUILDER_MAX_RUN_USD` (5), `BUILDER_RUN_MINUTES` (30), `BUILDER_HOME` and `BUILDER_CLAUDE_DIR` (a separate Claude login folder). The agent works from `docs/builder-guide.md`, so keep that guide current. `npm run ecology` is a headless population probe that the agent uses for tuning.

## Controls

Wheel or pinch zooms. Drag pans (with the Inspect tool, or right/middle drag). Double-click or double-tap fits the view. Keys `1`–`4` solo a layer, `Shift+1`–`4` blends layers. `Space` pauses. `I P M B X F K` pick tools, `[` `]` change brush size, `0` fits the view and `Esc` clears the selection.
