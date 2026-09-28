import { Suspense, lazy, useEffect } from "react";
import { selectActiveMap, useEditorStore } from "./stores/editorStore";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { Toolbar } from "./components/Toolbar";
import { ObjectsPanel } from "./components/ObjectsPanel";
import { LayersPanel } from "./components/LayersPanel";
import { PropertiesPanel } from "./components/PropertiesPanel";
import { StatusBar } from "./components/StatusBar";
import { ValidationPanel } from "./components/ValidationPanel";
import { OpenProjectScreen } from "./components/OpenProjectScreen";
import { MapTabs } from "./components/MapTabs";
import { MapCanvas } from "./canvas/MapCanvas";
import { Panel3D } from "./components/Panel3D";

// Three.js is only downloaded when a 3D map is opened.
const Map3DView = lazy(() => import("./three/Map3DView").then((m) => ({ default: m.Map3DView })));

export function App() {
  const project = useEditorStore((s) => s.project);
  const is3D = useEditorStore((s) => selectActiveMap(s)?.kind === "3d");
  useKeyboardShortcuts();

  // `krea start my-world.krea` opens the browser on /?open=<path>.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const toOpen = params.get("open");
    if (!toOpen) return;
    window.history.replaceState(null, "", window.location.pathname);
    useEditorStore.getState().openProject(toOpen).catch(() => {
      // surfaced on the start screen via loadError
    });
  }, []);

  if (!project) {
    return <OpenProjectScreen />;
  }

  return (
    <div className="app-shell">
      <Toolbar />
      <div className="app-body">
        <div className="left-column">
          <ObjectsPanel />
          <LayersPanel />
        </div>
        <div className="center-column">
          <MapTabs />
          {is3D ? (
            <Suspense fallback={<div className="map-canvas-container scene3d-container" />}>
              <Map3DView />
            </Suspense>
          ) : (
            <MapCanvas />
          )}
          <ValidationPanel />
        </div>
        <div className="right-column">
          {is3D ? <Panel3D /> : <PropertiesPanel />}
        </div>
      </div>
      <StatusBar />
    </div>
  );
}
