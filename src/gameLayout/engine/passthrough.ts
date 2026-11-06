/**
 * Large fluid pipe passthroughs: a normal pipe crosses a large (2-wide) pipe only through a
 * 4x2 passthrough piece laid in line with a straight run of the large pipe. Its two middle
 * tiles each carry one crossing slot; both slots are the same kind (item or fluid), any slot
 * may be unused, and the slots may belong to different pipe networks.
 */
import type { PortKind } from './geometry';

export interface Crossing {
  net: number;
  kind: PortKind;
  /** First crossed tile (top / left of the two). */
  x: number;
  y: number;
  /** true: the normal pipe runs vertically, so the large pipe runs horizontally. */
  vertical: boolean;
}

export interface Passthrough {
  x: number;
  y: number;
  w: number;
  h: number;
  kind: PortKind;
  largeNet: number;
  /** Normal pipe networks in the two slots (-1 = unused). */
  slots: [number, number];
}

export interface TileQuery {
  /** Large net covering the tile: -1 none, -2 more than one. */
  largeOwner(x: number, y: number): number;
  occS(x: number, y: number): number;
  occX(x: number, y: number): number;
}

export function assignPassthroughs(
  crossings: Crossing[],
  q: TileQuery,
): { passthroughs: Passthrough[]; bad: [number, number][] } {
  const used = new Set<string>();
  const out: Passthrough[] = [];
  const bad: [number, number][] = [];
  // along: coordinate along the large pipe; band: first of its two rows / columns
  const tile = (vertical: boolean, band: number, along: number): [number, number] =>
    vertical ? [along, band] : [band, along];
  const groups = new Map<string, { c: Crossing; band: number; along: number; ln: number }[]>();
  for (const c of crossings) {
    const band = c.vertical ? c.y : c.x;
    const along = c.vertical ? c.x : c.y;
    const ln = q.largeOwner(c.x, c.y);
    const k = `${c.vertical ? 'v' : 'h'}|${band}|${ln}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push({ c, band, along, ln });
  }
  const areaOk = (
    vertical: boolean,
    band: number,
    start: number,
    slots: Set<number>,
    ln: number,
  ): boolean => {
    for (let p = start; p < start + 4; p++) {
      for (let k = 0; k < 2; k++) {
        const [x, y] = tile(vertical, band + k, p);
        if (used.has(`${x},${y}`)) return false;
        if (q.largeOwner(x, y) !== ln || q.occS(x, y)) return false;
        const mid = p === start + 1 || p === start + 2;
        if (q.occX(x, y) && !(mid && slots.has(p))) return false;
      }
      // straight run: the large pipe has no tile right beside the piece
      for (const k of [-1, 2]) {
        const [x, y] = tile(vertical, band + k, p);
        if (q.largeOwner(x, y) === ln) return false;
      }
    }
    return true;
  };
  for (const items of groups.values()) {
    items.sort((a, b) => a.along - b.along);
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const nxt = items[i + 1];
      const tries: [number, Set<number>, boolean][] = [];
      if (it.ln >= 0) {
        if (nxt && nxt.along === it.along + 1 && nxt.c.kind === it.c.kind) {
          tries.push([it.along - 1, new Set([it.along, nxt.along]), true]);
        }
        tries.push([it.along - 1, new Set([it.along]), false]);
        tries.push([it.along - 2, new Set([it.along]), false]);
      }
      let placed = false;
      for (const [start, slots, pair] of tries) {
        if (!areaOk(it.c.vertical, it.band, start, slots, it.ln)) continue;
        for (let p = start; p < start + 4; p++) {
          for (let k = 0; k < 2; k++) {
            const [x, y] = tile(it.c.vertical, it.band + k, p);
            used.add(`${x},${y}`);
          }
        }
        const [x, y] = tile(it.c.vertical, it.band, start);
        out.push({
          x,
          y,
          w: it.c.vertical ? 4 : 2,
          h: it.c.vertical ? 2 : 4,
          kind: it.c.kind,
          largeNet: it.ln,
          slots: [it.c.net, pair ? nxt.c.net : -1],
        });
        if (pair) i++;
        placed = true;
        break;
      }
      if (!placed) {
        const [x2, y2] = it.c.vertical ? [it.c.x, it.c.y + 1] : [it.c.x + 1, it.c.y];
        bad.push([it.c.x, it.c.y], [x2, y2]);
      }
    }
  }
  return { passthroughs: out, bad };
}
