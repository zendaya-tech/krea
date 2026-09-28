// @ts-nocheck
// Restored from the previous CLI build after an interrupted file write.
import { describeShapeProblem } from "./collision-geometry";
import { KREA_FORMAT, KREA_VERSION, MAX_DETAIL_LAYERS, MAX_TERRAIN_LAYERS } from "./map-types";
import { footprintCells, getObjectSize, isFootprintInBounds } from "./map-utils";
import { isHexColor } from "./terrain";
import { validateEditableModel3D } from "./model3d";

export type ValidationSeverity = "error" | "warning";
export interface ValidationIssue { severity: ValidationSeverity; message: string; path?: string; }

function err(issues, message, path8) {
  issues.push({ severity: "error", message, path: path8 });
}
var isObj2 = (v) => typeof v === "object" && v !== null;
var isNonEmptyString = (v) => typeof v === "string" && v.trim() !== "";
var isPositiveInt = (v) => typeof v === "number" && Number.isInteger(v) && v > 0;
export function validateProject(input) {
  const issues = [];
  if (!isObj2(input)) {
    err(issues, "Project root must be a JSON object.");
    return { valid: false, issues };
  }
  if (input.format !== KREA_FORMAT) err(issues, `"format" must be "${KREA_FORMAT}".`, "format");
  if (input.version !== KREA_VERSION) err(issues, `"version" must be ${KREA_VERSION}.`, "version");
  if (!isNonEmptyString(input.name)) err(issues, 'Missing or invalid project "name".', "name");
  const objectsById = validateObjects(input.objects, issues);
  if (!Array.isArray(input.maps) || input.maps.length === 0) {
    err(issues, '"maps" must be a non-empty array.', "maps");
  } else {
    const mapIds = /* @__PURE__ */ new Set();
    input.maps.forEach((map, i) => {
      if (isObj2(map) && isNonEmptyString(map.id)) {
        if (mapIds.has(map.id)) err(issues, `Duplicate map id "${map.id}".`, `maps[${i}].id`);
        mapIds.add(map.id);
      }
      validateMap(map, i, objectsById, issues);
    });
  }
  return { valid: !issues.some((i) => i.severity === "error"), issues };
}
function validateObjects(objects, issues) {
  const byId = /* @__PURE__ */ new Map();
  if (!Array.isArray(objects)) {
    err(issues, 'Missing or invalid "objects" (expected array).', "objects");
    return byId;
  }
  objects.forEach((obj, i) => {
    const path8 = `objects[${i}]`;
    if (!isObj2(obj) || !isNonEmptyString(obj.id)) {
      err(issues, `Object at index ${i} has an invalid "id".`, `${path8}.id`);
      return;
    }
    const label = `Object "${obj.id}"`;
    if (byId.has(obj.id)) err(issues, `Duplicate object id "${obj.id}".`, `${path8}.id`);
    if (!isNonEmptyString(obj.name)) err(issues, `${label} has an invalid "name".`, `${path8}.name`);
    if (obj.description !== void 0 && typeof obj.description !== "string") {
      err(issues, `${label} has an invalid "description" (expected string).`, `${path8}.description`);
    }
    if (obj.sizeInTiles !== void 0) {
      const s = obj.sizeInTiles;
      if (!isObj2(s) || !isPositiveInt(s.width) || !isPositiveInt(s.height)) {
        err(issues, `${label} has an invalid "sizeInTiles" (expected positive integer width/height).`, `${path8}.sizeInTiles`);
      }
    }
    if (obj.collisions !== void 0) validateShapes(obj.collisions, `${label} (object-level collisions)`, `${path8}.collisions`, issues);
    if (obj.kind !== "2d" && obj.kind !== "3d") {
      err(issues, `${label} has an invalid "kind" (expected "2d" or "3d").`, `${path8}.kind`);
    } else if (obj.kind === "3d") {
      if (Array.isArray(obj.sprites) && obj.sprites.length > 0) err(issues, `${label} is a 3D object and can't have sprites.`, `${path8}.sprites`);
      if (obj.defaultSpriteId !== void 0) err(issues, `${label} is a 3D object and can't have a "defaultSpriteId".`, `${path8}.defaultSpriteId`);
      if (obj.model !== void 0) {
        const problem = describeAssetPathProblem(obj.model);
        if (problem) err(issues, `${label} has an invalid "model": ${problem}`, `${path8}.model`);
        else if (!/\.glb$/i.test(obj.model)) err(issues, `${label}: "model" must be a .glb file.`, `${path8}.model`);
      }
      if (obj.modelSource !== void 0) {
        if (obj.model === void 0) err(issues, `${label} has editable source but no generated .glb model.`, `${path8}.model`);
        for (const problem of validateEditableModel3D(obj.modelSource)) err(issues, `${label}: ${problem}`, `${path8}.modelSource`);
      }
    } else if (obj.model !== void 0) {
      err(issues, `${label} is a 2D object and can't have a "model" (make it a 3D object instead).`, `${path8}.model`);
    }
    if (obj.kind === "2d" && obj.modelSource !== void 0) err(issues, `${label} is a 2D object and cannot have 3D model source.`, `${path8}.modelSource`);
    if (!Array.isArray(obj.sprites)) {
      err(issues, `${label} has an invalid "sprites" (expected array, possibly empty).`, `${path8}.sprites`);
    } else if (obj.sprites.length === 0) {
      if (obj.defaultSpriteId !== void 0) {
        err(issues, `${label} has a "defaultSpriteId" but no sprites.`, `${path8}.defaultSpriteId`);
      }
    } else {
      const spriteIds = /* @__PURE__ */ new Set();
      obj.sprites.forEach((sprite, si) => {
        const spath = `${path8}.sprites[${si}]`;
        if (!isObj2(sprite) || !isNonEmptyString(sprite.id)) {
          err(issues, `${label}: sprite at index ${si} has an invalid "id".`, `${spath}.id`);
          return;
        }
        const slabel = `${label}, sprite "${sprite.id}"`;
        if (spriteIds.has(sprite.id)) err(issues, `${label} has duplicate sprite id "${sprite.id}".`, `${spath}.id`);
        spriteIds.add(sprite.id);
        if (typeof sprite.name !== "string") err(issues, `${slabel} has an invalid "name".`, `${spath}.name`);
        const imageProblem = describeAssetPathProblem(sprite.image);
        if (imageProblem) err(issues, `${slabel} has an invalid "image": ${imageProblem}`, `${spath}.image`);
        validateShapes(sprite.collisions, slabel, `${spath}.collisions`, issues);
      });
      if (!isNonEmptyString(obj.defaultSpriteId) || !spriteIds.has(obj.defaultSpriteId)) {
        err(issues, `${label} has a "defaultSpriteId" that doesn't match any of its sprites.`, `${path8}.defaultSpriteId`);
      }
    }
    byId.set(obj.id, obj);
  });
  return byId;
}
export function describeAssetPathProblem(value) {
  if (!isNonEmptyString(value)) return 'expected a project-relative path like "assets/tree.png".';
  if (value.includes("..") || /^([a-zA-Z]:)?[\\/]/.test(value)) {
    return `absolute or unsafe path ("${value}"). Use a project-relative path like "assets/tree.png".`;
  }
  return null;
}
function validateShapes(shapes, label, path8, issues) {
  if (!Array.isArray(shapes)) {
    err(issues, `${label} has an invalid "collisions" (expected array).`, path8);
    return;
  }
  const ids = /* @__PURE__ */ new Set();
  shapes.forEach((shape, ci) => {
    const problem = describeShapeProblem(shape);
    if (problem) {
      err(issues, `${label}: collision shape #${ci + 1} ${problem}.`, `${path8}[${ci}]`);
      return;
    }
    const id = shape.id;
    if (ids.has(id)) err(issues, `${label} has duplicate collision shape id "${id}".`, `${path8}[${ci}].id`);
    ids.add(id);
  });
}
function validateMap(input, mi, objectsById, issues) {
  const path8 = `maps[${mi}]`;
  if (!isObj2(input)) {
    err(issues, `Map at index ${mi} is not an object.`, path8);
    return;
  }
  const label = `Map "${isNonEmptyString(input.name) ? input.name : input.id ?? mi}"`;
  if (!isNonEmptyString(input.id)) err(issues, `${label} has an invalid "id".`, `${path8}.id`);
  if (!isNonEmptyString(input.name)) err(issues, `${label} has an invalid "name".`, `${path8}.name`);
  const layerIds = validateLayers(input.layers, label, path8, issues);
  if (input.kind === "2d") validateMap2D(input, label, path8, layerIds, objectsById, issues);
  else if (input.kind === "3d") validateMap3D(input, label, path8, layerIds, objectsById, issues);
  else err(issues, `${label} has an invalid "kind" (expected "2d" or "3d").`, `${path8}.kind`);
}
function validateLayers(layers, label, path8, issues) {
  const layerIds = /* @__PURE__ */ new Set();
  if (!Array.isArray(layers)) {
    err(issues, `${label} has an invalid "layers" (expected array).`, `${path8}.layers`);
    return layerIds;
  }
  layers.forEach((layer, li) => {
    const lpath = `${path8}.layers[${li}]`;
    if (!isObj2(layer) || !isNonEmptyString(layer.id)) {
      err(issues, `${label}: layer at index ${li} has an invalid "id".`, `${lpath}.id`);
      return;
    }
    if (layerIds.has(layer.id)) err(issues, `${label} has duplicate layer id "${layer.id}".`, `${lpath}.id`);
    layerIds.add(layer.id);
    if (!isNonEmptyString(layer.name)) err(issues, `${label}: layer "${layer.id}" has an invalid "name".`, `${lpath}.name`);
    if (typeof layer.visible !== "boolean") err(issues, `${label}: layer "${layer.id}" has an invalid "visible" flag.`, `${lpath}.visible`);
    if (typeof layer.locked !== "boolean") err(issues, `${label}: layer "${layer.id}" has an invalid "locked" flag.`, `${lpath}.locked`);
  });
  return layerIds;
}
var isFiniteNumber = (v) => typeof v === "number" && Number.isFinite(v);
var TERRAIN_RESOLUTION_RANGE = { min: 2, max: 1025 };
function validateMap3D(map, label, path8, layerIds, objectsById, issues) {
  const t = map.terrain;
  const tpath = `${path8}.terrain`;
  let terrainValid = false;
  if (!isObj2(t)) {
    err(issues, `${label} is missing its "terrain".`, tpath);
  } else {
    const res = t.resolution;
    const size = t.size;
    const resOk = typeof res === "number" && Number.isInteger(res) && res >= TERRAIN_RESOLUTION_RANGE.min && res <= TERRAIN_RESOLUTION_RANGE.max;
    if (!resOk) err(issues, `${label}: "terrain.resolution" must be an integer between ${TERRAIN_RESOLUTION_RANGE.min} and ${TERRAIN_RESOLUTION_RANGE.max}.`, `${tpath}.resolution`);
    const sizeOk = isObj2(size) && isFiniteNumber(size.width) && size.width > 0 && isFiniteNumber(size.depth) && size.depth > 0;
    if (!sizeOk) err(issues, `${label}: "terrain.size" needs positive "width" and "depth" in meters.`, `${tpath}.size`);
    if (t.waterLevel !== null && !isFiniteNumber(t.waterLevel)) err(issues, `${label}: "terrain.waterLevel" must be a number or null.`, `${tpath}.waterLevel`);
    if (!Array.isArray(t.layers) || t.layers.length === 0 || t.layers.length > MAX_TERRAIN_LAYERS) {
      err(issues, `${label}: "terrain.layers" must hold 1 to ${MAX_TERRAIN_LAYERS} texture layers.`, `${tpath}.layers`);
    } else {
      const ids2 = /* @__PURE__ */ new Set();
      t.layers.forEach((layer, li) => {
        const lpath = `${tpath}.layers[${li}]`;
        if (!isObj2(layer) || !isNonEmptyString(layer.id)) {
          err(issues, `${label}: terrain layer at index ${li} has an invalid "id".`, `${lpath}.id`);
          return;
        }
        const llabel = `${label}, terrain layer "${layer.id}"`;
        if (ids2.has(layer.id)) err(issues, `${label} has duplicate terrain layer id "${layer.id}".`, `${lpath}.id`);
        ids2.add(layer.id);
        if (!isNonEmptyString(layer.name)) err(issues, `${llabel} has an invalid "name".`, `${lpath}.name`);
        if (!isHexColor(layer.color)) err(issues, `${llabel}: "color" must be "#rrggbb".`, `${lpath}.color`);
        if (!isFiniteNumber(layer.tileSize) || layer.tileSize <= 0) err(issues, `${llabel}: "tileSize" must be a positive number of meters.`, `${lpath}.tileSize`);
        if (layer.texture !== void 0) {
          const problem = describeAssetPathProblem(layer.texture);
          if (problem) err(issues, `${llabel} has an invalid "texture": ${problem}`, `${lpath}.texture`);
        }
      });
    }
    if (resOk) {
      const n = res * res;
      if (!(t.heights instanceof Float32Array) || t.heights.length !== n) {
        err(issues, `${label}: terrain heights must hold resolution\xB2 = ${n} samples.`, `${tpath}.heights`);
      } else if (!t.heights.every(Number.isFinite)) {
        err(issues, `${label}: terrain heights contain non-finite values.`, `${tpath}.heights`);
      }
      if (!(t.splat instanceof Uint8Array) || t.splat.length !== n * 4) {
        err(issues, `${label}: terrain splat must hold resolution\xB2 \xD7 4 = ${n * 4} weights.`, `${tpath}.splat`);
      }
      if (!(t.details instanceof Uint8Array) || t.details.length !== n * 4) {
        err(issues, `${label}: terrain details must hold resolution\xB2 \xD7 4 = ${n * 4} densities.`, `${tpath}.details`);
      }
    }
    if (!Array.isArray(t.detailLayers) || t.detailLayers.length > MAX_DETAIL_LAYERS) {
      err(issues, `${label}: "terrain.detailLayers" must be an array of at most ${MAX_DETAIL_LAYERS} layers.`, `${tpath}.detailLayers`);
    } else {
      const ids2 = /* @__PURE__ */ new Set();
      t.detailLayers.forEach((layer, li) => {
        const lpath = `${tpath}.detailLayers[${li}]`;
        if (!isObj2(layer) || !isNonEmptyString(layer.id)) {
          err(issues, `${label}: detail layer at index ${li} has an invalid "id".`, `${lpath}.id`);
          return;
        }
        const llabel = `${label}, detail layer "${layer.id}"`;
        if (ids2.has(layer.id)) err(issues, `${label} has duplicate detail layer id "${layer.id}".`, `${lpath}.id`);
        ids2.add(layer.id);
        if (!isNonEmptyString(layer.name)) err(issues, `${llabel} has an invalid "name".`, `${lpath}.name`);
        if (!isHexColor(layer.color)) err(issues, `${llabel}: "color" must be "#rrggbb".`, `${lpath}.color`);
        for (const key of ["width", "height"]) {
          if (!isFiniteNumber(layer[key]) || layer[key] <= 0) err(issues, `${llabel}: "${key}" must be a positive number of meters.`, `${lpath}.${key}`);
        }
        if (!isFiniteNumber(layer.density) || layer.density < 0) err(issues, `${llabel}: "density" must be \u2265 0 (tufts per m\xB2).`, `${lpath}.density`);
        if (!isFiniteNumber(layer.sizeVariation) || layer.sizeVariation < 0 || layer.sizeVariation > 1) {
          err(issues, `${llabel}: "sizeVariation" must be between 0 and 1.`, `${lpath}.sizeVariation`);
        }
        if (layer.sprite !== void 0) {
          const problem = describeAssetPathProblem(layer.sprite);
          if (problem) err(issues, `${llabel} has an invalid "sprite": ${problem}`, `${lpath}.sprite`);
        }
        if (layer.model !== void 0) {
          const problem = describeAssetPathProblem(layer.model);
          if (problem) err(issues, `${llabel} has an invalid "model": ${problem}`, `${lpath}.model`);
          else if (!/\.glb$/i.test(layer.model)) err(issues, `${llabel}: "model" must be a .glb file.`, `${lpath}.model`);
        }
      });
    }
    terrainValid = resOk && sizeOk;
  }
  if (!Array.isArray(map.waters)) {
    err(issues, `${label} has an invalid "waters" (expected array, possibly empty).`, `${path8}.waters`);
  } else {
    const waterIds = /* @__PURE__ */ new Set();
    map.waters.forEach((w, i) => {
      const wpath = `${path8}.waters[${i}]`;
      if (!isObj2(w) || !isNonEmptyString(w.id)) {
        err(issues, `${label}: waters[${i}] has an invalid "id".`, `${wpath}.id`);
        return;
      }
      const wlabel = `${label}, water "${w.id}"`;
      if (waterIds.has(w.id)) err(issues, `${label} has duplicate water id "${w.id}".`, `${wpath}.id`);
      waterIds.add(w.id);
      if (!isNonEmptyString(w.name)) err(issues, `${wlabel} has an invalid "name".`, `${wpath}.name`);
      for (const key of ["x", "z", "level"]) {
        if (!isFiniteNumber(w[key])) err(issues, `${wlabel} has an invalid "${key}".`, `${wpath}.${key}`);
      }
      if (w.color !== void 0 && !isHexColor(w.color)) err(issues, `${wlabel}: "color" must be "#rrggbb".`, `${wpath}.color`);
      if (w.area !== void 0) {
        const a = w.area;
        if (!isObj2(a) || ![a.x, a.z, a.width, a.depth].every(isFiniteNumber) || !(a.width > 0) || !(a.depth > 0)) {
          err(issues, `${wlabel}: "area" needs numbers x, z and positive width, depth.`, `${wpath}.area`);
        }
      }
    });
  }
  if (!Array.isArray(map.placements)) {
    err(issues, `${label} has an invalid "placements" (expected array).`, `${path8}.placements`);
    return;
  }
  const ids = /* @__PURE__ */ new Set();
  const terrain = t;
  map.placements.forEach((pl, i) => {
    const ppath = `${path8}.placements[${i}]`;
    if (!isObj2(pl) || !isNonEmptyString(pl.id)) {
      err(issues, `${label}: placements[${i}] has an invalid "id".`, `${ppath}.id`);
      return;
    }
    const plabel = `${label}: placement "${pl.id}"`;
    if (ids.has(pl.id)) err(issues, `${label} has duplicate placement id "${pl.id}".`, `${ppath}.id`);
    ids.add(pl.id);
    const def = typeof pl.objectId === "string" ? objectsById.get(pl.objectId) : void 0;
    if (!def) err(issues, `${plabel} references unknown objectId "${pl.objectId}".`, `${ppath}.objectId`);
    if (typeof pl.layerId !== "string" || !layerIds.has(pl.layerId)) err(issues, `${plabel} references unknown layerId "${pl.layerId}".`, `${ppath}.layerId`);
    for (const key of ["x", "z", "elevation", "rotation"]) {
      if (!isFiniteNumber(pl[key])) err(issues, `${plabel} has an invalid "${key}".`, `${ppath}.${key}`);
    }
    if (!isFiniteNumber(pl.scale) || pl.scale <= 0) err(issues, `${plabel} has an invalid "scale" (positive number).`, `${ppath}.scale`);
    if (terrainValid && isFiniteNumber(pl.x) && isFiniteNumber(pl.z)) {
      if (pl.x < 0 || pl.z < 0 || pl.x > terrain.size.width || pl.z > terrain.size.depth) {
        err(issues, `${plabel} at (${pl.x}, ${pl.z}) is outside the terrain.`, ppath);
      }
    }
    if (def && pl.spriteId !== void 0 && !def.sprites?.some((sp) => sp.id === pl.spriteId)) {
      err(issues, `${plabel} uses sprite "${pl.spriteId}", which object "${def.id}" doesn't have.`, `${ppath}.spriteId`);
    }
  });
}
function validateMap2D(map, label, path8, layerIds, objectsById, issues) {
  const s = map.settings;
  let settingsValid = isObj2(s);
  if (!isObj2(s)) {
    err(issues, `${label} is missing its "settings" object.`, `${path8}.settings`);
  } else {
    for (const key of ["width", "height", "tileWidth", "tileHeight"]) {
      if (!isPositiveInt(s[key])) {
        err(issues, `${label}: "settings.${key}" must be a positive integer.`, `${path8}.settings.${key}`);
        settingsValid = false;
      }
    }
  }
  if (!Array.isArray(map.mapping)) {
    err(issues, `${label} has an invalid "mapping" (expected array).`, `${path8}.mapping`);
    return;
  }
  const occupancy = /* @__PURE__ */ new Map();
  map.mapping.forEach((inst, i) => {
    const ipath = `${path8}.mapping[${i}]`;
    if (!isObj2(inst)) {
      err(issues, `${label}: mapping[${i}] is not an object.`, ipath);
      return;
    }
    const def = typeof inst.objectId === "string" ? objectsById.get(inst.objectId) : void 0;
    if (!def) err(issues, `${label}: mapping[${i}] references unknown objectId "${inst.objectId}".`, `${ipath}.objectId`);
    else if (def.kind === "3d") err(issues, `${label}: mapping[${i}] places 3D object "${def.id}", which only fits on 3D maps.`, `${ipath}.objectId`);
    const validLayer = typeof inst.layerId === "string" && layerIds.has(inst.layerId);
    if (!validLayer) err(issues, `${label}: mapping[${i}] references unknown layerId "${inst.layerId}".`, `${ipath}.layerId`);
    const validX = typeof inst.x === "number" && Number.isInteger(inst.x) && inst.x >= 0;
    const validY = typeof inst.y === "number" && Number.isInteger(inst.y) && inst.y >= 0;
    if (!validX) err(issues, `${label}: mapping[${i}] has an invalid "x" coordinate.`, `${ipath}.x`);
    if (!validY) err(issues, `${label}: mapping[${i}] has an invalid "y" coordinate.`, `${ipath}.y`);
    if (def && inst.spriteId !== void 0 && !def.sprites?.some((sp) => sp.id === inst.spriteId)) {
      err(issues, `${label}: mapping[${i}] uses sprite "${inst.spriteId}", which object "${def.id}" doesn't have.`, `${ipath}.spriteId`);
    }
    if (!def || !validLayer || !validX || !validY) return;
    const size = getObjectSize(def);
    if (settingsValid && s && !isFootprintInBounds(inst.x, inst.y, size, s)) {
      err(
        issues,
        `${label}: mapping[${i}] at (${inst.x}, ${inst.y}) with size ${size.width}x${size.height} extends out of map bounds.`,
        ipath
      );
    }
    for (const cell of footprintCells(inst.x, inst.y, size)) {
      const key = `${inst.layerId}:${cell.x}:${cell.y}`;
      const existing = occupancy.get(key);
      if (existing !== void 0) {
        err(issues, `${label}: mapping[${i}] overlaps mapping[${existing}] on layer "${inst.layerId}" at cell (${cell.x}, ${cell.y}).`, ipath);
      } else {
        occupancy.set(key, i);
      }
    }
  });
}
export function isKreaProjectShape(input: unknown): input is import("./map-types").KreaProject {
  return isObj2(input) && input.format === KREA_FORMAT && Array.isArray(input.objects) && Array.isArray(input.maps) && input.maps.length > 0;
}

