import type { ClientAudioInputInfo, ClientMicrophoneClass } from "@fishaudio/agent-protocol";

type ExtendedAudioTrackSettings = MediaTrackSettings & {
  voiceIsolation?: boolean;
};

interface LabelRule {
  readonly micClass: ClientMicrophoneClass;
  readonly pattern: RegExp;
}

// Ordered from most specific to most general: virtual drivers and speakerphones
// match before generic brand names, Bluetooth before wired headsets, and
// cameras/displays before built-in laptop microphones.
const LABEL_RULES: readonly LabelRule[] = [
  {
    micClass: "virtual",
    pattern:
      /\b(krisp|nvidia broadcast|blackhole|vb-?cable|voicemeeter|loopback|soundflower|virtual|ndi|zoomaudio|teams audio|aggregate|obs)\b/i,
  },
  {
    micClass: "speakerphone",
    pattern:
      /\b(jabra speak|poly sync|powerconf|speakerphone|conference|meeting owl|yealink cp|shure stem|ankerwork)\b/i,
  },
  {
    micClass: "webcam",
    pattern:
      /\b(webcam|camera|brio|c920\w*|c922\w*|c930\w*|facetime|continuity|obsbot|insta360|studio display|pro display|monitor)\b/i,
  },
  {
    micClass: "bluetooth",
    pattern:
      /\b(airpods|hands-?free|bluetooth|hfp|bose|wh-?1000\w*|wf-?1000\w*|galaxy buds|pixel buds|beats|earbuds|tws|shokz|openrun|jabra elite|jabra evolve\d*)\b/i,
  },
  {
    micClass: "headset",
    pattern:
      /\b(headset|headphone|earphone|earpods|plantronics|blackwire|sennheiser|epos|arctis|steelseries|hyperx cloud|logitech [gh]\d|razer|corsair|astro|lavalier|lapel|boom)\b/i,
  },
  {
    micClass: "builtin",
    pattern:
      /\b(macbook|imac|mac mini|built-?in|internal|integrated|microphone array|mic array|realtek|intel smart sound|iphone|ipad)\b/i,
  },
  {
    micClass: "external",
    pattern:
      /\b(yeti|snowball|shure|mv7|sm7|rode|at2020|audio-?technica|fifine|elgato|quadcast|solocast|seiren|scarlett|focusrite|condenser|podmic|samson|usb audio|usb mic|external mic)\b/i,
  },
];

function normalizeLabel(label: string | undefined): string {
  if (!label) {
    return "";
  }
  return label
    .trim()
    .replace(/^(?:default|communications)\s*-\s*/i, "")
    .trim();
}

/** Classifies a browser MediaStreamTrack label into a coarse, PII-free microphone category. */
export function classifyMicrophoneLabel(label: string | undefined): ClientMicrophoneClass {
  const normalized = normalizeLabel(label);
  if (!normalized || /^(?:default|communications)$/i.test(normalized)) {
    return "unknown";
  }
  for (const rule of LABEL_RULES) {
    if (rule.pattern.test(normalized)) {
      return rule.micClass;
    }
  }
  return "unknown";
}

function readOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readOptionalPositiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : undefined;
}

/** Reads sanitized microphone class and active capture settings from a browser audio track. */
export function readClientAudioInputInfo(
  track: MediaStreamTrack | undefined,
): ClientAudioInputInfo | undefined {
  if (!track) {
    return undefined;
  }
  let settings: ExtendedAudioTrackSettings = {};
  try {
    settings = (track.getSettings?.() ?? {}) as ExtendedAudioTrackSettings;
  } catch {
    settings = {};
  }
  const info: ClientAudioInputInfo = {
    micClass: classifyMicrophoneLabel(track.label),
  };
  const echoCancellation = readOptionalBoolean(settings.echoCancellation);
  if (echoCancellation !== undefined) {
    info.echoCancellation = echoCancellation;
  }
  const noiseSuppression = readOptionalBoolean(settings.noiseSuppression);
  if (noiseSuppression !== undefined) {
    info.noiseSuppression = noiseSuppression;
  }
  const autoGainControl = readOptionalBoolean(settings.autoGainControl);
  if (autoGainControl !== undefined) {
    info.autoGainControl = autoGainControl;
  }
  const voiceIsolation = readOptionalBoolean(settings.voiceIsolation);
  if (voiceIsolation !== undefined) {
    info.voiceIsolation = voiceIsolation;
  }
  const sampleRate = readOptionalPositiveInt(settings.sampleRate);
  if (sampleRate !== undefined) {
    info.sampleRate = sampleRate;
  }
  const channelCount = readOptionalPositiveInt(settings.channelCount);
  if (channelCount !== undefined) {
    info.channelCount = channelCount;
  }
  return info;
}
