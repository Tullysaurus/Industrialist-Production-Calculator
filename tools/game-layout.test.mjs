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

test('the orthogonal hull does not count the notch of an L shape as empty space', async () => {
  const { hullStats, rectHullArea } = await viteServer.ssrLoadModule(
    '/src/gameLayout/engine/hull.ts',
  );
  // L shape in a 4x4 box: the top-right 2x2 notch is outside the hull, the gap at (1, 1) inside
  const L = [
    [1, 1, 0, 0],
    [1, 0, 0, 0],
    [1, 1, 1, 1],
    [1, 1, 1, 1],
  ];
  const mask = Uint8Array.from(L.flat());
  const h = hullStats(mask, 4, 4);
  assert.equal(h.used, 11);
  assert.equal(h.hull, 12);
  assert.equal(h.empty, 1);
  // two rectangles in an L: the hull is their union
  assert.equal(
    rectHullArea([
      [0, 0, 2, 4],
      [2, 2, 2, 2],
    ]),
    12,
  );
});

test('seam carving keeps a routed layout valid and never adds empty space', async () => {
  const { optimize } = await viteServer.ssrLoadModule('/src/gameLayout/engine/optimize.ts');
  const { seamCompact } = await viteServer.ssrLoadModule('/src/gameLayout/engine/seams.ts');
  const problem = buildProblem(input);
  const sol = optimize(problem, {
    timeBudget: 8,
    seed: 3,
    wireWeight: 1,
    jump: 3,
    useModules: true,
    slack: 1,
    log: () => {},
    seams: false,
    hullCost: false,
  });
  assert.equal(sol.ok, true);
  const carved = seamCompact(sol);
  assert.deepEqual(carved.validate(3), []);
  assert.ok(carved.hull.empty <= sol.hull.empty);
  assert.ok(carved.cost <= sol.cost);
  assert.equal(carved.machines.length, sol.machines.length);
});

/** Engine input for a small power plant save: three large pipe networks that must cross. */
function powerPlantInput() {
  const node = (id, recipeId, machineCount) => ({
    id,
    type: 'recipe',
    recipeId,
    machineCount,
    position: { x: 0, y: 0 },
    settings: {},
  });
  const edge = (id, source, sourceIndex, target, targetIndex) => ({
    id,
    source,
    sourceIndex,
    target,
    targetIndex,
  });
  const nodes = [
    node('drill', 'r_coal_drill_01', 16),
    node('cpp', 'r_coal_power_plant_01', 2),
    node('tower', 'r_cooling_tower_01', 4),
    node('stack', 'r_exhaust_stack_02', 3),
  ];
  const edges = [
    edge('e1', 'drill', 0, 'cpp', 0),
    edge('e2', 'cpp', 0, 'tower', 0),
    edge('e3', 'tower', 0, 'cpp', 1),
    edge('e4', 'cpp', 1, 'stack', 0),
  ];
  return powerInputFrom(nodes, edges);
}

async function powerInputFrom(rawNodes, rawEdges) {
  const save = JSON.parse(
    await readFile(new URL('../src/tutorials/Gearbox_Tutorial_save.json', import.meta.url), 'utf8'),
  );
  const data = { ...save.data, nodes: rawNodes, edges: rawEdges };
  const { nodes, edges, globalSettings } = deserializeCanvas(data);
  const res = solveFlowPipeline(nodes, edges, globalSettings);
  return buildLayoutInput({
    nodes,
    edges,
    ...res,
    machines: lookup.getAllMachines(),
    products: lookup.getAllProducts(),
    isSpecialRecipe: (id) => !!getSpecialRecipe(id),
  });
}

test('large pipes may turn inside an intersection, each through its own sides', async () => {
  const { Solution, key } = await viteServer.ssrLoadModule('/src/gameLayout/engine/solution.ts');
  const { pieceRoutes } = await viteServer.ssrLoadModule('/src/gameLayout/junctionRoutes.ts');
  const problem = buildProblem(await powerPlantInput());
  const [A, B] = problem.nets.map((n, i) => (n.large ? i : -1)).filter((i) => i >= 0);
  const build = (bExtra) => {
    const nodes = problem.nets.map(() => new Set());
    const edges = problem.nets.map(() => []);
    const chain = (ni, pts) =>
      pts.forEach((p, i) => {
        nodes[ni].add(key(...p));
        if (i) edges[ni].push(key(...pts[i - 1]), key(...p), 0);
      });
    // A comes down from the top and turns right inside the piece at (10, 10)
    const pa = [];
    for (let y = 4; y <= 10; y++) pa.push([10, y]);
    for (let x = 11; x <= 16; x++) pa.push([x, 10]);
    chain(A, pa);
    // B comes in from the left and leaves at the bottom (or, broken, at the top)
    const pb = [];
    for (let x = 4; x <= 8; x++) pb.push([x, 10]);
    chain(B, pb);
    bExtra(chain, edges[B]);
    return new Solution(problem, [], nodes, edges, [], 3);
  };
  const ok = build((chain, eb) => {
    const out = [];
    for (let y = 12; y <= 16; y++) out.push([10, y]);
    chain(B, out);
    eb.push(key(8, 10), key(10, 12), 3); // corner crossing: piece at (x of end, y of start)
  });
  assert.deepEqual(ok.badIntersections(), []);
  assert.deepEqual(ok.overfull(), []);
  assert.deepEqual(
    ok.validate(50).filter((e) => !e.includes('not connected')),
    [],
    'a curved crossing is a valid segment',
  );
  assert.deepEqual(ok.intersections(), [{ x: 10, y: 10, nets: [A, B].sort((a, b) => a - b) }]);
  const sides = new Map(pieceRoutes(ok, 10, 10).map((r) => [r.net, r.sides]));
  assert.deepEqual(sides.get(A), [0, 3], 'A: right and top');
  assert.deepEqual(sides.get(B), [1, 2], 'B: left and bottom');
  // B leaving through the top as well shares a side with A: not allowed
  const bad = build((chain, eb) => {
    const out = [];
    for (let y = 8; y >= 2; y--) out.push([10, y]);
    chain(B, out);
    eb.push(key(8, 10), key(10, 8), 3);
  });
  assert.ok(bad.overfull().length > 0);
});

test('a power plant with crossing large pipes is routed without editor errors', async () => {
  const pInput = await powerPlantInput();
  const res = runLayout(pInput, { timeBudget: 15, valves: false, seed: 1, quantumJump: 3 });
  assert.equal(res.summary.fullyRouted, true);
  const view = D.evaluateDoc(D.buildContext(buildProblem(pInput)), res.doc);
  assert.equal(errorsOf(view).length, 0, JSON.stringify(errorsOf(view).slice(0, 3)));
  assert.ok(res.doc.intersections.length > 0, 'the large pipes cross through intersection pieces');
});

test('surplus voidable outputs are not piped when the consumers are covered', async () => {
  const node = (id, recipeId, machineCount, settings = {}) => ({
    id,
    type: 'recipe',
    recipeId,
    machineCount,
    position: { x: 0, y: 0 },
    settings,
  });
  const pin = await powerInputFrom(
    [
      node('drill', 'r_mineshaft_drill_01', 6, {
        depth: 6000,
        drill_head: 'steel',
        acid_type: 'hydrochloric',
        has_machine_oil: 'No',
      }),
      node('bf', 'r_blast_furnace_13', 1),
    ],
    [{ id: 'e1', source: 'drill', sourceIndex: 2, target: 'bf', targetIndex: 1 }],
  );
  const problem = buildProblem(pin);
  const rock = problem.nets.find((n) => n.product === 'p_rock');
  assert.ok(rock, 'the rock connection becomes a pipe network');
  const sources = rock.terminals.filter((t) => t.direction === 'output');
  assert.ok(sources.length >= 1 && sources.length < 6, `${sources.length} drill(s) piped`);
  assert.ok(problem.notes.some((n) => n.includes('surplus')));
});

test('items and fluids never cross a large pipe through the same passthrough', async () => {
  const { Router } = await viteServer.ssrLoadModule('/src/gameLayout/engine/router.ts');
  const gw = 40;
  const gh = 24;
  const at = (x, y) => y * gw + x;
  const nets = [
    { large: true, kind: 'Fluid', terms: [new Set([at(0, 10)]), new Set([at(37, 10)])] },
    { large: false, kind: 'Item', terms: [new Set([at(18, 0)]), new Set([at(18, 22)])] },
    { large: false, kind: 'Fluid', terms: [new Set([at(19, 0)]), new Set([at(19, 22)])] },
  ];
  const r = new Router(gw, gh, new Uint8Array(gw * gh), nets, { jump: 3 });
  assert.equal(r.run(10, 40), true, 'routes without conflicts');
  const { passthroughs, bad } = r.checkCrossings();
  assert.equal(bad.size, 0);
  assert.equal(passthroughs.length, 2, 'one passthrough per kind');
  assert.notEqual(passthroughs[0].kind, passthroughs[1].kind);
});

test('a connection over one pipe capacity uses several ports of a single machine', async () => {
  const node = (id, recipeId, machineCount, settings = {}) => ({
    id,
    type: 'recipe',
    recipeId,
    machineCount,
    position: { x: 0, y: 0 },
    settings,
  });
  const pin = await powerInputFrom(
    [
      node('cpp', 'r_coal_power_plant_01', 16, { coal_feed: 27.5, air: 27.5, exhaust: 10 }),
      node('stack', 'r_exhaust_stack_02', 1),
    ],
    [{ id: 'e1', source: 'cpp', sourceIndex: 1, target: 'stack', targetIndex: 0 }],
  );
  const problem = buildProblem(pin);
  const exhaust = problem.nets.filter((n) => n.product === 'p_exhaust');
  const total = exhaust.reduce((a, n) => a + (n.flow ?? 0), 0);
  assert.ok(total > 12000, `the plan sends ${total.toFixed(0)}/s, more than one large pipe`);
  assert.equal(exhaust.length, 2, 'two pipe networks');
  for (const n of exhaust) assert.ok((n.flow ?? 0) <= n.capacity + 1e-6, 'none overloaded');
  const stackPorts = exhaust.map((n) => n.terminals.find((t) => t.direction === 'input').ports);
  assert.equal(stackPorts[0].length, 1);
  assert.notDeepEqual(stackPorts[0], stackPorts[1], 'each pipe on its own stack port');
});

test('power: reach, capacity and the grid are checked', async () => {
  const PW = await viteServer.ssrLoadModule('/src/gameLayout/engine/power.ts');
  const grid = { id: 'g', kind: 'grid', x: -30, y: 0, rot: 0 }; // reaches the HV pole only
  const hv = { id: 'h', kind: 'hv', x: 20, y: 0, rot: 0 }; // centre (26, 6)
  const tr = { id: 't', kind: 'transformer', x: 40, y: 0, rot: 0 }; // MV port (43.5, 0.5)
  const mv = { id: 'm', kind: 'mv', x: 50, y: 0, rot: 0 }; // centre (51, 0.5)
  const pieces = [grid, hv, tr, mv];
  const consumer = (key, at, type, load) => ({ inst: 0, key, at, type, load, assumed: false });
  // an HV machine 50 tiles from the HV pole and an MV machine 10 tiles from the MV pole
  let r = PW.solvePower(
    [consumer('0|0', [76, 6], 'HV', 5e6), consumer('1|0', [61, 0.5], 'MV', 1e6)],
    pieces,
  );
  assert.deepEqual(r.problems, []);
  assert.equal(r.unpowered.size, 0);
  // the transformer passes on its MV load plus 15 %
  const ti = pieces.indexOf(tr);
  assert.ok(Math.abs(r.load[pieces.indexOf(hv)] - (5e6 + 1e6 / 0.85)) < 1);
  assert.equal(r.load[ti], 1e6);
  // out of reach (MV: 22 - 2 tiles)
  r = PW.solvePower([consumer('0|0', [51 + 21, 0.5], 'MV', 1)], pieces);
  assert.equal(r.unpowered.size, 1);
  assert.equal(r.problems[0].code, 'unpowered');
  // an MV pole has 4 nodes of 1.5 MMF/s: five 1.4 MMF/s machines do not fit
  r = PW.solvePower(
    [0, 1, 2, 3, 4].map((i) => consumer(`${i}|0`, [66, 0.5], 'MV', 1.4e6)),
    pieces,
  );
  assert.ok(r.problems.some((p) => p.code === 'power-overload'));
  // a machine above one node's rating draws from several nodes of its pole
  r = PW.solvePower([consumer('0|0', [55, 0.5], 'MV', 3e6)], pieces);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(
    r.nodeUse[pieces.indexOf(mv)].filter((u) => u > 0),
    [1.5e6, 1.5e6],
  );
  // transformers power machines directly: MV side (MV reach), HV side (HV reach, no loss)
  r = PW.solvePower(
    [consumer('0|0', [43.5, 15], 'MV', 2e6), consumer('1|0', [43.5, 60], 'HV', 10e6)],
    [grid, hv, tr],
  );
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.feed, [2, 2], 'both on the transformer');
  assert.ok(Math.abs(r.load[1] - (2e6 / 0.85 + 10e6)) < 1, 'HV pole feeds both');
  // at most 240 MMF/s on each side
  r = PW.solvePower([consumer('0|0', [45, 70], 'HV', 250e6)], [grid, hv, tr]); // HV pole out of reach
  assert.ok(r.problems.some((p) => p.code === 'power-overload'));
  // the error names the piece that is full: here the pole feeding the machines' pole, whose
  // single node carries both machines (2 MMF/s over a 1.5 MMF/s node)
  const mv2 = { id: 'm2', kind: 'mv', x: 68, y: 0, rot: 0, feed: 'm' };
  r = PW.solvePower(
    [consumer('0|0', [80, 0.5], 'MV', 1e6), consumer('1|0', [80, 0.5], 'MV', 1e6)],
    [...pieces, mv2],
  );
  const over = r.problems.filter((p) => p.code === 'power-overload').map((p) => p.pieceId);
  assert.deepEqual(over, ['m'], 'the feeding pole, not the machines own pole');
  // no grid connection: nothing is powered
  r = PW.solvePower([consumer('0|0', [61, 0.5], 'MV', 1)], [hv, tr, mv]);
  assert.ok(r.problems.some((p) => p.code === 'no-grid'));
  assert.equal(r.unpowered.size, 1);
});

test('generated layouts power every machine and keep the plan in the saved document', () => {
  const res = runLayout(input, { timeBudget: 16, valves: false, seed: 4, quantumJump: 3 });
  const doc = normalizeLayoutDoc(JSON.parse(JSON.stringify(res.doc)));
  assert.ok(doc.power.length > 0, 'poles are placed');
  assert.ok(
    doc.power.some((p) => p.kind === 'grid'),
    'with a grid connection',
  );
  assert.ok(Object.keys(doc.powerFeeds).length > 0, 'machine feeds are saved');
  const view = D.evaluateDoc(ctx, doc);
  const power = view.problems.filter((p) =>
    ['unpowered', 'pole-unconnected', 'power-overload', 'no-grid', 'power-overlap'].includes(
      p.code,
    ),
  );
  assert.deepEqual(
    power.map((p) => p.message),
    [],
  );
});

test('grouping: same machines prefer one row or a mirrored pair, and options are used', async () => {
  const { Block } = await viteServer.ssrLoadModule('/src/gameLayout/engine/blocks.ts');
  const problem = buildProblem(input);
  const ni = problem.nodes.findIndex((n) => n.count >= 6 && !n.synthetic);
  const node = problem.nodes[ni];
  const ids = Array.from({ length: node.count }, (_v, i) => problem.instBase[ni] + i);
  const b = new Block(0, ni, node, ids, problem.nets);
  const n = node.count;
  assert.equal(b.rowsPenalty({ rot: 0, cols: n, alt: false }), 0, 'one row');
  assert.equal(b.rowsPenalty({ rot: 0, cols: Math.ceil(n / 2), alt: true }), 0, 'a mirrored pair');
  assert.ok(b.rowsPenalty({ rot: 0, cols: Math.ceil(n / 2), alt: false }) > 0, 'unmirrored pair');
  assert.ok(b.rowsPenalty({ rot: 0, cols: Math.ceil(n / 3), alt: true }) > 0, 'three rows');
  const res = runLayout(input, {
    timeBudget: 12,
    valves: false,
    seed: 5,
    quantumJump: 3,
    power: false,
    grouping: { rows: true, flowOrder: true, facing: true, strength: 1 },
  });
  assert.equal(res.summary.fullyRouted, true);
  assert.equal(errorsOf(D.evaluateDoc(ctx, res.doc)).length, 0);
});
