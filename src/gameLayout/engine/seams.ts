/**
 * Seam-carving compaction of a routed layout.
 *
 * A vertical seam takes one tile out of every row; everything right of it in that row moves one
 * tile left (a horizontal seam does the same with columns, moving things up). Unlike deleting a
 * whole row or column, a seam can step sideways between rows, so it finds the thin strips of
 * empty space between machines and pipes that never line up across the whole layout.
 *
 * A seam may pass through
 *  - empty tiles, and
 *  - normal pipe tiles the pipe runs straight across (the pipe gets one tile shorter).
 * Between two rows it may step sideways over a range of columns only where nothing joins those
 * rows there: machines, large pipes, pipes entering a port, hops and passthrough crossings are
 * rigid. A normal pipe that steps from one row to the next is the exception: the seam may cross
 * it if a free tile next to it lets the pipe take a one-tile jog.
 *
 * The best seam is found by dynamic programming over the rows: one pass, O(width x height).
 * Every carved layout is checked with the full rule validation and kept only when it is valid
 * and the layout cost goes down.
 */
import { accessCells } from './geometry';
import { fillOrthoHull } from './hull';
import { EDGE_CROSS, EDGE_HOP, EDGE_LCROSS, EDGE_STEP } from './router';
import { key, kx, ky, Solution } from './solution';
import { now } from './clock';

/** Axis 0: vertical seam (removes one x per row). Axis 1: horizontal seam (one y per column). */
type Axis = 0 | 1;

/**
 * Seam coordinates: u is the coordinate a seam removes, v the row it removes it from
 * (axis 0: u = x, v = y; axis 1: u = y, v = x), both relative to the bounding box.
 */
interface Frame {
  axis: Axis;
  x0: number;
  y0: number;
  U: number;
  V: number;
}

const uOf = (f: Frame, c: number) => (f.axis === 0 ? kx(c) - f.x0 : ky(c) - f.y0);
const vOf = (f: Frame, c: number) => (f.axis === 0 ? ky(c) - f.y0 : kx(c) - f.x0);
const keyOf = (f: Frame, u: number, v: number) =>
  f.axis === 0 ? key(u + f.x0, v + f.y0) : key(v + f.x0, u + f.y0);

/** DP cost of a pipe jog (one extra bend and tile). */
const JOG_COST = 0.3;

export interface SeamResult {
  /** The carved layout, or null when the seam broke a rule. */
  sol: Solution | null;
  /** Tiles of the seam that was tried (in the input layout's coordinates). */
  seam: number[];
}

/** Tile occupancy shared by the seam search and the carving. */
interface Grid {
  f: Frame;
  /** Machine or pipe on the tile (indexed v * U + u). */
  used: Uint8Array;
  /** Tile next to a machine port (a new pipe tile there would touch the port). */
  access: Uint8Array;
}

function inFrame(g: Grid, u: number, v: number): boolean {
  return u >= 0 && u < g.f.U && v >= 0 && v < g.f.V;
}

/** Free for a jog: inside the frame, empty and not next to a port. */
function free(g: Grid, u: number, v: number): boolean {
  if (!inFrame(g, u, v)) return false;
  const i = v * g.f.U + u;
  return !g.used[i] && !g.access[i];
}

/**
 * Finds the best seam along `axis` and carves it. Returns null when no seam would remove any
 * empty or pipe tile inside the layout. `banned` tiles are never used.
 */
export function carveSeam(sol: Solution, axis: Axis, banned?: Set<number>): SeamResult | null {
  const [x0, y0, x1, y1] = sol.bbox;
  const W = x1 - x0;
  const H = y1 - y0;
  if (W < 2 || H < 2) return null;
  const f: Frame = axis === 0 ? { axis, x0, y0, U: W, V: H } : { axis, x0, y0, U: H, V: W };
  const { U, V } = f;
  const P = sol.problem;
  const inside = (c: number) => {
    const x = kx(c);
    const y = ky(c);
    return x >= x0 && x < x1 && y >= y0 && y < y1;
  };
  const idx = (c: number) => vOf(f, c) * U + uOf(f, c);

  const forbid = new Uint8Array(U * V);
  /** hard[v * U + u]: tiles (u, v) and (u, v + 1) must move together. */
  const hard = new Uint8Array(U * V);
  /** soft[v * U + u]: normal pipe steps between (u, v) and (u, v + 1) (can take a jog). */
  const soft = new Uint8Array(U * V);
  const g: Grid = { f, used: new Uint8Array(U * V), access: new Uint8Array(U * V) };

  /** Joins two tiles of neighbouring rows at the same u. */
  const join = (a: number, b: number) => {
    if (!inside(a) || !inside(b) || uOf(f, a) !== uOf(f, b)) return;
    const va = vOf(f, a);
    const vb = vOf(f, b);
    if (Math.abs(va - vb) === 1) hard[Math.min(va, vb) * U + uOf(f, a)] = 1;
  };
  const rigidRect = (rx: number, ry: number, rw: number, rh: number) => {
    for (let y = ry; y < ry + rh; y++) {
      for (let x = rx; x < rx + rw; x++) {
        const c = key(x, y);
        if (!inside(c)) continue;
        forbid[idx(c)] = 1;
        g.used[idx(c)] = 1;
        if (axis === 0 && y + 1 < ry + rh) join(c, key(x, y + 1));
        if (axis === 1 && x + 1 < rx + rw) join(c, key(x + 1, y));
      }
    }
  };

  // machines (their whole bounding box) and the pinned area are rigid
  for (const m of sol.machines) rigidRect(m.x, m.y, m.shape.w, m.shape.h);
  if (sol.pinnedRegion) {
    const [px0, py0, px1, py1] = sol.pinnedRegion;
    rigidRect(px0, py0, px1 - px0, py1 - py0);
  }
  for (const cells of sol.cells) for (const c of cells) if (inside(c)) g.used[idx(c)] = 1;

  // pipes entering a machine port move with the machine; no new pipe next to a port
  const pipeAt = (c: number) => sol.occS.has(c) || sol.occL.has(c);
  for (const m of sol.machines) {
    for (const p of m.shape.ports.values()) {
      for (const [ax, ay] of accessCells(p)) {
        const c = key(m.x + ax, m.y + ay);
        if (inside(c)) g.access[idx(c)] = 1;
      }
      for (const [px, py] of p.cells) {
        const pc = key(m.x + px, m.y + py);
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]) {
          const nb = key(m.x + px + dx, m.y + py + dy);
          if (sol.blocked.get(nb) === m.inst || !pipeAt(nb) || !inside(nb)) continue;
          forbid[idx(nb)] = 1;
          join(pc, nb);
        }
      }
    }
  }

  // large pipes, intersections and passthrough slots are rigid
  for (const c of sol.occL.keys()) {
    if (!inside(c)) continue;
    forbid[idx(c)] = 1;
    const n = axis === 0 ? key(kx(c), ky(c) + 1) : key(kx(c) + 1, ky(c));
    if (sol.occL.has(n)) join(c, n);
  }
  for (const c of sol.occX.keys()) if (inside(c)) forbid[idx(c)] = 1;

  // pipe connections between rows; per tile, the connections along a row
  const along = new Map<number, [number, number, number][]>(); // tile -> [net, other, kind]
  sol.netEdges.forEach((e, ni) => {
    const large = P.nets[ni].large;
    for (let i = 0; i < e.length; i += 3) {
      const a = e[i];
      const b = e[i + 1];
      const kind = e[i + 2];
      const va = vOf(f, a);
      const vb = vOf(f, b);
      if (va !== vb) {
        const lo = Math.min(va, vb);
        const hi = Math.max(va, vb);
        const u = uOf(f, a);
        if (!large && kind === EDGE_STEP && hi - lo === 1) {
          if (u >= 0 && u < U && lo >= 0 && lo < V) soft[lo * U + u]++;
        } else {
          for (const uu of large ? [u, u + 1] : [u]) {
            if (uu < 0 || uu >= U) continue;
            for (let v = Math.max(0, lo); v < Math.min(hi, V); v++) hard[v * U + uu] = 1;
          }
        }
        // a tile with a connection to another row is never on the seam
        if (inside(a)) forbid[idx(a)] = 1;
        if (inside(b)) forbid[idx(b)] = 1;
      } else if (!large) {
        for (const [t, o] of [
          [a, b],
          [b, a],
        ]) {
          let l = along.get(t);
          if (!l) along.set(t, (l = []));
          l.push([ni, o, kind]);
        }
      }
    }
  });

  // normal pipe tiles: on the seam only where every pipe on it runs straight across
  const maxHop = Math.max(1, sol.jump);
  const pipeTile = new Uint8Array(U * V);
  for (const c of sol.occS.keys()) {
    if (!inside(c)) continue;
    const i = idx(c);
    pipeTile[i] = 1;
    if (forbid[i]) continue;
    const u = uOf(f, c);
    const byNet = new Map<number, number[]>();
    let ok = true;
    for (const [ni, o, kind] of along.get(c) ?? []) {
      if (kind !== EDGE_STEP && kind !== EDGE_HOP) ok = false;
      let l = byNet.get(ni);
      if (!l) byNet.set(ni, (l = []));
      l.push(uOf(f, o));
    }
    for (const [ni, us] of byNet) {
      if (!sol.netNodes[ni].has(c)) continue;
      const lo = us.filter((x) => x < u);
      const hi = us.filter((x) => x > u);
      if (us.length !== 2 || lo.length !== 1 || hi.length !== 1 || hi[0] - lo[0] - 1 > maxHop) {
        ok = false;
      }
    }
    // a pipe ending on the tile (no connection along the row) cannot lose it either
    sol.netNodes.forEach((nodes, ni) => {
      if (!P.nets[ni].large && nodes.has(c) && !byNet.has(ni)) ok = false;
    });
    if (!ok) forbid[i] = 1;
  }
  if (banned) for (const c of banned) if (inside(c)) forbid[idx(c)] = 1;

  // gain: empty tiles inside the hull, and pipe tiles (the pipe gets shorter)
  const usedXY = new Uint8Array(W * H);
  for (let v = 0; v < V; v++) {
    for (let u = 0; u < U; u++) {
      if (!g.used[v * U + u]) continue;
      const c = keyOf(f, u, v);
      usedXY[(ky(c) - y0) * W + kx(c) - x0] = 1;
    }
  }
  const hull = usedXY.slice();
  fillOrthoHull(hull, W, H);
  const cost = new Float64Array(U * V);
  for (let v = 0; v < V; v++) {
    for (let u = 0; u < U; u++) {
      const i = v * U + u;
      if (forbid[i]) {
        cost[i] = Infinity;
        continue;
      }
      const c = keyOf(f, u, v);
      const inHull = hull[(ky(c) - y0) * W + kx(c) - x0];
      cost[i] = pipeTile[i] ? -0.5 : inHull && !g.used[i] ? -1 : 0;
    }
  }

  // Dynamic programming row by row. Between rows v and v + 1 the seam steps from u = a to
  // u = b; the columns (min(a, b), max(a, b)] then move in one row and not in the other, so
  // each must be unjoined, or hold one normal pipe step that can take a jog.
  const best = new Float64Array(U);
  const next = new Float64Array(U);
  const from = new Int32Array(U * V);
  for (let u = 0; u < U; u++) best[u] = cost[u];
  const cR = new Float64Array(U); // crossing column x stepping right (a < b)
  const cL = new Float64Array(U); // stepping left (a > b)
  const R = new Float64Array(U);
  const L = new Float64Array(U);
  const argR = new Int32Array(U);
  const argL = new Int32Array(U);
  for (let v = 0; v + 1 < V; v++) {
    const row = v * U;
    for (let x = 0; x < U; x++) {
      const i = row + x;
      if (hard[i] || soft[i] > 1) {
        cR[x] = cL[x] = Infinity;
      } else if (soft[i] === 1) {
        // a < b: the upper end moves to x - 1; corner at (x - 1, v + 1) or (x + 1, v)
        cR[x] = free(g, x - 1, v + 1) || free(g, x + 1, v) ? JOG_COST : Infinity;
        // a > b: the lower end moves to x - 1; corner at (x + 1, v + 1) or (x - 1, v)
        cL[x] = free(g, x + 1, v + 1) || free(g, x - 1, v) ? JOG_COST : Infinity;
      } else {
        cR[x] = cL[x] = 0;
      }
    }
    R[0] = Infinity;
    for (let b = 1; b < U; b++) {
      if (best[b - 1] <= R[b - 1]) {
        R[b] = best[b - 1] + cR[b];
        argR[b] = b - 1;
      } else {
        R[b] = R[b - 1] + cR[b];
        argR[b] = argR[b - 1];
      }
    }
    L[U - 1] = Infinity;
    for (let b = U - 2; b >= 0; b--) {
      if (best[b + 1] <= L[b + 1]) {
        L[b] = best[b + 1] + cL[b + 1];
        argL[b] = b + 1;
      } else {
        L[b] = L[b + 1] + cL[b + 1];
        argL[b] = argL[b + 1];
      }
    }
    const nrow = (v + 1) * U;
    for (let b = 0; b < U; b++) {
      let m = best[b];
      let a = b;
      if (R[b] < m) {
        m = R[b];
        a = argR[b];
      }
      if (L[b] < m) {
        m = L[b];
        a = argL[b];
      }
      from[nrow + b] = a;
      next[b] = cost[nrow + b] + m;
    }
    best.set(next);
  }
  let end = 0;
  for (let u = 1; u < U; u++) if (best[u] < best[end]) end = u;
  if (!(best[end] < -0.75)) return null;
  const s = new Int32Array(V);
  s[V - 1] = end;
  for (let v = V - 1; v > 0; v--) s[v - 1] = from[v * U + s[v]];
  const seam: number[] = [];
  for (let v = 0; v < V; v++) seam.push(keyOf(f, s[v], v));
  return { sol: apply(sol, g, s), seam };
}

/** The layout with the seam taken out, or null when the result breaks a rule. */
function apply(sol: Solution, g: Grid, s: Int32Array): Solution | null {
  const { f } = g;
  const P = sol.problem;
  const shift = (c: number) => {
    const u = uOf(f, c);
    const v = vOf(f, c);
    const sv = v >= 0 && v < f.V ? s[v] : Infinity;
    return u > sv ? keyOf(f, u - 1, v) : c;
  };
  const onSeam = (c: number) => {
    const v = vOf(f, c);
    return v >= 0 && v < f.V && uOf(f, c) === s[v];
  };
  /** Original u of the tile that ends up at u in row v. */
  const origU = (u: number, v: number) => (u < s[v] ? u : u + 1);
  const taken = new Set<number>();
  const newNodes: Set<number>[] = [];
  const newEdges: number[][] = [];
  for (let ni = 0; ni < sol.netNodes.length; ni++) {
    const nodes = sol.netNodes[ni];
    const edges = sol.netEdges[ni];
    const large = P.nets[ni].large;
    const es: number[] = [];
    const kept = new Set<number>();
    for (const c of nodes) if (!onSeam(c)) kept.add(shift(c));
    const ends = new Map<number, number[]>(); // seam tile -> neighbours along the row
    for (let i = 0; i < edges.length; i += 3) {
      const a = edges[i];
      const b = edges[i + 1];
      const kind = edges[i + 2];
      const sa = onSeam(a);
      const sb = onSeam(b);
      if (sa || sb) {
        if (large || (sa && sb)) return null;
        const [t, o] = sa ? [a, b] : [b, a];
        let l = ends.get(t);
        if (!l) ends.set(t, (l = []));
        l.push(o);
        continue;
      }
      const va = vOf(f, a);
      const vb = vOf(f, b);
      const na = shift(a);
      const nb = shift(b);
      if (va === vb) {
        const ua = uOf(f, a);
        const ub = uOf(f, b);
        const sv = va >= 0 && va < f.V ? s[va] : Infinity;
        if ((ua < sv && ub > sv) || (ub < sv && ua > sv)) {
          // spans the seam without a node on it: one tile shorter
          if (kind === EDGE_CROSS || kind === EDGE_LCROSS) return null;
          const d = Math.abs(kx(na) - kx(nb)) + Math.abs(ky(na) - ky(nb));
          es.push(na, nb, d === 1 ? EDGE_STEP : kind);
          continue;
        }
        es.push(na, nb, kind);
        continue;
      }
      if (uOf(f, na) === uOf(f, nb)) {
        es.push(na, nb, kind);
        continue;
      }
      // a pipe step between rows whose ends moved apart: route it through a corner tile
      if (large || kind !== EDGE_STEP || Math.abs(va - vb) !== 1) return null;
      const [top, bot] = va < vb ? [na, nb] : [nb, na];
      const v = Math.min(va, vb);
      const ut = uOf(f, top);
      const ub = uOf(f, bot);
      if (Math.abs(ut - ub) !== 1) return null;
      let corner: number | null = null;
      for (const [cu, cv] of [
        [ut, v + 1],
        [ub, v],
      ]) {
        const ou = origU(cu, cv);
        const c = keyOf(f, cu, cv);
        if (free(g, ou, cv) && !taken.has(c)) {
          corner = c;
          break;
        }
      }
      if (corner === null) return null;
      taken.add(corner);
      kept.add(corner);
      es.push(top, corner, EDGE_STEP, corner, bot, EDGE_STEP);
    }
    for (const [, nb] of ends) {
      if (nb.length !== 2) return null;
      const na = shift(nb[0]);
      const nbb = shift(nb[1]);
      const d = Math.abs(kx(na) - kx(nbb)) + Math.abs(ky(na) - ky(nbb));
      es.push(na, nbb, d === 1 ? EDGE_STEP : EDGE_HOP);
    }
    newNodes.push(kept);
    newEdges.push(es);
  }
  const machines = sol.machines.map((m) => {
    const c = shift(key(m.x, m.y));
    return { ...m, x: kx(c), y: ky(c) };
  });
  const trial = new Solution(
    sol.problem,
    machines,
    newNodes,
    newEdges,
    sol.failed,
    sol.jump,
    sol.autoPieces,
  );
  if (sol.pinnedRegion) {
    const [px0, py0, px1, py1] = sol.pinnedRegion;
    const c = shift(key(px0, py0));
    const dx = kx(c) - px0;
    const dy = ky(c) - py0;
    trial.pinnedRegion = [px0 + dx, py0 + dy, px1 + dx, py1 + dy];
  }
  if (trial.validate(1).length) return null;
  trial.ok = sol.ok;
  trial.nOver = sol.nOver;
  return trial;
}

/** Seams that broke a rule before the carving along one axis gives up. */
const MAX_FAILS = 6;

/**
 * Carves seams along both axes until no seam lowers the layout cost or the deadline (ms)
 * passes. The input must be a valid layout.
 */
export function seamCompact(sol: Solution, log?: (m: string) => void, deadline?: number): Solution {
  if (sol.validate(1).length) return sol;
  let cur = sol;
  const removed = [0, 0];
  let outOfTime = false;
  for (let progress = true; progress && !outOfTime; ) {
    progress = false;
    for (const axis of [0, 1] as const) {
      const banned = new Set<number>();
      let fails = 0;
      for (;;) {
        if (deadline !== undefined && now() > deadline) {
          outOfTime = true;
          break;
        }
        const r = carveSeam(cur, axis, banned);
        if (!r) break;
        if (r.sol && r.sol.cost < cur.cost) {
          cur = r.sol;
          removed[axis]++;
          progress = true;
          banned.clear();
          fails = 0;
        } else {
          for (const c of r.seam) banned.add(c);
          if (++fails >= MAX_FAILS) break;
        }
      }
      if (outOfTime) break;
    }
  }
  log?.(
    `  seam carving: ${removed[0]} vertical + ${removed[1]} horizontal seams, empty tiles ${sol.hull.empty} -> ${cur.hull.empty}, pipe tiles ${sol.pipeTiles} -> ${cur.pipeTiles}${outOfTime ? ' (stopped: time budget)' : ''}`,
  );
  return cur;
}
