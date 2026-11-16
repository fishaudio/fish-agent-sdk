import { FishAgentError } from "../errors.js";

/**
 * `getUserMedia` failures at start that mean "no microphone could be
 * captured", by `DOMException` name. A denied permission (`NotAllowedError`)
 * is not one of them, it has its own code.
 */
export const MIC_UNAVAILABLE_MESSAGES: ReadonlyMap<string, string> = new Map([
  [
    "NotFoundError",
    "No microphone was found. Connect one, or check that the operating system lets this browser use it.",
  ],
  [
    "NotReadableError",
    "The microphone could not be opened. Another application may be using it, or the operating system is blocking it.",
  ],
  ["OverconstrainedError", "No microphone matches the requested device. Check `audio.inputDeviceId`."],
  ["AbortError", "The microphone could not be started."],
]);

/**
 * Throws where a web page cannot reach the microphone at all, so the start
 * fails with the reason instead of a failed capture later. Browsers only
 * expose `navigator.mediaDevices` to secure contexts: https pages, and
 * `localhost` during development.
 *
 * Only web pages are checked. React Native and Node have no `document`, and
 * there the capture goes through whatever the runtime installed.
 */
export function assertMicrophoneReachable(): void {
  if (typeof document === "undefined") {
    return;
  }
  const scope = globalThis as {
    isSecureContext?: boolean;
    navigator?: { mediaDevices?: { getUserMedia?: unknown } };
  };
  const hasGetUserMedia = typeof scope.navigator?.mediaDevices?.getUserMedia === "function";
  if (scope.isSecureContext === true && !hasGetUserMedia) {
    throw new FishAgentError(
      "mic_unavailable",
      "This browser does not provide microphone access (`navigator.mediaDevices.getUserMedia` is missing). " +
        "Some in-app browsers do not: open the page in the system browser instead.",
    );
  }
  if (scope.isSecureContext === false || !hasGetUserMedia) {
    throw new FishAgentError(
      "insecure_context",
      "This page is not a secure context, so the browser gives it no microphone access. " +
        "Serve it over https, or open it on http://localhost during development. " +
        "To start without the microphone, pass `microphone: false`.",
    );
  }
}
