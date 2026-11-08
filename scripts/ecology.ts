/**
 * Headless ecology probe: runs the simulation without UI and reports population
 * stability. Usage: npx tsx scripts/ecology.ts [ticks=9000] [runs=3] [size=256] [depth=1]
 * (3D example: npx tsx scripts/ecology.ts 3000 2 64 64)
 */
import { QuantumEntropyEngine } from '../src/engine/QuantumEntropy';
import { ECO, SimulationCore } from '../src/engine/SimulationCore';

// Override tunables from the environment, e.g. ECO='{"drift":0.3,"baseFood":0.2}'
if (process.env.ECO) Object.assign(ECO, JSON.parse(process.env.ECO));
console.log('ECO', JSON.stringify(ECO));

const TICKS = Number(process.argv[2] ?? 9000);
const RUNS = Number(process.argv[3] ?? 3);
const SIZE = Number(process.argv[4] ?? 256);
const DEPTH = Number(process.argv[5] ?? 1);

const results: { min: number; max: number; mean: number; cv: number; collapses: number; reseeds: number; species: number }[] = [];
for (let r = 0; r < RUNS; r++) {
  const q = new QuantumEntropyEngine();
  q.configureHarvester({ provider: null });
  const sim = new SimulationCore(SIZE, SIZE, q, undefined, false, DEPTH);
  const series: number[] = [];
  let collapses = 0;
  let reseeds = 0;
  let wasLow = false;
  let prevPop = sim.stats.population;
  let speciesSum = 0;
  let line = '';
  let tickMs = 0;
  for (let t = 1; t <= TICKS; t++) {
    const t0 = performance.now();
    sim.step();
    tickMs += performance.now() - t0;
    const p = sim.stats.population;
    if (p < 6 && !wasLow) collapses++;
    wasLow = p < 6;
    if (prevPop < 6 && p - prevPop >= 20) reseeds++;
    prevPop = p;
    if (t > TICKS / 3) {
      series.push(p);
      speciesSum += sim.stats.species;
    }
    if (t % (TICKS / 30) === 0) line += `${p} `;
  }
  const mean = series.reduce((a, b) => a + b, 0) / series.length;
  const sd = Math.sqrt(series.reduce((a, b) => a + (b - mean) ** 2, 0) / series.length);
  const res = { min: Math.min(...series), max: Math.max(...series), mean, cv: mean ? sd / mean : 0, collapses, reseeds, species: speciesSum / series.length };
  results.push(res);
  console.log(`run ${r + 1}: pop ${line}`);
  console.log(`        steady-state(last 2/3) min ${res.min} max ${res.max} mean ${mean.toFixed(0)} cv ${res.cv.toFixed(2)} | collapses ${collapses} | species ${res.species.toFixed(1)} | ${(tickMs / TICKS).toFixed(2)} ms/tick | occupancy ${((mean / sim.N) * 100).toFixed(1)}%`);
}
const avg = (k: keyof (typeof results)[0]) => results.reduce((a, b) => a + b[k], 0) / results.length;
console.log(`\nSUMMARY mean pop ${avg('mean').toFixed(0)}, cv ${avg('cv').toFixed(2)}, collapses/run ${avg('collapses').toFixed(1)}, min ${Math.min(...results.map((r) => r.min))}, species ${avg('species').toFixed(1)}`);
