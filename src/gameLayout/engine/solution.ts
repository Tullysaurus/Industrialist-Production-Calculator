/** Coordinate-based finished layout: validation and row / column compaction. */
import { accessCells, largeAnchor, occupied, type Shape } from './geometry';
import { assignPassthroughs, type Crossing, type Passthrough } from './passthrough';
import type { Problem } from './problem';
import { EDGE_CROSS, EDGE_HOP, EDGE_LCROSS, EDGE_STEP } from './router';
import { spacingViolations, type SpacedRect } from './spacing';
import { now } from './clock';
import { aspectPenalty, hullStats, type HullStats } from './hull';

/**
 * Tiles are packed into one number: (y + OFF) * KX + (x + OFF). The offset lets hand-edited
 * layouts use negative coordinates; neighbours stay at +-1 / +-KX.
 */
export const KX = 1 << 16;
const OFF = 1 << 14;
export const key = (x: number, y: number) => (y + OFF) * KX + (x + OFF);
export const kx = (k: number) => (k % KX) - OFF;
export const ky = (k: number) => Math.floor(k / KX) - OFF;

export interface SolMachine {
  inst: number;
  node: number;
  x: number;
  y: number;
  shape: Shape;
  rot: number;
  local: number;
}

/** Weight of a pipe tile in the layout cost (an empty tile is 1). */
export const PIPE_WEIGHT = 0.1;

function inc(m: Map<number, number>, k: number, d = 1) {
  m.set(k, (m.get(k) ?? 0) + d);
}

export class Solution {
  problem: Problem;
  machines: SolMachine[];
  /** Per net: tiles (normal pipes) or 2x2 anchors (large pipes). */
  netNodes: Set<number>[];
  /** Per net: flat [a, b, kind] triples (tile keys). */
  netEdges: number[][];
  failed: Set<number>;
  jump: number;
  ok = false;
  nOver = 0;
  // derived
  blocked = new Map<number, number>();
  cells: Set<number>[] = [];
  occS = new Map<number, number>();
  occL = new Map<number, number>();
  occX = new Map<number, number>();
  /** Large intersection tiles. */
  occI = new Map<number, number>();
  largeOwner = new Map<number, number>();
  passthroughs: Passthrough[] = [];
  passthroughBad: [number, number][] = [];
  bbox: [number, number, number, number] = [0, 0, 0, 0];
  autoPieces: boolean;
  /** Pinned area (x0, y0, x1, y1): compaction never deletes a row / column through it. */
  pinnedRegion: [number, number, number, number] | null = null;

  constructor(
    problem: Problem,
    machines: SolMachine[],
    netNodes: Set<number>[],
    netEdges: number[][],
    failed: Iterable<number>,
    jump: number,
    /**
     * true (generator): passthroughs / intersections are assigned automatically from the
     * crossings. false (editor): they are placed pieces, checked by the document evaluation.
     */
    autoPieces = true,
  ) {
    this.autoPieces = autoPieces;
    this.problem = problem;
    this.machines = machines;
    this.netNodes = netNodes;
    this.netEdges = netEdges;
    this.failed = new Set(failed);
    this.jump = jump;
    this.refresh();
  }

  copy(): Solution {
    const s = new Solution(
      this.problem,
      this.machines.map((m) => ({ ...m })),
      this.netNodes.map((n) => new Set(n)),
      this.netEdges.map((e) => [...e]),
      this.failed,
      this.jump,
      this.autoPieces,
    );
    s.ok = this.ok;
    s.nOver = this.nOver;
    s.pinnedRegion = this.pinnedRegion;
    return s;
  }

  refresh(): void {
    this.blocked = new Map();
    for (const m of this.machines) {
      for (const [x, y] of occupied(m.shape)) this.blocked.set(key(m.x + x, m.y + y), m.inst);
    }
    this.cells = [];
    this.occS = new Map();
    this.occL = new Map();
    this.occX = new Map();
    this.occI = new Map();
    this.largeOwner = new Map();
    this.netNodes.forEach((nodes, ni) => {
      const large = this.problem.nets[ni].large;
      const cells = new Set<number>();
      const fp = (a: number) => [a, a + 1, a + KX, a + KX + 1];
      for (const a of nodes) {
        if (large) for (const c of fp(a)) cells.add(c);
        else cells.add(a);
      }
      if (large) {
        const e = this.netEdges[ni];
        for (let i = 0; i < e.length; i += 3) {
          if (e[i + 2] !== EDGE_LCROSS) continue;
          for (const c of fp(e[i] + (e[i + 1] - e[i]) / 2)) {
            cells.add(c);
            inc(this.occI, c);
          }
        }
      }
      this.cells.push(cells);
      for (const c of cells) {
        inc(large ? this.occL : this.occS, c);
        if (large) this.largeOwner.set(c, this.largeOwner.has(c) ? -2 : ni);
      }
      if (!large) {
        const e = this.netEdges[ni];
        const cross = new Set<number>();
        for (let i = 0; i < e.length; i += 3) {
          if (e[i + 2] !== EDGE_CROSS) continue;
          const a = Math.min(e[i], e[i + 1]);
          const step = (Math.max(e[i], e[i + 1]) - a) / 3;
          cross.add(a + step);
          cross.add(a + 2 * step);
        }
        for (const c of cross) inc(this.occX, c);
      }
    });
    if (this.autoPieces) {
      const res = assignPassthroughs(this.crossings(), {
        largeOwner: (x, y) => this.largeOwner.get(key(x, y)) ?? -1,
        occS: (x, y) => this.occS.get(key(x, y)) ?? 0,
        occX: (x, y) => this.occX.get(key(x, y)) ?? 0,
      });
      this.passthroughs = res.passthroughs;
      this.passthroughBad = res.bad;
    } else {
      this.passthroughs = [];
      this.passthroughBad = [];
    }
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const m of this.machines) {
      x0 = Math.min(x0, m.x);
      y0 = Math.min(y0, m.y);
      x1 = Math.max(x1, m.x + m.shape.w);
      y1 = Math.max(y1, m.y + m.shape.h);
    }
    for (const cells of this.cells) {
      for (const c of cells) {
        const x = kx(c);
        const y = ky(c);
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x + 1 > x1) x1 = x + 1;
        if (y + 1 > y1) y1 = y + 1;
      }
    }
    if (!Number.isFinite(x0)) [x0, y0, x1, y1] = [0, 0, 0, 0];
    this.bbox = [x0, y0, x1, y1];
    this.hullCache = null;
  }

  crossings(): Crossing[] {
    const out: Crossing[] = [];
    this.netEdges.forEach((e, ni) => {
      const net = this.problem.nets[ni];
      if (net.large) return;
      for (let i = 0; i < e.length; i += 3) {
        if (e[i + 2] !== EDGE_CROSS) continue;
        const a = Math.min(e[i], e[i + 1]);
        const step = (Math.max(e[i], e[i + 1]) - a) / 3;
        const t = a + step;
        out.push({ net: ni, kind: net.kind, x: kx(t), y: ky(t), vertical: step !== 1 });
      }
    });
    return out;
  }

  get width(): number {
    return this.bbox[2] - this.bbox[0];
  }

  get height(): number {
    return this.bbox[3] - this.bbox[1];
  }

  get area(): number {
    return this.width * this.height;
  }

  /** Used tiles (machines and pipes) as a mask over the bounding box. */
  usedMask(): Uint8Array {
    const [x0, y0] = this.bbox;
    const w = this.width;
    const mask = new Uint8Array(w * this.height);
    for (const c of this.blocked.keys()) mask[(ky(c) - y0) * w + kx(c) - x0] = 1;
    for (const cells of this.cells) for (const c of cells) mask[(ky(c) - y0) * w + kx(c) - x0] = 1;
    return mask;
  }

  private hullCache: HullStats | null = null;

  /** Orthogonal hull and empty tiles inside it. */
  get hull(): HullStats {
    this.hullCache ??= hullStats(this.usedMask(), this.width, this.height);
    return this.hullCache;
  }

  /** Pipe tiles (normal and large). */
  get pipeTiles(): number {
    const s = new Set<number>();
    for (const cells of this.cells) for (const c of cells) s.add(c);
    return s.size;
  }

  /**
   * What the generator minimises: empty tiles inside the orthogonal hull, a soft penalty for
   * elongated layouts, and pipe length as a tie-break.
   */
  get cost(): number {
    const h = this.hull;
    return (
      h.empty +
      aspectPenalty(h.width, h.height, h.hull) +
      Solution.notchWeight * (h.width * h.height - h.hull) +
      PIPE_WEIGHT * this.pipeTiles
    );
  }

  /** Cost of a bounding-box tile outside the orthogonal hull (an empty tile inside costs 1). */
  static notchWeight = 0;

  overfull(): number[] {
    const out = new Set<number>();
    const keys = new Set([...this.occS.keys(), ...this.occL.keys(), ...this.occX.keys()]);
    for (const c of keys) {
      const s = this.occS.get(c) ?? 0;
      const l = this.occL.get(c) ?? 0;
      const x = this.occX.get(c) ?? 0;
      const i = this.occI.get(c) ?? 0;
      if (s > 2 || l > 2 || (s && l) || x > 1 || (x && s) || (x && l !== 1)) out.add(c);
      if ((l === 2 && i !== 1) || i > 1) out.add(c);
    }
    if (this.autoPieces) for (const c of this.badIntersections()) out.add(c);
    for (const [x, y] of this.passthroughBad) out.add(key(x, y));
    return [...out];
  }

  /** Intersection tiles whose crossed pipe does not run straight across them. */
  badIntersections(): number[] {
    const owners = new Map<number, number[]>();
    this.cells.forEach((cs, ni) => {
      if (!this.problem.nets[ni].large) return;
      for (const c of cs) {
        const l = owners.get(c);
        if (l) l.push(ni);
        else owners.set(c, [ni]);
      }
    });
    const has = (t: number, ni: number) => owners.get(t)?.includes(ni) ?? false;
    const out: number[] = [];
    this.netEdges.forEach((e, ni) => {
      if (!this.problem.nets[ni].large) return;
      for (let i = 0; i < e.length; i += 3) {
        if (e[i + 2] !== EDGE_LCROSS) continue;
        const mid = e[i] + (e[i + 1] - e[i]) / 2;
        const vertical = Math.abs(e[i + 1] - e[i]) >= KX;
        const mx = kx(mid);
        const my = ky(mid);
        const fp = [mid, mid + 1, mid + KX, mid + KX + 1];
        const others = (owners.get(mid) ?? []).filter((o) => o !== ni);
        let ok = others.length === 1;
        if (ok) {
          const o = others[0];
          const present = vertical
            ? [key(mx - 1, my), key(mx - 1, my + 1), key(mx + 2, my), key(mx + 2, my + 1)]
            : [key(mx, my - 1), key(mx + 1, my - 1), key(mx, my + 2), key(mx + 1, my + 2)];
          const absent = vertical
            ? [key(mx, my - 1), key(mx + 1, my - 1), key(mx, my + 2), key(mx + 1, my + 2)]
            : [key(mx - 1, my), key(mx - 1, my + 1), key(mx + 2, my), key(mx + 2, my + 1)];
          ok =
            fp.every((t) => has(t, o) && (owners.get(t)?.length ?? 0) === 2) &&
            present.every((t) => has(t, o)) &&
            absent.every((t) => !has(t, o));
        }
        if (!ok) out.push(...fp);
      }
    });
    return out;
  }

  /** Large intersections: [x, y] of the 2x2 piece, and the two nets. */
  intersections(): { x: number; y: number; nets: [number, number] }[] {
    const out: { x: number; y: number; nets: [number, number] }[] = [];
    this.netEdges.forEach((e, ni) => {
      if (!this.problem.nets[ni].large) return;
      for (let i = 0; i < e.length; i += 3) {
        if (e[i + 2] !== EDGE_LCROSS) continue;
        const mid = e[i] + (e[i + 1] - e[i]) / 2;
        const other = this.largeOwner.get(mid);
        out.push({
          x: kx(mid),
          y: ky(mid),
          nets: [ni, other !== undefined && other >= 0 ? other : -1],
        });
      }
    });
    return out;
  }

  access(m: SolMachine, pid: string, large: boolean): number[] {
    const p = m.shape.ports.get(pid);
    if (!p) return [];
    if (large) {
      const [ax, ay] = largeAnchor(p);
      return [key(ax + m.x, ay + m.y)];
    }
    return accessCells(p).map(([x, y]) => key(x + m.x, y + m.y));
  }

  /** Rule violations (empty = valid). Stops after `limit` errors. */
  validate(limit = 20): string[] {
    const errs: string[] = [];
    const P = this.problem;
    const instM = new Map(this.machines.map((m) => [m.inst, m]));
    const seen = new Map<number, number>();
    for (const m of this.machines) {
      for (const [x, y] of occupied(m.shape)) {
        const c = key(m.x + x, m.y + y);
        if (seen.has(c)) {
          errs.push(`machines overlap at (${m.x + x}, ${m.y + y})`);
          return errs;
        }
        seen.set(c, m.inst);
      }
    }
    for (let ni = 0; ni < P.nets.length && errs.length < limit; ni++) {
      if (this.failed.has(ni)) continue;
      const net = P.nets[ni];
      const cells = this.cells[ni];
      for (const c of cells) {
        if (this.blocked.has(c)) {
          errs.push(`${net.label}: pipe under a machine`);
          break;
        }
      }
      const nodes = this.netNodes[ni];
      for (const t of net.terminals) {
        const m = instM.get(t.inst);
        if (!m || !t.ports.some((p) => this.access(m, p, net.large).some((a) => nodes.has(a)))) {
          errs.push(`${net.label}: a ${P.nodes[m?.node ?? 0].shape.name} is not connected`);
        }
      }
      if (!nodes.size) continue;
      const adj = new Map<number, number[]>();
      const e = this.netEdges[ni];
      for (let i = 0; i < e.length; i += 3) {
        const a = e[i];
        const b = e[i + 1];
        const kind = e[i + 2];
        const ax = kx(a);
        const ay = ky(a);
        const bx = kx(b);
        const by = ky(b);
        const dist = Math.abs(ax - bx) + Math.abs(ay - by);
        const straight = ax === bx || ay === by;
        let bad = !straight || dist < 1;
        if (!bad && kind === EDGE_STEP) bad = dist !== 1;
        if (!bad && kind === EDGE_HOP) bad = net.large || dist < 2 || dist > Math.max(1, this.jump);
        if (!bad && kind === EDGE_CROSS) bad = net.large || dist !== 3;
        if (!bad && kind === EDGE_LCROSS) bad = !net.large || dist !== 4;
        if (!bad && dist > 1) {
          const sx = Math.sign(bx - ax);
          const sy = Math.sign(by - ay);
          for (let s = 1; s < dist; s++) {
            const q = key(ax + sx * s, ay + sy * s);
            if (this.blocked.has(q)) bad = true;
            const l = this.occL.get(q) ?? 0;
            if (kind === EDGE_LCROSS) continue;
            if (kind === EDGE_HOP && l) bad = true;
            if (kind === EDGE_CROSS && !l) bad = true;
          }
          if (kind === EDGE_LCROSS) {
            // the 2x2 intersection is centred between the two anchors
            const mid = key((ax + bx) / 2, (ay + by) / 2);
            for (const q of [mid, mid + 1, mid + KX, mid + KX + 1]) {
              if ((this.occL.get(q) ?? 0) !== 2 || this.blocked.has(q)) bad = true;
            }
          }
        }
        if (bad) errs.push(`${net.label}: broken pipe segment`);
        if (!adj.has(a)) adj.set(a, []);
        if (!adj.has(b)) adj.set(b, []);
        adj.get(a)!.push(b);
        adj.get(b)!.push(a);
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
      if (vis.size !== nodes.size) errs.push(`${net.label}: pipe network not connected`);
    }
    if (P.spacing.size) {
      const rects: SpacedRect[] = [];
      for (const m of this.machines) {
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
        errs.push(
          `${v.a.type} #${v.a.id} and #${v.b.id} are only ${v.dist.toFixed(0)} tiles apart (need ${v.need})`,
        );
      }
    }
    const over = this.overfull();
    for (const c of over.slice(0, Math.max(0, limit - errs.length))) {
      errs.push(
        `pipe conflict at (${kx(c)}, ${ky(c)}): ${this.occS.get(c) ?? 0} normal + ${this.occL.get(c) ?? 0} large`,
      );
    }
    return errs;
  }

  // ------------------------------------------------------------------ compaction

  private adjacency(ni: number): Map<number, number[]> {
    const adj = new Map<number, number[]>();
    const e = this.netEdges[ni];
    for (let i = 0; i < e.length; i += 3) {
      const a = e[i];
      const b = e[i + 1];
      if (!adj.has(a)) adj.set(a, []);
      if (!adj.has(b)) adj.set(b, []);
      adj.get(a)!.push(b, e[i + 2]);
      adj.get(b)!.push(a, e[i + 2]);
    }
    return adj;
  }

  /** Delete tile row (axis 1) or column (axis 0) k if every rule still holds. */
  tryDelete(axis: 0 | 1, k: number): Solution | null {
    const coord = axis === 0 ? kx : ky;
    const pr = this.pinnedRegion;
    if (pr && k >= (axis === 0 ? pr[0] : pr[1]) && k < (axis === 0 ? pr[2] : pr[3])) return null;
    for (const m of this.machines) {
      const lo = axis === 1 ? m.y : m.x;
      const size = axis === 1 ? m.shape.h : m.shape.w;
      if (lo <= k && k < lo + size) return null;
    }
    const shift = (c: number) => {
      const x = kx(c);
      const y = ky(c);
      return axis === 0 ? key(x > k ? x - 1 : x, y) : key(x, y > k ? y - 1 : y);
    };
    const newNodes: Set<number>[] = [];
    const newEdges: number[][] = [];
    for (let ni = 0; ni < this.netNodes.length; ni++) {
      const nodes = this.netNodes[ni];
      const edges = this.netEdges[ni];
      let on: number[] | null = null;
      for (const c of nodes) {
        if (coord(c) === k) (on ??= []).push(c);
      }
      // an edge spanning the line without a node on it (hop / crossing) gets one tile shorter
      const es: number[] = [];
      let spanning = false;
      for (let i = 0; i < edges.length; i += 3) {
        const a = edges[i];
        const b = edges[i + 1];
        const ca = coord(a);
        const cb = coord(b);
        if (ca === k || cb === k) continue;
        if ((ca < k && cb > k) || (cb < k && ca > k)) {
          if (edges[i + 2] === EDGE_CROSS || edges[i + 2] === EDGE_LCROSS) return null;
          spanning = true;
        }
        es.push(shift(a), shift(b), edges[i + 2]);
      }
      if (spanning) {
        // shortened hops become steps when they reach length 1
        for (let i = 0; i < es.length; i += 3) {
          const d = Math.abs(kx(es[i]) - kx(es[i + 1])) + Math.abs(ky(es[i]) - ky(es[i + 1]));
          if (d === 1 && es[i + 2] === EDGE_HOP) es[i + 2] = EDGE_STEP;
        }
      }
      if (!on) {
        newNodes.push(new Set([...nodes].map(shift)));
        newEdges.push(es);
        continue;
      }
      const adj = this.adjacency(ni);
      for (const c of on) {
        const nb = adj.get(c) ?? [];
        if (!nb.length) return null;
        const lo: [number, number][] = [];
        const hi: [number, number][] = [];
        for (let i = 0; i < nb.length; i += 2) {
          const cn = coord(nb[i]);
          if (cn === k) return null; // the pipe runs along the line
          (cn < k ? lo : hi).push([nb[i], nb[i + 1]]);
        }
        if (lo.length > 1 || hi.length > 1) return null;
        if (lo.length && hi.length) {
          const [a, ka] = lo[0];
          const [b, kb] = hi[0];
          if (ka === EDGE_CROSS || kb === EDGE_CROSS || ka === EDGE_LCROSS || kb === EDGE_LCROSS) {
            return null;
          }
          const sa = shift(a);
          const sb = shift(b);
          const d = Math.abs(kx(sa) - kx(sb)) + Math.abs(ky(sa) - ky(sb));
          es.push(sa, sb, d === 1 ? EDGE_STEP : EDGE_HOP);
        } else if ((lo[0] ?? hi[0])[1] === EDGE_CROSS || (lo[0] ?? hi[0])[1] === EDGE_LCROSS) {
          return null;
        }
      }
      const kept = new Set<number>();
      for (const c of nodes) if (coord(c) !== k) kept.add(shift(c));
      newNodes.push(kept);
      newEdges.push(es);
    }
    const machines = this.machines.map((m) => {
      if ((axis === 1 ? m.y : m.x) > k) {
        return axis === 1 ? { ...m, y: m.y - 1 } : { ...m, x: m.x - 1 };
      }
      return { ...m };
    });
    const trial = new Solution(
      this.problem,
      machines,
      newNodes,
      newEdges,
      this.failed,
      this.jump,
      this.autoPieces,
    );
    if (trial.validate(1).length) return null;
    trial.ok = this.ok;
    if (pr) {
      const sh = (lo: number, hi: number, a: 0 | 1) =>
        (axis === a ? [lo > k ? lo - 1 : lo, hi > k ? hi - 1 : hi] : [lo, hi]) as [number, number];
      const [x0, x1] = sh(pr[0], pr[2], 0);
      const [y0, y1] = sh(pr[1], pr[3], 1);
      trial.pinnedRegion = [x0, y0, x1, y1];
    }
    return trial;
  }

  /** Delete empty-enough rows / columns until nothing changes or the deadline (ms) passes. */
  compact(log?: (m: string) => void, deadline?: number): Solution {
    if (this.validate(1).length) return this;
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- the working copy starts as this
    let sol: Solution = this;
    const removed = [0, 0];
    let outOfTime = false;
    let changed = true;
    while (changed && !outOfTime) {
      changed = false;
      for (const axis of [0, 1] as const) {
        const [x0, y0, x1, y1] = sol.bbox;
        const [lo, hi] = axis === 0 ? [x0, x1] : [y0, y1];
        // only lines that hold no machine are candidates
        const busy = new Uint8Array(hi - lo + 1);
        for (const m of sol.machines) {
          const a = axis === 0 ? m.x : m.y;
          const s = axis === 0 ? m.shape.w : m.shape.h;
          for (let v = a; v < a + s; v++) if (v >= lo && v <= hi) busy[v - lo] = 1;
        }
        for (let k = hi - 1; k >= lo; k--) {
          if (busy[k - lo]) continue;
          if (deadline !== undefined && now() > deadline) {
            outOfTime = true;
            break;
          }
          const t = sol.tryDelete(axis, k);
          if (t) {
            sol = t;
            removed[axis]++;
            changed = true;
          }
        }
        if (outOfTime) break;
      }
    }
    log?.(
      `  compaction removed ${removed[0]} columns and ${removed[1]} rows${outOfTime ? ' (stopped: time budget)' : ''}`,
    );
    return sol;
  }
}
