import { importAsset } from "./net/client";

export type VegetationPreset = "grass" | "flowers";

/** Creates a small transparent billboard asset inside the open .krea project. */
export async function importVegetationPreset(kind: VegetationPreset): Promise<string> {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is unavailable.");
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  if (kind === "grass") drawGrass(ctx);
  else drawFlowers(ctx);

  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((result) => result ? resolve(result) : reject(new Error("Could not create the sprite.")), "image/png"),
  );
  const file = new File([blob], `${kind}-tuft.png`, { type: "image/png" });
  return (await importAsset(file)).path;
}

function blade(ctx: CanvasRenderingContext2D, rootX: number, tipX: number, tipY: number, width: number, fill: string, light: string) {
  ctx.beginPath();
  ctx.moveTo(rootX - width / 2, 118);
  ctx.quadraticCurveTo((rootX + tipX) / 2 - width, tipY + 20, tipX, tipY);
  ctx.quadraticCurveTo((rootX + tipX) / 2 + width * 0.7, tipY + 25, rootX + width / 2, 118);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.strokeStyle = "#2d5e34";
  ctx.lineWidth = 2;
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(rootX, 113);
  ctx.quadraticCurveTo((rootX + tipX) / 2, tipY + 24, tipX, tipY + 5);
  ctx.strokeStyle = light;
  ctx.lineWidth = 2;
  ctx.stroke();
}

function drawGrass(ctx: CanvasRenderingContext2D) {
  blade(ctx, 59, 28, 75, 16, "#428d42", "#9bd36a");
  blade(ctx, 72, 104, 65, 16, "#4e9a45", "#b3df77");
  blade(ctx, 44, 43, 55, 17, "#5cae4a", "#c2e477");
  blade(ctx, 82, 74, 49, 18, "#328242", "#8bcd69");
  blade(ctx, 62, 62, 36, 19, "#69b951", "#d1e98a");
  blade(ctx, 54, 14, 94, 12, "#31783e", "#8ac864");
  blade(ctx, 78, 116, 92, 12, "#5aaa49", "#b5dd73");
}

function drawFlowers(ctx: CanvasRenderingContext2D) {
  // Three stems and broad leaves make one small object, rather than a texture painted into the terrain.
  const stems = [
    { x: 38, y: 69, bloom: "#f4a0ce", petal: "#d768a8" },
    { x: 65, y: 49, bloom: "#ffc1df", petal: "#ed7fb8" },
    { x: 91, y: 76, bloom: "#b7a5ed", petal: "#8970cb" },
  ];
  for (const flower of stems) {
    ctx.beginPath();
    ctx.moveTo(64, 117);
    ctx.quadraticCurveTo(flower.x + 5, 92, flower.x, flower.y + 9);
    ctx.strokeStyle = "#327b41";
    ctx.lineWidth = 5;
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(flower.x - 10, 99, 11, 5, -0.5, 0, Math.PI * 2);
    ctx.ellipse(flower.x + 9, 105, 10, 5, 0.5, 0, Math.PI * 2);
    ctx.fillStyle = "#5aa64c";
    ctx.fill();
    for (let i = 0; i < 5; i++) {
      const a = (i * Math.PI * 2) / 5;
      ctx.beginPath();
      ctx.ellipse(flower.x + Math.cos(a) * 8, flower.y + Math.sin(a) * 8, 7, 10, a, 0, Math.PI * 2);
      ctx.fillStyle = flower.bloom;
      ctx.strokeStyle = flower.petal;
      ctx.lineWidth = 1.5;
      ctx.fill();
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(flower.x, flower.y, 6, 0, Math.PI * 2);
    ctx.fillStyle = "#f6cb61";
    ctx.strokeStyle = "#9a6e28";
    ctx.fill();
    ctx.stroke();
  }
  blade(ctx, 50, 24, 94, 12, "#3e9144", "#a1d575");
  blade(ctx, 77, 106, 91, 12, "#3e9144", "#a1d575");
}
