export interface RecentProject {
  path: string;
  name: string;
  openedAt: number;
}

const STORAGE_KEY = "krea.recent-projects.v1";
const MAX_RECENT = 8;

export function getRecentProjects(): RecentProject[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(value)
      ? value.filter((item): item is RecentProject =>
          !!item && typeof item.path === "string" && typeof item.name === "string" && typeof item.openedAt === "number")
        .sort((a, b) => b.openedAt - a.openedAt).slice(0, MAX_RECENT)
      : [];
  } catch {
    return [];
  }
}

export function rememberRecentProject(path: string, name: string): void {
  try {
    const normalized = path.trim();
    const entries = getRecentProjects().filter((item) => item.path.toLowerCase() !== normalized.toLowerCase());
    localStorage.setItem(STORAGE_KEY, JSON.stringify([{ path: normalized, name, openedAt: Date.now() }, ...entries].slice(0, MAX_RECENT)));
    window.dispatchEvent(new Event("krea:recent-projects"));
  } catch {
    // The editor still works when browser storage is unavailable.
  }
}

export function forgetRecentProject(path: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(getRecentProjects().filter((item) => item.path !== path)));
    window.dispatchEvent(new Event("krea:recent-projects"));
  } catch {
    // Ignore unavailable browser storage.
  }
}
