import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentSessionMessage,
  ClientSessionMessage,
  SessionToken,
} from "@fishaudio/agent-protocol";
import { FishAgentError } from "../errors.js";
import { startAgentSession, type AgentSessionOptions } from "../session/agentSession.js";
import { MAX_CLIENT_TOOL_RESULT_BYTES } from "../session/toolDispatcher.js";
import type {
  TranscriptionSegmentUpdate,
  Transport,
  TransportCallbacks,
  TransportConnectOptions,
  TransportConnectionState,
} from "../transport/types.js";

const SESSION_TOKEN: SessionToken = {
  transport: "livekit",
  session_id: "sess-1",
  expires_at: new Date(Date.now() + 120_000).toISOString(),
  max_duration_seconds: 600,
  livekit_url: "wss://example.livekit.cloud",
  token: "tok",
};

class MockTransport implements Transport {
  callbacks?: TransportCallbacks;
  connectOptions?: TransportConnectOptions;
  sent: ClientSessionMessage[] = [];
  micEnabled = true;
  connected = false;
  micError?: unknown;
  disconnected = false;
  disconnectCalls = 0;
  disconnectGate?: Promise<void>;
  disconnectError?: unknown;
  connectError?: unknown;

  micPrepares: Array<{ inputDeviceId?: string }> = [];

  prepareMicrophone(options: { inputDeviceId?: string }): void {
    this.micPrepares.push(options);
  }

  async connect(_sessionToken: SessionToken, options: TransportConnectOptions): Promise<void> {
    this.callbacks = options.callbacks;
    this.connectOptions = options;
    this.connected = true;
    if (this.connectError) {
      throw this.connectError;
    }
  }

  async disconnect(): Promise<void> {
    this.disconnectCalls += 1;
    await this.disconnectGate;
    if (this.disconnectError) {
      throw this.disconnectError;
    }
    this.connected = false;
    this.disconnected = true;
  }

  inputDevice?: string;
  inputDeviceError?: unknown;

  async setInputDevice(deviceId: string): Promise<void> {
    if (this.inputDeviceError) {
      throw this.inputDeviceError;
    }
    this.inputDevice = deviceId;
  }

  async setMicEnabled(enabled: boolean): Promise<void> {
    if (this.micError) {
      throw this.micError;
    }
    this.micEnabled = enabled;
  }

  /** Rejects the next `count` sends with this error, then delivers normally. */
  sendError?: { error: unknown; count: number };

  async sendClientEvent(message: ClientSessionMessage): Promise<void> {
    if (this.sendError && this.sendError.count > 0) {
      this.sendError.count -= 1;
      throw this.sendError.error;
    }
    this.sent.push(message);
  }

  agent(message: AgentSessionMessage): void {
    this.callbacks!.onAgentEvent(message);
  }

  agentState(state: string): void {
    this.callbacks!.onAgentState(state);
  }

  transcription(update: Partial<TranscriptionSegmentUpdate>): void {
    this.callbacks!.onTranscription({
      segmentId: "SG_1",
      role: "user",
      text: "",
      final: false,
      ...update,
    });
  }

  state(state: TransportConnectionState, reason?: string): void {
    this.callbacks!.onConnectionState(state, reason);
  }

  /** The agent's ready signal, the primary presence signal. */
  ready(): void {
    this.callbacks!.onAgentReady();
  }

  /** An older runtime: no ready signal, only the framework's agent state. */
  join(): void {
    this.callbacks!.onAgentState("initializing");
  }

  audioReadyMarks = 0;

  markAudioReady(): void {
    this.audioReadyMarks += 1;
  }

  room: unknown = { name: "mock-room" };

  getRoom(): unknown {
    return this.connected ? this.room : undefined;
  }
}

async function start(
  extra: Partial<AgentSessionOptions> = {},
  { agentJoins = true }: { agentJoins?: boolean } = {},
) {
  const transport = new MockTransport();
  const session = await startAgentSession({ sessionToken: SESSION_TOKEN, ...extra }, () => transport);
  if (agentJoins) {
    transport.join();
  }
  return { session, transport };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("start", () => {
  it("connects and reports the session id", async () => {
    const onConnect = vi.fn();
    const { session } = await start({ callbacks: { onConnect } });
    expect(session.status).toBe("connected");
    expect(session.sessionId).toBe("sess-1");
    expect(onConnect).toHaveBeenCalledWith({ sessionId: "sess-1" });
  });

  it("rejects a session token with an unknown transport and asks for an upgrade", async () => {
    const sessionToken = { ...SESSION_TOKEN, transport: "carrier-pigeon" } as unknown as SessionToken;
    await expect(start({ sessionToken })).rejects.toMatchObject({
      code: "unsupported_transport",
      message: expect.stringContaining("please upgrade"),
    });
  });

  it("rejects a session token whose join deadline has passed", async () => {
    const sessionToken = { ...SESSION_TOKEN, expires_at: "2020-01-01T00:00:00Z" };
    await expect(start({ sessionToken })).rejects.toMatchObject({ code: "session_expired" });
  });

  it("disconnects a partially connected session and preserves microphone permission errors", async () => {
    const transport = new MockTransport();
    const error = new Error("denied");
    error.name = "NotAllowedError";
    transport.connectError = error;
    let releaseDisconnect!: () => void;
    transport.disconnectGate = new Promise<void>((resolve) => {
      releaseDisconnect = resolve;
    });

    const outcome = startAgentSession({ sessionToken: SESSION_TOKEN }, () => transport).then(
      () => ({ status: "resolved" as const }),
      (startError: unknown) => ({ status: "rejected" as const, error: startError }),
    );
    await vi.waitFor(() => expect(transport.disconnectCalls).toBe(1));

    expect(transport.connected).toBe(true);
    expect(transport.disconnected).toBe(false);
    let settled = false;
    void outcome.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseDisconnect();
    await expect(outcome).resolves.toMatchObject({
      status: "rejected",
      error: { code: "mic_permission_denied" },
    });
    expect(transport.connected).toBe(false);
    expect(transport.disconnected).toBe(true);
  });

  it("does not let cleanup failures mask microphone permission errors", async () => {
    const transport = new MockTransport();
    const error = new Error("denied");
    error.name = "NotAllowedError";
    transport.connectError = error;
    transport.disconnectError = new Error("disconnect failed");
    await expect(
      startAgentSession({ sessionToken: SESSION_TOKEN }, () => transport),
    ).rejects.toMatchObject({ code: "mic_permission_denied" });
    expect(transport.disconnectCalls).toBe(1);
  });

  it("requires exactly one auth mode", async () => {
    await expect(
      startAgentSession({ sessionToken: SESSION_TOKEN, agentId: "a1" }, () => new MockTransport()),
    ).rejects.toThrow(TypeError);
    await expect(startAgentSession({}, () => new MockTransport())).rejects.toThrow(TypeError);
  });

  it("begins microphone capture at start and releases it when the token exchange fails", async () => {
    const transport = new MockTransport();
    await expect(startAgentSession({}, () => transport)).rejects.toThrow(TypeError);
    expect(transport.micPrepares).toHaveLength(1);
    expect(transport.disconnectCalls).toBe(1);
  });

  it("forwards the configured input device to the gesture-time capture", async () => {
    const { transport } = await start({ audio: { inputDeviceId: "mic-7" } });
    expect(transport.micPrepares).toEqual([{ inputDeviceId: "mic-7" }]);
  });

  it("leaves the microphone untouched for microphone: false starts", async () => {
    const { transport } = await start({ microphone: false });
    expect(transport.micPrepares).toEqual([]);
  });

  it("subscribes callbacks sugar early enough to observe connect", async () => {
    const connects: unknown[] = [];
    const transcripts: Array<{ text: string }> = [];
    const transport = new MockTransport();
    await startAgentSession(
      {
        sessionToken: SESSION_TOKEN,
        callbacks: {
          onConnect: (event) => connects.push(event),
          onUserTranscript: (event) => transcripts.push(event),
        },
      },
      () => transport,
    );
    expect(connects).toEqual([{ sessionId: "sess-1" }]);
    transport.transcription({ text: "hi", final: true });
    expect(transcripts).toMatchObject([{ text: "hi" }]);
  });

  it("rejects unknown callback keys before creating a transport", async () => {
    const createTransport = vi.fn(() => new MockTransport());
    await expect(
      startAgentSession(
        {
          sessionToken: SESSION_TOKEN,
          // Bare event names are the most common slip; they must not be a silent no-op.
          callbacks: { userTranscript: () => {} } as never,
        },
        createTransport,
      ),
    ).rejects.toThrow(/Unknown callback "userTranscript".*onUserTranscript/);
    await expect(
      startAgentSession(
        { sessionToken: SESSION_TOKEN, callbacks: { onTranscript: () => {} } as never },
        createTransport,
      ),
    ).rejects.toThrow(TypeError);
    await expect(
      startAgentSession(
        { sessionToken: SESSION_TOKEN, callbacks: { onConnect: "nope" } as never },
        createTransport,
      ),
    ).rejects.toThrow(/must be a function/);
    expect(createTransport).not.toHaveBeenCalled();
  });

  it("ignores callbacks set to undefined", async () => {
    const { session } = await start({ callbacks: { onConnect: undefined } });
    expect(session.status).toBe("connected");
  });
});

describe("getRoom", () => {
  it("hands out the transport's room while connected and undefined after end", async () => {
    const { session, transport } = await start();
    expect(session.getRoom()).toBe(transport.room);
    await session.end();
    expect(session.getRoom()).toBeUndefined();
  });

  it("returns undefined for a transport without a room", async () => {
    const transport = new MockTransport();
    (transport as { getRoom?: () => unknown }).getRoom = undefined;
    const session = await startAgentSession({ sessionToken: SESSION_TOKEN }, () => transport);
    expect(session.getRoom()).toBeUndefined();
    await session.end();
  });
});

describe("audio devices", () => {
  it("forwards input device switches to the transport", async () => {
    const { session, transport } = await start();
    await session.setInputDevice("mic-2");
    expect(transport.inputDevice).toBe("mic-2");
  });

  it("maps transport device failures to device_change_failed with the cause kept", async () => {
    const { session, transport } = await start();
    const cause = new Error("no such device");
    transport.inputDeviceError = cause;
    await expect(session.setInputDevice("mic-missing")).rejects.toMatchObject({
      name: "FishAgentError",
      code: "device_change_failed",
      cause,
    });
  });

  it("passes coded transport errors through unchanged", async () => {
    const { session, transport } = await start();
    const coded = new FishAgentError("device_change_failed", "Could not activate the requested microphone");
    transport.inputDeviceError = coded;
    await expect(session.setInputDevice("mic-missing")).rejects.toBe(coded);
  });

  it("rejects output selection where the platform has no setSinkId", async () => {
    // Node has no HTMLMediaElement, mirroring browsers without output selection.
    const { session } = await start();
    await expect(session.setOutputDevice("speaker-2")).rejects.toMatchObject({
      code: "device_change_failed",
    });
  });

  it("fails start() before connecting when audio.outputDeviceId cannot be honored", async () => {
    const transport = new MockTransport();
    await expect(
      startAgentSession(
        { sessionToken: SESSION_TOKEN, audio: { outputDeviceId: "speaker-2" } },
        () => transport,
      ),
    ).rejects.toMatchObject({ code: "device_change_failed" });
    expect(transport.connected).toBe(false);
  });

  it("maps device failures surfacing at unmute to device_change_failed", async () => {
    // A device preference recorded while muted defers its getUserMedia failure
    // to the unmute that actually captures.
    const { session, transport } = await start();
    const error = new Error("constraints cannot be satisfied");
    error.name = "OverconstrainedError";
    transport.micError = error;
    await expect(session.setMicMuted(false)).rejects.toMatchObject({
      code: "device_change_failed",
      cause: error,
    });
  });
});

describe("wake lock", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubWakeLock() {
    const sentinels: Array<{ released: boolean }> = [];
    const request = vi.fn(async (_type: string) => {
      const sentinel = {
        released: false,
        release: async () => {
          sentinel.released = true;
        },
      };
      sentinels.push(sentinel);
      return sentinel;
    });
    const listeners = new Set<() => void>();
    const fakeDocument = {
      visibilityState: "visible",
      addEventListener: (type: string, handler: () => void) => {
        if (type === "visibilitychange") {
          listeners.add(handler);
        }
      },
      removeEventListener: (type: string, handler: () => void) => {
        if (type === "visibilitychange") {
          listeners.delete(handler);
        }
      },
    };
    vi.stubGlobal("document", fakeDocument);
    vi.stubGlobal("navigator", { wakeLock: { request } });
    return {
      request,
      sentinels,
      listeners,
      setVisibility(state: "visible" | "hidden") {
        fakeDocument.visibilityState = state;
        for (const handler of [...listeners]) {
          handler();
        }
      },
    };
  }

  it("holds a screen wake lock for the session and releases it on end", async () => {
    const wakeLock = stubWakeLock();
    const { session } = await start();
    await tick();
    expect(wakeLock.request).toHaveBeenCalledWith("screen");
    await session.end();
    await tick();
    expect(wakeLock.sentinels[0]?.released).toBe(true);
    expect(wakeLock.listeners.size).toBe(0);
  });

  it("re-acquires when the page becomes visible again", async () => {
    const wakeLock = stubWakeLock();
    const { session } = await start();
    await tick();
    wakeLock.setVisibility("hidden");
    wakeLock.setVisibility("visible");
    await tick();
    expect(wakeLock.request).toHaveBeenCalledTimes(2);
    await session.end();
  });

  it("wakeLock: false leaves screen policy to the page", async () => {
    const wakeLock = stubWakeLock();
    const { session } = await start({ wakeLock: false });
    await tick();
    expect(wakeLock.request).not.toHaveBeenCalled();
    expect(wakeLock.listeners.size).toBe(0);
    await session.end();
  });

  it("carries on without the lock when the platform denies it", async () => {
    const wakeLock = stubWakeLock();
    wakeLock.request.mockRejectedValueOnce(new Error("denied"));
    const { session } = await start();
    await tick();
    expect(session.status).toBe("connected");
    await session.end();
  });
});

describe("reverse channel", () => {
  it("sends text, activity and interrupt frames", async () => {
    const { session, transport } = await start();
    session.sendUserMessage("hello");
    session.sendUserActivity();
    session.interrupt();
    await tick();
    expect(transport.sent).toEqual([
      { type: "user.message", text: "hello", audio: false },
      { type: "user.activity" },
      { type: "user.interrupt" },
    ]);
  });

  it("defaults typed turns to audio: false and omits the field for audio: true", async () => {
    const { session, transport } = await start();
    session.sendUserMessage("quiet please");
    session.sendUserMessage("also quiet", { audio: false });
    session.sendUserMessage("speak up", { audio: true });
    await tick();
    expect(transport.sent).toEqual([
      { type: "user.message", text: "quiet please", audio: false },
      { type: "user.message", text: "also quiet", audio: false },
      { type: "user.message", text: "speak up" },
    ]);
  });
});

describe("agent presence", () => {
  it("holds typed messages until the agent joins, then flushes in order", async () => {
    const { session, transport } = await start({}, { agentJoins: false });
    session.sendUserMessage("first");
    session.sendUserMessage("second");
    await tick();
    expect(transport.sent).toEqual([]);
    transport.join();
    await tick();
    expect(transport.sent).toEqual([
      { type: "user.message", text: "first", audio: false },
      { type: "user.message", text: "second", audio: false },
    ]);
  });

  it("still pins held messages locally", async () => {
    const { session } = await start({}, { agentJoins: false });
    const messages: unknown[] = [];
    session.on("message", (message) => messages.push(message));
    session.sendUserMessage("hello?");
    expect(messages).toEqual([{ role: "user", text: "hello?" }]);
  });

  it("fails the session when the agent never joins", async () => {
    vi.useFakeTimers();
    try {
      const errors: FishAgentError[] = [];
      const disconnects: unknown[] = [];
      const { session, transport } = await start({}, { agentJoins: false });
      session.on("error", (error) => errors.push(error));
      session.on("disconnect", (event) => disconnects.push(event));
      await vi.advanceTimersByTimeAsync(15_000);
      expect(errors).toMatchObject([{ code: "connection_failed" }]);
      expect(disconnects).toEqual([{ reason: "connection_lost" }]);
      expect(session.status).toBe("ended");
      expect(transport.disconnectCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not fire the join watchdog once the agent is there", async () => {
    vi.useFakeTimers();
    try {
      const errors: unknown[] = [];
      const { session } = await start();
      session.on("error", (error) => errors.push(error));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(errors).toEqual([]);
      expect(session.status).toBe("connected");
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases queued messages on the agent's ready signal", async () => {
    const { session, transport } = await start({}, { agentJoins: false });
    session.sendUserMessage("first");
    await tick();
    expect(transport.sent).toEqual([]);
    transport.ready();
    await tick();
    expect(transport.sent).toEqual([{ type: "user.message", text: "first", audio: false }]);
    // The fallback signal arriving afterwards must not resend anything.
    transport.join();
    await tick();
    expect(transport.sent).toHaveLength(1);
  });

  it("disarms the join watchdog on the agent's ready signal alone", async () => {
    vi.useFakeTimers();
    try {
      const errors: unknown[] = [];
      const { session, transport } = await start({}, { agentJoins: false });
      session.on("error", (error) => errors.push(error));
      transport.ready();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(errors).toEqual([]);
      expect(session.status).toBe("connected");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("audio-ready handshake", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  class FakeMediaElement {
    autoplay = false;
    volume = 1;
    srcObject: unknown = null;
    /** Rejects the next `count` play() calls, like an autoplay block. */
    blockPlays = 0;

    setAttribute(): void {}
    remove(): void {}

    async play(): Promise<void> {
      if (this.blockPlays > 0) {
        this.blockPlays -= 1;
        const error = new Error("play() failed because the user didn't interact");
        error.name = "NotAllowedError";
        throw error;
      }
    }

    async setSinkId(): Promise<void> {}
  }

  function stubPlayback(): FakeMediaElement[] {
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

  it("reports playback readiness once the agent's audio plays", async () => {
    stubPlayback();
    const { transport } = await start({ wakeLock: false });
    expect(transport.audioReadyMarks).toBe(0);
    // Background ambience playing says nothing about the speech track.
    transport.callbacks!.onOutputStream("TR_ambience", {} as MediaStream, false);
    await tick();
    expect(transport.audioReadyMarks).toBe(0);
    transport.callbacks!.onOutputStream("TR_voice", {} as MediaStream, true);
    await tick();
    expect(transport.audioReadyMarks).toBe(1);
  });

  it("holds the report while autoplay blocks and sends it from startAudio()", async () => {
    const elements = stubPlayback();
    const { session, transport } = await start({ wakeLock: false, audio: { outputDeviceId: "spk" } });
    elements[0]!.blockPlays = 1;
    transport.callbacks!.onOutputStream("TR_voice", {} as MediaStream, true);
    await tick();
    expect(transport.audioReadyMarks).toBe(0);
    await session.startAudio();
    expect(transport.audioReadyMarks).toBe(1);
  });

  it("does not report readiness before the agent's audio is attached", async () => {
    stubPlayback();
    const { session, transport } = await start({ wakeLock: false, audio: { outputDeviceId: "spk" } });
    // The element exists (created to validate the device), nothing plays yet.
    await session.startAudio();
    expect(transport.audioReadyMarks).toBe(0);
  });
});

describe("user transcripts", () => {
  it("relays interim updates and finalizes the segment into a message", async () => {
    const { session, transport } = await start();
    const events: unknown[] = [];
    const messages: unknown[] = [];
    session.on("userTranscript", (event) => events.push(event));
    session.on("message", (message) => messages.push(message));

    transport.transcription({ text: "hel" });
    transport.transcription({ text: "hello" });
    transport.transcription({ text: "hello there, world", final: true });

    expect(events).toEqual([
      { segmentId: "SG_1", text: "hel", final: false },
      { segmentId: "SG_1", text: "hello", final: false },
      { segmentId: "SG_1", text: "hello there, world", final: true },
    ]);
    expect(messages).toEqual([{ role: "user", text: "hello there, world" }]);
  });

  it("finalizes a typed message locally on send (no server echo)", async () => {
    const { session, transport } = await start();
    const events: unknown[] = [];
    const messages: unknown[] = [];
    session.on("userTranscript", (event) => events.push(event));
    session.on("message", (message) => messages.push(message));

    session.sendUserMessage("  Hi there!  ");
    session.sendUserMessage("   "); // whitespace-only: not sent, not recorded
    await tick();

    expect(transport.sent).toEqual([{ type: "user.message", text: "Hi there!", audio: false }]);
    expect(events).toEqual([{ segmentId: "typed_1", text: "Hi there!", final: true }]);
    expect(messages).toEqual([{ role: "user", text: "Hi there!" }]);
  });
});

describe("transcript backfill", () => {
  it("snapshots every segment in order, updating segments in place", async () => {
    const { session, transport } = await start();
    session.sendUserMessage("hi");
    transport.transcription({ segmentId: "SG_1", text: "hel" });
    transport.transcription({ segmentId: "SG_1", text: "hello", final: true });
    transport.transcription({ segmentId: "SG_a", role: "agent", text: "Wel" });
    expect(session.getTranscript()).toEqual([
      { segmentId: "typed_1", role: "user", text: "hi", final: true },
      { segmentId: "SG_1", role: "user", text: "hello", final: true },
      { segmentId: "SG_a", role: "agent", text: "Wel", final: false },
    ]);

    transport.transcription({ segmentId: "SG_a", role: "agent", text: "Welcome!", final: true });
    expect(session.getTranscript()).toEqual([
      { segmentId: "typed_1", role: "user", text: "hi", final: true },
      { segmentId: "SG_1", role: "user", text: "hello", final: true },
      { segmentId: "SG_a", role: "agent", text: "Welcome!", final: true },
    ]);
  });

  it("returns an independent snapshot", async () => {
    const { session } = await start();
    session.sendUserMessage("hi");
    const snapshot = session.getTranscript();
    snapshot[0]!.text = "mutated";
    snapshot.pop();
    expect(session.getTranscript()).toEqual([
      { segmentId: "typed_1", role: "user", text: "hi", final: true },
    ]);
  });
});

describe("agent responses and mode", () => {
  it("streams agent segments as deltas and finalizes into a response + message", async () => {
    const { session, transport } = await start();
    const deltas: unknown[] = [];
    const responses: unknown[] = [];
    const messages: unknown[] = [];
    const modes: unknown[] = [];
    session.on("agentResponseDelta", (event) => deltas.push(event));
    session.on("agentResponse", (event) => responses.push(event));
    session.on("message", (message) => messages.push(message));
    session.on("modeChange", (mode) => modes.push(mode));

    transport.agentState("thinking");
    transport.transcription({ segmentId: "SG_a", role: "agent", text: "Wel" });
    transport.transcription({ segmentId: "SG_a", role: "agent", text: "Welcome!" });
    // Segment close = playout finished: mode returns to the listening default.
    transport.transcription({ segmentId: "SG_a", role: "agent", text: "Welcome!", final: true });

    expect(deltas).toEqual([
      { segmentId: "SG_a", delta: "Wel", text: "Wel" },
      { segmentId: "SG_a", delta: "come!", text: "Welcome!" },
    ]);
    expect(responses).toEqual([{ segmentId: "SG_a", text: "Welcome!" }]);
    expect(messages).toEqual([{ role: "agent", text: "Welcome!" }]);
    expect(modes).toEqual(["thinking", "speaking", "listening"]);
    expect(session.mode).toBe("listening");
  });

  it("finalizes an interrupted segment with only the spoken text", async () => {
    const { session, transport } = await start();
    const responses: unknown[] = [];
    const deltas: unknown[] = [];
    session.on("agentResponse", (event) => responses.push(event));
    session.on("agentResponseDelta", (event) => deltas.push(event));

    transport.transcription({ segmentId: "SG_b", role: "agent", text: "Let me expl" });
    transport.transcription({ segmentId: "SG_b", role: "agent", text: "Let me expl", final: true });

    expect(deltas).toEqual([{ segmentId: "SG_b", delta: "Let me expl", text: "Let me expl" }]);
    expect(responses).toEqual([{ segmentId: "SG_b", text: "Let me expl" }]);
  });

  it("surfaces server errors as coded FishAgentError without internal detail", async () => {
    const { session, transport } = await start();
    const errors: FishAgentError[] = [];
    session.on("error", (error) => errors.push(error));
    transport.agent({ type: "error", code: "provider_error" });
    transport.agent({ type: "error", code: "internal_error" });
    expect(errors[0]).toMatchObject({ code: "provider_error" });
    expect(errors[1]).toMatchObject({ code: "internal_error" });
  });

  it("attaches stage and recovered from the error frame", async () => {
    const { session, transport } = await start();
    const errors: FishAgentError[] = [];
    session.on("error", (error) => errors.push(error));
    transport.agent({ type: "error", code: "provider_error", stage: "llm", recovered: true });
    transport.agent({ type: "error", code: "internal_error", stage: "runtime", recovered: false });
    expect(errors[0]).toMatchObject({ code: "provider_error", stage: "llm", recovered: true });
    expect(errors[0]?.message).toContain("retrying");
    expect(errors[1]).toMatchObject({ code: "internal_error", stage: "runtime", recovered: false });
    expect(errors[1]?.message).not.toContain("retrying");
  });

  it("leaves stage and recovered undefined when the frame omits them or carries an unknown stage", async () => {
    const { session, transport } = await start();
    const errors: FishAgentError[] = [];
    session.on("error", (error) => errors.push(error));
    transport.agent({ type: "error", code: "provider_error" });
    transport.agent({ type: "error", code: "provider_error", stage: "vad", recovered: "yes" } as never);
    expect(errors[0]?.stage).toBeUndefined();
    expect(errors[0]?.recovered).toBeUndefined();
    expect(errors[1]?.stage).toBeUndefined();
    expect(errors[1]?.recovered).toBeUndefined();
    expect(errors[1]?.code).toBe("provider_error");
  });

  it("keeps agent state values other than thinking off the mode surface", async () => {
    const { session, transport } = await start();
    transport.agentState("listening"); // agent-idle, not user-speaking
    expect(session.mode).toBe("listening"); // initial value, unchanged semantics
    transport.agentState("thinking");
    expect(session.mode).toBe("thinking");
    transport.agentState("speaking"); // audible speaking derives from the analyser instead
    expect(session.mode).toBe("thinking");
  });

  it("ignores unknown message types (forward compat)", async () => {
    const { transport } = await start();
    expect(() =>
      transport.agent({ type: "session.upgraded", shiny: true } as never),
    ).not.toThrow();
  });
});

describe("tool call lifecycle", () => {
  it("relays started/completed with payloads and normalized truncation flags", async () => {
    const { session, transport } = await start();
    const started: unknown[] = [];
    const completed: unknown[] = [];
    session.on("toolCallStarted", (event) => started.push(event));
    session.on("toolCallCompleted", (event) => completed.push(event));
    transport.agent({
      type: "tool.started",
      callId: "tc_1",
      toolName: "lookup_order",
      toolSource: "webhook",
      nodeId: "main",
      input: '{"orderId":"42"}',
    });
    transport.agent({
      type: "tool.completed",
      callId: "tc_1",
      toolName: "lookup_order",
      toolSource: "webhook",
      nodeId: "main",
      output: '{"status":"shipped"}',
      outputTruncated: true,
    });
    expect(started).toEqual([
      {
        callId: "tc_1",
        toolName: "lookup_order",
        source: "webhook",
        input: '{"orderId":"42"}',
        inputTruncated: false,
      },
    ]);
    expect(completed).toEqual([
      {
        callId: "tc_1",
        toolName: "lookup_order",
        source: "webhook",
        output: '{"status":"shipped"}',
        outputTruncated: true,
      },
    ]);
  });

  it("relays failures and supports the callbacks sugar", async () => {
    const onToolCallFailed = vi.fn();
    const { transport } = await start({ callbacks: { onToolCallFailed } });
    transport.agent({
      type: "tool.failed",
      callId: "tc_2",
      toolName: "lookup_order",
      toolSource: "mcp",
      nodeId: "main",
      error: "upstream timed out",
    });
    expect(onToolCallFailed).toHaveBeenCalledWith({
      callId: "tc_2",
      toolName: "lookup_order",
      source: "mcp",
      error: "upstream timed out",
    });
  });

  it("forwards httpStatus on webhook failures and leaves it off otherwise", async () => {
    const { session, transport } = await start();
    const failed: unknown[] = [];
    session.on("toolCallFailed", (event) => failed.push(event));
    transport.agent({
      type: "tool.failed",
      callId: "tc_3",
      toolName: "lookup_order",
      toolSource: "webhook",
      nodeId: "main",
      error: "endpoint returned 502",
      httpStatus: 502,
    });
    transport.agent({
      type: "tool.failed",
      callId: "tc_4",
      toolName: "lookup_order",
      toolSource: "webhook",
      nodeId: "main",
      error: "request timed out",
    });
    expect(failed[0]).toEqual({
      callId: "tc_3",
      toolName: "lookup_order",
      source: "webhook",
      error: "endpoint returned 502",
      httpStatus: 502,
    });
    expect(failed[1]).toEqual({
      callId: "tc_4",
      toolName: "lookup_order",
      source: "webhook",
      error: "request timed out",
    });
    expect(failed[1]).not.toHaveProperty("httpStatus");
  });
});

describe("client tools", () => {
  const call = (over: Partial<Extract<AgentSessionMessage, { type: "client_tool.call" }>> = {}) =>
    ({
      type: "client_tool.call",
      callId: "call-1",
      toolName: "lookup",
      params: { id: 7 },
      expectsResponse: true,
      ...over,
    }) as const;

  it("runs the registered handler and returns its result", async () => {
    const { transport } = await start({
      clientTools: { lookup: (params) => ({ found: params.id }) },
    });
    transport.agent(call());
    await tick();
    expect(transport.sent).toEqual([
      { type: "client_tool.result", callId: "call-1", result: { found: 7 } },
    ]);
  });

  it("answers unregistered tools with isError and emits an error", async () => {
    const { session, transport } = await start();
    const errors: FishAgentError[] = [];
    session.on("error", (error) => errors.push(error));
    transport.agent(call({ toolName: "missing" }));
    await tick();
    expect(transport.sent[0]).toMatchObject({
      type: "client_tool.result",
      callId: "call-1",
      isError: true,
    });
    expect(errors[0]).toMatchObject({ code: "tool_failed" });
  });

  it("maps handler throws to isError results", async () => {
    const { transport } = await start({
      clientTools: {
        lookup: () => {
          throw new Error("nope");
        },
      },
    });
    transport.agent(call());
    await tick();
    expect(transport.sent[0]).toMatchObject({ isError: true });
  });

  it("does not reply when expectsResponse is false", async () => {
    const handler = vi.fn();
    const { transport } = await start({ clientTools: { lookup: handler } });
    transport.agent(call({ expectsResponse: false }));
    await tick();
    expect(handler).toHaveBeenCalled();
    expect(transport.sent).toEqual([]);
  });

  it("times out hung handlers", async () => {
    const { session, transport } = await start({
      clientTools: { lookup: () => new Promise(() => {}) },
      clientToolTimeoutMs: 10,
    });
    const errors: FishAgentError[] = [];
    session.on("error", (error) => errors.push(error));
    transport.agent(call());
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(errors[0]).toMatchObject({ code: "tool_timeout" });
    expect(transport.sent[0]).toMatchObject({ isError: true });
  });

  it("supports late registration via registerClientTool", async () => {
    const { session, transport } = await start();
    session.registerClientTool("lookup", () => "ok");
    transport.agent(call());
    await tick();
    expect(transport.sent[0]).toMatchObject({ result: "ok" });
  });

  it("answers concurrent calls independently when they finish out of order", async () => {
    const settle = new Map<string, (value: unknown) => void>();
    const { transport } = await start({
      clientTools: {
        lookup: (_params, { callId }) => new Promise((resolve) => settle.set(callId, resolve)),
      },
    });
    transport.agent(call({ callId: "call-a", params: { id: 1 } }));
    transport.agent(call({ callId: "call-b", params: { id: 2 } }));
    await tick();
    expect(transport.sent).toEqual([]);

    settle.get("call-b")!({ found: 2 });
    settle.get("call-a")!({ found: 1 });
    await tick();
    expect(transport.sent).toEqual([
      { type: "client_tool.result", callId: "call-b", result: { found: 2 } },
      { type: "client_tool.result", callId: "call-a", result: { found: 1 } },
    ]);
  });

  it("reports fire-and-forget handler throws as errors without replying", async () => {
    const { session, transport } = await start({
      clientTools: {
        lookup: () => {
          throw new Error("nope");
        },
      },
    });
    const errors: FishAgentError[] = [];
    session.on("error", (error) => errors.push(error));
    transport.agent(call({ expectsResponse: false }));
    await tick();
    expect(errors[0]).toMatchObject({ code: "tool_failed" });
    expect(transport.sent).toEqual([]);
  });

  it("replies without a result field when the handler returns undefined", async () => {
    const { transport } = await start({
      clientTools: { lookup: () => undefined },
    });
    transport.agent(call());
    await tick();
    expect(transport.sent).toEqual([{ type: "client_tool.result", callId: "call-1" }]);
  });

  it("replaces an oversized result with an error result", async () => {
    const { session, transport } = await start({
      clientTools: { lookup: () => ({ blob: "x".repeat(MAX_CLIENT_TOOL_RESULT_BYTES) }) },
    });
    const errors: FishAgentError[] = [];
    session.on("error", (error) => errors.push(error));
    transport.agent(call());
    await tick();
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]).toMatchObject({
      type: "client_tool.result",
      callId: "call-1",
      isError: true,
      result: expect.stringContaining("too large"),
    });
    expect(errors[0]).toMatchObject({ code: "tool_failed" });
  });

  it("replaces a non-serializable result with an error result", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const { transport } = await start({ clientTools: { lookup: () => circular } });
    transport.agent(call());
    await tick();
    expect(transport.sent[0]).toMatchObject({
      isError: true,
      result: expect.stringContaining("not JSON-serializable"),
    });
  });

  it("falls back to an error result when the result cannot be sent", async () => {
    const { session, transport } = await start({
      clientTools: { lookup: () => ({ ok: true }) },
    });
    const errors: FishAgentError[] = [];
    session.on("error", (error) => errors.push(error));
    transport.sendError = { error: new Error("packet too large"), count: 1 };
    transport.agent(call());
    await tick();
    expect(transport.sent).toEqual([
      {
        type: "client_tool.result",
        callId: "call-1",
        isError: true,
        result: expect.stringContaining("could not be delivered"),
      },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: "tool_failed" });
  });

  it("reports, without looping, when even the error result cannot be sent", async () => {
    const { session, transport } = await start({
      clientTools: { lookup: () => ({ ok: true }) },
    });
    const errors: FishAgentError[] = [];
    session.on("error", (error) => errors.push(error));
    transport.sendError = { error: new Error("disconnected"), count: 5 };
    transport.agent(call());
    await tick();
    expect(transport.sent).toEqual([]);
    expect(transport.sendError.count).toBe(3);
    expect(errors.map((error) => error.code)).toEqual(["tool_failed", "tool_failed"]);
  });
});

describe("lifecycle", () => {
  it("ends gracefully: hangup frame, disconnect, ended status", async () => {
    const { session, transport } = await start();
    const disconnects: unknown[] = [];
    session.on("disconnect", (event) => disconnects.push(event));

    await session.end();

    expect(transport.sent).toEqual([{ type: "user.hangup" }]);
    expect(transport.disconnected).toBe(true);
    expect(session.status).toBe("ended");
    expect(session.endReason).toBe("user_hangup");
    expect(disconnects).toEqual([{ reason: "user_hangup" }]);
    await session.end(); // idempotent
    expect(disconnects).toHaveLength(1);
  });

  it("coalesces concurrent end calls into one hangup and disconnect", async () => {
    const { session, transport } = await start();
    let releaseDisconnect!: () => void;
    transport.disconnectGate = new Promise<void>((resolve) => {
      releaseDisconnect = resolve;
    });

    const first = session.end();
    await tick();
    expect(transport.sent).toEqual([{ type: "user.hangup" }]);
    expect(transport.disconnectCalls).toBe(1);

    // A transport can report disconnected before its disconnect promise
    // settles. Even though status is already ended, callers must still join
    // the in-flight teardown.
    transport.state("disconnected");
    expect(session.status).toBe("ended");
    const second = session.end();
    expect(second).toBe(first);
    let secondSettled = false;
    void second.then(() => {
      secondSettled = true;
    });
    await Promise.resolve();
    expect(secondSettled).toBe(false);

    releaseDisconnect();
    await Promise.all([first, second]);
    expect(session.status).toBe("ended");
  });

  it("allows teardown to be retried after a disconnect failure", async () => {
    const { session, transport } = await start();
    const error = new Error("disconnect failed");
    transport.disconnectError = error;

    await expect(session.end()).rejects.toBe(error);
    expect(session.status).toBe("connected");

    transport.disconnectError = undefined;
    await session.end();
    expect(transport.disconnectCalls).toBe(2);
    expect(session.status).toBe("ended");
  });

  it("maps room closure and agent departure to agent_hangup, drops to connection_lost", async () => {
    const closed = await start();
    closed.transport.state("disconnected", "ROOM_DELETED");
    expect(closed.session.endReason).toBe("agent_hangup");

    const agentLeft = await start();
    agentLeft.transport.state("disconnected", "AGENT_LEFT");
    expect(agentLeft.session.endReason).toBe("agent_hangup");

    const dropped = await start();
    dropped.transport.state("disconnected");
    expect(dropped.session.endReason).toBe("connection_lost");
  });

  it("prefers the announced session.ended reason over disconnect inference", async () => {
    const { session, transport } = await start();
    transport.agent({ type: "session.ended", reason: "conversation_timeout" });
    // The announcement alone doesn't end the session — teardown follows.
    expect(session.status).toBe("connected");
    transport.state("disconnected", "ROOM_DELETED");
    expect(session.endReason).toBe("conversation_timeout");
  });

  it("uses the announced reason even when the disconnect looks like a drop", async () => {
    const { session, transport } = await start();
    transport.agent({ type: "session.ended", reason: "agent_hangup" });
    transport.state("disconnected", "SIGNAL_CLOSE");
    expect(session.endReason).toBe("agent_hangup");
  });

  it("ends with llm_endpoint_failure when the runtime announces its LLM endpoint gave up", async () => {
    const { session, transport } = await start();
    const disconnects: unknown[] = [];
    session.on("disconnect", (event) => disconnects.push(event));
    transport.agent({ type: "session.ended", reason: "llm_endpoint_failure" });
    expect(session.status).toBe("connected");
    transport.state("disconnected", "ROOM_DELETED");
    expect(session.status).toBe("ended");
    expect(session.endReason).toBe("llm_endpoint_failure");
    expect(disconnects).toEqual([{ reason: "llm_endpoint_failure" }]);
  });

  it("ignores a session.ended carrying an unrecognized reason (forward compat)", async () => {
    const { session, transport } = await start();
    transport.agent({ type: "session.ended", reason: "sun_exploded" } as never);
    transport.state("disconnected", "ROOM_DELETED");
    expect(session.endReason).toBe("agent_hangup");
  });

  it("keeps user_hangup when the client ended locally despite an announcement", async () => {
    const { session, transport } = await start();
    transport.agent({ type: "session.ended", reason: "agent_hangup" });
    await session.end();
    expect(session.endReason).toBe("user_hangup");
  });

  it("ends with the announced reason if the room teardown never lands", async () => {
    vi.useFakeTimers();
    try {
      const { session, transport } = await start();
      transport.agent({ type: "session.ended", reason: "conversation_timeout" });
      expect(session.status).toBe("connected");
      await vi.advanceTimersByTimeAsync(10_000);
      expect(session.status).toBe("ended");
      expect(session.endReason).toBe("conversation_timeout");
      expect(transport.disconnectCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("tracks reconnection in status", async () => {
    const { session, transport } = await start();
    transport.state("reconnecting");
    expect(session.status).toBe("reconnecting");
    transport.state("connected");
    expect(session.status).toBe("connected");
  });

  it("end() is idempotent: one hangup frame, terminal state sticks", async () => {
    const { session, transport } = await start();
    await session.end();
    await session.end();
    expect(transport.sent.filter((message) => message.type === "user.hangup")).toHaveLength(1);
    expect(session.status).toBe("ended");
    expect(session.endReason).toBe("user_hangup");
  });

  it("mute toggles the transport mic", async () => {
    const { session, transport } = await start();
    await session.setMicMuted(true);
    expect(session.micMuted).toBe(true);
    expect(transport.micEnabled).toBe(false);
  });
});

describe("microphone-less start", () => {
  it("joins muted without capturing and passes the flag to the transport", async () => {
    const { session, transport } = await start({ microphone: false });
    expect(transport.connectOptions?.microphone).toBe(false);
    expect(session.micMuted).toBe(true);
  });

  it("captures on the first unmute", async () => {
    const { session, transport } = await start({ microphone: false });
    await session.setMicMuted(false);
    expect(session.micMuted).toBe(false);
    expect(transport.micEnabled).toBe(true);
  });

  it("maps an unmute permission denial and stays muted", async () => {
    const { session, transport } = await start({ microphone: false });
    const denial = new Error("denied");
    denial.name = "NotAllowedError";
    transport.micError = denial;
    await expect(session.setMicMuted(false)).rejects.toMatchObject({
      code: "mic_permission_denied",
    });
    expect(session.micMuted).toBe(true);
  });

  it("defaults to capturing at connect", async () => {
    const { transport } = await start();
    expect(transport.connectOptions?.microphone).toBeUndefined();
  });
});
