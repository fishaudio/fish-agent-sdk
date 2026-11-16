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

function hasCaptureApi(): boolean {
  const scope = globalThis as { navigator?: { mediaDevices?: { getUserMedia?: unknown } } };
  return typeof scope.navigator?.mediaDevices?.getUserMedia === "function";
}

/**
 * Throws `insecure_context` on a web page that is certain to get no
 * microphone: the browser says the page is not a secure context and exposes no
 * capture API to it. Browsers only give the microphone to https pages, and to
 * `localhost` during development.
 *
 * Anything less certain is left to the capture itself, so nothing that could
 * work is refused up front: no secure-context flag, a capture API that is
 * there anyway, or no `document` at all (React Native, Node, test runners).
 */
export function assertMicrophoneReachable(): void {
  if (typeof document === "undefined") {
    return;
  }
  const insecure = (globalThis as { isSecureContext?: boolean }).isSecureContext === false;
  if (insecure && !hasCaptureApi()) {
    throw new FishAgentError(
      "insecure_context",
      "This page is not a secure context, so the browser gives it no microphone access. " +
        "Serve it over https, or open it on http://localhost during development. " +
        "To start without the microphone, pass `microphone: false`.",
    );
  }
}

/**
 * A capture that failed where there is no capture API to call (the failure is
 * the `TypeError` from reaching into a missing `navigator.mediaDevices`) is
 * `mic_unavailable`. Every other failure is returned as it came, for the
 * session to map by name.
 */
export function asCaptureError(error: unknown): unknown {
  if (error instanceof TypeError && !hasCaptureApi()) {
    return new FishAgentError(
      "mic_unavailable",
      "This environment provides no microphone capture API " +
        "(`navigator.mediaDevices.getUserMedia` is missing). " +
        "Some in-app browsers do not: open the page in the system browser instead.",
      { cause: error },
    );
  }
  return error;
}
