import type { KreaProjectJson } from "@core/project-codec";
import type { ValidationIssue } from "@core/map-validator";

export interface ProjectInfo {
  /** The .krea archive the project is saved to (holds the project JSON and every image). */
  file: string;
  name: string;
}

export interface OpenProjectResponse {
  info: ProjectInfo;
  project: KreaProjectJson;
  issues: ValidationIssue[];
  /** Set when the project was converted from a legacy file (e.g. "map.json") and hasn't been saved as .krea yet. */
  migratedFrom: string | null;
}

export interface NewProjectResponse {
  info: ProjectInfo;
  project: KreaProjectJson;
}

export interface GetProjectDataResponse {
  project: KreaProjectJson;
  issues: ValidationIssue[];
}

export interface SaveProjectResponse {
  ok: true;
}

export interface ValidateResponse {
  valid: boolean;
  issues: ValidationIssue[];
}

export interface ProjectAssetsResponse {
  assets: string[];
}

export interface ImportAssetResponse {
  path: string;
}

export interface ExportRequestOptions {
  mapId: string;
  /** A .json file path, or a folder (the file is then named after the map id). */
  destination: string;
  overwrite?: boolean;
  /** Copy the images/models next to the exported file so it's self-contained. Defaults to true. */
  copyAssets?: boolean;
}

export interface ExportResponse {
  file: string;
  /** 3D maps: the terrain files written next to the JSON (heights, splat, mesh). */
  terrainFiles?: string[];
  assetsCopied: string[];
  assetsSkipped: string[];
}

export interface ApiErrorBody {
  error: string;
  issues?: ValidationIssue[];
}
