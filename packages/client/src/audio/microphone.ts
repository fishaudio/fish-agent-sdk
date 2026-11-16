import { FishAgentError } from "../errors.js";

/**
 * `getUserMedia` failures that mean "no microphone could be captured", by
 * `DOMException` name. A denied permission (`NotAllowedError`) is not one of
 * them, it has its own code.
 */
const MIC_UNAVAILABLE_MESSAGES: ReadonlyMap<string, string> = new Map([
  [
    "NotFoundError",
    "No microphone was found. Connect one, or check that the operating system lets this browser use it.",
  ],
  [
    "NotReadableError",
    "The microphone could not be opened. Another application may be using it, or the operating system is blocking it.",
  ],
  [
    "OverconstrainedError",
    "No available microphone meets the capture settings. If `audio.inputDeviceId` is set, that device may be gone.",
  ],
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
        "An https page inside a frame of an http page is not a secure context either. " +
        "To start without the microphone, pass `microphone: false`.",
    );
  }
}

/**
 * Names a failed start-time capture. Called only where the capture itself is
 * awaited, so an error of the same name from somewhere else in the start (an
 * aborted connection, say) is never taken for a microphone problem.
 *
 * - No capture API to call (the failure is the `TypeError` from reaching into
 *   a missing `navigator.mediaDevices`): `mic_unavailable`.
 * - A `getUserMedia` failure that means no microphone could be captured:
 *   `mic_unavailable`, worded by cause.
 * - Anything else, a denied permission included, is returned as it came for
 *   the session to map.
 */
export function asCaptureError(error: unknown): unknown {
  if (error instanceof TypeError && !hasCaptureApi()) {
    return new FishAgentError(
      "mic_unavailable",
      "No microphone capture API is available here (`navigator.mediaDevices.getUserMedia` is missing). " +
        "That is the case outside a browser page, on a page not served over https or localhost, " +
        "and in some in-app browsers.",
      { cause: error },
    );
  }
  const name = (error as { name?: unknown } | null)?.name;
  const message = typeof name === "string" ? MIC_UNAVAILABLE_MESSAGES.get(name) : undefined;
  if (message !== undefined) {
    return new FishAgentError("mic_unavailable", message, { cause: error });
  }
  return error;
}
