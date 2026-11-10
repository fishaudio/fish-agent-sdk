import type { AgentSessionMessage, ClientSessionMessage } from "@fishaudio/agent-protocol";
import { FishAgentError } from "../errors.js";

export type ClientToolHandler = (
  params: Record<string, unknown>,
  context: { callId: string; toolName: string },
) => unknown | Promise<unknown>;

export const DEFAULT_CLIENT_TOOL_TIMEOUT_MS = 15_000;

/**
 * Upper bound on the serialized `client_tool.result` message. The realtime
 * data channel rejects packets above 64 000 bytes; this leaves headroom for
 * the packet envelope. Larger results are replaced by an error result so the
 * agent hears back instead of waiting out its server-side timeout.
 */
export const MAX_CLIENT_TOOL_RESULT_BYTES = 60_000;

const textEncoder = new TextEncoder();

type ClientToolCall = Extract<AgentSessionMessage, { type: "client_tool.call" }>;

export class ClientToolDispatcher {
  private readonly tools = new Map<string, ClientToolHandler>();

  constructor(
    tools: Record<string, ClientToolHandler> | undefined,
    private readonly timeoutMs: number,
    private readonly send: (message: ClientSessionMessage) => Promise<void>,
    private readonly onError: (error: FishAgentError) => void,
  ) {
    for (const [name, handler] of Object.entries(tools ?? {})) {
      this.tools.set(name, handler);
    }
  }

  register(name: string, handler: ClientToolHandler): void {
    this.tools.set(name, handler);
  }

  async dispatch(call: ClientToolCall): Promise<void> {
    const handler = this.tools.get(call.toolName);
    if (!handler) {
      this.onError(
        new FishAgentError("tool_failed", `Client tool "${call.toolName}" is not registered`),
      );
      if (call.expectsResponse) {
        await this.reply(call.callId, { isError: true, result: "Tool is not registered" });
      }
      return;
    }

    try {
      const result = await this.withTimeout(
        Promise.resolve(handler(call.params, { callId: call.callId, toolName: call.toolName })),
        call.toolName,
        ClientToolDispatcher.timeoutFor(call, this.timeoutMs),
      );
      if (call.expectsResponse) {
        await this.reply(call.callId, result === undefined ? {} : { result });
      }
    } catch (error) {
      this.onError(
        error instanceof FishAgentError
          ? error
          : new FishAgentError("tool_failed", `Client tool "${call.toolName}" threw`, {
              cause: error,
            }),
      );
      if (call.expectsResponse) {
        await this.reply(call.callId, { isError: true, result: String(error) });
      }
    }
  }

  private async reply(
    callId: string,
    body: { result?: unknown; isError?: boolean },
  ): Promise<void> {
    const message: ClientSessionMessage = { type: "client_tool.result", callId, ...body };
    const rejected = this.undeliverable(message);
    if (rejected !== undefined) {
      this.onError(new FishAgentError("tool_failed", rejected));
      await this.deliver({ type: "client_tool.result", callId, isError: true, result: rejected });
      return;
    }
    try {
      await this.send(message);
    } catch (error) {
      this.onError(
        new FishAgentError("tool_failed", "Failed to deliver a client tool result", {
          cause: error,
        }),
      );
      if (body.isError) {
        return;
      }
      // The agent is still waiting on this call. Trade the lost result for a
      // short error result so it can recover in conversation now, rather than
      // after its server-side tool timeout.
      await this.deliver({
        type: "client_tool.result",
        callId,
        isError: true,
        result: `Client tool result could not be delivered: ${String(error)}`,
      });
    }
  }

  /** Why the message cannot go over the wire as-is, or undefined if it can. */
  private undeliverable(message: ClientSessionMessage): string | undefined {
    let serialized: string;
    try {
      serialized = JSON.stringify(message);
    } catch (error) {
      return `Client tool result is not JSON-serializable: ${String(error)}`;
    }
    const bytes = textEncoder.encode(serialized).byteLength;
    if (bytes > MAX_CLIENT_TOOL_RESULT_BYTES) {
      return (
        `Client tool result is too large to send (${bytes} bytes serialized; ` +
        `limit ${MAX_CLIENT_TOOL_RESULT_BYTES}). Return a summary or a reference instead.`
      );
    }
    return undefined;
  }

  /** Last-resort send of an error result; a failure here is reported, not retried. */
  private async deliver(message: ClientSessionMessage): Promise<void> {
    try {
      await this.send(message);
    } catch (error) {
      this.onError(
        new FishAgentError("tool_failed", "Failed to deliver a client tool error result", {
          cause: error,
        }),
      );
    }
  }

  /** The agent's own wait when the runtime sends it, else the configured fallback. */
  private static timeoutFor(call: ClientToolCall, fallbackMs: number): number {
    const fromAgent = call.timeoutMs;
    return typeof fromAgent === "number" && Number.isFinite(fromAgent) && fromAgent > 0
      ? fromAgent
      : fallbackMs;
  }

  private withTimeout<T>(promise: Promise<T>, toolName: string, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new FishAgentError(
            "tool_timeout",
            `Client tool "${toolName}" timed out after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }
}
