import { describe, expect, it } from "vitest";
import { Face, sizeTier, stateExpression, type FaceOptions, type Pose } from "../face.js";
import { avatarLook } from "../rule.js";

const look = avatarLook("agent-1");
const opts = (o: Partial<FaceOptions> = {}): FaceOptions => ({
  size: 96,
  state: "idle",
  animated: true,
  reducedMotion: false,
  interactive: true,
  ...o,
});
const run = (face: Face, seconds: number, each?: (p: Pose) => void) => {
  let pose = face.step(0);
  for (let t = 0; t < seconds; t += 1 / 60) {
    pose = face.step(1 / 60);
    each?.(pose);
  }
  return pose;
};

describe("size tiers", () => {
  it("adds abilities as avatars grow", () => {
    expect(sizeTier(16)).toEqual({ liveFlow: false, lookAround: false, pointer: false, breathe: false, bounce: false, saccade: false });
    expect(sizeTier(24)).toEqual(sizeTier(16));
    expect(sizeTier(32)).toMatchObject({ liveFlow: false, lookAround: true, pointer: true, breathe: false });
    expect(sizeTier(40)).toEqual(sizeTier(32));
    expect(sizeTier(48)).toMatchObject({ liveFlow: true, breathe: true, bounce: false, saccade: false });
    expect(sizeTier(64)).toMatchObject({ liveFlow: true, bounce: true, saccade: true });
  });
});

describe("Face", () => {
  it("maps each call state to its expression", () => {
    expect(stateExpression("idle")).toBe("normal");
    expect(stateExpression("speaking")).toBe("normal");
    expect(stateExpression("listening")).toBe("curious");
    expect(stateExpression("thinking")).toBe("thinking");
    expect(stateExpression("ended")).toBe("sleepy");
    expect(stateExpression("error")).toBe("sad");
  });

  it("hides the body behind three bars while connecting", () => {
    const face = new Face(look, opts({ state: "connecting" }));
    const pose = face.step(0);
    expect(pose.bodyHidden).toBe(true);
    expect(pose.bars).toBe(1);
    expect(pose.eyesOpacity).toBe(0);
    face.update(opts({ state: "listening" }));
    const after = run(face, 1);
    expect(after.bodyHidden).toBe(false);
    expect(after.bars).toBeLessThan(0.01);
  });

  it("moves the bars while connecting and freezes them under reduced motion", () => {
    const live = new Face(look, opts({ state: "connecting" }));
    const a = live.step(0).barHeights;
    const b = run(live, 0.35).barHeights;
    expect(a).not.toEqual(b);
    const still = new Face(look, opts({ state: "connecting", reducedMotion: true }));
    const c = still.step(0).barHeights;
    expect(run(still, 0.35).barHeights).toEqual(c);
  });

  it("fades the body 42% on error, not the eyes", () => {
    const face = new Face(look, opts({ state: "error" }));
    const pose = face.step(0);
    expect(pose.dim).toBe(1);
    expect(pose.eyesOpacity).toBe(1);
  });

  it("plays an event expression, then returns to the state", () => {
    const face = new Face(look, opts({ state: "listening" }));
    face.emote("happy", 1300);
    const during = run(face, 0.6);
    expect(during.eyes[0].glyphs.happy).toBeGreaterThan(0.9);
    const after = run(face, 1.2);
    expect(after.eyes[0].glyphs.happy).toBeLessThan(0.05);
    expect(after.eyes[0].glyphs.oval).toBeGreaterThan(0.95);
  });

  it("keeps a lasting expression over the state's own", () => {
    const face = new Face(look, opts({ state: "idle", expression: "sleepy" }));
    expect(face.step(0).eyes[0].glyphs.closed).toBe(1);
  });

  it("presses to 95% and back without overshoot", () => {
    const face = new Face(look, opts({ size: 40, animated: false }));
    face.press(true);
    let min = Infinity;
    run(face, 0.8, (p) => (min = Math.min(min, p.sx)));
    expect(min).toBeGreaterThan(0.95 - 1e-3);
    expect(min).toBeLessThan(0.951);
    face.press(false);
    let max = 0;
    const end = run(face, 1, (p) => (max = Math.max(max, p.sx)));
    expect(max).toBeLessThanOrEqual(1 + 1e-4);
    expect(end.sx).toBeCloseTo(1, 3);
    expect(face.busy).toBe(false);
  });

  it("keeps small bodies still: no flow, no tilt, no breathing", () => {
    const face = new Face(look, opts({ size: 24 }));
    const poses: Pose[] = [];
    run(face, 3, (p) => poses.push(p));
    for (const p of poses) {
      expect(p.clock).toBe(0);
      expect(p.rot).toBe(0);
      expect(p.sx).toBe(1);
    }
  });

  it("flows and breathes from 48 px", () => {
    const face = new Face(look, opts({ size: 48 }));
    const p = run(face, 1);
    expect(p.clock).toBeGreaterThan(0);
  });

  it("is completely still under reduced motion but still shows the state", () => {
    const face = new Face(look, opts({ size: 96, state: "listening", reducedMotion: true }));
    const first = face.step(0);
    const later = run(face, 6);
    expect(later.clock).toBe(0);
    expect(later.sx).toBe(first.sx);
    expect(later.eyes[0].blink).toBe(1);
    expect(later.eyes).toEqual(first.eyes);
    // curious: the eyes differ in size
    expect(later.eyes[0].rr).not.toBeCloseTo(later.eyes[1].rr, 4);
    expect(face.busy).toBe(false);
  });

  it("follows the real volume while speaking", () => {
    let volume = 0;
    const face = new Face(look, opts({ state: "speaking", getVolume: () => volume }));
    const quiet = run(face, 0.5);
    volume = 0.2;
    const loud = run(face, 0.5);
    expect(loud.energy).toBeGreaterThan(quiet.energy + 0.3);
    expect(loud.sy).toBeLessThan(1);
  });

  it("settles when not animated, so frames stop", () => {
    const face = new Face(look, opts({ animated: false }));
    run(face, 0.1);
    expect(face.busy).toBe(false);
  });
});
