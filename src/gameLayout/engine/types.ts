import type { MachineData, PortKind, Side } from './geometry';
import type { GameLayoutDoc } from '../docSchema';

// ------------------------------------------------------------------ input

export interface LayoutRecipeIO {
  product_id: string;
  quantity: number;
  port_ids?: string[];
  independentOfMachineCount?: boolean;
  temperature?: number;
  voidable?: boolean;
}

export interface LayoutRecipe {
  id: string;
  name: string;
  machine_id: string;
  cycle_time: number;
  power_consumption?: number | null;
  power_type?: string | null;
  pollution?: number | null;
  inputs: LayoutRecipeIO[];
  outputs: LayoutRecipeIO[];
}

export interface LayoutHandleFlow {
  connected: number;
  temperature?: number | null;
}

export interface LayoutInputNode {
  id: string;
  recipeId: string;
  name: string;
  machineCount: number;
  settings: Record<string, unknown>;
  special: boolean;
  /** Recipe as resolved by the website's flow pipeline (null when unknown). */
  recipe: LayoutRecipe | null;
  inputs: LayoutHandleFlow[];
  outputs: LayoutHandleFlow[];
}

export interface LayoutInputEdge {
  id: string;
  source: string;
  sourceIndex: number;
  target: string;
  targetIndex: number;
  /** Solved flow on the edge, /s. */
  flow: number;
}

export interface LayoutInput {
  nodes: LayoutInputNode[];
  edges: LayoutInputEdge[];
  machines: MachineData[];
  products: { id: string; name: string; type?: string }[];
}

export interface LayoutConfig {
  pipeCapacity: { Item: number; Fluid: number; LargeFluid: number };
  flowMargin: number;
  treesPerSprinkler: number;
  /** Minimum distance between two machines of the same type (machine id -> tiles). */
  minSpacing: Record<string, number>;
  /** edge: empty tiles between footprints along x or y; center: distance between centres. */
  spacingMeasure: 'edge' | 'center';
  /** Pipe networks to build as a valve manifold (net keys from a first even-split check). */
  valveNets: string[];
}

export interface LayoutOptions {
  /** Total time budget, seconds. */
  timeBudget: number;
  valves: boolean;
  seed: number;
  /** Place power poles, transformers and the grid connection (default on). */
  power?: boolean;
  /** Max tiles a pipe may hop over other pipes (quantum piping), 0 = off. */
  quantumJump: number;
  config?: Partial<LayoutConfig>;
  /** The current document: its pinned machines / pipes / pieces are kept as they are. */
  pinned?: GameLayoutDoc;
  /** Internal tuning (benchmarks). */
  tuning?: {
    slack?: number;
    stallLimit?: number;
    useModules?: boolean;
    seams?: boolean;
    hullCost?: boolean;
    notchWeight?: number;
  };
}

export interface LayoutSummary {
  width: number;
  height: number;
  area: number;
  /** Empty tiles inside the layout's orthogonal hull (what the generator minimises). */
  empty: number;
  /** Tiles inside the orthogonal hull. */
  hullArea: number;
  fullyRouted: boolean;
  conflicts: number;
  unrouted: number;
  elapsed: number;
  valves: number;
  passthroughs: number;
  log: string[];
}

export interface LayoutRunResult {
  doc: GameLayoutDoc;
  summary: LayoutSummary;
}

export const DEFAULT_LAYOUT_OPTIONS: LayoutOptions = {
  timeBudget: 60,
  valves: true,
  seed: 0,
  quantumJump: 3,
};

// ------------------------------------------------------------------ result

export type XY = [number, number];

export interface ResultPort {
  id: string;
  cells: XY[];
  side: Side;
  kind: PortKind;
  direction: string;
  width: number;
  net: number | null;
  rate: number | null;
}

export interface ResultIO {
  product: string;
  maxRate: number;
  plannedRate: number;
  temperature: number | null;
  selfFeed: number;
  voidable: boolean;
}

export interface ResultValve {
  product: string;
  sidePct: number;
  straightPct: number;
  flow: number;
  sideFlow: number;
  index: number;
  of: number;
}

export interface ResultMachine {
  inst: number;
  /** Document key: `${flowchart node id}#${instance index}`. */
  key: string;
  group: number;
  name: string;
  machine: string;
  recipe: string;
  index: number;
  count: number;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  rects: [number, number, number, number, string][];
  ports: ResultPort[];
  io: { inputs: ResultIO[]; outputs: ResultIO[] };
  valve: ResultValve | null;
  synthetic: 'valve' | 'adapter' | null;
  run: { planned: number; evenSplit: number | null; built: number | null };
}

export interface ResultJunctionValve {
  ok: boolean;
  why: string;
  straightPct?: number;
  sidePct?: number;
  tiles: XY[];
  split: [string, number][];
}

export interface ResultJunction {
  at: XY;
  kind: 'split' | 'merge' | 'mix' | 'end';
  ins: [string, number][];
  outs: [string, number][];
  evenOk: boolean;
  valve: ResultJunctionValve | null;
}

export interface ResultTerminal {
  inst: number;
  machine: string;
  direction: 'input' | 'output';
  rate: number | null;
  maxRate: number | null;
  at: XY | null;
  port: XY[];
}

export interface ResultPipe {
  index: number;
  label: string;
  product: string;
  kind: PortKind;
  large: boolean;
  flow: number | null;
  capacity: number;
  temperature: number | null;
  routed: boolean;
  /** [x1, y1, x2, y2, planned, evenSplit, withValves] in flow direction. */
  segments: [number, number, number, number, number, number | null, number | null][];
  nodes: XY[];
  junctions: ResultJunction[];
  terminals: ResultTerminal[];
  note: string;
}

export interface ResultGroup {
  index: number;
  id: string;
  name: string;
  recipe: string;
  machine: string;
  count: number;
  planned: number;
  /** Machines' worth the plan's input flows can actually run. */
  achievable: number;
  evenSplit: number | null;
  withValves: number | null;
  synthetic: 'valve' | 'adapter' | null;
}

export interface LayoutStats {
  machines: number;
  machineTiles: number;
  pipeNetworks: number;
  pipeTiles: number;
  overfullTiles: number;
  unrouted: number;
  valves: number;
  valvesNeededUnplaced: number;
  passthroughs: number;
}

export interface ResultPassthrough {
  x: number;
  y: number;
  w: number;
  h: number;
  kind: PortKind;
  largeNet: number;
  slots: [number, number];
}

export interface LayoutResult {
  version: 1;
  createdAt: number;
  footprint: { width: number; height: number; area: number };
  fullyRouted: boolean;
  elapsed: number;
  layoutStats: LayoutStats;
  passthroughs: ResultPassthrough[];
  groups: ResultGroup[];
  machines: ResultMachine[];
  pipes: ResultPipe[];
  warnings: string[];
  notes: string[];
  selfFeeds: { node: string; name: string; output: number; input: number; flow: number }[];
  log: string[];
}

// ------------------------------------------------------------------ worker protocol

export type LayoutPhase = 'model' | 'valve-check' | 'placement' | 'routing' | 'analysis' | 'done';

export interface LayoutProgress {
  phase: LayoutPhase;
  elapsed: number;
  budget: number;
  message: string;
  bestArea: number | null;
  /** Empty tiles inside the best layout's orthogonal hull. */
  bestEmpty: number | null;
  bestRouted: boolean;
}

export type LayoutWorkerRequest =
  | { type: 'run'; id: number; input: LayoutInput; options: LayoutOptions }
  | { type: 'stop'; id: number };

export type LayoutWorkerResponse =
  | { type: 'progress'; id: number; progress: LayoutProgress }
  | { type: 'log'; id: number; line: string }
  | { type: 'result'; id: number; result: LayoutRunResult; final: boolean }
  | { type: 'error'; id: number; message: string };
