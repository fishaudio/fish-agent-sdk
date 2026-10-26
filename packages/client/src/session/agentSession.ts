// Type-only: the transport implementation still loads lazily (see start()).
import type { Room } from "livekit-client";
import type {
  AgentErrorStage,
  AgentSessionMessage,
  ClientSessionMessage,
  SessionToken,
} from "@fishaudio/agent-protocol";
import { assertOutputSelectionSupported, AudioOutput } from "../audio/output.js";
import { AudioStreamAnalyser } from "../audio/analysis.js";
import { FishAgentError } from "../errors.js";
import {
  AGENT_SESSION_EVENT_NAMES,
  type AgentMode,
  type AgentSessionCallbacks,
  type AgentSessionEvents,
  type EndReason,
  type SessionStatus,
  type TranscriptSegment,
} from "../events.js";
import { resolveSessionToken, type SessionRequestOptions } from "../sessionToken.js";
import type {
  TranscriptionSegmentUpdate,
  Transport,
  TransportConnectionState,
  TransportFactory,
} from "../transport/types.js";
import { TypedEmitter } from "./emitter.js";
import {
  ClientToolDispatcher,
  DEFAULT_CLIENT_TOOL_TIMEOUT_MS,
  type ClientToolHandler,
} from "./toolDispatcher.js";
import { WakeLockHolder } from "./wakeLock.js";

export interface AgentSessionOptions extends SessionRequestOptions {
  clientTools?: Record<string, ClientToolHandler>;
  clientToolTimeoutMs?: number;
  /**
   * Capture the microphone on start. Default true. Set false to join without
   * requesting it (text-first UIs); the first `setMicMuted(false)` then
   * captures — the permission prompt happens there, so call it from a user
   * gesture.
   */
  microphone?: boolean;
  audio?: {
    inputDeviceId?: string;
    /** Playback device (`setSinkId`); start rejects with `device_change_failed`
     * where output selection is unsupported (before creating a server session)
     * or the device cannot be used (before connecting). */
    outputDeviceId?: string;
  };
  /**
   * Hold a screen wake lock while the session is live, so long calls survive
   * the phone trying to sleep. Default true; denial is silent. Set false to
   * leave screen policy to the page.
   */
  wakeLock?: boolean;
  callbacks?: Partial<AgentSessionCallbacks>;
}

/** How long after connect the agent participant gets to show up before the
 * session gives up — normal joins land within a couple of seconds. */
const AGENT_JOIN_TIMEOUT_MS = 15_000;

/** The runtime tears the room down right after announcing `session.ended`;
 * if that teardown signal never lands, end locally with the announced reason. */
const SESSION_ENDED_GRACE_MS = 10_000;

/** `session.ended` reasons this SDK understands; the reason set is additive,
 * so an announcement carrying an unrecognized value is ignored by contract
 * and the transport disconnect signals decide instead. */
const ANNOUNCED_END_REASONS: ReadonlySet<string> = new Set<EndReason>([
  "user_hangup",
  "agent_hangup",
  "conversation_timeout",
  "escalated",
  "llm_endpoint_failure",
]);

/** `error.stage` values this SDK understands. Anything else is dropped, like an unknown field. */
const ERROR_STAGES: ReadonlySet<string> = new Set<AgentErrorStage>(["llm", "stt", "tts", "runtime"]);

/** `error` frames carry a category only, the wording is the SDK's own. */
function describeRuntimeError(
  code: "provider_error" | "internal_error",
  recovered: boolean | undefined,
): string {
  const base =
    code === "provider_error"
      ? "An upstream provider failed during the session"
      : "The agent runtime hit an internal error";
  return recovered === true ? `${base}, the agent is retrying this turn` : base;
}

const EVENT_NAMES = new Set<string>(AGENT_SESSION_EVENT_NAMES);

/**
 * Maps the `callbacks` shorthand (`onUserTranscript`) to event names
 * (`userTranscript`). Unknown keys throw: silently subscribing to a
 * non-existent event would hide typos and the bare event names people
 * reach for first (`userTranscript` instead of `onUserTranscript`).
 */
function resolveCallbackSubscriptions(
  callbacks: Partial<AgentSessionCallbacks> | undefined,
): Array<[keyof AgentSessionEvents, unknown]> {
  const subscriptions: Array<[keyof AgentSessionEvents, unknown]> = [];
  for (const [key, callback] of Object.entries(callbacks ?? {})) {
    if (callback === undefined) {
      continue;
    }
    const event = /^on[A-Z]/.test(key) ? key.charAt(2).toLowerCase() + key.slice(3) : undefined;
    if (event === undefined || !EVENT_NAMES.has(event)) {
      const expected = AGENT_SESSION_EVENT_NAMES.map(
        (name) => `on${name.charAt(0).toUpperCase()}${name.slice(1)}`,
      ).join(", ");
      throw new TypeError(
        `Unknown callback "${key}". Callback keys are event names prefixed with "on": ${expected}.`,
      );
    }
    if (typeof callback !== "function") {
      throw new TypeError(`Callback "${key}" must be a function, got ${typeof callback}.`);
    }
    subscriptions.push([event as keyof AgentSessionEvents, callback]);
  }
  return subscriptions;
}

/** Assigned in AgentSession's static block; bridges startAgentSession to the
 * class-private #startWith so no transport types sit on the public class. */
let startWith: (
  options: AgentSessionOptions,
  createTransport: TransportFactory,
) => Promise<AgentSession>;

export class AgentSession extends TypedEmitter<AgentSessionEvents> {
  #status: SessionStatus = "connecting";
  #mode: AgentMode = "listening";
  #endReason?: EndReason;
  /** Reason announced by the runtime over `session.ended`, held until the
   * transport disconnect (or the grace timer) finalizes the session with it. */
  #announcedEndReason?: EndReason;
  #endedGraceTimer?: ReturnType<typeof setTimeout>;
  #sessionId: string;
  #micMuted = false;
  #endedByClient = false;
  #ending?: Promise<void>;

  #transport!: Transport;
  #tools!: ClientToolDispatcher;
  readonly #output = new AudioOutput({
    // A resolved play() on the agent's stream is the browser allowing playback:
    // tell the runtime it can speak the opening line now.
    onPlaybackStarted: () => this.#transport.markAudioReady?.(),
  });
  readonly #outputAnalyser = new AudioStreamAnalyser();
  readonly #inputAnalyser = new AudioStreamAnalyser();
  readonly #wakeLock = new WakeLockHolder();

  /** Text already delivered per agent segment, to derive deltas from full-text updates. */
  readonly #agentSegments = new Map<string, string>();
  /** Transcript so far, for late subscribers (getTranscript); upserted per segment. */
  readonly #transcript: TranscriptSegment[] = [];
  readonly #transcriptIndex = new Map<string, number>();
  #typedMessageCount = 0;

  // Data frames reach only participants already in the room — and the worker
  // registers its handlers while starting up — so typed messages wait here
  // until the agent announces itself: its ready signal, or for older runtimes
  // its first pipeline state.
  #agentPresent = false;
  #pendingMessages: ClientSessionMessage[] = [];
  #joinTimer?: ReturnType<typeof setTimeout>;

  private constructor(sessionToken: SessionToken) {
    super();
    this.#sessionId = sessionToken.session_id;
  }

  /**
   * Obtain a session token (if needed), connect, publish the microphone and
   * hand back a live session. Rejects with FishAgentError on session-request,
   * permission or connect failures.
   */
  static async start(options: AgentSessionOptions): Promise<AgentSession> {
    // Lazy so the transport implementation (and livekit-client) never loads
    // in SSR bundles or in tests that inject their own transport.
    const { LiveKitTransport } = await import("../transport/livekit.js");
    return AgentSession.#startWith(options, () => new LiveKitTransport());
  }

  // ---- getters ----

  get sessionId(): string {
    return this.#sessionId;
  }

  get status(): SessionStatus {
    return this.#status;
  }

  get mode(): AgentMode {
    return this.#mode;
  }

  get isSpeaking(): boolean {
    return this.#mode === "speaking";
  }

  get micMuted(): boolean {
    return this.#micMuted;
  }

  get endReason(): EndReason | undefined {
    return this.#endReason;
  }

  /**
   * Snapshot of every transcript segment so far, in conversation order. Seed a
   * consumer that subscribes after events already fired (e.g. a component
   * mounted right after start), then apply live events by segmentId.
   */
  getTranscript(): TranscriptSegment[] {
    return this.#transcript.map((segment) => ({ ...segment }));
  }

  // ---- text & control channel ----

  /** Typed turns get a text-only reply by default (no TTS); pass `audio: true` to have the agent speak this turn. */
  sendUserMessage(text: string, options?: { audio?: boolean }): void {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    const message: ClientSessionMessage =
      options?.audio === true
        ? { type: "user.message", text: trimmed }
        : { type: "user.message", text: trimmed, audio: false };
    if (this.#agentPresent) {
      this.#sendClientEvent(message);
    } else {
      this.#pendingMessages.push(message);
    }
    this.#recordTypedUserMessage(trimmed);
  }

  sendUserActivity(): void {
    this.#sendClientEvent({ type: "user.activity" });
  }

  interrupt(): void {
    this.#sendClientEvent({ type: "user.interrupt" });
  }

  registerClientTool(name: string, handler: ClientToolHandler): void {
    this.#tools.register(name, handler);
  }

  // ---- audio ----

  /**
   * After a `microphone: false` start, the first unmute captures and publishes
   * the microphone — the permission prompt happens here. A denial rejects with
   * `mic_permission_denied` and the session stays muted.
   */
  async setMicMuted(muted: boolean): Promise<void> {
    const previous = this.#micMuted;
    this.#micMuted = muted;
    try {
      await this.#transport.setMicEnabled(!muted);
    } catch (error) {
      this.#micMuted = previous;
      throw AgentSession.#asMicError(error);
    }
  }

  /** Call from a user gesture to satisfy browser autoplay policies. */
  async startAudio(): Promise<void> {
    this.#outputAnalyser.resume();
    this.#inputAnalyser.resume();
    await this.#output.startAudio();
  }

  /**
   * Switch the microphone mid-call. While the mic is not captured yet
   * (`microphone: false` start, still muted) this records the preference for
   * the first unmute. Rejects with `device_change_failed` when the device
   * cannot be activated, switching back to the previous microphone (best
   * effort — the transport stops the old capture before acquiring the new).
   */
  async setInputDevice(deviceId: string): Promise<void> {
    try {
      await this.#transport.setInputDevice(deviceId);
    } catch (error) {
      throw AgentSession.#asDeviceError(error, "Could not switch the microphone");
    }
  }

  /**
   * Route the agent's audio to an output device (`setSinkId`); pass `""` to
   * return to the default device. Rejects with `device_change_failed` where
   * the browser does not support output selection (common on mobile browsers)
   * or the device cannot be used; playback stays on the previous device.
   */
  async setOutputDevice(deviceId: string): Promise<void> {
    await this.#output.setSinkId(deviceId);
  }

  setOutputVolume(volume: number): void {
    this.#output.setVolume(volume);
  }

  getOutputVolume(): number {
    return this.#outputAnalyser.getVolume();
  }

  getInputVolume(): number {
    return this.#inputAnalyser.getVolume();
  }

  getOutputFrequencyData(): Uint8Array {
    return this.#outputAnalyser.getFrequencyData();
  }

  getInputFrequencyData(): Uint8Array {
    return this.#inputAnalyser.getFrequencyData();
  }

  /**
   * Escape hatch: the underlying LiveKit `Room`, for needs the session API
   * doesn't cover (connection-quality telemetry, publishing extra tracks).
   * Code using it couples to this SDK's transport choice and livekit-client
   * version — prefer the session API where one exists. `undefined` after the
   * session ends, or when a custom transport doesn't expose a room.
   */
  getRoom(): Room | undefined {
    return this.#transport.getRoom?.() as Room | undefined;
  }

  // ---- lifecycle ----

  end(): Promise<void> {
    if (this.#ending) {
      return this.#ending;
    }
    if (this.#status === "ended") {
      return Promise.resolve();
    }
    const ending = this.#endOnce();
    this.#ending = ending;
    void ending.catch(() => {
      if (this.#ending === ending) {
        this.#ending = undefined;
      }
    });
    return ending;
  }

  async #endOnce(): Promise<void> {
    this.#endedByClient = true;
    try {
      // Graceful hangup over the reverse channel; participant departure is the
      // worker-side fallback if this frame never arrives.
      await this.#transport.sendClientEvent({ type: "user.hangup" });
    } catch {
      // best effort
    }
    await this.#transport.disconnect();
    this.#finalize("user_hangup");
  }

  // ---- internals ----

  static {
    startWith = (options, createTransport) => AgentSession.#startWith(options, createTransport);
  }

  static async #startWith(
    options: AgentSessionOptions,
    createTransport: TransportFactory,
  ): Promise<AgentSession> {
    if (options.audio?.outputDeviceId !== undefined) {
      // Cheap sync check first, so an unsupported browser fails before a
      // server session is even created.
      assertOutputSelectionSupported();
    }
    // Validated before anything with side effects: a typo in a callback name
    // is a programming error and must not cost a microphone prompt or a
    // server session to discover.
    const callbackSubscriptions = resolveCallbackSubscriptions(options.callbacks);
    const transport = createTransport();
    if (options.microphone !== false) {
      // Inside the user gesture that called start(), before the token
      // round-trip pushes getUserMedia out of the gesture's transient
      // activation (see Transport.prepareMicrophone). A denial surfaces in
      // transport.connect().
      transport.prepareMicrophone?.({ inputDeviceId: options.audio?.inputDeviceId });
    }
    let sessionToken: SessionToken;
    let session: AgentSession;
    try {
      sessionToken = await resolveSessionToken(options);
      session = new AgentSession(sessionToken);
      if (options.audio?.outputDeviceId !== undefined) {
        // The browser validates the device id here, before anything connects;
        // rejects like a token failure — no events yet.
        await session.#output.setSinkId(options.audio.outputDeviceId);
      }
    } catch (error) {
      // The gesture-time capture must not outlive a failed start.
      await transport.disconnect().catch(() => undefined);
      throw error;
    }

    for (const [event, callback] of callbackSubscriptions) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      session.on(event, callback as any);
    }

    session.#transport = transport;
    if (options.microphone === false) {
      session.#micMuted = true;
    }
    session.#tools = new ClientToolDispatcher(
      options.clientTools,
      options.clientToolTimeoutMs ?? DEFAULT_CLIENT_TOOL_TIMEOUT_MS,
      (message) => transport.sendClientEvent(message),
      (error) => session.emit("error", error),
    );

    try {
      await transport.connect(sessionToken, {
        inputDeviceId: options.audio?.inputDeviceId,
        microphone: options.microphone,
        callbacks: {
          onAgentEvent: (message) => session.#handleAgentEvent(message),
          onAgentReady: () => session.#handleAgentPresent(),
          // Mode model: "listening" is the default state; the framework's agent
          // state supplies the thinking edge; speaking follows the playout-synced
          // transcription segments (open = audible, closed = back to listening).
          onAgentState: (state) => {
            // Presence fallback for runtimes without the ready signal: any
            // published agent state proves the worker's pipeline is up and its
            // event handlers are registered, the gate for queued messages.
            session.#handleAgentPresent();
            if (state === "thinking") {
              session.#setMode("thinking");
            }
          },
          onTranscription: (update) => session.#handleTranscription(update),
          onOutputStream: (id, stream, voice) => {
            session.#output.setStream(id, stream, voice);
            if (voice) {
              session.#outputAnalyser.setStream(stream);
            }
          },
          onOutputStreamEnded: (id) => session.#output.removeStream(id),
          onInputStream: (stream) => session.#inputAnalyser.setStream(stream),
          onConnectionState: (state, reason) => session.#handleConnectionState(state, reason),
        },
      });
    } catch (error) {
      // connect() can fail after the room is already joined (e.g. mic capture);
      // tear the transport down or the room stays connected with no owner.
      await session.#transport.disconnect().catch(() => undefined);
      session.#finalize("connection_lost");
      throw AgentSession.#asStartError(error);
    }

    if (session.#status === "connecting") {
      session.#setStatus("connected");
      session.emit("connect", { sessionId: session.#sessionId });
    }
    if (session.#status !== "ended" && options.wakeLock !== false) {
      session.#wakeLock.acquire();
    }
    if (!session.#agentPresent && session.#status === "connected") {
      session.#joinTimer = setTimeout(() => session.#abandonAgentWait(), AGENT_JOIN_TIMEOUT_MS);
    }
    return session;
  }

  static #asStartError(error: unknown): FishAgentError {
    if (error instanceof FishAgentError) {
      return error;
    }
    if (error instanceof Error && error.name === "NotAllowedError") {
      return new FishAgentError("mic_permission_denied", "Microphone permission was denied", {
        cause: error,
      });
    }
    return new FishAgentError("connection_failed", "Could not establish the realtime session", {
      cause: error,
    });
  }

  static #asMicError(error: unknown): FishAgentError {
    if (error instanceof FishAgentError) {
      return error;
    }
    if (error instanceof Error && error.name === "NotAllowedError") {
      return new FishAgentError("mic_permission_denied", "Microphone permission was denied", {
        cause: error,
      });
    }
    if (
      error instanceof Error &&
      (error.name === "OverconstrainedError" || error.name === "NotFoundError")
    ) {
      // Device/constraint failures surface here both for a preference recorded
      // while muted and for a first capture with no usable microphone — keep
      // the device error code, with a message that fits either.
      return new FishAgentError(
        "device_change_failed",
        "No usable microphone could be activated",
        { cause: error },
      );
    }
    return new FishAgentError("connection_failed", "Could not toggle the microphone", {
      cause: error,
    });
  }

  static #asDeviceError(error: unknown, message: string): FishAgentError {
    if (error instanceof FishAgentError) {
      return error;
    }
    return new FishAgentError("device_change_failed", message, { cause: error });
  }

  #sendClientEvent(message: Parameters<Transport["sendClientEvent"]>[0]): void {
    void this.#transport.sendClientEvent(message).catch((error: unknown) => {
      this.emit(
        "error",
        new FishAgentError("connection_failed", "Failed to send to the agent", { cause: error }),
      );
    });
  }

  #setStatus(status: SessionStatus): void {
    if (this.#status !== status) {
      this.#status = status;
      this.emit("statusChange", status);
    }
  }

  #setMode(mode: AgentMode): void {
    if (this.#mode !== mode) {
      this.#mode = mode;
      this.emit("modeChange", mode);
    }
  }

  #handleAgentPresent(): void {
    if (this.#agentPresent) {
      return;
    }
    this.#agentPresent = true;
    if (this.#joinTimer) {
      clearTimeout(this.#joinTimer);
      this.#joinTimer = undefined;
    }
    const pending = this.#pendingMessages;
    this.#pendingMessages = [];
    for (const message of pending) {
      this.#sendClientEvent(message);
    }
  }

  #abandonAgentWait(): void {
    if (this.#status === "ended" || this.#agentPresent) {
      return;
    }
    this.emit(
      "error",
      new FishAgentError("connection_failed", "The agent did not join the session"),
    );
    void this.#transport.disconnect().catch(() => {});
    this.#finalize("connection_lost");
  }

  #handleConnectionState(state: TransportConnectionState, reason?: string): void {
    if (this.#status === "ended") {
      return;
    }
    if (state === "reconnecting") {
      this.#setStatus("reconnecting");
      return;
    }
    if (state === "connected") {
      if (this.#status === "reconnecting") {
        this.#setStatus("connected");
      }
      return;
    }
    // A `session.ended` announcement from the runtime is authoritative. The
    // transport signals below are the fallback for ends nobody could announce
    // (older runtimes, a runtime crash, network loss): AGENT_LEFT = the agent
    // participant hung up (worker ends without closing the room); room
    // deletion covers server-forced ends and the duration cap — without the
    // announcement these are indistinguishable and all read as agent_hangup.
    const ended = this.#endedByClient
      ? "user_hangup"
      : (this.#announcedEndReason ??
        (reason === "AGENT_LEFT" || reason === "ROOM_DELETED" || reason === "ROOM_CLOSED"
          ? "agent_hangup"
          : "connection_lost"));
    this.#finalize(ended);
  }

  #finalize(reason: EndReason): void {
    if (this.#status === "ended") {
      return;
    }
    if (this.#joinTimer) {
      clearTimeout(this.#joinTimer);
      this.#joinTimer = undefined;
    }
    if (this.#endedGraceTimer) {
      clearTimeout(this.#endedGraceTimer);
      this.#endedGraceTimer = undefined;
    }
    this.#endReason = reason;
    this.#setStatus("ended");
    this.#wakeLock.release();
    this.#output.dispose();
    this.#outputAnalyser.dispose();
    this.#inputAnalyser.dispose();
    this.emit("disconnect", { reason });
  }

  #handleSessionEnded(reason: string): void {
    if (this.#status === "ended" || this.#announcedEndReason !== undefined) {
      return;
    }
    if (!ANNOUNCED_END_REASONS.has(reason)) {
      // Forward compatibility: an unrecognized reason voids the announcement;
      // the transport disconnect signals decide instead.
      return;
    }
    this.#announcedEndReason = reason as EndReason;
    const announced = this.#announcedEndReason;
    this.#endedGraceTimer = setTimeout(() => {
      void this.#transport.disconnect().catch(() => {});
      this.#finalize(announced);
    }, SESSION_ENDED_GRACE_MS);
  }

  #handleAgentEvent(message: AgentSessionMessage): void {
    switch (message.type) {
      case "client_tool.call":
        void this.#tools.dispatch(message);
        return;
      case "tool.started":
        this.emit("toolCallStarted", {
          callId: message.callId,
          toolName: message.toolName,
          source: message.toolSource,
          input: message.input,
          inputTruncated: message.inputTruncated === true,
        });
        return;
      case "tool.completed":
        this.emit("toolCallCompleted", {
          callId: message.callId,
          toolName: message.toolName,
          source: message.toolSource,
          output: message.output,
          outputTruncated: message.outputTruncated === true,
        });
        return;
      case "tool.failed":
        this.emit("toolCallFailed", {
          callId: message.callId,
          toolName: message.toolName,
          source: message.toolSource,
          error: message.error,
          ...(typeof message.httpStatus === "number" ? { httpStatus: message.httpStatus } : {}),
        });
        return;
      case "session.ended":
        this.#handleSessionEnded(message.reason);
        return;
      case "error": {
        const code = message.code === "provider_error" ? "provider_error" : "internal_error";
        const stage =
          typeof message.stage === "string" && ERROR_STAGES.has(message.stage) ? message.stage : undefined;
        const recovered = typeof message.recovered === "boolean" ? message.recovered : undefined;
        this.emit(
          "error",
          new FishAgentError(code, describeRuntimeError(code, recovered), { stage, recovered }),
        );
        return;
      }
      default:
        // Forward compatibility: unknown message types are ignored by contract.
        return;
    }
  }

  #recordSegment(role: "user" | "agent", segmentId: string, text: string, final: boolean): void {
    const key = `${role}:${segmentId}`;
    const index = this.#transcriptIndex.get(key);
    if (index === undefined) {
      this.#transcriptIndex.set(key, this.#transcript.length);
      this.#transcript.push({ segmentId, role, text, final });
    } else {
      this.#transcript[index] = { segmentId, role, text, final };
    }
  }

  #handleTranscription(update: TranscriptionSegmentUpdate): void {
    if (update.role === "user") {
      this.#recordSegment("user", update.segmentId, update.text, update.final);
      this.emit("userTranscript", {
        segmentId: update.segmentId,
        text: update.text,
        final: update.final,
      });
      if (update.final) {
        this.emit("message", { role: "user", text: update.text });
      }
      return;
    }
    // Agent speech: playout-synced, so streaming text means the agent is audibly
    // speaking; the segment closing means playout finished — back to listening.
    this.#setMode(update.final ? "listening" : "speaking");
    this.#recordSegment("agent", update.segmentId, update.text, update.final);
    const previous = this.#agentSegments.get(update.segmentId) ?? "";
    const delta = update.text.startsWith(previous) ? update.text.slice(previous.length) : update.text;
    this.#agentSegments.set(update.segmentId, update.text);
    if (delta) {
      this.emit("agentResponseDelta", { segmentId: update.segmentId, delta, text: update.text });
    }
    if (update.final) {
      this.#agentSegments.delete(update.segmentId);
      this.emit("agentResponse", { segmentId: update.segmentId, text: update.text });
      this.emit("message", { role: "agent", text: update.text });
    }
  }

  // Typed messages are not echoed by the server; the sender finalizes its own bubble.
  #recordTypedUserMessage(text: string): void {
    const segmentId = `typed_${++this.#typedMessageCount}`;
    this.#recordSegment("user", segmentId, text, true);
    this.emit("userTranscript", { segmentId, text, final: true });
    this.emit("message", { role: "user", text });
  }
}

/** Internal seam: identical to AgentSession.start but with an injectable transport. */
export function startAgentSession(
  options: AgentSessionOptions,
  createTransport: TransportFactory,
): Promise<AgentSession> {
  return startWith(options, createTransport);
}
