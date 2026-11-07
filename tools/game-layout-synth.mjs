// Writes synthetic planner saves for benchmarking the in-game layout generator.
// Usage: node tools/game-layout-synth.mjs <out-dir>
// Then: node tools/game-layout-input.mjs <out-dir>/<name>.json <input.json>
import fs from 'node:fs';
import path from 'node:path';

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error('usage: node tools/game-layout-synth.mjs <out-dir>');
fs.mkdirSync(outDir, { recursive: true });

const tutorial = JSON.parse(
  fs.readFileSync(new URL('../src/tutorials/Gearbox_Tutorial_save.json', import.meta.url), 'utf8'),
);
const settings = tutorial.data.globalSettings;

function save(name, nodes, edges) {
  const data = { version: 2, nodes, edges, globalSettings: settings };
  fs.writeFileSync(
    path.join(outDir, `${name}.json`),
    JSON.stringify({ id: name, name, timestamp: 0, data }),
  );
  console.log(`${name}: ${nodes.length} nodes, ${edges.length} edges`);
}

const node = (id, recipeId, machineCount, x) => ({
  id,
  type: 'recipe',
  recipeId,
  machineCount,
  position: { x, y: 0 },
  settings: {},
});
const edge = (id, source, sourceIndex, target, targetIndex) => ({
  id,
  source,
  sourceIndex,
  target,
  targetIndex,
});

// Large fluid pipes: coal power plants with cooling towers and exhaust stacks.
save(
  'synth-power',
  [
    node('drill', 'r_coal_drill_01', 16, 0),
    node('cpp', 'r_coal_power_plant_01', 2, 400),
    node('tower', 'r_cooling_tower_01', 4, 800),
    node('stack', 'r_exhaust_stack_02', 3, 800),
  ],
  [
    edge('e1', 'drill', 0, 'cpp', 0),
    edge('e2', 'cpp', 0, 'tower', 0),
    edge('e3', 'tower', 0, 'cpp', 1),
    edge('e4', 'cpp', 1, 'stack', 0),
  ],
);

// The tutorial at a third of its size (a smaller factory with the same structure).
save(
  'synth-tutorial-third',
  tutorial.data.nodes.map((n) => ({
    ...n,
    machineCount: Math.max(1, Math.ceil(n.machineCount / 3)),
  })),
  tutorial.data.edges,
);
