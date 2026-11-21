import Foundation

/// How much earlier than the agent's own deadline a client tool times out, in ms.
private let toolTimeoutMarginMs = 1000.0

/// A `client_tool.call` message, read leniently.
struct ClientToolCall: Sendable {
    let callId: String
    let toolName: String
    let params: [String: JSONValue]
    let expectsResponse: Bool
    /// How long the agent waits, in ms. Nil from runtimes that do not send it.
    let timeoutMs: Double?
}

/// Runs client tools and answers the agent.
/// Port of packages/client/src/session/toolDispatcher.ts.
@MainActor
final class ClientToolDispatcher {
    private var tools: [String: ClientToolHandler]
    private let fallbackTimeoutMs: Int
    private let scheduler: Scheduler
    private let send: @MainActor (JSONValue) async throws -> Void
    private let onError: @MainActor (FishAgentError) -> Void
    /// Handlers still running, so they can be cancelled when the session ends.
    private var running: [UUID: Task<Void, Never>] = [:]
    private var stopped = false

    init(
        tools: [String: ClientToolHandler],
        fallbackTimeoutMs: Int,
        scheduler: Scheduler,
        send: @escaping @MainActor (JSONValue) async throws -> Void,
        onError: @escaping @MainActor (FishAgentError) -> Void
    ) {
        self.tools = tools
        self.fallbackTimeoutMs = fallbackTimeoutMs
        self.scheduler = scheduler
        self.send = send
        self.onError = onError
    }

    func register(_ name: String, handler: @escaping ClientToolHandler) {
        tools[name] = handler
    }

    /// The session ended: stop every handler and send nothing more.
    func stop() {
        stopped = true
        for task in running.values { task.cancel() }
        running.removeAll()
    }

    func dispatch(_ call: ClientToolCall) {
        guard let handler = tools[call.toolName] else {
            onError(FishAgentError(.toolFailed, "Client tool \"\(call.toolName)\" is not registered"))
            if call.expectsResponse {
                Task { await self.reply(callId: call.callId, result: "Tool is not registered", isError: true) }
            }
            return
        }

        let timeoutMs = Self.timeout(fromAgentMs: call.timeoutMs, fallbackMs: fallbackTimeoutMs)
        let id = UUID()
        var settled = false
        var deadline: ScheduledWork?

        // The handler runs as its own task and races the clock. The agent has
        // to hear back by the deadline even when the handler ignores cancellation.
        let settle: @MainActor (Result<JSONValue?, Error>) -> Void = { [weak self] outcome in
            guard let self, !settled, !self.stopped else { return }
            settled = true
            deadline?.cancel()
            self.running[id] = nil
            Task { await self.finish(call, outcome) }
        }

        let context = ClientToolContext(callId: call.callId, toolName: call.toolName)
        let task = Task {
            let outcome: Result<JSONValue?, Error>
            do {
                outcome = .success(try await handler(call.params, context))
            } catch {
                outcome = .failure(error)
            }
            await MainActor.run { settle(outcome) }
        }
        running[id] = task
        deadline = scheduler.schedule(afterMilliseconds: timeoutMs) {
            task.cancel()
            settle(.failure(FishAgentError(.toolTimeout, "Client tool \"\(call.toolName)\" timed out after \(timeoutMs)ms")))
        }
    }

    private func finish(_ call: ClientToolCall, _ outcome: Result<JSONValue?, Error>) async {
        switch outcome {
        case let .success(value):
            if call.expectsResponse {
                await reply(callId: call.callId, result: value, isError: false)
            }
        case let .failure(error):
            onError(
                error as? FishAgentError
                    ?? FishAgentError(.toolFailed, "Client tool \"\(call.toolName)\" threw", underlyingError: error)
            )
            if call.expectsResponse {
                await reply(callId: call.callId, result: .string(String(describing: error)), isError: true)
            }
        }
    }

    private func reply(callId: String, result: JSONValue?, isError: Bool) async {
        let message = ClientMessages.toolResult(callId: callId, result: result, isError: isError)
        // Why the message cannot go out as it is, or nil if it can.
        let rejected: String?
        if let bytes = try? message.encoded().count {
            rejected = bytes > WireProtocol.maxClientToolResultBytes
                ? "Client tool result is too large to send (\(bytes) bytes serialized; limit "
                + "\(WireProtocol.maxClientToolResultBytes)). Return a summary or a reference instead."
                : nil
        } else {
            rejected = "Client tool result is not JSON-serializable"
        }
        if let rejected {
            onError(FishAgentError(.toolFailed, rejected))
            await deliver(ClientMessages.toolResult(callId: callId, result: .string(rejected), isError: true))
            return
        }
        do {
            try await send(message)
        } catch {
            onError(FishAgentError(.toolFailed, "Failed to deliver a client tool result", underlyingError: error))
            if isError { return }
            // The agent is still waiting on this call. Trade the lost result for
            // a short error result so it can recover now, not after its own timeout.
            await deliver(
                ClientMessages.toolResult(
                    callId: callId,
                    result: .string("Client tool result could not be delivered: \(error)"),
                    isError: true
                )
            )
        }
    }

    /// Last-resort send of an error result. A failure here is reported, not retried.
    private func deliver(_ message: JSONValue) async {
        do {
            try await send(message)
        } catch {
            onError(FishAgentError(.toolFailed, "Failed to deliver a client tool error result", underlyingError: error))
        }
    }

    /// The agent's own wait when the runtime sends one, minus a margin (the
    /// smaller of 1 s and 10 %) so the timeout reply reaches the agent before
    /// it gives up; otherwise the configured fallback.
    nonisolated static func timeout(fromAgentMs: Double?, fallbackMs: Int) -> Int {
        guard let fromAgentMs, fromAgentMs.isFinite, fromAgentMs > 0 else { return fallbackMs }
        return Int(max(fromAgentMs - toolTimeoutMarginMs, fromAgentMs * 0.9).rounded())
    }
}
