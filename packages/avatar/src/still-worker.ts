// The image worker. Draws still avatars with its own WebGL context on an
// OffscreenCanvas and encodes them as PNG, so the page's main thread does
// none of it. Also encodes pixels sent from the page (for browsers whose
// workers cannot use WebGL). Built into a string at build time and started
// from a blob URL; see scripts/build-worker.mjs.
import { stillFrame, type StillJob } from "./still.js";

type Message =
  | { type: "render"; id: number; job: StillJob }
  | { type: "encode"; id: number; w: number; h: number; buf: ArrayBuffer };

const post = (data: unknown) => (self as unknown as { postMessage(d: unknown): void }).postMessage(data);

self.onmessage = async (e: MessageEvent<Message>) => {
  const msg = e.data;
  try {
    if (msg.type === "render") {
      const canvas = new OffscreenCanvas(msg.job.px, msg.job.px);
      const ctx = canvas.getContext("2d");
      if (!ctx || !stillFrame(ctx, msg.job)) {
        post({ id: msg.id, blob: null, failed: true });
        return;
      }
      post({ id: msg.id, blob: await canvas.convertToBlob({ type: "image/png" }) });
    } else {
      const canvas = new OffscreenCanvas(msg.w, msg.h);
      canvas.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(msg.buf), msg.w, msg.h), 0, 0);
      post({ id: msg.id, blob: await canvas.convertToBlob({ type: "image/png" }) });
    }
  } catch {
    post({ id: msg.id, blob: null, failed: true });
  }
};
