import fs from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { projectRoutes } from "./routes/project";
import { assetRoutes } from "./routes/assets";
import { validateRoutes } from "./routes/validate";
import { renderRoutes } from "./routes/render";
import { agentRoutes } from "./routes/agent";
import { systemRoutes } from "./routes/system";

const STATIC_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

/**
 * The HTTP app: the /api routes, plus — when `staticDir` is given (the
 * published `krea` CLI) — the built editor UI, served from the same origin
 * so the client's relative /api calls just work.
 */
export function createApp(options: { staticDir?: string } = {}): Hono {
  const app = new Hono();
  app.use("/api/*", cors());

  app.route("/api/project", projectRoutes);
  app.route("/api/assets", assetRoutes);
  app.route("/api/validate", validateRoutes);
  app.route("/api/render", renderRoutes);
  app.route("/api/agent", agentRoutes);
  app.route("/api/system", systemRoutes);
  app.get("/api/health", (c) => c.json({ ok: true }));
  app.all("/api/*", (c) => c.json({ error: `Unknown API route: ${c.req.method} ${c.req.path}` }, 404));

  const { staticDir } = options;
  if (staticDir) {
    const root = path.resolve(staticDir);
    app.get("*", async (c) => {
      const requested = path.resolve(root, `.${decodeURIComponent(c.req.path)}`);
      // Never serve anything outside the UI build folder.
      const safe = requested === root || requested.startsWith(root + path.sep);
      const target = safe && path.extname(requested) ? requested : path.join(root, "index.html");
      const data = await fs.readFile(target).catch(() => null);
      if (!data) return c.text("Not found", 404);
      const type = STATIC_TYPES[path.extname(target).toLowerCase()] ?? "application/octet-stream";
      return new Response(new Uint8Array(data), { headers: { "Content-Type": type } });
    });
  }

  return app;
}
