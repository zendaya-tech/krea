import { selectActiveMap, useEditorStore } from "../stores/editorStore";

export function StatusBar() {
  const map = useEditorStore(selectActiveMap);
  const camera = useEditorStore((s) => s.camera);
  const hoverCell = useEditorStore((s) => s.hoverCell);
  const hoverPoint = useEditorStore((s) => s.hoverPoint);
  const saveStatus = useEditorStore((s) => s.saveStatus);
  const saveError = useEditorStore((s) => s.saveError);
  const issues = useEditorStore((s) => s.issues);
  const migratedFrom = useEditorStore((s) => s.migratedFrom);

  if (!map) return <div className="status-bar" />;

  const errorCount = issues.filter((i) => i.severity === "error").length;

  return (
    <div className="status-bar">
      <span>{map.name}</span>
      <span className="status-sep">|</span>
      {map.kind === "2d" ? (
        <>
          <span>
            Map {map.settings.width}×{map.settings.height}
          </span>
          <span className="status-sep">|</span>
          <span>
            Tile {map.settings.tileWidth}×{map.settings.tileHeight}
          </span>
          <span className="status-sep">|</span>
          <span>Zoom {Math.round(camera.zoom * 100)}%</span>
          <span className="status-sep">|</span>
          <span>Cursor {hoverCell ? `${hoverCell.x}, ${hoverCell.y}` : "—"}</span>
        </>
      ) : (
        <>
          <span>
            3D terrain {map.terrain.size.width}×{map.terrain.size.depth} m
          </span>
          <span className="status-sep">|</span>
          <span>{map.placements.length} objects</span>
          <span className="status-sep">|</span>
          <span>
            Cursor{" "}
            {hoverPoint ? `x ${hoverPoint.x.toFixed(1)}  z ${hoverPoint.z.toFixed(1)}  height ${hoverPoint.y.toFixed(2)} m` : "—"}
          </span>
        </>
      )}
      <span className="status-sep">|</span>
      <span className={errorCount > 0 ? "status-error" : "status-ok"}>
        {errorCount > 0 ? `${errorCount} validation error${errorCount > 1 ? "s" : ""}` : "Valid"}
      </span>
      {migratedFrom && (
        <>
          <span className="status-sep">|</span>
          <span className="status-warn">Converted from {migratedFrom} — save to create the .krea file</span>
        </>
      )}
      <span className="status-spacer" />
      <span className={`save-indicator save-${saveStatus}`}>
        {saveStatus === "saving" && "Saving…"}
        {saveStatus === "saved" && "Saved"}
        {saveStatus === "error" && (saveError ?? "Save failed")}
      </span>
    </div>
  );
}
