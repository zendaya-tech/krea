import { Hono } from "hono";
import type { Context } from "hono";
import type { KreaProject, MapObjectDefinition } from "@core/map-types";
import { modelTemplate, validateEditableModel3D, type EditableModel3D } from "@core/model3d";
import { buildEditableModelGlb } from "@shared/model3d-glb";
import { uniqueId } from "@core/map-utils";
import * as objectOps from "@core/map-operations";
import { summarizeMap, summarizeProject } from "@core/map-summary";
import { projectFromWire, projectToWire, type KreaProjectJson } from "@core/project-codec";
import { downsampleHeights, heightAt, normalAt, slopeAt, splatWeightsAt, terrainStats } from "@core/terrain";
import { get3DMap } from "@core/map-utils";
import { buildWaterIndex } from "@core/water";
import { validateProject } from "@core/map-validator";
import { OperationError, applyOperation, describeOperations } from "@core/operation-dispatch";
import { prepareNewProjectFile, resolveProjectLocation } from "../services/project-service";
import {
  addAsset,
  checkAssetsPresent,
  listAssets,
  loadProject,
  readUnpackedFolder,
  referencedAssets,
  resolvePackTarget,
  unpackToFolder,
  writeKreaArchive,
} from "../services/project-file-service";
import { exportMap } from "../services/export-service";
import { buildAgentOpenApi } from "../agent-openapi";
import { errorResponse } from "../lib/http-errors";
import { projectFromNewBody } from "../lib/new-project";

/**
 * Stateless API for an external AI agent (or a CLI): every route takes the
 * .krea file's location directly (`projectPath`) and never touches the
 * editor session, so it's safe to call while a human has the app open.
 * Because a .krea is a binary archive, agents change it through these routes
 * (PUT /project, POST /assets) rather than by editing files on disk.
 */
export const agentRoutes = new Hono();

function projectPathFrom(c: Context): string | null {
  const p = c.req.query("projectPath");
  return p && p.trim() ? p : null;
}

const MISSING_PATH = { error: 'Missing "projectPath" query parameter (a .krea file).' };

/**
 * A project as JSON for an agent. 3D terrain arrays (heights, splat) are
 * large, so they're left out unless asked for — GET /api/agent/terrain gives
 * a compact view of the relief instead.
 */
function projectForAgent(project: KreaProject, includeTerrainData: boolean): KreaProjectJson {
  const wire = projectToWire(project);
  if (includeTerrainData) return wire;
  return {
    ...wire,
    maps: wire.maps.map((m) => {
      if (m.kind !== "3d") return m;
      const { heightsBase64: _h, splatBase64: _s, ...terrain } = m.terrain;
      return { ...m, terrain };
    }),
  };
}

/**
 * Decodes a project sent by an agent. A 3D map sent without terrain data
 * (as returned by GET /project without terrainData=true) keeps the terrain
 * currently saved for that map id, as long as its resolution didn't change.
 */
function agentProject(input: unknown, current: KreaProject | null): KreaProject {
  if (current && typeof input === "object" && input !== null && Array.isArray((input as { maps?: unknown }).maps)) {
    const maps = (input as { maps: unknown[] }).maps.map((raw) => {
      const m = raw as { kind?: string; id?: string; terrain?: Record<string, unknown> };
      if (m?.kind !== "3d" || !m.terrain || typeof m.id !== "string") return raw;
      const existing = get3DMap(current, m.id);
      if (!existing || existing.terrain.resolution !== m.terrain.resolution) return raw;
      const t = { ...m.terrain };
      if (t.heightsBase64 === undefined && t.heights === undefined) t.heights = existing.terrain.heights as unknown;
      if (t.splatBase64 === undefined && t.splat === undefined) t.splat = existing.terrain.splat as unknown;
      return { ...m, terrain: t };
    });
    input = { ...(input as object), maps };
  }
  return projectFromWire(input) as KreaProject;
}

/** Machine-readable description of this API, for agent frameworks that consume OpenAPI. */
agentRoutes.get("/openapi.json", (c) => c.json(buildAgentOpenApi()));

agentRoutes.get("/operations", (c) => c.json({ operations: describeOperations() }));

/**
 * Applies a batch of edit operations (same functions as the editor UI) to a
 * .krea file. Atomic: nothing is saved if an operation is malformed or if
 * the resulting project fails validation.
 */
agentRoutes.post("/operations", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.projectPath !== "string" || !Array.isArray(body.operations)) {
    return c.json({ error: "Expected { projectPath, operations: [...], dryRun? }. See GET /api/agent/operations." }, 400);
  }
  try {
    const location = await resolveProjectLocation(body.projectPath);
    const { project: initial, assets } = await loadProject(location);

    let project = initial;
    const results: Array<{ index: number; op: string; applied: boolean; detail?: string; createdId?: string; createdIds?: string[] }> = [];
    for (let index = 0; index < body.operations.length; index++) {
      const input = body.operations[index];
      const op = typeof input?.op === "string" ? input.op : "?";
      try {
        const outcome = applyOperation(project, input);
        project = outcome.project;
        results.push({ index, op, applied: outcome.applied, detail: outcome.detail, createdId: outcome.createdId, createdIds: outcome.createdIds });
      } catch (e) {
        if (!(e instanceof OperationError)) throw e;
        return c.json({ error: `Operation #${index} (${op}) rejected: ${e.message} Nothing was saved.`, saved: false, results }, 400);
      }
    }

    const issues = [...validateProject(project).issues, ...checkAssetsPresent(project, assets)];
    if (issues.some((i) => i.severity === "error")) {
      return c.json({ error: "The resulting project is invalid; nothing was saved.", saved: false, results, issues }, 400);
    }
    if (body.dryRun === true) return c.json({ saved: false, dryRun: true, results, issues });

    const writeIssues = await writeKreaArchive(location.file, project, assets);
    if (writeIssues.length > 0) return c.json({ error: "Project failed validation; not saved.", saved: false, results, issues: writeIssues }, 400);
    return c.json({ saved: true, projectPath: location.file, results, issues });
  } catch (e) {
    return errorResponse(c, e);
  }
});

agentRoutes.post("/unpack", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.projectPath !== "string" || typeof body.destination !== "string" || !body.destination.trim()) {
    return c.json({ error: "Expected { projectPath, destination, overwrite? }." }, 400);
  }
  try {
    const { project, assets } = await loadProject(await resolveProjectLocation(body.projectPath));
    return c.json(await unpackToFolder(body.destination, project, assets, body.overwrite === true));
  } catch (e) {
    return errorResponse(c, e);
  }
});

agentRoutes.post("/pack", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.folder !== "string" || typeof body.destination !== "string" || !body.destination.trim()) {
    return c.json({ error: "Expected { folder, destination, overwrite? }." }, 400);
  }
  try {
    const { project, assets } = await readUnpackedFolder(body.folder);
    const file = await resolvePackTarget(body.destination, body.overwrite === true);
    const issues = await writeKreaArchive(file, project, assets);
    if (issues.length > 0) return c.json({ error: "The folder's project is invalid; nothing was written.", issues }, 400);
    return c.json({ projectPath: file, assets: assets.size });
  } catch (e) {
    return errorResponse(c, e);
  }
});

/** Creates a new .krea file and writes it immediately (an agent has no session to "save later"). */
agentRoutes.post("/project", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.path !== "string" || !body.path.trim()) return c.json({ error: 'Missing "path".' }, 400);
  const built = projectFromNewBody(body);
  if ("error" in built) return c.json({ error: built.error }, 400);
  try {
    const location = await prepareNewProjectFile(body.path);
    const issues = await writeKreaArchive(location.file, built.project, new Map());
    return c.json({ projectPath: location.file, project: projectForAgent(built.project, false), issues });
  } catch (e) {
    return errorResponse(c, e);
  }
});

agentRoutes.get("/project", async (c) => {
  const projectPath = projectPathFrom(c);
  if (!projectPath) return c.json(MISSING_PATH, 400);
  try {
    const location = await resolveProjectLocation(projectPath);
    const { project, issues, migratedFrom } = await loadProject(location);
    const includeTerrainData = c.req.query("terrainData") === "true";
    const has3D = project.maps.some((m) => m.kind === "3d");
    return c.json({
      projectPath: location.file,
      project: projectForAgent(project, includeTerrainData),
      ...(has3D && !includeTerrainData ? { terrainDataOmitted: true } : {}),
      issues,
      migratedFrom,
    });
  } catch (e) {
    return errorResponse(c, e);
  }
});

/** Replaces the project JSON inside the archive (its images are kept). Refused if invalid. */
agentRoutes.put("/project", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.projectPath !== "string" || !body.project) {
    return c.json({ error: 'Expected { projectPath, project }.' }, 400);
  }
  try {
    const location = await resolveProjectLocation(body.projectPath);
    const { project: current, assets } = await loadProject(location);
    const issues = await writeKreaArchive(location.file, agentProject(body.project, current), assets);
    if (issues.length > 0) return c.json({ error: "Project failed validation; not saved.", issues }, 400);
    return c.json({ ok: true, projectPath: location.file });
  } catch (e) {
    return errorResponse(c, e);
  }
});

agentRoutes.get("/maps", async (c) => {
  const projectPath = projectPathFrom(c);
  if (!projectPath) return c.json(MISSING_PATH, 400);
  try {
    const { project } = await loadProject(await resolveProjectLocation(projectPath));
    return c.json(summarizeProject(project));
  } catch (e) {
    return errorResponse(c, e);
  }
});

agentRoutes.get("/summary", async (c) => {
  const projectPath = projectPathFrom(c);
  if (!projectPath) return c.json(MISSING_PATH, 400);
  try {
    const location = await resolveProjectLocation(projectPath);
    const { project } = await loadProject(location);
    const mapId = c.req.query("mapId") ?? project.maps[0].id;
    const summary = summarizeMap(project, mapId);
    if (!summary) return c.json({ error: `Map "${mapId}" not found.` }, 404);
    const base = `/api/render/screenshot?projectPath=${encodeURIComponent(location.file)}&mapId=${encodeURIComponent(mapId)}`;
    return c.json({
      ...summary,
      projectPath: location.file,
      screenshotUrlTemplate:
        summary.kind === "3d"
          ? `${base}&view={iso|top|perspective}&width=1024&height=768&showGrid=false&showCollisions=false`
          : `${base}&x={x}&y={y}&cols={cols}&rows={rows}&zoom=1&showGrid=true&showCollisions=false`,
    });
  } catch (e) {
    return errorResponse(c, e);
  }
});

agentRoutes.get("/objects", async (c) => {
  const projectPath = projectPathFrom(c);
  if (!projectPath) return c.json(MISSING_PATH, 400);
  try {
    const { project } = await loadProject(await resolveProjectLocation(projectPath));
    return c.json({ objects: project.objects });
  } catch (e) {
    return errorResponse(c, e);
  }
});

/** Procedural 3D models: source and generated GLB are saved together in the .krea archive. */
agentRoutes.get("/models", async (c) => {
  const projectPath = projectPathFrom(c);
  if (!projectPath) return c.json(MISSING_PATH, 400);
  try {
    const { project } = await loadProject(await resolveProjectLocation(projectPath));
    return c.json({ models: project.objects.filter((object) => object.kind === "3d").map(({ id, name, model, modelSource }) => ({ id, name, model, modelSource })) });
  } catch (e) {
    return errorResponse(c, e);
  }
});

agentRoutes.get("/model-templates", (c) => c.json({ templates: {
  blank: modelTemplate("blank"), person: modelTemplate("person"), face: modelTemplate("face"),
} }));

agentRoutes.post("/models", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.projectPath !== "string" || !body.projectPath.trim() || typeof body.name !== "string" || !body.name.trim()) {
    return c.json({ error: 'Expected { projectPath, name, source?, template?, objectId? }.' }, 400);
  }
  const source: EditableModel3D = body.source ?? (body.template === "blank" || body.template === "person" || body.template === "face" ? modelTemplate(body.template) : null);
  const problems = validateEditableModel3D(source);
  if (problems.length) return c.json({ error: "Invalid editable model source.", issues: problems }, 400);
  if (body.objectId !== undefined && (typeof body.objectId !== "string" || !body.objectId.trim())) return c.json({ error: '"objectId" must be a nonempty string.' }, 400);
  try {
    const location = await resolveProjectLocation(body.projectPath);
    const { project, assets } = await loadProject(location);
    const existing = body.objectId ? project.objects.find((object) => object.id === body.objectId) : undefined;
    if (body.objectId && !existing) return c.json({ error: `Object "${body.objectId}" not found.` }, 404);
    if (existing && existing.kind !== "3d") return c.json({ error: `Object "${existing.id}" is not 3D.` }, 400);
    const id = existing?.id ?? uniqueId(project.objects.map((object) => object.id), body.name);
    const filename = `${id.replace(/[^a-z0-9_-]/gi, "-")}.glb`;
    const model = addAsset(assets, filename, buildEditableModelGlb(source));
    let next: KreaProject;
    if (existing) {
      const result = objectOps.updateObjectDefinition(project, id, { name: body.name.trim(), model, modelSource: source });
      if (!result) return c.json({ error: "Could not update the model object." }, 400);
      next = result.project;
    } else {
      const definition: MapObjectDefinition = { id, name: body.name.trim(), kind: "3d", sprites: [], model, modelSource: source };
      const result = objectOps.addObjectDefinition(project, definition);
      if (!result) return c.json({ error: "Could not create the model object." }, 400);
      next = result.project;
    }
    const issues = await writeKreaArchive(location.file, next, assets);
    if (issues.length) return c.json({ error: "Project validation failed; nothing was saved.", issues }, 400);
    return c.json({ projectPath: location.file, objectId: id, model, parts: source.parts.length, created: !existing });
  } catch (e) {
    return errorResponse(c, e);
  }
});

agentRoutes.get("/assets", async (c) => {
  const projectPath = projectPathFrom(c);
  if (!projectPath) return c.json(MISSING_PATH, 400);
  try {
    const { project, assets } = await loadProject(await resolveProjectLocation(projectPath));
    const usedBy = new Map<string, string[]>();
    for (const ref of referencedAssets(project)) usedBy.set(ref.path, [...(usedBy.get(ref.path) ?? []), ref.usedBy]);
    return c.json({
      assets: listAssets(assets).map((p) => ({ path: p, bytes: assets.get(p)!.byteLength, usedBy: usedBy.get(p) ?? [] })),
    });
  } catch (e) {
    return errorResponse(c, e);
  }
});

/** multipart/form-data: projectPath + file. Adds the image or .glb model into the .krea archive and saves it. */
agentRoutes.post("/assets", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.parseBody();
  } catch {
    return c.json({ error: 'Expected multipart/form-data with "projectPath" and "file".' }, 400);
  }
  const file = body.file;
  if (typeof body.projectPath !== "string" || !(file instanceof File)) {
    return c.json({ error: 'Expected multipart/form-data with "projectPath" and "file".' }, 400);
  }
  try {
    const location = await resolveProjectLocation(body.projectPath);
    const { project, assets } = await loadProject(location);
    const key = addAsset(assets, file.name, new Uint8Array(await file.arrayBuffer()));
    const issues = await writeKreaArchive(location.file, project, assets);
    if (issues.length > 0) return c.json({ error: "Project is invalid; file not saved. Fix the project first.", issues }, 400);
    return c.json({ path: key });
  } catch (e) {
    return errorResponse(c, e);
  }
});

agentRoutes.post("/export", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.projectPath !== "string" || typeof body.destination !== "string" || !body.destination.trim()) {
    return c.json({ error: 'Expected { projectPath, destination, mapId?, overwrite?, copyAssets? }.' }, 400);
  }
  try {
    const { project, assets } = await loadProject(await resolveProjectLocation(body.projectPath));
    const result = await exportMap(project, assets, {
      mapId: typeof body.mapId === "string" ? body.mapId : project.maps[0].id,
      destination: body.destination,
      overwrite: body.overwrite === true,
      copyAssets: body.copyAssets !== false,
    });
    return c.json(result);
  } catch (e) {
    return errorResponse(c, e);
  }
});

/**
 * GET /api/agent/terrain?projectPath=…&mapId=…&samples=33&at=x,z;x,z
 *
 * A compact view of a 3D map's relief: height stats, layer coverage, an
 * n×n grid of heights (rows along z, from z=0), and optional probes giving
 * height, slope and paint weights at exact points.
 */
agentRoutes.get("/terrain", async (c) => {
  const projectPath = projectPathFrom(c);
  if (!projectPath) return c.json(MISSING_PATH, 400);
  try {
    const { project } = await loadProject(await resolveProjectLocation(projectPath));
    const mapId = c.req.query("mapId") ?? project.maps.find((m) => m.kind === "3d")?.id ?? "";
    const map = get3DMap(project, mapId);
    if (!map) return c.json({ error: `"${mapId}" is not a 3D map of this project.` }, 404);
    const t = map.terrain;
    const samples = Number(c.req.query("samples") ?? "33");
    if (!Number.isInteger(samples) || samples < 2 || samples > 129) return c.json({ error: '"samples" must be an integer between 2 and 129.' }, 400);
    const stats = terrainStats(t);
    const water = buildWaterIndex(map);
    const probes: Array<Record<string, unknown>> = [];
    for (const pair of (c.req.query("at") ?? "").split(";").filter(Boolean)) {
      const [x, z] = pair.split(",").map(Number);
      if (!Number.isFinite(x) || !Number.isFinite(z)) return c.json({ error: `Invalid probe "${pair}" (expected x,z).` }, 400);
      const weights = splatWeightsAt(t, x, z);
      const n = normalAt(t, x, z);
      const h = heightAt(t, x, z);
      probes.push({
        x,
        z,
        height: round(h),
        slope: round(slopeAt(t, x, z)),
        normal: { x: round(n.x), y: round(n.y), z: round(n.z) },
        underwater: water.surfaceAt(x, z) !== null,
        ...(water.surfaceAt(x, z)
          ? { water: { source: water.surfaceAt(x, z)!.source, surface: round(water.surfaceAt(x, z)!.level), depth: round(water.surfaceAt(x, z)!.level - h) } }
          : {}),
        layers: Object.fromEntries(t.layers.map((l, i) => [l.id, round(weights[i])])),
      });
    }
    return c.json({
      mapId: map.id,
      size: t.size,
      resolution: t.resolution,
      waterLevel: t.waterLevel,
      waters: map.waters,
      layers: t.layers.map((l, i) => ({ ...l, coverage: round(stats.layerCoverage[i]?.share ?? 0) })),
      minHeight: round(stats.minHeight),
      maxHeight: round(stats.maxHeight),
      meanHeight: round(stats.meanHeight),
      heightGrid: {
        samples,
        spacing: { x: round(t.size.width / (samples - 1)), z: round(t.size.depth / (samples - 1)) },
        rows: downsampleHeights(t, samples),
      },
      probes,
      placements: map.placements.length,
    });
  } catch (e) {
    return errorResponse(c, e);
  }
});

function round(v: number): number {
  return Math.round(v * 100) / 100;
}
