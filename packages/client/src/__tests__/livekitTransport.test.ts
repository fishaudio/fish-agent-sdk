import { describe, expect, it, vi } from "vitest";
import { ConnectionState, RoomEvent } from "livekit-client";
import type { SessionToken } from "@fishaudio/agent-protocol";
import { LiveKitTransport } from "../transport/livekit.js";
import type { TransportCallbacks, TransportConnectionState } from "../transport/types.js";

const { FakeRoom } = vi.hoisted(() => {
  type Participant = { attributes?: Record<string, string> };

  class FakeRoom {
    static lastInstance: FakeRoom | undefined;
    private handlers = new Map<string, Array<(...args: unknown[]) => void>>();
    state: string = "disconnected";
    remoteParticipants = new Map<string, Participant>();
    disconnectCalls = 0;
    localParticipant = {
      identity: "local",
      audioTrackPublications: new Map<string, never>(),
      setMicrophoneEnabled: async () => {},
      publishData: async () => {},
    };

    constructor() {
      FakeRoom.lastInstance = this;
    }

    on(event: string, handler: (...args: unknown[]) => void): this {
      const list = this.handlers.get(event) ?? [];
      list.push(handler);
      this.handlers.set(event, list);
      return this;
    }

    emit(event: string, ...args: unknown[]): void {
      for (const handler of this.handlers.get(event) ?? []) {
        handler(...args);
      }
    }

    registerTextStreamHandler(): void {}

    switchActiveDeviceCalls: Array<{ kind: string; deviceId: string; exact: boolean }> = [];
    switchActiveDeviceResult = true;
    switchActiveDeviceError?: unknown;
    activeDevices = new Map<string, string>();

    async switchActiveDevice(kind: string, deviceId: string, exact: boolean): Promise<boolean> {
      this.switchActiveDeviceCalls.push({ kind, deviceId, exact });
      if (this.switchActiveDeviceError) {
        const error = this.switchActiveDeviceError;
        this.switchActiveDeviceError = undefined;
        throw error;
      }
      if (this.switchActiveDeviceResult) {
        this.activeDevices.set(kind, deviceId);
      }
      return this.switchActiveDeviceResult;
    }

    getActiveDevice(kind: string): string | undefined {
      return this.activeDevices.get(kind);
    }

    async connect(): Promise<void> {
      this.state = "connected";
    }

    async disconnect(): Promise<void> {
      this.disconnectCalls += 1;
      this.state = "disconnected";
    }
  }

  return { FakeRoom };
});

vi.mock("livekit-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("livekit-client")>();
  return { ...actual, Room: FakeRoom as unknown as typeof actual.Room };
});

const SESSION_TOKEN: SessionToken = {
  transport: "livekit",
  session_id: "sess-1",
  expires_at: new Date(Date.now() + 120_000).toISOString(),
  max_duration_seconds: 600,
  livekit_url: "wss://example.livekit.cloud",
  token: "tok",
};

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function connectTransport() {
  const states: Array<{ state: TransportConnectionState; reason?: string }> = [];
  const inputStreams: unknown[] = [];
  const outputStreams: Array<{ id: string; voice: boolean }> = [];
  const endedOutputStreams: string[] = [];
  const callbacks: TransportCallbacks = {
    onAgentEvent: () => {},
    onAgentState: () => {},
    onTranscription: () => {},
    onOutputStream: (id, _stream, voice) => {
      outputStreams.push({ id, voice });
    },
    onOutputStreamEnded: (id) => {
      endedOutputStreams.push(id);
    },
    onInputStream: (stream) => {
      inputStreams.push(stream);
    },
    onConnectionState: (state, reason) => {
      states.push({ state, reason });
    },
  };
  const transport = new LiveKitTransport();
  await transport.connect(SESSION_TOKEN, { callbacks, microphone: false });
  const room = FakeRoom.lastInstance;
  if (!room) {
    throw new Error("FakeRoom was not constructed");
  }
  room.remoteParticipants.set("agent", {});
  return { transport, room, states, inputStreams, outputStreams, endedOutputStreams };
}

// Mirrors livekit-client 2.20 Room.handleRestarting: the roster is cleared and
// ParticipantDisconnected emitted first (state may still read Connected), and
// only afterwards is state set to Reconnecting and the event emitted.
function emitFullReconnectStart(room: InstanceType<typeof FakeRoom>): void {
  const agent = room.remoteParticipants.get("agent");
  room.remoteParticipants.clear();
  room.emit(RoomEvent.ParticipantDisconnected, agent);
  room.state = ConnectionState.Reconnecting;
  room.emit(RoomEvent.Reconnecting);
}

describe("LiveKitTransport reconnect vs agent hangup", () => {
  it("survives a full reconnect that clears the roster before Reconnecting", async () => {
    const { room, states } = await connectTransport();

    emitFullReconnectStart(room);
    await flush();

    expect(states).toEqual([{ state: "reconnecting", reason: undefined }]);
    expect(room.disconnectCalls).toBe(0);
  });

  it("suppresses roster clearing while already reconnecting (failed resume path)", async () => {
    const { room, states } = await connectTransport();

    room.state = ConnectionState.SignalReconnecting;
    const agent = room.remoteParticipants.get("agent");
    room.remoteParticipants.clear();
    room.emit(RoomEvent.ParticipantDisconnected, agent);
    room.state = ConnectionState.Reconnecting;
    room.emit(RoomEvent.Reconnecting);
    await flush();

    expect(states).toEqual([{ state: "reconnecting", reason: undefined }]);
    expect(room.disconnectCalls).toBe(0);
  });

  it("reports connected after Reconnected when the agent came back", async () => {
    const { room, states } = await connectTransport();

    emitFullReconnectStart(room);
    await flush();
    room.remoteParticipants.set("agent", {});
    room.state = ConnectionState.Connected;
    room.emit(RoomEvent.Reconnected);
    await flush();

    expect(states).toEqual([
      { state: "reconnecting", reason: undefined },
      { state: "connected", reason: undefined },
    ]);
    expect(room.disconnectCalls).toBe(0);
  });

  it("fires AGENT_LEFT after Reconnected when the agent did not come back", async () => {
    const { room, states } = await connectTransport();

    emitFullReconnectStart(room);
    await flush();
    room.state = ConnectionState.Connected;
    room.emit(RoomEvent.Reconnected);
    await flush();

    expect(states).toEqual([
      { state: "reconnecting", reason: undefined },
      { state: "disconnected", reason: "AGENT_LEFT" },
    ]);
    expect(room.disconnectCalls).toBe(1);
  });

  it("fires AGENT_LEFT on a plain hangup while connected", async () => {
    const { room, states } = await connectTransport();

    const agent = room.remoteParticipants.get("agent");
    room.remoteParticipants.delete("agent");
    room.emit(RoomEvent.ParticipantDisconnected, agent);
    await flush();

    expect(states).toEqual([{ state: "disconnected", reason: "AGENT_LEFT" }]);
    expect(room.disconnectCalls).toBe(1);
  });
});

describe("LiveKitTransport getRoom", () => {
  it("exposes the room while connected and undefined after disconnect", async () => {
    const { transport, room } = await connectTransport();
    expect(transport.getRoom()).toBe(room);
    await transport.disconnect();
    expect(transport.getRoom()).toBeUndefined();
  });
});

describe("LiveKitTransport setInputDevice", () => {
  it("switches with exact matching and rejects when the device is unavailable", async () => {
    const { transport, room } = await connectTransport();

    await transport.setInputDevice("mic-2");
    expect(room.switchActiveDeviceCalls).toEqual([
      { kind: "audioinput", deviceId: "mic-2", exact: true },
    ]);

    room.switchActiveDeviceResult = false;
    await expect(transport.setInputDevice("mic-missing")).rejects.toMatchObject({
      code: "device_change_failed",
    });
  });

  it("switches back to the previous microphone when the new device fails", async () => {
    const { transport, room } = await connectTransport();
    await transport.setInputDevice("mic-1");

    room.switchActiveDeviceError = new Error("OverconstrainedError");
    await expect(transport.setInputDevice("mic-broken")).rejects.toThrow();
    // livekit stops the old capture before acquiring the new one, so the
    // transport must switch back or the call goes silently mic-dead.
    expect(room.switchActiveDeviceCalls.map((call) => call.deviceId)).toEqual([
      "mic-1",
      "mic-broken",
      "mic-1",
    ]);
  });

  it("re-emits the input stream after a switch and on livekit-initiated restarts", async () => {
    vi.stubGlobal(
      "MediaStream",
      class {
        constructor(readonly tracks: unknown[]) {}
      },
    );
    try {
      const { transport, room, inputStreams } = await connectTransport();
      const track = { mediaStreamTrack: { id: "t1" }, on: vi.fn() };
      room.localParticipant.audioTrackPublications.set("pub", { track } as never);

      await transport.setInputDevice("mic-2");
      expect(inputStreams).toHaveLength(1);

      // Restarts (devicechange auto-recovery, escape-hatch switches) replace
      // the MediaStreamTrack without our API being involved.
      expect(track.on).toHaveBeenCalledWith("restarted", expect.any(Function));
      const restartHandler = track.on.mock.calls[0]![1] as () => void;
      track.mediaStreamTrack = { id: "t2" };
      restartHandler();
      expect(inputStreams).toHaveLength(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("is a no-op once disconnected", async () => {
    const { transport, room } = await connectTransport();
    await transport.disconnect();
    await transport.setInputDevice("mic-2");
    expect(room.switchActiveDeviceCalls).toEqual([]);
  });
});

describe("LiveKitTransport remote-initiated ends", () => {
  it("clears the room once the room reports Disconnected", async () => {
    const { transport, room } = await connectTransport();
    room.emit(RoomEvent.Disconnected);
    expect(transport.getRoom()).toBeUndefined();
    // ...so a later device switch is a no-op, not a fake success on a dead room.
    await transport.setInputDevice("mic-2");
    expect(room.switchActiveDeviceCalls).toEqual([]);
  });
});

describe("LiveKitTransport agent audio tracks", () => {
  it("reports every agent audio track and marks only the microphone-source one as voice", async () => {
    vi.stubGlobal(
      "MediaStream",
      class {
        constructor(readonly tracks: unknown[]) {}
      },
    );
    try {
      const { room, outputStreams, endedOutputStreams } = await connectTransport();
      const audio = (source: string) => ({ kind: "audio", source, mediaStreamTrack: { id: source } });
      room.emit(RoomEvent.TrackSubscribed, audio("microphone"), { trackSid: "TR_voice" });
      room.emit(RoomEvent.TrackSubscribed, audio("unknown"), { trackSid: "TR_ambience" });
      room.emit(RoomEvent.TrackSubscribed, { kind: "video", source: "camera" }, { trackSid: "TR_video" });
      expect(outputStreams).toEqual([
        { id: "TR_voice", voice: true },
        { id: "TR_ambience", voice: false },
      ]);
      room.emit(RoomEvent.TrackUnsubscribed, audio("unknown"), { trackSid: "TR_ambience" });
      expect(endedOutputStreams).toEqual(["TR_ambience"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
