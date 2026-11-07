/**
 * Which pipe goes where through a shared spot: a 2x2 large intersection piece, or a tile two
 * normal pipes share. Used by the viewer to draw each pipe's path and by the tooltip.
 *
 * Sides: 0 right, 1 left, 2 bottom, 3 top (see engine/intersection.ts).
 */
import { SIDE_NAMES, sideOwners } from './engine/intersection';
import { key, KX, kx, ky, type Solution } from './engine/solution';

export interface JunctionRoute {
  net: number;
  /** Sides the pipe enters / leaves through, ascending. */
  sides: number[];
}

/** Large pipes through the intersection piece with its top-left tile at (x, y). */
export function pieceRoutes(sol: Solution, x: number, y: number): JunctionRoute[] {
  const owners = sideOwners(key(x, y), KX, (t) => sol.largeOwner.get(t) ?? -1);
  return group(owners);
}

/** Normal pipes on a tile shared by two of them (empty unless two pipes share it). */
export function sharedTileRoutes(sol: Solution, c: number): JunctionRoute[] {
  if ((sol.occS.get(c) ?? 0) < 2) return [];
  const out: JunctionRoute[] = [];
  for (const [ni, sides] of sideCache(sol).get(c) ?? []) {
    out.push({ net: ni, sides: [...new Set(sides)].sort((a, b) => a - b) });
  }
  return out;
}

/** Tiles two normal pipes share. */
export function sharedTiles(sol: Solution): number[] {
  const out: number[] = [];
  for (const [c, n] of sol.occS) if (n >= 2) out.push(c);
  return out;
}

/** "top - right" style description of the sides a pipe uses. */
export function describeSides(sides: number[]): string {
  return sides.map((k) => SIDE_NAMES[k]).join(' - ');
}

function group(owners: number[]): JunctionRoute[] {
  const by = new Map<number, number[]>();
  owners.forEach((o, k) => {
    if (o < 0) return;
    let l = by.get(o);
    if (!l) by.set(o, (l = []));
    l.push(k);
  });
  return [...by].map(([net, sides]) => ({ net, sides }));
}

const cache = new WeakMap<Solution, Map<number, Map<number, number[]>>>();

/** Per shared tile: net -> sides its connections leave through. */
function sideCache(sol: Solution): Map<number, Map<number, number[]>> {
  let m = cache.get(sol);
  if (m) return m;
  m = new Map();
  const shared = new Set(sharedTiles(sol));
  const add = (c: number, ni: number, o: number) => {
    if (!shared.has(c)) return;
    const dx = Math.sign(kx(o) - kx(c));
    const dy = Math.sign(ky(o) - ky(c));
    const side = dx > 0 ? 0 : dx < 0 ? 1 : dy > 0 ? 2 : 3;
    let byNet = m!.get(c);
    if (!byNet) m!.set(c, (byNet = new Map()));
    let l = byNet.get(ni);
    if (!l) byNet.set(ni, (l = []));
    l.push(side);
  };
  sol.netEdges.forEach((e, ni) => {
    if (sol.problem.nets[ni].large) return;
    for (let i = 0; i < e.length; i += 3) {
      add(e[i], ni, e[i + 1]);
      add(e[i + 1], ni, e[i]);
    }
  });
  cache.set(sol, m);
  return m;
}
