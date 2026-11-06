/**
 * Place -> route -> grow congested corridors -> route ... then tighten and compact.
 *
 * The block arrangement found by the initial annealing is kept; afterwards mostly corridor
 * widths around / inside blocks change, so every step is a small local edit.
 */
import {
  Block,
  makeTermPos,
  type BlockLike,
  type BlockOption,
  type Geometry,
  type SideMap,
} from './blocks';
import { Macro, MacroLayout, clusterSignature, instanceClusters } from './clusters';
import { accessCells, largeAnchor, occupied, rot, SIDES, type Shape, type Side } from './geometry';
import { Placer, type PlacementInfo, type PlacerState } from './placer';
import type { Problem } from './problem';
import { Router, type RouterNet } from './router';
import { key, kx, ky, Solution, type SolMachine } from './solution';
import { now } from './clock';

/** Free border around the placement so pipes can run around the outside. */
const MARGIN = 4;

export interface OptimizeOptions {
  timeBudget: number;
  seed: number;
  wireWeight: number;
  jump: number;
  useModules: boolean;
  slack: number;
  log: (m: string) => void;
  /** Called with every new best layout (routed or not). */
  onBest?: (sol: Solution) => void;
  /** Called between steps; return true to stop early (keeps the best layout). */
  shouldStop?: () => boolean;
  /** Machines / pipes the player pinned: kept exactly as they are, the rest goes around. */
  pinned?: PinnedSpec;
  /** Negotiation passes without improvement before a routing round gives up. */
  stallLimit?: number;
}

export interface PinnedSpec {
  /** Instance -> position and rotation in document coordinates. */
  machines: Map<number, { x: number; y: number; rot: number }>;
  /** Net -> route in document coordinates (tile keys) for pinned pipes between pinned machines. */
  pipes: Map<number, { nodes: Set<number>; edges: number[] }>;
  /** Extra tiles that belong to the pinned area (valves, passthroughs, intersections). */
  tiles: [number, number][];
}

/**
 * All pinned machines (and pinned pipes / pieces between them) as one rigid block: it can move
 * as a whole but never rotates, so their relative positions stay exactly as the player left
 * them.
 */
export class PinnedBlock implements BlockLike {
  idx: number;
  instIds: number[];
  n: number;
  label = 'Pinned';
  extSide: SideMap;
  /** Document coordinates of the pinned area's top-left. */
  minX: number;
  minY: number;
  w0: number;
  h0: number;
  private placed: { inst: number; x: number; y: number; shape: Shape; rot: number }[];
  private cache = new Map<string, Geometry>();

  constructor(idx: number, problem: Problem, spec: PinnedSpec, slack: number) {
    this.idx = idx;
    this.placed = [...spec.machines].map(([inst, p]) => ({
      inst,
      x: p.x,
      y: p.y,
      rot: p.rot,
      shape: rot(problem.nodes[problem.instances[inst][0]].shape, p.rot),
    }));
    this.instIds = this.placed.map((p) => p.inst);
    this.n = this.instIds.length;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    const add = (x: number, y: number, w: number, h: number) => {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x + w);
      y1 = Math.max(y1, y + h);
    };
    for (const p of this.placed) add(p.x, p.y, p.shape.w, p.shape.h);
    for (const [ni, r] of spec.pipes) {
      const sz = problem.nets[ni].large ? 2 : 1;
      for (const c of r.nodes) add(kx(c), ky(c), sz, sz);
    }
    for (const [x, y] of spec.tiles) add(x, y, 1, 1);
    this.minX = x0;
    this.minY = y0;
    this.w0 = x1 - x0;
    this.h0 = y1 - y0;
    this.extSide = { left: slack, top: slack, right: slack, bottom: slack };
  }

  options(): BlockOption[] {
    return [{ rot: 0, cols: 1, alt: false }];
  }

  defaultOption(): BlockOption {
    return { rot: 0, cols: 1, alt: false };
  }

  geometry(): Geometry {
    const e = this.extSide;
    const pad: [number, number, number, number] = [
      Math.max(0, e.left),
      Math.max(0, e.top),
      Math.max(0, e.right),
      Math.max(0, e.bottom),
    ];
    const k = pad.join(',');
    let g = this.cache.get(k);
    if (!g) {
      const items = this.placed.map((p) => ({
        dx: p.x - this.minX + pad[0],
        dy: p.y - this.minY + pad[1],
        shape: p.shape,
        rot: p.rot,
      }));
      const w = this.w0 + pad[0] + pad[2];
      const h = this.h0 + pad[1] + pad[3];
      g = {
        w,
        h,
        pad,
        core: [pad[0], pad[1], w - pad[2], h - pad[3]],
        items,
        rot: 0,
        termPos: makeTermPos(items),
      };
      this.cache.set(k, g);
    }
    return g;
  }

  /** Document -> grid offset once the block is placed at (bx, by) of the packing. */
  offset(bx: number, by: number): [number, number] {
    const g = this.geometry();
    return [MARGIN + bx + g.pad[0] - this.minX, MARGIN + by + g.pad[1] - this.minY];
  }

  clearCache(): void {
    this.cache.clear();
  }

  getState(): unknown {
    return { ...this.extSide };
  }

  setState(st: unknown): void {
    this.extSide = { ...(st as SideMap) };
    this.clearCache();
  }

  widenInner(): void {
    // the pinned area is fixed: only its surrounding corridor can grow
    for (const s of SIDES) this.extSide[s] += 1;
    this.clearCache();
  }
}

export function buildBlocks(
  problem: Problem,
  useModules: boolean,
  seed: number,
  log?: (m: string) => void,
  pinned?: PinnedSpec,
  slack = 1,
): [BlockLike[], Map<number, [number, number]>] {
  const blocks: BlockLike[] = [];
  const instBlock = new Map<number, [number, number]>();
  const clustered = new Set<number>();
  if (pinned?.machines.size) {
    const pb = new PinnedBlock(0, problem, pinned, slack);
    pb.instIds.forEach((g, li) => {
      instBlock.set(g, [0, li]);
      clustered.add(g);
    });
    blocks.push(pb);
  }
  if (useModules) {
    const layouts = new Map<string, MacroLayout>();
    for (const all of instanceClusters(problem)) {
      const members = all.filter((g) => !clustered.has(g));
      if (members.length < 2) continue;
      const sig = clusterSignature(problem, members);
      if (!layouts.has(sig)) layouts.set(sig, new MacroLayout(problem, members, 1.5, seed));
      const m = new Macro(blocks.length, problem, members, layouts.get(sig)!);
      members.forEach((g, li) => {
        instBlock.set(g, [m.idx, li]);
        clustered.add(g);
      });
      blocks.push(m);
    }
    if (log && blocks.length) {
      const kinds = new Map<string, number>();
      for (const b of blocks) kinds.set(b.label, (kinds.get(b.label) ?? 0) + 1);
      for (const [lbl, c] of kinds) log(`  module x${c}: ${lbl}`);
    }
  }
  problem.nodes.forEach((node, ni) => {
    const ids: number[] = [];
    for (let i = 0; i < node.count; i++) {
      const g = problem.instBase[ni] + i;
      if (!clustered.has(g)) ids.push(g);
    }
    if (!ids.length) return;
    const groups = problem.spacing.has(node.shape.id) ? ids.map((g) => [g]) : [ids];
    for (const grp of groups) {
      const b = new Block(blocks.length, ni, node, grp, problem.nets);
      grp.forEach((g, li) => instBlock.set(g, [b.idx, li]));
      blocks.push(b);
    }
  });
  return [blocks, instBlock];
}

interface Realized {
  gw: number;
  gh: number;
  machines: SolMachine[];
  router: Router;
}

export function realize(
  problem: Problem,
  blocks: BlockLike[],
  info: PlacementInfo,
  jump: number,
  pinned?: PinnedSpec,
): Realized {
  const { xs, ys, W, H, geos } = info;
  const gw = W + 2 * MARGIN;
  const gh = H + 2 * MARGIN;
  const blocked = new Uint8Array(gw * gh);
  const machines: SolMachine[] = [];
  const instPos = new Map<number, SolMachine>();
  blocks.forEach((blk, b) => {
    geos[b].items.forEach((it, li) => {
      const inst = blk.instIds[li];
      const m: SolMachine = {
        inst,
        node: problem.instances[inst][0],
        x: MARGIN + xs[b] + it.dx,
        y: MARGIN + ys[b] + it.dy,
        shape: it.shape,
        rot: it.rot,
        local: problem.instances[inst][1],
      };
      instPos.set(inst, m);
      machines.push(m);
      for (const [cx, cy] of occupied(it.shape)) blocked[(m.y + cy) * gw + m.x + cx] = 1;
    });
  });
  const groupSize = new Map<string, number>();
  for (const n of problem.nets) groupSize.set(n.key, (groupSize.get(n.key) ?? 0) + 1);
  const rnets: RouterNet[] = problem.nets.map((net) => ({
    large: net.large,
    kind: net.kind,
    group: (groupSize.get(net.key) ?? 0) > 1 ? net.key : undefined,
    terms: net.terminals.map((t) => {
      const m = instPos.get(t.inst)!;
      const cells = new Set<number>();
      for (const pid of t.ports) {
        const p = m.shape.ports.get(pid);
        if (!p) continue;
        if (net.large) {
          const [ax, ay] = largeAnchor(p);
          const x = ax + m.x;
          const y = ay + m.y;
          if (x >= 0 && x < gw - 1 && y >= 0 && y < gh - 1) cells.add(y * gw + x);
        } else {
          for (const [ax, ay] of accessCells(p)) {
            const x = ax + m.x;
            const y = ay + m.y;
            if (x >= 0 && x < gw && y >= 0 && y < gh && !blocked[y * gw + x]) cells.add(y * gw + x);
          }
        }
      }
      return cells;
    }),
  }));
  // pinned pipes: committed as they are and never ripped up
  const pb = blocks[0] instanceof PinnedBlock ? blocks[0] : null;
  const fixedRoutes: [number, Set<number>, number[]][] = [];
  if (pb && pinned) {
    const [ox, oy] = pb.offset(xs[0], ys[0]);
    const g = (k: number) => (ky(k) + oy) * gw + kx(k) + ox;
    for (const [ni, r] of pinned.pipes) {
      rnets[ni].fixed = true;
      const tree = new Set([...r.nodes].map(g));
      const edges: number[] = [];
      for (let i = 0; i < r.edges.length; i += 3)
        edges.push(g(r.edges[i]), g(r.edges[i + 1]), r.edges[i + 2]);
      fixedRoutes.push([ni, tree, edges]);
    }
  }
  const router = new Router(gw, gh, blocked, rnets, { jump });
  for (const [ni, tree, edges] of fixedRoutes) router.commit(ni, tree, edges);
  // drop large anchors whose 2x2 footprint is blocked
  for (const rn of rnets) {
    if (!rn.large) continue;
    rn.terms = rn.terms.map((t) => new Set([...t].filter((a) => !router.blockedL[a])));
  }
  return { gw, gh, machines, router };
}

function solutionFrom(problem: Problem, r: Realized, jump: number): Solution {
  const { gw, router } = r;
  const conv = (c: number) => key(c % gw, Math.floor(c / gw));
  const nodes = router.tree.map((t) => new Set([...t].map(conv)));
  const edges = router.edges.map((e) => {
    const out: number[] = [];
    for (let i = 0; i < e.length; i += 3) out.push(conv(e[i]), conv(e[i + 1]), e[i + 2]);
    return out;
  });
  return new Solution(
    problem,
    r.machines.map((m) => ({ ...m })),
    nodes,
    edges,
    router.failed,
    jump,
  );
}

/** For each problem tile: nearest block and which part of it (a side corridor or inside). */
function classify(
  cells: Iterable<number>,
  gw: number,
  info: PlacementInfo,
  blocks: BlockLike[],
): [Map<number, Map<string, number>>, Map<number, [number, number][]>] {
  const { xs, ys, geos } = info;
  const hits = new Map<number, Map<string, number>>();
  const inner = new Map<number, [number, number][]>();
  for (const c of cells) {
    const x = (c % gw) - MARGIN;
    const y = Math.floor(c / gw) - MARGIN;
    let best = 0;
    let bd = Infinity;
    for (let b = 0; b < blocks.length; b++) {
      const g = geos[b];
      const bx0 = xs[b];
      const by0 = ys[b];
      const d =
        Math.max(bx0 - x, 0, x - (bx0 + g.w) + 1) + Math.max(by0 - y, 0, y - (by0 + g.h) + 1);
      if (d < bd) {
        bd = d;
        best = b;
      }
    }
    const g = geos[best];
    const rx = x - xs[best];
    const ry = y - ys[best];
    const [cx0, cy0, cx1, cy1] = g.core;
    let part: string;
    if (rx >= cx0 && rx < cx1 && ry >= cy0 && ry < cy1) {
      part = 'inner';
      if (!inner.has(best)) inner.set(best, []);
      inner.get(best)!.push([rx, ry]);
    } else {
      const cand: [number, Side][] = [
        [cx0 - rx, 'left'],
        [cy0 - ry, 'top'],
        [rx - (cx1 - 1), 'right'],
        [ry - (cy1 - 1), 'bottom'],
      ];
      cand.sort((p, q) => q[0] - p[0]);
      part = cand[0][1];
    }
    if (!hits.has(best)) hits.set(best, new Map());
    const h = hits.get(best)!;
    h.set(part, (h.get(part) ?? 0) + 1);
  }
  return [hits, inner];
}

function score(sol: Solution): number {
  return sol.nOver + 50 * sol.failed.size;
}

export function optimize(problem: Problem, o: OptimizeOptions): Solution {
  const t0 = now();
  const left = () => o.timeBudget - (now() - t0) / 1000;
  const clock = () => now() / 1000;
  Block.initialSlack = o.slack;
  const [blocks, instBlock] = buildBlocks(problem, o.useModules, o.seed, o.log, o.pinned, o.slack);
  const spaced = problem.instances
    .map(([ni], g) => ({
      type: problem.nodes[ni].shape.id,
      inst: g,
      min: problem.spacing.get(problem.nodes[ni].shape.id) ?? 0,
    }))
    .filter((s) => s.min > 0);
  const placer = new Placer(blocks, problem.nets, instBlock, {
    wireWeight: o.wireWeight,
    seed: o.seed,
    spaced,
    measure: problem.spacingMeasure,
  });
  o.log(
    `Placement (${blocks.length} blocks, ${problem.instances.length} machines, ${problem.nets.length} pipe networks)...`,
  );
  let state: PlacerState;
  let info: PlacementInfo;
  [state, , info] = placer.anneal(null, Math.max(2, Math.min(60, o.timeBudget * 0.2)), {
    log: o.log,
  });
  if (info.viol > 0)
    o.log('  WARNING: placement could not satisfy the spacing rule; try a longer time budget');

  let best: Solution | null = null;
  let bestExt: unknown[] | null = null;
  const frozen = new Set<string>();
  let tried: [number, Side][] = [];
  let attempt = 0;
  let phase: 'grow' | 'tighten' = 'grow';
  const snapshot = () => blocks.map((b) => b.getState());
  const restore = (snap: unknown[]) => {
    blocks.forEach((b, i) => b.setState(snap[i]));
    for (const b of blocks) b.clearCache();
  };
  const offer = (sol: Solution): boolean => {
    const better =
      !best ||
      (sol.ok && !best.ok) ||
      (sol.ok && best.ok && sol.area < best.area) ||
      (!sol.ok && !best.ok && score(sol) < score(best));
    if (better) {
      best = sol;
      o.onBest?.(sol);
    }
    return better;
  };
  const minAttemptTime = Math.min(5, Math.max(1, o.timeBudget * 0.05));
  while (left() > Math.min(10, o.timeBudget * 0.08) || attempt === 0) {
    if (o.shouldStop?.()) break;
    attempt++;
    o.log(`Attempt ${attempt} (${phase}): ${Math.max(0, left()).toFixed(0)}s left`);
    const r = realize(problem, blocks, info, o.jump, o.pinned);
    if (o.stallLimit) r.router.stallLimit = o.stallLimit;
    // a bounded share per attempt, so corridors can be widened / tightened several times
    const routeTime = Math.max(minAttemptTime, Math.min(left() * 0.3, 45));
    const ok = r.router.run(routeTime, 60, o.log, clock);
    const over = r.router.overusedCells();
    let sol = solutionFrom(problem, r, o.jump);
    if (blocks[0] instanceof PinnedBlock) {
      const pb = blocks[0];
      const [ox, oy] = pb.offset(info.xs[0], info.ys[0]);
      sol.pinnedRegion = [pb.minX + ox, pb.minY + oy, pb.minX + ox + pb.w0, pb.minY + oy + pb.h0];
    }
    sol.ok = ok;
    sol.nOver = over.length;
    if (ok) {
      const errs = sol.validate(3);
      if (errs.length) {
        o.log(`  validation failed: ${errs.join('; ')}`);
        sol.ok = false;
        sol.nOver = Math.max(1, sol.nOver);
      }
    }
    const bad = [...over, ...r.router.hotspots];
    for (const ni of r.router.failed) {
      for (const t of r.router.nets[ni].terms) {
        const first = t.values().next();
        if (!first.done) bad.push(first.value);
      }
    }
    if (sol.ok) {
      const raw = sol.area;
      sol = sol.compact(o.log, t0 + o.timeBudget * 1000 * 1.05);
      sol.ok = true;
      sol.nOver = 0;
      o.log(`  ROUTED. footprint ${raw} -> ${sol.area} tiles after compaction`);
      const improved = offer(sol);
      if (improved) {
        bestExt = snapshot();
      } else {
        for (const t of tried) frozen.add(`${t[0]}|${t[1]}`);
        if (bestExt) restore(bestExt);
      }
      phase = 'tighten';
      const used = new Set<number>();
      for (const cells of r.router.cells) for (const c of cells) used.add(c);
      const [usage] = classify(used, r.gw, info, blocks);
      const cand: [number, number, Side][] = [];
      blocks.forEach((_blk, b) => {
        const g: Geometry = info.geos[b];
        SIDES.forEach((side) => {
          const k = side === 'left' ? 0 : side === 'top' ? 1 : side === 'right' ? 2 : 3;
          if (frozen.has(`${b}|${side}`) || g.pad[k] <= 0) return;
          const length = side === 'left' || side === 'right' ? g.h : g.w;
          const u = usage.get(b)?.get(side) ?? 0;
          cand.push([u / Math.max(1, length * g.pad[k]), b, side]);
        });
      });
      cand.sort((p, q) => p[0] - q[0]);
      tried = cand.slice(0, Math.max(2, Math.floor(blocks.length / 4))).map(([, b, s]) => [b, s]);
      if (!tried.length) {
        o.log('  nothing left to tighten');
        break;
      }
      for (const [b, side] of tried) {
        blocks[b].extSide[side] -= 1;
        blocks[b].clearCache();
      }
    } else {
      o.log(`  ${sol.nOver} conflicting tiles, ${r.router.failed.size} unrouted pipe networks`);
      if (!best || !(best as Solution).ok) offer(sol);
      if (phase === 'tighten') {
        for (const t of tried) frozen.add(`${t[0]}|${t[1]}`);
        if (bestExt) restore(bestExt);
        tried = [];
        o.log('  tightening step failed, reverted');
      } else {
        const [hits, inner] = classify(bad, r.gw, info, blocks);
        const grown: string[] = [];
        for (const [b, parts] of hits) {
          const blk = blocks[b];
          for (const [part, n] of parts) {
            let step = n < 6 ? 1 : 2;
            if (part === 'inner') {
              step = 1;
              blk.widenInner(inner.get(b) ?? [], info.geos[b]);
            } else {
              blk.extSide[part as Side] += step;
            }
            grown.push(`${blk.label.slice(0, 30)}:${part}+${step}`);
          }
          blk.clearCache();
        }
        o.log(`  widening: ${grown.join(', ')}`);
      }
    }
    info = placer.evaluate(state)[1];
    if (info.viol > 0) {
      o.log(
        `  (spacing short by ${info.viol.toFixed(0)} tiles after repack - re-annealing briefly)`,
      );
      [state, , info] = placer.anneal(state, Math.min(5, Math.max(1, left() * 0.1)), {
        tScale: 0.02,
        tEndFrac: 1e-3,
      });
    }
  }
  if (!best) throw new Error('no layout produced');
  o.log(`Done in ${((now() - t0) / 1000).toFixed(0)}s`);
  return best;
}
