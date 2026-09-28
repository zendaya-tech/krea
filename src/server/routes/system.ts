import { Hono } from "hono";
import type { Context } from "hono";
import { pickFolderNative, pickProjectToOpen, pickProjectToSave } from "../services/dialog-service";

/** Native OS dialogs, opened on the machine running the server. Each returns { path: null } if cancelled. */
export const systemRoutes = new Hono();

async function respond(c: Context, pick: () => Promise<string | null>) {
  try {
    return c.json({ path: await pick() });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Failed to open the dialog." }, 500);
  }
}

systemRoutes.post("/pick-folder", (c) => respond(c, pickFolderNative));

systemRoutes.post("/pick-project", (c) => respond(c, pickProjectToOpen));

systemRoutes.post("/pick-new-project", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const name = typeof body?.defaultName === "string" ? body.defaultName : "project";
  return respond(c, () => pickProjectToSave(name));
});
