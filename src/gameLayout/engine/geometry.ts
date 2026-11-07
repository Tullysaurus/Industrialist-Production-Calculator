/**
 * Machine footprints, ports and rotation (90 degree steps, no mirroring), plus the composite
 * footprints the planner models as one recipe (modular turbine, tree farm) and the logistics
 * pieces the layout adds itself (valve controls, pipe adapters).
 */

export type Side = 'top' | 'right' | 'bottom' | 'left';
export type PortKind = 'Item' | 'Fluid';
export type PortDirection = 'input' | 'output' | 'both';
export type Cell = readonly [number, number];

export const SIDES: readonly Side[] = ['top', 'right', 'bottom', 'left'];
const ROT_SIDE: Record<Side, Side> = { top: 'right', right: 'bottom', bottom: 'left', left: 'top' };
export const OUTWARD: Record<Side, Cell> = {
  top: [0, -1],
  bottom: [0, 1],
  left: [-1, 0],
  right: [1, 0],
};

export function rotateSide(side: Side, k: number): Side {
  let s = side;
  for (let i = 0; i < ((k % 4) + 4) % 4; i++) s = ROT_SIDE[s];
  return s;
}

export interface Port {
  id: string;
  kind: PortKind;
  direction: PortDirection;
  side: Side;
  /** Tiles of the machine (local coordinates) the port occupies. */
  cells: Cell[];
  width: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  machineId: string;
}

export interface Shape {
  id: string;
  name: string;
  w: number;
  h: number;
  rects: Rect[];
  ports: Map<string, Port>;
  category: string;
  /** Rotations 0..3 (index 0 is the shape itself). */
  rotations?: Shape[];
}

/** Tiles directly outside the port where a normal pipe attaches. */
export function accessCells(port: Port): Cell[] {
  const [dx, dy] = OUTWARD[port.side];
  return port.cells.map(([x, y]) => [x + dx, y + dy] as const);
}

/** Top-left tile of the 2x2 large pipe that attaches to this port. */
export function largeAnchor(port: Port): Cell {
  let x0 = Infinity;
  let y0 = Infinity;
  for (const [x, y] of port.cells) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
  }
  switch (port.side) {
    case 'top':
      return [x0, y0 - 2];
    case 'bottom':
      return [x0, y0 + 1];
    case 'left':
      return [x0 - 2, y0];
    default:
      return [x0 + 1, y0];
  }
}

function rotatePort(p: Port, h: number): Port {
  const cells = p.cells
    .map(([x, y]) => [h - 1 - y, x] as const)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return { ...p, side: ROT_SIDE[p.side], cells };
}

function rotatedOnce(s: Shape): Shape {
  const { w, h } = s;
  const rects = s.rects.map((r) => ({ ...r, x: h - r.y - r.h, y: r.x, w: r.h, h: r.w }));
  const ports = new Map<string, Port>();
  for (const [id, p] of s.ports) ports.set(id, rotatePort(p, h));
  void w;
  return { id: s.id, name: s.name, w: h, h: w, rects, ports, category: s.category };
}

/** The shape rotated k quarter turns clockwise (cached). */
export function rot(s: Shape, k: number): Shape {
  const r = ((k % 4) + 4) % 4;
  if (r === 0) return s;
  if (!s.rotations) {
    const r1 = rotatedOnce(s);
    const r2 = rotatedOnce(r1);
    const r3 = rotatedOnce(r2);
    s.rotations = [s, r1, r2, r3];
  }
  return s.rotations[r];
}

export function* occupied(s: Shape): Generator<Cell> {
  for (const r of s.rects) {
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) yield [x, y];
    }
  }
}

export function shapeArea(s: Shape): number {
  let a = 0;
  for (const r of s.rects) a += r.w * r.h;
  return a;
}

// ------------------------------------------------------------------ machines.json

export interface MachinePortData {
  id: string;
  type?: string;
  direction: PortDirection;
  x: number;
  y: number;
  width?: number;
  side?: Side;
  product_type?: PortKind;
}

export interface MachineData {
  id: string;
  name: string;
  size: { x: number; y: number };
  category?: string;
  ports?: MachinePortData[];
  cost?: number;
}

function portCells(p: MachinePortData): Cell[] {
  const w = Math.max(1, Math.round(p.width ?? 1));
  const out: Cell[] = [];
  for (let i = 0; i < w; i++) {
    out.push(p.side === 'top' || p.side === 'bottom' ? [p.x + i, p.y] : [p.x, p.y + i]);
  }
  return out;
}

export function machineShape(m: MachineData): Shape {
  const w = Math.max(1, Math.round(m.size.x));
  const h = Math.max(1, Math.round(m.size.y));
  const ports = new Map<string, Port>();
  for (const p of m.ports ?? []) {
    // power / data ports are not routed (no pole data)
    if (p.type !== 'product' || !p.side) continue;
    ports.set(p.id, {
      id: p.id,
      kind: p.product_type ?? 'Item',
      direction: p.direction,
      side: p.side,
      cells: portCells(p),
      width: Math.max(1, Math.round(p.width ?? 1)),
    });
  }
  return {
    id: m.id,
    name: m.name,
    w,
    h,
    rects: [{ x: 0, y: 0, w, h, label: m.name, machineId: m.id }],
    ports,
    category: m.category ?? '',
  };
}

// ------------------------------------------------------------------ composites

/** Assembles several machine shapes into one footprint. */
export class Composite {
  private rects: Rect[] = [];
  private ports = new Map<string, Port>();
  private count = new Map<string, number>();
  readonly id: string;
  readonly name: string;

  constructor(id: string, name: string) {
    this.id = id;
    this.name = name;
  }

  add(shape: Shape, x: number, y: number, keepPorts = true): void {
    for (const r of shape.rects) this.rects.push({ ...r, x: r.x + x, y: r.y + y });
    if (!keepPorts) return;
    for (const [pid, p] of shape.ports) {
      const n = this.count.get(pid) ?? 0;
      this.count.set(pid, n + 1);
      const id = `${pid}#${n}`;
      this.ports.set(id, { ...p, id, cells: p.cells.map(([cx, cy]) => [cx + x, cy + y] as const) });
    }
  }

  build(category = 'Composite'): Shape {
    let minx = Infinity;
    let miny = Infinity;
    let maxx = -Infinity;
    let maxy = -Infinity;
    for (const r of this.rects) {
      minx = Math.min(minx, r.x);
      miny = Math.min(miny, r.y);
      maxx = Math.max(maxx, r.x + r.w);
      maxy = Math.max(maxy, r.y + r.h);
    }
    const rects = this.rects.map((r) => ({ ...r, x: r.x - minx, y: r.y - miny }));
    const ports = new Map<string, Port>();
    for (const [id, p] of this.ports) {
      ports.set(id, { ...p, cells: p.cells.map(([x, y]) => [x - minx, y - miny] as const) });
    }
    return { id: this.id, name: this.name, w: maxx - minx, h: maxy - miny, rects, ports, category };
  }
}

/** Turbine input, n LPT, 1 IPT, n HPT, generator, turbine output, laid end to end. */
export function modularTurbine(shapes: Map<string, Shape>, nLpt: number, nHpt: number): Shape {
  const parts = [
    'm_turbine_input',
    ...Array<string>(nLpt).fill('m_low_pressure_turbine'),
    'm_intermediate_pressure_turbine',
    ...Array<string>(nHpt).fill('m_high_pressure_turbine'),
    'm_turbine_generator',
    'm_turbine_output',
  ];
  const c = new Composite(
    `modular_turbine_${nLpt}l_${nHpt}h`,
    `Modular Turbine (${nLpt} LPT, ${nHpt} HPT)`,
  );
  const present = parts.filter((p) => shapes.has(p));
  const height = Math.max(...present.map((p) => shapes.get(p)!.h));
  let x = 0;
  for (const p of present) {
    const s = shapes.get(p)!;
    c.add(
      s,
      x,
      Math.floor((height - s.h) / 2),
      p === 'm_turbine_input' || p === 'm_turbine_output',
    );
    x += s.w;
  }
  return c.build();
}

export interface TreeFarmSettings {
  treeCount: number;
  harvesterCount: number;
  sprinklerCount: number;
  outputsCount: number;
  treeId: string;
  controllerId: string;
}

/**
 * Tree farm following the wiki guide: a 7x7 block of tree cells (corners cut) around each
 * sprinkler, harvesters on the outer corners, outputs in the cut corners between the squares,
 * controller + water tanks in a strip above the farm.
 */
export function treeFarm(
  shapes: Map<string, Shape>,
  st: TreeFarmSettings,
  treesPerSprinkler = 44,
): Shape {
  const T = Math.max(1, Math.round(st.treeCount));
  const H = Math.max(0, Math.round(st.harvesterCount));
  const sReq = Math.max(1, Math.round(st.sprinklerCount));
  const O = Math.max(1, Math.round(st.outputsCount));
  const tree = shapes.get(st.treeId) ?? shapes.get('m_tree')!;
  const ctrl = shapes.get(st.controllerId) ?? shapes.get('m_tree_farm_controller')!;
  const spr = shapes.get('m_tree_farm_sprinkler')!;
  const harv = shapes.get('m_farm_harvester')!;
  const out = shapes.get('m_tree_farm_output')!;
  const tank = shapes.get('m_tree_farm_water_tank')!;
  const c = tree.w;

  const S = Math.max(1, Math.ceil(T / treesPerSprinkler));
  const comp = new Composite('tree_farm', `Tree Farm (${T} trees)`);
  const sprinklers: Cell[] = [];
  for (let s = 0; s < S; s++) sprinklers.push([7 * s + 3, 3]);
  const key = (x: number, y: number) => `${x},${y}`;
  const corners = new Set<string>();
  for (let s = 0; s < S; s++) {
    for (const a of [0, 6]) for (const b of [0, 6]) corners.add(key(7 * s + a, b));
  }
  const sprSet = new Set(sprinklers.map(([x, y]) => key(x, y)));
  const slots: Cell[] = [];
  for (let y = 0; y < 7; y++) {
    for (let x = 0; x < 7 * S; x++) {
      if (!corners.has(key(x, y)) && !sprSet.has(key(x, y))) slots.push([x, y]);
    }
  }
  const dist = ([cx, cy]: Cell) =>
    Math.min(
      ...sprinklers.map(
        ([sx, sy]) =>
          Math.max(Math.abs(cx - sx), Math.abs(cy - sy)) + 0.01 * Math.hypot(cx - sx, cy - sy),
      ),
    );
  slots.sort((a, b) => dist(a) - dist(b));
  const treeCells = slots.slice(0, T);
  const spare = slots.slice(T);
  for (const [cx, cy] of treeCells) comp.add(tree, cx * c, cy * c);
  for (const [cx, cy] of sprinklers) comp.add(spr, cx * c, cy * c);

  const bottomSeams: Cell[] = [];
  const topSeams: Cell[] = [];
  for (let s = 0; s < S - 1; s++) {
    for (const a of [6, 7]) {
      bottomSeams.push([7 * s + a, 6]);
      topSeams.push([7 * s + a, 0]);
    }
  }
  const bottomFree = [...bottomSeams, ...spare.filter((cl) => cl[1] === 6)];
  const otherFree = [...topSeams, ...spare.filter((cl) => cl[1] !== 6)];
  // outputs need their (bottom) port to face open space -> bottom seams first
  const overflowBottom: Shape[] = [];
  for (let i = 0; i < O; i++) {
    const cl = bottomFree.shift();
    if (cl) comp.add(out, cl[0] * c, cl[1] * c);
    else overflowBottom.push(out);
  }
  const free = [...otherFree, ...bottomFree];
  for (let i = 0; i < Math.max(0, sReq - S); i++) {
    const cl = free.shift();
    if (cl) comp.add(spr, cl[0] * c, cl[1] * c);
    else overflowBottom.push(spr);
  }
  // harvesters (2x2 cells) covering the outer cut corners, extras in rows above the farm
  const hpos: Cell[] = [
    [-1, -1],
    [7 * S - 1, -1],
    [-1, 6],
    [7 * S - 1, 6],
  ];
  const perRow = Math.max(1, Math.floor((7 * S - 2) / 2));
  for (let i = 0; i < H; i++) {
    if (i < 4) {
      comp.add(harv, hpos[i][0] * c, hpos[i][1] * c);
    } else {
      const k = i - 4;
      const row = Math.floor(k / perRow);
      const col = k % perRow;
      comp.add(harv, (1 + 2 * col) * c, (-3 - 2 * row) * c);
    }
  }
  const harvRows = H > 4 ? Math.ceil((H - 4) / perRow) : 0;
  // strip above: water tanks (1 per 3 sprinklers) + controller, ports face up/out
  const nTanks = Math.max(1, Math.ceil(Math.max(S, sReq) / 3));
  const items: Shape[] = [...Array<Shape>(nTanks).fill(tank), ctrl];
  // below the harvester rows when there are extra harvesters, so they never overlap
  const stripTop = harvRows > 0 ? -(1 + 2 * harvRows) * c - 1 : 0;
  let x = c;
  let x1 = (7 * S - 1) * c;
  let row = 0;
  for (const it of items) {
    if (x + it.w > x1) {
      row += 1;
      x = -c;
      x1 = (7 * S + 1) * c;
    }
    const y = stripTop - c * (row + 1) - row - (it.h - c);
    comp.add(it, x, y);
    x += it.w;
  }
  // anything that did not fit in the cut corners goes in a row under the farm
  x = c;
  for (const it of overflowBottom) {
    comp.add(it, x, 7 * c);
    x += it.w + 1;
  }
  return comp.build();
}

// ------------------------------------------------------------------ logistics pieces

/**
 * 3x1 fluid / item valve control: in at the left end, straight out at the right end, side out
 * of the middle tile (bottom).
 */
export function valveShape(kind: PortKind): Shape {
  const ports = new Map<string, Port>([
    [
      'valve_in',
      { id: 'valve_in', kind, direction: 'input', side: 'left', cells: [[0, 0]], width: 1 },
    ],
    [
      'valve_straight',
      { id: 'valve_straight', kind, direction: 'output', side: 'right', cells: [[2, 0]], width: 1 },
    ],
    [
      'valve_side',
      { id: 'valve_side', kind, direction: 'output', side: 'bottom', cells: [[1, 0]], width: 1 },
    ],
  ]);
  const id = `valve_${kind.toLowerCase()}`;
  const name = kind === 'Fluid' ? 'Fluid Valve Control' : 'Item Valve Control';
  return {
    id,
    name,
    w: 3,
    h: 1,
    rects: [{ x: 0, y: 0, w: 3, h: 1, label: 'Valve', machineId: id }],
    ports,
    category: 'Logistics',
  };
}

export const ADAPTER_SIZE = 4;
export const ADAPTER_SMALL_PORTS = 8;

/**
 * 4x4 large <-> small fluid pipe adapter. One 2-wide large port centred on the top side and
 * eight 1-wide small ports in a U: the lower two tiles of the left side, all four tiles of the
 * bottom and the lower two tiles of the right side (the bottom corner tiles have a port on both
 * of their outer sides). It works in both directions and any subset of the small ports may be
 * used, so it also splits / merges small pipes.
 */
export function adapterShape(smallToLarge: boolean): Shape {
  const n = ADAPTER_SIZE;
  const mid = n / 2;
  const large: PortDirection = smallToLarge ? 'output' : 'input';
  const small: PortDirection = smallToLarge ? 'input' : 'output';
  const ports = new Map<string, Port>();
  ports.set('adapter_large', {
    id: 'adapter_large',
    kind: 'Fluid',
    direction: large,
    side: 'top',
    cells: [
      [mid - 1, 0],
      [mid, 0],
    ],
    width: 2,
  });
  const smallCells: [Side, Cell][] = [
    ['left', [0, n - 2]],
    ['left', [0, n - 1]],
    ['bottom', [0, n - 1]],
    ['bottom', [1, n - 1]],
    ['bottom', [2, n - 1]],
    ['bottom', [3, n - 1]],
    ['right', [n - 1, n - 1]],
    ['right', [n - 1, n - 2]],
  ];
  smallCells.forEach(([side, cell], i) => {
    const id = `adapter_small_${i + 1}`;
    ports.set(id, { id, kind: 'Fluid', direction: small, side, cells: [cell], width: 1 });
  });
  const id = smallToLarge ? 'pipe_adapter_s2l' : 'pipe_adapter_l2s';
  return {
    id,
    name: 'Pipe Adapter',
    w: n,
    h: n,
    rects: [{ x: 0, y: 0, w: n, h: n, label: 'Adapter', machineId: id }],
    ports,
    category: 'Logistics',
  };
}

export function adapterSmallPortIds(): string[] {
  return Array.from({ length: ADAPTER_SMALL_PORTS }, (_u, i) => `adapter_small_${i + 1}`);
}
