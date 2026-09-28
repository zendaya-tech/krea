import { useEffect, useRef, useState } from "react";
import { cellKey, pixelToGrid, screenToWorld } from "@core/map-utils";
import { selectActive2DMap, useEditorStore } from "../stores/editorStore";
import { ContextMenu } from "../components/ContextMenu";
import { CanvasRenderer, type RenderSnapshot } from "./CanvasRenderer";
import { subscribeImageCache } from "./image-cache";

interface InstanceContextMenu {
  x: number;
  y: number;
  layerId: string;
  objectId: string;
  objectName: string;
  cellX: number;
  cellY: number;
}

const CURSOR_BY_TOOL: Record<string, string> = {
  select: "default",
  pencil: "crosshair",
  eraser: "crosshair",
  fill: "crosshair",
  pan: "grab",
};

export function MapCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<CanvasRenderer | null>(null);
  const isPaintingRef = useRef(false);
  const isPanningRef = useRef(false);
  const panStartRef = useRef({ screenX: 0, screenY: 0, camX: 0, camY: 0 });
  const tool = useEditorStore((s) => s.tool);
  const [contextMenu, setContextMenu] = useState<InstanceContextMenu | null>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    const renderer = new CanvasRenderer(canvasRef.current);
    rendererRef.current = renderer;

    const renderNow = () => {
      const state = useEditorStore.getState();
      const map = selectActive2DMap(state);
      const snapshot: RenderSnapshot | null = state.project && map
        ? {
            map,
            objects: state.project.objects,
            cellIndex: state.cellIndex,
            camera: state.camera,
            showGrid: state.showGrid,
            showCollisions: state.showCollisions,
            activeLayerId: state.activeLayerId,
            selectedInstances: state.selectedInstances,
            hoverCell: state.hoverCell,
            tool: state.tool,
            paintObjectId: state.selectedObjectId,
          }
        : null;
      renderer.render(snapshot);
    };

    renderNow();
    const unsubStore = useEditorStore.subscribe(renderNow);
    const unsubImages = subscribeImageCache(renderNow);

    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      renderer.resize(entry.contentRect.width, entry.contentRect.height);
      renderNow();
    });
    if (containerRef.current) resizeObserver.observe(containerRef.current);

    return () => {
      unsubStore();
      unsubImages();
      resizeObserver.disconnect();
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const anchor = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      useEditorStore.getState().zoomStep(e.deltaY < 0 ? 1 : -1, anchor);
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, []);

  function getGridCell(clientX: number, clientY: number): { x: number; y: number } | null {
    const state = useEditorStore.getState();
    const map = selectActive2DMap(state);
    if (!map || !canvasRef.current) return null;
    const rect = canvasRef.current.getBoundingClientRect();
    const world = screenToWorld(clientX - rect.left, clientY - rect.top, state.camera);
    return pixelToGrid(world.worldX, world.worldY, map.settings);
  }

  /** Topmost visible-layer instance at a cell, searched back-to-front like the canvas draws. */
  function findTopInstanceAt(cellX: number, cellY: number): { layerId: string; objectId: string } | null {
    const state = useEditorStore.getState();
    const map = selectActive2DMap(state);
    if (!map) return null;
    const layers = map.layers;
    for (let i = layers.length - 1; i >= 0; i--) {
      const layer = layers[i];
      if (!layer.visible) continue;
      const inst = state.cellIndex.get(cellKey(layer.id, cellX, cellY));
      if (inst) return { layerId: layer.id, objectId: inst.objectId };
    }
    return null;
  }

  function handlePointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    const state = useEditorStore.getState();
    if (!state.project) return;
    canvasRef.current?.setPointerCapture(e.pointerId);

    if (e.button === 1 || state.tool === "pan") {
      isPanningRef.current = true;
      panStartRef.current = { screenX: e.clientX, screenY: e.clientY, camX: state.camera.x, camY: state.camera.y };
      return;
    }
    if (e.button !== 0) return;

    const cell = getGridCell(e.clientX, e.clientY);
    if (!cell) return;

    if (state.tool === "pencil" || state.tool === "eraser") {
      state.beginStroke();
      state.paintAt(cell.x, cell.y);
      isPaintingRef.current = true;
    } else if (state.tool === "fill") {
      state.fillAt(cell.x, cell.y);
    } else if (state.tool === "select") {
      const found = findTopInstanceAt(cell.x, cell.y);
      if (found) state.selectInstanceAt(found.layerId, cell.x, cell.y);
      else state.clearSelection();
    }
  }

  function handleContextMenu(e: React.MouseEvent<HTMLCanvasElement>) {
    e.preventDefault();
    const state = useEditorStore.getState();
    if (!state.project) {
      setContextMenu(null);
      return;
    }
    const cell = getGridCell(e.clientX, e.clientY);
    if (!cell) {
      setContextMenu(null);
      return;
    }
    const found = findTopInstanceAt(cell.x, cell.y);
    if (!found) {
      setContextMenu(null);
      return;
    }
    state.selectInstanceAt(found.layerId, cell.x, cell.y);
    const objectName = state.project.objects.find((o) => o.id === found.objectId)?.name ?? found.objectId;
    setContextMenu({ x: e.clientX, y: e.clientY, layerId: found.layerId, objectId: found.objectId, objectName, cellX: cell.x, cellY: cell.y });
  }

  function handlePointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    const state = useEditorStore.getState();
    if (isPanningRef.current) {
      const dx = e.clientX - panStartRef.current.screenX;
      const dy = e.clientY - panStartRef.current.screenY;
      state.setCamera({
        x: panStartRef.current.camX - dx / state.camera.zoom,
        y: panStartRef.current.camY - dy / state.camera.zoom,
      });
      return;
    }
    const cell = getGridCell(e.clientX, e.clientY);
    state.setHoverCell(cell);
    if (isPaintingRef.current && cell && (state.tool === "pencil" || state.tool === "eraser")) {
      state.paintAt(cell.x, cell.y);
    }
  }

  function handlePointerUp(e: React.PointerEvent<HTMLCanvasElement>) {
    canvasRef.current?.releasePointerCapture(e.pointerId);
    if (isPaintingRef.current) {
      useEditorStore.getState().endStroke();
      isPaintingRef.current = false;
    }
    isPanningRef.current = false;
  }

  function handlePointerLeave() {
    if (!isPanningRef.current) {
      useEditorStore.getState().setHoverCell(null);
    }
  }

  return (
    <div ref={containerRef} className="map-canvas-container">
      <canvas
        ref={canvasRef}
        className="map-canvas"
        style={{ cursor: CURSOR_BY_TOOL[tool] ?? "default" }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerLeave}
        onContextMenu={handleContextMenu}
      />
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          items={[
            {
              label: "Duplicate",
              onSelect: () => useEditorStore.getState().duplicateInstanceAt(contextMenu.layerId, contextMenu.cellX, contextMenu.cellY),
            },
            {
              label: `Select all "${contextMenu.objectName}"`,
              onSelect: () => useEditorStore.getState().selectAllOfType(contextMenu.objectId),
            },
            {
              label: `Delete all "${contextMenu.objectName}"`,
              danger: true,
              onSelect: () => useEditorStore.getState().deleteAllOfType(contextMenu.objectId),
            },
            {
              label: "Delete",
              danger: true,
              onSelect: () => useEditorStore.getState().deleteSelectedInstances(),
            },
          ]}
        />
      )}
    </div>
  );
}
