/**
 * Turns the planner graph (recipe nodes, edges and the website's solved flows) into machine
 * instances and pipe networks.
 *
 * Rates, products and port ids come straight from the website's flow pipeline (the resolved
 * recipes of every node, including special recipes). Port inference is only used for recipes
 * that list no port for a connected input / output.
 */
import {
  adapterShape,
  adapterSmallPortIds,
  machineShape,
  modularTurbine,
  treeFarm,
  valveShape,
  type MachineData,
  type PortKind,
  type Shape,
} from './geometry';
import type { LayoutInput, LayoutInputNode, LayoutConfig } from './types';

export interface Slot {
  idx: number;
  direction: 'input' | 'output';
  product: string | null;
  /** Units/s for one machine running at 100 %. */
  rate: number | null;
  kind: PortKind | null;
  ports: string[];
  /** Every listed port needs its own connection (tree farm). */
  requireAll: boolean;
  inferred: boolean;
  /** Planner flow on this slot (all machines of the node), /s. */
  connected: number | null;
  /** Part of `connected` that loops back into the same machine. */
  selfFeed: number;
  temperature: number | null;
  voidable: boolean;
}

export interface PNode {
  id: string;
  recipeId: string;
  name: string;
  shape: Shape;
  machineCount: number;
  /**
   * Machines' worth the plan can actually run, given the solved input flows (equal to
   * machineCount unless the planner itself is short of an input).
   */
  effectiveCount: number;
  count: number;
  known: boolean;
  slots: Map<string, Slot>;
  special: boolean;
  settings: Record<string, unknown>;
  powerUse: number | null;
  powerType: string | null;
  pollution: number | null;
  /** Synthetic piece added by the layout (valve, adapter). */
  synthetic?: 'valve' | 'adapter';
}

export type SlotRef = readonly [number, 'input' | 'output', number];

export interface Terminal {
  inst: number;
  /** Candidate port ids (the pipe may attach to any one of them). */
  ports: string[];
  /** "input": machine takes from the pipe, "output": machine feeds it. */
  direction: 'input' | 'output';
  /** Planned flow through this terminal, /s. */
  rate: number | null;
  /** What this machine takes / gives at 100 %, /s. */
  capacity: number | null;
  slot: SlotRef | null;
}

export interface Net {
  id: number;
  label: string;
  product: string | null;
  productName: string;
  kind: PortKind;
  large: boolean;
  flow: number | null;
  capacity: number;
  terminals: Terminal[];
  /** Stable id of this pipe network across rebuilds (for valve requests). */
  key: string;
  temperature: number | null;
}

export interface ValveInfo {
  inst: number;
  key: string;
  product: string;
  sidePct: number;
  straightPct: number;
  flow: number;
  sideFlow: number;
  index: number;
  of: number;
}

export interface Problem {
  nodes: PNode[];
  /** [node index, local index] per machine instance. */
  instances: [number, number][];
  nets: Net[];
  warnings: string[];
  notes: string[];
  spacing: Map<string, number>;
  spacingMeasure: 'edge' | 'center';
  productNames: Map<string, string>;
  selfFeeds: { node: number; output: number; input: number; flow: number }[];
  valves: ValveInfo[];
  instBase: number[];
}

export const DEFAULT_CONFIG: LayoutConfig = {
  pipeCapacity: { Item: 120, Fluid: 120, LargeFluid: 12000 },
  flowMargin: 0,
  treesPerSprinkler: 44,
  minSpacing: { m_mineshaft_drill: 48 },
  spacingMeasure: 'edge',
  valveNets: [],
};

export function prettyId(pid: string | null | undefined): string {
  if (!pid) return '?';
  return pid
    .replace(/^p_/, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

const EPS_COUNT = 2.220446049250313e-16 * 8;

export function ceilCount(v: number): number {
  if (!Number.isFinite(v) || v <= 1e-12) return 0;
  const r = Math.round(v);
  if (r > 0 && Math.abs(v - r) <= Math.abs(v) * EPS_COUNT + 1e-9) return r;
  return Math.ceil(v);
}

function machineFor(recipeId: string, machines: Map<string, MachineData>): string | null {
  const base = recipeId.replace(/^r_/, '').replace(/_\d+$/, '').toLowerCase();
  const parts = base.split('_');
  for (let n = parts.length; n > 0; n--) {
    const mid = `m_${parts.slice(0, n).join('_')}`;
    if (machines.has(mid)) return mid;
  }
  return null;
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' && v ? v : fallback;
}

const slotKey = (d: string, i: number) => `${d}:${i}`;

/** Recipe port ids -> ports of a composite footprint ("<id>#<n>"). */
function compositePorts(shape: Shape, recipePorts: string[]): string[] {
  const out: string[] = [];
  for (const rp of recipePorts) {
    for (const pid of shape.ports.keys()) {
      if (pid === rp || pid.startsWith(`${rp}#`)) out.push(pid);
    }
  }
  return out;
}

function portNumber(id: string): number {
  const tail = id.split('_port_').pop() ?? '';
  const digits = tail.replace(/\D/g, '');
  return digits ? parseInt(digits, 10) : 0;
}

export function buildProblem(input: LayoutInput, cfgOverrides?: Partial<LayoutConfig>): Problem {
  const cfg: LayoutConfig = {
    ...DEFAULT_CONFIG,
    ...cfgOverrides,
    pipeCapacity: { ...DEFAULT_CONFIG.pipeCapacity, ...(cfgOverrides?.pipeCapacity ?? {}) },
    minSpacing: { ...DEFAULT_CONFIG.minSpacing, ...(cfgOverrides?.minSpacing ?? {}) },
  };
  const machines = new Map(input.machines.map((m) => [m.id, m]));
  const productNames = new Map<string, string>();
  const productTypes = new Map<string, PortKind>();
  for (const p of input.products) {
    productNames.set(p.id, p.name);
    if (p.type === 'Item' || p.type === 'Fluid') productTypes.set(p.id, p.type);
  }
  const pname = (pid: string | null) => (pid ? (productNames.get(pid) ?? prettyId(pid)) : '?');
  const shapes = new Map<string, Shape>();
  for (const m of input.machines) shapes.set(m.id, machineShape(m));
  const portKind = new Map<string, PortKind>();
  for (const m of input.machines) {
    for (const p of m.ports ?? []) if (p.product_type) portKind.set(p.id, p.product_type);
  }

  const warnings: string[] = [];
  const notes: string[] = [];
  const nodes: PNode[] = [];
  const nodeIndex = new Map<string, number>();

  const usedSlots = new Map<string, Set<string>>();
  const markUsed = (nid: string, k: string) => {
    let s = usedSlots.get(nid);
    if (!s) usedSlots.set(nid, (s = new Set()));
    s.add(k);
  };
  for (const e of input.edges) {
    markUsed(e.source, slotKey('output', e.sourceIndex));
    markUsed(e.target, slotKey('input', e.targetIndex));
  }

  for (const n of input.nodes) {
    const node = buildNode(n);
    if (node) {
      nodeIndex.set(n.id, nodes.length);
      nodes.push(node);
    }
  }

  function buildNode(n: LayoutInputNode): PNode | null {
    const mc = n.machineCount > 0 ? n.machineCount : 0;
    if (mc <= 0) {
      warnings.push(`Skipped ${n.name}: machine count is 0`);
      return null;
    }
    const count = Math.max(1, ceilCount(mc));
    const rid = n.recipeId;
    const settings = n.settings ?? {};
    const recipe = n.recipe;
    let shape: Shape;
    if (rid.startsWith('r_modular_turbine')) {
      const lpt = Math.max(1, Math.round(num(settings.lpt_count, 5)));
      const hpt = Math.max(0, Math.round(num(settings.hpt_count, 1)));
      shape = modularTurbine(shapes, lpt, hpt);
      notes.push(
        `${n.name}: built modular turbine (input, ${lpt} LPT, 1 IPT, ${hpt} HPT, generator, output) = ${shape.w}x${shape.h}`,
      );
    } else if (rid.startsWith('r_tree_farm')) {
      shape = treeFarm(
        shapes,
        {
          treeCount: num(settings.tree_count, 600),
          harvesterCount: num(settings.harvester_count, 20),
          sprinklerCount: num(settings.sprinkler_count, 24),
          outputsCount: num(settings.outputs_count, 8),
          treeId: str(settings.tree_id, 'm_tree'),
          controllerId: str(settings.controller_id, 'm_tree_farm_controller'),
        },
        cfg.treesPerSprinkler,
      );
      notes.push(`${n.name}: built tree farm from the guide layout = ${shape.w}x${shape.h}`);
    } else if (recipe && shapes.has(recipe.machine_id)) {
      shape = shapes.get(recipe.machine_id)!;
    } else {
      const mid = machineFor(rid, machines);
      if (!mid) {
        warnings.push(`${n.name}: no machine found for recipe ${rid} - skipped`);
        return null;
      }
      shape = shapes.get(mid)!;
    }
    let name = n.name || shape.name;
    if (!name.includes(shape.name)) name = `${shape.name}: ${name}`;

    const slots = new Map<string, Slot>();
    const known = recipe !== null;
    if (recipe) {
      const cycle = recipe.cycle_time > 0 ? recipe.cycle_time : 1;
      for (const direction of ['input', 'output'] as const) {
        const ios = direction === 'input' ? recipe.inputs : recipe.outputs;
        const flows = direction === 'input' ? n.inputs : n.outputs;
        ios.forEach((io, i) => {
          let ports: string[];
          let requireAll = false;
          if (shape.id.startsWith('tree_farm')) {
            ports = [...shape.ports.values()]
              .filter((p) => p.direction === direction || p.direction === 'both')
              .map((p) => p.id);
            requireAll = true;
          } else if (shape.id.startsWith('modular_turbine')) {
            ports = compositePorts(shape, io.port_ids ?? []);
          } else {
            ports = (io.port_ids ?? []).filter((p) => shape.ports.has(p));
          }
          const kinds = new Set(ports.map((p) => shape.ports.get(p)!.kind));
          if (kinds.size === 0 && productTypes.has(io.product_id)) {
            kinds.add(productTypes.get(io.product_id)!);
          }
          const kind = kinds.size === 1 ? [...kinds][0] : null;
          // rate of one machine at 100 %; machine-count independent rates are shared
          const total = io.quantity / cycle;
          const rate = io.independentOfMachineCount ? total / count : total;
          const flow = flows[i];
          const slot: Slot = {
            idx: i,
            direction,
            product: io.product_id,
            rate,
            kind,
            ports,
            requireAll,
            inferred: false,
            connected: flow ? flow.connected : 0,
            selfFeed: 0,
            temperature: flow?.temperature ?? io.temperature ?? null,
            voidable: !!io.voidable,
          };
          if (!ports.length && usedSlots.get(n.id)?.has(slotKey(direction, i))) {
            warnings.push(
              `${name}: ${direction} ${pname(io.product_id)} lists no port of ${shape.name} - port inferred`,
            );
            slot.inferred = true;
          }
          slots.set(slotKey(direction, i), slot);
        });
      }
    } else {
      notes.push(
        `${rid}: recipe unknown -> assumed machine ${shape.name}; ports and rates inferred`,
      );
    }
    let frac = 1;
    if (recipe) {
      const cycle = recipe.cycle_time > 0 ? recipe.cycle_time : 1;
      recipe.inputs.forEach((io, i) => {
        const need = (io.quantity / cycle) * (io.independentOfMachineCount ? 1 : mc);
        if (need > 1e-12) frac = Math.min(frac, (n.inputs[i]?.connected ?? 0) / need);
      });
    }
    return {
      id: n.id,
      recipeId: rid,
      name,
      shape,
      machineCount: mc,
      effectiveCount: mc * Math.max(0, Math.min(1, frac)),
      count,
      known,
      slots,
      special: !!n.special,
      settings,
      powerUse: recipe?.power_consumption ?? null,
      powerType: recipe?.power_type ?? null,
      pollution: recipe?.pollution ?? null,
    };
  }

  // ---- group slots into nets (union find over edges; self loops handled separately)
  const parent = new Map<string, string>();
  const find = (a: string): string => {
    if (!parent.has(a)) parent.set(a, a);
    let r = a;
    while (parent.get(r) !== r) {
      const p = parent.get(parent.get(r)!)!;
      parent.set(r, p);
      r = p;
    }
    return r;
  };
  const union = (a: string, b: string) => parent.set(find(a), find(b));
  const refKey = (ni: number, d: string, i: number) => `${ni}|${d}|${i}`;
  const parseRef = (k: string): SlotRef => {
    const [a, d, i] = k.split('|');
    return [Number(a), d as 'input' | 'output', Number(i)];
  };
  const slotOf = (ni: number, d: string, i: number): Slot => {
    const node = nodes[ni];
    let s = node.slots.get(slotKey(d, i));
    if (!s) {
      s = {
        idx: i,
        direction: d as 'input' | 'output',
        product: null,
        rate: null,
        kind: null,
        ports: [],
        requireAll: false,
        inferred: true,
        connected: null,
        selfFeed: 0,
        temperature: null,
        voidable: false,
      };
      node.slots.set(slotKey(d, i), s);
    }
    return s;
  };

  const selfLoops: { a: string; b: string; flow: number }[] = [];
  for (const e of input.edges) {
    const si = nodeIndex.get(e.source);
    const ti = nodeIndex.get(e.target);
    if (si === undefined || ti === undefined) continue;
    const a = refKey(si, 'output', e.sourceIndex);
    const b = refKey(ti, 'input', e.targetIndex);
    slotOf(si, 'output', e.sourceIndex);
    slotOf(ti, 'input', e.targetIndex);
    if (e.source === e.target) {
      selfLoops.push({ a, b, flow: e.flow });
      find(a);
      find(b);
    } else {
      union(a, b);
    }
  }
  const comps = new Map<string, string[]>();
  for (const k of parent.keys()) {
    const r = find(k);
    if (!comps.has(r)) comps.set(r, []);
    comps.get(r)!.push(k);
  }
  const slotByKey = (k: string) => {
    const [ni, d, i] = parseRef(k);
    return slotOf(ni, d, i);
  };

  // ---- infer product / kind for unknown slots by propagating through nets
  const loopPairs = new Map<string, string[]>();
  for (const { a, b } of selfLoops) {
    const ra = find(a);
    const rb = find(b);
    if (!loopPairs.has(ra)) loopPairs.set(ra, []);
    if (!loopPairs.has(rb)) loopPairs.set(rb, []);
    loopPairs.get(ra)!.push(rb);
    loopPairs.get(rb)!.push(ra);
  }
  for (let guard = 0, changed = true; changed && guard < 50; guard++) {
    changed = false;
    for (const [root, members] of comps) {
      const kinds = new Set<PortKind>();
      const prods = new Set<string>();
      const scan = (ms: string[]) => {
        for (const k of ms) {
          const s = slotByKey(k);
          if (s.kind) kinds.add(s.kind);
          if (s.product) prods.add(s.product);
        }
      };
      scan(members);
      for (const other of loopPairs.get(root) ?? []) scan(comps.get(other) ?? []);
      for (const k of members) {
        const s = slotByKey(k);
        if (!s.kind && kinds.size === 1) {
          s.kind = [...kinds][0];
          changed = true;
        }
        if (!s.product && prods.size === 1) {
          s.product = [...prods][0];
          changed = true;
        }
      }
    }
    // per machine: an unknown slot can only be a kind that still has a free port
    for (const node of nodes) {
      for (const direction of ['input', 'output'] as const) {
        const group = [...node.slots.values()].filter((s) => s.direction === direction);
        const unknown = group.filter((s) => !s.kind && s.inferred);
        if (!unknown.length) continue;
        const count = new Map<PortKind, number>();
        for (const p of node.shape.ports.values()) {
          if (p.direction === direction || p.direction === 'both') {
            count.set(p.kind, (count.get(p.kind) ?? 0) + 1);
          }
        }
        for (const s of group) if (s.kind) count.set(s.kind, (count.get(s.kind) ?? 0) - 1);
        const possible = [...count].filter(([, c]) => c >= 1).map(([k]) => k);
        if (possible.length === 1) {
          for (const s of unknown) {
            s.kind = possible[0];
            changed = true;
          }
        }
      }
    }
  }

  // ---- assign ports to inferred slots
  for (const node of nodes) {
    for (const direction of ['input', 'output'] as const) {
      const all = [...node.slots.values()].filter((s) => s.direction === direction);
      const inferred = all
        .filter((s) => s.inferred && !s.ports.length)
        .sort((a, b) => a.idx - b.idx);
      if (!inferred.length) continue;
      const taken = new Set(all.flatMap((s) => s.ports));
      let free = [...node.shape.ports.values()]
        .filter((p) => (p.direction === direction || p.direction === 'both') && !taken.has(p.id))
        .sort((a, b) => portNumber(a.id) - portNumber(b.id));
      for (const kind of ['Item', 'Fluid', null] as const) {
        const group = inferred.filter((s) => s.kind === kind);
        if (!group.length) continue;
        const cand = free.filter((p) => kind === null || p.kind === kind).map((p) => p.id);
        if (!cand.length) {
          warnings.push(`${node.name}: no free ${kind ?? ''} ${direction} port left`);
          continue;
        }
        const nS = group.length;
        const nP = cand.length;
        group.forEach((s, j) => {
          s.ports =
            nS <= nP
              ? cand.slice(Math.floor((j * nP) / nS), Math.floor(((j + 1) * nP) / nS))
              : [cand[j % nP]];
          if (!s.kind) s.kind = node.shape.ports.get(s.ports[0])!.kind;
        });
        const used = new Set(group.flatMap((s) => s.ports));
        free = free.filter((p) => !used.has(p.id));
      }
    }
  }

  // ---- slots of one machine that share candidate ports must get distinct ports
  for (const node of nodes) {
    for (const direction of ['input', 'output'] as const) {
      const group = [...node.slots.values()]
        .filter((s) => s.direction === direction && s.ports.length && !s.requireAll)
        .sort((a, b) => a.idx - b.idx);
      const seen = new Set<string>();
      let overlap = false;
      for (const s of group) {
        if (s.ports.some((p) => seen.has(p))) overlap = true;
        for (const p of s.ports) seen.add(p);
      }
      if (!overlap) continue;
      const used = new Set<string>();
      for (const s of [...group].sort((a, b) => a.ports.length - b.ports.length || a.idx - b.idx)) {
        const freeP = s.ports.filter((p) => !used.has(p));
        s.ports = [freeP[0] ?? s.ports[0]];
        used.add(s.ports[0]);
      }
    }
  }

  // ---- self feeds: an output that loops back into the same machine needs no pipe
  const selfFeeds: Problem['selfFeeds'] = [];
  for (const { a, b, flow } of selfLoops) {
    const sa = slotByKey(a);
    const sb = slotByKey(b);
    sa.selfFeed += flow;
    sb.selfFeed += flow;
    const [ni, , oi] = parseRef(a);
    const [, , ii] = parseRef(b);
    selfFeeds.push({ node: ni, output: oi, input: ii, flow });
    notes.push(
      `Self feed on ${nodes[ni].name}: ${pname(sa.product)} (${flow.toFixed(2)}/s) is handled inside the machine, no pipe`,
    );
  }

  // ---- instances
  const instances: [number, number][] = [];
  const instBase: number[] = [];
  nodes.forEach((node, ni) => {
    instBase.push(instances.length);
    for (let i = 0; i < node.count; i++) instances.push([ni, i]);
  });

  const cap = cfg.pipeCapacity;
  const nets: Net[] = [];
  const external = (k: string): number | null => {
    const s = slotByKey(k);
    if (s.connected === null) return null;
    return Math.max(0, s.connected - s.selfFeed);
  };
  const slotTerminals = (k: string, s: Slot, localIds: number[], share?: number): Terminal[] => {
    const [ni] = parseRef(k);
    const node = nodes[ni];
    const ext = external(k);
    const per = ext === null ? null : ext / (share ?? node.count);
    const ref = parseRef(k);
    const out: Terminal[] = [];
    for (const i of localIds) {
      const g = instBase[ni] + i;
      if (s.requireAll) {
        const kk = Math.max(1, s.ports.length);
        for (const pp of s.ports) {
          out.push({
            inst: g,
            ports: [pp],
            direction: s.direction,
            rate: per === null ? null : per / kk,
            capacity: s.rate === null ? null : s.rate / kk,
            slot: ref,
          });
        }
      } else {
        out.push({
          inst: g,
          ports: [...s.ports],
          direction: s.direction,
          rate: per,
          capacity: s.rate,
          slot: ref,
        });
      }
    }
    return out;
  };

  interface AdapterJob {
    s2l: boolean;
    largeNet: number;
    smallNets: number[];
    amount: number | null;
  }
  const adapters: AdapterJob[] = [];
  const valveKeys = new Set(cfg.valveNets);
  const valveJobs: {
    key: string;
    kind: PortKind;
    pname: string;
    product: string | null;
    temp: number | null;
    sources: Terminal[];
    outlets: Terminal[][];
  }[] = [];

  const sortedComps = [...comps.values()]
    .map((ms) => ms.sort(cmpRef))
    .sort((a, b) => cmpRef(a[0], b[0]));
  function cmpRef(x: string, y: string): number {
    const [a1, d1, i1] = parseRef(x);
    const [a2, d2, i2] = parseRef(y);
    return a1 - a2 || (d1 < d2 ? -1 : d1 > d2 ? 1 : 0) || i1 - i2;
  }

  for (const members of sortedComps) {
    if (members.length < 2) continue;
    const ss = members.map(slotByKey);
    if (ss.some((s) => !s.ports.length)) {
      warnings.push(
        `A ${pname(ss.find((s) => s.product)?.product ?? null)} connection has no machine port and was skipped`,
      );
      continue;
    }
    const kind: PortKind = ss.find((s) => s.kind)?.kind ?? 'Item';
    const isWide = members.map((k, j) => {
      const [ni] = parseRef(k);
      return ss[j].ports.every((pp) => (nodes[ni].shape.ports.get(pp)?.width ?? 1) >= 2);
    });
    const large = kind === 'Fluid' && isWide.every(Boolean);
    const mixed = kind === 'Fluid' && isWide.some(Boolean) && !isWide.every(Boolean);
    const capacity = large ? cap.LargeFluid : cap[kind];
    const product = ss.find((s) => s.product)?.product ?? null;
    const temp =
      ss.find((s, j) => parseRef(members[j])[1] === 'output' && s.temperature !== null)
        ?.temperature ?? null;
    const ext = members.map(external);
    const sideFlow = { wide: 0, small: 0 };
    let flow: number | null;
    if (ext.some((v) => v === null)) {
      flow = null;
    } else {
      let sup = 0;
      let dem = 0;
      members.forEach((k, j) => {
        const v = ext[j]!;
        const out = parseRef(k)[1] === 'output';
        if (out) sup += v;
        else dem += v;
        sideFlow[isWide[j] ? 'wide' : 'small'] += out ? v : -v;
      });
      flow = Math.max(sup, dem);
    }
    // Machines whose output on this connection is not needed: when the consumers are already
    // fully supplied without them and their output is voidable (the machine keeps running when
    // it backs up), they are left off the pipe network.
    const keep = members.map((k) => {
      const nC = nodes[parseRef(k)[0]].count;
      return Array.from({ length: nC }, (_u, i) => i);
    });
    if (flow !== null) {
      let dem = 0;
      let sure = 0;
      const optional: { m: number; i: number; supply: number }[] = [];
      members.forEach((k, m) => {
        const [ni, d] = parseRef(k);
        const node = nodes[ni];
        if (d === 'input') {
          dem += ext[m]!;
          return;
        }
        // what one machine of this node puts out at the planned machine count (input shortfalls
        // of the plan are reported separately)
        const each = (ss[m].rate ?? 0) * (node.machineCount / Math.max(1, node.count));
        if (!ss[m].voidable || ss[m].requireAll || !(each > 0)) {
          sure += ext[m]!;
          return;
        }
        for (let i = 0; i < node.count; i++) optional.push({ m, i, supply: each });
      });
      if (dem > 1e-9 && optional.length) {
        let have = sure;
        const kept = new Set<string>();
        for (const o of optional) {
          if (have >= dem * (1 + cfg.flowMargin)) break;
          kept.add(`${o.m}|${o.i}`);
          have += o.supply;
        }
        const dropped = optional.length - kept.size;
        if (dropped > 0 && have >= dem - 1e-9) {
          members.forEach((_k, m) => {
            if (!optional.some((o) => o.m === m)) return;
            keep[m] = keep[m].filter((i) => kept.has(`${m}|${i}`));
          });
          notes.push(
            `${pname(product)}: ${dropped} machine(s) with surplus (voidable) output are not piped - the others cover the ${dem.toFixed(2)}/s needed`,
          );
        }
      }
    }
    const minCount = Math.min(...keep.map((l) => l.length).filter((n) => n > 0));
    // most separate pipes each group can take: one per machine, or one per port when a slot has
    // several ports (an exhaust stack with two exhaust inputs takes two pipes)
    const maxSplit = Math.min(
      ...keep
        .map((l, m) => (ss[m].requireAll ? l.length : l.length * Math.max(1, ss[m].ports.length)))
        .filter((n) => n > 0),
    );
    let kSplit: number;
    if (flow === null) {
      kSplit = minCount;
    } else {
      let need = flow / capacity;
      if (mixed) {
        need = Math.max(
          Math.max(Math.abs(sideFlow.wide), 1e-9) / cap.LargeFluid,
          Math.max(Math.abs(sideFlow.small), 1e-9) / cap.Fluid,
        );
      }
      kSplit = Math.max(1, Math.ceil(need * (1 + cfg.flowMargin) - 1e-9));
      kSplit = Math.min(kSplit, maxSplit);
      if (!mixed && flow / kSplit > capacity * 1.0001) {
        warnings.push(
          `${pname(product)}: ${flow.toFixed(1)}/s over ${kSplit} pipe(s) exceeds the pipe capacity of ${capacity}/s (a group has only ${minCount} machine(s) with ${maxSplit} port(s) between them - add machines in the flowchart)`,
        );
      }
    }
    const pn = pname(product);
    for (let j = 0; j < kSplit; j++) {
      const parts: { wide: Terminal[]; small: Terminal[] } = { wide: [], small: [] };
      members.forEach((k, m) => {
        const L = keep[m];
        const side = parts[isWide[m] ? 'wide' : 'small'];
        if (L.length >= kSplit || ss[m].requireAll) {
          const ids: number[] = [];
          for (let q = 0; q < L.length; q++)
            if (Math.floor((q * kSplit) / L.length) === j) ids.push(L[q]);
          side.push(...slotTerminals(k, ss[m], ids, L.length));
          return;
        }
        // fewer machines than pipes: machine j % n takes this pipe on its own share of ports
        const n = L.length;
        const q = j % n;
        const sharing = Math.floor((kSplit - 1 - q) / n) + 1;
        const rank = Math.floor(j / n);
        const [t] = slotTerminals(k, ss[m], [L[q]], n);
        side.push({
          ...t,
          ports: ss[m].ports.filter((_p, pi) => pi % sharing === rank),
          rate: t.rate === null ? null : t.rate / sharing,
          capacity: t.capacity === null ? null : t.capacity / sharing,
        });
      });
      const sfx = kSplit > 1 ? ` [${j + 1}/${kSplit}]` : '';
      // stable across product renames: product id, connected node slots, split index
      const key = `${product ?? '?'}|${members
        .map((k) => {
          const [ni, d, i] = parseRef(k);
          return `${nodes[ni].id}:${d[0]}${i}`;
        })
        .join('+')}|${j}`;
      if (!mixed) {
        const terms = [...parts.wide, ...parts.small];
        if (terms.length < 2) continue;
        if (valveKeys.has(key) && !large && flow !== null) {
          const chain = valveChain(terms);
          if (chain) {
            valveJobs.push({ key, kind, pname: pn, product, temp, ...chain });
            continue;
          }
        }
        nets.push({
          id: nets.length,
          label: pn + sfx,
          product,
          productName: pn,
          kind,
          large,
          flow: flow === null ? null : flow / kSplit,
          capacity,
          terminals: terms,
          key,
          temperature: temp,
        });
        continue;
      }
      // mixed widths: large pipe <-> 4x4 adapter <-> small pipe(s)
      const through = flow === null ? null : sideFlow.small / kSplit; // >0: small side feeds large side
      const s2l = through === null || through >= 0;
      const amount = through === null ? null : Math.abs(through);
      const largeNet = nets.length;
      nets.push({
        id: largeNet,
        label: `${pn}${sfx} (large side)`,
        product,
        productName: pn,
        kind,
        large: true,
        flow: amount,
        capacity: cap.LargeFluid,
        terminals: parts.wide,
        key: `${key}|L`,
        temperature: temp,
      });
      const groups = splitAdapterSide(parts.small);
      const smallNets: number[] = [];
      groups.forEach((g, gi) => {
        smallNets.push(nets.length);
        nets.push({
          id: nets.length,
          label: `${pn}${sfx} (small side${groups.length > 1 ? ` ${gi + 1}` : ''})`,
          product,
          productName: pn,
          kind,
          large: false,
          flow: amount === null ? null : amount / groups.length,
          capacity: cap.Fluid,
          terminals: g,
          key: `${key}|S${gi}`,
          temperature: temp,
        });
      });
      adapters.push({ s2l, largeNet, smallNets, amount });
      if (amount !== null && amount / groups.length > cap.Fluid * 1.0001) {
        warnings.push(
          `${pn}: ${amount.toFixed(1)}/s through a pipe adapter exceeds the small pipe capacity of ${cap.Fluid}/s per port`,
        );
      }
    }
    if (mixed)
      notes.push(`${pn}: joins 1-wide and 2-wide fluid ports -> ${kSplit} pipe adapter(s)`);
    notes.push(
      `${pn} (${kind}${large ? ', large' : ''}): ${flow === null ? 'flow unknown' : `${flow.toFixed(2)}/s`} -> ${kSplit} pipe network(s)`,
    );
  }

  // ---- valve manifolds: sources -> valve 1 -> valve 2 -> ...; each side outlet feeds one machine
  const problemValves: ValveInfo[] = [];
  for (const vkind of ['Item', 'Fluid'] as const) {
    const jobs = valveJobs.filter((jb) => jb.kind === vkind);
    if (!jobs.length) continue;
    const shape = valveShape(vkind);
    const ni = nodes.length;
    const total = jobs.reduce((a, jb) => a + jb.outlets.length - 1, 0);
    nodes.push({
      id: `valves-${vkind.toLowerCase()}`,
      recipeId: shape.id,
      name: shape.name,
      shape,
      machineCount: total,
      effectiveCount: total,
      count: total,
      known: true,
      slots: new Map(),
      special: false,
      settings: {},
      powerUse: null,
      powerType: null,
      pollution: null,
      synthetic: 'valve',
    });
    instBase.push(instances.length);
    let local = 0;
    for (const jb of jobs) {
      const demand = jb.outlets.map((o) => o.reduce((a, t) => a + (t.rate ?? 0), 0));
      const nV = jb.outlets.length - 1;
      const g0 = instances.length;
      for (let i = 0; i < nV; i++) instances.push([ni, local++]);
      const through = demand.reduce((a, b) => a + b, 0);
      const mk = (label: string, terms: Terminal[], f: number) =>
        nets.push({
          id: nets.length,
          label,
          product: jb.product,
          productName: jb.pname,
          kind: vkind,
          large: false,
          flow: f,
          capacity: cap[vkind],
          terminals: terms,
          key: jb.key,
          temperature: jb.temp,
        });
      const vt = (g: number, port: string, dir: 'input' | 'output', rate: number, idx: number) =>
        ({
          inst: g,
          ports: [port],
          direction: dir,
          rate,
          capacity: null,
          slot: [ni, dir, idx] as const,
        }) satisfies Terminal;
      mk(
        `${jb.pname} -> valve 1`,
        [...jb.sources, vt(g0, 'valve_in', 'input', through, 0)],
        through,
      );
      let rest = through;
      for (let i = 0; i < nV; i++) {
        const g = g0 + i;
        const side = demand[i];
        const pct = rest > 0 ? (100 * side) / rest : 0;
        problemValves.push({
          inst: g,
          key: jb.key,
          product: jb.pname,
          sidePct: pct,
          straightPct: 100 - pct,
          flow: rest,
          sideFlow: side,
          index: i + 1,
          of: nV,
        });
        mk(
          `${jb.pname} valve ${i + 1} side (${pct.toFixed(1)}%)`,
          [vt(g, 'valve_side', 'output', side, 1), ...jb.outlets[i]],
          side,
        );
        rest -= side;
        const next =
          i + 1 < nV
            ? [vt(g + 1, 'valve_in', 'input', rest, 0)]
            : jb.outlets[jb.outlets.length - 1];
        mk(
          `${jb.pname} valve ${i + 1} straight (${(100 - pct).toFixed(1)}%)`,
          [vt(g, 'valve_straight', 'output', rest, 0), ...next],
          rest,
        );
      }
      notes.push(`${jb.pname}: even splitting would starve machines -> ${nV} ${shape.name}(s)`);
    }
  }

  // ---- adapters become placeable 4x4 pieces, one node per direction
  for (const s2l of [true, false]) {
    const mine = adapters.filter((a) => a.s2l === s2l);
    if (!mine.length) continue;
    const shape = adapterShape(s2l);
    const ni = nodes.length;
    nodes.push({
      id: `adapter-${s2l ? 's2l' : 'l2s'}`,
      recipeId: shape.id,
      name: s2l ? 'Pipe Adapter (small -> large)' : 'Pipe Adapter (large -> small)',
      shape,
      machineCount: mine.length,
      effectiveCount: mine.length,
      count: mine.length,
      known: true,
      slots: new Map(),
      special: false,
      settings: {},
      powerUse: null,
      powerType: null,
      pollution: null,
      synthetic: 'adapter',
    });
    instBase.push(instances.length);
    const smallIds = adapterSmallPortIds();
    mine.forEach((a, i) => {
      const g = instances.length;
      instances.push([ni, i]);
      nets[a.largeNet].terminals.push({
        inst: g,
        ports: ['adapter_large'],
        direction: s2l ? 'output' : 'input',
        rate: a.amount,
        capacity: null,
        slot: [ni, s2l ? 'output' : 'input', 0],
      });
      const per = a.amount === null ? null : a.amount / a.smallNets.length;
      // one small port per small-side network; a single network may use any of them
      a.smallNets.forEach((si, k) => {
        nets[si].terminals.push({
          inst: g,
          ports: a.smallNets.length === 1 ? smallIds : [smallIds[k % smallIds.length]],
          direction: s2l ? 'input' : 'output',
          rate: per,
          capacity: null,
          slot: [ni, s2l ? 'input' : 'output', 0],
        });
      });
    });
    notes.push(
      `${mine.length} pipe adapter(s) ${s2l ? 'small -> large' : 'large -> small'} (4x4, large port on top, 8 small ports in a U)`,
    );
  }
  for (const net of nets) {
    if (net.flow === null && net.terminals.every((t) => t.rate !== null)) {
      let o = 0;
      let i = 0;
      for (const t of net.terminals) {
        if (t.direction === 'output') o += t.rate!;
        else i += t.rate!;
      }
      net.flow = Math.max(o, i);
    }
  }
  const kept = nets.filter((n) => n.terminals.length >= 2);
  kept.forEach((n, i) => (n.id = i));

  const spacing = new Map<string, number>();
  for (const [mid, d] of Object.entries(cfg.minSpacing)) if (d > 0) spacing.set(mid, d);
  for (const [mid, d] of spacing) {
    const n = nodes.reduce((a, nd) => a + (nd.shape.id === mid ? nd.count : 0), 0);
    if (n > 1) {
      notes.push(
        `Spacing rule: the ${n} ${shapes.get(mid)?.name ?? mid}s must be at least ${d} tiles apart (${cfg.spacingMeasure} distance)`,
      );
    }
  }
  return {
    nodes,
    instances,
    nets: kept,
    warnings,
    notes,
    spacing,
    spacingMeasure: cfg.spacingMeasure,
    productNames,
    selfFeeds,
    valves: problemValves,
    instBase,
  };
}

/**
 * Split the small side of an adapter into up to 8 networks (one per small port), so the
 * adapter does the splitting. Only done when every machine on that side has the same rate, so
 * the adapter's even split matches the plan.
 */
function splitAdapterSide(terms: Terminal[]): Terminal[][] {
  const byInst = new Map<number, Terminal[]>();
  for (const t of terms) {
    if (!byInst.has(t.inst)) byInst.set(t.inst, []);
    byInst.get(t.inst)!.push(t);
  }
  const groups = [...byInst.values()];
  const rates = groups.map((g) => g.reduce((a, t) => a + (t.rate ?? 0), 0));
  const dirs = new Set(terms.map((t) => t.direction));
  const equal = rates.every((r) => Math.abs(r - rates[0]) <= Math.max(1e-9, rates[0] * 0.005));
  if (groups.length < 2 || dirs.size !== 1 || !equal) return [terms];
  let k = Math.min(8, groups.length);
  while (groups.length % k) k--;
  const out: Terminal[][] = Array.from({ length: k }, () => []);
  groups.forEach((g, i) => out[i % k].push(...g));
  return out;
}

/**
 * Split a pipe network's terminals into (sources, outlets) for a valve manifold: every
 * consuming machine gets its own outlet with exactly its planned share.
 */
function valveChain(terms: Terminal[]): { sources: Terminal[]; outlets: Terminal[][] } | null {
  const sources = terms.filter((t) => t.direction === 'output');
  const sinks = terms.filter((t) => t.direction === 'input');
  if (!sources.length || sinks.length < 2) return null;
  const per = new Map<number, Terminal[]>();
  for (const t of sinks) {
    if (!per.has(t.inst)) per.set(t.inst, []);
    per.get(t.inst)!.push(t);
  }
  const outlets = [...per.keys()].sort((a, b) => a - b).map((i) => per.get(i)!);
  if (outlets.length < 2) return null;
  return { sources, outlets };
}
