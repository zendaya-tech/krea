/**
 * Colors shared by the browser CanvasRenderer and the server-side headless
 * renderer, so a screenshot from the API looks like the editor's own canvas.
 */
export const RENDER_THEME = {
  background: "#1b1c1f",
  mapBackground: "#26282c",
  grid: "rgba(255, 255, 255, 0.08)",
  bounds: "rgba(255, 255, 255, 0.25)",
  placeholder: "#3a3d42",
  error: "#7a2e2e",
  collisionFill: "rgba(255, 80, 80, 0.25)",
  collisionStroke: "rgba(255, 110, 110, 0.95)",
  /** Sprite-less (invisible) objects are drawn as a dashed, crossed box. */
  markerFill: "rgba(170, 120, 255, 0.16)",
  markerStroke: "rgba(190, 150, 255, 0.95)",
} as const;
