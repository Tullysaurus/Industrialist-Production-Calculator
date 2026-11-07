// Runs the in-game layout generator headlessly on an input made by game-layout-input.mjs, then
// evaluates the resulting document the way the editor does (problems list).
// Usage: node tools/game-layout-bench.mjs <input.json> [seconds] [out.json]
//          [--no-valves] [--seed=N] [--verbose] [--pin=N]   (pin N machines and run again)
//          [--no-seams] [--no-hull]   (old row/column compaction, bounding-box objective)
import fs from 'node:fs';
import { createServer } from 'vite';

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith('--'));
const flag = (name, dflt) => {
  const f = flags.find((x) => x.startsWith(`--${name}=`));
  return f ? Number(f.split('=')[1]) : dflt;
};
const [inputPath, seconds = '60', outPath] = args.filter((a) => !a.startsWith('--'));
const server = await createServer({
  configFile: false,
  root: process.cwd(),
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
});
try {
  const { runLayout } = await server.ssrLoadModule('/src/gameLayout/engine/index.ts');
  const { buildProblem } = await server.ssrLoadModule('/src/gameLayout/engine/problem.ts');
  const { buildContext, evaluateDoc } = await server.ssrLoadModule('/src/gameLayout/doc.ts');
  const { hullStats } = await server.ssrLoadModule('/src/gameLayout/engine/hull.ts');
  const { pieceSize } = await server.ssrLoadModule('/src/gameLayout/engine/power.ts');
  // empty tiles inside the orthogonal hull of the document (machines, pipes, pieces)
  const docHull = (doc) => {
    const tiles = new Set();
    const rect = (x, y, w, h) => {
      for (let i = 0; i < w; i++) for (let j = 0; j < h; j++) tiles.add(`${x + i},${y + j}`);
    };
    for (const m of doc.machines) {
      const odd = m.rot % 2 === 1;
      rect(m.x, m.y, odd ? m.h : m.w, odd ? m.w : m.h);
    }
    for (const p of doc.pipes) {
      const sz = p.large ? 2 : 1;
      for (let i = 0; i + 1 < p.nodes.length; i += 2) rect(p.nodes[i], p.nodes[i + 1], sz, sz);
    }
    for (const v of doc.valves) rect(v.x, v.y, v.rot % 2 ? 1 : 3, v.rot % 2 ? 3 : 1);
    for (const v of doc.intersections) rect(v.x, v.y, 2, 2);
    for (const p of doc.power ?? []) {
      const [w, h] = pieceSize(p.kind, p.rot);
      rect(p.x, p.y, w, h);
    }
    const xy = [...tiles].map((t) => t.split(',').map(Number));
    const x0 = Math.min(...xy.map((p) => p[0]));
    const y0 = Math.min(...xy.map((p) => p[1]));
    const w = Math.max(...xy.map((p) => p[0])) - x0 + 1;
    const h = Math.max(...xy.map((p) => p[1])) - y0 + 1;
    const mask = new Uint8Array(w * h);
    for (const [x, y] of xy) mask[(y - y0) * w + x - x0] = 1;
    return hullStats(mask, w, h);
  };
  const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const verbose = flags.includes('--verbose');
  const run = (pinned) => {
    const t0 = Date.now();
    const res = runLayout(
      input,
      {
        timeBudget: Number(seconds),
        valves: !flags.includes('--no-valves'),
        seed: flag('seed', 0),
        quantumJump: 3,
        power: !flags.includes('--no-power'),
        pinned,
        tuning: {
          slack: flag('slack', undefined),
          stallLimit: flag('stall', undefined),
          useModules: flags.includes('--no-modules') ? false : undefined,
          seams: flags.includes('--no-seams') ? false : undefined,
          hullCost: flags.includes('--no-hull') ? false : undefined,
          notchWeight: flag('notch', undefined),
        },
      },
      { log: (l) => (verbose || !l.startsWith('    ')) && console.log(l) },
    );
    const s = res.summary;
    console.log(
      `RESULT ${s.width}x${s.height} = ${s.area} tiles, routed=${s.fullyRouted}, conflicts=${s.conflicts}, ` +
        `unrouted=${s.unrouted}, valves=${s.valves}, passthroughs=${s.passthroughs}, ${((Date.now() - t0) / 1000).toFixed(1)}s`,
    );
    const hs = docHull(res.doc);
    console.log(
      `HULL ${hs.width}x${hs.height}, hull ${hs.hull}, used ${hs.used}, empty ${hs.empty} (${((100 * hs.empty) / hs.hull).toFixed(1)}%)`,
    );
    const view = evaluateDoc(buildContext(buildProblem(input, {})), res.doc);
    const byCode = {};
    for (const p of view.problems)
      byCode[`${p.severity}:${p.code}`] = (byCode[`${p.severity}:${p.code}`] ?? 0) + 1;
    console.log('EDITOR PROBLEMS', JSON.stringify(byCode));
    for (const p of view.problems.filter((p) => p.severity === 'error').slice(0, 8)) {
      console.log('  -', p.message, JSON.stringify(p.tiles.slice(0, 2)));
    }
    return res;
  };
  const res = run(undefined);
  if (outPath) fs.writeFileSync(outPath, JSON.stringify(res));
  const nPin = flag('pin', 0);
  if (nPin) {
    const doc = res.doc;
    const keys = new Set(doc.machines.slice(0, nPin).map((m) => m.key));
    const pinnedDoc = {
      ...doc,
      machines: doc.machines.map((m) => (keys.has(m.key) ? { ...m, pinned: true } : m)),
    };
    console.log(`--- rerun with ${keys.size} pinned machine(s)`);
    const res2 = run(pinnedDoc);
    let moved = 0;
    for (const m of res2.doc.machines) {
      if (!keys.has(m.key)) continue;
      const o = doc.machines.find((x) => x.key === m.key);
      if (o.x !== m.x || o.y !== m.y || o.rot !== m.rot) moved++;
    }
    console.log(`PINNED machines moved: ${moved} of ${keys.size}`);
  }
} finally {
  await server.close();
}
