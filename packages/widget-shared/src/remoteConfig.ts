import { DEFAULT_SERVER_URL } from "@fishaudio/agent-client";
import type { RemoteWidgetConfig } from "./settings.js";

/**
 * Pull the operator-managed widget config for a public agent. Best
 * effort — any failure (network, HTTP error, non-JSON) resolves
 * null and the widget renders from attributes + defaults.
 */
export async function fetchRemoteConfig(
  serverUrl: string | undefined,
  agentId: string,
): Promise<RemoteWidgetConfig | null> {
  const base = (serverUrl ?? DEFAULT_SERVER_URL).replace(/\/$/, "");
  try {
    const response = await fetch(
      `${base}/v1/agent/agents/${encodeURIComponent(agentId)}/widget`,
      {
        headers: { Accept: "application/json" },
        signal: typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(3000) : undefined,
      },
    );
    if (!response.ok) {
      return null;
    }
    const body: unknown = await response.json();
    return typeof body === "object" && body !== null ? (body as RemoteWidgetConfig) : null;
  } catch {
    return null;
  }
}
