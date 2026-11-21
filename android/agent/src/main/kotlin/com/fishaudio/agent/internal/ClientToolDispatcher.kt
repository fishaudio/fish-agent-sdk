package com.fishaudio.agent.internal

import com.fishaudio.agent.ClientToolContext
import com.fishaudio.agent.ClientToolHandler
import com.fishaudio.agent.FishAgentError
import com.fishaudio.agent.FishAgentErrorCode
import kotlin.math.max
import kotlin.math.roundToLong
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.async
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.selects.onTimeout
import kotlinx.coroutines.selects.select
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** How much earlier than the agent's own deadline a client tool times out. */
private const val TOOL_TIMEOUT_MARGIN_MS = 1_000.0

/** A `client_tool.call` message, read leniently. */
internal class ClientToolCall(
    val callId: String,
    val toolName: String,
    val params: JsonObject,
    val expectsResponse: Boolean,
    /** How long the agent waits, in ms. Null from runtimes that do not send it. */
    val timeoutMs: Double?,
)

/**
 * Runs client tools and answers the agent.
 * Port of packages/client/src/session/toolDispatcher.ts.
 */
internal class ClientToolDispatcher(
    tools: Map<String, ClientToolHandler>,
    private val fallbackTimeoutMs: Long,
    /** Where handlers run. Cancelled when the session ends. */
    private val handlerScope: CoroutineScope,
    private val send: suspend (JsonObject) -> Unit,
    private val onError: (FishAgentError) -> Unit,
) {
    private val tools = tools.toMutableMap()

    fun register(name: String, handler: ClientToolHandler) {
        tools[name] = handler
    }

    suspend fun dispatch(call: ClientToolCall) {
        val handler = tools[call.toolName]
        if (handler == null) {
            onError(FishAgentError(FishAgentErrorCode.TOOL_FAILED, "Client tool \"${call.toolName}\" is not registered"))
            if (call.expectsResponse) {
                reply(call.callId, JsonPrimitive("Tool is not registered"), isError = true)
            }
            return
        }

        val timeoutMs = timeoutFor(call.timeoutMs, fallbackTimeoutMs)
        // The handler runs as its own job and races the clock. `withTimeout`
        // would wait for a handler that ignores cancellation, and the agent
        // has to hear back by the deadline either way.
        val running = handlerScope.async {
            handler.invoke(JsonValues.fromObject(call.params), ClientToolContext(call.callId, call.toolName))
        }
        val value: Any? = try {
            select {
                running.onAwait { it }
                onTimeout(timeoutMs) {
                    running.cancel()
                    throw FishAgentError(
                        FishAgentErrorCode.TOOL_TIMEOUT,
                        "Client tool \"${call.toolName}\" timed out after ${timeoutMs}ms",
                    )
                }
            }
        } catch (error: Throwable) {
            // A handler can fail with a CancellationException of its own (its
            // own timeout, for one). That is a tool failure. Only stop here
            // when this dispatch itself was cancelled, which means the session ended.
            currentCoroutineContext().ensureActive()
            fail(call, error)
            return
        }

        if (!call.expectsResponse) return
        val element = try {
            value?.let(JsonValues::toElement)
        } catch (error: IllegalArgumentException) {
            val reason = "Client tool result is not JSON-serializable: ${error.message}"
            onError(FishAgentError(FishAgentErrorCode.TOOL_FAILED, reason))
            deliver(ClientMessages.toolResult(call.callId, JsonPrimitive(reason), isError = true))
            return
        }
        reply(call.callId, element, isError = false)
    }

    private suspend fun fail(call: ClientToolCall, error: Throwable) {
        onError(
            error as? FishAgentError
                ?: FishAgentError(FishAgentErrorCode.TOOL_FAILED, "Client tool \"${call.toolName}\" threw", cause = error),
        )
        if (call.expectsResponse) {
            reply(call.callId, JsonPrimitive(error.toString()), isError = true)
        }
    }

    private suspend fun reply(callId: String, result: JsonElement?, isError: Boolean) {
        val message = ClientMessages.toolResult(callId, result, isError)
        val bytes = JsonValues.encode(message).toByteArray(Charsets.UTF_8).size
        if (bytes > Protocol.MAX_CLIENT_TOOL_RESULT_BYTES) {
            val reason = "Client tool result is too large to send ($bytes bytes serialized; limit " +
                "${Protocol.MAX_CLIENT_TOOL_RESULT_BYTES}). Return a summary or a reference instead."
            onError(FishAgentError(FishAgentErrorCode.TOOL_FAILED, reason))
            deliver(ClientMessages.toolResult(callId, JsonPrimitive(reason), isError = true))
            return
        }
        try {
            send(message)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Throwable) {
            onError(
                FishAgentError(FishAgentErrorCode.TOOL_FAILED, "Failed to deliver a client tool result", cause = error),
            )
            if (isError) return
            // The agent is still waiting on this call. Trade the lost result for
            // a short error result so it can recover now, not after its own timeout.
            deliver(
                ClientMessages.toolResult(
                    callId,
                    JsonPrimitive("Client tool result could not be delivered: $error"),
                    isError = true,
                ),
            )
        }
    }

    /** Last-resort send of an error result. A failure here is reported, not retried. */
    private suspend fun deliver(message: JsonObject) {
        try {
            send(message)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Throwable) {
            onError(
                FishAgentError(
                    FishAgentErrorCode.TOOL_FAILED,
                    "Failed to deliver a client tool error result",
                    cause = error,
                ),
            )
        }
    }

    companion object {
        /**
         * The agent's own wait when the runtime sends one, minus a margin (the
         * smaller of 1 s and 10 %) so the timeout reply reaches the agent
         * before it gives up; otherwise the configured fallback.
         */
        fun timeoutFor(fromAgentMs: Double?, fallbackMs: Long): Long {
            if (fromAgentMs == null || !fromAgentMs.isFinite() || fromAgentMs <= 0) {
                return fallbackMs
            }
            return max(fromAgentMs - TOOL_TIMEOUT_MARGIN_MS, fromAgentMs * 0.9).roundToLong()
        }
    }
}
