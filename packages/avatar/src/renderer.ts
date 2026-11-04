// One WebGL context for the whole page. Browsers cap live contexts at about
// 16, so avatars never get their own: each body is drawn here, off screen,
// and copied straight into the avatar's own 2D canvas. The pixels then live
// in the page, so they scroll and clip with it natively.
import type { AvatarLook } from "./rule.js";
import { BODY_UNIFORMS, FRAGMENT_SHADER, VERTEX_SHADER, bodyUniforms } from "./shader.js";
import { avatarShape } from "./shapes.js";

export interface BodyFrame {
  look: AvatarLook;
  /** Display size in CSS pixels; sets the texture strength. */
  size: number;
  /** Half the drawn box in outline units (1.12 in a slot). */
  half: number;
  tx: number;
  ty: number;
  /** Degrees. */
  rot: number;
  sx: number;
  sy: number;
  clock: number;
  energy: number;
  listen: number;
}

interface Renderer {
  canvas: HTMLCanvasElement;
  gl: WebGLRenderingContext;
  uniform: (name: string) => WebGLUniformLocation | null;
}

let renderer: Renderer | null | undefined;

function compile(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader) ?? "shader compile failed");
  }
  return shader;
}

function createRenderer(): Renderer | null {
  if (typeof document === "undefined") return null;
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl", { premultipliedAlpha: true, antialias: true });
    if (!gl || !gl.getExtension("OES_standard_derivatives")) return null;
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, "p");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    const locations = new Map<string, WebGLUniformLocation | null>();
    const uniform = (name: string) => {
      if (!locations.has(name)) locations.set(name, gl.getUniformLocation(program, name));
      return locations.get(name)!;
    };
    // A lost context is rebuilt on the next draw. Canvases already painted keep their pixels.
    canvas.addEventListener("webglcontextlost", (event) => {
      event.preventDefault();
      renderer = undefined;
    });
    return { canvas, gl, uniform };
  } catch {
    return null;
  }
}

function getRenderer(): Renderer | null {
  if (renderer === undefined) renderer = createRenderer();
  return renderer;
}

/** True when the page can draw the flowing body. */
export function hasWebGL(): boolean {
  return getRenderer() !== null;
}

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);

/**
 * Draws the body into the shared canvas at `px` × `px` device pixels and
 * copies it to `target` at (dx, dy). Returns false when WebGL is unavailable.
 */
export function drawBody(
  target: CanvasRenderingContext2D,
  px: number,
  dx: number,
  dy: number,
  frame: BodyFrame,
): boolean {
  const r = getRenderer();
  if (!r) return false;
  const { canvas, gl, uniform } = r;
  if (canvas.width < px || canvas.height < px) {
    canvas.width = Math.max(canvas.width, px);
    canvas.height = Math.max(canvas.height, px);
  }
  gl.viewport(0, 0, px, px);
  gl.disable(gl.SCISSOR_TEST);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);

  const { look } = frame;
  look.palette.forEach((hex, i) => gl.uniform3fv(uniform("c" + i), rgb(hex)));
  const values = bodyUniforms(frame.size);
  values.uSize = 1 / frame.half;
  values.uShapeRot = (frame.rot * Math.PI) / 180;
  values.uFlowAng = look.flowAngle;
  for (const key of BODY_UNIFORMS) gl.uniform1f(uniform(key), values[key]);
  gl.uniform1fv(uniform("uRT"), avatarShape(look.shape).radii);
  gl.uniform2f(uniform("uOff"), frame.tx / frame.half, -frame.ty / frame.half);
  gl.uniform2f(uniform("uSclD"), frame.sx - 1, frame.sy - 1);
  gl.uniform1f(uniform("t"), look.seed + frame.clock);
  gl.uniform1f(uniform("energy"), frame.energy);
  gl.uniform1f(uniform("listen"), frame.listen);
  // Texture and grain are tuned for a body this many pixels across (the reference slot was 1.62× the avatar).
  gl.uniform1f(uniform("uResY"), (3.6288 * px) / (2 * frame.half));
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

  // WebGL's origin is bottom-left, so the frame sits at the bottom of the canvas.
  target.drawImage(canvas, 0, canvas.height - px, px, px, dx, dy, px, px);
  return true;
}
