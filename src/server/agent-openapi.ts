import { describeOperations, type ParamType } from "@core/operation-dispatch";

/**
 * OpenAPI 3.1 description of the AI/automation-facing API, served at
 * GET /api/agent/openapi.json so agent frameworks can discover the tools.
 * The operations part is generated from OPERATIONS, the same catalog that
 * validates requests, so the description can't drift from the behavior.
 */

type Json = Record<string, unknown>;

function paramSchema(type: ParamType, description: string): Json {
  const base: Record<ParamType, Json> = {
    string: { type: "string" },
    integer: { type: "integer" },
    number: { type: "number" },
    boolean: { type: "boolean" },
    object: { type: "object" },
    array: { type: "array" },
    "string|null": { type: ["string", "null"] },
    "number|null": { type: ["number", "null"] },
    "object|null": { type: ["object", "null"] },
  };
  return { ...base[type], description };
}

function operationSchemas(): Json[] {
  return describeOperations().map(({ op, description, params }) => ({
    title: op,
    description,
    type: "object",
    additionalProperties: false,
    required: ["op", ...Object.entries(params).filter(([, p]) => p.required).map(([name]) => name)],
    properties: {
      op: { const: op },
      ...Object.fromEntries(Object.entries(params).map(([name, p]) => [name, paramSchema(p.type, p.description)])),
    },
  }));
}

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const projectPathQuery = {
  name: "projectPath",
  in: "query",
  required: true,
  description: "Absolute path of the .krea file (a folder containing one also works).",
  schema: { type: "string" },
};
const errors = {
  "400": { description: "Invalid input or project.", content: { "application/json": { schema: ref("Error") } } },
  "404": { description: "Project, map or file not found.", content: { "application/json": { schema: ref("Error") } } },
  "409": { description: "Target already exists (pass overwrite).", content: { "application/json": { schema: ref("Error") } } },
};
const jsonBody = (schema: Json, description?: string) => ({
  required: true,
  ...(description ? { description } : {}),
  content: { "application/json": { schema } },
});
const ok = (description: string, schema: Json = { type: "object" }) => ({
  "200": { description, content: { "application/json": { schema } } },
  ...errors,
});

const shapeCommon = {
  id: { type: "string" },
  x: { type: "number", description: "Center x, in the sprite image's pixels." },
  y: { type: "number", description: "Center y, in the sprite image's pixels." },
};
const point = { type: "object", required: ["x", "y"], properties: { x: { type: "number" }, y: { type: "number" } } };

export function buildAgentOpenApi(): Json {
  return {
    openapi: "3.1.0",
    info: {
      title: "Krea map editor — agent API",
      version: "1.0.0",
      description:
        "Stateless API to create, inspect, edit, render and export .krea map projects. Every route takes the project's path; " +
        "none of them touch the editor UI's session. Typical flow: POST /api/agent/project → POST /api/agent/assets (images) → " +
        "POST /api/agent/operations (addObjectDefinition, createMap, fillRect, placeObject…) → GET /api/agent/summary and " +
        "GET /api/render/screenshot?showCollisions=true to check → POST /api/agent/export. " +
        "Maps are 2D (tile grid; coordinates in cells) or 3D (sculptable terrain; coordinates in meters, x east, y up, z south). " +
        "3D flow: createMap kind 3d → generateTerrain / sculptTerrain → autoPaintTerrain / paintTerrain → setWaterLevel → " +
        "addObjectDefinition kind 3d (.glb model) or 2d (billboard) → scatterObjects3D / placeObject3D → GET /api/agent/terrain and " +
        "GET /api/render/screenshot?view=iso|top|perspective to check.",
    },
    servers: [{ url: "http://localhost:3001" }],
    paths: {
      "/api/agent/project": {
        post: {
          operationId: "createProject",
          summary: "Create a new .krea project file (written immediately) with one 2D or 3D map.",
          requestBody: jsonBody({
            type: "object",
            required: ["path", "name"],
            properties: {
              path: { type: "string", description: "Where to write it; .krea is appended if missing. Refuses to overwrite." },
              name: { type: "string" },
              mapName: { type: "string", description: 'Name of the first map (default "Main", id "main").' },
              kind: { enum: ["2d", "3d"], description: 'Kind of the first map (default "2d").' },
              width: { type: "number", description: "2D: width in cells (required). 3D: terrain width in meters (default 128)." },
              height: { type: "integer", description: "2D only (required): height in cells." },
              tileWidth: { type: "integer", description: "2D only (required): cell width in pixels." },
              tileHeight: { type: "integer", description: "2D only (required): cell height in pixels." },
              depth: { type: "number", description: "3D only: terrain depth in meters (default = width)." },
              resolution: { type: "integer", description: "3D only: heightmap samples per side, 17-513 (default 129)." },
              waterLevel: { type: ["number", "null"], description: "3D only: water plane height, or null (default)." },
            },
          }),
          responses: ok("Created.", { type: "object", properties: { projectPath: { type: "string" }, project: ref("KreaProject") } }),
        },
        get: {
          operationId: "getProject",
          summary: "Read the full project JSON.",
          description:
            "3D terrain arrays are omitted by default (terrainDataOmitted: true) — use GET /api/agent/terrain for the relief. " +
            "Sending such a project back with PUT keeps the saved terrain.",
          parameters: [
            projectPathQuery,
            { name: "terrainData", in: "query", schema: { type: "boolean" }, description: "Include 3D terrain arrays (heightsBase64, splatBase64)." },
          ],
          responses: ok("The project.", {
            type: "object",
            properties: { projectPath: { type: "string" }, project: ref("KreaProject"), issues: { type: "array", items: ref("ValidationIssue") } },
          }),
        },
        put: {
          operationId: "replaceProject",
          summary: "Replace the whole project JSON (images inside the archive are kept). Prefer /operations for edits.",
          requestBody: jsonBody({ type: "object", required: ["projectPath", "project"], properties: { projectPath: { type: "string" }, project: ref("KreaProject") } }),
          responses: ok("Saved."),
        },
      },
      "/api/agent/operations": {
        get: {
          operationId: "listOperations",
          summary: "Catalog of every edit operation with its parameters.",
          responses: ok("Operations.", { type: "object", properties: { operations: { type: "array" } } }),
        },
        post: {
          operationId: "applyOperations",
          summary: "Apply a batch of edit operations atomically (all or nothing), validate, and save.",
          description:
            "Operations run in order on the same project; ids created by earlier ones (returned as createdId) can be used by later ones. " +
            "If any operation is malformed or the final project is invalid, nothing is saved. Operations that are valid but change nothing report applied: false with a reason.",
          requestBody: jsonBody({
            type: "object",
            required: ["projectPath", "operations"],
            properties: {
              projectPath: { type: "string" },
              operations: { type: "array", items: ref("Operation") },
              dryRun: { type: "boolean", description: "Run and validate without saving." },
            },
          }),
          responses: ok("Result of each operation.", {
            type: "object",
            properties: {
              saved: { type: "boolean" },
              results: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    index: { type: "integer" },
                    op: { type: "string" },
                    applied: { type: "boolean" },
                    detail: { type: "string" },
                    createdId: { type: "string" },
                    createdIds: { type: "array", items: { type: "string" } },
                  },
                },
              },
              issues: { type: "array", items: ref("ValidationIssue") },
            },
          }),
        },
      },
      "/api/agent/maps": {
        get: { operationId: "listMaps", summary: "Project overview: maps and catalog counts.", parameters: [projectPathQuery], responses: ok("Overview.") },
      },
      "/api/agent/summary": {
        get: {
          operationId: "summarizeMap",
          summary: "One map in detail: layer/object counts, occupied bounds, catalog with sprites, screenshot URL template.",
          parameters: [projectPathQuery, { name: "mapId", in: "query", schema: { type: "string" }, description: "Default: first map." }],
          responses: ok("Summary."),
        },
      },
      "/api/agent/terrain": {
        get: {
          operationId: "inspectTerrain",
          summary: "A 3D map's relief: height stats, layer coverage, a downsampled height grid, and point probes.",
          parameters: [
            projectPathQuery,
            { name: "mapId", in: "query", schema: { type: "string" }, description: "Default: first 3D map." },
            { name: "samples", in: "query", schema: { type: "integer", default: 33 }, description: "Height grid size (2-129 per side)." },
            { name: "at", in: "query", schema: { type: "string" }, description: 'Probes "x,z;x,z" (meters): height, slope, normal, underwater, layer weights.' },
          ],
          responses: ok("Terrain."),
        },
      },
      "/api/agent/objects": {
        get: { operationId: "listObjects", summary: "The object catalog with sprites and collisions.", parameters: [projectPathQuery], responses: ok("Objects.") },
      },
      "/api/agent/models": {
        get: { operationId: "listModels", summary: "List 3D object models and their editable source, when created in Krea.", parameters: [projectPathQuery], responses: ok("3D models.") },
        post: {
          operationId: "createOrUpdateModel",
          summary: "Create or update an editable 3D model, generate a GLB, and save both in the .krea project.",
          description: "Set objectId to update an existing 3D object. Send source from GET /model-templates or an edited source, or use template: blank, person, or face. Imported GLBs can also be replaced this way. The project file is written atomically.",
          requestBody: jsonBody({ type: "object", required: ["projectPath", "name"], properties: {
            projectPath: { type: "string" }, name: { type: "string" }, objectId: { type: "string" },
            template: { enum: ["blank", "person", "face"] },
            source: ref("EditableModel3D"),
          } }),
          responses: ok("Editable model saved.", { type: "object", properties: { projectPath: { type: "string" }, objectId: { type: "string" }, model: { type: "string" }, parts: { type: "integer" }, created: { type: "boolean" } } }),
        },
      },
      "/api/agent/model-templates": {
        get: { operationId: "getModelTemplates", summary: "Editable primitive templates for a blank object, a person, and a face.", responses: ok("Template sources.") },
      },
      "/api/agent/assets": {
        get: { operationId: "listAssets", summary: "Images and 3D models stored in the project and what uses each.", parameters: [projectPathQuery], responses: ok("Assets.") },
        post: {
          operationId: "uploadAsset",
          summary: "Add an image (png, jpg, gif, webp, bmp) or a 3D model (.glb) into the project archive (and save). Returns its asset path for sprites, textures or models.",
          requestBody: {
            required: true,
            content: {
              "multipart/form-data": {
                schema: {
                  type: "object",
                  required: ["projectPath", "file"],
                  properties: { projectPath: { type: "string" }, file: { type: "string", format: "binary" } },
                },
              },
            },
          },
          responses: ok("Stored.", { type: "object", properties: { path: { type: "string", description: 'e.g. "assets/tree.png"' } } }),
        },
      },
      "/api/agent/export": {
        post: {
          operationId: "exportMap",
          summary: "Export a map as game-ready JSON plus its assets. 2D: world-space collisions. 3D: placements with world positions and boxes, heights.f32, splat.rgba and a terrain .glb mesh.",
          requestBody: jsonBody({
            type: "object",
            required: ["projectPath", "destination"],
            properties: {
              projectPath: { type: "string" },
              mapId: { type: "string", description: "Default: first map." },
              destination: { type: "string", description: "A .json file path, or a folder (file named after the map id)." },
              overwrite: { type: "boolean" },
              copyAssets: { type: "boolean", description: "Default true." },
            },
          }),
          responses: ok("Exported."),
        },
      },
      "/api/agent/unpack": {
        post: {
          operationId: "unpackProject",
          summary: "Extract a .krea into a folder: project.json + assets/… + maps/<id>/heights.f32 & splat.rgba for 3D maps.",
          requestBody: jsonBody({
            type: "object",
            required: ["projectPath", "destination"],
            properties: { projectPath: { type: "string" }, destination: { type: "string" }, overwrite: { type: "boolean" } },
          }),
          responses: ok("Unpacked."),
        },
      },
      "/api/agent/pack": {
        post: {
          operationId: "packProject",
          summary: "Build a .krea from an unpacked folder (project.json + assets/…). Validated before writing.",
          requestBody: jsonBody({
            type: "object",
            required: ["folder", "destination"],
            properties: { folder: { type: "string" }, destination: { type: "string", description: ".krea path" }, overwrite: { type: "boolean" } },
          }),
          responses: ok("Packed."),
        },
      },
      "/api/render/screenshot": {
        get: {
          operationId: "renderScreenshot",
          summary: "PNG of a map, rendered server-side. 2D maps: a region of cells. 3D maps: an iso, top or perspective view.",
          description:
            "For 3D maps the X-Krea-Camera header (JSON) describes the camera; with view=top it maps pixels to meters: " +
            "x = originX + px * metersPerPixel, z = originZ + py * metersPerPixel.",
          parameters: [
            projectPathQuery,
            { name: "mapId", in: "query", schema: { type: "string" } },
            { name: "x", in: "query", schema: { type: "integer", default: 0 }, description: "2D: top-left cell column." },
            { name: "y", in: "query", schema: { type: "integer", default: 0 }, description: "2D: top-left cell row." },
            { name: "cols", in: "query", schema: { type: "integer", default: 20 }, description: "2D." },
            { name: "rows", in: "query", schema: { type: "integer", default: 15 }, description: "2D." },
            { name: "zoom", in: "query", schema: { type: "number", default: 1 }, description: "2D." },
            { name: "view", in: "query", schema: { enum: ["iso", "top", "perspective"], default: "iso" }, description: "3D." },
            { name: "width", in: "query", schema: { type: "integer", default: 1024 }, description: "3D: image width (16-2048 px)." },
            { name: "height", in: "query", schema: { type: "integer" }, description: "3D: image height (default: from the area's aspect for top, 3:4 otherwise)." },
            { name: "areaX", in: "query", schema: { type: "number" }, description: "3D: area to frame (meters), with areaZ, areaWidth, areaDepth. Default: whole terrain." },
            { name: "areaZ", in: "query", schema: { type: "number" } },
            { name: "areaWidth", in: "query", schema: { type: "number" } },
            { name: "areaDepth", in: "query", schema: { type: "number" } },
            { name: "yaw", in: "query", schema: { type: "number", default: 45 }, description: "3D iso/perspective: degrees around the vertical the camera looks from (0 = from +z)." },
            { name: "pitch", in: "query", schema: { type: "number" }, description: "3D iso/perspective: degrees above the horizon (default 35 / 30)." },
            { name: "distance", in: "query", schema: { type: "number" }, description: "3D perspective: meters from the target." },
            { name: "targetX", in: "query", schema: { type: "number" }, description: "3D perspective: point looked at (default: area center)." },
            { name: "targetZ", in: "query", schema: { type: "number" } },
            { name: "fov", in: "query", schema: { type: "number", default: 50 }, description: "3D perspective: vertical field of view (degrees)." },
            { name: "showGrid", in: "query", schema: { type: "boolean" } },
            { name: "gridSpacing", in: "query", schema: { type: "number" }, description: "3D: grid spacing in meters." },
            { name: "showCollisions", in: "query", schema: { type: "boolean" }, description: "2D: collision shapes. 3D: bounding boxes." },
            { name: "showLabels", in: "query", schema: { type: "boolean" }, description: "3D: write each placement's id above it." },
            { name: "layers", in: "query", schema: { type: "string" }, description: "Comma-separated layer ids, rendered even if hidden." },
          ],
          responses: { "200": { description: "PNG image.", content: { "image/png": { schema: { type: "string", format: "binary" } } } }, ...errors },
        },
      },
      "/api/validate": {
        post: {
          operationId: "validateProject",
          summary: "Structural validation of a project JSON.",
          requestBody: jsonBody({ type: "object", required: ["project"], properties: { project: ref("KreaProject") } }),
          responses: ok("Result.", { type: "object", properties: { valid: { type: "boolean" }, issues: { type: "array", items: ref("ValidationIssue") } } }),
        },
      },
    },
    components: {
      schemas: {
        Error: { type: "object", properties: { error: { type: "string" }, issues: { type: "array", items: ref("ValidationIssue") } } },
        ValidationIssue: {
          type: "object",
          properties: { severity: { enum: ["error", "warning"] }, message: { type: "string" }, path: { type: "string" } },
        },
        Operation: { oneOf: operationSchemas(), discriminator: { propertyName: "op" } },
        CollisionShape: {
          description: "In the sprite image's pixels (or, for sprite-less objects, footprint space at 32 px per tile). Rotation: degrees, clockwise, around the center.",
          oneOf: [
            {
              type: "object",
              required: ["id", "type", "x", "y", "width", "height", "rotation"],
              properties: { ...shapeCommon, type: { const: "rect" }, width: { type: "number" }, height: { type: "number" }, rotation: { type: "number" } },
            },
            { type: "object", required: ["id", "type", "x", "y", "radius"], properties: { ...shapeCommon, type: { const: "circle" }, radius: { type: "number" } } },
            {
              type: "object",
              required: ["id", "type", "x", "y", "points", "rotation"],
              properties: {
                ...shapeCommon,
                type: { const: "triangle" },
                points: { type: "array", minItems: 3, maxItems: 3, items: point, description: "Offsets from the center, before rotation." },
                rotation: { type: "number" },
              },
            },
          ],
        },
        Sprite: {
          type: "object",
          required: ["id", "name", "image", "collisions"],
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            image: { type: "string", description: 'Asset path inside the project, e.g. "assets/tree.png".' },
            collisions: { type: "array", items: ref("CollisionShape") },
          },
        },
        EditableModel3D: {
          type: "object", required: ["version", "parts"],
          properties: { version: { const: 1 }, parts: { type: "array", minItems: 1, maxItems: 128, items: {
            type: "object", required: ["id", "name", "shape", "position", "rotation", "scale", "color", "metallic", "roughness"],
            properties: {
              id: { type: "string" }, name: { type: "string" }, shape: { enum: ["box", "sphere", "cylinder", "cone", "capsule", "torus"] },
              position: { type: "array", minItems: 3, maxItems: 3, items: { type: "number" }, description: "x,y,z in meters; y is up." },
              rotation: { type: "array", minItems: 3, maxItems: 3, items: { type: "number" }, description: "Euler XYZ degrees." },
              scale: { type: "array", minItems: 3, maxItems: 3, items: { type: "number", exclusiveMinimum: 0 } },
              color: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" }, metallic: { type: "number", minimum: 0, maximum: 1 }, roughness: { type: "number", minimum: 0, maximum: 1 },
            },
          } } },
        },
        ObjectDefinition: {
          type: "object",
          required: ["id", "name", "kind", "sprites"],
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            kind: { enum: ["2d", "3d"], description: "2d: sprites (tiles on 2D maps, billboards on 3D maps). 3d: a .glb model, 3D maps only." },
            model: { type: "string", description: '3D objects: .glb asset path ("assets/tree.glb"). Absent = invisible marker.' },
            modelSource: ref("EditableModel3D"),
            description: { type: "string" },
            sizeInTiles: { type: "object", properties: { width: { type: "integer" }, height: { type: "integer" } } },
            sprites: { type: "array", items: ref("Sprite"), description: "May be empty (invisible object)." },
            defaultSpriteId: { type: "string", description: "Required when sprites is non-empty." },
            collisions: { type: "array", items: ref("CollisionShape"), description: "Only for sprite-less objects (footprint space)." },
          },
        },
        MapDocument: { oneOf: [ref("Map2D"), ref("Map3D")], discriminator: { propertyName: "kind" } },
        Map3D: {
          type: "object",
          required: ["kind", "id", "name", "terrain", "layers", "placements"],
          properties: {
            kind: { const: "3d" },
            id: { type: "string" },
            name: { type: "string" },
            terrain: {
              type: "object",
              required: ["resolution", "size", "layers", "waterLevel"],
              properties: {
                resolution: { type: "integer", description: "Heightmap samples per side." },
                size: { type: "object", properties: { width: { type: "number" }, depth: { type: "number" } }, description: "Meters." },
                layers: {
                  type: "array",
                  maxItems: 4,
                  items: {
                    type: "object",
                    required: ["id", "name", "color", "tileSize"],
                    properties: { id: { type: "string" }, name: { type: "string" }, color: { type: "string" }, texture: { type: "string" }, tileSize: { type: "number" } },
                  },
                },
                waterLevel: { type: ["number", "null"] },
                heightsBase64: { type: "string", description: "resolution² little-endian float32, row-major (x first). Omitted unless requested." },
                splatBase64: { type: "string", description: "resolution² × 4 bytes of layer weights. Omitted unless requested." },
              },
            },
            layers: {
              type: "array",
              items: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, visible: { type: "boolean" }, locked: { type: "boolean" } } },
            },
            placements: {
              type: "array",
              items: {
                type: "object",
                required: ["id", "objectId", "layerId", "x", "z", "elevation", "rotation", "scale"],
                properties: {
                  id: { type: "string" },
                  objectId: { type: "string" },
                  layerId: { type: "string" },
                  x: { type: "number" },
                  z: { type: "number" },
                  elevation: { type: "number", description: "Meters above the terrain." },
                  rotation: { type: "number", description: "Yaw, degrees, counter-clockwise seen from above." },
                  scale: { type: "number" },
                  spriteId: { type: "string" },
                },
              },
            },
          },
        },
        Map2D: {
          type: "object",
          required: ["kind", "id", "name", "settings", "layers", "mapping"],
          properties: {
            kind: { const: "2d" },
            id: { type: "string" },
            name: { type: "string" },
            settings: {
              type: "object",
              properties: { width: { type: "integer" }, height: { type: "integer" }, tileWidth: { type: "integer" }, tileHeight: { type: "integer" } },
            },
            layers: {
              type: "array",
              items: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, visible: { type: "boolean" }, locked: { type: "boolean" } } },
            },
            mapping: {
              type: "array",
              items: {
                type: "object",
                required: ["objectId", "layerId", "x", "y"],
                properties: {
                  objectId: { type: "string" },
                  layerId: { type: "string" },
                  x: { type: "integer", description: "Top-left cell of the footprint." },
                  y: { type: "integer" },
                  spriteId: { type: "string" },
                },
              },
            },
          },
        },
        KreaProject: {
          type: "object",
          required: ["format", "version", "name", "objects", "maps"],
          properties: {
            format: { const: "krea" },
            version: { const: 3 },
            name: { type: "string" },
            objects: { type: "array", items: ref("ObjectDefinition") },
            maps: { type: "array", items: ref("MapDocument"), minItems: 1 },
          },
        },
      },
    },
  };
}
