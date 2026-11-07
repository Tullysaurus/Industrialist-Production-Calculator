import {
  ArrowLeftRight,
  ArrowRight,
  ChevronDown,
  ChevronUp,
  CircleStop,
  Cross,
  Eraser,
  Gauge,
  Maximize,
  MousePointer2,
  Pin,
  RefreshCw,
  RotateCw,
  Route,
  Sparkles,
  Spline,
  Trash2,
  Waves,
} from 'lucide-react';
import { useState } from 'react';
import type { LayoutViewModel } from './useLayoutView';
import { evaluateDoc } from '../../gameLayout/doc';
import { deleteItems, rotateMachines, selectionSize, togglePinned } from '../../gameLayout/docOps';
import { emptyLayoutDoc, type GameLayoutDoc } from '../../gameLayout/docSchema';
import { routeNetworks, unroutedNetworks } from '../../gameLayout/routeTools';
import { useFlowStore } from '../../stores/useFlowStore';
import {
  useGameLayoutStore,
  type EditorTool,
  type FlowView,
} from '../../stores/useGameLayoutStore';
import { useUIStore } from '../../stores/useUIStore';
import styles from './GameLayout.module.css';

const TOOLS: { id: EditorTool; label: string; key: string; Icon: typeof Spline }[] = [
  { id: 'select', label: 'Select', key: 'V', Icon: MousePointer2 },
  { id: 'pipe', label: 'Pipe', key: 'W', Icon: Spline },
  { id: 'erase', label: 'Erase', key: 'E', Icon: Eraser },
  { id: 'valve', label: 'Valve', key: 'Q', Icon: Gauge },
  { id: 'passthrough', label: 'Passthru', key: 'T', Icon: ArrowLeftRight },
  { id: 'intersection', label: 'Cross', key: 'I', Icon: Cross },
];

const FLOW_LABEL: Record<FlowView, string> = {
  planned: 'Planned',
  even: 'Even split',
  valve: 'As built',
};
const NEXT_FLOW: Record<FlowView, FlowView> = { planned: 'even', even: 'valve', valve: 'planned' };

/** Only the pinned machines / pipes / pieces of a document (what the generator keeps). */
function pinnedPart(doc: GameLayoutDoc | null): GameLayoutDoc | null {
  if (!doc) return null;
  const machines = doc.machines.filter((m) => m.pinned);
  if (!machines.length) return null;
  return {
    version: 1,
    machines,
    pipes: doc.pipes.filter((p) => p.pinned),
    valves: doc.valves.filter((v) => v.pinned),
    passthroughs: doc.passthroughs.filter((p) => p.pinned),
    intersections: doc.intersections.filter((p) => p.pinned),
  };
}

export function GameLayoutTray({ model }: { model: LayoutViewModel }) {
  const [minimized, setMinimized] = useState(false);
  const tool = useGameLayoutStore((s) => s.tool);
  const selection = useGameLayoutStore((s) => s.selection);
  const flowView = useGameLayoutStore((s) => s.flowView);
  const showArrows = useGameLayoutStore((s) => s.showArrows);
  const running = useGameLayoutStore((s) => s.generator.status === 'running');
  const st = useGameLayoutStore.getState;
  const setDoc = useFlowStore((s) => s.setGameLayout);
  const { view, doc, input, ctx } = model;
  const hasSelection = selectionSize(selection) > 0;
  const noMachines = ctx.problem.instances.length === 0;

  const generate = async () => {
    if (running) {
      st().stopGenerator();
      return;
    }
    const unpinned =
      (doc?.machines ?? []).filter((m) => !m.pinned).length +
      (doc?.pipes ?? []).filter((p) => !p.pinned).length;
    if (unpinned) {
      const ok = await useUIStore.getState().confirm({
        title: 'GENERATE LAYOUT',
        message:
          'The generator lays out every machine and pipe again. Pinned machines and pipes stay exactly where they are; everything else is replaced (undo brings it back).',
        confirmLabel: 'GENERATE',
        intent: 'info',
      });
      if (!ok) return;
    }
    st().startGenerator(input, pinnedPart(doc), (res) => {
      setDoc(res.doc);
      const s = res.summary;
      st().notify(
        s.fullyRouted
          ? `Layout ready: ${s.width} x ${s.height}, ${s.empty.toLocaleString()} empty tiles`
          : `Best layout so far has ${s.conflicts} conflicting tile(s); see Problems`,
        s.fullyRouted ? 'success' : 'error',
      );
      st().requestFit();
    });
  };

  const autoRoute = () => {
    const nets = unroutedNetworks(view);
    if (!nets.length) {
      st().notify('Everything that can be routed is routed');
      return;
    }
    const res = routeNetworks(view, nets, 10);
    setDoc(res.doc);
    st().notify(
      res.failed.length
        ? `Routed ${res.routed} pipe(s); no room for ${res.failed.length}: ${res.failed.slice(0, 3).join(', ')}`
        : `Routed ${res.routed} pipe(s)${res.conflictFree ? '' : ' (some still conflict, see Problems)'}`,
      res.failed.length ? 'error' : 'success',
    );
  };

  const reroute = () => {
    const P = ctx.problem;
    const insts = new Set<number>();
    for (const k of selection.machines) {
      const g = ctx.instByKey.get(k);
      if (g !== undefined) insts.add(g);
    }
    const nets = P.nets
      .map((n, i) => [n, i] as const)
      .filter(([n]) => selection.pipes.has(n.key) || n.terminals.some((t) => insts.has(t.inst)))
      .map(([, i]) => i);
    if (!nets.length) {
      st().notify('Select pipes or machines to re-route');
      return;
    }
    const base = evaluateDoc(ctx, doc ?? emptyLayoutDoc(), { analyse: false });
    const res = routeNetworks(base, nets, 10);
    setDoc(res.doc);
    st().notify(
      `Re-routed ${res.routed} pipe(s)${res.failed.length ? `, no room for ${res.failed.length}` : ''}`,
      res.failed.length ? 'error' : 'success',
    );
  };

  const actions: {
    id: string;
    label: string;
    Icon: typeof Spline;
    onClick: () => void;
    disabled?: boolean;
    active?: boolean;
    title: string;
  }[] = [
    {
      id: 'generate',
      label: running ? 'Stop' : 'Generate',
      Icon: running ? CircleStop : Sparkles,
      onClick: () => void generate(),
      disabled: noMachines && !running,
      active: running,
      title: running
        ? 'Stop and keep the best layout so far'
        : 'Lay out everything automatically (pinned items stay)',
    },
    {
      id: 'autoroute',
      label: 'Auto-route',
      Icon: Route,
      onClick: autoRoute,
      disabled: running || !doc,
      title: 'Route every connection between placed machines that is not routed yet',
    },
    {
      id: 'reroute',
      label: 'Re-route',
      Icon: RefreshCw,
      onClick: reroute,
      disabled: running || !hasSelection,
      title: 'Re-route the selected pipes and the pipes of the selected machines',
    },
    {
      id: 'rotate',
      label: 'Rotate',
      Icon: RotateCw,
      onClick: () => doc && setDoc(rotateMachines(doc, ctx, selection.machines)),
      disabled: running || !selection.machines.size,
      title: 'Rotate the selected machines (R)',
    },
    {
      id: 'pin',
      label: 'Pin',
      Icon: Pin,
      onClick: () => doc && setDoc(togglePinned(doc, selection)),
      disabled: running || !hasSelection,
      title: 'Pin / unpin the selection: the generator keeps pinned items (P)',
    },
    {
      id: 'delete',
      label: 'Delete',
      Icon: Trash2,
      onClick: () => {
        if (!doc) return;
        setDoc(deleteItems(doc, selection));
        st().clearSelection();
      },
      disabled: running || !hasSelection,
      title: 'Delete the selection; machines go back to Unplaced (Del)',
    },
    {
      id: 'flow',
      label: FLOW_LABEL[flowView],
      Icon: Waves,
      onClick: () => st().setFlowView(NEXT_FLOW[flowView]),
      title: 'Flows shown: as planned, with even splits, or as built (valves at their settings)',
    },
    {
      id: 'arrows',
      label: 'Arrows',
      Icon: ArrowRight,
      onClick: () => st().toggleArrows(),
      active: showArrows,
      title: 'Show flow direction arrows',
    },
    {
      id: 'fit',
      label: 'Fit',
      Icon: Maximize,
      onClick: () => st().requestFit(),
      title: 'Fit the layout in view (F)',
    },
  ];

  return (
    <div className={styles.tray}>
      <button type="button" className={styles['tray-bar']} onClick={() => setMinimized((m) => !m)}>
        <span className={styles['tray-bar-text']}>
          {minimized ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
          {minimized ? 'SHOW LAYOUT TOOLS' : 'HIDE LAYOUT TOOLS'}
        </span>
      </button>
      {!minimized && (
        <div className={styles['tray-rows']}>
          <div className={styles['tray-row']}>
            {TOOLS.map(({ id, label, key, Icon }) => (
              <button
                key={id}
                type="button"
                className={styles['tray-button']}
                data-active={tool === id ? 'true' : 'false'}
                onClick={() => st().setTool(id)}
                disabled={running}
                title={`${label} (${key})`}
              >
                <Icon size={16} />
                <span className={styles['tray-label']}>{label}</span>
              </button>
            ))}
          </div>
          <div className={styles['tray-row']}>
            {actions.map(({ id, label, Icon, onClick, disabled, active, title }) => (
              <button
                key={id}
                type="button"
                className={styles['tray-button']}
                data-active={active ? 'true' : 'false'}
                onClick={onClick}
                disabled={disabled}
                title={title}
              >
                <Icon size={16} />
                <span className={styles['tray-label']}>{label}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
