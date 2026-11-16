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

/**
 * What the SDK cannot connect without. `session_id` and `expires_at` are not
 * on the list: a token without them connects (no session id is reported, no
 * join deadline is checked), so it is not rejected for lacking them.
 */
const REQUIRED_TOKEN_FIELDS = ["transport", "livekit_url", "token"] as const;
/** Every key of the session-creation response the SDK reads, for telling what an object is. */
const TOKEN_FIELDS = ["transport", "session_id", "expires_at", "livekit_url", "token"] as const;

/** Renamed keys seen when a backend or serializer converts the response to camelCase. */
const CAMEL_CASE_FIELDS: ReadonlyMap<string, string> = new Map([
  ["sessionId", "session_id"],
  ["expiresAt", "expires_at"],
  ["livekitUrl", "livekit_url"],
  ["liveKitUrl", "livekit_url"],
  ["maxDurationSeconds", "max_duration_seconds"],
]);

/** Keys an HTTP error body typically carries. */
const ERROR_BODY_KEYS = [
  "error",
  "errors",
  "detail",
  "message",
  "code",
  "status",
  "statusCode",
  "status_code",
];

/** Where the session token comes from, for wording a shape problem. */
type TokenSource = "option" | "response";

interface TokenProblem {
  /** Predicate describing what was received, e.g. `is a string`. Never contains a value. */
  what: string;
  /** What the caller should do instead (only meaningful for the `sessionToken` option). */
  fix: string;
}

const FORWARD_VERBATIM =
  "Pass the JSON object your backend received from `POST /v1/agent/sessions`, unchanged";

const FETCH_FIRST = `Fetch the session token before starting the call. ${FORWARD_VERBATIM}`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Key names are echoed into error messages, values never. A key is only echoed
 * when it looks like an identifier, so a secret used as a key cannot leak.
 */
function quoteKeys(keys: string[]): string {
  const safe = keys.filter((key) => /^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(key));
  return safe.map((key) => `\`${key}\``).join(", ");
}

/** How many session-token keys (snake_case or renamed to camelCase) the object has. */
function countTokenFields(value: Record<string, unknown>): number {
  return [...TOKEN_FIELDS, ...CAMEL_CASE_FIELDS.keys()].filter((field) => field in value).length;
}

function describeFieldProblems(value: Record<string, unknown>): string | undefined {
  const missing: string[] = [];
  const mistyped: string[] = [];
  for (const field of REQUIRED_TOKEN_FIELDS) {
    const actual = value[field];
    if (actual === undefined || actual === null) {
      missing.push(field);
    } else if (typeof actual !== "string") {
      const got = Array.isArray(actual) ? "an array" : typeof actual;
      mistyped.push(`\`${field}\` (expected a string, got ${got})`);
    } else if (actual === "") {
      mistyped.push(`\`${field}\` (an empty string)`);
    }
  }
  const parts = [
    ...(missing.length > 0 ? [`is missing ${quoteKeys(missing)}`] : []),
    ...(mistyped.length > 0 ? [`has an unusable ${mistyped.join(", ")}`] : []),
  ];
  return parts.length > 0 ? parts.join(" and ") : undefined;
}

/**
 * Says what is wrong with a value that should be a session token, or returns
 * undefined when it has every field the SDK needs to connect. Only values that
 * could never have connected are reported. Unknown extra fields are fine: the
 * response is additive.
 */
function findTokenProblem(value: unknown): TokenProblem | undefined {
  if (value === null || value === undefined) {
    return { what: `is ${value === null ? "null" : "undefined"}`, fix: FETCH_FIRST };
  }
  if (typeof value === "string") {
    if (value.trim() === "") {
      return { what: "is an empty string", fix: FETCH_FIRST };
    }
    if (value.trimStart().startsWith("{")) {
      return {
        what: "is a string of JSON text",
        fix: "Parse it first (`await response.json()`, or `JSON.parse`) and pass the resulting object",
      };
    }
    return {
      what: "is a string",
      fix: `${FORWARD_VERBATIM}, not only its \`token\` field`,
    };
  }
  if (typeof Response !== "undefined" && value instanceof Response) {
    return {
      what: "is a fetch Response",
      fix: "Check `response.ok`, then pass `await response.json()`",
    };
  }
  if (typeof (value as { then?: unknown }).then === "function") {
    return { what: "is a Promise", fix: "`await` it before starting the session" };
  }
  if (!isRecord(value)) {
    return {
      what: Array.isArray(value) ? "is an array" : `is a ${typeof value}`,
      fix: FORWARD_VERBATIM,
    };
  }

  const transport = value.transport;
  if (typeof transport === "string" && transport !== "" && !SUPPORTED_TRANSPORTS.includes(transport)) {
    // A token for another transport carries other connection fields. Its
    // shape is not this SDK's to judge: the transport check reports it.
    return undefined;
  }
  const fieldProblems = describeFieldProblems(value);
  if (fieldProblems === undefined) {
    return undefined;
  }

  const keys = Object.keys(value);
  if (keys.length === 0) {
    return { what: "is an empty object", fix: FORWARD_VERBATIM };
  }
  const wrapperKey = keys.find((key) => {
    const inner = value[key];
    return isRecord(inner) && countTokenFields(inner) >= 2;
  });
  if (wrapperKey !== undefined) {
    const quoted = quoteKeys([wrapperKey]);
    return {
      what: `has the session token nested under ${quoted || "another key"}`,
      fix: "Pass that inner object as `sessionToken`, not the object around it",
    };
  }
  const errorKeys = keys.filter((key) => ERROR_BODY_KEYS.includes(key));
  if (errorKeys.length > 0 && countTokenFields(value) === 0) {
    return {
      what: `looks like an error response (keys: ${quoteKeys(errorKeys)}), not a session token`,
      fix:
        "Session creation probably failed on your backend. Check the response status " +
        "(`response.ok`) before passing its body to the SDK, and look at your backend's logs",
    };
  }
  const camelKeys = keys.filter((key) => CAMEL_CASE_FIELDS.has(key));
  if (camelKeys.length > 0) {
    const expected = [...new Set(camelKeys.map((key) => CAMEL_CASE_FIELDS.get(key) as string))];
    return {
      what:
        `has camelCase keys (${quoteKeys(camelKeys)}) where the SDK reads snake_case ` +
        `(${quoteKeys(expected)})`,
      fix: "Forward the session-creation response without renaming its keys",
    };
  }
  return { what: fieldProblems, fix: FORWARD_VERBATIM };
}

/**
 * Checks shape, transport and join deadline, in that order. Synchronous, so a
 * caller-supplied token can be rejected before anything with side effects.
 */
export function validateSessionToken(
  sessionToken: unknown,
  source: TokenSource = "option",
): SessionToken {
  const problem = findTokenProblem(sessionToken);
  if (problem !== undefined) {
    throw source === "option"
      ? new FishAgentError(
          "invalid_session_token",
          `\`sessionToken\` ${problem.what}. ${problem.fix}.`,
        )
      : new FishAgentError(
          "session_request_failed",
          `The session endpoint answered with a body that ${problem.what}`,
        );
  }
  const token = sessionToken as SessionToken;
  const transport: string = token.transport;
  if (!SUPPORTED_TRANSPORTS.includes(transport)) {
    throw new FishAgentError(
      "unsupported_transport",
      `Session token uses transport "${transport}" which this SDK version does not support; ` +
        "please upgrade @fishaudio/agent-client",
    );
  }
  const expiresAt = Date.parse(token.expires_at);
  if (!Number.isNaN(expiresAt) && expiresAt <= Date.now()) {
    throw new FishAgentError(
      "session_expired",
      "The session token's join deadline has passed; request a new session",
    );
  }
  return token;
}

/**
 * The synchronous half of resolving a session token: rejects a call that names
 * both or neither auth mode, and validates a caller-supplied `sessionToken`.
 * Returns that token, or undefined when the session has to be created from
 * `agentId` (see `resolveSessionToken`).
 */
export function checkSessionRequest(options: SessionRequestOptions): SessionToken | undefined {
  const provided = [options.agentId, options.sessionToken].filter((value) => value !== undefined);
  if (provided.length !== 1) {
    throw new TypeError(
      "Exactly one of `agentId` or `sessionToken` must be provided to start a session",
    );
  }
  // Anything but undefined is an attempt to pass a token: null or "" must not
  // fall through to creating a public session.
  return options.sessionToken !== undefined
    ? validateSessionToken(options.sessionToken)
    : undefined;
}

/** Creates a public (keyless) session from `agentId` and validates the answer. */
export async function createSessionToken(options: SessionRequestOptions): Promise<SessionToken> {
  return validateSessionToken(await createPublicSession(options), "response");
}

export async function resolveSessionToken(options: SessionRequestOptions): Promise<SessionToken> {
  return checkSessionRequest(options) ?? (await createSessionToken(options));
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

async function createPublicSession(options: SessionRequestOptions): Promise<unknown> {
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
  return (await response.json()) as unknown;
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
