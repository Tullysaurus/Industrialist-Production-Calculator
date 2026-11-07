import { ChevronDown, ChevronRight, CircleAlert, Pin, TriangleAlert } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import type { LayoutViewModel } from './useLayoutView';
import type { LayoutProblem } from '../../gameLayout/doc';
import { valveGeometry } from '../../gameLayout/doc';
import { deleteOrphans, emptySelection, updateValve } from '../../gameLayout/docOps';
import { edgeKey } from '../../gameLayout/engine/flows';
import { key } from '../../gameLayout/engine/solution';
import { useFlowStore } from '../../stores/useFlowStore';
import { useGameLayoutStore } from '../../stores/useGameLayoutStore';
import { useUIStore } from '../../stores/useUIStore';
import type { RateMode } from '../../types/ui';
import { formatPct, formatRate } from './format';
import styles from './GameLayout.module.css';

const BUDGETS = [15, 30, 60, 120, 300, 600];

function Section({
  title,
  badge,
  children,
  defaultOpen = true,
}: {
  title: string;
  badge?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={styles.panel}>
      <button type="button" className={styles['panel-header']} onClick={() => setOpen((o) => !o)}>
        <span className={styles['panel-title']}>
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {title}
        </span>
        {badge}
      </button>
      {open && <div className={styles['panel-body']}>{children}</div>}
    </section>
  );
}

function Row({
  label,
  value,
  tone,
}: {
  label: string;
  value: ReactNode;
  tone?: 'error' | 'success';
}) {
  return (
    <div className={styles['stat-row']}>
      <span className={styles['stat-label']}>{label}</span>
      <span className={styles['stat-value']} data-tone={tone ?? 'none'}>
        {value}
      </span>
    </div>
  );
}

export function GameLayoutSidebar({ model }: { model: LayoutViewModel }) {
  const { view, doc, ctx } = model;
  const P = ctx.problem;
  const rateMode = useUIStore((s) => s.rateMode);
  const st = useGameLayoutStore.getState;
  const options = useGameLayoutStore((s) => s.options);
  const generator = useGameLayoutStore((s) => s.generator);
  const placing = useGameLayoutStore((s) => s.placing);
  const setDoc = useFlowStore((s) => s.setGameLayout);
  const [showLog, setShowLog] = useState(false);

  const [x0, y0, x1, y1] = view.sol.bbox;
  const errors = view.problems.filter((p) => p.severity === 'error');
  const warnings = view.problems.filter((p) => p.severity === 'warning');

  // unplaced machines grouped by flowchart node
  const unplacedGroups = useMemo(() => {
    const m = new Map<number, number[]>();
    for (const g of view.unplaced) {
      const ni = P.instances[g][0];
      if (!m.has(ni)) m.set(ni, []);
      m.get(ni)!.push(g);
    }
    return [...m].map(([ni, insts]) => ({ ni, insts }));
  }, [view.unplaced, P]);

  const openProblem = (p: LayoutProblem) => {
    if (p.tiles.length) st().focusTiles(p.tiles);
    const sel = emptySelection();
    if (p.machineKey) sel.machines.add(p.machineKey);
    if (p.netKey) sel.pipes.add(p.netKey);
    if (p.pieceId) sel.pieces.add(p.pieceId);
    st().setSelection(sel);
  };

  const progress = generator.progress;
  const pct = progress ? Math.min(1, progress.elapsed / Math.max(1, progress.budget)) : 0;

  return (
    <aside className={styles.sidebar} aria-label="In-game layout">
      <Section title="In-game layout">
        <Row
          label="Footprint"
          value={
            x1 > x0 ? `${x1 - x0} × ${y1 - y0} = ${((x1 - x0) * (y1 - y0)).toLocaleString()}` : '-'
          }
        />
        <Row label="Machines placed" value={`${view.placed.size} / ${P.instances.length}`} />
        <Row
          label="Pipes routed"
          value={`${P.nets.filter((_n, i) => view.sol.netNodes[i].size).length} / ${P.nets.length}`}
        />
        <Row
          label="Valves · passthroughs"
          value={`${view.doc.valves.length} · ${view.doc.passthroughs.length}`}
        />
        <Row
          label="Empty tiles"
          value={
            x1 > x0
              ? `${view.sol.hull.empty.toLocaleString()} (${Math.round((100 * view.sol.hull.empty) / Math.max(1, view.sol.hull.hull))}%)`
              : '-'
          }
        />
        <Row
          label="Power (HV · MV · transformers)"
          value={(() => {
            const pw = view.doc.power ?? [];
            const n = (k: string) => pw.filter((p) => p.kind === k).length;
            return pw.length ? `${n('hv')} · ${n('mv')} · ${n('transformer')}` : '-';
          })()}
        />
        <Row
          label="Problems"
          value={
            errors.length
              ? `${errors.length} error(s)`
              : warnings.length
                ? `${warnings.length} warning(s)`
                : 'none'
          }
          tone={errors.length ? 'error' : 'success'}
        />
      </Section>

      <Section title="Generator" defaultOpen={!doc}>
        <label className={styles.field}>
          <span>Time budget</span>
          <select
            value={options.timeBudget}
            onChange={(e) => st().setOptions({ timeBudget: Number(e.target.value) })}
            disabled={generator.status === 'running'}
          >
            {BUDGETS.map((b) => (
              <option key={b} value={b}>
                {b < 60 ? `${b} s` : `${b / 60} min`}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={options.valves}
            onChange={(e) => st().setOptions({ valves: e.target.checked })}
            disabled={generator.status === 'running'}
          />
          <span>Add valves where even splits would starve machines</span>
        </label>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={options.power}
            onChange={(e) => st().setOptions({ power: e.target.checked })}
            disabled={generator.status === 'running'}
          />
          <span>Place power poles, transformers and the grid connection</span>
        </label>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={options.rows}
            onChange={(e) => st().setOptions({ rows: e.target.checked })}
            disabled={generator.status === 'running'}
          />
          <span>Same machines in rows</span>
        </label>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={options.facing}
            onChange={(e) => st().setOptions({ facing: e.target.checked })}
            disabled={generator.status === 'running'}
          />
          <span>Ports facing shared corridors (inputs one side, outputs the other)</span>
        </label>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={options.flowOrder}
            onChange={(e) => st().setOptions({ flowOrder: e.target.checked })}
            disabled={generator.status === 'running'}
          />
          <span>Production in flow order (raw materials to products)</span>
        </label>
        <label className={styles.field}>
          <span>Tidy vs. compact</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={options.tidiness}
            onChange={(e) => st().setOptions({ tidiness: Number(e.target.value) })}
            disabled={generator.status === 'running'}
            title="How much extra space the layout may use to be tidier"
          />
        </label>
        <p className={styles.hint}>
          Generate keeps pinned machines and pipes where they are and lays out the rest around them.
        </p>
        {generator.status === 'running' && (
          <div className={styles.progress}>
            <div className={styles['progress-text']}>
              {progress?.message ?? 'Starting…'} · {Math.round(progress?.elapsed ?? 0)}s
            </div>
            <div className={styles['progress-track']}>
              <div
                className={styles['progress-fill']}
                ref={(el) => el?.style.setProperty('--progress', String(pct))}
              />
            </div>
            {progress?.bestEmpty != null && (
              <div className={styles['progress-text']}>
                Best: {progress.bestEmpty.toLocaleString()} empty tiles
                {progress.bestRouted ? ', fully routed' : ', routing'}
              </div>
            )}
          </div>
        )}
        {generator.status === 'error' && <p className={styles.error}>{generator.error}</p>}
        {generator.last && generator.status !== 'running' && (
          <Row
            label="Last run"
            value={`${generator.last.empty.toLocaleString()} empty of ${generator.last.hullArea.toLocaleString()} tiles, ${Math.round(generator.last.elapsed)}s`}
          />
        )}
        {generator.log.length > 0 && (
          <button
            type="button"
            className={styles['link-button']}
            onClick={() => setShowLog((s) => !s)}
          >
            {showLog ? 'Hide log' : 'Show log'}
          </button>
        )}
        {showLog && <pre className={styles.log}>{generator.log.join('\n')}</pre>}
      </Section>

      {unplacedGroups.length > 0 && (
        <Section
          title="Unplaced"
          badge={<span className={styles.badge}>{view.unplaced.length}</span>}
        >
          <p className={styles.hint}>
            Click to place, R rotates, Shift+click keeps placing the same machine.
          </p>
          <ul className={styles.list}>
            {unplacedGroups.map(({ ni, insts }) => {
              const node = P.nodes[ni];
              const active = placing !== null && P.instances[placing.inst][0] === ni;
              return (
                <li key={ni}>
                  <button
                    type="button"
                    className={styles['list-button']}
                    data-active={active ? 'true' : 'false'}
                    onClick={() => st().startPlacing(insts[0])}
                  >
                    <span className={styles['list-name']}>{node.name}</span>
                    <span className={styles['list-meta']}>
                      {insts.length} × {node.shape.w}×{node.shape.h}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </Section>
      )}

      <Section
        title="Problems"
        badge={
          errors.length + warnings.length ? (
            <span className={styles.badge} data-tone={errors.length ? 'error' : 'warning'}>
              {errors.length + warnings.length}
            </span>
          ) : undefined
        }
        defaultOpen={false}
      >
        {view.orphanMachines.length + view.orphanPipes.length > 0 && (
          <button
            type="button"
            className={styles['link-button']}
            onClick={() => doc && setDoc(deleteOrphans(doc, view.orphanMachines, view.orphanPipes))}
          >
            Remove {view.orphanMachines.length} machine(s) and {view.orphanPipes.length} pipe(s) of
            deleted flowchart items (hidden, kept for undo)
          </button>
        )}
        {!view.problems.length && <p className={styles.hint}>No problems.</p>}
        <ul className={styles.list}>
          {[...errors, ...warnings].slice(0, 200).map((p, i) => (
            <li key={i}>
              <button
                type="button"
                className={styles['problem-button']}
                data-severity={p.severity}
                onClick={() => openProblem(p)}
              >
                {p.severity === 'error' ? <CircleAlert size={12} /> : <TriangleAlert size={12} />}
                <span>{p.message}</span>
              </button>
            </li>
          ))}
        </ul>
      </Section>

      <Inspector model={model} rateMode={rateMode} />
      <Shortcuts />
    </aside>
  );
}

function Inspector({ model: m, rateMode: rm }: { model: LayoutViewModel; rateMode: RateMode }) {
  const sel = useGameLayoutStore((x) => x.selection);
  const setDoc = useFlowStore((x) => x.setGameLayout);
  const { doc, ctx } = m;
  const P = ctx.problem;
  const total = sel.machines.size + sel.pipes.size + sel.pieces.size;
  if (!total) return null;
  const v = m.view;
  if (total > 1) {
    return (
      <Section title="Selection">
        <Row label="Machines" value={sel.machines.size} />
        <Row label="Pipes" value={sel.pipes.size} />
        <Row label="Pieces" value={sel.pieces.size} />
      </Section>
    );
  }
  const [mk] = sel.machines;
  if (mk) {
    const g = ctx.instByKey.get(mk);
    const dm = doc?.machines.find((x) => x.key === mk);
    if (g === undefined || !dm) {
      return (
        <Section title="Machine">
          <p className={styles.error}>This machine is no longer in the flowchart.</p>
        </Section>
      );
    }
    const [ni, li] = P.instances[g];
    const node = P.nodes[ni];
    const an = v.analysis;
    const slots = [...node.slots.values()].sort((a, b) => a.idx - b.idx);
    return (
      <Section title="Machine">
        <div className={styles['inspector-title']}>
          {dm.pinned && <Pin size={12} />} {node.name} #{li + 1}
        </div>
        <Row label="Position" value={`${dm.x}, ${dm.y} · ${dm.rot * 90}°`} />
        {an && (
          <>
            <Row label="Planned run" value={formatPct(an.plannedRun[g] ?? 0)} />
            <Row label="With even splits" value={formatPct(an.runEven?.[g] ?? 0)} />
            <Row label="As built" value={formatPct(an.runValve?.[g] ?? 0)} />
          </>
        )}
        {slots
          .filter((s) => s.rate !== null)
          .map((s) => (
            <Row
              key={`${s.direction}${s.idx}`}
              label={`${s.direction === 'input' ? 'In' : 'Out'}: ${s.product ? (P.productNames.get(s.product) ?? s.product) : '?'}`}
              value={formatRate(
                (s.rate ?? 0) * (node.count ? node.effectiveCount / node.count : 0),
                rm,
              )}
            />
          ))}
      </Section>
    );
  }
  const [pk] = sel.pipes;
  if (pk) {
    const ni = ctx.netByKey.get(pk);
    if (ni === undefined) {
      return (
        <Section title="Pipe">
          <p className={styles.error}>Its flowchart connection changed: re-route or delete it.</p>
        </Section>
      );
    }
    const net = P.nets[ni];
    const nf = v.analysis?.nets[ni];
    const splits = nf
      ? [...nf.junctions.values()].filter((j) => j.kind === 'split' || j.kind === 'mix')
      : [];
    const uneven = splits.filter((j) => !j.evenOk).length;
    return (
      <Section title="Pipe">
        <div className={styles['inspector-title']}>{net.label}</div>
        <Row label="Type" value={`${net.kind}${net.large ? ', large' : ''}`} />
        <Row label="Planned flow" value={net.flow === null ? '?' : formatRate(net.flow, rm)} />
        <Row label="Capacity" value={formatRate(net.capacity, rm)} />
        <Row label="Tiles" value={v.sol.cells[ni].size} />
        <Row label="Machines" value={net.terminals.length} />
        <Row
          label="Splits"
          value={`${splits.length}${uneven ? `, ${uneven} uneven` : ''}`}
          tone={uneven ? 'error' : undefined}
        />
      </Section>
    );
  }
  const [pid] = sel.pieces;
  const valve = doc?.valves.find((x) => x.id === pid);
  if (valve && doc) {
    // planned share at the valve's middle tile
    const vg = valveGeometry(valve);
    const M = key(vg.m[0], vg.m[1]);
    let planned: number | null = null;
    const pv = v.valves.find((x) => x.node === M);
    if (pv && v.analysis) {
      const nf = v.analysis.nets[pv.net];
      let tin = 0;
      for (const u of nf.adj.get(M) ?? []) tin += nf.edgeFlow.get(edgeKey(u, M)) ?? 0;
      const side = nf.edgeFlow.get(edgeKey(M, pv.side)) ?? 0;
      if (tin > 0) planned = Math.round((1000 * side) / tin) / 10;
    }
    return (
      <Section title="Valve">
        <label className={styles.field}>
          <span>Side outlet %</span>
          <input
            type="number"
            min={0}
            max={100}
            step={0.1}
            value={valve.sidePct}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n))
                setDoc(updateValve(doc, valve.id, { sidePct: Math.min(100, Math.max(0, n)) }));
            }}
          />
        </label>
        <Row label="Straight" value={`${(100 - valve.sidePct).toFixed(1)}%`} />
        {planned !== null && (
          <button
            type="button"
            className={styles['link-button']}
            onClick={() => setDoc(updateValve(doc, valve.id, { sidePct: planned! }))}
          >
            Use the planned share ({planned}%)
          </button>
        )}
        {!pv && <p className={styles.error}>Not on a valid pipe (see Problems).</p>}
      </Section>
    );
  }
  const pt = doc?.passthroughs.find((x) => x.id === pid);
  if (pt) {
    return (
      <Section title="Passthrough">
        <Row label="Carries" value={pt.kind} />
        <Row label="Large pipe runs" value={pt.horizontal ? 'horizontally' : 'vertically'} />
      </Section>
    );
  }
  return (
    <Section title="Intersection">
      <p className={styles.hint}>2×2 crossing of two large pipes.</p>
    </Section>
  );
}

function Shortcuts() {
  return (
    <Section title="Shortcuts" defaultOpen={false}>
      <ul className={styles.shortcuts}>
        <li>
          <kbd>V</kbd> select · <kbd>W</kbd> pipe · <kbd>E</kbd> erase
        </li>
        <li>
          <kbd>Q</kbd> valve · <kbd>T</kbd> passthrough · <kbd>I</kbd> intersection
        </li>
        <li>
          <kbd>H</kbd> HV pole · <kbd>M</kbd> MV pole · <kbd>K</kbd> transformer · <kbd>G</kbd> grid
          connection
        </li>
        <li>
          <kbd>R</kbd> rotate · <kbd>P</kbd> pin · <kbd>Del</kbd> delete · <kbd>F</kbd> fit
        </li>
        <li>Pipe tool: drag to paint tile by tile, or click a port then click the target.</li>
        <li>Shift+drag on empty space selects an area; drag empty space or right-drag to pan.</li>
        <li>
          <kbd>Ctrl</kbd>+<kbd>Z</kbd> / <kbd>Ctrl</kbd>+<kbd>Y</kbd> undo and redo layout edits
          too.
        </li>
      </ul>
    </Section>
  );
}
