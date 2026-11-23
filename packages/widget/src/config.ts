/**
 * Attribute parsing for the <fish-agent> element. Settings resolution and the
 * UI strings live in @fishaudio/agent-widget-shared, shared with React Native.
 */

import {
  WIDGET_POSITIONS,
  type WidgetAttributes,
  type WidgetPosition,
  type WidgetTextContents,
} from "@fishaudio/agent-widget-shared";

export {
  DEFAULT_TEXTS,
  resolveSettings,
  type RemoteWidgetConfig,
  type SessionTokenProvider,
  type WidgetAttributes,
  type WidgetPosition,
  type WidgetSettings,
  type WidgetTextContents,
} from "@fishaudio/agent-widget-shared";

export const OBSERVED_ATTRIBUTES = [
  "agent-id",
  "server-url",
  "user-id",
  "language",
  "dynamic-variables",
  "agent-name",
  "greeting",
  "proactive-message",
  "proactive-delay",
  "transcript",
  "text-input",
  "mic-muting",
  "consent",
  "consent-key",
  "consent-text",
  "terms-url",
  "privacy-url",
  "position",
  "text-contents",
] as const;

interface AttributeSource {
  getAttribute(name: string): string | null;
}

function text(source: AttributeSource, name: string): string | undefined {
  const value = source.getAttribute(name);
  return value === null || value === "" ? undefined : value;
}

function bool(source: AttributeSource, name: string): boolean | undefined {
  const value = source.getAttribute(name);
  if (value === null) {
    return undefined;
  }
  return !["false", "0", "off"].includes(value.trim().toLowerCase());
}

function json<T>(source: AttributeSource, name: string): T | undefined {
  const value = text(source, name);
  if (value === undefined) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null ? (parsed as T) : undefined;
  } catch {
    console.warn(`[fish-agent] ignoring invalid JSON in ${name} attribute`);
    return undefined;
  }
}

export function parseAttributes(source: AttributeSource): WidgetAttributes {
  const delayRaw = text(source, "proactive-delay");
  const delay = delayRaw === undefined ? undefined : Number(delayRaw);
  const positionRaw = text(source, "position") as WidgetPosition | undefined;
  return {
    agentId: text(source, "agent-id"),
    serverUrl: text(source, "server-url"),
    userId: text(source, "user-id"),
    language: text(source, "language"),
    dynamicVariables: json<Record<string, string>>(source, "dynamic-variables"),
    agentName: text(source, "agent-name"),
    greeting: text(source, "greeting"),
    proactiveMessage: text(source, "proactive-message"),
    proactiveDelaySeconds: delay !== undefined && Number.isFinite(delay) ? delay : undefined,
    transcript: bool(source, "transcript"),
    textInput: bool(source, "text-input"),
    micMuting: bool(source, "mic-muting"),
    consent: bool(source, "consent"),
    consentKey: text(source, "consent-key"),
    consentText: text(source, "consent-text"),
    termsUrl: text(source, "terms-url"),
    privacyUrl: text(source, "privacy-url"),
    position: positionRaw && WIDGET_POSITIONS.includes(positionRaw) ? positionRaw : undefined,
    texts: json<Partial<WidgetTextContents>>(source, "text-contents"),
  };
}

