// Bundles the Node server into dist/server (ESM, node_modules kept external).
import { build } from 'esbuild';

await build({
  entryPoints: { index: 'src/server/index.ts' },
  outdir: 'dist/server',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  packages: 'external',
  sourcemap: true,
  legalComments: 'none',
  logLevel: 'info',
});
