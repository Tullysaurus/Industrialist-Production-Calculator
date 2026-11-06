// Builds the in-game layout engine input from a planner save, using the website's own flow
// pipeline. Usage: node tools/game-layout-input.mjs <save.json> <out.json>
import 'fake-indexeddb/auto';
import fs from 'node:fs';
import { createServer } from 'vite';

const [savePath, outPath] = process.argv.slice(2);
const server = await createServer({
  configFile: false,
  root: process.cwd(),
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
});
try {
  const lookup = await server.ssrLoadModule('/src/data/lookup.ts');
  await lookup.initializeDatabase();
  const { deserializeCanvas } = await server.ssrLoadModule('/src/persistence/transformer.ts');
  const { solveFlowPipeline } = await server.ssrLoadModule('/src/solver/solverPipeline.ts');
  const { getSpecialRecipe } = await server.ssrLoadModule('/src/data/registry.ts');
  const { buildLayoutInput } = await server.ssrLoadModule('/src/gameLayout/input.ts');
  const save = JSON.parse(fs.readFileSync(savePath, 'utf8'));
  const { nodes, edges, globalSettings } = deserializeCanvas(save.data ?? save);
  const res = solveFlowPipeline(nodes, edges, globalSettings);
  const input = buildLayoutInput({
    nodes,
    edges,
    ...res,
    machines: lookup.getAllMachines(),
    products: lookup.getAllProducts(),
    isSpecialRecipe: (id) => !!getSpecialRecipe(id),
  });
  fs.writeFileSync(outPath, JSON.stringify(input));
  console.log(`${input.nodes.length} nodes, ${input.edges.length} edges -> ${outPath}`);
} finally {
  await server.close();
}
