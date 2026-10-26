import { describe, expect, it, vi } from "vitest";
import { ConnectionState, RoomEvent } from "livekit-client";
import {
  AGENT_READY_ATTRIBUTE,
  CLIENT_AUDIO_READY_ATTRIBUTE,
  CLIENT_AUDIO_READY_PENDING,
  CLIENT_EVENT_TOPIC,
  type SessionToken,
} from "@fishaudio/agent-protocol";
import { LiveKitTransport } from "../transport/livekit.js";
import type { TransportCallbacks, TransportConnectionState } from "../transport/types.js";

const { FakeRoom, createLocalAudioTrack } = vi.hoisted(() => {
  type Participant = { attributes?: Record<string, string>; isLocal?: boolean };

  class FakeLocalParticipant {
    identity = "local";
    isLocal = true;
    audioTrackPublications = new Map<string, never>();
    attributes: Record<string, string> = {};
    /** Every setAttributes payload, in order. */
    attributeUpdates: Array<Record<string, string>> = [];
    /** Interleaved order of attribute and track publishes. */
    calls: string[] = [];
    /** Every data frame published, decoded. */
    dataFrames: Array<{ topic?: string; message: unknown }> = [];
    setAttributesError?: unknown;

    async setMicrophoneEnabled(): Promise<void> {}
    async publishData(payload: Uint8Array, options?: { topic?: string }): Promise<void> {
      this.dataFrames.push({ topic: options?.topic, message: JSON.parse(new TextDecoder().decode(payload)) });
    }

    async publishTrack(): Promise<void> {
      this.calls.push("publishTrack");
    }

    async setAttributes(attributes: Record<string, string>): Promise<void> {
      this.calls.push(`setAttributes:${JSON.stringify(attributes)}`);
      if (this.setAttributesError) {
        throw this.setAttributesError;
      }
      this.attributeUpdates.push(attributes);
      Object.assign(this.attributes, attributes);
    }
  }

  class FakeRoom {
    static lastInstance: FakeRoom | undefined;
    /** Runs inside the next connect(), before it resolves. */
    static onConnect: (() => void) | undefined;
    /** Participants already in the room when the next FakeRoom connects. */
    static nextParticipants: Array<[string, Participant]> = [];
    private handlers = new Map<string, Array<(...args: unknown[]) => void>>();
    state: string = "disconnected";
    remoteParticipants = new Map<string, Participant>(FakeRoom.nextParticipants);
    disconnectCalls = 0;
    localParticipant = new FakeLocalParticipant();

    constructor() {
      FakeRoom.lastInstance = this;
      FakeRoom.nextParticipants = [];
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
      const hook = FakeRoom.onConnect;
      FakeRoom.onConnect = undefined;
      hook?.();
    }

    async disconnect(): Promise<void> {
      this.disconnectCalls += 1;
      this.state = "disconnected";
    }
  }

  const createLocalAudioTrack = vi.fn(async () => ({
    stop: () => {},
    on: () => {},
    mediaStreamTrack: undefined,
  }));

  return { FakeRoom, createLocalAudioTrack };
});

vi.mock("livekit-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("livekit-client")>();
  return {
    ...actual,
    Room: FakeRoom as unknown as typeof actual.Room,
    createLocalAudioTrack:
      createLocalAudioTrack as unknown as typeof actual.createLocalAudioTrack,
  };
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

async function connectTransport({
  microphone = false,
  duringConnect,
}: {
  microphone?: boolean;
  /** Runs while room.connect() is in flight, with the transport under test. */
  duringConnect?: (transport: LiveKitTransport) => void;
} = {}) {
  const states: Array<{ state: TransportConnectionState; reason?: string }> = [];
  const inputStreams: unknown[] = [];
  const agentStates: string[] = [];
  let agentReady = 0;
  const callbacks: TransportCallbacks = {
    onAgentEvent: () => {},
    onAgentReady: () => {
      agentReady += 1;
    },
    onAgentState: (state) => {
      agentStates.push(state);
    },
    onTranscription: () => {},
    onOutputStream: () => {},
    onInputStream: (stream) => {
      inputStreams.push(stream);
    },
    onConnectionState: (state, reason) => {
      states.push({ state, reason });
    },
  };
  const transport = new LiveKitTransport();
  FakeRoom.onConnect = duringConnect ? () => duringConnect(transport) : undefined;
  await transport.connect(SESSION_TOKEN, { callbacks, microphone });
  const room = FakeRoom.lastInstance;
  if (!room) {
    throw new Error("FakeRoom was not constructed");
  }
  if (!room.remoteParticipants.has("agent")) {
    room.remoteParticipants.set("agent", {});
  }
  return {
    transport,
    room,
    states,
    inputStreams,
    agentStates,
    agentReady: () => agentReady,
  };
}

function audioReadyValues(room: InstanceType<typeof FakeRoom>): string[] {
  return room.localParticipant.attributeUpdates.map(
    (update) => update[CLIENT_AUDIO_READY_ATTRIBUTE]!,
  );
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

describe("LiveKitTransport audio-ready handshake", () => {
  it("announces pending right after connect, before the microphone is published", async () => {
    const { room } = await connectTransport({ microphone: true });
    await flush();
    expect(room.localParticipant.calls).toEqual([
      `setAttributes:${JSON.stringify({ [CLIENT_AUDIO_READY_ATTRIBUTE]: CLIENT_AUDIO_READY_PENDING })}`,
      "publishTrack",
    ]);
  });

  it("stamps the ready time once the session reports playback, exactly once", async () => {
    const { transport, room } = await connectTransport();
    await flush();
    const before = Date.now();
    transport.markAudioReady();
    transport.markAudioReady();
    await flush();
    const values = audioReadyValues(room);
    expect(values).toHaveLength(2);
    expect(values[0]).toBe(CLIENT_AUDIO_READY_PENDING);
    expect(values[1]).toMatch(/^\d+$/);
    expect(Number(values[1])).toBeGreaterThanOrEqual(before);
  });

  it("sends the ready stamp over the data channel as well, never the pending announcement", async () => {
    const { transport, room } = await connectTransport();
    await flush();
    expect(room.localParticipant.dataFrames).toEqual([]);
    transport.markAudioReady();
    await flush();
    const stamp = audioReadyValues(room)[1];
    expect(room.localParticipant.dataFrames).toEqual([
      { topic: CLIENT_EVENT_TOPIC, message: { type: "client.audio_ready", at: Number(stamp) } },
    ]);
  });

  it("keeps a ready stamp reported during connect instead of overwriting it with pending", async () => {
    const { room } = await connectTransport({
      duringConnect: (transport) => transport.markAudioReady(),
    });
    await flush();
    const values = audioReadyValues(room);
    expect(values).toHaveLength(2);
    expect(values[0]).toMatch(/^\d+$/);
    expect(values[1]).toBe(values[0]);
  });

  it("re-announces pending after a reconnect while playback is not ready", async () => {
    const { room } = await connectTransport();
    emitFullReconnectStart(room);
    await flush();
    room.remoteParticipants.set("agent", {});
    room.state = ConnectionState.Connected;
    room.emit(RoomEvent.Reconnected);
    await flush();
    expect(audioReadyValues(room)).toEqual([
      CLIENT_AUDIO_READY_PENDING,
      CLIENT_AUDIO_READY_PENDING,
    ]);
  });

  it("re-publishes the same ready stamp after a reconnect", async () => {
    const { transport, room } = await connectTransport();
    transport.markAudioReady();
    await flush();
    emitFullReconnectStart(room);
    await flush();
    room.remoteParticipants.set("agent", {});
    room.state = ConnectionState.Connected;
    room.emit(RoomEvent.Reconnected);
    await flush();
    const values = audioReadyValues(room);
    expect(values).toHaveLength(3);
    expect(values[2]).toBe(values[1]);
    expect(values[2]).toMatch(/^\d+$/);
    expect(room.localParticipant.dataFrames.map((frame) => frame.message)).toEqual([
      { type: "client.audio_ready", at: Number(values[1]) },
      { type: "client.audio_ready", at: Number(values[1]) },
    ]);
  });

  it("swallows attribute publish failures and logs them at debug level", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    try {
      const { transport, room } = await connectTransport();
      room.localParticipant.setAttributesError = new Error("signal closed");
      transport.markAudioReady();
      await flush();
      expect(room.localParticipant.calls).toHaveLength(2);
      expect(debug).toHaveBeenCalledTimes(1);
      expect(debug.mock.calls[0]![0]).toContain("audio readiness report rejected");
    } finally {
      debug.mockRestore();
    }
  });

  it("is a no-op once disconnected", async () => {
    const { transport, room } = await connectTransport();
    await transport.disconnect();
    transport.markAudioReady();
    await flush();
    expect(audioReadyValues(room)).toEqual([CLIENT_AUDIO_READY_PENDING]);
  });
});

describe("LiveKitTransport agent presence", () => {
  it("reports the agent ready from its fish.agent.ready attribute", async () => {
    const { room, agentReady, agentStates } = await connectTransport();
    room.emit(
      RoomEvent.ParticipantAttributesChanged,
      { [AGENT_READY_ATTRIBUTE]: "1700000000000" },
      { isLocal: false },
    );
    expect(agentReady()).toBe(1);
    expect(agentStates).toEqual([]);
  });

  it("falls back to lk.agent.state for runtimes without the ready signal", async () => {
    const { room, agentReady, agentStates } = await connectTransport();
    room.emit(
      RoomEvent.ParticipantAttributesChanged,
      { "lk.agent.state": "initializing" },
      { isLocal: false },
    );
    expect(agentStates).toEqual(["initializing"]);
    expect(agentReady()).toBe(0);
  });

  it("ignores the local participant's attributes", async () => {
    const { room, agentReady, agentStates } = await connectTransport();
    room.emit(
      RoomEvent.ParticipantAttributesChanged,
      { [AGENT_READY_ATTRIBUTE]: "1", "lk.agent.state": "listening" },
      { isLocal: true },
    );
    expect(agentReady()).toBe(0);
    expect(agentStates).toEqual([]);
  });

  it("replays sticky attributes of an agent already in the room on connect", async () => {
    FakeRoom.nextParticipants = [
      ["agent", { attributes: { [AGENT_READY_ATTRIBUTE]: "1", "lk.agent.state": "listening" } }],
    ];
    const { agentReady, agentStates } = await connectTransport();
    expect(agentReady()).toBe(1);
    expect(agentStates).toEqual(["listening"]);
  });

  it("reads sticky attributes off a participant that connects already ready", async () => {
    const { room, agentReady } = await connectTransport();
    room.emit(RoomEvent.ParticipantConnected, {
      attributes: { [AGENT_READY_ATTRIBUTE]: "1" },
    });
    expect(agentReady()).toBe(1);
  });

  it("re-reads the roster after a reconnect", async () => {
    const { room, agentReady, states } = await connectTransport();
    emitFullReconnectStart(room);
    await flush();
    room.remoteParticipants.set("agent", { attributes: { [AGENT_READY_ATTRIBUTE]: "1" } });
    room.state = ConnectionState.Connected;
    room.emit(RoomEvent.Reconnected);
    await flush();
    expect(agentReady()).toBe(1);
    expect(states.map((entry) => entry.state)).toEqual(["reconnecting", "connected"]);
  });
});
