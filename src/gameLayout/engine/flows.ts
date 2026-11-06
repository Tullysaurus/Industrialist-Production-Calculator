/**
 * Flow on every routed pipe segment, junction types, and the even-split bottleneck check.
 *
 * Game rules modelled here
 *  - a split (1 in, 2 or 3 out) shares its inflow evenly between the open directions; a
 *    direction that is full (everything behind it is saturated) gets nothing and its share
 *    goes to the others
 *  - a machine only runs as fast as its scarcest input
 *  - normal pipes can be split with exact percentages by a valve control (3x1: in at one end,
 *    one outflow straight through, one out of the side of the middle tile); large pipes have
 *    no valve
 *
 * Planned flows come from the website's solver (each terminal carries its share); segment
 * directions follow them. The simulation replays the layout with even splitting and reports
 * which machine groups fall short of the plan and which junctions need a valve.
 */
import type { Problem, Terminal } from './problem';
import { key, kx, ky, type SolMachine, type Solution } from './solution';

const EPS = 1e-9;
/** Shortfalls below 1 % of an input are absorbed by its buffer. */
const BUFFER_TOLERANCE = 0.01;

export interface TermInfo {
  t: Terminal;
  node: number | null;
  portCells: number[];
  machine: SolMachine | null;
}

export interface JunctionValve {
  ok: boolean;
  why: string;
  tiles: number[];
  straightPct?: number;
  sidePct?: number;
  split: [string, number][];
  rebuilt?: boolean;
}

export interface Junction {
  node: number;
  kind: 'split' | 'merge' | 'mix' | 'pass' | 'end';
  ins: [string, number][];
  outs: [string, number][];
  evenOk: boolean;
  valve: JunctionValve | null;
}

export interface PlacedValve {
  net: number;
  label: string;
  node: number;
  split: [string, number][];
  tiles: number[];
  dir: [number, number];
  straight: number;
  side: number;
  rebuilt: boolean;
  /** Share set on the valve (0..100); undefined = the ideal planned share. */
  sidePct?: number;
}

export interface UnplacedValve {
  net: number;
  label: string;
  node: number;
  split: [string, number][];
  why: string;
}

const ek = (a: number, b: number) => `${a}>${b}`;

export class NetFlow {
  ni: number;
  adj: Map<number, Set<number>>;
  terms: TermInfo[];
  edgeFlow = new Map<string, number>();
  simFlow = new Map<string, number>();
  valveFlow = new Map<string, number>();
  junctions = new Map<number, Junction>();
  balancedNote = '';
  cyclic: boolean;
  radj = new Map<number, Set<number>>();
  rflow = new Map<string, [number, number, number]>();
  chains = new Map<string, number[]>();

  constructor(ni: number, adj: Map<number, Set<number>>, terms: TermInfo[], cyclic: boolean) {
    this.ni = ni;
    this.adj = adj;
    this.terms = terms;
    this.cyclic = cyclic;
  }

  flow(a: number, b: number): number {
    return this.edgeFlow.get(ek(a, b)) ?? 0;
  }
}

function graph(nodes: Set<number>, edges: number[]): Map<number, Set<number>> {
  const adj = new Map<number, Set<number>>();
  for (const n of nodes) adj.set(n, new Set());
  for (let i = 0; i < edges.length; i += 3) {
    const a = edges[i];
    const b = edges[i + 1];
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a)!.add(b);
    adj.get(b)!.add(a);
  }
  return adj;
}

/** Drop edges that close cycles (BFS tree). */
function spanning(adj: Map<number, Set<number>>): [Map<number, Set<number>>, boolean] {
  const tree = new Map<number, Set<number>>();
  const seen = new Set<number>();
  let cyc = false;
  const starts = [...adj.keys()].sort((a, b) => a - b);
  for (const start of starts) {
    if (seen.has(start)) continue;
    seen.add(start);
    if (!tree.has(start)) tree.set(start, new Set());
    const q = [start];
    for (let h = 0; h < q.length; h++) {
      const u = q[h];
      for (const v of [...adj.get(u)!].sort((a, b) => a - b)) {
        if (!seen.has(v)) {
          seen.add(v);
          if (!tree.has(v)) tree.set(v, new Set());
          tree.get(u)!.add(v);
          tree.get(v)!.add(u);
          q.push(v);
        } else if (!tree.get(u)!.has(v)) {
          cyc = true;
        }
      }
    }
  }
  return [tree, cyc];
}

/** Split `total` evenly over the directions; full ones (cap reached) drop out. */
export function waterFill(total: number, caps: number[], base: number[]): number[] {
  const amounts = [...base];
  const room = caps.map((c) => Math.max(0, c));
  let open = room.map((_r, i) => i).filter((i) => room[i] > EPS);
  let rest = total;
  while (rest > EPS && open.length) {
    const share = rest / open.length;
    const tight = open.filter((i) => room[i] <= share + EPS);
    if (!tight.length) {
      for (const i of open) {
        amounts[i] += share;
        room[i] -= share;
      }
      break;
    }
    for (const i of tight) {
      amounts[i] += room[i];
      rest -= room[i];
      room[i] = 0;
    }
    open = open.filter((i) => room[i] > EPS);
  }
  return amounts;
}

export const tileLabel = (n: number) => `pipe (${kx(n)}, ${ky(n)})`;

export class Analysis {
  problem: Problem;
  sol: Solution;
  instM: Map<number, SolMachine>;
  nets: NetFlow[];
  plannedRun: number[];
  runEven: number[] | null = null;
  runValve: number[] | null = null;
  valveNets = new Set<number>();
  valveNodes = new Map<number, Set<number>>();
  /** Per net: valve middle tile -> straight tile and the share set on the valve. */
  valveSettings = new Map<number, Map<number, { straight: number; sidePct?: number }>>();
  placed: PlacedValve[] = [];
  unplaced: UnplacedValve[] = [];
  groups: [number, number, number, number][] = [];

  constructor(problem: Problem, sol: Solution) {
    this.problem = problem;
    this.sol = sol;
    this.instM = new Map(sol.machines.map((m) => [m.inst, m]));
    this.nets = problem.nets.map((net, ni) => this.buildNet(ni, net.large));
    this.plannedRun = problem.instances.map(([ni]) => {
      const node = problem.nodes[ni];
      return node.count ? node.effectiveCount / node.count : 0;
    });
  }

  private buildNet(ni: number, large: boolean): NetFlow {
    const nodes = this.sol.netNodes[ni];
    const [adj, cyc] = spanning(graph(nodes, this.sol.netEdges[ni]));
    const terms: TermInfo[] = this.problem.nets[ni].terminals.map((t) => {
      const m = this.instM.get(t.inst) ?? null;
      let at: number | null = null;
      let cells: number[] = [];
      if (m) {
        for (const pid of t.ports) {
          const acc = this.sol.access(m, pid, large).filter((a) => nodes.has(a));
          if (acc.length) {
            at = Math.min(...acc);
            const p = m.shape.ports.get(pid)!;
            cells = p.cells.map(([x, y]) => key(m.x + x, m.y + y));
            break;
          }
        }
      }
      return { t, node: at, portCells: cells, machine: m };
    });
    const nf = new NetFlow(ni, adj, terms, cyc);
    this.planned(nf);
    this.reduce(nf);
    return nf;
  }

  private reduce(nf: NetFlow): void {
    const adj = nf.adj;
    const keyNodes = new Set<number>();
    for (const [n, s] of adj) if (s.size !== 2) keyNodes.add(n);
    for (const ti of nf.terms) if (ti.node !== null) keyNodes.add(ti.node);
    if (!keyNodes.size && adj.size) keyNodes.add(adj.keys().next().value as number);
    for (const k of keyNodes) {
      if (!nf.radj.has(k)) nf.radj.set(k, new Set());
      for (const nb of adj.get(k) ?? []) {
        const path = [k];
        let prev = k;
        let cur = nb;
        let guard = 0;
        while (!keyNodes.has(cur) && guard++ < 1e6) {
          path.push(cur);
          let nxt: number | undefined;
          for (const w of adj.get(cur)!) if (w !== prev) nxt = w;
          if (nxt === undefined) break;
          prev = cur;
          cur = nxt;
        }
        path.push(cur);
        const end = path[path.length - 1];
        if (end === k || nf.chains.has(ek(k, end))) continue;
        nf.chains.set(ek(k, end), path);
        nf.chains.set(ek(end, k), [...path].reverse());
        if (!nf.radj.has(end)) nf.radj.set(end, new Set());
        nf.radj.get(k)!.add(end);
        nf.radj.get(end)!.add(k);
        const f1 = nf.flow(path[0], path[1]);
        const f2 = nf.flow(path[1], path[0]);
        if (f1 > EPS) nf.rflow.set(ek(k, end), [k, end, f1]);
        else if (f2 > EPS) nf.rflow.set(ek(end, k), [end, k, f2]);
      }
    }
  }

  /** Reduced-edge flows -> per tile-edge flows. */
  private expand(nf: NetFlow, rflows: Map<string, number>): Map<string, number> {
    const out = new Map<string, number>();
    for (const [k, f] of rflows) {
      const path = nf.chains.get(k);
      if (!path) continue;
      for (let i = 0; i + 1 < path.length; i++) out.set(ek(path[i], path[i + 1]), f);
    }
    return out;
  }

  private inject(nf: NetFlow, supply: number[], demand: number[]) {
    const loc = new Map<number, [[number, number][], [number, number][]]>();
    nf.terms.forEach((ti, k) => {
      if (ti.node === null) return;
      if (!loc.has(ti.node)) loc.set(ti.node, [[], []]);
      const e = loc.get(ti.node)!;
      if (ti.t.direction === 'output') e[0].push([k, supply[k]]);
      else e[1].push([k, demand[k]]);
    });
    return loc;
  }

  private tlabel(ti: TermInfo): string {
    const [ni, li] = this.problem.instances[ti.t.inst];
    return `${this.problem.nodes[ni].shape.name} #${li + 1}`;
  }

  /** Tree-cut flows from the planned terminal rates (supply and demand balanced first). */
  private planned(nf: NetFlow): void {
    let sup = nf.terms.map((ti) => (ti.t.direction === 'output' ? (ti.t.rate ?? 0) : 0));
    let dem = nf.terms.map((ti) => (ti.t.direction === 'input' ? (ti.t.rate ?? 0) : 0));
    const S = sup.reduce((a, b) => a + b, 0);
    const D = dem.reduce((a, b) => a + b, 0);
    if (S > D + EPS) {
      if (S > 0) sup = sup.map((v) => (v * D) / S);
      nf.balancedNote = `supply ${S.toFixed(2)}/s > demand ${D.toFixed(2)}/s: the excess backs up in the pipe`;
    } else if (D > S + EPS) {
      if (D > 0) dem = dem.map((v) => (v * S) / D);
      nf.balancedNote = `demand ${D.toFixed(2)}/s > supply ${S.toFixed(2)}/s: shortage`;
    }
    const loc = this.inject(nf, sup, dem);
    const b = new Map<number, number>();
    for (const [n, [srcs, snks]] of loc) {
      b.set(n, srcs.reduce((a, [, v]) => a + v, 0) - snks.reduce((a, [, v]) => a + v, 0));
    }
    const flows = new Map<string, number>();
    const visited = new Set<number>();
    for (const root of nf.adj.keys()) {
      if (visited.has(root)) continue;
      const order: number[] = [];
      const parent = new Map<number, number | null>([[root, null]]);
      const st = [root];
      visited.add(root);
      while (st.length) {
        const u = st.pop()!;
        order.push(u);
        for (const v of nf.adj.get(u)!) {
          if (!parent.has(v)) {
            parent.set(v, u);
            visited.add(v);
            st.push(v);
          }
        }
      }
      const sub = new Map<number, number>();
      for (let i = order.length - 1; i >= 0; i--) {
        const u = order[i];
        const su = (sub.get(u) ?? 0) + (b.get(u) ?? 0);
        sub.set(u, su);
        const p = parent.get(u);
        if (p !== null && p !== undefined) {
          sub.set(p, (sub.get(p) ?? 0) + su);
          if (su >= 0) flows.set(ek(u, p), su);
          else flows.set(ek(p, u), -su);
        }
      }
    }
    nf.edgeFlow = flows;
    for (const n of nf.adj.keys()) {
      const [srcs, snks] = loc.get(n) ?? [[], []];
      const ins: [string, number][] = [];
      const outs: [string, number][] = [];
      for (const v of nf.adj.get(n)!) {
        const fi = flows.get(ek(v, n)) ?? 0;
        const fo = flows.get(ek(n, v)) ?? 0;
        if (fi > EPS) ins.push([tileLabel(v), fi]);
        if (fo > EPS) outs.push([tileLabel(v), fo]);
      }
      for (const [k, a] of srcs) if (a > EPS) ins.push([this.tlabel(nf.terms[k]), a]);
      for (const [k, a] of snks) if (a > EPS) outs.push([this.tlabel(nf.terms[k]), a]);
      let kind: Junction['kind'];
      if (ins.length + outs.length <= 1) kind = 'end';
      else if (ins.length === 1 && outs.length === 1) kind = 'pass';
      else if (ins.length === 1) kind = 'split';
      else if (outs.length === 1) kind = 'merge';
      else kind = 'mix';
      nf.junctions.set(n, { node: n, kind, ins, outs, evenOk: true, valve: null });
    }
  }

  // ---------------------------------------------------------------- even split simulation

  private simulateNet(
    nf: NetFlow,
    supply: number[],
    cap: number[],
    valves: boolean,
  ): [number[], Map<string, number>] {
    const loc = this.inject(nf, supply, cap);
    const nodeCap = new Map<number, number>();
    for (const [n, [, snks]] of loc)
      nodeCap.set(
        n,
        snks.reduce((a, [, c]) => a + c, 0),
      );
    const indeg = new Map<number, number>();
    const outE = new Map<number, number[]>();
    const inE = new Map<number, number[]>();
    for (const [u, v] of nf.rflow.values()) {
      indeg.set(v, (indeg.get(v) ?? 0) + 1);
      if (!outE.has(u)) outE.set(u, []);
      outE.get(u)!.push(v);
      if (!inE.has(v)) inE.set(v, []);
      inE.get(v)!.push(u);
    }
    const order: number[] = [];
    const deg = new Map(indeg);
    const q = [...nf.radj.keys()].filter((n) => !indeg.get(n));
    for (let h = 0; h < q.length; h++) {
      const u = q[h];
      order.push(u);
      for (const v of outE.get(u) ?? []) {
        deg.set(v, deg.get(v)! - 1);
        if (deg.get(v) === 0) q.push(v);
      }
    }
    const down = new Map<number, number>();
    for (let i = order.length - 1; i >= 0; i--) {
      const u = order[i];
      let s = nodeCap.get(u) ?? 0;
      for (const v of outE.get(u) ?? []) s += down.get(v) ?? 0;
      down.set(u, s);
    }
    const accept = new Map<string, number>();
    for (const [u, v] of nf.rflow.values()) accept.set(ek(u, v), down.get(v) ?? 0);
    const vnodes = valves ? (this.valveNodes.get(nf.ni) ?? new Set<number>()) : new Set<number>();
    let flow = new Map<string, number>();
    let delivered = new Array<number>(nf.terms.length).fill(0);
    for (let round = 0; round < 30; round++) {
      const inflow = new Map<number, number>();
      flow = new Map();
      delivered = new Array<number>(nf.terms.length).fill(0);
      for (const u of order) {
        const [srcs, snks] = loc.get(u) ?? [[], []];
        const total = (inflow.get(u) ?? 0) + srcs.reduce((a, [, v]) => a + v, 0);
        const dirs: { t: boolean; id: number; cap: number }[] = [
          ...snks.map(([k, c]) => ({ t: true, id: k, cap: c })),
          ...(outE.get(u) ?? []).map((v) => ({ t: false, id: v, cap: accept.get(ek(u, v))! })),
        ];
        if (!dirs.length) continue;
        let amounts: number[];
        if (vnodes.has(u) && dirs.length >= 2) {
          // valve: split in planned proportions (or as set on the valve); what a full branch
          // cannot take goes on
          const setting = valves ? this.valveSettings.get(nf.ni)?.get(u) : undefined;
          const straightOf = (v: number) => nf.chains.get(ek(u, v))?.[1] === setting?.straight;
          const nSide = dirs.filter((d) => d.t || !straightOf(d.id)).length || 1;
          const want = dirs.map((d) => {
            if (setting?.sidePct !== undefined) {
              const p = Math.min(100, Math.max(0, setting.sidePct)) / 100;
              return !d.t && straightOf(d.id) ? 1 - p : p / nSide;
            }
            return d.t ? (nf.terms[d.id].t.rate ?? 0) : (nf.rflow.get(ek(u, d.id))?.[2] ?? 0);
          });
          const tw = want.reduce((a, b) => a + b, 0) || 1;
          amounts = dirs.map((d, i) => Math.min(d.cap, (total * want[i]) / tw));
          const rest = total - amounts.reduce((a, b) => a + b, 0);
          if (rest > EPS)
            amounts = waterFill(
              rest,
              dirs.map((d, i) => d.cap - amounts[i]),
              amounts,
            );
        } else {
          amounts = waterFill(
            total,
            dirs.map((d) => d.cap),
            dirs.map(() => 0),
          );
        }
        dirs.forEach((d, i) => {
          if (d.t) delivered[d.id] += amounts[i];
          else {
            flow.set(ek(u, d.id), amounts[i]);
            inflow.set(d.id, (inflow.get(d.id) ?? 0) + amounts[i]);
          }
        });
      }
      // a node that cannot pass on everything it receives backs up its feeders
      let changed = false;
      for (const v of order) {
        const [srcs, snks] = loc.get(v) ?? [[], []];
        const inV = inflow.get(v) ?? 0;
        const got = inV + srcs.reduce((a, [, x]) => a + x, 0);
        let passed = 0;
        for (const w of outE.get(v) ?? []) passed += flow.get(ek(v, w)) ?? 0;
        for (const [k] of snks) passed += delivered[k];
        if (got > passed + 1e-9 * Math.max(1, got) && inV > EPS) {
          const keep = passed / got;
          for (const u of inE.get(v) ?? []) {
            const nv = (flow.get(ek(u, v)) ?? 0) * keep;
            const a = accept.get(ek(u, v))!;
            if (nv < a - 1e-9 * Math.max(1, a)) {
              accept.set(ek(u, v), nv);
              changed = true;
            }
          }
        }
      }
      if (!changed) break;
    }
    return [delivered, flow];
  }

  /** Steady state of the whole layout: machine run fractions (1 = 100 %). */
  simulate(valves: boolean, iters = 80): [number[], Map<number, Map<string, number>>] {
    const P = this.problem;
    const n = P.instances.length;
    const hasIn: [number, number][][] = Array.from({ length: n }, () => []);
    for (const nf of this.nets) {
      nf.terms.forEach((ti, k) => {
        if (ti.t.direction === 'input') hasIn[ti.t.inst].push([nf.ni, k]);
      });
    }
    let run = [...this.plannedRun];
    let frac = new Map<string, number>();
    const fk = (g: number, ni: number, k: number) => `${g}|${ni}|${k}`;
    const flows = new Map<number, Map<string, number>>();
    const others = (g: number, ni: number, k: number) => {
      let v = 1;
      for (const [n2, k2] of hasIn[g]) {
        if (n2 === ni && k2 === k) continue;
        v = Math.min(v, frac.get(fk(g, n2, k2)) ?? 1);
      }
      return v;
    };
    for (let it = 0; it < iters; it++) {
      const newFrac = new Map<string, number>();
      for (const nf of this.nets) {
        const sup: number[] = [];
        const cap: number[] = [];
        nf.terms.forEach((ti, k) => {
          const g = ti.t.inst;
          const full = (ti.t.rate ?? 0) / Math.max(this.plannedRun[g], EPS);
          if (ti.t.direction === 'output') {
            sup.push(full * run[g]);
            cap.push(0);
          } else {
            sup.push(0);
            cap.push(full * others(g, nf.ni, k));
          }
        });
        const [deliv, fl] = this.simulateNet(nf, sup, cap, valves);
        flows.set(nf.ni, fl);
        nf.terms.forEach((ti, k) => {
          if (ti.t.direction !== 'input') return;
          const full = (ti.t.rate ?? 0) / Math.max(this.plannedRun[ti.t.inst], EPS);
          const f = full > EPS ? Math.min(1, deliv[k] / full) : 1;
          newFrac.set(fk(ti.t.inst, nf.ni, k), f >= 1 - BUFFER_TOLERANCE ? 1 : f);
        });
      }
      frac = newFrac;
      const next = run.map((_r, g) => {
        let v = hasIn[g].length ? 1 : this.plannedRun[g];
        for (const [ni, k] of hasIn[g]) v = Math.min(v, frac.get(fk(g, ni, k)) ?? 1);
        return v;
      });
      let delta = 0;
      for (let g = 0; g < n; g++) delta = Math.max(delta, Math.abs(next[g] - run[g]));
      run = next;
      if (delta < 1e-7) break;
    }
    return [run, flows];
  }

  groupThroughput(run: number[]): [number, number, number][] {
    const P = this.problem;
    const actual = new Array<number>(P.nodes.length).fill(0);
    P.instances.forEach(([ni], g) => (actual[ni] += run[g]));
    return P.nodes.map((node, ni) => [ni, node.effectiveCount, actual[ni]]);
  }

  loss(run: number[]): number {
    let s = 0;
    for (const [, plan, act] of this.groupThroughput(run))
      s += Math.max(0, plan - act) / Math.max(plan, EPS);
    return s;
  }

  private hypothetical(nets: Set<number>): Map<number, Set<number>> {
    const out = new Map<number, Set<number>>();
    for (const ni of nets) {
      const s = new Set<number>();
      for (const [n, j] of this.nets[ni].junctions)
        if (j.kind === 'split' || j.kind === 'mix') s.add(n);
      out.set(ni, s);
    }
    return out;
  }

  /** placed: valves already in the layout; needed: nets known to need them. */
  analyse(placed?: PlacedValve[], needed?: Set<number>, unplaced: UnplacedValve[] = []): this {
    const [run, flows] = this.simulate(false);
    this.runEven = run;
    for (const nf of this.nets) nf.simFlow = this.expandFlows(nf, flows.get(nf.ni));
    if (needed) {
      this.valveNets = new Set(needed);
    } else {
      const base = this.loss(run);
      const cand = this.nets
        .filter(
          (nf) =>
            !this.problem.nets[nf.ni].large &&
            [...nf.junctions.values()].some((j) => j.kind === 'split' || j.kind === 'mix'),
        )
        .map((nf) => nf.ni);
      this.valveNets = new Set();
      if (base > 1e-3 && cand.length) {
        this.valveNets = new Set(cand);
        this.valveNodes = this.hypothetical(this.valveNets);
        let best = this.loss(this.simulate(true)[0]);
        // keep valves only on nets where they help
        for (const ni of [...cand].sort(
          (a, b) => this.nets[a].terms.length - this.nets[b].terms.length,
        )) {
          this.valveNets.delete(ni);
          this.valveNodes = this.hypothetical(this.valveNets);
          const l2 = this.loss(this.simulate(true)[0]);
          if (l2 > best + 1e-4) this.valveNets.add(ni);
          else best = Math.min(best, l2);
        }
      }
    }
    if (!placed) {
      this.valveNodes = this.hypothetical(this.valveNets);
    } else {
      this.placed = placed;
      this.unplaced = unplaced;
      this.valveNodes = new Map();
      this.valveSettings = new Map();
      for (const v of placed) {
        if (!this.valveNodes.has(v.net)) this.valveNodes.set(v.net, new Set());
        this.valveNodes.get(v.net)!.add(v.tiles[1]);
        if (!this.valveSettings.has(v.net)) this.valveSettings.set(v.net, new Map());
        this.valveSettings
          .get(v.net)!
          .set(v.tiles[1], { straight: v.straight, sidePct: v.sidePct });
      }
    }
    const [runV, flowsV] = this.simulate(true);
    this.runValve = runV;
    for (const nf of this.nets) {
      nf.valveFlow = this.expandFlows(nf, flowsV.get(nf.ni));
      this.junctionChecks(nf);
    }
    const even = this.groupThroughput(run);
    const withV = this.groupThroughput(runV);
    this.groups = even.map(([ni, plan, act], i) => [ni, plan, act, withV[i][2]]);
    return this;
  }

  private expandFlows(nf: NetFlow, fl: Map<string, number> | undefined): Map<string, number> {
    return fl ? this.expand(nf, fl) : new Map();
  }

  private junctionChecks(nf: NetFlow): void {
    const placed = new Map(this.placed.filter((v) => v.net === nf.ni).map((v) => [v.tiles[1], v]));
    const unplaced = new Map(this.unplaced.filter((v) => v.net === nf.ni).map((v) => [v.node, v]));
    for (const [n, j] of nf.junctions) {
      if (j.kind !== 'split' && j.kind !== 'mix') continue;
      const outs = j.outs.map(([, f]) => f);
      const tot = outs.reduce((a, b) => a + b, 0);
      j.evenOk = tot <= EPS || Math.max(...outs) - Math.min(...outs) <= Math.max(1e-6, tot * 0.01);
      const totIn = j.ins.reduce((a, [, f]) => a + f, 0) || 1;
      const pv = placed.get(n);
      const uv = unplaced.get(n);
      if (pv) {
        const st = nf.flow(n, pv.straight);
        j.valve = {
          ok: true,
          tiles: pv.tiles,
          rebuilt: pv.rebuilt,
          straightPct: (100 * st) / totIn,
          sidePct: 100 * (1 - st / totIn),
          split: j.outs.map(([l, f]) => [l, (100 * f) / totIn]),
          why: '',
        };
      } else if (uv) {
        j.valve = { ok: false, tiles: [], why: uv.why, split: uv.split };
      } else if (this.valveNets.has(nf.ni) && !j.evenOk && !this.placed.length) {
        j.valve = this.proposeValve(nf, n, j);
      }
    }
  }

  private proposeValve(nf: NetFlow, n: number, j: Junction): JunctionValve {
    const totIn = j.ins.reduce((a, [, f]) => a + f, 0) || 1;
    const info: JunctionValve = {
      ok: false,
      why: '',
      tiles: [],
      split: j.outs.map(([l, f]) => [l, (100 * f) / totIn]),
    };
    if (this.problem.nets[nf.ni].large) {
      info.why = 'large pipes have no valve - give these consumers their own pipe';
      return info;
    }
    if (j.outs.length > 2 || j.ins.length > 1) {
      info.why = `${j.ins.length} in / ${j.outs.length} out: a valve has 1 input and 2 outputs - chain two valves or move one branch`;
      return info;
    }
    const nbrs = [...nf.adj.get(n)!];
    const inNb = nbrs.filter((v) => nf.flow(v, n) > EPS);
    const outNb = nbrs.filter((v) => nf.flow(n, v) > EPS);
    if (inNb.length === 1) {
      const a = inNb[0];
      const straight = key(2 * kx(n) - kx(a), 2 * ky(n) - ky(a));
      if (Math.abs(kx(a) - kx(n)) + Math.abs(ky(a) - ky(n)) !== 1) {
        info.why = 'inflow arrives through a quantum hop - needs a straight 3-tile run';
        return info;
      }
      if (outNb.includes(straight)) {
        const tiles = [a, n, straight];
        const occ = (c: number) => (this.sol.occS.get(c) ?? 0) + (this.sol.occL.get(c) ?? 0);
        if (Math.max(...tiles.map(occ)) > 1) {
          info.why = 'another pipe shares the valve tiles - re-route that pipe';
          return info;
        }
        info.tiles = tiles;
        info.ok = true;
        info.straightPct = (100 * nf.flow(n, straight)) / totIn;
        info.sidePct = 100 - info.straightPct;
        return info;
      }
    }
    info.why =
      'inflow does not run straight through the junction - re-route so it enters at one end';
    return info;
  }

  /** Flow passing through a graph node (max of in / out). */
  nodeFlow(nf: NetFlow, n: number, which: 'planned' | 'even' | 'valve'): number {
    const fl = which === 'planned' ? nf.edgeFlow : which === 'even' ? nf.simFlow : nf.valveFlow;
    let fin = 0;
    let fout = 0;
    for (const v of nf.adj.get(n) ?? []) {
      fin += fl.get(ek(v, n)) ?? 0;
      fout += fl.get(ek(n, v)) ?? 0;
    }
    const j = nf.junctions.get(n);
    if (which === 'planned' && j) {
      fin = Math.max(
        fin,
        j.ins.reduce((a, [, f]) => a + f, 0),
      );
      fout = Math.max(
        fout,
        j.outs.reduce((a, [, f]) => a + f, 0),
      );
    }
    return Math.max(fin, fout);
  }
}

export { ek as edgeKey };
