/**
 * 2x2 large pipe intersection geometry, shared by the router (grid indices, stride = grid
 * width) and the layout solution / editor (tile keys, stride = KX).
 *
 * An intersection keeps two large pipes apart whatever sides they use: each pipe enters and
 * leaves through its own sides (straight across or turning a corner); a single pipe may also
 * bend, split or merge inside one. The router models a pipe going through a piece as a
 * crossing edge between the large-pipe anchors right outside two sides of the piece.
 *
 * Sides are numbered by the direction pointing out of the piece: 0 right, 1 left, 2 bottom,
 * 3 top (the router's direction order). A pipe moving in direction d enters through side d ^ 1.
 */

export const SIDE_NAMES = ['right', 'left', 'bottom', 'top'] as const;

/** Anchor of the intersection a crossing edge a -> b goes through. */
export function lcrossMid(a: number, b: number, stride: number): number {
  const ax = a % stride;
  const bx = b % stride;
  // straight across: halfway; around a corner: the column of b in the row of a
  if (ax === bx || a - ax === b - bx) return a + (b - a) / 2;
  return a - ax + bx;
}

/** The crossing edge between side anchors c and m of the piece at f, ordered for lcrossMid. */
export function lcrossEdge(c: number, m: number, f: number, stride: number): [number, number] {
  return lcrossMid(c, m, stride) === f ? [c, m] : [m, c];
}

/** The two tiles right outside side k of the piece at f. */
export function sideTiles(f: number, k: number, stride: number): [number, number] {
  switch (k) {
    case 0:
      return [f + 2, f + 2 + stride];
    case 1:
      return [f - 1, f - 1 + stride];
    case 2:
      return [f + 2 * stride, f + 2 * stride + 1];
    default:
      return [f - stride, f - stride + 1];
  }
}

/** Anchor of the large pipe right outside side k of the piece at f. */
export function sideAnchor(f: number, k: number, stride: number): number {
  return [f + 2, f - 2, f + 2 * stride, f - 2 * stride][k];
}

/** Side of the piece at f that anchor a sits right outside of, or -1. */
export function sideOf(f: number, a: number, stride: number): number {
  for (let k = 0; k < 4; k++) if (sideAnchor(f, k, stride) === a) return k;
  return -1;
}

/** The four tiles of the piece at f. */
export function pieceTiles(f: number, stride: number): [number, number, number, number] {
  return [f, f + 1, f + stride, f + stride + 1];
}

/**
 * Which large pipe uses each side of the piece at f: the net covering both tiles outside it,
 * -1 when neither tile is covered, -2 when the side is covered partly or by different nets.
 * `owner(t)` is the large net on tile t (-1 none, -2 several).
 */
export function sideOwners(
  f: number,
  stride: number,
  owner: (t: number) => number,
): [number, number, number, number] {
  const out: [number, number, number, number] = [-1, -1, -1, -1];
  for (let k = 0; k < 4; k++) {
    const [p, q] = sideTiles(f, k, stride);
    const a = owner(p);
    const b = owner(q);
    out[k] = a === -1 && b === -1 ? -1 : a === b && a >= 0 ? a : -2;
  }
  return out;
}

/**
 * Rule check of one piece: one or two large pipes use it, each covers the whole piece, and
 * each side of it belongs to one of them (or to none). `owners(t)` lists the large nets on t.
 */
export function pieceOk(f: number, stride: number, owners: (t: number) => number[]): boolean {
  const tiles = pieceTiles(f, stride);
  const nets = new Set<number>();
  for (const t of tiles) for (const n of owners(t)) nets.add(n);
  if (nets.size < 1 || nets.size > 2) return false;
  for (const n of nets) if (!tiles.every((t) => owners(t).includes(n))) return false;
  for (let k = 0; k < 4; k++) {
    const [p, q] = sideTiles(f, k, stride);
    const a = owners(p).filter((n) => nets.has(n));
    const b = owners(q).filter((n) => nets.has(n));
    // a side is used by one of the pipes on the piece, fully, or by none of them
    if (a.length > 1 || b.length > 1 || a.length !== b.length || (a.length && a[0] !== b[0])) {
      return false;
    }
  }
  return true;
}
