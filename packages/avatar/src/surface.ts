// Canvases for drawing, on the page or in a worker. The same drawing code
// runs in both: on the page with <canvas>, in a worker with OffscreenCanvas.

export type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;
export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** A new canvas, or null where neither the DOM nor OffscreenCanvas exists. */
export function makeCanvas(w: number, h: number): AnyCanvas | null {
  if (typeof document !== "undefined" && typeof document.createElement === "function") {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    return c;
  }
  if (typeof OffscreenCanvas === "function") return new OffscreenCanvas(w, h);
  return null;
}
