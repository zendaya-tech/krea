/** Editable source for a Krea-made GLB. Coordinates are meters, y up. */
export type ModelShape3D = "box" | "sphere" | "cylinder" | "cone" | "capsule" | "torus";
export type Vec3Tuple = [number, number, number];

export interface ModelPart3D {
  id: string;
  name: string;
  shape: ModelShape3D;
  position: Vec3Tuple;
  /** Euler angles in degrees. */
  rotation: Vec3Tuple;
  /** Dimensions relative to a one-meter primitive. */
  scale: Vec3Tuple;
  color: string;
  metallic: number;
  roughness: number;
}

export interface EditableModel3D {
  version: 1;
  parts: ModelPart3D[];
}

export const MODEL_SHAPES: ModelShape3D[] = ["box", "sphere", "cylinder", "cone", "capsule", "torus"];

export function validateEditableModel3D(input: unknown): string[] {
  if (!input || typeof input !== "object") return ["Model source must be an object."];
  const model = input as Partial<EditableModel3D>;
  if (model.version !== 1) return ["Model source version must be 1."];
  if (!Array.isArray(model.parts) || model.parts.length < 1 || model.parts.length > 128) return ["A model needs 1 to 128 parts."];
  const issues: string[] = [];
  const ids = new Set<string>();
  for (const [index, part] of model.parts.entries()) {
    const label = `Part ${index + 1}`;
    if (!part || typeof part !== "object") { issues.push(`${label} is invalid.`); continue; }
    if (typeof part.id !== "string" || !part.id.trim() || ids.has(part.id)) issues.push(`${label} needs a unique id.`);
    else ids.add(part.id);
    if (typeof part.name !== "string" || !part.name.trim()) issues.push(`${label} needs a name.`);
    if (!MODEL_SHAPES.includes(part.shape)) issues.push(`${label} has an unsupported shape.`);
    for (const key of ["position", "rotation", "scale"] as const) {
      const values = part[key];
      if (!Array.isArray(values) || values.length !== 3 || !values.every((v) => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 1000)) {
        issues.push(`${label} has an invalid ${key}.`);
      } else if (key === "scale" && values.some((v) => v <= 0)) issues.push(`${label} scale must be positive.`);
    }
    if (typeof part.color !== "string" || !/^#[0-9a-f]{6}$/i.test(part.color)) issues.push(`${label} needs a hex color.`);
    if (typeof part.metallic !== "number" || part.metallic < 0 || part.metallic > 1) issues.push(`${label} metallic must be 0–1.`);
    if (typeof part.roughness !== "number" || part.roughness < 0 || part.roughness > 1) issues.push(`${label} roughness must be 0–1.`);
  }
  return issues;
}

export function newModelPart(shape: ModelShape3D, name: string = shape): ModelPart3D {
  return { id: crypto.randomUUID(), name, shape, position: [0, 0.5, 0], rotation: [0, 0, 0], scale: [1, 1, 1], color: "#9bc5df", metallic: 0, roughness: 0.75 };
}

function part(name: string, shape: ModelShape3D, position: Vec3Tuple, scale: Vec3Tuple, color: string, rotation: Vec3Tuple = [0, 0, 0]): ModelPart3D {
  return { id: crypto.randomUUID(), name, shape, position, rotation, scale, color, metallic: 0, roughness: 0.82 };
}

export function modelTemplate(kind: "blank" | "person" | "face"): EditableModel3D {
  if (kind === "blank") return { version: 1, parts: [newModelPart("box", "Body")] };
  if (kind === "person") return { version: 1, parts: [
    part("Boot left", "box", [-0.22, 0.12, 0.08], [0.28, 0.24, 0.45], "#38475b"),
    part("Boot right", "box", [0.22, 0.12, 0.08], [0.28, 0.24, 0.45], "#38475b"),
    part("Leg left", "capsule", [-0.22, 0.59, 0], [0.25, 0.82, 0.27], "#334d73"),
    part("Leg right", "capsule", [0.22, 0.59, 0], [0.25, 0.82, 0.27], "#334d73"),
    part("Torso", "box", [0, 1.3, 0], [0.85, 0.95, 0.43], "#6187ad"),
    part("Arm left", "capsule", [-0.56, 1.34, 0], [0.25, 0.85, 0.26], "#51769b", [0, 0, -12]),
    part("Arm right", "capsule", [0.56, 1.34, 0], [0.25, 0.85, 0.26], "#51769b", [0, 0, 12]),
    part("Neck", "cylinder", [0, 1.85, 0], [0.25, 0.25, 0.25], "#d9a582"),
    part("Head", "sphere", [0, 2.2, 0], [0.6, 0.7, 0.57], "#e7b794"),
    part("Hair", "sphere", [0, 2.48, -0.06], [0.64, 0.28, 0.6], "#4b354e"),
    part("Eye left", "sphere", [-0.16, 2.24, 0.51], [0.08, 0.09, 0.05], "#263545"),
    part("Eye right", "sphere", [0.16, 2.24, 0.51], [0.08, 0.09, 0.05], "#263545"),
    part("Nose", "cone", [0, 2.1, 0.56], [0.1, 0.17, 0.1], "#d39a78", [90, 0, 0]),
    part("Mouth", "box", [0, 1.97, 0.52], [0.2, 0.035, 0.025], "#a45f65"),
  ] };
  return { version: 1, parts: [
    part("Face", "sphere", [0, 1.25, 0], [1.25, 1.55, 0.95], "#e6b493"),
    part("Ear left", "sphere", [-0.65, 1.25, 0], [0.25, 0.43, 0.3], "#dfa985"),
    part("Ear right", "sphere", [0.65, 1.25, 0], [0.25, 0.43, 0.3], "#dfa985"),
    part("Hair", "sphere", [0, 1.83, -0.12], [1.32, 0.55, 1], "#714766"),
    part("White eye left", "sphere", [-0.28, 1.35, 0.79], [0.24, 0.18, 0.08], "#f9f5ee"),
    part("White eye right", "sphere", [0.28, 1.35, 0.79], [0.24, 0.18, 0.08], "#f9f5ee"),
    part("Pupil left", "sphere", [-0.28, 1.35, 0.86], [0.08, 0.1, 0.04], "#31416a"),
    part("Pupil right", "sphere", [0.28, 1.35, 0.86], [0.08, 0.1, 0.04], "#31416a"),
    part("Brow left", "box", [-0.28, 1.57, 0.78], [0.31, 0.065, 0.06], "#67485b", [0, 0, -6]),
    part("Brow right", "box", [0.28, 1.57, 0.78], [0.31, 0.065, 0.06], "#67485b", [0, 0, 6]),
    part("Nose", "cone", [0, 1.08, 0.9], [0.16, 0.28, 0.18], "#ce9678", [90, 0, 0]),
    part("Mouth", "box", [0, 0.76, 0.8], [0.34, 0.07, 0.04], "#a65565"),
  ] };
}
