import {
  AgentSession,
  type AgentMode,
  type AgentSessionOptions,
  type EndReason,
} from "@fishaudio/agent-client";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  parseAttributes,
  resolveSettings,
  type RemoteWidgetConfig,
  type SessionTokenProvider,
  type WidgetAttributes,
  type WidgetSettings,
} from "./config.js";
import {
  errorText as sharedErrorText,
  fetchRemoteConfig,
  TranscriptStore,
} from "@fishaudio/agent-widget-shared";
import {
  CallView,
  ConsentView,
  FabView,
  formatTimer,
  HomeView,
  MinimizedPill,
  PanelShell,
} from "./views.js";

export interface FishAgentWidgetProps {
  host: HTMLElement & { sessionTokenProvider?: SessionTokenProvider };
  attributes: WidgetAttributes;
}

type WidgetPhase = "idle" | "starting" | "live" | "ended";

type PendingAction = { kind: "voice" } | { kind: "text"; text: string };

const PROACTIVE_DISMISSED_KEY = "fish-agent-proactive-dismissed";

function storageGet(storage: () => Storage, key: string): string | null {
  try {
    return storage().getItem(key);
  } catch {
    return null;
  }
}

function storageSet(storage: () => Storage, key: string, value: string): void {
  try {
    storage().setItem(key, value);
  } catch {
    // storage unavailable (private mode / sandbox) — proceed without memory
  }
}

export function FishAgentWidget({ host, attributes }: FishAgentWidgetProps) {
  const [remote, setRemote] = useState<RemoteWidgetConfig | null>(null);
  const settings: WidgetSettings = useMemo(
    () => resolveSettings(attributes, remote),
    [attributes, remote],
  );
  const { texts } = settings;

  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<WidgetPhase>("idle");
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [mode, setMode] = useState<AgentMode>("listening");
  const [muted, setMuted] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  /** First typed message, echoed into the transcript while the session starts. */
  const [pendingText, setPendingText] = useState<string | null>(null);
  const [proactiveVisible, setProactiveVisible] = useState(false);

  const sessionRef = useRef<AgentSession | null>(null);
  /** Live timer value for the disconnect handler — `seconds` there is a stale closure. */
  const secondsRef = useRef(0);
  const storeRef = useRef<TranscriptStore>();
  storeRef.current ??= new TranscriptStore();
  const store = storeRef.current;
  const [entries, setEntries] = useState(store.entries);
  const detachRef = useRef<(() => void) | null>(null);
  const attemptRef = useRef<{ cancelled: boolean } | null>(null);
  const startingRef = useRef(false);
  const consentAcceptedRef = useRef(false);
  const lastActivityRef = useRef(0);

  useEffect(() => store.subscribe(() => setEntries(store.entries)), [store]);

  // Operator-managed config for public agents; attributes win.
  useEffect(() => {
    const agentId = attributes.agentId;
    if (!agentId) {
      return;
    }
    let stale = false;
    void fetchRemoteConfig(attributes.serverUrl, agentId).then((config) => {
      if (!stale && config) {
        setRemote(config);
      }
    });
    return () => {
      stale = true;
    };
  }, [attributes.agentId, attributes.serverUrl]);

  // Programmatic expansion: `fish-agent:expand` on the element or the document.
  useEffect(() => {
    const expand = () => setOpen(true);
    host.addEventListener("fish-agent:expand", expand);
    document.addEventListener("fish-agent:expand", expand);
    return () => {
      host.removeEventListener("fish-agent:expand", expand);
      document.removeEventListener("fish-agent:expand", expand);
    };
  }, [host]);

  // Proactive bubble: appears after the configured delay until opened/dismissed.
  useEffect(() => {
    if (open || !settings.proactiveMessage) {
      setProactiveVisible(false);
      return;
    }
    if (storageGet(() => sessionStorage, PROACTIVE_DISMISSED_KEY) === "1") {
      return;
    }
    const timer = setTimeout(
      () => setProactiveVisible(true),
      settings.proactiveDelaySeconds * 1000,
    );
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

  // End the call when the element is removed from the page. A start still in
  // flight is cancelled so its session ends instead of leaking a live room.
  useEffect(
    () => () => {
      if (attemptRef.current) {
        attemptRef.current.cancelled = true;
      }
      void sessionRef.current?.end();
      detachRef.current?.();
    },
    [],
  );

  const emit = (name: string, detail?: unknown) => {
    host.dispatchEvent(
      new CustomEvent(`fish-agent:${name}`, { detail, bubbles: true, composed: true }),
    );
  };

  const errorText = (code: string | undefined): string => sharedErrorText(texts, code);

  const needsConsent = (): boolean => {
    if (!settings.consent || consentAcceptedRef.current) {
      return false;
    }
    return storageGet(() => localStorage, settings.consentKey) !== "accepted";
  };

  /** Resting phase once no call is in flight: keep the transcript view if history exists. */
  const restingPhase = (): WidgetPhase => (store.entries.length > 0 ? "ended" : "idle");

  const startCall = async (kind: "voice" | "text", firstText?: string) => {
    // `phase` is a render snapshot — submits landing before the state commit
    // all see "idle", so the in-flight gate must be a ref checked synchronously
    // (key auto-repeat during the lazy livekit import can otherwise mint
    // several sessions).
    if (startingRef.current || sessionRef.current || phase === "starting" || phase === "live") {
      return;
    }
    startingRef.current = true;
    setError(null);
    setPendingText(firstText ?? null);
    setPhase("starting");
    const attempt = { cancelled: false };
    attemptRef.current = attempt;

    try {
      const options: AgentSessionOptions = { microphone: kind === "voice" };
      if (host.sessionTokenProvider) {
        options.sessionToken = await host.sessionTokenProvider();
      } else if (settings.agentId) {
        options.agentId = settings.agentId;
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
        console.error(
          "[fish-agent] set agent-id or sessionTokenProvider to start a session",
        );
        throw new Error("missing configuration");
      }

      // The host page may mutate `detail.options` (clientTools,
      // overrides, dynamic variables, …) before the session starts.
      emit("call", { options });

      const session = await AgentSession.start(options);
      if (attempt.cancelled) {
        // Cancelled mid-connect: without the phase reset the "starting" guard
        // above would block every future call until remount.
        void session.end();
        setPendingText(null);
        setPhase(restingPhase());
        return;
      }
      sessionRef.current = session;
      detachRef.current = store.attach(session);
      session.on("modeChange", setMode);
      session.on("statusChange", (status) => setReconnecting(status === "reconnecting"));
      session.on("disconnect", ({ reason }: { reason: EndReason }) => {
        if (sessionRef.current !== session) {
          return; // a superseded session's exit must not tear down the live one
        }
        detachRef.current?.();
        detachRef.current = null;
        sessionRef.current = null;
        store.pushDivider(`${texts.endedDividerLabel} · ${formatTimer(secondsRef.current)}`);
        setPhase("ended");
        setReconnecting(false);
        setMode("listening");
        emit("disconnect", { reason });
      });
      session.on("error", (sessionError) => {
        // A failure the agent is already recovering from on its own is not a
        // broken call, so no banner for it. The host page still hears about it.
        if (sessionError.recovered !== true) {
          setError(
            sessionError.code === "mic_permission_denied"
              ? texts.errorMicDenied
              : errorText(sessionError.code),
          );
        }
        emit("error", {
          code: sessionError.code,
          message: sessionError.message,
          ...(sessionError.stage !== undefined ? { stage: sessionError.stage } : {}),
          ...(sessionError.recovered !== undefined ? { recovered: sessionError.recovered } : {}),
        });
      });
      setMuted(session.micMuted);
      setPendingText(null);
      setPhase("live");
      void session.startAudio().catch(() => {});
      if (firstText) {
        session.sendUserMessage(firstText);
      }
      emit("connect", { sessionId: session.sessionId });
    } catch (startError) {
      if (attempt.cancelled) {
        setPendingText(null);
        setPhase(restingPhase());
        return;
      }
      const code = (startError as { code?: string }).code;
      setError(errorText(code));
      setPendingText(null);
      setPhase(restingPhase());
      emit("error", {
        code: code ?? "connection_failed",
        message: startError instanceof Error ? startError.message : String(startError),
      });
    } finally {
      startingRef.current = false;
      attemptRef.current = null;
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
    const session = sessionRef.current;
    if (phase === "live" && session) {
      session.sendUserMessage(text);
      return;
    }
    gate({ kind: "text", text });
  };

  const agreeConsent = () => {
    consentAcceptedRef.current = true;
    storageSet(() => localStorage, settings.consentKey, "accepted");
    const action = pending;
    setPending(null);
    if (action) {
      void startCall(action.kind, action.kind === "text" ? action.text : undefined);
    }
  };

  const toggleMute = async () => {
    const session = sessionRef.current;
    if (!session) {
      return;
    }
    try {
      await session.setMicMuted(!session.micMuted);
      setMuted(session.micMuted);
      setError(null);
    } catch (muteError) {
      const code = (muteError as { code?: string }).code;
      if (code === "mic_permission_denied") {
        setError(texts.errorMicDenied);
      }
      emit("error", {
        code: code ?? "connection_failed",
        message: muteError instanceof Error ? muteError.message : String(muteError),
      });
    }
  };

  const endCall = () => {
    if (attemptRef.current) {
      attemptRef.current.cancelled = true;
    }
    void sessionRef.current?.end();
  };

  const closePanel = () => {
    endCall();
    setError(null);
    setPending(null);
    setOpen(false);
  };

  const dismissProactive = () => {
    storageSet(() => sessionStorage, PROACTIVE_DISMISSED_KEY, "1");
    setProactiveVisible(false);
  };

  const onActivity = () => {
    const session = sessionRef.current;
    if (phase !== "live" || !session) {
      return;
    }
    const now = Date.now();
    if (now - lastActivityRef.current > 1500) {
      lastActivityRef.current = now;
      session.sendUserActivity();
    }
  };

  if (!open) {
    if (phase === "live" || phase === "starting") {
      return (
        <div class="fa-root">
          <MinimizedPill
            settings={settings}
            session={sessionRef.current}
            seconds={seconds}
            onExpand={() => setOpen(true)}
            onEnd={endCall}
          />
        </div>
      );
    }
    return (
      <div class="fa-root">
        <FabView
          settings={settings}
          proactiveVisible={proactiveVisible}
          onOpen={() => setOpen(true)}
          onDismissProactive={dismissProactive}
        />
      </div>
    );
  }

  const status =
    phase === "starting" ? (
      texts.statusConnecting
    ) : phase === "live" ? (
      reconnecting ? (
        texts.statusReconnecting
      ) : (
        <>
          <span class="fa-live-dot" aria-hidden="true" />
          {`${texts.statusLive} · ${formatTimer(seconds)}`}
        </>
      )
    ) : phase === "ended" ? (
      texts.statusEnded
    ) : null;

  const inCall = phase !== "idle" && pending === null;

  return (
    <div class="fa-root">
      <PanelShell
        settings={settings}
        status={status}
        mode={phase === "live" ? mode : undefined}
        session={sessionRef.current}
        call={inCall && settings.transcript}
        live={phase === "live"}
        starting={phase === "starting"}
        muted={muted}
        onToggleMute={() => void toggleMute()}
        onEnd={endCall}
        onMinimize={() => setOpen(false)}
        onClose={closePanel}
      >
        {pending !== null ? (
          <ConsentView settings={settings} onAgree={agreeConsent} onDecline={() => setPending(null)} />
        ) : phase === "idle" ? (
          <HomeView
            settings={settings}
            error={error}
            onStartVoice={requestVoice}
            onSendText={requestText}
          />
        ) : (
          <CallView
            settings={settings}
            session={sessionRef.current}
            entries={
              pendingText !== null && phase === "starting"
                ? [
                    ...entries,
                    { kind: "message", id: "pending:first", role: "user", text: pendingText, final: true },
                  ]
                : entries
            }
            phase={phase}
            mode={mode}
            error={error}
            onRestartVoice={requestVoice}
            onSendText={requestText}
            onActivity={onActivity}
          />
        )}
      </PanelShell>
    </div>
  );
}

export { parseAttributes };
