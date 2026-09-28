import { useEffect, useState } from "react";
import { Circle, Ghost, Plus, Square, Triangle, type LucideIcon } from "lucide-react";
import type { CollisionShape, CollisionShapeType, SpriteDefinition } from "@core/map-types";
import { createDefaultShape, type Size } from "@core/collision-geometry";
import { footprintSpace, uniqueId } from "@core/map-utils";
import { assetUrl } from "../../net/client";
import { useEditorStore } from "../../stores/editorStore";
import { AssetPicker } from "../AssetPicker";
import { CollisionCanvas } from "./CollisionCanvas";
import { ShapeProperties } from "./ShapeProperties";

const SHAPE_BUTTONS: Array<{ type: CollisionShapeType; label: string; icon: LucideIcon }> = [
  { type: "rect", label: "Rectangle", icon: Square },
  { type: "circle", label: "Circle", icon: Circle },
  { type: "triangle", label: "Triangle", icon: Triangle },
];

function prettyName(image: string): string {
  const base = image.replace(/^.*\//, "").replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim();
  return base ? base[0].toUpperCase() + base.slice(1) : "Sprite";
}

/**
 * Edits one catalog object's sprites and their collision shapes — or, for a
 * sprite-less object (spawn point, trigger, invisible wall), the collisions
 * drawn over its footprint. Works on a local draft; nothing touches the
 * project until "Save", which commits everything as a single undo step.
 */
export function SpriteEditorModal({ objectId, onClose }: { objectId: string; onClose: () => void }) {
  const def = useEditorStore((s) => s.project?.objects.find((o) => o.id === objectId));
  const updateObjectDefinition = useEditorStore((s) => s.updateObjectDefinition);

  const [sprites, setSprites] = useState<SpriteDefinition[]>(() => structuredClone(def?.sprites ?? []));
  const [objectCollisions, setObjectCollisions] = useState<CollisionShape[]>(() => structuredClone(def?.collisions ?? []));
  const [defaultSpriteId, setDefaultSpriteId] = useState(def?.defaultSpriteId ?? "");
  const [selectedSpriteId, setSelectedSpriteId] = useState(def?.defaultSpriteId ?? def?.sprites[0]?.id ?? "");
  const [selectedShapeId, setSelectedShapeId] = useState<string | null>(null);
  const [imageSize, setImageSize] = useState<Size | null>(null);
  const [pickingImageFor, setPickingImageFor] = useState<"new" | "replace" | null>(null);

  const spriteless = sprites.length === 0;
  const sprite = sprites.find((s) => s.id === selectedSpriteId) ?? null;
  const shapes = spriteless ? objectCollisions : (sprite?.collisions ?? []);
  const shape = shapes.find((c) => c.id === selectedShapeId) ?? null;

  function updateSprite(id: string, fn: (s: SpriteDefinition) => SpriteDefinition) {
    setSprites((prev) => prev.map((s) => (s.id === id ? fn(s) : s)));
  }

  /** Edits whichever shape list is on screen: the selected sprite's, or the object's own. */
  function setShapes(fn: (shapes: CollisionShape[]) => CollisionShape[]) {
    if (spriteless) setObjectCollisions(fn);
    else if (sprite) updateSprite(sprite.id, (s) => ({ ...s, collisions: fn(s.collisions) }));
  }

  function selectSprite(id: string) {
    setSelectedSpriteId(id);
    setSelectedShapeId(null);
    setPickingImageFor(null);
  }

  function addShape(type: CollisionShapeType) {
    if (!imageSize) return;
    const id = uniqueId(shapes.map((c) => c.id), type);
    setShapes((list) => [...list, createDefaultShape(type, imageSize, id)]);
    setSelectedShapeId(id);
  }

  function changeShape(next: CollisionShape) {
    setShapes((list) => list.map((c) => (c.id === next.id ? next : c)));
  }

  function deleteShape() {
    if (!selectedShapeId) return;
    setShapes((list) => list.filter((c) => c.id !== selectedShapeId));
    setSelectedShapeId(null);
  }

  function pickImage(image: string) {
    if (pickingImageFor === "new") {
      const id = uniqueId(sprites.map((s) => s.id), prettyName(image));
      setSprites((prev) => [...prev, { id, name: prettyName(image), image, collisions: [] }]);
      if (spriteless) setDefaultSpriteId(id);
      selectSprite(id);
    } else if (pickingImageFor === "replace" && sprite) {
      updateSprite(sprite.id, (s) => ({ ...s, image }));
      setPickingImageFor(null);
    }
  }

  function duplicateSprite() {
    if (!sprite) return;
    const id = uniqueId(sprites.map((s) => s.id), `${sprite.id}-copy`);
    setSprites((prev) => [...prev, { ...structuredClone(sprite), id, name: `${sprite.name} copy` }]);
    selectSprite(id);
  }

  function deleteSprite() {
    if (!sprite) return;
    const remaining = sprites.filter((s) => s.id !== sprite.id);
    setSprites(remaining);
    if (defaultSpriteId === sprite.id) setDefaultSpriteId(remaining[0]?.id ?? "");
    selectSprite(remaining[0]?.id ?? "");
  }

  function save() {
    updateObjectDefinition(objectId, {
      sprites,
      defaultSpriteId: sprites.length ? defaultSpriteId : undefined,
      collisions: objectCollisions.length ? objectCollisions : undefined,
    });
    onClose();
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      if ((e.key === "Delete" || e.key === "Backspace") && selectedShapeId) {
        e.preventDefault();
        deleteShape();
      }
      if (e.key === "Escape") setSelectedShapeId(null);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  if (!def) return null;

  return (
    <div className="modal-backdrop">
      <div className="modal sprite-editor-modal">
        <div className="modal-header">Sprites &amp; collisions — {def.name}</div>
        <div className="sprite-editor-body">
          <aside className="sprite-list">
            <div className="sprite-list-header">
              <span className="field-label">Sprites</span>
              <button className="small-button" onClick={() => setPickingImageFor("new")}>
                <Plus size={12} /> Sprite
              </button>
            </div>
            {spriteless && (
              <div className="sprite-item active">
                <div className="object-thumb object-thumb-empty">
                  <Ghost size={16} />
                </div>
                <div className="sprite-item-meta">
                  <div className="object-name">No sprite</div>
                  <div className="object-id">invisible · {objectCollisions.length} shapes</div>
                </div>
              </div>
            )}
            {sprites.map((s) => (
              <button key={s.id} className={`sprite-item ${s.id === selectedSpriteId ? "active" : ""}`} onClick={() => selectSprite(s.id)}>
                <img src={assetUrl(s.image)} alt={s.name} />
                <div className="sprite-item-meta">
                  <div className="object-name">
                    {s.name} {s.id === defaultSpriteId && <span className="default-badge">default</span>}
                  </div>
                  <div className="object-id">
                    {s.collisions.length} shape{s.collisions.length === 1 ? "" : "s"}
                  </div>
                </div>
              </button>
            ))}
            {!spriteless && objectCollisions.length > 0 && (
              <div className="empty-hint">
                {objectCollisions.length} object-level shape(s) are kept for if this object loses all its sprites; sprites use their own.
              </div>
            )}
          </aside>

          <section className="collision-workspace">
            {pickingImageFor ? (
              <div className="sprite-image-picker">
                <div className="field-label">{pickingImageFor === "new" ? "Pick the new sprite's image" : "Replace this sprite's image"}</div>
                <AssetPicker selected={null} onSelect={pickImage} />
                <button className="secondary-button" onClick={() => setPickingImageFor(null)}>
                  Back
                </button>
              </div>
            ) : spriteless || sprite ? (
              <>
                <div className="shape-toolbar">
                  {SHAPE_BUTTONS.map((b) => (
                    <button key={b.type} className="tool-button" onClick={() => addShape(b.type)} disabled={!imageSize}>
                      <Plus size={13} />
                      <b.icon size={14} /> {b.label}
                    </button>
                  ))}
                  <span className="shape-toolbar-info">
                    {spriteless ? "Footprint space · 32 px per tile" : imageSize ? `${imageSize.width}×${imageSize.height}px` : ""}
                  </span>
                </div>
                <CollisionCanvas
                  image={spriteless ? null : sprite!.image}
                  footprintSize={footprintSpace(def)}
                  shapes={shapes}
                  selectedShapeId={selectedShapeId}
                  onSelect={setSelectedShapeId}
                  onChange={changeShape}
                  onImageSize={setImageSize}
                />
                <div className="empty-hint">
                  Drag a shape to move it · square handles resize · triangle vertices reshape · round handle rotates (Shift = 15° steps) · Del removes.
                </div>
              </>
            ) : null}
          </section>

          <aside className="shape-panel">
            {sprite && (
              <div className="sprite-settings">
                <label className="field-label">Sprite name</label>
                <input className="text-input" value={sprite.name} onChange={(e) => updateSprite(sprite.id, (s) => ({ ...s, name: e.target.value }))} />
                <div className="sprite-actions">
                  <button className="small-button" onClick={() => setDefaultSpriteId(sprite.id)} disabled={sprite.id === defaultSpriteId}>
                    Set default
                  </button>
                  <button className="small-button" onClick={() => setPickingImageFor("replace")}>
                    Change image
                  </button>
                  <button className="small-button" onClick={duplicateSprite}>
                    Duplicate
                  </button>
                  <button className="small-button" onClick={deleteSprite}>
                    Delete
                  </button>
                </div>
              </div>
            )}
            {spriteless && (
              <div className="empty-hint">
                This object has no sprite: it's invisible in-game (spawn point, trigger, invisible wall…). Shapes drawn here are its collisions.
              </div>
            )}
            {shape ? (
              <ShapeProperties shape={shape} onChange={changeShape} onDelete={deleteShape} />
            ) : (
              <div className="empty-hint">Add a shape with the buttons above, or click one to edit it.</div>
            )}
          </aside>
        </div>
        <div className="modal-footer">
          <button className="secondary-button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary-button" onClick={save} disabled={sprites.some((s) => !s.name.trim())}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
