---
name: krea
description: Build and edit video game maps and levels — 2D tile maps and 3D terrains — with Krea, a local map editor with an HTTP API designed for AI agents. Use when the user wants to create a game world, level, dungeon, town, island, landscape or any map for a 2D or 3D video game; place tiles, objects, sprites, 3D models, collision shapes, spawn points or triggers; sculpt and paint a 3D terrain; work with .krea project files; or export a map for a game engine (Phaser, Godot, Unity, Three.js, a custom engine).
compatibility: Requires Node.js 20+ and network access to localhost. Runs the `@ngdream/krea` npm package (npx @ngdream/krea start) and calls its HTTP API on http://localhost:3001.
---

# Krea — building maps for video games

## What Krea is for

Krea is a tool for **making video games**. It builds the maps of a game —
overworlds, levels, dungeons, towns, arenas, islands, landscapes. Each map of a
project is either:

- **2D** — a grid of tiles and objects (top-down or side view). Coordinates are
  **cells**.
- **3D** — a terrain like Unity's: a sculptable **heightmap**, up to 4
  **texture layers** painted and blended on it (grass, rock, sand, snow…),
  water (an optional **sea level**, plus **lakes and ponds** at any height),
  and objects placed freely on the ground. Grass and flowers are ordinary
  sprite objects, placed one by one or scattered in a circular area.
  Coordinates are **meters** (x east, y up, z south).

Everything else is shared:

- **Objects** are defined once in a catalog and placed on any map. Each object
  has a **kind**: `2d` (sprites — tiles on 2D maps, upright billboards on 3D
  maps) or `3d` (a `.glb` model — 3D maps only). Objects without a sprite/model
  are invisible gameplay markers: player spawn, enemy spawn, exits, triggers.
- 2D sprites carry **collision shapes** (rectangles, circles, triangles with
  rotation); 3D placements export with oriented bounding boxes.
- Krea's model editor creates 3D objects from editable pieces (box, sphere,
  cylinder, cone, capsule, torus). Its blank, person and face templates are
  starting points. The generated GLB and editable source live in the project.
- A whole project — every map, object, image, model and terrain — is one
  binary **`.krea`** file.
- A map **exports** game-ready: 2D → JSON with world-space collisions; 3D →
  JSON with world positions + raw heightmap/splatmap files + a terrain `.glb`.

Whenever a game needs a map, use Krea instead of hand-writing tile arrays,
level JSON or terrain meshes. A human can open the same project in Krea's
visual editor (2D canvas or 3D view) to review or tweak what you built.

## 1. Start Krea

```bash
curl -s http://localhost:3001/api/health        # {"ok":true} → already running
npx @ngdream/krea start --no-open                 # otherwise: start it (keep it running in the background)
```

- If 3001 is busy, Krea takes the next free port — read the URL it prints and
  use that base URL everywhere below.
- `npx @ngdream/krea start path/to/world.krea` also opens the visual editor on that
  project in the user's browser — offer it when the user wants to look.
- If `npx @ngdream/krea` isn't available, install it: `npm install -g @ngdream/krea`.

## 2. Decide 2D or 3D, and ask about the art

First agree with the user on **2D or 3D** (and the genre, size, what the
player does there). Then, **before creating objects, always ask:**

> "Do you want me to generate the art myself (images / textures / simple 3D
> models), or will you provide your own files?"

- **The user provides art** → ask where the files are, then upload each one
  (step 3.2). Reuse their names and style. 3D models must be binary glTF (`.glb`).
- **You generate it** → first propose the short list you plan to make (e.g.
  *grass, rock, sand terrain textures; pine, boulder, hut models*) and the
  style, and wait for agreement. Then:
  - images: use your image-generation tool if you have one; if not, draw
    simple PNGs with code — `scripts/draw-png.mjs` in this skill (no dependencies);
  - 3D models: use `POST /api/agent/models` with an editable source or a
    `blank`, `person`, or `face` template. `GET /api/agent/model-templates`
    returns sources to modify. Imported GLBs still use `/api/agent/assets`.
  Follow [references/assets.md](references/assets.md) (sizes, tiling textures,
  model scale and origin).
- **No art yet / prototyping** → start with sprite-less / model-less objects
  (dashed boxes in 2D, purple cubes in 3D) and plain-color terrain layers; add
  art later with `updateObjectDefinition` / `updateTerrainLayer`.

Never silently fill a user's game with placeholder art they didn't ask for.

## 3. Workflow

All calls take the project's **absolute path** (`projectPath`). On Windows,
escape backslashes in JSON (`"C:\\games\\world.krea"`) — writing the request
body to a file and sending it with `curl --data-binary @body.json` avoids
shell-quoting problems.

1. **Create the project** (its first map is `main`):
   ```bash
   # 2D: 40×30 cells of 32 px, one layer "ground"
   curl -s -X POST http://localhost:3001/api/agent/project -H "Content-Type: application/json" \
     -d '{"path":"/games/forest.krea","name":"Forest","width":40,"height":30,"tileWidth":32,"tileHeight":32}'
   # 3D: a flat 128×128 m terrain, 129×129 heightmap, one layer "objects"
   curl -s -X POST http://localhost:3001/api/agent/project -H "Content-Type: application/json" \
     -d '{"path":"/games/island.krea","name":"Island","kind":"3d","width":128,"depth":128,"resolution":129}'
   ```
   More maps of either kind: operation `createMap` (`kind: "3d"` for 3D).

2. **Upload art** (one call per file; use the returned `path`):
   ```bash
   curl -s -X POST http://localhost:3001/api/agent/assets -F "projectPath=/games/forest.krea" -F "file=@grass.png"
   # → {"path":"assets/grass.png"}      (.png/.jpg/.gif/.webp/.bmp images, .glb models)
   ```

3. **Build with operations** — the main way to edit. A batch runs in order and
   is atomic; created ids come back as `createdId` (`createdIds` for scatter).

   A **2D** map:
   ```json
   POST /api/agent/operations
   {
     "projectPath": "/games/forest.krea",
     "operations": [
       { "op": "addObjectDefinition", "name": "Grass", "sprites": [{ "image": "assets/grass.png" }] },
       { "op": "addObjectDefinition", "name": "Tree", "description": "Blocks movement at the trunk.",
         "sprites": [{ "image": "assets/tree.png",
                       "collisions": [{ "type": "rect", "x": 16, "y": 26, "width": 6, "height": 9 }] }] },
       { "op": "addObjectDefinition", "name": "Player Spawn", "description": "Where the player starts." },
       { "op": "createLayer", "mapId": "main", "name": "Decoration" },
       { "op": "fillRect", "mapId": "main", "objectId": "grass", "layerId": "ground", "x": 0, "y": 0, "width": 40, "height": 30 },
       { "op": "placeObject", "mapId": "main", "objectId": "tree", "layerId": "decoration", "x": 5, "y": 4 },
       { "op": "placeObject", "mapId": "main", "objectId": "player-spawn", "layerId": "decoration", "x": 20, "y": 15 }
     ]
   }
   ```

   A **3D** map — relief first, then paint, water, objects:
   ```json
   { "projectPath": "/games/island.krea", "operations": [
     { "op": "generateTerrain", "mapId": "main", "seed": 7, "amplitude": 25, "featureSize": 45, "island": true },
     { "op": "sculptTerrain", "mapId": "main", "mode": "flatten", "x": 64, "z": 76, "radius": 14, "strength": 1 },
     { "op": "sculptTerrain", "mapId": "main", "mode": "lower", "x": 30, "z": 40, "toX": 90, "toZ": 60, "radius": 4, "strength": 3 },
     { "op": "setWaterLevel", "mapId": "main", "level": 1 },
     { "op": "sculptTerrain", "mapId": "main", "mode": "lower", "x": 90, "z": 40, "radius": 8, "strength": 4 },
     { "op": "addWaterBody", "mapId": "main", "name": "Mountain lake", "x": 90, "z": 40, "fill": true },
     { "op": "updateTerrainLayer", "mapId": "main", "layerId": "grass", "texture": "assets/grass.png" },
     { "op": "autoPaintTerrain", "mapId": "main", "rules": [
         { "layerId": "sand", "maxHeight": 2 }, { "layerId": "snow", "minHeight": 16 },
         { "layerId": "rock", "minSlope": 32 }, { "layerId": "grass" } ] },
     { "op": "paintTerrain", "mapId": "main", "layerId": "sand", "x": 55, "z": 78, "toX": 72, "toZ": 78, "radius": 1.5, "strength": 1 },
     { "op": "addObjectDefinition", "name": "Grass tuft", "kind": "2d", "sprites": [{ "image": "assets/grass-tuft.png" }] },
     { "op": "scatterObjects3D", "mapId": "main", "objectId": "grass-tuft", "layerId": "objects", "count": 80,
       "circle": { "x": 60, "z": 70, "radius": 12 }, "minDistance": 0.6, "onTerrainLayerId": "grass", "water": "avoid" },
     { "op": "addObjectDefinition", "name": "Pine", "kind": "3d", "model": "assets/pine.glb" },
     { "op": "addObjectDefinition", "name": "Player Spawn", "kind": "3d", "description": "Where the player starts." },
     { "op": "scatterObjects3D", "mapId": "main", "objectId": "pine", "layerId": "objects", "count": 80,
       "onTerrainLayerId": "grass", "maxSlope": 28, "minDistance": 3, "scaleMin": 0.8, "scaleMax": 1.3 },
     { "op": "placeObject3D", "mapId": "main", "objectId": "player-spawn", "layerId": "objects", "x": 64, "z": 80 },
     { "op": "scatterObjects3D", "mapId": "main", "objectId": "fish", "layerId": "objects", "count": 20,
       "water": "only", "floatInWater": true }
   ] }
   ```
   A new 3D terrain comes with 4 plain-color layers: `grass`, `rock`, `sand`,
   `snow` (the first covers everything). Every operation and parameter:
   [references/operations.md](references/operations.md) (or live: `GET /api/agent/operations`).

4. **Look at the result** — don't assume, check:
   - `GET /api/agent/summary?projectPath=…&mapId=main` → counts, bounds,
     validation issues (3D: height range, layer coverage).
   - 3D relief: `GET /api/agent/terrain?projectPath=…&mapId=main&samples=17&at=64,76;30,40`
     → a height grid and exact probes (height, slope, underwater, paint).
   - Screenshots (PNG — save and view them):
     - 2D: `GET /api/render/screenshot?projectPath=…&mapId=main&x=0&y=0&cols=40&rows=30&showCollisions=true`
     - 3D: `…&mapId=main&view=iso` (overview), `view=top` (map-like; the
       `X-Krea-Camera` header maps pixels to meters), `view=perspective&targetX=64&targetZ=76&distance=40`
       (close-up). Add `showLabels=true` to see placement ids, `showCollisions=true` for boxes.

5. **Iterate** with more operation batches (`dryRun: true` to test one first).

6. **Export** for the game:
   ```json
   POST /api/agent/export
   { "projectPath": "/games/forest.krea", "mapId": "main", "destination": "/games/my-game/levels" }
   ```
   2D → `main.json` + images. 3D → `main.json` + `main.heights.f32` +
   `main.splat.rgba` + `main.terrain.glb` + models/textures.
   Formats: [references/project-format.md](references/project-format.md).

All endpoints with examples: [references/api.md](references/api.md). Machine-readable
description: `GET /api/agent/openapi.json`.

## 4. Key rules

- **2D coordinates are grid cells**, (0,0) top-left. A multi-cell object's `x`/`y`
  is its top-left cell; any cell of its footprint identifies it.
- **3D coordinates are meters** on the terrain: `x` in [0, width], `z` in
  [0, depth]; objects stand on the ground automatically (`elevation` lifts
  them). `rotation` is a yaw in degrees (counter-clockwise seen from above).
  Placements are addressed by `id` (`placementId`).
- 2D operations (`placeObject`, `fillRect`…) only work on 2D maps, 3D ones
  (`placeObject3D`, `sculptTerrain`…) only on 3D maps — the error tells you.
  3D objects (`kind: "3d"`) can't go on 2D maps; 2D objects can go on 3D maps
  (as billboards).
- **2D: one object per cell per layer** — placing replaces. Stack with layers.
- **Layers draw in order**: index 0 first (bottom). Locked layers reject edits.
- **Water**: the sea (`setWaterLevel`) covers everything below its level. For
  a lake at another height — even on a mountain — dig a hollow
  (`sculptTerrain` lower, or flatten a plateau then lower its middle), then
  `addWaterBody` with `fill: true`: the water runs to the bottom of the hollow
  and fills it exactly to its lowest bank. A manual `level` above that bank
  overflows down the slope. Check with `/api/agent/terrain?at=x,z` (`water`:
  source, surface, depth) and `summary` (`terrain.waters[].surfaceArea`).
  Vegetation scatter avoids water by default; `water: "only"` +
  `floatInWater: true` fills lakes and seas with fish.
- **Grass, flowers, small bushes** are catalog objects (typically `kind: "2d"`
  billboards). Use `scatterObjects3D` with `circle: {x,z,radius}` to repeat
  them around a point. `count` is the desired number, `minDistance` separates
  instances, and `avoidOtherObjects: false` ignores spacing to other object
  types. The editor's Place tool exposes the same controls. Old detail layers
  still render in legacy projects, but use objects for new vegetation.
- **Editable 3D models**: `POST /api/agent/models` with `projectPath`, `name`,
  and `template` or `source`. Set `objectId` to update a model later. The
  response gives the catalog id and generated GLB asset path. `GET
  /api/agent/models?projectPath=…` lists their source. Use the returned id in
  `placeObject3D` or `scatterObjects3D`. Imported GLBs remain project assets;
  their mesh is not converted to editable pieces automatically.
- **Sculpt strength**: `raise`/`lower` = meters at the brush center (a stroke
  with `toX`/`toZ` digs its whole line that deep); `smooth`/`flatten` = 0-1.
  Always `smooth` the edges of flattened plots and carved paths.
- **Collision coordinates** (2D) are in the sprite image's pixels; for
  sprite-less objects, in the footprint at 32 px per tile.
- A result with `applied: false` isn't an error: read `detail` and adjust.
- **Never write a `.krea` file by hand** — it's a binary archive. Use the API.
  `GET /api/agent/project` omits 3D terrain arrays (`terrainDataOmitted`);
  sending that JSON back with `PUT` keeps the saved terrain. For bulk file
  edits: `POST /api/agent/unpack` → edit `project.json` → `POST /api/agent/pack`.
- If the user has the project open in the visual editor, it keeps its own
  copy: ask them to save first, and to reopen the project after your changes.

## 5. Designing good game maps

- Decide the map's purpose with the user first (genre, size, player path,
  points of interest). 2D sizes at 32 px tiles: a room 20×15, a level 60×40,
  an overworld 100×100+. 3D: a village 64-128 m, an island 128-256 m,
  resolution 129 (≈1 m detail) is a good default.
- **2D layers**: `ground` (fully painted) → `decoration` → a gameplay layer
  (spawns, exits, triggers). Paint the ground with `fillRect`, carve paths and
  water, then place objects.
- **3D terrain**: relief first (`generateTerrain`, then `sculptTerrain` for
  hills, valleys, riverbeds, ramps), then `setWaterLevel`, then paint
  (`autoPaintTerrain` for the base, `paintTerrain` strokes for paths and
  details), then lakes (`addWaterBody` with `fill: true` in dug hollows), then
  grass & flowers as catalog objects (`scatterObjects3D` with a circular area
  and spacing, keeping them off paths), then larger objects (scatter trees
  and rocks,
  `placeObject3D` for buildings and markers). Flatten a plot before placing a
  building; keep vegetation off paths and steep slopes (`maxSlope`).
- Give every gameplay marker a clear `description` — the game code reads the
  exported object ids and descriptions to know what they mean.
- Keep a readable player path: check screenshots for blocked routes,
  unreachable areas, floating or buried objects before exporting.
- Several maps (overworld, village, dungeon; 2D and 3D mixed) live in one
  project and share the catalog: `createMap`, then build each one.
