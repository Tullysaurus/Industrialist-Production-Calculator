/** A block = all machines of one recipe node arranged as a grid array with pipe corridors. */
import { accessCells, rot, rotateSide, SIDES, type Shape, type Side } from './geometry';
import type { Net, PNode } from './problem';

export interface BlockOption {
  rot: number;
  cols: number;
  alt: boolean;
}

export interface PlacedItem {
  dx: number;
  dy: number;
  shape: Shape;
  rot: number;
}

export interface Geometry {
  w: number;
  h: number;
  /** left, top, right, bottom corridor widths. */
  pad: [number, number, number, number];
  /** Machine area inside the corridors (x0, y0, x1, y1). */
  core: [number, number, number, number];
  items: PlacedItem[];
  rot: number;
  termPos(local: number, ports: string[]): [number, number];
}

export type SideMap = Record<Side, number>;

export interface BlockLike {
  idx: number;
  instIds: number[];
  n: number;
  label: string;
  extSide: SideMap;
  options(): BlockOption[];
  defaultOption(): BlockOption;
  geometry(opt: BlockOption): Geometry;
  clearCache(): void;
  getState(): unknown;
  setState(st: unknown): void;
  widenInner(points: [number, number][], geo: Geometry): void;
}

export const sameOption = (a: BlockOption, b: BlockOption) =>
  a.rot === b.rot && a.cols === b.cols && a.alt === b.alt;

/**
 * Corridor width (tiles) for pipes leaving one side: two normal pipes may share a tile, a large
 * pipe needs its own two tiles.
 */
function lanes(small: number, large: number): number {
  return Math.ceil(small / 2 - 1e-9) + 2 * Math.ceil(large - 1e-9);
}

export function makeTermPos(items: PlacedItem[]) {
  const cache = new Map<string, [number, number]>();
  return (local: number, ports: string[]): [number, number] => {
    const key = `${local}|${ports.join(',')}`;
    let v = cache.get(key);
    if (!v) {
      const it = items[local];
      let sx = 0;
      let sy = 0;
      let n = 0;
      for (const pid of ports) {
        const p = it.shape.ports.get(pid);
        if (!p) continue;
        for (const [x, y] of accessCells(p)) {
          sx += x;
          sy += y;
          n++;
        }
      }
      v = n
        ? [it.dx + sx / n + 0.5, it.dy + sy / n + 0.5]
        : [it.dx + it.shape.w / 2, it.dy + it.shape.h / 2];
      cache.set(key, v);
    }
    return v;
  };
}

export class Block implements BlockLike {
  static initialSlack = 1;
  idx: number;
  nodeIdx: number;
  node: PNode;
  shape: Shape;
  instIds: number[];
  n: number;
  label: string;
  /** Extra corridor width inside the block. */
  extInt = 0;
  extSide: SideMap;
  /** How much pipe demand accumulates along a shared corridor. */
  acc = 0.75;
  demand: Record<Side, [number, number]>;
  private cache = new Map<string, Geometry>();

  constructor(idx: number, nodeIdx: number, node: PNode, instIds: number[], nets: Net[]) {
    this.idx = idx;
    this.nodeIdx = nodeIdx;
    this.node = node;
    this.shape = node.shape;
    this.instIds = instIds;
    this.n = instIds.length;
    this.label = node.name;
    const s0 = Block.initialSlack;
    this.extSide = { left: s0, top: s0, right: s0, bottom: s0 };
    const local = new Set(instIds);
    const perInst = new Map<number, Record<Side, [number, number]>>();
    for (const net of nets) {
      for (const t of net.terminals) {
        if (!local.has(t.inst)) continue;
        const sides = new Set<Side>();
        for (const p of t.ports) {
          const port = this.shape.ports.get(p);
          if (port) sides.add(port.side);
        }
        let d = perInst.get(t.inst);
        if (!d) {
          d = { top: [0, 0], right: [0, 0], bottom: [0, 0], left: [0, 0] };
          perInst.set(t.inst, d);
        }
        for (const s of sides) d[s][net.large ? 1 : 0] += 1 / sides.size;
      }
    }
    this.demand = { top: [0, 0], right: [0, 0], bottom: [0, 0], left: [0, 0] };
    for (const d of perInst.values()) {
      for (const s of SIDES) {
        for (const k of [0, 1] as const) this.demand[s][k] = Math.max(this.demand[s][k], d[s][k]);
      }
    }
  }

  /** Corridor width per side after rotating by r quarter turns, shared by `mult` machines. */
  lanes(r: number, mult: number): SideMap {
    const m = 1 + (mult - 1) * this.acc;
    const out: SideMap = { top: 0, right: 0, bottom: 0, left: 0 };
    for (const s of SIDES) {
      const v = this.demand[s];
      out[rotateSide(s, r)] = v[0] || v[1] ? lanes(v[0] * m, v[1] * m) : 0;
    }
    return out;
  }

  options(): BlockOption[] {
    const out: BlockOption[] = [];
    for (let r = 0; r < 4; r++) {
      for (let cols = 1; cols <= this.n; cols++) {
        const rows = Math.ceil(this.n / cols);
        if (cols > 1 && Math.ceil(this.n / (cols - 1)) === rows) continue;
        out.push({ rot: r, cols, alt: false });
        if (rows > 1) out.push({ rot: r, cols, alt: true });
      }
    }
    return out;
  }

  defaultOption(): BlockOption {
    let best: BlockOption | null = null;
    let bestScore = Infinity;
    for (const opt of this.options()) {
      const g = this.geometry(opt);
      const score = Math.max(g.w, g.h) * 4 + (g.w * g.h) / Math.max(1, Math.min(g.w, g.h));
      if (score < bestScore) {
        best = opt;
        bestScore = score;
      }
    }
    return best!;
  }

  geometry(opt: BlockOption): Geometry {
    const es = this.extSide;
    const key = `${opt.rot}|${opt.cols}|${opt.alt ? 1 : 0}|${this.extInt}|${es.left},${es.top},${es.right},${es.bottom}|${this.acc}`;
    let g = this.cache.get(key);
    if (!g) {
      g = this.build(opt);
      this.cache.set(key, g);
    }
    return g;
  }

  private build(opt: BlockOption): Geometry {
    const n = this.n;
    const cols = Math.min(opt.cols, n);
    const rows = Math.ceil(n / cols);
    const shapes = [rot(this.shape, opt.rot), rot(this.shape, opt.rot + 2)];
    const lr = [this.lanes(opt.rot, cols), this.lanes(opt.rot + 2, cols)]; // corridors along rows
    const lc = [this.lanes(opt.rot, rows), this.lanes(opt.rot + 2, rows)]; // along columns
    const rowt = Array.from({ length: rows }, (_u, r) => (opt.alt ? r % 2 : 0));
    const types = [...new Set(rowt)];
    const W = shapes[0].w;
    const H = shapes[0].h;
    const ei = this.extInt;
    const es = this.extSide;
    const colgap =
      cols > 1 ? Math.max(0, Math.max(...types.map((t) => lc[t].right + lc[t].left)) + ei) : 0;
    const rowgaps: number[] = [];
    for (let r = 0; r < rows - 1; r++) {
      rowgaps.push(Math.max(0, lr[rowt[r]].bottom + lr[rowt[r + 1]].top + ei));
    }
    const padL = Math.max(0, Math.max(...types.map((t) => lc[t].left)) + es.left);
    const padR = Math.max(0, Math.max(...types.map((t) => lc[t].right)) + es.right);
    const padT = Math.max(0, lr[rowt[0]].top + es.top);
    let padB = Math.max(0, lr[rowt[rows - 1]].bottom + es.bottom);
    if (rows > 1 && n % cols) {
      // machines in the second-to-last row with nothing below expose their bottom side
      padB = Math.max(padB, lr[rowt[rows - 2]].bottom + es.bottom - (H + rowgaps[rows - 2]));
    }
    const w = padL + cols * W + (cols - 1) * colgap + padR;
    const h = padT + rows * H + rowgaps.reduce((a, b) => a + b, 0) + padB;
    const ys: number[] = [];
    let y = padT;
    for (let r = 0; r < rows; r++) {
      ys.push(y);
      y += H + (r < rows - 1 ? rowgaps[r] : 0);
    }
    const items: PlacedItem[] = [];
    for (let i = 0; i < n; i++) {
      const r = Math.floor(i / cols);
      const c = i % cols;
      const t = rowt[r];
      items.push({
        dx: padL + c * (W + colgap),
        dy: ys[r],
        shape: shapes[t],
        rot: (opt.rot + 2 * t) % 4,
      });
    }
    return {
      w,
      h,
      pad: [padL, padT, padR, padB],
      core: [padL, padT, w - padR, h - padB],
      items,
      rot: opt.rot,
      termPos: makeTermPos(items),
    };
  }

  clearCache(): void {
    this.cache.clear();
  }

  getState(): unknown {
    return [this.extInt, { ...this.extSide }];
  }

  setState(st: unknown): void {
    const [ei, es] = st as [number, SideMap];
    this.extInt = ei;
    this.extSide = { ...es };
    this.clearCache();
  }

  widenInner(): void {
    this.extInt += 1;
    this.clearCache();
  }
}
