import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  root: path.join(root, "src/client"),
  publicDir: path.join(root, "public"),
  resolve: {
    alias: {
      "@core": path.join(root, "src/core"),
      "@shared": path.join(root, "src/shared"),
      "@client": path.join(root, "src/client"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: path.join(root, "dist", "client"),
    emptyOutDir: true,
  },
});
