/** Everything the in-game view needs, in layout coordinates (top-left of the footprint = 0, 0). */
import type { Analysis } from './flows';
import { edgeKey } from './flows';
import { shapeArea } from './geometry';
import type { Problem } from './problem';
import { kx, ky, type Solution } from './solution';
import type { LayoutResult, ResultJunctionValve, ResultMachine, ResultPipe, XY } from './types';

export function exportResult(
  problem: Problem,
  sol: Solution,
  analysis: Analysis | null,
  elapsed: number,
  log: string[],
  opts: { origin?: [number, number] } = {},
): LayoutResult {
  const [bx0, by0, x1, y1] = sol.bbox;
  // the generator exports relative to its footprint; the editor keeps document coordinates
  const [x0, y0] = opts.origin ?? [bx0, by0];
  const P = (c: number): XY => [kx(c) - x0, ky(c) - y0];
  const fixLabel = (lbl: string) => {
    const m = /^pipe \((-?\d+), (-?\d+)\)$/.exec(lbl);
    return m ? `pipe (${Number(m[1]) - x0}, ${Number(m[2]) - y0})` : lbl;
  };
  const groupsBy = new Map((analysis?.groups ?? []).map(([ni, pl, ev, vv]) => [ni, [pl, ev, vv]]));
  const portUse = new Map<string, [number, number | null]>();
  problem.nets.forEach((net, ni) => {
    for (const t of net.terminals)
      for (const pid of t.ports) portUse.set(`${t.inst}|${pid}`, [ni, t.rate]);
  });
  const valveOf = new Map(problem.valves.map((v) => [v.inst, v]));
  const pipeTiles = new Set<number>();
  for (const c of sol.cells) for (const t of c) pipeTiles.add(t);

  const machines: ResultMachine[] = sol.machines.map((m) => {
    const node = problem.nodes[m.node];
    const util = node.count ? node.machineCount / node.count : 0;
    const io: ResultMachine['io'] = { inputs: [], outputs: [] };
    for (const s of [...node.slots.values()].sort((a, b) => a.idx - b.idx)) {
      if (s.rate === null) continue;
      (s.direction === 'input' ? io.inputs : io.outputs).push({
        product: s.product ? (problem.productNames.get(s.product) ?? s.product) : '?',
        maxRate: s.rate,
        plannedRate: s.rate * util,
        temperature: s.temperature,
        selfFeed: node.count ? s.selfFeed / node.count : 0,
        voidable: s.voidable,
      });
    }
    const v = valveOf.get(m.inst);
    return {
      inst: m.inst,
      key: `${node.id}#${m.local}`,
      group: m.node,
      name: node.name,
      machine: node.shape.name,
      recipe: node.recipeId,
      index: m.local + 1,
      count: node.count,
      x: m.x - x0,
      y: m.y - y0,
      w: m.shape.w,
      h: m.shape.h,
      rotation: m.rot * 90,
      rects: m.shape.rects.map((r) => [r.x + m.x - x0, r.y + m.y - y0, r.w, r.h, r.label]),
      ports: [...m.shape.ports.values()].map((pt) => {
        const use = portUse.get(`${m.inst}|${pt.id}`);
        return {
          id: pt.id,
          cells: pt.cells.map(([cx, cy]) => [m.x + cx - x0, m.y + cy - y0] as XY),
          side: pt.side,
          kind: pt.kind,
          direction: pt.direction,
          width: pt.width,
          net: use ? use[0] : null,
          rate: use ? use[1] : null,
        };
      }),
      io,
      valve: v
        ? {
            product: v.product,
            sidePct: v.sidePct,
            straightPct: v.straightPct,
            flow: v.flow,
            sideFlow: v.sideFlow,
            index: v.index,
            of: v.of,
          }
        : null,
      synthetic: node.synthetic ?? null,
      run: {
        planned: analysis?.plannedRun[m.inst] ?? util,
        evenSplit: analysis?.runEven?.[m.inst] ?? null,
        built: analysis?.runValve?.[m.inst] ?? null,
      },
    };
  });

  const pipes: ResultPipe[] = problem.nets.map((net, ni) => {
    const nf = analysis?.nets[ni];
    const segments: ResultPipe['segments'] = [];
    const e = sol.netEdges[ni];
    for (let i = 0; i < e.length; i += 3) {
      let a = e[i];
      let b = e[i + 1];
      if (nf && nf.flow(b, a) > nf.flow(a, b)) [a, b] = [b, a];
      const [ax, ay] = P(a);
      const [bx, by] = P(b);
      segments.push([
        ax,
        ay,
        bx,
        by,
        nf ? nf.flow(a, b) : 0,
        nf ? (nf.simFlow.get(edgeKey(a, b)) ?? null) : null,
        nf ? (nf.valveFlow.get(edgeKey(a, b)) ?? null) : null,
      ]);
    }
    const valveJson = (
      v: NonNullable<ReturnType<NonNullable<typeof nf>['junctions']['get']>>['valve'],
    ) =>
      v
        ? ({
            ok: v.ok,
            why: v.why,
            straightPct: v.straightPct,
            sidePct: v.sidePct,
            tiles: v.tiles.map(P),
            split: v.split.map(([l, p]) => [fixLabel(l), p] as [string, number]),
          } satisfies ResultJunctionValve)
        : null;
    return {
      index: ni,
      label: net.label,
      product: net.productName,
      kind: net.kind,
      large: net.large,
      flow: net.flow,
      capacity: net.capacity,
      temperature: net.temperature,
      routed: !sol.failed.has(ni),
      segments,
      nodes: [...sol.netNodes[ni]].sort((a, b) => a - b).map(P),
      junctions: nf
        ? [...nf.junctions.values()]
            .filter((j) => j.kind !== 'pass')
            .map((j) => ({
              at: P(j.node),
              kind: j.kind as 'split' | 'merge' | 'mix' | 'end',
              ins: j.ins.map(([l, f]) => [fixLabel(l), f] as [string, number]),
              outs: j.outs.map(([l, f]) => [fixLabel(l), f] as [string, number]),
              evenOk: j.evenOk,
              valve: valveJson(j.valve),
            }))
        : [],
      terminals: nf
        ? nf.terms.map((ti) => {
            const [nIdx, li] = problem.instances[ti.t.inst];
            return {
              inst: ti.t.inst,
              machine: `${problem.nodes[nIdx].shape.name} #${li + 1}`,
              direction: ti.t.direction,
              rate: ti.t.rate,
              maxRate: ti.t.capacity,
              at: ti.node === null ? null : P(ti.node),
              port: ti.portCells.map(P),
            };
          })
        : [],
      note: nf?.balancedNote ?? '',
    };
  });

  return {
    version: 1,
    createdAt: Date.now(),
    footprint: { width: x1 - bx0, height: y1 - by0, area: (x1 - bx0) * (y1 - by0) },
    fullyRouted: sol.ok,
    elapsed,
    layoutStats: {
      machines: sol.machines.length,
      machineTiles: sol.machines.reduce((a, m) => a + shapeArea(m.shape), 0),
      pipeNetworks: problem.nets.length,
      pipeTiles: pipeTiles.size,
      overfullTiles: sol.overfull().length,
      unrouted: sol.failed.size,
      valves: problem.valves.length + (analysis?.placed.length ?? 0),
      valvesNeededUnplaced: analysis?.unplaced.length ?? 0,
      passthroughs: sol.passthroughs.length,
    },
    passthroughs: sol.passthroughs.map((p) => ({
      x: p.x - x0,
      y: p.y - y0,
      w: p.w,
      h: p.h,
      kind: p.kind,
      largeNet: p.largeNet,
      slots: p.slots,
    })),
    groups: problem.nodes.map((node, ni) => {
      const g = groupsBy.get(ni);
      return {
        index: ni,
        id: node.id,
        name: node.name,
        recipe: node.recipeId,
        machine: node.shape.name,
        count: node.count,
        planned: node.machineCount,
        achievable: node.effectiveCount,
        evenSplit: g ? g[1] : null,
        withValves: g ? g[2] : null,
        synthetic: node.synthetic ?? null,
      };
    }),
    machines,
    pipes,
    warnings: problem.warnings,
    notes: problem.notes,
    selfFeeds: problem.selfFeeds.map((f) => ({
      node: problem.nodes[f.node].id,
      name: problem.nodes[f.node].name,
      output: f.output,
      input: f.input,
      flow: f.flow,
    })),
    log,
  };
}
