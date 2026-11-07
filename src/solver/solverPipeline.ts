import type {
  FlowResults,
  ReactFlowEdge,
  ReactFlowNode,
  SolverGraph,
  TemperatureDiagnostics,
} from '../types/solver';
import type { Recipe } from '../types/data';
import { getSpecialRecipe } from '../data/registry';
import { resolveActiveRecipe } from '../data/lookup';
import { buildSolverGraph } from './graphBuilder';
import { calculateFlows } from './flowSolver';
import {
  MAX_TEMPERATURE_PROPAGATION_ITERATIONS,
  propagateTemperatures,
} from './temperaturePropagator';
import { computeResolvedProducts } from '../utils/productResolver';
import { createGraphResolutionContext } from '../utils/graphResolutionContext';
import { buildHandleId } from '../utils/idGenerator';
import {
  areRatesEquivalent as areRateValuesEquivalent,
  normalizeSolverRate,
} from '../utils/precision';
import { sumConnectedEdgeFlows } from './flowAggregation';

const MAX_TEMPERATURE_COUPLED_PASSES = 8;

type SettingsOverrides = Record<string, Record<string, unknown>>;

export interface SolverPipelineResult {
  results: FlowResults;
  edgeFlows: Record<string, number>;
  edgeTemps: Record<string, number>;
  inputTemps: Record<string, Record<number, number>>;
  resolvedProducts: Record<string, string>;
  nodeRecipes: Record<string, Recipe>;
  temperatureDiagnostics: TemperatureDiagnostics;
}

interface TemperatureCoupledPassResult extends Omit<
  SolverPipelineResult,
  'temperatureDiagnostics'
> {
  propagation: ReturnType<typeof propagateTemperatures>;
  settingsOverrides: SettingsOverrides;
}

const SETTINGS_NUMERIC_TOLERANCE = 1e-6;

function areSettingsEquivalent(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') {
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      return a === b;
    }
    return Math.abs(a - b) <= SETTINGS_NUMERIC_TOLERANCE;
  }
  return a === b;
}

/** Temperature settings whose value differs between two passes' overrides. */
function getOverrideChanges(
  prev: SettingsOverrides | undefined,
  next: SettingsOverrides | undefined,
): NonNullable<TemperatureDiagnostics['unsettled']> {
  const out: NonNullable<TemperatureDiagnostics['unsettled']> = [];
  const ids = new Set([...Object.keys(prev ?? {}), ...Object.keys(next ?? {})]);
  for (const nodeId of ids) {
    const p = prev?.[nodeId] ?? {};
    const n = next?.[nodeId] ?? {};
    for (const setting of new Set([...Object.keys(p), ...Object.keys(n)])) {
      if (areSettingsEquivalent(p[setting], n[setting])) continue;
      const from = p[setting];
      const to = n[setting];
      if (typeof from === 'number' && typeof to === 'number') {
        out.push({ nodeId, setting, from, to });
      }
    }
  }
  return out;
}

function areRatesEquivalent(a: number, b: number): boolean {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return a === b;
  const normalizedA = normalizeSolverRate(a);
  const normalizedB = normalizeSolverRate(b);
  return areRateValuesEquivalent(normalizedA, normalizedB);
}

function normalizeEdgeFlows(edgeFlows: Record<string, number>): Record<string, number> {
  const normalized: Record<string, number> = {};
  for (const [edgeId, flow] of Object.entries(edgeFlows)) {
    normalized[edgeId] = normalizeSolverRate(flow);
  }
  return normalized;
}

function areOverridesEquivalent(
  prev: SettingsOverrides | undefined,
  next: SettingsOverrides | undefined,
): boolean {
  const previousOverrides = prev ?? {};
  const nextOverrides = next ?? {};
  const prevNodeIds = Object.keys(previousOverrides);
  const nextNodeIds = Object.keys(nextOverrides);
  if (prevNodeIds.length !== nextNodeIds.length) return false;

  for (let i = 0; i < nextNodeIds.length; i++) {
    const nodeId = nextNodeIds[i];
    const prevNodeOverrides = previousOverrides[nodeId];
    const nextNodeOverrides = nextOverrides[nodeId];
    if (!prevNodeOverrides || !nextNodeOverrides) return false;

    const prevKeys = Object.keys(prevNodeOverrides);
    const nextKeys = Object.keys(nextNodeOverrides);
    if (prevKeys.length !== nextKeys.length) return false;

    for (let j = 0; j < nextKeys.length; j++) {
      const key = nextKeys[j];
      if (!areSettingsEquivalent(prevNodeOverrides[key], nextNodeOverrides[key])) {
        return false;
      }
    }
  }

  return true;
}

function hasMeaningfulOverrides(
  nodesById: Map<string, ReactFlowNode>,
  overrides: SettingsOverrides,
): boolean {
  const nodeIds = Object.keys(overrides);
  if (nodeIds.length === 0) return false;

  for (let i = 0; i < nodeIds.length; i++) {
    const nodeId = nodeIds[i];
    const node = nodesById.get(nodeId);
    const nodeOverrides = overrides[nodeId];
    if (!node || !nodeOverrides) continue;

    const currentSettings = node.data.settings ?? {};
    const overrideKeys = Object.keys(nodeOverrides);
    for (let j = 0; j < overrideKeys.length; j++) {
      const key = overrideKeys[j];
      if (!areSettingsEquivalent(currentSettings[key], nodeOverrides[key])) {
        return true;
      }
    }
  }

  return false;
}

function hasFlowDependentRecipes(nodes: ReactFlowNode[]): boolean {
  for (let i = 0; i < nodes.length; i++) {
    if (getSpecialRecipe(nodes[i].data.recipeId)?.flowDependentInputs) {
      return true;
    }
  }
  return false;
}

function areNodePortsEquivalent(
  a: SolverGraph['nodes'][string],
  b: SolverGraph['nodes'][string],
): boolean {
  if (a.inputs.length !== b.inputs.length || a.outputs.length !== b.outputs.length) {
    return false;
  }

  for (let i = 0; i < a.inputs.length; i++) {
    const left = a.inputs[i];
    const right = b.inputs[i];
    if (left.productId !== right.productId || !areRatesEquivalent(left.rate, right.rate)) {
      return false;
    }
  }

  for (let i = 0; i < a.outputs.length; i++) {
    const left = a.outputs[i];
    const right = b.outputs[i];
    if (left.productId !== right.productId || !areRatesEquivalent(left.rate, right.rate)) {
      return false;
    }
  }

  return true;
}

function areGraphNodesEquivalent(prev: SolverGraph['nodes'], next: SolverGraph['nodes']): boolean {
  const prevNodeIds = Object.keys(prev);
  const nextNodeIds = Object.keys(next);
  if (prevNodeIds.length !== nextNodeIds.length) return false;

  for (let i = 0; i < prevNodeIds.length; i++) {
    const nodeId = prevNodeIds[i];
    const prevNode = prev[nodeId];
    const nextNode = next[nodeId];
    if (!prevNode || !nextNode || !areNodePortsEquivalent(prevNode, nextNode)) {
      return false;
    }
  }

  return true;
}

function solveFlowsForPipeline(
  nodes: ReactFlowNode[],
  edges: ReactFlowEdge[],
  settingsOverrides: SettingsOverrides | undefined,
  includesFlowDependentRecipes: boolean,
  globalSettings?: Record<string, unknown>,
): {
  results: FlowResults;
  edgeFlows: Record<string, number>;
} {
  const initialGraph = buildSolverGraph(nodes, edges, settingsOverrides, undefined, globalSettings);
  const firstPassResult = calculateFlows(initialGraph);
  const firstPass = {
    ...firstPassResult,
    edgeFlows: normalizeEdgeFlows(firstPassResult.edgeFlows),
  };

  if (!includesFlowDependentRecipes) {
    return firstPass;
  }

  const correctedGraph = buildSolverGraph(
    nodes,
    edges,
    settingsOverrides,
    firstPass.edgeFlows,
    globalSettings,
  );
  if (areGraphNodesEquivalent(initialGraph.nodes, correctedGraph.nodes)) {
    return firstPass;
  }

  const correctedResult = calculateFlows(correctedGraph, true);
  return {
    ...correctedResult,
    edgeFlows: normalizeEdgeFlows(correctedResult.edgeFlows),
  };
}

function solveTemperatureCoupledPass(
  nodes: ReactFlowNode[],
  edges: ReactFlowEdge[],
  settingsOverrides: SettingsOverrides | undefined,
  includesFlowDependentRecipes: boolean,
  globalSettings?: Record<string, unknown>,
): TemperatureCoupledPassResult {
  const { results, edgeFlows } = solveFlowsForPipeline(
    nodes,
    edges,
    settingsOverrides,
    includesFlowDependentRecipes,
    globalSettings,
  );
  const propagation = propagateTemperatures(nodes, edges, edgeFlows, globalSettings);

  return {
    results,
    edgeFlows,
    edgeTemps: propagation.edgeTemps,
    inputTemps: propagation.inputTemps,
    resolvedProducts: {},
    nodeRecipes: {},
    propagation,
    settingsOverrides: propagation.settingsOverrides,
  };
}

export function createEmptyTemperatureDiagnostics(): TemperatureDiagnostics {
  return {
    converged: true,
    propagation: {
      converged: true,
      iterationsRun: 0,
      totalIterationsRun: 0,
      passesRun: 0,
      iterationLimit: MAX_TEMPERATURE_PROPAGATION_ITERATIONS,
      limitReached: false,
    },
    coupling: {
      converged: true,
      passesRun: 0,
      passLimit: MAX_TEMPERATURE_COUPLED_PASSES,
      limitReached: false,
    },
  };
}

export function solveFlowPipeline(
  nodes: ReactFlowNode[],
  edges: ReactFlowEdge[],
  globalSettings?: Record<string, unknown>,
): SolverPipelineResult {
  const nodesById = new Map<string, ReactFlowNode>(nodes.map((node) => [node.id, node]));
  const includesFlowDependentRecipes = hasFlowDependentRecipes(nodes);
  let activeOverrides: SettingsOverrides | undefined;
  let finalResult: SolverPipelineResult = {
    results: new Map(),
    edgeFlows: {},
    edgeTemps: {},
    inputTemps: {},
    resolvedProducts: {},
    nodeRecipes: {},
    temperatureDiagnostics: createEmptyTemperatureDiagnostics(),
  };
  let needsFinalResync = false;
  let temperatureCouplingConverged = false;
  let temperaturePropagation: ReturnType<typeof propagateTemperatures> | undefined;
  let temperaturePropagationPassesRun = 0;
  let totalTemperatureIterationsRun = 0;
  let temperatureCouplingPassesRun = 0;
  let lastOverrideChanges: NonNullable<TemperatureDiagnostics['unsettled']> = [];

  for (let pass = 0; pass < MAX_TEMPERATURE_COUPLED_PASSES; pass++) {
    temperatureCouplingPassesRun += 1;
    const passResult = solveTemperatureCoupledPass(
      nodes,
      edges,
      activeOverrides,
      includesFlowDependentRecipes,
      globalSettings,
    );
    const { settingsOverrides, propagation, ...resultSnapshot } = passResult;

    finalResult = { ...finalResult, ...resultSnapshot };
    temperaturePropagation = propagation;
    temperaturePropagationPassesRun += 1;
    totalTemperatureIterationsRun += propagation.iterationsRun;
    needsFinalResync = false;

    const nextOverrides = hasMeaningfulOverrides(nodesById, settingsOverrides)
      ? settingsOverrides
      : undefined;
    if (areOverridesEquivalent(activeOverrides, nextOverrides)) {
      temperatureCouplingConverged = true;
      break;
    }

    lastOverrideChanges = getOverrideChanges(activeOverrides, nextOverrides);
    activeOverrides = nextOverrides;
    needsFinalResync = pass === MAX_TEMPERATURE_COUPLED_PASSES - 1;
  }

  if (needsFinalResync) {
    const passResult = solveTemperatureCoupledPass(
      nodes,
      edges,
      activeOverrides,
      includesFlowDependentRecipes,
      globalSettings,
    );
    finalResult = {
      ...finalResult,
      results: passResult.results,
      edgeFlows: passResult.edgeFlows,
      edgeTemps: passResult.edgeTemps,
      inputTemps: passResult.inputTemps,
      resolvedProducts: passResult.resolvedProducts,
      nodeRecipes: passResult.nodeRecipes,
    };
    temperaturePropagation = passResult.propagation;
    temperaturePropagationPassesRun += 1;
    totalTemperatureIterationsRun += passResult.propagation.iterationsRun;
    const nextOverrides = hasMeaningfulOverrides(nodesById, passResult.settingsOverrides)
      ? passResult.settingsOverrides
      : undefined;
    temperatureCouplingConverged = areOverridesEquivalent(activeOverrides, nextOverrides);
    if (!temperatureCouplingConverged) {
      lastOverrideChanges = getOverrideChanges(activeOverrides, nextOverrides);
    }
  }

  const propagation = temperaturePropagation ?? {
    edgeTemps: {},
    inputTemps: {},
    settingsOverrides: {},
    iterationsRun: 0,
    converged: true,
  };
  finalResult.temperatureDiagnostics = {
    converged: propagation.converged && temperatureCouplingConverged,
    propagation: {
      converged: propagation.converged,
      iterationsRun: propagation.iterationsRun,
      totalIterationsRun: totalTemperatureIterationsRun,
      passesRun: temperaturePropagationPassesRun,
      iterationLimit: MAX_TEMPERATURE_PROPAGATION_ITERATIONS,
      limitReached:
        !propagation.converged &&
        propagation.iterationsRun >= MAX_TEMPERATURE_PROPAGATION_ITERATIONS,
    },
    coupling: {
      converged: temperatureCouplingConverged,
      passesRun: temperatureCouplingPassesRun,
      passLimit: MAX_TEMPERATURE_COUPLED_PASSES,
      limitReached:
        !temperatureCouplingConverged &&
        temperatureCouplingPassesRun >= MAX_TEMPERATURE_COUPLED_PASSES,
    },
    ...(temperatureCouplingConverged ? {} : { unsettled: lastOverrideChanges }),
  };

  finalResult.resolvedProducts = computeResolvedProducts(nodesById, edges, globalSettings);

  const resolutionContext = createGraphResolutionContext(nodes, edges);
  const nodeRecipes: Record<string, Recipe> = {};

  for (const node of nodes) {
    const nodeId = node.id;
    const nodeOverrides = activeOverrides?.[nodeId];
    const settings =
      nodeOverrides || node.data.settings ? { ...node.data.settings, ...nodeOverrides } : undefined;

    const helpers = {
      resolveProduct: (side: 'input' | 'output', index: number): string => {
        const handleId = buildHandleId(nodeId, side, index);
        return finalResult.resolvedProducts[handleId] ?? '';
      },
      hasConnection: (side: 'input' | 'output', index: number): boolean => {
        const handleId = buildHandleId(nodeId, side, index);
        return (resolutionContext.edgeLookup.get(handleId)?.length ?? 0) > 0;
      },
      getFlowRate: (side: 'input' | 'output', index: number): number => {
        const handleId = buildHandleId(nodeId, side, index);
        const connectedEdges = resolutionContext.edgeLookup.get(handleId) ?? [];
        return sumConnectedEdgeFlows(connectedEdges, finalResult.edgeFlows, true);
      },
    };

    const recipe = resolveActiveRecipe(node.data.recipeId, settings, nodeId, helpers, {
      temperatureInputOverrides: finalResult.inputTemps[nodeId],
      suppressStoreTemperatureOverrides: true,
      globalSettings,
    });

    if (recipe) {
      nodeRecipes[nodeId] = recipe;
    }
  }

  finalResult.nodeRecipes = nodeRecipes;
  return finalResult;
}
