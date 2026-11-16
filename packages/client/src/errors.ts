import type { AgentErrorStage } from "@fishaudio/agent-protocol";

export type FishAgentErrorCode =
  | "session_request_failed"
  | "agent_not_public"
  | "origin_forbidden"
  /** The session request was refused for lack of credit (HTTP 402): the agent owner's account has no Agent credit left. */
  | "insufficient_credit"
  /**
   * The `sessionToken` option is not the session-creation response: it is
   * null, a string, an error body, wrapped in another object, has renamed
   * keys, or lacks fields. The message says which.
   */
  | "invalid_session_token"
  /** The session token is well-formed but names a transport this SDK version does not know. */
  | "unsupported_transport"
  /** The page is not a secure context (https or localhost), so the browser gives it no microphone. */
  | "insecure_context"
  | "mic_permission_denied"
  /** No microphone could be captured at start: none found, or it could not be opened. */
  | "mic_unavailable"
  /** A requested audio device could not be activated, or the browser does not support selecting it. */
  | "device_change_failed"
  | "connection_failed"
  | "session_expired"
  | "tool_failed"
  | "tool_timeout"
  /** An upstream model/speech provider failed during the session. */
  | "provider_error"
  /** The agent runtime hit an internal error. */
  | "internal_error";

/** Pipeline stage a `provider_error` / `internal_error` came from. */
export type FishAgentErrorStage = AgentErrorStage;

export class FishAgentError extends Error {
  readonly code: FishAgentErrorCode;
  /** HTTP status of the failing session request, when the error originated there. */
  readonly statusCode?: number;
  /** `provider_error` / `internal_error` only: which stage failed, when the runtime said. */
  readonly stage?: FishAgentErrorStage;
  /**
   * `provider_error` / `internal_error` only. true: the runtime is still going
   * to answer this turn by itself, a light hint is enough. false: the turn is
   * lost. Undefined when the runtime did not say.
   */
  readonly recovered?: boolean;

  constructor(
    code: FishAgentErrorCode,
    message: string,
    options?: {
      statusCode?: number;
      stage?: FishAgentErrorStage;
      recovered?: boolean;
      cause?: unknown;
    },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "FishAgentError";
    this.code = code;
    this.statusCode = options?.statusCode;
    this.stage = options?.stage;
    this.recovered = options?.recovered;
  }
}
