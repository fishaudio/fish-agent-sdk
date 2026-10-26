import type {
  AgentSessionMessage,
  ClientSessionMessage,
  SessionToken,
} from "@fishaudio/agent-protocol";

// Internal seam: the session layer speaks only this interface, so transport
// vocabulary stops at the implementation file and tests run against a mock.
// Not part of the public API surface.

export type TransportConnectionState = "connected" | "reconnecting" | "disconnected";

/**
 * One update of a transcription segment (`lk.transcription`). `text` is the
 * segment's full text so far — updates for the same id replace, never append.
 */
export interface TranscriptionSegmentUpdate {
  segmentId: string;
  role: "user" | "agent";
  text: string;
  final: boolean;
}

export interface TransportCallbacks {
  onAgentEvent(message: AgentSessionMessage): void;
  /**
   * The agent announced that its pipeline is live and its opening line is
   * queued (`fish.agent.ready`). Sticky: a late or reconnecting client gets it
   * on connect. The primary "agent is present" signal. Older runtimes never
   * send it, `onAgentState` is the fallback.
   */
  onAgentReady(): void;
  /**
   * Agent pipeline state as published by the agent framework (`lk.agent.state`
   * participant attribute): "initializing" | "idle" | "listening" | "thinking" |
   * "speaking". Sticky — late joiners receive the current value on connect.
   */
  onAgentState(state: string): void;
  onTranscription(update: TranscriptionSegmentUpdate): void;
  /**
   * One remote (agent) audio track, keyed by its id. An agent can publish several
   * at once (speech plus background ambience); each plays on its own. `voice` marks
   * the agent's speech, the only track that feeds output analysis.
   */
  onOutputStream(id: string, stream: MediaStream, voice: boolean): void;
  /** The remote audio track with this id went away. */
  onOutputStreamEnded(id: string): void;
  /** Local microphone audio, for input level/FFT reporting. */
  onInputStream(stream: MediaStream): void;
  onConnectionState(state: TransportConnectionState, reason?: string): void;
}

export interface TransportConnectOptions {
  callbacks: TransportCallbacks;
  inputDeviceId?: string;
  /** Capture and publish the microphone during connect. Default true. */
  microphone?: boolean;
}

export interface Transport {
  /**
   * Begin microphone capture immediately, inside the user gesture that started
   * the call — browsers (Safari, in-app WebViews) auto-deny a later
   * getUserMedia without showing a prompt once the gesture's transient
   * activation expires behind the token/connect round-trips. `connect()`
   * consumes the pending capture (denials surface there); `disconnect()`
   * releases a capture that was never published.
   */
  prepareMicrophone?(options: { inputDeviceId?: string }): void;
  connect(sessionToken: SessionToken, options: TransportConnectOptions): Promise<void>;
  disconnect(): Promise<void>;
  setMicEnabled(enabled: boolean): Promise<void>;
  /**
   * Switch the capture device. While the microphone is not captured yet
   * (`microphone: false` start, still muted) this records the preference for
   * the next capture. Rejects when the device cannot be activated.
   */
  setInputDevice(deviceId: string): Promise<void>;
  sendClientEvent(message: ClientSessionMessage): Promise<void>;
  /**
   * The agent's audio is attached to the SDK's playback path and the browser
   * has allowed it to play. The transport relays this to the runtime, which
   * holds the opening line (bounded) until it hears it. Best effort: must
   * never throw, a lost report only costs the handshake.
   */
  markAudioReady?(): void;
  /**
   * The transport's underlying connection object (a LiveKit `Room` for the
   * production transport), backing the session's `getRoom()` escape hatch.
   * `unknown` here so this seam stays free of transport vocabulary.
   */
  getRoom?(): unknown;
}

// No arguments: the transport must exist before the session token does, so
// prepareMicrophone can run inside the user gesture that started the call.
export type TransportFactory = () => Transport;
