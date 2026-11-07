/**
 * Canvas 2D drawing of the in-game layout: machines, ports, pipes, logistics pieces, problems,
 * selection and tool previews. Colours come from the active theme's CSS tokens.
 */
import { pieceSize, transformerPorts, type PowerKind } from '../../gameLayout/engine/power';
import type { DocView } from '../../gameLayout/doc';
import { passthroughTiles, valveGeometry } from '../../gameLayout/doc';
import type { DocValve, GameLayoutDoc } from '../../gameLayout/docSchema';
import type { Selection } from '../../gameLayout/docOps';
import { edgeKey } from '../../gameLayout/engine/flows';
import type { Shape } from '../../gameLayout/engine/geometry';
import { EDGE_CROSS, EDGE_HOP, EDGE_LCROSS, EDGE_LNODE } from '../../gameLayout/engine/router';
import { lcrossMid } from '../../gameLayout/engine/intersection';
import { KX, kx, ky } from '../../gameLayout/engine/solution';
import {
  pieceRoutes,
  sharedTileRoutes,
  sharedTiles,
  type JunctionRoute,
} from '../../gameLayout/junctionRoutes';
import type { FlowView } from '../../stores/useGameLayoutStore';

export interface Camera {
  /** Tile at the top-left of the canvas. */
  x: number;
  y: number;
  /** Pixels per tile. */
  scale: number;
}

export interface Theme {
  bg: string;
  grid: string;
  machine: string;
  machineBorder: string;
  text: string;
  textDim: string;
  item: string;
  fluid: string;
  primary: string;
  error: string;
  warning: string;
  success: string;
  input: string;
  output: string;
}

export function readTheme(el: Element): Theme {
  const cs = getComputedStyle(el);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    bg: v('--theme-color-canvas-bg', 'Canvas'),
    grid: v('--theme-color-grid-dots', 'GrayText'),
    machine: v('--theme-color-node-bg', 'Canvas'),
    machineBorder: v('--theme-color-node-border', 'CanvasText'),
    text: v('--theme-color-text-primary', 'CanvasText'),
    textDim: v('--theme-color-text-secondary', 'GrayText'),
    item: v('--theme-color-item', 'CanvasText'),
    fluid: v('--theme-color-fluid', 'LinkText'),
    primary: v('--theme-color-primary', 'Highlight'),
    error: v('--theme-color-error', 'Mark'),
    warning: v('--theme-color-warning', 'Mark'),
    success: v('--theme-color-success', 'Highlight'),
    input: v('--theme-color-handle-input-supplied', 'Highlight'),
    output: v('--theme-color-handle-output-connected', 'Mark'),
  };
}

export interface Overlay {
  /** Machine ghost (placing / dragging): shape at tile position, valid or not. */
  ghosts: { shape: Shape; x: number; y: number; ok: boolean }[];
  /** Valve / passthrough / intersection ghost. */
  pieceGhost: {
    kind: 'valve' | 'passthrough' | 'intersection' | 'power';
    /** Power piece kind (kind 'power'). */
    power?: PowerKind;
    x: number;
    y: number;
    rot: number;
  } | null;
  /** Pipe preview: tile keys and flat [a, b, kind] edges. */
  pipePreview: { nodes: number[]; edges: number[]; large: boolean; ok: boolean } | null;
  /** Live offset of the dragged selection (tiles). */
  drag: { dx: number; dy: number } | null;
  marquee: [number, number, number, number] | null;
  hover: [number, number] | null;
  /** Item under the pointer (select tool): a machine instance, a pipe network or a piece. */
  hoverItem: { inst: number } | { net: number } | { piece: string } | null;
  /** Highlighted network (pipe tool). */
  activeNet: number | null;
  focus: [number, number][] | null;
}

export interface DrawOptions {
  flowView: FlowView;
  showArrows: boolean;
  showLabels: boolean;
  /** Draw power cables. */
  showPower: boolean;
  selection: Selection;
  /** Shown instead of the document while the generator runs. */
  preview: GameLayoutDoc | null;
}

const netBBoxCache = new WeakMap<DocView, [number, number, number, number][]>();

function netBBoxes(view: DocView): [number, number, number, number][] {
  let b = netBBoxCache.get(view);
  if (b) return b;
  b = view.sol.cells.map((cells) => {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const c of cells) {
      const x = kx(c);
      const y = ky(c);
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
    return [x0, y0, x1 + 1, y1 + 1] as [number, number, number, number];
  });
  netBBoxCache.set(view, b);
  return b;
}

export function drawLayout(
  g: CanvasRenderingContext2D,
  width: number,
  height: number,
  cam: Camera,
  view: DocView,
  theme: Theme,
  opt: DrawOptions,
  ov: Overlay,
): void {
  const s = cam.scale;
  const X = (x: number) => (x - cam.x) * s;
  const Y = (y: number) => (y - cam.y) * s;
  const vx0 = cam.x - 2;
  const vy0 = cam.y - 2;
  const vx1 = cam.x + width / s + 2;
  const vy1 = cam.y + height / s + 2;
  const visible = (x0: number, y0: number, x1: number, y1: number) =>
    x1 >= vx0 && y1 >= vy0 && x0 <= vx1 && y0 <= vy1;

  g.fillStyle = theme.bg;
  g.fillRect(0, 0, width, height);

  // grid
  if (s >= 8) {
    g.strokeStyle = theme.grid;
    g.globalAlpha = s >= 16 ? 0.35 : 0.18;
    g.lineWidth = 1;
    g.beginPath();
    for (let x = Math.floor(cam.x); x <= cam.x + width / s; x++) {
      g.moveTo(Math.round(X(x)) + 0.5, 0);
      g.lineTo(Math.round(X(x)) + 0.5, height);
    }
    for (let y = Math.floor(cam.y); y <= cam.y + height / s; y++) {
      g.moveTo(0, Math.round(Y(y)) + 0.5);
      g.lineTo(width, Math.round(Y(y)) + 0.5);
    }
    g.stroke();
    g.globalAlpha = 1;
  }

  const P = view.ctx.problem;
  const sel = opt.selection;
  const dragOf = (selected: boolean) => (selected && ov.drag ? ov.drag : { dx: 0, dy: 0 });

  // ---- pipes
  const boxes = netBBoxes(view);
  const hoverNet = ov.hoverItem && !ov.drag && 'net' in ov.hoverItem ? ov.hoverItem.net : -1;
  const an = view.analysis;
  P.nets.forEach((net, ni) => {
    const nodes = view.sol.netNodes[ni];
    if (!nodes.size) return;
    const [bx0, by0, bx1, by1] = boxes[ni];
    if (!visible(bx0, by0, bx1, by1)) return;
    const selected = sel.pipes.has(net.key) || ov.activeNet === ni;
    const { dx, dy } = dragOf(sel.pipes.has(net.key));
    const col = net.kind === 'Fluid' ? theme.fluid : theme.item;
    g.strokeStyle = selected ? theme.primary : col;
    g.fillStyle = selected ? theme.primary : col;
    const dim = ov.activeNet !== null && ov.activeNet !== ni;
    g.globalAlpha = dim ? 0.35 : 1;
    const off = net.large ? 1 : 0.5;
    g.lineCap = 'round';
    g.lineWidth = Math.max(1, s * (net.large ? 1.4 : 0.32));
    const e = view.sol.netEdges[ni];
    g.beginPath();
    for (let i = 0; i < e.length; i += 3) {
      if (e[i + 2] !== 0 && e[i + 2] !== EDGE_LNODE) continue;
      g.moveTo(X(kx(e[i]) + dx + off), Y(ky(e[i]) + dy + off));
      g.lineTo(X(kx(e[i + 1]) + dx + off), Y(ky(e[i + 1]) + dy + off));
    }
    // through an intersection piece: in to the middle of the piece and out (the piece draws
    // the actual path inside it on top)
    for (let i = 0; i < e.length; i += 3) {
      if (e[i + 2] !== EDGE_LCROSS) continue;
      const f = lcrossMid(e[i], e[i + 1], KX);
      g.moveTo(X(kx(e[i]) + dx + off), Y(ky(e[i]) + dy + off));
      g.lineTo(X(kx(f) + dx + 1), Y(ky(f) + dy + 1));
      g.lineTo(X(kx(e[i + 1]) + dx + off), Y(ky(e[i + 1]) + dy + off));
    }
    if (hoverNet === ni && !selected) {
      // hovered (like a hovered flowchart node): a glow under the pipe
      g.save();
      g.strokeStyle = theme.primary;
      g.globalAlpha = 0.5;
      g.lineWidth += Math.max(4, s * 0.5);
      g.stroke();
      g.restore();
    }
    g.stroke();
    // hops and passthrough crossings: dashed
    g.setLineDash([Math.max(2, s * 0.4), Math.max(2, s * 0.3)]);
    g.beginPath();
    for (let i = 0; i < e.length; i += 3) {
      const k = e[i + 2];
      if (k !== EDGE_HOP && k !== EDGE_CROSS) continue;
      g.moveTo(X(kx(e[i]) + dx + off), Y(ky(e[i]) + dy + off));
      g.lineTo(X(kx(e[i + 1]) + dx + off), Y(ky(e[i + 1]) + dy + off));
    }
    g.stroke();
    g.setLineDash([]);
    // single tiles (stubs, junction dots)
    const r = Math.max(1, s * (net.large ? 0.75 : 0.2));
    for (const c of nodes) {
      const deg = degreeOf(view, ni, c);
      if (deg === 2) continue;
      g.beginPath();
      g.arc(X(kx(c) + dx + off), Y(ky(c) + dy + off), r, 0, Math.PI * 2);
      g.fill();
    }
    // flow arrows
    if (opt.showArrows && an && s >= 6 && !dim) {
      const nf = an.nets[ni];
      const fl =
        opt.flowView === 'planned'
          ? nf.edgeFlow
          : opt.flowView === 'even'
            ? nf.simFlow
            : nf.valveFlow;
      g.fillStyle = theme.bg;
      for (let i = 0; i < e.length; i += 3) {
        const a = e[i];
        const b = e[i + 1];
        const f1 = fl.get(edgeKey(a, b)) ?? 0;
        const f2 = fl.get(edgeKey(b, a)) ?? 0;
        if (Math.max(f1, f2) <= 1e-9) continue;
        const [p, q] = f1 >= f2 ? [a, b] : [b, a];
        if (((kx(p) + ky(p)) & 3) !== 0 && e[i + 2] === 0) continue; // every few tiles
        arrow(
          g,
          X(kx(p) + dx + off),
          Y(ky(p) + dy + off),
          X(kx(q) + dx + off),
          Y(ky(q) + dy + off),
          s * (net.large ? 0.5 : 0.22),
        );
      }
    }
    g.globalAlpha = 1;
  });

  // ---- pieces
  const doc = view.doc;
  g.lineWidth = Math.max(1, s * 0.12);
  for (const pt of doc.passthroughs) {
    const { dx, dy } = dragOf(sel.pieces.has(pt.id));
    const [w, h] = pt.horizontal ? [4, 2] : [2, 4];
    if (!visible(pt.x, pt.y, pt.x + w, pt.y + h)) continue;
    g.strokeStyle = sel.pieces.has(pt.id) ? theme.primary : theme.machineBorder;
    g.fillStyle = theme.machine;
    g.globalAlpha = 0.85;
    g.fillRect(X(pt.x + dx), Y(pt.y + dy), w * s, h * s);
    g.globalAlpha = 1;
    g.strokeRect(X(pt.x + dx), Y(pt.y + dy), w * s, h * s);
    g.strokeStyle = pt.kind === 'Fluid' ? theme.fluid : theme.item;
    g.beginPath();
    for (const m of [1, 2]) {
      if (pt.horizontal) {
        g.moveTo(X(pt.x + dx + m + 0.5), Y(pt.y + dy));
        g.lineTo(X(pt.x + dx + m + 0.5), Y(pt.y + dy + 2));
      } else {
        g.moveTo(X(pt.x + dx), Y(pt.y + dy + m + 0.5));
        g.lineTo(X(pt.x + dx + 2), Y(pt.y + dy + m + 0.5));
      }
    }
    g.stroke();
    void passthroughTiles;
  }
  // which pipe goes where: each pipe's path through the piece / shared tile, the second one
  // with a halo so two paths never read as joined
  const routeStyle = (ni: number, base: number, k: number) => {
    const net = P.nets[ni];
    const selected = sel.pipes.has(net.key) || ov.activeNet === ni;
    return {
      color: selected ? theme.primary : net.kind === 'Fluid' ? theme.fluid : theme.item,
      alpha: ov.activeNet !== null && ov.activeNet !== ni ? 0.35 : 1,
      width: base,
      halo: k > 0,
    };
  };
  for (const it of doc.intersections) {
    const { dx, dy } = dragOf(sel.pieces.has(it.id));
    if (!visible(it.x, it.y, it.x + 2, it.y + 2)) continue;
    g.fillStyle = theme.machine;
    g.fillRect(X(it.x + dx), Y(it.y + dy), 2 * s, 2 * s);
    g.lineWidth = Math.max(1, s * 0.12);
    g.strokeStyle = sel.pieces.has(it.id) ? theme.primary : theme.machineBorder;
    g.strokeRect(X(it.x + dx), Y(it.y + dy), 2 * s, 2 * s);
    const routes = pieceRoutes(view.sol, it.x, it.y);
    drawRoutes(g, X(it.x + dx), Y(it.y + dy), 2 * s, routes, theme, (ni, k) =>
      routeStyle(ni, s * 0.75, k),
    );
  }
  g.lineWidth = Math.max(1, s * 0.12);
  if (s >= 8) {
    for (const c of sharedTiles(view.sol)) {
      const x = kx(c);
      const y = ky(c);
      if (!visible(x, y, x + 1, y + 1)) continue;
      const routes = sharedTileRoutes(view.sol, c);
      // only where the two pipes cross (no common side); side by side runs stay as drawn
      if (routes.length !== 2 || routes[0].sides.some((k) => routes[1].sides.includes(k))) continue;
      const moved = routes.some((r) => sel.pipes.has(P.nets[r.net].key)) && ov.drag;
      if (moved) continue;
      g.fillStyle = theme.bg;
      g.fillRect(X(x), Y(y), s, s);
      drawRoutes(g, X(x), Y(y), s, routes, theme, (ni, k) => routeStyle(ni, s * 0.3, k));
    }
  }
  for (const v of doc.valves)
    drawValve(
      g,
      v,
      X,
      Y,
      s,
      theme,
      sel.pieces.has(v.id),
      dragOf(sel.pieces.has(v.id)),
      opt.showLabels,
    );

  // ---- machines
  const fontPx = (n: number) => `${Math.round(n)}px system-ui, sans-serif`;
  for (const m of view.sol.machines) {
    const dm = view.machineOf.get(m.inst);
    const selected = !!dm && sel.machines.has(dm.key);
    const { dx, dy } = dragOf(selected);
    const x = m.x + dx;
    const y = m.y + dy;
    if (!visible(x, y, x + m.shape.w, y + m.shape.h)) continue;
    g.fillStyle = theme.machine;
    g.strokeStyle = selected ? theme.primary : theme.machineBorder;
    g.lineWidth = selected ? Math.max(2, s * 0.18) : Math.max(1, s * 0.08);
    for (const r of m.shape.rects) {
      g.fillRect(X(x + r.x), Y(y + r.y), r.w * s, r.h * s);
      g.strokeRect(X(x + r.x), Y(y + r.y), r.w * s, r.h * s);
    }
    // ports
    if (s >= 3) {
      for (const p of m.shape.ports.values()) {
        g.fillStyle =
          p.direction === 'input'
            ? theme.input
            : p.direction === 'output'
              ? theme.output
              : theme.textDim;
        for (const [cx, cy] of p.cells) {
          g.fillRect(X(x + cx + 0.2), Y(y + cy + 0.2), s * 0.6, s * 0.6);
        }
      }
    }
    if (dm?.pinned) {
      g.fillStyle = theme.primary;
      g.beginPath();
      g.arc(
        X(x) + Math.max(4, s * 0.6),
        Y(y) + Math.max(4, s * 0.6),
        Math.max(3, s * 0.35),
        0,
        Math.PI * 2,
      );
      g.fill();
    }
    if (opt.showLabels && m.shape.w * s >= 40) {
      const node = P.nodes[m.node];
      const size = Math.min(14, Math.max(9, s * 1.1));
      g.font = fontPx(size);
      g.fillStyle = theme.text;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      const label = `${node.shape.name} #${m.local + 1}`;
      const maxW = m.shape.w * s - 6;
      g.fillText(fit(g, label, maxW), X(x + m.shape.w / 2), Y(y + m.shape.h / 2));
    }
  }

  // ---- power: pieces, then cables on top (they run overhead)
  drawPower(g, view, theme, s, X, Y, visible, sel.pieces, dragOf, opt.showPower);

  // ---- problems
  g.strokeStyle = theme.error;
  g.lineWidth = Math.max(1.5, s * 0.12);
  let shown = 0;
  for (const pr of view.problems) {
    if (pr.severity !== 'error') continue;
    for (const [x, y] of pr.tiles) {
      if (shown++ > 3000) break;
      if (!visible(x, y, x + 1, y + 1)) continue;
      g.strokeRect(X(x) + 1, Y(y) + 1, Math.max(3, s - 2), Math.max(3, s - 2));
    }
  }

  // ---- overlays
  for (const gh of ov.ghosts) {
    g.globalAlpha = 0.55;
    g.fillStyle = gh.ok ? theme.primary : theme.error;
    for (const r of gh.shape.rects) g.fillRect(X(gh.x + r.x), Y(gh.y + r.y), r.w * s, r.h * s);
    g.globalAlpha = 1;
    g.fillStyle = theme.text;
    for (const p of gh.shape.ports.values()) {
      for (const [cx, cy] of p.cells)
        g.fillRect(X(gh.x + cx + 0.25), Y(gh.y + cy + 0.25), s * 0.5, s * 0.5);
    }
  }
  if (ov.pieceGhost) {
    const pg = ov.pieceGhost;
    g.globalAlpha = 0.6;
    g.fillStyle = theme.primary;
    if (pg.kind === 'valve') {
      const vg = valveGeometry(pg);
      for (const [tx, ty] of [vg.a, vg.m, vg.e]) g.fillRect(X(tx), Y(ty), s, s);
    } else if (pg.kind === 'passthrough') {
      const [w, h] = pg.rot % 2 ? [2, 4] : [4, 2];
      g.fillRect(X(pg.x), Y(pg.y), w * s, h * s);
    } else if (pg.kind === 'power' && pg.power) {
      const [w, h] = pieceSize(pg.power, pg.rot);
      g.fillRect(X(pg.x), Y(pg.y), w * s, h * s);
    } else {
      g.fillRect(X(pg.x), Y(pg.y), 2 * s, 2 * s);
    }
    g.globalAlpha = 1;
  }
  if (ov.pipePreview) {
    const pp = ov.pipePreview;
    const off = pp.large ? 1 : 0.5;
    g.strokeStyle = pp.ok ? theme.primary : theme.error;
    g.lineWidth = Math.max(2, s * (pp.large ? 1.4 : 0.35));
    g.globalAlpha = 0.8;
    g.beginPath();
    for (let i = 0; i < pp.edges.length; i += 3) {
      g.moveTo(X(kx(pp.edges[i]) + off), Y(ky(pp.edges[i]) + off));
      g.lineTo(X(kx(pp.edges[i + 1]) + off), Y(ky(pp.edges[i + 1]) + off));
    }
    g.stroke();
    g.fillStyle = g.strokeStyle;
    for (const c of pp.nodes) {
      g.beginPath();
      g.arc(X(kx(c) + off), Y(ky(c) + off), Math.max(2, s * 0.22), 0, Math.PI * 2);
      g.fill();
    }
    g.globalAlpha = 1;
  }
  if (ov.focus) {
    g.strokeStyle = theme.warning;
    g.lineWidth = 3;
    for (const [x, y] of ov.focus.slice(0, 200)) g.strokeRect(X(x) - 3, Y(y) - 3, s + 6, s + 6);
  }
  if (ov.hoverItem && !ov.drag) drawHover(g, view, theme, s, X, Y, ov.hoverItem, opt.showLabels);
  if (ov.hover) {
    const [x, y] = ov.hover;
    g.strokeStyle = theme.text;
    g.globalAlpha = 0.6;
    g.lineWidth = 1;
    g.strokeRect(X(x) + 0.5, Y(y) + 0.5, s - 1, s - 1);
    g.globalAlpha = 1;
  }
  if (ov.marquee) {
    const [x0, y0, x1, y1] = ov.marquee;
    g.strokeStyle = theme.primary;
    g.setLineDash([5, 4]);
    g.lineWidth = 1;
    g.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
    g.setLineDash([]);
  }
}

/**
 * Pipe paths inside a square box (pixels, top-left px / py, side `size`): straight across,
 * a quarter arc around the corner between two neighbouring sides, or spokes to the middle
 * (a pipe splitting / merging inside). Pipes using the same sides are drawn side by side.
 */
function drawRoutes(
  g: CanvasRenderingContext2D,
  px: number,
  py: number,
  size: number,
  routes: JunctionRoute[],
  theme: Theme,
  style: (net: number, k: number) => { color: string; alpha: number; width: number; halo: boolean },
): void {
  const h = size / 2;
  const mid: [number, number][] = [
    [px + size, py + h],
    [px, py + h],
    [px + h, py + size],
    [px + h, py],
  ];
  // two pipes using a common side run side by side: draw them apart
  const same =
    routes.length === 2 && routes[0].sides.some((k) => routes[1].sides.includes(k))
      ? size * 0.18
      : 0;
  g.save();
  g.lineCap = 'butt';
  routes.forEach((r, k) => {
    const st = style(r.net, k);
    const shift = same ? (k ? same : -same) : 0;
    const path = () => {
      g.beginPath();
      const [a, b] = r.sides;
      if (r.sides.length === 2 && (a ^ 1) === b) {
        // straight across (sides 0/1 or 2/3)
        const horizontal = a === 0;
        const [x1, y1] = mid[a];
        const [x2, y2] = mid[b];
        const ox = horizontal ? 0 : shift;
        const oy = horizontal ? shift : 0;
        g.moveTo(x1 + ox, y1 + oy);
        g.lineTo(x2 + ox, y2 + oy);
      } else if (r.sides.length === 2) {
        // around the corner between the two sides
        const right = r.sides.includes(0);
        const bottom = r.sides.includes(2);
        const cx = right ? px + size : px;
        const cy = bottom ? py + size : py;
        const rad = Math.max(1, h + shift);
        const angle = (k2: number) => Math.atan2(mid[k2][1] - cy, mid[k2][0] - cx);
        const a0 = angle(a);
        let d = angle(b) - a0;
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        const start = d < 0 ? a0 + d : a0;
        g.arc(cx, cy, rad, start, start + Math.abs(d));
      } else {
        for (const sd of r.sides) {
          g.moveTo(mid[sd][0] + shift, mid[sd][1] + shift);
          g.lineTo(px + h + shift, py + h + shift);
        }
      }
    };
    g.globalAlpha = st.alpha;
    if (st.halo) {
      g.strokeStyle = theme.bg;
      g.lineWidth = st.width + Math.max(2, size * 0.12);
      path();
      g.stroke();
    }
    g.strokeStyle = st.color;
    g.lineWidth = Math.max(1, st.width);
    path();
    g.stroke();
  });
  g.restore();
}

function drawPower(
  g: CanvasRenderingContext2D,
  view: DocView,
  theme: Theme,
  s: number,
  X: (x: number) => number,
  Y: (y: number) => number,
  visible: (x0: number, y0: number, x1: number, y1: number) => boolean,
  selected: Set<string>,
  dragOf: (selected: boolean) => { dx: number; dy: number },
  cables: boolean,
): void {
  const pieces = view.doc.power ?? [];
  if (!pieces.length) return;
  const hv = theme.warning;
  const mv = theme.success;
  const fontPx = (n: number) => `${Math.round(n)}px system-ui, sans-serif`;
  for (const p of pieces) {
    const [w, h] = pieceSize(p.kind, p.rot);
    const { dx, dy } = dragOf(selected.has(p.id));
    if (!visible(p.x + dx, p.y + dy, p.x + dx + w, p.y + dy + h)) continue;
    const col = p.kind === 'mv' ? mv : hv;
    g.globalAlpha = 0.9;
    g.fillStyle = theme.machine;
    g.fillRect(X(p.x + dx), Y(p.y + dy), w * s, h * s);
    g.globalAlpha = 1;
    g.lineWidth = Math.max(1, s * 0.15);
    g.strokeStyle = selected.has(p.id) ? theme.primary : col;
    g.strokeRect(X(p.x + dx), Y(p.y + dy), w * s, h * s);
    if (p.kind === 'transformer') {
      // MV and HV ends
      const { mv: m, hv: hh } = transformerPorts({ ...p, x: p.x + dx, y: p.y + dy });
      for (const [[px, py], c] of [
        [m, mv],
        [hh, hv],
      ] as const) {
        g.fillStyle = c;
        g.beginPath();
        g.arc(X(px), Y(py), Math.max(2, s * 0.45), 0, Math.PI * 2);
        g.fill();
      }
    }
    if (s * Math.min(w, h) >= 14) {
      const label =
        p.kind === 'hv'
          ? 'HV'
          : p.kind === 'mv'
            ? 'MV'
            : p.kind === 'transformer'
              ? 'HV/MV'
              : 'GRID';
      g.fillStyle = col;
      g.font = fontPx(Math.min(s * Math.min(w, h) * 0.4, s * 2.5));
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(label, X(p.x + dx + w / 2), Y(p.y + dy + h / 2));
    }
  }
  const pr = view.sol.powerResult;
  if (!cables || !pr) return;
  g.save();
  g.lineCap = 'round';
  for (const l of pr.links) {
    const [ax, ay] = l.a;
    const [bx, by] = l.b;
    if (!visible(Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by))) continue;
    const machine = l.to < 0;
    g.strokeStyle = l.type === 'HV' ? hv : mv;
    g.globalAlpha = machine ? 0.55 : 0.9;
    g.lineWidth = Math.max(1, s * (machine ? 0.08 : 0.18));
    g.setLineDash(machine ? [Math.max(2, s * 0.3), Math.max(2, s * 0.25)] : []);
    g.beginPath();
    g.moveTo(X(ax), Y(ay));
    g.lineTo(X(bx), Y(by));
    g.stroke();
  }
  g.restore();
}

function degreeOf(view: DocView, ni: number, c: number): number {
  let cache = degCache.get(view);
  if (!cache) {
    cache = view.sol.netEdges.map((e) => {
      const d = new Map<number, number>();
      for (let i = 0; i < e.length; i += 3) {
        d.set(e[i], (d.get(e[i]) ?? 0) + 1);
        d.set(e[i + 1], (d.get(e[i + 1]) ?? 0) + 1);
      }
      return d;
    });
    degCache.set(view, cache);
  }
  return cache[ni].get(c) ?? 0;
}
const degCache = new WeakMap<DocView, Map<number, number>[]>();

function arrow(
  g: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  size: number,
) {
  const mx = (x0 + x1) / 2;
  const my = (y0 + y1) / 2;
  const a = Math.atan2(y1 - y0, x1 - x0);
  g.beginPath();
  g.moveTo(mx + Math.cos(a) * size, my + Math.sin(a) * size);
  g.lineTo(mx + Math.cos(a + 2.5) * size, my + Math.sin(a + 2.5) * size);
  g.lineTo(mx + Math.cos(a - 2.5) * size, my + Math.sin(a - 2.5) * size);
  g.closePath();
  g.fill();
}

function drawValve(
  g: CanvasRenderingContext2D,
  v: DocValve,
  X: (x: number) => number,
  Y: (y: number) => number,
  s: number,
  theme: Theme,
  selected: boolean,
  d: { dx: number; dy: number },
  labels: boolean,
) {
  const vg = valveGeometry({ x: v.x + d.dx, y: v.y + d.dy, rot: v.rot });
  g.fillStyle = theme.machine;
  g.strokeStyle = selected ? theme.primary : theme.warning;
  g.lineWidth = Math.max(1.5, s * 0.12);
  const x0 = Math.min(vg.a[0], vg.e[0]);
  const y0 = Math.min(vg.a[1], vg.e[1]);
  g.fillRect(X(x0), Y(y0), vg.w * s, vg.h * s);
  g.strokeRect(X(x0), Y(y0), vg.w * s, vg.h * s);
  // side outlet marker
  g.fillStyle = theme.warning;
  const [sx, sy] = vg.sideAt;
  const [mx, my] = vg.m;
  g.fillRect(X(mx + 0.35 + (sx - mx) * 0.5), Y(my + 0.35 + (sy - my) * 0.5), s * 0.3, s * 0.3);
  if (labels && s >= 10) {
    g.fillStyle = theme.text;
    g.font = `${Math.round(Math.min(12, s * 0.6))}px system-ui, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(`${Math.round(v.sidePct)}%`, X(mx + 0.5), Y(my + 0.5));
  }
}

function fit(g: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (g.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 3 && g.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
  return `${t}…`;
}

/** Tiles (as rects) of the valve, passthrough, intersection or power piece with this id. */
function pieceRects(doc: GameLayoutDoc, id: string): [number, number, number, number][] {
  const v = doc.valves.find((x) => x.id === id);
  if (v)
    return [valveGeometry(v).a, valveGeometry(v).m, valveGeometry(v).e].map(([x, y]) => [
      x,
      y,
      1,
      1,
    ]);
  const pt = doc.passthroughs.find((x) => x.id === id);
  if (pt)
    return [[pt.x, pt.y, ...(pt.horizontal ? [4, 2] : [2, 4])] as [number, number, number, number]];
  const it = doc.intersections.find((x) => x.id === id);
  if (it) return [[it.x, it.y, 2, 2]];
  const pp = (doc.power ?? []).find((x) => x.id === id);
  if (pp) return [[pp.x, pp.y, ...pieceSize(pp.kind, pp.rot)]];
  return [];
}

/**
 * Highlight of the item under the pointer, like a hovered flowchart node: a primary outline
 * around a machine or piece, and the machine's name even where labels are hidden (a hovered
 * pipe glows where the pipes are drawn).
 */
function drawHover(
  g: CanvasRenderingContext2D,
  view: DocView,
  theme: Theme,
  s: number,
  X: (x: number) => number,
  Y: (y: number) => number,
  item: NonNullable<Overlay['hoverItem']>,
  labelsShown: boolean,
): void {
  g.save();
  g.strokeStyle = theme.primary;
  g.lineWidth = 2;
  // outside the item's own border, so it shows whatever colour that border is
  if ('inst' in item) {
    const m = view.sol.machines.find((x) => x.inst === item.inst);
    if (m) {
      for (const r of m.shape.rects) {
        g.strokeRect(X(m.x + r.x) - 3, Y(m.y + r.y) - 3, r.w * s + 6, r.h * s + 6);
      }
      const node = view.ctx.problem.nodes[m.node];
      const label = `${node.shape.name} #${m.local + 1}`;
      if (!labelsShown || m.shape.w * s < 40) {
        // above the machine, on a backing, so it reads at any zoom
        g.font = '12px system-ui, sans-serif';
        g.textAlign = 'center';
        g.textBaseline = 'bottom';
        const cx = X(m.x + m.shape.w / 2);
        const by = Y(m.y) - 4;
        const w = g.measureText(label).width + 10;
        g.fillStyle = theme.bg;
        g.fillRect(cx - w / 2, by - 17, w, 17);
        g.strokeRect(cx - w / 2, by - 17, w, 17);
        g.fillStyle = theme.text;
        g.fillText(label, cx, by - 2);
      }
    }
  } else if ('piece' in item) {
    for (const [x, y, w, h] of pieceRects(view.doc, item.piece)) {
      g.strokeRect(X(x) - 3, Y(y) - 3, w * s + 6, h * s + 6);
    }
  }
  g.restore();
}
