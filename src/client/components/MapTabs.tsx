import { useState } from "react";
import { Box, Grid3x3, Plus } from "lucide-react";
import { selectActiveMap, useEditorStore } from "../stores/editorStore";
import { ContextMenu } from "./ContextMenu";
import { DEFAULT_2D, MapKindFields, isMapFormatValid, type MapFormat } from "./MapKindFields";

/** One tab per map in the project: switch, create, rename (double-click or right-click), delete. */
export function MapTabs() {
  const maps = useEditorStore((s) => s.project?.maps);
  const activeMapId = useEditorStore((s) => s.activeMapId);
  const activeMap = useEditorStore(selectActiveMap);
  const switchMap = useEditorStore((s) => s.switchMap);
  const createMap = useEditorStore((s) => s.createMap);
  const renameMap = useEditorStore((s) => s.renameMap);
  const deleteMap = useEditorStore((s) => s.deleteMap);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number; mapId: string } | null>(null);
  const [creating, setCreating] = useState(false);

  if (!maps) return null;

  function startRename(mapId: string, name: string) {
    setRenamingId(mapId);
    setDraft(name);
  }

  function commitRename() {
    if (renamingId && draft.trim()) renameMap(renamingId, draft.trim());
    setRenamingId(null);
  }

  return (
    <div className="map-tabs">
      {maps.map((m) =>
        renamingId === m.id ? (
          <input
            key={m.id}
            className="text-input map-tab-input"
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") setRenamingId(null);
            }}
          />
        ) : (
          <button
            key={m.id}
            className={`map-tab ${m.id === activeMapId ? "active" : ""}`}
            onClick={() => switchMap(m.id)}
            onDoubleClick={() => startRename(m.id, m.name)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY, mapId: m.id });
            }}
            title={m.kind === "2d" ? `${m.id} · 2D · ${m.settings.width}×${m.settings.height} tiles` : `${m.id} · 3D · ${m.terrain.size.width}×${m.terrain.size.depth} m`}
          >
            {m.kind === "3d" ? <Box size={12} /> : <Grid3x3 size={12} />}
            {m.name}
          </button>
        ),
      )}
      <button className="map-tab map-tab-add" onClick={() => setCreating(true)} title="New map">
        <Plus size={13} /> Map
      </button>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: "Rename", onSelect: () => startRename(menu.mapId, maps.find((m) => m.id === menu.mapId)?.name ?? "") },
            {
              label: "Delete map",
              danger: true,
              disabled: maps.length <= 1,
              onSelect: () => {
                const name = maps.find((m) => m.id === menu.mapId)?.name;
                if (window.confirm(`Delete map "${name}"? (Undo can restore it.)`)) deleteMap(menu.mapId);
              },
            },
          ]}
        />
      )}

      {creating && (
        <NewMapModal
          defaults={activeMap?.kind === "2d" ? { kind: "2d", ...activeMap.settings } : DEFAULT_2D}
          onCancel={() => setCreating(false)}
          onCreate={(params) => {
            createMap(params);
            setCreating(false);
          }}
        />
      )}
    </div>
  );
}

function NewMapModal({
  defaults,
  onCancel,
  onCreate,
}: {
  defaults: MapFormat;
  onCancel: () => void;
  onCreate: (params: MapFormat & { name: string }) => void;
}) {
  const [name, setName] = useState("New map");
  const [format, setFormat] = useState<MapFormat>(defaults);
  const valid = name.trim() !== "" && isMapFormatValid(format);

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">New map</div>
        <div className="modal-body">
          <label className="field-label">Name</label>
          <input className="text-input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          <label className="field-label">Format</label>
          <MapKindFields value={format} onChange={setFormat} />
          <div className="empty-hint">The object catalog is shared: every object is available in every map (3D objects only in 3D maps).</div>
        </div>
        <div className="modal-footer">
          <button className="secondary-button" onClick={onCancel}>
            Cancel
          </button>
          <button className="primary-button" disabled={!valid} onClick={() => onCreate({ ...format, name: name.trim() })}>
            Create map
          </button>
        </div>
      </div>
    </div>
  );
}
