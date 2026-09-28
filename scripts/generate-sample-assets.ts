/**
 * Generates examples/demo-world.krea: a small project (two 2D maps and a 3D island) whose images
 * (drawn procedurally, with transparency) are stored inside the archive,
 * with several sprites per object, collision shapes of every type, and code-built .glb models.
 * Run with `npm run gen:sample`. Never touches existing projects.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { strToU8, zipSync, type Zippable } from "fflate";
import { KREA_VERSION, type KreaProject, type Map2D, type MapObjectDefinition } from "../src/core/map-types";
import { applyOperation } from "../src/core/operation-dispatch";
import { validateProject } from "../src/core/map-validator";
import { projectToDisk } from "../src/core/project-codec";
import { addBox, addCone, addGableRoof, addSphere, builderToPrimitive, hexToLinear, newMeshBuilder, writeGlb } from "../src/shared/glb";

const OUT_FILE = path.resolve(import.meta.dirname, "..", "examples", "demo-world.krea");

type RGBA = [number, number, number, number];
const CLEAR: RGBA = [0, 0, 0, 0];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** Encodes an RGBA PNG whose pixels come from `pixel(x, y)`. */
function encodePng(width: number, height: number, pixel: (x: number, y: number) => RGBA): Uint8Array {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    for (let x = 0; x < width; x++) raw.set(pixel(x, y), row + 1 + x * 4);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const shade = ([r, g, b, a]: RGBA, f: number): RGBA => [Math.round(r * f), Math.round(g * f), Math.round(b * f), a];
const noise = (x: number, y: number) => ((x * 73856093) ^ (y * 19349663)) % 7;

const images: Record<string, Uint8Array> = {
  "assets/grass.png": encodePng(32, 32, (x, y) => shade([86, 158, 74, 255], noise(x, y) === 0 ? 0.85 : 1)),
  "assets/water.png": encodePng(32, 32, (x, y) => shade([64, 122, 196, 255], (x + y) % 8 < 2 ? 1.15 : 1)),
  "assets/path.png": encodePng(32, 32, (x, y) => shade([176, 146, 98, 255], noise(x, y) === 1 ? 0.9 : 1)),
  // Tree: round canopy + trunk on a transparent background.
  "assets/tree.png": encodePng(32, 32, (x, y) => {
    if (Math.hypot(x - 15.5, y - 12) < 11) return shade([45, 122, 60, 255], y < 10 ? 1.15 : 1);
    if (x >= 13 && x <= 18 && y >= 20 && y <= 30) return [110, 72, 40, 255];
    return CLEAR;
  }),
  "assets/tree-autumn.png": encodePng(32, 32, (x, y) => {
    if (Math.hypot(x - 15.5, y - 12) < 11) return shade([214, 120, 40, 255], y < 10 ? 1.15 : 1);
    if (x >= 13 && x <= 18 && y >= 20 && y <= 30) return [110, 72, 40, 255];
    return CLEAR;
  }),
  "assets/rock.png": encodePng(32, 32, (x, y) =>
    Math.hypot((x - 15.5) / 1.15, y - 17) < 10 ? shade([128, 128, 132, 255], y < 14 ? 1.2 : 1) : CLEAR,
  ),
  // House: 64x64 (2x2 tiles) with a triangular roof.
  "assets/house.png": encodePng(64, 64, (x, y) => {
    if (y >= 6 && y < 30 && Math.abs(x - 31.5) <= (y - 6) * 1.3) return [150, 55, 45, 255];
    if (y >= 30 && y < 62 && x >= 8 && x < 56) {
      if (x >= 27 && x < 37 && y >= 44) return [90, 60, 35, 255];
      return [196, 160, 110, 255];
    }
    return CLEAR;
  }),
};
// Tiling terrain textures for the 3D map.
const grain = (x: number, y: number, seed: number) => {
  const h = Math.imul(x * 374761393 + y * 668265263 + seed * 2147483647, 1274126177) >>> 0;
  return (h % 1000) / 1000;
};
images["assets/terrain-grass.png"] = encodePng(64, 64, (x, y) => shade([88, 140, 60, 255], 0.86 + grain(x, y, 1) * 0.22));
images["assets/terrain-rock.png"] = encodePng(64, 64, (x, y) => shade([122, 118, 110, 255], 0.8 + grain(x >> 1, y >> 1, 2) * 0.3 + ((x + y * 3) % 17 === 0 ? -0.2 : 0)));
images["assets/terrain-sand.png"] = encodePng(64, 64, (x, y) => shade([214, 194, 140, 255], 0.9 + grain(x, y, 3) * 0.14));
// A tuft of flowers for the 3D detail layer: stems + colored heads on a transparent background.
images["assets/flowers-tuft.png"] = encodePng(32, 32, (x, y) => {
  const heads: Array<[number, number, RGBA]> = [
    [8, 10, [240, 214, 70, 255]],
    [17, 6, [236, 236, 240, 255]],
    [25, 12, [214, 96, 170, 255]],
  ];
  for (const [hx, hy, color] of heads) {
    if (Math.hypot(x - hx, y - hy) < 3.2) return color;
    if (Math.abs(x - hx) < 1 && y > hy && y < 31) return [70, 128, 50, 255];
  }
  return CLEAR;
});
images["assets/terrain-snow.png"] = encodePng(64, 64, (x, y) => shade([236, 240, 245, 255], 0.94 + grain(x, y, 4) * 0.06));

// Low-poly 3D models, built from primitives.
const models: Record<string, Uint8Array> = {
  "assets/pine.glb": (() => {
    const trunk = newMeshBuilder();
    addCone(trunk, 0, 0, 0, 0.18, 1.2, 8, 0.14);
    const leaves = newMeshBuilder();
    addCone(leaves, 0, 0.9, 0, 1.1, 1.6, 10);
    addCone(leaves, 0, 1.8, 0, 0.85, 1.4, 10);
    addCone(leaves, 0, 2.6, 0, 0.55, 1.2, 10);
    return writeGlb([{ name: "pine", primitives: [builderToPrimitive(trunk, hexToLinear("#6b4a2b")), builderToPrimitive(leaves, hexToLinear("#2f6b3a"))] }]);
  })(),
  "assets/fish.glb": (() => {
    const body = newMeshBuilder();
    addSphere(body, 0, 0, 0, 0.2, 5, 8, 0.7);
    addSphere(body, -0.2, 0, 0, 0.13, 4, 7, 0.6);
    const fins = newMeshBuilder();
    addBox(fins, -0.4, 0, 0, 0.12, 0.26, 0.03);
    addBox(fins, 0.02, 0.14, 0, 0.14, 0.08, 0.02);
    return writeGlb([{ name: "fish", primitives: [builderToPrimitive(body, hexToLinear("#f08a24")), builderToPrimitive(fins, hexToLinear("#d8581a"))] }]);
  })(),
  "assets/boulder.glb": (() => {
    const rock = newMeshBuilder();
    addSphere(rock, 0, 0.35, 0, 0.7, 5, 8, 0.65);
    addSphere(rock, 0.45, 0.25, 0.2, 0.4, 4, 7, 0.7);
    return writeGlb([{ name: "boulder", primitives: [builderToPrimitive(rock, hexToLinear("#8a8680"))] }]);
  })(),
  "assets/cottage.glb": (() => {
    const walls = newMeshBuilder();
    addBox(walls, 0, 1.25, 0, 4, 2.5, 3);
    const roof = newMeshBuilder();
    addGableRoof(roof, 0, 2.5, 0, 4.4, 3.4, 1.6);
    const door = newMeshBuilder();
    addBox(door, 0, 0.8, 1.51, 0.9, 1.6, 0.04);
    return writeGlb([
      {
        name: "cottage",
        primitives: [
          builderToPrimitive(walls, hexToLinear("#d8c29a")),
          builderToPrimitive(roof, hexToLinear("#9a3b2e")),
          builderToPrimitive(door, hexToLinear("#5a3b22")),
        ],
      },
    ]);
  })(),
};

const objects: MapObjectDefinition[] = [
  { id: "grass", name: "Grass", kind: "2d", sprites: [{ id: "default", name: "Default", image: "assets/grass.png", collisions: [] }], defaultSpriteId: "default" },
  {
    id: "water",
    name: "Water",
    kind: "2d",
    description: "Not walkable.",
    sprites: [
      { id: "default", name: "Default", image: "assets/water.png", collisions: [{ id: "full", type: "rect", x: 16, y: 16, width: 32, height: 32, rotation: 0 }] },
    ],
    defaultSpriteId: "default",
  },
  { id: "path", name: "Path", kind: "2d", sprites: [{ id: "default", name: "Default", image: "assets/path.png", collisions: [] }], defaultSpriteId: "default" },
  {
    id: "tree",
    name: "Tree",
    kind: "2d",
    description: "Only the trunk blocks movement. On 3D maps it's shown as a billboard.",
    sprites: [
      { id: "summer", name: "Summer", image: "assets/tree.png", collisions: [{ id: "trunk", type: "rect", x: 16, y: 26, width: 6, height: 9, rotation: 0 }] },
      { id: "autumn", name: "Autumn", image: "assets/tree-autumn.png", collisions: [{ id: "trunk", type: "rect", x: 16, y: 26, width: 6, height: 9, rotation: 0 }] },
    ],
    defaultSpriteId: "summer",
  },
  {
    id: "rock",
    name: "Rock",
    kind: "2d",
    sprites: [{ id: "default", name: "Default", image: "assets/rock.png", collisions: [{ id: "body", type: "circle", x: 16, y: 17, radius: 10 }] }],
    defaultSpriteId: "default",
  },
  {
    id: "house",
    name: "House",
    kind: "2d",
    description: "2x2 building; the roof is a triangle collider, the walls a rectangle.",
    sizeInTiles: { width: 2, height: 2 },
    sprites: [
      {
        id: "default",
        name: "Default",
        image: "assets/house.png",
        collisions: [
          { id: "walls", type: "rect", x: 32, y: 46, width: 48, height: 32, rotation: 0 },
          { id: "roof", type: "triangle", x: 32, y: 21, rotation: 0, points: [{ x: 0, y: -15 }, { x: 31, y: 9 }, { x: -31, y: 9 }] },
        ],
      },
    ],
    defaultSpriteId: "default",
  },
];

function groundMap(id: string, name: string, width: number, height: number): Map2D {
  const mapping: Map2D["mapping"] = [];
  for (let x = 0; x < width; x++) for (let y = 0; y < height; y++) mapping.push({ objectId: "grass", layerId: "ground", x, y });
  return {
    kind: "2d",
    id,
    name,
    settings: { width, height, tileWidth: 32, tileHeight: 32 },
    layers: [
      { id: "ground", name: "Ground", visible: true, locked: false },
      { id: "decoration", name: "Decoration", visible: true, locked: false },
    ],
    mapping,
  };
}

function setGround(map: Map2D, x: number, y: number, objectId: string) {
  const inst = map.mapping.find((m) => m.layerId === "ground" && m.x === x && m.y === y);
  if (inst) inst.objectId = objectId;
}

const overworld = groundMap("overworld", "Overworld", 20, 15);
for (let x = 12; x < 18; x++) for (let y = 2; y < 5; y++) setGround(overworld, x, y, "water");
for (let x = 0; x < 20; x++) setGround(overworld, x, 9, "path");
overworld.mapping.push(
  { objectId: "tree", layerId: "decoration", x: 3, y: 4 },
  { objectId: "tree", layerId: "decoration", x: 5, y: 3, spriteId: "autumn" },
  { objectId: "tree", layerId: "decoration", x: 7, y: 5 },
  { objectId: "rock", layerId: "decoration", x: 9, y: 12 },
  { objectId: "house", layerId: "decoration", x: 14, y: 11 },
);

const village = groundMap("village", "Village", 12, 10);
for (let y = 0; y < 10; y++) setGround(village, 5, y, "path");
village.mapping.push(
  { objectId: "house", layerId: "decoration", x: 2, y: 2 },
  { objectId: "house", layerId: "decoration", x: 7, y: 2 },
  { objectId: "house", layerId: "decoration", x: 2, y: 6 },
  { objectId: "tree", layerId: "decoration", x: 9, y: 7, spriteId: "autumn" },
);

let project: KreaProject = { format: "krea", version: KREA_VERSION, name: "Demo World", objects, maps: [overworld, village] };

// The 3D island is built with the same JSON operations an AI agent sends to POST /api/agent/operations.
const operations: unknown[] = [
  { op: "addObjectDefinition", id: "pine", name: "Pine", kind: "3d", model: "assets/pine.glb", description: "3D tree." },
  { op: "addObjectDefinition", id: "boulder", name: "Boulder", kind: "3d", model: "assets/boulder.glb" },
  { op: "addObjectDefinition", id: "cottage", name: "Cottage", kind: "3d", model: "assets/cottage.glb", description: "4 x 3 m house." },
  { op: "addObjectDefinition", id: "spawn", name: "Player spawn", kind: "3d", description: "Invisible marker: where the player starts." },
  { op: "addObjectDefinition", id: "fish", name: "Fish", kind: "3d", model: "assets/fish.glb", description: "Swims in the sea and the mountain lake." },
  {
    op: "createMap",
    id: "island",
    name: "Island",
    kind: "3d",
    width: 128,
    depth: 128,
    resolution: 129,
    terrainLayers: [
      { id: "grass", name: "Grass", color: "#588c3c", texture: "assets/terrain-grass.png", tileSize: 4 },
      { id: "rock", name: "Rock", color: "#7a766e", texture: "assets/terrain-rock.png", tileSize: 6 },
      { id: "sand", name: "Sand", color: "#d6c28c", texture: "assets/terrain-sand.png", tileSize: 4 },
      { id: "snow", name: "Snow", color: "#eef2f5", texture: "assets/terrain-snow.png", tileSize: 6 },
    ],
  },
  { op: "generateTerrain", mapId: "island", seed: 7, amplitude: 26, featureSize: 48, octaves: 5, baseHeight: -2, island: true },
  // A flat plot for the village, at the ground's own height there, with soft edges.
  { op: "sculptTerrain", mapId: "island", mode: "flatten", x: 63, z: 77, radius: 14, strength: 1 },
  { op: "sculptTerrain", mapId: "island", mode: "flatten", x: 63, z: 77, radius: 14, strength: 1 },
  { op: "sculptTerrain", mapId: "island", mode: "smooth", x: 63, z: 77, radius: 18, strength: 0.6 },
  // A basin dug on the eastern hill, for a mountain lake far above the sea.
  { op: "sculptTerrain", mapId: "island", mode: "flatten", x: 81, z: 48, radius: 13, strength: 1, height: 14.5 },
  { op: "sculptTerrain", mapId: "island", mode: "flatten", x: 81, z: 48, radius: 13, strength: 1, height: 14.5 },
  { op: "sculptTerrain", mapId: "island", mode: "lower", x: 81, z: 48, radius: 8, strength: 4 },
  { op: "sculptTerrain", mapId: "island", mode: "smooth", x: 81, z: 48, radius: 14, strength: 0.5 },
  { op: "setWaterLevel", mapId: "island", level: 1 },
  {
    op: "autoPaintTerrain",
    mapId: "island",
    rules: [
      { layerId: "sand", maxHeight: 2.2 },
      { layerId: "snow", minHeight: 15 },
      { layerId: "rock", minSlope: 32 },
      { layerId: "grass" },
    ],
  },
  { op: "paintTerrain", mapId: "island", layerId: "sand", x: 55, z: 78, toX: 70, toZ: 78, radius: 1.8, strength: 0.9 },
  // Grass and flowers painted as density (Unity's "Paint Details"), off the path.
  { op: "addDetailLayer", mapId: "island", id: "grass-tufts", name: "Grass", color: "#6f9c3d", width: 0.45, height: 0.5, density: 12 },
  { op: "addDetailLayer", mapId: "island", id: "flowers", name: "Flowers", sprite: "assets/flowers-tuft.png", color: "#ffffff", width: 0.4, height: 0.4, density: 1.5, sizeVariation: 0.3 },
  { op: "autoPaintDetails", mapId: "island", layerId: "grass-tufts", onTerrainLayerId: "grass", maxSlope: 30, patchiness: 0.3, seed: 4 },
  { op: "autoPaintDetails", mapId: "island", layerId: "flowers", onTerrainLayerId: "grass", maxSlope: 20, patchiness: 0.8, patchSize: 10, seed: 9 },
  { op: "paintDetails", mapId: "island", layerId: "grass-tufts", x: 55, z: 78, toX: 70, toZ: 78, radius: 2, strength: 1, erase: true },
  { op: "paintDetails", mapId: "island", layerId: "flowers", x: 55, z: 78, toX: 70, toZ: 78, radius: 2, strength: 1, erase: true },
  { op: "addWaterBody", mapId: "island", id: "mountain-lake", name: "Mountain lake", x: 81, z: 48, fill: true },
  { op: "placeObject3D", mapId: "island", objectId: "cottage", layerId: "objects", x: 58, z: 74, rotation: 0, id: "cottage-1" },
  { op: "placeObject3D", mapId: "island", objectId: "cottage", layerId: "objects", x: 68, z: 75, rotation: -20, id: "cottage-2" },
  { op: "placeObject3D", mapId: "island", objectId: "spawn", layerId: "objects", x: 63, z: 82, id: "player-spawn" },
  { op: "scatterObjects3D", mapId: "island", objectId: "pine", layerId: "objects", count: 70, seed: 3, onTerrainLayerId: "grass", maxSlope: 28, minDistance: 3, scaleMin: 0.8, scaleMax: 1.3 },
  { op: "scatterObjects3D", mapId: "island", objectId: "fish", layerId: "objects", count: 6, seed: 11, water: "only", floatInWater: true, area: { x: 71, z: 38, width: 20, depth: 20 }, scaleMin: 1, scaleMax: 1.4 },
  { op: "scatterObjects3D", mapId: "island", objectId: "fish", layerId: "objects", count: 30, seed: 12, water: "only", floatInWater: true, minDistance: 2, area: { x: 8, z: 8, width: 112, depth: 112 }, scaleMin: 1.2, scaleMax: 2 },
  { op: "scatterObjects3D", mapId: "island", objectId: "boulder", layerId: "objects", count: 18, seed: 5, onTerrainLayerId: "rock", minDistance: 4, scaleMin: 0.7, scaleMax: 1.8 },
  { op: "scatterObjects3D", mapId: "island", objectId: "tree", spriteId: "autumn", layerId: "objects", count: 6, seed: 9, area: { x: 50, z: 84, width: 28, depth: 14 }, onTerrainLayerId: "grass", minDistance: 3, scaleMin: 2.5, scaleMax: 3 },
];
for (const [i, op] of operations.entries()) {
  const outcome = applyOperation(project, op);
  if (!outcome.applied) throw new Error(`Operation #${i} not applied: ${outcome.detail}`);
  project = outcome.project;
}

const result = validateProject(project);
if (!result.valid) throw new Error(`Generated project is invalid: ${result.issues.map((i) => i.message).join("; ")}`);

const disk = projectToDisk(project);
const entries: Zippable = { "project.json": [strToU8(JSON.stringify(disk.json, null, 2)), { level: 6 }] };
for (const [key, data] of disk.files) entries[key] = [data, { level: 6 }];
for (const [key, data] of Object.entries(images)) entries[key] = [data, { level: 0 }];
for (const [key, data] of Object.entries(models)) entries[key] = [data, { level: 6 }];

fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
fs.writeFileSync(OUT_FILE, zipSync(entries));
console.log(`Demo project written to ${OUT_FILE}`);
