import { Hono } from "hono";
import { validateProject } from "@core/map-validator";
import { projectFromWire } from "@core/project-codec";
import type { ValidateResponse } from "@shared/api-types";

export const validateRoutes = new Hono();

/** Structural validation of any .krea project JSON (no image checks — those need the archive). */
validateRoutes.post("/", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object" || !("project" in body)) {
    return c.json({ error: 'Missing "project" in request body.' }, 400);
  }
  const result = validateProject(projectFromWire(body.project));
  const response: ValidateResponse = { valid: result.valid, issues: result.issues };
  return c.json(response);
});
