import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (payload: never) => void;

const { conversation } = vi.hoisted(() => {
  const conversation = {
    startCalls: [] as Array<Record<string, unknown>>,
    /** Resolves or rejects the pending startSession. */
    settle: undefined as undefined | ((outcome: { id?: string; error?: unknown }) => void),
    sent: [] as string[],
    ended: 0,
    micMuted: false,
    rerender: undefined as undefined | (() => void),
    /** The callbacks of the last started session, to play events through. */
    callbacks(): Record<string, Handler> {
      const last = conversation.startCalls.at(-1);
      return (last?.callbacks ?? {}) as Record<string, Handler>;
    },
  };
  return { conversation };
});

vi.mock("react-native", async () => {
  const React = await import("react");
  const h = React.createElement;
  const a11y = (props: Record<string, unknown>) => ({
    "aria-label": props.accessibilityLabel as string | undefined,
    role: props.accessibilityRole === "alert" ? "alert" : undefined,
  });
  const host =
    (tag: string) =>
    ({ children, ...props }: Record<string, unknown> & { children?: unknown }) =>
      h(tag, a11y(props), children as never);
  const Pressable = ({ children, onPress, disabled, ...props }: Record<string, unknown>) =>
    h(
      "button",
      { ...a11y(props), onClick: onPress as () => void, disabled: disabled as boolean },
      (typeof children === "function" ? (children as (s: unknown) => unknown)({ pressed: false }) : children) as never,
    );
  const Text = ({ children, onPress, ...props }: Record<string, unknown>) =>
    h("span", { ...a11y(props), onClick: onPress as () => void }, children as never);
  const TextInput = ({ value, placeholder, onChangeText, onSubmitEditing, editable }: Record<string, unknown>) =>
    h("input", {
      value: value as string,
      placeholder: placeholder as string,
      disabled: editable === false,
      onChange: (event: { target: { value: string } }) => (onChangeText as (t: string) => void)(event.target.value),
      onKeyDown: (event: { key: string }) => event.key === "Enter" && (onSubmitEditing as () => void)(),
    });
  const ScrollView = React.forwardRef(({ children }: { children?: unknown }, ref) => {
    React.useImperativeHandle(ref, () => ({ scrollToEnd: () => undefined }));
    return h("div", null, children as never);
  });
  class Value {
    setValue() {}
    interpolate() {
      return 0;
    }
  }
  return {
    View: host("div"),
    Text,
    TextInput,
    Pressable,
    ScrollView,
    KeyboardAvoidingView: host("div"),
    Animated: {
      View: host("div"),
      Value,
      loop: () => ({ start() {}, stop() {} }),
      timing: () => ({}),
    },
    Easing: { linear: (t: number) => t, ease: (t: number) => t, out: (f: unknown) => f, inOut: (f: unknown) => f },
    StyleSheet: { create: <T,>(styles: T) => styles, absoluteFill: {}, hairlineWidth: 1 },
    Platform: { OS: "ios", select: (choices: Record<string, unknown>) => choices.ios ?? choices.default },
    AccessibilityInfo: {
      isReduceMotionEnabled: async () => true,
      addEventListener: () => ({ remove() {} }),
    },
    BackHandler: { addEventListener: () => ({ remove() {} }) },
    Linking: { openURL: async () => undefined },
    PermissionsAndroid: {
      PERMISSIONS: { RECORD_AUDIO: "mic" },
      RESULTS: { GRANTED: "granted" },
      check: async () => true,
      request: async () => "granted",
    },
    useColorScheme: () => "light",
    useWindowDimensions: () => ({ width: 390, height: 844 }),
  };
});

vi.mock("react-native-svg", async () => {
  const React = await import("react");
  const stub = () => null;
  return {
    default: ({ children }: { children?: unknown }) => React.createElement("svg", null, children as never),
    Path: stub,
    Line: stub,
    Polyline: stub,
    Circle: stub,
    Defs: stub,
    RadialGradient: stub,
    Stop: stub,
  };
});

vi.mock("@fishaudio/agent-react-native", async () => {
  const React = await import("react");
  return {
    useConversation: () => {
      const [, setTick] = React.useState(0);
      conversation.rerender = () => setTick((n) => n + 1);
      return {
        status: "idle",
        mode: "listening",
        micMuted: conversation.micMuted,
        startSession: (options: Record<string, unknown>) => {
          conversation.startCalls.push(options);
          return new Promise<string>((resolve, reject) => {
            conversation.settle = ({ id, error }) => (error ? reject(error) : resolve(id ?? "sess-1"));
          });
        },
        endSession: async () => {
          conversation.ended += 1;
        },
        sendUserMessage: (text: string) => void conversation.sent.push(text),
        sendUserActivity: () => undefined,
        setMicMuted: async (muted: boolean) => {
          conversation.micMuted = muted;
          conversation.rerender?.();
        },
      };
    },
  };
});

vi.mock("@fishaudio/agent-widget-shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fishaudio/agent-widget-shared")>();
  return { ...actual, fetchRemoteConfig: async () => null };
});

import { DEFAULT_TEXTS, FishAgentWidget } from "../index.js";

const flush = () => act(async () => {});

function openPanel() {
  fireEvent.click(screen.getByLabelText(DEFAULT_TEXTS.openLabel));
}

beforeEach(() => {
  conversation.startCalls = [];
  conversation.settle = undefined;
  conversation.sent = [];
  conversation.ended = 0;
  conversation.micMuted = false;
});

afterEach(cleanup);

describe("FishAgentWidget", () => {
  it("starts a voice call with the public agent options and the app's tools", async () => {
    const tool = vi.fn();
    const onCall = vi.fn((options: Record<string, unknown>) => {
      options.dynamicVariables = { plan: "pro" };
    });
    const onConnect = vi.fn();
    render(
      <FishAgentWidget agentId="agent_1" origin="https://example.com" clientTools={{ tool }} onCall={onCall} onConnect={onConnect} />,
    );
    openPanel();
    fireEvent.click(screen.getByText(DEFAULT_TEXTS.startVoice));
    await flush();

    const options = conversation.startCalls[0]!;
    expect(options).toMatchObject({
      microphone: true,
      agentId: "agent_1",
      origin: "https://example.com",
      clientTools: { tool },
      dynamicVariables: { plan: "pro" },
    });
    expect(onCall).toHaveBeenCalledOnce();

    await act(async () => conversation.settle!({ id: "sess-9" }));
    expect(onConnect).toHaveBeenCalledWith({ sessionId: "sess-9" });
    expect(screen.getByLabelText(DEFAULT_TEXTS.endCallLabel)).toBeTruthy();
  });

  it("asks for consent before the first call and remembers it in the given storage", async () => {
    const storage = { getItem: vi.fn(async () => null), setItem: vi.fn() };
    render(<FishAgentWidget agentId="agent_1" consent consentStorage={storage} />);
    await flush();
    openPanel();
    fireEvent.click(screen.getByText(DEFAULT_TEXTS.startVoice));
    expect(conversation.startCalls).toHaveLength(0);
    expect(screen.getByText(DEFAULT_TEXTS.consentTitle)).toBeTruthy();

    fireEvent.click(screen.getByText(DEFAULT_TEXTS.consentAgree));
    await flush();
    expect(storage.setItem).toHaveBeenCalledWith("fish-agent-consent", "accepted");
    expect(conversation.startCalls).toHaveLength(1);
  });

  it("skips consent when the storage already holds the answer", async () => {
    const storage = { getItem: vi.fn(async () => "accepted"), setItem: vi.fn() };
    render(<FishAgentWidget agentId="agent_1" consent consentStorage={storage} />);
    await flush();
    openPanel();
    fireEvent.click(screen.getByText(DEFAULT_TEXTS.startVoice));
    await flush();
    expect(conversation.startCalls).toHaveLength(1);
  });

  it("starts a text chat without the microphone and sends the first message once live", async () => {
    render(<FishAgentWidget agentId="agent_1" />);
    openPanel();
    const input = screen.getByPlaceholderText(DEFAULT_TEXTS.composerPlaceholder);
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await flush();

    expect(conversation.startCalls[0]).toMatchObject({ microphone: false });
    expect(screen.getByText("hello")).toBeTruthy(); // echoed while connecting
    expect(conversation.sent).toEqual([]);
    await act(async () => conversation.settle!({}));
    expect(conversation.sent).toEqual(["hello"]);
  });

  it("shows nothing when the user hangs up while connecting", async () => {
    const onError = vi.fn();
    render(<FishAgentWidget agentId="agent_1" onError={onError} />);
    openPanel();
    fireEvent.click(screen.getByText(DEFAULT_TEXTS.startVoice));
    await flush();
    fireEvent.click(screen.getByLabelText(DEFAULT_TEXTS.endCallLabel));
    const abort = Object.assign(new Error("Conversation start was cancelled by endSession"), { name: "AbortError" });
    await act(async () => conversation.settle!({ error: abort }));

    expect(conversation.ended).toBe(1);
    expect(onError).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText(DEFAULT_TEXTS.startVoice)).toBeTruthy(); // back home
  });

  it("maps start errors to the mobile wording and reports them", async () => {
    const onError = vi.fn();
    render(<FishAgentWidget agentId="agent_1" onError={onError} />);
    openPanel();
    fireEvent.click(screen.getByText(DEFAULT_TEXTS.startVoice));
    await flush();
    await act(async () =>
      conversation.settle!({ error: Object.assign(new Error("forbidden"), { code: "origin_forbidden" }) }),
    );

    expect(screen.getByRole("alert").textContent).toBe("This app isn't allowed to talk to this agent.");
    expect(onError).toHaveBeenCalledWith({ code: "origin_forbidden", message: "forbidden" });
  });

  it("streams the transcript through the session callbacks and adds a divider when the call ends", async () => {
    const onDisconnect = vi.fn();
    render(<FishAgentWidget agentId="agent_1" onDisconnect={onDisconnect} />);
    openPanel();
    fireEvent.click(screen.getByText(DEFAULT_TEXTS.startVoice));
    await flush();
    const callbacks = conversation.callbacks();
    // Delivered before startSession resolves: nothing may be lost.
    await act(async () => callbacks.onAgentResponseDelta!({ segmentId: "a1", text: "Hi" } as never));
    await act(async () => conversation.settle!({}));
    await act(async () => callbacks.onAgentResponse!({ segmentId: "a1", text: "Hi there" } as never));
    expect(screen.getByText("Hi there")).toBeTruthy();

    await act(async () => callbacks.onDisconnect!({ reason: "agent_left" } as never));
    expect(onDisconnect).toHaveBeenCalledWith({ reason: "agent_left" });
    expect(screen.getByText(`${DEFAULT_TEXTS.endedDividerLabel} · 0:00`)).toBeTruthy();
    expect(screen.getByText(DEFAULT_TEXTS.restartVoice)).toBeTruthy();
  });

  it("keeps the app's own session callbacks working", async () => {
    const onUserTranscript = vi.fn();
    render(
      <FishAgentWidget
        agentId="agent_1"
        onCall={(options) => {
          options.callbacks = { onUserTranscript };
        }}
      />,
    );
    openPanel();
    fireEvent.click(screen.getByText(DEFAULT_TEXTS.startVoice));
    await flush();
    await act(async () => conversation.settle!({}));
    const payload = { segmentId: "u1", text: "yo", final: true };
    await act(async () => conversation.callbacks().onUserTranscript!(payload as never));
    expect(onUserTranscript).toHaveBeenCalledWith(payload);
    expect(screen.getByText("yo")).toBeTruthy();
  });

  it("toggles the microphone from the header pill", async () => {
    render(<FishAgentWidget agentId="agent_1" />);
    openPanel();
    fireEvent.click(screen.getByText(DEFAULT_TEXTS.startVoice));
    await flush();
    await act(async () => conversation.settle!({}));
    fireEvent.click(screen.getByLabelText(DEFAULT_TEXTS.muteLabel));
    await flush();
    expect(conversation.micMuted).toBe(true);
    expect(screen.getByLabelText(DEFAULT_TEXTS.unmuteLabel)).toBeTruthy();
  });

  it("uses the session token provider for private agents", async () => {
    const token = { session_id: "s", livekit_url: "wss://x", livekit_token: "t" };
    render(<FishAgentWidget sessionTokenProvider={async () => token as never} agentId="ignored" />);
    openPanel();
    fireEvent.click(screen.getByText(DEFAULT_TEXTS.startVoice));
    await flush();
    expect(conversation.startCalls[0]).toMatchObject({ sessionToken: token });
    expect(conversation.startCalls[0]!.agentId).toBeUndefined();
  });
});
