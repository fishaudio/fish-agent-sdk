import Foundation

/// Every failure the SDK reports, thrown from calls or delivered as `ConversationEvent.error`.
public struct FishAgentError: Error, LocalizedError, Sendable {
    /// What went wrong. The raw values are the codes the Web and React Native
    /// SDKs and the documentation use.
    ///
    /// New codes can be added in a minor release, so keep a `default` when
    /// switching over them.
    public enum Code: String, Sendable, CaseIterable {
        /// The session request failed: no response, or a status this SDK has no narrower code for.
        case sessionRequestFailed = "session_request_failed"
        /// The agent does not accept sessions without an API key.
        case agentNotPublic = "agent_not_public"
        /// The agent restricts origins and the request's origin is not on its list.
        case originForbidden = "origin_forbidden"
        /// The agent owner's account has no Agent credit left (HTTP 402).
        case insufficientCredit = "insufficient_credit"
        /// The session uses a transport this SDK version does not support. Upgrade the SDK.
        case unsupportedTransport = "unsupported_transport"
        /// The microphone permission is not granted.
        case micPermissionDenied = "mic_permission_denied"
        /// A requested audio device could not be activated. Not raised by this SDK today.
        case deviceChangeFailed = "device_change_failed"
        /// The realtime connection could not be set up, or a message could not be sent.
        case connectionFailed = "connection_failed"
        /// The session token's join deadline has passed. Request a new one.
        case sessionExpired = "session_expired"
        /// A client tool failed, is not registered, or its result could not be sent.
        case toolFailed = "tool_failed"
        /// A client tool did not return in time.
        case toolTimeout = "tool_timeout"
        /// An upstream model or speech provider failed during the session.
        case providerError = "provider_error"
        /// The agent runtime hit an internal error.
        case internalError = "internal_error"
    }

    /// Pipeline stage a `providerError` or `internalError` came from.
    public enum Stage: String, Sendable, CaseIterable {
        case llm, stt, tts, runtime
    }

    public let code: Code
    public let message: String
    /// HTTP status of the failing session request, when the error came from there.
    public let statusCode: Int?
    /// Which stage failed, when the runtime said. Only on provider and internal errors.
    public let stage: Stage?
    /// Only on provider and internal errors. `true`: the runtime is still going
    /// to answer this turn by itself, so a light hint is enough. `false`: the
    /// turn is lost. `nil`: the runtime did not say. Never means the session ended.
    public let recovered: Bool?
    /// The error underneath, when there is one.
    public let underlyingError: (any Error)?

    public init(
        _ code: Code,
        _ message: String,
        statusCode: Int? = nil,
        stage: Stage? = nil,
        recovered: Bool? = nil,
        underlyingError: (any Error)? = nil
    ) {
        self.code = code
        self.message = message
        self.statusCode = statusCode
        self.stage = stage
        self.recovered = recovered
        self.underlyingError = underlyingError
    }

    public var errorDescription: String? { message }
}
