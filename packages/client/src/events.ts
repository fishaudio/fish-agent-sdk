import type { ToolCallSource } from "@fishaudio/agent-protocol";
import type { FishAgentError } from "./errors.js";

export type SessionStatus = "connecting" | "connected" | "reconnecting" | "ended";

export type AgentMode = "listening" | "thinking" | "speaking";

/**
 * Why the session ended. `connection_lost` is client-derived (reconnection
 * failed, the agent never joined, or the call dropped before the runtime could
 * say why); every other value is the runtime's own reason, delivered over the
 * protocol's `session.ended` announcement — or, against an older runtime that
 * never sends one, inferred from transport signals (where every server-side
 * end surfaces as `agent_hangup`). `llm_endpoint_failure` means the agent's
 * custom LLM endpoint failed repeatedly and the runtime closed the session.
 */
export type EndReason =
  | "user_hangup"
  | "agent_hangup"
  | "conversation_timeout"
  | "escalated"
  | "llm_endpoint_failure"
  | "connection_lost";

export interface UserTranscriptEvent {
  /** Groups updates of one utterance; interim updates replace, they never append. */
  segmentId: string;
  /** Full text of the utterance so far. */
  text: string;
  final: boolean;
}

export interface AgentResponseDeltaEvent {
  /** Groups streaming updates of one agent speech segment. */
  segmentId: string;
  delta: string;
  /** Accumulated segment text including this delta. */
  text: string;
}

export interface AgentResponseEvent {
  segmentId: string;
  text: string;
}

/** One transcript segment; `text` is the whole segment so far, refined in place. */
export interface TranscriptSegment {
  segmentId: string;
  role: "user" | "agent";
  text: string;
  final: boolean;
}

export interface ConversationMessage {
  role: "user" | "agent";
  text: string;
}

/**
 * Tool-call lifecycle, forwarded for every tool the agent runs (including client
 * tools, which complete once this client returns their result). `callId` pairs one
 * started event with exactly one completed/failed event; terminal events repeat
 * name/source so a listener attached mid-call can still render a full item.
 * Emission is a session-creation option (`toolEvents`/`tool_events`, default true).
 */
export interface ToolCallStartedEvent {
  callId: string;
  toolName: string;
  source: ToolCallSource;
  /** Tool arguments as a JSON string; parse only when `inputTruncated` is false. */
  input: string;
  inputTruncated: boolean;
}

export interface ToolCallCompletedEvent {
  callId: string;
  toolName: string;
  source: ToolCallSource;
  /** Tool result as a JSON string; parse only when `outputTruncated` is false. */
  output: string;
  outputTruncated: boolean;
}

export interface ToolCallFailedEvent {
  callId: string;
  toolName: string;
  source: ToolCallSource;
  error: string;
  /**
   * HTTP status the tool's endpoint answered with when the call failed after a
   * response arrived: a 3xx/4xx/5xx from a webhook tool, or a response an
   * integration tool (reported as `builtin`) could not use. Absent when no
   * response arrived and for client and MCP tools.
   */
  httpStatus?: number;
}

export interface AgentSessionEvents {
  connect: (event: { sessionId: string }) => void;
  disconnect: (event: { reason: EndReason }) => void;
  statusChange: (status: SessionStatus) => void;
  modeChange: (mode: AgentMode) => void;
  userTranscript: (event: UserTranscriptEvent) => void;
  agentResponseDelta: (event: AgentResponseDeltaEvent) => void;
  agentResponse: (event: AgentResponseEvent) => void;
  /** Finalized messages only, in conversation order — the "just give me a chat log" event. */
  message: (message: ConversationMessage) => void;
  toolCallStarted: (event: ToolCallStartedEvent) => void;
  toolCallCompleted: (event: ToolCallCompletedEvent) => void;
  toolCallFailed: (event: ToolCallFailedEvent) => void;
  error: (error: FishAgentError) => void;
}

export type AgentSessionCallbacks = {
  [K in keyof AgentSessionEvents as `on${Capitalize<K>}`]: AgentSessionEvents[K];
};

/** Every event name, for runtime validation of the `callbacks` shorthand. */
export const AGENT_SESSION_EVENT_NAMES = [
  "connect",
  "disconnect",
  "statusChange",
  "modeChange",
  "userTranscript",
  "agentResponseDelta",
  "agentResponse",
  "message",
  "toolCallStarted",
  "toolCallCompleted",
  "toolCallFailed",
  "error",
] as const satisfies readonly (keyof AgentSessionEvents)[];

// Compile-time check that the list above stays exhaustive.
type MissingEventName = Exclude<keyof AgentSessionEvents, (typeof AGENT_SESSION_EVENT_NAMES)[number]>;
const _assertEventNamesExhaustive: MissingEventName extends never ? true : never = true;
void _assertEventNamesExhaustive;
