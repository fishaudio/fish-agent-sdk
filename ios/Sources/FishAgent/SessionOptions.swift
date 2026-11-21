import Foundation

/// What your backend gets back from `POST /v1/agent/sessions`. Pass the
/// response body to `init(json:)` as it is; do not pick fields out of it.
///
/// `transport` is kept as text on purpose: a transport this SDK version does
/// not know fails the start with `unsupportedTransport`, which tells the user
/// to upgrade, instead of failing to parse.
public struct SessionToken: Sendable, CustomStringConvertible {
    public var transport: String
    public var sessionId: String
    /// The deadline to join, in ISO 8601. Not the length of the call.
    public var expiresAt: String?
    public var maxDurationSeconds: Int?
    public var livekitUrl: String?
    public var token: String?

    public init(
        transport: String,
        sessionId: String,
        expiresAt: String? = nil,
        maxDurationSeconds: Int? = nil,
        livekitUrl: String? = nil,
        token: String? = nil
    ) {
        self.transport = transport
        self.sessionId = sessionId
        self.expiresAt = expiresAt
        self.maxDurationSeconds = maxDurationSeconds
        self.livekitUrl = livekitUrl
        self.token = token
    }

    /// Why some text is not a session token.
    public struct InvalidTokenError: Error, LocalizedError, Sendable {
        public let message: String
        public var errorDescription: String? { message }
    }

    /// Reads the JSON your backend returned. Fields this SDK does not know are ignored.
    ///
    /// Throws `InvalidTokenError` when the data is not a JSON object or has no
    /// `transport` or `session_id`.
    public init(json: Data) throws {
        guard let body = try? JSONValue(data: json), case .object = body else {
            throw InvalidTokenError(message: "A session token must be a JSON object")
        }
        guard let transport = body["transport"]?.stringValue else {
            throw InvalidTokenError(message: "The session token has no `transport`")
        }
        guard let sessionId = body["session_id"]?.stringValue else {
            throw InvalidTokenError(message: "The session token has no `session_id`")
        }
        self.init(
            transport: transport,
            sessionId: sessionId,
            expiresAt: body["expires_at"]?.stringValue,
            maxDurationSeconds: body["max_duration_seconds"]?.numberValue.flatMap { Int(exactly: $0) },
            livekitUrl: body["livekit_url"]?.stringValue,
            token: body["token"]?.stringValue
        )
    }

    /// Leaves the join token out, so a session token can be logged.
    public var description: String { "SessionToken(transport: \(transport), sessionId: \(sessionId))" }
}

/// How a call gets its session.
public enum SessionAuth: Sendable {
    /// A session token your backend created with your API key. The recommended
    /// way for apps: your backend decides who may call, and no key ships in the app.
    case sessionToken(SessionToken)
    /// A public agent, by its ID. The SDK creates the session itself, without a
    /// key. Anyone with the ID can start sessions, billed to the agent's owner.
    case agentId(String)
}

/// Per-session switches for what the platform tells the agent on its own.
public struct SessionContextOptions: Sendable {
    /// Whether the agent knows the current date and time. `false` withholds
    /// them, `true` gives them even when the agent has them off, `nil` follows the agent.
    public var currentTime: Bool?
    public init(currentTime: Bool? = nil) { self.currentTime = currentTime }
}

/// Per-session replacements for the agent's configuration. Each field must be
/// allowed on the agent. A public agent accepts only `language` and `voiceId`.
public struct SessionOverrides: Sendable {
    /// The opening line, word for word. Use this or `firstMessagePrompt`, not both.
    public var firstMessage: String?
    /// Instructions the agent writes its opening line from.
    public var firstMessagePrompt: String?
    public var systemPrompt: String?
    /// The voice. Voices lean toward their own language, so pair it with `language`.
    public var voiceId: String?
    /// ISO 639-1 code, for example `"ja"`.
    public var language: String?
    /// Speech recognition model, for example `"deepgram:nova-3"`. API-key sessions only.
    public var asrModel: String?

    public init(
        firstMessage: String? = nil,
        firstMessagePrompt: String? = nil,
        systemPrompt: String? = nil,
        voiceId: String? = nil,
        language: String? = nil,
        asrModel: String? = nil
    ) {
        self.firstMessage = firstMessage
        self.firstMessagePrompt = firstMessagePrompt
        self.systemPrompt = systemPrompt
        self.voiceId = voiceId
        self.language = language
        self.asrModel = asrModel
    }
}

/// What a client tool is told about the call it is answering.
public struct ClientToolContext: Sendable {
    public let callId: String
    public let toolName: String
}

/// A tool the agent can call in the app.
///
/// Return the result, or `nil` for no result. Throw to report a failure to the
/// agent. A result that is too large to send (about 60 KB as JSON) is replaced
/// by an error.
///
/// Handlers do not run on the main actor. Mark the closure `@MainActor` to
/// touch the UI. The agent stops waiting after its own timeout; the handler's
/// task is then cancelled.
public typealias ClientToolHandler =
    @Sendable (_ params: [String: JSONValue], _ context: ClientToolContext) async throws -> JSONValue?

/// Options for a call. With `SessionAuth.sessionToken` only `clientTools`,
/// `clientToolTimeout` and `microphone` apply: your backend chose the rest
/// when it created the session.
public struct SessionOptions: Sendable {
    /// Experimental. The origin to present for a public agent that restricts
    /// origins, for example `"https://www.example.com"`. An app sends no origin
    /// by itself, so such an agent refuses it without this. Use an origin you
    /// own from the agent's list. May change or be removed in a minor release.
    public var origin: String?
    /// The Fish API base URL. Leave unset outside of testing.
    public var serverUrl: URL?
    /// Short for `overrides.language`. An explicit override wins.
    public var language: String?
    /// IANA timezone for the agent's sense of local time. Unset: the device's timezone is sent as a hint.
    public var timezone: String?
    public var context: SessionContextOptions?
    public var overrides: SessionOverrides?
    /// `{{name}}` values for the agent's prompt and first message: strings, numbers and booleans.
    public var dynamicVariables: [String: JSONValue]?
    /// Your identifier for the person calling, kept on the session record.
    public var endUserId: String?
    /// Your own tags, stored and returned as they are. The platform never reads them.
    public var metadata: [String: JSONValue]?
    /// Whether tool call events are sent to this app. `nil` follows the default (on).
    public var toolEvents: Bool?
    public var clientTools: [String: ClientToolHandler]
    /// How long a client tool gets when the agent does not say, in seconds. The agent's own timeout wins.
    public var clientToolTimeout: TimeInterval
    /// Capture the microphone when the call starts. `false` joins without it
    /// (for text-first screens); unmuting later starts the capture.
    public var microphone: Bool

    public init(
        origin: String? = nil,
        serverUrl: URL? = nil,
        language: String? = nil,
        timezone: String? = nil,
        context: SessionContextOptions? = nil,
        overrides: SessionOverrides? = nil,
        dynamicVariables: [String: JSONValue]? = nil,
        endUserId: String? = nil,
        metadata: [String: JSONValue]? = nil,
        toolEvents: Bool? = nil,
        clientTools: [String: ClientToolHandler] = [:],
        clientToolTimeout: TimeInterval = 15,
        microphone: Bool = true
    ) {
        self.origin = origin
        self.serverUrl = serverUrl
        self.language = language
        self.timezone = timezone
        self.context = context
        self.overrides = overrides
        self.dynamicVariables = dynamicVariables
        self.endUserId = endUserId
        self.metadata = metadata
        self.toolEvents = toolEvents
        self.clientTools = clientTools
        self.clientToolTimeout = clientToolTimeout
        self.microphone = microphone
    }
}
