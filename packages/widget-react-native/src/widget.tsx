import type {
  AgentSessionCallbacks,
  AgentSessionOptions,
  EndReason,
  FishAgentError,
} from "@fishaudio/agent-client";
import {
  useConversation,
  type AudioOutputRoute,
  type CallNotification,
} from "@fishaudio/agent-react-native";
import {
  errorText,
  fetchRemoteConfig,
  formatTimer,
  resolveSettings,
  TranscriptStore,
  type RemoteWidgetConfig,
  type SessionTokenProvider,
  type WidgetAttributes,
  type WidgetPosition,
  type WidgetSettings,
  type WidgetTextContents,
} from "@fishaudio/agent-widget-shared";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import {
  BackHandler,
  KeyboardAvoidingView,
  PermissionsAndroid,
  Platform,
  StyleSheet,
  useColorScheme,
  useWindowDimensions,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { MOBILE_TEXTS } from "./texts.js";
import { DARK_THEME, LIGHT_THEME, ThemeContext, type WidgetTheme } from "./theme.js";
import { CallView, ConsentView, FabView, HomeView, LiveStatus, MinimizedPill, PanelShell } from "./views.js";

/** `onError` payload. `stage` and `recovered` come with in-call runtime errors that report them. */
export interface FishAgentWidgetErrorDetail {
  code: string;
  message: string;
  stage?: string;
  recovered?: boolean;
}

/**
 * Where the consent answer is remembered, e.g. `@react-native-async-storage/async-storage`.
 * Without one, consent lasts until the app restarts.
 */
export interface ConsentStorage {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
}

export interface WidgetInsets {
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
}

export interface FishAgentWidgetProps {
  /** Public agent id. Exactly one of `agentId` / `sessionTokenProvider` is required. */
  agentId?: string;
  /**
   * @experimental Public agents only: an origin on the agent's allowlist,
   * sent because an app has no web origin of its own. May change or be
   * removed in a minor release; prefer `sessionTokenProvider` in production.
   */
  origin?: string;
  /** Fetches the session token from your backend (private agents); called before every session start. */
  sessionTokenProvider?: SessionTokenProvider;
  serverUrl?: string;
  /** Your end-user identifier, stored on the session. */
  userId?: string;
  language?: AgentSessionOptions["language"];
  dynamicVariables?: Record<string, string>;
  agentName?: string;
  greeting?: string;
  proactiveMessage?: string;
  /** Seconds before the proactive bubble shows (default 3). */
  proactiveDelay?: number;
  transcript?: boolean;
  textInput?: boolean;
  micMuting?: boolean;
  consent?: boolean;
  consentKey?: string;
  consentText?: string;
  termsUrl?: string;
  privacyUrl?: string;
  /** Corner of the floating button (default `bottom-right`). */
  position?: WidgetPosition;
  /** Overrides for any UI string (keys of `DEFAULT_TEXTS`). */
  textContents?: Partial<WidgetTextContents>;
  /** Colors and sizes; any subset, applied over the light or dark defaults. */
  theme?: Partial<WidgetTheme>;
  /** Default `light`, like the web widget. `system` follows the device setting. */
  colorScheme?: "light" | "dark" | "system";
  /** Safe-area insets, e.g. from react-native-safe-area-context's `useSafeAreaInsets()`. */
  insets?: WidgetInsets;
  /** Remembers the consent answer across launches. */
  consentStorage?: ConsentStorage;
  /** Android: the ongoing notification during voice calls (see `useConversation`). */
  callNotification?: CallNotification | false;
  /** Initial audio route (see `useConversation`). */
  audioOutput?: AudioOutputRoute;
  /** Client tools for every session. */
  clientTools?: AgentSessionOptions["clientTools"];
  /** Runs right before a session starts; mutate `options` to adjust anything. */
  onCall?(options: AgentSessionOptions): void;
  onConnect?(event: { sessionId: string }): void;
  onDisconnect?(event: { reason: EndReason }): void;
  onError?(event: FishAgentWidgetErrorDetail): void;
  /** Style of the full-screen overlay the widget positions itself in. */
  style?: StyleProp<ViewStyle>;
}

export interface FishAgentWidgetHandle {
  /** Opens the panel, as tapping the floating button does. */
  expand(): void;
}

type WidgetPhase = "idle" | "starting" | "live" | "ended";
type PendingAction = { kind: "voice" } | { kind: "text"; text: string };

/** Panels wider than this screen are cards in a corner; narrower screens get a full-screen sheet. */
const SHEET_BELOW_WIDTH = 600;
const CARD_WIDTH = 380;
const CARD_MAX_HEIGHT = 600;

/** The proactive bubble stays dismissed for the rest of the app's run, like the web's sessionStorage. */
let proactiveDismissed = false;

type Handler = (payload: never) => void;

/**
 * Receives the session's events through the `callbacks` option, which the
 * client subscribes before connecting, so not even the first transcript
 * delta is missed while React publishes the session.
 */
class CallbackBridge {
  readonly #handlers = new Map<string, Set<Handler>>();

  on(event: string, handler: Handler): this {
    let set = this.#handlers.get(event);
    if (!set) {
      set = new Set();
      this.#handlers.set(event, set);
    }
    set.add(handler);
    return this;
  }

  off(event: string, handler: Handler): this {
    this.#handlers.get(event)?.delete(handler);
    return this;
  }

  emit(event: string, payload: unknown): void {
    for (const handler of this.#handlers.get(event) ?? []) {
      handler(payload as never);
    }
  }
}

const BRIDGED_EVENTS = [
  "userTranscript",
  "agentResponseDelta",
  "agentResponse",
  "toolCallStarted",
  "toolCallCompleted",
  "toolCallFailed",
] as const;

function mergeCallbacks(
  ours: Partial<AgentSessionCallbacks>,
  theirs: Partial<AgentSessionCallbacks> | undefined,
): Partial<AgentSessionCallbacks> {
  const merged: Record<string, (payload: never) => void> = { ...(ours as Record<string, Handler>) };
  for (const [key, callback] of Object.entries(theirs ?? {})) {
    if (typeof callback !== "function") {
      continue;
    }
    const own = merged[key];
    merged[key] = own
      ? (payload: never) => {
          own(payload);
          (callback as Handler)(payload);
        }
      : (callback as Handler);
  }
  return merged as Partial<AgentSessionCallbacks>;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function ensureMicrophonePermission(): Promise<boolean> {
  if (Platform.OS !== "android") {
    return true;
  }
  const permission = PermissionsAndroid.PERMISSIONS.RECORD_AUDIO;
  if (await PermissionsAndroid.check(permission)) {
    return true;
  }
  return (await PermissionsAndroid.request(permission)) === PermissionsAndroid.RESULTS.GRANTED;
}

/**
 * The Fish Audio voice-agent widget for React Native: a floating button that
 * opens a call panel with live transcript, text input, mute and consent, the
 * counterpart of the web `<fish-agent>` element. Render it last in your root
 * view so it floats above the app; it fills the screen without blocking
 * touches outside its button and panel.
 */
export const FishAgentWidget = forwardRef<FishAgentWidgetHandle, FishAgentWidgetProps>(
  function FishAgentWidget(props, ref) {
    const propsRef = useRef(props);
    propsRef.current = props;

    const systemScheme = useColorScheme();
    const scheme = props.colorScheme === "system" ? (systemScheme ?? "light") : (props.colorScheme ?? "light");
    const theme = useMemo<WidgetTheme>(
      () => ({ ...(scheme === "dark" ? DARK_THEME : LIGHT_THEME), ...props.theme }),
      [scheme, props.theme],
    );

    const [remote, setRemote] = useState<RemoteWidgetConfig | null>(null);
    const attributes: WidgetAttributes = {
      agentId: props.agentId,
      serverUrl: props.serverUrl,
      userId: props.userId,
      language: props.language,
      dynamicVariables: props.dynamicVariables,
      agentName: props.agentName,
      greeting: props.greeting,
      proactiveMessage: props.proactiveMessage,
      proactiveDelaySeconds: props.proactiveDelay,
      transcript: props.transcript,
      textInput: props.textInput,
      micMuting: props.micMuting,
      consent: props.consent,
      consentKey: props.consentKey,
      consentText: props.consentText,
      termsUrl: props.termsUrl,
      privacyUrl: props.privacyUrl,
      position: props.position,
      texts: props.textContents,
    };
    const settings: WidgetSettings = resolveSettings(attributes, remote);
    for (const [key, value] of Object.entries(MOBILE_TEXTS) as [keyof WidgetTextContents, string][]) {
      if (remote?.text_contents?.[key] === undefined && props.textContents?.[key] === undefined) {
        settings.texts[key] = value;
      }
    }
    const { texts } = settings;

    const conversation = useConversation(
      {},
      { callNotification: props.callNotification, audioOutput: props.audioOutput },
    );

    const [open, setOpen] = useState(false);
    const [phase, setPhase] = useState<WidgetPhase>("idle");
    const [pending, setPending] = useState<PendingAction | null>(null);
    const [seconds, setSeconds] = useState(0);
    const [error, setError] = useState<string | null>(null);
    /** First typed message, echoed into the transcript while the session starts. */
    const [pendingText, setPendingText] = useState<string | null>(null);
    const [proactiveVisible, setProactiveVisible] = useState(false);

    const storeRef = useRef<TranscriptStore>(null);
    storeRef.current ??= new TranscriptStore();
    const store = storeRef.current;
    const [entries, setEntries] = useState(store.entries);
    const secondsRef = useRef(0);
    /** The bridge of the call on screen; events from any other session are stale. */
    const liveRef = useRef<CallbackBridge | null>(null);
    const detachRef = useRef<(() => void) | null>(null);
    const attemptRef = useRef<{ cancelled: boolean } | null>(null);
    const startingRef = useRef(false);
    const consentAcceptedRef = useRef(false);
    const lastActivityRef = useRef(0);

    useImperativeHandle(ref, () => ({ expand: () => setOpen(true) }), []);

    useEffect(() => store.subscribe(() => setEntries(store.entries)), [store]);

    // Operator-managed config for public agents; props win.
    useEffect(() => {
      const agentId = props.agentId;
      if (!agentId) {
        return;
      }
      let stale = false;
      void fetchRemoteConfig(props.serverUrl, agentId).then((config) => {
        if (!stale && config) {
          setRemote(config);
        }
      });
      return () => {
        stale = true;
      };
    }, [props.agentId, props.serverUrl]);

    // A remembered consent answer, read once the key is known.
    useEffect(() => {
      const storage = props.consentStorage;
      if (!settings.consent || !storage) {
        return;
      }
      let stale = false;
      void Promise.resolve()
        .then(() => storage.getItem(settings.consentKey))
        .then((value) => {
          if (!stale && value === "accepted") {
            consentAcceptedRef.current = true;
          }
        })
        .catch(() => undefined);
      return () => {
        stale = true;
      };
    }, [settings.consent, settings.consentKey, props.consentStorage]);

    // Proactive bubble: appears after the configured delay until opened or dismissed.
    useEffect(() => {
      if (open || !settings.proactiveMessage || proactiveDismissed) {
        setProactiveVisible(false);
        return;
      }
      const timer = setTimeout(() => setProactiveVisible(true), settings.proactiveDelaySeconds * 1000);
      return () => clearTimeout(timer);
    }, [open, settings.proactiveMessage, settings.proactiveDelaySeconds]);

    // Live call timer.
    useEffect(() => {
      if (phase !== "live") {
        return;
      }
      setSeconds(0);
      secondsRef.current = 0;
      const startedAt = Date.now();
      const timer = setInterval(() => {
        const elapsed = Math.floor((Date.now() - startedAt) / 1000);
        secondsRef.current = elapsed;
        setSeconds(elapsed);
      }, 500);
      return () => clearInterval(timer);
    }, [phase]);

    // Android back button minimizes the open panel instead of leaving the screen.
    useEffect(() => {
      if (!open) {
        return;
      }
      const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
        setOpen(false);
        return true;
      });
      return () => subscription.remove();
    }, [open]);

    // On unmount useConversation ends the call; only the store needs detaching.
    useEffect(
      () => () => {
        if (attemptRef.current) {
          attemptRef.current.cancelled = true;
        }
        detachRef.current?.();
      },
      [],
    );

    const reportError = (detail: FishAgentWidgetErrorDetail) => propsRef.current.onError?.(detail);

    const needsConsent = (): boolean => settings.consent && !consentAcceptedRef.current;

    /** Resting phase once no call is in flight: keep the transcript view if history exists. */
    const restingPhase = (): WidgetPhase => (store.entries.length > 0 ? "ended" : "idle");

    const startCall = async (kind: "voice" | "text", firstText?: string) => {
      // `phase` is a render snapshot; the in-flight gate must be a ref so a
      // double tap cannot start two sessions.
      if (startingRef.current || liveRef.current || phase === "starting" || phase === "live") {
        return;
      }
      startingRef.current = true;
      setError(null);
      setPendingText(firstText ?? null);
      setPhase("starting");
      const attempt = { cancelled: false };
      attemptRef.current = attempt;
      const bridge = new CallbackBridge();

      try {
        const current = propsRef.current;
        const options: AgentSessionOptions = { microphone: kind === "voice" };
        if (current.sessionTokenProvider) {
          options.sessionToken = await current.sessionTokenProvider();
        } else if (settings.agentId) {
          options.agentId = settings.agentId;
          if (current.origin) {
            options.origin = current.origin;
          }
          if (settings.serverUrl) {
            options.serverUrl = settings.serverUrl;
          }
          if (settings.language) {
            options.language = settings.language as AgentSessionOptions["language"];
          }
          if (settings.dynamicVariables) {
            options.dynamicVariables = settings.dynamicVariables;
          }
          if (settings.userId) {
            options.endUserId = settings.userId;
          }
        } else {
          console.error("[fish-agent] set agentId or sessionTokenProvider to start a session");
          throw new Error("missing configuration");
        }
        if (attempt.cancelled) {
          throw Object.assign(new Error("cancelled"), { name: "AbortError" });
        }
        if (current.clientTools) {
          options.clientTools = current.clientTools;
        }
        // The app may adjust anything (tools, variables, callbacks) here.
        current.onCall?.(options);

        const ours: Partial<AgentSessionCallbacks> = {
          onDisconnect: ({ reason }: { reason: EndReason }) => {
            if (liveRef.current !== bridge) {
              return; // a cancelled or superseded session must not touch the call on screen
            }
            liveRef.current = null;
            detachRef.current?.();
            detachRef.current = null;
            store.pushDivider(`${texts.endedDividerLabel} · ${formatTimer(secondsRef.current)}`);
            setPhase("ended");
            propsRef.current.onDisconnect?.({ reason });
          },
          onError: (sessionError: FishAgentError) => {
            if (liveRef.current !== bridge) {
              return;
            }
            // A failure the agent is already recovering from is not a broken call: no banner.
            if (sessionError.recovered !== true) {
              setError(errorText(texts, sessionError.code));
            }
            reportError({
              code: sessionError.code,
              message: sessionError.message,
              ...(sessionError.stage !== undefined ? { stage: sessionError.stage } : {}),
              ...(sessionError.recovered !== undefined ? { recovered: sessionError.recovered } : {}),
            });
          },
        };
        for (const event of BRIDGED_EVENTS) {
          const key = `on${event.charAt(0).toUpperCase()}${event.slice(1)}` as keyof AgentSessionCallbacks;
          (ours as Record<string, Handler>)[key] = (payload: never) => bridge.emit(event, payload);
        }
        options.callbacks = mergeCallbacks(ours, options.callbacks);
        detachRef.current?.();
        detachRef.current = store.attach(bridge as unknown as Parameters<TranscriptStore["attach"]>[0]);

        const sessionId = await conversation.startSession(options);
        if (attempt.cancelled) {
          throw Object.assign(new Error("cancelled"), { name: "AbortError" });
        }
        liveRef.current = bridge;
        setPendingText(null);
        setPhase("live");
        if (firstText) {
          conversation.sendUserMessage(firstText);
        }
        propsRef.current.onConnect?.({ sessionId });
      } catch (startError) {
        if (liveRef.current !== bridge) {
          detachRef.current?.();
          detachRef.current = null;
        }
        setPendingText(null);
        setPhase(restingPhase());
        if (attempt.cancelled || isAbort(startError)) {
          return; // hung up while connecting: not an error
        }
        const code = (startError as { code?: string }).code;
        setError(errorText(texts, code));
        reportError({
          code: code ?? "connection_failed",
          message: startError instanceof Error ? startError.message : String(startError),
        });
      } finally {
        startingRef.current = false;
        if (attemptRef.current === attempt) {
          attemptRef.current = null;
        }
      }
    };

    const gate = (action: PendingAction) => {
      if (needsConsent()) {
        setPending(action);
        return;
      }
      void startCall(action.kind, action.kind === "text" ? action.text : undefined);
    };

    const requestVoice = () => gate({ kind: "voice" });

    const requestText = (text: string) => {
      if (phase === "live" && liveRef.current) {
        conversation.sendUserMessage(text);
        return;
      }
      gate({ kind: "text", text });
    };

    const agreeConsent = () => {
      consentAcceptedRef.current = true;
      const storage = propsRef.current.consentStorage;
      if (storage) {
        void Promise.resolve()
          .then(() => storage.setItem(settings.consentKey, "accepted"))
          .catch(() => undefined);
      }
      const action = pending;
      setPending(null);
      if (action) {
        void startCall(action.kind, action.kind === "text" ? action.text : undefined);
      }
    };

    const toggleMute = async () => {
      if (!liveRef.current) {
        return;
      }
      const next = !conversation.micMuted;
      try {
        // A text chat joins muted without the microphone permission.
        if (!next && !(await ensureMicrophonePermission())) {
          setError(texts.errorMicDenied);
          reportError({ code: "mic_permission_denied", message: "Microphone permission was denied" });
          return;
        }
        await conversation.setMicMuted(next);
        setError(null);
      } catch (muteError) {
        const code = (muteError as { code?: string }).code;
        if (code === "mic_permission_denied") {
          setError(texts.errorMicDenied);
        }
        reportError({
          code: code ?? "connection_failed",
          message: muteError instanceof Error ? muteError.message : String(muteError),
        });
      }
    };

    const endCall = () => {
      if (attemptRef.current) {
        attemptRef.current.cancelled = true;
      }
      void conversation.endSession().catch(() => undefined);
    };

    const closePanel = () => {
      endCall();
      setError(null);
      setPending(null);
      setOpen(false);
    };

    const dismissProactive = () => {
      proactiveDismissed = true;
      setProactiveVisible(false);
    };

    const onActivity = () => {
      if (phase !== "live") {
        return;
      }
      const now = Date.now();
      if (now - lastActivityRef.current > 1500) {
        lastActivityRef.current = now;
        conversation.sendUserActivity();
      }
    };

    const screen = useWindowDimensions();
    const insets = props.insets ?? {};
    const top = settings.position.startsWith("top");
    const alignEnd = settings.position.endsWith("right");
    const corner: ViewStyle = {
      position: "absolute",
      [top ? "top" : "bottom"]: theme.offset + ((top ? insets.top : insets.bottom) ?? 0),
      [alignEnd ? "right" : "left"]: theme.offset + ((alignEnd ? insets.right : insets.left) ?? 0),
    };

    let content;
    if (!open) {
      content =
        phase === "live" || phase === "starting" ? (
          <View style={corner}>
            <MinimizedPill
              settings={settings}
              seconds={seconds}
              live={phase === "live"}
              onExpand={() => setOpen(true)}
              onEnd={endCall}
            />
          </View>
        ) : (
          <View style={corner}>
            <FabView
              settings={settings}
              proactiveVisible={proactiveVisible}
              alignEnd={alignEnd}
              onOpen={() => setOpen(true)}
              onDismissProactive={dismissProactive}
            />
          </View>
        );
    } else {
      const reconnecting = conversation.status === "reconnecting";
      const status =
        phase === "starting" ? (
          <LiveStatus label={texts.statusConnecting} color={theme.textSecondary} />
        ) : phase === "live" ? (
          reconnecting ? (
            <LiveStatus label={texts.statusReconnecting} color={theme.textSecondary} />
          ) : (
            <LiveStatus
              label={`${texts.statusLive} · ${formatTimer(seconds)}`}
              color={theme.textSecondary}
              dot={theme.live}
            />
          )
        ) : phase === "ended" ? (
          <LiveStatus label={texts.statusEnded} color={theme.textSecondary} />
        ) : null;

      const inCall = phase !== "idle" && pending === null;
      const sheet = screen.width < SHEET_BELOW_WIDTH;
      const callHeight = Math.min(CARD_MAX_HEIGHT, screen.height - 2 * theme.offset - (insets.top ?? 0) - (insets.bottom ?? 0));
      const panelStyle: StyleProp<ViewStyle> = sheet
        ? { flex: 1 }
        : [
            styles.card,
            { width: CARD_WIDTH, borderRadius: theme.radius, maxHeight: callHeight },
            inCall && settings.transcript ? { height: callHeight } : null,
          ];

      const panel = (
        <PanelShell
          settings={settings}
          status={status}
          mode={phase === "live" ? conversation.mode : undefined}
          live={phase === "live"}
          starting={phase === "starting"}
          muted={conversation.micMuted}
          onToggleMute={() => void toggleMute()}
          onEnd={endCall}
          onMinimize={() => setOpen(false)}
          onClose={closePanel}
          style={panelStyle}
        >
          {pending !== null ? (
            <ConsentView settings={settings} fill={sheet} onAgree={agreeConsent} onDecline={() => setPending(null)} />
          ) : phase === "idle" ? (
            <HomeView settings={settings} fill={sheet} error={error} onStartVoice={requestVoice} onSendText={requestText} />
          ) : (
            <CallView
              settings={settings}
              entries={
                pendingText !== null && phase === "starting"
                  ? [...entries, { kind: "message", id: "pending:first", role: "user", text: pendingText, final: true }]
                  : entries
              }
              phase={phase}
              mode={conversation.mode}
              error={error}
              onRestartVoice={requestVoice}
              onSendText={requestText}
              onActivity={onActivity}
            />
          )}
        </PanelShell>
      );

      content = sheet ? (
        // Insets on an outer view: KeyboardAvoidingView sets its own paddingBottom.
        <View
          style={[
            StyleSheet.absoluteFill,
            {
              backgroundColor: theme.background,
              paddingTop: insets.top ?? 0,
              paddingBottom: insets.bottom ?? 0,
              paddingLeft: insets.left ?? 0,
              paddingRight: insets.right ?? 0,
            },
          ]}
        >
          <KeyboardAvoidingView behavior="padding" style={styles.fill}>
            {panel}
          </KeyboardAvoidingView>
        </View>
      ) : (
        <KeyboardAvoidingView behavior="padding" style={corner}>
          {panel}
        </KeyboardAvoidingView>
      );
    }

    return (
      <ThemeContext.Provider value={theme}>
        <View pointerEvents="box-none" style={[StyleSheet.absoluteFill, props.style]}>
          {content}
        </View>
      </ThemeContext.Provider>
    );
  },
);

const styles = StyleSheet.create({
  fill: { flex: 1 },
  card: {
    borderWidth: 1,
    shadowColor: "#0f0e0d",
    shadowOpacity: 0.18,
    shadowRadius: 48,
    shadowOffset: { width: 0, height: 16 },
    elevation: 16,
  },
});
