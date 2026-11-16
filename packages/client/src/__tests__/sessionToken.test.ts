import { afterEach, describe, expect, it, vi } from "vitest";
import pkg from "../../package.json";
import {
  DEFAULT_SERVER_URL,
  SDK_VERSION,
  resolveSessionToken,
  validateSessionToken,
} from "../sessionToken.js";

const SESSION_TOKEN = {
  transport: "livekit",
  session_id: "sess-1",
  expires_at: new Date(Date.now() + 60_000).toISOString(),
  max_duration_seconds: 600,
  livekit_url: "wss://x",
  token: "t",
};

function stubFetch(status: number, body: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("public session request", () => {
  it("presents the given origin outside a browser and leaves it out otherwise", async () => {
    const fetchMock = stubFetch(201, SESSION_TOKEN);
    await resolveSessionToken({ agentId: "agent-1", origin: "https://www.example.com" });
    await resolveSessionToken({ agentId: "agent-1" });
    const headers = fetchMock.mock.calls.map(
      (call) => (call as unknown as [string, RequestInit])[1].headers as Record<string, string>,
    );
    expect(headers[0]?.Origin).toBe("https://www.example.com");
    expect(headers[1]).not.toHaveProperty("Origin");
  });

  it("tells a native caller to pass origin when the allowlist refuses it", async () => {
    stubFetch(403, { message: "Origin not allowed" });
    await expect(resolveSessionToken({ agentId: "a" })).rejects.toMatchObject({
      code: "origin_forbidden",
      message: expect.stringContaining("pass `origin`"),
    });
    stubFetch(403, { message: "Origin not allowed" });
    await expect(
      resolveSessionToken({ agentId: "a", origin: "https://wrong.example" }),
    ).rejects.toMatchObject({ code: "origin_forbidden", message: "Origin not allowed" });
  });

  it("posts the full create body with the SDK version header", async () => {
    const fetchMock = stubFetch(201, SESSION_TOKEN);
    const sessionToken = await resolveSessionToken({
      agentId: "agent-1",
      language: "en",
      overrides: { first_message: "Hi {{user_name}}!" },
      dynamicVariables: { user_name: "Ada" },
      endUserId: "u-1",
      metadata: { plan: "pro" },
      toolEvents: false,
    });
    expect(sessionToken.session_id).toBe("sess-1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${DEFAULT_SERVER_URL}/v1/agent/sessions`);
    expect((init.headers as Record<string, string>)["X-Fish-SDK"]).toBe(
      `agent-client/${pkg.version}`,
    );
    expect(JSON.parse(init.body as string)).toEqual({
      agent_id: "agent-1",
      // Auto-filled browser hint; asserted against the test runtime's own zone.
      client_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      // The `language` option is client-side sugar folded into overrides.
      overrides: { language: "en", first_message: "Hi {{user_name}}!" },
      dynamic_variables: { user_name: "Ada" },
      end_user_id: "u-1",
      metadata: { plan: "pro" },
      tool_events: false,
    });
  });

  it("reports the version from package.json, not a hardcoded one", () => {
    expect(SDK_VERSION).toBe(pkg.version);
    expect(SDK_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("lets an explicit overrides.language win over the language option", async () => {
    const fetchMock = stubFetch(201, SESSION_TOKEN);
    await resolveSessionToken({
      agentId: "a",
      language: "en",
      overrides: { language: "ja", voice_id: "voice-1" },
    });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({
      overrides: { language: "ja", voice_id: "voice-1" },
    });
  });

  it("sends an explicit timezone alongside the browser hint", async () => {
    const fetchMock = stubFetch(201, SESSION_TOKEN);
    await resolveSessionToken({ agentId: "a", timezone: "Asia/Shanghai" });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({
      timezone: "Asia/Shanghai",
      client_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
  });

  it("forwards the current time override, the deprecated alias, and omits the default", async () => {
    const fetchMock = stubFetch(201, SESSION_TOKEN);
    await resolveSessionToken({ agentId: "a", context: { currentTime: false } });
    const [, offInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(offInit.body as string)).toMatchObject({
      context: { current_time: false },
    });

    await resolveSessionToken({ agentId: "a", worldContext: false });
    const [, aliasInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(JSON.parse(aliasInit.body as string)).toMatchObject({ world_context: false });

    await resolveSessionToken({ agentId: "a" });
    const [, defaultInit] = fetchMock.mock.calls[2] as unknown as [string, RequestInit];
    const body = JSON.parse(defaultInit.body as string);
    expect(body).not.toHaveProperty("context");
    expect(body).not.toHaveProperty("world_context");
  });

  it("targets a custom serverUrl and strips its trailing slash", async () => {
    const fetchMock = stubFetch(201, SESSION_TOKEN);
    await resolveSessionToken({ agentId: "a", serverUrl: "https://api.example.com/" });
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe("https://api.example.com/v1/agent/sessions");
  });

  it("maps HTTP failures onto stable error codes", async () => {
    stubFetch(409, { code: "unsupported_transport", message: "Unsupported transport" });
    await expect(resolveSessionToken({ agentId: "a" })).rejects.toMatchObject({
      code: "unsupported_transport",
      statusCode: 409,
      message: expect.stringContaining("please upgrade"),
    });

    // A 409 without the discriminator (e.g. unpublished agent) is not an
    // SDK-version problem and must not tell the user to upgrade.
    stubFetch(409, { message: "Agent has no published version" });
    await expect(resolveSessionToken({ agentId: "a" })).rejects.toMatchObject({
      code: "session_request_failed",
      statusCode: 409,
      message: "Agent has no published version",
    });

    stubFetch(403, { message: "Origin not allowed" });
    await expect(resolveSessionToken({ agentId: "a" })).rejects.toMatchObject({
      code: "origin_forbidden",
    });

    stubFetch(403, { message: "Agent is not public" });
    await expect(resolveSessionToken({ agentId: "a" })).rejects.toMatchObject({
      code: "agent_not_public",
    });

    stubFetch(402, { message: "Out of API credit" });
    await expect(resolveSessionToken({ agentId: "a" })).rejects.toMatchObject({
      code: "insufficient_credit",
      statusCode: 402,
      message: "Out of API credit",
    });

    stubFetch(400, { message: "Overrides not enabled for this agent: first_message" });
    await expect(resolveSessionToken({ agentId: "a" })).rejects.toMatchObject({
      code: "session_request_failed",
      message: expect.stringContaining("first_message"),
    });
  });

  it("maps network failures to session_request_failed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network down");
      }),
    );
    await expect(resolveSessionToken({ agentId: "a" })).rejects.toMatchObject({
      code: "session_request_failed",
    });
  });
});

describe("session token validation", () => {
  const invalid = (value: unknown) => {
    try {
      validateSessionToken(value);
    } catch (error) {
      return error as { code: string; message: string };
    }
    throw new Error("expected the token to be rejected");
  };

  it("accepts the session-creation response, including fields it does not know", () => {
    const response = {
      ...SESSION_TOKEN,
      join_url: "https://example.com/join#abc",
      some_future_field: { nested: true },
    };
    expect(validateSessionToken(response)).toBe(response);
  });

  it("says what it received when the value is not an object", async () => {
    expect(invalid(undefined)).toMatchObject({
      code: "invalid_session_token",
      message: expect.stringMatching(/^`sessionToken` is undefined\. Fetch the session token/),
    });
    expect(invalid(42).message).toMatch(/is a number/);
    expect(invalid([SESSION_TOKEN]).message).toMatch(/is an array/);
    expect(invalid({}).message).toMatch(/is an empty object/);
    const pending = Promise.resolve(SESSION_TOKEN);
    expect(invalid(pending)).toMatchObject({
      code: "invalid_session_token",
      message: expect.stringMatching(/is a Promise\. `await` it/),
    });
    expect(invalid(new Response("{}")).message).toMatch(/is a fetch Response\. Check `response\.ok`/);
  });

  it("names empty and mistyped connection fields without echoing their values", () => {
    const error = invalid({ ...SESSION_TOKEN, livekit_url: "", token: 12345 });
    expect(error.code).toBe("invalid_session_token");
    expect(error.message).toMatch(/`token` \(expected a string, got number\)/);
    expect(error.message).toMatch(/`livekit_url` \(an empty string\)/);
    expect(error.message).not.toContain("12345");
    expect(invalid({ ...SESSION_TOKEN, token: undefined }).message).toMatch(/is missing `token`\./);
    expect(invalid({ ...SESSION_TOKEN, transport: "" }).message).toMatch(
      /`transport` \(an empty string\)/,
    );
  });

  it("accepts every token that could connect before, whatever its session_id and expires_at", () => {
    const connectable = { transport: "livekit", livekit_url: "wss://x", token: "t" };
    const accepted: unknown[] = [
      connectable,
      { ...connectable, session_id: null, expires_at: null },
      { ...connectable, session_id: 12345 },
      // Not a date: no deadline is checked, as before.
      { ...connectable, expires_at: "soon" },
      { ...connectable, expires_at: "" },
      { ...connectable, expires_at: 4102444800000 },
      { ...connectable, expires_at: { seconds: 1 } },
    ];
    for (const token of accepted) {
      expect(validateSessionToken(token)).toBe(token);
    }
  });

  it("accepts a session endpoint answer without session_id and expires_at", async () => {
    stubFetch(201, { transport: "livekit", livekit_url: "wss://x", token: "t" });
    await expect(resolveSessionToken({ agentId: "a" })).resolves.toEqual({
      transport: "livekit",
      livekit_url: "wss://x",
      token: "t",
    });
  });

  it("does not echo keys that could be a pasted secret", () => {
    const secretKey = "eyJhbGciOiJIUzI1NiJ9.payload.signature";
    const error = invalid({ [secretKey]: { ...SESSION_TOKEN } });
    expect(error.message).toMatch(/nested under another key/);
    expect(error.message).not.toContain("eyJ");
  });

  it("does not mistake keys named like built-in properties for renamed fields", () => {
    const error = invalid({ constructor: "x", toString: "y", session_id: "sess-1" });
    expect(error.message).not.toMatch(/camelCase/);
    expect(error.message).toMatch(/is missing `transport`, `livekit_url`, `token`\./);
  });

  it("reports unsupported_transport only for an object whose transport is an unknown string", () => {
    // A token for another transport need not carry the LiveKit fields.
    expect(
      invalid({ transport: "carrier-pigeon", session_id: "sess-1", loft_address: "roof" }),
    ).toMatchObject({
      code: "unsupported_transport",
      message: expect.stringContaining('transport "carrier-pigeon"'),
    });
    // None of these is an SDK-version problem.
    expect(invalid({ ...SESSION_TOKEN, transport: undefined })).toMatchObject({
      code: "invalid_session_token",
      message: expect.stringMatching(/is missing `transport`\./),
    });
    expect(invalid({ ...SESSION_TOKEN, transport: 7 }).code).toBe("invalid_session_token");
    expect(invalid("carrier-pigeon").code).toBe("invalid_session_token");
    expect(invalid({ error: "Unauthorized" }).code).toBe("invalid_session_token");
    expect(invalid({ data: { ...SESSION_TOKEN, transport: "carrier-pigeon" } }).code).toBe(
      "invalid_session_token",
    );
  });

  it("still rejects a well-formed token past its join deadline", () => {
    expect(invalid({ ...SESSION_TOKEN, expires_at: "2020-01-01T00:00:00Z" }).code).toBe(
      "session_expired",
    );
  });

  it("reports an unusable answer from the session endpoint as a failed request, not a bad option", async () => {
    stubFetch(200, { ok: true });
    await expect(resolveSessionToken({ agentId: "a" })).rejects.toMatchObject({
      code: "session_request_failed",
      message: expect.stringMatching(
        /^The session endpoint answered with a body that is missing `transport`, `livekit_url`, `token`$/,
      ),
    });
  });
});
