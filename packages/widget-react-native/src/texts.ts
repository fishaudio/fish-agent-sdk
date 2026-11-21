import { DEFAULT_TEXTS as WEB_TEXTS, type WidgetTextContents } from "@fishaudio/agent-widget-shared";

/** Mobile wording where the web strings talk about browsers and sites. */
export const MOBILE_TEXTS: Partial<WidgetTextContents> = {
  errorMicDenied: "Microphone access was denied. Turn it on in Settings.",
  errorOrigin: "This app isn't allowed to talk to this agent.",
};

/** The widget's built-in UI strings; override any of them with `textContents`. */
export const DEFAULT_TEXTS: WidgetTextContents = { ...WEB_TEXTS, ...MOBILE_TEXTS };
