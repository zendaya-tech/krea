import { useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Brush,
  Copy,
  Eraser,
  Maximize2,
  Move3d,
  PackagePlus,
  RotateCw,
  Scaling,
  Shovel,
  Waves,
  Droplets,
  FileDown,
  FolderOutput,
  Grid3x3,
  Hand,
  MousePointer2,
  PaintBucket,
  Pencil,
  Redo2,
  Save,
  Shapes,
  Undo2,
  X,
  ZoomIn,
  ZoomOut,
  type LucideIcon,
} from "lucide-react";
import type { EditorTool } from "@core/map-types";
import { ZOOM_LEVELS } from "@core/map-types";
import type { SculptMode } from "@core/terrain";
import { selectActive3DMap, selectActiveMap, useEditorStore, type Tool3D, type TransformMode } from "../stores/editorStore";
import { ExportModal } from "./ExportModal";
import { UnpackModal } from "./UnpackModal";

const TOOLS: Array<{ id: EditorTool; label: string; hint: string; icon: LucideIcon }> = [
  { id: "select", label: "Select", hint: "V", icon: MousePointer2 },
  { id: "pencil", label: "Pencil", hint: "B", icon: Pencil },
  { id: "eraser", label: "Eraser", hint: "E", icon: Eraser },
  { id: "fill", label: "Fill", hint: "G", icon: PaintBucket },
  { id: "pan", label: "Pan", hint: "H", icon: Hand },
];

const ICON = 14;

export function Toolbar() {
  const tool = useEditorStore((s) => s.tool);
  const setTool = useEditorStore((s) => s.setTool);
  const showGrid = useEditorStore((s) => s.showGrid);
  const setShowGrid = useEditorStore((s) => s.setShowGrid);
  const camera = useEditorStore((s) => s.camera);
  const zoomTo = useEditorStore((s) => s.zoomTo);
  const undo = useEditorStore((s) => s.undo);
  const redo = useEditorStore((s) => s.redo);
  const history = useEditorStore((s) => s.history);
  const save = useEditorStore((s) => s.save);
  const dirty = useEditorStore((s) => s.dirty);
  const saveStatus = useEditorStore((s) => s.saveStatus);
  const projectInfo = useEditorStore((s) => s.projectInfo);
  const projectName = useEditorStore((s) => s.project?.name);
  const showCollisions = useEditorStore((s) => s.showCollisions);
  const setShowCollisions = useEditorStore((s) => s.setShowCollisions);
  const closeProject = useEditorStore((s) => s.closeProject);
  const is3D = useEditorStore((s) => selectActiveMap(s)?.kind === "3d");
  const [showExport, setShowExport] = useState(false);
  const [showUnpack, setShowUnpack] = useState(false);

  const anchorCenter = { x: 400, y: 300 };

  function handleClose() {
    if (dirty && !window.confirm("Close the project? Unsaved changes will be lost.")) return;
    closeProject();
  }

  return (
    <div className="toolbar">
      <div className="toolbar-row menu-row">
        <div className="menu-group">
          <button className="menu-button" onClick={() => void save()} disabled={!dirty && saveStatus !== "error"} title="Save (Ctrl+S)">
            <Save size={ICON} />
            <span className="btn-label">Save{dirty ? " *" : ""}</span>
          </button>
          <button className="menu-button" onClick={() => setShowExport(true)} title="Export this map as game-ready JSON">
            <FileDown size={ICON} />
            <span className="btn-label">Export map…</span>
          </button>
          <button className="menu-button" onClick={() => setShowUnpack(true)} title="Write the project as project.json + assets/">
            <FolderOutput size={ICON} />
            <span className="btn-label">Export as folder…</span>
          </button>
          <button className="menu-button" onClick={handleClose} title="Close the project">
            <X size={ICON} />
            <span className="btn-label">Close</span>
          </button>
          <span className="menu-sep" />
          <button className="menu-button" onClick={undo} disabled={history.past.length === 0} title="Undo (Ctrl+Z)">
            <Undo2 size={ICON} />
            <span className="btn-label">Undo</span>
          </button>
          <button className="menu-button" onClick={redo} disabled={history.future.length === 0} title="Redo (Ctrl+Shift+Z)">
            <Redo2 size={ICON} />
            <span className="btn-label">Redo</span>
          </button>
          <span className="menu-sep" />
          <button className={`menu-button toggle ${showGrid ? "on" : ""}`} onClick={() => setShowGrid(!showGrid)} title="Show grid">
            <Grid3x3 size={ICON} />
            <span className="btn-label">Grid</span>
          </button>
          <button
            className={`menu-button toggle ${showCollisions ? "on" : ""}`}
            onClick={() => setShowCollisions(!showCollisions)}
            title={is3D ? "Show bounding boxes" : "Show collision shapes"}
          >
            <Shapes size={ICON} />
            <span className="btn-label">Collisions</span>
          </button>
        </div>
        <div className="app-title" title={projectInfo?.file}>
          {projectName ?? "Krea"} {projectInfo ? `— ${projectInfo.name}.krea` : ""}
        </div>
      </div>
      {showExport && <ExportModal onClose={() => setShowExport(false)} />}
      {showUnpack && <UnpackModal onClose={() => setShowUnpack(false)} />}
      {is3D ? (
        <Tools3D />
      ) : (
        <div className="toolbar-row tools-row">
          <div className="tool-group">
            {TOOLS.map((t) => (
              <button
                key={t.id}
                className={`tool-button ${tool === t.id ? "active" : ""}`}
                title={`${t.label} (${t.hint})`}
                onClick={() => setTool(t.id)}
              >
                <t.icon size={ICON} />
                <span className="btn-label">{t.label}</span>
              </button>
            ))}
          </div>
          <div className="zoom-group">
            <button className="tool-button icon-only" onClick={() => zoomTo(prevZoom(camera.zoom), anchorCenter)} title="Zoom out">
              <ZoomOut size={ICON} />
            </button>
            <select value={camera.zoom} onChange={(e) => zoomTo(Number(e.target.value), anchorCenter)}>
              {ZOOM_LEVELS.map((z) => (
                <option key={z} value={z}>
                  {Math.round(z * 100)}%
                </option>
              ))}
            </select>
            <button className="tool-button icon-only" onClick={() => zoomTo(nextZoom(camera.zoom), anchorCenter)} title="Zoom in">
              <ZoomIn size={ICON} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const NO_LAYERS: Array<{ id: string; name: string }> = [];

const SCULPT_TOOLS: Array<{ mode: SculptMode; label: string; hint: string; icon: LucideIcon }> = [
  { mode: "raise", label: "Raise", hint: "1", icon: ArrowUpFromLine },
  { mode: "lower", label: "Lower", hint: "2", icon: ArrowDownToLine },
  { mode: "smooth", label: "Smooth", hint: "3", icon: Waves },
  { mode: "flatten", label: "Flatten", hint: "4", icon: Shovel },
];

const TRANSFORMS: Array<{ mode: TransformMode; label: string; hint: string; icon: LucideIcon }> = [
  { mode: "translate", label: "Move", hint: "W", icon: Move3d },
  { mode: "rotate", label: "Rotate", hint: "E", icon: RotateCw },
  { mode: "scale", label: "Scale", hint: "R", icon: Scaling },
];

/** Tool row of the 3D editor: select/place objects, sculpt and paint the terrain, brush settings. */
function Tools3D() {
  const tool = useEditorStore((s) => s.tool3d);
  const setTool = useEditorStore((s) => s.setTool3d);
  const sculptMode = useEditorStore((s) => s.sculptMode);
  const setSculptMode = useEditorStore((s) => s.setSculptMode);
  const brush = useEditorStore((s) => s.brush);
  const setBrush = useEditorStore((s) => s.setBrush);
  const transformMode = useEditorStore((s) => s.transformMode);
  const setTransformMode = useEditorStore((s) => s.setTransformMode);
  const paintLayerId = useEditorStore((s) => s.paintLayerId);
  const setPaintLayer = useEditorStore((s) => s.setPaintLayer);
  const terrainLayers = useEditorStore((s) => selectActive3DMap(s)?.terrain.layers ?? NO_LAYERS);
  const duplicate = useEditorStore((s) => s.duplicateSelectedPlacements);
  const hasSelection = useEditorStore((s) => s.selectedPlacementIds.length > 0);

  const button = (active: boolean, title: string, Icon: LucideIcon, label: string, onClick: () => void) => (
    <button key={title} className={`tool-button ${active ? "active" : ""}`} title={title} onClick={onClick}>
      <Icon size={ICON} />
      <span className="btn-label">{label}</span>
    </button>
  );
  const brushTool = tool === "sculpt" || tool === "paint";

  return (
    <div className="toolbar-row tools-row">
      <div className="tool-group">
        {button(tool === "select", "Select objects (V)", MousePointer2, "Select", () => setTool("select" as Tool3D))}
        {button(tool === "place", "Place the selected object (P)", PackagePlus, "Place", () => setTool("place"))}
        <span className="menu-sep" />
        {SCULPT_TOOLS.map((t) =>
          button(tool === "sculpt" && sculptMode === t.mode, `${t.label} terrain (${t.hint})`, t.icon, t.label, () =>
            setSculptMode(t.mode),
          ),
        )}
        {button(tool === "paint", "Paint texture layer (B)", Brush, "Paint", () => setTool("paint"))}
        {button(tool === "water", "Add a lake: click in a basin, even high up (L)", Droplets, "Water", () => setTool("water"))}
        {tool === "paint" && (
          <select className="tool-select" value={paintLayerId ?? ""} onChange={(e) => setPaintLayer(e.target.value)} title="Layer to paint">
            {terrainLayers.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="tool-group">
        {brushTool && (
          <>
            <label className="slider-field" title="Brush radius (meters) — [ and ]">
              <span>Radius</span>
              <input
                type="range"
                min={0.5}
                max={60}
                step={0.5}
                value={brush.radius}
                onChange={(e) => setBrush({ radius: Number(e.target.value) })}
              />
              <span className="slider-value">{brush.radius} m</span>
            </label>
            <label className="slider-field" title="Brush strength">
              <span>Strength</span>
              <input
                type="range"
                min={0.05}
                max={1}
                step={0.05}
                value={brush.strength}
                onChange={(e) => setBrush({ strength: Number(e.target.value) })}
              />
              <span className="slider-value">{Math.round(brush.strength * 100)}%</span>
            </label>
          </>
        )}
        {tool === "select" && (
          <>
            {TRANSFORMS.map((t) =>
              button(transformMode === t.mode, `${t.label} (${t.hint})`, t.icon, t.label, () => setTransformMode(t.mode)),
            )}
            <button className="tool-button" disabled={!hasSelection} onClick={duplicate} title="Duplicate (Ctrl+D)">
              <Copy size={ICON} />
              <span className="btn-label">Duplicate</span>
            </button>
          </>
        )}
        <button
          className="tool-button icon-only"
          onClick={() => window.dispatchEvent(new Event("krea:frame-selection"))}
          title="Frame selection / terrain (F)"
        >
          <Maximize2 size={ICON} />
        </button>
      </div>
    </div>
  );
}

function nextZoom(current: number): number {
  const idx = ZOOM_LEVELS.findIndex((z) => z > current + 0.001);
  return idx < 0 ? ZOOM_LEVELS[ZOOM_LEVELS.length - 1] : ZOOM_LEVELS[idx];
}

function prevZoom(current: number): number {
  const idx = [...ZOOM_LEVELS].reverse().findIndex((z) => z < current - 0.001);
  return idx < 0 ? ZOOM_LEVELS[0] : [...ZOOM_LEVELS].reverse()[idx];
}
