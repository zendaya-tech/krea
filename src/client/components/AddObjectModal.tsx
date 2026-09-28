import { useState } from "react";
import { Box, Image } from "lucide-react";
import type { ObjectKind } from "@core/map-types";
import type { EditableModel3D } from "@core/model3d";
import { getSprite } from "@core/map-utils";
import { useEditorStore } from "../stores/editorStore";
import { AssetPicker } from "./AssetPicker";
import { ModelEditorModal } from "./ModelEditorModal";

type Props = { onClose: () => void } & ({ mode: "add" } | { mode: "edit"; objectId: string });

/**
 * Creates a catalog object or edits its basics. An object can have no sprite
 * at all (invisible in-game: spawn point, trigger, invisible wall…). In edit
 * mode the image picked here replaces the default sprite's image; extra
 * sprites and collisions are managed in the sprite editor.
 */
export function AddObjectModal(props: Props) {
  const { onClose } = props;
  const project = useEditorStore((s) => s.project);
  const addObjectDefinition = useEditorStore((s) => s.addObjectDefinition);
  const updateObjectDefinition = useEditorStore((s) => s.updateObjectDefinition);

  const source = props.mode === "edit" ? project?.objects.find((o) => o.id === props.objectId) : undefined;
  const defaultSprite = getSprite(source);
  const sourceHasSprites = (source?.sprites.length ?? 0) > 0;

  const activeMapKind = useEditorStore((s) => s.project?.maps.find((m) => m.id === s.activeMapId)?.kind ?? "2d");
  const [kind, setKind] = useState<ObjectKind>(source?.kind ?? activeMapKind);
  const [model, setModel] = useState<string | null>(source?.model ?? null);
  const [modelSource, setModelSource] = useState<EditableModel3D | undefined>(source?.modelSource);
  const [showModelEditor, setShowModelEditor] = useState(false);
  const [noModel, setNoModel] = useState(props.mode === "edit" && source?.kind === "3d" && !source.model);
  const [image, setImage] = useState<string | null>(defaultSprite?.image ?? null);
  const [noSprite, setNoSprite] = useState(props.mode === "edit" && !sourceHasSprites);
  const [name, setName] = useState(source?.name ?? "");
  const [description, setDescription] = useState(source?.description ?? "");
  const [sizeWidth, setSizeWidth] = useState(source?.sizeInTiles?.width ?? 1);
  const [sizeHeight, setSizeHeight] = useState(source?.sizeInTiles?.height ?? 1);

  const usedImages = new Set(project?.objects.flatMap((o) => o.sprites.map((s) => s.image)) ?? []);
  const canSubmit = name.trim() !== "" && (kind === "3d" ? noModel || model !== null : noSprite || image !== null);

  function handleSubmit() {
    if (!canSubmit) return;
    const width = Math.max(1, Math.round(sizeWidth) || 1);
    const height = Math.max(1, Math.round(sizeHeight) || 1);
    const sizeInTiles = width === 1 && height === 1 ? undefined : { width, height };
    const basics = { name: name.trim(), description: description.trim() || undefined, sizeInTiles };
    if (kind === "3d") {
      const chosen = noModel ? undefined : (model ?? undefined);
      if (props.mode === "edit" && source)
        updateObjectDefinition(props.objectId, { name: basics.name, description: basics.description, model: chosen, modelSource: chosen ? modelSource : undefined });
      else addObjectDefinition({ name: basics.name, description: basics.description, kind: "3d", model: chosen, modelSource: chosen ? modelSource : undefined });
      onClose();
      return;
    }
    if (props.mode === "edit" && source) {
      if (sourceHasSprites) {
        updateObjectDefinition(props.objectId, {
          ...basics,
          sprites: source.sprites.map((s) => (s.id === source.defaultSpriteId ? { ...s, image: image! } : s)),
        });
      } else if (!noSprite && image) {
        updateObjectDefinition(props.objectId, {
          ...basics,
          sprites: [{ id: "default", name: "Default", image, collisions: [] }],
          defaultSpriteId: "default",
        });
      } else {
        updateObjectDefinition(props.objectId, basics);
      }
    } else {
      addObjectDefinition({ ...basics, kind: "2d", image: noSprite ? undefined : image! });
    }
    onClose();
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">{props.mode === "edit" ? "Edit Object" : "Add Object"}</div>
        <div className="modal-body">
          <label className="field-label">Type</label>
          <div className="kind-choice">
            <button
              type="button"
              className={`kind-option ${kind === "2d" ? "active" : ""}`}
              disabled={props.mode === "edit"}
              onClick={() => setKind("2d")}
            >
              <Image size={16} />
              <span>
                <strong>2D</strong> — sprites. Tiles on 2D maps, upright billboards on 3D maps.
              </span>
            </button>
            <button
              type="button"
              className={`kind-option ${kind === "3d" ? "active" : ""}`}
              disabled={props.mode === "edit"}
              onClick={() => setKind("3d")}
            >
              <Box size={16} />
              <span>
                <strong>3D</strong> — a .glb model, for 3D maps only.
              </span>
            </button>
          </div>

          <label className="field-label">Name</label>
          <input className="text-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Tree" autoFocus />

          <label className="field-label">Description (optional)</label>
          <textarea
            className="text-input textarea-input"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="A short note about this object…"
            rows={2}
          />

          {kind === "3d" ? (
            <>
              <label className="menu-checkbox no-sprite-option">
                <input type="checkbox" checked={noModel} onChange={(e) => setNoModel(e.target.checked)} />
                No model — invisible 3D marker (spawn point, trigger zone, waypoint…)
              </label>
              {!noModel && (
                <AssetPicker
                  kind="model"
                  selected={model}
                  onSelect={(path) => { setModel(path); if (path !== model) setModelSource(undefined); }}
                  onCreate={() => setShowModelEditor(true)}
                  onImported={(_path, fileName) => {
                    if (name.trim()) return;
                    const base = fileName
                      .replace(/\.[^.]+$/, "")
                      .replace(/[-_]+/g, " ")
                      .trim();
                    setName(base ? base[0].toUpperCase() + base.slice(1) : "");
                  }}
                />
              )}
            </>
          ) : (
            <>
              <label className="field-label">Size (tiles)</label>
              <div className="size-fields">
                <input
                  className="text-input number-input"
                  type="number"
                  min={1}
                  value={sizeWidth}
                  onChange={(e) => setSizeWidth(Number(e.target.value))}
                  aria-label="Width in tiles"
                />
                <span className="size-fields-sep">×</span>
                <input
                  className="text-input number-input"
                  type="number"
                  min={1}
                  value={sizeHeight}
                  onChange={(e) => setSizeHeight(Number(e.target.value))}
                  aria-label="Height in tiles"
                />
                <span className="size-fields-hint">e.g. 2×2 for a house</span>
              </div>

              {!sourceHasSprites && (
                <label className="menu-checkbox no-sprite-option">
                  <input type="checkbox" checked={noSprite} onChange={(e) => setNoSprite(e.target.checked)} />
                  No sprite — invisible object (spawn point, trigger, invisible wall…)
                </label>
              )}
              {props.mode === "edit" && (source?.sprites.length ?? 0) > 1 && (
                <div className="empty-hint">
                  The image below is the default sprite's. Other sprites are edited in "Sprites & collisions".
                </div>
              )}
              {noSprite ? (
                <div className="empty-hint">
                  It shows as a dashed box in the editor. You can still give it collisions in "Sprites &amp; collisions".
                </div>
              ) : (
                <AssetPicker
                  selected={image}
                  onSelect={setImage}
                  usedImages={usedImages}
                  onImported={(_path, fileName) => {
                    if (name.trim()) return;
                    const base = fileName
                      .replace(/\.[^.]+$/, "")
                      .replace(/[-_]+/g, " ")
                      .trim();
                    setName(base ? base[0].toUpperCase() + base.slice(1) : "");
                  }}
                />
              )}
            </>
          )}
        </div>
        <div className="modal-footer">
          <button className="secondary-button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary-button" onClick={handleSubmit} disabled={!canSubmit}>
            {props.mode === "edit" ? "Save Changes" : "Add Object"}
          </button>
        </div>
      </div>
      {showModelEditor && <ModelEditorModal
        name={name}
        initial={modelSource}
        onClose={() => setShowModelEditor(false)}
        onSave={(path, editable) => { setModel(path); setModelSource(editable); setNoModel(false); setShowModelEditor(false); if (!name.trim()) setName("New 3D model"); }}
      />}
    </div>
  );
}
