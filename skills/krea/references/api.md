# Krea HTTP API (for agents)

Base URL: `http://localhost:3001` (or the URL `krea start` printed). Every
agent route is **stateless**: it takes the `.krea` path and never touches the
visual editor's session. Errors come back as `{ "error": "…" }` with a 4xx/5xx
status; validation failures also include `issues: [{ severity, message, path }]`.

Machine-readable version of this page: `GET /api/agent/openapi.json`.

## Projects

### `POST /api/agent/project` — create

```jsonc
// 2D first map: cells and pixels
{ "path": "/games/forest.krea", "name": "Forest", "width": 40, "height": 30, "tileWidth": 32, "tileHeight": 32, "mapName": "Overworld" }
// 3D first map: meters and heightmap samples (defaults: 128 × 128 m, resolution 129, no water)
{ "path": "/games/island.krea", "name": "Island", "kind": "3d", "width": 128, "depth": 128, "resolution": 129, "waterLevel": null }
```

Writes the file immediately (`.krea` is appended if missing; refuses to
overwrite). The first map's id is `main`: a 2D map has one layer `ground`; a
3D map has one layer `objects` and terrain layers `grass`, `rock`, `sand`,
`snow` (plain colors, the first one covering everything).
→ `{ "projectPath": "…", "project": { … } }`

### `GET /api/agent/project?projectPath=…` — read everything

→ `{ "projectPath", "project", "issues" }`. The full JSON can be large; prefer
`/summary` to orient yourself. 3D terrain arrays are left out
(`terrainDataOmitted: true`) unless you add `&terrainData=true` (then each 3D
map's terrain has `heightsBase64` — little-endian float32 — and `splatBase64`).

### `PUT /api/agent/project` — replace the whole JSON

`{ "projectPath": "…", "project": { … } }` — keeps the images and models
already in the archive; refused if invalid. A 3D map sent without terrain
arrays keeps its saved terrain (same resolution). Prefer `/operations` for
normal edits.

### `GET /api/agent/maps?projectPath=…` — overview

Every map (id, name, size, layer and instance counts) and every catalog object
(sprite and collision counts), plus validation status.

### `GET /api/agent/summary?projectPath=…&mapId=…` — one map in detail

`kind` (`2d`/`3d`), layers with instance/placement counts, the catalog (with
`placeable` on this map) and how often each object is used here,
`occupiedBounds`, validation issues, and a `screenshotUrlTemplate`. 3D maps
also get `terrain`: size, resolution, water level, min/max/mean height, each
texture layer's `coverage` (0-1).

### `GET /api/agent/terrain?projectPath=…&mapId=…&samples=33&at=x,z;x,z` — 3D relief

```jsonc
{
  "size": { "width": 128, "depth": 128 }, "resolution": 129, "waterLevel": 1,
  "minHeight": -11.1, "maxHeight": 16.8, "meanHeight": -2.8,
  "layers": [{ "id": "grass", "color": "#588c3c", "texture": "assets/grass.png", "tileSize": 4, "coverage": 0.21 }, …],
  "heightGrid": { "samples": 33, "spacing": { "x": 4, "z": 4 }, "rows": [[…33 heights…], …] },   // rows along z from z=0
  "waters": [{ "id": "mountain-lake", "name": "Mountain lake", "x": 81, "z": 48, "level": 13.01 }],
  "probes": [{ "x": 64, "z": 76, "height": 4.2, "slope": 1.5, "underwater": false, "layers": { "grass": 0.9, "sand": 0.1, … } },
             { "x": 81, "z": 48, "height": 10.8, "underwater": true, "water": { "source": "mountain-lake", "surface": 13.01, "depth": 2.2 }, … }]
}
```

`samples` is 2-129. Use it to find flat spots, peaks, shores, and to check
that a plot is flat before placing a building.

### `GET /api/agent/objects?projectPath=…`

The catalog with every sprite and collision shape.

## Images and models

### `POST /api/agent/assets` — upload (multipart/form-data)

Fields: `projectPath`, `file`. Stores the image or `.glb` model inside the
archive and saves.

```bash
curl -s -X POST http://localhost:3001/api/agent/assets -F "projectPath=/games/forest.krea" -F "file=@tree.png"
# → {"path":"assets/tree.png"}   (a suffix is added if the name is taken — always use the returned path)
```

Images: PNG, JPG, GIF, WebP or BMP, up to 10 MB each. Models: binary glTF
(`.glb`), up to 50 MB — use them as a 3D object's `model`.

### `GET /api/agent/assets?projectPath=…`

Every image and model in the archive, its size in bytes, and what uses it
(`object/sprite`, a 3D object, or `map/terrain/layer`).

### `GET /api/agent/model-templates` — editable starting shapes

Returns `blank`, `person`, and `face` sources. Each source has `version: 1`
and 1–128 parts. Parts have `id`, `name`, `shape` (`box`, `sphere`, `cylinder`,
`cone`, `capsule`, `torus`), `position` and `scale` as `[x,y,z]`, `rotation` as
Euler degrees, `color` as `#rrggbb`, and `metallic`/`roughness` from 0 to 1.

### `POST /api/agent/models` — create or update an editable 3D object

```json
{ "projectPath": "/games/island.krea", "name": "Guard", "template": "person" }
```

To customize it, send `source` instead of `template`. To update the same
catalog object, add `objectId` and send the modified `source`. The API
generates a `.glb`, stores both it and the editable source in the `.krea`
file, then returns `{ projectPath, objectId, model, parts, created }`.
`GET /api/agent/models?projectPath=…` lists 3D objects and their source when
available. Imported `.glb` models have no editable source until replaced
through this endpoint. Use the catalog `objectId` for placement operations.

## Editing

### `GET /api/agent/operations`

The catalog of edit operations with descriptions and parameter types.

### `POST /api/agent/operations`

```json
{ "projectPath": "…", "operations": [ { "op": "fillRect", … }, … ], "dryRun": false }
```

→ `{ "saved": true, "results": [ { "index", "op", "applied", "detail"?, "createdId"?, "createdIds"? } ], "issues": [] }`

- Runs in order on the same project; later operations can use ids created
  earlier (ids are slugified names: "Stone Wall" → `stone-wall`, unless you pass `id`).
- **Atomic**: a malformed operation → 400, nothing saved, and the error names
  the problem (unknown op/parameter, wrong type, unknown map/layer/object —
  listing the valid ids). An invalid final project → 400, nothing saved.
- `applied: false` = valid but no change (see `detail`); the batch continues.
- `dryRun: true` runs and validates without saving.

Full list: [operations.md](operations.md).

### `POST /api/validate`

`{ "project": { … } }` → `{ "valid", "issues" }` — structural check of a
project JSON you built yourself.

## Looking at maps

### `GET /api/render/screenshot` → PNG

Rendered on the server (no browser needed).

**2D maps** — a region of cells:

| Query | Default | Meaning |
|---|---|---|
| `projectPath` | — (required) | the `.krea` file |
| `mapId` | first map | which map |
| `x`, `y` | 0, 0 | top-left **cell** of the region |
| `cols`, `rows` | 20, 15 | region size in cells |
| `zoom` | 1 | scale (output capped at 4096 px per side) |
| `showGrid` | false | draw cell lines |
| `showCollisions` | false | overlay collision shapes in red |
| `layers` | visible layers | comma-separated layer ids (drawn even if hidden) |

Sprite-less objects appear as purple dashed, crossed boxes. For big maps,
capture regions rather than the whole map at high zoom.

**3D maps** — a camera view of the terrain, water and objects:

| Query | Default | Meaning |
|---|---|---|
| `view` | `iso` | `iso` (fitted overview), `top` (orthographic, like a map), `perspective` (free camera) |
| `width`, `height` | 1024, auto | image size in px (16-2048); `top` keeps the area's aspect |
| `areaX`, `areaZ`, `areaWidth`, `areaDepth` | whole terrain | area (meters) to frame (iso/top) and to center on (perspective) |
| `yaw` | 45 | degrees around the vertical the camera looks **from** (0 = from +z / south) |
| `pitch` | 35 / 30 | degrees above the horizon (iso / perspective) |
| `targetX`, `targetZ` | area center | perspective: point looked at |
| `distance` | ≈ area size | perspective: meters from the target |
| `fov` | 50 | perspective: vertical field of view |
| `showGrid`, `gridSpacing` | false, auto | world grid lines on the terrain (meters) |
| `showCollisions` | false | each placement's bounding box in red |
| `showLabels` | false | each placement's id written above it |
| `layers` | visible layers | comma-separated layer ids |

The `X-Krea-Camera` response header (JSON) describes the camera. With
`view=top` it maps pixels to the world: `x = originX + px * metersPerPixel`,
`z = originZ + py * metersPerPixel` — handy to turn "that clearing in the
screenshot" into coordinates. 2D objects appear as billboards, model-less 3D
objects as purple cubes.

## Output

### `POST /api/agent/export` — game-ready JSON

```json
{ "projectPath": "…", "mapId": "main", "destination": "/games/my-game/levels", "overwrite": false, "copyAssets": true }
```

`destination` is a folder (file named `<mapId>.json`) or a `.json` path. With
`copyAssets`, the images/models the map uses are written next to it under the
same relative paths. Existing files are kept unless `overwrite: true`. For a
3D map, `terrainFiles` lists the heightmap, splatmap and terrain mesh written
next to the JSON. Formats in [project-format.md](project-format.md#export-format).

### `POST /api/agent/unpack` / `POST /api/agent/pack`

- unpack: `{ "projectPath", "destination", "overwrite"? }` → a folder with
  `project.json` + `assets/…` + `maps/<id>/heights.f32` & `splat.rgba` for 3D maps.
- pack: `{ "folder", "destination", "overwrite"? }` → builds a `.krea` from
  such a folder (validated first).

Useful for bulk edits with file tools, or to keep a project under Git.
