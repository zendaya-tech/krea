// Dev entry point (`npm run dev`): API only — Vite serves the UI and proxies /api here.
import { startServer } from "./start";

const { url } = await startServer({ port: 3001 });
console.log(`[server] API listening on ${url}`);
