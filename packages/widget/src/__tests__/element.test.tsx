// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (payload: never) => void;

class FakeSession {
  handlers = new Map<string, Set<Handler>>();
  sent: string[] = [];
  activity = 0;
  micMuted: boolean;
  sessionId = "sess-w1";
  status = "connected";
  #typed = 0;

  constructor(micMuted: boolean) {
    this.micMuted = micMuted;
  }

  on(event: string, handler: Handler) {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler);
    return this;
  }

  off(event: string, handler: Handler) {
    this.handlers.get(event)?.delete(handler);
    return this;
  }

  emit(event: string, payload: unknown) {
    for (const handler of [...(this.handlers.get(event) ?? [])]) {
      handler(payload as never);
    }
  }

  sendUserMessage(text: string) {
    this.sent.push(text);
    this.#typed += 1;
    this.emit("userTranscript", { segmentId: `typed_${this.#typed}`, text, final: true });
  }

  sendUserActivity() {
    this.activity += 1;
  }

  async setMicMuted(muted: boolean) {
    this.micMuted = muted;
  }

  async startAudio() {}

  async end() {
    this.emit("disconnect", { reason: "user_hangup" });
  }

  getOutputFrequencyData() {
    return new Uint8Array(32);
  }

  getOutputVolume() {
    return 0;
  }
}

const startMock = vi.fn();

vi.mock("@fishaudio/agent-client", () => ({
  DEFAULT_SERVER_URL: "https://api.fish.test",
  AgentSession: { start: startMock },
  FishAgentError: class extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
}));

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

let sessions: FakeSession[] = [];

async function mount(attrs: Record<string, string>) {
  const { registerWidget } = await import("../element.js");
  registerWidget();
  const element = document.createElement("fish-agent");
  for (const [name, value] of Object.entries(attrs)) {
    element.setAttribute(name, value);
  }
  document.body.append(element);
  await tick();
  return element;
}

function $(element: Element, selector: string): HTMLElement {
  const found = element.shadowRoot?.querySelector(selector);
  if (!found) {
    throw new Error(`expected shadow DOM to contain ${selector}`);
  }
  return found as HTMLElement;
}

function query(element: Element, selector: string): HTMLElement | null {
  return (element.shadowRoot?.querySelector(selector) as HTMLElement | null) ?? null;
}

function click(target: HTMLElement) {
  target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function deferredStart() {
  let resolve!: (session: FakeSession) => void;
  startMock.mockImplementationOnce(
    () => new Promise<FakeSession>((r) => { resolve = r; }),
  );
  return { resolve: () => resolve(new FakeSession(false)) };
}

async function openPanel(element: Element) {
  click($(element, ".fa-fab"));
  await tick();
}

async function typeAndSend(element: Element, text: string) {
  const input = $(element, ".fa-composer input") as HTMLInputElement;
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await tick();
  $(element, ".fa-composer").dispatchEvent(
    new Event("submit", { bubbles: true, cancelable: true }),
  );
  await tick();
}

beforeEach(() => {
  sessions = [];
  startMock.mockReset();
  startMock.mockImplementation(async (options: { microphone?: boolean }) => {
    const session = new FakeSession(options.microphone === false);
    sessions.push(session);
    return session;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 404 })),
  );
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("<fish-agent>", () => {
  it("renders the FAB, opens the home view and shows the agent name", async () => {
    const element = await mount({ "agent-id": "agent_1", "agent-name": "Aria" });
    expect(query(element, ".fa-fab")).not.toBeNull();
    await openPanel(element);
    expect($(element, ".fa-header-title").textContent).toBe("Aria");
    expect($(element, ".fa-home-greeting").textContent).toBe("Hey! How can I help?");
  });

  it("starts a voice call with the microphone and dispatches lifecycle events", async () => {
    const element = await mount({ "agent-id": "agent_1" });
    const seen: string[] = [];
    for (const name of ["fish-agent:call", "fish-agent:connect", "fish-agent:disconnect"]) {
      element.addEventListener(name, () => seen.push(name));
    }
    await openPanel(element);
    click($(element, ".fa-cta"));
    await tick();

    expect(startMock).toHaveBeenCalledTimes(1);
    expect(startMock.mock.calls[0]![0]).toMatchObject({ agentId: "agent_1", microphone: true });
    expect(seen).toEqual(["fish-agent:call", "fish-agent:connect"]);
    expect(query(element, ".fa-transcript")).not.toBeNull();

    click($(element, ".fa-header-end"));
    await tick();
    expect(seen).toEqual(["fish-agent:call", "fish-agent:connect", "fish-agent:disconnect"]);
    expect($(element, ".fa-header-status").textContent).toBe("Call ended");
  });

  it("starts micless from the home composer and forwards the first message", async () => {
    const element = await mount({ "agent-id": "agent_1" });
    await openPanel(element);
    await typeAndSend(element, "Book it");

    expect(startMock.mock.calls[0]![0]).toMatchObject({ microphone: false });
    expect(sessions[0]!.sent).toEqual(["Book it"]);
    const bubble = $(element, ".fa-bubble--user");
    expect(bubble.textContent).toBe("Book it");
  });

  it("starts from a host-supplied sessionTokenProvider without any attributes", async () => {
    const token = {
      session_id: "sess_1",
      transport: "livekit" as const,
      livekit_url: "wss://livekit.fish.test",
      token: "jwt",
      expires_at: "2099-01-01T00:00:00Z",
      max_duration_seconds: 600,
    };
    const { FishAgentElement } = await import("../element.js");
    const element = (await mount({})) as InstanceType<typeof FishAgentElement>;
    element.sessionTokenProvider = async () => token;
    await openPanel(element);
    click($(element, ".fa-cta"));
    await tick();
    expect(startMock).toHaveBeenCalledTimes(1);
    expect(startMock.mock.calls[0]![0]).toMatchObject({ sessionToken: token });
    expect(startMock.mock.calls[0]![0]).not.toHaveProperty("agentId");
  });

  it("lets the host inject start options via fish-agent:call", async () => {
    const element = await mount({ "agent-id": "agent_1" });
    const lookup = () => "ok";
    element.addEventListener("fish-agent:call", (event) => {
      (event as CustomEvent<{ options: Record<string, unknown> }>).detail.options.clientTools = {
        lookup,
      };
    });
    await openPanel(element);
    click($(element, ".fa-cta"));
    await tick();
    expect(startMock.mock.calls[0]![0]).toMatchObject({ clientTools: { lookup } });
  });

  it("gates the first call behind consent and remembers acceptance", async () => {
    const element = await mount({ "agent-id": "agent_1", consent: "true" });
    await openPanel(element);
    click($(element, ".fa-cta"));
    await tick();
    expect(startMock).not.toHaveBeenCalled();
    expect(query(element, ".fa-consent")).not.toBeNull();

    click($(element, ".fa-btn-primary"));
    await tick();
    expect(startMock).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("fish-agent-consent")).toBe("accepted");
  });

  it("declining consent returns to home without starting", async () => {
    const element = await mount({ "agent-id": "agent_1", consent: "true" });
    await openPanel(element);
    click($(element, ".fa-cta"));
    await tick();
    click($(element, ".fa-btn-secondary"));
    await tick();
    expect(startMock).not.toHaveBeenCalled();
    expect(query(element, ".fa-home-greeting")).not.toBeNull();
    expect(localStorage.getItem("fish-agent-consent")).toBeNull();
  });

  it("shows no banner for an in-call error the agent is recovering from, and forwards the detail", async () => {
    const element = await mount({ "agent-id": "agent_1" });
    const details: unknown[] = [];
    element.addEventListener("fish-agent:error", (event) => {
      details.push((event as CustomEvent).detail);
    });
    await openPanel(element);
    click($(element, ".fa-cta"));
    await tick();
    const session = sessions[0]!;

    session.emit("error", { code: "provider_error", message: "retrying", stage: "llm", recovered: true });
    await tick();
    expect(query(element, ".fa-error")).toBeNull();

    session.emit("error", { code: "provider_error", message: "lost", stage: "llm", recovered: false });
    await tick();
    expect(query(element, ".fa-error")).not.toBeNull();

    session.emit("error", { code: "internal_error", message: "older runtime" });
    await tick();
    expect(details).toEqual([
      { code: "provider_error", message: "retrying", stage: "llm", recovered: true },
      { code: "provider_error", message: "lost", stage: "llm", recovered: false },
      { code: "internal_error", message: "older runtime" },
    ]);
  });

  it("renders streaming transcript segments and tool chips", async () => {
    const element = await mount({ "agent-id": "agent_1" });
    await openPanel(element);
    click($(element, ".fa-cta"));
    await tick();
    const session = sessions[0]!;

    session.emit("userTranscript", { segmentId: "s1", text: "I need to resch", final: false });
    await tick();
    session.emit("userTranscript", {
      segmentId: "s1",
      text: "I need to reschedule.",
      final: true,
    });
    session.emit("agentResponseDelta", { segmentId: "a1", text: "Friday works" });
    session.emit("toolCallStarted", {
      callId: "tc1",
      toolName: "check_availability",
      source: "webhook",
      input: "{}",
      inputTruncated: false,
    });
    await tick();

    const bubbles = element.shadowRoot!.querySelectorAll(".fa-bubble");
    expect(bubbles).toHaveLength(2);
    expect(bubbles[0]!.textContent).toBe("I need to reschedule.");
    expect(bubbles[1]!.textContent).toBe("Friday works");
    expect($(element, ".fa-tool-name").textContent).toBe("check_availability");
    expect(query(element, ".fa-tool-dot--running")).not.toBeNull();

    session.emit("toolCallCompleted", {
      callId: "tc1",
      toolName: "check_availability",
      source: "webhook",
      output: '{"slot":"14:30"}',
      outputTruncated: false,
    });
    await tick();
    expect(query(element, ".fa-tool-dot--done")).not.toBeNull();
  });

  it("minimizes to a live pill and collapses to the FAB when the call ends", async () => {
    const element = await mount({ "agent-id": "agent_1" });
    await openPanel(element);
    click($(element, ".fa-cta"));
    await tick();

    click($(element, '.fa-icon-btn[aria-label="Minimize"]'));
    await tick();
    expect(query(element, ".fa-pill")).not.toBeNull();

    click($(element, ".fa-pill .fa-btn-round--danger"));
    await tick();
    expect(query(element, ".fa-pill")).toBeNull();
    expect(query(element, ".fa-fab")).not.toBeNull();
  });

  it("recovers when a connect is cancelled from the header hang-up and can start again", async () => {
    const pending = deferredStart();
    const element = await mount({ "agent-id": "agent_1" });
    await openPanel(element);
    click($(element, ".fa-cta"));
    await tick();
    expect(startMock).toHaveBeenCalledTimes(1);

    // Mid-connect the header shows the call controls; hang-up cancels the attempt.
    click($(element, ".fa-header-end"));
    await tick();
    pending.resolve();
    await tick();

    // Back at rest the close button returns; closing lands on the FAB.
    click($(element, '.fa-icon-btn[aria-label="Close"]'));
    await tick();
    expect(query(element, ".fa-pill")).toBeNull();
    expect(query(element, ".fa-fab")).not.toBeNull();

    await openPanel(element);
    click($(element, ".fa-cta"));
    await tick();
    expect(startMock).toHaveBeenCalledTimes(2);
    expect(query(element, ".fa-transcript")).not.toBeNull();
  });

  it("recovers to the FAB when the pill hang-up fires mid-connect", async () => {
    const pending = deferredStart();
    const element = await mount({ "agent-id": "agent_1" });
    await openPanel(element);
    click($(element, ".fa-cta"));
    await tick();
    click($(element, '.fa-icon-btn[aria-label="Minimize"]'));
    await tick();
    expect(query(element, ".fa-pill")).not.toBeNull();

    click($(element, ".fa-pill .fa-btn-round--danger"));
    await tick();
    pending.resolve();
    await tick();

    expect(query(element, ".fa-pill")).toBeNull();
    expect(query(element, ".fa-fab")).not.toBeNull();

    await openPanel(element);
    click($(element, ".fa-cta"));
    await tick();
    expect(startMock).toHaveBeenCalledTimes(2);
    expect(query(element, ".fa-transcript")).not.toBeNull();
  });

  it("keeps typed messages from an earlier call when a new call reuses segment ids", async () => {
    const element = await mount({ "agent-id": "agent_1" });
    await openPanel(element);
    await typeAndSend(element, "Hello");
    click($(element, ".fa-header-end"));
    await tick();

    // Ended state parks the composer behind the "continue by typing" reveal.
    click($(element, ".fa-link"));
    await tick();
    await typeAndSend(element, "Second");
    const bubbles = element.shadowRoot!.querySelectorAll(".fa-bubble--user");
    expect([...bubbles].map((bubble) => bubble.textContent)).toEqual(["Hello", "Second"]);
  });

  it("expands programmatically on fish-agent:expand", async () => {
    const element = await mount({ "agent-id": "agent_1" });
    // The listener registers in an effect; preact flushes effects on the next
    // animation frame (~16ms in jsdom), so give it a beat.
    await new Promise((resolve) => setTimeout(resolve, 40));
    document.dispatchEvent(new CustomEvent("fish-agent:expand"));
    await tick();
    expect(query(element, ".fa-home-greeting")).not.toBeNull();
  });

  it("applies remote widget config under attributes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ agent_name: "Remote", greeting: "From the dashboard" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    const element = await mount({ "agent-id": "agent_1", "agent-name": "Aria" });
    await tick();
    await openPanel(element);
    expect($(element, ".fa-header-title").textContent).toBe("Aria"); // attribute wins
    expect($(element, ".fa-home-greeting").textContent).toBe("From the dashboard");
  });
});
