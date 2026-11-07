/**
 * The in-game layout document against the current flowchart: matching machines and pipes,
 * the engine Solution built from it (for validation and the flow analysis), and the list of
 * problems the editor shows. Pure functions; nothing here touches the stores.
 */
import { pieceName, pieceTiles as powerTiles } from './engine/power';
import type { GameLayoutDoc, DocMachine, DocPipe, DocValve, DocPassthrough } from './docSchema';
import { Analysis, type Junction, type PlacedValve } from './engine/flows';
import { accessCells, rot, valveShape, type Cell, type Shape } from './engine/geometry';
import type { Problem } from './engine/problem';
import { crossSpan, EDGE_CROSS, EDGE_LCROSS, EDGE_LNODE, lnodeEnd } from './engine/router';
import { key, KX, kx, ky, Solution, type SolMachine } from './engine/solution';
import { spacingViolations, type SpacedRect } from './engine/spacing';

export type ProblemSeverity = 'error' | 'warning';

export interface LayoutProblem {
  severity: ProblemSeverity;
  code:
    | 'overlap'
    | 'pipe-under-machine'
    | 'unconnected'
    | 'unrouted'
    | 'broken-pipe'
    | 'conflict'
    | 'no-passthrough'
    | 'bad-passthrough'
    | 'no-intersection'
    | 'bad-intersection'
    | 'bad-valve'
    | 'spacing'
    | 'orphan-machine'
    | 'orphan-pipe'
    | 'unplaced'
    | 'starved'
    | 'unpowered'
    | 'pole-unconnected'
    | 'power-overload'
    | 'no-grid'
    | 'power-overlap';
  message: string;
  /** Tiles to highlight / zoom to. */
  tiles: [number, number][];
  machineKey?: string;
  netKey?: string;
  pieceId?: string;
}

/** Problem (the engine's model of the flowchart) plus key lookups. */
export interface LayoutContext {
  problem: Problem;
  instKeys: string[];
  instByKey: Map<string, number>;
  netByKey: Map<string, number>;
}

export function instanceKey(problem: Problem, inst: number): string {
  const [ni, li] = problem.instances[inst];
  return `${problem.nodes[ni].id}#${li}`;
}

export function buildContext(problem: Problem): LayoutContext {
  const instKeys = problem.instances.map((_v, g) => instanceKey(problem, g));
  return {
    problem,
    instKeys,
    instByKey: new Map(instKeys.map((k, g) => [k, g])),
    netByKey: new Map(problem.nets.map((n, i) => [n.key, i])),
  };
}

/** Footprint of an instance at a rotation. */
export function instanceShape(ctx: LayoutContext, inst: number, r: number): Shape {
  return rot(ctx.problem.nodes[ctx.problem.instances[inst][0]].shape, r);
}

// ------------------------------------------------------------------ valve geometry

export interface ValveGeometry {
  /** In, middle and straight-out tiles (absolute). */
  a: Cell;
  m: Cell;
  e: Cell;
  /** Tiles just outside the in end, the straight end and the side of the middle tile. */
  inAt: Cell;
  straightAt: Cell;
  sideAt: Cell;
  w: number;
  h: number;
}

export function valveGeometry(v: Pick<DocValve, 'x' | 'y' | 'rot'>): ValveGeometry {
  const sh = rot(valveShape('Item'), v.rot);
  const at = (pid: string) => {
    const p = sh.ports.get(pid)!;
    const [cx, cy] = p.cells[0];
    const [ax, ay] = accessCells(p)[0];
    return {
      cell: [v.x + cx, v.y + cy] as Cell,
      out: [v.x + ax, v.y + ay] as Cell,
    };
  };
  const i = at('valve_in');
  const s = at('valve_side');
  const e = at('valve_straight');
  return {
    a: i.cell,
    m: s.cell,
    e: e.cell,
    inAt: i.out,
    straightAt: e.out,
    sideAt: s.out,
    w: sh.w,
    h: sh.h,
  };
}

/** Tiles of a passthrough piece and its two crossing columns / rows. */
export function passthroughTiles(p: Pick<DocPassthrough, 'x' | 'y' | 'horizontal'>): Cell[] {
  const out: Cell[] = [];
  const [w, h] = p.horizontal ? [4, 2] : [2, 4];
  for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) out.push([p.x + dx, p.y + dy]);
  return out;
}

// ------------------------------------------------------------------ evaluation

export interface DocView {
  ctx: LayoutContext;
  doc: GameLayoutDoc;
  sol: Solution;
  /** Instances placed on the grid. */
  placed: Set<number>;
  unplaced: number[];
  /** Doc machine per instance. */
  machineOf: Map<number, DocMachine>;
  orphanMachines: DocMachine[];
  orphanPipes: DocPipe[];
  /** Net index per doc pipe index (-1 = orphan). */
  pipeNet: number[];
  valves: PlacedValve[];
  problems: LayoutProblem[];
  /** Flows and the even-split check (null until computed; the editor runs it in a worker). */
  analysis: AnalysisData | null;
}

/** Flows of one pipe network (plain data, so it can come from a worker). */
export interface NetFlowData {
  adj: Map<number, Set<number>>;
  edgeFlow: Map<string, number>;
  simFlow: Map<string, number>;
  valveFlow: Map<string, number>;
  junctions: Map<number, Junction>;
}

export interface AnalysisData {
  nets: NetFlowData[];
  plannedRun: number[];
  runEven: number[] | null;
  runValve: number[] | null;
  /** [node, achievable machines, with even splits, as built]. */
  groups: [number, number, number, number][];
}

/** Flow analysis of an evaluated layout (valves at their settings). */
export function analyseView(P: Problem, sol: Solution, valves: PlacedValve[]): AnalysisData {
  const an = new Analysis(P, sol).analyse(valves, new Set(valves.map((v) => v.net)), []);
  return {
    nets: an.nets.map((nf) => ({
      adj: nf.adj,
      edgeFlow: nf.edgeFlow,
      simFlow: nf.simFlow,
      valveFlow: nf.valveFlow,
      junctions: nf.junctions,
    })),
    plannedRun: an.plannedRun,
    runEven: an.runEven,
    runValve: an.runValve,
    groups: an.groups,
  };
}

/** Machine groups (fully placed) that fall short of their plan as built. */
export function starvedProblems(
  P: Problem,
  placed: Set<number>,
  an: AnalysisData,
): LayoutProblem[] {
  const out: LayoutProblem[] = [];
  for (const [ni, plan, , withV] of an.groups) {
    const node = P.nodes[ni];
    const all = P.instances.every(([n], g) => n !== ni || placed.has(g));
    if (!all || withV >= plan * 0.995) continue;
    out.push({
      severity: 'warning',
      code: 'starved',
      message: `${node.name} runs at ${((100 * withV) / Math.max(plan, 1e-9)).toFixed(0)}% of plan (even-split check)`,
      tiles: [],
    });
  }
  return out;
}

const xy = (c: number): [number, number] => [kx(c), ky(c)];

export function evaluateDoc(
  ctx: LayoutContext,
  doc: GameLayoutDoc,
  opts: { analyse?: boolean; jump?: number } = {},
): DocView {
  const P = ctx.problem;
  const problems: LayoutProblem[] = [];
  const machines: SolMachine[] = [];
  const machineOf = new Map<number, DocMachine>();
  const orphanMachines: DocMachine[] = [];
  for (const m of doc.machines) {
    const g = ctx.instByKey.get(m.key);
    if (g === undefined || machineOf.has(g)) {
      orphanMachines.push(m);
      continue;
    }
    machineOf.set(g, m);
    machines.push({
      inst: g,
      node: P.instances[g][0],
      x: m.x,
      y: m.y,
      shape: instanceShape(ctx, g, m.rot),
      rot: m.rot,
      local: P.instances[g][1],
    });
  }
  const placed = new Set(machineOf.keys());
  const unplaced = P.instances.map((_v, g) => g).filter((g) => !placed.has(g));

  const netNodes = P.nets.map(() => new Set<number>());
  const netEdges: number[][] = P.nets.map(() => []);
  const orphanPipes: DocPipe[] = [];
  const pipeNet: number[] = [];
  for (const p of doc.pipes) {
    const ni = ctx.netByKey.get(p.net);
    if (ni === undefined || P.nets[ni].large !== p.large) {
      orphanPipes.push(p);
      pipeNet.push(-1);
      continue;
    }
    pipeNet.push(ni);
    for (let i = 0; i + 1 < p.nodes.length; i += 2)
      netNodes[ni].add(key(p.nodes[i], p.nodes[i + 1]));
    for (let i = 0; i + 4 < p.edges.length + 1; i += 5) {
      const a = key(p.edges[i], p.edges[i + 1]);
      const b = key(p.edges[i + 2], p.edges[i + 3]);
      netNodes[ni].add(a);
      netNodes[ni].add(b);
      netEdges[ni].push(a, b, p.edges[i + 4]);
    }
  }
  const failed = P.nets.map((_n, i) => i).filter((i) => netNodes[i].size === 0);
  const sol = new Solution(P, machines, netNodes, netEdges, failed, opts.jump ?? 3, false);
  sol.ok = true;
  const feeds = new Map<string, string>();
  for (const [k, id] of Object.entries(doc.powerFeeds ?? {})) {
    const cut = k.lastIndexOf('|');
    const inst = ctx.instByKey.get(k.slice(0, cut));
    if (inst !== undefined) feeds.set(`${inst}|${k.slice(cut + 1)}`, id);
  }
  sol.setPower(
    (doc.power ?? []).map((p) => ({ ...p })),
    feeds,
  );

  // ---- machines
  const seen = new Map<number, number>();
  const overlapTiles: [number, number][] = [];
  for (const m of machines) {
    for (const r of m.shape.rects) {
      for (let y = r.y; y < r.y + r.h; y++) {
        for (let x = r.x; x < r.x + r.w; x++) {
          const c = key(m.x + x, m.y + y);
          const other = seen.get(c);
          if (other !== undefined && other !== m.inst) overlapTiles.push([m.x + x, m.y + y]);
          else seen.set(c, m.inst);
        }
      }
    }
  }
  if (overlapTiles.length) {
    problems.push({
      severity: 'error',
      code: 'overlap',
      message: `Machines overlap on ${overlapTiles.length} tile(s)`,
      tiles: overlapTiles,
    });
  }
  // machines / pipes of flowchart items that were deleted are kept out of sight (so undoing
  // the delete brings them back where they were); they are not drawn and not reported
  if (unplaced.length) {
    problems.push({
      severity: 'warning',
      code: 'unplaced',
      message: `${unplaced.length} machine(s) not placed yet`,
      tiles: [],
    });
  }
  if (P.spacing.size) {
    const rects: SpacedRect[] = [];
    for (const m of machines) {
      const d = P.spacing.get(m.shape.id);
      if (d)
        rects.push({
          type: m.shape.id,
          id: m.inst,
          rect: [m.x, m.y, m.shape.w, m.shape.h],
          min: d,
        });
    }
    for (const v of spacingViolations(rects, P.spacingMeasure)) {
      problems.push({
        severity: 'error',
        code: 'spacing',
        message: `Two ${P.nodes[P.instances[v.a.id][0]].shape.name}s are ${v.dist.toFixed(0)} tiles apart (need ${v.need})`,
        tiles: [
          [v.a.rect[0], v.a.rect[1]],
          [v.b.rect[0], v.b.rect[1]],
        ],
        machineKey: ctx.instKeys[v.a.id],
      });
    }
  }

  // ---- pipes
  const instM = new Map(machines.map((m) => [m.inst, m]));
  P.nets.forEach((net, ni) => {
    const nodes = netNodes[ni];
    const allPlaced = net.terminals.every((t) => placed.has(t.inst));
    if (!nodes.size) {
      if (allPlaced) {
        problems.push({
          severity: 'warning',
          code: 'unrouted',
          message: `${net.label} is not routed`,
          tiles: [],
          netKey: net.key,
        });
      }
      return;
    }
    const under: [number, number][] = [];
    for (const c of sol.cells[ni]) if (sol.blocked.has(c)) under.push(xy(c));
    if (under.length) {
      problems.push({
        severity: 'error',
        code: 'pipe-under-machine',
        message: `${net.label} runs under a machine`,
        tiles: under,
        netKey: net.key,
      });
    }
    for (const t of net.terminals) {
      const m = instM.get(t.inst);
      if (!m) continue;
      if (
        !(t.qports ?? t.ports).some((pid) =>
          sol.access(m, pid, net.large).some((a) => nodes.has(a)),
        )
      ) {
        const [nIdx, li] = P.instances[t.inst];
        problems.push({
          severity: 'error',
          code: 'unconnected',
          message: `${net.label} does not reach ${P.nodes[nIdx].shape.name} #${li + 1}`,
          tiles: [[m.x + Math.floor(m.shape.w / 2), m.y + Math.floor(m.shape.h / 2)]],
          netKey: net.key,
          machineKey: ctx.instKeys[t.inst],
        });
      }
    }
    // segments and connectivity
    const adj = new Map<number, number[]>();
    const e = netEdges[ni];
    const bad: [number, number][] = [];
    for (let i = 0; i < e.length; i += 3) {
      const a = e[i];
      const b = e[i + 1];
      const kind = e[i + 2];
      const d = Math.abs(kx(a) - kx(b)) + Math.abs(ky(a) - ky(b));
      const straight = kx(a) === kx(b) || ky(a) === ky(b);
      // through an intersection piece a large pipe may also turn (2 apart in x and in y)
      const corner =
        kind === EDGE_LCROSS && Math.abs(kx(a) - kx(b)) === 2 && Math.abs(ky(a) - ky(b)) === 2;
      let ok = straight || corner;
      if (kind === 0) ok &&= d === 1;
      else if (kind === 1) ok &&= !net.large && d >= 2 && d <= Math.max(1, sol.jump);
      else if (kind === EDGE_LNODE) {
        // 2 straight into the spot right outside a machine node (quantum piping)
        ok &&= net.large && d === 2 && lnodeEnd(a, b, KX, (t) => sol.blocked.has(t)) >= 0;
      } else if (kind === EDGE_CROSS) {
        ok &&= !net.large && (d === 3 || d === 2);
        // 2 long: into a machine node through a passthrough flat against it (quantum piping)
        if (ok && d === 2) {
          const { end } = crossSpan(a, b, KX, (t) => sol.blocked.has(t));
          ok = end >= 0 && !!sol.occL.get(end);
        }
      } else ok &&= net.large && d === 4;
      if (ok && kind === 1) {
        const sx = Math.sign(kx(b) - kx(a));
        const sy = Math.sign(ky(b) - ky(a));
        for (let s = 1; s < d; s++) {
          const q = key(kx(a) + sx * s, ky(a) + sy * s);
          if (sol.blocked.has(q) || sol.occL.get(q)) ok = false;
        }
      }
      if (!ok) bad.push(xy(a));
      if (!adj.has(a)) adj.set(a, []);
      if (!adj.has(b)) adj.set(b, []);
      adj.get(a)!.push(b);
      adj.get(b)!.push(a);
    }
    if (bad.length) {
      problems.push({
        severity: 'error',
        code: 'broken-pipe',
        message: `${net.label} has ${bad.length} invalid segment(s)`,
        tiles: bad,
        netKey: net.key,
      });
    }
    const start = nodes.values().next().value as number;
    const stack = [start];
    const vis = new Set([start]);
    while (stack.length) {
      const c = stack.pop()!;
      for (const d of adj.get(c) ?? []) {
        if (!vis.has(d)) {
          vis.add(d);
          stack.push(d);
        }
      }
    }
    if (vis.size !== nodes.size) {
      const loose = [...nodes]
        .filter((c) => !vis.has(c))
        .slice(0, 50)
        .map(xy);
      problems.push({
        severity: 'error',
        code: 'broken-pipe',
        message: `${net.label} is split into separate pieces`,
        tiles: loose,
        netKey: net.key,
      });
    }
  });
  const over = sol.overfull();
  if (over.length) {
    problems.push({
      severity: 'error',
      code: 'conflict',
      message: `${over.length} tile(s) hold pipes that cannot share them`,
      tiles: over.map(xy),
    });
  }

  // ---- passthroughs: every crossing needs a piece, every piece must sit on a straight run
  const ptByTile = new Map<number, DocPassthrough>();
  for (const pt of doc.passthroughs)
    for (const [x, y] of passthroughTiles(pt)) ptByTile.set(key(x, y), pt);
  for (const c of sol.crossings()) {
    const pt = ptByTile.get(key(c.x, c.y));
    // crossing tiles: (x, y) and the next one across the large pipe
    const ok =
      pt &&
      pt.horizontal === c.vertical &&
      pt.kind === c.kind &&
      (pt.horizontal
        ? c.y === pt.y && (c.x === pt.x + 1 || c.x === pt.x + 2)
        : c.x === pt.x && (c.y === pt.y + 1 || c.y === pt.y + 2));
    if (!ok) {
      problems.push({
        severity: 'error',
        code: 'no-passthrough',
        message: `${P.nets[c.net].label} crosses a large pipe without a ${c.kind.toLowerCase()} passthrough`,
        tiles: [[c.x, c.y]],
        netKey: P.nets[c.net].key,
      });
    }
  }
  for (const pt of doc.passthroughs) {
    const why = passthroughProblem(sol, pt);
    if (why) {
      problems.push({
        severity: 'error',
        code: 'bad-passthrough',
        message: `Passthrough: ${why}`,
        tiles: [[pt.x, pt.y]],
        pieceId: pt.id,
      });
    }
  }

  // ---- intersections
  const inter = new Set(doc.intersections.map((i) => key(i.x, i.y)));
  const usedInter = new Set<number>();
  for (const it of sol.intersections()) {
    const k = key(it.x, it.y);
    usedInter.add(k);
    if (!inter.has(k)) {
      problems.push({
        severity: 'error',
        code: 'no-intersection',
        message: `${P.nets[it.nets[0]].label} goes through a large pipe intersection that has no piece`,
        tiles: [[it.x, it.y]],
        netKey: P.nets[it.nets[0]].key,
      });
    }
  }
  const badInter = new Set(sol.badIntersections());
  for (const it of doc.intersections) {
    const k = key(it.x, it.y);
    if (!usedInter.has(k)) {
      problems.push({
        severity: 'warning',
        code: 'bad-intersection',
        message: 'Intersection piece without a large pipe going through it',
        tiles: [[it.x, it.y]],
        pieceId: it.id,
      });
    } else if (badInter.has(k)) {
      problems.push({
        severity: 'error',
        code: 'bad-intersection',
        message:
          'Pipes on an intersection must each enter and leave through their own sides (at most two pipes)',
        tiles: [[it.x, it.y]],
        pieceId: it.id,
      });
    }
  }

  // ---- power: every machine on a pole of its voltage, poles on the grid, within capacity
  const pr = sol.powerResult;
  if (pr) {
    for (const q of pr.problems) {
      const inst = q.inst;
      problems.push({
        severity: 'error',
        code: q.code,
        message: q.message,
        tiles: q.tiles,
        ...(inst !== undefined ? { machineKey: ctx.instKeys[inst] } : {}),
        ...(q.pieceId ? { pieceId: q.pieceId } : {}),
      });
    }
  } else if (machines.some((m) => (P.nodes[m.node].powerUse ?? 0) > 0)) {
    problems.push({
      severity: 'warning',
      code: 'unpowered',
      message: 'No power poles yet: run the generator or place poles and a grid connection',
      tiles: [],
    });
  }
  {
    const busy = new Set<number>();
    for (const c of sol.blocked.keys()) busy.add(c);
    for (const cs of sol.cells) for (const c of cs) busy.add(c);
    for (const p of doc.power ?? []) {
      const clash = powerTiles(p).find(([x, y]) => busy.has(key(x, y)));
      for (const [x, y] of powerTiles(p)) busy.add(key(x, y));
      if (clash) {
        problems.push({
          severity: 'error',
          code: 'power-overlap',
          message: `${pieceName(p.kind)} sits on a machine, a pipe or another power piece`,
          tiles: [clash],
          pieceId: p.id,
        });
      }
    }
  }

  // ---- valves
  const valves: PlacedValve[] = [];
  const valveTiles = new Map<number, string>();
  for (const v of doc.valves) {
    const g = valveGeometry(v);
    const [A, M, E] = [g.a, g.m, g.e].map(([x, y]) => key(x, y));
    const fail = (why: string) =>
      problems.push({
        severity: 'error',
        code: 'bad-valve',
        message: `Valve: ${why}`,
        tiles: [g.m as [number, number]],
        pieceId: v.id,
      });
    if ([A, M, E].some((t) => valveTiles.has(t))) {
      fail('overlaps another valve');
      continue;
    }
    for (const t of [A, M, E]) valveTiles.set(t, v.id);
    if ([A, M, E].some((t) => sol.blocked.has(t))) {
      fail('sits on a machine');
      continue;
    }
    const owners = P.nets.map((_n, i) => i).filter((i) => netNodes[i].has(M));
    if (owners.length !== 1) {
      fail(owners.length ? 'more than one pipe runs through it' : 'no pipe runs through it');
      continue;
    }
    const ni = owners[0];
    const net = P.nets[ni];
    if (net.large) {
      fail('large pipes have no valve');
      continue;
    }
    if (
      [A, E].some((t) => !netNodes[ni].has(t)) ||
      [A, M, E].some((t) => (sol.occS.get(t) ?? 0) > 1)
    ) {
      fail('the pipe must run straight through all three tiles, alone');
      continue;
    }
    // no check on which way pipes enter or leave: with quantum piping a valve works whatever
    // direction its connections come from (even perpendicular to the main pipe)
    const sdAt = key(g.sideAt[0], g.sideAt[1]);
    valves.push({
      net: ni,
      label: net.label,
      node: M,
      split: [],
      tiles: [A, M, E],
      dir: [g.e[0] - g.m[0], g.e[1] - g.m[1]],
      straight: E,
      side: sdAt,
      rebuilt: false,
      sidePct: v.sidePct,
    });
  }

  let analysis: AnalysisData | null = null;
  if (opts.analyse !== false) {
    analysis = analyseView(P, sol, valves);
    problems.push(...starvedProblems(P, placed, analysis));
  }
  return {
    ctx,
    doc,
    sol,
    placed,
    unplaced,
    machineOf,
    orphanMachines,
    orphanPipes,
    pipeNet,
    valves,
    problems,
    analysis,
  };
}

/** Why a passthrough piece is not valid where it is (null = fine). */
export function passthroughProblem(sol: Solution, pt: DocPassthrough): string | null {
  const tiles = passthroughTiles(pt).map(([x, y]) => key(x, y));
  const owners = new Set(tiles.map((t) => sol.largeOwner.get(t) ?? -1));
  if (owners.size !== 1 || owners.has(-1) || owners.has(-2)) {
    return 'must sit on exactly one large pipe';
  }
  const ln = [...owners][0];
  for (const t of tiles) {
    if (sol.occS.get(t)) return 'a normal pipe runs along it (only crossings may pass)';
    if (sol.blocked.has(t)) return 'sits on a machine';
  }
  // straight run: the large pipe has no tile right beside the piece
  const [w, h] = pt.horizontal ? [4, 2] : [2, 4];
  for (let i = 0; i < (pt.horizontal ? w : h); i++) {
    const side = pt.horizontal
      ? [key(pt.x + i, pt.y - 1), key(pt.x + i, pt.y + 2)]
      : [key(pt.x - 1, pt.y + i), key(pt.x + 2, pt.y + i)];
    if (side.some((t) => sol.largeOwner.get(t) === ln))
      return 'the large pipe must run straight through it';
  }
  // crossings only in the two middle tiles
  for (let i = 0; i < 4; i++) {
    if (i === 1 || i === 2) continue;
    const cells = pt.horizontal
      ? [key(pt.x + i, pt.y), key(pt.x + i, pt.y + 1)]
      : [key(pt.x, pt.y + i), key(pt.x + 1, pt.y + i)];
    if (cells.some((t) => sol.occX.get(t))) return 'crossings must use the two middle tiles';
  }
  return null;
}

/** Empty layout document ready for editing. */
export { emptyLayoutDoc } from './docSchema';
