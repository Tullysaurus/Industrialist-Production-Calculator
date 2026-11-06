import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import 'fake-indexeddb/auto';
import { after, before, test } from 'node:test';
import { createServer } from 'vite';

const viteServer = await createServer({
  configFile: false,
  root: process.cwd(),
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
});
const lookup = await viteServer.ssrLoadModule('/src/data/lookup.ts');
await lookup.initializeDatabase();
const { deserializeCanvas } = await viteServer.ssrLoadModule('/src/persistence/transformer.ts');
const { solveFlowPipeline } = await viteServer.ssrLoadModule('/src/solver/solverPipeline.ts');
const { getSpecialRecipe } = await viteServer.ssrLoadModule('/src/data/registry.ts');
const { buildLayoutInput } = await viteServer.ssrLoadModule('/src/gameLayout/input.ts');
const { buildProblem } = await viteServer.ssrLoadModule('/src/gameLayout/engine/problem.ts');
const { runLayout } = await viteServer.ssrLoadModule('/src/gameLayout/engine/index.ts');
const D = await viteServer.ssrLoadModule('/src/gameLayout/doc.ts');
const O = await viteServer.ssrLoadModule('/src/gameLayout/docOps.ts');
const R = await viteServer.ssrLoadModule('/src/gameLayout/routeTools.ts');
const { normalizeLayoutDoc } = await viteServer.ssrLoadModule('/src/gameLayout/docSchema.ts');

after(async () => {
  await viteServer.close();
});

let input;
let ctx;

before(async () => {
  const save = JSON.parse(
    await readFile(new URL('../src/tutorials/Gearbox_Tutorial_save.json', import.meta.url), 'utf8'),
  );
  const { nodes, edges, globalSettings } = deserializeCanvas(save.data ?? save);
  const res = solveFlowPipeline(nodes, edges, globalSettings);
  input = buildLayoutInput({
    nodes,
    edges,
    ...res,
    machines: lookup.getAllMachines(),
    products: lookup.getAllProducts(),
    isSpecialRecipe: (id) => !!getSpecialRecipe(id),
  });
  ctx = D.buildContext(buildProblem(input));
});

const errorsOf = (view) => view.problems.filter((p) => p.severity === 'error');

/** A small-pipe connection between exactly two single machines. */
function simpleConnection() {
  const net = ctx.problem.nets.find(
    (n) => !n.large && n.terminals.length === 2 && n.terminals[0].inst !== n.terminals[1].inst,
  );
  assert.ok(net, 'the sample save has a two-machine connection');
  return net;
}

test('every machine of the flowchart starts unplaced and nothing is reported as an error', () => {
  const view = D.evaluateDoc(ctx, O.ensureDoc(null), { analyse: false });
  assert.equal(view.unplaced.length, ctx.problem.instances.length);
  assert.equal(errorsOf(view).length, 0);
});

test('machines placed by hand can be moved, rotated, pinned and deleted', () => {
  const net = simpleConnection();
  const [a, b] = net.terminals.map((t) => t.inst);
  let doc = O.placeMachine(null, ctx, a, 0, 0, 0);
  doc = O.placeMachine(doc, ctx, b, 40, 10, 1);
  let view = D.evaluateDoc(ctx, doc, { analyse: false });
  assert.equal(view.placed.size, 2);
  assert.equal(view.sol.machines.find((m) => m.inst === b).rot, 1);

  const keyA = ctx.instKeys[a];
  const sel = { machines: new Set([keyA]), pipes: new Set(), pieces: new Set() };
  doc = O.moveItems(doc, sel, 5, -3);
  assert.deepEqual(
    [doc.machines[0].x, doc.machines[0].y],
    [5, -3],
    'negative coordinates are allowed',
  );
  doc = O.rotateMachines(doc, ctx, sel.machines);
  assert.equal(doc.machines.find((m) => m.key === keyA).rot, 1);
  doc = O.togglePinned(doc, sel);
  assert.equal(doc.machines.find((m) => m.key === keyA).pinned, true);
  doc = O.deleteItems(doc, sel);
  view = D.evaluateDoc(ctx, doc, { analyse: false });
  assert.equal(view.placed.size, 1);
  assert.ok(view.unplaced.includes(a), 'a deleted machine goes back to the unplaced list');
});

test('overlapping machines and unrouted connections are reported', () => {
  const net = simpleConnection();
  const [a, b] = net.terminals.map((t) => t.inst);
  const doc = O.placeMachine(O.placeMachine(null, ctx, a, 0, 0, 0), ctx, b, 1, 1, 0);
  const view = D.evaluateDoc(ctx, doc, { analyse: false });
  const codes = view.problems.map((p) => p.code);
  assert.ok(codes.includes('overlap'));
  assert.ok(codes.includes('unrouted'));
});

test('auto-route connects hand-placed machines with a valid pipe', () => {
  const net = simpleConnection();
  const [a, b] = net.terminals.map((t) => t.inst);
  let doc = O.placeMachine(O.placeMachine(null, ctx, a, 0, 0, 0), ctx, b, 30, 14, 0);
  let view = D.evaluateDoc(ctx, doc, { analyse: false });
  const nets = R.unroutedNetworks(view);
  assert.ok(nets.includes(net.id));
  const res = R.routeNetworks(view, nets, 5);
  assert.deepEqual(res.failed, []);
  doc = res.doc;
  view = D.evaluateDoc(ctx, doc, { analyse: false });
  assert.equal(errorsOf(view).length, 0, JSON.stringify(errorsOf(view)));
  assert.ok(!view.problems.some((p) => p.code === 'unrouted' && p.netKey === net.key));
  // the document survives the save-file validation unchanged
  assert.deepEqual(normalizeLayoutDoc(JSON.parse(JSON.stringify(doc))), doc);
});

test('erasing pipe tiles splits the network and is reported until it is re-routed', () => {
  const net = simpleConnection();
  const [a, b] = net.terminals.map((t) => t.inst);
  let doc = O.placeMachine(O.placeMachine(null, ctx, a, 0, 0, 0), ctx, b, 30, 14, 0);
  doc = R.routeNetworks(D.evaluateDoc(ctx, doc, { analyse: false }), [net.id], 5).doc;
  const g = O.pipeGraph(doc.pipes[0]);
  const middle = [...g.nodes][Math.floor(g.nodes.size / 2)];
  doc = O.eraseTiles(doc, new Set([middle]));
  let view = D.evaluateDoc(ctx, doc, { analyse: false });
  assert.ok(errorsOf(view).length > 0, 'a cut pipe is an error');
  doc = R.routeNetworks(view, [net.id], 5).doc;
  view = D.evaluateDoc(ctx, doc, { analyse: false });
  assert.equal(errorsOf(view).length, 0);
});

test('a generated layout opens in the editor without errors and keeps pinned machines', () => {
  const opts = { timeBudget: 12, valves: false, seed: 1, quantumJump: 3 };
  const first = runLayout(input, opts);
  assert.equal(first.summary.fullyRouted, true, 'the sample save routes within the budget');
  const view = D.evaluateDoc(ctx, first.doc);
  assert.equal(view.unplaced.length, 0);
  assert.equal(errorsOf(view).length, 0, JSON.stringify(errorsOf(view).slice(0, 3)));

  const keys = new Set(first.doc.machines.slice(0, 8).map((m) => m.key));
  const pinned = {
    ...first.doc,
    machines: first.doc.machines.map((m) => (keys.has(m.key) ? { ...m, pinned: true } : m)),
  };
  const second = runLayout(input, { ...opts, seed: 2, pinned });
  for (const m of second.doc.machines) {
    if (!keys.has(m.key)) continue;
    const o = first.doc.machines.find((x) => x.key === m.key);
    assert.deepEqual([m.x, m.y, m.rot, m.pinned], [o.x, o.y, o.rot, true], `${m.key} stayed put`);
  }
});
