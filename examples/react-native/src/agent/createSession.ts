import type {
  AgentSessionCreateRequest,
  SessionLanguage,
  SessionToken,
} from '@fishaudio/agent-protocol';
import { SESSION_TRANSPORT_LIVEKIT } from '@fishaudio/agent-protocol';

export const FISH_API_URL = 'https://api.fish.audio';

export type SessionSource =
  /** Dev only: the API key is bundled into the app. Production apps get the token from their backend. */
  | { kind: 'apiKey'; apiKey: string; agentId: string }
  /** A token minted elsewhere (e.g. `curl` on a laptop) and pasted in. */
  | { kind: 'token'; token: SessionToken }
  /** Keyless public agent. The server requires an allow-listed Origin header, which a native app has to fake. */
  | { kind: 'public'; agentId: string; origin?: string };

export interface CreateSessionOptions {
  language?: SessionLanguage;
  endUserId?: string;
}

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

export async function createSession(
  source: SessionSource,
  options: CreateSessionOptions = {},
): Promise<SessionToken> {
  if (source.kind === 'token') {
    return validate(source.token);
  }

  const timezone = clientTimezone();
  const request: AgentSessionCreateRequest = {
    agent_id: source.agentId,
    ...(timezone ? { client_timezone: timezone } : {}),
    ...(options.language ? { overrides: { language: options.language } } : {}),
    ...(options.endUserId ? { end_user_id: options.endUserId } : {}),
  };
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Fish-SDK': 'agent-rn-demo/0.0.0',
  };
  if (source.kind === 'apiKey') {
    headers.Authorization = `Bearer ${source.apiKey}`;
  } else if (source.origin) {
    // Browsers forbid setting Origin; React Native's fetch does not.
    headers.Origin = source.origin;
  }

  let response: Response;
  try {
    response = await fetch(`${FISH_API_URL}/v1/agent/sessions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
    });
  } catch (cause) {
    throw new SessionRequestError(`Could not reach the session endpoint: ${String(cause)}`);
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
