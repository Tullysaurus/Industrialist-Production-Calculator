/// <reference lib="webworker" />
/**
 * Flow analysis of the in-game layout (even-split simulation) off the main thread: on large
 * layouts it takes too long to run after every edit.
 */
import { buildContext, evaluateDoc, type AnalysisData } from './doc';
import type { GameLayoutDoc } from './docSchema';
import { buildProblem } from './engine/problem';
import type { LayoutInput } from './engine/types';

export interface AnalysisRequest {
  id: number;
  input: LayoutInput;
  doc: GameLayoutDoc;
}

export interface AnalysisResponse {
  id: number;
  analysis: AnalysisData | null;
  error?: string;
}

const ctx = self as unknown as DedicatedWorkerGlobalScope;
let cached: { input: LayoutInput; layout: ReturnType<typeof buildContext> } | null = null;

ctx.onmessage = (ev: MessageEvent<AnalysisRequest>) => {
  const { id, input, doc } = ev.data;
  try {
    if (!cached || cached.input !== input) {
      cached = { input, layout: buildContext(buildProblem(input)) };
    }
    const view = evaluateDoc(cached.layout, doc, { analyse: true });
    ctx.postMessage({ id, analysis: view.analysis } satisfies AnalysisResponse);
  } catch (err) {
    ctx.postMessage({
      id,
      analysis: null,
      error: err instanceof Error ? err.message : String(err),
    } satisfies AnalysisResponse);
  }
};
