import type { SessionLanguage, SessionToken } from '@fishaudio/agent-protocol';
import { SESSION_TRANSPORT_LIVEKIT } from '@fishaudio/agent-protocol';

/**
 * How a production app starts a call: it asks its own backend for a session
 * token. The backend holds the API key, picks the agent and calls
 * POST /v1/agent/sessions (see server/index.mjs); the app never sees the key.
 */
export interface SessionRequest {
  /** The backend's token endpoint, e.g. https://api.example.com/agent-session. */
  tokenUrl: string;
  /** Reply language the backend may pass on as an override. */
  language?: SessionLanguage;
}

/**
 * The two supported ways for an app to start a call:
 * - `backend` (recommended): the app's own backend creates the session with
 *   the API key and returns the token.
 * - `public`: a public agent, keyless. The SDK creates the session itself and
 *   presents `origin` to the agent's allowlist, since a native app sends no
 *   Origin of its own. Anyone with the agent ID can do the same, as on the web.
 */
export type CallSource =
  | { kind: 'backend'; tokenUrl: string }
  | { kind: 'public'; agentId: string; origin: string };

export class SessionRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

function clientTimezone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

export async function requestSessionToken({ tokenUrl, language }: SessionRequest): Promise<SessionToken> {
  let response: Response;
  try {
    response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ language, timezone: clientTimezone() }),
    });
  } catch (cause) {
    throw new SessionRequestError(
      `Could not reach the token endpoint ${tokenUrl}: ${String(cause)}. ` +
        'On a phone, localhost is the phone itself: use the computer\'s LAN address, or `adb reverse` on Android.',
    );
  }
  const body = await response.text();
  if (!response.ok) {
    throw new SessionRequestError(`${response.status}: ${body || response.statusText}`, response.status);
  }
  return validate(JSON.parse(body) as SessionToken);
}

function validate(token: SessionToken): SessionToken {
  if (token.transport !== SESSION_TRANSPORT_LIVEKIT) {
    throw new SessionRequestError(`Unsupported transport "${String(token.transport)}"`);
  }
  const expiresAt = Date.parse(token.expires_at);
  if (!Number.isNaN(expiresAt) && expiresAt <= Date.now()) {
    throw new SessionRequestError('The session token has expired; request a new one');
  }
  return token;
}
