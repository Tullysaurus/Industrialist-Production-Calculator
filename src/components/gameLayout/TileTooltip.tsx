import { fmt as fmtPower, pieceName, POLE } from '../../gameLayout/engine/power';
import type { DocView } from '../../gameLayout/doc';
import { edgeKey } from '../../gameLayout/engine/flows';
import { key } from '../../gameLayout/engine/solution';
import { describeSides, pieceRoutes, sharedTileRoutes } from '../../gameLayout/junctionRoutes';
import { useGameLayoutStore } from '../../stores/useGameLayoutStore';
import { useUIStore } from '../../stores/useUIStore';
import { formatRate } from './format';
import type { HitIndex } from './GameLayoutCanvas';
import styles from './GameLayout.module.css';

interface Props {
  view: DocView;
  hit: HitIndex;
  tile: [number, number];
  px: number;
  py: number;
}

/** What is on the hovered tile: machine, pipes (with flow), pieces. */
export function TileTooltip({ view, hit, tile, px, py }: Props) {
  const rateMode = useUIStore((s) => s.rateMode);
  const flowView = useGameLayoutStore((s) => s.flowView);
  const t = key(tile[0], tile[1]);
  const P = view.ctx.problem;
  const lines: { label: string; detail?: string; tone?: 'fluid' | 'item' | 'error' }[] = [];
  const inst = hit.machineAt.get(t);
  if (inst !== undefined) {
    const [ni, li] = P.instances[inst];
    lines.push({ label: `${P.nodes[ni].name}`, detail: `#${li + 1} of ${P.nodes[ni].count}` });
    const use = P.nodes[ni].powerUse ?? 0;
    if (use > 0) {
      const off = view.sol.powerResult?.unpowered.has(inst);
      lines.push({
        label: `Power ${P.nodes[ni].powerType ?? ''}`,
        detail: `${fmtPower(use)}${off === undefined ? '' : off ? ' - not connected' : ' - connected'}`,
        ...(off ? { tone: 'error' as const } : {}),
      });
    }
  }
  const nets = hit.netsAt.get(t) ?? [];
  for (const ni of nets) {
    const net = P.nets[ni];
    const nf = view.analysis?.nets[ni];
    let f = 0;
    if (nf) {
      const fl =
        flowView === 'planned' ? nf.edgeFlow : flowView === 'even' ? nf.simFlow : nf.valveFlow;
      for (const v of nf.adj.get(t) ?? [])
        f = Math.max(f, fl.get(edgeKey(v, t)) ?? 0, fl.get(edgeKey(t, v)) ?? 0);
    }
    lines.push({
      label: `${net.label}${net.large ? ' (large)' : ''}`,
      detail: `${formatRate(f, rateMode)} of ${formatRate(net.capacity, rateMode)}`,
      tone: net.kind === 'Fluid' ? 'fluid' : 'item',
    });
  }
  const port = hit.portNets.get(t);
  if (port && !nets.length) {
    lines.push({
      label: `Port for ${port.map((ni) => P.nets[ni].label).join(', ')}`,
      detail: 'not connected',
    });
  }
  const piece = hit.pieceAt.get(t);
  const pp = piece ? (view.doc.power ?? []).find((x) => x.id === piece) : undefined;
  if (pp) {
    const i = (view.doc.power ?? []).indexOf(pp);
    const pr = view.sol.powerResult;
    const load = pr?.load[i] ?? 0;
    const nodes = pr?.nodeUse[i]?.filter((u) => u > 0).length ?? 0;
    const spec = pp.kind === 'hv' ? POLE.HV : pp.kind === 'mv' ? POLE.MV : null;
    lines.push({
      label: pieceName(pp.kind),
      detail: spec
        ? `${fmtPower(load)} of ${fmtPower(spec.nodes * spec.rating)}, ${nodes} of ${spec.nodes} nodes in use`
        : pp.kind === 'transformer'
          ? `${fmtPower(load)} out (MV), 15% loss`
          : 'external HV supply',
    });
  } else if (piece) {
    const v = view.doc.valves.find((x) => x.id === piece);
    if (v)
      lines.push({
        label: 'Valve control',
        detail: `side ${v.sidePct}% / straight ${100 - v.sidePct}%`,
      });
    else if (view.doc.passthroughs.some((x) => x.id === piece))
      lines.push({ label: 'Large pipe passthrough' });
    else {
      lines.push({ label: 'Large pipe intersection' });
      const it = view.doc.intersections.find((x) => x.id === piece);
      if (it) {
        for (const r of pieceRoutes(view.sol, it.x, it.y)) {
          lines.push({ label: P.nets[r.net].label, detail: describeSides(r.sides), tone: 'fluid' });
        }
      }
    }
  } else {
    // two normal pipes sharing the tile: where each one goes
    for (const r of sharedTileRoutes(view.sol, t)) {
      const net = P.nets[r.net];
      lines.push({
        label: `${net.label} through this tile`,
        detail: describeSides(r.sides),
        tone: net.kind === 'Fluid' ? 'fluid' : 'item',
      });
    }
  }
  for (const pr of view.problems) {
    if (pr.severity === 'error' && pr.tiles.some(([x, y]) => x === tile[0] && y === tile[1])) {
      lines.push({ label: pr.message, tone: 'error' });
    }
  }
  if (!lines.length) return null;
  return (
    <div
      className={styles.tooltip}
      data-flip-x={px > 260 ? 'true' : 'false'}
      ref={(el) => {
        if (el) {
          el.style.setProperty('--tip-x', `${px}px`);
          el.style.setProperty('--tip-y', `${py}px`);
        }
      }}
    >
      <div className={styles['tooltip-coord']}>
        {tile[0]}, {tile[1]}
      </div>
      {lines.map((l, i) => (
        <div key={i} className={styles['tooltip-line']} data-tone={l.tone ?? 'none'}>
          <span>{l.label}</span>
          {l.detail && <span className={styles['tooltip-detail']}>{l.detail}</span>}
        </div>
      ))}
    </div>
  );
}
