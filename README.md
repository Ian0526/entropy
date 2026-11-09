# TuringLife · Morphogenesis

A living wallpaper for Windows. Multi-channel Lenia organisms (three coupled species fields plus a
phase field) grow, swim, bond into colonies and bounce apart behind your desktop icons, seeded by
quantum random numbers from a hardware QRNG. Left alone, the world drifts: its look, colours,
physics and even its laws ease from one random state to the next, morphing one kind of life into
another instead of resetting.

- **Website:** a live preview with every setting, at the Railway deployment.
- **Desktop app:** download `TuringLifeSetup.exe` from the [latest release](https://github.com/Ian0526/entropy/releases/latest).
  Run it, choose Install, and it lives in the tray: the settings window (native controls with a live
  preview), the world on the desktop, and Start with Windows. It installs per user (no admin), and is
  removed from Settings → Apps like any other app. It needs the Microsoft Edge WebView2 Runtime,
  which Windows 10 and 11 already have.

## What it does

- **The world** (`src/client/morpho`): GPU multi-channel Lenia in WebGL2. Each regime is a set of
  ring kernels and growth bands (`regimes.ts`); Bert Chan's 15-kernel "aquarium" law gives the
  Bioluminescent Protozoa. A phase field (Kuramoto oscillators) beats inside the bodies, curl flow
  makes organisms spin, and per-organism genomes (speciation) give each colony its own hue and law.
- **The Director** (`director.ts`) keeps an unattended world alive: it reseeds extinction, thins
  overcrowding, stirs stagnation, and morphs between regimes by interpolating the law itself.
- **Drift** (`drift.ts`): smooth, endless randomisation of optics, colours, physics and speed within
  ranges you set.
- **Load guard**: times its own GPU work and keeps within a budget (fewer steps first, down to a floor
  you choose, then a lighter world). On the desktop, a fullscreen game or a busy GPU/CPU slows the
  world to a crawl at a negligible load.
- **Quantum seeds**: the LfD QRNG (an ID Quantique Quantis device, free and keyless) supplies the
  random numbers behind seeds, genomes and the Director's choices; a seeded SFC32 generator fills in.

## Build from source

Needs Node 20+ and, for the desktop app, Windows with the [.NET 8 SDK](https://dotnet.microsoft.com/download).

```
git clone https://github.com/Ian0526/entropy.git
cd entropy
npm install

npm run dev        # the website: Vite on :5173, server on :8080 (quantum pool)
npm run desktop    # the Windows app: desktop/dist/TuringLifeSetup.exe
npm run build && npm start   # the website as deployed: http://localhost:8080
```

`TuringLifeSetup.exe --portable` runs a copy without installing it.

## Layout

| Path | Purpose |
|---|---|
| `src/client/morpho/` | The world: `MorphoGL.ts` (WebGL2 passes: occupancy, field convolutions, flow + phase update, stamps, stats, display), `regimes.ts`, `director.ts`, `drift.ts`, `settings.ts`, and the lab UI (`MorphoLab.tsx`, `SettingsPanel.tsx`). |
| `src/client/Hosted.tsx` | The bare world the desktop app shows (`?view=wallpaper` / `?view=preview`), driven by messages from the app. |
| `src/server/index.ts` | The website's server: static files, `/api/quantum/pool`, `/health`. |
| `src/engine/` | The quantum-entropy harvester and QRNG providers used by the server. |
| `desktop/TuringLife/` | The Windows app (C#, WinForms + WebView2): settings window, wallpaper window behind the icons (WorkerW), mouse relay, PC watcher, self-installer. |
| `scripts/build-desktop.mjs` | Builds the web page, embeds it, and publishes the single self-contained `.exe`. |
| `scripts/morpho-probe.ts` | CPU (FFT) version of the physics, for tuning regimes offline. |

## Deploy

The repo deploys to Railway from `main` (Dockerfile; health check `/health`). Optional variables:
`QRNG_PROVIDER` and friends (see `.env.example`).
