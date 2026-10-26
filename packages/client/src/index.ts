// Public surface. Transport-neutral except the deliberate escape hatch
// `AgentSession.getRoom()`, whose return type is livekit-client's `Room`.
export { AgentSession, type AgentSessionOptions } from "./session/agentSession.js";
export { DEFAULT_SERVER_URL } from "./sessionToken.js";
export { FishAgentError, type FishAgentErrorCode, type FishAgentErrorStage } from "./errors.js";
export type {
  AgentMode,
  AgentResponseDeltaEvent,
  AgentResponseEvent,
  AgentSessionCallbacks,
  AgentSessionEvents,
  ConversationMessage,
  EndReason,
  SessionStatus,
  ToolCallCompletedEvent,
  ToolCallFailedEvent,
  ToolCallStartedEvent,
  TranscriptSegment,
  UserTranscriptEvent,
} from "./events.js";
export type { ClientToolHandler } from "./session/toolDispatcher.js";
export { MAX_CLIENT_TOOL_RESULT_BYTES } from "./session/toolDispatcher.js";
export type {
  AgentSessionCreateRequest,
  SessionAsrOverrides,
  SessionOverrides,
  SessionToken,
  ToolCallSource,
} from "@fishaudio/agent-protocol";
