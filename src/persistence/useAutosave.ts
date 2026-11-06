import { useEffect } from 'react';
import { useFlowStore } from '../stores/useFlowStore';
import { useUIStore } from '../stores/useUIStore';
import { useGlobalSettingsStore } from '../stores/useGlobalSettingsStore';
import { getAutosave } from './idb';
import { applySaveSettings, deserializeCanvas } from './transformer';
import { getAutosaveTabId, getStartupAutosaveTabId } from './autosaveIdentity';
import {
  establishAutosaveBaseline,
  markAutosaveFreshStart,
  markStartupAutosaveLoadComplete,
  preserveAutosaveAfterLoadFailure,
  saveCurrentAutosave,
} from './autosaveWriter';

let startupAutosavePromise: ReturnType<typeof getAutosave> | null = null;

export function getStartupAutosave(): ReturnType<typeof getAutosave> {
  if (!startupAutosavePromise) {
    const request = getAutosave(getStartupAutosaveTabId());
    const cachedRequest = request.catch((error: unknown) => {
      if (startupAutosavePromise === cachedRequest) startupAutosavePromise = null;
      throw error;
    });
    startupAutosavePromise = cachedRequest;
  }
  return startupAutosavePromise;
}

export function useAutosave(): void {
  useEffect(() => {
    let isMounted = true;
    let startupRestoreIsApplying = false;
    let startupResolved = false;
    let changedBeforeStartupResolved = false;
    let dirtyVersion = 0;
    let lastSavedVersion = 0;
    let isSaving = false;
    let autosaveFailureReported = false;

    const loadStartupAutosave = async () => {
      let record: Awaited<ReturnType<typeof getAutosave>> = null;
      let readFailed = false;

      while (isMounted) {
        try {
          record = await getStartupAutosave();
          break;
        } catch (err) {
          if (!isMounted) return;
          console.warn('Failed to read autosave on startup:', err);
          const detail = err instanceof Error ? err.message : 'The save data could not be read.';
          const retry = await useUIStore.getState().confirm({
            title: 'AUTOSAVE COULD NOT BE READ',
            message: `${detail}\n\nRetry the read, or continue without restoring. The existing autosave will remain preserved.`,
            confirmLabel: 'RETRY',
            cancelLabel: 'CONTINUE WITHOUT RESTORING',
            intent: 'error',
          });
          if (!isMounted) return;
          if (retry) continue;

          readFailed = true;
          preserveAutosaveAfterLoadFailure(getAutosaveTabId());
          break;
        }
      }

      if (!isMounted) return;
      if (readFailed) return;

      if (record?.data) {
        let canvas: ReturnType<typeof deserializeCanvas>;
        try {
          canvas = deserializeCanvas(record.data);
        } catch (error) {
          const tabId = getAutosaveTabId();
          const preservedSeparateSlot = preserveAutosaveAfterLoadFailure(tabId);
          const detail =
            error instanceof Error ? error.message : 'The save data could not be validated.';
          const nextStep = preservedSeparateSlot
            ? 'The original autosave remains unchanged. New changes in this tab will use a separate autosave slot.'
            : 'The original autosave remains unchanged, but this browser could not create a separate slot, so autosaving is paused for this session.';
          await useUIStore.getState().confirm({
            title: 'AUTOSAVE COULD NOT BE LOADED',
            message: `${detail}\n\n${nextStep}`,
            confirmLabel: 'CONTINUE',
            showCancel: false,
            intent: 'error',
          });
          return;
        }

        const currentStore = useFlowStore.getState();
        const canRestore =
          !changedBeforeStartupResolved &&
          currentStore.nodes.length === 0 &&
          currentStore.edges.length === 0;
        if (canRestore) {
          const { nodes, edges, globalSettings } = canvas;

          if (nodes.length >= 250) {
            const confirmed = await useUIStore.getState().confirm({
              title: 'PERFORMANCE WARNING',
              message: `This autosave contains ${nodes.length} nodes. Loading this graph will degrade graph performance and take a while to load. Continue?`,
              confirmLabel: 'LOAD AUTOSAVE',
              cancelLabel: 'START FRESH',
              intent: 'info',
            });
            if (!isMounted) return;

            if (!confirmed) {
              establishAutosaveBaseline(null);
              markAutosaveFreshStart();
              dirtyVersion++;
              return;
            }
          }

          const restoreTarget = useFlowStore.getState();
          if (
            changedBeforeStartupResolved ||
            restoreTarget.nodes.length > 0 ||
            restoreTarget.edges.length > 0
          ) {
            establishAutosaveBaseline(record);
            markAutosaveFreshStart();
            return;
          }

          startupRestoreIsApplying = true;
          try {
            currentStore.setNodesAndEdges(nodes, edges, {
              recordHistory: false,
              resetHistory: true,
            });
            currentStore.setGameLayout(canvas.gameLayout, { recordHistory: false });
            applySaveSettings(globalSettings);
          } finally {
            startupRestoreIsApplying = false;
          }
          establishAutosaveBaseline(record);
          return;
        }

        establishAutosaveBaseline(record);
        if (changedBeforeStartupResolved) markAutosaveFreshStart();
        return;
      }

      establishAutosaveBaseline(null);
      if (changedBeforeStartupResolved) markAutosaveFreshStart();
    };

    void loadStartupAutosave()
      .catch(async (err: unknown) => {
        console.warn('Failed to load autosave on startup:', err);
        if (!isMounted) return;
        const hasSeparateSlot = preserveAutosaveAfterLoadFailure(getAutosaveTabId());
        const detail = err instanceof Error ? err.message : 'The save data could not be loaded.';
        await useUIStore.getState().confirm({
          title: 'AUTOSAVE COULD NOT BE LOADED',
          message: `${detail}\n\n${hasSeparateSlot ? 'The original autosave remains unchanged; future changes will use a separate slot.' : 'The original autosave remains unchanged, but this browser could not create a separate slot, so autosaving is paused for this session.'}`,
          confirmLabel: 'CONTINUE',
          showCancel: false,
          intent: 'error',
        });
      })
      .finally(() => {
        if (!isMounted) return;
        startupResolved = true;
        markStartupAutosaveLoadComplete();
        useUIStore.getState().setAutosaveLoaded();
      });

    const unsub = useFlowStore.subscribe(
      (state) => ({ nodes: state.nodes, edges: state.edges, gameLayout: state.gameLayout }),
      () => {
        dirtyVersion++;
        if (!startupRestoreIsApplying && !startupResolved) {
          changedBeforeStartupResolved = true;
        }
      },
      {
        equalityFn: (prev, next) =>
          prev.nodes === next.nodes &&
          prev.edges === next.edges &&
          prev.gameLayout === next.gameLayout,
      },
    );

    const unsubGlobalSettings = useGlobalSettingsStore.subscribe(() => {
      dirtyVersion++;
      if (!startupRestoreIsApplying && !startupResolved) {
        changedBeforeStartupResolved = true;
      }
    });

    const saveIfDirty = () => {
      if (dirtyVersion === lastSavedVersion) return;
      if (isSaving) return;

      isSaving = true;
      const capturedVersion = dirtyVersion;
      saveCurrentAutosave(getAutosaveTabId())
        .then(() => {
          autosaveFailureReported = false;
          if (dirtyVersion === capturedVersion) {
            lastSavedVersion = capturedVersion;
          }
        })
        .catch(async (err) => {
          console.warn('Failed to commit autosave interval:', err);
          if (autosaveFailureReported) return;
          autosaveFailureReported = true;
          const detail =
            err instanceof Error ? err.message : 'The current canvas could not be saved.';
          await useUIStore.getState().confirm({
            title: 'AUTOSAVE COULD NOT BE UPDATED',
            message: `${detail}\n\nThe previous autosave remains unchanged. The current canvas changes have not been saved yet; automatic retries will continue.`,
            confirmLabel: 'CONTINUE',
            showCancel: false,
            intent: 'error',
          });
        })
        .finally(() => {
          isSaving = false;
        });
    };

    const intervalId = setInterval(() => {
      if (!document.hidden) saveIfDirty();
    }, 5000);

    const handleBeforeUnload = () => {
      void saveCurrentAutosave(getAutosaveTabId()).catch((err) => {
        console.warn('Failed to commit autosave beforeunload:', err);
      });
    };

    const handleVisibilityChange = () => {
      if (document.hidden) saveIfDirty();
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      isMounted = false;
      clearInterval(intervalId);
      unsub();
      unsubGlobalSettings();
      window.removeEventListener('beforeunload', handleBeforeUnload);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);
}
