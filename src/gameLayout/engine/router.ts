/**
 * Grid pipe router: A* Steiner trees + PathFinder negotiated congestion.
 *
 * Tile rules
 *  - pipes never pass through machines
 *  - a tile holds at most 2 normal pipes (crossing via an intersection or side by side);
 *    items and fluids may share
 *  - large fluid pipes are 2x2; two large pipes may cross (large intersection), they never
 *    share a tile with a normal pipe
 *  - a normal pipe crosses a large pipe only through a "large fluid pipe passthrough": a 4x2
 *    piece laid in line with a straight run of the large pipe with two crossing slots in its
 *    middle tiles (both slots carry the same kind, item or fluid). The router models the
 *    crossing as a straight 3-tile move over the 2-wide pipe; `checkCrossings` then assigns
 *    every crossing to a passthrough and reports crossings that cannot get one as conflicts.
 *  - quantum piping: a normal pipe may hop straight over other normal pipes (never over
 *    machines or large pipes) to a tile up to `jump` tiles away
 */
import type { PortKind } from './geometry';
import { assignPassthroughs, type Crossing, type Passthrough } from './passthrough';

export const EDGE_STEP = 0;
export const EDGE_HOP = 1;
export const EDGE_CROSS = 2;
/** Large pipe over another large pipe through a 2x2 large intersection (4 anchors apart). */
export const EDGE_LCROSS = 3;

export interface RouterNet {
  large: boolean;
  kind: PortKind;
  /** Per terminal: candidate start tiles (normal pipe) or 2x2 anchors (large pipe). */
  terms: Set<number>[];
  /** Pinned route: committed up front and never ripped up. */
  fixed?: boolean;
  /**
   * Nets of one group (the pipes of a valve manifold: one flowchart connection) may not share
   * tiles, otherwise merging them into one network would join separate branches.
   */
  group?: string;
}

export interface RouterOptions {
  shareCost?: number;
  bendCost?: number;
  hWeight?: number;
  jump?: number;
  jumpCost?: number;
  crossCost?: number;
}

/** Binary min-heap over (key, value) pairs stored in parallel typed arrays. */
class Heap {
  keys = new Float64Array(1024);
  gs = new Float64Array(1024);
  vals = new Int32Array(1024);
  size = 0;

  clear() {
    this.size = 0;
  }

  private grow() {
    const n = this.keys.length * 2;
    const k = new Float64Array(n);
    k.set(this.keys);
    const g = new Float64Array(n);
    g.set(this.gs);
    const v = new Int32Array(n);
    v.set(this.vals);
    this.keys = k;
    this.gs = g;
    this.vals = v;
  }

  push(key: number, g: number, val: number) {
    if (this.size === this.keys.length) this.grow();
    let i = this.size++;
    const K = this.keys;
    const G = this.gs;
    const V = this.vals;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (K[p] <= key) break;
      K[i] = K[p];
      G[i] = G[p];
      V[i] = V[p];
      i = p;
    }
    K[i] = key;
    G[i] = g;
    V[i] = val;
  }

  /** Pops into `out` ([g, val]). */
  pop(out: Float64Array) {
    const K = this.keys;
    const G = this.gs;
    const V = this.vals;
    out[0] = G[0];
    out[1] = V[0];
    const n = --this.size;
    if (n === 0) return;
    const key = K[n];
    const g = G[n];
    const val = V[n];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= n) break;
      if (c + 1 < n && K[c + 1] < K[c]) c++;
      if (K[c] >= key) break;
      K[i] = K[c];
      G[i] = G[c];
      V[i] = V[c];
      i = c;
    }
    K[i] = key;
    G[i] = g;
    V[i] = val;
  }
}

export class Router {
  gw: number;
  gh: number;
  N: number;
  blocked: Uint8Array;
  blockedL: Uint8Array;
  nets: RouterNet[];
  occS: Int16Array;
  occL: Int16Array;
  /** Small pipes crossing a large pipe through a passthrough slot. */
  occX: Int16Array;
  hist: Float32Array;
  /** Tiles occupied by each net (normal tiles / large footprints, crossings excluded). */
  cells: Set<number>[];
  /** Anchors of each net (tiles, or 2x2 anchors for large nets). */
  tree: Set<number>[];
  /** Flat [a, b, kind] triples per net. */
  edges: number[][];
  /** Crossing slot tiles used by each small net. */
  crossCells: Set<number>[];
  /** Large intersection tiles laid by each large net. */
  occI: Int16Array;
  interCells: Set<number>[];
  private interBad = new Set<number>();
  failed = new Set<number>();
  passthroughs: Passthrough[] = [];
  private crossBad = new Set<number>();
  pres = 0.5;
  stallLimit = 8;
  /** History cost seen by large pipes (pushed by normal pipes that could not get through). */
  histL: Float32Array;
  /** Normal-pipe port access tiles: large pipes keep off them. */
  reserve: Uint8Array;
  /** Phase B: large pipes are fixed; normal pipes may only cross them through passthroughs. */
  largeFrozen = false;
  /** Feedback search: normal pipes may run over large pipes (to find what blocks them). */
  private probe = false;
  /** Tiles where normal pipes could not get past large pipes (for corridor widening). */
  hotspots = new Set<number>();
  shareCost: number;
  bendCost: number;
  hWeight: number;
  jump: number;
  jumpCost: number;
  crossCost: number;
  // A* scratch
  private gArr: Float64Array;
  private stamp: Int32Array;
  private tgt: Int32Array;
  private own: Int32Array;
  private came: Int32Array;
  private kindArr: Int8Array;
  private dirArr: Int8Array;
  private gen = 0;
  private heap = new Heap();
  private popped = new Float64Array(2);

  constructor(
    gw: number,
    gh: number,
    blocked: Uint8Array,
    nets: RouterNet[],
    o: RouterOptions = {},
  ) {
    this.gw = gw;
    this.gh = gh;
    this.N = gw * gh;
    this.blocked = blocked;
    const bl = new Uint8Array(this.N);
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const c = y * gw + x;
        if (
          x >= gw - 1 ||
          y >= gh - 1 ||
          blocked[c] ||
          blocked[c + 1] ||
          blocked[c + gw] ||
          blocked[c + gw + 1]
        ) {
          bl[c] = 1;
        }
      }
    }
    this.blockedL = bl;
    this.nets = nets;
    this.occS = new Int16Array(this.N);
    this.occL = new Int16Array(this.N);
    this.occX = new Int16Array(this.N);
    this.hist = new Float32Array(this.N);
    this.cells = nets.map(() => new Set());
    this.tree = nets.map(() => new Set());
    this.edges = nets.map(() => []);
    this.crossCells = nets.map(() => new Set());
    this.occI = new Int16Array(this.N);
    this.histL = new Float32Array(this.N);
    this.reserve = new Uint8Array(this.N);
    for (const net of nets) {
      if (net.large) continue;
      for (const t of net.terms) for (const c of t) this.reserve[c] = 1;
    }
    this.interCells = nets.map(() => new Set());
    this.shareCost = o.shareCost ?? 0.35;
    this.bendCost = o.bendCost ?? 0.25;
    this.hWeight = o.hWeight ?? 1.25;
    this.jump = Math.max(1, Math.floor(o.jump ?? 3) || 1);
    this.jumpCost = o.jumpCost ?? 3;
    this.crossCost = o.crossCost ?? 4;
    this.gArr = new Float64Array(this.N);
    this.stamp = new Int32Array(this.N);
    this.tgt = new Int32Array(this.N);
    this.own = new Int32Array(this.N);
    this.came = new Int32Array(this.N);
    this.kindArr = new Int8Array(this.N);
    this.dirArr = new Int8Array(this.N);
  }

  // ------------------------------------------------------------------ occupancy

  overAmount(c: number): number {
    const s = this.occS[c];
    const l = this.occL[c];
    const x = this.occX[c];
    const i = this.occI[c];
    return (
      Math.max(0, s - 2) +
      Math.max(0, l - 2) +
      // two large pipes only meet at an intersection laid by one of them
      (l === 2 && i !== 1 ? 1 : 0) +
      Math.max(0, i - 1) +
      (this.interBad.has(c) ? 1 : 0) +
      (s && l ? Math.min(s, l) : 0) +
      Math.max(0, x - 1) +
      (x && s ? Math.min(x, s) : 0) +
      (x && l !== 1 ? 1 : 0) +
      (this.crossBad.has(c) ? 1 : 0)
    );
  }

  ripup(ni: number): void {
    const large = this.nets[ni].large;
    if (large) this.ownerCache = null;
    for (const c of this.cells[ni]) {
      if (large) this.occL[c]--;
      else this.occS[c]--;
    }
    for (const c of this.crossCells[ni]) this.occX[c]--;
    for (const c of this.interCells[ni]) this.occI[c]--;
    this.interCells[ni] = new Set();
    this.cells[ni] = new Set();
    this.tree[ni] = new Set();
    this.edges[ni] = [];
    this.crossCells[ni] = new Set();
  }

  private footprint(a: number): [number, number, number, number] {
    const g = this.gw;
    return [a, a + 1, a + g, a + g + 1];
  }

  commit(ni: number, tree: Set<number>, edges: number[]): void {
    const large = this.nets[ni].large;
    if (large) this.ownerCache = null;
    const cells = new Set<number>();
    const cross = new Set<number>();
    const inter = new Set<number>();
    if (large) {
      for (const a of tree) for (const c of this.footprint(a)) cells.add(c);
      for (let i = 0; i < edges.length; i += 3) {
        if (edges[i + 2] !== EDGE_LCROSS) continue;
        const mid = edges[i] + (edges[i + 1] - edges[i]) / 2;
        for (const c of this.footprint(mid)) {
          cells.add(c);
          inter.add(c);
        }
      }
      for (const c of cells) this.occL[c]++;
      for (const c of inter) this.occI[c]++;
    } else {
      for (const c of tree) cells.add(c);
      for (const c of cells) this.occS[c]++;
      for (let i = 0; i < edges.length; i += 3) {
        if (edges[i + 2] !== EDGE_CROSS) continue;
        const a = edges[i];
        const b = edges[i + 1];
        const step = (b - a) / 3;
        cross.add(a + step);
        cross.add(a + 2 * step);
      }
      for (const c of cross) this.occX[c]++;
    }
    this.cells[ni] = cells;
    this.tree[ni] = new Set(tree);
    this.edges[ni] = edges;
    this.crossCells[ni] = cross;
    this.interCells[ni] = inter;
  }

  private smallCost(c: number): number {
    const s = this.occS[c];
    const l = this.occL[c];
    const over = (s >= 2 ? s - 1 : 0) + l * 2 + this.occX[c];
    return (1 + this.hist[c]) * (1 + this.pres * over) + this.shareCost * (s + l);
  }

  private largeCost(a: number, own: number): number {
    let tot = 0;
    const g = this.gw;
    for (let k = 0; k < 4; k++) {
      const c = a + (k & 1) + (k >> 1) * g;
      if (this.own[c] === own) continue;
      const s = this.occS[c];
      const l = this.occL[c];
      const over = l * 2 + s * 2 + this.occX[c] * 2;
      tot +=
        (1 + this.histL[c] + this.reserve[c] * 60) * (1 + this.pres * over) +
        this.shareCost * (s + l);
    }
    return tot * 0.5;
  }

  /**
   * A crossing entering tile n in direction d needs a 4x2 passthrough on a straight run of one
   * large pipe: n and the tile after it are the two crossed tiles, the run goes perpendicular.
   */
  private passthroughFits(n: number, d: number): boolean {
    const gw = this.gw;
    const across = d < 2 ? 1 : gw; // step from the first to the second crossed tile
    const along = d < 2 ? gw : 1; // step along the large pipe
    const first = across > 0 && (d === 1 || d === 3) ? n - across : n;
    const x0 = first % gw;
    const y0 = (first - x0) / gw;
    const L = this.occL;
    const S = this.occS;
    const X = this.occX;
    const ok = (t: number) => t >= 0 && t < this.N && L[t] === 1 && !S[t];
    const free = (t: number) => t < 0 || t >= this.N || L[t] === 0;
    for (const start of [-1, -2]) {
      // stay inside the grid along the run
      const a0 = d < 2 ? y0 + start : x0 + start;
      const lim = d < 2 ? this.gh : gw;
      if (a0 < 0 || a0 + 3 >= lim) continue;
      let good = true;
      for (let p = start; p < start + 4 && good; p++) {
        const t = first + p * along;
        const t2 = t + across;
        if (!ok(t) || !ok(t2)) good = false;
        else if (p !== 0 && p !== start + 1 && p !== start + 2 && (X[t] || X[t2])) good = false;
        else if (!free(t - across) || !free(t2 + across)) good = false;
      }
      if (good) return true;
    }
    return false;
  }

  /**
   * A large pipe at anchor c moving in direction d can cross another large pipe that runs
   * straight across its path two tiles ahead: anchor c + 2d is fully covered by that one pipe,
   * which continues on both sides, and the anchors c + d / c + 3d only touch it inside the
   * intersection.
   */
  private intersectionFits(c: number, d: number, ownGen: number): boolean {
    const gw = this.gw;
    const DX = [1, -1, 0, 0];
    const DY = [0, 0, 1, -1];
    const mx = (c % gw) + 2 * DX[d];
    const my = Math.floor(c / gw) + 2 * DY[d];
    if (mx < 1 || my < 1 || mx + 2 >= gw || my + 2 >= this.gh) return false;
    const at = (x: number, y: number) => y * gw + x;
    let owner = -1;
    for (const [x, y] of [
      [mx, my],
      [mx + 1, my],
      [mx, my + 1],
      [mx + 1, my + 1],
    ]) {
      const t = at(x, y);
      if (this.own[t] === ownGen) return false;
      if (this.occL[t] !== 1 || this.occS[t] || this.occX[t] || this.occI[t]) return false;
      const o = this.ownerOf(t);
      if (o < 0 || (owner >= 0 && o !== owner)) return false;
      owner = o;
    }
    // the crossed pipe runs straight across our path: present on both sides of the
    // intersection, absent right before / after it along our direction
    const vertical = DY[d] !== 0;
    const present = vertical
      ? [at(mx - 1, my), at(mx - 1, my + 1), at(mx + 2, my), at(mx + 2, my + 1)]
      : [at(mx, my - 1), at(mx + 1, my - 1), at(mx, my + 2), at(mx + 1, my + 2)];
    const absent = vertical
      ? [at(mx, my - 1), at(mx + 1, my - 1), at(mx, my + 2), at(mx + 1, my + 2)]
      : [at(mx - 1, my), at(mx - 1, my + 1), at(mx + 2, my), at(mx + 2, my + 1)];
    for (const t of present) if (this.ownerOf(t) !== owner) return false;
    for (const t of absent) if (this.occL[t] && this.ownerOf(t) === owner) return false;
    return true;
  }

  /** Large net covering a tile (-1 none, -2 several). Uses the committed cells. */
  private ownerOf(t: number): number {
    if (t < 0 || t >= this.N || !this.occL[t]) return -1;
    if (!this.ownerCache) {
      this.ownerCache = new Int32Array(this.N).fill(-1);
      this.nets.forEach((net, ni) => {
        if (!net.large) return;
        for (const c of this.cells[ni]) {
          this.ownerCache![c] = this.ownerCache![c] === -1 ? ni : -2;
        }
      });
    }
    return this.ownerCache[t];
  }

  private ownerCache: Int32Array | null = null;

  // ------------------------------------------------------------------ A*

  /**
   * Search from `sources` (marked with the current generation in `own`) to any tile marked as
   * target. Returns the path as flat [cell, kind-of-edge-into-cell] pairs from target back.
   */
  private astar(
    sources: Iterable<number>,
    targets: Iterable<number>,
    large: boolean,
    ownGen: number,
    win: [number, number, number, number],
  ): number[] | null {
    const gw = this.gw;
    const [x0, y0] = win;
    let [, , x1, y1] = win;
    if (large) {
      x1 = Math.min(x1, gw - 2);
      y1 = Math.min(y1, this.gh - 2);
    }
    const gen = ++this.gen;
    const tg = this.tgt;
    let tx0 = Infinity;
    let ty0 = Infinity;
    let tx1 = -Infinity;
    let ty1 = -Infinity;
    for (const t of targets) {
      tg[t] = gen;
      const tx = t % gw;
      const ty = (t - tx) / gw;
      if (tx < tx0) tx0 = tx;
      if (tx > tx1) tx1 = tx;
      if (ty < ty0) ty0 = ty;
      if (ty > ty1) ty1 = ty;
    }
    const hw = this.hWeight;
    const blocked = large ? this.blockedL : this.blocked;
    const occS = this.occS;
    const occL = this.occL;
    const G = this.gArr;
    const st = this.stamp;
    const came = this.came;
    const kindA = this.kindArr;
    const dirA = this.dirArr;
    const own = this.own;
    const heap = this.heap;
    heap.clear();
    const H = (x: number, y: number) =>
      (x < tx0 ? tx0 - x : x > tx1 ? x - tx1 : 0) + (y < ty0 ? ty0 - y : y > ty1 ? y - ty1 : 0);
    for (const s of sources) {
      st[s] = gen;
      G[s] = 0;
      came[s] = -1;
      dirA[s] = -1;
      kindA[s] = 0;
      const sx = s % gw;
      heap.push(H(sx, (s - sx) / gw) * hw, 0, s);
    }
    const DX = [1, -1, 0, 0];
    const DY = [0, 0, 1, -1];
    const OFF = [1, -1, gw, -gw];
    const bend = large ? this.bendCost * 4 : this.bendCost;
    const jump = large ? 1 : this.jump;
    const jcost = this.jumpCost;
    const xcost = this.crossCost;
    const out = this.popped;
    let found = -1;
    const relax = (
      n: number,
      nx: number,
      ny: number,
      ng: number,
      from: number,
      d: number,
      k: number,
    ) => {
      if (st[n] !== gen || ng < G[n]) {
        st[n] = gen;
        G[n] = ng;
        came[n] = from;
        dirA[n] = d;
        kindA[n] = k;
        heap.push(ng + hw * H(nx, ny), ng, n);
      }
    };
    while (heap.size) {
      heap.pop(out);
      const gc = out[0];
      const c = out[1];
      if (gc > G[c]) continue;
      if (tg[c] === gen) {
        found = c;
        break;
      }
      const cx = c % gw;
      const cy = (c - cx) / gw;
      const dc = dirA[c];
      for (let d = 0; d < 4; d++) {
        const nx = cx + DX[d];
        const ny = cy + DY[d];
        if (nx < x0 || nx > x1 || ny < y0 || ny > y1) continue;
        const n = c + OFF[d];
        if (blocked[n]) continue;
        const turn = dc >= 0 && d !== dc ? bend : 0;
        const isOwn = own[n] === ownGen;
        const onLarge = !large && occL[n] > 0;
        if (!onLarge || !this.largeFrozen || this.probe) {
          const step = isOwn
            ? 0
            : large
              ? this.largeCost(n, ownGen)
              : this.smallCost(n) + (onLarge && this.probe ? 4 : 0);
          relax(n, nx, ny, gc + step + turn, c, d, EDGE_STEP);
        }
        if (large) {
          if (!isOwn && this.intersectionFits(c, d, ownGen)) {
            const m = c + 4 * OFF[d];
            const mx = cx + 4 * DX[d];
            const my = cy + 4 * DY[d];
            if (mx >= x0 && mx <= x1 && my >= y0 && my <= y1 && !blocked[m]) {
              const mid = c + 2 * OFF[d];
              let pen = 0;
              for (const q of this.footprint(mid)) pen += this.histL[q] + this.pres * this.occI[q];
              const sm = own[m] === ownGen ? 0 : this.largeCost(m, ownGen);
              relax(m, mx, my, gc + 3 + xcost * (1 + pen) + sm + turn, c, d, EDGE_LCROSS);
            }
          }
          continue;
        }
        if (isOwn) continue;
        if (occL[n] > 0) {
          // passthrough: cross a 2-wide large pipe straight to the tile beyond it
          const n2 = n + OFF[d];
          const n3 = n2 + OFF[d];
          const x3 = cx + 3 * DX[d];
          const y3 = cy + 3 * DY[d];
          if (x3 < x0 || x3 > x1 || y3 < y0 || y3 > y1) continue;
          if (blocked[n2] || blocked[n3] || occL[n2] === 0 || occL[n3] > 0) continue;
          if (occS[n] || occS[n2]) continue;
          if (!this.passthroughFits(n, d)) continue;
          const pen =
            (1 + this.hist[n] + this.hist[n2]) * (1 + this.pres * (this.occX[n] + this.occX[n2]));
          const s3 = own[n3] === ownGen ? 0 : this.smallCost(n3);
          relax(n3, x3, y3, gc + 2 + xcost * pen + s3 + turn, c, d, EDGE_CROSS);
          continue;
        }
        if (jump > 1 && occS[n] > 0) {
          // quantum piping: hop over normal pipes in front (never over machines / large pipes)
          for (let k = 2; k <= jump; k++) {
            const jx = cx + DX[d] * k;
            const jy = cy + DY[d] * k;
            if (jx < x0 || jx > x1 || jy < y0 || jy > y1) break;
            const m = c + OFF[d] * k;
            const mid = m - OFF[d];
            if (blocked[m] || occL[mid] > 0 || occL[m] > 0) break;
            const sm = own[m] === ownGen ? 0 : this.smallCost(m);
            relax(m, jx, jy, gc + sm + (k - 1) + jcost + turn, c, d, EDGE_HOP);
          }
        }
      }
    }
    if (found < 0) return null;
    const path: number[] = [];
    let c = found;
    let conflict = false;
    while (c !== -1) {
      path.push(c, kindA[c]);
      if (own[c] !== ownGen) {
        if (large) {
          const g = this.gw;
          if (occL[c] || occL[c + 1] || occL[c + g] || occL[c + g + 1]) conflict = true;
          if (occS[c] || occS[c + 1] || occS[c + g] || occS[c + g + 1]) conflict = true;
        } else if (occL[c] || occS[c] >= 2) {
          conflict = true;
        }
      }
      c = came[c];
    }
    this.lastCost = G[found];
    this.lastConflict = conflict;
    return path;
  }

  private lastCost = 0;
  private lastConflict = false;

  private bbox(cells: Iterable<number>, pad: number | null): [number, number, number, number] {
    if (pad === null) return [0, 0, this.gw - 1, this.gh - 1];
    const gw = this.gw;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const c of cells) {
      const x = c % gw;
      const y = (c - x) / gw;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    return [
      Math.max(0, x0 - pad),
      Math.max(0, y0 - pad),
      Math.min(gw - 1, x1 + pad),
      Math.min(this.gh - 1, y1 + pad),
    ];
  }

  routeNet(ni: number): boolean {
    const net = this.nets[ni];
    const large = net.large;
    const terms = net.terms.filter((t) => t.size > 0);
    if (terms.length < net.terms.length) return false;
    if (terms.length < 2) {
      this.commit(ni, new Set(), []);
      return true;
    }
    const gw = this.gw;
    const tree = new Set<number>();
    const edges: number[] = [];
    // `own` marks tiles (or footprint tiles for large nets) already part of this net
    const ownGen = ++this.gen;
    const own = this.own;
    const cent = terms.map((t) => {
      let sx = 0;
      let sy = 0;
      for (const c of t) {
        const x = c % gw;
        sx += x;
        sy += (c - x) / gw;
      }
      return [sx / t.size, sy / t.size];
    });
    // start from the terminal nearest to the centroid of all terminals
    let cx = 0;
    let cy = 0;
    for (const [x, y] of cent) {
      cx += x;
      cy += y;
    }
    cx /= cent.length;
    cy /= cent.length;
    let first = 0;
    let fd = Infinity;
    cent.forEach(([x, y], i) => {
      const d = Math.abs(x - cx) + Math.abs(y - cy);
      if (d < fd) {
        fd = d;
        first = i;
      }
    });
    const remaining = terms.map((_t, i) => i).filter((i) => i !== first);
    let base: Set<number> = terms[first];
    const mark = (c: number) => {
      if (large) for (const q of this.footprint(c)) own[q] = ownGen;
      else own[c] = ownGen;
    };
    while (remaining.length) {
      const [bx0, by0, bx1, by1] = this.bbox(base, 0);
      let bj = 0;
      let bd = Infinity;
      remaining.forEach((j, idx) => {
        const [x, y] = cent[j];
        const d = Math.max(bx0 - x, 0, x - bx1) + Math.max(by0 - y, 0, y - by1);
        if (d < bd) {
          bd = d;
          bj = idx;
        }
      });
      const j = remaining.splice(bj, 1)[0];
      let hit = false;
      for (const c of terms[j]) if (tree.has(c)) hit = true;
      if (hit) continue;
      // a small window first; when that path runs through occupied tiles, look further out
      // for a detour and keep the cheaper of the two
      let path: number[] | null = null;
      let cost = Infinity;
      for (const pad of [12, 40, null]) {
        const win = this.bbox([...base, ...terms[j]], pad);
        const p = this.astar(base, terms[j], large, ownGen, win);
        if (p && this.lastCost < cost) {
          path = p;
          cost = this.lastCost;
          if (!this.lastConflict) break;
        }
      }
      if (!path) {
        this.commit(ni, tree, edges);
        return false;
      }
      // path: [cell, kind] from target back to the source
      for (let i = 0; i < path.length; i += 2) {
        const c = path[i];
        tree.add(c);
        mark(c);
        if (i + 2 < path.length) edges.push(path[i + 2], c, path[i + 1]);
      }
      base = tree;
    }
    this.commit(ni, tree, edges);
    return true;
  }

  // ------------------------------------------------------------------ passthroughs

  /** Crossings of normal pipes over large pipes, in tile coordinates. */
  crossings(): Crossing[] {
    const gw = this.gw;
    const out: Crossing[] = [];
    this.nets.forEach((net, ni) => {
      if (net.large) return;
      const e = this.edges[ni];
      for (let i = 0; i < e.length; i += 3) {
        if (e[i + 2] !== EDGE_CROSS) continue;
        const a = Math.min(e[i], e[i + 1]);
        const b = Math.max(e[i], e[i + 1]);
        const step = (b - a) / 3;
        const t1 = a + step;
        const x = t1 % gw;
        out.push({ net: ni, kind: net.kind, x, y: (t1 - x) / gw, vertical: step !== 1 });
      }
    });
    return out;
  }

  /**
   * Assign every crossing to a passthrough; crossings that cannot get one become conflicts
   * (reported through overAmount / overusedCells).
   */
  checkCrossings(): { passthroughs: Passthrough[]; bad: Set<number> } {
    const gw = this.gw;
    const owner = new Int32Array(this.N).fill(-1);
    this.nets.forEach((net, ni) => {
      if (!net.large) return;
      for (const c of this.cells[ni]) owner[c] = owner[c] === -1 ? ni : -2;
    });
    const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < gw && y < this.gh;
    const res = assignPassthroughs(this.crossings(), {
      largeOwner: (x, y) => (inside(x, y) ? owner[y * gw + x] : -1),
      occS: (x, y) => (inside(x, y) ? this.occS[y * gw + x] : 0),
      occX: (x, y) => (inside(x, y) ? this.occX[y * gw + x] : 0),
    });
    return { passthroughs: res.passthroughs, bad: new Set(res.bad.map(([x, y]) => y * gw + x)) };
  }

  // ------------------------------------------------------------------ PathFinder

  /** PathFinder negotiation over a set of nets. Returns true when they are conflict free. */
  private negotiate(
    nets: number[],
    maxIters: number,
    deadline: number,
    clock: () => number,
    log: ((m: string) => void) | undefined,
    label: string,
  ): boolean {
    let todo = nets;
    this.pres = 0.5;
    let bestScore = Infinity;
    let stall = 0;
    for (let it = 0; it < maxIters; it++) {
      const tp = clock();
      // rip up and reroute one net at a time: when time runs out the rest keep their routes
      for (const ni of todo) {
        if (clock() > deadline) break;
        this.ripup(ni);
        this.failed.delete(ni);
        if (!this.routeNet(ni)) this.failed.add(ni);
      }
      const over = this.overusedCells();
      let failed = 0;
      for (const ni of nets) if (this.failed.has(ni)) failed++;
      log?.(
        `    ${label} pass ${it + 1}: ${todo.length} rerouted, ${over.length} conflicts, ${failed} unroutable (${(clock() - tp).toFixed(1)}s)`,
      );
      if (!over.length && !failed) return true;
      if (clock() > deadline) break;
      const score = over.length + 50 * failed;
      if (score < bestScore) {
        bestScore = score;
        stall = 0;
      } else if (++stall >= this.stallLimit) {
        break;
      }
      const h = this.largeFrozen ? this.hist : this.histL;
      for (const c of over) h[c] += 0.6 * this.overAmount(c);
      this.pres = Math.min(this.pres * 1.6, 12);
      const overSet = new Set(over);
      todo = nets.filter((ni) => {
        if (this.failed.has(ni)) return true;
        for (const c of this.cells[ni]) if (overSet.has(c)) return true;
        for (const c of this.crossCells[ni]) if (overSet.has(c)) return true;
        for (const c of this.interCells[ni]) if (overSet.has(c)) return true;
        return false;
      });
    }
    return false;
  }

  /**
   * For normal pipes that failed or still conflict: find where they would like to run over the
   * large pipes and make those large tiles more expensive for the next large-pipe pass.
   */
  private pushLargePipes(small: number[]): number {
    const over = new Set(this.overusedCells());
    const stuck = small.filter((ni) => {
      if (this.failed.has(ni)) return true;
      for (const c of this.cells[ni]) if (over.has(c)) return true;
      return false;
    });
    let pushed = 0;
    for (const ni of stuck) {
      this.ripup(ni);
      this.probe = true;
      this.routeNet(ni);
      this.probe = false;
      const gw = this.gw;
      for (const c of this.cells[ni]) {
        if (!this.occL[c]) continue;
        this.hotspots.add(c);
        // push the whole neighbourhood so the large pipe moves rather than shifts a tile
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const q = c + dy * gw + dx;
            if (q >= 0 && q < this.N && this.occL[q]) this.histL[q] += dx || dy ? 1 : 3;
          }
        }
        pushed++;
      }
      this.ripup(ni);
      this.failed.add(ni);
    }
    return pushed;
  }

  run(
    timeLimit = 60,
    maxIters = 40,
    log?: (m: string) => void,
    clock: () => number = () => Date.now() / 1000,
  ): boolean {
    const t0 = clock();
    const deadline = t0 + timeLimit;
    const bySpan = (a: number, b: number) => this.span(b) - this.span(a);
    const free = this.nets.map((_n, i) => i).filter((i) => !this.nets[i].fixed);
    const large = free.filter((i) => this.nets[i].large).sort(bySpan);
    const small = free.filter((i) => !this.nets[i].large).sort(bySpan);
    this.failed = new Set();
    let ok = false;
    let best: { score: number; snap: ReturnType<Router['snapshot']> } | null = null;
    const keepBest = () => {
      this.markUnrouted();
      const sc = this.overusedCells().length + 50 * this.failed.size;
      if (!best || sc < best.score) best = { score: sc, snap: this.snapshot() };
      return sc;
    };
    let roundStart: number;
    for (let round = 0; round < 12 && clock() < deadline; round++) {
      roundStart = clock();
      // phase A: large pipes on their own (normal pipes removed)
      for (const ni of small) this.ripup(ni);
      this.largeFrozen = false;
      // large pipes get at most half of the remaining time, normal pipes need the rest
      const deadlineL = clock() + (deadline - clock()) * 0.5;
      const okL = large.length
        ? this.negotiate(
            large,
            Math.min(maxIters, 30),
            deadlineL,
            clock,
            log,
            `large r${round + 1}`,
          )
        : true;
      // phase B: normal pipes around / through the fixed large pipes
      this.largeFrozen = true;
      const okS = this.negotiate(small, maxIters, deadline, clock, log, `normal r${round + 1}`);
      ok = okL && okS;
      keepBest();
      if (ok || !large.length || clock() > deadline - 0.5) break;
      // a new round rips up every large pipe: only start one that can finish
      if (deadline - clock() < (clock() - roundStart) * 0.9) break;
      const pushed = this.pushLargePipes(small);
      log?.(`    round ${round + 1}: pushing large pipes off ${pushed} tiles`);
      if (!pushed) {
        // nothing to push: let the stuck normal pipes try again on the current large layout
        this.negotiate(small, maxIters, deadline, clock, log, `normal r${round + 1}+`);
        ok = !this.overusedCells().length && !this.failed.size;
        keepBest();
        break;
      }
      for (const ni of large) this.ripup(ni);
    }
    this.largeFrozen = false;
    this.markUnrouted();
    const b = best as { score: number; snap: ReturnType<Router['snapshot']> } | null;
    if (!ok && b) {
      this.restore(b.snap);
      ok = b.score === 0;
    }
    this.overusedCells();
    return ok;
  }

  /**
   * Negotiate only the given nets; every other net keeps its committed route (fixed). Large
   * pipes first, then normal pipes around / through them.
   */
  runSubset(subset: number[], timeLimit: number, clock: () => number): boolean {
    const deadline = clock() + timeLimit;
    const large = subset.filter((i) => this.nets[i].large);
    const small = subset.filter((i) => !this.nets[i].large);
    for (const ni of subset) this.ripup(ni);
    this.failed = new Set();
    let ok = true;
    if (large.length) {
      this.largeFrozen = false;
      ok = this.negotiate(
        large,
        30,
        clock() + (deadline - clock()) * 0.5,
        clock,
        undefined,
        'large',
      );
    }
    this.largeFrozen = true;
    if (small.length) ok = this.negotiate(small, 40, deadline, clock, undefined, 'normal') && ok;
    this.largeFrozen = false;
    const over = new Set(this.overusedCells());
    return (
      ok &&
      subset.every((ni) => {
        if (this.failed.has(ni)) return false;
        for (const c of this.cells[ni]) if (over.has(c)) return false;
        return true;
      })
    );
  }

  /**
   * Cheapest path for net ni from any of `sources` to any of `targets` (grid cells, anchors for
   * large nets) around everything committed. The net's own committed tiles are free to reuse.
   * Returns [cell, kind of the segment into it] pairs from target to source, or null.
   */
  findPath(ni: number, sources: Iterable<number>, targets: Iterable<number>): number[] | null {
    const large = this.nets[ni].large;
    const ownGen = ++this.gen;
    for (const c of this.tree[ni]) {
      if (large) for (const q of this.footprint(c)) this.own[q] = ownGen;
      else this.own[c] = ownGen;
    }
    this.largeFrozen = !large;
    const path = this.astar(sources, targets, large, ownGen, [0, 0, this.gw - 1, this.gh - 1]);
    this.largeFrozen = false;
    return path;
  }

  /** Nets left without a route (e.g. time ran out before they were rerouted) count as failed. */
  private markUnrouted(): void {
    this.nets.forEach((net, ni) => {
      const needed =
        net.terms.filter((t) => t.size > 0).length >= 2 || net.terms.some((t) => !t.size);
      if (needed && !this.tree[ni].size) this.failed.add(ni);
    });
  }

  /** Routing state of every net (for keeping the best round). */
  snapshot() {
    return {
      tree: this.tree.map((t) => new Set(t)),
      edges: this.edges.map((e) => [...e]),
      failed: new Set(this.failed),
    };
  }

  restore(snap: ReturnType<Router['snapshot']>): void {
    this.nets.forEach((_n, ni) => this.ripup(ni));
    this.nets.forEach((_n, ni) => this.commit(ni, snap.tree[ni], snap.edges[ni]));
    this.failed = new Set(snap.failed);
  }

  private span(ni: number): number {
    const all: number[] = [];
    for (const t of this.nets[ni].terms) for (const c of t) all.push(c);
    if (!all.length) return 0;
    const [x0, y0, x1, y1] = this.bbox(all, 0);
    return x1 - x0 + (y1 - y0);
  }

  /** Why a tile is in conflict (for diagnostics). */
  conflictReasons(): Record<string, number> {
    const out: Record<string, number> = {};
    const add = (k: string) => (out[k] = (out[k] ?? 0) + 1);
    for (let c = 0; c < this.N; c++) {
      const s = this.occS[c];
      const l = this.occL[c];
      const x = this.occX[c];
      if (s > 2) add('normal>2');
      if (l > 2) add('large>2');
      if (s && l) add('normal+large');
      if (x > 1) add('2 crossings');
      if (x && s) add('crossing+normal');
      if (x && l !== 1) add('crossing not on 1 large');
      if (this.crossBad.has(c)) add('no passthrough');
      if (l === 2 && this.occI[c] !== 1) add('large overlap');
      if (this.interBad.has(c)) add('bad intersection');
    }
    return out;
  }

  /** Intersections whose crossed pipe no longer runs straight across them. */
  checkIntersections(): Set<number> {
    const gw = this.gw;
    const owners = new Map<number, number[]>();
    this.nets.forEach((net, ni) => {
      if (!net.large) return;
      for (const c of this.cells[ni]) {
        const l = owners.get(c);
        if (l) l.push(ni);
        else owners.set(c, [ni]);
      }
    });
    const has = (t: number, ni: number) => owners.get(t)?.includes(ni) ?? false;
    const bad = new Set<number>();
    this.nets.forEach((net, ni) => {
      if (!net.large) return;
      const e = this.edges[ni];
      for (let i = 0; i < e.length; i += 3) {
        if (e[i + 2] !== EDGE_LCROSS) continue;
        const mid = e[i] + (e[i + 1] - e[i]) / 2;
        const vertical = Math.abs(e[i + 1] - e[i]) >= gw;
        const mx = mid % gw;
        const my = (mid - mx) / gw;
        const at = (x: number, y: number) => y * gw + x;
        const fp = this.footprint(mid);
        const others = (owners.get(fp[0]) ?? []).filter((o) => o !== ni);
        let ok = others.length === 1;
        if (ok) {
          const o = others[0];
          ok = fp.every((t) => has(t, o) && (owners.get(t)?.length ?? 0) === 2);
          const present = vertical
            ? [at(mx - 1, my), at(mx - 1, my + 1), at(mx + 2, my), at(mx + 2, my + 1)]
            : [at(mx, my - 1), at(mx + 1, my - 1), at(mx, my + 2), at(mx + 1, my + 2)];
          const absent = vertical
            ? [at(mx, my - 1), at(mx + 1, my - 1), at(mx, my + 2), at(mx + 1, my + 2)]
            : [at(mx - 1, my), at(mx - 1, my + 1), at(mx + 2, my), at(mx + 2, my + 1)];
          if (ok) ok = present.every((t) => has(t, o)) && absent.every((t) => !has(t, o));
        }
        if (!ok) for (const t of fp) bad.add(t);
      }
    });
    return bad;
  }

  /** Tiles shared by two nets of the same group. */
  private groupClashes(): Set<number> {
    const out = new Set<number>();
    const seen = new Map<number, number>();
    const groups = new Map<string, number[]>();
    this.nets.forEach((n, ni) => {
      if (!n.group) return;
      if (!groups.has(n.group)) groups.set(n.group, []);
      groups.get(n.group)!.push(ni);
    });
    for (const members of groups.values()) {
      if (members.length < 2) continue;
      seen.clear();
      for (const ni of members) {
        for (const c of this.cells[ni]) {
          const o = seen.get(c);
          if (o !== undefined && o !== ni) out.add(c);
          else seen.set(c, ni);
        }
      }
    }
    return out;
  }

  overusedCells(): number[] {
    const { passthroughs, bad } = this.checkCrossings();
    this.passthroughs = passthroughs;
    this.crossBad = bad;
    this.interBad = this.checkIntersections();
    for (const c of this.groupClashes()) this.interBad.add(c);
    const out: number[] = [];
    for (let c = 0; c < this.N; c++) if (this.overAmount(c) > 0) out.push(c);
    return out;
  }
}
