/**
 * Orthogonal hull: the smallest set of tiles that contains the layout and meets every row and
 * every column in one unbroken run. Tiles inside it that hold nothing are the layout's empty
 * space; tiles outside it (notches of an L or T shape) are not counted.
 */

/** Fills `mask` (row-major, w x h, 1 = inside) to its orthogonal hull in place. */
export function fillOrthoHull(mask: Uint8Array, w: number, h: number): void {
  for (let changed = true; changed; ) {
    changed = false;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let a = -1;
      let b = -1;
      for (let x = 0; x < w; x++) {
        if (mask[row + x]) {
          if (a < 0) a = x;
          b = x;
        }
      }
      for (let x = a + 1; a >= 0 && x < b; x++) {
        if (!mask[row + x]) {
          mask[row + x] = 1;
          changed = true;
        }
      }
    }
    for (let x = 0; x < w; x++) {
      let a = -1;
      let b = -1;
      for (let y = 0; y < h; y++) {
        if (mask[y * w + x]) {
          if (a < 0) a = y;
          b = y;
        }
      }
      for (let y = a + 1; a >= 0 && y < b; y++) {
        if (!mask[y * w + x]) {
          mask[y * w + x] = 1;
          changed = true;
        }
      }
    }
  }
}

export interface HullStats {
  /** Tiles inside the orthogonal hull. */
  hull: number;
  /** Tiles that hold a machine or a pipe. */
  used: number;
  /** hull - used. */
  empty: number;
  /** Bounding box of the used tiles. */
  width: number;
  height: number;
}

/** Hull statistics of a set of used tiles given as a mask over their bounding box. */
export function hullStats(used: Uint8Array, w: number, h: number): HullStats {
  let n = 0;
  for (let i = 0; i < used.length; i++) n += used[i];
  const mask = used.slice();
  fillOrthoHull(mask, w, h);
  let hull = 0;
  for (let i = 0; i < mask.length; i++) hull += mask[i];
  return { hull, used: n, empty: hull - n, width: w, height: h };
}

/**
 * Hull area of a set of rectangles [x, y, w, h], computed on the grid of their distinct edges
 * (fast enough to run inside the placement annealing).
 */
export function rectHullArea(rects: ArrayLike<number>[]): number {
  const xs = [...new Set(rects.flatMap((r) => [r[0], r[0] + r[2]]))].sort((a, b) => a - b);
  const ys = [...new Set(rects.flatMap((r) => [r[1], r[1] + r[3]]))].sort((a, b) => a - b);
  const w = xs.length - 1;
  const h = ys.length - 1;
  if (w <= 0 || h <= 0) return 0;
  const xi = new Map(xs.map((v, i) => [v, i]));
  const yi = new Map(ys.map((v, i) => [v, i]));
  const mask = new Uint8Array(w * h);
  for (const r of rects) {
    if (r[2] <= 0 || r[3] <= 0) continue;
    const x0 = xi.get(r[0])!;
    const x1 = xi.get(r[0] + r[2])!;
    const y0 = yi.get(r[1])!;
    const y1 = yi.get(r[1] + r[3])!;
    for (let y = y0; y < y1; y++) mask.fill(1, y * w + x0, y * w + x1);
  }
  fillOrthoHull(mask, w, h);
  let area = 0;
  for (let y = 0; y < h; y++) {
    const ch = ys[y + 1] - ys[y];
    for (let x = 0; x < w; x++) if (mask[y * w + x]) area += (xs[x + 1] - xs[x]) * ch;
  }
  return area;
}

/**
 * Soft penalty for elongated layouts: nothing up to `free` : 1, then `weight` x hull area per
 * unit of aspect ratio beyond it.
 */
export function aspectPenalty(
  w: number,
  h: number,
  hull: number,
  weight = ASPECT_WEIGHT,
  free = ASPECT_FREE,
): number {
  if (w <= 0 || h <= 0) return 0;
  const r = Math.max(w, h) / Math.min(w, h);
  return r > free ? weight * hull * (r - free) : 0;
}

export const ASPECT_WEIGHT = 0.05;
export const ASPECT_FREE = 2.5;
