import { useState } from "react";
import { Box, Flower2, Ghost, Plus, Sprout } from "lucide-react";
import { getSprite } from "@core/map-utils";
import { assetUrl } from "../net/client";
import { useEditorStore } from "../stores/editorStore";
import { AddObjectModal } from "./AddObjectModal";
import { importVegetationPreset, type VegetationPreset } from "../vegetation-presets";
import { ContextMenu } from "./ContextMenu";
import { SpriteEditorModal } from "./sprites/SpriteEditorModal";

export function ObjectsPanel() {
  const objects = useEditorStore((s) => s.project?.objects);
  const selectedObjectId = useEditorStore((s) => s.selectedObjectId);
  const selectObject = useEditorStore((s) => s.selectObject);
  const mapKind = useEditorStore((s) => s.project?.maps.find((m) => m.id === s.activeMapId)?.kind ?? "2d");
  const selectAllPlacementsOfType = useEditorStore((s) => s.selectAllPlacementsOfType);
  const deleteAllPlacementsOfType = useEditorStore((s) => s.deleteAllPlacementsOfType);
  const duplicateObjectDefinition = useEditorStore((s) => s.duplicateObjectDefinition);
  const removeObjectDefinition = useEditorStore((s) => s.removeObjectDefinition);
  const addObjectDefinition = useEditorStore((s) => s.addObjectDefinition);
  const setTool3d = useEditorStore((s) => s.setTool3d);
  const setPlaceSettings = useEditorStore((s) => s.setPlaceSettings);
  const setPlaceRandomize = useEditorStore((s) => s.setPlaceRandomize);
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingObjectId, setEditingObjectId] = useState<string | null>(null);
  const [spriteEditorObjectId, setSpriteEditorObjectId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; objectId: string } | null>(null);
  const [creatingPreset, setCreatingPreset] = useState<VegetationPreset | null>(null);
  const [presetError, setPresetError] = useState<string | null>(null);

  async function addVegetation(kind: VegetationPreset) {
    setCreatingPreset(kind);
    setPresetError(null);
    try {
      const image = await importVegetationPreset(kind);
      addObjectDefinition({
        kind: "2d",
        name: kind === "grass" ? "Grass tuft" : "Wildflowers",
        description: kind === "grass" ? "Small grass object for 3D terrain." : "Flower cluster for 3D terrain.",
        image,
      });
      setPlaceSettings({ placeScatter: true, placeCount: kind === "grass" ? 30 : 12, placeRadius: 10, placeSpacing: kind === "grass" ? 0.65 : 1.2, placeOnTerrainLayerId: null, placeWater: "avoid" });
      setPlaceRandomize(true);
      setTool3d("place");
    } catch (error) {
      setPresetError(error instanceof Error ? error.message : "Could not create the vegetation object.");
    } finally {
      setCreatingPreset(null);
    }
  }

  if (!objects) return null;

  return (
    <div className="panel objects-panel">
      <div className="panel-header">
        <span>Objects</span>
        <button className="small-button" onClick={() => setShowAddModal(true)}>
          <Plus size={12} /> Add
        </button>
      </div>
      <div className="objects-list">
        {mapKind === "3d" && (
          <div className="vegetation-presets">
            <div className="empty-hint">Quick objects for 3D terrain</div>
            <div className="detail-presets">
              <button className="small-button" disabled={creatingPreset !== null} onClick={() => void addVegetation("grass")}><Sprout size={12} /> Grass tuft</button>
              <button className="small-button" disabled={creatingPreset !== null} onClick={() => void addVegetation("flowers")}><Flower2 size={12} /> Flowers</button>
            </div>
            {creatingPreset && <div className="empty-hint">Creating {creatingPreset}…</div>}
            {presetError && <div className="error-text">{presetError}</div>}
          </div>
        )}
        {objects.map((obj) => {
          const sprite = getSprite(obj);
          const collisionCount =
            obj.sprites.length === 0 ? (obj.collisions?.length ?? 0) : obj.sprites.reduce((n, s) => n + s.collisions.length, 0);
          return (
            <button
              key={obj.id}
              className={`object-item ${selectedObjectId === obj.id ? "active" : ""} ${obj.kind === "3d" && mapKind === "2d" ? "unavailable" : ""}`}
              onClick={() => selectObject(obj.id)}
              onDoubleClick={() => (obj.kind === "3d" ? setEditingObjectId(obj.id) : setSpriteEditorObjectId(obj.id))}
              onContextMenu={(e) => {
                e.preventDefault();
                selectObject(obj.id);
                setContextMenu({ x: e.clientX, y: e.clientY, objectId: obj.id });
              }}
              title={
                (obj.kind === "3d" && mapKind === "2d" ? "3D object — only placeable on 3D maps. " : "") +
                (obj.description ? `${obj.id} — ${obj.description}` : obj.id)
              }
            >
              {obj.kind === "3d" ? (
                <div className="object-thumb object-thumb-empty" title={obj.model ? obj.model : "No model (invisible marker)"}>
                  {obj.model ? <Box size={16} /> : <Ghost size={16} />}
                </div>
              ) : sprite ? (
                <img src={assetUrl(sprite.image)} alt={obj.name} className="object-thumb" />
              ) : (
                <div className="object-thumb object-thumb-empty" title="No sprite (invisible)">
                  <Ghost size={16} />
                </div>
              )}
              <div className="object-meta">
                <div className="object-name">
                  {obj.name} <span className="kind-badge">{obj.kind === "3d" ? "3D" : "2D"}</span>
                </div>
                <div className="object-id">
                  {obj.id}
                  {obj.kind === "2d" && obj.sprites.length === 0 && " · invisible"}
                  {obj.kind === "3d" && !obj.model && " · marker"}
                  {obj.sprites.length > 1 && ` · ${obj.sprites.length} sprites`}
                  {collisionCount > 0 && ` · ${collisionCount} coll.`}
                </div>
              </div>
            </button>
          );
        })}
        {objects.length === 0 && <div className="empty-hint">No objects yet.</div>}
      </div>
      {showAddModal && <AddObjectModal mode="add" onClose={() => setShowAddModal(false)} />}
      {editingObjectId && <AddObjectModal mode="edit" objectId={editingObjectId} onClose={() => setEditingObjectId(null)} />}
      {spriteEditorObjectId && <SpriteEditorModal objectId={spriteEditorObjectId} onClose={() => setSpriteEditorObjectId(null)} />}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          items={[
            { label: "Edit…", onSelect: () => setEditingObjectId(contextMenu.objectId) },
            ...(objects.find((o) => o.id === contextMenu.objectId)?.kind === "2d"
              ? [{ label: "Sprites & collisions…", onSelect: () => setSpriteEditorObjectId(contextMenu.objectId) }]
              : []),
            ...(mapKind === "3d"
              ? [
                  { label: "Select all on this map", onSelect: () => selectAllPlacementsOfType(contextMenu.objectId) },
                  { label: "Remove all from this map", danger: true, onSelect: () => deleteAllPlacementsOfType(contextMenu.objectId) },
                ]
              : []),
            { label: "Duplicate", onSelect: () => duplicateObjectDefinition(contextMenu.objectId) },
            { label: "Delete", danger: true, onSelect: () => removeObjectDefinition(contextMenu.objectId) },
          ]}
        />
      )}
    </div>
  );
}
