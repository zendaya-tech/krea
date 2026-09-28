import { useState } from "react";
import { Copy, Droplets, Mountain, Plus, Sparkles, Sprout, Trash2, Trees, Waves } from "lucide-react";
import { detailCoverage } from "@core/details";
import type { Map3D, TerrainLayer } from "@core/map-types";
import { MAX_TERRAIN_LAYERS } from "@core/map-types";
import { heightAt, terrainStats } from "@core/terrain";
import { DEFAULT_WATER_COLOR, spillLevel, waterMask, waterSampleCount } from "@core/water";
import { selectActive3DMap, useEditorStore } from "../stores/editorStore";
import { AssetPicker } from "./AssetPicker";

/** Right column of the 3D editor: the selected placements' properties, or the terrain settings. */
export function Panel3D() {
  const map = useEditorStore(selectActive3DMap);
  const selected = useEditorStore((s) => s.selectedPlacementIds);
  const tool = useEditorStore((s) => s.tool3d);
  if (!map) return null;
  return selected.length > 0 ? <PlacementProperties map={map} ids={selected} /> : tool === "place" ? <PlacePanel map={map} /> : <TerrainPanel map={map} />;
}

function PlacePanel({ map }: { map: Map3D }) {
  const project = useEditorStore((s) => s.project)!;
  const selectedObjectId = useEditorStore((s) => s.selectedObjectId);
  const activeLayerId = useEditorStore((s) => s.activeLayerId);
  const placeScatter = useEditorStore((s) => s.placeScatter);
  const placeCount = useEditorStore((s) => s.placeCount);
  const placeRadius = useEditorStore((s) => s.placeRadius);
  const placeSpacing = useEditorStore((s) => s.placeSpacing);
  const placeMaxSlope = useEditorStore((s) => s.placeMaxSlope);
  const placeOnTerrainLayerId = useEditorStore((s) => s.placeOnTerrainLayerId);
  const placeWater = useEditorStore((s) => s.placeWater);
  const placeRandomize = useEditorStore((s) => s.placeRandomize);
  const placeHint = useEditorStore((s) => s.placeHint);
  const setPlaceSettings = useEditorStore((s) => s.setPlaceSettings);
  const setPlaceRandomize = useEditorStore((s) => s.setPlaceRandomize);
  const scatter = useEditorStore((s) => s.scatter);
  const [wholeMapHint, setWholeMapHint] = useState<string | null>(null);
  const def = project.objects.find((o) => o.id === selectedObjectId);
  const layer = map.layers.find((l) => l.id === activeLayerId);

  return (
    <div className="panel properties-panel terrain-panel">
      <div className="panel-header">Place objects</div>
      <div className="properties-body">
        <div className="empty-hint">
          Select an object on the left, then click the terrain. Grass and flowers are ordinary objects: import a transparent PNG as a 2D billboard or a .glb model.
        </div>
        <div className="prop-row"><span className="prop-label">Object</span><span className="prop-value">{def?.name ?? "None selected"}</span></div>
        <div className="prop-row"><span className="prop-label">Layer</span><span className="prop-value">{layer?.name ?? "None"}{layer?.locked ? " (locked)" : ""}</span></div>
        <div className="section-title"><Trees size={13} /> Placement</div>
        <div className="detail-presets">
          <button className={`small-button ${!placeScatter ? "active" : ""}`} onClick={() => setPlaceSettings({ placeScatter: false })}>One object</button>
          <button className={`small-button ${placeScatter ? "active" : ""}`} onClick={() => setPlaceSettings({ placeScatter: true })}>Scatter on click</button>
        </div>
        {placeScatter && (
          <>
            <NumberRow label="Copies / click" value={placeCount} step={1} min={1} onCommit={(v) => setPlaceSettings({ placeCount: Math.min(500, Math.round(v)) })} />
            <NumberRow label="Radius (m)" value={placeRadius} min={0.1} onCommit={(v) => setPlaceSettings({ placeRadius: Math.min(200, v) })} />
            <NumberRow label="Spacing (m)" value={placeSpacing} min={0} onCommit={(v) => setPlaceSettings({ placeSpacing: Math.min(50, v) })} />
            <NumberRow label="Max slope °" value={placeMaxSlope} min={0} onCommit={(v) => setPlaceSettings({ placeMaxSlope: Math.min(90, v) })} />
            <div className="prop-row">
              <span className="prop-label">Ground</span>
              <select className="text-input prop-select" value={placeOnTerrainLayerId ?? ""} onChange={(e) => setPlaceSettings({ placeOnTerrainLayerId: e.target.value || null })}>
                <option value="">Any texture</option>
                {map.terrain.layers.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </div>
            <div className="prop-row">
              <span className="prop-label">Water</span>
              <select className="text-input prop-select" value={placeWater} onChange={(e) => setPlaceSettings({ placeWater: e.target.value as "avoid" | "only" | "any" })}>
                <option value="avoid">Dry land</option><option value="only">Under water</option><option value="any">Anywhere</option>
              </select>
            </div>
          </>
        )}
        <label className="menu-checkbox">
          <input type="checkbox" checked={placeRandomize} onChange={(e) => setPlaceRandomize(e.target.checked)} />
          Random rotation and size variation
        </label>
        {placeScatter && <div className="empty-hint">The green circle previews the area. Copies use the selected object and can be undone in one step.</div>}
        {placeHint && <div className="empty-hint">{placeHint}</div>}
        {placeScatter && (
          <>
            <button className="secondary-button" disabled={!def || !layer || layer.locked} onClick={() => {
              const placed = scatter({ count: placeCount, minDistance: placeSpacing, maxSlope: placeMaxSlope, onTerrainLayerId: placeOnTerrainLayerId ?? undefined, water: placeWater, randomRotation: placeRandomize, scaleMin: placeRandomize ? 0.85 : 1, scaleMax: placeRandomize ? 1.15 : 1, seed: Math.floor(Math.random() * 1e9) });
              setWholeMapHint(placed ? `Placed ${placed} objects across the map.` : "No valid position matched the settings.");
            }}>Scatter across whole map</button>
            {wholeMapHint && <div className="empty-hint">{wholeMapHint}</div>}
          </>
        )}
      </div>
    </div>
  );
}

function PlacementProperties({ map, ids }: { map: Map3D; ids: string[] }) {
  const project = useEditorStore((s) => s.project)!;
  const updatePlacements = useEditorStore((s) => s.updatePlacements);
  const deleteSelected = useEditorStore((s) => s.deleteSelectedPlacements);
  const duplicateSelected = useEditorStore((s) => s.duplicateSelectedPlacements);
  const placements = map.placements.filter((p) => ids.includes(p.id));

  if (placements.length !== 1) {
    return (
      <div className="panel properties-panel">
        <div className="panel-header">Properties</div>
        <div className="properties-body">
          <div className="prop-row">
            <span className="prop-label">Selection</span>
            <span className="prop-value">{placements.length} objects</span>
          </div>
          <button className="secondary-button" onClick={duplicateSelected}>
            <Copy size={13} /> Duplicate (Ctrl+D)
          </button>
          <button className="secondary-button danger-button" onClick={deleteSelected}>
            <Trash2 size={13} /> Delete Selected
          </button>
        </div>
      </div>
    );
  }

  const p = placements[0];
  const def = project.objects.find((o) => o.id === p.objectId);
  const set = (patch: Record<string, unknown>) => updatePlacements([{ id: p.id, ...patch }]);
  const defaultSprite = def?.sprites.find((s) => s.id === def.defaultSpriteId);

  return (
    <div className="panel properties-panel">
      <div className="panel-header">Properties</div>
      <div className="properties-body">
        <div className="prop-row">
          <span className="prop-label">Object</span>
          <span className="prop-value">
            {def?.name ?? "?"} <span className="kind-badge">{def?.kind === "3d" ? "3D" : "2D"}</span>
          </span>
        </div>
        <div className="prop-row">
          <span className="prop-label">ID</span>
          <span className="prop-value">{p.id}</span>
        </div>
        <div className="prop-row">
          <span className="prop-label">Layer</span>
          <select className="text-input prop-select" value={p.layerId} onChange={(e) => set({ layerId: e.target.value })}>
            {map.layers.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </div>
        {def && def.kind === "2d" && def.sprites.length > 1 && (
          <div className="prop-row">
            <span className="prop-label">Sprite</span>
            <select className="text-input prop-select" value={p.spriteId ?? ""} onChange={(e) => set({ spriteId: e.target.value || null })}>
              <option value="">Default ({defaultSprite?.name})</option>
              {def.sprites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <NumberRow label="X (m)" value={p.x} onCommit={(x) => set({ x })} />
        <NumberRow label="Z (m)" value={p.z} onCommit={(z) => set({ z })} />
        <NumberRow label="Elevation" value={p.elevation} onCommit={(elevation) => set({ elevation })} />
        <NumberRow label="Rotation °" value={p.rotation} onCommit={(rotation) => set({ rotation })} />
        <NumberRow label="Scale" value={p.scale} min={0.01} onCommit={(scale) => set({ scale })} />
        {def?.description && (
          <div className="prop-row prop-row-stacked">
            <span className="prop-label">Description</span>
            <span className="prop-value prop-description">{def.description}</span>
          </div>
        )}
        <div className="empty-hint">Gizmo: W move · E rotate · R scale. F frames the selection.</div>
        <button className="secondary-button" onClick={duplicateSelected}>
          <Copy size={13} /> Duplicate (Ctrl+D)
        </button>
        <button className="secondary-button danger-button" onClick={deleteSelected}>
          <Trash2 size={13} /> Delete
        </button>
      </div>
    </div>
  );
}

function TerrainPanel({ map }: { map: Map3D }) {
  const project = useEditorStore((s) => s.project)!;
  const renameMap = useEditorStore((s) => s.renameMap);
  const renameProject = useEditorStore((s) => s.renameProject);
  const paintLayerId = useEditorStore((s) => s.paintLayerId);
  const setPaintLayer = useEditorStore((s) => s.setPaintLayer);
  const updateTerrainLayer = useEditorStore((s) => s.updateTerrainLayer);
  const removeTerrainLayer = useEditorStore((s) => s.removeTerrainLayer);
  const addTerrainLayer = useEditorStore((s) => s.addTerrainLayer);
  const setWaterLevel = useEditorStore((s) => s.setWaterLevel);
  const [texturePickerFor, setTexturePickerFor] = useState<string | null>(null);
  const t = map.terrain;

  return (
    <div className="panel properties-panel terrain-panel">
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
          <span className="prop-label">Terrain</span>
          <span className="prop-value">
            {t.size.width} × {t.size.depth} m · {t.resolution}²
          </span>
        </div>

        <div className="section-title">
          <Mountain size={13} /> Texture layers
        </div>
        {t.layers.map((layer, i) => (
          <TerrainLayerRow
            key={layer.id}
            layer={layer}
            index={i}
            active={paintLayerId === layer.id}
            canRemove={t.layers.length > 1}
            onPick={() => setPaintLayer(layer.id)}
            onChange={(patch) => updateTerrainLayer(layer.id, patch)}
            onRemove={() => removeTerrainLayer(layer.id)}
            onPickTexture={() => setTexturePickerFor(layer.id)}
          />
        ))}
        {t.layers.length < MAX_TERRAIN_LAYERS && (
          <button className="small-button" onClick={() => addTerrainLayer({ name: "Layer", color: "#8a7a5a", tileSize: 4 })}>
            <Plus size={12} /> Add layer
          </button>
        )}

        <div className="section-title">
          <Waves size={13} /> Sea
        </div>
        <label className="menu-checkbox">
          <input type="checkbox" checked={t.waterLevel !== null} onChange={(e) => setWaterLevel(e.target.checked ? 0 : null)} />
          Sea — covers everything below its level
        </label>
        {t.waterLevel !== null && <NumberRow label="Level (m)" value={t.waterLevel} onCommit={(v) => setWaterLevel(v)} />}

        <LakesPanel map={map} />
        {t.detailLayers.length > 0 && <DetailsPanel map={map} />}

        <GeneratePanel />
        <AutoPaintPanel map={map} />
      </div>
      {texturePickerFor && (
        <div className="modal-backdrop" onClick={() => setTexturePickerFor(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">Layer texture</div>
            <div className="modal-body">
              <AssetPicker
                label="Tiling image (stored in the project)"
                selected={t.layers.find((l) => l.id === texturePickerFor)?.texture ?? null}
                onSelect={(path) => {
                  updateTerrainLayer(texturePickerFor, { texture: path });
                  setTexturePickerFor(null);
                }}
              />
            </div>
            <div className="modal-footer">
              <button
                className="secondary-button"
                onClick={() => {
                  updateTerrainLayer(texturePickerFor, { texture: undefined });
                  setTexturePickerFor(null);
                }}
              >
                Use plain color
              </button>
              <button className="secondary-button" onClick={() => setTexturePickerFor(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function TerrainLayerRow(props: {
  layer: TerrainLayer;
  index: number;
  active: boolean;
  canRemove: boolean;
  onPick: () => void;
  onChange: (patch: Partial<TerrainLayer>) => void;
  onRemove: () => void;
  onPickTexture: () => void;
}) {
  const { layer } = props;
  return (
    <div className={`terrain-layer ${props.active ? "active" : ""}`} onClick={props.onPick} title="Click to paint with this layer">
      <input
        type="color"
        className="color-swatch"
        value={layer.color}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => props.onChange({ color: e.target.value })}
        title="Color (used when there's no texture)"
      />
      <div className="terrain-layer-meta">
        <input
          key={layer.name}
          className="text-input terrain-layer-name"
          defaultValue={layer.name}
          onClick={(e) => e.stopPropagation()}
          onBlur={(e) => e.target.value.trim() && e.target.value !== layer.name && props.onChange({ name: e.target.value.trim() })}
        />
        <div className="terrain-layer-sub">
          <button
            className="link-button"
            onClick={(e) => {
              e.stopPropagation();
              props.onPickTexture();
            }}
          >
            {layer.texture ? layer.texture.replace(/^assets\//, "") : "no texture"}
          </button>
          <span>tile</span>
          <input
            key={layer.tileSize}
            className="text-input tiny-number"
            type="number"
            min={0.1}
            step={0.5}
            defaultValue={layer.tileSize}
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => {
              const v = Number(e.target.value);
              if (v > 0 && v !== layer.tileSize) props.onChange({ tileSize: v });
            }}
          />
          <span>m</span>
        </div>
      </div>
      {props.canRemove && (
        <button
          className="icon-button"
          title="Remove layer"
          onClick={(e) => {
            e.stopPropagation();
            props.onRemove();
          }}
        >
          <Trash2 size={12} />
        </button>
      )}
    </div>
  );
}

function LakesPanel({ map }: { map: Map3D }) {
  const selectedWaterId = useEditorStore((s) => s.selectedWaterId);
  const selectWater = useEditorStore((s) => s.selectWater);
  const updateWaterBody = useEditorStore((s) => s.updateWaterBody);
  const removeWaterBody = useEditorStore((s) => s.removeWaterBody);
  const setTool = useEditorStore((s) => s.setTool3d);
  const waterHint = useEditorStore((s) => s.waterHint);
  const t = map.terrain;
  const cell = (t.size.width / (t.resolution - 1)) * (t.size.depth / (t.resolution - 1));

  return (
    <>
      <div className="section-title">
        <Droplets size={13} /> Lakes &amp; ponds
      </div>
      <div className="empty-hint">
        Water tool (L): click in a hollow — even on a mountain — and water fills that basin. Dig it first with Lower so it has banks,
        then raise or lower the level.
      </div>
      <button className="small-button" onClick={() => setTool("water")}>
        <Droplets size={12} /> Water tool
      </button>
      {waterHint && <div className="error-text">{waterHint}</div>}
      {map.waters.map((w) => {
        const ground = heightAt(t, w.x, w.z);
        const area = Math.round(waterSampleCount(waterMask(t, w)) * cell);
        const open = selectedWaterId === w.id;
        const brim = open ? Math.round((spillLevel(t, w.x, w.z, w.area) - 0.05) * 100) / 100 : 0;
        return (
          <div key={w.id} className={`terrain-layer water-row ${open ? "active" : ""}`} onClick={() => selectWater(open ? null : w.id)}>
            <input
              type="color"
              className="color-swatch"
              value={w.color ?? DEFAULT_WATER_COLOR}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => updateWaterBody(w.id, { color: e.target.value })}
              title="Water color"
            />
            <div className="terrain-layer-meta">
              <input
                key={w.name}
                className="text-input terrain-layer-name"
                defaultValue={w.name}
                onClick={(e) => e.stopPropagation()}
                onBlur={(e) => e.target.value.trim() && e.target.value !== w.name && updateWaterBody(w.id, { name: e.target.value.trim() })}
              />
              <div className="terrain-layer-sub">
                <span>
                  level {w.level} m · {area > 0 ? `${area} m²` : "dry — raise the level"}
                </span>
              </div>
              {open && (
                <div className="water-level" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="range"
                    min={Math.floor(ground)}
                    max={Math.ceil(Math.max(ground + 20, w.level + 5))}
                    step={0.1}
                    value={w.level}
                    onChange={(e) => updateWaterBody(w.id, { level: Number(e.target.value) })}
                    title="Water level"
                  />
                  <NumberRow label="Level (m)" value={w.level} onCommit={(level) => updateWaterBody(w.id, { level })} />
                  <div className="terrain-layer-sub">
                    <span>{w.level > brim + 0.01 ? `Overflows above ${brim} m` : `Brim at ${brim} m`}</span>
                    <button className="link-button" onClick={() => updateWaterBody(w.id, { level: brim })}>
                      fill to brim
                    </button>
                  </div>
                </div>
              )}
            </div>
            <button
              className="icon-button"
              title="Remove"
              onClick={(e) => {
                e.stopPropagation();
                removeWaterBody(w.id);
              }}
            >
              <Trash2 size={12} />
            </button>
          </div>
        );
      })}
    </>
  );
}

/** Old density layers remain readable and removable; new vegetation uses object placements. */
function DetailsPanel({ map }: { map: Map3D }) {
  const t = map.terrain;
  const detailLayerId = useEditorStore((s) => s.detailLayerId);
  const setDetailLayer = useEditorStore((s) => s.setDetailLayer);
  const updateDetailLayer = useEditorStore((s) => s.updateDetailLayer);
  const removeDetailLayer = useEditorStore((s) => s.removeDetailLayer);
  const autoPaintDetails = useEditorStore((s) => s.autoPaintDetails);
  const [picker, setPicker] = useState<{ layerId: string; kind: "image" | "model" } | null>(null);
  const coverage = detailCoverage(t);

  return (
    <>
      <div className="section-title">
        <Sprout size={13} /> Legacy painted details
      </div>
      <div className="empty-hint">
        Existing density layers are preserved. For new grass and flowers, create an object and use Place → Scatter on click.
      </div>
      {t.detailLayers.map((layer, i) => {
        const open = detailLayerId === layer.id;
        return (
          <div key={layer.id} className={`terrain-layer water-row ${open ? "active" : ""}`} onClick={() => setDetailLayer(layer.id)}>
            <input
              type="color"
              className="color-swatch"
              value={layer.color}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => updateDetailLayer(layer.id, { color: e.target.value })}
              title="Blade color / tint"
            />
            <div className="terrain-layer-meta">
              <input
                key={layer.name}
                className="text-input terrain-layer-name"
                defaultValue={layer.name}
                onClick={(e) => e.stopPropagation()}
                onBlur={(e) => e.target.value.trim() && e.target.value !== layer.name && updateDetailLayer(layer.id, { name: e.target.value.trim() })}
              />
              <div className="terrain-layer-sub">
                <span>
                  {layer.model ? layer.model.replace(/^assets\//, "") : layer.sprite ? layer.sprite.replace(/^assets\//, "") : "procedural blades"} ·{" "}
                  {Math.round((coverage[i] ?? 0) * 100)}% painted
                </span>
              </div>
              {open && (
                <div className="water-level" onClick={(e) => e.stopPropagation()}>
                  <NumberRow label="Per m²" value={layer.density} min={0} onCommit={(density) => updateDetailLayer(layer.id, { density })} />
                  <NumberRow label="Width (m)" value={layer.width} min={0.01} onCommit={(width) => updateDetailLayer(layer.id, { width })} />
                  <NumberRow label="Height (m)" value={layer.height} min={0.01} onCommit={(height) => updateDetailLayer(layer.id, { height })} />
                  <NumberRow
                    label="Variation"
                    value={layer.sizeVariation}
                    min={0}
                    onCommit={(sizeVariation) => updateDetailLayer(layer.id, { sizeVariation: Math.min(1, sizeVariation) })}
                  />
                  <div className="terrain-layer-sub">
                    <button className="link-button" onClick={() => setPicker({ layerId: layer.id, kind: "image" })}>
                      image…
                    </button>
                    <button className="link-button" onClick={() => setPicker({ layerId: layer.id, kind: "model" })}>
                      model…
                    </button>
                    {(layer.sprite || layer.model) && (
                      <button className="link-button" onClick={() => updateDetailLayer(layer.id, { sprite: null, model: null })}>
                        procedural
                      </button>
                    )}
                  </div>
                  <button className="secondary-button" onClick={() => autoPaintDetails({ layerId: layer.id, density: 0 })}>
                    Clear
                  </button>
                </div>
              )}
            </div>
            <button
              className="icon-button"
              title="Remove layer"
              onClick={(e) => {
                e.stopPropagation();
                removeDetailLayer(layer.id);
              }}
            >
              <Trash2 size={12} />
            </button>
          </div>
        );
      })}
      {picker && (
        <div className="modal-backdrop" onClick={() => setPicker(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">{picker.kind === "model" ? "Tuft model (.glb)" : "Tuft image"}</div>
            <div className="modal-body">
              <AssetPicker
                kind={picker.kind}
                label={picker.kind === "model" ? "Small model: a flower, a bush…" : "Image of one tuft, transparent background"}
                selected={null}
                onSelect={(path) => {
                  updateDetailLayer(picker.layerId, picker.kind === "model" ? { model: path, sprite: null } : { sprite: path, model: null });
                  setPicker(null);
                }}
              />
            </div>
            <div className="modal-footer">
              <button className="secondary-button" onClick={() => setPicker(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function GeneratePanel() {
  const generateTerrain = useEditorStore((s) => s.generateTerrain);
  const [seed, setSeed] = useState(1);
  const [amplitude, setAmplitude] = useState(15);
  const [featureSize, setFeatureSize] = useState(40);
  const [island, setIsland] = useState(false);
  return (
    <>
      <div className="section-title">
        <Sparkles size={13} /> Generate relief
      </div>
      <NumberRow label="Seed" value={seed} step={1} onCommit={(v) => setSeed(Math.round(v))} />
      <NumberRow label="Height (m)" value={amplitude} onCommit={setAmplitude} />
      <NumberRow label="Hill size (m)" value={featureSize} min={1} onCommit={setFeatureSize} />
      <label className="menu-checkbox">
        <input type="checkbox" checked={island} onChange={(e) => setIsland(e.target.checked)} />
        Island (edges sink below 0)
      </label>
      <button
        className="secondary-button"
        onClick={() => generateTerrain({ seed, amplitude, featureSize, island, baseHeight: island ? -2 : 0, octaves: 5, mode: "replace" })}
      >
        Generate (replaces the relief)
      </button>
    </>
  );
}

function AutoPaintPanel({ map }: { map: Map3D }) {
  const autoPaintTerrain = useEditorStore((s) => s.autoPaintTerrain);
  const layers = map.terrain.layers;
  const stats = terrainStats(map.terrain);
  const byName = (re: RegExp) => layers.find((l) => re.test(l.id) || re.test(l.name.toLowerCase()));

  function run() {
    const sand = byName(/sand|beach/);
    const rock = byName(/rock|cliff|stone/);
    const snow = byName(/snow|ice/);
    const base = byName(/grass/) ?? layers[0];
    const water = map.terrain.waterLevel ?? stats.minHeight;
    // Snow on the top quarter of the land above the water (not of the seabed-to-peak range).
    const land = Math.max(water, stats.minHeight);
    const rules = [
      ...(sand ? [{ layerId: sand.id, maxHeight: water + 1 }] : []),
      ...(snow && stats.maxHeight - land > 6 ? [{ layerId: snow.id, minHeight: land + (stats.maxHeight - land) * 0.78 }] : []),
      ...(rock ? [{ layerId: rock.id, minSlope: 32 }] : []),
      { layerId: base.id },
    ];
    autoPaintTerrain(rules);
  }

  return (
    <>
      <div className="section-title">
        <Sparkles size={13} /> Auto-paint
      </div>
      <div className="empty-hint">Sand near the water, rock on steep slopes, snow on the peaks, grass elsewhere (by layer names).</div>
      <button className="secondary-button" onClick={run}>
        Auto-paint terrain
      </button>
    </>
  );
}

function NumberRow({ label, value, onCommit, min, step }: { label: string; value: number; onCommit: (v: number) => void; min?: number; step?: number }) {
  return (
    <div className="prop-row">
      <span className="prop-label">{label}</span>
      <input
        key={value}
        className="text-input number-input"
        type="number"
        step={step ?? "any"}
        defaultValue={value}
        onBlur={(e) => {
          const parsed = Number(e.currentTarget.value);
          if (Number.isFinite(parsed) && parsed !== value && (min === undefined || parsed >= min)) onCommit(parsed);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
    </div>
  );
}
