/** Call timer label, e.g. 3:07. */
export function formatTimer(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${rest.toString().padStart(2, "0")}`;
}

/**
 * Whether an in-call error breaks the call and deserves the error banner. A
 * failure the agent is recovering from does not, and neither does a client
 * tool failure: the agent hears the error as the tool's result and carries on.
 */
export function showsErrorBanner(error: { code: string; recovered?: boolean }): boolean {
  return error.recovered !== true && error.code !== "tool_failed" && error.code !== "tool_timeout";
}

/** Map an SDK error code to the widget's user-facing message. */
export function errorText(
  texts: { errorMicDenied: string; errorOrigin: string; errorUnavailable: string; errorConnection: string },
  code: string | undefined,
): string {
  switch (code) {
    case "mic_permission_denied":
      return texts.errorMicDenied;
    case "origin_forbidden":
    case "agent_not_public":
      return texts.errorOrigin;
    case "insufficient_credit":
      return texts.errorUnavailable;
    default:
      return texts.errorConnection;
  }
}

/** Pretty-print a tool payload when it is complete JSON; otherwise show it raw. */
export function formatToolPayload(payload: string, truncated: boolean | undefined): string {
  if (!truncated) {
    try {
      return JSON.stringify(JSON.parse(payload), null, 1);
    } catch {
      // fall through to the raw string
    }
  }
  return payload;
}
