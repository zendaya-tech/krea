import { getObjectSize } from "@core/map-utils";
import { selectActiveMap, useEditorStore } from "../stores/editorStore";

export function PropertiesPanel() {
  const project = useEditorStore((s) => s.project);
  const map = useEditorStore(selectActiveMap);
  const selectedInstances = useEditorStore((s) => s.selectedInstances);
  const updateSelectedPosition = useEditorStore((s) => s.updateSelectedPosition);
  const setSelectedSprite = useEditorStore((s) => s.setSelectedSprite);
  const deleteSelectedInstances = useEditorStore((s) => s.deleteSelectedInstances);
  const resizeMap = useEditorStore((s) => s.resizeMap);
  const renameMap = useEditorStore((s) => s.renameMap);
  const renameProject = useEditorStore((s) => s.renameProject);

  if (!project || !map || map.kind !== "2d") return null;

  if (selectedInstances.length > 1) {
    return (
      <div className="panel properties-panel">
        <div className="panel-header">Properties</div>
        <div className="properties-body">
          <div className="prop-row">
            <span className="prop-label">Selection</span>
            <span className="prop-value">{selectedInstances.length} objects</span>
          </div>
          <button className="secondary-button danger-button" onClick={deleteSelectedInstances}>
            Delete Selected
          </button>
        </div>
      </div>
    );
  }

  if (selectedInstances.length === 1) {
    const sel = selectedInstances[0];
    const inst = map.mapping.find((m) => m.layerId === sel.layerId && m.x === sel.x && m.y === sel.y);
    const def = project.objects.find((o) => o.id === inst?.objectId);
    const layer = map.layers.find((l) => l.id === sel.layerId);
    const size = getObjectSize(def);
    const defaultSprite = def?.sprites.find((s) => s.id === def.defaultSpriteId);
    return (
      <div className="panel properties-panel">
        <div className="panel-header">Properties</div>
        <div className="properties-body">
          <div className="prop-row">
            <span className="prop-label">Object</span>
            <span className="prop-value">{def?.name ?? "?"}</span>
          </div>
          <div className="prop-row">
            <span className="prop-label">ID</span>
            <span className="prop-value">{def?.id ?? "?"}</span>
          </div>
          <div className="prop-row">
            <span className="prop-label">Layer</span>
            <span className="prop-value">{layer?.name ?? "?"}</span>
          </div>
          <div className="prop-row">
            <span className="prop-label">Size</span>
            <span className="prop-value">
              {size.width} × {size.height} tiles
            </span>
          </div>
          {def && def.sprites.length === 0 && (
            <div className="prop-row">
              <span className="prop-label">Sprite</span>
              <span className="prop-value">none (invisible)</span>
            </div>
          )}
          {def && def.sprites.length > 1 && (
            <div className="prop-row">
              <span className="prop-label">Sprite</span>
              <select
                className="text-input prop-select"
                value={inst?.spriteId ?? ""}
                onChange={(e) => setSelectedSprite(e.target.value || null)}
              >
                <option value="">Default ({defaultSprite?.name})</option>
                {def.sprites.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="prop-row">
            <span className="prop-label">X</span>
            <NumberField value={sel.x} onCommit={(x) => updateSelectedPosition(x, sel.y)} />
          </div>
          <div className="prop-row">
            <span className="prop-label">Y</span>
            <NumberField value={sel.y} onCommit={(y) => updateSelectedPosition(sel.x, y)} />
          </div>
          {def?.description && (
            <div className="prop-row prop-row-stacked">
              <span className="prop-label">Description</span>
              <span className="prop-value prop-description">{def.description}</span>
            </div>
          )}
          <button className="secondary-button danger-button" onClick={deleteSelectedInstances}>
            Delete
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="panel properties-panel">
      <div className="panel-header">Map</div>
      <div className="properties-body">
        <div className="prop-row">
          <span className="prop-label">Project</span>
          <input key={project.name} className="text-input" defaultValue={project.name} onBlur={(e) => renameProject(e.target.value)} />
        </div>
        <div className="prop-row">
          <span className="prop-label">Map</span>
          <input key={map.id + map.name} className="text-input" defaultValue={map.name} onBlur={(e) => renameMap(map.id, e.target.value)} />
        </div>
        <div className="prop-row">
          <span className="prop-label">Width</span>
          <NumberField value={map.settings.width} onCommit={(w) => resizeMap(w, map.settings.height)} />
        </div>
        <div className="prop-row">
          <span className="prop-label">Height</span>
          <NumberField value={map.settings.height} onCommit={(h) => resizeMap(map.settings.width, h)} />
        </div>
        <div className="prop-row">
          <span className="prop-label">Tile size</span>
          <span className="prop-value">
            {map.settings.tileWidth} × {map.settings.tileHeight}
          </span>
        </div>
        <div className="empty-hint">Select a placed object to edit its properties.</div>
      </div>
    </div>
  );
}

function NumberField({ value, onCommit }: { value: number; onCommit: (v: number) => void }) {
  return (
    <input
      key={value}
      className="text-input number-input"
      type="number"
      defaultValue={value}
      onBlur={(e) => {
        const parsed = Number(e.currentTarget.value);
        if (Number.isInteger(parsed) && parsed >= 0 && parsed !== value) onCommit(parsed);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
    />
  );
}
