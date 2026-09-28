import * as THREE from "three";
import type { TerrainData } from "@core/map-types";
import { MAX_TERRAIN_LAYERS } from "@core/map-types";

/**
 * Terrain shader: blends up to 4 texture layers by the splatmap (like Unity's
 * terrain), lit by one sun, with an optional world grid and the brush ring
 * drawn directly on the surface.
 */

const vertexShader = /* glsl */ `
  uniform vec2 uSize;
  uniform float uRes;
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying vec2 vSplatUv;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    vNormal = normalize(mat3(modelMatrix) * normal);
    vSplatUv = (position.xz / uSize * (uRes - 1.0) + 0.5) / uRes;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const fragmentShader = /* glsl */ `
  uniform sampler2D uSplat;
  uniform sampler2D uTex0;
  uniform sampler2D uTex1;
  uniform sampler2D uTex2;
  uniform sampler2D uTex3;
  uniform vec3 uColor0;
  uniform vec3 uColor1;
  uniform vec3 uColor2;
  uniform vec3 uColor3;
  uniform vec4 uUseTex;
  uniform vec4 uTile;
  uniform float uLayerCount;
  uniform vec3 uSunDir;
  uniform float uShowGrid;
  uniform float uGridSpacing;
  uniform vec3 uBrush;
  uniform float uBrushVisible;
  uniform vec3 uBrushColor;
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying vec2 vSplatUv;

  vec3 layer(sampler2D tex, vec3 color, float useTex, float tile) {
    vec3 t = texture2D(tex, vWorld.xz / tile).rgb;
    return mix(color, t, useTex);
  }

  void main() {
    vec4 w = texture2D(uSplat, vSplatUv);
    w *= step(vec4(0.5, 1.5, 2.5, 3.5), vec4(uLayerCount));
    float sum = w.x + w.y + w.z + w.w;
    if (sum < 1e-4) { w = vec4(1.0, 0.0, 0.0, 0.0); sum = 1.0; }
    w /= sum;
    vec3 c = w.x * layer(uTex0, uColor0, uUseTex.x, uTile.x)
           + w.y * layer(uTex1, uColor1, uUseTex.y, uTile.y)
           + w.z * layer(uTex2, uColor2, uUseTex.z, uTile.z)
           + w.w * layer(uTex3, uColor3, uUseTex.w, uTile.w);
    vec3 n = normalize(vNormal);
    float diffuse = max(dot(n, normalize(uSunDir)), 0.0);
    c *= 0.38 + 0.8 * diffuse;

    if (uShowGrid > 0.5) {
      vec2 g = vWorld.xz / uGridSpacing;
      vec2 d = abs(fract(g - 0.5) - 0.5) / fwidth(g);
      float line = 1.0 - min(min(d.x, d.y), 1.0);
      c = mix(c, vec3(1.0), line * 0.35);
    }

    if (uBrushVisible > 0.5) {
      float dist = distance(vWorld.xz, uBrush.xy);
      float ring = 1.0 - smoothstep(0.0, fwidth(dist) * 1.8, abs(dist - uBrush.z));
      c = mix(c, uBrushColor, ring * 0.9);
      c = mix(c, uBrushColor, 0.1 * step(dist, uBrush.z));
    }

    gl_FragColor = vec4(c, 1.0);
    #include <colorspace_fragment>
  }
`;

const WHITE = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
WHITE.needsUpdate = true;

export const SUN_DIRECTION = new THREE.Vector3(-0.45, 0.8, 0.35).normalize();

export function createTerrainMaterial(terrain: TerrainData, splat: THREE.DataTexture): THREE.ShaderMaterial {
  const uniforms: Record<string, THREE.IUniform> = {
    uSize: { value: new THREE.Vector2(terrain.size.width, terrain.size.depth) },
    uRes: { value: terrain.resolution },
    uSplat: { value: splat },
    uUseTex: { value: new THREE.Vector4() },
    uTile: { value: new THREE.Vector4(4, 4, 4, 4) },
    uLayerCount: { value: terrain.layers.length },
    uSunDir: { value: SUN_DIRECTION.clone() },
    uShowGrid: { value: 0 },
    uGridSpacing: { value: 10 },
    uBrush: { value: new THREE.Vector3() },
    uBrushVisible: { value: 0 },
    uBrushColor: { value: new THREE.Color("#ffd23f") },
  };
  for (let i = 0; i < MAX_TERRAIN_LAYERS; i++) {
    uniforms[`uTex${i}`] = { value: WHITE };
    uniforms[`uColor${i}`] = { value: new THREE.Color("#808080") };
  }
  return new THREE.ShaderMaterial({ uniforms, vertexShader, fragmentShader });
}

export function createSplatTexture(terrain: TerrainData): THREE.DataTexture {
  const tex = new THREE.DataTexture(terrain.splat, terrain.resolution, terrain.resolution, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** Points the shader at the current layer colors/textures (textures resolved by `getTexture`, may be null while loading). */
export function applyTerrainLayers(
  material: THREE.ShaderMaterial,
  terrain: TerrainData,
  getTexture: (path: string) => THREE.Texture | null,
): void {
  const u = material.uniforms;
  u.uLayerCount.value = terrain.layers.length;
  const useTex = u.uUseTex.value as THREE.Vector4;
  const tile = u.uTile.value as THREE.Vector4;
  for (let i = 0; i < MAX_TERRAIN_LAYERS; i++) {
    const layer = terrain.layers[i];
    const tex = layer?.texture ? getTexture(layer.texture) : null;
    u[`uTex${i}`].value = tex ?? WHITE;
    (u[`uColor${i}`].value as THREE.Color).set(layer?.color ?? "#808080");
    useTex.setComponent(i, tex ? 1 : 0);
    tile.setComponent(i, layer?.tileSize ?? 4);
  }
}
