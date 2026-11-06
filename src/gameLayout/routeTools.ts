/**
 * Router-backed editing tools: re-route networks around everything else, route what is not
 * routed yet, and find the path for a click-to-click pipe. They work on the document's own
 * coordinates through a temporary grid around the layout.
 */
import type { DocView } from './doc';
import { passthroughTiles } from './doc';
import type { DocPassthrough, GameLayoutDoc } from './docSchema';
import { addIntersection, addPassthrough, pipeGraph, setPipe, type PipeGraph } from './docOps';
import { accessCells, largeAnchor, occupied } from './engine/geometry';
import { EDGE_LCROSS, Router, type RouterNet } from './engine/router';
import { key, kx, ky } from './engine/solution';
import { now } from './engine/clock';

const MARGIN = 24;

export interface EditorGrid {
  router: Router;
  ox: number;
  oy: number;
  gw: number;
  gh: number;
  toGrid(k: number): number;
  fromGrid(c: number): number;
  inside(x: number, y: number): boolean;
}

/** Bounds of everything in the document, plus a margin to route around the outside. */
function bounds(view: DocView, extra: [number, number][] = []): [number, number, number, number] {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const add = (x: number, y: number, w = 1, h = 1) => {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x + w);
    y1 = Math.max(y1, y + h);
  };
  for (const m of view.sol.machines) add(m.x, m.y, m.shape.w, m.shape.h);
  for (const cells of view.sol.cells) for (const c of cells) add(kx(c), ky(c));
  for (const [x, y] of extra) add(x, y);
  if (!Number.isFinite(x0)) return [-MARGIN, -MARGIN, MARGIN, MARGIN];
  return [x0 - MARGIN, y0 - MARGIN, x1 + MARGIN, y1 + MARGIN];
}

/**
 * A router over the layout: machines block, every network's current route is committed, and
 * each network's terminals are the ports of placed machines.
 */
export function buildEditorGrid(view: DocView, extra: [number, number][] = []): EditorGrid {
  const P = view.ctx.problem;
  const [x0, y0, x1, y1] = bounds(view, extra);
  const gw = x1 - x0;
  const gh = y1 - y0;
  const inside = (x: number, y: number) => x >= x0 && y >= y0 && x < x1 && y < y1;
  const toGrid = (k: number) => (ky(k) - y0) * gw + (kx(k) - x0);
  const fromGrid = (c: number) => key((c % gw) + x0, Math.floor(c / gw) + y0);
  const blocked = new Uint8Array(gw * gh);
  for (const m of view.sol.machines) {
    for (const [cx, cy] of occupied(m.shape)) {
      if (inside(m.x + cx, m.y + cy)) blocked[(m.y + cy - y0) * gw + m.x + cx - x0] = 1;
    }
  }
  const instM = new Map(view.sol.machines.map((m) => [m.inst, m]));
  const rnets: RouterNet[] = P.nets.map((net) => ({
    large: net.large,
    kind: net.kind,
    terms: net.terminals
      .filter((t) => instM.has(t.inst))
      .map((t) => {
        const m = instM.get(t.inst)!;
        const cells = new Set<number>();
        for (const pid of t.ports) {
          const p = m.shape.ports.get(pid);
          if (!p) continue;
          const pts = net.large ? [largeAnchor(p)] : accessCells(p);
          for (const [ax, ay] of pts) {
            const x = ax + m.x;
            const y = ay + m.y;
            if (!inside(x, y) || (net.large && !inside(x + 1, y + 1))) continue;
            const c = (y - y0) * gw + (x - x0);
            if (!net.large && blocked[c]) continue;
            cells.add(c);
          }
        }
        return cells;
      }),
  }));
  const router = new Router(gw, gh, blocked, rnets, { jump: view.sol.jump });
  for (const rn of rnets) {
    if (rn.large)
      rn.terms = rn.terms.map((t) => new Set([...t].filter((a) => !router.blockedL[a])));
  }
  // valve tiles belong to their pipe alone: keep every other pipe off them
  for (const v of view.valves) {
    for (const t of v.tiles) {
      if (inside(kx(t), ky(t))) router.hist[toGrid(t)] = 1e4;
    }
  }
  P.nets.forEach((_net, ni) => {
    const nodes = view.sol.netNodes[ni];
    if (!nodes.size) return;
    const tree = new Set<number>();
    for (const c of nodes) if (inside(kx(c), ky(c))) tree.add(toGrid(c));
    const e = view.sol.netEdges[ni];
    const edges: number[] = [];
    for (let i = 0; i < e.length; i += 3) {
      if (!inside(kx(e[i]), ky(e[i])) || !inside(kx(e[i + 1]), ky(e[i + 1]))) continue;
      edges.push(toGrid(e[i]), toGrid(e[i + 1]), e[i + 2]);
    }
    router.commit(ni, tree, edges);
  });
  return { router, ox: x0, oy: y0, gw, gh, toGrid, fromGrid, inside };
}

function graphOf(grid: EditorGrid, ni: number): PipeGraph {
  const r = grid.router;
  const nodes = new Set<number>();
  for (const c of r.tree[ni]) nodes.add(grid.fromGrid(c));
  const edges: number[] = [];
  const e = r.edges[ni];
  for (let i = 0; i < e.length; i += 3)
    edges.push(grid.fromGrid(e[i]), grid.fromGrid(e[i + 1]), e[i + 2]);
  return { nodes, edges };
}

/** Add passthrough / intersection pieces for crossings of `nets` that have none yet. */
function addMissingPieces(doc: GameLayoutDoc, grid: EditorGrid, nets: Set<number>): GameLayoutDoc {
  let d = doc;
  const covered = new Set<number>();
  for (const pt of d.passthroughs)
    for (const [x, y] of passthroughTiles(pt)) covered.add(key(x, y));
  const { passthroughs } = grid.router.checkCrossings();
  for (const p of passthroughs) {
    if (!nets.has(p.slots[0]) && !nets.has(p.slots[1])) continue;
    const k = grid.fromGrid(p.y * grid.gw + p.x);
    if (covered.has(k)) continue;
    const piece: Pick<DocPassthrough, 'x' | 'y' | 'horizontal'> = {
      x: kx(k),
      y: ky(k),
      horizontal: p.w > p.h,
    };
    for (const [x, y] of passthroughTiles(piece)) covered.add(key(x, y));
    d = addPassthrough(d, piece.x, piece.y, piece.horizontal, p.kind);
  }
  const have = new Set(d.intersections.map((i) => key(i.x, i.y)));
  for (const ni of nets) {
    const e = grid.router.edges[ni];
    for (let i = 0; i < e.length; i += 3) {
      if (e[i + 2] !== EDGE_LCROSS) continue;
      const mid = grid.fromGrid(e[i] + (e[i + 1] - e[i]) / 2);
      if (have.has(mid)) continue;
      have.add(mid);
      d = addIntersection(d, kx(mid), ky(mid));
    }
  }
  return d;
}

export interface RouteOutcome {
  doc: GameLayoutDoc;
  routed: number;
  failed: string[];
  conflictFree: boolean;
}

/**
 * Route (or re-route) the given networks around everything else. Pinned pipes are never
 * touched; networks whose machines are not all placed are routed between the placed ones.
 */
export function routeNetworks(view: DocView, nets: number[], timeLimit = 8): RouteOutcome {
  const P = view.ctx.problem;
  const pinned = new Set(view.doc.pipes.filter((p) => p.pinned).map((p) => p.net));
  const todo = nets.filter((ni) => !pinned.has(P.nets[ni].key));
  if (!todo.length) return { doc: view.doc, routed: 0, failed: [], conflictFree: true };
  const grid = buildEditorGrid(view);
  const ok = grid.router.runSubset(todo, timeLimit, () => now() / 1000);
  let doc = view.doc;
  const failed: string[] = [];
  for (const ni of todo) {
    const net = P.nets[ni];
    if (grid.router.failed.has(ni)) failed.push(net.label);
    doc = setPipe(doc, net.key, net.large, net.productName, graphOf(grid, ni));
  }
  doc = addMissingPieces(doc, grid, new Set(todo));
  return { doc, routed: todo.length - failed.length, failed, conflictFree: ok };
}

/** Networks with placed machines on both ends that have no complete route. */
export function unroutedNetworks(view: DocView): number[] {
  const P = view.ctx.problem;
  const bad = new Set<string>();
  for (const pr of view.problems) {
    if (
      (pr.code === 'unrouted' || pr.code === 'unconnected' || pr.code === 'broken-pipe') &&
      pr.netKey
    ) {
      bad.add(pr.netKey);
    }
  }
  return P.nets
    .map((n, i) => [n, i] as const)
    .filter(
      ([n]) => bad.has(n.key) && n.terminals.filter((t) => view.placed.has(t.inst)).length >= 2,
    )
    .map(([, i]) => i);
}

/**
 * Click-to-click pipe: the cheapest legal path for net ni from `from` to `to` (tile keys; large
 * pipes use 2x2 anchors) around everything already in the layout.
 */
export function pathBetween(
  view: DocView,
  ni: number,
  from: number[],
  to: number[],
): { nodes: number[]; edges: number[] } | null {
  const grid = buildEditorGrid(
    view,
    [...from, ...to].map((k) => [kx(k), ky(k)] as [number, number]),
  );
  const conv = (ks: number[]) => ks.filter((k) => grid.inside(kx(k), ky(k))).map(grid.toGrid);
  const path = grid.router.findPath(ni, conv(from), conv(to));
  if (!path) return null;
  const nodes: number[] = [];
  const edges: number[] = [];
  for (let i = 0; i < path.length; i += 2) {
    const c = grid.fromGrid(path[i]);
    nodes.push(c);
    if (i + 2 < path.length) edges.push(grid.fromGrid(path[i + 2]), c, path[i + 1]);
  }
  return { nodes, edges };
}

/** After a pipe edit: add pieces for its new crossings. */
export function withPiecesFor(view: DocView, ni: number): GameLayoutDoc {
  const grid = buildEditorGrid(view);
  return addMissingPieces(view.doc, grid, new Set([ni]));
}

export { pipeGraph };
