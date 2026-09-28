import { useEffect, useState } from "react";
import { Box, Plus, Upload } from "lucide-react";
import { assetUrl, fetchProjectAssets, importAsset } from "../net/client";

const MODEL_RE = /\.glb$/i;

/**
 * Grid of the images (or .glb models) stored in the open .krea project, plus
 * an "Import from computer…" button that adds a file from disk into the project.
 */
export function AssetPicker({
  selected,
  onSelect,
  usedImages,
  onImported,
  onCreate,
  kind = "image",
  label,
}: {
  kind?: "image" | "model";
  label?: string;
  selected: string | null;
  onSelect: (path: string) => void;
  usedImages?: Set<string>;
  /** Called with the original file name after an import, e.g. to prefill a name field. */
  onImported?: (path: string, fileName: string) => void;
  onCreate?: () => void;
}) {
  const [assets, setAssets] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    fetchProjectAssets()
      .then((res) => setAssets(res.assets.filter((a) => MODEL_RE.test(a) === (kind === "model"))))
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to list project images."));
  }, [kind]);

  useEffect(() => {
    if (selected && !assets.includes(selected)) setAssets((previous) => [...previous, selected].sort());
  }, [selected]);

  async function handleImport(file: File) {
    setImporting(true);
    setError(null);
    try {
      const res = await importAsset(file);
      setAssets((prev) => (prev.includes(res.path) ? prev : [...prev, res.path].sort()));
      onSelect(res.path);
      onImported?.(res.path, file.name);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to import file.");
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="asset-picker">
      <div className="field-label-row">
        <label className="field-label">{label ?? (kind === "model" ? "3D model (.glb, stored in the project)" : "Image (stored in the project)")}</label>
        {onCreate && <button type="button" className="small-button" onClick={onCreate}><Plus size={12} /> Create</button>}
        <label className="small-button file-import-button">
          <Upload size={12} /> {importing ? "Importing…" : "Import from computer…"}
          <input
            type="file"
            accept={kind === "model" ? ".glb,model/gltf-binary" : "image/png,image/jpeg,image/gif,image/webp,image/bmp"}
            hidden
            disabled={importing}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void handleImport(file);
            }}
          />
        </label>
      </div>
      {error && <div className="error-text">{error}</div>}
      <div className="asset-grid">
        {assets.map((path) => (
          <button
            key={path}
            type="button"
            className={`asset-item ${selected === path ? "active" : ""}`}
            onClick={() => onSelect(path)}
            title={path}
          >
            {kind === "model" ? (
              <div className="asset-model-icon">
                <Box size={28} />
              </div>
            ) : (
              <img src={assetUrl(path)} alt={path} />
            )}
            <div className="asset-name">{path.replace(/^assets\//, "")}</div>
            {usedImages?.has(path) && <div className="asset-used">in use</div>}
          </button>
        ))}
        {assets.length === 0 && !error && <div className="empty-hint">{kind === "model" ? "No models yet — import a .glb." : "No images yet — import one."}</div>}
      </div>
    </div>
  );
}
