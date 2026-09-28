import { useEffect, useState } from "react";
import type { CollisionShape, Point } from "@core/map-types";

const fmt = (v: number) => String(Math.round(v * 100) / 100);

/** Number input that lets the user type freely (e.g. "-" or "1.") without the value snapping back. */
function NumInput({ value, onChange, min, step = 0.5 }: { value: number; onChange: (v: number) => void; min?: number; step?: number }) {
  const [draft, setDraft] = useState(fmt(value));
  useEffect(() => {
    if (parseFloat(draft) !== value) setDraft(fmt(value));
  }, [value]);
  return (
    <input
      className="text-input shape-num"
      type="number"
      step={step}
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value);
        const n = parseFloat(e.target.value);
        if (Number.isFinite(n) && (min === undefined || n >= min)) onChange(n);
      }}
    />
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="shape-row">
      <span className="prop-label">{label}</span>
      <div className="shape-row-inputs">{children}</div>
    </div>
  );
}

function RotationRow({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <>
      <Row label="Rotation °">
        <NumInput value={value} onChange={onChange} step={1} />
      </Row>
      <input
        className="rotation-slider"
        type="range"
        min={-180}
        max={180}
        step={1}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label="Rotation"
      />
    </>
  );
}

const TYPE_LABELS: Record<CollisionShape["type"], string> = { rect: "Rectangle", circle: "Circle", triangle: "Triangle" };

/** Precise numeric editing of a collision shape (sprite pixel units). */
export function ShapeProperties({
  shape,
  onChange,
  onDelete,
}: {
  shape: CollisionShape;
  onChange: (shape: CollisionShape) => void;
  onDelete: () => void;
}) {
  const setPoint = (index: number, patch: Partial<Point>) => {
    if (shape.type !== "triangle") return;
    const points = shape.points.map((p, i) => (i === index ? { ...p, ...patch } : p)) as typeof shape.points;
    onChange({ ...shape, points });
  };

  return (
    <div className="shape-properties">
      <div className="shape-type">{TYPE_LABELS[shape.type]}</div>
      <Row label="Center">
        <NumInput value={shape.x} onChange={(x) => onChange({ ...shape, x })} />
        <NumInput value={shape.y} onChange={(y) => onChange({ ...shape, y })} />
      </Row>

      {shape.type === "rect" && (
        <>
          <Row label="Size">
            <NumInput value={shape.width} min={0.5} onChange={(width) => onChange({ ...shape, width })} />
            <NumInput value={shape.height} min={0.5} onChange={(height) => onChange({ ...shape, height })} />
          </Row>
          <RotationRow value={shape.rotation} onChange={(rotation) => onChange({ ...shape, rotation })} />
        </>
      )}

      {shape.type === "circle" && (
        <Row label="Radius">
          <NumInput value={shape.radius} min={0.5} onChange={(radius) => onChange({ ...shape, radius })} />
        </Row>
      )}

      {shape.type === "triangle" && (
        <>
          {shape.points.map((p, i) => (
            <Row key={i} label={`Point ${i + 1}`}>
              <NumInput value={p.x} onChange={(x) => setPoint(i, { x })} />
              <NumInput value={p.y} onChange={(y) => setPoint(i, { y })} />
            </Row>
          ))}
          <div className="empty-hint">Points are offsets from the center, before rotation.</div>
          <RotationRow value={shape.rotation} onChange={(rotation) => onChange({ ...shape, rotation })} />
        </>
      )}

      <button className="secondary-button danger-button" onClick={onDelete}>
        Delete shape
      </button>
    </div>
  );
}
