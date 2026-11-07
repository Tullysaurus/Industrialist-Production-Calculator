/**
 * Power distribution: HV / MV poles, HV transformers and the external HV grid connection.
 *
 * Game rules (as given; node positions on the poles are not in the game data, so every
 * connection keeps a safety margin):
 *  - HV pole: 12x12, 8 nodes of 120 MMF/s each, reaches machines / poles up to 70 tiles away
 *    (66 with the 4 tile margin).
 *  - MV pole (HMVT): 2x1, 4 nodes of 1.5 MMF/s each, reaches up to 22 tiles (20 with the 2 tile margin).
 *  - A node feeds any number of cables as long as their total stays within its rating; a
 *    cable to a downstream pole carries that pole's whole load and counts on the node it
 *    hangs from.
 *  - HV transformer: 8x8, HV side fed from an HV pole, MV side feeds MV poles; 15 % of the
 *    power is lost (no coolant piped).
 *  - The layout is fed from one external HV grid connection with unlimited power.
 *  - Every machine with a power connection must be connected to a pole of its voltage with
 *    enough capacity on the way.
 *
 * Distances are straight lines between the machine's power port and the pole centre (or
 * between pole centres / transformer ports).
 */
import type { PowerPort } from './geometry';
import type { Problem } from './problem';
import { key, kx, ky, type Solution, type SolMachine } from './solution';

export type Voltage = 'HV' | 'MV';
export type PowerKind = 'hv' | 'mv' | 'transformer' | 'grid';

export const POLE = {
  HV: { w: 12, h: 12, nodes: 8, rating: 120e6, range: 70, margin: 4 },
  MV: { w: 2, h: 1, nodes: 4, rating: 1.5e6, range: 22, margin: 2 },
} as const;

export const TRANSFORMER = {
  size: 8,
  /** Local power port centres (rotation 0), from the game data. */
  mv: [3.5, 0.5] as const,
  hv: [3.5, 6.5] as const,
  maxInput: 240e6,
  loss: 0.15,
};

/** Size of the grid connection marker. */
export const GRID_SIZE = 2;

/** Usable reach of a connection of this voltage (range minus margin). */
export const reach = (v: Voltage) => POLE[v].range - POLE[v].margin;

export interface PowerPiece {
  id: string;
  kind: PowerKind;
  x: number;
  y: number;
  rot: number;
  /** Id of the piece this one takes its power from (kept when it is still in reach). */
  feed?: string;
}

export function pieceSize(kind: PowerKind, r: number): [number, number] {
  switch (kind) {
    case 'hv':
      return [POLE.HV.w, POLE.HV.h];
    case 'mv':
      return r % 2 ? [POLE.MV.h, POLE.MV.w] : [POLE.MV.w, POLE.MV.h];
    case 'transformer':
      return [TRANSFORMER.size, TRANSFORMER.size];
    default:
      return [GRID_SIZE, GRID_SIZE];
  }
}

export function pieceCentre(p: PowerPiece): [number, number] {
  const [w, h] = pieceSize(p.kind, p.rot);
  return [p.x + w / 2, p.y + h / 2];
}

/** Tiles a power piece covers. */
export function pieceTiles(p: PowerPiece): [number, number][] {
  const [w, h] = pieceSize(p.kind, p.rot);
  const out: [number, number][] = [];
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) out.push([p.x + i, p.y + j]);
  return out;
}

/** Absolute HV / MV port positions of a transformer. */
export function transformerPorts(p: PowerPiece): { hv: [number, number]; mv: [number, number] } {
  const n = TRANSFORMER.size;
  const turn = ([x, y]: readonly [number, number]): [number, number] => {
    let px = x;
    let py = y;
    for (let k = 0; k < ((p.rot % 4) + 4) % 4; k++) [px, py] = [n - py, px];
    return [p.x + px, p.y + py];
  };
  return { hv: turn(TRANSFORMER.hv), mv: turn(TRANSFORMER.mv) };
}

const dist = (a: readonly [number, number], b: readonly [number, number]) =>
  Math.hypot(a[0] - b[0], a[1] - b[1]);

// ------------------------------------------------------------------ consumers

export interface Consumer {
  inst: number;
  /** `${inst}|${n}`: the machine's n-th power connection (stable across moves). */
  key: string;
  /** Absolute port position. */
  at: [number, number];
  type: Voltage;
  /** MF/s this connection draws (0 for generators and machines without power use). */
  load: number;
  /** No power port in the game data: connected at the machine's centre. */
  assumed: boolean;
}

/** Power connections every placed machine needs. */
export function powerConsumers(problem: Problem, machines: SolMachine[]): Consumer[] {
  const out: Consumer[] = [];
  for (const m of machines) {
    const node = problem.nodes[m.node];
    if (node.synthetic) continue;
    const use = Math.max(0, node.powerUse ?? 0);
    const want: Voltage | null =
      node.powerType === 'HV' || node.powerType === 'MV' ? node.powerType : null;
    const ports = m.shape.power ?? [];
    let picked: PowerPort[];
    if (!ports.length) {
      // no connection in the game data: only machines that draw power need one
      if (!(use > 0) || !want) continue;
      out.push({
        inst: m.inst,
        key: `${m.inst}|0`,
        at: [m.x + m.shape.w / 2, m.y + m.shape.h / 2],
        type: want,
        load: use,
        assumed: true,
      });
      continue;
    }
    if (m.shape.id.startsWith('tree_farm') || m.shape.id.startsWith('modular_turbine')) {
      picked = ports; // every part of a composite has its own connection
    } else {
      picked = [ports.find((p) => p.type === want) ?? ports[0]];
    }
    const drawing = picked.filter((p) => p.direction !== 'output');
    const share = drawing.length ? use / drawing.length : 0;
    picked.forEach((p, k) => {
      out.push({
        inst: m.inst,
        key: `${m.inst}|${k}`,
        at: [m.x + p.x, m.y + p.y],
        type: p.type,
        load: p.direction === 'output' ? 0 : share,
        assumed: false,
      });
    });
  }
  return out;
}

// ------------------------------------------------------------------ network check

export interface PowerLink {
  /** Piece index (or -1 for a machine connection). */
  from: number;
  to: number;
  a: [number, number];
  b: [number, number];
  type: Voltage;
  power: number;
}

export interface PowerProblem {
  code: 'unpowered' | 'pole-unconnected' | 'power-overload' | 'no-grid';
  message: string;
  tiles: [number, number][];
  pieceId?: string;
  inst?: number;
}

export interface PowerResult {
  /** Consumer index -> piece index feeding it (-1: unpowered). */
  feed: number[];
  links: PowerLink[];
  /** Per piece: total power handed out, and per node use (poles). */
  load: number[];
  nodeUse: number[][];
  unpowered: Set<number>;
  problems: PowerProblem[];
  /** Consumers connected although no pole in reach had room (they overload one). */
  forced: number[];
  /** Consumer key -> id of the pole feeding it. */
  assign: Map<string, string>;
}

/**
 * Capacity bookkeeping along the power tree: node loads per pole, which node of its parent each
 * piece hangs from (taken first fit when power first flows through it), and the load each piece
 * hands out. Shared by the planner and the check so both count the same way.
 */
export class Ledger {
  pieces: PowerPiece[];
  parent: number[];
  nodeUse: number[][];
  feedNode: number[];
  /** Load handed out (transformers: on their MV side). */
  load: number[];
  /** Transformers: HV machines connected straight to their HV side. */
  hvDirect: number[];

  constructor(pieces: PowerPiece[], parent: number[]) {
    this.pieces = pieces;
    this.parent = parent;
    this.nodeUse = [];
    this.feedNode = [];
    this.load = [];
    this.hvDirect = [];
    for (let i = 0; i < pieces.length; i++) this.grow(i);
  }

  /** Bookkeeping for a piece added at index i. */
  grow(i: number): void {
    while (this.nodeUse.length <= i) {
      const sp = this.spec(this.nodeUse.length);
      this.nodeUse.push(sp ? new Array<number>(sp.nodes).fill(0) : []);
      this.feedNode.push(-1);
      this.load.push(0);
      this.hvDirect.push(0);
    }
    while (this.parent.length <= i) this.parent.push(-2);
  }

  spec(i: number) {
    const k = this.pieces[i].kind;
    return k === 'hv' ? POLE.HV : k === 'mv' ? POLE.MV : null;
  }

  /** Can `amount` more be drawn through piece i? */
  /**
   * Can `amount` more be drawn through piece i? `hv`: an HV machine on a transformer's HV side
   * (no conversion, no loss).
   */
  fits(i: number, amount: number, hv = false): boolean {
    let cur = i;
    let nd = -1;
    let a = amount;
    let child = -1;
    if (hv && this.pieces[i].kind === 'transformer') {
      if (this.draw(i) + a > TRANSFORMER.maxInput + 1e-6) return false;
      child = i;
      nd = this.feedNode[i];
      cur = this.parent[i];
    }
    while (cur >= 0) {
      const sp = this.spec(cur);
      if (sp) {
        if (cur === i) {
          // a machine's cable may draw from several nodes of its pole
          const room = this.nodeUse[cur].reduce((r, u) => r + Math.max(0, sp.rating - u), 0);
          if (room + 1e-6 < a) return false;
        } else if (!this.nodeFits(cur, nd, a) && !this.pack(cur, child, a)) {
          return false;
        }
      }
      if (this.pieces[cur].kind === 'transformer') {
        // both sides carry at most 240 MMF/s: what it hands out on MV, what it takes on HV
        if (this.load[cur] + a > TRANSFORMER.maxInput + 1e-6) return false;
        if (this.draw(cur) + a / (1 - TRANSFORMER.loss) > TRANSFORMER.maxInput + 1e-6) {
          return false;
        }
        a /= 1 - TRANSFORMER.loss;
      }
      child = cur;
      nd = this.feedNode[cur];
      cur = this.parent[cur];
    }
    return true;
  }

  /** Does `a` more fit on node nd of pole cur (nd < 0: on any one node)? */
  private nodeFits(cur: number, nd: number, a: number): boolean {
    const r = this.spec(cur)!.rating + 1e-6;
    const use = this.nodeUse[cur];
    return nd < 0 ? use.some((u) => u + a <= r) : use[nd] + a <= r;
  }

  /**
   * Cables of pole cur laid out again, biggest first each on the node with the most room, with
   * `a` more through `child` (cables to other pieces cannot be split, machines' cables can):
   * the player picks the nodes, so the check should not depend on the order loads were added.
   * Returns the new node of every cable and each node's use, or null when they do not fit.
   * `counted`: the loads already include `a` (during commit).
   */
  private pack(
    cur: number,
    child: number,
    a: number,
    counted = false,
  ): { use: number[]; feed: [number, number][] } | null {
    const sp = this.spec(cur);
    if (!sp) return null;
    const items: [number, number][] = [];
    let cables = 0;
    for (let j = 0; j < this.pieces.length; j++) {
      if (this.parent[j] !== cur || j === cur) continue;
      const d = this.feedNode[j] >= 0 || (counted && j === child) ? this.draw(j) : 0;
      cables += d;
      const amt = j === child && !counted ? (this.feedNode[j] >= 0 ? d : 0) + a : d;
      if (amt > 0) items.push([j, amt]);
    }
    // machines straight on this pole (can spread over nodes)
    let div = this.load[cur] - cables + (child < 0 && !counted ? a : 0);
    items.sort((p, q) => q[1] - p[1]);
    const use = new Array<number>(sp.nodes).fill(0);
    const feed: [number, number][] = [];
    for (const [j, amt] of items) {
      let best = 0;
      for (let k = 1; k < use.length; k++) if (use[k] < use[best]) best = k;
      if (use[best] + amt > sp.rating + 1e-6) return null;
      use[best] += amt;
      feed.push([j, best]);
    }
    const room = use.reduce((r, u) => r + Math.max(0, sp.rating - u), 0);
    if (room + 1e-6 < div) return null;
    for (let k = 0; k < use.length && div > 1e-12; k++) {
      const take = Math.min(div, Math.max(0, sp.rating - use[k]));
      use[k] += take;
      div -= take;
    }
    return { use, feed };
  }

  /** Draws `amount` through piece i (forced: also when it does not fit). */
  commit(i: number, amount: number, hv = false): void {
    let cur = i;
    let nd = -1;
    let a = amount;
    let child = -1;
    if (hv && this.pieces[i].kind === 'transformer') {
      this.hvDirect[i] += a;
      child = i;
      nd = this.feedNode[i];
      cur = this.parent[i];
    }
    while (cur >= 0) {
      const sp = this.spec(cur);
      this.load[cur] += a;
      if (sp && cur === i) {
        // the machine's own pole: one node when it fits, else spread over the emptiest nodes
        const use = this.nodeUse[cur];
        const one = use.findIndex((u) => u + a <= sp.rating + 1e-6);
        if (one >= 0) {
          use[one] += a;
        } else {
          let left = a;
          const order = use.map((_u, k) => k).sort((p, q) => use[p] - use[q]);
          for (const k of order) {
            const take = Math.min(left, Math.max(0, sp.rating - use[k]));
            use[k] += take;
            left -= take;
          }
          // forced: what does not fit goes on the emptiest node
          if (left > 1e-9) use[order[0]] += left;
        }
      } else if (sp) {
        const packed = this.nodeFits(cur, nd, a) ? null : this.pack(cur, child, a, true);
        if (packed) {
          // laid out again so it fits
          this.nodeUse[cur] = packed.use;
          for (const [j, k] of packed.feed) this.feedNode[j] = k;
        } else {
          if (nd < 0) {
            const use = this.nodeUse[cur];
            nd = use.findIndex((u) => u + a <= sp.rating + 1e-6);
            if (nd < 0) nd = use.indexOf(Math.min(...use));
            if (child >= 0) this.feedNode[child] = nd;
          }
          this.nodeUse[cur][nd] += a;
        }
      }
      if (this.pieces[cur].kind === 'transformer') a /= 1 - TRANSFORMER.loss;
      child = cur;
      nd = this.feedNode[cur];
      cur = this.parent[cur];
    }
  }

  /**
   * The piece that has no room when `amount` is drawn through piece i (the machine's own pole,
   * or the first pole / transformer up the chain that is full), or -1 when it fits.
   */
  bottleneck(i: number, amount: number, hv = false): number {
    let cur = i;
    let nd = -1;
    let a = amount;
    let child = -1;
    if (hv && this.pieces[i].kind === 'transformer') {
      if (this.draw(i) + a > TRANSFORMER.maxInput + 1e-6) return i;
      child = i;
      nd = this.feedNode[i];
      cur = this.parent[i];
    }
    while (cur >= 0) {
      const sp = this.spec(cur);
      if (sp) {
        if (cur === i) {
          const room = this.nodeUse[cur].reduce((r, u) => r + Math.max(0, sp.rating - u), 0);
          if (room + 1e-6 < a) return cur;
        } else if (!this.nodeFits(cur, nd, a) && !this.pack(cur, child, a)) {
          return cur;
        }
      }
      if (this.pieces[cur].kind === 'transformer') {
        if (this.load[cur] + a > TRANSFORMER.maxInput + 1e-6) return cur;
        if (this.draw(cur) + a / (1 - TRANSFORMER.loss) > TRANSFORMER.maxInput + 1e-6) return cur;
        a /= 1 - TRANSFORMER.loss;
      }
      child = cur;
      nd = this.feedNode[cur];
      cur = this.parent[cur];
    }
    return -1;
  }

  /** What piece j takes from its parent. */
  draw(j: number): number {
    return this.pieces[j].kind === 'transformer'
      ? this.load[j] / (1 - TRANSFORMER.loss) + this.hvDirect[j]
      : this.load[j];
  }
}

/**
 * Builds the power network over the given pieces (grid -> HV poles -> transformers -> MV
 * poles -> machines, each feeding from the nearest piece in reach that is on the network) and
 * checks reach and capacity.
 */
export function solvePower(
  consumers: Consumer[],
  pieces: PowerPiece[],
  assigned?: Map<string, string>,
): PowerResult {
  const n = pieces.length;
  const parent = new Array<number>(n).fill(-2); // -2 unreached, -1 root (grid)
  const centre = pieces.map(pieceCentre);
  const tports = pieces.map((p) => (p.kind === 'transformer' ? transformerPorts(p) : null));
  const R_HV = reach('HV');
  const R_MV = reach('MV');
  // where a piece connects on its HV side / MV side
  const hvAt = (i: number) => (tports[i] ? tports[i]!.hv : centre[i]);
  const mvAt = (i: number) => (tports[i] ? tports[i]!.mv : centre[i]);
  const order: number[] = [];
  const queue: number[] = [];
  pieces.forEach((p, i) => {
    if (p.kind === 'grid') {
      parent[i] = -1;
      queue.push(i);
    }
  });
  const canFeed = (i: number, j: number): boolean => {
    const k = pieces[i].kind;
    const kj = pieces[j].kind;
    if ((k === 'grid' || k === 'hv') && (kj === 'hv' || kj === 'transformer')) {
      return dist(hvAt(i), hvAt(j)) <= R_HV;
    }
    if ((k === 'transformer' || k === 'mv') && kj === 'mv') return dist(mvAt(i), mvAt(j)) <= R_MV;
    return false;
  };
  // a piece keeps the feed it was laid out with while that one is still in reach
  const byId = new Map(pieces.map((p, i) => [p.id, i]));
  const stored = pieces.map((p, j) => {
    const f = p.feed === undefined ? undefined : byId.get(p.feed);
    return f !== undefined && f !== j && canFeed(f, j) ? f : -1;
  });
  // breadth first: grids -> HV poles (-> HV poles) -> transformers -> MV poles (-> MV poles);
  // a second pass picks up pieces whose stored feed never got power
  for (let pass = 0; pass < 2; pass++) {
    if (pass === 1) {
      for (let i = 0; i < n; i++) if (parent[i] !== -2) queue.push(i);
      order.length = 0;
    }
    while (queue.length) {
      const i = queue.shift()!;
      order.push(i);
      for (let j = 0; j < n; j++) {
        if (parent[j] !== -2) continue;
        if (pass === 0 && stored[j] >= 0 && stored[j] !== i) continue;
        if (!canFeed(i, j)) continue;
        parent[j] = i;
        queue.push(j);
      }
    }
  }
  const problems: PowerProblem[] = [];
  const tileOf = (p: PowerPiece): [number, number] => [p.x, p.y];
  if (!pieces.some((p) => p.kind === 'grid') && pieces.length) {
    problems.push({
      code: 'no-grid',
      message: 'There is no grid connection: nothing feeds the power poles',
      tiles: [tileOf(pieces[0])],
    });
  }
  pieces.forEach((p, i) => {
    if (p.kind !== 'grid' && parent[i] === -2) {
      problems.push({
        code: 'pole-unconnected',
        message: `${pieceName(p.kind)} is not connected to the grid`,
        tiles: [tileOf(p)],
        pieceId: p.id,
      });
    }
  });
  // machines: first the ones the layout assigned (in the order it did, so capacity counts
  // the same), then the rest, most constrained first (fewest poles in reach), each on the
  // nearest pole in reach with room all the way up to the grid
  const ledger = new Ledger(pieces, parent);
  const { nodeUse, load } = ledger;
  const fits = (i: number, a: number, hv = false) => ledger.fits(i, a, hv);
  const commit = (i: number, a: number, hv = false) => ledger.commit(i, a, hv);
  /** Where a machine of voltage v connects on piece i (a transformer's matching side). */
  const connectAt = (i: number, v: Voltage) => (v === 'HV' ? hvAt(i) : mvAt(i));
  const feed = new Array<number>(consumers.length).fill(-1);
  const overloaded = new Set<number>();
  const forced: number[] = [];
  const candsOf = consumers.map((c) => {
    const cands: [number, number][] = [];
    pieces.forEach((p, i) => {
      if (parent[i] === -2) return;
      // poles of the machine's voltage, or a transformer (MV side / HV side)
      const pole = (p.kind === 'hv' && c.type === 'HV') || (p.kind === 'mv' && c.type === 'MV');
      if (!pole && p.kind !== 'transformer') return;
      const d = dist(c.at, connectAt(i, c.type));
      if (d <= reach(c.type)) cands.push([d, i]);
    });
    return cands.sort((p, q) => p[0] - q[0]);
  });
  const done = new Set<number>();
  /** Consumers in the order they were put on poles (capacity depends on it). */
  const committed: number[] = [];
  if (assigned?.size) {
    const byKey = new Map(consumers.map((c, i) => [c.key, i]));
    for (const [ck, pid] of assigned) {
      const ci = byKey.get(ck);
      const i = byId.get(pid);
      if (ci === undefined || i === undefined) continue;
      const hv = consumers[ci].type === 'HV';
      if (!candsOf[ci].some(([, j]) => j === i) || !fits(i, consumers[ci].load, hv)) continue;
      feed[ci] = i;
      commit(i, consumers[ci].load, hv);
      done.add(ci);
      committed.push(ci);
    }
  }
  const todo = consumers
    .map((_c, i) => i)
    .filter((i) => !done.has(i))
    .sort((p, q) => candsOf[p].length - candsOf[q].length || consumers[q].load - consumers[p].load);
  for (const ci of todo) {
    const c = consumers[ci];
    const cands = candsOf[ci];
    if (!cands.length) continue;
    const hv = c.type === 'HV';
    const ok = cands.find(([, i]) => fits(i, c.load, hv));
    const i = ok ? ok[1] : cands[0][1];
    if (!ok) {
      // blame the piece that is actually full (often a pole further up the chain)
      const full = ledger.bottleneck(i, c.load, hv);
      overloaded.add(full >= 0 ? full : i);
      forced.push(ci);
    }
    feed[ci] = i;
    commit(i, c.load, hv);
    committed.push(ci);
  }
  const draw = (j: number) => ledger.draw(j);
  for (const i of overloaded) {
    const p = pieces[i];
    const sp = ledger.spec(i);
    const mm = (v: number) => (v / 1e6).toFixed(2);
    problems.push({
      code: 'power-overload',
      message: sp
        ? `${pieceName(p.kind)} is over capacity: its nodes carry ${nodeUse[i].map(mm).join(' / ')} MMF/s, at most ${mm(sp.rating)} each`
        : `HV transformer is over capacity: ${fmt(load[i])} out on MV, ${fmt(ledger.draw(i))} in on HV, at most ${fmt(TRANSFORMER.maxInput)} each`,
      tiles: [tileOf(p)],
      pieceId: p.id,
    });
  }
  const unpowered = new Set<number>();
  consumers.forEach((c, ci) => {
    if (feed[ci] >= 0) return;
    unpowered.add(c.inst);
    problems.push({
      code: 'unpowered',
      message: `No ${c.type} pole on the grid within ${reach(c.type)} tiles of this machine's power connection`,
      tiles: [[Math.floor(c.at[0]), Math.floor(c.at[1])]],
      inst: c.inst,
    });
  });
  const links: PowerLink[] = [];
  for (let j = 0; j < n; j++) {
    const i = parent[j];
    if (i < 0) continue;
    const mvSide = pieces[j].kind === 'mv';
    links.push({
      from: i,
      to: j,
      a: mvSide ? mvAt(i) : hvAt(i),
      b: mvSide ? mvAt(j) : hvAt(j),
      type: mvSide ? 'MV' : 'HV',
      power: draw(j),
    });
  }
  consumers.forEach((c, ci) => {
    const i = feed[ci];
    if (i < 0) return;
    links.push({
      from: i,
      to: -1,
      a: connectAt(i, c.type),
      b: c.at,
      type: c.type,
      power: c.load,
    });
  });
  const assign = new Map<string, string>();
  for (const ci of committed) assign.set(consumers[ci].key, pieces[feed[ci]].id);
  return { feed, links, load, nodeUse, unpowered, problems, forced, assign };
}

export function pieceName(kind: PowerKind): string {
  return kind === 'hv'
    ? 'HV pole'
    : kind === 'mv'
      ? 'MV pole'
      : kind === 'transformer'
        ? 'HV transformer'
        : 'Grid connection';
}

export function fmt(v: number): string {
  if (v >= 1e6) return `${(v / 1e6).toFixed(v >= 1e8 ? 0 : 2)} MMF/s`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)} kMF/s`;
  return `${v.toFixed(0)} MF/s`;
}

// ------------------------------------------------------------------ planning

/** Free-space index over a box: summed area table of occupied tiles. */
class FreeMap {
  x0: number;
  y0: number;
  w: number;
  h: number;
  occ: Uint8Array;
  private sat: Int32Array | null = null;

  constructor(x0: number, y0: number, w: number, h: number) {
    this.x0 = x0;
    this.y0 = y0;
    this.w = w;
    this.h = h;
    this.occ = new Uint8Array(w * h);
  }

  mark(x: number, y: number): void {
    const i = x - this.x0;
    const j = y - this.y0;
    if (i >= 0 && j >= 0 && i < this.w && j < this.h) this.occ[j * this.w + i] = 1;
    this.sat = null;
  }

  /** True when the w x h rectangle at (x, y) is inside the box and free. */
  free(x: number, y: number, w: number, h: number): boolean {
    const i = x - this.x0;
    const j = y - this.y0;
    if (i < 0 || j < 0 || i + w > this.w || j + h > this.h) return false;
    if (!this.sat) {
      const W = this.w + 1;
      const s = new Int32Array(W * (this.h + 1));
      for (let yy = 0; yy < this.h; yy++) {
        let row = 0;
        for (let xx = 0; xx < this.w; xx++) {
          row += this.occ[yy * this.w + xx];
          s[(yy + 1) * W + xx + 1] = s[yy * W + xx + 1] + row;
        }
      }
      this.sat = s;
    }
    const W = this.w + 1;
    const s = this.sat;
    return s[(j + h) * W + i + w] - s[j * W + i + w] - s[(j + h) * W + i] + s[j * W + i] === 0;
  }
}

export interface PowerPlan {
  pieces: PowerPiece[];
  /** Consumer key -> id of the pole feeding it. */
  assign: Map<string, string>;
  /** Machines that could not be connected. */
  unpowered: Set<number>;
  result: PowerResult;
}

/** Time the planner may spend taking out pieces that are not needed. */
const PRUNE_MS = 400;

/** Room around the layout where poles may stand. */
const RING = 14;

/**
 * Places poles, transformers and the grid connection on free tiles of a routed layout (and in
 * a ring around it) so every machine is connected: HV poles grow outwards from the grid
 * connection towards HV machines and transformers, MV poles grow from transformers towards MV
 * machines, each pole within reach of the one feeding it and within its capacity.
 */
export function planPower(problem: Problem, sol: Solution, keep: PowerPiece[] = []): PowerPlan {
  const consumers = powerConsumers(problem, sol.machines);
  const pieces: PowerPiece[] = keep.map((p) => ({ ...p }));
  const [bx0, by0, bx1, by1] = sol.bbox;
  const fm = new FreeMap(bx0 - RING, by0 - RING, bx1 - bx0 + 2 * RING, by1 - by0 + 2 * RING);
  for (const c of sol.blocked.keys()) fm.mark(kx(c), ky(c));
  for (const cells of sol.cells) for (const c of cells) fm.mark(kx(c), ky(c));
  // keep one free tile around machine ports (pipes may still need them in the editor)
  const place = (p: PowerPiece) => {
    for (const [x, y] of pieceTiles(p)) fm.mark(x, y);
    pieces.push(p);
    ledger.grow(pieces.length - 1);
    ledger.parent[pieces.length - 1] = -1;
  };
  for (const p of pieces) for (const [x, y] of pieceTiles(p)) fm.mark(x, y);
  let seq = 0;
  const newId = (k: PowerKind) => `${k}-${++seq}`;
  const R_HV = reach('HV');
  const R_MV = reach('MV');

  // ---- capacity bookkeeping along the tree (shared with the check)
  const ledger = new Ledger(
    pieces,
    pieces.map(() => -1),
  );
  const assigned = new Map<string, string>();
  const canAdd = (i: number, amount: number): boolean => ledger.fits(i, amount);
  const attach = (child: number, parent: number) => {
    ledger.grow(child);
    ledger.parent[child] = parent;
    pieces[child].feed = pieces[parent].id;
  };
  const infoOf = (i: number) => {
    ledger.grow(i);
    return { parent: ledger.parent[i] };
  };

  const hvAt = (i: number) =>
    pieces[i].kind === 'transformer' ? transformerPorts(pieces[i]).hv : pieceCentre(pieces[i]);
  const mvAt = (i: number) =>
    pieces[i].kind === 'transformer' ? transformerPorts(pieces[i]).mv : pieceCentre(pieces[i]);

  // ---- grid connection: on the edge of the layout nearest to the HV machines' middle
  const hvCons = consumers.filter((c) => c.type === 'HV');
  const mvCons = consumers.filter((c) => c.type === 'MV');
  if (!consumers.length)
    return {
      pieces,
      unpowered: new Set(),
      result: solvePower(consumers, pieces),
      assign: new Map(),
    };
  if (!pieces.some((p) => p.kind === 'grid')) {
    const pts = (hvCons.length ? hvCons : consumers).map((c) => c.at);
    const mx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
    const my = pts.reduce((a, p) => a + p[1], 0) / pts.length;
    const cands: [number, number][] = [];
    for (let x = bx0 - 6; x <= bx1 + 4; x += 2) cands.push([x, by0 - 6], [x, by1 + 4]);
    for (let y = by0 - 6; y <= by1 + 4; y += 2) cands.push([bx0 - 6, y], [bx1 + 4, y]);
    cands.sort((a, b) => Math.hypot(a[0] - mx, a[1] - my) - Math.hypot(b[0] - mx, b[1] - my));
    const at = cands.find(([x, y]) => fm.free(x, y, GRID_SIZE, GRID_SIZE)) ?? cands[0];
    place({ id: newId('grid'), kind: 'grid', x: at[0], y: at[1], rot: 0 });
  }

  // ---- HV network
  const hvNet = () =>
    pieces.map((_p, i) => i).filter((i) => pieces[i].kind === 'grid' || pieces[i].kind === 'hv');
  /** HV feeder in reach of point `at` with room for `amount` (nearest). */
  const hvFeeder = (at: readonly [number, number], amount: number): number => {
    let best = -1;
    let bd = Infinity;
    for (const i of hvNet()) {
      const d = dist(hvAt(i), at);
      if (d <= R_HV && d < bd && canAdd(i, amount)) {
        bd = d;
        best = i;
      }
    }
    return best;
  };
  /**
   * Chain of new HV poles from the network to a pole within `within` of `target`: breadth
   * first over free pole sites (fewest poles), so the chain may detour around the layout.
   */
  const hvPathTo = (target: readonly [number, number], within: number, amount: number): boolean => {
    const { w, h } = POLE.HV;
    const step = 4;
    const sites: [number, number][] = [];
    for (let y = fm.y0; y + h <= fm.y0 + fm.h; y += step) {
      for (let x = fm.x0; x + w <= fm.x0 + fm.w; x += step)
        if (fm.free(x, y, w, h)) sites.push([x, y]);
    }
    if (!sites.length) return false;
    const cen = sites.map(([x, y]) => [x + w / 2, y + h / 2] as [number, number]);
    // buckets of reach size for neighbour lookups
    const B = R_HV;
    const bk = new Map<string, number[]>();
    const bkey = (x: number, y: number) => `${Math.floor(x / B)},${Math.floor(y / B)}`;
    cen.forEach(([x, y], i) => {
      const k = bkey(x, y);
      const l = bk.get(k);
      if (l) l.push(i);
      else bk.set(k, [i]);
    });
    const near = (x: number, y: number): number[] => {
      const out: number[] = [];
      const bx = Math.floor(x / B);
      const by = Math.floor(y / B);
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) out.push(...(bk.get(`${bx + dx},${by + dy}`) ?? []));
      return out;
    };
    const prev = new Int32Array(sites.length).fill(-2);
    const feederOf = new Int32Array(sites.length).fill(-1);
    let queue: number[] = [];
    for (const i of hvNet()) {
      if (!canAdd(i, amount)) continue;
      const at = hvAt(i);
      for (const j of near(at[0], at[1])) {
        if (prev[j] !== -2 || dist(cen[j], at) > R_HV) continue;
        prev[j] = -1;
        feederOf[j] = i;
        queue.push(j);
      }
    }
    let goal = -1;
    while (queue.length && goal < 0) {
      const next: number[] = [];
      for (const j of queue) {
        if (dist(cen[j], target) <= within) {
          goal = j;
          break;
        }
        for (const k of near(cen[j][0], cen[j][1])) {
          if (prev[k] !== -2 || dist(cen[k], cen[j]) > R_HV) continue;
          prev[k] = j;
          next.push(k);
        }
      }
      queue = next;
    }
    if (goal < 0) return false;
    const chain: number[] = [];
    for (let j = goal; j >= 0; j = prev[j]) chain.unshift(j);
    let feeder = feederOf[chain[0]];
    for (const j of chain) {
      const [x, y] = sites[j];
      if (!fm.free(x, y, w, h)) return false;
      place({ id: newId('hv'), kind: 'hv', x, y, rot: 0 });
      attach(pieces.length - 1, feeder);
      feeder = pieces.length - 1;
    }
    return true;
  };

  /**
   * Adds an HV pole that covers `target` (or, if none can be fed, one that brings the network
   * closer to it). Returns false when no progress is possible.
   */
  const growHV = (target: readonly [number, number], amount: number): boolean => {
    const { w, h } = POLE.HV;
    let best: { x: number; y: number; feeder: number; d: number } | null = null;
    // candidates covering the target
    const t0x = Math.floor(target[0] - R_HV - w / 2);
    const t0y = Math.floor(target[1] - R_HV - h / 2);
    for (let y = t0y; y <= target[1] + R_HV; y += 2) {
      for (let x = t0x; x <= target[0] + R_HV; x += 2) {
        const c: [number, number] = [x + w / 2, y + h / 2];
        if (dist(c, target) > R_HV) continue;
        if (!fm.free(x, y, w, h)) continue;
        const feeder = hvFeeder(c, amount);
        if (feeder < 0) continue;
        const d = dist(c, target);
        // prefer poles that leave room (far from the target edge) and near the feeder
        const score = -d + 0.25 * dist(c, hvAt(feeder));
        if (!best || score < best.d) best = { x, y, feeder, d: score };
      }
    }
    if (!best) return hvPathTo(target, R_HV, amount);
    place({ id: newId('hv'), kind: 'hv', x: best.x, y: best.y, rot: 0 });
    attach(pieces.length - 1, best.feeder);
    return true;
  };

  const unpowered = new Set<number>();
  const assign = (
    cons: Consumer[],
    kinds: PowerKind,
    R: number,
    grow: (c: Consumer) => boolean,
  ) => {
    // biggest first, so they get the emptiest nodes
    const todo = [...cons].sort((a, b) => b.load - a.load);
    for (const c of todo) {
      for (let tries = 0; tries < 12; tries++) {
        let best = -1;
        let bd = Infinity;
        const hv = c.type === 'HV';
        pieces.forEach((p, i) => {
          // a pole of the machine's voltage, or a transformer's matching side
          if (p.kind !== kinds && p.kind !== 'transformer') return;
          const at = p.kind === 'transformer' ? (hv ? hvAt(i) : mvAt(i)) : pieceCentre(p);
          const d = dist(c.at, at);
          if (d <= R && d < bd && ledger.fits(i, c.load, hv)) {
            bd = d;
            best = i;
          }
        });
        if (best >= 0) {
          ledger.commit(best, c.load, hv);
          assigned.set(c.key, pieces[best].id);
          break;
        }
        if (!grow(c)) {
          unpowered.add(c.inst);
          break;
        }
      }
    }
  };
  assign(hvCons, 'hv', R_HV, (c) => growHV(c.at, c.load));

  // ---- MV network: transformers on the HV network, MV poles from them
  const mvFeeder = (at: readonly [number, number], amount: number): number => {
    let best = -1;
    let bd = Infinity;
    pieces.forEach((p, i) => {
      if (p.kind !== 'transformer' && p.kind !== 'mv') return;
      const d = dist(mvAt(i), at);
      // poles straight off a transformer get priority (their cable is not node-limited)
      const pen = p.kind === 'transformer' ? 0 : 6;
      if (d <= R_MV && d + pen < bd && canAdd(i, amount)) {
        bd = d + pen;
        best = i;
      }
    });
    return best;
  };
  const addTransformer = (target: readonly [number, number], amount: number): boolean => {
    const n = TRANSFORMER.size;
    let best: { x: number; y: number; r: number; feeder: number; d: number } | null = null;
    let room = false;
    for (let y = Math.floor(target[1] - 2 * R_MV - n); y <= target[1] + 2 * R_MV; y += 1) {
      for (let x = Math.floor(target[0] - 2 * R_MV - n); x <= target[0] + 2 * R_MV; x += 1) {
        if (!fm.free(x, y, n, n)) continue;
        room = true;
        for (let r = 0; r < 4; r++) {
          const ports = transformerPorts({ id: '', kind: 'transformer', x, y, rot: r });
          const d = dist(ports.mv, target);
          if (d > 2 * R_MV || (best && d >= best.d)) continue;
          const feeder = hvFeeder(ports.hv, amount / (1 - TRANSFORMER.loss));
          if (feeder < 0) continue;
          best = { x, y, r, feeder, d };
        }
      }
    }
    if (!best) {
      // no room for a transformer here: the layout has to make room (corridor widening)
      if (!room) return false;
      // room, but no HV pole with spare capacity in reach: bring the HV network closer first
      return hvPathTo(target, R_HV + 2 * R_MV, amount / (1 - TRANSFORMER.loss));
    }
    place({ id: newId('transformer'), kind: 'transformer', x: best.x, y: best.y, rot: best.r });
    attach(pieces.length - 1, best.feeder);
    return true;
  };
  /**
   * Chain of new MV poles from the MV network to one within reach of `target`, breadth first
   * over free 2x1 sites in a window around the target (MV poles fit in narrow gaps).
   */
  const mvPathTo = (target: readonly [number, number], amount: number): boolean => {
    const W = 90;
    const sites: [number, number, number][] = [];
    for (let y = Math.floor(target[1] - W); y <= target[1] + W; y += 2) {
      for (let x = Math.floor(target[0] - W); x <= target[0] + W; x += 2) {
        if (fm.free(x, y, 2, 1)) sites.push([x, y, 0]);
        else if (fm.free(x, y, 1, 2)) sites.push([x, y, 1]);
      }
    }
    if (!sites.length) return false;
    const cen = sites.map(
      ([x, y, r]) => (r ? [x + 0.5, y + 1] : [x + 1, y + 0.5]) as [number, number],
    );
    const B = R_MV;
    const bk = new Map<string, number[]>();
    const bkey = (x: number, y: number) => `${Math.floor(x / B)},${Math.floor(y / B)}`;
    cen.forEach(([x, y], i) => {
      const k = bkey(x, y);
      const l = bk.get(k);
      if (l) l.push(i);
      else bk.set(k, [i]);
    });
    const near = (x: number, y: number): number[] => {
      const out: number[] = [];
      const bx = Math.floor(x / B);
      const by = Math.floor(y / B);
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) out.push(...(bk.get(`${bx + dx},${by + dy}`) ?? []));
      return out;
    };
    const prev = new Int32Array(sites.length).fill(-2);
    const feederOf = new Int32Array(sites.length).fill(-1);
    let queue: number[] = [];
    pieces.forEach((p, i) => {
      if ((p.kind !== 'mv' && p.kind !== 'transformer') || !canAdd(i, amount)) return;
      const at = mvAt(i);
      for (const j of near(at[0], at[1])) {
        if (prev[j] !== -2 || dist(cen[j], at) > R_MV) continue;
        prev[j] = -1;
        feederOf[j] = i;
        queue.push(j);
      }
    });
    let goal = -1;
    while (queue.length && goal < 0) {
      const next: number[] = [];
      for (const j of queue) {
        if (dist(cen[j], target) <= R_MV) {
          goal = j;
          break;
        }
        for (const k of near(cen[j][0], cen[j][1])) {
          if (prev[k] !== -2 || dist(cen[k], cen[j]) > R_MV) continue;
          prev[k] = j;
          next.push(k);
        }
      }
      queue = next;
    }
    if (goal < 0) return false;
    const chain: number[] = [];
    for (let j = goal; j >= 0; j = prev[j]) chain.unshift(j);
    // a chain hangs off one node all the way: it must carry what it will feed
    let feeder = feederOf[chain[0]];
    for (const j of chain) {
      const [x, y, r] = sites[j];
      const [pw, ph] = r ? [1, 2] : [2, 1];
      if (!fm.free(x, y, pw, ph)) return false;
      place({ id: newId('mv'), kind: 'mv', x, y, rot: r });
      attach(pieces.length - 1, feeder);
      feeder = pieces.length - 1;
    }
    return true;
  };

  const growMV = (c: Consumer): boolean => {
    const { w, h } = POLE.MV;
    let best: { x: number; y: number; r: number; feeder: number; s: number } | null = null;
    for (let y = Math.floor(c.at[1] - R_MV - 1); y <= c.at[1] + R_MV; y++) {
      for (let x = Math.floor(c.at[0] - R_MV - 1); x <= c.at[0] + R_MV; x++) {
        for (let r = 0; r < 2; r++) {
          const [pw, ph] = r ? [h, w] : [w, h];
          const cc: [number, number] = [x + pw / 2, y + ph / 2];
          if (dist(cc, c.at) > R_MV || !fm.free(x, y, pw, ph)) continue;
          const feeder = mvFeeder(cc, c.load);
          if (feeder < 0) continue;
          // other uncovered MV machines this pole would reach
          let cover = 0;
          for (const o of mvCons) if (dist(o.at, cc) <= R_MV) cover++;
          // tidy: in line with poles already placed nearby (same row or column)
          let align = 0;
          for (const q of pieces) {
            if (q.kind !== 'mv') continue;
            if ((q.y === y || q.x === x) && Math.abs(q.x - x) + Math.abs(q.y - y) <= 3 * R_MV) {
              align = 1;
              break;
            }
          }
          const s = -cover * 4 - align * 3 + dist(cc, mvAt(feeder)) * 0.05;
          if (!best || s < best.s) best = { x, y, r, feeder, s };
        }
      }
    }
    if (!best) {
      // a relay chain hangs off single nodes: no use for a machine above one node's rating
      if (c.load <= POLE.MV.rating && mvPathTo(c.at, c.load)) return true;
      return addTransformer(c.at, Math.max(c.load, 1));
    }
    place({ id: newId('mv'), kind: 'mv', x: best.x, y: best.y, rot: best.r });
    attach(pieces.length - 1, best.feeder);
    return true;
  };
  assign(mvCons, 'mv', R_MV, growMV);

  // the check assigns machines on its own: where one found no pole with room, add capacity
  const result0 = solvePower(consumers, pieces, assigned);
  // drop pieces nothing hangs from (relays that ended up unused, idle transformers)
  const used = new Set<number>();
  result0.feed.forEach((i) => {
    for (let cur = i; cur >= 0; cur = infoOf(cur).parent) used.add(cur);
  });
  const kept = pieces.filter(
    (p, i) => used.has(i) || p.kind === 'grid' || keep.some((k) => k.id === p.id),
  );
  const keptIds = new Set(kept.map((p) => p.id));
  const keptAssign = new Map([...result0.assign].filter(([, id]) => keptIds.has(id)));
  let result = solvePower(consumers, kept, keptAssign);
  // fewer pieces: take out lightly loaded poles / transformers one by one while every machine
  // keeps its power (their machines and the pieces they fed move to others in reach)
  let final = kept;
  const t0 = Date.now();
  const order = final
    .map((p, i) => ({ p, load: result.load[i] }))
    .filter(({ p }) => p.kind !== 'grid' && !keep.some((k) => k.id === p.id))
    .sort((a, b) => a.load - b.load)
    .map(({ p }) => p.id);
  for (const id of order) {
    if (Date.now() - t0 > PRUNE_MS) break;
    const trial = final.filter((p) => p.id !== id);
    const ta = new Map([...result.assign].filter(([, pid]) => pid !== id));
    const r = solvePower(consumers, trial, ta);
    if (r.problems.length <= result.problems.length && r.unpowered.size <= result.unpowered.size) {
      final = trial;
      result = r;
    }
  }
  for (const i of result.unpowered) unpowered.add(i);
  return { pieces: final, unpowered, result, assign: result.assign };
}

/** Key of a tile, for callers that index power pieces by tile. */
export function pieceTileKeys(p: PowerPiece): number[] {
  return pieceTiles(p).map(([x, y]) => key(x, y));
}
