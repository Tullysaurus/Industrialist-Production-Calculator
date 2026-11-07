/**
 * Immutable edits of the in-game layout document. Every function returns a new document (or
 * the same one when nothing changed), so documents can be kept as undo snapshots.
 */
import { pieceTiles as powerTiles } from './engine/power';
import type {
  DocIntersection,
  DocPowerPiece,
  DocMachine,
  DocPassthrough,
  DocPipe,
  DocValve,
  GameLayoutDoc,
} from './docSchema';
import { emptyLayoutDoc } from './docSchema';
import { instanceKey, instanceShape, type LayoutContext } from './doc';
import { valveShape, rot, type Shape } from './engine/geometry';
import type { Problem } from './engine/problem';
import { key, kx, ky, type Solution } from './engine/solution';

let idSeq = 0;
export function newPieceId(prefix: string): string {
  idSeq += 1;
  return `${prefix}-${Date.now().toString(36)}-${idSeq.toString(36)}`;
}

export const ensureDoc = (doc: GameLayoutDoc | null): GameLayoutDoc => doc ?? emptyLayoutDoc();

// ------------------------------------------------------------------ machines

export function placeMachine(
  doc: GameLayoutDoc | null,
  ctx: LayoutContext,
  inst: number,
  x: number,
  y: number,
  r: number,
): GameLayoutDoc {
  const d = ensureDoc(doc);
  const k = ctx.instKeys[inst];
  const node = ctx.problem.nodes[ctx.problem.instances[inst][0]];
  const m: DocMachine = {
    key: k,
    x,
    y,
    rot: ((r % 4) + 4) % 4,
    name: `${node.shape.name} #${ctx.problem.instances[inst][1] + 1}`,
    w: node.shape.w,
    h: node.shape.h,
  };
  return { ...d, machines: [...d.machines.filter((o) => o.key !== k), m] };
}

/** Move machines (and the valves / pieces given by id) by whole tiles. */
export function moveItems(
  doc: GameLayoutDoc,
  sel: Selection,
  dx: number,
  dy: number,
): GameLayoutDoc {
  if (!dx && !dy) return doc;
  const mv = <T extends { x: number; y: number }>(o: T): T => ({ ...o, x: o.x + dx, y: o.y + dy });
  return {
    ...doc,
    machines: doc.machines.map((m) => (sel.machines.has(m.key) ? mv(m) : m)),
    valves: doc.valves.map((v) => (sel.pieces.has(v.id) ? mv(v) : v)),
    passthroughs: doc.passthroughs.map((p) => (sel.pieces.has(p.id) ? mv(p) : p)),
    intersections: doc.intersections.map((p) => (sel.pieces.has(p.id) ? mv(p) : p)),
    power: (doc.power ?? []).map((p) => (sel.pieces.has(p.id) ? mv(p) : p)),
    pipes: doc.pipes.map((p) => (sel.pipes.has(p.net) ? shiftPipe(p, dx, dy) : p)),
  };
}

function shiftPipe(p: DocPipe, dx: number, dy: number): DocPipe {
  return {
    ...p,
    nodes: p.nodes.map((v, i) => v + (i % 2 ? dy : dx)),
    edges: p.edges.map((v, i) => {
      const j = i % 5;
      if (j === 4) return v; // segment kind
      return v + (j % 2 === 0 ? dx : dy);
    }),
  };
}

/** Rotate machines a quarter turn clockwise about the centre of their footprint. */
export function rotateMachines(
  doc: GameLayoutDoc,
  ctx: LayoutContext,
  keys: Set<string>,
): GameLayoutDoc {
  if (!keys.size) return doc;
  return {
    ...doc,
    machines: doc.machines.map((m) => {
      if (!keys.has(m.key)) return m;
      const g = ctx.instByKey.get(m.key);
      const sh = g === undefined ? null : instanceShape(ctx, g, m.rot);
      const w = sh?.w ?? (m.rot % 2 ? m.h : m.w);
      const h = sh?.h ?? (m.rot % 2 ? m.w : m.h);
      return {
        ...m,
        rot: (m.rot + 1) % 4,
        x: m.x + Math.floor((w - h) / 2),
        y: m.y + Math.floor((h - w) / 2),
      };
    }),
  };
}

export interface Selection {
  machines: Set<string>;
  pipes: Set<string>;
  /** Valve, passthrough and intersection ids. */
  pieces: Set<string>;
}

export const emptySelection = (): Selection => ({
  machines: new Set(),
  pipes: new Set(),
  pieces: new Set(),
});

export const selectionSize = (s: Selection) => s.machines.size + s.pipes.size + s.pieces.size;

/** Delete the selection: machines go back to the unplaced list. */
export function deleteItems(doc: GameLayoutDoc, sel: Selection): GameLayoutDoc {
  return {
    ...doc,
    machines: doc.machines.filter((m) => !sel.machines.has(m.key)),
    pipes: doc.pipes.filter((p) => !sel.pipes.has(p.net)),
    valves: doc.valves.filter((v) => !sel.pieces.has(v.id)),
    passthroughs: doc.passthroughs.filter((p) => !sel.pieces.has(p.id)),
    intersections: doc.intersections.filter((p) => !sel.pieces.has(p.id)),
    power: (doc.power ?? []).filter((p) => !sel.pieces.has(p.id)),
  };
}

/**
 * The selection plus the pipes of its machines' connections: deleting a machine takes its
 * pipes with it instead of leaving them behind, unconnected.
 */
export function withAttachedPipes(sel: Selection, ctx: LayoutContext): Selection {
  if (!sel.machines.size) return sel;
  const insts = new Set<number>();
  for (const k of sel.machines) {
    const g = ctx.instByKey.get(k);
    if (g !== undefined) insts.add(g);
  }
  const pipes = new Set(sel.pipes);
  for (const net of ctx.problem.nets) {
    if (net.terminals.some((t) => insts.has(t.inst))) pipes.add(net.key);
  }
  return { ...sel, pipes };
}

/** Pin when anything selected is unpinned, otherwise unpin all of it. */
export function togglePinned(doc: GameLayoutDoc, sel: Selection): GameLayoutDoc {
  const items = [
    ...doc.machines.filter((m) => sel.machines.has(m.key)),
    ...doc.pipes.filter((p) => sel.pipes.has(p.net)),
    ...doc.valves.filter((v) => sel.pieces.has(v.id)),
    ...doc.passthroughs.filter((p) => sel.pieces.has(p.id)),
    ...doc.intersections.filter((p) => sel.pieces.has(p.id)),
    ...(doc.power ?? []).filter((p) => sel.pieces.has(p.id)),
  ];
  if (!items.length) return doc;
  const pin = items.some((i) => !i.pinned);
  const set = <T extends { pinned?: boolean }>(o: T): T => {
    const { pinned: _p, ...rest } = o;
    void _p;
    return (pin ? { ...rest, pinned: true } : rest) as T;
  };
  return {
    ...doc,
    machines: doc.machines.map((m) => (sel.machines.has(m.key) ? set(m) : m)),
    pipes: doc.pipes.map((p) => (sel.pipes.has(p.net) ? set(p) : p)),
    valves: doc.valves.map((v) => (sel.pieces.has(v.id) ? set(v) : v)),
    passthroughs: doc.passthroughs.map((p) => (sel.pieces.has(p.id) ? set(p) : p)),
    intersections: doc.intersections.map((p) => (sel.pieces.has(p.id) ? set(p) : p)),
    power: (doc.power ?? []).map((p) => (sel.pieces.has(p.id) ? set(p) : p)),
  };
}

/** Remove orphaned machines and pipes (no longer in the flowchart). */
export function deleteOrphans(
  doc: GameLayoutDoc,
  orphanMachines: DocMachine[],
  orphanPipes: DocPipe[],
): GameLayoutDoc {
  const m = new Set(orphanMachines);
  const p = new Set(orphanPipes);
  return {
    ...doc,
    machines: doc.machines.filter((x) => !m.has(x)),
    pipes: doc.pipes.filter((x) => !p.has(x)),
  };
}

// ------------------------------------------------------------------ pipes

/** A pipe network as tile keys: nodes and flat [a, b, kind] edges. */
export interface PipeGraph {
  nodes: Set<number>;
  edges: number[];
}

export function pipeGraph(p: DocPipe | undefined): PipeGraph {
  const nodes = new Set<number>();
  const edges: number[] = [];
  if (!p) return { nodes, edges };
  for (let i = 0; i + 1 < p.nodes.length; i += 2) nodes.add(key(p.nodes[i], p.nodes[i + 1]));
  for (let i = 0; i + 4 < p.edges.length + 1; i += 5) {
    const a = key(p.edges[i], p.edges[i + 1]);
    const b = key(p.edges[i + 2], p.edges[i + 3]);
    nodes.add(a);
    nodes.add(b);
    edges.push(a, b, p.edges[i + 4]);
  }
  return { nodes, edges };
}

export function docPipe(
  net: string,
  large: boolean,
  label: string,
  g: PipeGraph,
  pinned?: boolean,
): DocPipe {
  const nodes: number[] = [];
  for (const c of g.nodes) nodes.push(kx(c), ky(c));
  const edges: number[] = [];
  for (let i = 0; i < g.edges.length; i += 3) {
    edges.push(
      kx(g.edges[i]),
      ky(g.edges[i]),
      kx(g.edges[i + 1]),
      ky(g.edges[i + 1]),
      g.edges[i + 2],
    );
  }
  return { net, large, nodes, edges, label, ...(pinned ? { pinned: true } : {}) };
}

/** Replace (or with an empty graph, remove) the route of one pipe network. */
export function setPipe(
  doc: GameLayoutDoc | null,
  net: string,
  large: boolean,
  label: string,
  g: PipeGraph,
): GameLayoutDoc {
  const d = ensureDoc(doc);
  const old = d.pipes.find((p) => p.net === net);
  const rest = d.pipes.filter((p) => p.net !== net);
  if (!g.nodes.size) return { ...d, pipes: rest };
  return { ...d, pipes: [...rest, docPipe(net, large, label, g, old?.pinned)] };
}

/** Add tiles / segments to a pipe network (painting, auto-path). */
export function extendPipe(
  doc: GameLayoutDoc | null,
  net: string,
  large: boolean,
  label: string,
  nodes: Iterable<number>,
  edges: number[],
): GameLayoutDoc {
  const d = ensureDoc(doc);
  const g = pipeGraph(d.pipes.find((p) => p.net === net));
  const have = new Set<string>();
  for (let i = 0; i < g.edges.length; i += 3) {
    have.add(`${Math.min(g.edges[i], g.edges[i + 1])}|${Math.max(g.edges[i], g.edges[i + 1])}`);
  }
  for (const c of nodes) g.nodes.add(c);
  for (let i = 0; i < edges.length; i += 3) {
    const k = `${Math.min(edges[i], edges[i + 1])}|${Math.max(edges[i], edges[i + 1])}`;
    if (have.has(k) || edges[i] === edges[i + 1]) continue;
    have.add(k);
    g.nodes.add(edges[i]);
    g.nodes.add(edges[i + 1]);
    g.edges.push(edges[i], edges[i + 1], edges[i + 2]);
  }
  return setPipe(d, net, large, label, g);
}

/** Erase pipe tiles (all networks, or only `onlyNet`); segments touching them go too. */
export function eraseTiles(
  doc: GameLayoutDoc,
  tiles: Set<number>,
  onlyNet?: string,
): GameLayoutDoc {
  let changed = false;
  const pipes: DocPipe[] = [];
  for (const p of doc.pipes) {
    if ((onlyNet && p.net !== onlyNet) || p.pinned) {
      pipes.push(p);
      continue;
    }
    const g = pipeGraph(p);
    // a large pipe tile is erased when any tile of its 2x2 footprint is
    const hit = (a: number) =>
      tiles.has(a) ||
      (p.large &&
        (tiles.has(a + 1) ||
          tiles.has(key(kx(a), ky(a) + 1)) ||
          tiles.has(key(kx(a) + 1, ky(a) + 1))));
    const nodes = new Set([...g.nodes].filter((a) => !hit(a)));
    if (nodes.size === g.nodes.size) {
      pipes.push(p);
      continue;
    }
    changed = true;
    const edges: number[] = [];
    for (let i = 0; i < g.edges.length; i += 3) {
      if (nodes.has(g.edges[i]) && nodes.has(g.edges[i + 1]))
        edges.push(g.edges[i], g.edges[i + 1], g.edges[i + 2]);
    }
    if (nodes.size) pipes.push(docPipe(p.net, p.large, p.label, { nodes, edges }, p.pinned));
  }
  // pieces on erased tiles go as well
  const inTiles = (x: number, y: number) => tiles.has(key(x, y));
  const valves = doc.valves.filter((v) => !inTiles(v.x, v.y) || v.pinned);
  const passthroughs = doc.passthroughs.filter((p) => !inTiles(p.x, p.y) || p.pinned);
  const intersections = doc.intersections.filter((p) => !inTiles(p.x, p.y) || p.pinned);
  const power = (doc.power ?? []).filter(
    (p) => p.pinned || !powerTiles(p).some(([x, y]) => inTiles(x, y)),
  );
  if (
    !changed &&
    valves.length === doc.valves.length &&
    passthroughs.length === doc.passthroughs.length &&
    intersections.length === doc.intersections.length &&
    power.length === (doc.power ?? []).length
  ) {
    return doc;
  }
  return { ...doc, pipes, valves, passthroughs, intersections, power };
}

// ------------------------------------------------------------------ pieces

export function addValve(
  doc: GameLayoutDoc | null,
  x: number,
  y: number,
  r: number,
  sidePct = 50,
): GameLayoutDoc {
  const d = ensureDoc(doc);
  const v: DocValve = { id: newPieceId('valve'), x, y, rot: ((r % 4) + 4) % 4, sidePct };
  return { ...d, valves: [...d.valves, v] };
}

export function updateValve(
  doc: GameLayoutDoc,
  id: string,
  patch: Partial<Omit<DocValve, 'id'>>,
): GameLayoutDoc {
  return { ...doc, valves: doc.valves.map((v) => (v.id === id ? { ...v, ...patch } : v)) };
}

export function addPassthrough(
  doc: GameLayoutDoc | null,
  x: number,
  y: number,
  horizontal: boolean,
  kind: 'Item' | 'Fluid',
): GameLayoutDoc {
  const d = ensureDoc(doc);
  const p: DocPassthrough = { id: newPieceId('pass'), x, y, horizontal, kind };
  return { ...d, passthroughs: [...d.passthroughs, p] };
}

export function addPowerPiece(
  doc: GameLayoutDoc | null,
  kind: DocPowerPiece['kind'],
  x: number,
  y: number,
  rot: number,
): GameLayoutDoc {
  const d = ensureDoc(doc);
  const p: DocPowerPiece = {
    id: newPieceId(kind),
    kind,
    x,
    y,
    rot: kind === 'mv' || kind === 'transformer' ? rot : 0,
  };
  return { ...d, power: [...(d.power ?? []), p] };
}

export function addIntersection(doc: GameLayoutDoc | null, x: number, y: number): GameLayoutDoc {
  const d = ensureDoc(doc);
  const p: DocIntersection = { id: newPieceId('inter'), x, y };
  return { ...d, intersections: [...d.intersections, p] };
}

/** Footprint size of a valve at a rotation. */
export function valveSize(r: number): [number, number] {
  const sh: Shape = rot(valveShape('Item'), r);
  return [sh.w, sh.h];
}

// ------------------------------------------------------------------ generator output

/**
 * Turn a generator result into a document. Valve controls the generator built as pieces of a
 * manifold become valves lying on the merged pipe network (one network per flowchart
 * connection); passthroughs and intersections become placed pieces.
 */
export function docFromSolution(
  problem: Problem,
  sol: Solution,
  keep?: GameLayoutDoc | null,
): GameLayoutDoc {
  const machines: DocMachine[] = [];
  const valves: DocValve[] = [];
  const valveInfo = new Map(problem.valves.map((v) => [v.inst, v]));
  const extra = new Map<string, PipeGraph>();
  const addTo = (net: string, nodes: number[], edges: number[]) => {
    let g = extra.get(net);
    if (!g) extra.set(net, (g = { nodes: new Set(), edges: [] }));
    for (const n of nodes) g.nodes.add(n);
    g.edges.push(...edges);
  };
  for (const m of sol.machines) {
    const node = problem.nodes[m.node];
    if (node.synthetic === 'valve') {
      const v = valveInfo.get(m.inst);
      const port = (pid: string) => {
        const p = m.shape.ports.get(pid)!;
        const [cx, cy] = p.cells[0];
        return key(m.x + cx, m.y + cy);
      };
      const A = port('valve_in');
      const M = port('valve_side');
      const E = port('valve_straight');
      // the pipes attach at the tiles outside the ports; join them through the valve
      const acc = (pid: string) => sol.access(m, pid, false)[0];
      const inAt = acc('valve_in');
      const stAt = acc('valve_straight');
      const sdAt = acc('valve_side');
      const net = v?.key ?? '';
      const nets = problem.nets.filter((n) => n.key === net);
      const has = (t: number) => nets.some((n) => sol.netNodes[n.id]?.has(t));
      const edges = [A, M, 0, M, E, 0];
      if (has(inAt)) edges.push(inAt, A, 0);
      if (has(stAt)) edges.push(E, stAt, 0);
      if (has(sdAt)) edges.push(M, sdAt, 0);
      addTo(net, [A, M, E], edges);
      valves.push({
        id: newPieceId('valve'),
        x: m.x,
        y: m.y,
        rot: m.rot,
        sidePct: Math.round((v?.sidePct ?? 50) * 10) / 10,
      });
      continue;
    }
    machines.push({
      key: `${node.id}#${m.local}`,
      x: m.x,
      y: m.y,
      rot: m.rot,
      name: `${node.shape.name} #${m.local + 1}`,
      w: node.shape.w,
      h: node.shape.h,
    });
  }
  const byKey = new Map<string, { large: boolean; label: string; g: PipeGraph }>();
  problem.nets.forEach((net, ni) => {
    const nodes = sol.netNodes[ni];
    if (!nodes?.size) return;
    let e = byKey.get(net.key);
    if (!e) {
      e = { large: net.large, label: net.productName, g: { nodes: new Set(), edges: [] } };
      byKey.set(net.key, e);
    }
    for (const c of nodes) e.g.nodes.add(c);
    e.g.edges.push(...sol.netEdges[ni]);
  });
  for (const [net, g] of extra) {
    const e = byKey.get(net);
    if (!e) continue;
    for (const n of g.nodes) e.g.nodes.add(n);
    e.g.edges.push(...g.edges);
  }
  const pipes = [...byKey].map(([net, e]) => docPipe(net, e.large, e.label, e.g));
  const passthroughs: DocPassthrough[] = sol.passthroughs.map((p) => ({
    id: newPieceId('pass'),
    x: p.x,
    y: p.y,
    horizontal: p.w > p.h,
    kind: p.kind,
  }));
  const intersections: DocIntersection[] = sol
    .intersections()
    .map((i) => ({ id: newPieceId('inter'), x: i.x, y: i.y }));
  const ids = new Map(sol.power.map((p) => [p.id, newPieceId(p.kind)]));
  const power = sol.power.map((p) => ({
    ...p,
    id: ids.get(p.id)!,
    ...(p.feed !== undefined && ids.has(p.feed) ? { feed: ids.get(p.feed)! } : {}),
  }));
  const powerFeeds: Record<string, string> = {};
  for (const [ck, pid] of sol.powerAssign) {
    const [inst, n] = ck.split('|').map(Number);
    const id = ids.get(pid);
    if (id !== undefined) powerFeeds[`${instanceKey(problem, inst)}|${n}`] = id;
  }
  const doc: GameLayoutDoc = {
    version: 1,
    machines,
    pipes,
    valves,
    passthroughs,
    intersections,
    power,
    powerFeeds,
  };
  if (!keep) return doc;
  // pinned items of the previous document are part of the result already; keep their flags
  const pinnedM = new Set(keep.machines.filter((m) => m.pinned).map((m) => m.key));
  const pinnedP = new Set(keep.pipes.filter((p) => p.pinned).map((p) => p.net));
  return {
    ...doc,
    machines: doc.machines.map((m) => (pinnedM.has(m.key) ? { ...m, pinned: true } : m)),
    pipes: doc.pipes.map((p) => (pinnedP.has(p.net) ? { ...p, pinned: true } : p)),
  };
}
