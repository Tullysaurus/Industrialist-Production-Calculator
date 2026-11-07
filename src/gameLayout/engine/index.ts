/**
 * In-game layout builder: packs the machines of a planner graph into the smallest footprint
 * it can, with every pipe and conveyor routed tile by tile.
 *
 * With valves enabled it runs two passes: a quick layout that is replayed with the game's
 * even-split rule to find splits that would starve machines, then the final layout where those
 * pipe networks are built as valve manifolds.
 */
import { Analysis } from './flows';
import { buildProblem, type Problem } from './problem';
import { docFromSolution, moveItems } from '../docOps';
import type { GameLayoutDoc } from '../docSchema';
import { valveGeometry } from '../doc';
import type { Solution } from './solution';
import { optimize, type PinnedSpec } from './optimize';
import { placeValves } from './valves';
import { now } from './clock';
import { key, kx, ky } from './solution';
import type { LayoutInput, LayoutOptions, LayoutPhase, LayoutRunResult } from './types';

export interface RunCallbacks {
  log?: (line: string) => void;
  progress?: (phase: LayoutPhase, message: string, best: Solution | null) => void;
  /** Every improved layout (anytime result). `final` is set on the last call. */
  result?: (result: LayoutRunResult, final: boolean) => void;
  shouldStop?: () => boolean;
}

/** Even-split check plus valves on routed junctions where they are still needed. */
export function analyse(problem: Problem, sol: Solution, valves: boolean): Analysis {
  const first = new Analysis(problem, sol).analyse();
  if (!valves || !first.valveNets.size) {
    first.placed = [];
    first.unplaced = [];
    return first;
  }
  const [placed, unplaced] = placeValves(problem, sol, first);
  return new Analysis(problem, sol).analyse(placed, first.valveNets, unplaced);
}

/** Machine groups within this fraction of their plan do not get valve manifolds. */
const VALVE_TOLERANCE = 0.02;
const EMIT_INTERVAL_MS = 1500;

/** True when some pipe network splits between consumers (only then can even splits starve). */
function hasSplits(problem: Problem): boolean {
  return problem.nets.some(
    (n) => !n.large && n.terminals.filter((t) => t.direction === 'input').length >= 2,
  );
}

/** The pinned part of a document, in terms of one problem (instances and nets). */
export function pinnedSpec(
  problem: Problem,
  doc: GameLayoutDoc | undefined,
): PinnedSpec | undefined {
  if (!doc) return undefined;
  const instByKey = new Map<string, number>(
    problem.instances.map(([ni, li], g) => [`${problem.nodes[ni].id}#${li}`, g]),
  );
  const machines = new Map<number, { x: number; y: number; rot: number }>();
  for (const m of doc.machines) {
    const g = instByKey.get(m.key);
    if (m.pinned && g !== undefined) machines.set(g, { x: m.x, y: m.y, rot: m.rot });
  }
  if (!machines.size) return undefined;
  const pipes = new Map<number, { nodes: Set<number>; edges: number[] }>();
  for (const p of doc.pipes) {
    if (!p.pinned) continue;
    const nets = problem.nets.filter((n) => n.key === p.net && n.large === p.large);
    // a pinned pipe stays only between pinned machines, and only as one network
    if (nets.length !== 1 || !nets[0].terminals.every((t) => machines.has(t.inst))) continue;
    const nodes = new Set<number>();
    for (let i = 0; i + 1 < p.nodes.length; i += 2) nodes.add(key(p.nodes[i], p.nodes[i + 1]));
    const edges: number[] = [];
    for (let i = 0; i + 4 < p.edges.length + 1; i += 5) {
      edges.push(
        key(p.edges[i], p.edges[i + 1]),
        key(p.edges[i + 2], p.edges[i + 3]),
        p.edges[i + 4],
      );
    }
    pipes.set(nets[0].id, { nodes, edges });
  }
  const tiles: [number, number][] = [];
  for (const v of doc.valves) if (v.pinned) tiles.push([v.x, v.y]);
  for (const p of doc.passthroughs) if (p.pinned) tiles.push([p.x, p.y]);
  for (const p of doc.intersections) if (p.pinned) tiles.push([p.x, p.y]);
  return { machines, pipes, tiles };
}

/** Document from a generator solution, moved back onto the pinned machines' coordinates. */
function toDoc(
  problem: Problem,
  sol: Solution,
  pinned: GameLayoutDoc | undefined,
  analysis: Analysis | null,
): GameLayoutDoc {
  let doc = docFromSolution(problem, sol, pinned);
  // junction valves the analysis laid on routed pipes become valve pieces too
  for (const v of analysis?.placed ?? []) {
    const [A, M, E] = v.tiles;
    const j = analysis!.nets[v.net].junctions.get(M);
    for (let r = 0; r < 4; r++) {
      const cand = {
        x: Math.min(...[A, M, E].map(kx)),
        y: Math.min(...[A, M, E].map(ky)),
        rot: r,
      };
      const g = valveGeometry(cand);
      if (key(...g.a) === A && key(...g.m) === M && key(...g.e) === E) {
        doc = {
          ...doc,
          valves: [
            ...doc.valves,
            { id: `jv-${M}`, ...cand, sidePct: Math.round((j?.valve?.sidePct ?? 50) * 10) / 10 },
          ],
        };
        break;
      }
    }
  }
  if (!pinned) return doc;
  const anchor = pinned.machines.find((m) => m.pinned && doc.machines.some((d) => d.key === m.key));
  if (anchor) {
    const now_ = doc.machines.find((d) => d.key === anchor.key)!;
    const all = {
      machines: new Set(doc.machines.map((m) => m.key)),
      pipes: new Set(doc.pipes.map((p) => p.net)),
      pieces: new Set([...doc.valves, ...doc.passthroughs, ...doc.intersections].map((p) => p.id)),
    };
    doc = moveItems(doc, all, anchor.x - now_.x, anchor.y - now_.y);
  }
  // pinned pieces stay exactly as they were (generated duplicates on their tiles go)
  const at = (p: { x: number; y: number }) => `${p.x},${p.y}`;
  const pv = pinned.valves.filter((v) => v.pinned);
  const pp = pinned.passthroughs.filter((v) => v.pinned);
  const pi = pinned.intersections.filter((v) => v.pinned);
  const taken = new Set([...pv, ...pp, ...pi].map(at));
  return {
    ...doc,
    valves: [...doc.valves.filter((v) => !taken.has(at(v))), ...pv],
    passthroughs: [...doc.passthroughs.filter((v) => !taken.has(at(v))), ...pp],
    intersections: [...doc.intersections.filter((v) => !taken.has(at(v))), ...pi],
  };
}

function summary(sol: Solution, doc: GameLayoutDoc, elapsed: number, log: string[]) {
  return {
    width: sol.width,
    height: sol.height,
    area: sol.area,
    empty: sol.hull.empty,
    hullArea: sol.hull.hull,
    fullyRouted: sol.ok,
    conflicts: sol.overfull().length,
    unrouted: sol.failed.size,
    elapsed,
    valves: doc.valves.length,
    passthroughs: doc.passthroughs.length,
    log,
  };
}

export function runLayout(
  input: LayoutInput,
  options: LayoutOptions,
  cb: RunCallbacks = {},
): LayoutRunResult {
  const t0 = now();
  const lines: string[] = [];
  const log = (m: string) => {
    lines.push(m);
    cb.log?.(m);
  };
  const elapsed = () => (now() - t0) / 1000;
  const cfg = { ...(options.config ?? {}) };
  let problem = buildProblem(input, cfg);
  for (const w of problem.warnings) log(`WARNING: ${w}`);
  if (!problem.instances.length) throw new Error('There are no machines to lay out.');
  const base = {
    seed: options.seed,
    wireWeight: 1,
    jump: Math.max(1, options.quantumJump || 1),
    useModules: options.tuning?.useModules ?? true,
    slack: options.tuning?.slack ?? 1,
    stallLimit: options.tuning?.stallLimit,
    seams: options.tuning?.seams ?? true,
    hullCost: options.tuning?.hullCost ?? true,
    notchWeight: options.tuning?.notchWeight ?? 0.1,
    log,
    shouldStop: cb.shouldStop,
    pinned: pinnedSpec(problem, options.pinned),
  };
  if (base.pinned)
    log(
      `Keeping ${base.pinned.machines.size} pinned machine(s) and ${base.pinned.pipes.size} pinned pipe(s)`,
    );
  let budget = Math.max(5, options.timeBudget);
  // intermediate layouts are analysed and exported at most every 1.5 s (that costs time)
  let lastEmit = -Infinity;
  const emit = (sol: Solution, valves: boolean, final: boolean) => {
    if (!cb.result || (!final && now() - lastEmit < EMIT_INTERVAL_MS)) return;
    lastEmit = now();
    const copy = sol.copy();
    const an = valves && final ? analyse(problem, copy, true) : null;
    const doc = toDoc(problem, copy, options.pinned, an);
    cb.result({ doc, summary: summary(copy, doc, elapsed(), [...lines]) }, final);
  };

  if (options.valves && hasSplits(problem)) {
    const t1 = Math.min(120, Math.max(5, 0.25 * budget), 0.5 * budget);
    cb.progress?.('valve-check', `Quick ${t1.toFixed(0)}s layout to check pipe splits`, null);
    log(`Pass 1 (${t1.toFixed(0)}s): quick layout to check pipe splits`);
    const quick = optimize(problem, {
      ...base,
      timeBudget: t1,
      onBest: (s) => {
        cb.progress?.('valve-check', 'Checking pipe splits', s);
        emit(s, false, false);
      },
    });
    const stopped = !!cb.shouldStop?.();
    const check = new Analysis(problem, quick).analyse();
    const keys = [
      ...new Set([...check.valveNets].map((ni) => problem.nets[ni].key).filter(Boolean)),
    ].sort();
    // valve manifolds cost a lot of space: only build them for real shortfalls
    const loss = check.groups.filter(([, plan, act]) => act < plan * (1 - VALVE_TOLERANCE));
    if (keys.length && loss.length) {
      log(
        `  even splitting would starve ${loss.length} machine group(s), e.g. ` +
          loss
            .slice(0, 4)
            .map(([ni, p, a]) => `${problem.nodes[ni].name} ${((100 * a) / p).toFixed(0)}% of plan`)
            .join('; '),
      );
      log(`  -> building ${keys.length} pipe network(s) as valve manifolds`);
      cfg.valveNets = keys;
      problem = buildProblem(input, cfg);
      base.pinned = pinnedSpec(problem, options.pinned);
    } else {
      log('  every split works with even splitting - no valves needed');
    }
    budget = Math.max(5, budget - elapsed());
    if (stopped) {
      const doc = toDoc(problem, quick, options.pinned, null);
      const res = { doc, summary: summary(quick, doc, elapsed(), [...lines]) };
      cb.result?.(res, true);
      return res;
    }
  }
  cb.progress?.('placement', 'Placing machines', null);
  const sol = optimize(problem, {
    ...base,
    timeBudget: budget,
    onBest: (s) => {
      cb.progress?.('routing', s.ok ? 'Improving the layout' : 'Routing pipes', s);
      emit(s, options.valves, false);
    },
  });
  cb.progress?.('analysis', 'Checking splits and placing valves', sol);
  const analysis = analyse(problem, sol, options.valves);
  for (const [ni, plan, , withV] of analysis.groups) {
    if (withV < plan * 0.995) {
      log(
        `WARNING: ${problem.nodes[ni].name} runs at ${((100 * withV) / Math.max(plan, 1e-9)).toFixed(0)}% of plan in the built layout (even-split check)`,
      );
    }
  }
  log(
    `Footprint ${sol.width} x ${sol.height} = ${sol.area.toLocaleString('en-US')} tiles, ${sol.hull.empty.toLocaleString('en-US')} empty tiles inside the outline (${sol.ok ? 'fully routed' : 'NOT fully routed'})`,
  );
  const doc = toDoc(problem, sol, options.pinned, options.valves ? analysis : null);
  const result = { doc, summary: summary(sol, doc, elapsed(), [...lines]) };
  cb.result?.(result, true);
  cb.progress?.('done', 'Done', sol);
  return result;
}

export * from './types';
