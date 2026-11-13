/**
 * Widget settings shared by the web and React Native widgets: UI strings, the
 * remote config shape, and resolution. Precedence:
 * host-supplied value > remote widget config (platform endpoint) > built-in default.
 */

import type { SessionToken } from "@fishaudio/agent-client";

export type WidgetPosition = "bottom-right" | "bottom-left" | "top-right" | "top-left";

/**
 * Host-supplied token fetcher for private agents, called before every session
 * start. Fetch the session token from your backend — with whatever auth
 * headers, body, or credentials the request needs — and return it verbatim.
 */
export type SessionTokenProvider = () => SessionToken | Promise<SessionToken>;

export interface WidgetTextContents {
  statusConnecting: string;
  statusReconnecting: string;
  statusLive: string;
  statusEnded: string;
  greeting: string;
  homeHint: string;
  startVoice: string;
  restartVoice: string;
  continueWithText: string;
  endedDividerLabel: string;
  composerPlaceholder: string;
  consentTitle: string;
  consentBody: string;
  consentAgree: string;
  consentDecline: string;
  poweredBy: string;
  listening: string;
  thinking: string;
  speaking: string;
  errorMicDenied: string;
  errorOrigin: string;
  errorUnavailable: string;
  errorConnection: string;
  openLabel: string;
  closeLabel: string;
  minimizeLabel: string;
  expandLabel: string;
  sendLabel: string;
  muteLabel: string;
  unmuteLabel: string;
  muteShort: string;
  unmuteShort: string;
  endCallLabel: string;
  dismissLabel: string;
  toolRunning: string;
  toolDone: string;
  toolFailed: string;
}

export const DEFAULT_TEXTS: WidgetTextContents = {
  statusConnecting: "Connecting…",
  statusReconnecting: "Reconnecting…",
  statusLive: "Live",
  statusEnded: "Call ended",
  greeting: "Hey! How can I help?",
  homeHint: "Start a voice chat, or type below.",
  startVoice: "Start a voice chat",
  restartVoice: "Start a new voice chat",
  continueWithText: "Or continue by typing",
  endedDividerLabel: "Call ended",
  composerPlaceholder: "Or type a message…",
  consentTitle: "Before you start",
  consentBody:
    "This conversation is powered by Fish Audio. Your voice is processed in real time to run the call. By continuing, you agree to our Terms of Service and Privacy Policy.",
  consentAgree: "Agree & continue",
  consentDecline: "Not now",
  poweredBy: "Powered by Fish Audio",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
  errorMicDenied: "Microphone access was denied — check your browser settings.",
  errorOrigin: "This site isn't allowed to talk to this agent.",
  errorUnavailable: "This agent is temporarily unavailable.",
  errorConnection: "Connection failed — please try again.",
  openLabel: "Open assistant",
  closeLabel: "Close",
  minimizeLabel: "Minimize",
  expandLabel: "Expand",
  sendLabel: "Send",
  muteLabel: "Mute microphone",
  unmuteLabel: "Unmute microphone",
  muteShort: "mute",
  unmuteShort: "unmute",
  endCallLabel: "End call",
  dismissLabel: "Dismiss",
  toolRunning: "Running",
  toolDone: "Done",
  toolFailed: "Failed",
};

/** Raw attribute values; `undefined` = attribute absent (lets remote config apply). */
export interface WidgetAttributes {
  agentId?: string;
  serverUrl?: string;
  userId?: string;
  language?: string;
  dynamicVariables?: Record<string, string>;
  agentName?: string;
  greeting?: string;
  proactiveMessage?: string;
  proactiveDelaySeconds?: number;
  transcript?: boolean;
  textInput?: boolean;
  micMuting?: boolean;
  consent?: boolean;
  consentKey?: string;
  consentText?: string;
  termsUrl?: string;
  privacyUrl?: string;
  position?: WidgetPosition;
  texts?: Partial<WidgetTextContents>;
}

/** Shape served by `GET /v1/agent/agents/{id}/widget`; all fields optional. */
export interface RemoteWidgetConfig {
  agent_name?: string;
  greeting?: string;
  proactive_message?: string;
  consent_required?: boolean;
  consent_text?: string;
  transcript_enabled?: boolean;
  text_input_enabled?: boolean;
  mic_muting_enabled?: boolean;
  text_contents?: Partial<WidgetTextContents>;
}

/** Fully resolved, render-ready settings. */
export interface WidgetSettings {
  agentId?: string;
  serverUrl?: string;
  userId?: string;
  language?: string;
  dynamicVariables?: Record<string, string>;
  agentName: string;
  proactiveMessage?: string;
  proactiveDelaySeconds: number;
  transcript: boolean;
  textInput: boolean;
  micMuting: boolean;
  consent: boolean;
  consentKey: string;
  termsUrl?: string;
  privacyUrl?: string;
  position: WidgetPosition;
  texts: WidgetTextContents;
}

export const WIDGET_POSITIONS: readonly WidgetPosition[] = [
  "bottom-right",
  "bottom-left",
  "top-right",
  "top-left",
];

export function resolveSettings(
  attrs: WidgetAttributes,
  remote: RemoteWidgetConfig | null,
): WidgetSettings {
  const texts: WidgetTextContents = {
    ...DEFAULT_TEXTS,
    ...remote?.text_contents,
    ...attrs.texts,
  };
  const greeting = attrs.greeting ?? attrs.texts?.greeting ?? remote?.greeting;
  if (greeting !== undefined) {
    texts.greeting = greeting;
  }
  const consentBody = attrs.consentText ?? attrs.texts?.consentBody ?? remote?.consent_text;
  if (consentBody !== undefined) {
    texts.consentBody = consentBody;
  }
  return {
    agentId: attrs.agentId,
    serverUrl: attrs.serverUrl,
    userId: attrs.userId,
    language: attrs.language,
    dynamicVariables: attrs.dynamicVariables,
    agentName: attrs.agentName ?? remote?.agent_name ?? "Agent",
    proactiveMessage: attrs.proactiveMessage ?? remote?.proactive_message,
    proactiveDelaySeconds: attrs.proactiveDelaySeconds ?? 3,
    transcript: attrs.transcript ?? remote?.transcript_enabled ?? true,
    textInput: attrs.textInput ?? remote?.text_input_enabled ?? true,
    micMuting: attrs.micMuting ?? remote?.mic_muting_enabled ?? true,
    consent: attrs.consent ?? remote?.consent_required ?? false,
    consentKey: attrs.consentKey ?? "fish-agent-consent",
    termsUrl: attrs.termsUrl,
    privacyUrl: attrs.privacyUrl,
    position: attrs.position ?? "bottom-right",
    texts,
  };
}
