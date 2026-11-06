import type { DocView } from '../../gameLayout/doc';
import { edgeKey } from '../../gameLayout/engine/flows';
import { key } from '../../gameLayout/engine/solution';
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
  if (piece) {
    const v = view.doc.valves.find((x) => x.id === piece);
    if (v)
      lines.push({
        label: 'Valve control',
        detail: `side ${v.sidePct}% / straight ${100 - v.sidePct}%`,
      });
    else if (view.doc.passthroughs.some((x) => x.id === piece))
      lines.push({ label: 'Large pipe passthrough' });
    else lines.push({ label: 'Large pipe intersection' });
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
