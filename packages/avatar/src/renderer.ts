// One WebGL context for the whole page. Browsers cap live contexts at about
// 16, so avatars never get their own: each frame is drawn here, off screen,
// and copied into the avatar's 2D canvas.
import { EYE_TYPE_UNIFORM, LOOK, type LookKey } from "./look.js";
import type { AgentAvatarLook } from "./rule.js";
import { FRAGMENT_SHADER, VERTEX_SHADER } from "./shader.js";

/** Room around the box so a pulse or glow is not clipped, as a share of the box per side. */
const PAD = 0.15;

export interface OrbFrame {
  look: AgentAvatarLook;
  /** Flow clock in shader time units, added to the look's seed. */
  clock: number;
  /** Speaking energy, 0–1. */
  energy: number;
  /** Listening, 0–1. */
  listen: number;
  /** Size change, e.g. 0.05 draws the orb 5% larger. */
  pulse: number;
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
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl", { premultipliedAlpha: true, antialias: true });
  if (!gl || !gl.getExtension("OES_standard_derivatives")) return null;
  try {
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

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);

/**
 * Draws one frame of an orb filling a `px` × `px` box into `target`, which
 * must be at least that large. Returns false when WebGL is unavailable.
 */
export function drawOrb(target: CanvasRenderingContext2D, px: number, frame: OrbFrame): boolean {
  const r = getRenderer();
  if (!r) return false;
  const { canvas, gl, uniform } = r;
  const full = Math.round(px * (1 + PAD * 2));
  const offset = Math.floor((full - px) / 2);
  if (canvas.width < full || canvas.height < full) {
    canvas.width = Math.max(canvas.width, full);
    canvas.height = Math.max(canvas.height, full);
  }
  gl.viewport(0, 0, full, full);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);

  const { look } = frame;
  look.palette.forEach((hex, i) => gl.uniform3fv(uniform("c" + i), rgb(hex)));
  const values: Record<LookKey, number> = {
    ...LOOK,
    Size: (LOOK.Size / (1 + PAD * 2)) * (1 + frame.pulse),
    FlowAng: look.flowAngle,
    Eyes: look.eyes ? 1 : 0,
    EyeType: look.eyes ? EYE_TYPE_UNIFORM[look.eyes.type] : 0,
  };
  for (const key in values) gl.uniform1f(uniform("u" + key), values[key as LookKey]);
  gl.uniform1f(uniform("t"), look.seed + frame.clock);
  gl.uniform1f(uniform("energy"), frame.energy);
  gl.uniform1f(uniform("listen"), frame.listen);
  gl.uniform1f(uniform("uResY"), full);
  gl.uniform1f(uniform("uOp"), 1);
  const eyes = look.eyes;
  gl.uniform1f(uniform("eOpenL"), 1);
  gl.uniform1f(uniform("eOpenR"), 1);
  gl.uniform1f(uniform("eLookX"), eyes?.lookX ?? 0);
  gl.uniform1f(uniform("eLookY"), eyes?.lookY ?? 0);
  gl.uniform1f(uniform("eSmile"), eyes?.smile ? 1 : 0);
  gl.uniform1f(uniform("eScale"), 1);
  gl.uniform1f(uniform("eTilt"), 0);
  gl.uniform1f(uniform("eSquash"), 0);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

  // WebGL's origin is bottom-left, so the frame sits at the bottom of the canvas.
  target.clearRect(0, 0, px, px);
  target.drawImage(canvas, offset, canvas.height - full + offset, px, px, 0, 0, px, px);
  return true;
}
