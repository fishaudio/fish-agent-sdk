import type { AgentErrorStage } from "@fishaudio/agent-protocol";

export type FishAgentErrorCode =
  | "session_request_failed"
  | "agent_not_public"
  | "origin_forbidden"
  | "unsupported_transport"
  | "mic_permission_denied"
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
