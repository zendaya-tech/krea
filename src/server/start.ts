import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { createApp } from "./app";

export interface StartOptions {
  port: number;
  host?: string;
  staticDir?: string;
  /** When the port is taken, try the next ones (up to this many extra attempts). */
  portRetries?: number;
}

/** Starts the server; resolves with the port actually bound. */
export function startServer(options: StartOptions): Promise<{ port: number; url: string }> {
  const app = createApp({ staticDir: options.staticDir });
  const host = options.host ?? "localhost";
  const retries = options.portRetries ?? 0;

  return new Promise((resolve, reject) => {
    const attempt = (port: number, left: number) => {
      const server = serve({ fetch: app.fetch, port, hostname: host }, (info: AddressInfo) => {
        resolve({ port: info.port, url: `http://${host}:${info.port}` });
      });
      server.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && left > 0) attempt(port + 1, left - 1);
        else reject(err);
      });
    };
    attempt(options.port, retries);
  });
}
