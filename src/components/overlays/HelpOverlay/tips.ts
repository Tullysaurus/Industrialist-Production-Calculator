export interface TipCategory {
  id: string;
  title: string;
  summary: string;
  icon: string;
  tips: string[];
}

export const CATEGORIZED_TIPS: TipCategory[] = [
  {
    id: 'tips-shortcuts',
    title: 'Canvas and shortcuts',
    summary: 'Move around the canvas and switch tools without leaving your work.',
    icon: 'MousePointerSquareDashed',
    tips: [
      'Hold Alt to delete a node or connection, then release it to return to your previous tool.',
      'Hold Ctrl (Windows/Linux) or Command (Mac) to select several nodes and move them together.',
      'Hold Shift while clicking a recipe node to mark or unmark it as a target.',
      'Select an edge and double-click it to add bends. Orthogonal edges add a pair of bends at a time.',
      'Click a recipe input or output row to open Add Recipe with that product and side already selected.',
      'Select several recipe nodes and choose Add Group to keep that part of the graph together.',
      'Zoom out on a large graph to switch nodes to their compact view; zoom in to see the recipe details again.',
    ],
  },
  {
    id: 'tips-ingame',
    title: 'In-game layout',
    summary: 'Lay the factory out tile by tile, by hand or with the generator.',
    icon: 'Factory',
    tips: [
      'Switch between Flowchart and In-game layout with the tabs at the top. The in-game layout is saved with the save file.',
      'Every machine of the flowchart appears under Unplaced. Click one, move the mouse onto the grid and click to place it; R rotates and Shift+click keeps placing the same machine.',
      'Pipe tool (W): drag from a port to paint a pipe tile by tile, or click a port and then click where the pipe should go to let the router find a legal path.',
      'Auto-route connects everything between placed machines that is not routed yet; Re-route redoes the selected pipes or the pipes of the selected machines.',
      'Pin machines and pipes (P) to keep them: Generate lays out everything else around the pinned part.',
      'A normal pipe crosses a large pipe only through a passthrough, two large pipes cross through an intersection. Drawing across a large pipe adds the passthrough when it fits.',
      'Valves (Q) lie on a pipe: in at one end, straight out at the other, side out of the middle. Set the side share in the inspector, or use the planned share.',
      'Problems lists everything that breaks a game rule or the plan; click an entry to jump to it. When the flowchart changes, new machines show up as Unplaced and removed ones are marked in red.',
    ],
  },
  {
    id: 'tips-solver',
    title: 'Flow and optimization',
    summary: 'Understand shortages, targets, and the optimizer results.',
    icon: 'Zap',
    tips: [
      'Mark at least one recipe node as a target before you run Compute. Targets tell the optimizer which machine counts it must preserve.',
      'Compute suggests machine counts for the connected recipe graph. Review the proposed changes before you apply them.',
      'Double-click a connected input or output handle to balance that recipe against the flow on its connected product network.',
      'A variable input or output is a capacity limit. Its actual flow depends on the connected graph.',
      'Connect unwanted byproducts to a dump, burner, or another recipe if they are blocking production.',
      'Temperature-sensitive recipes use temperatures carried by connected flow. With no flow, an edge does not carry material or temperature.',
      'After changing a machine count or connection, let the canvas recalculate before reading the dashboard.',
    ],
  },
  {
    id: 'tips-recipes',
    title: 'Recipes and node settings',
    summary: 'Change machine counts, recipe settings, and handle order.',
    icon: 'Settings',
    tips: [
      'Open a node’s editor to change its machine count or settings. Special recipes may have controls for fuel, temperature, or other inputs.',
      'Use Reset Handles to restore the recipe’s original input and output order.',
      'Apply to Chain scales the connected machines by the same ratio as the selected node.',
      'For a variable handle, the editor shows its maximum capacity. The connected flow can be lower.',
      'Some recipes change their inputs, outputs, or rates when you change a setting or connect a temperature-sensitive input.',
    ],
  },
  {
    id: 'tips-saves',
    title: 'Saves and dashboard',
    summary: 'Keep a copy of your graph and find problems in the production chain.',
    icon: 'Save',
    tips: [
      'Save Manager stores layouts in this browser. Export a JSON save if you want to move it to another browser or share it.',
      'Export PNG saves an image of the current canvas view.',
      'Use Rate in the controls tray to show rates per second, minute, hour, or recipe cycle.',
      'Use Machines to set difficulty and research unlocks; these choices affect which recipes are available.',
      'Open More Stats to find shortages and excess products. Click a row to center the graph on the related node.',
      'The app autosaves your current graph in the browser. It is not a substitute for exporting a backup.',
    ],
  },
];

export const ALL_TIPS: string[] = CATEGORIZED_TIPS.flatMap((cat) => cat.tips);
