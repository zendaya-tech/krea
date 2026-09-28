import { useEffect, useRef } from "react";
import { Scene3D, type Scene3DState } from "./Scene3D";
import { selectActive3DMap, useEditorStore } from "../stores/editorStore";

function sceneState(): Scene3DState | null {
  const s = useEditorStore.getState();
  const map = selectActive3DMap(s);
  if (!s.project || !map) return null;
  return {
    project: s.project,
    map,
    tool: s.tool3d,
    sculptMode: s.sculptMode,
    brush: s.brush,
    placeScatter: s.placeScatter,
    placeRadius: s.placeRadius,
    paintLayerId: s.paintLayerId,
    transformMode: s.transformMode,
    selectedPlacementIds: s.selectedPlacementIds,
    showGrid: s.showGrid,
    showCollisions: s.showCollisions,
  };
}

/** Hosts the imperative Three.js scene for the active 3D map and bridges it to the store. */
export function Map3DView() {
  const containerRef = useRef<HTMLDivElement>(null);
  const activeMapId = useEditorStore((s) => s.activeMapId);

  useEffect(() => {
    const container = containerRef.current;
    const initial = sceneState();
    if (!container || !initial) return;
    const store = useEditorStore.getState;
    const scene = new Scene3D(container, initial, {
      onHover: (p) => store().setHoverPoint(p),
      onSelect: (id, additive) => store().selectPlacement(id, additive),
      onPlace: (x, z) => store().placeObjectAt3D(x, z),
      onAddWater: (x, z) => store().addWaterAt(x, z),
      onTerrainStroke: (patch, label) => store().commitTerrainPatch(patch, label),
      onTransform: (updates) => store().updatePlacements(updates),
    });
    const unsubscribe = useEditorStore.subscribe((s, prev) => {
      if (s.hoverPoint !== prev.hoverPoint && s.project === prev.project) return;
      const next = sceneState();
      if (next) scene.update(next);
    });
    const onFrame = () => scene.frameSelection();
    window.addEventListener("krea:frame-selection", onFrame);
    return () => {
      window.removeEventListener("krea:frame-selection", onFrame);
      unsubscribe();
      scene.dispose();
    };
  }, [activeMapId]);

  return (
    <div className="map-canvas-container scene3d-container" ref={containerRef}>
      <div className="scene3d-hint">Right-drag: orbit · Middle-drag: pan · Wheel: zoom · F: frame</div>
    </div>
  );
}
