import { useState } from "react";
import type { ExportResponse } from "@shared/api-types";
import { pickFolder } from "../net/client";
import { selectActiveMap, useEditorStore } from "../stores/editorStore";

/** Exports the active map to a game-ready JSON file (plus its images) at a chosen location. */
export function ExportModal({ onClose }: { onClose: () => void }) {
  const map = useEditorStore(selectActiveMap);
  const exportActiveMap = useEditorStore((s) => s.exportActiveMap);
  const [destination, setDestination] = useState("");
  const [overwrite, setOverwrite] = useState(false);
  const [copyAssets, setCopyAssets] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ExportResponse | null>(null);

  async function handleBrowse() {
    const res = await pickFolder().catch(() => null);
    if (res?.path) setDestination(res.path);
  }

  async function handleExport() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await exportActiveMap({ destination: destination.trim(), overwrite, copyAssets }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Export failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">Export map — {map?.name}</div>
        <div className="modal-body">
          <p className="modal-text">
            Writes a game-ready JSON file: the objects this map uses (sprites + collisions), every placed instance with its
            pixel rectangle, and its collisions resolved to world pixels.
          </p>
          <label className="field-label">Destination (folder, or a .json file path)</label>
          <div className="path-field">
            <input
              className="text-input"
              placeholder="C:\my-game\levels"
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
              autoFocus
            />
            <button className="secondary-button" onClick={() => void handleBrowse()}>
              Browse…
            </button>
          </div>
          <label className="menu-checkbox">
            <input type="checkbox" checked={copyAssets} onChange={(e) => setCopyAssets(e.target.checked)} />
            Copy images next to the exported file
          </label>
          <label className="menu-checkbox">
            <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />
            Overwrite existing files
          </label>
          {error && <div className="error-text">{error}</div>}
          {result && (
            <div className="export-result">
              Exported to <code>{result.file}</code>
              {result.assetsCopied.length > 0 && <div>{result.assetsCopied.length} image(s) copied.</div>}
              {result.assetsSkipped.length > 0 && <div>{result.assetsSkipped.length} image(s) skipped (already present).</div>}
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="secondary-button" onClick={onClose}>
            {result ? "Close" : "Cancel"}
          </button>
          <button className="primary-button" onClick={() => void handleExport()} disabled={busy || !destination.trim()}>
            {busy ? "Exporting…" : "Export"}
          </button>
        </div>
      </div>
    </div>
  );
}
