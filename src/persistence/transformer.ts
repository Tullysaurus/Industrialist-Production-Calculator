import type { Edge } from '@xyflow/react';
import type { GameLayoutDoc } from '../gameLayout/docSchema';
import { isGroupNode, isRecipeNode } from '../types/nodes';
import type { CanvasNode } from '../types/nodes';
import type { EdgeControlPoint } from '../types/edges';
import { parseHandleId, buildHandleId } from '../utils/idGenerator';
import { getAllResearches, getRecipe, resolveActiveRecipe } from '../data/lookup';
import { getBlockedResearchIds } from '../data/researchRules';
import { useGlobalSettingsStore } from '../stores/useGlobalSettingsStore';
import type {
  SavedNode,
  SavedRecipeNode,
  SavedEdge,
  SaveData,
  GlobalSettings,
} from '../types/saves';
import {
  migrateSaveData as migrateSaveDataStrict,
  SaveMigrationError,
  type RecipePortCounts,
} from './saveMigrations';

export const CURRENT_SAVE_VERSION = 5;

function sanitizeSavedPoints(raw: unknown): EdgeControlPoint[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new Error('[Persistence] Cannot save malformed edge control points.');
  }

  const points: EdgeControlPoint[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!item || typeof item !== 'object') {
      throw new Error(`[Persistence] Cannot save malformed edge control point at index ${i}.`);
    }

    const point = item as { x?: number; y?: number };
    if (
      typeof point.x !== 'number' ||
      !Number.isFinite(point.x) ||
      typeof point.y !== 'number' ||
      !Number.isFinite(point.y)
    ) {
      throw new Error(`[Persistence] Cannot save non-finite edge control point at index ${i}.`);
    }

    points.push({ x: point.x, y: point.y });
  }

  return points.length > 0 ? points : undefined;
}

function resolveRecipePorts(
  node: SavedRecipeNode,
  globalSettings: GlobalSettings | undefined,
  overrides: SaveData['dataOverrides'],
): RecipePortCounts | undefined {
  const override = overrides?.find((entry) => entry.id === `recipe:${node.recipeId}`);
  if (override?.data._tombstone) return undefined;

  const recipe =
    resolveActiveRecipe(
      node.recipeId,
      node.settings,
      undefined,
      undefined,
      globalSettings ? { globalSettings: { ...globalSettings } } : undefined,
    ) ?? getRecipe(node.recipeId);
  const inputs = override?.data.inputs ?? recipe?.inputs;
  const outputs = override?.data.outputs ?? recipe?.outputs;
  if (!Array.isArray(inputs) || !Array.isArray(outputs)) return undefined;
  return { inputs: inputs.length, outputs: outputs.length };
}

export function migrateSaveData(
  rawData: unknown,
  recipeOverridesForValidation?: SaveData['dataOverrides'],
): SaveData {
  const migrated = migrateSaveDataStrict(
    rawData,
    CURRENT_SAVE_VERSION,
    (node, globalSettings, overrides) => resolveRecipePorts(node, globalSettings, overrides),
    recipeOverridesForValidation,
  );

  validateUnlockedResearches(migrated.globalSettings, recipeOverridesForValidation);
  return migrated;
}

function validateUnlockedResearches(
  settings: GlobalSettings | undefined,
  overrides: SaveData['dataOverrides'],
): void {
  const currentSettings = useGlobalSettingsStore.getState().settings;
  const difficulty = settings?.difficulty ?? currentSettings.difficulty;
  if (difficulty === 'sandbox' || difficulty === 'sandbox_plus') return;

  const unlockedIds = new Set(settings?.unlockedResearchIds ?? currentSettings.unlockedResearchIds);
  const prerequisitesByResearchId = new Map<string, unknown>(
    getAllResearches().map((research) => [research.id, research.prerequisites]),
  );

  for (const override of overrides ?? []) {
    if (!override.id.startsWith('research:')) continue;
    const researchId = override.id.slice('research:'.length);
    if (!researchId) continue;
    if (override.data._tombstone) {
      prerequisitesByResearchId.delete(researchId);
    } else if (
      Object.hasOwn(override.data, 'prerequisites') ||
      !prerequisitesByResearchId.has(researchId)
    ) {
      prerequisitesByResearchId.set(researchId, override.data.prerequisites);
    }
  }

  const dependentsByResearchId = new Map<string, string[]>();
  for (const researchId of prerequisitesByResearchId.keys()) {
    dependentsByResearchId.set(researchId, []);
  }
  for (const [researchId, prerequisites] of prerequisitesByResearchId) {
    if (!Array.isArray(prerequisites)) continue;
    for (const prerequisite of prerequisites) {
      if (typeof prerequisite !== 'string' || !prerequisite.startsWith('s_')) continue;
      dependentsByResearchId.get(prerequisite)?.push(researchId);
    }
  }
  const blockedResearchIds = getBlockedResearchIds(difficulty, dependentsByResearchId);

  const fail = (reason: string): never => {
    throw new SaveMigrationError(
      `Cannot load save: globalSettings.unlockedResearchIds ${reason}. The input data was not modified.`,
    );
  };

  for (const researchId of unlockedIds) {
    if (!prerequisitesByResearchId.has(researchId)) {
      return fail(`references unknown research "${researchId}"`);
    }
    if (blockedResearchIds.has(researchId)) {
      return fail(`contains research "${researchId}" that is unavailable in ${difficulty} mode`);
    }
    const prerequisites = prerequisitesByResearchId.get(researchId);
    const prerequisiteList: unknown[] | undefined = Array.isArray(prerequisites)
      ? prerequisites
      : undefined;
    if (!prerequisiteList) {
      return fail(`cannot validate prerequisites for research "${researchId}"`);
    }

    for (const prerequisite of prerequisiteList) {
      if (typeof prerequisite !== 'string' || prerequisite.length === 0) {
        return fail(`contains a malformed prerequisite for research "${researchId}"`);
      }
      if (!prerequisite.startsWith('s_')) continue;
      if (!prerequisitesByResearchId.has(prerequisite)) {
        return fail(`research "${researchId}" references unknown prerequisite "${prerequisite}"`);
      }
      if (!unlockedIds.has(prerequisite)) {
        return fail(
          `research "${researchId}" is unlocked while prerequisite "${prerequisite}" is locked`,
        );
      }
    }
  }
}

export function serializeCanvas(
  nodes: CanvasNode[],
  edges: Edge[],
  allOverrides?: { id: string; data: Record<string, unknown> }[],
  gameLayout?: GameLayoutDoc | null,
): SaveData {
  const savedNodes: SavedNode[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (isRecipeNode(n)) {
      savedNodes.push({
        id: n.id,
        type: 'recipe',
        recipeId: n.data.recipeId,
        machineCount: n.data.machineCount,
        machineCountConstraint: n.data.machineCountConstraint,
        inputOrder: n.data.inputOrder,
        outputOrder: n.data.outputOrder,
        position: { x: n.position.x, y: n.position.y },
        settings: n.data.settings ?? {},
        isTarget: n.data.isTarget,
        groupId: n.data.groupId,
        hidden: n.hidden || undefined,
      });
    } else if (isGroupNode(n)) {
      savedNodes.push({
        id: n.id,
        type: 'group',
        label: n.data.label,
        collapsed: n.data.collapsed,
        inputProxyHandleIds: n.data.inputProxyHandleIds,
        outputProxyHandleIds: n.data.outputProxyHandleIds,
        position: { x: n.position.x, y: n.position.y },
      });
    }
  }

  const savedEdges: SavedEdge[] = [];
  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i];
    if (edge.id.startsWith('proxy-')) continue;
    if (!edge.sourceHandle || !edge.targetHandle) {
      throw new Error(`[Persistence] Cannot save edge ${edge.id} without both port handles.`);
    }

    const sourceParsed = parseHandleId(edge.sourceHandle);
    const targetParsed = parseHandleId(edge.targetHandle);
    if (
      !sourceParsed ||
      sourceParsed.nodeId !== edge.source ||
      sourceParsed.side !== 'output' ||
      !targetParsed ||
      targetParsed.nodeId !== edge.target ||
      targetParsed.side !== 'input'
    ) {
      throw new Error(`[Persistence] Cannot save edge ${edge.id} with malformed port handles.`);
    }

    savedEdges.push({
      id: edge.id,
      source: edge.source,
      sourceIndex: sourceParsed.index,
      target: edge.target,
      targetIndex: targetParsed.index,
      controlPoints: sanitizeSavedPoints(
        (edge.data as { controlPoints?: unknown } | undefined)?.controlPoints,
      ),
      orthogonalTurns: sanitizeSavedPoints(
        (edge.data as { orthogonalTurns?: unknown } | undefined)?.orthogonalTurns,
      ),
      hidden: edge.hidden || undefined,
    });
  }

  const globalSettings: GlobalSettings = { ...useGlobalSettingsStore.getState().settings };
  if (globalSettings.difficulty === 'sandbox' || globalSettings.difficulty === 'sandbox_plus') {
    delete globalSettings.unlockedResearchIds;
  }

  return migrateSaveData(
    {
      version: CURRENT_SAVE_VERSION,
      nodes: savedNodes,
      edges: savedEdges,
      globalSettings,
      dataOverrides: allOverrides && allOverrides.length > 0 ? allOverrides : undefined,
      gameLayout: gameLayout ?? undefined,
    },
    allOverrides,
  );
}

export function deserializeCanvas(
  saveData: unknown,
  recipeOverridesForValidation?: SaveData['dataOverrides'],
): {
  nodes: CanvasNode[];
  edges: Edge[];
  globalSettings?: GlobalSettings;
  gameLayout: GameLayoutDoc | null;
} {
  const migrated = migrateSaveData(saveData, recipeOverridesForValidation);
  const nodes: CanvasNode[] = migrated.nodes.map((savedNode) => {
    if (savedNode.type === 'group') {
      return {
        id: savedNode.id,
        type: 'group',
        position: savedNode.position,
        data: {
          label: savedNode.label,
          collapsed: savedNode.collapsed,
          handlesReady: false,
          inputProxyHandleIds: savedNode.inputProxyHandleIds,
          outputProxyHandleIds: savedNode.outputProxyHandleIds,
        },
      };
    }

    return {
      id: savedNode.id,
      type: 'recipe',
      position: savedNode.position,
      hidden: savedNode.hidden || undefined,
      data: {
        recipeId: savedNode.recipeId,
        machineCount: savedNode.machineCount,
        machineCountConstraint: savedNode.machineCountConstraint,
        inputOrder: savedNode.inputOrder,
        outputOrder: savedNode.outputOrder,
        settings: savedNode.settings,
        isTarget: savedNode.isTarget,
        groupId: savedNode.groupId,
      },
    };
  });

  const edges: Edge[] = migrated.edges.map((savedEdge) => {
    const edgeData =
      (savedEdge.controlPoints && savedEdge.controlPoints.length > 0) ||
      (savedEdge.orthogonalTurns && savedEdge.orthogonalTurns.length > 0)
        ? {
            ...(savedEdge.controlPoints && savedEdge.controlPoints.length > 0
              ? { controlPoints: savedEdge.controlPoints }
              : {}),
            ...(savedEdge.orthogonalTurns && savedEdge.orthogonalTurns.length > 0
              ? { orthogonalTurns: savedEdge.orthogonalTurns }
              : {}),
          }
        : undefined;

    return {
      id: savedEdge.id,
      type: 'recipe',
      source: savedEdge.source,
      target: savedEdge.target,
      sourceHandle: buildHandleId(savedEdge.source, 'output', savedEdge.sourceIndex),
      targetHandle: buildHandleId(savedEdge.target, 'input', savedEdge.targetIndex),
      data: edgeData,
      hidden: savedEdge.hidden || undefined,
    };
  });

  return {
    nodes,
    edges,
    globalSettings: migrated.globalSettings,
    gameLayout: migrated.gameLayout ?? null,
  };
}

export function applySaveSettings(settings: GlobalSettings | undefined): void {
  if (!settings) return;

  const store = useGlobalSettingsStore.getState();
  const difficulty = settings.difficulty ?? store.settings.difficulty;
  const unlockedResearchIds =
    difficulty === 'sandbox' || difficulty === 'sandbox_plus'
      ? getAllResearches().map((research) => research.id)
      : settings.unlockedResearchIds;

  store.importSettings({
    ...settings,
    ...(unlockedResearchIds === undefined ? {} : { unlockedResearchIds }),
  });
}

export { SaveMigrationError };
