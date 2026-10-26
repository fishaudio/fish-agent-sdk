import { afterEach, describe, expect, it, vi } from "vitest";
import { AudioOutput } from "../audio/output.js";

class FakeMediaElement {
  autoplay = false;
  removed = false;
  volume = 1;
  srcObject: unknown = null;
  sinkCalls: string[] = [];
  sinkError?: unknown;
  playCalls = 0;
  /** Rejects the next `count` play() calls, like an autoplay block. */
  blockPlays = 0;

  setAttribute(): void {}
  remove(): void {
    this.removed = true;
  }

  async play(): Promise<void> {
    this.playCalls += 1;
    if (this.blockPlays > 0) {
      this.blockPlays -= 1;
      const error = new Error("play() failed because the user didn't interact");
      error.name = "NotAllowedError";
      throw error;
    }
  }

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

describe("AudioOutput playback signal", () => {
  it("fires once play() resolves on the attached speech stream", async () => {
    stubDom();
    const onPlaybackStarted = vi.fn();
    const output = new AudioOutput({ onPlaybackStarted });
    output.setStream("TR_voice", {} as MediaStream, true);
    await Promise.resolve();
    await Promise.resolve();
    expect(onPlaybackStarted).toHaveBeenCalledTimes(1);
  });

  it("ignores tracks other than the speech, playing or not", async () => {
    const elements = stubDom();
    const onPlaybackStarted = vi.fn();
    const output = new AudioOutput({ onPlaybackStarted });
    output.setStream("TR_ambience", {} as MediaStream);
    await Promise.resolve();
    await Promise.resolve();
    expect(onPlaybackStarted).not.toHaveBeenCalled();
    elements[0]!.blockPlays = 1;
    output.setStream("TR_voice", {} as MediaStream, true);
    await Promise.resolve();
    await Promise.resolve();
    expect(onPlaybackStarted).toHaveBeenCalledTimes(1);
  });

  it("stays silent under an autoplay block and fires from startAudio()", async () => {
    const elements = stubDom();
    const onPlaybackStarted = vi.fn();
    const output = new AudioOutput({ onPlaybackStarted });
    await output.setSinkId("speaker-2");
    elements[0]!.blockPlays = 1;
    output.setStream("TR_voice", {} as MediaStream, true);
    await Promise.resolve();
    await Promise.resolve();
    expect(onPlaybackStarted).not.toHaveBeenCalled();
    await output.startAudio();
    expect(onPlaybackStarted).toHaveBeenCalledTimes(1);
  });

  it("does not play or report an element with no stream attached", async () => {
    const elements = stubDom();
    const onPlaybackStarted = vi.fn();
    const output = new AudioOutput({ onPlaybackStarted });
    await output.setSinkId("speaker-2");
    await output.startAudio();
    expect(elements[0]!.playCalls).toBe(0);
    expect(onPlaybackStarted).not.toHaveBeenCalled();
  });

  it("drops a play() that resolves after the track went away or after dispose", async () => {
    stubDom();
    const onPlaybackStarted = vi.fn();
    const output = new AudioOutput({ onPlaybackStarted });
    output.setStream("TR_voice", {} as MediaStream, true);
    output.removeStream("TR_voice");
    await Promise.resolve();
    await Promise.resolve();
    expect(onPlaybackStarted).not.toHaveBeenCalled();
    output.setStream("TR_voice", {} as MediaStream, true);
    output.dispose();
    await Promise.resolve();
    await Promise.resolve();
    expect(onPlaybackStarted).not.toHaveBeenCalled();
  });
});
