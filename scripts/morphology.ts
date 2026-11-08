/**
 * Headless morphology probe: how many bounded organisms exist, how big they are, how
 * mirror-symmetric they are, and what the most common evolved body looks like.
 * Usage: npx tsx scripts/morphology.ts [ticks=6000] [size=256] [depth=1]
 */
import { QuantumEntropyEngine } from '../src/engine/QuantumEntropy';
import { isDevelopmental } from '../src/engine/Genome';
import { SimulationCore } from '../src/engine/SimulationCore';

const TICKS = Number(process.argv[2] ?? 6000);
const SIZE = Number(process.argv[3] ?? 256);
const DEPTH = Number(process.argv[4] ?? 1);

const q = new QuantumEntropyEngine();
q.configureHarvester({ provider: null });
const sim = new SimulationCore(SIZE, SIZE, q, undefined, false, DEPTH);

interface Body { cells: number[]; dev: number; axis: number }

function bodies(): Map<number, Body> {
  const out = new Map<number, Body>();
  for (let i = 0; i < sim.N; i++) {
    if (sim.somatic[i] === 0 || !isDevelopmental(sim.dev[i])) continue;
    const b = sim.body[i];
    let e = out.get(b);
    if (!e) out.set(b, (e = { cells: [], dev: sim.dev[i], axis: sim.axis[i] }));
    e.cells.push(i);
  }
  return out;
}

/** Unwrapped (x, y) of a body's cells relative to its first cell (bodies are much smaller than the torus). */
function coords(b: Body): [number, number][] {
  const W = sim.W;
  const H = sim.H;
  const x0 = b.cells[0] % W;
  const y0 = ((b.cells[0] / W) | 0) % H;
  return b.cells.map((i) => {
    let dx = (i % W) - x0;
    let dy = (((i / W) | 0) % H) - y0;
    if (dx > W / 2) dx -= W;
    if (dx < -W / 2) dx += W;
    if (dy > H / 2) dy -= H;
    if (dy < -H / 2) dy += H;
    return [dx, dy];
  });
}

/** Fraction of cells whose mirror image across the body axis (through the centroid) is a cell of the same type. */
function symmetry(b: Body): number {
  const c = coords(b);
  const types = b.cells.map((i) => sim.somatic[i]);
  const key = new Map<string, number>();
  c.forEach(([x, y], k) => key.set(`${x},${y}`, types[k]));
  const alongX = b.axis % 2 === 0; // dirs 0/2 = ±x, 1/3 = ±y (2D)
  const cy = c.reduce((a, p) => a + p[1], 0) / c.length;
  const cx = c.reduce((a, p) => a + p[0], 0) / c.length;
  let hit = 0;
  c.forEach(([x, y], k) => {
    const mx = alongX ? x : Math.round(2 * cx - x);
    const my = alongX ? Math.round(2 * cy - y) : y;
    if (key.get(`${mx},${my}`) === types[k]) hit++;
  });
  return hit / c.length;
}

function draw(b: Body): string {
  const c = coords(b);
  const xs = c.map((p) => p[0]);
  const ys = c.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const grid = Array.from({ length: y1 - y0 + 1 }, () => Array(x1 - x0 + 1).fill(' '));
  c.forEach(([x, y], k) => (grid[y - y0][x - x0] = ' oA*'[sim.somatic[b.cells[k]]]));
  return grid.map((r) => '    ' + r.join('')).join('\n');
}

let line = '';
let seeds = 0;
const popSeries: number[] = [];
for (let t = 1; t <= TICKS; t++) {
  sim.step();
  seeds += sim.stats.seeds;
  if (t > TICKS / 3) popSeries.push(sim.stats.population);
  if (t % (TICKS / 12) === 0) {
    const s = sim.stats;
    line += `\n  t${t}: pop ${s.population}, organisms ${s.organisms} (${s.organismCells} cells, ${((s.organismCells / Math.max(1, s.population)) * 100).toFixed(0)}%), seeds so far ${seeds}`;
  }
}
console.log(`timeline:${line}`);
const mean = popSeries.reduce((a, b) => a + b, 0) / popSeries.length;
console.log(`population (last 2/3): mean ${mean.toFixed(0)}, min ${Math.min(...popSeries)}, max ${Math.max(...popSeries)}`);

const all = [...bodies().values()].filter((b) => b.cells.length >= 4);
if (all.length === 0) {
  console.log('no multicellular organisms alive');
} else {
  const sizes = all.map((b) => b.cells.length).sort((a, b) => a - b);
  const high = all.reduce((a, b) => a + b.cells.filter((i) => sim.morphA[i] > 1.35).length, 0) / all.reduce((a, b) => a + b.cells.length, 0);
  console.log(`cells with a high Turing activator: ${(high * 100).toFixed(0)}%`);
  console.log(`organisms ≥4 cells: ${all.length}, median size ${sizes[sizes.length >> 1]}, max ${sizes[sizes.length - 1]}`);
  if (DEPTH === 1) {
    const sym = all.map(symmetry);
    console.log(`mirror symmetry (same cell type across the axis): mean ${(sym.reduce((a, b) => a + b, 0) / sym.length).toFixed(2)}`);
    // Most common body plan (dev word) and its largest living example.
    const byPlan = new Map<number, Body[]>();
    for (const b of all) byPlan.set(b.dev, [...(byPlan.get(b.dev) ?? []), b]);
    const plans = [...byPlan.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 3);
    for (const [dev, list] of plans) {
      const big = list.sort((a, b) => b.cells.length - a.cells.length)[0];
      console.log(`\nplan ${dev.toString(16).padStart(8, '0')}: ${list.length} organisms; largest (${big.cells.length} cells, symmetry ${symmetry(big).toFixed(2)}):  o core  A armor  * sensor`);
      console.log(draw(big));
    }
  }
}
