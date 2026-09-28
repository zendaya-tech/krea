import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import type { KreaProject, Map3D, MapObjectDefinition, Placement3D, TerrainData } from "@core/map-types";
import { getSprite } from "@core/map-utils";
import type { TerrainPatch } from "@core/history";
import {
  SPLAT_CHANNELS,
  extractRegion,
  heightAt,
  paintDab,
  sampleSpacing,
  sculptDab,
  unionRegion,
  type SculptMode,
  type TerrainRegion,
} from "@core/terrain";
import { MARKER_SIZE, billboardSize } from "@core/placement-geometry";
import { applyTerrainLayers, createSplatTexture, createTerrainMaterial, SUN_DIRECTION } from "./terrain-material";
import { getTexture, loadModel, loadTexture } from "./asset-cache";
import { buildWaterGroup, disposeWaterGroup } from "./water-mesh";
import { buildDetailLayer, disposeDetailGroup, windUniform } from "./details-mesh";
import { buildWaterIndex } from "@core/water";

/**
 * The 3D map editor's scene, driven imperatively (outside React) like the 2D
 * CanvasRenderer. Map3DView feeds it the store's state with update() and
 * receives user intents through the callbacks.
 *
 * Mouse: left = current tool, right-drag = orbit, middle-drag = pan, wheel = zoom.
 */

export interface Scene3DState {
  project: KreaProject;
  map: Map3D;
  tool: "select" | "place" | "sculpt" | "paint" | "water";
  sculptMode: SculptMode;
  brush: { radius: number; strength: number };
  placeScatter: boolean;
  placeRadius: number;
  paintLayerId: string | null;
  transformMode: "translate" | "rotate" | "scale";
  selectedPlacementIds: string[];
  showGrid: boolean;
  showCollisions: boolean;
}

export interface Scene3DCallbacks {
  onHover: (point: { x: number; y: number; z: number } | null) => void;
  onSelect: (placementId: string | null, additive: boolean) => void;
  onPlace: (x: number, z: number) => void;
  /** Water tool: a click in a basin. */
  onAddWater: (x: number, z: number) => void;
  onTerrainStroke: (patch: TerrainPatch, label: string) => void;
  onTransform: (updates: Array<{ id: string; x: number; z: number; elevation: number; rotation: number; scale: number }>) => void;
}

interface PlacementView {
  group: THREE.Group;
  placement: Placement3D;
  def: MapObjectDefinition | undefined;
  /** Rebuild key: what the visual depends on besides the transform. */
  key: string;
  billboard: THREE.Mesh | null;
  box: THREE.LineSegments;
}

const SELECT_COLOR = new THREE.Color("#ffd23f");
const COLLISION_COLOR = new THREE.Color("#ff6060");

export class Scene3D {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private orbit: OrbitControls;
  private gizmo: TransformControls;
  private gizmoHelper: THREE.Object3D;
  private terrainMesh: THREE.Mesh;
  private terrainGeometry: THREE.BufferGeometry;
  private terrainMaterial: THREE.ShaderMaterial;
  private splatTexture: THREE.DataTexture;
  private water = new THREE.Group();
  private details = new THREE.Group();
  private objects = new THREE.Group();
  private views = new Map<string, PlacementView>();
  private raycaster = new THREE.Raycaster();
  private frame = 0;
  private disposed = false;
  private resizeObserver: ResizeObserver;

  private state: Scene3DState;
  /** Terrain the geometry currently shows (a working copy during a stroke). */
  private shownTerrain: TerrainData;
  private pointer: { x: number; y: number } | null = null;
  private hover: THREE.Vector3 | null = null;
  private stroke: {
    original: TerrainData;
    working: TerrainData;
    region: TerrainRegion | null;
    flattenHeight: number;
    label: string;
  } | null = null;
  private gizmoDragging = false;
  private lastScale = 1;

  constructor(
    private container: HTMLElement,
    initial: Scene3DState,
    private callbacks: Scene3DCallbacks,
  ) {
    this.state = initial;
    this.shownTerrain = initial.map.terrain;
    const t = initial.map.terrain;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = false;
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.className = "scene3d-canvas";

    this.scene.background = new THREE.Color("#9ec4e8");
    const span = Math.max(t.size.width, t.size.depth);
    this.scene.fog = new THREE.Fog("#9ec4e8", span * 1.5, span * 5);
    this.scene.add(new THREE.HemisphereLight("#dfefff", "#4d5a3a", 1.4));
    const sun = new THREE.DirectionalLight("#fff4e0", 2.2);
    sun.position.copy(SUN_DIRECTION).multiplyScalar(100);
    this.scene.add(sun);

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, span * 20);
    const center = new THREE.Vector3(t.size.width / 2, 0, t.size.depth / 2);
    center.y = heightAt(t, center.x, center.z);
    const dist = span * 0.9;
    this.camera.position.set(center.x + dist * 0.55, center.y + dist * 0.6, center.z + dist * 0.55);

    // Terrain
    this.terrainGeometry = buildTerrainGeometry(t);
    this.splatTexture = createSplatTexture(t);
    this.terrainMaterial = createTerrainMaterial(t, this.splatTexture);
    this.terrainMesh = new THREE.Mesh(this.terrainGeometry, this.terrainMaterial);
    this.scene.add(this.terrainMesh);

    this.scene.add(this.objects);

    // Controls
    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbit.target.copy(center);
    this.orbit.mouseButtons = { LEFT: -1 as THREE.MOUSE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
    this.orbit.enableDamping = true;
    this.orbit.zoomToCursor = true;
    this.orbit.maxPolarAngle = Math.PI * 0.49;
    this.orbit.update();

    this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
    this.gizmo.setSize(0.9);
    this.gizmoHelper = this.gizmo.getHelper();
    this.scene.add(this.gizmoHelper);
    this.gizmo.addEventListener("dragging-changed", (e) => {
      const dragging = (e as unknown as { value: boolean }).value;
      this.orbit.enabled = !dragging;
      this.gizmoDragging = dragging;
      if (dragging) this.lastScale = this.gizmo.object?.scale.x ?? 1;
      else this.commitGizmo();
    });
    this.gizmo.addEventListener("objectChange", () => {
      const obj = this.gizmo.object;
      if (!obj || this.state.transformMode !== "scale") return;
      // Uniform scale: follow whichever axis the user dragged.
      const s = obj.scale;
      const comps = [s.x, s.y, s.z];
      const changed = comps.reduce((best, v) => (Math.abs(v - this.lastScale) > Math.abs(best - this.lastScale) ? v : best), this.lastScale);
      s.setScalar(Math.max(0.05, changed));
      this.lastScale = s.x;
    });

    const dom = this.renderer.domElement;
    dom.addEventListener("pointerdown", this.onPointerDown);
    dom.addEventListener("pointermove", this.onPointerMove);
    dom.addEventListener("pointerleave", this.onPointerLeave);
    window.addEventListener("pointerup", this.onPointerUp);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();

    this.applyTerrain(t, true);
    this.syncPlacements();
    this.syncOverlays();
    this.loop();
  }

  update(next: Scene3DState): void {
    const prev = this.state;
    this.state = next;
    if (!this.stroke && next.map.terrain !== prev.map.terrain) {
      const sameShape = next.map.terrain.resolution === prev.map.terrain.resolution;
      this.applyTerrain(next.map.terrain, !sameShape || next.map.terrain.size !== prev.map.terrain.size);
    } else if (next.map.waters !== prev.map.waters) {
      this.rebuildWater();
      this.rebuildDetails();
    }
    if (next.map !== prev.map || next.project.objects !== prev.project.objects || next.selectedPlacementIds !== prev.selectedPlacementIds) {
      this.syncPlacements();
    }
    this.syncOverlays();
  }

  /** Centers the orbit on the selection (or the whole terrain). */
  frameSelection(): void {
    const t = this.shownTerrain;
    const selected = this.state.selectedPlacementIds.map((id) => this.views.get(id)).filter((v): v is PlacementView => !!v);
    const box = new THREE.Box3();
    if (selected.length > 0) selected.forEach((v) => box.expandByObject(v.group));
    else box.set(new THREE.Vector3(0, 0, 0), new THREE.Vector3(t.size.width, 0, t.size.depth));
    const center = box.getCenter(new THREE.Vector3());
    const size = Math.max(4, box.getSize(new THREE.Vector3()).length());
    const dir = this.camera.position.clone().sub(this.orbit.target).normalize();
    this.orbit.target.copy(center);
    this.camera.position.copy(center).addScaledVector(dir, size * 1.4);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    const dom = this.renderer.domElement;
    dom.removeEventListener("pointerdown", this.onPointerDown);
    dom.removeEventListener("pointermove", this.onPointerMove);
    dom.removeEventListener("pointerleave", this.onPointerLeave);
    window.removeEventListener("pointerup", this.onPointerUp);
    this.gizmo.detach();
    this.gizmo.dispose();
    this.orbit.dispose();
    this.terrainGeometry.dispose();
    this.terrainMaterial.dispose();
    this.splatTexture.dispose();
    disposeWaterGroup(this.water);
    this.details.children.forEach((c) => disposeDetailGroup(c as THREE.Group));
    for (const view of this.views.values()) disposeGroup(view.group);
    this.renderer.dispose();
    dom.remove();
  }

  // ---- Terrain ----

  private applyTerrain(t: TerrainData, rebuild: boolean): void {
    this.shownTerrain = t;
    if (rebuild) {
      this.terrainGeometry.dispose();
      this.terrainGeometry = buildTerrainGeometry(t);
      this.terrainMesh.geometry = this.terrainGeometry;
      this.splatTexture.dispose();
      this.splatTexture = createSplatTexture(t);
      this.terrainMaterial.uniforms.uSplat.value = this.splatTexture;
      this.terrainMaterial.uniforms.uSize.value.set(t.size.width, t.size.depth);
      this.terrainMaterial.uniforms.uRes.value = t.resolution;
    } else {
      writeHeights(this.terrainGeometry, t, { x0: 0, z0: 0, w: t.resolution, h: t.resolution });
      this.splatTexture.image.data = t.splat;
      this.splatTexture.needsUpdate = true;
    }
    applyTerrainLayers(this.terrainMaterial, t, (path) => getTexture(path, { onReady: () => this.refreshLayers() }));
    this.rebuildWater();
    this.rebuildDetails();
    this.refreshPlacementHeights();
  }

  /** Regenerates the grass/flower tufts (all layers, or one while it's being painted). */
  private rebuildDetails(onlyLayerId?: string): void {
    const t = this.shownTerrain;
    const water = buildWaterIndex({ terrain: t, waters: this.state.map.waters });
    const isWet = (x: number, z: number) => water.surfaceAt(x, z) !== null;
    if (!onlyLayerId) {
      this.scene.remove(this.details);
      this.details.children.forEach((c) => disposeDetailGroup(c as THREE.Group));
      this.details = new THREE.Group();
      this.scene.add(this.details);
    }
    t.detailLayers.forEach((layer, i) => {
      if (onlyLayerId && layer.id !== onlyLayerId) return;
      const old = this.details.children.find((c) => c.userData.detailLayerId === layer.id) as THREE.Group | undefined;
      if (old) {
        this.details.remove(old);
        disposeDetailGroup(old);
      }
      this.details.add(buildDetailLayer(t, layer, i, isWet, () => undefined));
    });
  }

  /** Water depends on both the terrain (basins, depth) and the water settings. */
  private rebuildWater(): void {
    this.scene.remove(this.water);
    disposeWaterGroup(this.water);
    this.water = buildWaterGroup({ ...this.state.map, terrain: this.shownTerrain });
    this.scene.add(this.water);
  }

  private refreshLayers(): void {
    if (this.disposed) return;
    applyTerrainLayers(this.terrainMaterial, this.shownTerrain, (path) => getTexture(path));
  }

  private beginStroke(): void {
    const original = this.state.map.terrain;
    const tool = this.state.tool;
    if (tool === "paint" && !original.layers.some((l) => l.id === this.state.paintLayerId)) return;
    const working: TerrainData = { ...original, heights: original.heights.slice(), splat: original.splat.slice(), details: original.details.slice() };
    this.stroke = {
      original,
      working,
      region: null,
      flattenHeight: this.hover ? heightAt(original, this.hover.x, this.hover.z) : 0,
      label: tool === "paint" ? "Paint terrain" : `Sculpt terrain (${this.state.sculptMode})`,
    };
    this.shownTerrain = working;
    this.orbit.enabled = false;
  }

  /** One dab per frame while the button is held — holding longer sculpts more, like Unity. */
  private strokeStep(): void {
    const s = this.stroke;
    if (!s || !this.hover) return;
    const { radius, strength } = this.state.brush;
    const t = s.working;
    let region: TerrainRegion | null = null;
    if (this.state.tool === "paint") {
      const layerIndex = t.layers.findIndex((l) => l.id === this.state.paintLayerId);
      region = paintDab(t, t.splat, { x: this.hover.x, z: this.hover.z, radius, strength: 0.04 + strength * 0.3, layerIndex });
      if (region) {
        this.splatTexture.image.data = t.splat;
        this.splatTexture.needsUpdate = true;
      }
    } else {
      const mode = this.state.sculptMode;
      const amount = mode === "raise" || mode === "lower" ? (0.02 + strength * 0.25) * Math.max(1, radius / 8) : 0.05 + strength * 0.45;
      region = sculptDab(t, t.heights, { x: this.hover.x, z: this.hover.z, radius, strength: amount, mode, height: s.flattenHeight });
      if (region) writeHeights(this.terrainGeometry, t, region);
    }
    s.region = unionRegion(s.region, region);
  }

  private endStroke(): void {
    const s = this.stroke;
    if (!s) return;
    this.stroke = null;
    this.orbit.enabled = true;
    if (!s.region) {
      this.applyTerrain(this.state.map.terrain, false);
      return;
    }
    const res = s.original.resolution;
    const patch: TerrainPatch = { region: s.region };
    if (this.state.tool === "paint") {
      patch.splatBefore = extractRegion(s.original.splat, res, SPLAT_CHANNELS, s.region);
      patch.splatAfter = extractRegion(s.working.splat, res, SPLAT_CHANNELS, s.region);
    } else {
      patch.heightsBefore = extractRegion(s.original.heights, res, 1, s.region);
      patch.heightsAfter = extractRegion(s.working.heights, res, 1, s.region);
    }
    this.callbacks.onTerrainStroke(patch, s.label);
  }

  // ---- Placements ----

  private syncPlacements(): void {
    const { map, project, selectedPlacementIds } = this.state;
    const defs = new Map(project.objects.map((o) => [o.id, o]));
    const layerVisible = new Map(map.layers.map((l) => [l.id, l.visible]));
    const seen = new Set<string>();

    for (const placement of map.placements) {
      seen.add(placement.id);
      const def = defs.get(placement.objectId);
      const key = `${placement.objectId}|${placement.spriteId ?? ""}|${def ? JSON.stringify([def.kind, def.model, def.sprites, def.defaultSpriteId, def.sizeInTiles]) : "?"}`;
      let view = this.views.get(placement.id);
      if (view && view.key !== key) {
        this.objects.remove(view.group);
        disposeGroup(view.group);
        view = undefined;
      }
      if (!view) {
        view = this.createView(placement, def, key);
        this.views.set(placement.id, view);
        this.objects.add(view.group);
      }
      view.placement = placement;
      view.def = def;
      if (!(this.gizmoDragging && this.gizmo.object === view.group)) this.positionView(view);
      view.group.visible = layerVisible.get(placement.layerId) ?? true;
      const selected = selectedPlacementIds.includes(placement.id);
      (view.box.material as THREE.LineBasicMaterial).color.copy(selected ? SELECT_COLOR : COLLISION_COLOR);
      view.box.visible = selected || this.state.showCollisions;
    }
    for (const [id, view] of this.views) {
      if (seen.has(id)) continue;
      this.objects.remove(view.group);
      disposeGroup(view.group);
      this.views.delete(id);
    }
    this.syncGizmo();
  }

  private createView(placement: Placement3D, def: MapObjectDefinition | undefined, key: string): PlacementView {
    const group = new THREE.Group();
    group.userData.placementId = placement.id;
    const box = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), new THREE.LineBasicMaterial({ color: COLLISION_COLOR, depthTest: false }));
    box.renderOrder = 5;
    box.visible = false;
    box.userData.isBox = true;
    group.add(box);
    const view: PlacementView = { group, placement, def, key, billboard: null, box };
    const fitBox = (min: THREE.Vector3, max: THREE.Vector3) => {
      box.scale.set(Math.max(max.x - min.x, 0.05), Math.max(max.y - min.y, 0.05), Math.max(max.z - min.z, 0.05));
      box.position.set((min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2);
    };

    const addMarker = () => {
      const s = MARKER_SIZE;
      const marker = new THREE.Mesh(
        new THREE.BoxGeometry(s, s, s).translate(0, s / 2, 0),
        new THREE.MeshStandardMaterial({ color: "#b98cff", transparent: true, opacity: 0.75, roughness: 0.6 }),
      );
      group.add(marker);
      fitBox(new THREE.Vector3(-s / 2, 0, -s / 2), new THREE.Vector3(s / 2, s, s / 2));
    };

    if (def?.kind === "3d" && def.model) {
      fitBox(new THREE.Vector3(-0.5, 0, -0.5), new THREE.Vector3(0.5, 1, 0.5));
      void loadModel(def.model).then((scene) => {
        if (this.disposed || this.views.get(placement.id) !== view) return;
        if (!scene) {
          addMarker();
          return;
        }
        const clone = scene.clone(true);
        group.add(clone);
        const bounds = new THREE.Box3().setFromObject(clone);
        fitBox(bounds.min, bounds.max);
      });
    } else if (def?.kind === "2d" && def.sprites.length > 0) {
      const sprite = getSprite(def, placement.spriteId)!;
      fitBox(new THREE.Vector3(-0.5, 0, -0.05), new THREE.Vector3(0.5, 1, 0.05));
      void loadTexture(sprite.image, true).then((tex) => {
        if (this.disposed || this.views.get(placement.id) !== view) return;
        if (!tex) {
          addMarker();
          return;
        }
        const img = tex.image as { width: number; height: number };
        const size = billboardSize(def, { width: img.width, height: img.height });
        const mesh = new THREE.Mesh(
          new THREE.PlaneGeometry(size.width, size.height).translate(0, size.height / 2, 0),
          new THREE.MeshBasicMaterial({ map: tex, alphaTest: 0.5, side: THREE.DoubleSide }),
        );
        group.add(mesh);
        view.billboard = mesh;
        fitBox(new THREE.Vector3(-size.width / 2, 0, -0.05), new THREE.Vector3(size.width / 2, size.height, 0.05));
      });
    } else {
      addMarker();
    }
    return view;
  }

  private positionView(view: PlacementView): void {
    const p = view.placement;
    view.group.position.set(p.x, heightAt(this.shownTerrain, p.x, p.z) + p.elevation, p.z);
    view.group.rotation.set(0, (p.rotation * Math.PI) / 180, 0);
    view.group.scale.setScalar(p.scale);
  }

  private refreshPlacementHeights(): void {
    for (const view of this.views.values()) this.positionView(view);
  }

  private syncGizmo(): void {
    const ids = this.state.selectedPlacementIds;
    const view = this.state.tool === "select" && ids.length === 1 ? this.views.get(ids[0]) : undefined;
    const layer = view ? this.state.map.layers.find((l) => l.id === view.placement.layerId) : undefined;
    if (view && layer && !layer.locked) {
      if (this.gizmo.object !== view.group) this.gizmo.attach(view.group);
      this.gizmo.setMode(this.state.transformMode);
      const rotate = this.state.transformMode === "rotate";
      this.gizmo.showX = !rotate;
      this.gizmo.showZ = !rotate;
      this.gizmo.showY = true;
    } else if (this.gizmo.object) {
      this.gizmo.detach();
    }
  }

  private commitGizmo(): void {
    const obj = this.gizmo.object;
    const id = obj?.userData.placementId as string | undefined;
    const view = id ? this.views.get(id) : undefined;
    if (!obj || !id || !view) return;
    const t = this.shownTerrain;
    const x = clamp(obj.position.x, 0, t.size.width);
    const z = clamp(obj.position.z, 0, t.size.depth);
    const round = (v: number) => Math.round(v * 100) / 100;
    const rotation = round((((obj.rotation.y * 180) / Math.PI) % 360 + 360) % 360);
    this.callbacks.onTransform([
      { id, x: round(x), z: round(z), elevation: round(obj.position.y - heightAt(t, x, z)), rotation, scale: round(obj.scale.x) },
    ]);
  }

  // ---- Overlays & input ----

  private syncOverlays(): void {
    const u = this.terrainMaterial.uniforms;
    const t = this.shownTerrain;
    u.uShowGrid.value = this.state.showGrid ? 1 : 0;
    u.uGridSpacing.value = niceSpacing(Math.max(t.size.width, t.size.depth) / 12);
    const brushTool = this.state.tool === "sculpt" || this.state.tool === "paint" || (this.state.tool === "place" && this.state.placeScatter);
    u.uBrushVisible.value = brushTool && this.hover ? 1 : 0;
    u.uBrush.value.set(this.hover?.x ?? 0, this.hover?.z ?? 0, this.state.tool === "place" ? this.state.placeRadius : this.state.brush.radius);
    (u.uBrushColor.value as THREE.Color).set(
      this.state.tool === "paint" ? "#7fe0ff" : this.state.tool === "place" ? "#8cf07a" : "#ffd23f",
    );
    for (const view of this.views.values()) {
      view.box.visible = this.state.selectedPlacementIds.includes(view.placement.id) || this.state.showCollisions;
    }
    this.syncGizmo();
  }

  private ndc(clientX: number, clientY: number): THREE.Vector2 {
    const rect = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
  }

  /** Ray-marches the heightfield (fast at any resolution, and follows the stroke's working copy). */
  private pickTerrain(clientX: number, clientY: number): THREE.Vector3 | null {
    this.raycaster.setFromCamera(this.ndc(clientX, clientY), this.camera);
    const { origin, direction } = this.raycaster.ray;
    const t = this.shownTerrain;
    const { dx, dz } = sampleSpacing(t);
    const step = Math.min(dx, dz) * 0.5;
    const maxDist = this.camera.far;
    const inside = (p: THREE.Vector3) => p.x >= 0 && p.z >= 0 && p.x <= t.size.width && p.z <= t.size.depth;
    const above = (p: THREE.Vector3) => p.y - heightAt(t, p.x, p.z);
    const p = new THREE.Vector3();
    let prevDist = 0;
    let prevAbove = Number.POSITIVE_INFINITY;
    for (let d = 0; d < maxDist; d += step * (1 + d / 400)) {
      p.copy(origin).addScaledVector(direction, d);
      if (!inside(p)) {
        prevAbove = Number.POSITIVE_INFINITY;
        prevDist = d;
        continue;
      }
      const a = above(p);
      if (a <= 0 && prevAbove !== Number.POSITIVE_INFINITY) {
        let lo = prevDist;
        let hi = d;
        for (let i = 0; i < 20; i++) {
          const mid = (lo + hi) / 2;
          p.copy(origin).addScaledVector(direction, mid);
          if (above(p) > 0) lo = mid;
          else hi = mid;
        }
        p.copy(origin).addScaledVector(direction, hi);
        p.y = heightAt(t, p.x, p.z);
        return p.clone();
      }
      if (a <= 0) return null; // started below the surface
      prevAbove = a;
      prevDist = d;
    }
    return null;
  }

  private pickPlacement(clientX: number, clientY: number): string | null {
    this.raycaster.setFromCamera(this.ndc(clientX, clientY), this.camera);
    const hits = this.raycaster.intersectObjects(this.objects.children, true);
    for (const hit of hits) {
      if (hit.object.userData.isBox) continue;
      let o: THREE.Object3D | null = hit.object;
      while (o && o.userData.placementId === undefined) o = o.parent;
      if (o && o.visible) {
        const terrainHit = this.pickTerrain(clientX, clientY);
        if (terrainHit && terrainHit.distanceTo(this.camera.position) < hit.distance - 0.01) return null;
        return o.userData.placementId as string;
      }
    }
    return null;
  }

  private onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 || this.gizmo.dragging || this.gizmo.axis !== null) return;
    const tool = this.state.tool;
    if (tool === "select") {
      this.callbacks.onSelect(this.pickPlacement(e.clientX, e.clientY), e.shiftKey || e.ctrlKey);
    } else if (tool === "place") {
      const p = this.pickTerrain(e.clientX, e.clientY);
      if (p) this.callbacks.onPlace(p.x, p.z);
    } else if (tool === "water") {
      const p = this.pickTerrain(e.clientX, e.clientY);
      if (p) this.callbacks.onAddWater(p.x, p.z);
    } else {
      this.hover = this.pickTerrain(e.clientX, e.clientY);
      if (this.hover) {
        this.beginStroke();
        this.strokeStep(); // a simple click already sculpts/paints once
      }
    }
  };

  private onPointerMove = (e: PointerEvent) => {
    this.pointer = { x: e.clientX, y: e.clientY };
  };

  private onPointerLeave = () => {
    this.pointer = null;
  };

  private onPointerUp = (e: PointerEvent) => {
    if (e.button === 0 && this.stroke) this.endStroke();
  };

  private resize(): void {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = `${w}px`;
    this.renderer.domElement.style.height = `${h}px`;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private lastHoverReport = "";

  private loop = () => {
    if (this.disposed) return;
    this.frame = requestAnimationFrame(this.loop);

    const hover = this.pointer ? this.pickTerrain(this.pointer.x, this.pointer.y) : null;
    this.hover = hover ?? (this.stroke ? this.hover : null);
    const report = hover ? `${hover.x.toFixed(1)},${hover.y.toFixed(1)},${hover.z.toFixed(1)}` : "";
    if (report !== this.lastHoverReport) {
      this.lastHoverReport = report;
      this.callbacks.onHover(hover ? { x: hover.x, y: hover.y, z: hover.z } : null);
    }
    if (this.stroke) {
      this.strokeStep();
      this.refreshPlacementHeights();
    }
    this.syncOverlays();

    // Billboards turn around the vertical axis to face the camera.
    for (const view of this.views.values()) {
      if (!view.billboard) continue;
      const g = view.group;
      const yaw = Math.atan2(this.camera.position.x - g.position.x, this.camera.position.z - g.position.z);
      view.billboard.rotation.y = yaw - g.rotation.y;
    }

    windUniform.value = performance.now() / 1000;
    this.orbit.update();
    this.renderer.render(this.scene, this.camera);
  };
}

// ---- Geometry helpers ----

function buildTerrainGeometry(t: TerrainData): THREE.BufferGeometry {
  const res = t.resolution;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(res * res * 3), 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(res * res * 3), 3));
  const index = new Uint32Array((res - 1) * (res - 1) * 6);
  let k = 0;
  for (let iz = 0; iz < res - 1; iz++) {
    for (let ix = 0; ix < res - 1; ix++) {
      const a = iz * res + ix;
      const b = a + 1;
      const c = a + res;
      const d = c + 1;
      index[k++] = a;
      index[k++] = c;
      index[k++] = b;
      index[k++] = b;
      index[k++] = c;
      index[k++] = d;
    }
  }
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  writeHeights(geometry, t, { x0: 0, z0: 0, w: res, h: res });
  return geometry;
}

/** Writes positions and normals for a region of samples (normals one sample wider, since they depend on neighbors). */
function writeHeights(geometry: THREE.BufferGeometry, t: TerrainData, region: TerrainRegion): void {
  const res = t.resolution;
  const { dx, dz } = sampleSpacing(t);
  const pos = geometry.getAttribute("position") as THREE.BufferAttribute;
  const nor = geometry.getAttribute("normal") as THREE.BufferAttribute;
  const p = pos.array as Float32Array;
  const n = nor.array as Float32Array;
  const h = t.heights;
  const x0 = Math.max(0, region.x0 - 1);
  const z0 = Math.max(0, region.z0 - 1);
  const x1 = Math.min(res - 1, region.x0 + region.w);
  const z1 = Math.min(res - 1, region.z0 + region.h);
  for (let iz = z0; iz <= z1; iz++) {
    for (let ix = x0; ix <= x1; ix++) {
      const i = iz * res + ix;
      p[i * 3] = ix * dx;
      p[i * 3 + 1] = h[i];
      p[i * 3 + 2] = iz * dz;
      const hl = h[iz * res + Math.max(0, ix - 1)];
      const hr = h[iz * res + Math.min(res - 1, ix + 1)];
      const hd = h[Math.max(0, iz - 1) * res + ix];
      const hu = h[Math.min(res - 1, iz + 1) * res + ix];
      const nx = (hl - hr) / (2 * dx);
      const nz = (hd - hu) / (2 * dz);
      const len = Math.hypot(nx, 1, nz);
      n[i * 3] = nx / len;
      n[i * 3 + 1] = 1 / len;
      n[i * 3 + 2] = nz / len;
    }
  }
  pos.needsUpdate = true;
  nor.needsUpdate = true;
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
}

function disposeGroup(group: THREE.Object3D): void {
  group.traverse((o) => {
    const mesh = o as THREE.Mesh;
    // Model clones share geometry/materials with the cached original: only dispose what we created.
    if (mesh.userData.isBox || (mesh.isMesh && !mesh.userData.fromModel && o.parent === group)) {
      mesh.geometry?.dispose();
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat?.dispose();
    }
  });
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function niceSpacing(raw: number): number {
  const pow = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-3))));
  const n = raw / pow;
  return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * pow;
}
