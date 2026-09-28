import { KREA_VERSION, type KreaProject, type Map2D, type Map3D, type TerrainInfo } from "./map-types";
import { migrateV2Json } from "./project-migration";
import { SPLAT_CHANNELS } from "./terrain";

/**
 * In memory, 3D terrains hold typed arrays (Float32Array heights, Uint8Array
 * splat). JSON can't carry those, so a project has two serialized forms:
 *
 * - wire (HTTP API): terrain arrays inlined as base64 — `heightsBase64`
 *   (little-endian float32) and `splatBase64` (RGBA bytes). Agents may also
 *   send plain number arrays as `heights` / `splat`.
 * - disk (.krea archive / unpacked folder): project.json references one
 *   folder per 3D map holding raw binary files —
 *     maps/<mapId>/heights.f32   resolution² little-endian float32, row-major
 *     maps/<mapId>/splat.rgba    resolution² × 4 bytes (one channel per terrain layer)
 *     maps/<mapId>/details.rgba  resolution² × 4 bytes (painted grass density, one channel per detail layer)
 *
 * Decoding is lenient: malformed or missing terrain data decodes to empty
 * arrays, which validateProject() then reports as errors.
 */

export interface TerrainJson extends TerrainInfo {
  heightsBase64?: string;
  splatBase64?: string;
  heights?: number[];
  splat?: number[];
  heightsFile?: string;
  splatFile?: string;
  detailsBase64?: string;
  details?: number[];
  detailsFile?: string;
}

export type Map3DJson = Omit<Map3D, "terrain"> & { terrain: TerrainJson };
export type MapDocumentJson = Map2D | Map3DJson;
export type KreaProjectJson = Omit<KreaProject, "maps"> & { maps: MapDocumentJson[] };

export function terrainFolder(mapId: string): string {
  return `maps/${mapId}`;
}

export function terrainFiles(mapId: string): { heights: string; splat: string; details: string } {
  const dir = terrainFolder(mapId);
  return { heights: `${dir}/heights.f32`, splat: `${dir}/splat.rgba`, details: `${dir}/details.rgba` };
}

/** Whether an archive entry is 3D terrain data (as opposed to an asset). */
export function isTerrainFile(key: string): boolean {
  return /^maps\/[^/]+\/(heights\.f32|splat\.rgba|details\.rgba)$/.test(key);
}

// ---- base64 (works in browsers and Node) ----

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  try {
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return new Uint8Array(0);
  }
}

export function floatsToBytes(values: Float32Array): Uint8Array {
  return new Uint8Array(values.buffer.slice(values.byteOffset, values.byteOffset + values.byteLength));
}

export function bytesToFloats(bytes: Uint8Array): Float32Array {
  if (bytes.byteLength % 4 !== 0) return new Float32Array(0);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Float32Array(copy.buffer);
}

// ---- encode ----

function terrainInfo(map: Map3D): TerrainInfo {
  const { resolution, size, layers, waterLevel, detailLayers } = map.terrain;
  return { resolution, size, layers, waterLevel, detailLayers };
}

export function projectToWire(project: KreaProject): KreaProjectJson {
  return {
    ...project,
    maps: project.maps.map((map) =>
      map.kind === "3d"
        ? {
            ...map,
            terrain: {
              ...terrainInfo(map),
              heightsBase64: bytesToBase64(floatsToBytes(map.terrain.heights)),
              splatBase64: bytesToBase64(map.terrain.splat),
              detailsBase64: bytesToBase64(map.terrain.details),
            },
          }
        : map,
    ),
  };
}

/** The project.json of an archive, plus the terrain files that go next to it. */
export function projectToDisk(project: KreaProject): { json: KreaProjectJson; files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  const maps = project.maps.map((map): MapDocumentJson => {
    if (map.kind !== "3d") return map;
    const paths = terrainFiles(map.id);
    files.set(paths.heights, floatsToBytes(map.terrain.heights));
    files.set(paths.splat, map.terrain.splat.slice());
    files.set(paths.details, map.terrain.details.slice());
    return { ...map, terrain: { ...terrainInfo(map), heightsFile: paths.heights, splatFile: paths.splat, detailsFile: paths.details } };
  });
  return { json: { ...project, maps }, files };
}

// ---- decode ----

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

function decodeTerrain(terrain: Record<string, unknown>, readFile?: (key: string) => Uint8Array | undefined): Map3D["terrain"] {
  const { heightsBase64, splatBase64, heightsFile, splatFile, heights, splat, detailsBase64, detailsFile, details, ...info } = terrain;
  let h: Float32Array = new Float32Array(0);
  let s: Uint8Array = new Uint8Array(0);
  if (heights instanceof Float32Array) h = heights;
  else if (Array.isArray(heights)) h = Float32Array.from(heights.map(Number));
  else if (typeof heightsBase64 === "string") h = bytesToFloats(base64ToBytes(heightsBase64));
  else if (typeof heightsFile === "string" && readFile) h = bytesToFloats(readFile(heightsFile) ?? new Uint8Array(0));

  if (splat instanceof Uint8Array) s = splat;
  else if (Array.isArray(splat)) s = Uint8Array.from(splat.map(Number));
  else if (typeof splatBase64 === "string") s = base64ToBytes(splatBase64);
  else if (typeof splatFile === "string" && readFile) s = (readFile(splatFile) ?? new Uint8Array(0)).slice();
  else if (h.length > 0 && splat === undefined) {
    // No splat given: everything painted with the first layer.
    s = new Uint8Array(h.length * SPLAT_CHANNELS);
    for (let i = 0; i < h.length; i++) s[i * SPLAT_CHANNELS] = 255;
  }
  let d: Uint8Array = new Uint8Array(0);
  if (details instanceof Uint8Array) d = details;
  else if (Array.isArray(details)) d = Uint8Array.from(details.map(Number));
  else if (typeof detailsBase64 === "string") d = base64ToBytes(detailsBase64);
  else if (typeof detailsFile === "string" && readFile) d = (readFile(detailsFile) ?? new Uint8Array(0)).slice();
  // Projects from before detail layers: no grass painted anywhere.
  if (d.length === 0 && h.length > 0 && details === undefined) d = new Uint8Array(h.length * SPLAT_CHANNELS);
  const terrainInfo = info as unknown as TerrainInfo;
  return { ...terrainInfo, detailLayers: terrainInfo.detailLayers ?? [], heights: h, splat: s, details: d };
}

function decodeProject(input: unknown, readFile?: (key: string) => Uint8Array | undefined): unknown {
  if (!isObj(input)) return input;
  const migrated = migrateV2Json(input);
  if (!Array.isArray(migrated.maps)) return migrated;
  return {
    ...migrated,
    maps: migrated.maps.map((map) =>
      isObj(map) && map.kind === "3d" && isObj(map.terrain)
        ? { ...map, waters: map.waters ?? [], terrain: decodeTerrain(map.terrain, readFile) }
        : map,
    ),
  };
}

/** Parses a project received over HTTP (wire form, or an older version). Still needs validateProject(). */
export function projectFromWire(input: unknown): unknown {
  return decodeProject(input);
}

/** Parses an archive's project.json, reading terrain files through `readFile`. Still needs validateProject(). */
export function projectFromDisk(input: unknown, readFile: (key: string) => Uint8Array | undefined): unknown {
  return decodeProject(input, readFile);
}

/** Map-level variants, for routes that send or receive a single map. */
export function mapToWire(map: KreaProject["maps"][number]): MapDocumentJson {
  return projectToWire({ format: "krea", version: KREA_VERSION, name: "", objects: [], maps: [map] }).maps[0];
}
