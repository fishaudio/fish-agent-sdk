import {
  SESSION_TRANSPORT_LIVEKIT,
  type AgentSessionCreateRequest,
  type SessionLanguage,
  type SessionOverrides,
  type SessionToken,
} from "@fishaudio/agent-protocol";
import { FishAgentError } from "./errors.js";

// Replaced at build time, see buildConstants.d.ts.
export const SDK_VERSION = __SDK_VERSION__;
export const DEFAULT_SERVER_URL = "https://api.fish.audio";

const SUPPORTED_TRANSPORTS: string[] = [SESSION_TRANSPORT_LIVEKIT];

export interface SessionContextOptions {
  /** See `context.current_time` on the session request. */
  currentTime?: boolean;
}

export interface SessionRequestOptions {
  /** Public agent: the SDK creates the session directly against the Fish API. */
  agentId?: string;
  /**
   * Public agent outside a browser (React Native, Node): the origin to present
   * to the agent's allowlist, e.g. `"https://www.example.com"`. Browsers send
   * their page's origin themselves and ignore this. Native apps send none, so
   * without it a public agent answers 403 `origin_forbidden`. Use an origin you
   * own that is on the agent's allowlist. Ignored with `sessionToken`.
   *
   * @experimental The platform documents public agents for browsers only, and a
   * dedicated way for apps to identify themselves may replace this. It may
   * change or be removed in a minor release. For production apps, prefer a
   * session token from your backend.
   */
  origin?: string;
  /** Session token created by the host backend, passed through verbatim. */
  sessionToken?: SessionToken;
  serverUrl?: string;
  /** Sugar for `overrides.language`; an explicit override wins. Pair with a voice in that language. */
  language?: SessionLanguage;
  /**
   * IANA timezone for the agent's sense of local time in this session. Omit to
   * use the browser's timezone (sent automatically as a hint). With
   * `sessionToken` auth the host backend chooses instead, via `timezone` on its
   * session-creation call.
   */
  timezone?: string;
  /**
   * Per-session overrides of the agent's context switches. `currentTime: false`
   * withholds the current date and time from this session, `true` injects them
   * even when the agent has them off, omitted follows the agent. With
   * `sessionToken` auth the host backend chooses instead, via `context` on its
   * session-creation call.
   */
  context?: SessionContextOptions;
  /** @deprecated Use `context.currentTime`. Still sent as the API's alias. */
  worldContext?: boolean;
  /** Per-session config overrides; each field must be allow-listed on the agent. */
  overrides?: SessionOverrides;
  /** `{{name}}` template values for the agent's prompt and first message. */
  dynamicVariables?: Record<string, string | number | boolean>;
  endUserId?: string;
  /** Caller-owned tag, stored and returned verbatim; the platform never interprets it. */
  metadata?: Record<string, unknown>;
  /**
   * Stream the agent's tool-call lifecycle (toolCallStarted/Completed/Failed
   * events, with payloads) to this session. Default true; set false when tool
   * data must stay hidden from this client. With `sessionToken` auth the host
   * backend chooses instead, via `tool_events` on its session-creation call.
   */
  toolEvents?: boolean;
}

export function validateSessionToken(sessionToken: SessionToken): SessionToken {
  const transport: string = sessionToken.transport;
  if (!SUPPORTED_TRANSPORTS.includes(transport)) {
    throw new FishAgentError(
      "unsupported_transport",
      `Session token uses transport "${transport}" which this SDK version does not support; ` +
        "please upgrade @fishaudio/agent-client",
    );
  }
  const expiresAt = Date.parse(sessionToken.expires_at);
  if (!Number.isNaN(expiresAt) && expiresAt <= Date.now()) {
    throw new FishAgentError(
      "session_expired",
      "The session token's join deadline has passed; request a new session",
    );
  }
  return sessionToken;
}

export async function resolveSessionToken(options: SessionRequestOptions): Promise<SessionToken> {
  const provided = [options.agentId, options.sessionToken].filter((value) => value !== undefined);
  if (provided.length !== 1) {
    throw new TypeError(
      "Exactly one of `agentId` or `sessionToken` must be provided to start a session",
    );
  }

  if (options.sessionToken) {
    return validateSessionToken(options.sessionToken);
  }
  return validateSessionToken(await createPublicSession(options));
}

// The browser knows the end user's real timezone; without the hint the
// platform would have to guess UTC.
function detectClientTimezone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

async function createPublicSession(options: SessionRequestOptions): Promise<SessionToken> {
  const serverUrl = (options.serverUrl ?? DEFAULT_SERVER_URL).replace(/\/$/, "");
  const clientTimezone = detectClientTimezone();
  const overrides: SessionOverrides | undefined =
    options.language || options.overrides
      ? { ...(options.language ? { language: options.language } : {}), ...options.overrides }
      : undefined;
  const request: AgentSessionCreateRequest = {
    agent_id: options.agentId as string,
    ...(options.timezone ? { timezone: options.timezone } : {}),
    ...(clientTimezone ? { client_timezone: clientTimezone } : {}),
    ...(options.context?.currentTime !== undefined
      ? { context: { current_time: options.context.currentTime } }
      : options.worldContext !== undefined
        ? { world_context: options.worldContext }
        : {}),
    ...(overrides ? { overrides } : {}),
    ...(options.dynamicVariables ? { dynamic_variables: options.dynamicVariables } : {}),
    ...(options.endUserId ? { end_user_id: options.endUserId } : {}),
    ...(options.metadata ? { metadata: options.metadata } : {}),
    ...(options.toolEvents !== undefined ? { tool_events: options.toolEvents } : {}),
  };

  let response: Response;
  try {
    response = await fetch(`${serverUrl}/v1/agent/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Fish-SDK": `agent-client/${SDK_VERSION}`,
        // Browsers set Origin themselves and drop this; native fetch sends it.
        ...(options.origin ? { Origin: options.origin } : {}),
      },
      body: JSON.stringify(request),
    });
  } catch (cause) {
    throw new FishAgentError("session_request_failed", "Could not reach the session endpoint", {
      cause,
    });
  }

  if (!response.ok) {
    const error = await createSessionError(response);
    if (error.code === "origin_forbidden" && !options.origin && typeof document === "undefined") {
      // Outside a browser no Origin goes out at all unless the caller sets one.
      error.message +=
        "; outside a browser (React Native) pass `origin` with an origin on the agent's allowlist";
    }
    throw error;
  }
  return (await response.json()) as SessionToken;
}

async function createSessionError(response: Response): Promise<FishAgentError> {
  let message = `Session request failed with HTTP ${response.status}`;
  let code: string | undefined;
  try {
    const body = (await response.json()) as { message?: string; error?: string; code?: string };
    message = body.message ?? body.error ?? message;
    code = body.code;
  } catch {
    // keep the status-based message
  }
  const options = { statusCode: response.status };
  // 409 alone is ambiguous (the server also uses it for e.g. an unpublished
  // agent); only the coded arm means "this SDK is too old".
  if (response.status === 409 && code === "unsupported_transport") {
    return new FishAgentError(
      "unsupported_transport",
      `${message}; please upgrade @fishaudio/agent-client`,
      options,
    );
  }
  if (response.status === 402) {
    return new FishAgentError("insufficient_credit", message, options);
  }
  if (response.status === 403) {
    return /origin/i.test(message)
      ? new FishAgentError("origin_forbidden", message, options)
      : new FishAgentError("agent_not_public", message, options);
  }
  return new FishAgentError("session_request_failed", message, options);
}
