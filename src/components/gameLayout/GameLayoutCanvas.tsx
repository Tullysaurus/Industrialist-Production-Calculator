import { pieceSize } from '../../gameLayout/engine/power';
import { pieceTiles as powerPieceTiles } from '../../gameLayout/engine/power';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DocView } from '../../gameLayout/doc';
import { evaluateDoc, instanceShape, passthroughTiles, valveGeometry } from '../../gameLayout/doc';
import {
  addIntersection,
  addPowerPiece,
  addPassthrough,
  addValve,
  emptySelection,
  eraseTiles,
  extendPipe,
  moveItems,
  placeMachine,
  rotateMachines,
  selectionSize,
  togglePinned,
  deleteItems,
  withAttachedPipes,
  type Selection,
} from '../../gameLayout/docOps';
import { emptyLayoutDoc, type GameLayoutDoc } from '../../gameLayout/docSchema';
import { edgeKey } from '../../gameLayout/engine/flows';
import { accessCells, largeAnchor } from '../../gameLayout/engine/geometry';
import { EDGE_CROSS, EDGE_STEP } from '../../gameLayout/engine/router';
import { key, kx, ky } from '../../gameLayout/engine/solution';
import {
  buildEditorGrid,
  routeNetworks,
  withPiecesFor,
  type EditorGrid,
} from '../../gameLayout/routeTools';
import { useFlowStore } from '../../stores/useFlowStore';
import { isPowerTool, useGameLayoutStore } from '../../stores/useGameLayoutStore';
import { drawLayout, readTheme, type Camera, type Overlay } from './renderer';
import { TileTooltip } from './TileTooltip';
import styles from './GameLayout.module.css';

interface Props {
  view: DocView;
  doc: GameLayoutDoc | null;
}

/** Lookups for hit testing, built once per evaluated document. */
interface HitIndex {
  machineAt: Map<number, number>;
  netsAt: Map<number, number[]>;
  /** Port access tile (or every tile of a large port's anchor) -> nets that attach there. */
  portNets: Map<number, number[]>;
  pieceAt: Map<number, string>;
}

function buildHitIndex(view: DocView): HitIndex {
  const P = view.ctx.problem;
  const netsAt = new Map<number, number[]>();
  view.sol.cells.forEach((cells, ni) => {
    for (const c of cells) {
      const l = netsAt.get(c);
      if (l) l.push(ni);
      else netsAt.set(c, [ni]);
    }
  });
  const portNets = new Map<number, number[]>();
  const instM = new Map(view.sol.machines.map((m) => [m.inst, m]));
  P.nets.forEach((net, ni) => {
    for (const t of net.terminals) {
      const m = instM.get(t.inst);
      if (!m) continue;
      for (const pid of t.ports) {
        const p = m.shape.ports.get(pid);
        if (!p) continue;
        const tiles: [number, number][] = [];
        if (net.large) {
          const [ax, ay] = largeAnchor(p);
          tiles.push([ax, ay], [ax + 1, ay], [ax, ay + 1], [ax + 1, ay + 1]);
        } else {
          tiles.push(...accessCells(p).map(([x, y]) => [x, y] as [number, number]));
        }
        for (const [x, y] of tiles) {
          const k = key(m.x + x, m.y + y);
          const l = portNets.get(k);
          if (!l) portNets.set(k, [ni]);
          else if (!l.includes(ni)) l.push(ni);
        }
      }
    }
  });
  const pieceAt = new Map<number, string>();
  for (const v of view.doc.valves) {
    const g = valveGeometry(v);
    for (const [x, y] of [g.a, g.m, g.e]) pieceAt.set(key(x, y), v.id);
  }
  for (const p of view.doc.passthroughs)
    for (const [x, y] of passthroughTiles(p)) pieceAt.set(key(x, y), p.id);
  for (const p of view.doc.intersections) {
    for (const [dx, dy] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ]) {
      pieceAt.set(key(p.x + dx, p.y + dy), p.id);
    }
  }
  for (const p of view.doc.power ?? [])
    for (const [x, y] of powerPieceTiles(p)) pieceAt.set(key(x, y), p.id);
  return { machineAt: view.sol.blocked, netsAt, portNets, pieceAt };
}

type Gesture =
  | { kind: 'pan'; sx: number; sy: number; cx: number; cy: number }
  | { kind: 'drag'; tx: number; ty: number; before: GameLayoutDoc; moved: boolean }
  | { kind: 'marquee'; sx: number; sy: number }
  | { kind: 'paint'; ni: number; tiles: number[] }
  | { kind: 'erase'; before: GameLayoutDoc; tiles: Set<number> };

const MIN_SCALE = 0.4;
const MAX_SCALE = 48;

export function GameLayoutCanvas({ view, doc }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cam = useRef<Camera>({ x: -20, y: -20, scale: 8 });
  const gesture = useRef<Gesture | null>(null);
  const [hover, setHover] = useState<{ tile: [number, number]; px: number; py: number } | null>(
    null,
  );
  const [overlay, setOverlay] = useState<Overlay>({
    ghosts: [],
    pieceGhost: null,
    pipePreview: null,
    drag: null,
    marquee: null,
    hover: null,
    activeNet: null,
    focus: null,
  });
  /** Pipe tool: net and start tiles of a click-to-click pipe in progress. */
  const pending = useRef<{ ni: number; from: number[] } | null>(null);
  const gridCache = useRef<{ view: DocView; grid: EditorGrid } | null>(null);
  const focusRef = useRef<[number, number][] | null>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });

  const tool = useGameLayoutStore((s) => s.tool);
  const placing = useGameLayoutStore((s) => s.placing);
  const pieceRot = useGameLayoutStore((s) => s.pieceRot);
  const pieceKind = useGameLayoutStore((s) => s.pieceKind);
  const selection = useGameLayoutStore((s) => s.selection);
  const flowView = useGameLayoutStore((s) => s.flowView);
  const showArrows = useGameLayoutStore((s) => s.showArrows);
  const showLabels = useGameLayoutStore((s) => s.showLabels);
  const showPower = useGameLayoutStore((s) => s.showPower);
  const focus = useGameLayoutStore((s) => s.focus);
  const fitRequest = useGameLayoutStore((s) => s.fitRequest);
  const preview = useGameLayoutStore((s) => s.generator.preview);
  const editor = useGameLayoutStore.getState;

  // while the generator runs, the view is its latest layout (read-only)
  const shown = view;
  const hit = useMemo(() => buildHitIndex(shown), [shown]);
  const setDoc = useFlowStore.getState().setGameLayout;
  const curDoc = () => useFlowStore.getState().gameLayout ?? emptyLayoutDoc();

  // ---------------------------------------------------------------- drawing
  const redraw = useRef(0);
  const draw = useCallback(() => {
    cancelAnimationFrame(redraw.current);
    redraw.current = requestAnimationFrame(() => {
      const c = canvasRef.current;
      if (!c) return;
      const g = c.getContext('2d');
      if (!g) return;
      const dpr = window.devicePixelRatio || 1;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawLayout(
        g,
        size.w,
        size.h,
        cam.current,
        shown,
        readTheme(c),
        { flowView, showArrows, showLabels, showPower, selection, preview },
        {
          ...overlay,
          pipePreview: tool === 'pipe' ? overlay.pipePreview : null,
          activeNet: tool === 'pipe' ? overlay.activeNet : null,
          pieceGhost:
            tool === 'valve' ||
            tool === 'passthrough' ||
            tool === 'intersection' ||
            isPowerTool(tool)
              ? overlay.pieceGhost
              : null,
          focus: focusRef.current,
        },
      );
    });
  }, [shown, size, flowView, showArrows, showLabels, showPower, selection, preview, overlay, tool]);
  useEffect(draw, [draw]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      const c = canvasRef.current;
      if (!c) return;
      const dpr = window.devicePixelRatio || 1;
      c.width = Math.max(1, Math.floor(r.width * dpr));
      c.height = Math.max(1, Math.floor(r.height * dpr));
      setSize({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ---------------------------------------------------------------- camera
  const fit = useCallback(() => {
    const v = shown;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const m of v.sol.machines) {
      x0 = Math.min(x0, m.x);
      y0 = Math.min(y0, m.y);
      x1 = Math.max(x1, m.x + m.shape.w);
      y1 = Math.max(y1, m.y + m.shape.h);
    }
    const [bx0, by0, bx1, by1] = v.sol.bbox;
    if (bx1 > bx0) {
      x0 = Math.min(x0, bx0);
      y0 = Math.min(y0, by0);
      x1 = Math.max(x1, bx1);
      y1 = Math.max(y1, by1);
    }
    // frame the layout in the area the panels leave free
    const narrow = size.w < 900;
    const left = narrow ? 0 : Math.min(250, size.w * 0.2);
    const right = narrow ? 0 : Math.min(370, size.w * 0.3);
    const top = 48;
    const bottom = narrow ? Math.min(size.h * 0.45, 360) : 140;
    const aw = Math.max(100, size.w - left - right);
    const ah = Math.max(100, size.h - top - bottom);
    if (!Number.isFinite(x0)) {
      cam.current = { x: -(left + aw / 2) / 8, y: -(top + ah / 2) / 8, scale: 8 };
    } else {
      const scale = Math.min(
        MAX_SCALE,
        Math.max(MIN_SCALE, Math.min(aw / (x1 - x0 + 4), ah / (y1 - y0 + 4))),
      );
      cam.current = {
        scale,
        x: (x0 + x1) / 2 - (left + aw / 2) / scale,
        y: (y0 + y1) / 2 - (top + ah / 2) / scale,
      };
    }
    draw();
  }, [shown, size, draw]);
  // tests read the camera to turn tiles into screen positions (development builds only)
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    (window as unknown as { __gameLayoutCamera?: () => Camera }).__gameLayoutCamera = () =>
      cam.current;
  }, []);
  const fitted = useRef(false);
  useEffect(() => {
    if (!fitted.current && size.w > 1) {
      fitted.current = true;
      fit();
    }
  }, [fit, size]);
  // a fit requested together with a document change waits for the new evaluated view
  const pendingFit = useRef(0);
  useEffect(() => {
    if (fitRequest) pendingFit.current = fitRequest;
  }, [fitRequest]);
  useEffect(() => {
    if (!pendingFit.current) return;
    pendingFit.current = 0;
    fit();
  }, [fit, fitRequest, shown]);
  useEffect(() => {
    if (!focus || !focus.tiles.length) return;
    const xs = focus.tiles.map((t) => t[0]);
    const ys = focus.tiles.map((t) => t[1]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const scale = Math.max(cam.current.scale, 10);
    cam.current = { scale, x: cx - size.w / scale / 2, y: cy - size.h / scale / 2 };
    focusRef.current = focus.tiles;
    draw();
    const t = setTimeout(() => {
      focusRef.current = null;
      draw();
    }, 2500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  const toTile = (ev: { clientX: number; clientY: number }): [number, number, number, number] => {
    const r = canvasRef.current!.getBoundingClientRect();
    const px = ev.clientX - r.left;
    const py = ev.clientY - r.top;
    const c = cam.current;
    return [Math.floor(c.x + px / c.scale), Math.floor(c.y + py / c.scale), px, py];
  };

  const onWheel = useCallback(
    (ev: WheelEvent) => {
      ev.preventDefault();
      const r = canvasRef.current!.getBoundingClientRect();
      const px = ev.clientX - r.left;
      const py = ev.clientY - r.top;
      const c = cam.current;
      const wx = c.x + px / c.scale;
      const wy = c.y + py / c.scale;
      const scale = Math.min(
        MAX_SCALE,
        Math.max(MIN_SCALE, c.scale * Math.exp(-ev.deltaY * 0.0015)),
      );
      cam.current = { scale, x: wx - px / scale, y: wy - py / scale };
      draw();
    },
    [draw],
  );
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    c.addEventListener('wheel', onWheel, { passive: false });
    return () => c.removeEventListener('wheel', onWheel);
  }, [onWheel]);

  // ---------------------------------------------------------------- helpers
  const P = view.ctx.problem;
  const readOnly = !!preview;

  const machineKeyAt = (t: number): string | null => {
    const inst = hit.machineAt.get(t);
    if (inst !== undefined) return shown.machineOf.get(inst)?.key ?? null;
    return null;
  };

  const netOfTile = (t: number): number | null => {
    const sel = [...editor().selection.pipes];
    const candidates = [...(hit.portNets.get(t) ?? []), ...(hit.netsAt.get(t) ?? [])];
    if (!candidates.length) return null;
    const preferred = candidates.find((ni) => sel.includes(P.nets[ni].key));
    return preferred ?? candidates[0];
  };

  /** Free of machines (other than `ignore`) for a footprint at (x, y). */
  const fits = (
    shape: ReturnType<typeof instanceShape>,
    x: number,
    y: number,
    ignore: Set<number>,
  ) => {
    for (const r of shape.rects) {
      for (let yy = r.y; yy < r.y + r.h; yy++) {
        for (let xx = r.x; xx < r.x + r.w; xx++) {
          const o = hit.machineAt.get(key(x + xx, y + yy));
          if (o !== undefined && !ignore.has(o)) return false;
        }
      }
    }
    return true;
  };

  const gridFor = (v: DocView) => {
    if (gridCache.current?.view !== v) gridCache.current = { view: v, grid: buildEditorGrid(v) };
    return gridCache.current.grid;
  };

  /** Auto-path for a click-to-click pipe from the pending start to tile t. */
  const autoPath = (ni: number, from: number[], t: number) => {
    const grid = gridFor(view);
    let targets = [t];
    const own = view.sol.netNodes[ni];
    if (own.has(t)) targets = [...own];
    const conv = (ks: number[]) => ks.filter((k) => grid.inside(kx(k), ky(k))).map(grid.toGrid);
    const path = grid.router.findPath(ni, conv(from), conv(targets));
    if (!path) return null;
    const nodes: number[] = [];
    const edges: number[] = [];
    for (let i = 0; i < path.length; i += 2) {
      const c = grid.fromGrid(path[i]);
      nodes.push(c);
      if (i + 2 < path.length) edges.push(grid.fromGrid(path[i + 2]), c, path[i + 1]);
    }
    return { nodes, edges };
  };

  /** Painted tiles -> segments; two tiles over a large pipe become a passthrough crossing. */
  const paintedSegments = (ni: number, tiles: number[]) => {
    const large = P.nets[ni].large;
    const occL = (t: number) => !large && (view.sol.occL.get(t) ?? 0) > 0;
    const nodes: number[] = [];
    const edges: number[] = [];
    let i = 0;
    while (i < tiles.length) {
      const t = tiles[i];
      if (!occL(t)) {
        if (nodes.length) edges.push(nodes[nodes.length - 1], t, EDGE_STEP);
        nodes.push(t);
        i++;
        continue;
      }
      // a run over a large pipe: exactly two tiles in a straight line -> crossing
      let j = i;
      while (j < tiles.length && occL(tiles[j])) j++;
      const prev = nodes[nodes.length - 1];
      const next = tiles[j];
      const straight =
        prev !== undefined &&
        next !== undefined &&
        j - i === 2 &&
        (kx(prev) === kx(next) || ky(prev) === ky(next)) &&
        Math.abs(kx(prev) - kx(next)) + Math.abs(ky(prev) - ky(next)) === 3;
      if (straight) {
        edges.push(prev, next, EDGE_CROSS);
        nodes.push(next);
        i = j + 1;
      } else {
        for (let k = i; k < j; k++) {
          if (nodes.length) edges.push(nodes[nodes.length - 1], tiles[k], EDGE_STEP);
          nodes.push(tiles[k]);
        }
        i = j;
      }
    }
    return { nodes, edges };
  };

  const commitPipe = (ni: number, nodes: number[], edges: number[]) => {
    const net = P.nets[ni];
    const before = curDoc();
    let next = extendPipe(before, net.key, net.large, net.productName, nodes, edges);
    const v2 = evaluateDoc(view.ctx, next, { analyse: false });
    next = withPiecesFor(v2, ni);
    setDoc(next, { before });
  };

  const tilesBetween = (a: number, b: number): number[] => {
    // orthogonal steps from a to b (x first, then y)
    const out: number[] = [];
    let x = kx(a);
    let y = ky(a);
    const bx = kx(b);
    const by = ky(b);
    while (x !== bx) {
      x += Math.sign(bx - x);
      out.push(key(x, y));
    }
    while (y !== by) {
      y += Math.sign(by - y);
      out.push(key(x, y));
    }
    return out;
  };

  const rerouteAfterMove = (before: GameLayoutDoc, moved: GameLayoutDoc, sel: Selection) => {
    if (!editor().rerouteOnMove) return moved;
    const insts = new Set<number>();
    for (const k of sel.machines) {
      const g = view.ctx.instByKey.get(k);
      if (g !== undefined) insts.add(g);
    }
    const nets = P.nets
      .map((n, i) => [n, i] as const)
      .filter(([n]) => !sel.pipes.has(n.key) && n.terminals.some((t) => insts.has(t.inst)))
      .filter(
        ([n]) =>
          moved.pipes.some((p) => p.net === n.key) || before.pipes.some((p) => p.net === n.key),
      )
      .map(([, i]) => i);
    if (!nets.length) return moved;
    const v2 = evaluateDoc(view.ctx, moved, { analyse: false });
    return routeNetworks(v2, nets, 3).doc;
  };

  // ---------------------------------------------------------------- pointer
  const onPointerDown = (ev: React.PointerEvent) => {
    const [tx, ty, px, py] = toTile(ev);
    const t = key(tx, ty);
    (ev.target as Element).setPointerCapture(ev.pointerId);
    const st = editor();
    if (st.tool !== 'pipe') pending.current = null;
    if (ev.button === 1 || ev.button === 2 || readOnly) {
      gesture.current = { kind: 'pan', sx: px, sy: py, cx: cam.current.x, cy: cam.current.y };
      return;
    }
    if (st.placing) {
      const inst = st.placing.inst;
      const shape = instanceShape(view.ctx, inst, st.placing.rot);
      const x = tx - Math.floor(shape.w / 2);
      const y = ty - Math.floor(shape.h / 2);
      setDoc(placeMachine(curDoc(), view.ctx, inst, x, y, st.placing.rot));
      setOverlay((o) => ({ ...o, ghosts: [] }));
      // keep placing the next unplaced machine of the same flowchart node
      const ni = P.instances[inst][0];
      const nextInst = view.unplaced.find((g) => g !== inst && P.instances[g][0] === ni);
      if (nextInst !== undefined && ev.shiftKey) st.startPlacing(nextInst, st.placing.rot);
      else st.setPlacing(null);
      return;
    }
    switch (st.tool) {
      case 'select': {
        const piece = hit.pieceAt.get(t);
        const mk = machineKeyAt(t);
        const nets = hit.netsAt.get(t);
        const sel = ev.shiftKey ? cloneSel(st.selection) : emptySelection();
        let target: { set: keyof Selection; id: string } | null = null;
        if (piece) target = { set: 'pieces', id: piece };
        else if (mk) target = { set: 'machines', id: mk };
        else if (nets?.length) target = { set: 'pipes', id: P.nets[nets[0]].key };
        if (!target) {
          if (ev.shiftKey) gesture.current = { kind: 'marquee', sx: px, sy: py };
          else {
            st.clearSelection();
            gesture.current = { kind: 'pan', sx: px, sy: py, cx: cam.current.x, cy: cam.current.y };
          }
          return;
        }
        const already = st.selection[target.set].has(target.id);
        if (ev.shiftKey && already) sel[target.set].delete(target.id);
        else if (!already || ev.shiftKey) sel[target.set].add(target.id);
        const active = already && !ev.shiftKey ? st.selection : sel;
        if (!(already && !ev.shiftKey)) st.setSelection(sel);
        if (target.set !== 'pipes' || active.machines.size || active.pieces.size) {
          gesture.current = { kind: 'drag', tx, ty, before: curDoc(), moved: false };
        }
        return;
      }
      case 'pipe': {
        if (pending.current) {
          // second click: commit the auto path
          const p = autoPath(pending.current.ni, pending.current.from, t);
          if (p) commitPipe(pending.current.ni, p.nodes, p.edges);
          else st.notify('No free path to there', 'error');
          pending.current = null;
          setOverlay((o) => ({ ...o, pipePreview: null, activeNet: null }));
          return;
        }
        const ni = netOfTile(t);
        if (ni === null) {
          st.notify('Start a pipe on a machine port or an existing pipe');
          return;
        }
        gesture.current = { kind: 'paint', ni, tiles: [t] };
        setOverlay((o) => ({ ...o, activeNet: ni }));
        return;
      }
      case 'erase': {
        const before = curDoc();
        const tiles = new Set([t]);
        gesture.current = { kind: 'erase', before, tiles };
        setDoc(eraseTiles(before, tiles), { recordHistory: false });
        return;
      }
      case 'valve': {
        const g = valveGeometry({ x: tx, y: ty, rot: st.pieceRot });
        const ox = tx - (g.m[0] - tx);
        const oy = ty - (g.m[1] - ty);
        const m = key(tx, ty);
        let pct = 50;
        const nis = hit.netsAt.get(m);
        if (nis?.length && view.analysis) {
          const nf = view.analysis.nets[nis[0]];
          const side = valveGeometry({ x: ox, y: oy, rot: st.pieceRot }).sideAt;
          const tin = [...(nf.adj.get(m) ?? [])].reduce(
            (a, v) => a + (nf.edgeFlow.get(edgeKey(v, m)) ?? 0),
            0,
          );
          const ts = nf.edgeFlow.get(edgeKey(m, key(side[0], side[1]))) ?? 0;
          if (tin > 0) pct = Math.round((1000 * ts) / tin) / 10;
        }
        setDoc(addValve(curDoc(), ox, oy, st.pieceRot, pct));
        return;
      }
      case 'passthrough': {
        const horizontal = st.pieceRot % 2 === 0;
        const [w, h] = horizontal ? [4, 2] : [2, 4];
        const x = tx - Math.floor(w / 2);
        const y = ty - Math.floor(h / 2);
        // kind from a normal pipe crossing the middle, else the chosen one
        let kind = st.pieceKind;
        for (const c of view.sol.crossings()) {
          if (c.x >= x && c.x < x + w && c.y >= y && c.y < y + h) kind = c.kind;
        }
        setDoc(addPassthrough(curDoc(), x, y, horizontal, kind));
        return;
      }
      case 'intersection':
        setDoc(addIntersection(curDoc(), tx, ty));
        return;
      case 'hv':
      case 'mv':
      case 'transformer':
      case 'grid': {
        const [w, h] = pieceSize(st.tool, st.pieceRot);
        setDoc(
          addPowerPiece(
            curDoc(),
            st.tool,
            tx - Math.floor(w / 2),
            ty - Math.floor(h / 2),
            st.pieceRot,
          ),
        );
        return;
      }
    }
  };

  const onPointerMove = (ev: React.PointerEvent) => {
    const [tx, ty, px, py] = toTile(ev);
    const t = key(tx, ty);
    const gs = gesture.current;
    setHover(gs ? null : { tile: [tx, ty], px, py });
    const st = editor();
    const ov: Partial<Overlay> = { hover: [tx, ty] };
    if (gs?.kind === 'pan') {
      const c = cam.current;
      cam.current = { ...c, x: gs.cx - (px - gs.sx) / c.scale, y: gs.cy - (py - gs.sy) / c.scale };
    } else if (gs?.kind === 'drag') {
      const dx = tx - gs.tx;
      const dy = ty - gs.ty;
      if (dx || dy) gs.moved = true;
      ov.drag = { dx, dy };
      const ignore = new Set<number>();
      for (const k of st.selection.machines) {
        const g = view.ctx.instByKey.get(k);
        if (g !== undefined) ignore.add(g);
      }
      ov.ghosts = view.sol.machines
        .filter((m) => ignore.has(m.inst))
        .slice(0, 200)
        .map((m) => ({
          shape: m.shape,
          x: m.x + dx,
          y: m.y + dy,
          ok: fits(m.shape, m.x + dx, m.y + dy, ignore),
        }));
    } else if (gs?.kind === 'marquee') {
      ov.marquee = [gs.sx, gs.sy, px, py];
    } else if (gs?.kind === 'paint') {
      const last = gs.tiles[gs.tiles.length - 1];
      if (t !== last) gs.tiles.push(...tilesBetween(last, t));
      const p = paintedSegments(gs.ni, gs.tiles);
      ov.pipePreview = { nodes: p.nodes, edges: p.edges, large: P.nets[gs.ni].large, ok: true };
    } else if (gs?.kind === 'erase') {
      gs.tiles.add(t);
      setDoc(eraseTiles(curDoc(), new Set([t])), { recordHistory: false });
    } else if (st.tool === 'pipe' && pending.current) {
      const p = autoPath(pending.current.ni, pending.current.from, t);
      ov.pipePreview = p
        ? { nodes: p.nodes, edges: p.edges, large: P.nets[pending.current.ni].large, ok: true }
        : { nodes: [t], edges: [], large: P.nets[pending.current.ni].large, ok: false };
    }
    if (st.placing) {
      const shape = instanceShape(view.ctx, st.placing.inst, st.placing.rot);
      const x = tx - Math.floor(shape.w / 2);
      const y = ty - Math.floor(shape.h / 2);
      ov.ghosts = [{ shape, x, y, ok: fits(shape, x, y, new Set()) }];
    } else if (
      !gs &&
      (st.tool === 'valve' ||
        st.tool === 'passthrough' ||
        st.tool === 'intersection' ||
        isPowerTool(st.tool))
    ) {
      if (isPowerTool(st.tool)) {
        const [w, h] = pieceSize(st.tool, st.pieceRot);
        ov.pieceGhost = {
          kind: 'power',
          power: st.tool,
          x: tx - Math.floor(w / 2),
          y: ty - Math.floor(h / 2),
          rot: st.pieceRot,
        };
      } else if (st.tool === 'valve') {
        const g = valveGeometry({ x: tx, y: ty, rot: st.pieceRot });
        ov.pieceGhost = {
          kind: 'valve',
          x: tx - (g.m[0] - tx),
          y: ty - (g.m[1] - ty),
          rot: st.pieceRot,
        };
      } else if (st.tool === 'passthrough') {
        const [w, h] = st.pieceRot % 2 ? [2, 4] : [4, 2];
        ov.pieceGhost = {
          kind: 'passthrough',
          x: tx - Math.floor(w / 2),
          y: ty - Math.floor(h / 2),
          rot: st.pieceRot,
        };
      } else {
        ov.pieceGhost = { kind: 'intersection', x: tx, y: ty, rot: 0 };
      }
    }
    setOverlay((o) => ({
      ...o,
      ghosts: ov.ghosts ?? (gs?.kind === 'drag' ? o.ghosts : []),
      pieceGhost: ov.pieceGhost ?? null,
      drag: ov.drag ?? (gs?.kind === 'drag' ? o.drag : null),
      marquee: ov.marquee ?? null,
      pipePreview:
        ov.pipePreview ?? (gs?.kind === 'paint' || pending.current ? o.pipePreview : null),
      hover: ov.hover ?? null,
    }));
    draw();
  };

  const onPointerUp = (ev: React.PointerEvent) => {
    const gs = gesture.current;
    gesture.current = null;
    const st = editor();
    if (!gs) return;
    if (gs.kind === 'drag') {
      const [tx, ty] = toTile(ev);
      const dx = tx - gs.tx;
      const dy = ty - gs.ty;
      if (gs.moved && (dx || dy)) {
        const moved = moveItems(gs.before, st.selection, dx, dy);
        setDoc(rerouteAfterMove(gs.before, moved, st.selection), { before: gs.before });
      }
      setOverlay((o) => ({ ...o, drag: null, ghosts: [] }));
    } else if (gs.kind === 'marquee') {
      const [, , px, py] = toTile(ev);
      const c = cam.current;
      const x0 = c.x + Math.min(gs.sx, px) / c.scale;
      const x1 = c.x + Math.max(gs.sx, px) / c.scale;
      const y0 = c.y + Math.min(gs.sy, py) / c.scale;
      const y1 = c.y + Math.max(gs.sy, py) / c.scale;
      const sel = cloneSel(st.selection);
      // everything entirely inside the box
      const inBox = (x: number, y: number, w: number, h: number) =>
        x >= x0 && y >= y0 && x + w <= x1 && y + h <= y1;
      for (const m of view.sol.machines) {
        if (inBox(m.x, m.y, m.shape.w, m.shape.h)) {
          const dm = view.machineOf.get(m.inst);
          if (dm) sel.machines.add(dm.key);
        }
      }
      P.nets.forEach((net, ni) => {
        const cells = view.sol.cells[ni];
        if (!cells.size) return;
        for (const c of cells) if (!inBox(kx(c), ky(c), 1, 1)) return;
        sel.pipes.add(net.key);
      });
      for (const v of view.doc.valves) {
        const g = valveGeometry(v);
        if ([g.a, g.m, g.e].every(([x, y]) => inBox(x, y, 1, 1))) sel.pieces.add(v.id);
      }
      for (const p of view.doc.passthroughs) {
        const [w, h] = p.horizontal ? [4, 2] : [2, 4];
        if (inBox(p.x, p.y, w, h)) sel.pieces.add(p.id);
      }
      for (const p of view.doc.intersections) if (inBox(p.x, p.y, 2, 2)) sel.pieces.add(p.id);
      for (const p of view.doc.power ?? []) {
        const [w, h] = pieceSize(p.kind, p.rot);
        if (inBox(p.x, p.y, w, h)) sel.pieces.add(p.id);
      }
      st.setSelection(sel);
      setOverlay((o) => ({ ...o, marquee: null }));
    } else if (gs.kind === 'paint') {
      if (gs.tiles.length <= 1) {
        // a click: start a click-to-click pipe from here (or from the whole existing network)
        const ni = gs.ni;
        const own = view.sol.netNodes[ni];
        const from = own.has(gs.tiles[0]) ? [...own] : [gs.tiles[0]];
        pending.current = { ni, from };
        st.notify('Click where the pipe should go (Esc cancels)');
      } else {
        const p = paintedSegments(gs.ni, gs.tiles);
        commitPipe(gs.ni, p.nodes, p.edges);
        setOverlay((o) => ({ ...o, pipePreview: null, activeNet: null }));
      }
    } else if (gs.kind === 'erase') {
      const after = curDoc();
      if (after !== gs.before) setDoc(after, { before: gs.before });
    }
    draw();
  };

  // ---------------------------------------------------------------- keyboard
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const target = ev.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      )
        return;
      if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
      const st = editor();
      const k = ev.key.toLowerCase();
      const d = useFlowStore.getState().gameLayout;
      if (k === 'escape') {
        pending.current = null;
        st.setPlacing(null);
        st.clearSelection();
        setOverlay((o) => ({
          ...o,
          pipePreview: null,
          activeNet: null,
          ghosts: [],
          pieceGhost: null,
        }));
      } else if (k === 'r') {
        if (st.placing) st.setPlacing({ ...st.placing, rot: (st.placing.rot + 1) % 4 });
        else if (
          st.tool === 'valve' ||
          st.tool === 'passthrough' ||
          st.tool === 'mv' ||
          st.tool === 'transformer'
        )
          st.rotatePiece();
        else if (d && st.selection.machines.size)
          setDoc(rotateMachines(d, view.ctx, st.selection.machines));
      } else if ((k === 'delete' || k === 'backspace') && d && selectionSize(st.selection)) {
        setDoc(deleteItems(d, withAttachedPipes(st.selection, view.ctx)));
        st.clearSelection();
      } else if (k === 'p' && d && selectionSize(st.selection)) {
        setDoc(togglePinned(d, st.selection));
      } else if (k === 'f') {
        fit();
      } else if (k === 'v') st.setTool('select');
      else if (k === 'w') st.setTool('pipe');
      else if (k === 'e') st.setTool('erase');
      else if (k === 'q') st.setTool('valve');
      else if (k === 't') st.setTool('passthrough');
      else if (k === 'i') st.setTool('intersection');
      else if (k === 'h') st.setTool('hv');
      else if (k === 'm') st.setTool('mv');
      else if (k === 'k') st.setTool('transformer');
      else if (k === 'g') st.setTool('grid');
      else return;
      ev.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [view, fit, editor, setDoc]);

  // tool previews depend on these; redraw when they change
  useEffect(draw, [draw, pieceRot, pieceKind, placing, doc]);

  return (
    <div ref={wrapRef} className={styles['canvas-wrap']} data-tool={tool}>
      <canvas
        ref={canvasRef}
        className={styles.canvas}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => {
          setHover(null);
          setOverlay((o) => ({ ...o, hover: null, pieceGhost: null }));
        }}
        onContextMenu={(e) => e.preventDefault()}
        aria-label="In-game layout"
      />
      {hover && (
        <TileTooltip view={shown} hit={hit} tile={hover.tile} px={hover.px} py={hover.py} />
      )}
    </div>
  );
}

function cloneSel(s: Selection): Selection {
  return { machines: new Set(s.machines), pipes: new Set(s.pipes), pieces: new Set(s.pieces) };
}

export type { HitIndex };
