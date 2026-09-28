import type { Context } from "hono";
import { ProjectError } from "../services/project-service";

export function errorResponse(c: Context, e: unknown) {
  if (e instanceof ProjectError) {
    return c.json({ error: e.message }, e.status as 400 | 403 | 404 | 409 | 415);
  }
  const message = e instanceof Error ? e.message : "Unexpected server error.";
  return c.json({ error: message }, 500);
}
