import { afterEach, describe, expect, it, vi } from "vitest";
import { AudioOutput } from "../audio/output.js";

class FakeMediaElement {
  autoplay = false;
  removed = false;
  volume = 1;
  srcObject: unknown = null;
  sinkCalls: string[] = [];
  sinkError?: unknown;

  setAttribute(): void {}
  remove(): void {
    this.removed = true;
  }
  async play(): Promise<void> {}

  async setSinkId(sinkId: string): Promise<void> {
    if (this.sinkError) {
      throw this.sinkError;
    }
    this.sinkCalls.push(sinkId);
  }
}

function stubDom(): FakeMediaElement[] {
  const elements: FakeMediaElement[] = [];
  class StubHTMLMediaElement {
    setSinkId(): Promise<void> {
      return Promise.resolve();
    }
  }
  vi.stubGlobal("HTMLMediaElement", StubHTMLMediaElement);
  vi.stubGlobal("document", {
    createElement: () => {
      const element = new FakeMediaElement();
      elements.push(element);
      return element;
    },
  });
  return elements;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AudioOutput.setSinkId", () => {
  it("routes the live element to the requested device", async () => {
    const elements = stubDom();
    const output = new AudioOutput();
    output.setStream("voice", {} as MediaStream);
    await output.setSinkId("speaker-2");
    expect(elements[0]?.sinkCalls).toEqual(["speaker-2"]);
  });

  it("creates the element eagerly so the device id is validated before audio arrives", async () => {
    const elements = stubDom();
    const output = new AudioOutput();
    await output.setSinkId("speaker-2");
    expect(elements).toHaveLength(1);
    expect(elements[0]?.sinkCalls).toEqual(["speaker-2"]);
    output.setStream("voice", {} as MediaStream);
    expect(elements).toHaveLength(1);
  });

  it("maps element failures to device_change_failed with the cause kept", async () => {
    const elements = stubDom();
    const output = new AudioOutput();
    output.setStream("voice", {} as MediaStream);
    const cause = new Error("device unplugged");
    elements[0]!.sinkError = cause;
    await expect(output.setSinkId("speaker-2")).rejects.toMatchObject({
      name: "FishAgentError",
      code: "device_change_failed",
      cause,
    });
  });

  it("rejects up front where the platform has no setSinkId", async () => {
    const output = new AudioOutput();
    await expect(output.setSinkId("speaker-2")).rejects.toMatchObject({
      code: "device_change_failed",
    });
  });
});

describe("AudioOutput with several agent tracks", () => {
  it("plays each track on its own element so ambience never replaces speech", () => {
    const elements = stubDom();
    const output = new AudioOutput();
    const voice = { id: "voice" } as unknown as MediaStream;
    const ambience = { id: "ambience" } as unknown as MediaStream;
    output.setStream("TR_voice", voice);
    output.setStream("TR_ambience", ambience);
    expect(elements).toHaveLength(2);
    expect(elements[0]?.srcObject).toBe(voice);
    expect(elements[1]?.srcObject).toBe(ambience);
  });

  it("reuses a track's element when the same track is re-subscribed", () => {
    const elements = stubDom();
    const output = new AudioOutput();
    const next = { id: "next" } as unknown as MediaStream;
    output.setStream("TR_voice", {} as MediaStream);
    output.setStream("TR_voice", next);
    expect(elements).toHaveLength(1);
    expect(elements[0]?.srcObject).toBe(next);
  });

  it("drops only the ended track's element", () => {
    const elements = stubDom();
    const output = new AudioOutput();
    output.setStream("TR_voice", {} as MediaStream);
    output.setStream("TR_ambience", {} as MediaStream);
    output.removeStream("TR_ambience");
    expect(elements[1]?.removed).toBe(true);
    expect(elements[1]?.srcObject).toBeNull();
    expect(elements[0]?.removed).toBe(false);
  });

  it("applies volume and the chosen device to every track, including later ones", async () => {
    const elements = stubDom();
    const output = new AudioOutput();
    output.setStream("TR_voice", {} as MediaStream);
    output.setVolume(0.4);
    await output.setSinkId("speaker-2");
    output.setStream("TR_ambience", {} as MediaStream);
    await Promise.resolve();
    expect(elements.map((element) => element.volume)).toEqual([0.4, 0.4]);
    expect(elements.map((element) => element.sinkCalls)).toEqual([["speaker-2"], ["speaker-2"]]);
  });
});
