import { useEffect } from "react";
import { selectActiveMap, useEditorStore } from "../stores/editorStore";
import type { SculptMode } from "@core/terrain";

const TOOL_KEYS: Record<string, "select" | "pencil" | "eraser" | "fill" | "pan"> = {
  v: "select",
  b: "pencil",
  e: "eraser",
  g: "fill",
  h: "pan",
};

const SCULPT_KEYS: Record<string, SculptMode> = { "1": "raise", "2": "lower", "3": "smooth", "4": "flatten" };

/** 3D editor keys: V select, P place, 1-4 sculpt modes, B paint, W/E/R gizmo, F frame, [ ] brush size, Ctrl+D duplicate. */
function handle3DKey(e: KeyboardEvent): boolean {
  const s = useEditorStore.getState();
  const key = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && key === "d") {
    s.duplicateSelectedPlacements();
    return true;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  if (e.key === "Delete" || e.key === "Backspace") {
    const had = s.selectedPlacementIds.length > 0;
    s.deleteSelectedPlacements();
    return had;
  }
  if (e.key === "Escape") {
    s.clearSelection();
    return true;
  }
  if (SCULPT_KEYS[key]) s.setSculptMode(SCULPT_KEYS[key]);
  else if (key === "v") s.setTool3d("select");
  else if (key === "p") s.setTool3d("place");
  else if (key === "b") s.setTool3d("paint");
  else if (key === "l") s.setTool3d("water");
  else if (key === "w") s.setTransformMode("translate");
  else if (key === "e") s.setTransformMode("rotate");
  else if (key === "r") s.setTransformMode("scale");
  else if (key === "f") window.dispatchEvent(new Event("krea:frame-selection"));
  else if (key === "[") s.setBrush({ radius: Math.max(0.5, Math.round((s.brush.radius / 1.25) * 2) / 2) });
  else if (key === "]") s.setBrush({ radius: Math.min(60, Math.round(s.brush.radius * 1.25 * 2) / 2) });
  else return false;
  return true;
}

export function useKeyboardShortcuts() {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // Modals (e.g. the collision editor) own the keyboard while open.
      if (document.querySelector(".modal-backdrop")) return;
      const target = e.target as HTMLElement | null;
      const isEditingText = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA");

      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void useEditorStore.getState().save();
        return;
      }
      if (mod && !e.shiftKey && e.key.toLowerCase() === "z") {
        e.preventDefault();
        useEditorStore.getState().undo();
        return;
      }
      if (mod && (e.key.toLowerCase() === "y" || (e.shiftKey && e.key.toLowerCase() === "z"))) {
        e.preventDefault();
        useEditorStore.getState().redo();
        return;
      }

      if (!isEditingText && selectActiveMap(useEditorStore.getState())?.kind === "3d") {
        if (handle3DKey(e)) e.preventDefault();
        return;
      }

      if (isEditingText || mod || e.altKey) return;

      if (e.key === "Delete" || e.key === "Backspace") {
        if (useEditorStore.getState().selectedInstances.length > 0) {
          e.preventDefault();
          useEditorStore.getState().deleteSelectedInstances();
        }
        return;
      }

      const tool = TOOL_KEYS[e.key.toLowerCase()];
      if (tool) {
        useEditorStore.getState().setTool(tool);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
