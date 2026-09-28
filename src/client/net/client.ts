import type { KreaProject } from "@core/map-types";
import { projectFromWire, projectToWire } from "@core/project-codec";
import type {
  ApiErrorBody,
  ExportRequestOptions,
  ExportResponse,
  ImportAssetResponse,
  NewProjectResponse,
  OpenProjectResponse,
  ProjectAssetsResponse,
  SaveProjectResponse,
} from "@shared/api-types";

export class ApiError extends Error {
  issues?: ApiErrorBody["issues"];
  constructor(message: string, issues?: ApiErrorBody["issues"]) {
    super(message);
    this.issues = issues;
  }
}

let editorProjectPath: string | null = null;

async function parseResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: res.statusText }))) as ApiErrorBody;
    throw new ApiError(body.error, body.issues);
  }
  return res.json() as Promise<T>;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { "Content-Type": "application/json", ...(editorProjectPath && path.startsWith("/api/project/") ? { "X-Krea-Project-Path": editorProjectPath } : {}), ...init?.headers } });
  return parseResponse<T>(res);
}

/** Projects travel as JSON with 3D terrain arrays in base64; in memory they're typed arrays. */
function decode(project: unknown): KreaProject {
  return projectFromWire(project) as KreaProject;
}

function encode(project: KreaProject): string {
  return JSON.stringify(projectToWire(project));
}

export type Decoded<T> = Omit<T, "project"> & { project: KreaProject };

export async function openProject(path: string): Promise<Decoded<OpenProjectResponse>> {
  const res = await request<OpenProjectResponse>("/api/project/open", { method: "POST", body: JSON.stringify({ path }) });
  editorProjectPath = res.info.file;
  return { ...res, project: decode(res.project) };
}

export type NewProjectParams =
  | { path: string; name: string; kind: "2d"; width: number; height: number; tileWidth: number; tileHeight: number }
  | { path: string; name: string; kind: "3d"; width: number; depth: number; resolution: number };

export async function createProject(params: NewProjectParams): Promise<Decoded<NewProjectResponse>> {
  const res = await request<NewProjectResponse>("/api/project/new", { method: "POST", body: JSON.stringify(params) });
  editorProjectPath = res.info.file;
  return { ...res, project: decode(res.project) };
}

export function saveProject(project: KreaProject): Promise<SaveProjectResponse> {
  return request("/api/project/data", { method: "PUT", body: `{"project":${encode(project)}}` });
}

export function fetchProjectAssets(): Promise<ProjectAssetsResponse> {
  return request("/api/project/assets");
}

export async function importAsset(file: File): Promise<ImportAssetResponse> {
  const formData = new FormData();
  formData.append("file", file);
  return parseResponse(await fetch("/api/project/import-asset", { method: "POST", body: formData, headers: editorProjectPath ? { "X-Krea-Project-Path": editorProjectPath } : undefined }));
}

export function exportMap(project: KreaProject, options: ExportRequestOptions): Promise<ExportResponse> {
  return request("/api/project/export", { method: "POST", body: JSON.stringify({ project: projectToWire(project), ...options }) });
}

/** Writes the project as a folder: project.json + assets/… + maps/… (same layout as inside the .krea). */
export function unpackProject(project: KreaProject, destination: string, overwrite: boolean): Promise<{ folder: string; files: string[] }> {
  return request("/api/project/unpack", { method: "POST", body: JSON.stringify({ project: projectToWire(project), destination, overwrite }) });
}

export function pickFolder(): Promise<{ path: string | null }> {
  return request("/api/system/pick-folder", { method: "POST" });
}

export function pickProjectToOpen(): Promise<{ path: string | null }> {
  return request("/api/system/pick-project", { method: "POST" });
}

export function pickProjectToCreate(defaultName: string): Promise<{ path: string | null }> {
  return request("/api/system/pick-new-project", { method: "POST", body: JSON.stringify({ defaultName }) });
}

export function assetUrl(relativePath: string): string {
  const base = `/api/assets/${relativePath.replace(/^\/+/, "")}`;
  return editorProjectPath ? `${base}?projectPath=${encodeURIComponent(editorProjectPath)}` : base;
}
