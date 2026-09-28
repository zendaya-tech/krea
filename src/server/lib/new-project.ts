import type { KreaProject } from "@core/map-types";
import { createDefaultProject } from "@core/project-migration";

/**
 * Builds a blank project from a "new project" request body:
 *   2D: { name, mapName?, kind?: "2d", width, height, tileWidth, tileHeight } (cells / pixels)
 *   3D: { name, mapName?, kind: "3d", width, depth?, resolution?, waterLevel? } (meters / samples)
 */
export function projectFromNewBody(body: Record<string, unknown>): { project: KreaProject } | { error: string } {
  if (typeof body.name !== "string" || !body.name.trim()) return { error: 'Missing "name".' };
  const name = body.name.trim();
  const mapName = typeof body.mapName === "string" && body.mapName.trim() ? body.mapName.trim() : "Main";
  const kind = body.kind ?? "2d";

  if (kind === "3d") {
    const width = body.width ?? 128;
    const depth = body.depth ?? width;
    const resolution = body.resolution ?? 129;
    const waterLevel = body.waterLevel ?? null;
    if (typeof width !== "number" || !(width > 0) || typeof depth !== "number" || !(depth > 0)) {
      return { error: '"width" and "depth" must be positive numbers of meters.' };
    }
    if (typeof resolution !== "number" || !Number.isInteger(resolution) || resolution < 17 || resolution > 513) {
      return { error: '"resolution" must be an integer between 17 and 513.' };
    }
    if (waterLevel !== null && (typeof waterLevel !== "number" || !Number.isFinite(waterLevel))) {
      return { error: '"waterLevel" must be a number or null.' };
    }
    const settings = { width: 32, height: 32, tileWidth: 32, tileHeight: 32 };
    return { project: createDefaultProject(name, settings, mapName, "3d", { width, depth, resolution, waterLevel }) };
  }
  if (kind !== "2d") return { error: '"kind" must be "2d" or "3d".' };

  const { width, height, tileWidth, tileHeight } = body;
  for (const [key, value] of Object.entries({ width, height, tileWidth, tileHeight })) {
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return { error: `"${key}" must be a positive integer.` };
  }
  const settings = { width, height, tileWidth, tileHeight } as { width: number; height: number; tileWidth: number; tileHeight: number };
  return { project: createDefaultProject(name, settings, mapName) };
}
