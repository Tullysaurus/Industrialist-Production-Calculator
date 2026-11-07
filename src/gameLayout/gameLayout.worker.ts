/// <reference lib="webworker" />
/**
 * Runs the in-game layout builder off the main thread. Every improved layout is posted as it is
 * found, so stopping (terminating the worker) keeps the best layout so far.
 */
import { runLayout } from './engine';
import type { LayoutWorkerRequest, LayoutWorkerResponse } from './engine/types';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const post = (msg: LayoutWorkerResponse) => ctx.postMessage(msg);

ctx.onmessage = (event: MessageEvent<LayoutWorkerRequest>) => {
  const req = event.data;
  if (req.type !== 'run') return;
  const { id } = req;
  const started = performance.now();
  let bestArea: number | null = null;
  let bestEmpty: number | null = null;
  let bestRouted = false;
  try {
    runLayout(req.input, req.options, {
      log: (line) => post({ type: 'log', id, line }),
      progress: (phase, message, best) => {
        if (best) {
          bestArea = best.area;
          bestEmpty = best.hull.empty;
          bestRouted = best.ok;
        }
        post({
          type: 'progress',
          id,
          progress: {
            phase,
            message,
            elapsed: (performance.now() - started) / 1000,
            budget: req.options.timeBudget,
            bestArea,
            bestEmpty,
            bestRouted,
          },
        });
      },
      result: (result, final) => post({ type: 'result', id, result, final }),
    });
  } catch (err) {
    post({ type: 'error', id, message: err instanceof Error ? err.message : String(err) });
  }
};
