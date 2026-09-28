import {
  FOOTPRINT_PX_PER_TILE,
  type CollisionShape,
  type EditorCamera,
  type KreaProject,
  type Map2D,
  type Map3D,
  type MapDocument,
  type MapObjectDefinition,
  type MapObjectInstance,
  type MapSettings,
  type SpriteDefinition,
} from "./map-types";

/** Grid -> pixel conversion, centralized so a future "free" (pixel) placement mode
 * only needs to change instance storage, not every call site. */
export function gridToPixel(x: number, y: number, settings: MapSettings): { px: number; py: number } {
  return { px: x * settings.tileWidth, py: y * settings.tileHeight };
}

export function pixelToGrid(px: number, py: number, settings: MapSettings): { x: number; y: number } {
  return {
    x: Math.floor(px / settings.tileWidth),
    y: Math.floor(py / settings.tileHeight),
  };
}

export function cellKey(layerId: string, x: number, y: number): string {
  return `${layerId}:${x}:${y}`;
}

export function isInBounds(x: number, y: number, settings: MapSettings): boolean {
  return x >= 0 && y >= 0 && x < settings.width && y < settings.height;
}

export interface TileSize {
  width: number;
  height: number;
}

/** An object's footprint in grid cells. Defaults to 1x1 when unset or the definition is unknown. */
export function getObjectSize(def: MapObjectDefinition | undefined): TileSize {
  const size = def?.sizeInTiles;
  if (size && Number.isInteger(size.width) && Number.isInteger(size.height) && size.width > 0 && size.height > 0) {
    return size;
  }
  return { width: 1, height: 1 };
}

/** The sprite an instance shows: its own `spriteId` if valid, else the object's default; undefined for sprite-less objects. */
export function getSprite(def: MapObjectDefinition | undefined, spriteId?: string): SpriteDefinition | undefined {
  if (!def || def.sprites.length === 0) return undefined;
  return (
    (spriteId ? def.sprites.find((s) => s.id === spriteId) : undefined) ??
    def.sprites.find((s) => s.id === def.defaultSpriteId) ??
    def.sprites[0]
  );
}

/** Pixel size of a sprite-less object's collision space (its footprint at FOOTPRINT_PX_PER_TILE). */
export function footprintSpace(def: MapObjectDefinition | undefined): TileSize {
  const size = getObjectSize(def);
  return { width: size.width * FOOTPRINT_PX_PER_TILE, height: size.height * FOOTPRINT_PX_PER_TILE };
}

/**
 * The collision shapes that apply to an instance, and the pixel space they're
 * authored in: the shown sprite's shapes in its image space (size known only
 * once the image is decoded — pass it in), or, for a sprite-less object, its
 * object-level shapes in footprint space.
 */
export function instanceCollisions(
  def: MapObjectDefinition | undefined,
  sprite: SpriteDefinition | undefined,
  spriteImageSize: TileSize | null,
): { shapes: CollisionShape[]; space: TileSize } | null {
  if (!def) return null;
  if (sprite) return spriteImageSize ? { shapes: sprite.collisions, space: spriteImageSize } : null;
  return { shapes: def.collisions ?? [], space: footprintSpace(def) };
}

/** Every grid cell an instance occupies, given its origin (top-left) and footprint. */
export function footprintCells(x: number, y: number, size: TileSize): Array<{ x: number; y: number }> {
  const cells: Array<{ x: number; y: number }> = [];
  for (let dy = 0; dy < size.height; dy++) {
    for (let dx = 0; dx < size.width; dx++) {
      cells.push({ x: x + dx, y: y + dy });
    }
  }
  return cells;
}

/** Whether an object's entire footprint, placed with origin (x, y), fits on the map. */
export function isFootprintInBounds(x: number, y: number, size: TileSize, settings: MapSettings): boolean {
  return x >= 0 && y >= 0 && x + size.width <= settings.width && y + size.height <= settings.height;
}

/**
 * Builds a lookup index of mapping instances keyed by "layerId:x:y" for O(1)
 * access. Multi-cell objects are registered at every cell of their
 * footprint, all pointing back to the same instance — callers read
 * `instance.x`/`instance.y` to recover its true origin regardless of which
 * footprint cell they looked up.
 */
export function buildCellIndex(mapping: MapObjectInstance[], objects: MapObjectDefinition[]): Map<string, MapObjectInstance> {
  const sizes = new Map(objects.map((o) => [o.id, getObjectSize(o)]));
  const index = new Map<string, MapObjectInstance>();
  for (const inst of mapping) {
    const size = sizes.get(inst.objectId) ?? { width: 1, height: 1 };
    for (const cell of footprintCells(inst.x, inst.y, size)) {
      index.set(cellKey(inst.layerId, cell.x, cell.y), inst);
    }
  }
  return index;
}

export function getMap(project: KreaProject, mapId: string): MapDocument | undefined {
  return project.maps.find((m) => m.id === mapId);
}

export function get2DMap(project: KreaProject, mapId: string): Map2D | undefined {
  const map = getMap(project, mapId);
  return map?.kind === "2d" ? map : undefined;
}

export function get3DMap(project: KreaProject, mapId: string): Map3D | undefined {
  const map = getMap(project, mapId);
  return map?.kind === "3d" ? map : undefined;
}

/** Whether an object can be placed on a map of this kind: 2D maps take 2D objects; 3D maps take both (2D ones as billboards). */
export function isObjectAllowedOnMap(def: MapObjectDefinition, mapKind: MapDocument["kind"]): boolean {
  return mapKind === "3d" || def.kind !== "3d";
}

export function replaceMap(project: KreaProject, map: MapDocument): KreaProject {
  return { ...project, maps: project.maps.map((m) => (m.id === map.id ? map : m)) };
}

export function screenToWorld(
  screenX: number,
  screenY: number,
  camera: EditorCamera,
): { worldX: number; worldY: number } {
  return {
    worldX: screenX / camera.zoom + camera.x,
    worldY: screenY / camera.zoom + camera.y,
  };
}

export function worldToScreen(
  worldX: number,
  worldY: number,
  camera: EditorCamera,
): { screenX: number; screenY: number } {
  return {
    screenX: (worldX - camera.x) * camera.zoom,
    screenY: (worldY - camera.y) * camera.zoom,
  };
}

let idCounter = 0;
export function generateId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

export function slugifyId(input: string): string {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || generateId("id");
}

/** A readable id derived from `seed`, suffixed until it doesn't collide with `existing`. */
export function uniqueId(existing: Iterable<string>, seed: string): string {
  const taken = new Set(existing);
  const base = slugifyId(seed);
  let id = base;
  let suffix = 1;
  while (taken.has(id)) {
    id = `${base}-${suffix}`;
    suffix += 1;
  }
  return id;
}
