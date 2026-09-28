import { Box, Grid3x3 } from "lucide-react";

export type MapFormat =
  | { kind: "2d"; width: number; height: number; tileWidth: number; tileHeight: number }
  | { kind: "3d"; width: number; depth: number; resolution: number };

export const DEFAULT_2D: MapFormat = { kind: "2d", width: 20, height: 15, tileWidth: 32, tileHeight: 32 };
export const DEFAULT_3D: MapFormat = { kind: "3d", width: 128, depth: 128, resolution: 129 };

const RESOLUTIONS = [65, 129, 257, 513];

export function isMapFormatValid(f: MapFormat): boolean {
  if (f.kind === "2d") return [f.width, f.height, f.tileWidth, f.tileHeight].every((v) => Number.isInteger(v) && v > 0);
  return f.width > 0 && f.depth > 0 && RESOLUTIONS.includes(f.resolution);
}

/** The 2D / 3D choice for a new map, with the matching size fields. */
export function MapKindFields({ value, onChange }: { value: MapFormat; onChange: (f: MapFormat) => void }) {
  const field = (label: string, v: number, set: (n: number) => void, step?: number) => (
    <label>
      {label}
      <input className="text-input" type="number" min={1} step={step} value={v} onChange={(e) => set(Number(e.target.value))} />
    </label>
  );

  return (
    <>
      <div className="kind-choice">
        <button type="button" className={`kind-option ${value.kind === "2d" ? "active" : ""}`} onClick={() => onChange(DEFAULT_2D)}>
          <Grid3x3 size={16} />
          <span>
            <strong>2D</strong> — tile grid, top-down or side view.
          </span>
        </button>
        <button type="button" className={`kind-option ${value.kind === "3d" ? "active" : ""}`} onClick={() => onChange(DEFAULT_3D)}>
          <Box size={16} />
          <span>
            <strong>3D</strong> — sculptable terrain with painted textures, water, 3D objects.
          </span>
        </button>
      </div>
      {value.kind === "2d" ? (
        <div className="new-project-grid">
          {field("Width (tiles)", value.width, (width) => onChange({ ...value, width }))}
          {field("Height (tiles)", value.height, (height) => onChange({ ...value, height }))}
          {field("Tile width (px)", value.tileWidth, (tileWidth) => onChange({ ...value, tileWidth }))}
          {field("Tile height (px)", value.tileHeight, (tileHeight) => onChange({ ...value, tileHeight }))}
        </div>
      ) : (
        <div className="new-project-grid">
          {field("Width (m)", value.width, (width) => onChange({ ...value, width }))}
          {field("Depth (m)", value.depth, (depth) => onChange({ ...value, depth }))}
          <label>
            Heightmap detail
            <select className="text-input" value={value.resolution} onChange={(e) => onChange({ ...value, resolution: Number(e.target.value) })}>
              {RESOLUTIONS.map((r) => (
                <option key={r} value={r}>
                  {r} × {r} {r === 129 ? "(recommended)" : r > 257 ? "(heavy)" : ""}
                </option>
              ))}
            </select>
          </label>
          <div className="field-hint">≈ {(value.width / (value.resolution - 1)).toFixed(2)} m between samples</div>
        </div>
      )}
    </>
  );
}
