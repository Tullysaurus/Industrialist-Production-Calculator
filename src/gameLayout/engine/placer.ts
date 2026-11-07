/** Simulated annealing over a sequence-pair floorplan of blocks. */
import { sameOption, type BlockLike, type BlockOption, type Geometry } from './blocks';
import { Rng } from './rng';
import { spacingViolations, type SpacedRect } from './spacing';
import { now } from './clock';
import { aspectPenalty, rectHullArea } from './hull';

export interface PackResult {
  xs: Int32Array;
  ys: Int32Array;
  W: number;
  H: number;
}

/** Sequence-pair packing: i before j in both sequences -> i left of j; only in A -> above. */
export function pack(seqA: number[], seqB: number[], ws: number[], hs: number[]): PackResult {
  const n = seqA.length;
  const posB = new Int32Array(n);
  for (let k = 0; k < n; k++) posB[seqB[k]] = k;
  const xs = new Int32Array(n);
  const ys = new Int32Array(n);
  let W = 0;
  let H = 0;
  for (let idx = 0; idx < n; idx++) {
    const j = seqA[idx];
    let xj = 0;
    let yj = 0;
    const pj = posB[j];
    for (let t = 0; t < idx; t++) {
      const i = seqA[t];
      if (posB[i] < pj) {
        const v = xs[i] + ws[i];
        if (v > xj) xj = v;
      } else {
        const v = ys[i] + hs[i];
        if (v > yj) yj = v;
      }
    }
    xs[j] = xj;
    ys[j] = yj;
    if (xj + ws[j] > W) W = xj + ws[j];
    if (yj + hs[j] > H) H = yj + hs[j];
  }
  return { xs, ys, W, H };
}

export class PlacerState {
  a: number[];
  b: number[];
  opt: BlockOption[];

  constructor(a: number[], b: number[], opt: BlockOption[]) {
    this.a = a;
    this.b = b;
    this.opt = opt;
  }

  copy(): PlacerState {
    return new PlacerState([...this.a], [...this.b], [...this.opt]);
  }
}

export interface PlacementInfo extends PackResult {
  geos: Geometry[];
  wl: number;
  viol: number;
}

interface PlacerNet {
  terms: [number, number, string[]][];
  /** Per term: the machine gives to the pipe (a source). */
  out: boolean[];
  weight: number;
}

/** How tidy the layout should be, traded against space. */
export interface GroupingOptions {
  /** Machines of one recipe in rows (one row or one mirrored back-to-back pair). */
  rows: boolean;
  /** Production stages in order along one axis (the one that fits better). */
  flowOrder: boolean;
  /** Ports facing the row corridors: inputs on one side, outputs on the other. */
  facing: boolean;
  /** 0..1: how much space tidiness may cost. */
  strength: number;
}

export interface SpacedInst {
  type: string;
  block: number;
  local: number;
  min: number;
}

export class Placer {
  blocks: BlockLike[];
  measure: 'edge' | 'center';
  spacingWeight: number;
  spaced: SpacedInst[];
  rng: Rng;
  wireWeight: number;
  options: BlockOption[][];
  nets: PlacerNet[];
  lastViolation = 0;
  /** Cost the orthogonal hull of the blocks (soft aspect penalty) instead of the bounding box. */
  hullCost: boolean;
  notchWeight: number;
  grouping: GroupingOptions | null;

  constructor(
    blocks: BlockLike[],
    nets: {
      large: boolean;
      terminals: { inst: number; ports: string[]; direction?: 'input' | 'output' }[];
    }[],
    instBlock: Map<number, [number, number]>,
    opts: {
      wireWeight?: number;
      seed?: number;
      spaced?: { type: string; inst: number; min: number }[];
      measure?: 'edge' | 'center';
      spacingWeight?: number;
      hullCost?: boolean;
      notchWeight?: number;
      grouping?: GroupingOptions;
    } = {},
  ) {
    this.blocks = blocks;
    this.hullCost = opts.hullCost ?? false;
    this.grouping = opts.grouping ?? null;
    this.notchWeight = opts.notchWeight ?? 0;
    this.measure = opts.measure ?? 'edge';
    this.spacingWeight = opts.spacingWeight ?? 4000;
    this.spaced = (opts.spaced ?? [])
      .filter((s) => instBlock.has(s.inst))
      .map((s) => ({
        type: s.type,
        block: instBlock.get(s.inst)![0],
        local: instBlock.get(s.inst)![1],
        min: s.min,
      }));
    this.rng = new Rng(opts.seed ?? 0);
    this.wireWeight = opts.wireWeight ?? 1;
    this.options = blocks.map((b) => b.options());
    this.nets = [];
    for (const net of nets) {
      const terms: [number, number, string[]][] = [];
      const out: boolean[] = [];
      for (const t of net.terminals) {
        const ib = instBlock.get(t.inst);
        if (ib) {
          terms.push([ib[0], ib[1], t.ports]);
          out.push(t.direction === 'output');
        }
      }
      if (terms.length >= 2) this.nets.push({ terms, out, weight: net.large ? 2 : 1 });
    }
  }

  initial(): PlacerState {
    const area = this.blocks.map((b) => {
      const g = b.geometry(b.defaultOption());
      return g.w * g.h;
    });
    const order = this.blocks.map((_b, i) => i).sort((i, j) => area[j] - area[i]);
    return new PlacerState(
      [...order],
      [...order],
      this.blocks.map((b) => b.defaultOption()),
    );
  }

  evaluate(st: PlacerState): [number, PlacementInfo] {
    const geos = this.blocks.map((b, i) => b.geometry(st.opt[i]));
    const p = pack(
      st.a,
      st.b,
      geos.map((g) => g.w),
      geos.map((g) => g.h),
    );
    const { xs, ys } = p;
    let wl = 0;
    const flow = !!this.grouping?.flowOrder;
    // flow order: how far sources sit after their consumers, along x and along y
    let backX = 0;
    let backY = 0;
    for (const net of this.nets) {
      let minx = Infinity;
      let miny = Infinity;
      let maxx = -Infinity;
      let maxy = -Infinity;
      let sx = 0;
      let sy = 0;
      let sn = 0;
      let cx = 0;
      let cy = 0;
      let cn = 0;
      net.terms.forEach(([b, li, ports], k) => {
        const tp = geos[b].termPos(li, ports);
        const px = tp[0] + xs[b];
        const py = tp[1] + ys[b];
        if (px < minx) minx = px;
        if (px > maxx) maxx = px;
        if (py < miny) miny = py;
        if (py > maxy) maxy = py;
        if (!flow) return;
        if (net.out[k]) {
          sx += px;
          sy += py;
          sn++;
        } else {
          cx += px;
          cy += py;
          cn++;
        }
      });
      wl += net.weight * (maxx - minx + (maxy - miny));
      if (flow && sn && cn) {
        backX += net.weight * Math.max(0, sx / sn - cx / cn);
        backY += net.weight * Math.max(0, sy / sn - cy / cn);
      }
    }
    let viol = 0;
    if (this.spaced.length) {
      const rects: SpacedRect[] = this.spaced.map((s, k) => {
        const it = geos[s.block].items[s.local];
        return {
          type: s.type,
          id: k,
          rect: [xs[s.block] + it.dx, ys[s.block] + it.dy, it.shape.w, it.shape.h],
          min: s.min,
        };
      });
      for (const v of spacingViolations(rects, this.measure)) viol += v.need - v.dist;
    }
    let area = p.W * p.H;
    if (this.hullCost) {
      const hull = rectHullArea(geos.map((gg, b) => [xs[b], ys[b], gg.w, gg.h]));
      area = hull + aspectPenalty(p.W, p.H, hull) + this.notchWeight * (p.W * p.H - hull);
    }
    let tidy = 0;
    const gr = this.grouping;
    if (gr && gr.strength > 0) {
      const s = gr.strength;
      this.blocks.forEach((blk, i) => {
        if (gr.rows && blk.rowsPenalty) tidy += 2 * s * blk.rowsPenalty(st.opt[i]);
        if (gr.facing && blk.facingPenalty) tidy += s * blk.facingPenalty(st.opt[i]);
      });
      // left to right or top to bottom, whichever the layout fits better
      if (gr.flowOrder) tidy += 4 * s * Math.min(backX, backY);
    }
    const cost = area + this.wireWeight * wl + this.spacingWeight * viol + tidy;
    this.lastViolation = viol;
    return [cost, { ...p, geos, wl, viol }];
  }

  neighbor(st: PlacerState): PlacerState {
    const s = st.copy();
    const n = s.a.length;
    const rng = this.rng;
    const r = rng.random();
    if (n >= 2 && r < 0.3) {
      const [i, j] = rng.pair(n);
      [s.a[i], s.a[j]] = [s.a[j], s.a[i]];
    } else if (n >= 2 && r < 0.6) {
      const [i, j] = rng.pair(n);
      [s.b[i], s.b[j]] = [s.b[j], s.b[i]];
    } else if (n >= 2 && r < 0.75) {
      const [x, y] = rng.pair(n);
      const ia = s.a.indexOf(x);
      const ja = s.a.indexOf(y);
      const ib = s.b.indexOf(x);
      const jb = s.b.indexOf(y);
      [s.a[ia], s.a[ja]] = [s.a[ja], s.a[ia]];
      [s.b[ib], s.b[jb]] = [s.b[jb], s.b[ib]];
    } else if (n >= 2 && r < 0.82) {
      // move one block to a new position in both sequences
      const x = rng.int(n);
      s.a.splice(s.a.indexOf(x), 1);
      s.a.splice(rng.int(n), 0, x);
      s.b.splice(s.b.indexOf(x), 1);
      s.b.splice(rng.int(n), 0, x);
    } else if (n >= 1) {
      const k = rng.int(n);
      const opts = this.options[k];
      if (opts.length > 1) {
        const cur = s.opt[k];
        const rr = rng.random();
        if (rr < 0.5) {
          // nudge: same rotation / alternation, neighbouring column count
          const same = opts.filter((o) => o.rot === cur.rot && o.alt === cur.alt);
          same.sort((x, y) => x.cols - y.cols);
          const i = same.findIndex((o) => sameOption(o, cur));
          if (i >= 0) {
            const ni = i + (rng.random() < 0.5 ? -1 : 1);
            if (ni >= 0 && ni < same.length) s.opt[k] = same[ni];
          } else {
            s.opt[k] = rng.pick(opts);
          }
        } else if (rr < 0.8) {
          const cand = { ...cur, rot: (cur.rot + 1 + rng.int(3)) % 4 };
          s.opt[k] = opts.find((o) => sameOption(o, cand)) ?? rng.pick(opts);
        } else {
          s.opt[k] = rng.pick(opts);
        }
      }
    }
    return s;
  }

  anneal(
    state: PlacerState | null,
    seconds: number,
    opts: { tStart?: number; tEndFrac?: number; tScale?: number; log?: (m: string) => void } = {},
  ): [PlacerState, number, PlacementInfo] {
    let st = state ? state.copy() : this.initial();
    let [cost, info] = this.evaluate(st);
    let best = st.copy();
    let bestCost = cost;
    let bestInfo = info;
    let tStart = opts.tStart;
    if (tStart === undefined) {
      let sum = 0;
      for (let i = 0; i < 60; i++) sum += Math.abs(this.evaluate(this.neighbor(st))[0] - cost);
      tStart = (sum / 60) * 0.5 * (opts.tScale ?? 1) + 1e-9;
    }
    const tEnd = Math.max(tStart * (opts.tEndFrac ?? 1e-4), 1e-6);
    const t0 = now();
    let it = 0;
    let T = tStart;
    for (;;) {
      it++;
      if ((it & 63) === 0) {
        const frac = (now() - t0) / 1000 / seconds;
        if (frac >= 1) break;
        T = tStart * Math.pow(tEnd / tStart, frac);
      }
      const cand = this.neighbor(st);
      const [c2, inf2] = this.evaluate(cand);
      const d = c2 - cost;
      if (d <= 0 || this.rng.random() < Math.exp(-d / T)) {
        st = cand;
        cost = c2;
        info = inf2;
        if (cost < bestCost) {
          best = st.copy();
          bestCost = cost;
          bestInfo = info;
        }
      }
    }
    opts.log?.(
      `  placement: ${it} iterations, ${bestInfo.W}x${bestInfo.H} = ${bestInfo.W * bestInfo.H} tiles, est. pipe length ${bestInfo.wl.toFixed(0)}` +
        (bestInfo.viol > 0 ? `, spacing short by ${bestInfo.viol.toFixed(0)} tiles` : ''),
    );
    return [best, bestCost, bestInfo];
  }
}
