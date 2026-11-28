import { describe, expect, it } from "vitest";
import { classifyMicrophoneLabel, readClientAudioInputInfo } from "../audio/inputInfo.js";

describe("classifyMicrophoneLabel", () => {
  it("classifies built-in laptop and mobile microphones", () => {
    expect(classifyMicrophoneLabel("MacBook Pro Microphone")).toBe("builtin");
    expect(classifyMicrophoneLabel("Default - MacBook Air Microphone (Built-in)")).toBe("builtin");
    expect(classifyMicrophoneLabel("Microphone Array (Intel Smart Sound Technology)")).toBe("builtin");
    expect(classifyMicrophoneLabel("Microphone (Realtek(R) Audio)")).toBe("builtin");
    expect(classifyMicrophoneLabel("iPhone Microphone")).toBe("builtin");
    expect(classifyMicrophoneLabel("内置麦克风")).toBe("builtin");
  });

  it("classifies Bluetooth headsets separately from wired headsets", () => {
    expect(classifyMicrophoneLabel("Default - AirPods Pro")).toBe("bluetooth");
    expect(classifyMicrophoneLabel("Headset (WH-1000XM5 Hands-Free)")).toBe("bluetooth");
    expect(classifyMicrophoneLabel("Bose QuietComfort Ultra Bluetooth")).toBe("bluetooth");
    expect(classifyMicrophoneLabel("Jabra Evolve2 65")).toBe("bluetooth");
  });

  it("classifies wired headsets, webcams, speakerphones, external mics, and virtual devices", () => {
    expect(classifyMicrophoneLabel("Plantronics Blackwire 3220 Headset")).toBe("headset");
    expect(classifyMicrophoneLabel("HyperX Cloud II")).toBe("headset");
    expect(classifyMicrophoneLabel("Logitech Brio 4K Webcam")).toBe("webcam");
    expect(classifyMicrophoneLabel("Studio Display Microphone")).toBe("webcam");
    expect(classifyMicrophoneLabel("Jabra Speak 510 USB")).toBe("speakerphone");
    expect(classifyMicrophoneLabel("Shure MV7 USB Microphone")).toBe("external");
    expect(classifyMicrophoneLabel("Blue Yeti Stereo Microphone")).toBe("external");
    expect(classifyMicrophoneLabel("Krisp Microphone (Virtual)")).toBe("virtual");
    expect(classifyMicrophoneLabel("BlackHole 2ch")).toBe("virtual");
  });

  it("falls back to unknown for empty or generic labels", () => {
    expect(classifyMicrophoneLabel(undefined)).toBe("unknown");
    expect(classifyMicrophoneLabel("")).toBe("unknown");
    expect(classifyMicrophoneLabel("Default")).toBe("unknown");
    expect(classifyMicrophoneLabel("Communications")).toBe("unknown");
    expect(classifyMicrophoneLabel("Microphone (2- High Definition Audio)")).toBe("unknown");
  });
});

describe("readClientAudioInputInfo", () => {
  it("returns undefined without a track", () => {
    expect(readClientAudioInputInfo(undefined)).toBeUndefined();
  });

  it("reads sanitized class and active capture settings without leaking raw labels", () => {
    const track = {
      label: "Default - Alice's MacBook Pro Microphone",
      getSettings: () => ({
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false,
        voiceIsolation: true,
        sampleRate: 48000,
        channelCount: 1,
      }),
    } as unknown as MediaStreamTrack;

    const info = readClientAudioInputInfo(track);
    expect(info).toEqual({
      micClass: "builtin",
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: false,
      voiceIsolation: true,
      sampleRate: 48000,
      channelCount: 1,
    });
    expect(JSON.stringify(info)).not.toContain("Alice");
  });

  it("survives getSettings throwing", () => {
    const track = {
      label: "AirPods Pro",
      getSettings: () => {
        throw new Error("not readable");
      },
    } as unknown as MediaStreamTrack;

    expect(readClientAudioInputInfo(track)).toEqual({ micClass: "bluetooth" });
  });
});
