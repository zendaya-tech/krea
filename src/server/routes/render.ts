import { Hono } from "hono";
import { resolveProjectLocation } from "../services/project-service";
import { loadProject } from "../services/project-file-service";
import { renderRegion } from "../services/render-service";
import { renderMap3D, type View3D } from "../services/render3d-service";
import { errorResponse } from "../lib/http-errors";

export const renderRoutes = new Hono();

/**
 * 2D maps:
 *   GET /api/render/screenshot?projectPath=...&mapId=...&x=0&y=0&cols=20&rows=15&zoom=1&showGrid=false&showCollisions=false&layers=ground,decoration
 * 3D maps:
 *   GET /api/render/screenshot?projectPath=...&mapId=...&view=iso|top|perspective&width=1024&height=768
 *       &areaX=&areaZ=&areaWidth=&areaDepth=&yaw=45&pitch=35&distance=&targetX=&targetZ=&fov=50
 *       &showGrid=false&gridSpacing=&showCollisions=false&showLabels=false&layers=objects
 *   The X-Krea-Camera response header (JSON) describes the camera; for view=top it
 *   maps pixels to world meters (x = originX + px * metersPerPixel, z = originZ + py * metersPerPixel).
 *
 * Stateless: reads the .krea file directly rather than relying on whatever
 * project the interactive editor has open, so a CLI or an AI agent can call it independently.
 */
renderRoutes.get("/screenshot", async (c) => {
  const projectPath = c.req.query("projectPath");
  if (!projectPath) return c.json({ error: 'Missing "projectPath" query parameter (a .krea file).' }, 400);
  const layersParam = c.req.query("layers");
  const layerIds = layersParam ? layersParam.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
  const flag = (name: string) => c.req.query(name) === "true";

  try {
    const { project, assets } = await loadProject(await resolveProjectLocation(projectPath));
    const mapId = c.req.query("mapId") ?? project.maps[0].id;
    const map = project.maps.find((m) => m.id === mapId);
    if (!map) return c.json({ error: `Map "${mapId}" not found. Maps: ${project.maps.map((m) => m.id).join(", ")}.` }, 404);

    if (map.kind === "3d") {
      const optional: Record<string, number | undefined> = {};
      for (const key of ["width", "height", "yaw", "pitch", "distance", "targetX", "targetZ", "fov", "gridSpacing", "areaX", "areaZ", "areaWidth", "areaDepth"]) {
        const raw = c.req.query(key);
        if (raw === undefined || raw === "") continue;
        const value = Number(raw);
        if (!Number.isFinite(value)) return c.json({ error: `Invalid numeric parameter "${key}".` }, 400);
        optional[key] = value;
      }
      const view = (c.req.query("view") ?? "iso") as View3D;
      if (!["iso", "top", "perspective"].includes(view)) return c.json({ error: '"view" must be "iso", "top" or "perspective".' }, 400);
      const areaKeys = ["areaX", "areaZ", "areaWidth", "areaDepth"];
      const areaGiven = areaKeys.filter((k) => optional[k] !== undefined).length;
      if (areaGiven > 0 && areaGiven < 4) return c.json({ error: "Give all of areaX, areaZ, areaWidth, areaDepth, or none." }, 400);
      const { png, camera } = await renderMap3D(project, assets, map, {
        view,
        width: optional.width ?? 1024,
        height: optional.height,
        yaw: optional.yaw,
        pitch: optional.pitch,
        distance: optional.distance,
        targetX: optional.targetX,
        targetZ: optional.targetZ,
        fov: optional.fov,
        gridSpacing: optional.gridSpacing,
        area: areaGiven === 4 ? { x: optional.areaX!, z: optional.areaZ!, width: optional.areaWidth!, depth: optional.areaDepth! } : undefined,
        showGrid: flag("showGrid"),
        showCollisions: flag("showCollisions"),
        showLabels: flag("showLabels"),
        layerIds,
      });
      return new Response(new Uint8Array(png), {
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "no-cache",
          "X-Krea-Camera": JSON.stringify(camera),
          "Access-Control-Expose-Headers": "X-Krea-Camera",
        },
      });
    }

    const numericParams = {
      x: Number(c.req.query("x") ?? "0"),
      y: Number(c.req.query("y") ?? "0"),
      cols: Number(c.req.query("cols") ?? "20"),
      rows: Number(c.req.query("rows") ?? "15"),
      zoom: Number(c.req.query("zoom") ?? "1"),
    };
    for (const [key, value] of Object.entries(numericParams)) {
      if (!Number.isFinite(value)) return c.json({ error: `Invalid numeric parameter "${key}".` }, 400);
    }
    const png = await renderRegion(project, assets, mapId, {
      ...numericParams,
      showGrid: flag("showGrid"),
      showCollisions: flag("showCollisions"),
      layerIds,
    });
    return new Response(new Uint8Array(png), { headers: { "Content-Type": "image/png", "Cache-Control": "no-cache" } });
  } catch (e) {
    return errorResponse(c, e);
  }
});
