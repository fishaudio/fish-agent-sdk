import Combine
import Foundation

/// A voice conversation with a Fish Audio agent, and what a phone needs around
/// it: the microphone permission and audio routing.
///
/// Create one and keep it (as a `@StateObject`, for example). It can make any
/// number of calls, one at a time. Read state from the published properties;
/// `events()` tells what happened.
///
/// ```swift
/// @StateObject private var conversation = Conversation()
///
/// let token = try SessionToken(json: responseBody)
/// try await conversation.startSession(.sessionToken(token))
/// ```
///
/// Add `NSMicrophoneUsageDescription` to the app's Info.plist, and the `audio`
/// background mode for calls that continue in the background.
///
/// Only one call can run in an app at a time, whichever `Conversation` makes it.
@MainActor
public final class Conversation: ObservableObject {
    /// `idle` before the first call and after a start that failed. Stays `ended` after a call until the next one starts.
    @Published public private(set) var status: ConversationStatus = .idle
    @Published public private(set) var mode: AgentMode = .listening
    @Published public private(set) var micMuted = false
    /// The route that was asked for. It is not the device audio is playing on right now.
    @Published public private(set) var audioOutput: AudioOutputRoute
    /// The chat log of the current call, streaming entries included (see
    /// `ChatMessage.isFinal`). It stays after the call ends and is emptied when
    /// the next call starts. For finished messages only, take
    /// `ConversationEvent.message` from `events()`.
    @Published public private(set) var messages: [ChatMessage] = []
    /// Why the last call ended. `nil` during a call and before the first one.
    @Published public private(set) var endReason: EndReason?

    public var isSpeaking: Bool { mode == .speaking }

    /// The ID of the current or last call's session.
    public var sessionId: String? { session?.sessionId }

    private let defaults: SessionOptions
    private let environment: ConversationEnvironment

    /// One call to `startSession` that is still on its way.
    private final class PendingStart {
        var task: Task<String, Error>?
        /// `endSession` ran while this was starting.
        var cancelled = false
        /// This start's session became the conversation's session.
        var published = false
        var result: Result<String, Error>?
        var waiters: [UUID: CheckedContinuation<String, Error>] = [:]
    }

    private var session: AgentSession?
    private var sessionStart: PendingStart?
    private var starting: PendingStart?
    /// The start whose call holds the audio route.
    private var platformOwner: PendingStart?
    private var tools: [String: ClientToolHandler]
    private var streams: [UUID: AsyncStream<ConversationEvent>.Continuation] = [:]

    private var liveSession: AgentSession? {
        guard let session, session.status != .ended else { return nil }
        return session
    }

    /// - Parameters:
    ///   - defaults: options for every call. `startSession` can adjust them per call.
    public convenience init(defaults: SessionOptions = SessionOptions(), mobile: MobileOptions = MobileOptions()) {
        self.init(defaults: defaults, mobile: mobile, environment: AppleEnvironment())
    }

    init(defaults: SessionOptions, mobile: MobileOptions, environment: ConversationEnvironment) {
        self.defaults = defaults
        self.environment = environment
        audioOutput = mobile.audioOutput
        tools = defaults.clientTools
    }

    deinit {
        // Releasing the conversation ends its call. Best effort: call endSession() to wait for it.
        let session = session
        let environment = environment
        let id = ObjectIdentifier(self)
        let streams = streams
        Task { @MainActor in
            streams.values.forEach { $0.finish() }
            guard let session, session.status != .ended else { return }
            try? await session.end()
            environment.callDidEnd()
            CallSlot.release(id)
        }
    }

    /// What happens during calls, as a new stream for each caller. Nothing is
    /// replayed: an event from before the stream was made is gone, so read
    /// state from the published properties. A consumer that falls more than
    /// 256 events behind loses the oldest ones.
    public func events() -> AsyncStream<ConversationEvent> {
        let id = UUID()
        return AsyncStream(bufferingPolicy: .bufferingNewest(256)) { continuation in
            streams[id] = continuation
            continuation.onTermination = { [weak self] _ in
                Task { @MainActor in self?.streams[id] = nil }
            }
        }
    }

    // MARK: - Starting

    /// Starts a call and returns its session ID once it is connected. The agent
    /// may still be joining then; messages sent early are held until it is ready.
    ///
    /// Asks for the microphone permission if the user has not been asked yet.
    ///
    /// Calling this again while a start is on its way, or while a call is live,
    /// joins that call and returns its ID. The start belongs to the
    /// conversation, not to the caller: cancelling the calling task stops the
    /// wait, not the call. Use `endSession()` to hang up.
    ///
    /// - Parameter configure: adjusts `SessionOptions` for this call, starting from the conversation's defaults.
    /// - Throws: `FishAgentError` when the call cannot be set up (`status` goes
    ///   back to `idle`); `CancellationError` when `endSession()` ran while
    ///   this was starting, or the calling task was cancelled;
    ///   `ConversationUsageError.callAlreadyActive` when another `Conversation` has a call in progress.
    @discardableResult
    public func startSession(_ auth: SessionAuth, configure: ((inout SessionOptions) -> Void)? = nil) async throws -> String {
        if let live = liveSession { return live.sessionId }
        let pending: PendingStart
        if let existing = starting, !existing.cancelled {
            pending = existing
        } else {
            pending = try beginStart(auth, configure: configure, after: starting)
        }
        return try await wait(for: pending)
    }

    private func beginStart(_ auth: SessionAuth, configure: ((inout SessionOptions) -> Void)?, after previous: PendingStart?) throws -> PendingStart {
        guard CallSlot.claim(self) else { throw ConversationUsageError.callAlreadyActive }
        var options = defaults
        configure?(&options)
        // Tools registered on the conversation apply to every call; the per-call options win.
        options.clientTools = tools.merging(options.clientTools) { _, perCall in perCall }

        let pending = PendingStart()
        starting = pending
        messages = []
        endReason = nil
        status = .connecting
        let finalOptions = options
        pending.task = Task { @MainActor [weak self] in
            // A start that was hung up on releases what it holds before the next one begins.
            _ = await previous?.task?.result
            guard let self else { throw CancellationError() }
            let outcome: Result<String, Error>
            do {
                outcome = .success(try await self.runStart(pending, auth, finalOptions))
            } catch {
                outcome = .failure(error)
            }
            pending.result = outcome
            let waiters = pending.waiters
            pending.waiters = [:]
            waiters.values.forEach { $0.resume(with: outcome) }
            return try outcome.get()
        }
        return pending
    }

    /// Waits for a start. A cancelled caller stops waiting; the start goes on.
    private func wait(for pending: PendingStart) async throws -> String {
        if let result = pending.result { return try result.get() }
        let id = UUID()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<String, Error>) in
                if let result = pending.result {
                    continuation.resume(with: result)
                } else if Task.isCancelled {
                    continuation.resume(throwing: CancellationError())
                } else {
                    pending.waiters[id] = continuation
                }
            }
        } onCancel: {
            Task { @MainActor in
                pending.waiters.removeValue(forKey: id)?.resume(throwing: CancellationError())
            }
        }
    }

    private func runStart(_ pending: PendingStart, _ auth: SessionAuth, _ options: SessionOptions) async throws -> String {
        defer { if starting === pending { starting = nil } }
        do {
            if pending.cancelled { throw CancellationError() }
            // Before the session request: a refusal must not cost a server session.
            if options.microphone {
                guard await environment.requestMicrophonePermission() else {
                    throw FishAgentError(
                        .micPermissionDenied,
                        "The microphone permission is not granted. The user can turn it on in Settings."
                    )
                }
                if pending.cancelled { throw CancellationError() }
            }
            platformOwner = pending
            environment.applyAudioOutput(audioOutput, callActive: false)
            let started = try await AgentSession.start(
                auth,
                options: options,
                dependencies: SessionDependencies(
                    // Created only once a session token is in hand: a failed session request costs no room.
                    makeTransport: { [environment] in environment.makeTransport() },
                    tokens: environment.tokens,
                    scheduler: environment.scheduler,
                    onEvent: { [weak self] event in self?.handle(event, from: pending) }
                )
            )
            // endSession may have run while the session was being set up.
            // That late session never becomes the conversation's: it is closed
            // before it can keep the microphone or the connection.
            if pending.cancelled {
                try? await started.end()
                throw CancellationError()
            }
            session = started
            sessionStart = pending
            pending.published = true
            // Mirror, do not assume: a start without the microphone joins muted.
            micMuted = started.micMuted
            mode = started.mode
            status = started.status
            if started.status == .ended {
                // It ended while connecting.
                endReason = started.endReason
                releasePlatform(pending)
            } else if platformOwner === pending {
                // The audio session is live now; a forced speaker route only applies to a live session.
                environment.applyAudioOutput(audioOutput, callActive: true)
            }
            return started.sessionId
        } catch {
            releasePlatform(pending)
            if !pending.cancelled { status = .idle }
            throw error
        }
    }

    private func handle(_ event: ConversationEvent, from pending: PendingStart) {
        // A start that was hung up on shows nothing of what it still does.
        if pending.cancelled { return }
        switch event {
        case let .statusChange(next):
            // Before the session is published, an end is a failed start; runStart reports that as idle.
            if pending.published || next != .ended {
                status = next
                // A call can also end from the other side or the network.
                if next == .ended { releasePlatform(pending) }
            }
        case let .disconnect(reason):
            if pending.published { endReason = reason }
        case let .modeChange(next):
            mode = next
        case let .userTranscript(segmentId, text, isFinal):
            upsert(ChatMessage(id: "user-\(segmentId)", role: .user, text: text, isFinal: isFinal))
        case let .agentResponseDelta(segmentId, _, text):
            upsert(ChatMessage(id: "agent-\(segmentId)", role: .agent, text: text, isFinal: false))
        case let .agentResponse(segmentId, text):
            upsert(ChatMessage(id: "agent-\(segmentId)", role: .agent, text: text, isFinal: true))
        default:
            break
        }
        for stream in streams.values { stream.yield(event) }
    }

    private func upsert(_ message: ChatMessage) {
        if let index = messages.firstIndex(where: { $0.id == message.id }) {
            messages[index] = message
        } else {
            messages.append(message)
        }
    }

    /// Puts the app's audio back, if `owner`'s call still holds it, and frees the call slot.
    private func releasePlatform(_ owner: PendingStart) {
        if platformOwner === owner {
            platformOwner = nil
            environment.callDidEnd()
        }
        // The slot stays claimed while a newer start of this conversation is on its way.
        if starting == nil || starting === owner, liveSession == nil {
            CallSlot.release(ObjectIdentifier(self))
        }
    }

    // MARK: - Ending

    /// Hangs up. Safe to call at any time, also while a call is still starting:
    /// that start then fails with `CancellationError` and its session, if one
    /// was created, is closed. Does nothing when there is no call.
    public func endSession() async throws {
        let pending = starting
        let current = liveSession
        if let pending {
            pending.cancelled = true
            status = .ended
        }
        defer { if let sessionStart { releasePlatform(sessionStart) } }
        do {
            try await current?.end()
        } catch {
            // The cancelled start releases what it holds as it finishes; its failure is its caller's to see.
            _ = await pending?.task?.result
            throw error
        }
        _ = await pending?.task?.result
    }

    // MARK: - During a call

    /// After a start without the microphone, the first unmute captures it and
    /// asks for the permission if needed. Does nothing when there is no call.
    public func setMicMuted(_ muted: Bool) async throws {
        guard let current = liveSession else { return }
        if !muted {
            guard await environment.requestMicrophonePermission() else {
                throw FishAgentError(
                    .micPermissionDenied,
                    "The microphone permission is not granted. The user can turn it on in Settings."
                )
            }
        }
        try await current.setMicMuted(muted)
        micMuted = muted
    }

    /// Sends a typed message. The agent answers in text only unless `audio` is true. Does nothing when there is no call.
    public func sendUserMessage(_ text: String, audio: Bool = false) {
        liveSession?.sendUserMessage(text, audio: audio)
    }

    /// Tells the agent the user is active (typing, for one), so silence is not taken for idleness.
    public func sendUserActivity() {
        liveSession?.sendUserActivity()
    }

    /// Stops the agent's current reply.
    public func interrupt() {
        liveSession?.interrupt()
    }

    /// Changes where the agent's voice plays, now and for later calls.
    public func setAudioOutput(_ route: AudioOutputRoute) {
        audioOutput = route
        if platformOwner != nil {
            environment.applyAudioOutput(route, callActive: liveSession != nil)
        }
    }

    /// Registers a client tool for the current call and every later one.
    public func registerClientTool(_ name: String, handler: @escaping ClientToolHandler) {
        tools[name] = handler
        liveSession?.registerClientTool(name, handler: handler)
    }

    /// Every transcript segment of the current or last call, in conversation order.
    public func transcript() -> [TranscriptSegment] {
        session?.getTranscript() ?? []
    }
}
