import { useState } from "react";
import { ArrowDown, ArrowUp, Eye, EyeOff, Lock, LockOpen, Plus, Trash2 } from "lucide-react";
import { selectActiveMap, useEditorStore } from "../stores/editorStore";

export function LayersPanel() {
  const map = useEditorStore(selectActiveMap);
  const activeLayerId = useEditorStore((s) => s.activeLayerId);
  const setActiveLayer = useEditorStore((s) => s.setActiveLayer);
  const toggleLayerVisibility = useEditorStore((s) => s.toggleLayerVisibility);
  const toggleLayerLock = useEditorStore((s) => s.toggleLayerLock);
  const reorderLayer = useEditorStore((s) => s.reorderLayer);
  const removeLayer = useEditorStore((s) => s.removeLayer);
  const addLayer = useEditorStore((s) => s.addLayer);
  const renameLayer = useEditorStore((s) => s.renameLayer);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");

  if (!map) return null;
  const layers = map.layers;

  function commitRename() {
    if (renamingId && draftName.trim()) renameLayer(renamingId, draftName.trim());
    setRenamingId(null);
  }

  return (
    <div className="panel layers-panel">
      <div className="panel-header">
        <span>Layers</span>
        <button className="small-button" onClick={() => addLayer(`Layer ${layers.length + 1}`)}>
          <Plus size={12} /> Add
        </button>
      </div>
      <div className="layers-list">
        {layers
          .slice()
          .reverse()
          .map((layer) => {
            const index = layers.findIndex((l) => l.id === layer.id);
            return (
              <div key={layer.id} className={`layer-item ${activeLayerId === layer.id ? "active" : ""}`}>
                <button
                  className="icon-button"
                  title={layer.visible ? "Hide layer" : "Show layer"}
                  onClick={() => toggleLayerVisibility(layer.id)}
                >
                  {layer.visible ? <Eye size={14} /> : <EyeOff size={14} />}
                </button>
                <button
                  className="icon-button"
                  title={layer.locked ? "Unlock layer" : "Lock layer"}
                  onClick={() => toggleLayerLock(layer.id)}
                >
                  {layer.locked ? <Lock size={14} /> : <LockOpen size={14} />}
                </button>
                {renamingId === layer.id ? (
                  <input
                    autoFocus
                    className="text-input layer-rename-input"
                    value={draftName}
                    onChange={(e) => setDraftName(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRename();
                      if (e.key === "Escape") setRenamingId(null);
                    }}
                  />
                ) : (
                  <button
                    className="layer-name"
                    onClick={() => setActiveLayer(layer.id)}
                    onDoubleClick={() => {
                      setRenamingId(layer.id);
                      setDraftName(layer.name);
                    }}
                  >
                    {layer.name}
                  </button>
                )}
                <div className="layer-actions">
                  <button
                    className="icon-button"
                    title="Move up"
                    disabled={index === layers.length - 1}
                    onClick={() => reorderLayer(layer.id, index + 1)}
                  >
                    <ArrowUp size={14} />
                  </button>
                  <button
                    className="icon-button"
                    title="Move down"
                    disabled={index === 0}
                    onClick={() => reorderLayer(layer.id, index - 1)}
                  >
                    <ArrowDown size={14} />
                  </button>
                  <button
                    className="icon-button"
                    title="Delete layer"
                    disabled={layers.length <= 1}
                    onClick={() => removeLayer(layer.id)}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            );
          })}
      </div>
    </div>
  );
}
