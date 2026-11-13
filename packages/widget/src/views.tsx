import type { AgentMode, AgentSession } from "@fishaudio/agent-client";
import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { WidgetSettings } from "./config.js";
import {
  IconAudioLines,
  IconMic,
  IconMicOff,
  IconMinimize,
  IconPhone,
  IconPhoneOff,
  IconX,
} from "./icons.js";
import { formatTimer, type TranscriptEntry } from "@fishaudio/agent-widget-shared";
import { Composer, Orb, Transcript, Waveform } from "./parts.js";

export { formatTimer };

interface FabViewProps {
  settings: WidgetSettings;
  proactiveVisible: boolean;
  onOpen(): void;
  onDismissProactive(): void;
}

export function FabView({ settings, proactiveVisible, onOpen, onDismissProactive }: FabViewProps) {
  return (
    <div class="fa-collapsed">
      {proactiveVisible && settings.proactiveMessage ? (
        <div class="fa-proactive">
          {settings.proactiveMessage}
          <button
            type="button"
            class="fa-proactive-dismiss"
            aria-label={settings.texts.dismissLabel}
            onClick={onDismissProactive}
          >
            <IconX size={11} />
          </button>
        </div>
      ) : null}
      <button type="button" class="fa-fab" aria-label={settings.texts.openLabel} onClick={onOpen}>
        <IconAudioLines size={26} />
      </button>
    </div>
  );
}

interface PanelShellProps {
  settings: WidgetSettings;
  status: ComponentChildren;
  mode?: AgentMode;
  session?: AgentSession | null;
  call?: boolean;
  /** Live call: the header swaps close for the mute pill + hang-up (Calling top-bar style). */
  live?: boolean;
  starting?: boolean;
  muted?: boolean;
  onToggleMute?(): void;
  onEnd?(): void;
  onMinimize(): void;
  onClose(): void;
  children: ComponentChildren;
}

export function PanelShell({
  settings,
  status,
  mode,
  session,
  call,
  live,
  starting,
  muted,
  onToggleMute,
  onEnd,
  onMinimize,
  onClose,
  children,
}: PanelShellProps) {
  const { texts } = settings;
  const inCall = live || starting;
  return (
    <div class={`fa-panel${call ? " fa-panel--call" : ""}`}>
      <div class="fa-header">
        <div class="fa-header-left">
          <Orb size={32} mode={mode} session={session} />
          <div class="fa-header-names">
            <div class="fa-header-title">{settings.agentName}</div>
            {status != null ? <div class="fa-header-status">{status}</div> : null}
          </div>
        </div>
        <div class="fa-header-actions">
          <button type="button" class="fa-icon-btn" aria-label={texts.minimizeLabel} onClick={onMinimize}>
            <IconMinimize size={15} />
          </button>
          {inCall ? (
            <>
              {settings.micMuting ? (
                <button
                  type="button"
                  class={`fa-header-pill${muted ? " fa-header-pill--muted" : ""}`}
                  aria-label={muted ? texts.unmuteLabel : texts.muteLabel}
                  aria-pressed={muted}
                  disabled={!live}
                  onClick={onToggleMute}
                >
                  {muted ? <IconMic size={12} /> : <IconMicOff size={12} />}
                  {muted ? texts.unmuteShort : texts.muteShort}
                </button>
              ) : null}
              <button
                type="button"
                class="fa-header-end"
                aria-label={texts.endCallLabel}
                onClick={onEnd}
              >
                <IconPhoneOff size={14} />
              </button>
            </>
          ) : (
            <button type="button" class="fa-icon-btn" aria-label={texts.closeLabel} onClick={onClose}>
              <IconX size={15} />
            </button>
          )}
        </div>
      </div>
      {children}
      <div class="fa-footer">
        <a href="https://fish.audio" target="_blank" rel="noopener noreferrer">
          {texts.poweredBy}
        </a>
      </div>
    </div>
  );
}

interface HomeViewProps {
  settings: WidgetSettings;
  error: string | null;
  onStartVoice(): void;
  onSendText(text: string): void;
}

export function HomeView({ settings, error, onStartVoice, onSendText }: HomeViewProps) {
  const { texts } = settings;
  return (
    <>
      <div class="fa-home">
        <Orb size={72} />
        <div class="fa-home-greeting">{texts.greeting}</div>
        <div class="fa-home-hint">{settings.textInput ? texts.homeHint : texts.startVoice}</div>
        <button type="button" class="fa-cta" onClick={onStartVoice}>
          <IconPhone size={16} />
          {texts.startVoice}
        </button>
      </div>
      {error ? <div class="fa-error">{error}</div> : null}
      {settings.textInput ? (
        <Composer
          placeholder={texts.composerPlaceholder}
          sendLabel={texts.sendLabel}
          onSend={onSendText}
        />
      ) : null}
    </>
  );
}

interface ConsentViewProps {
  settings: WidgetSettings;
  onAgree(): void;
  onDecline(): void;
}

export function ConsentView({ settings, onAgree, onDecline }: ConsentViewProps) {
  const { texts } = settings;
  return (
    <div class="fa-consent">
      <div class="fa-consent-title">{texts.consentTitle}</div>
      <div class="fa-consent-terms">{texts.consentBody}</div>
      {settings.termsUrl || settings.privacyUrl ? (
        <div class="fa-consent-links">
          {settings.termsUrl ? (
            <a href={settings.termsUrl} target="_blank" rel="noopener noreferrer">
              Terms of Service
            </a>
          ) : null}
          {settings.privacyUrl ? (
            <a href={settings.privacyUrl} target="_blank" rel="noopener noreferrer">
              Privacy Policy
            </a>
          ) : null}
        </div>
      ) : null}
      <div class="fa-consent-buttons">
        <button type="button" class="fa-btn-secondary" onClick={onDecline}>
          {texts.consentDecline}
        </button>
        <button type="button" class="fa-btn-primary" onClick={onAgree}>
          {texts.consentAgree}
        </button>
      </div>
    </div>
  );
}

export type CallPhase = "starting" | "live" | "ended";

interface CallViewProps {
  settings: WidgetSettings;
  session: AgentSession | null;
  entries: readonly TranscriptEntry[];
  phase: CallPhase;
  mode: AgentMode;
  error: string | null;
  onRestartVoice(): void;
  onSendText(text: string): void;
  onActivity(): void;
}

export function CallView({
  settings,
  session,
  entries,
  phase,
  mode,
  error,
  onRestartVoice,
  onSendText,
  onActivity,
}: CallViewProps) {
  const { texts } = settings;
  const live = phase === "live";
  const ended = phase === "ended";
  // Ended state hides the (dead) composer behind an explicit "continue by
  // typing" reveal; a new call resets the reveal.
  const [typingRevealed, setTypingRevealed] = useState(false);
  useEffect(() => {
    if (!ended) {
      setTypingRevealed(false);
    }
  }, [ended]);
  return (
    <>
      {settings.transcript ? (
        <Transcript entries={entries} texts={texts} />
      ) : (
        <div class="fa-home" style="flex:1;justify-content:center">
          <Orb size={72} mode={live ? mode : undefined} session={session} />
        </div>
      )}
      {error ? <div class="fa-error">{error}</div> : null}
      {!ended ? (
        <div class="fa-mode-status">
          <Waveform session={live ? session : null} bars={5} barWidth={2} gap={3} height={12} />
          <span>{live ? texts[mode] : texts.statusConnecting}</span>
        </div>
      ) : null}
      {settings.textInput && (!ended || typingRevealed) ? (
        <Composer
          placeholder={texts.composerPlaceholder}
          sendLabel={texts.sendLabel}
          disabled={phase === "starting"}
          divided={ended}
          onSend={onSendText}
          onActivity={onActivity}
        />
      ) : null}
      {ended ? (
        <div class="fa-ended">
          <button type="button" class="fa-cta fa-cta--wide" onClick={onRestartVoice}>
            <IconPhone size={16} />
            {texts.restartVoice}
          </button>
          {settings.textInput && !typingRevealed ? (
            <button type="button" class="fa-link" onClick={() => setTypingRevealed(true)}>
              {texts.continueWithText}
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

interface MinimizedPillProps {
  settings: WidgetSettings;
  session: AgentSession | null;
  seconds: number;
  onExpand(): void;
  onEnd(): void;
}

export function MinimizedPill({ settings, session, seconds, onExpand, onEnd }: MinimizedPillProps) {
  const { texts } = settings;
  return (
    <div class="fa-pill">
      <button type="button" class="fa-pill-expand" aria-label={texts.expandLabel} onClick={onExpand}>
        <Orb size={32} mode="speaking" session={session} />
        <Waveform session={session} bars={6} barWidth={2.5} gap={2.5} height={18} />
        <span class="fa-pill-timer">{formatTimer(seconds)}</span>
      </button>
      <button
        type="button"
        class="fa-btn-round fa-btn-round--danger"
        aria-label={texts.endCallLabel}
        onClick={onEnd}
      >
        <IconPhoneOff size={14} />
      </button>
    </div>
  );
}
