import fs from "node:fs/promises";
import path from "node:path";
import { DEFAULT_PROJECT_FILE, KREA_EXTENSION } from "@core/map-types";
import { LEGACY_MAP_FILE } from "@core/project-migration";

export class ProjectError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/** Where a project lives on disk. */
export interface ProjectLocation {
  /** The .krea archive the project is saved to (may not exist yet for a new or migrated project). */
  file: string;
  /** Folder of a legacy map.json project to migrate from, when the .krea doesn't exist yet. */
  legacyRoot: string | null;
}

/** The editor's open project: where it saves, plus its images, held in memory until Save. */
export interface ProjectSession {
  location: ProjectLocation;
  assets: Map<string, Uint8Array>;
}

let session: ProjectSession | null = null;

async function exists(p: string): Promise<boolean> {
  return fs
    .stat(p)
    .then(() => true)
    .catch(() => false);
}

/**
 * Accepts a .krea file, a project folder (containing project.krea or a
 * single *.krea), or a legacy map.json / its folder — which is migrated on
 * read and saved as project.krea next to it on first save.
 */
export async function resolveProjectLocation(rawPath: string): Promise<ProjectLocation> {
  const resolved = path.resolve(rawPath);
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat) throw new ProjectError(`Path not found: "${rawPath}".`, 404);

  if (stat.isFile()) {
    if (path.extname(resolved).toLowerCase() === KREA_EXTENSION) return { file: resolved, legacyRoot: null };
    if (path.basename(resolved).toLowerCase() === LEGACY_MAP_FILE) return legacyLocation(path.dirname(resolved));
    throw new ProjectError(`"${rawPath}" is not a ${KREA_EXTENSION} project file.`, 400);
  }

  const entries = await fs.readdir(resolved).catch(() => [] as string[]);
  const kreaFiles = entries.filter((e) => path.extname(e).toLowerCase() === KREA_EXTENSION);
  if (kreaFiles.includes(DEFAULT_PROJECT_FILE)) return { file: path.join(resolved, DEFAULT_PROJECT_FILE), legacyRoot: null };
  if (kreaFiles.length === 1) return { file: path.join(resolved, kreaFiles[0]), legacyRoot: null };
  if (kreaFiles.length > 1) {
    throw new ProjectError(`"${resolved}" contains several ${KREA_EXTENSION} files (${kreaFiles.join(", ")}) — open one of them directly.`, 409);
  }
  if (entries.includes(LEGACY_MAP_FILE)) return legacyLocation(resolved);
  throw new ProjectError(`No ${KREA_EXTENSION} project (or legacy ${LEGACY_MAP_FILE}) found in "${resolved}".`, 404);
}

async function legacyLocation(root: string): Promise<ProjectLocation> {
  const target = path.join(root, DEFAULT_PROJECT_FILE);
  // Already migrated once: open the .krea rather than risk overwriting it with a fresh migration.
  if (await exists(target)) return { file: target, legacyRoot: null };
  return { file: target, legacyRoot: root };
}

/**
 * Validates a path for a brand-new project file: appends ".krea" if missing,
 * refuses to overwrite an existing file, and creates missing parent folders.
 */
export async function prepareNewProjectFile(rawPath: string): Promise<ProjectLocation> {
  let resolved = path.resolve(rawPath.trim());
  if (path.extname(resolved).toLowerCase() !== KREA_EXTENSION) resolved += KREA_EXTENSION;
  if (await exists(resolved)) {
    throw new ProjectError(`"${resolved}" already exists — open it instead of creating a new project there.`, 409);
  }
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  return { file: resolved, legacyRoot: null };
}

export function startSession(location: ProjectLocation, assets: Map<string, Uint8Array>): ProjectSession {
  session = { location, assets };
  return session;
}

export function getSession(): ProjectSession {
  if (!session) throw new ProjectError("No project is open.", 404);
  return session;
}

export function projectInfo(location: ProjectLocation): { file: string; name: string } {
  return { file: location.file, name: path.basename(location.file, path.extname(location.file)) };
}
