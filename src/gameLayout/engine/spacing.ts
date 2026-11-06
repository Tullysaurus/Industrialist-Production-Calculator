/** Minimum-distance rule between machines of the same type. */

export type RectTuple = [number, number, number, number];

/** edge: empty tiles between the footprints (max of x / y gap); center: distance of centres. */
export function rectDistance(r1: RectTuple, r2: RectTuple, measure: 'edge' | 'center'): number {
  const [x1, y1, w1, h1] = r1;
  const [x2, y2, w2, h2] = r2;
  if (measure === 'center') {
    return Math.hypot(x1 + w1 / 2 - (x2 + w2 / 2), y1 + h1 / 2 - (y2 + h2 / 2));
  }
  const gx = Math.max(0, x2 - (x1 + w1), x1 - (x2 + w2));
  const gy = Math.max(0, y2 - (y1 + h1), y1 - (y2 + h2));
  return Math.max(gx, gy);
}

export interface SpacedRect {
  type: string;
  id: number;
  rect: RectTuple;
  min: number;
}

export function spacingViolations(
  rects: SpacedRect[],
  measure: 'edge' | 'center',
): { a: SpacedRect; b: SpacedRect; dist: number; need: number }[] {
  const out: { a: SpacedRect; b: SpacedRect; dist: number; need: number }[] = [];
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      if (rects[i].type !== rects[j].type) continue;
      const d = rectDistance(rects[i].rect, rects[j].rect, measure);
      if (d < rects[i].min - 1e-9)
        out.push({ a: rects[i], b: rects[j], dist: d, need: rects[i].min });
    }
  }
  return out;
}
