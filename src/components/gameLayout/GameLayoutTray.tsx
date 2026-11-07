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
  PinOff,
  RefreshCw,
  RotateCw,
  Route,
  Sparkles,
  Spline,
  Trash2,
  Plug,
  PlugZap,
  Repeat2,
  UtilityPole,
  Waves,
  WandSparkles,
  X,
  Zap,
} from 'lucide-react';
import { useState } from 'react';
import type { LayoutViewModel } from './useLayoutView';
import { evaluateDoc } from '../../gameLayout/doc';
import {
  deleteItems,
  rotateMachines,
  selectionSize,
  togglePinned,
  withAttachedPipes,
} from '../../gameLayout/docOps';
import { emptyLayoutDoc, type GameLayoutDoc } from '../../gameLayout/docSchema';
import { routeNetworks, tidyNetworks, unroutedNetworks } from '../../gameLayout/routeTools';
import { useFlowStore } from '../../stores/useFlowStore';
import {
  useGameLayoutStore,
  type EditorTool,
  type FlowView,
} from '../../stores/useGameLayoutStore';
import { useUIStore } from '../../stores/useUIStore';
import styles from './GameLayout.module.css';

interface ToolDef {
  id: EditorTool;
  label: string;
  key: string;
  Icon: typeof Spline;
  /** What the tool does (tooltip). */
  help: string;
}

const TOOL_GROUPS: { title: string; tools: ToolDef[] }[] = [
  {
    title: 'Edit',
    tools: [
      {
        id: 'select',
        label: 'Select',
        key: 'V',
        Icon: MousePointer2,
        help: 'Click or drag a box to select machines, pipes and pieces; drag to move them',
      },
      {
        id: 'pipe',
        label: 'Draw pipe',
        key: 'W',
        Icon: Spline,
        help: 'Click a port, then another port to lay a pipe between them, or paint tiles',
      },
      {
        id: 'erase',
        label: 'Erase tiles',
        key: 'E',
        Icon: Eraser,
        help: 'Drag over tiles to remove the pipe tiles and pieces on them (machines stay)',
      },
    ],
  },
  {
    title: 'Pipe pieces',
    tools: [
      {
        id: 'valve',
        label: 'Valve',
        key: 'Q',
        Icon: Gauge,
        help: 'Place a valve control on a normal pipe (R rotates)',
      },
      {
        id: 'passthrough',
        label: 'Passthrough',
        key: 'T',
        Icon: ArrowLeftRight,
        help: 'Place a passthrough where a normal pipe crosses a large pipe (R rotates)',
      },
      {
        id: 'intersection',
        label: 'Crossing',
        key: 'I',
        Icon: Cross,
        help: 'Place a 2x2 intersection where two large pipes meet',
      },
    ],
  },
  {
    title: 'Power',
    tools: [
      {
        id: 'hv',
        label: 'HV pole',
        key: 'H',
        Icon: UtilityPole,
        help: 'Place an HV pole (12x12, 8 nodes of 120 MMF/s)',
      },
      {
        id: 'mv',
        label: 'MV pole',
        key: 'M',
        Icon: Plug,
        help: 'Place an MV pole (2x1, 4 nodes of 1.5 MMF/s; R rotates)',
      },
      {
        id: 'transformer',
        label: 'Transformer',
        key: 'K',
        Icon: Repeat2,
        help: 'Place an HV transformer (8x8; R rotates)',
      },
      {
        id: 'grid',
        label: 'Grid link',
        key: 'G',
        Icon: PlugZap,
        help: 'Place the external HV grid connection',
      },
    ],
  },
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
    power: (doc.power ?? []).filter((p) => p.pinned),
  };
}

export function GameLayoutTray({ model }: { model: LayoutViewModel }) {
  const [minimized, setMinimized] = useState(false);
  const tool = useGameLayoutStore((s) => s.tool);
  const selection = useGameLayoutStore((s) => s.selection);
  const flowView = useGameLayoutStore((s) => s.flowView);
  const showArrows = useGameLayoutStore((s) => s.showArrows);
  const showPower = useGameLayoutStore((s) => s.showPower);
  const quantum = useGameLayoutStore((s) => s.options.quantum);
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
    const res = routeNetworks(view, nets, 10, quantum);
    setDoc(res.doc);
    st().notify(
      res.failed.length
        ? `Routed ${res.routed} pipe(s); no room for ${res.failed.length}: ${res.failed.slice(0, 3).join(', ')}`
        : `Routed ${res.routed} pipe(s)${res.conflictFree ? '' : ' (some still conflict, see Problems)'}`,
      res.failed.length ? 'error' : 'success',
    );
  };

  /** The selected pipes and the pipes of the selected machines. */
  const selectedNets = () => {
    const P = ctx.problem;
    const insts = new Set<number>();
    for (const k of selection.machines) {
      const g = ctx.instByKey.get(k);
      if (g !== undefined) insts.add(g);
    }
    return P.nets
      .map((n, i) => [n, i] as const)
      .filter(([n]) => selection.pipes.has(n.key) || n.terminals.some((t) => insts.has(t.inst)))
      .map(([, i]) => i);
  };

  const tidy = (onlySelected: boolean) => {
    const nets = onlySelected ? selectedNets() : undefined;
    if (onlySelected && !nets?.length) {
      st().notify('Select pipes or machines to tidy');
      return;
    }
    const base = evaluateDoc(ctx, doc ?? emptyLayoutDoc(), { analyse: false });
    const res = tidyNetworks(base, nets, quantum, 5);
    if (res.changed) setDoc(res.doc);
    st().notify(
      res.changed
        ? `Tidied ${res.changed} pipe(s): shorter, fewer bends, closer to the machines`
        : 'The pipes are already as tidy as this pass gets them',
      res.changed ? 'success' : 'info',
    );
  };

  const reroute = () => {
    const nets = selectedNets();
    if (!nets.length) {
      st().notify('Select pipes or machines to re-route');
      return;
    }
    const base = evaluateDoc(ctx, doc ?? emptyLayoutDoc(), { analyse: false });
    const res = routeNetworks(base, nets, 10, quantum);
    setDoc(res.doc);
    st().notify(
      `Re-routed ${res.routed} pipe(s)${res.failed.length ? `, no room for ${res.failed.length}` : ''}`,
      res.failed.length ? 'error' : 'success',
    );
  };

  type Action = {
    id: string;
    label: string;
    Icon: typeof Spline;
    onClick: () => void;
    disabled?: boolean;
    active?: boolean;
    title: string;
  };
  const layoutActions: Action[] = [
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
      label: 'Route missing',
      Icon: Route,
      onClick: autoRoute,
      disabled: running || !doc,
      title: 'Lay pipes for every connection between placed machines that has none yet',
    },
    {
      id: 'tidy',
      label: 'Tidy pipes',
      Icon: WandSparkles,
      onClick: () => tidy(false),
      disabled: running || !doc?.pipes.length,
      title:
        'Lay every pipe again where that is shorter, with fewer bends and closer to the machines (pinned pipes stay; valves are laid again on moved pipes)',
    },
  ];
  const viewActions: Action[] = [
    {
      id: 'flow',
      label: `Flows: ${FLOW_LABEL[flowView]}`,
      Icon: Waves,
      onClick: () => st().setFlowView(NEXT_FLOW[flowView]),
      title:
        'Which flows are shown (click to switch): as planned, with even splits, or as built (valves at their settings)',
    },
    {
      id: 'arrows',
      label: 'Arrows',
      Icon: ArrowRight,
      onClick: () => st().toggleArrows(),
      active: showArrows,
      title: 'Show flow direction arrows on pipes (on / off)',
    },
    {
      id: 'power',
      label: 'Cables',
      Icon: Zap,
      onClick: () => st().togglePower(),
      active: showPower,
      title: 'Show power cables (on / off); poles and transformers are always shown',
    },
    {
      id: 'fit',
      label: 'Fit view',
      Icon: Maximize,
      onClick: () => st().requestFit(),
      title: 'Zoom to fit the whole layout (F)',
    },
  ];
  // the selection and what can be done with it (only shown while something is selected)
  const selCount = [
    [selection.machines.size, 'machine'],
    [selection.pipes.size, 'pipe'],
    [selection.pieces.size, 'piece'],
  ]
    .filter(([n]) => (n as number) > 0)
    .map(([n, w]) => `${n} ${w}${n === 1 ? '' : 's'}`)
    .join(', ');
  const allPinned =
    !!doc &&
    [
      ...doc.machines.filter((m) => selection.machines.has(m.key)),
      ...doc.pipes.filter((p) => selection.pipes.has(p.net)),
      ...[...doc.valves, ...doc.passthroughs, ...doc.intersections, ...(doc.power ?? [])].filter(
        (p) => selection.pieces.has(p.id),
      ),
    ].every((x) => x.pinned);
  const selectionActions: Action[] = [
    {
      id: 'rotate',
      label: 'Rotate',
      Icon: RotateCw,
      onClick: () => doc && setDoc(rotateMachines(doc, ctx, selection.machines)),
      disabled: running || !selection.machines.size,
      title: 'Rotate the selected machines a quarter turn (R)',
    },
    {
      id: 'reroute',
      label: 'Re-route',
      Icon: RefreshCw,
      onClick: reroute,
      disabled: running,
      title: 'Lay the selected pipes, and the pipes of the selected machines, again',
    },
    {
      id: 'tidy-sel',
      label: 'Tidy',
      Icon: WandSparkles,
      onClick: () => tidy(true),
      disabled: running,
      title: 'Tidy the selected pipes and the pipes of the selected machines',
    },
    {
      id: 'pin',
      label: allPinned ? 'Unpin' : 'Pin',
      Icon: allPinned ? PinOff : Pin,
      onClick: () => doc && setDoc(togglePinned(doc, selection)),
      disabled: running,
      title: allPinned
        ? 'Unpin: the generator may move these again (P)'
        : 'Pin: the generator keeps these exactly where they are (P)',
    },
    {
      id: 'delete',
      label: 'Delete',
      Icon: Trash2,
      onClick: () => {
        if (!doc) return;
        setDoc(deleteItems(doc, withAttachedPipes(selection, ctx)));
        st().clearSelection();
      },
      disabled: running,
      title:
        'Remove the selection and the pipes of selected machines; machines go back to the Unplaced list (Del)',
    },
    {
      id: 'clear',
      label: 'Deselect',
      Icon: X,
      onClick: () => st().clearSelection(),
      title: 'Clear the selection (Esc)',
    },
  ];

  const button = ({ id, label, Icon, onClick, disabled, active, title }: Action) => (
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
  );

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
          {hasSelection && !running && (
            <div className={styles['tray-selection']}>
              <span className={styles['tray-selection-text']}>{selCount} selected</span>
              {selectionActions.map(button)}
            </div>
          )}
          <div className={styles['tray-row']}>
            {TOOL_GROUPS.map((g) => (
              <div key={g.title} className={styles['tray-group']}>
                <span className={styles['tray-group-title']}>{g.title}</span>
                <div className={styles['tray-group-buttons']}>
                  {g.tools.map(({ id, label, key, Icon, help }) => (
                    <button
                      key={id}
                      type="button"
                      className={styles['tray-button']}
                      data-active={tool === id ? 'true' : 'false'}
                      onClick={() => st().setTool(id)}
                      disabled={running}
                      title={`${label} (${key}): ${help}`}
                    >
                      <Icon size={16} />
                      <span className={styles['tray-label']}>{label}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className={styles['tray-row']}>
            <div className={styles['tray-group']}>
              <span className={styles['tray-group-title']}>Layout</span>
              <div className={styles['tray-group-buttons']}>{layoutActions.map(button)}</div>
            </div>
            <div className={styles['tray-group']}>
              <span className={styles['tray-group-title']}>View</span>
              <div className={styles['tray-group-buttons']}>{viewActions.map(button)}</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
