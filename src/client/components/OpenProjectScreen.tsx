import { useEffect, useState } from "react";
import { FilePlus2, FolderOpen, LayoutGrid, X } from "lucide-react";
import { useEditorStore } from "../stores/editorStore";
import { pickProjectToCreate, pickProjectToOpen } from "../net/client";
import { DEFAULT_2D, MapKindFields, isMapFormatValid, type MapFormat } from "./MapKindFields";
import { forgetRecentProject, getRecentProjects } from "../recent-projects";

type Mode = "open" | "new";

export function OpenProjectScreen() {
  const [mode, setMode] = useState<Mode>("open");
  const loadError = useEditorStore((s) => s.loadError);

  return (
    <div className="open-project-screen">
      <div className="open-project-card">
        <h1 className="app-brand">
          <LayoutGrid size={22} /> Krea
        </h1>
        <p className="app-tagline">2D &amp; 3D map editor for video games</p>
        <div className="mode-tabs">
          <button className={mode === "open" ? "active" : ""} onClick={() => setMode("open")}>
            <FolderOpen size={14} /> Open Project
          </button>
          <button className={mode === "new" ? "active" : ""} onClick={() => setMode("new")}>
            <FilePlus2 size={14} /> New Project
          </button>
        </div>
        {mode === "open" ? <OpenForm /> : <NewForm />}
        {loadError && <div className="error-text">{loadError}</div>}
      </div>
    </div>
  );
}

/** Path input + a "Browse…" button backed by a native OS dialog opened by the local server
 * (a browser page can't recover a real filesystem path on its own). */
function PathField({
  path,
  onChange,
  onBrowse,
  onEnter,
  placeholder,
}: {
  path: string;
  onChange: (path: string) => void;
  onBrowse: () => Promise<{ path: string | null }>;
  onEnter?: () => void;
  placeholder: string;
}) {
  const [browsing, setBrowsing] = useState(false);

  async function handleBrowse() {
    setBrowsing(true);
    try {
      const res = await onBrowse();
      if (res.path) onChange(res.path);
    } catch {
      // The user can still type the path manually.
    } finally {
      setBrowsing(false);
    }
  }

  return (
    <div className="path-field">
      <input
        className="text-input"
        placeholder={placeholder}
        value={path}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && onEnter?.()}
        autoFocus
      />
      <button className="secondary-button" onClick={() => void handleBrowse()} disabled={browsing}>
        {browsing ? "…" : "Browse…"}
      </button>
    </div>
  );
}

function OpenForm() {
  const openProject = useEditorStore((s) => s.openProject);
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [recent, setRecent] = useState(getRecentProjects);

  useEffect(() => {
    const refresh = () => setRecent(getRecentProjects());
    window.addEventListener("krea:recent-projects", refresh);
    return () => window.removeEventListener("krea:recent-projects", refresh);
  }, []);

  async function handleOpen(chosenPath = path) {
    if (!chosenPath.trim()) return;
    setBusy(true);
    try {
      await openProject(chosenPath.trim());
    } catch {
      // surfaced via loadError
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <p>
        Open a <code>.krea</code> project — a single file holding every map, object, sprite, collision and image. Older
        folder projects with a <code>map.json</code> are converted automatically.
      </p>
      <PathField path={path} onChange={setPath} onBrowse={pickProjectToOpen} onEnter={() => void handleOpen()} placeholder="C:\games\my-world.krea" />
      <button className="primary-button" onClick={() => void handleOpen()} disabled={busy || !path.trim()}>
        {busy ? "Opening…" : "Open Project"}
      </button>
      {recent.length > 0 && (
        <div className="recent-projects">
          <div className="field-label">Recent projects</div>
          {recent.map((item) => (
            <div className="recent-project" key={item.path}>
              <button className="recent-project-open" disabled={busy} onClick={() => void handleOpen(item.path)} title={item.path}>
                <span>{item.name}</span><small>{item.path}</small>
              </button>
              <button className="icon-button" title={`Remove ${item.name} from recent projects`} onClick={() => forgetRecentProject(item.path)}><X size={13} /></button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function NewForm() {
  const newProject = useEditorStore((s) => s.newProject);
  const [path, setPath] = useState("");
  const [name, setName] = useState("My World");
  const [format, setFormat] = useState<MapFormat>(DEFAULT_2D);
  const [busy, setBusy] = useState(false);

  async function handleCreate() {
    if (!path.trim() || !name.trim() || !isMapFormatValid(format)) return;
    setBusy(true);
    try {
      await newProject({ path: path.trim(), name: name.trim(), ...format });
    } catch {
      // surfaced via loadError
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <p>
        Choose where to save the new <code>.krea</code> file. Nothing is written until you save for the first time.
      </p>
      <PathField
        path={path}
        onChange={setPath}
        onBrowse={() => pickProjectToCreate(name)}
        placeholder="C:\games\my-world.krea"
      />
      <input className="text-input" placeholder="Project name" value={name} onChange={(e) => setName(e.target.value)} />
      <label className="field-label">First map</label>
      <MapKindFields value={format} onChange={setFormat} />
      <button className="primary-button" onClick={() => void handleCreate()} disabled={busy || !path.trim() || !name.trim() || !isMapFormatValid(format)}>
        {busy ? "Creating…" : "Create Project"}
      </button>
    </>
  );
}
