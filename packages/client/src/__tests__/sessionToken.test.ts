import { afterEach, describe, expect, it, vi } from "vitest";
import pkg from "../../package.json";
import { DEFAULT_SERVER_URL, SDK_VERSION, resolveSessionToken } from "../sessionToken.js";

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
