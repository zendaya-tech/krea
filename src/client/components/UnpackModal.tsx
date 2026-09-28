import { useState } from "react";
import { pickFolder, unpackProject } from "../net/client";
import { useEditorStore } from "../stores/editorStore";

/** Writes the whole project (as currently edited, saved or not) as a plain folder: project.json + assets/…. */
export function UnpackModal({ onClose }: { onClose: () => void }) {
  const project = useEditorStore((s) => s.project);
  const [destination, setDestination] = useState("");
  const [overwrite, setOverwrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ folder: string; files: string[] } | null>(null);

  async function handleBrowse() {
    const res = await pickFolder().catch(() => null);
    if (res?.path) setDestination(res.path);
  }

  async function handleExport() {
    if (!project) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await unpackProject(project, destination.trim(), overwrite));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Export failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">Export project as folder</div>
        <div className="modal-body">
          <p className="modal-text">
            Writes everything inside the <code>.krea</code> as plain files — <code>project.json</code> plus the{" "}
            <code>assets/</code> images — e.g. to browse them, version them with Git, or let a tool edit them. It can be packed back
            into a <code>.krea</code> with <code>POST /api/agent/pack</code>.
          </p>
          <label className="field-label">Destination folder</label>
          <div className="path-field">
            <input className="text-input" placeholder="C:\my-world-unpacked" value={destination} onChange={(e) => setDestination(e.target.value)} autoFocus />
            <button className="secondary-button" onClick={() => void handleBrowse()}>
              Browse…
            </button>
          </div>
          <label className="menu-checkbox">
            <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />
            Overwrite an existing project.json there
          </label>
          {error && <div className="error-text">{error}</div>}
          {result && (
            <div className="export-result">
              Written to <code>{result.folder}</code> — {result.files.length} file(s).
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
