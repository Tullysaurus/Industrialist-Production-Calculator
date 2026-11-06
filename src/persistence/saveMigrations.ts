import type {
  GlobalSettings,
  SaveData,
  SavedEdge,
  SavedNode,
  SavedRecipeNode,
} from '../types/saves';
import { isGameDifficulty } from '../types/globalSettings';
import { normalizeLayoutDoc } from '../gameLayout/docSchema';

export class SaveMigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SaveMigrationError';
  }
}

export interface RecipePortCounts {
  inputs: number;
  outputs: number;
}

export type RecipePortResolver = (
  node: SavedRecipeNode,
  globalSettings: GlobalSettings | undefined,
  overrides: SaveData['dataOverrides'],
) => RecipePortCounts | undefined;

const MONTHS = new Set([
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]);

const ROOT_KEYS = ['version', 'nodes', 'edges', 'globalSettings', 'dataOverrides', 'gameLayout'];
const RECIPE_NODE_KEYS_V2 = [
  'id',
  'type',
  'recipeId',
  'machineCount',
  'inputOrder',
  'outputOrder',
  'position',
  'settings',
  'isTarget',
  'groupId',
  'hidden',
];
const RECIPE_NODE_KEYS_V3 = [...RECIPE_NODE_KEYS_V2, 'machineCountConstraint'];
const GROUP_NODE_KEYS = [
  'id',
  'type',
  'label',
  'collapsed',
  'handlesReady',
  'inputProxyHandleIds',
  'outputProxyHandleIds',
  'position',
];
const EDGE_KEYS = [
  'id',
  'source',
  'sourceIndex',
  'target',
  'targetIndex',
  'controlPoints',
  'orthogonalTurns',
  'hidden',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(path: string, reason: string): never {
  throw new SaveMigrationError(
    `Cannot load save: ${path} ${reason}. The input data was not modified.`,
  );
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) fail(path, 'must be an object');
  return value;
}

function requireKeys(value: Record<string, unknown>, allowed: string[], path: string): void {
  const unknownKey = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknownKey) fail(path, `contains unsupported field "${unknownKey}"`);
}

function requireId(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0)
    fail(path, 'must have a non-empty string ID');
  return value;
}

function requirePosition(value: unknown, path: string): { x: number; y: number } {
  const position = requireRecord(value, path);
  requireKeys(position, ['x', 'y'], path);
  if (
    typeof position.x !== 'number' ||
    !Number.isFinite(position.x) ||
    typeof position.y !== 'number' ||
    !Number.isFinite(position.y)
  ) {
    fail(path, 'must contain finite x and y coordinates');
  }
  return { x: position.x, y: position.y };
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail(path, 'must be a boolean');
  return value;
}

function optionalBoolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined) return undefined;
  return requireBoolean(value, path);
}

function requireUniqueIntegerArray(value: unknown, path: string): number[] {
  if (!Array.isArray(value)) fail(path, 'must be an array');
  const seen = new Set<number>();
  for (const item of value) {
    if (typeof item !== 'number' || !Number.isInteger(item) || item < 0) {
      fail(path, 'must contain non-negative integer indexes');
    }
    if (seen.has(item)) fail(path, `contains duplicate index ${item}`);
    seen.add(item);
  }
  return [...value];
}

function requireStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) fail(path, 'must be an array');
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0) {
      fail(path, 'must contain non-empty strings');
    }
    if (seen.has(item)) fail(path, `contains duplicate value "${item}"`);
    seen.add(item);
  }
  return [...value];
}

function requireSettings(value: unknown, path: string): Record<string, unknown> {
  if (value === undefined) return {};
  return { ...requireRecord(value, path) };
}

function requireConstraint(
  value: unknown,
  path: string,
): SavedRecipeNode['machineCountConstraint'] {
  if (value === undefined) return undefined;
  const constraint = requireRecord(value, path);
  requireKeys(constraint, ['kind', 'value'], path);
  if (constraint.kind !== 'locked' && constraint.kind !== 'capped') {
    fail(`${path}.kind`, 'must be "locked" or "capped"');
  }
  if (
    typeof constraint.value !== 'number' ||
    !Number.isFinite(constraint.value) ||
    constraint.value < 0
  ) {
    fail(`${path}.value`, 'must be a finite non-negative number');
  }
  return { kind: constraint.kind, value: constraint.value };
}

function requirePoints(value: unknown, path: string): { x: number; y: number }[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) fail(path, 'must be an array');
  return value.map((item, index) => {
    const point = requireRecord(item, `${path}[${index}]`);
    requireKeys(point, ['x', 'y'], `${path}[${index}]`);
    if (
      typeof point.x !== 'number' ||
      !Number.isFinite(point.x) ||
      typeof point.y !== 'number' ||
      !Number.isFinite(point.y)
    ) {
      fail(`${path}[${index}]`, 'must contain finite x and y coordinates');
    }
    return { x: point.x, y: point.y };
  });
}

function requireGlobalSettings(value: unknown, version: number): GlobalSettings | undefined {
  if (value === undefined) {
    if (version >= 4) fail('globalSettings', 'must include a valid game month');
    return undefined;
  }
  const settings = requireRecord(value, 'globalSettings');
  const allowed = [
    'global_pollution',
    'difficulty',
    'unlockedResearchIds',
    'oreNodesEnabled',
    'showVariantLimited',
  ];
  if (version >= 3) allowed.push('current_month');
  requireKeys(settings, allowed, 'globalSettings');

  if (
    typeof settings.global_pollution !== 'number' ||
    !Number.isFinite(settings.global_pollution)
  ) {
    fail('globalSettings.global_pollution', 'must be a finite number');
  }
  if (settings.difficulty !== undefined && !isGameDifficulty(settings.difficulty)) {
    fail(
      'globalSettings.difficulty',
      'must be a supported game mode (normal, hard, impossible, impossible2, sandbox, or sandbox_plus)',
    );
  }
  const unlockedResearchIds =
    settings.unlockedResearchIds === undefined
      ? undefined
      : requireStringArray(settings.unlockedResearchIds, 'globalSettings.unlockedResearchIds');
  if (settings.oreNodesEnabled !== undefined && typeof settings.oreNodesEnabled !== 'boolean') {
    fail('globalSettings.oreNodesEnabled', 'must be a boolean');
  }
  if (
    settings.showVariantLimited !== undefined &&
    typeof settings.showVariantLimited !== 'boolean'
  ) {
    fail('globalSettings.showVariantLimited', 'must be a boolean');
  }
  if (
    (settings.current_month !== undefined && !MONTHS.has(settings.current_month as string)) ||
    (version >= 4 && settings.current_month === undefined)
  ) {
    fail('globalSettings.current_month', 'must be a valid game month');
  }

  return {
    global_pollution: settings.global_pollution,
    ...(settings.current_month === undefined
      ? {}
      : { current_month: settings.current_month as GlobalSettings['current_month'] }),
    ...(settings.difficulty === undefined ? {} : { difficulty: settings.difficulty }),
    ...(unlockedResearchIds === undefined ? {} : { unlockedResearchIds }),
    ...(settings.oreNodesEnabled === undefined
      ? {}
      : { oreNodesEnabled: settings.oreNodesEnabled }),
    ...(settings.showVariantLimited === undefined
      ? {}
      : { showVariantLimited: settings.showVariantLimited }),
  };
}

function migrateV2ToV3(data: Record<string, unknown>): Record<string, unknown> {
  return {
    ...data,
    version: 3,
  };
}

function migrateV3ToV4(data: Record<string, unknown>): Record<string, unknown> {
  const globalSettings = data.globalSettings;
  const migratedGlobalSettings =
    globalSettings === undefined
      ? undefined
      : {
          ...(globalSettings as Record<string, unknown>),
          current_month: (globalSettings as Record<string, unknown>).current_month ?? 'January',
        };
  return {
    ...data,
    version: 4,
    ...(migratedGlobalSettings === undefined ? {} : { globalSettings: migratedGlobalSettings }),
  };
}

/** Version 5 adds the optional in-game layout; older saves have none. */
function migrateV4ToV5(data: Record<string, unknown>): Record<string, unknown> {
  return { ...data, version: 5 };
}

function parseHandleId(
  value: string,
): { nodeId: string; side: 'input' | 'output'; index: number } | null {
  const lastSeparator = value.lastIndexOf('-');
  if (lastSeparator <= 0) return null;
  const indexText = value.slice(lastSeparator + 1);
  if (!/^(0|[1-9]\d*)$/.test(indexText)) return null;

  const sideSeparator = value.lastIndexOf('-', lastSeparator - 1);
  if (sideSeparator <= 0) return null;
  const side = value.slice(sideSeparator + 1, lastSeparator);
  if (side !== 'input' && side !== 'output') return null;

  const index = Number(indexText);
  if (!Number.isSafeInteger(index)) return null;
  return { nodeId: value.slice(0, sideSeparator), side, index };
}

function requireOverrides(value: unknown): SaveData['dataOverrides'] {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) fail('dataOverrides', 'must be an array');

  const seen = new Set<string>();
  return value.map((rawEntry, index) => {
    const path = `dataOverrides[${index}]`;
    const entry = requireRecord(rawEntry, path);
    requireKeys(entry, ['id', 'data'], path);
    const id = requireId(entry.id, `${path}.id`);
    if (seen.has(id)) fail(path, `duplicates override ID "${id}"`);
    seen.add(id);
    const data = requireRecord(entry.data, `${path}.data`);
    return { id, data };
  });
}

function normalizeNode(rawNode: unknown, index: number, version: number): SavedNode {
  const path = `nodes[${index}]`;
  const node = requireRecord(rawNode, path);
  if (node.type === 'group') {
    requireKeys(node, GROUP_NODE_KEYS, path);
    const id = requireId(node.id, `${path}.id`);
    if (typeof node.label !== 'string') fail(`${path}.label`, 'must be a string');
    const collapsed = requireBoolean(node.collapsed, `${path}.collapsed`);
    const handlesReady = optionalBoolean(node.handlesReady, `${path}.handlesReady`);
    return {
      id,
      type: 'group',
      label: node.label,
      collapsed,
      ...(handlesReady === undefined ? {} : { handlesReady }),
      inputProxyHandleIds: requireStringArray(
        node.inputProxyHandleIds,
        `${path}.inputProxyHandleIds`,
      ),
      outputProxyHandleIds: requireStringArray(
        node.outputProxyHandleIds,
        `${path}.outputProxyHandleIds`,
      ),
      position: requirePosition(node.position, `${path}.position`),
    };
  }

  if (node.type !== undefined && node.type !== 'recipe') {
    fail(`${path}.type`, `has unsupported node type "${String(node.type)}"`);
  }
  requireKeys(node, version >= 3 ? RECIPE_NODE_KEYS_V3 : RECIPE_NODE_KEYS_V2, path);
  const id = requireId(node.id, `${path}.id`);
  const recipeId = requireId(node.recipeId, `${path}.recipeId`);
  if (
    typeof node.machineCount !== 'number' ||
    !Number.isFinite(node.machineCount) ||
    node.machineCount < 0
  ) {
    fail(`${path}.machineCount`, 'must be a finite non-negative number');
  }
  if (node.groupId !== undefined && (typeof node.groupId !== 'string' || !node.groupId)) {
    fail(`${path}.groupId`, 'must refer to a group ID');
  }

  return {
    id,
    type: 'recipe',
    recipeId,
    machineCount: node.machineCount,
    ...(version >= 3 && node.machineCountConstraint !== undefined
      ? {
          machineCountConstraint: requireConstraint(
            node.machineCountConstraint,
            `${path}.machineCountConstraint`,
          ),
        }
      : {}),
    ...(node.inputOrder === undefined
      ? {}
      : { inputOrder: requireUniqueIntegerArray(node.inputOrder, `${path}.inputOrder`) }),
    ...(node.outputOrder === undefined
      ? {}
      : { outputOrder: requireUniqueIntegerArray(node.outputOrder, `${path}.outputOrder`) }),
    position: requirePosition(node.position, `${path}.position`),
    settings: requireSettings(node.settings, `${path}.settings`),
    ...(node.isTarget === undefined
      ? {}
      : { isTarget: requireBoolean(node.isTarget, `${path}.isTarget`) }),
    ...(node.groupId === undefined ? {} : { groupId: node.groupId }),
    ...(node.hidden === undefined ? {} : { hidden: requireBoolean(node.hidden, `${path}.hidden`) }),
  };
}

function normalizeEdge(rawEdge: unknown, index: number): SavedEdge {
  const path = `edges[${index}]`;
  const edge = requireRecord(rawEdge, path);
  requireKeys(edge, EDGE_KEYS, path);
  const id = requireId(edge.id, `${path}.id`);
  const source = requireId(edge.source, `${path}.source`);
  const target = requireId(edge.target, `${path}.target`);
  for (const [key, value] of [
    ['sourceIndex', edge.sourceIndex],
    ['targetIndex', edge.targetIndex],
  ] as const) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      fail(`${path}.${key}`, 'must be a non-negative integer port index');
    }
  }
  return {
    id,
    source,
    sourceIndex: edge.sourceIndex as number,
    target,
    targetIndex: edge.targetIndex as number,
    ...(edge.controlPoints === undefined
      ? {}
      : { controlPoints: requirePoints(edge.controlPoints, `${path}.controlPoints`) }),
    ...(edge.orthogonalTurns === undefined
      ? {}
      : { orthogonalTurns: requirePoints(edge.orthogonalTurns, `${path}.orthogonalTurns`) }),
    ...(edge.hidden === undefined ? {} : { hidden: requireBoolean(edge.hidden, `${path}.hidden`) }),
  };
}

function validateVersionedFields(data: Record<string, unknown>, version: number): void {
  if (version < 5 && data.gameLayout !== undefined) {
    fail('gameLayout', `is only supported from save version 5 (this save is version ${version})`);
  }
  if (!Array.isArray(data.nodes)) fail('nodes', 'must be an array');
  if (!Array.isArray(data.edges)) fail('edges', 'must be an array');

  for (let index = 0; index < data.nodes.length; index++) {
    const path = `nodes[${index}]`;
    const node = requireRecord(data.nodes[index], path);
    if (node.type === 'group') {
      requireKeys(node, GROUP_NODE_KEYS, path);
    } else {
      requireKeys(node, version >= 3 ? RECIPE_NODE_KEYS_V3 : RECIPE_NODE_KEYS_V2, path);
    }
  }

  for (let index = 0; index < data.edges.length; index++) {
    requireKeys(requireRecord(data.edges[index], `edges[${index}]`), EDGE_KEYS, `edges[${index}]`);
  }
}

function validateReferences(
  nodes: SavedNode[],
  edges: SavedEdge[],
  globalSettings: GlobalSettings | undefined,
  overrides: SaveData['dataOverrides'],
  resolveRecipePorts: RecipePortResolver,
): void {
  const nodeById = new Map<string, SavedNode>();
  const portsByRecipeId = new Map<string, RecipePortCounts>();

  for (const node of nodes) {
    if (nodeById.has(node.id)) fail(`nodes`, `contains duplicate node ID "${node.id}"`);
    nodeById.set(node.id, node);
    if (node.type === 'group') continue;

    const ports = resolveRecipePorts(node, globalSettings, overrides);
    if (!ports) fail(`nodes[${node.id}].recipeId`, `references unknown recipe "${node.recipeId}"`);
    if (
      !Number.isSafeInteger(ports.inputs) ||
      ports.inputs < 0 ||
      !Number.isSafeInteger(ports.outputs) ||
      ports.outputs < 0
    ) {
      fail(`recipe "${node.recipeId}"`, 'has an invalid input or output port count');
    }
    portsByRecipeId.set(node.id, ports);

    for (const [key, indexes, count] of [
      ['inputOrder', node.inputOrder, ports.inputs],
      ['outputOrder', node.outputOrder, ports.outputs],
    ] as const) {
      if (indexes?.some((portIndex) => portIndex >= count)) {
        fail(`nodes[${node.id}].${key}`, 'references a missing recipe port');
      }
    }
  }

  for (const node of nodes) {
    if (node.type === 'group') {
      for (const [side, handles] of [
        ['input', node.inputProxyHandleIds],
        ['output', node.outputProxyHandleIds],
      ] as const) {
        for (const handleId of handles) {
          const parsed = parseHandleId(handleId);
          if (!parsed || parsed.side !== side) {
            fail(
              `groups[${node.id}].${side}ProxyHandleIds`,
              `contains invalid handle "${handleId}"`,
            );
          }
          const target = nodeById.get(parsed.nodeId);
          const ports = portsByRecipeId.get(parsed.nodeId);
          if (target?.type !== 'recipe' || !ports) {
            fail(
              `groups[${node.id}].${side}ProxyHandleIds`,
              `references missing recipe port "${handleId}"`,
            );
          }
          const portCount = side === 'input' ? ports.inputs : ports.outputs;
          if (parsed.index >= portCount) {
            fail(
              `groups[${node.id}].${side}ProxyHandleIds`,
              `references missing recipe port "${handleId}"`,
            );
          }
        }
      }
    } else if (node.groupId) {
      if (nodeById.get(node.groupId)?.type !== 'group') {
        fail(`nodes[${node.id}].groupId`, `references missing group "${node.groupId}"`);
      }
    }
  }

  const edgeIds = new Set<string>();
  for (const edge of edges) {
    if (edgeIds.has(edge.id)) fail('edges', `contains duplicate edge ID "${edge.id}"`);
    edgeIds.add(edge.id);
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    if (source?.type !== 'recipe') {
      fail(`edges[${edge.id}].source`, `references missing recipe node "${edge.source}"`);
    }
    if (target?.type !== 'recipe') {
      fail(`edges[${edge.id}].target`, `references missing recipe node "${edge.target}"`);
    }
    const sourcePorts = portsByRecipeId.get(source.id);
    const targetPorts = portsByRecipeId.get(target.id);
    if (!sourcePorts || edge.sourceIndex >= sourcePorts.outputs) {
      fail(`edges[${edge.id}].sourceIndex`, `references a missing output port on "${source.id}"`);
    }
    if (!targetPorts || edge.targetIndex >= targetPorts.inputs) {
      fail(`edges[${edge.id}].targetIndex`, `references a missing input port on "${target.id}"`);
    }
  }
}

export function migrateSaveData(
  rawData: unknown,
  currentVersion: number,
  resolveRecipePorts: RecipePortResolver,
  recipeOverridesForValidation?: unknown,
): SaveData {
  const source = requireRecord(rawData, 'save data');
  const sourceVersion = source.version;
  if (typeof sourceVersion !== 'number' || !Number.isSafeInteger(sourceVersion)) {
    fail('version', 'is missing or invalid; this save format is not supported');
  }
  if (sourceVersion > currentVersion) {
    fail(
      'version',
      `is ${sourceVersion}, newer than this app supports (version ${currentVersion})`,
    );
  }
  if (sourceVersion < 2) {
    fail('version', `is ${sourceVersion}, and no explicit migration exists for that legacy format`);
  }
  requireKeys(source, ROOT_KEYS, 'save data');
  validateVersionedFields(source, sourceVersion);

  let data = source;
  let version = sourceVersion;
  if (version === 2) {
    requireGlobalSettings(data.globalSettings, 2);
    data = migrateV2ToV3(data);
    version = 3;
  }
  if (version === 3 && version < currentVersion) {
    requireGlobalSettings(data.globalSettings, 3);
    data = migrateV3ToV4(data);
    version = 4;
  }
  if (version === 4 && version < currentVersion) {
    data = migrateV4ToV5(data);
    version = 5;
  }
  if (version !== currentVersion) {
    fail('version', `is ${sourceVersion}; no migration path to version ${currentVersion} exists`);
  }

  if (!Array.isArray(data.nodes)) fail('nodes', 'must be an array');
  if (!Array.isArray(data.edges)) fail('edges', 'must be an array');

  const globalSettings = requireGlobalSettings(data.globalSettings, version);
  const dataOverrides = requireOverrides(data.dataOverrides);
  const overridesForValidation =
    recipeOverridesForValidation === undefined
      ? undefined
      : requireOverrides(recipeOverridesForValidation);
  const nodes = data.nodes.map((node, index) => normalizeNode(node, index, version));
  const edges = data.edges.map(normalizeEdge);
  validateReferences(nodes, edges, globalSettings, overridesForValidation, resolveRecipePorts);
  let gameLayout: SaveData['gameLayout'];
  if (data.gameLayout !== undefined) {
    try {
      gameLayout = normalizeLayoutDoc(data.gameLayout);
    } catch (err) {
      fail('gameLayout', err instanceof Error ? err.message : String(err));
    }
  }

  return {
    version: currentVersion,
    nodes,
    edges,
    ...(globalSettings === undefined ? {} : { globalSettings }),
    ...(dataOverrides === undefined ? {} : { dataOverrides }),
    ...(gameLayout === undefined ? {} : { gameLayout }),
  };
}
