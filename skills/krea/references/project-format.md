# The .krea project format

A `.krea` file is a zip archive:

```
world.krea
├── project.json               the whole project (below)
├── assets/*.png, *.glb        every image and 3D model, referenced by these paths
└── maps/<mapId>/              one folder per 3D map
    ├── heights.f32            heightmap: resolution² float32 (little-endian), row-major
    ├── splat.rgba             paint weights: resolution² × 4 bytes (one channel per terrain layer)
    └── details.rgba           grass/flower density: resolution² × 4 bytes (one channel per detail layer)
```

Don't write it by hand — use the API, or `unpack` → edit files → `pack`.

## project.json

```jsonc
{
  "format": "krea",
  "version": 3,                                   // version 2 files (2D only) are upgraded on read
  "name": "My World",
  "objects": [                                   // shared by every map
    {
      "id": "tree",
      "name": "Tree",
      "kind": "2d",                                     // "2d": sprites. "3d": a .glb model (3D maps only)
      "description": "Blocks movement at the trunk.",   // optional; say what it means for gameplay
      "sizeInTiles": { "width": 1, "height": 1 },       // optional, default 1×1
      "defaultSpriteId": "summer",                      // required when there are sprites
      "sprites": [
        {
          "id": "summer",
          "name": "Summer",
          "image": "assets/tree.png",
          "collisions": [
            { "id": "trunk", "type": "rect", "x": 16, "y": 26, "width": 6, "height": 9, "rotation": 0 }
          ]
        },
        { "id": "autumn", "name": "Autumn", "image": "assets/tree-autumn.png", "collisions": [] }
      ]
    },
    {
      "id": "player-spawn",
      "name": "Player Spawn",
      "kind": "2d",
      "description": "Where the player starts.",
      "sprites": [],                                   // sprite-less: invisible in-game
      "collisions": []                                 // optional, footprint space (see below)
    },
    {
      "id": "pine",
      "name": "Pine",
      "kind": "3d",
      "model": "assets/pine.glb",                      // absent = invisible 3D marker
      "modelSource": { "version": 1, "parts": [          // only for models created in Krea
        { "id": "trunk", "name": "Trunk", "shape": "cylinder", "position": [0, 1, 0],
          "rotation": [0, 0, 0], "scale": [0.3, 2, 0.3], "color": "#79553a", "metallic": 0, "roughness": 0.9 }
      ] },
      "sprites": []                                    // always empty for 3D objects
    }
  ],
  "maps": [
    {
      "kind": "2d",
      "id": "main",
      "name": "Overworld",
      "settings": { "width": 40, "height": 30, "tileWidth": 32, "tileHeight": 32 },
      "layers": [                                       // drawn in order: index 0 at the bottom
        { "id": "ground", "name": "Ground", "visible": true, "locked": false },
        { "id": "decoration", "name": "Decoration", "visible": true, "locked": false }
      ],
      "mapping": [                                      // one entry per placed instance
        { "objectId": "tree", "layerId": "decoration", "x": 5, "y": 4 },
        { "objectId": "tree", "layerId": "decoration", "x": 7, "y": 4, "spriteId": "autumn" }
      ]
    },
    {
      "kind": "3d",
      "id": "island",
      "name": "Island",
      "terrain": {
        "resolution": 129,                              // heightmap samples per side
        "size": { "width": 128, "depth": 128 },         // meters
        "waterLevel": 1,                                // or null
        "layers": [                                     // 1-4 texture layers, index = splat channel
          { "id": "grass", "name": "Grass", "color": "#588c3c", "texture": "assets/grass.png", "tileSize": 4 },
          { "id": "rock", "name": "Rock", "color": "#7a766e", "tileSize": 6 }
        ],
        "detailLayers": [                               // 0-4 grass/flower layers, index = details channel
          { "id": "grass", "name": "Grass", "color": "#6f9c3d", "width": 0.45, "height": 0.5, "sizeVariation": 0.35, "density": 12 },
          { "id": "flowers", "name": "Flowers", "sprite": "assets/flowers.png", "color": "#ffffff", "width": 0.4, "height": 0.4, "sizeVariation": 0.3, "density": 1.5 }
        ],
        "heightsFile": "maps/island/heights.f32",
        "splatFile": "maps/island/splat.rgba",
        "detailsFile": "maps/island/details.rgba"
      },
      "waters": [                                       // lakes/ponds at their own heights
        { "id": "mountain-lake", "name": "Mountain lake", "x": 81, "z": 48, "level": 13.01 }   // optional: "color", "area"
      ],
      "layers": [{ "id": "objects", "name": "Objects", "visible": true, "locked": false }],
      "placements": [
        { "id": "pine-3", "objectId": "pine", "layerId": "objects", "x": 40.5, "z": 22.1, "elevation": 0, "rotation": 120, "scale": 1.1 }
      ]
    }
  ]
}
```

## 3D terrain

- World axes: **x** east (0 → width), **y** up, **z** south (0 → depth; it grows
  downward on the top view). Meters.
- Heightmap sample `(ix, iz)` is at `x = ix * width / (resolution - 1)`,
  `z = iz * depth / (resolution - 1)`; its height is `heights[iz * resolution + ix]`.
- Splat weights: 4 bytes per sample in the same order, channel `i` = `layers[i]`,
  summing to 255. The shader blends the layers' textures (tiled every
  `tileSize` meters) or plain `color`s by these weights.
- **Legacy detail layers** (grass, flowers, bushes): each sample's `details` byte is
  the painted density (0-255) of that layer; tufts per m² = `density` ×
  value / 255. Tufts are generated from it (deterministic per cell) — by
  Krea's editor and screenshots, and by your game. A layer without `sprite`
  or `model` is procedural grass blades in `color`. Existing projects still
  render these layers. For new vegetation, define catalog objects and use
  `scatterObjects3D` (optionally with a circular area).
- **Water**: `terrain.waterLevel` is the sea — every sample below it is under
  water. Each entry of `waters` is a lake: starting from its seed (`x`, `z`),
  every connected (4-neighbor) sample lower than `level` is under water,
  within `area` if set. So a lake can sit high up in the mountains; if its
  level is above the lowest bank, it spreads down the slope.
- Placements stand on the terrain: world `y` = terrain height at (`x`, `z`) +
  `elevation`. `rotation` = yaw in degrees, counter-clockwise seen from above
  (Three.js / glTF convention). `scale` is uniform. A 2D object placed on a 3D
  map is an upright billboard `sizeInTiles.width` meters wide.

## Coordinates

- **Grid cells**, origin (0,0) at the top-left; pixel position = cell × tile size.
- An instance's `x`/`y` is the **top-left cell of its footprint**; a 2×2 object
  at (10,4) covers (10..11, 4..5). The footprint must fit inside the map.
- Two instances on the same layer may not overlap (placing replaces).

## Collision shapes

Authored in the **sprite image's own pixels** (origin at the image's top-left),
centered on `x`/`y`:

| type | fields |
|---|---|
| `rect` | `x`, `y` (center), `width`, `height`, `rotation` |
| `circle` | `x`, `y` (center), `radius` |
| `triangle` | `x`, `y` (center), `points`: 3 × `{x, y}` offsets from the center before rotation, `rotation` |

`rotation` is in degrees, clockwise, around the center. In operations, `id`
is optional (generated) and `rotation` defaults to 0.

The sprite is stretched to fill the object's footprint, and its collisions
scale with it. So a 32×32 image on a 1×1 object at 32 px tiles is 1:1; a
64×64 image on a 2×2 object too.

**Sprite-less objects** have object-level `collisions` in *footprint space*:
the footprint drawn at 32 px per tile (a 2×1 trigger's space is 64×32).

## Export format

### 2D maps

`POST /api/agent/export` writes:

```jsonc
{
  "format": "krea-map-export",
  "version": 1,
  "project": { "name": "My World" },
  "map": { "id": "main", "name": "Overworld", "width": 40, "height": 30,
           "tileWidth": 32, "tileHeight": 32, "pixelWidth": 1280, "pixelHeight": 960 },
  "layers": [{ "id": "ground", "name": "Ground", "visible": true, "index": 0 }],
  "objects": [ /* the objects this map uses: sprites with imageWidth/imageHeight, collisions in sprite space */ ],
  "instances": [
    {
      "objectId": "tree", "spriteId": "summer", "layerId": "decoration", "x": 5, "y": 4,
      "pixel": { "x": 160, "y": 128, "width": 32, "height": 32 },
      "collisions": [   // already in world pixels
        { "id": "trunk", "type": "rect", "cx": 176, "cy": 154, "width": 6, "height": 9, "rotation": 0,
          "points": [ { "x": 173, "y": 149.5 }, { "x": 179, "y": 149.5 }, { "x": 179, "y": 158.5 }, { "x": 173, "y": 158.5 } ] }
      ]
    }
  ]
}
```

- Rect and triangle collisions come with `points` (world-space polygon);
  circles are `{ type: "circle", cx, cy, radius }`.
- Sprite-less instances have `spriteId: null` and their object-level collisions.
- With `copyAssets`, images are written next to the JSON under the same
  relative `image` paths.

### 3D maps

```
levels/
├── island.json            description (below)
├── island.heights.f32     the heightmap (same layout as inside the .krea)
├── island.splat.rgba      the paint weights
├── island.details.rgba    legacy grass/flower densities, if present
├── island.terrain.glb     the terrain as a mesh, colored by its blended layers
├── island.water.glb       the water surfaces: "sea" and one mesh per lake (if any water)
└── assets/…               models, sprites and terrain textures (copyAssets)
```

```jsonc
{
  "format": "krea-map-export", "version": 1, "kind": "3d",
  "map": { "id": "island", "name": "Island" },
  "terrain": { "width": 128, "depth": 128, "resolution": 129, "sampleSpacing": { "dx": 1, "dz": 1 },
               "minHeight": -11.1, "maxHeight": 16.8, "waterLevel": 1,
               "heightsFile": "island.heights.f32", "splatFile": "island.splat.rgba", "meshFile": "island.terrain.glb",
               "layers": [{ "id": "grass", "channel": 0, "texture": "assets/grass.png", "tileSize": 4, "color": "#588c3c", "coverage": 0.21 }] },
  "waters": [ { "id": "mountain-lake", "level": 13.01, "color": "#2f79a8", "surfaceArea": 75,
                "cells": [[78, 45], …] } ],      // wet heightmap cells: a ready-made "in water" mask
  "objects": [ /* used objects: kind, model, sprites, billboard size */ ],
  "placements": [
    { "id": "pine-3", "objectId": "pine", "layerId": "objects", "spriteId": null,
      "position": { "x": 40.5, "y": 6.2, "z": 22.1 },          // resolved on the terrain
      "elevation": 0, "rotation": 120, "scale": 1.1,
      "bounds": { "center": { … }, "halfSize": { … }, "rotation": 120 } }   // oriented box: a default collider
  ]
}
```

Engines: Unity (`TerrainData.SetHeights` from the .f32, alpha maps from the
splat), Godot (HeightMapShape3D / the .glb), Three.js/Babylon (load the
`.glb`, or build a PlaneGeometry from the heights).
