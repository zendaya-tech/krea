import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { assetUrl } from "../net/client";
import { onImageCacheClear } from "../canvas/image-cache";

/**
 * Loaded Three.js assets, keyed by project asset path and shared by every 3D
 * view. Cleared when a project is opened/closed (clearThreeCache).
 */

const textures = new Map<string, { texture: THREE.Texture | null; promise: Promise<THREE.Texture | null> }>();
const models = new Map<string, Promise<THREE.Object3D | null>>();
const loader = new GLTFLoader();

/** A texture (sRGB, repeating). Returns the loaded texture, or null while it loads; `onReady` fires once loaded. */
export function getTexture(path: string, options: { pixelArt?: boolean; onReady?: () => void } = {}): THREE.Texture | null {
  const cached = textures.get(path);
  if (cached) {
    if (!cached.texture && options.onReady) void cached.promise.then(() => options.onReady!());
    return cached.texture;
  }
  const entry: { texture: THREE.Texture | null; promise: Promise<THREE.Texture | null> } = { texture: null, promise: Promise.resolve(null) };
  entry.promise = new THREE.TextureLoader()
    .loadAsync(assetUrl(path))
    .then((tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.anisotropy = 8;
      if (options.pixelArt) {
        tex.magFilter = THREE.NearestFilter;
        tex.minFilter = THREE.NearestMipmapLinearFilter;
      }
      entry.texture = tex;
      return tex;
    })
    .catch(() => null);
  textures.set(path, entry);
  if (options.onReady) void entry.promise.then(() => options.onReady!());
  return null;
}

export function loadTexture(path: string, pixelArt = false): Promise<THREE.Texture | null> {
  getTexture(path, { pixelArt });
  return textures.get(path)!.promise;
}

/** A .glb model's scene; clone it per placement. */
export function loadModel(path: string): Promise<THREE.Object3D | null> {
  let promise = models.get(path);
  if (!promise) {
    promise = fetch(assetUrl(path))
      .then((res) => (res.ok ? res.arrayBuffer() : Promise.reject(new Error(res.statusText))))
      .then((buffer) => loader.parseAsync(buffer, ""))
      .then((gltf) => {
        gltf.scene.traverse((o) => {
          if ((o as THREE.Mesh).isMesh) {
            o.castShadow = true;
            o.receiveShadow = true;
          }
        });
        return gltf.scene as THREE.Object3D;
      })
      .catch(() => null);
    models.set(path, promise);
  }
  return promise;
}

export function clearThreeCache(): void {
  for (const entry of textures.values()) entry.texture?.dispose();
  textures.clear();
  models.clear();
}

onImageCacheClear(clearThreeCache);
