// Control-channel wire contract between the agent runtime and end-user clients.
// Every type here has a shipped SDK behavior. Transcripts ride LiveKit's
// `lk.transcription` text streams, agent state its `lk.agent.state`
// participant attribute.
//
// Compatibility is additive-only: published fields never change name, meaning, or
// type; new fields are optional; a semantic change is a new `type`. Consumers must
// ignore unknown `type` values and unknown fields.

export const AGENT_EVENT_TOPIC = "agent-event";
export const CLIENT_EVENT_TOPIC = "client-event";

/**
 * Participant attribute the agent sets once its pipeline is live and the opener
 * is queued. Sticky, so a late or reconnecting client reads it on connect.
 * Value: epoch milliseconds. Gate the "connected" UI on this attribute. Fall
 * back to `AGENT_STATE_ATTRIBUTE` only after a bounded wait (about 8 s) without
 * it, for older runtimes that never set it.
 */
export const AGENT_READY_ATTRIBUTE = "fish.agent.ready";

/**
 * Participant attribute the agent framework publishes with its pipeline state
 * (`initializing`, `listening`, `thinking`, `speaking`). It is set before
 * `AGENT_READY_ATTRIBUTE`, so its presence alone does not mean the agent is
 * ready: wait a bounded time for the ready attribute before falling back to it.
 */
export const AGENT_STATE_ATTRIBUTE = "lk.agent.state";

/**
 * Participant attribute the client sets to report audio readiness. Set it to
 * `CLIENT_AUDIO_READY_PENDING` right after joining to announce a client that
 * will report, then to epoch milliseconds once the agent's audio track is
 * attached and the browser allows playback. The runtime waits a bounded time
 * for the ready value before speaking the opener, so the first words are not
 * lost to a blocked audio element. A client that never sets it only delays the
 * opener. Publishing it needs a join token that lets the participant update
 * its own attributes.
 *
 * The ready value also goes out as a `client.audio_ready` message on
 * `CLIENT_EVENT_TOPIC`. LiveKit holds attribute updates from a participant that
 * has published no track (a microphone-off session) for seconds, the data
 * channel delivers at once. The attribute stays because it is sticky: a runtime
 * that joins later still reads it.
 */
export const CLIENT_AUDIO_READY_ATTRIBUTE = "fish.client.audio_ready";
export const CLIENT_AUDIO_READY_PENDING = "pending";

/**
 * Where a tool call is executed; `background` is a call the agent delegated to a
 * background task, `unknown` a model call the runtime could not resolve (still
 * reported, as a failure).
 */
export type ToolCallSource = "client" | "webhook" | "mcp" | "builtin" | "background" | "unknown";

/**
 * Tool-call lifecycle: one `tool.started` per call, resolved by exactly one
 * `tool.completed`/`tool.failed` with the same `callId`. Terminal messages repeat
 * name/source so a client that missed the start (no data-channel replay) can still
 * render a full item. `input`/`output` are JSON strings truncated at the source.
 * Emission is a session-creation option (`tool_events`, default true); sessions
 * created with `tool_events: false` receive none of the three.
 */
export type ToolCallEventMessage =
  | {
      type: "tool.started";
      callId: string;
      toolName: string;
      toolSource: ToolCallSource;
      nodeId: string;
      input: string;
      inputTruncated?: boolean;
    }
  | {
      type: "tool.completed";
      callId: string;
      toolName: string;
      toolSource: ToolCallSource;
      nodeId: string;
      output: string;
      outputTruncated?: boolean;
    }
  | {
      type: "tool.failed";
      callId: string;
      toolName: string;
      toolSource: ToolCallSource;
      nodeId: string;
      error: string;
      /**
       * HTTP status the tool's endpoint answered with when the call failed
       * after a response arrived: a 3xx/4xx/5xx from a webhook tool, or a
       * response an integration tool (reported as `builtin`) could not use.
       * Absent when no response arrived (timeout, DNS failure) and for client
       * and MCP tools.
       */
      httpStatus?: number;
    };

/**
 * Why the runtime ended the session. Values mirror the `endReason` on the
 * session record your backend reads, so the client-observed reason and the
 * server-recorded one reconcile exactly. The set is additive: a consumer
 * receiving a reason it does not recognize must ignore the whole message and
 * fall back to transport-level disconnect signals.
 */
export type SessionEndedReason =
  | "user_hangup"
  | "agent_hangup"
  | "conversation_timeout"
  | "escalated"
  /** The agent's custom LLM endpoint failed repeatedly and the runtime closed the session. */
  | "llm_endpoint_failure"
  /**
   * The runtime failed and closed the session: its process was stopped (over its memory
   * limit, or the worker shutting down) or an internal error ended the call.
   */
  | "internal_error";

/** Pipeline stage an `error` message came from. `runtime` is the runtime's own code path. */
export type AgentErrorStage = "llm" | "stt" | "tts" | "runtime";

/** `agent-event` topic: agent→client, one complete JSON object per message. */
export type AgentSessionMessage =
  | {
      // While `expectsResponse` is true the agent suspends the tool call
      // until a matching `client_tool.result` or timeout.
      type: "client_tool.call";
      callId: string;
      toolName: string;
      params: Record<string, unknown>;
      expectsResponse: boolean;
      /**
       * How long the agent waits for the result, in ms. Clients should time out
       * the handler at this value. Absent from runtimes that predate it.
       */
      timeoutMs?: number;
    }
  | ToolCallEventMessage
  // Sent once, before the agent leaves or the room is deleted, on every close
  // path that still has a live runtime to announce it (agent hangup, workflow
  // end, duration cap, server-forced end). Ends nobody can announce — a
  // runtime crash, network loss — surface only as a transport disconnect.
  | { type: "session.ended"; reason: SessionEndedReason }
  // Category only — raw provider/runtime error text is never sent to clients.
  | {
      type: "error";
      code: "provider_error" | "internal_error";
      /** Which stage failed. Older runtimes omit it. */
      stage?: AgentErrorStage;
      /**
       * true: the runtime is still going to answer this turn by itself (a retry
       * or a silent regeneration), a light "retrying" hint is enough. false: the
       * turn is lost and the caller has to act. Neither value means the session
       * has ended. Older runtimes omit it.
       */
      recovered?: boolean;
    };

/** `client-event` topic: client→agent. `user.message` gets no echo — the sender finalizes its own bubble. */
export type ClientSessionMessage =
  // `audio: false` asks the agent to answer this turn in text only (no TTS);
  // the reply still streams over `lk.transcription`. Absent means audio as usual.
  // (The web SDK's `sendUserMessage` sends `audio: false` unless called with `audio: true`.)
  | { type: "user.message"; text: string; audio?: boolean }
  | { type: "user.activity" }
  | { type: "user.interrupt" }
  | { type: "user.hangup" }
  // Same report as the `fish.client.audio_ready` attribute's ready value, `at` is
  // that epoch-ms stamp. Sent because attribute updates from a participant without
  // a published track reach the agent late (see `CLIENT_AUDIO_READY_ATTRIBUTE`).
  | { type: "client.audio_ready"; at: number }
  | { type: "client_tool.result"; callId: string; result?: unknown; isError?: boolean };
