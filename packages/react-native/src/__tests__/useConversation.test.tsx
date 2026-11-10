import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { calls, platform, web, audioSession, nativeModule, permissions } = vi.hoisted(() => {
  const calls: string[] = [];
  const platform = { OS: "android" as "android" | "ios" };
  const web = {
    status: "idle" as string,
    startError: undefined as unknown,
    startSession: async () => {
      calls.push("web.start");
      if (web.startError) {
        throw web.startError;
      }
      return "sess-1";
    },
    endSession: async () => {
      calls.push("web.end");
    },
  };
  const audioSession = {
    outputs: ["speaker", "earpiece"] as string[],
    startAudioSession: async () => void calls.push("audio.start"),
    stopAudioSession: async () => void calls.push("audio.stop"),
    selectAudioOutput: async (id: string) => void calls.push(`audio.select:${id}`),
    getAudioOutputs: async () => audioSession.outputs,
    setAppleAudioConfiguration: async (config: { audioMode?: string }) =>
      void calls.push(`audio.apple:${config.audioMode}`),
  };
  const nativeModule = {
    startCallService: (title: string) => {
      calls.push(`service.start:${title}`);
      return true;
    },
    stopCallService: () => void calls.push("service.stop"),
  };
  const permissions = { granted: true, checked: false };
  return { calls, platform, web, audioSession, nativeModule, permissions };
});

vi.mock("react-native", () => ({
  Platform: platform,
  PermissionsAndroid: {
    PERMISSIONS: { RECORD_AUDIO: "android.permission.RECORD_AUDIO" },
    RESULTS: { GRANTED: "granted", DENIED: "denied" },
    check: async () => permissions.checked,
    request: async () => {
      calls.push("permission.request");
      return permissions.granted ? "granted" : "denied";
    },
  },
}));
vi.mock("expo", () => ({ requireOptionalNativeModule: () => nativeModule }));
vi.mock("@livekit/react-native", () => ({
  AudioSession: audioSession,
  registerGlobals: () => {
    calls.push("registerGlobals");
    (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection = class {};
  },
}));
vi.mock("@fishaudio/agent-react", async () => {
  const React = await import("react");
  return {
    useConversation: () => {
      const [, rerender] = React.useState(0);
      (web as { rerender?: () => void }).rerender = () => rerender((n) => n + 1);
      return { ...web, session: null, mode: "listening" };
    },
  };
});

import { useConversation } from "../useConversation.js";
import { applyAudioOutput } from "../audio.js";

beforeEach(() => {
  calls.length = 0;
  // Most tests start as if the entry file already installed the globals.
  (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection = class {};
  platform.OS = "android";
  web.status = "idle";
  web.startError = undefined;
  permissions.granted = true;
  permissions.checked = false;
  audioSession.outputs = ["speaker", "earpiece"];
});

describe("useConversation (React Native)", () => {
  it("asks for the mic, starts audio and the call service, then the session", async () => {
    const { result } = renderHook(() =>
      useConversation({}, { callNotification: { title: "Talking to support" } }),
    );
    await act(async () => {
      await result.current.startSession();
    });
    expect(calls).toEqual([
      "permission.request",
      "audio.start",
      "service.start:Talking to support",
      "web.start",
    ]);
  });

  it("fails the start without touching audio when the mic is denied", async () => {
    permissions.granted = false;
    const { result } = renderHook(() => useConversation());
    await act(async () => {
      await expect(result.current.startSession()).rejects.toMatchObject({
        code: "mic_permission_denied",
      });
    });
    expect(calls).toEqual(["permission.request"]);
  });

  it("skips the permission and the call service for a session without a microphone", async () => {
    const { result } = renderHook(() => useConversation({ microphone: false }));
    await act(async () => {
      await result.current.startSession();
    });
    expect(calls).toEqual(["audio.start", "web.start"]);
  });

  it("skips the call service when callNotification is false", async () => {
    permissions.checked = true;
    const { result } = renderHook(() => useConversation({}, { callNotification: false }));
    await act(async () => {
      await result.current.startSession();
    });
    expect(calls).toEqual(["audio.start", "web.start"]);
  });

  it("releases audio and the call service when the start fails", async () => {
    permissions.checked = true;
    web.startError = new Error("no token");
    const { result } = renderHook(() => useConversation());
    await act(async () => {
      await expect(result.current.startSession()).rejects.toThrow("no token");
    });
    expect(calls).toEqual([
      "audio.start",
      "service.start:Call in progress",
      "web.start",
      "service.stop",
      "audio.stop",
    ]);
  });

  it("releases the platform once when the call ends from the other side", async () => {
    permissions.checked = true;
    const { result } = renderHook(() => useConversation());
    await act(async () => {
      await result.current.startSession();
    });
    calls.length = 0;
    await act(async () => {
      web.status = "ended";
      (web as { rerender?: () => void }).rerender?.();
    });
    await act(async () => {
      await result.current.endSession();
    });
    expect(calls).toEqual(["service.stop", "audio.stop", "web.end"]);
  });

  it("routes audio live during a call and only records the choice otherwise", async () => {
    permissions.checked = true;
    const { result } = renderHook(() => useConversation());
    await act(async () => {
      await result.current.setAudioOutput("earpiece");
    });
    expect(calls).toEqual([]);
    expect(result.current.audioOutput).toBe("earpiece");
    await act(async () => {
      await result.current.startSession();
    });
    expect(calls).toContain("audio.select:earpiece");
    calls.length = 0;
    await act(async () => {
      await result.current.setAudioOutput("speaker");
    });
    expect(calls).toEqual(["audio.select:speaker"]);
  });
});

describe("WebRTC globals", () => {
  it("installs them on start when the entry file did not", async () => {
    delete (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection;
    permissions.checked = true;
    const { result } = renderHook(() => useConversation({}, { callNotification: false }));
    await act(async () => {
      await result.current.startSession();
    });
    expect(calls).toEqual(["registerGlobals", "audio.start", "web.start"]);
  });

  it("leaves them alone when they are already there", async () => {
    permissions.checked = true;
    const { result } = renderHook(() => useConversation({}, { callNotification: false }));
    await act(async () => {
      await result.current.startSession();
    });
    expect(calls).not.toContain("registerGlobals");
  });
});

describe("iOS audio session", () => {
  it("leaves activating and deactivating the session to WebRTC", async () => {
    platform.OS = "ios";
    const { result } = renderHook(() => useConversation());
    await act(async () => {
      await result.current.startSession();
      await result.current.endSession();
    });
    expect(calls).not.toContain("audio.start");
    expect(calls).not.toContain("audio.stop");
    expect(calls).toContain("audio.apple:videoChat");
    expect(calls).toContain("web.start");
  });
});

describe("applyAudioOutput", () => {
  it("leaves LiveKit's automatic routing alone at the start of an Android call", async () => {
    await applyAudioOutput("auto", { initial: true });
    expect(calls).toEqual([]);
  });

  it("picks a connected headset when going back to auto on Android", async () => {
    audioSession.outputs = ["speaker", "earpiece", "headset"];
    await applyAudioOutput("auto");
    expect(calls).toEqual(["audio.select:headset"]);
  });

  it("uses the receiver mode for the iOS earpiece and the override for the speaker", async () => {
    platform.OS = "ios";
    await applyAudioOutput("earpiece");
    await applyAudioOutput("speaker");
    await applyAudioOutput("auto");
    expect(calls).toEqual([
      "audio.apple:voiceChat",
      "audio.select:default",
      "audio.apple:videoChat",
      "audio.select:force_speaker",
      "audio.apple:videoChat",
      "audio.select:default",
    ]);
  });
});
