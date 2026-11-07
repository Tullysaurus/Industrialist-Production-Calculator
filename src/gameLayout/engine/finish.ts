/**
 * Last steps of a layout: the flow analysis with junction valves, and those valves as pieces.
 */
import type { GameLayoutDoc } from '../docSchema';
import { valveGeometry } from '../doc';
import { Analysis } from './flows';
import type { Problem } from './problem';
import { key, kx, ky, type Solution } from './solution';
import { placeValves } from './valves';

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

/**
 * Junction valves the analysis laid on routed pipes, as valve pieces (only on `nets` when
 * given).
 */
export function withJunctionValves(
  base: GameLayoutDoc,
  analysis: Analysis,
  nets?: Set<number>,
): GameLayoutDoc {
  let doc = base;
  for (const v of analysis.placed) {
    if (nets && !nets.has(v.net)) continue;
    const [A, M, E] = v.tiles;
    const j = analysis.nets[v.net].junctions.get(M);
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
  return doc;
}
