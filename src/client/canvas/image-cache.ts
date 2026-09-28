import { assetUrl } from "../net/client";

interface ImageEntry {
  status: "loading" | "loaded" | "error";
  img?: HTMLImageElement;
}

const cache = new Map<string, ImageEntry>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of listeners) fn();
}

export function subscribeImageCache(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getCachedImage(path: string): ImageEntry | undefined {
  return cache.get(path);
}

export function ensureImageLoaded(path: string): void {
  if (cache.has(path)) return;
  const entry: ImageEntry = { status: "loading" };
  cache.set(path, entry);
  const img = new Image();
  img.onload = () => {
    cache.set(path, { status: "loaded", img });
    notify();
  };
  img.onerror = () => {
    cache.set(path, { status: "error" });
    notify();
  };
  img.src = assetUrl(path);
}

const clearHooks = new Set<() => void>();

/** Lets other asset caches (e.g. the lazily-loaded 3D view's) clear along with this one. */
export function onImageCacheClear(hook: () => void): void {
  clearHooks.add(hook);
}

export function clearImageCache(): void {
  cache.clear();
  clearHooks.forEach((hook) => hook());
  notify();
}
