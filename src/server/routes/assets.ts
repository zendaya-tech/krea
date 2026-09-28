import { Hono } from "hono";
import path from "node:path";
import { getSession, ProjectError } from "../services/project-service";
import { CONTENT_TYPES, normalizeAssetKey } from "../services/project-file-service";
import { errorResponse } from "../lib/http-errors";

/** Serves images from the open project's in-memory archive, e.g. GET /api/assets/assets/tree.png. */
export const assetRoutes = new Hono();

assetRoutes.get("/*", (c) => {
  const key = normalizeAssetKey(decodeURIComponent(c.req.path.replace(/^\/api\/assets\//, "")));
  if (!key) return c.json({ error: "Invalid asset path." }, 400);
  try {
    const session = getSession();
    const expected = c.req.query("projectPath");
    if (expected && path.resolve(expected).toLowerCase() !== path.resolve(session.location.file).toLowerCase()) {
      throw new ProjectError("Another project is active in this server. Reopen this project to view its assets.", 409);
    }
    const data = session.assets.get(key);
    if (!data) return c.json({ error: `Asset not found: "${key}".` }, 404);
    const contentType = CONTENT_TYPES[path.extname(key).toLowerCase()] ?? "application/octet-stream";
    return new Response(new Uint8Array(data), { headers: { "Content-Type": contentType, "Cache-Control": "no-cache" } });
  } catch (e) {
    return errorResponse(c, e);
  }
});
