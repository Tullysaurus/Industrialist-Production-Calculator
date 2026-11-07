# Industrialist Calculator

Industrialist Calculator is a browser-based production planner for the Roblox
game Industrialist. Build a graph from
recipes, connect inputs and outputs, and inspect production rates, temperatures,
shortages, and excesses. The app also includes machine-count optimization,
recipe autocomplete, editable game data, and local layout saves.

Next to the flowchart there is an **In-game layout** view: place the machines of the plan on
the game's tile grid by hand, draw pipes and conveyors, add valves, large pipe passthroughs and
intersections, or let the generator pack and route everything (keeping anything you pinned).

**Live app:** [industrialist-calculator.pages.dev](https://industrialist-calculator.pages.dev/)

## Stack

- TypeScript 6 and React 19, built with Vite 8.
- PixiJS renders the recipe and group graph by default using WebGL, with React Flow
  available as a device fallback and a selectable renderer in Theme Editor.
- Zustand stores canvas, settings, and result state.
- SCIP and SoPlex compiled to WebAssembly run in a browser Worker for ratio
  optimization. The prebuilt bundle is in `public/scip/`.
- IndexedDB stores layouts, autosave state, custom data overrides, and cached
  wiki comparison results. A service worker provides the installable app shell.

## Calculations

The flow pipeline resolves active recipe variants, builds the connected graph,
allocates product flows, and propagates temperatures. Recipes whose settings
depend on connected flow or temperature can trigger additional passes until the
settings settle or the pass limit is reached. See
[`src/solver/solverPipeline.ts`](src/solver/solverPipeline.ts).

The Ratio Optimizer keeps the recipes already on the canvas. Its staged solve
reduces connected-input shortages, then sink excess, then optimizes enabled
metrics in priority order, and finally minimizes fractional machine counts as
a tie-breaker. Complete Production searches for upstream recipes for existing
targets, solves candidate graphs, and verifies the generated graph before
offering a plan. Optimization metrics use Produced Pollution; the dashboard
reports Net Pollution, including reductions.

The native bundle uses a shared precision policy for solver tolerances and
whole-machine rounding. For the native model, payload, rebuild process, and
smoke suite, see [`tools/scip-wasm/README.md`](tools/scip-wasm/README.md).

## In-game layout

The tabs at the top switch between the **Flowchart** and the **In-game layout**. The layout is a
document stored in the save (save format v5): machines are keyed by their flowchart node and
instance, pipes by the flowchart connection they carry, so the layout is matched up again when
the flowchart changes (new machines appear as unplaced, removed ones are flagged).

- **By hand**: place machines from the Unplaced list, move / rotate / pin / delete them, paint
  pipes tile by tile or click port to port for an automatic path, erase tiles, and place valves,
  passthroughs and intersections. Undo and redo are shared with the flowchart.
- **Routing tools**: auto-route everything between placed machines that is not routed yet, or
  re-route selected pipes / the pipes of selected machines around everything else.
- **Generator**: packs all machines with as little empty space as it can (simulated annealing
  over a sequence-pair floorplan of machine blocks and modules), routes every pipe with a
  negotiated congestion A\* router (large pipes first, then normal pipes around and through
  them), then squeezes out the remaining gaps with seam carving: seams of empty tiles (and
  straight pipe runs) are cut out row by row, stepping around machines, with one-tile jogs in
  pipes where a seam crosses them. Empty space is counted inside the layout's orthogonal hull,
  so an L- or T-shaped layout is only lightly penalised for its notches (long tails and very
  elongated layouts cost a little extra, which keeps the shape compact). Pinned machines and pipes form a fixed block the rest is laid out around. It
  runs in a Web Worker, shows its best layout while it works and can be stopped at any time.
- **Rules checked** (Problems list): overlaps, pipes under machines, unconnected ports, at most
  two normal pipes per tile, large pipes only crossing at a 2x2 intersection, normal pipes only
  crossing large pipes through a 4x2 passthrough on a straight run, quantum hops only over
  normal pipes, valve placement, the mineshaft drill spacing rule, and an even-split simulation
  of every pipe split (valves at their set percentages).

Rates come from the website's own flow pipeline, so the layout always uses the same numbers as
the flowchart. Assumed geometry that is not in the game data: the 3x1 valve control, the 8x8
pipe adapter (large port centred on top, eight small ports in a flattened U) and the 4x2
passthrough.

## Run locally

Install the dependencies and start Vite from the repository root:

```sh
git clone https://github.com/Pollywrath/Industrialist-Production-Calculator.git
cd Industrialist-Production-Calculator
npm install
npm run dev
```

Available scripts:

```sh
npm run build        # TypeScript project build, then production Vite build
npm run preview      # Serve the production build locally
npm run lint         # ESLint checks for src/
npm run format       # Format source files under src/
npm run format:check # Check source and tooling formatting
npm run check:design-rules # Check CSS and TSX design rules
npm run test:game-layout   # In-game layout editor and generator tests
```

Layout generator tools (development):

```sh
node tools/game-layout-input.mjs save.json input.json   # solve a save and write the engine input
node tools/game-layout-bench.mjs input.json 60          # run the generator headlessly
node tools/game-layout-synth.mjs out-dir                # write synthetic benchmark saves
```

The checked-in WebAssembly bundle is sufficient for local app development.
Docker is required only to rebuild the native solver; follow the instructions in
[`tools/scip-wasm/README.md`](tools/scip-wasm/README.md).

## Code map

| Path                         | Responsibility                                                                    |
| ---------------------------- | --------------------------------------------------------------------------------- |
| `src/components/canvas/`     | Shared canvas host plus renderer-specific PixiJS and React Flow views             |
| `src/components/overlays/`   | Recipe selector, optimizer, Data Manager, saves, themes, machines, and Help       |
| `src/data/`                  | Built-in recipes, machines, products, research, lookups, and special recipe rules |
| `src/solver/`                | Flow and temperature pipeline, balancing, autocomplete, and ratio optimization    |
| `src/gameLayout/`            | In-game layout document, editing operations, routing tools, and the generator     |
| `src/components/gameLayout/` | In-game layout editor: tile canvas, tools tray, sidebar, inspector                |
| `src/stores/`                | Zustand stores for canvas, solver results, settings, and overlays                 |
| `src/persistence/`           | IndexedDB access, autosave, save transformation, and graph merging                |
| `src/tutorials/`             | Guided tutorial steps and tutorial graph definitions                              |
| `functions/api/`             | Wiki data proxy used by the Data Manager comparison view                          |
| `public/scip/`               | Runtime SCIP and SoPlex WebAssembly assets                                        |
| `tools/scip-wasm/`           | Native wrapper, pinned build setup, and smoke tests                               |

## License and data

The application source is licensed under the MIT License; see [LICENSE](LICENSE).
Game data and third-party assets have separate terms documented in
[ATTRIBUTIONS.md](ATTRIBUTIONS.md).
