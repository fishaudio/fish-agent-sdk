import { describe, expect, it } from "vitest";
import { agentAvatar, avatarIndex, EYES_MIN_SIZE } from "../rule.js";
import golden from "./rule-golden.json";

describe("agentAvatar", () => {
  // Any renderer, on any platform, must agree with these. Updating them is a breaking change.
  it.each(golden)("matches the golden look for $id", (expected) => {
    const look = agentAvatar(expected.id, 64);
    expect(look.n).toBe(expected.n);
    expect(look.tier).toBe(expected.tier);
    expect(look.palette).toEqual(expected.palette);
    expect(look.hue).toBeCloseTo(expected.hue, 9);
    expect(look.seed).toBeCloseTo(expected.seed, 9);
    expect(look.flowAngle).toBeCloseTo(expected.flowAngle, 9);
    expect(look.eyes).toEqual({
      ...expected.eyes,
      lookX: expect.closeTo(expected.eyes.lookX, 9),
      lookY: expect.closeTo(expected.eyes.lookY, 9),
    });
  });

  it("drops the eyes below the minimum size", () => {
    expect(agentAvatar("Beau", EYES_MIN_SIZE - 1).eyes).toBeNull();
    expect(agentAvatar("Beau", EYES_MIN_SIZE).eyes).not.toBeNull();
  });

  it("keeps colours and flow the same at every size", () => {
    const { eyes: _small, ...small } = agentAvatar("agent-7", 24);
    const { eyes: _large, ...large } = agentAvatar("agent-7", 128);
    expect(small).toEqual(large);
  });

  it("never picks a yellow-green hue", () => {
    for (let i = 0; i < 2000; i++) {
      const { hue } = agentAvatar(`agent-${i}`);
      expect(hue >= 48 && hue < 95).toBe(false);
    }
  });

  it("reduces any id to 0–99999", () => {
    for (const id of ["", "a", "🐟", "x".repeat(500)]) {
      const n = avatarIndex(id);
      expect(Number.isInteger(n) && n >= 0 && n < 100000).toBe(true);
    }
  });
});
