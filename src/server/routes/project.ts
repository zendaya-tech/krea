import { Hono } from "hono";
import path from "node:path";
import type { KreaProject } from "@core/map-types";
import { projectFromWire, projectToWire } from "@core/project-codec";
import {
  getSession,
  ProjectError,
  prepareNewProjectFile,
  projectInfo,
  resolveProjectLocation,
  startSession,
} from "../services/project-service";
import { addAsset, listAssets, loadProject, unpackToFolder, writeKreaArchive } from "../services/project-file-service";
import { projectFromNewBody } from "../lib/new-project";
import { exportMap } from "../services/export-service";
import { errorResponse } from "../lib/http-errors";
import type {
  ExportResponse,
  ImportAssetResponse,
  NewProjectResponse,
  OpenProjectResponse,
  ProjectAssetsResponse,
  SaveProjectResponse,
} from "@shared/api-types";

/**
 * Editor-session routes: they act on the project the running editor has
 * open. Its images live in server memory (the session) until Save writes the
 * whole .krea archive; the project JSON itself is owned by the client.
 */
export const projectRoutes = new Hono();

function sessionForRequest(expectedPath: string | undefined) {
  const session = getSession();
  if (expectedPath && path.resolve(expectedPath).toLowerCase() !== path.resolve(session.location.file).toLowerCase()) {
    throw new ProjectError("Another project is active in this server. Reopen this project before saving or importing assets.", 409);
  }
  return session;
}

/** The client sends projects in wire form (3D terrain arrays as base64). */
function wireProject(input: unknown): KreaProject {
  return projectFromWire(input) as KreaProject;
}

projectRoutes.get("/", (c) => {
  try {
    return c.json(projectInfo(getSession().location));
  } catch (e) {
    return errorResponse(c, e);
  }
});

projectRoutes.post("/open", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.path !== "string" || !body.path.trim()) return c.json({ error: 'Missing "path".' }, 400);
  try {
    const location = await resolveProjectLocation(body.path);
    const loaded = await loadProject(location);
    startSession(location, loaded.assets);
    const response: OpenProjectResponse = {
      info: projectInfo(location),
      project: projectToWire(loaded.project),
      issues: loaded.issues,
      migratedFrom: loaded.migratedFrom,
    };
    return c.json(response);
  } catch (e) {
    return errorResponse(c, e);
  }
});

projectRoutes.post("/new", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.path !== "string" || !body.path.trim()) return c.json({ error: 'Missing "path".' }, 400);
  const built = projectFromNewBody(body);
  if ("error" in built) return c.json({ error: built.error }, 400);
  try {
    const location = await prepareNewProjectFile(body.path);
    startSession(location, new Map());
    const response: NewProjectResponse = { info: projectInfo(location), project: projectToWire(built.project) };
    return c.json(response);
  } catch (e) {
    return errorResponse(c, e);
  }
});

/** Saves the client's project together with the session's images as the .krea archive. */
projectRoutes.put("/data", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object" || !body.project) return c.json({ error: 'Missing "project" in request body.' }, 400);
  try {
    const session = sessionForRequest(c.req.header("X-Krea-Project-Path"));
    const issues = await writeKreaArchive(session.location.file, wireProject(body.project), session.assets);
    if (issues.length > 0) return c.json({ error: "Project failed validation; not saved.", issues }, 400);
    session.location = { ...session.location, legacyRoot: null };
    const response: SaveProjectResponse = { ok: true };
    return c.json(response);
  } catch (e) {
    return errorResponse(c, e);
  }
});

projectRoutes.get("/assets", (c) => {
  try {
    const response: ProjectAssetsResponse = { assets: listAssets(sessionForRequest(c.req.header("X-Krea-Project-Path")).assets) };
    return c.json(response);
  } catch (e) {
    return errorResponse(c, e);
  }
});

/** Adds an image or .glb model (picked anywhere on disk in the browser) into the project; persisted on next Save. */
projectRoutes.post("/import-asset", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.parseBody();
  } catch {
    return c.json({ error: 'Expected multipart/form-data with a "file" field.' }, 400);
  }
  const file = body.file;
  if (!(file instanceof File)) return c.json({ error: 'Missing "file".' }, 400);
  try {
    const key = addAsset(sessionForRequest(c.req.header("X-Krea-Project-Path")).assets, file.name, new Uint8Array(await file.arrayBuffer()));
    const response: ImportAssetResponse = { path: key };
    return c.json(response);
  } catch (e) {
    return errorResponse(c, e);
  }
});

/** Writes the client's (possibly unsaved) project as a folder: project.json + assets/…. */
projectRoutes.post("/unpack", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || !body.project || typeof body.destination !== "string" || !body.destination.trim()) {
    return c.json({ error: "Expected { project, destination, overwrite? }." }, 400);
  }
  try {
    return c.json(await unpackToFolder(body.destination, wireProject(body.project), sessionForRequest(c.req.header("X-Krea-Project-Path")).assets, body.overwrite === true));
  } catch (e) {
    return errorResponse(c, e);
  }
});

/** Exports a map of the client's (possibly unsaved) project, using the session's images. */
projectRoutes.post("/export", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || !body.project || typeof body.mapId !== "string" || typeof body.destination !== "string" || !body.destination.trim()) {
    return c.json({ error: 'Expected { project, mapId, destination, overwrite?, copyAssets? }.' }, 400);
  }
  try {
    const result: ExportResponse = await exportMap(wireProject(body.project), sessionForRequest(c.req.header("X-Krea-Project-Path")).assets, {
      mapId: body.mapId,
      destination: body.destination,
      overwrite: body.overwrite === true,
      copyAssets: body.copyAssets !== false,
    });
    return c.json(result);
  } catch (e) {
    return errorResponse(c, e);
  }
});
