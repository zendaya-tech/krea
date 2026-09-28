import fs from "node:fs/promises";
import path from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from "fflate";
import type { KreaProject } from "@core/map-types";
import { isKreaProjectShape, validateProject, type ValidationIssue } from "@core/map-validator";
import { LEGACY_MAP_FILE, isLegacyMapV1, migrateLegacyMap } from "@core/project-migration";
import { isTerrainFile, projectFromDisk, projectToDisk } from "@core/project-codec";
import { ProjectError, type ProjectLocation } from "./project-service";

/**
 * The .krea file is a single binary archive (zip) holding everything:
 *
 *   project.json             the project (catalog, sprites, collisions, all maps)
 *   assets/<file>            every image and 3D model (.glb) the project uses
 *   maps/<mapId>/heights.f32 3D maps only: the terrain heightmap (float32, little-endian)
 *   maps/<mapId>/splat.rgba  3D maps only: the terrain paint weights (4 bytes per sample)
 *
 * Sprite `image`, object `model` and terrain layer `texture` paths
 * ("assets/tree.png") are keys inside the archive.
 */
const PROJECT_ENTRY = "project.json";
export const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);
export const MODEL_EXTENSIONS = new Set([".glb"]);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_MODEL_BYTES = 50 * 1024 * 1024;

export interface LoadedProject {
  project: KreaProject;
  assets: Map<string, Uint8Array>;
  issues: ValidationIssue[];
  /** "map.json" when converted from a legacy folder project that hasn't been saved as .krea yet. */
  migratedFrom: string | null;
}

function isImagePath(p: string): boolean {
  return IMAGE_EXTENSIONS.has(path.extname(p).toLowerCase());
}

export function isAssetPath(p: string): boolean {
  const ext = path.extname(p).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext) || MODEL_EXTENSIONS.has(ext);
}

/** Normalizes an archive asset key and rejects anything that could escape the archive namespace. */
export function normalizeAssetKey(key: string): string | null {
  const normalized = key.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").some((part) => part === ".." || part === "")) return null;
  return normalized;
}

export async function loadProject(location: ProjectLocation): Promise<LoadedProject> {
  const { project, assets, migratedFrom } = location.legacyRoot
    ? await readLegacyFolder(location.legacyRoot)
    : await readKreaArchive(location.file);
  const structural = validateProject(project);
  return { project, assets, migratedFrom, issues: [...structural.issues, ...checkAssetsPresent(project, assets)] };
}

/** Decodes a disk-form project.json (terrain data read via `readFile`) and checks it's project-shaped. */
function decodeDiskProject(parsed: unknown, readFile: (key: string) => Uint8Array | undefined, where: string): KreaProject {
  const decoded = projectFromDisk(parsed, readFile);
  if (!isKreaProjectShape(decoded)) {
    const issues = validateProject(decoded).issues;
    throw new ProjectError(`${where} does not contain a valid project: ${issues.map((i) => i.message).join("; ")}`, 400);
  }
  return decoded;
}

async function readKreaArchive(file: string): Promise<{ project: KreaProject; assets: Map<string, Uint8Array>; migratedFrom: null }> {
  let bytes: Uint8Array;
  try {
    bytes = await fs.readFile(file);
  } catch {
    throw new ProjectError(`Cannot read "${file}".`, 404);
  }

  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch {
    throw new ProjectError(`"${file}" is not a valid .krea archive.`, 400);
  }

  const projectBytes = entries[PROJECT_ENTRY];
  if (!projectBytes) throw new ProjectError(`"${file}" has no ${PROJECT_ENTRY} inside.`, 400);

  let parsed: unknown;
  try {
    parsed = JSON.parse(strFromU8(projectBytes));
  } catch (e) {
    throw new ProjectError(`${PROJECT_ENTRY} inside "${file}" is not valid JSON: ${(e as Error).message}`, 400);
  }
  const project = decodeDiskProject(parsed, (key) => entries[key], `"${file}"`);

  const assets = new Map<string, Uint8Array>();
  for (const [key, data] of Object.entries(entries)) {
    if (key === PROJECT_ENTRY || key.endsWith("/") || isTerrainFile(key)) continue;
    const normalized = normalizeAssetKey(key);
    if (normalized && isAssetPath(normalized)) assets.set(normalized, data);
  }
  return { project, assets, migratedFrom: null };
}

/** Reads a legacy folder project (map.json + loose image files) into memory as a .krea project. */
async function readLegacyFolder(root: string): Promise<{ project: KreaProject; assets: Map<string, Uint8Array>; migratedFrom: string }> {
  const mapFile = path.join(root, LEGACY_MAP_FILE);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(mapFile, "utf-8"));
  } catch (e) {
    throw new ProjectError(`Cannot read legacy "${mapFile}": ${(e as Error).message}`, 400);
  }
  if (!isLegacyMapV1(parsed)) throw new ProjectError(`"${mapFile}" is not a recognizable legacy map.`, 400);
  const project = migrateLegacyMap(parsed);

  const assets = new Map<string, Uint8Array>();
  const wanted = new Set<string>();
  for (const obj of project.objects) for (const s of obj.sprites) wanted.add(s.image);
  const assetsDir = path.join(root, "assets");
  for (const name of await fs.readdir(assetsDir).catch(() => [] as string[])) {
    if (isImagePath(name)) wanted.add(`assets/${name}`);
  }
  for (const key of wanted) {
    const normalized = normalizeAssetKey(key);
    if (!normalized) continue;
    const data = await fs.readFile(path.join(root, normalized)).catch(() => null);
    if (data) assets.set(normalized, data);
  }
  return { project, assets, migratedFrom: LEGACY_MAP_FILE };
}

/** Every asset path the project references, with who uses it. */
export function referencedAssets(project: KreaProject): Array<{ path: string; usedBy: string; where: string }> {
  const refs: Array<{ path: string; usedBy: string; where: string }> = [];
  project.objects.forEach((obj, oi) => {
    obj.sprites?.forEach((sprite, si) => refs.push({ path: sprite.image, usedBy: `${obj.id}/${sprite.id}`, where: `objects[${oi}].sprites[${si}].image` }));
    if (obj.model) refs.push({ path: obj.model, usedBy: obj.id, where: `objects[${oi}].model` });
  });
  project.maps.forEach((map, mi) => {
    if (map.kind !== "3d") return;
    map.terrain.layers?.forEach((layer, li) => {
      if (layer.texture) refs.push({ path: layer.texture, usedBy: `${map.id}/terrain/${layer.id}`, where: `maps[${mi}].terrain.layers[${li}].texture` });
    });
    map.terrain.detailLayers?.forEach((layer, li) => {
      const where = `maps[${mi}].terrain.detailLayers[${li}]`;
      if (layer.sprite) refs.push({ path: layer.sprite, usedBy: `${map.id}/details/${layer.id}`, where: `${where}.sprite` });
      if (layer.model) refs.push({ path: layer.model, usedBy: `${map.id}/details/${layer.id}`, where: `${where}.model` });
    });
  });
  return refs;
}

/** Every image and model the project references must be present inside the archive. */
export function checkAssetsPresent(project: KreaProject, assets: Map<string, Uint8Array>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const ref of referencedAssets(project)) {
    const key = normalizeAssetKey(ref.path ?? "");
    if (!key || !assets.has(key)) {
      issues.push({ severity: "error", message: `"${ref.usedBy}": file "${ref.path}" is not in the project.`, path: ref.where });
    }
  }
  return issues;
}

/**
 * Validates and writes the whole project (JSON + terrain data + every asset)
 * as one .krea archive. Returns blocking issues; an empty array means the
 * write succeeded. Writes to a temp file and renames it, so a crash
 * mid-write can never corrupt the only copy of the project.
 */
export async function writeKreaArchive(file: string, project: KreaProject, assets: Map<string, Uint8Array>): Promise<ValidationIssue[]> {
  const structural = validateProject(project);
  const missing = checkAssetsPresent(project, assets);
  if (!structural.valid || missing.length > 0) return [...structural.issues, ...missing];

  const disk = projectToDisk(project);
  const entries: Zippable = { [PROJECT_ENTRY]: [strToU8(JSON.stringify(disk.json, null, 2)), { level: 6 }] };
  for (const [key, data] of disk.files) entries[key] = [data, { level: 6 }];
  for (const [key, data] of assets) {
    // Images are already compressed; storing them avoids wasted CPU for no size gain.
    entries[key] = [data, { level: isImagePath(key) ? 0 : 6 }];
  }
  const bytes = zipSync(entries);

  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(tmp, bytes);
    await fs.rename(tmp, file);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
  return [];
}

async function exists(p: string): Promise<boolean> {
  return fs
    .stat(p)
    .then(() => true)
    .catch(() => false);
}

/**
 * Writes a project as an unpacked folder — the same layout as inside the
 * archive (project.json + assets/… + maps/<id>/…) — e.g. to inspect it,
 * version it with Git, or let a tool edit plain files before packing it back.
 */
export async function unpackToFolder(
  destination: string,
  project: KreaProject,
  assets: Map<string, Uint8Array>,
  overwrite: boolean,
): Promise<{ folder: string; files: string[] }> {
  const folder = path.resolve(destination.trim());
  const projectFile = path.join(folder, PROJECT_ENTRY);
  if (!overwrite && (await exists(projectFile))) {
    throw new ProjectError(`"${projectFile}" already exists — pass overwrite to replace it.`, 409);
  }
  const disk = projectToDisk(project);
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(projectFile, JSON.stringify(disk.json, null, 2), "utf-8");
  const files = [PROJECT_ENTRY];
  for (const [key, data] of [...disk.files, ...assets]) {
    const target = path.join(folder, key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, data);
    files.push(key);
  }
  return { folder, files };
}

async function listFilesRecursive(dir: string, prefix: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: string[] = [];
  for (const e of entries) {
    const rel = `${prefix}/${e.name}`;
    if (e.isDirectory()) out.push(...(await listFilesRecursive(path.join(dir, e.name), rel)));
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

/** Reads an unpacked project folder (project.json + assets/… + maps/…) back into memory. */
export async function readUnpackedFolder(source: string): Promise<{ project: KreaProject; assets: Map<string, Uint8Array> }> {
  const folder = path.resolve(source.trim());
  const projectFile = path.join(folder, PROJECT_ENTRY);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(projectFile, "utf-8"));
  } catch (e) {
    throw new ProjectError(`Cannot read "${projectFile}": ${(e as Error).message}`, 400);
  }
  const terrainFiles = new Map<string, Uint8Array>();
  for (const key of await listFilesRecursive(path.join(folder, "maps"), "maps")) {
    if (isTerrainFile(key)) terrainFiles.set(key, await fs.readFile(path.join(folder, key)));
  }
  const project = decodeDiskProject(parsed, (key) => terrainFiles.get(key), `"${projectFile}"`);
  const assets = new Map<string, Uint8Array>();
  for (const key of await listFilesRecursive(path.join(folder, "assets"), "assets")) {
    const normalized = normalizeAssetKey(key);
    if (normalized && isAssetPath(normalized)) assets.set(normalized, await fs.readFile(path.join(folder, normalized)));
  }
  return { project, assets };
}

/** Where a pack goes: ".krea" is appended if missing; an existing file is only replaced with `overwrite`. */
export async function resolvePackTarget(destination: string, overwrite: boolean): Promise<string> {
  let file = path.resolve(destination.trim());
  if (path.extname(file).toLowerCase() !== ".krea") file += ".krea";
  if (!overwrite && (await exists(file))) throw new ProjectError(`"${file}" already exists — pass overwrite to replace it.`, 409);
  return file;
}

/** Images and models of the archive, sorted. */
export function listAssets(assets: Map<string, Uint8Array>): string[] {
  return [...assets.keys()].filter(isAssetPath).sort();
}

/** Adds an image or a .glb model to an in-memory asset store under assets/, deduping the filename. Returns its key. */
export function addAsset(assets: Map<string, Uint8Array>, originalName: string, data: Uint8Array): string {
  const ext = path.extname(originalName).toLowerCase();
  const isModel = MODEL_EXTENSIONS.has(ext);
  if (!IMAGE_EXTENSIONS.has(ext) && !isModel) {
    throw new ProjectError(`Unsupported file type: "${originalName}" (images: png, jpg, gif, webp, bmp; 3D models: glb).`, 415);
  }
  const limit = isModel ? MAX_MODEL_BYTES : MAX_IMAGE_BYTES;
  if (data.byteLength === 0 || data.byteLength > limit) {
    throw new ProjectError(`"${originalName}" is empty or exceeds the ${limit / 1024 / 1024}MB limit.`, 400);
  }
  if (isModel && (data.byteLength < 12 || new DataView(data.buffer, data.byteOffset).getUint32(0, true) !== 0x46546c67)) {
    throw new ProjectError(`"${originalName}" is not a binary glTF (.glb) file.`, 400);
  }

  const base =
    path
      .basename(originalName, path.extname(originalName))
      .replace(/[^a-zA-Z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || (isModel ? "model" : "image");
  let key = `assets/${base}${ext}`;
  let suffix = 1;
  while (assets.has(key)) {
    key = `assets/${base}-${suffix}${ext}`;
    suffix += 1;
  }
  assets.set(key, data);
  return key;
}

export const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".glb": "model/gltf-binary",
};
