import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import type { AnalysisRequest, AnalysisResponse } from '../../gameLayout/analysis.worker';
import { getAllMachines, getAllProducts } from '../../data/lookup';
import { getSpecialRecipe } from '../../data/registry';
import {
  buildContext,
  evaluateDoc,
  starvedProblems,
  type AnalysisData,
  type DocView,
  type LayoutContext,
} from '../../gameLayout/doc';
import { emptyLayoutDoc, type GameLayoutDoc } from '../../gameLayout/docSchema';
import { buildProblem } from '../../gameLayout/engine/problem';
import type { LayoutInput } from '../../gameLayout/engine/types';
import { buildLayoutInput } from '../../gameLayout/input';
import { useDataStore } from '../../stores/useDataStore';
import { useFlowResultStore } from '../../stores/useFlowResultStore';
import { useFlowStore } from '../../stores/useFlowStore';
import { useGameLayoutStore } from '../../stores/useGameLayoutStore';

export interface LayoutViewModel {
  input: LayoutInput;
  ctx: LayoutContext;
  /** Current document (null = nothing placed yet). */
  doc: GameLayoutDoc | null;
  /**
   * Evaluated document (may lag the document by a frame on large layouts). While the generator
   * runs this is its latest layout, so the canvas, size, problems and stats follow it live.
   */
  view: DocView;
}

/** The flowchart, its solved flows and the in-game layout document, evaluated together. */
export function useLayoutView(): LayoutViewModel {
  const nodes = useFlowStore((s) => s.nodes);
  const edges = useFlowStore((s) => s.edges);
  const doc = useFlowStore((s) => s.gameLayout);
  const results = useFlowResultStore((s) => s.results);
  const edgeFlows = useFlowResultStore((s) => s.edgeFlows);
  const inputTemps = useFlowResultStore((s) => s.inputTemps);
  const nodeRecipes = useFlowResultStore((s) => s.nodeRecipes);
  const dbVersion = useDataStore((s) => s.dbVersion);

  const input = useMemo(() => {
    void dbVersion;
    return buildLayoutInput({
      nodes,
      edges,
      results,
      edgeFlows,
      inputTemps,
      nodeRecipes,
      machines: getAllMachines(),
      products: getAllProducts(),
      isSpecialRecipe: (id) => !!getSpecialRecipe(id),
    });
  }, [nodes, edges, results, edgeFlows, inputTemps, nodeRecipes, dbVersion]);

  const ctx = useMemo(() => buildContext(buildProblem(input)), [input]);
  const preview = useGameLayoutStore((s) => s.generator.preview);
  const deferredDoc = useDeferredValue(preview ?? doc);
  // geometry and rule checks right away; flows and the even-split check from a worker
  const base = useMemo(
    () => evaluateDoc(ctx, deferredDoc ?? emptyLayoutDoc(), { analyse: false }),
    [ctx, deferredDoc],
  );
  const analysis = useLayoutAnalysis(input, ctx, deferredDoc);
  const view = useMemo<DocView>(() => {
    // flows of an older document stay drawn until the new ones arrive (same flowchart)
    if (!analysis) return base;
    return {
      ...base,
      analysis,
      problems: [...base.problems, ...starvedProblems(ctx.problem, base.placed, analysis)],
    };
  }, [base, analysis, ctx]);
  return { input, ctx, doc, view };
}

/** Debounced flow analysis in a worker: the latest result for the current flowchart. */
function useLayoutAnalysis(
  input: LayoutInput,
  ctx: LayoutContext,
  doc: GameLayoutDoc | null,
): AnalysisData | null {
  const [result, setResult] = useState<{ data: AnalysisData; ctx: LayoutContext } | null>(null);
  const worker = useRef<Worker | null>(null);
  const seq = useRef(0);
  const pending = useRef(new Map<number, LayoutContext>());
  useEffect(() => {
    const w = new Worker(new URL('../../gameLayout/analysis.worker.ts', import.meta.url), {
      type: 'module',
    });
    const reqs = pending.current;
    w.onmessage = (ev: MessageEvent<AnalysisResponse>) => {
      const c = reqs.get(ev.data.id);
      reqs.delete(ev.data.id);
      if (ev.data.id !== seq.current || !c || !ev.data.analysis) return;
      setResult({ data: ev.data.analysis, ctx: c });
    };
    worker.current = w;
    return () => {
      w.terminate();
      worker.current = null;
      reqs.clear();
    };
  }, []);
  useEffect(() => {
    if (!doc) return;
    const t = setTimeout(() => {
      const id = ++seq.current;
      pending.current.set(id, ctx);
      const req: AnalysisRequest = { id, input, doc };
      worker.current?.postMessage(req);
    }, 250);
    return () => clearTimeout(t);
  }, [doc, input, ctx]);
  return result && result.ctx === ctx ? result.data : null;
}
