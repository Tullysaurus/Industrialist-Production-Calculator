/**
 * Group tightly connected machines (e.g. coal plant + its heat exchanger + turbines) into
 * modules ("macros") that are laid out once and placed as a unit.
 */
import {
  Block,
  makeTermPos,
  type BlockLike,
  type BlockOption,
  type Geometry,
  type PlacedItem,
  type SideMap,
} from './blocks';
import { rot, rotateSide, shapeArea, type Side } from './geometry';
import { Placer, type PlacerState } from './placer';
import type { Problem } from './problem';

export function instanceClusters(
  problem: Problem,
  maxTerms = 8,
  maxMembers = 26,
  areaFrac = 1 / 4,
  minWeight = 0.15,
): number[][] {
  const area = problem.instances.map(([ni]) => shapeArea(problem.nodes[ni].shape));
  const total = area.reduce((a, b) => a + b, 0);
  const w = new Map<string, number>();
  for (const net of problem.nets) {
    const insts = [...new Set(net.terminals.map((t) => t.inst))].sort((a, b) => a - b);
    if (insts.length < 2 || insts.length > maxTerms) continue;
    const val = (net.large ? 3 : 1) / (insts.length - 1);
    for (let i = 0; i < insts.length; i++) {
      for (let j = i + 1; j < insts.length; j++) {
        const k = `${insts[i]},${insts[j]}`;
        w.set(k, (w.get(k) ?? 0) + val);
      }
    }
  }
  const pairs = [...w].map(([k, v]) => {
    const [a, b] = k.split(',').map(Number);
    return { a, b, v };
  });
  const parent = area.map((_a, i) => i);
  const members = new Map<number, number[]>(area.map((_a, i) => [i, [i]]));
  const carea = new Map<number, number>(area.map((a, i) => [i, a]));
  const find = (a: number) => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  };
  const spacedType = (g: number) => {
    const sid = problem.nodes[problem.instances[g][0]].shape.id;
    return problem.spacing.has(sid) ? sid : null;
  };
  for (;;) {
    const cw = new Map<string, number>();
    for (const { a, b, v } of pairs) {
      const ra = find(a);
      const rb = find(b);
      if (ra === rb) continue;
      const k = ra < rb ? `${ra},${rb}` : `${rb},${ra}`;
      cw.set(k, (cw.get(k) ?? 0) + v);
    }
    let best: [number, number, number] | null = null;
    for (const [k, v] of cw) {
      if (v < minWeight) continue;
      const [ra, rb] = k.split(',').map(Number);
      const ma = members.get(ra)!;
      const mb = members.get(rb)!;
      const biggest = Math.max(...ma.map((g) => area[g]), ...mb.map((g) => area[g]));
      const limit = Math.max(total * areaFrac, biggest * 2.2);
      if (carea.get(ra)! + carea.get(rb)! > limit || ma.length + mb.length > maxMembers) continue;
      const spaced = [...ma, ...mb].map(spacedType).filter((s): s is string => s !== null);
      if (spaced.length !== new Set(spaced).size) continue; // far-apart machines cannot share a module
      const score = v / Math.sqrt(ma.length + mb.length);
      if (!best || score > best[0]) best = [score, ra, rb];
    }
    if (!best) break;
    const [, ra, rb] = best;
    parent[rb] = ra;
    members.get(ra)!.push(...members.get(rb)!);
    members.delete(rb);
    carea.set(ra, carea.get(ra)! + carea.get(rb)!);
    carea.delete(rb);
  }
  const out: number[][] = [];
  for (const [r, m] of members) {
    if (find(r) !== r) continue;
    out.push(
      m.sort(
        (x, y) =>
          problem.instances[x][0] - problem.instances[y][0] ||
          problem.instances[x][1] - problem.instances[y][1],
      ),
    );
  }
  return out;
}

export function clusterSignature(problem: Problem, members: number[]): string {
  const pos = new Map(members.map((g, i) => [g, i]));
  const sigNets: string[] = [];
  for (const net of problem.nets) {
    const ts = net.terminals
      .filter((t) => pos.has(t.inst))
      .map((t) => `${pos.get(t.inst)}:${t.ports.join(',')}`)
      .sort();
    if (ts.length >= 2) sigNets.push(`${net.large ? 'L' : 'S'}[${ts.join(';')}]`);
  }
  sigNets.sort();
  return `${members.map((g) => problem.instances[g][0]).join(',')}#${sigNets.join('|')}`;
}

/**
 * Internal arrangement of one module type (shared by identical modules). The arrangement is
 * solved once; afterwards only the corridor widths of individual members change.
 */
export class MacroLayout {
  problem: Problem;
  members: number[];
  seconds: number;
  seed: number;
  placer: Placer | null = null;
  state: PlacerState | null = null;
  private cache = new Map<string, [number, number, PlacedItem[]]>();

  constructor(problem: Problem, members: number[], seconds = 1, seed = 0) {
    this.problem = problem;
    this.members = members;
    this.seconds = seconds;
    this.seed = seed;
  }

  private solve(): void {
    const pos = new Set(this.members);
    const subNets = this.problem.nets
      .map((n) => ({ large: n.large, terminals: n.terminals.filter((t) => pos.has(t.inst)) }))
      .filter((n) => n.terminals.length >= 2);
    const blocks: Block[] = [];
    const instBlock = new Map<number, [number, number]>();
    this.members.forEach((g, k) => {
      const ni = this.problem.instances[g][0];
      blocks.push(new Block(k, ni, this.problem.nodes[ni], [g], this.problem.nets));
      instBlock.set(g, [k, 0]);
    });
    this.placer = new Placer(blocks, subNets, instBlock, { seed: this.seed });
    this.state = this.placer.anneal(null, this.seconds)[0];
  }

  get memberBlocks(): Block[] {
    if (!this.placer) this.solve();
    return this.placer!.blocks as Block[];
  }

  key(): string {
    return this.memberBlocks
      .map((b) => `${b.extSide.left},${b.extSide.top},${b.extSide.right},${b.extSide.bottom}`)
      .join('|');
  }

  build(): [number, number, PlacedItem[]] {
    const k = this.key();
    let v = this.cache.get(k);
    if (!v) {
      const info = this.placer!.evaluate(this.state!)[1];
      const items = this.placer!.blocks.map((_b, i) => {
        const it = info.geos[i].items[0];
        return { ...it, dx: info.xs[i] + it.dx, dy: info.ys[i] + it.dy };
      });
      v = [info.W, info.H, items];
      this.cache.set(k, v);
    }
    return v;
  }

  getState(): SideMap[] {
    return this.memberBlocks.map((b) => ({ ...b.extSide }));
  }

  setState(st: SideMap[]): void {
    this.memberBlocks.forEach((b, i) => {
      b.extSide = { ...st[i] };
      b.clearCache();
    });
  }
}

function macroGeometry(
  W0: number,
  H0: number,
  items0: PlacedItem[],
  r: number,
  pad: [number, number, number, number],
): Geometry {
  let items = items0;
  let W = W0;
  let H = H0;
  for (let i = 0; i < r % 4; i++) {
    const h = H;
    items = items.map((it) => ({
      dx: h - it.dy - it.shape.h,
      dy: it.dx,
      shape: rot(it.shape, 1),
      rot: (it.rot + 1) % 4,
    }));
    [W, H] = [H, W];
  }
  const [pl, pt, pr, pb] = pad;
  const placed = items.map((it) => ({ ...it, dx: it.dx + pl, dy: it.dy + pt }));
  const w = W + pl + pr;
  const h = H + pt + pb;
  return {
    w,
    h,
    pad,
    core: [pl, pt, w - pr, h - pb],
    items: placed,
    rot: r,
    termPos: makeTermPos(placed),
  };
}

/** Placer-compatible block made of several different machines. */
export class Macro implements BlockLike {
  idx: number;
  instIds: number[];
  n: number;
  label: string;
  layout: MacroLayout;
  extSide: SideMap = { left: 0, top: 0, right: 0, bottom: 0 };
  private cache = new Map<string, Geometry>();

  constructor(idx: number, problem: Problem, members: number[], layout: MacroLayout) {
    this.idx = idx;
    this.instIds = members;
    this.n = members.length;
    const names = new Map<string, number>();
    for (const g of members) {
      const nm = problem.nodes[problem.instances[g][0]].shape.name;
      names.set(nm, (names.get(nm) ?? 0) + 1);
    }
    this.label = [...names].map(([n, c]) => (c > 1 ? `${c}x ${n}` : n)).join(' + ');
    this.layout = layout;
  }

  options(): BlockOption[] {
    return [0, 1, 2, 3].map((r) => ({ rot: r, cols: 1, alt: false }));
  }

  defaultOption(): BlockOption {
    return { rot: 0, cols: 1, alt: false };
  }

  geometry(opt: BlockOption): Geometry {
    const e = this.extSide;
    const pad: [number, number, number, number] = [
      Math.max(0, e.left),
      Math.max(0, e.top),
      Math.max(0, e.right),
      Math.max(0, e.bottom),
    ];
    const key = `${opt.rot}|${this.layout.key()}|${pad.join(',')}`;
    let g = this.cache.get(key);
    if (!g) {
      const [W, H, items] = this.layout.build();
      g = macroGeometry(W, H, items, opt.rot, pad);
      this.cache.set(key, g);
    }
    return g;
  }

  clearCache(): void {
    this.cache.clear();
  }

  getState(): unknown {
    return [{ ...this.extSide }, this.layout.getState()];
  }

  setState(st: unknown): void {
    const [es, ls] = st as [SideMap, SideMap[]];
    this.extSide = { ...es };
    this.layout.setState(ls);
    this.clearCache();
  }

  /** Widen the corridor of the member machine(s) nearest to congested points (block-local). */
  widenInner(points: [number, number][], geo: Geometry): void {
    const touched = new Map<string, number>();
    for (const [x, y] of points) {
      let best: [number, number, Side] | null = null;
      geo.items.forEach((it, k) => {
        const ddx = Math.max(it.dx - x, 0, x - (it.dx + it.shape.w - 1));
        const ddy = Math.max(it.dy - y, 0, y - (it.dy + it.shape.h - 1));
        const d = ddx + ddy;
        if (!best || d < best[0]) {
          const side: Side =
            x < it.dx ? 'left' : x >= it.dx + it.shape.w ? 'right' : y < it.dy ? 'top' : 'bottom';
          best = [d, k, side];
        }
      });
      if (!best) continue;
      const [, k, side] = best as [number, number, Side];
      const baseSide = rotateSide(side, (4 - geo.rot) % 4);
      const key = `${k}|${baseSide}`;
      touched.set(key, (touched.get(key) ?? 0) + 1);
    }
    const blocks = this.layout.memberBlocks;
    for (const [key, n] of touched) {
      const [k, side] = key.split('|') as [string, Side];
      const b = blocks[Number(k)];
      b.extSide[side] += n < 10 ? 1 : 2;
      b.clearCache();
    }
    this.clearCache();
  }
}
