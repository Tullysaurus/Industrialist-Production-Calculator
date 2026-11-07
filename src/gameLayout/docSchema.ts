/**
 * The in-game layout document: what the player built, stored with the save. Machines are keyed
 * by their flowchart node and instance number, pipes by the flowchart connection they carry,
 * so the document survives reloads and is re-matched when the flowchart changes.
 *
 * Coordinates are tiles. Flat number arrays keep large layouts small in the save file.
 */

export interface DocMachine {
  /** `${flowchart node id}#${instance index}` (adapters: `adapter-s2l#0`). */
  key: string;
  x: number;
  y: number;
  /** Quarter turns clockwise. */
  rot: number;
  pinned?: boolean;
  /** Last known footprint, so an orphaned machine (node removed) can still be drawn. */
  name: string;
  w: number;
  h: number;
}

export interface DocPipe {
  /** Key of the pipe network (product | connected node slots | split index). */
  net: string;
  large: boolean;
  /** Flat [x, y, ...]: tiles (normal pipe) or 2x2 anchors (large pipe). */
  nodes: number[];
  /** Flat [ax, ay, bx, by, kind, ...]; kind: 0 step, 1 quantum hop, 2 passthrough, 3 intersection, 4 into a node spot (quantum). */
  edges: number[];
  pinned?: boolean;
  /** Product name when it was routed (for orphaned pipes). */
  label: string;
}

/** 3x1 valve control lying on a normal pipe: in at one end, straight out, side out of the middle. */
export interface DocValve {
  id: string;
  /** Top-left of the rotated 3x1 / 1x3 piece. */
  x: number;
  y: number;
  rot: number;
  /** Share sent out of the side, 0..100. */
  sidePct: number;
  pinned?: boolean;
}

/** 4x2 / 2x4 large pipe passthrough with two crossing slots in its middle tiles. */
export interface DocPassthrough {
  id: string;
  x: number;
  y: number;
  /** true: the large pipe runs horizontally (4 wide, 2 tall). */
  horizontal: boolean;
  kind: 'Item' | 'Fluid';
  pinned?: boolean;
}

/** 2x2 large pipe intersection. */
export interface DocIntersection {
  id: string;
  x: number;
  y: number;
  pinned?: boolean;
}

/** Power piece: HV pole (12x12), MV pole (2x1), HV transformer (8x8), grid connection (2x2). */
export interface DocPowerPiece {
  id: string;
  kind: 'hv' | 'mv' | 'transformer' | 'grid';
  x: number;
  y: number;
  rot: number;
  /** Id of the piece it takes its power from. */
  feed?: string;
  pinned?: boolean;
}

export interface GameLayoutDoc {
  version: 1;
  machines: DocMachine[];
  pipes: DocPipe[];
  valves: DocValve[];
  passthroughs: DocPassthrough[];
  intersections: DocIntersection[];
  /** Power poles, transformers and the grid connection (missing in older saves). */
  power?: DocPowerPiece[];
  /**
   * Which pole feeds each machine power connection: `${machine key}|${n}` -> power piece id
   * (kept as laid out while still valid; capacity is counted in this order).
   */
  powerFeeds?: Record<string, string>;
}

export function emptyLayoutDoc(): GameLayoutDoc {
  return { version: 1, machines: [], pipes: [], valves: [], passthroughs: [], intersections: [] };
}

// ------------------------------------------------------------------ validation (save files)

function fail(path: string, message: string): never {
  throw new Error(`gameLayout.${path} ${message}`);
}

function rec(v: unknown, path: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(path, 'must be an object');
  return v as Record<string, unknown>;
}

function int(v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || Math.abs(v) > 1e6) {
    fail(path, 'must be an integer tile coordinate');
  }
  return v;
}

function str(v: unknown, path: string, max = 400): string {
  if (typeof v !== 'string' || v.length > max) fail(path, 'must be a string');
  return v;
}

function arr(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) fail(path, 'must be an array');
  return v;
}

function ints(v: unknown, path: string, group: number): number[] {
  const a = arr(v, path);
  if (a.length % group) fail(path, `must hold groups of ${group} numbers`);
  return a.map((x, i) => int(x, `${path}[${i}]`));
}

const pin = (o: Record<string, unknown>) => (o.pinned === true ? { pinned: true } : {});

/** Validate and normalise a stored layout document (throws with a readable path). */
export function normalizeLayoutDoc(value: unknown): GameLayoutDoc {
  const d = rec(value, '');
  if (d.version !== 1) fail('version', 'is not a supported in-game layout version');
  const machines = arr(d.machines, 'machines').map((raw, i) => {
    const m = rec(raw, `machines[${i}]`);
    return {
      key: str(m.key, `machines[${i}].key`),
      x: int(m.x, `machines[${i}].x`),
      y: int(m.y, `machines[${i}].y`),
      rot: ((int(m.rot, `machines[${i}].rot`) % 4) + 4) % 4,
      ...pin(m),
      name: str(m.name ?? '', `machines[${i}].name`),
      w: Math.max(1, int(m.w ?? 1, `machines[${i}].w`)),
      h: Math.max(1, int(m.h ?? 1, `machines[${i}].h`)),
    } satisfies DocMachine;
  });
  const pipes = arr(d.pipes, 'pipes').map((raw, i) => {
    const p = rec(raw, `pipes[${i}]`);
    const edges = ints(p.edges, `pipes[${i}].edges`, 5);
    for (let k = 4; k < edges.length; k += 5) {
      if (edges[k] < 0 || edges[k] > 4) fail(`pipes[${i}].edges`, 'has an unknown segment kind');
    }
    return {
      net: str(p.net, `pipes[${i}].net`, 4000),
      large: p.large === true,
      nodes: ints(p.nodes, `pipes[${i}].nodes`, 2),
      edges,
      ...pin(p),
      label: str(p.label ?? '', `pipes[${i}].label`),
    } satisfies DocPipe;
  });
  const valves = arr(d.valves ?? [], 'valves').map((raw, i) => {
    const v = rec(raw, `valves[${i}]`);
    const pct = v.sidePct;
    if (typeof pct !== 'number' || !Number.isFinite(pct) || pct < 0 || pct > 100) {
      fail(`valves[${i}].sidePct`, 'must be a percentage');
    }
    return {
      id: str(v.id, `valves[${i}].id`),
      x: int(v.x, `valves[${i}].x`),
      y: int(v.y, `valves[${i}].y`),
      rot: ((int(v.rot, `valves[${i}].rot`) % 4) + 4) % 4,
      sidePct: pct,
      ...pin(v),
    } satisfies DocValve;
  });
  const passthroughs = arr(d.passthroughs ?? [], 'passthroughs').map((raw, i) => {
    const p = rec(raw, `passthroughs[${i}]`);
    if (p.kind !== 'Item' && p.kind !== 'Fluid')
      fail(`passthroughs[${i}].kind`, 'must be Item or Fluid');
    return {
      id: str(p.id, `passthroughs[${i}].id`),
      x: int(p.x, `passthroughs[${i}].x`),
      y: int(p.y, `passthroughs[${i}].y`),
      horizontal: p.horizontal === true,
      kind: p.kind,
      ...pin(p),
    } satisfies DocPassthrough;
  });
  const intersections = arr(d.intersections ?? [], 'intersections').map((raw, i) => {
    const p = rec(raw, `intersections[${i}]`);
    return {
      id: str(p.id, `intersections[${i}].id`),
      x: int(p.x, `intersections[${i}].x`),
      y: int(p.y, `intersections[${i}].y`),
      ...pin(p),
    } satisfies DocIntersection;
  });
  const power = arr(d.power ?? [], 'power').map((raw, i) => {
    const p = rec(raw, `power[${i}]`);
    if (p.kind !== 'hv' && p.kind !== 'mv' && p.kind !== 'transformer' && p.kind !== 'grid')
      fail(`power[${i}].kind`, 'must be hv, mv, transformer or grid');
    return {
      id: str(p.id, `power[${i}].id`),
      kind: p.kind,
      x: int(p.x, `power[${i}].x`),
      y: int(p.y, `power[${i}].y`),
      rot: ((int(p.rot ?? 0, `power[${i}].rot`) % 4) + 4) % 4,
      ...(typeof p.feed === 'string' ? { feed: str(p.feed, `power[${i}].feed`) } : {}),
      ...pin(p),
    } satisfies DocPowerPiece;
  });
  const powerFeeds: Record<string, string> = {};
  if (d.powerFeeds !== undefined) {
    for (const [k, v] of Object.entries(rec(d.powerFeeds, 'powerFeeds'))) {
      powerFeeds[str(k, 'powerFeeds key')] = str(v, `powerFeeds.${k}`);
    }
  }
  return {
    version: 1,
    machines,
    pipes,
    valves,
    passthroughs,
    intersections,
    // older saves have no power: keep the document as it was
    ...(d.power !== undefined ? { power } : {}),
    ...(d.powerFeeds !== undefined ? { powerFeeds } : {}),
  };
}
