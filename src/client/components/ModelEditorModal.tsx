import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { Box, Copy, Plus, Trash2 } from "lucide-react";
import { MODEL_SHAPES, modelTemplate, newModelPart, validateEditableModel3D, type EditableModel3D, type ModelPart3D, type ModelShape3D, type Vec3Tuple } from "@core/model3d";
import { buildEditableModelGlb, partGeometry } from "@shared/model3d-glb";
import { importAsset } from "../net/client";

interface Props {
  name: string;
  initial?: EditableModel3D;
  onClose: () => void;
  onSave: (path: string, source: EditableModel3D) => void;
}

type TransformMode = "translate" | "rotate" | "scale";

function ModelViewport({ model, selectedId, mode, onSelect, onTransform }: {
  model: EditableModel3D;
  selectedId: string | null;
  mode: TransformMode;
  onSelect: (id: string | null) => void;
  onTransform: (id: string, patch: Partial<ModelPart3D>) => void;
}) {
  const mount = useRef<HTMLDivElement>(null);
  const state = useRef<{ scene: THREE.Scene; renderer: THREE.WebGLRenderer; camera: THREE.PerspectiveCamera; orbit: OrbitControls; transform: TransformControls; group: THREE.Group; raycaster: THREE.Raycaster; pointer: THREE.Vector2; frame: number } | null>(null);
  const onSelectRef = useRef(onSelect);
  const onTransformRef = useRef(onTransform);
  const selectedRef = useRef(selectedId);
  onSelectRef.current = onSelect;
  onTransformRef.current = onTransform;
  selectedRef.current = selectedId;

  useEffect(() => {
    const host = mount.current;
    if (!host) return;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#172535");
    const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 500);
    camera.position.set(4, 3.4, 5);
    camera.lookAt(0, 1, 0);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.appendChild(renderer.domElement);
    const orbit = new OrbitControls(camera, renderer.domElement);
    orbit.target.set(0, 1, 0);
    orbit.enableDamping = true;
    scene.add(new THREE.HemisphereLight("#e4f3ff", "#566574", 2));
    const light = new THREE.DirectionalLight("#fff4dd", 2.8);
    light.position.set(4, 8, 5);
    scene.add(light);
    const grid = new THREE.GridHelper(10, 20, "#6387a0", "#365066");
    scene.add(grid);
    const group = new THREE.Group();
    scene.add(group);
    const transform = new TransformControls(camera, renderer.domElement);
    scene.add(transform.getHelper());
    transform.addEventListener("dragging-changed", (event) => { orbit.enabled = !event.value; });
    transform.addEventListener("mouseUp", () => {
      const obj = transform.object;
      const id = obj?.userData.partId as string | undefined;
      if (!obj || !id) return;
      onTransformRef.current(id, {
        position: [obj.position.x, obj.position.y, obj.position.z],
        rotation: [THREE.MathUtils.radToDeg(obj.rotation.x), THREE.MathUtils.radToDeg(obj.rotation.y), THREE.MathUtils.radToDeg(obj.rotation.z)],
        scale: [obj.scale.x, obj.scale.y, obj.scale.z],
      });
    });
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const onPointerDown = (event: PointerEvent) => {
      if (transform.axis) return;
      const bounds = renderer.domElement.getBoundingClientRect();
      pointer.set(((event.clientX - bounds.left) / bounds.width) * 2 - 1, -((event.clientY - bounds.top) / bounds.height) * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects(group.children, false)[0];
      onSelectRef.current(hit ? (hit.object.userData.partId as string) : null);
    };
    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    const resize = () => {
      const width = host.clientWidth;
      const height = host.clientHeight;
      renderer.setSize(width, height);
      camera.aspect = width / Math.max(height, 1);
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();
    const animation = () => {
      const s = state.current;
      if (!s) return;
      orbit.update();
      renderer.render(scene, camera);
      s.frame = requestAnimationFrame(animation);
    };
    state.current = { scene, renderer, camera, orbit, transform, group, raycaster, pointer, frame: 0 };
    animation();
    return () => {
      const s = state.current;
      if (s) cancelAnimationFrame(s.frame);
      state.current = null;
      observer.disconnect();
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      transform.dispose();
      orbit.dispose();
      group.children.forEach((child) => {
        const mesh = child as THREE.Mesh;
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
      });
      renderer.dispose();
      host.removeChild(renderer.domElement);
    };
  }, []);

  useEffect(() => {
    const s = state.current;
    if (!s) return;
    s.transform.detach();
    for (const child of [...s.group.children]) {
      s.group.remove(child);
      const mesh = child as THREE.Mesh;
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
    for (const part of model.parts) {
      const mesh = new THREE.Mesh(partGeometry(part.shape), new THREE.MeshStandardMaterial({ color: part.color, metalness: part.metallic, roughness: part.roughness, emissive: part.id === selectedId ? "#193b53" : "#000000" }));
      mesh.userData.partId = part.id;
      mesh.position.set(...part.position);
      mesh.rotation.set(...part.rotation.map(THREE.MathUtils.degToRad) as Vec3Tuple);
      mesh.scale.set(...part.scale);
      s.group.add(mesh);
      if (part.id === selectedId) s.transform.attach(mesh);
    }
    s.transform.setMode(mode);
  }, [model, selectedId, mode]);

  return <div className="model-viewport" ref={mount} aria-label="3D model preview" />;
}

export function ModelEditorModal({ name, initial, onClose, onSave }: Props) {
  const [model, setModel] = useState<EditableModel3D>(() => structuredClone(initial ?? modelTemplate("blank")));
  const [selectedId, setSelectedId] = useState<string | null>(() => model.parts[0]?.id ?? null);
  const [mode, setMode] = useState<TransformMode>("translate");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selected = model.parts.find((part) => part.id === selectedId);

  function updatePart(id: string, patch: Partial<ModelPart3D>) {
    setModel((current) => ({ ...current, parts: current.parts.map((part) => part.id === id ? { ...part, ...patch } : part) }));
  }
  function addPart(shape: ModelShape3D) {
    if (model.parts.length >= 128) return;
    const part = newModelPart(shape);
    setModel((current) => ({ ...current, parts: [...current.parts, part] }));
    setSelectedId(part.id);
  }
  function chooseTemplate(template: "blank" | "person" | "face") {
    const next = modelTemplate(template);
    setModel(next);
    setSelectedId(next.parts[0].id);
  }
  function duplicatePart() {
    if (!selected || model.parts.length >= 128) return;
    const copy: ModelPart3D = { ...structuredClone(selected), id: crypto.randomUUID(), name: `${selected.name} copy`, position: [selected.position[0] + 0.2, selected.position[1], selected.position[2]] };
    setModel((current) => ({ ...current, parts: [...current.parts, copy] }));
    setSelectedId(copy.id);
  }
  function deletePart() {
    if (!selected || model.parts.length <= 1) return;
    setModel((current) => ({ ...current, parts: current.parts.filter((part) => part.id !== selected.id) }));
    setSelectedId(null);
  }
  async function save() {
    const problems = validateEditableModel3D(model);
    if (problems.length) { setError(problems.join(" ")); return; }
    setSaving(true);
    setError(null);
    try {
      const bytes = buildEditableModelGlb(model);
      const fileName = `${name.trim().replace(/[^a-z0-9_-]+/gi, "-") || "krea-model"}.glb`;
      const file = new File([new Uint8Array(bytes)], fileName, { type: "model/gltf-binary" });
      const result = await importAsset(file);
      onSave(result.path, model);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save the model.");
    } finally {
      setSaving(false);
    }
  }

  const tupleEditor = (label: string, key: "position" | "rotation" | "scale") => selected && (
    <div className="model-vector-row" key={key}>
      <span>{label}</span>
      {([0, 1, 2] as const).map((axis) => <label key={axis}>{"XYZ"[axis]}<input type="number" step={key === "rotation" ? 1 : 0.05} value={Number(selected[key][axis].toFixed(3))} onChange={(event) => {
        const values = [...selected[key]] as Vec3Tuple;
        values[axis] = Number(event.target.value);
        updatePart(selected.id, { [key]: values });
      }} /></label>)}
    </div>
  );

  return <div className="modal-backdrop model-editor-backdrop" onClick={onClose}>
    <div className="modal model-editor-modal" onClick={(event) => event.stopPropagation()}>
      <div className="modal-header"><Box size={18} /> Model editor — {name.trim() || "New object"}</div>
      <div className="model-editor-topbar">
        <span>Start with</span>
        <button className="small-button" onClick={() => chooseTemplate("blank")}>Blank</button>
        <button className="small-button" onClick={() => chooseTemplate("person")}>Person</button>
        <button className="small-button" onClick={() => chooseTemplate("face")}>Face</button>
        <span className="model-editor-spacer" />
        {(["translate", "rotate", "scale"] as const).map((tool) => <button key={tool} className={`small-button ${mode === tool ? "active" : ""}`} onClick={() => setMode(tool)}>{tool}</button>)}
      </div>
      <div className="model-editor-main">
        <div className="model-editor-preview"><ModelViewport model={model} selectedId={selectedId} mode={mode} onSelect={setSelectedId} onTransform={updatePart} /><div className="model-editor-tip">Drag to orbit · Wheel to zoom · Click a part to edit it</div></div>
        <div className="model-editor-sidebar">
          <div className="field-label-row"><strong>Parts ({model.parts.length})</strong><select value="" onChange={(event) => { if (event.target.value) addPart(event.target.value as ModelShape3D); }}><option value="">+ Add shape</option>{MODEL_SHAPES.map((shape) => <option key={shape} value={shape}>{shape}</option>)}</select></div>
          <div className="model-part-list">{model.parts.map((part) => <button key={part.id} className={`model-part-item ${selectedId === part.id ? "active" : ""}`} onClick={() => setSelectedId(part.id)}>{part.name}<small>{part.shape}</small></button>)}</div>
          {selected && <div className="model-part-fields">
            <div className="field-label-row"><strong>Selected part</strong><div><button className="small-button" title="Duplicate" onClick={duplicatePart}><Copy size={13} /></button><button className="small-button" title="Delete" disabled={model.parts.length <= 1} onClick={deletePart}><Trash2 size={13} /></button></div></div>
            <label>Name<input className="text-input" value={selected.name} onChange={(event) => updatePart(selected.id, { name: event.target.value })} /></label>
            <label>Shape<select value={selected.shape} onChange={(event) => updatePart(selected.id, { shape: event.target.value as ModelShape3D })}>{MODEL_SHAPES.map((shape) => <option key={shape}>{shape}</option>)}</select></label>
            {tupleEditor("Position", "position")}{tupleEditor("Rotation °", "rotation")}{tupleEditor("Scale", "scale")}
            <div className="model-material-row"><label>Color<input type="color" value={selected.color} onChange={(event) => updatePart(selected.id, { color: event.target.value })} /></label><label>Metallic<input type="number" min={0} max={1} step={0.05} value={selected.metallic} onChange={(event) => updatePart(selected.id, { metallic: Number(event.target.value) })} /></label><label>Roughness<input type="number" min={0} max={1} step={0.05} value={selected.roughness} onChange={(event) => updatePart(selected.id, { roughness: Number(event.target.value) })} /></label></div>
          </div>}
        </div>
      </div>
      {error && <div className="error-text model-editor-error">{error}</div>}
      <div className="modal-footer"><span className="model-editor-save-hint">The editable source and GLB are stored in the project.</span><button className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={saving} onClick={() => void save()}><Plus size={14} />{saving ? "Saving…" : "Use model"}</button></div>
    </div>
  </div>;
}
