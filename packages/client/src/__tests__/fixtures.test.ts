// Runs the shared conformance fixtures in packages/protocol/fixtures against
// this client. The native SDKs run the same files, so this client is the
// reference: a fixture is only valid once it passes here.
//
// The runner is strict on purpose: an unknown key or kind in a fixture fails
// the test instead of being skipped (see the fixtures README).
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentSessionMessage,
  ClientSessionMessage,
  SessionToken,
} from "@fishaudio/agent-protocol";
import pkg from "../../package.json";
import agentEventsFixture from "../../../protocol/fixtures/messages/agent-events.json";
import clientEventsFixture from "../../../protocol/fixtures/messages/client-events.json";
import requestFixture from "../../../protocol/fixtures/session/request.json";
import errorsFixture from "../../../protocol/fixtures/session/errors.json";
import tokensFixture from "../../../protocol/fixtures/session/tokens.json";
import timeoutsFixture from "../../../protocol/fixtures/tools/timeouts.json";
import resultsFixture from "../../../protocol/fixtures/tools/results.json";
import scenariosFixture from "../../../protocol/fixtures/scenarios/session.json";
import { FishAgentError } from "../errors.js";
import type { AgentSessionEvents } from "../events.js";
import {
  startAgentSession,
  type AgentSession,
  type AgentSessionOptions,
} from "../session/agentSession.js";
import type { ClientToolHandler } from "../session/toolDispatcher.js";
import { resolveSessionToken, type SessionRequestOptions } from "../sessionToken.js";
import type {
  Transport,
  TransportCallbacks,
  TransportConnectionState,
  TransportConnectOptions,
} from "../transport/types.js";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

interface Fixture<Case> {
  description: string;
  cases: Case[];
}

/** JSON imports are typed as the union of their literals; read them as the documented shape instead. */
function load<Case extends { name: string }>(fixture: unknown, where: string): Case[] {
  const { cases, ...rest } = fixture as Fixture<Case>;
  onlyKeys(rest, ["description"], where);
  const names = cases.map((item) => item.name);
  expect(new Set(names).size, `${where}: case names must be unique`).toBe(names.length);
  return cases;
}

function onlyKeys(value: object, allowed: readonly string[], where: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new Error(`${where}: unknown key(s) ${unknown.join(", ")}; update this runner`);
  }
}

const PLACEHOLDERS: Record<string, () => string> = {
  "{{client_timezone}}": () => Intl.DateTimeFormat().resolvedOptions().timeZone,
  "{{sdk}}": () => `agent-client/${pkg.version}`,
};

/** Replaces whole-string placeholders anywhere in an expected value. */
function fill(value: Json): Json {
  if (typeof value === "string") {
    return PLACEHOLDERS[value]?.() ?? value;
  }
  if (Array.isArray(value)) {
    return value.map(fill);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fill(item)]));
  }
  return value;
}

const SESSION_TOKEN: SessionToken = {
  transport: "livekit",
  session_id: "sess-fixture",
  expires_at: new Date(Date.now() + 120_000).toISOString(),
  max_duration_seconds: 600,
  livekit_url: "wss://example.livekit.cloud",
  token: "tok",
};

class FixtureTransport implements Transport {
  callbacks?: TransportCallbacks;
  sent: ClientSessionMessage[] = [];

  async connect(_sessionToken: SessionToken, options: TransportConnectOptions): Promise<void> {
    this.callbacks = options.callbacks;
  }
  async disconnect(): Promise<void> {}
  async setMicEnabled(): Promise<void> {}
  async setInputDevice(): Promise<void> {}
  async sendClientEvent(message: ClientSessionMessage): Promise<void> {
    this.sent.push(message);
  }

  agent(message: unknown): void {
    this.callbacks!.onAgentEvent(message as AgentSessionMessage);
  }
}

/** A connected session whose agent has joined and announced it is ready. */
async function startReady(extra: Partial<AgentSessionOptions> = {}) {
  const transport = new FixtureTransport();
  const session = await startAgentSession({ sessionToken: SESSION_TOKEN, ...extra }, () => transport);
  transport.callbacks!.onAgentState("initializing");
  transport.callbacks!.onAgentReady();
  return { session, transport };
}

const EVENT_NAMES: Array<keyof AgentSessionEvents> = [
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
];

function recordEvents(session: AgentSession): Array<[string, unknown]> {
  const seen: Array<[string, unknown]> = [];
  for (const name of EVENT_NAMES) {
    session.on(name, ((payload: unknown) => {
      seen.push([name, payload]);
    }) as never);
  }
  return seen;
}

function stubFetch(respond: () => Promise<Response>) {
  const fetchMock = vi.fn(respond);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ---- messages/agent-events.json ----

interface AgentEventCase {
  name: string;
  message: JsonObject;
  expect: {
    event?: string;
    payload?: JsonObject;
    error?: { code: string; stage?: string; recovered?: boolean };
    ignored?: true;
    endReasonAfterDisconnect?: string;
  };
}

describe("fixtures: messages/agent-events.json", () => {
  const where = "messages/agent-events.json";
  for (const item of load<AgentEventCase>(agentEventsFixture, where)) {
    it(item.name, async () => {
      onlyKeys(item, ["name", "message", "expect"], where);
      const { session, transport } = await startReady();
      const seen = recordEvents(session);
      transport.agent(item.message);

      const expected = item.expect;
      if (expected.event !== undefined) {
        onlyKeys(expected, ["event", "payload"], where);
        expect(seen).toEqual([[expected.event, expected.payload]]);
      } else if (expected.error !== undefined) {
        onlyKeys(expected, ["error"], where);
        onlyKeys(expected.error, ["code", "stage", "recovered"], where);
        expect(seen).toHaveLength(1);
        const [name, error] = seen[0]!;
        expect(name).toBe("error");
        expect(error).toBeInstanceOf(FishAgentError);
        const { code, stage, recovered } = error as FishAgentError;
        // toEqual treats an undefined property like a missing one, so a key
        // left out of the fixture means "absent on the error".
        expect({ code, stage, recovered }).toEqual(expected.error);
      } else if (expected.ignored !== undefined) {
        onlyKeys(expected, ["ignored"], where);
        expect(expected.ignored).toBe(true);
        expect(seen).toEqual([]);
        expect(transport.sent).toEqual([]);
      } else if (expected.endReasonAfterDisconnect !== undefined) {
        onlyKeys(expected, ["endReasonAfterDisconnect"], where);
        expect(seen).toEqual([]);
        transport.callbacks!.onConnectionState("disconnected");
        expect(session.endReason).toBe(expected.endReasonAfterDisconnect);
      } else {
        throw new Error(`${where}: "${item.name}" has no expectation this runner knows`);
      }
    });
  }
});

// ---- messages/client-events.json ----

interface ClientEventCase {
  name: string;
  call: { method: string; text?: string; audio?: boolean };
  sent: JsonObject[];
}

describe("fixtures: messages/client-events.json", () => {
  const where = "messages/client-events.json";
  for (const item of load<ClientEventCase>(clientEventsFixture, where)) {
    it(item.name, async () => {
      onlyKeys(item, ["name", "call", "sent"], where);
      const { session, transport } = await startReady();
      const { call } = item;
      switch (call.method) {
        case "sendUserMessage":
          onlyKeys(call, ["method", "text", "audio"], where);
          session.sendUserMessage(
            call.text!,
            call.audio === undefined ? undefined : { audio: call.audio },
          );
          break;
        case "sendUserActivity":
          onlyKeys(call, ["method"], where);
          session.sendUserActivity();
          break;
        case "interrupt":
          onlyKeys(call, ["method"], where);
          session.interrupt();
          break;
        case "end":
          onlyKeys(call, ["method"], where);
          await session.end();
          break;
        default:
          throw new Error(`${where}: unknown method "${call.method}"; update this runner`);
      }
      expect(transport.sent).toEqual(item.sent);
    });
  }
});

// ---- session/request.json ----

interface RequestCase {
  name: string;
  options: JsonObject;
  expect: {
    url: string;
    headers: Record<string, string>;
    absentHeaders: string[];
    body: JsonObject;
  };
}

const REQUEST_OPTION_KEYS = [
  "agentId",
  "origin",
  "serverUrl",
  "language",
  "timezone",
  "context",
  "overrides",
  "dynamicVariables",
  "endUserId",
  "metadata",
  "toolEvents",
];

describe("fixtures: session/request.json", () => {
  const where = "session/request.json";
  for (const item of load<RequestCase>(requestFixture, where)) {
    it(item.name, async () => {
      onlyKeys(item, ["name", "options", "expect"], where);
      onlyKeys(item.options, REQUEST_OPTION_KEYS, where);
      onlyKeys(item.expect, ["url", "headers", "absentHeaders", "body"], where);
      const fetchMock = stubFetch(
        async () => new Response(JSON.stringify(SESSION_TOKEN), { status: 201 }),
      );

      await resolveSessionToken(item.options as SessionRequestOptions);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe(item.expect.url);
      expect(init.method).toBe("POST");
      const headers = init.headers as Record<string, string>;
      for (const [name, value] of Object.entries(item.expect.headers)) {
        expect(headers[name], `header ${name}`).toBe(fill(value));
      }
      for (const name of item.expect.absentHeaders) {
        expect(headers, `header ${name}`).not.toHaveProperty(name);
      }
      expect(JSON.parse(init.body as string)).toEqual(fill(item.expect.body));
    });
  }
});

// ---- session/errors.json ----

interface ErrorCase {
  name: string;
  response: { status?: number; json?: Json; text?: string; networkError?: true };
  options?: { origin?: string };
  expect: {
    code: string;
    statusCode: number | null;
    message?: string;
    messageStartsWith?: string;
    messageContains?: string;
  };
}

function checkMessage(
  message: string,
  expected: { message?: string; messageStartsWith?: string; messageContains?: string },
): void {
  if (expected.message !== undefined) {
    expect(message).toBe(expected.message);
  }
  if (expected.messageStartsWith !== undefined) {
    expect(message.startsWith(expected.messageStartsWith), message).toBe(true);
  }
  if (expected.messageContains !== undefined) {
    expect(message).toContain(expected.messageContains);
  }
}

describe("fixtures: session/errors.json", () => {
  const where = "session/errors.json";
  for (const item of load<ErrorCase>(errorsFixture, where)) {
    it(item.name, async () => {
      onlyKeys(item, ["name", "response", "options", "expect"], where);
      onlyKeys(item.options ?? {}, ["origin"], where);
      onlyKeys(
        item.expect,
        ["code", "statusCode", "message", "messageStartsWith", "messageContains"],
        where,
      );
      const { response } = item;
      if (response.networkError !== undefined) {
        onlyKeys(response, ["networkError"], where);
        stubFetch(async () => {
          throw new TypeError("fetch failed");
        });
      } else if (response.json !== undefined) {
        onlyKeys(response, ["status", "json"], where);
        stubFetch(async () => new Response(JSON.stringify(response.json), { status: response.status }));
      } else if (response.text !== undefined) {
        onlyKeys(response, ["status", "text"], where);
        stubFetch(async () => new Response(response.text, { status: response.status }));
      } else {
        throw new Error(`${where}: "${item.name}" has no response this runner knows`);
      }

      const error = await resolveSessionToken({ agentId: "agent-1", ...item.options }).then(
        () => undefined,
        (reason: unknown) => reason,
      );

      expect(error).toBeInstanceOf(FishAgentError);
      const failure = error as FishAgentError;
      expect(failure.code).toBe(item.expect.code);
      expect(failure.statusCode ?? null).toBe(item.expect.statusCode);
      checkMessage(failure.message, item.expect);
    });
  }
});

// ---- session/tokens.json ----

interface TokenCase {
  name: string;
  token: JsonObject;
  expiresAtOffsetMs?: number;
  expect: { ok?: true; error?: string; messageContains?: string };
}

describe("fixtures: session/tokens.json", () => {
  const where = "session/tokens.json";
  for (const item of load<TokenCase>(tokensFixture, where)) {
    it(item.name, async () => {
      onlyKeys(item, ["name", "token", "expiresAtOffsetMs", "expect"], where);
      onlyKeys(item.expect, ["ok", "error", "messageContains"], where);
      const token = {
        ...item.token,
        ...(item.expiresAtOffsetMs !== undefined
          ? { expires_at: new Date(Date.now() + item.expiresAtOffsetMs).toISOString() }
          : {}),
      } as unknown as SessionToken;

      const outcome = resolveSessionToken({ sessionToken: token });

      if (item.expect.ok !== undefined) {
        onlyKeys(item.expect, ["ok"], where);
        expect(item.expect.ok).toBe(true);
        await expect(outcome).resolves.toBe(token);
      } else if (item.expect.error !== undefined) {
        const error = await outcome.then(
          () => undefined,
          (reason: unknown) => reason,
        );
        expect(error).toBeInstanceOf(FishAgentError);
        expect((error as FishAgentError).code).toBe(item.expect.error);
        checkMessage((error as FishAgentError).message, item.expect);
      } else {
        throw new Error(`${where}: "${item.name}" has no expectation this runner knows`);
      }
    });
  }
});

// ---- tools/timeouts.json ----

interface TimeoutCase {
  name: string;
  call: JsonObject;
  fallbackMs: number;
  expectMs: number;
}

function toolResults(transport: FixtureTransport) {
  return transport.sent.filter((message) => message.type === "client_tool.result");
}

describe("fixtures: tools/timeouts.json", () => {
  const where = "tools/timeouts.json";
  for (const item of load<TimeoutCase>(timeoutsFixture, where)) {
    it(item.name, async () => {
      onlyKeys(item, ["name", "call", "fallbackMs", "expectMs"], where);
      onlyKeys(item.call, ["timeoutMs"], where);
      vi.useFakeTimers();
      const { transport } = await startReady({
        clientTools: { slow_tool: () => new Promise(() => {}) },
        clientToolTimeoutMs: item.fallbackMs,
      });
      transport.agent({
        type: "client_tool.call",
        callId: "call-timeout",
        toolName: "slow_tool",
        params: {},
        expectsResponse: true,
        ...item.call,
      });

      await vi.advanceTimersByTimeAsync(item.expectMs - 1);
      expect(toolResults(transport)).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(toolResults(transport)).toMatchObject([
        { type: "client_tool.result", callId: "call-timeout", isError: true },
      ]);
    });
  }
});

// ---- tools/results.json ----

interface ResultCase {
  name: string;
  call: JsonObject & { callId: string; toolName: string };
  handler: { kind: string; value?: Json; length?: number; message?: string };
  expect: {
    reply: string;
    result?: Json;
    resultAbsent?: true;
    errorCode: string | null;
  };
}

/** Longer than any timeout a fixture uses, so a tool that hangs has timed out by then. */
const PAST_EVERY_TIMEOUT_MS = 20_000;

function handlerFor(handler: ResultCase["handler"], where: string): ClientToolHandler | undefined {
  switch (handler.kind) {
    case "returns":
      onlyKeys(handler, ["kind", "value"], where);
      return () => handler.value;
    case "returnsNothing":
      onlyKeys(handler, ["kind"], where);
      return () => undefined;
    case "returnsStringOfLength":
      onlyKeys(handler, ["kind", "length"], where);
      return () => "a".repeat(handler.length!);
    case "echoesParams":
      onlyKeys(handler, ["kind"], where);
      return (params) => params;
    case "echoesContext":
      onlyKeys(handler, ["kind"], where);
      return (_params, context) => ({ callId: context.callId, toolName: context.toolName });
    case "throws":
      onlyKeys(handler, ["kind", "message"], where);
      return () => {
        throw new Error(handler.message);
      };
    case "hangs":
      onlyKeys(handler, ["kind"], where);
      return () => new Promise(() => {});
    case "unregistered":
      onlyKeys(handler, ["kind"], where);
      return undefined;
    default:
      throw new Error(`${where}: unknown handler kind "${handler.kind}"; update this runner`);
  }
}

describe("fixtures: tools/results.json", () => {
  const where = "tools/results.json";
  for (const item of load<ResultCase>(resultsFixture, where)) {
    it(item.name, async () => {
      onlyKeys(item, ["name", "call", "handler", "expect"], where);
      onlyKeys(item.expect, ["reply", "result", "resultAbsent", "errorCode"], where);
      vi.useFakeTimers();
      const handler = handlerFor(item.handler, where);
      const errorCodes: string[] = [];
      const { transport } = await startReady({
        clientTools: handler ? { [item.call.toolName]: handler } : {},
        callbacks: { onError: (error) => errorCodes.push(error.code) },
      });

      transport.agent(item.call);
      await vi.advanceTimersByTimeAsync(PAST_EVERY_TIMEOUT_MS);

      expect(errorCodes).toEqual(item.expect.errorCode === null ? [] : [item.expect.errorCode]);
      const replies = toolResults(transport) as unknown as JsonObject[];
      switch (item.expect.reply) {
        case "none":
          onlyKeys(item.expect, ["reply", "errorCode"], where);
          expect(replies).toEqual([]);
          break;
        case "result": {
          expect(replies).toHaveLength(1);
          const reply = replies[0]!;
          expect(reply.callId).toBe(item.call.callId);
          expect(reply).not.toHaveProperty("isError");
          if (item.expect.resultAbsent !== undefined) {
            expect(item.expect.resultAbsent).toBe(true);
            expect(reply).not.toHaveProperty("result");
          } else if (item.expect.result !== undefined) {
            expect(reply.result).toEqual(item.expect.result);
          } else {
            expect(reply).toHaveProperty("result");
          }
          break;
        }
        case "error": {
          onlyKeys(item.expect, ["reply", "result", "errorCode"], where);
          expect(replies).toHaveLength(1);
          const reply = replies[0]!;
          expect(reply.callId).toBe(item.call.callId);
          expect(reply.isError).toBe(true);
          if (item.expect.result !== undefined) {
            expect(reply.result).toEqual(item.expect.result);
          } else {
            expect(typeof reply.result).toBe("string");
          }
          break;
        }
        default:
          throw new Error(`${where}: unknown reply "${item.expect.reply}"; update this runner`);
      }
    });
  }
});

// ---- scenarios/session.json ----

interface ScenarioCase {
  name: string;
  start?: { agent?: string };
  steps: Array<JsonObject & { do?: string; expect?: string }>;
}

/** An event in the shape the fixtures use: errors reduced to their code, stage and recovered flag. */
function eventForFixture(name: string, payload: unknown): { event: string; payload: unknown } {
  if (name === "error") {
    const { code, stage, recovered } = payload as FishAgentError;
    return { event: name, payload: { code, stage, recovered } };
  }
  return { event: name, payload };
}

describe("fixtures: scenarios/session.json", () => {
  const where = "scenarios/session.json";
  for (const item of load<ScenarioCase>(scenariosFixture, where)) {
    it(item.name, async () => {
      onlyKeys(item, ["name", "start", "steps"], where);
      onlyKeys(item.start ?? {}, ["agent"], where);
      // Before the session starts: its join timeout is armed during start.
      vi.useFakeTimers();
      const seen: Array<{ event: string; payload: unknown }> = [];
      const callbacks = Object.fromEntries(
        EVENT_NAMES.map((name) => [
          `on${name.charAt(0).toUpperCase()}${name.slice(1)}`,
          (payload: unknown) => seen.push(eventForFixture(name, payload)),
        ]),
      );
      const transport = new FixtureTransport();
      const session = await startAgentSession(
        { sessionToken: SESSION_TOKEN, callbacks },
        () => transport,
      );
      const agent = item.start?.agent ?? "ready";
      if (agent === "ready") {
        transport.callbacks!.onAgentState("initializing");
        transport.callbacks!.onAgentReady();
      } else if (agent === "joined") {
        transport.callbacks!.onAgentState("initializing");
      } else if (agent !== "absent") {
        throw new Error(`${where}: unknown start.agent "${agent}"; update this runner`);
      }
      const settle = () => vi.advanceTimersByTimeAsync(0);
      await settle();

      for (const [index, step] of item.steps.entries()) {
        const at = `${where}: "${item.name}" step ${index + 1}`;
        if (step.do !== undefined) {
          switch (step.do) {
            case "agentState":
              onlyKeys(step, ["do", "state"], at);
              transport.callbacks!.onAgentState(step.state as string);
              break;
            case "agentReady":
              onlyKeys(step, ["do"], at);
              transport.callbacks!.onAgentReady();
              break;
            case "agentEvent":
              onlyKeys(step, ["do", "message"], at);
              transport.agent(step.message);
              break;
            case "transcription":
              onlyKeys(step, ["do", "role", "segmentId", "text", "final"], at);
              transport.callbacks!.onTranscription({
                role: step.role as "user" | "agent",
                segmentId: step.segmentId as string,
                text: step.text as string,
                final: step.final as boolean,
              });
              break;
            case "connectionState":
              onlyKeys(step, ["do", "state", "reason"], at);
              transport.callbacks!.onConnectionState(
                step.state as TransportConnectionState,
                step.reason as string | undefined,
              );
              break;
            case "sendUserMessage":
              onlyKeys(step, ["do", "text", "audio"], at);
              session.sendUserMessage(
                step.text as string,
                step.audio === undefined ? undefined : { audio: step.audio as boolean },
              );
              break;
            case "sendUserActivity":
              onlyKeys(step, ["do"], at);
              session.sendUserActivity();
              break;
            case "interrupt":
              onlyKeys(step, ["do"], at);
              session.interrupt();
              break;
            case "end":
              onlyKeys(step, ["do"], at);
              await session.end();
              break;
            case "advance":
              onlyKeys(step, ["do", "ms"], at);
              await vi.advanceTimersByTimeAsync(step.ms as number);
              break;
            default:
              throw new Error(`${at}: unknown action "${step.do}"; update this runner`);
          }
          await settle();
        } else if (step.expect !== undefined) {
          switch (step.expect) {
            case "sent":
              onlyKeys(step, ["expect", "messages"], at);
              expect(transport.sent.splice(0), at).toEqual(step.messages);
              break;
            case "events": {
              onlyKeys(step, ["expect", "of", "events"], at);
              const since = seen.splice(0);
              if (step.events === "any") {
                onlyKeys(step, ["expect", "events"], at);
                break;
              }
              const of = step.of as string[] | undefined;
              const relevant = of ? since.filter((event) => of.includes(event.event)) : since;
              expect(relevant, at).toEqual(step.events);
              break;
            }
            case "state":
              onlyKeys(step, ["expect", "status", "mode", "endReason"], at);
              if (step.status !== undefined) {
                expect(session.status, at).toBe(step.status);
              }
              if (step.mode !== undefined) {
                expect(session.mode, at).toBe(step.mode);
              }
              if (step.endReason !== undefined) {
                expect(session.endReason ?? null, at).toBe(step.endReason);
              }
              break;
            default:
              throw new Error(`${at}: unknown expectation "${step.expect}"; update this runner`);
          }
        } else {
          throw new Error(`${at}: a step needs "do" or "expect"`);
        }
      }
    });
  }
});
