import { describe, expect, it } from "vitest";
import {
  DEFAULT_TEXTS,
  parseAttributes,
  resolveSettings,
  type WidgetTextContents,
} from "../config.js";

function source(attrs: Record<string, string>) {
  return { getAttribute: (name: string) => attrs[name] ?? null };
}

describe("parseAttributes", () => {
  it("parses booleans, JSON and enums, leaving absent attributes undefined", () => {
    const attrs = parseAttributes(
      source({
        "agent-id": "agent_1",
        transcript: "false",
        consent: "",
        "dynamic-variables": '{"plan":"pro"}',
        position: "top-left",
        "proactive-delay": "7",
      }),
    );
    expect(attrs.agentId).toBe("agent_1");
    expect(attrs.transcript).toBe(false);
    expect(attrs.consent).toBe(true); // bare attribute enables, HTML boolean convention
    expect(attrs.textInput).toBeUndefined();
    expect(attrs.dynamicVariables).toEqual({ plan: "pro" });
    expect(attrs.position).toBe("top-left");
    expect(attrs.proactiveDelaySeconds).toBe(7);
  });

  it("drops invalid JSON and invalid positions", () => {
    const attrs = parseAttributes(
      source({ "dynamic-variables": "{oops", position: "middle", "proactive-delay": "soon" }),
    );
    expect(attrs.dynamicVariables).toBeUndefined();
    expect(attrs.position).toBeUndefined();
    expect(attrs.proactiveDelaySeconds).toBeUndefined();
  });
});

describe("resolveSettings", () => {
  it("applies defaults when nothing is configured", () => {
    const settings = resolveSettings(parseAttributes(source({})), null);
    expect(settings.agentName).toBe("Agent");
    expect(settings.transcript).toBe(true);
    expect(settings.textInput).toBe(true);
    expect(settings.micMuting).toBe(true);
    expect(settings.consent).toBe(false);
    expect(settings.position).toBe("bottom-right");
    expect(settings.texts).toEqual(DEFAULT_TEXTS);
  });

  it("lets attributes win over remote config, which wins over defaults", () => {
    const settings = resolveSettings(
      parseAttributes(source({ "agent-name": "Aria", transcript: "true" })),
      {
        agent_name: "Remote",
        transcript_enabled: false,
        text_input_enabled: false,
        consent_required: true,
        greeting: "Hello from the dashboard",
      },
    );
    expect(settings.agentName).toBe("Aria"); // attribute wins
    expect(settings.transcript).toBe(true); // attribute wins
    expect(settings.textInput).toBe(false); // remote applies
    expect(settings.consent).toBe(true); // remote applies
    expect(settings.texts.greeting).toBe("Hello from the dashboard");
  });

  it("merges text contents with shortcut attributes on top", () => {
    const settings = resolveSettings(
      parseAttributes(
        source({
          greeting: "Hi!",
          "consent-text": "Custom terms",
          "text-contents": '{"startVoice":"Call us","greeting":"Ignored by shortcut"}',
        }),
      ),
      { text_contents: { poweredBy: "Powered by remote" } },
    );
    expect(settings.texts.greeting).toBe("Hi!");
    expect(settings.texts.startVoice).toBe("Call us");
    expect(settings.texts.consentBody).toBe("Custom terms");
    expect(settings.texts.poweredBy).toBe("Powered by remote");
    expect(settings.texts.consentTitle).toBe(DEFAULT_TEXTS.consentTitle);
  });
});

describe("errorMicUnavailable text", () => {
  const micText = (
    attrTexts?: Partial<WidgetTextContents>,
    remoteTexts?: Partial<WidgetTextContents>,
  ) =>
    resolveSettings(
      { ...parseAttributes(source({})), texts: attrTexts },
      remoteTexts ? { text_contents: remoteTexts } : null,
    ).texts.errorMicUnavailable;

  it("uses the English default only on a page that overrides no text", () => {
    expect(micText()).toBe("No microphone available — check your device and try again.");
    expect(micText(undefined, {})).toBe("No microphone available — check your device and try again.");
  });

  it("falls back to the page's own connection error when the page has its own texts", () => {
    // A translated page written before the key existed keeps its own wording.
    expect(micText({ errorConnection: "接続に失敗しました。" })).toBe("接続に失敗しました。");
    expect(micText(undefined, { errorConnection: "Verbindung fehlgeschlagen." })).toBe(
      "Verbindung fehlgeschlagen.",
    );
    // Attributes win over remote config, for the fallback too.
    expect(micText({ errorConnection: "attr" }, { errorConnection: "remote" })).toBe("attr");
    // Any override makes it "a page with its own texts", even without a connection text.
    expect(micText({ startVoice: "話す" })).toBe(DEFAULT_TEXTS.errorConnection);
  });

  it("uses the page's errorMicUnavailable when it sets one", () => {
    expect(micText({ errorConnection: "接続に失敗しました。", errorMicUnavailable: "マイクがありません。" })).toBe(
      "マイクがありません。",
    );
    expect(micText({ errorConnection: "attr" }, { errorMicUnavailable: "remote mic" })).toBe("remote mic");
  });

  it("keeps a complete set of texts without the key assignable to WidgetTextContents", () => {
    const { errorMicUnavailable: _newKey, ...before } = DEFAULT_TEXTS;
    // Fails type-checking if the key becomes required.
    const complete: WidgetTextContents = before;
    expect(micText(complete)).toBe(DEFAULT_TEXTS.errorConnection);
  });
});
