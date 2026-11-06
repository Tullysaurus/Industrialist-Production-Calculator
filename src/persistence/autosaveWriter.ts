import { useFlowStore } from '../stores/useFlowStore';
import { useGlobalSettingsStore } from '../stores/useGlobalSettingsStore';
import type { AutosaveRecord, SaveData } from '../types/saves';
import { getDataOverrides, publishAutosaveAsLatest, saveAutosave } from './idb';
import { serializeCanvas } from './transformer';
import { rotateAutosaveTabId } from './autosaveIdentity';

let writeQueue: Promise<void> = Promise.resolve();
const protectedWriteTargets = new Map<string, string>();
let autosaveWritesBlocked = false;
let startupAutosaveLoadComplete = false;
let baselineFingerprint: string | undefined;
let baselineModifiedAt: number | undefined;
let forceLatestPublication = false;
let latestPublicationPending = false;
let latestPublicationDeferralCount = 0;

export function markStartupAutosaveLoadComplete(): void {
  startupAutosaveLoadComplete = true;
}

function getCanvasFingerprint(data: SaveData): string {
  return JSON.stringify({
    nodes: data.nodes,
    edges: data.edges,
    globalSettings: data.globalSettings,
    gameLayout: data.gameLayout,
  });
}

export function establishAutosaveBaseline(record: AutosaveRecord | null): void {
  const flow = useFlowStore.getState();
  const snapshot = serializeCanvas(flow.nodes, flow.edges, [], flow.gameLayout);
  baselineFingerprint = getCanvasFingerprint(snapshot);
  const modifiedAt = record?.modifiedAt;
  baselineModifiedAt = record
    ? typeof modifiedAt === 'number' && Number.isFinite(modifiedAt)
      ? modifiedAt
      : record.timestamp
    : undefined;
  forceLatestPublication = false;
  latestPublicationPending = false;
}

export function markAutosaveFreshStart(): void {
  forceLatestPublication = true;
}

export function beginLatestPublicationDeferral(): void {
  latestPublicationDeferralCount++;
}

export function endLatestPublicationDeferral(): void {
  latestPublicationDeferralCount = Math.max(0, latestPublicationDeferralCount - 1);
}

export interface AutosaveWriteOptions {
  deferLatestPublication?: boolean;
}

export function preserveAutosaveAfterLoadFailure(tabId: string): boolean {
  establishAutosaveBaseline(null);
  if (protectedWriteTargets.has(tabId)) return !autosaveWritesBlocked;

  const replacementId = rotateAutosaveTabId();
  if (replacementId === tabId || (replacementId === 'latest' && tabId !== 'latest')) {
    autosaveWritesBlocked = true;
    return false;
  }

  protectedWriteTargets.set(tabId, replacementId);
  return true;
}

export interface AutosaveSnapshotVersion {
  nodes: ReturnType<typeof useFlowStore.getState>['nodes'];
  edges: ReturnType<typeof useFlowStore.getState>['edges'];
  settings: ReturnType<typeof useGlobalSettingsStore.getState>;
  targetId: string;
  publishLatest: boolean;
  fingerprint: string;
}

export function saveCurrentAutosave(
  tabId: string,
  options: AutosaveWriteOptions = {},
): Promise<AutosaveSnapshotVersion> {
  const write = writeQueue.then(async () => {
    if (!startupAutosaveLoadComplete) {
      throw new Error(
        'Autosave cannot be written until the existing startup save has been checked.',
      );
    }
    if (autosaveWritesBlocked) {
      throw new Error(
        'Autosave is paused because this browser could not create a separate slot for the preserved save.',
      );
    }
    const flow = useFlowStore.getState();
    const settings = useGlobalSettingsStore.getState();
    const overrides = await getDataOverrides();
    const targetId = protectedWriteTargets.get(tabId) ?? tabId;
    const data = serializeCanvas(flow.nodes, flow.edges, overrides, flow.gameLayout);
    const fingerprint = getCanvasFingerprint(data);
    const changed = baselineFingerprint !== undefined && fingerprint !== baselineFingerprint;
    const publishLatest = changed || forceLatestPublication || latestPublicationPending;
    if (baselineFingerprint !== undefined && !publishLatest) {
      return {
        nodes: flow.nodes,
        edges: flow.edges,
        settings,
        targetId,
        publishLatest,
        fingerprint,
      };
    }
    const modifiedAt = publishLatest
      ? Math.max(Date.now(), (baselineModifiedAt ?? 0) + 1)
      : (baselineModifiedAt ?? 0);
    const deferLatestPublication =
      options.deferLatestPublication === true || latestPublicationDeferralCount > 0;
    await saveAutosave(data, targetId, {
      modifiedAt,
      publishLatest: publishLatest && !deferLatestPublication,
    });
    baselineFingerprint = fingerprint;
    baselineModifiedAt = modifiedAt;
    if (deferLatestPublication && publishLatest) {
      latestPublicationPending = true;
    } else if (!deferLatestPublication) {
      forceLatestPublication = false;
      latestPublicationPending = false;
    }
    return { nodes: flow.nodes, edges: flow.edges, settings, targetId, publishLatest, fingerprint };
  });

  writeQueue = write.then(
    () => undefined,
    () => undefined,
  );
  return write;
}

export function publishCurrentAutosaveAsLatest(
  tabId: string,
  targetId: string,
  expected: AutosaveSnapshotVersion,
): Promise<boolean> {
  const write = writeQueue.then(async () => {
    if (!startupAutosaveLoadComplete) {
      throw new Error(
        'Autosave cannot be published until the existing startup save has been checked.',
      );
    }
    if (autosaveWritesBlocked) {
      throw new Error(
        'Autosave is paused because this browser could not create a separate slot for the preserved save.',
      );
    }
    const flow = useFlowStore.getState();
    const settings = useGlobalSettingsStore.getState();
    if (
      flow.nodes !== expected.nodes ||
      flow.edges !== expected.edges ||
      settings !== expected.settings ||
      baselineFingerprint !== expected.fingerprint
    ) {
      return false;
    }
    const resolvedTargetId = protectedWriteTargets.get(tabId) ?? targetId;
    await publishAutosaveAsLatest(resolvedTargetId);
    const flowAfter = useFlowStore.getState();
    const settingsAfter = useGlobalSettingsStore.getState();
    if (
      flowAfter.nodes !== expected.nodes ||
      flowAfter.edges !== expected.edges ||
      settingsAfter !== expected.settings
    ) {
      return false;
    }
    latestPublicationPending = false;
    forceLatestPublication = false;
    return true;
  });

  writeQueue = write.then(
    () => undefined,
    () => undefined,
  );
  return write;
}
