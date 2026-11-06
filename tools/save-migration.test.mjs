import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import 'fake-indexeddb/auto';
import { after, test } from 'node:test';
import ts from 'typescript';
import { createServer } from 'vite';

const migrationPath = new URL('../src/persistence/saveMigrations.ts', import.meta.url);
const source = await readFile(migrationPath, 'utf8');
const globalSettingsSource = await readFile(
  new URL('../src/types/globalSettings.ts', import.meta.url),
  'utf8',
);
const { outputText: globalSettingsOutput } = ts.transpileModule(globalSettingsSource, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
});
const globalSettingsModuleUrl = `data:text/javascript;base64,${Buffer.from(globalSettingsOutput).toString('base64')}`;
const { outputText: transpiledMigration } = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
});
const docSchemaSource = await readFile(
  new URL('../src/gameLayout/docSchema.ts', import.meta.url),
  'utf8',
);
const { outputText: docSchemaOutput } = ts.transpileModule(docSchemaSource, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
});
const docSchemaModuleUrl = `data:text/javascript;base64,${Buffer.from(docSchemaOutput).toString('base64')}`;
const outputText = transpiledMigration
  .replace("from '../types/globalSettings'", `from '${globalSettingsModuleUrl}'`)
  .replace("from '../gameLayout/docSchema'", `from '${docSchemaModuleUrl}'`);
const migrationModuleUrl = `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`;
const { migrateSaveData, SaveMigrationError } = await import(migrationModuleUrl);
const viteServer = await createServer({
  configFile: false,
  root: process.cwd(),
  server: { middlewareMode: true },
  appType: 'custom',
});
const lookup = await viteServer.ssrLoadModule('/src/data/lookup.ts');
await lookup.initializeDatabase();
const transformer = await viteServer.ssrLoadModule('/src/persistence/transformer.ts');
const globalSettingsStore = await viteServer.ssrLoadModule('/src/stores/useGlobalSettingsStore.ts');

after(async () => {
  await viteServer.close();
});

const recipePorts = new Map([
  ['recipe:source', { inputs: 1, outputs: 2 }],
  ['recipe:target', { inputs: 2, outputs: 1 }],
]);

function resolveRecipePorts(node) {
  return recipePorts.get(node.recipeId);
}

function recipeNode(id, recipeId, extra = {}) {
  return {
    id,
    type: 'recipe',
    recipeId,
    machineCount: 1,
    position: { x: 10, y: 20 },
    settings: {},
    ...extra,
  };
}

function version2Save() {
  return {
    version: 2,
    nodes: [recipeNode('source-node', 'recipe:source'), recipeNode('target-node', 'recipe:target')],
    edges: [
      {
        id: 'edge-1',
        source: 'source-node',
        sourceIndex: 1,
        target: 'target-node',
        targetIndex: 0,
        controlPoints: [{ x: 14, y: 15 }],
      },
    ],
    globalSettings: {
      global_pollution: 12,
      difficulty: 'sandbox',
      unlockedResearchIds: ['research-a'],
      oreNodesEnabled: false,
      showVariantLimited: true,
    },
  };
}

function version3Save() {
  return {
    version: 3,
    nodes: [
      recipeNode('source-node', 'recipe:source', {
        machineCountConstraint: { kind: 'capped', value: 3 },
        inputOrder: [0],
        outputOrder: [1, 0],
        settings: { customSetting: 'retained' },
        groupId: 'group-node',
      }),
      recipeNode('target-node', 'recipe:target'),
      {
        id: 'group-node',
        type: 'group',
        label: 'Group A',
        collapsed: false,
        inputProxyHandleIds: ['source-node-input-0'],
        outputProxyHandleIds: ['source-node-output-1'],
        position: { x: 0, y: 0 },
      },
    ],
    edges: [
      {
        id: 'edge-1',
        source: 'source-node',
        sourceIndex: 1,
        target: 'target-node',
        targetIndex: 0,
        orthogonalTurns: [{ x: 21, y: 22 }],
        hidden: true,
      },
    ],
    globalSettings: {
      global_pollution: 12,
      difficulty: 'sandbox',
      unlockedResearchIds: ['research-a'],
      oreNodesEnabled: false,
      showVariantLimited: true,
    },
    dataOverrides: [{ id: 'product:custom', data: { id: 'custom', name: 'Custom product' } }],
  };
}

function version4Save() {
  const save = version3Save();
  save.version = 4;
  save.globalSettings.current_month = 'October';
  return save;
}

function emptySaveWithSettings(settings) {
  const save = version3Save();
  save.nodes = [];
  save.edges = [];
  save.globalSettings = { ...save.globalSettings, ...settings };
  return save;
}

function researchPrerequisiteClosure(researchId) {
  const researchesById = new Map(
    lookup.getAllResearches().map((research) => [research.id, research]),
  );
  const unlocked = new Set();
  const visit = (id) => {
    if (unlocked.has(id)) return;
    const research = researchesById.get(id);
    assert.ok(research, `expected research ${id} to exist`);
    unlocked.add(id);
    for (const prerequisite of research.prerequisites) {
      if (prerequisite.startsWith('s_')) visit(prerequisite);
    }
  };
  visit(researchId);
  return [...unlocked];
}

test('migrates the supported v2 format through v3 to v4 with its documented month default', () => {
  const migrated = migrateSaveData(version2Save(), 4, resolveRecipePorts);

  assert.equal(migrated.version, 4);
  assert.equal(migrated.globalSettings?.current_month, 'January');
  assert.deepEqual(migrated.edges[0].controlPoints, [{ x: 14, y: 15 }]);
  assert.equal(migrated.nodes.length, 2);
});

test('migrates v3 saves without a month to v4 with a January default', () => {
  const source = version3Save();
  const original = JSON.stringify(source);
  const migrated = migrateSaveData(source, 4, resolveRecipePorts);

  assert.equal(migrated.version, 4);
  assert.equal(migrated.globalSettings?.current_month, 'January');
  assert.equal(JSON.stringify(source), original);
});

function sampleGameLayout() {
  return {
    version: 1,
    machines: [{ key: 'n1#0', x: 3, y: -4, rot: 1, pinned: true, name: 'Drill', w: 4, h: 4 }],
    pipes: [
      {
        net: 'p_coal|n1:o0+n2:i0|0',
        large: false,
        nodes: [0, 0, 1, 0],
        edges: [0, 0, 1, 0, 0],
        label: 'Coal',
      },
    ],
    valves: [{ id: 'v1', x: 5, y: 5, rot: 2, sidePct: 25 }],
    passthroughs: [{ id: 'p1', x: 10, y: 10, horizontal: true, kind: 'Item' }],
    intersections: [{ id: 'i1', x: 20, y: 20 }],
  };
}

test('migrates v4 saves to v5 without inventing an in-game layout', () => {
  const migrated = migrateSaveData(version4Save(), 5, resolveRecipePorts);

  assert.equal(migrated.version, 5);
  assert.equal(migrated.gameLayout, undefined);
});

test('validates and round-trips the in-game layout of v5 saves', () => {
  const save = { ...version4Save(), version: 5, gameLayout: sampleGameLayout() };
  const migrated = migrateSaveData(save, 5, resolveRecipePorts);
  const reloaded = migrateSaveData(JSON.parse(JSON.stringify(migrated)), 5, resolveRecipePorts);

  assert.deepEqual(migrated.gameLayout, sampleGameLayout());
  assert.deepEqual(reloaded, migrated);
});

test('rejects an in-game layout on saves older than v5', () => {
  const save = { ...version4Save(), gameLayout: sampleGameLayout() };

  assert.throws(
    () => migrateSaveData(save, 5, resolveRecipePorts),
    /only supported from save version 5/,
  );
});

test('rejects malformed in-game layout data with the offending path', () => {
  const layout = sampleGameLayout();
  layout.pipes[0].edges = [0, 0, 1, 0];
  const save = { ...version4Save(), version: 5, gameLayout: layout };

  assert.throws(() => migrateSaveData(save, 5, resolveRecipePorts), /pipes\[0\]\.edges/);

  const badValve = sampleGameLayout();
  badValve.valves[0].sidePct = 150;
  assert.throws(
    () => migrateSaveData({ ...save, gameLayout: badValve }, 5, resolveRecipePorts),
    /sidePct/,
  );
});

test('preserves a valid month on v3 saves written by the previous app format', () => {
  const save = version3Save();
  save.globalSettings.current_month = 'October';

  const migrated = migrateSaveData(save, 4, resolveRecipePorts);

  assert.equal(migrated.globalSettings?.current_month, 'October');
});

test('validates and round-trips the current v4 format without losing graph or settings data', () => {
  const migrated = migrateSaveData(version4Save(), 4, resolveRecipePorts);
  const reloaded = migrateSaveData(JSON.parse(JSON.stringify(migrated)), 4, resolveRecipePorts);

  assert.deepEqual(reloaded, migrated);
  assert.equal(reloaded.nodes[0].settings?.customSetting, 'retained');
  assert.deepEqual(reloaded.nodes[0].outputOrder, [1, 0]);
  assert.equal(reloaded.edges[0].hidden, true);
  assert.equal(reloaded.globalSettings?.current_month, 'October');
  assert.equal(reloaded.dataOverrides?.[0].data.name, 'Custom product');
});

test('requires the game month in v4 saves', () => {
  const save = version4Save();
  delete save.globalSettings.current_month;

  assert.throws(
    () => migrateSaveData(save, 4, resolveRecipePorts),
    /globalSettings\.current_month must be a valid game month/,
  );

  const missingSettings = version4Save();
  delete missingSettings.globalSettings;
  assert.throws(
    () => migrateSaveData(missingSettings, 4, resolveRecipePorts),
    /globalSettings must include a valid game month/,
  );
});

test('rejects future versions before invoking recipe normalization and leaves the saved record unchanged', () => {
  const record = { id: 'future-save', name: 'Future', data: { ...version4Save(), version: 5 } };
  const original = JSON.stringify(record);
  let resolverCalled = false;

  assert.throws(
    () =>
      migrateSaveData(record.data, 4, () => {
        resolverCalled = true;
        return undefined;
      }),
    (error) =>
      error instanceof SaveMigrationError && /newer than this app supports/.test(error.message),
  );
  assert.equal(resolverCalled, false);
  assert.equal(JSON.stringify(record), original);
});

test('rejects unversioned and unsupported historical formats instead of assuming they are current', () => {
  assert.throws(
    () => migrateSaveData({ ...version2Save(), version: undefined }, 4, resolveRecipePorts),
    SaveMigrationError,
  );
  assert.throws(
    () => migrateSaveData({ ...version2Save(), version: 1 }, 4, resolveRecipePorts),
    /no explicit migration exists/,
  );
});

test('rejects unknown recipes without replacing their IDs', () => {
  const save = version2Save();
  save.nodes[0].recipeId = 'recipe:missing';
  const original = JSON.stringify(save);

  assert.throws(
    () => migrateSaveData(save, 4, resolveRecipePorts),
    /unknown recipe "recipe:missing"/,
  );
  assert.equal(save.nodes[0].recipeId, 'recipe:missing');
  assert.equal(JSON.stringify(save), original);
});

test('validates custom recipe ports from overrides only when those overrides are selected for loading', () => {
  const save = version2Save();
  save.nodes[0].recipeId = 'recipe:custom';
  const overrides = [{ id: 'recipe:custom', data: { inputs: [{}], outputs: [{}, {}] } }];
  save.dataOverrides = overrides;
  const resolveWithOverrides = (node, _globalSettings, selectedOverrides) => {
    if (node.recipeId === 'recipe:custom') {
      const override = selectedOverrides?.find((entry) => entry.id === 'recipe:custom');
      if (!override) return undefined;
      return {
        inputs: override.data.inputs.length,
        outputs: override.data.outputs.length,
      };
    }
    return resolveRecipePorts(node);
  };

  assert.throws(() => migrateSaveData(save, 4, resolveWithOverrides), /unknown recipe/);
  const migrated = migrateSaveData(save, 4, resolveWithOverrides, overrides);
  assert.equal(migrated.nodes[0].recipeId, 'recipe:custom');
});

test('rejects edges with missing nodes or ports instead of dropping them', () => {
  const missingNode = version2Save();
  missingNode.edges[0].target = 'deleted-node';
  assert.throws(
    () => migrateSaveData(missingNode, 4, resolveRecipePorts),
    /references missing recipe node/,
  );

  const missingPort = version2Save();
  missingPort.edges[0].sourceIndex = 2;
  assert.throws(() => migrateSaveData(missingPort, 4, resolveRecipePorts), /missing output port/);
});

test('rejects malformed nodes, settings, group references, and proxy handles instead of fabricating defaults', () => {
  const missingPosition = version2Save();
  delete missingPosition.nodes[0].position;
  assert.throws(() => migrateSaveData(missingPosition, 4, resolveRecipePorts), /must be an object/);

  const malformedSettings = version2Save();
  malformedSettings.nodes[0].settings = [];
  assert.throws(
    () => migrateSaveData(malformedSettings, 4, resolveRecipePorts),
    /must be an object/,
  );

  const missingGroup = version3Save();
  missingGroup.nodes[0].groupId = 'deleted-group';
  assert.throws(
    () => migrateSaveData(missingGroup, 4, resolveRecipePorts),
    /references missing group/,
  );

  const malformedProxy = version3Save();
  malformedProxy.nodes[2].inputProxyHandleIds = ['missing-node-input-0'];
  assert.throws(
    () => migrateSaveData(malformedProxy, 4, resolveRecipePorts),
    /references missing recipe port/,
  );
});

test('rejects malformed override entries rather than dropping them', () => {
  const save = version4Save();
  save.dataOverrides.push({ id: 'broken:entry', data: null });

  assert.throws(() => migrateSaveData(save, 4, resolveRecipePorts), /must be an object/);
});

test('serializes and deserializes a real canvas without losing nodes, edges, or settings', () => {
  const sourceRecipe = lookup.getAllRecipes().find((recipe) => recipe.outputs.length > 0);
  const targetRecipe = lookup.getAllRecipes().find((recipe) => recipe.inputs.length > 0);
  assert.ok(sourceRecipe);
  assert.ok(targetRecipe);

  const nodes = [
    {
      id: 'roundtrip-source',
      type: 'recipe',
      position: { x: 10, y: 20 },
      data: { recipeId: sourceRecipe.id, machineCount: 2, settings: { custom: 'kept' } },
    },
    {
      id: 'roundtrip-target',
      type: 'recipe',
      position: { x: 40, y: 50 },
      data: { recipeId: targetRecipe.id, machineCount: 1, settings: {} },
    },
  ];
  const edges = [
    {
      id: 'roundtrip-edge',
      source: 'roundtrip-source',
      sourceHandle: 'roundtrip-source-output-0',
      target: 'roundtrip-target',
      targetHandle: 'roundtrip-target-input-0',
      data: { controlPoints: [{ x: 15, y: 25 }] },
      hidden: true,
    },
  ];

  const serialized = transformer.serializeCanvas(nodes, edges);
  const restored = transformer.deserializeCanvas(serialized);
  const serializedAgain = transformer.serializeCanvas(restored.nodes, restored.edges);

  assert.equal(restored.nodes.length, 2);
  assert.equal(restored.edges.length, 1);
  assert.equal(restored.nodes[0].data.settings.custom, 'kept');
  assert.deepEqual(serializedAgain, serialized);
});

test('sandbox saves omit research IDs and restore every active research as unlocked', () => {
  const store = globalSettingsStore.useGlobalSettingsStore;
  const settingsBefore = structuredClone(store.getState().settings);
  const activeResearchIds = lookup.getAllResearches().map((research) => research.id);

  try {
    for (const difficulty of ['sandbox', 'sandbox_plus']) {
      store.setState({
        settings: { ...settingsBefore, difficulty, unlockedResearchIds: ['edited-research-id'] },
      });
      const saved = transformer.serializeCanvas([], []);

      assert.equal(Object.hasOwn(saved.globalSettings ?? {}, 'unlockedResearchIds'), false);
      transformer.applySaveSettings({
        ...saved.globalSettings,
        unlockedResearchIds: ['edited-research-id'],
      });
      assert.deepEqual(store.getState().settings.unlockedResearchIds, activeResearchIds);
    }

    const progressionResearch = lookup
      .getAllResearches()
      .find((research) => research.prerequisites.length > 0);
    assert.ok(progressionResearch);
    const progressionIds = researchPrerequisiteClosure(progressionResearch.id);
    store.setState({
      settings: { ...settingsBefore, difficulty: 'normal', unlockedResearchIds: progressionIds },
    });
    const progressionSave = transformer.serializeCanvas([], []);
    assert.deepEqual(progressionSave.globalSettings?.unlockedResearchIds, progressionIds);
    transformer.applySaveSettings(progressionSave.globalSettings);
    assert.deepEqual(store.getState().settings.unlockedResearchIds, progressionIds);
  } finally {
    store.setState({ settings: settingsBefore });
  }
});

test('rejects unsupported game modes before the save can reach application state', () => {
  assert.throws(
    () =>
      transformer.deserializeCanvas(
        emptySaveWithSettings({ difficulty: 'Sandbox', unlockedResearchIds: [] }),
      ),
    /globalSettings\.difficulty must be a supported game mode/,
  );
});

test('validates progression unlock IDs and requires their complete prerequisite chain', () => {
  const research = lookup.getAllResearches().find((entry) => entry.prerequisites.length > 0);
  assert.ok(research);

  assert.throws(
    () =>
      transformer.deserializeCanvas(
        emptySaveWithSettings({
          difficulty: 'normal',
          unlockedResearchIds: ['edited-research-id'],
        }),
      ),
    /references unknown research "edited-research-id"/,
  );

  assert.throws(
    () =>
      transformer.deserializeCanvas(
        emptySaveWithSettings({
          difficulty: 'normal',
          unlockedResearchIds: [research.id],
        }),
      ),
    /is unlocked while prerequisite .* is locked/,
  );

  const validSave = emptySaveWithSettings({
    difficulty: 'normal',
    unlockedResearchIds: researchPrerequisiteClosure(research.id),
  });
  assert.deepEqual(transformer.deserializeCanvas(validSave).globalSettings, {
    ...validSave.globalSettings,
    current_month: 'January',
  });
});

test('does not treat in-game action requirements as research IDs', () => {
  const researchWithActionRequirement = lookup
    .getAllResearches()
    .find((entry) => entry.prerequisites.some((prerequisite) => !prerequisite.startsWith('s_')));
  assert.ok(researchWithActionRequirement);

  const save = emptySaveWithSettings({
    difficulty: 'normal',
    unlockedResearchIds: researchPrerequisiteClosure(researchWithActionRequirement.id),
  });
  assert.doesNotThrow(() => transformer.deserializeCanvas(save));
});

test('rejects research that is unavailable in the saved game mode', () => {
  for (const [difficulty, researchId] of [
    ['hard', 's_energy_hand_crank'],
    ['impossible', 's_production_advanced_copper_extraction'],
    ['impossible2', 's_production_advanced_coal_extraction'],
  ]) {
    const save = emptySaveWithSettings({
      difficulty,
      unlockedResearchIds: [researchId],
    });
    assert.throws(
      () => transformer.deserializeCanvas(save),
      new RegExp(`research "${researchId}" that is unavailable in ${difficulty} mode`),
    );
  }
});

test('sandbox imports ignore redundant research IDs', () => {
  const save = emptySaveWithSettings({
    difficulty: 'sandbox',
    unlockedResearchIds: ['edited-research-id'],
  });
  assert.deepEqual(transformer.deserializeCanvas(save).globalSettings?.unlockedResearchIds, [
    'edited-research-id',
  ]);
});

test('failed deserialization leaves the named record, autosave payload, and global settings untouched', () => {
  const futureData = { ...version4Save(), version: 6 };
  const namedRecord = { id: 'named-save', data: futureData };
  const autosaveRecord = { id: 'tab:autosave', data: futureData };
  const namedBefore = JSON.stringify(namedRecord);
  const autosaveBefore = JSON.stringify(autosaveRecord);
  const settingsBefore = structuredClone(
    globalSettingsStore.useGlobalSettingsStore.getState().settings,
  );

  assert.throws(
    () => transformer.deserializeCanvas(namedRecord.data),
    /newer than this app supports/,
  );
  assert.throws(
    () => transformer.deserializeCanvas(autosaveRecord.data),
    /newer than this app supports/,
  );
  assert.equal(JSON.stringify(namedRecord), namedBefore);
  assert.equal(JSON.stringify(autosaveRecord), autosaveBefore);
  assert.deepEqual(globalSettingsStore.useGlobalSettingsStore.getState().settings, settingsBefore);

  const sourceRecipe = lookup.getAllRecipes().find((recipe) => recipe.outputs.length > 0);
  const targetRecipe = lookup.getAllRecipes().find((recipe) => recipe.inputs.length > 0);
  assert.ok(sourceRecipe);
  assert.ok(targetRecipe);
  const currentSave = transformer.serializeCanvas(
    [
      {
        id: 'source-node',
        type: 'recipe',
        position: { x: 0, y: 0 },
        data: { recipeId: sourceRecipe.id, machineCount: 1, settings: {} },
      },
      {
        id: 'target-node',
        type: 'recipe',
        position: { x: 0, y: 0 },
        data: { recipeId: targetRecipe.id, machineCount: 1, settings: {} },
      },
    ],
    [
      {
        id: 'edge',
        source: 'source-node',
        sourceHandle: 'source-node-output-0',
        target: 'target-node',
        targetHandle: 'target-node-input-0',
      },
    ],
  );
  const invalidCurrentSave = structuredClone(currentSave);
  invalidCurrentSave.globalSettings.global_pollution = 999;
  invalidCurrentSave.edges[0].sourceIndex = sourceRecipe.outputs.length;

  assert.throws(() => transformer.deserializeCanvas(invalidCurrentSave), /missing output port/);
  assert.deepEqual(globalSettingsStore.useGlobalSettingsStore.getState().settings, settingsBefore);
});
