import * as THREE from "three";
import type { EditableModel3D, ModelPart3D } from "@core/model3d";
import { validateEditableModel3D } from "@core/model3d";
import { writeGlb, type GlbMeshInput } from "./glb";

export function partGeometry(shape: ModelPart3D["shape"]): THREE.BufferGeometry {
  switch (shape) {
    case "box": return new THREE.BoxGeometry(1, 1, 1);
    case "sphere": return new THREE.SphereGeometry(0.5, 20, 14);
    case "cylinder": return new THREE.CylinderGeometry(0.5, 0.5, 1, 20);
    case "cone": return new THREE.ConeGeometry(0.5, 1, 20);
    case "capsule": return new THREE.CapsuleGeometry(0.5, 0.25, 5, 12);
    case "torus": return new THREE.TorusGeometry(0.38, 0.12, 10, 24);
  }
}

export function partTransform(part: ModelPart3D): THREE.Matrix4 {
  const rotation = new THREE.Euler(
    THREE.MathUtils.degToRad(part.rotation[0]),
    THREE.MathUtils.degToRad(part.rotation[1]),
    THREE.MathUtils.degToRad(part.rotation[2]),
    "XYZ",
  );
  return new THREE.Matrix4().compose(
    new THREE.Vector3(...part.position),
    new THREE.Quaternion().setFromEuler(rotation),
    new THREE.Vector3(...part.scale),
  );
}

/** Same geometry is used by the browser preview and the stateless agent API. */
export function buildEditableModelGlb(source: EditableModel3D): Uint8Array {
  const issues = validateEditableModel3D(source);
  if (issues.length) throw new Error(issues.join(" "));
  const meshes: GlbMeshInput[] = source.parts.map((part) => {
    const geometry = partGeometry(part.shape).toNonIndexed();
    geometry.applyMatrix4(partTransform(part));
    const position = geometry.getAttribute("position") as THREE.BufferAttribute;
    const normal = geometry.getAttribute("normal") as THREE.BufferAttribute;
    const color = new THREE.Color(part.color);
    const mesh: GlbMeshInput = {
      name: part.name,
      primitives: [{
        positions: Float32Array.from(position.array),
        normals: Float32Array.from(normal.array),
        color: [color.r, color.g, color.b, 1],
        metallic: part.metallic,
        roughness: part.roughness,
      }],
    };
    geometry.dispose();
    return mesh;
  });
  return writeGlb(meshes, "Krea 3D Model Editor");
}
