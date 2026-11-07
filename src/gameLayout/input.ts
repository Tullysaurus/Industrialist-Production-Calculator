/**
 * Builds the layout engine's input from the planner graph and the flow pipeline's results.
 * Pure function of its arguments (the stores are read by the caller), so it also runs in tests.
 */
import type { Edge } from '@xyflow/react';
import type { Machine, Product, Recipe } from '../types/data';
import type { CanvasNode } from '../types/nodes';
import type { FlowResults } from '../types/solver';
import { parseHandleId } from '../utils/idGenerator';
import type { MachineData } from './engine/geometry';
import type { LayoutInput, LayoutInputNode, LayoutRecipe } from './engine/types';

export interface LayoutSourceData {
  nodes: CanvasNode[];
  edges: Edge[];
  results: FlowResults;
  edgeFlows: Record<string, number>;
  inputTemps: Record<string, Record<number, number>>;
  nodeRecipes: Record<string, Recipe>;
  machines: Machine[];
  products: Product[];
  isSpecialRecipe: (recipeId: string) => boolean;
}

function toLayoutRecipe(r: Recipe): LayoutRecipe {
  return {
    id: r.id,
    name: r.name,
    machine_id: r.machine_id,
    cycle_time: r.cycle_time,
    power_consumption: r.power_use,
    power_type: r.power_type,
    pollution: r.pollution,
    inputs: r.inputs.map((io) => ({
      product_id: io.product_id,
      quantity: io.quantity,
      port_ids: io.port_ids,
      independentOfMachineCount: io.independentOfMachineCount,
    })),
    outputs: r.outputs.map((io) => ({
      product_id: io.product_id,
      quantity: io.quantity,
      port_ids: io.port_ids,
      independentOfMachineCount: io.independentOfMachineCount,
      temperature: io.temperature,
      voidable: io.voidable,
    })),
  };
}

export function buildLayoutInput(src: LayoutSourceData): LayoutInput {
  const nodes: LayoutInputNode[] = [];
  const recipeIds = new Set<string>();
  for (const n of src.nodes) {
    if (n.type !== 'recipe' || n.hidden) continue;
    const data = n.data;
    const recipe = src.nodeRecipes[n.id];
    const res = src.results.get(n.id);
    const temps = src.inputTemps[n.id] ?? {};
    recipeIds.add(n.id);
    nodes.push({
      id: n.id,
      recipeId: data.recipeId,
      name: recipe?.name ?? data.recipeId,
      machineCount: data.machineCount ?? 0,
      settings: data.settings ?? {},
      special: src.isSpecialRecipe(data.recipeId),
      recipe: recipe ? toLayoutRecipe(recipe) : null,
      inputs: (recipe?.inputs ?? []).map((_io, i) => ({
        connected: res?.inputFlows[i]?.connected ?? 0,
        temperature: temps[i] ?? null,
      })),
      outputs: (recipe?.outputs ?? []).map((io, i) => ({
        connected: res?.outputFlows[i]?.connected ?? 0,
        temperature: io.temperature ?? null,
      })),
    });
  }
  const edges: LayoutInput['edges'] = [];
  for (const e of src.edges) {
    if (e.hidden || !recipeIds.has(e.source) || !recipeIds.has(e.target)) continue;
    const s = e.sourceHandle ? parseHandleId(e.sourceHandle) : null;
    const t = e.targetHandle ? parseHandleId(e.targetHandle) : null;
    if (!s || !t) continue;
    edges.push({
      id: e.id,
      source: e.source,
      sourceIndex: s.index,
      target: e.target,
      targetIndex: t.index,
      flow: src.edgeFlows[e.id] ?? 0,
    });
  }
  const machines: MachineData[] = src.machines.map((m) => ({
    id: m.id,
    name: m.name,
    size: { x: m.size.x, y: m.size.y },
    category: m.category,
    cost: m.cost,
    ports: (m.ports ?? []).map((p) => ({
      id: p.id,
      type: p.type,
      direction: p.direction,
      x: p.x,
      y: p.y,
      width: p.width,
      side: p.type === 'product' ? p.side : undefined,
      product_type: p.type === 'product' ? p.product_type : undefined,
      power_type: p.type === 'power' ? p.power_type : undefined,
    })),
  }));
  return {
    nodes,
    edges,
    machines,
    products: src.products.map((p) => ({ id: p.id, name: p.name, type: p.type })),
  };
}
