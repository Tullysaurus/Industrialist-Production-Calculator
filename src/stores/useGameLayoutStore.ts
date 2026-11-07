/**
 * UI state of the in-game layout editor: active tool, selection, view toggles and the layout
 * generator (worker). The layout document itself lives in useFlowStore (saved, undoable).
 */
import { create } from 'zustand';
import { emptySelection, type Selection } from '../gameLayout/docOps';
import type {
  LayoutInput,
  LayoutOptions,
  LayoutProgress,
  LayoutRunResult,
  LayoutWorkerRequest,
  LayoutWorkerResponse,
} from '../gameLayout/engine/types';
import type { GameLayoutDoc } from '../gameLayout/docSchema';

export type EditorTool =
  | 'select'
  | 'pipe'
  | 'erase'
  | 'valve'
  | 'passthrough'
  | 'intersection'
  | 'hv'
  | 'mv'
  | 'transformer'
  | 'grid';

/** Tools that place a power piece (the tool id is the piece kind). */
export const POWER_TOOLS = ['hv', 'mv', 'transformer', 'grid'] as const;
export type PowerTool = (typeof POWER_TOOLS)[number];
export const isPowerTool = (t: EditorTool): t is PowerTool =>
  (POWER_TOOLS as readonly string[]).includes(t);
export type FlowView = 'planned' | 'even' | 'valve';

export interface GeneratorOptions {
  timeBudget: number;
  valves: boolean;
  /** Place power poles, transformers and the grid connection. */
  power: boolean;
  /** Same machines in rows (one row or a mirrored back-to-back pair per recipe). */
  rows: boolean;
  /** Production stages in order along one axis. */
  flowOrder: boolean;
  /** Ports facing the row corridors (inputs one side, outputs the other). */
  facing: boolean;
  /** 0..1: how much space tidiness may cost. */
  tidiness: number;
  /**
   * Quantum piping: feed machines through any of their nodes (and take outputs from nodes
   * near the output port), passthroughs flat against large nodes, intersections on nodes.
   */
  quantum: boolean;
}

const OPTIONS_KEY = 'industrialist.gameLayout.options';

function readOptions(): GeneratorOptions {
  const fallback: GeneratorOptions = {
    timeBudget: 60,
    valves: true,
    power: true,
    rows: true,
    flowOrder: false,
    facing: true,
    tidiness: 0.5,
    quantum: true,
  };
  try {
    const raw = localStorage.getItem(OPTIONS_KEY);
    if (!raw) return fallback;
    const v = JSON.parse(raw) as Partial<GeneratorOptions>;
    return {
      timeBudget:
        typeof v.timeBudget === 'number' && v.timeBudget >= 5 && v.timeBudget <= 1800
          ? v.timeBudget
          : fallback.timeBudget,
      valves: typeof v.valves === 'boolean' ? v.valves : fallback.valves,
      power: typeof v.power === 'boolean' ? v.power : fallback.power,
      rows: typeof v.rows === 'boolean' ? v.rows : fallback.rows,
      flowOrder: typeof v.flowOrder === 'boolean' ? v.flowOrder : fallback.flowOrder,
      facing: typeof v.facing === 'boolean' ? v.facing : fallback.facing,
      tidiness:
        typeof v.tidiness === 'number' && v.tidiness >= 0 && v.tidiness <= 1
          ? v.tidiness
          : fallback.tidiness,
      quantum: typeof v.quantum === 'boolean' ? v.quantum : fallback.quantum,
    };
  } catch {
    return fallback;
  }
}

export interface GeneratorState {
  status: 'idle' | 'running' | 'error';
  progress: LayoutProgress | null;
  /** Latest layout found while running (shown as a preview until it finishes). */
  preview: GameLayoutDoc | null;
  last: LayoutRunResult['summary'] | null;
  log: string[];
  error: string | null;
}

interface GameLayoutEditorState {
  tool: EditorTool;
  /** Instance being placed from the unplaced list (ghost under the cursor). */
  placing: { inst: number; rot: number } | null;
  /** Rotation for valves; orientation for passthroughs. */
  pieceRot: number;
  pieceKind: 'Item' | 'Fluid';
  selection: Selection;
  flowView: FlowView;
  showArrows: boolean;
  /** Draw power cables. */
  showPower: boolean;
  showLabels: boolean;
  /** Tiles to flash / zoom to (problem list). */
  focus: { tiles: [number, number][]; id: number } | null;
  fitRequest: number;
  options: GeneratorOptions;
  generator: GeneratorState;
  /** Short status line (tool results). */
  notice: { text: string; tone: 'info' | 'error' | 'success'; id: number } | null;

  setTool: (tool: EditorTool) => void;
  startPlacing: (inst: number, rot?: number) => void;
  setPlacing: (p: { inst: number; rot: number } | null) => void;
  rotatePiece: () => void;
  setPieceKind: (k: 'Item' | 'Fluid') => void;
  setSelection: (s: Selection) => void;
  clearSelection: () => void;
  setFlowView: (v: FlowView) => void;
  toggleArrows: () => void;
  togglePower: () => void;
  toggleLabels: () => void;
  focusTiles: (tiles: [number, number][]) => void;
  requestFit: () => void;
  setOptions: (o: Partial<GeneratorOptions>) => void;
  notify: (text: string, tone?: 'info' | 'error' | 'success') => void;
  startGenerator: (
    input: LayoutInput,
    pinned: GameLayoutDoc | null,
    onDone: (result: LayoutRunResult) => void,
  ) => void;
  stopGenerator: () => void;
}

let worker: Worker | null = null;
let runId = 0;
let seq = 0;

export const useGameLayoutStore = create<GameLayoutEditorState>((set, get) => ({
  tool: 'select',
  placing: null,
  pieceRot: 0,
  pieceKind: 'Item',
  selection: emptySelection(),
  flowView: 'valve',
  showArrows: true,
  showPower: true,
  showLabels: true,
  focus: null,
  fitRequest: 0,
  options: readOptions(),
  generator: { status: 'idle', progress: null, preview: null, last: null, log: [], error: null },
  notice: null,

  setTool: (tool) => set({ tool, placing: null }),
  startPlacing: (inst, rot) =>
    set((s) => ({ placing: { inst, rot: rot ?? s.placing?.rot ?? 0 }, tool: 'select' })),
  setPlacing: (placing) => set({ placing }),
  rotatePiece: () => set((s) => ({ pieceRot: (s.pieceRot + 1) % 4 })),
  setPieceKind: (pieceKind) => set({ pieceKind }),
  setSelection: (selection) => set({ selection }),
  clearSelection: () => set({ selection: emptySelection() }),
  setFlowView: (flowView) => set({ flowView }),
  toggleArrows: () => set((s) => ({ showArrows: !s.showArrows })),
  togglePower: () => set((s) => ({ showPower: !s.showPower })),
  toggleLabels: () => set((s) => ({ showLabels: !s.showLabels })),
  focusTiles: (tiles) => set({ focus: { tiles, id: ++seq } }),
  requestFit: () => set((s) => ({ fitRequest: s.fitRequest + 1 })),
  setOptions: (o) => {
    const options = { ...get().options, ...o };
    try {
      localStorage.setItem(OPTIONS_KEY, JSON.stringify(options));
    } catch {
      // not remembered
    }
    set({ options });
  },
  notify: (text, tone = 'info') => set({ notice: { text, tone, id: ++seq } }),

  startGenerator: (input, pinned, onDone) => {
    get().stopGenerator();
    const id = ++runId;
    const opts: LayoutOptions = {
      timeBudget: get().options.timeBudget,
      valves: get().options.valves,
      power: get().options.power,
      grouping: {
        rows: get().options.rows,
        flowOrder: get().options.flowOrder,
        facing: get().options.facing,
        strength: get().options.tidiness,
      },
      seed: Math.floor(Math.random() * 1e9),
      quantumJump: 3,
      quantumNodes: get().options.quantum,
      pinned: pinned ?? undefined,
    };
    try {
      worker = new Worker(new URL('../gameLayout/gameLayout.worker.ts', import.meta.url), {
        type: 'module',
      });
    } catch (err) {
      set({
        generator: {
          ...get().generator,
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
        },
      });
      return;
    }
    let latest: LayoutRunResult | null = null;
    set({
      generator: {
        status: 'running',
        progress: null,
        preview: null,
        last: null,
        log: [],
        error: null,
      },
    });
    let done = false;
    const finish = (result: LayoutRunResult | null) => {
      if (id !== runId || done) return;
      done = true;
      stopHandler = null;
      worker?.terminate();
      worker = null;
      set((s) => ({
        generator: {
          ...s.generator,
          status: 'idle',
          preview: null,
          last: result?.summary ?? s.generator.last,
        },
      }));
      if (result) onDone(result);
    };
    worker.onmessage = (ev: MessageEvent<LayoutWorkerResponse>) => {
      const msg = ev.data;
      if (msg.id !== id) return;
      if (msg.type === 'progress') {
        set((s) => ({ generator: { ...s.generator, progress: msg.progress } }));
      } else if (msg.type === 'log') {
        set((s) => ({
          generator: { ...s.generator, log: [...s.generator.log, msg.line].slice(-400) },
        }));
      } else if (msg.type === 'result') {
        latest = msg.result;
        if (msg.final) finish(msg.result);
        else
          set((s) => ({
            generator: { ...s.generator, preview: msg.result.doc, last: msg.result.summary },
          }));
      } else if (msg.type === 'error') {
        done = true;
        stopHandler = null;
        worker?.terminate();
        worker = null;
        set((s) => ({
          generator: { ...s.generator, status: 'error', error: msg.message, preview: null },
        }));
      }
    };
    worker.onerror = (ev) => {
      ev.preventDefault();
      worker?.terminate();
      worker = null;
      set((s) => ({
        generator: {
          ...s.generator,
          status: 'error',
          error: ev.message || 'The generator stopped unexpectedly.',
        },
      }));
    };
    // Stop keeps the best layout found so far
    stopHandler = () => finish(latest);
    const req: LayoutWorkerRequest = { type: 'run', id, input, options: opts };
    worker.postMessage(req);
  },

  stopGenerator: () => {
    if (!worker) return;
    const h = stopHandler;
    stopHandler = null;
    if (h) h();
    else {
      worker.terminate();
      worker = null;
    }
  },
}));

let stopHandler: (() => void) | null = null;
