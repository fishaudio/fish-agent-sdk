import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({ Animated: {}, PanResponder: {}, View: () => null }));

import { restingPoint, snapPosition, type DragBounds } from "../drag.js";

const bounds: DragBounds = { width: 400, height: 800, left: 20, right: 20, top: 64, bottom: 54 };

describe("snapPosition", () => {
  it("snaps to the nearer side and measures from the nearer edge", () => {
    expect(snapPosition({ x: 50, y: 100, width: 60, height: 60 }, bounds)).toEqual({ side: "left", edge: "top", distance: 100 });
    expect(snapPosition({ x: 300, y: 600, width: 60, height: 60 }, bounds)).toEqual({
      side: "right",
      edge: "bottom",
      distance: 140,
    });
  });

  it("keeps the launcher out of the insets when released past an edge", () => {
    expect(snapPosition({ x: -30, y: -40, width: 60, height: 60 }, bounds)).toEqual({ side: "left", edge: "top", distance: 64 });
    expect(snapPosition({ x: 390, y: 790, width: 60, height: 60 }, bounds)).toEqual({ side: "right", edge: "bottom", distance: 54 });
  });
});

describe("restingPoint", () => {
  it("places the launcher at its side and distance", () => {
    expect(restingPoint({ side: "right", edge: "bottom", distance: 140 }, bounds, { width: 60, height: 60 })).toEqual({
      x: 400 - 20 - 60,
      y: 800 - 140 - 60,
    });
    expect(restingPoint({ side: "left", edge: "top", distance: 100 }, bounds, { width: 60, height: 60 })).toEqual({ x: 20, y: 100 });
  });

  it("keeps a wider launcher flush with the right side", () => {
    expect(restingPoint({ side: "right", edge: "bottom", distance: 140 }, bounds, { width: 180, height: 48 }).x).toBe(400 - 20 - 180);
  });

  it("clamps a stored distance that no longer fits, e.g. after rotation", () => {
    const landscape = { ...bounds, width: 800, height: 400 };
    expect(restingPoint({ side: "left", edge: "bottom", distance: 600 }, landscape, { width: 60, height: 60 })).toEqual({
      x: 20,
      y: 64,
    });
  });
});
