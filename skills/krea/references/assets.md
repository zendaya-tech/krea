# Art for Krea maps

Ask the user first whether you should generate the art or they'll provide it
(see SKILL.md, step 2). These rules apply either way.

## Sizes

- **One tile = `tileWidth` × `tileHeight` pixels** of the map (32×32 by default).
- **Ground tiles** (grass, water, sand, floor): exactly one tile, **opaque**, and
  **seamless** — the left edge must continue the right edge, the top the
  bottom — or the map looks like a checkerboard.
- **Objects**: `sizeInTiles.width × tileWidth` by `sizeInTiles.height × tileHeight`.
  A 2×2 house at 32 px tiles → 64×64. The image is stretched to fill the
  footprint, so match the footprint's proportions.
- Higher-resolution art is fine (64×64 for a 1×1 object at 32 px tiles) —
  it's scaled down; collisions are authored in the image's own pixels either way.

## Transparency

Objects that don't fill their cells (trees, rocks, characters, props) need a
**transparent background** (PNG with alpha) so the ground shows through. Ground
tiles should be fully opaque.

## Consistency

- One perspective for the whole game (top-down, or 3/4 view) and one light
  direction.
- One palette and one level of detail (pixel art vs painted). Mixing styles
  is the fastest way to make a map look wrong.
- Several looks of the same thing (summer/autumn tree, open/closed door) are
  **sprites of one object**, not separate objects — add them to the object's
  `sprites` and pick per instance with `setInstanceSprite`.

## Files

- PNG (best), JPG, GIF, WebP or BMP; up to 10 MB each.
- Lowercase, descriptive names: `grass.png`, `tree-autumn.png`, `house-red.png`.
- Upload with `POST /api/agent/assets` and use the **returned** path (a suffix
  is added if the name is taken).

## 3D terrain textures

- One **seamless, opaque** image per terrain layer (grass, rock, sand, snow,
  dirt path…), 64×64 to 1024×1024. It repeats every `tileSize` meters
  (4 m for grass, 6 m for rock is a good start).
- Keep them low-contrast: strong details repeat visibly across a big terrain.
- Also set each layer's `color` to the texture's average color — it's used in
  previews and in the exported terrain mesh.

## Grass and flower objects

- Make each tuft or clump a catalog object. A 2D tuft image needs a
  **transparent** background, bottom-centered, about 32-128 px. On 3D terrain
  it stands upright as a billboard. Flowers and small bushes can also be
  lightweight `.glb` objects.
- Use `scatterObjects3D` with `circle`, `count`, and `minDistance` to place
  clumps. Keep grass and flowers off roads, water, and steep slopes with its
  filters. The editor offers quick Grass tuft and Flowers objects.

## 3D models (.glb)

- Binary glTF 2.0 (`.glb`), textures embedded. **Meters**, **y up**.
- The origin is where the object touches the ground: put it at the bottom
  center (a tree's trunk base, a house's floor center). Krea stands that point
  on the terrain.
- Real-world scale (a door ≈ 2 m, a pine 4-10 m); vary size per placement
  with `scale` rather than making several models.
- Keep them light for a game: hundreds to a few thousand triangles for props.
- 2D sprites also work on 3D maps as billboards (1 m per tile of width) —
  fine for grass tufts, flowers, distant trees, retro styles.

## Generating 3D models with code

If the user wants you to generate models and you have no 3D-generation tool,
`scripts/draw-glb.mjs` writes low-poly `.glb` files from simple parts, with no
dependencies:

```js
import { writeGlb, box, cone, cylinder, sphere, roof } from "./draw-glb.mjs";

writeGlb("pine.glb", [
  { color: "#6b4a2b", parts: [cylinder(0, 0, 0, 0.16, 1.2)] },                                   // trunk
  { color: "#2f6b3a", parts: [cone(0, 0.9, 0, 1.1, 1.6), cone(0, 1.8, 0, 0.85, 1.4), cone(0, 2.6, 0, 0.55, 1.2)] },
]);
writeGlb("hut.glb", [
  { color: "#d8c29a", parts: [box(0, 1.25, 0, 4, 2.5, 3)] },      // walls (center y = half height)
  { color: "#9a3b2e", parts: [roof(0, 2.5, 0, 4.4, 3.4, 1.6)] },  // gable roof on top
]);
writeGlb("rock.glb", [{ color: "#8a8680", parts: [sphere(0, 0.35, 0, 0.7, 0.65)] }]);
```

`node draw-glb.mjs out-folder` writes these three examples. Tell the user
they're placeholders; swapping in a real model later is one
`updateObjectDefinition` (`model`) — placements don't change.

## Generating PNGs with code

If you have no image-generation tool, `scripts/draw-png.mjs` (next to this
skill's SKILL.md) writes PNGs from a per-pixel function, with no dependencies:

```js
import { writePng, shade } from "./draw-png.mjs";

// A 32×32 seamless grass tile with a little noise.
writePng("grass.png", 32, 32, (x, y) => shade([86, 158, 74, 255], ((x * 7 + y * 13) % 5 === 0) ? 0.88 : 1));

// A tree: round canopy + trunk on a transparent background.
writePng("tree.png", 32, 32, (x, y) => {
  if (Math.hypot(x - 15.5, y - 12) < 11) return [45, 122, 60, 255];
  if (x >= 13 && x <= 18 && y >= 20 && y <= 30) return [110, 72, 40, 255];
  return [0, 0, 0, 0];
});
```

Run it with `node my-art.mjs` from a folder where you copied `draw-png.mjs`
(or import it by absolute path). Keep code-drawn art simple and consistent;
tell the user it's placeholder-quality and can be swapped later by changing
the sprite's `image` (`updateObjectDefinition`) — the map itself doesn't change.
