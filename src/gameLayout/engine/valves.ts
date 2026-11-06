/**
 * Place fluid / item valve controls (3x1) on routed junctions where even splitting would still
 * starve machines. A valve is three tiles in a straight line [A, M, E]: the pipe enters A from
 * the end, leaves E straight through and leaves the middle tile M out of its side. Only normal
 * pipes have valves.
 *
 *  1. if the routed pipe already runs straight through the junction (and the tiles are not
 *     shared with another pipe) the valve simply goes there;
 *  2. otherwise the junction is rebuilt locally: the valve is laid in line with the incoming
 *     pipe and the two branches are re-connected from its outlets with a short path search;
 *  3. if neither works the junction is reported (with the percentages) for manual placement.
 */
import type { Analysis, NetFlow, PlacedValve, UnplacedValve } from './flows';
import type { Problem } from './problem';
import { EDGE_STEP } from './router';
import { key, kx, ky, type Solution } from './solution';

const DIRS: [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

const add = (a: number, d: [number, number], k = 1) => key(kx(a) + d[0] * k, ky(a) + d[1] * k);

function adjOf(edges: number[]): Map<number, Set<number>> {
  const g = new Map<number, Set<number>>();
  for (let i = 0; i < edges.length; i += 3) {
    const a = edges[i];
    const b = edges[i + 1];
    if (!g.has(a)) g.set(a, new Set());
    if (!g.has(b)) g.set(b, new Set());
    g.get(a)!.add(b);
    g.get(b)!.add(a);
  }
  return g;
}

class ValvePlacer {
  p: Problem;
  sol: Solution;
  an: Analysis;
  radius = 14;
  maxPath = 40;
  reserved = new Set<number>();
  placed: PlacedValve[] = [];
  failed: UnplacedValve[] = [];

  constructor(p: Problem, sol: Solution, an: Analysis) {
    this.p = p;
    this.sol = sol;
    this.an = an;
  }

  occ(c: number): number {
    return (this.sol.occS.get(c) ?? 0) + (this.sol.occL.get(c) ?? 0) + (this.sol.occX.get(c) ?? 0);
  }

  free(c: number, ni: number): boolean {
    if (this.sol.blocked.has(c) || this.reserved.has(c)) return false;
    if (this.sol.occL.get(c) || this.sol.occX.get(c)) return false;
    const own = this.sol.netNodes[ni].has(c);
    return (this.sol.occS.get(c) ?? 0) - (own ? 1 : 0) < 2;
  }

  termNodes(nf: NetFlow): Set<number> {
    return new Set(nf.terms.map((t) => t.node).filter((n): n is number => n !== null));
  }

  straightOk(nf: NetFlow, A: number, M: number, E: number, d: [number, number]): boolean {
    const g = nf.adj;
    const tn = this.termNodes(nf);
    if ([A, M, E].some((c) => tn.has(c))) return false;
    if ([A, M, E].some((c) => this.occ(c) > 1 || this.reserved.has(c))) return false;
    const prev = add(A, d, -1);
    const nxt = add(E, d);
    const ga = g.get(A);
    const ge = g.get(E);
    return (
      !!ga &&
      !!ge &&
      ga.size === 2 &&
      ga.has(prev) &&
      ga.has(M) &&
      ge.size === 2 &&
      ge.has(M) &&
      ge.has(nxt) &&
      (g.get(M)?.size ?? 0) === 3 &&
      nf.flow(prev, A) > 0 &&
      nf.flow(E, nxt) > 0
    );
  }

  run(): [PlacedValve[], UnplacedValve[]] {
    for (const nf of this.an.nets) {
      if (!this.an.valveNets.has(nf.ni) || this.p.nets[nf.ni].large) continue;
      const todo = [...nf.junctions.entries()]
        .filter(([, j]) => j.kind === 'split' && !j.evenOk)
        .map(([n]) => n);
      for (const J of todo) this.place(nf.ni, J);
    }
    return [this.placed, this.failed];
  }

  place(ni: number, J: number): void {
    const nf = this.an.nets[ni];
    const j = nf.junctions.get(J)!;
    const totIn = j.ins.reduce((a, [, f]) => a + f, 0) || 1;
    const split = j.outs.map(([l, f]) => [l, (100 * f) / totIn] as [string, number]);
    const rec = { net: ni, label: this.p.nets[ni].label, node: J, split };
    const fail = (why: string) => this.failed.push({ ...rec, why });
    if (j.outs.length !== 2 || j.ins.length !== 1) {
      fail(
        `${j.ins.length} in / ${j.outs.length} out at the junction: a valve has 1 input and 2 outputs - chain two valves or move one branch`,
      );
      return;
    }
    const nbrs = [...(nf.adj.get(J) ?? [])];
    const inNb = nbrs.filter((v) => nf.flow(v, J) > 0);
    const outNb = nbrs.filter((v) => nf.flow(J, v) > 0);
    const termHere = nf.terms.some((t) => t.node === J);
    if (termHere || inNb.length !== 1 || outNb.length !== 2) {
      fail('a machine port attaches at the split tile - move the split one tile along the pipe');
      return;
    }
    const a = inNb[0];
    const d: [number, number] = [kx(J) - kx(a), ky(J) - ky(a)];
    if (Math.abs(d[0]) + Math.abs(d[1]) !== 1) {
      fail('the pipe reaches the split through a quantum hop or passthrough');
      return;
    }
    const E = add(J, d);
    if (this.straightOk(nf, a, J, E, d)) {
      const side = outNb.find((v) => v !== E)!;
      this.record(rec, [a, J, E], d, E, side, false);
      return;
    }
    const res = this.rebuild(ni, nf, J, a, d, outNb);
    if (!res) {
      fail('no room for a 3x1 valve in line with the incoming pipe - place it by hand');
      return;
    }
    this.record(rec, res[0], d, res[1], res[2], true);
  }

  record(
    rec: { net: number; label: string; node: number; split: [string, number][] },
    tiles: number[],
    dir: [number, number],
    straight: number,
    side: number,
    rebuilt: boolean,
  ): void {
    for (const t of tiles) this.reserved.add(t);
    this.placed.push({ ...rec, tiles, dir, straight, side, rebuilt });
  }

  rebuild(
    ni: number,
    nf: NetFlow,
    J: number,
    a: number,
    d: [number, number],
    outNb: number[],
  ): [number[], number, number] | null {
    const M = add(J, d);
    const E = add(J, d, 2);
    for (const c of [M, E]) {
      if (this.sol.blocked.has(c) || this.occ(c) > 0 || this.reserved.has(c)) return null;
    }
    if (this.occ(J) > 1) return null;
    const g = adjOf(this.sol.netEdges[ni]);
    const branches = outNb.map((b) => {
      const seen = new Set([b]);
      const st = [b];
      while (st.length) {
        const u = st.pop()!;
        for (const w of g.get(u) ?? []) {
          if (w !== J && !seen.has(w)) {
            seen.add(w);
            st.push(w);
          }
        }
      }
      return seen;
    });
    const S = add(E, d);
    const perp: [number, number][] = [
      [d[1], d[0]],
      [-d[1], -d[0]],
    ];
    let best: [number, number[], number[]] | null = null;
    for (const order of [
      [0, 1],
      [1, 0],
    ]) {
      for (const pd of perp) {
        const sideStart = add(M, pd);
        const p1 = this.path(ni, S, branches[order[0]], new Set([J, M, E]));
        if (!p1) continue;
        const p2 = this.path(ni, sideStart, branches[order[1]], new Set([J, M, E, ...p1]));
        if (!p2) continue;
        const cost = p1.length + p2.length;
        if (!best || cost < best[0]) best = [cost, p1, p2];
      }
    }
    if (!best) return null;
    const [, p1, p2] = best;
    const old = this.sol.netEdges[ni];
    const edges: number[] = [];
    for (let i = 0; i < old.length; i += 3) {
      const touchesJ = old[i] === J || old[i + 1] === J;
      if (!touchesJ || old[i] === a || old[i + 1] === a) edges.push(old[i], old[i + 1], old[i + 2]);
    }
    const push = (x: number, y: number) => edges.push(x, y, EDGE_STEP);
    push(J, M);
    push(M, E);
    push(E, p1[0]);
    for (let i = 0; i + 1 < p1.length; i++) push(p1[i], p1[i + 1]);
    push(M, p2[0]);
    for (let i = 0; i + 1 < p2.length; i++) push(p2[i], p2[i + 1]);
    const [nodes, pruned] = this.prune(nf, edges, new Set([J, M, E, ...p1, ...p2]));
    this.sol.netNodes[ni] = nodes;
    this.sol.netEdges[ni] = pruned;
    this.sol.refresh();
    return [[J, M, E], p1[0], p2[0]];
  }

  /** Shortest free path from start to any tile of `targets` (inclusive). */
  path(ni: number, start: number, targets: Set<number>, avoid: Set<number>): number[] | null {
    if (avoid.has(start) || (!this.free(start, ni) && !targets.has(start))) return null;
    if (targets.has(start)) return [start];
    const x0 = kx(start);
    const y0 = ky(start);
    const dist = new Map([[start, 0]]);
    const prev = new Map<number, number | null>([[start, null]]);
    const open: [number, number][] = [[0, start]];
    while (open.length) {
      // small searches: a sorted array is fine
      open.sort((p, q) => p[0] - q[0]);
      const [dcur, u] = open.shift()!;
      if (dcur > dist.get(u)!) continue;
      if (dcur > this.maxPath) break;
      for (const [dx, dy] of DIRS) {
        const v = key(kx(u) + dx, ky(u) + dy);
        if (
          Math.abs(kx(v) - x0) > this.radius ||
          Math.abs(ky(v) - y0) > this.radius ||
          avoid.has(v) ||
          dist.has(v)
        ) {
          continue;
        }
        if (targets.has(v)) {
          const out = [v, u];
          let c: number | null | undefined = prev.get(u);
          while (c !== null && c !== undefined) {
            out.push(c);
            c = prev.get(c);
          }
          return out.reverse();
        }
        if (!this.free(v, ni)) continue;
        const cost = dcur + 1 + (this.occ(v) ? 0.6 : 0);
        dist.set(v, cost);
        prev.set(v, u);
        open.push([cost, v]);
      }
    }
    return null;
  }

  /** Remove dangling pipe ends that no longer lead to a machine port. */
  prune(nf: NetFlow, edges: number[], keep: Set<number>): [Set<number>, number[]] {
    const tn = new Set([...this.termNodes(nf), ...keep]);
    const g = adjOf(edges);
    let changed = true;
    while (changed) {
      changed = false;
      for (const [n, s] of [...g]) {
        if (!tn.has(n) && s.size <= 1) {
          for (const m of s) g.get(m)!.delete(n);
          g.delete(n);
          changed = true;
        }
      }
    }
    const out: number[] = [];
    for (let i = 0; i < edges.length; i += 3) {
      if (g.has(edges[i]) && g.has(edges[i + 1])) out.push(edges[i], edges[i + 1], edges[i + 2]);
    }
    return [new Set(g.keys()), out];
  }
}

export function placeValves(
  problem: Problem,
  sol: Solution,
  analysis: Analysis,
): [PlacedValve[], UnplacedValve[]] {
  return new ValvePlacer(problem, sol, analysis).run();
}
