import Foundation

let defaultServerURL = "https://api.fish.audio"

struct HTTPResponse {
    let status: Int
    let body: Data
}

/// The one HTTP call the SDK makes: creating a session for a public agent. A seam for tests.
protocol HTTPClient: Sendable {
    /// Throws when no response arrives.
    func post(url: URL, headers: [String: String], body: Data) async throws -> HTTPResponse
}

/// `URLSession`, so the SDK adds no HTTP library to the app.
struct URLSessionHTTPClient: HTTPClient {
    func post(url: URL, headers: [String: String], body: Data) async throws -> HTTPResponse {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.httpBody = body
        request.timeoutInterval = 30
        for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
        let (data, response) = try await URLSession.shared.data(for: request)
        return HTTPResponse(status: (response as? HTTPURLResponse)?.statusCode ?? 0, body: data)
    }
}

/// Turns a `SessionAuth` into a session token the SDK can join with: checks a
/// token the app passed in, or creates a session for a public agent.
/// Port of packages/client/src/sessionToken.ts.
struct SessionTokenResolver: Sendable {
    let http: any HTTPClient
    /// Current time in epoch ms.
    let now: @Sendable () -> Int64
    /// The device's IANA timezone, sent as a hint.
    let clientTimezone: @Sendable () -> String?
    /// The `X-Fish-SDK` header value, for example `agent-ios/1.2.0`.
    let sdkHeader: String

    func resolve(_ auth: SessionAuth, options: SessionOptions) async throws -> SessionToken {
        switch auth {
        case let .sessionToken(token):
            return try validate(token)
        case let .agentId(agentId):
            return try validate(try await createPublicSession(agentId: agentId, options: options))
        }
    }

    /// The transport is checked first: an SDK that is too old should say so, whatever else is wrong.
    func validate(_ token: SessionToken) throws -> SessionToken {
        guard token.transport == WireProtocol.transportLiveKit else {
            throw FishAgentError(
                .unsupportedTransport,
                "Session token uses transport \"\(token.transport)\" which this SDK version does not "
                    + "support; please upgrade the Fish Agent SDK"
            )
        }
        // A deadline that cannot be read does not block the call: the server enforces it anyway.
        if let expiresAt = token.expiresAt.flatMap(ISO8601.parseEpochMs), expiresAt <= now() {
            throw FishAgentError(
                .sessionExpired,
                "The session token's join deadline has passed; request a new session"
            )
        }
        return token
    }

    private func createPublicSession(agentId: String, options: SessionOptions) async throws -> SessionToken {
        var base = (options.serverUrl?.absoluteString ?? defaultServerURL)
        if base.hasSuffix("/") { base.removeLast() }
        guard let url = URL(string: base + "/v1/agent/sessions") else {
            throw FishAgentError(.sessionRequestFailed, "The server URL is not valid")
        }
        var headers = ["Content-Type": "application/json", "X-Fish-SDK": sdkHeader]
        // An app sends no Origin by itself; a public agent that restricts origins needs one.
        let origin = options.origin.flatMap { $0.isEmpty ? nil : $0 }
        if let origin { headers["Origin"] = origin }

        let response: HTTPResponse
        do {
            response = try await http.post(url: url, headers: headers, body: try requestBody(agentId: agentId, options: options).encoded())
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw FishAgentError(.sessionRequestFailed, "Could not reach the session endpoint", underlyingError: error)
        }
        guard (200 ... 299).contains(response.status) else {
            throw sessionError(response, originSent: origin != nil)
        }
        do {
            return try SessionToken(json: response.body)
        } catch {
            throw FishAgentError(
                .sessionRequestFailed,
                "The session endpoint returned a response this SDK cannot read",
                statusCode: response.status,
                underlyingError: error
            )
        }
    }

    func requestBody(agentId: String, options: SessionOptions) -> JSONValue {
        var body: [String: JSONValue] = ["agent_id": .string(agentId)]
        if let timezone = options.timezone, !timezone.isEmpty { body["timezone"] = .string(timezone) }
        if let hint = clientTimezone(), !hint.isEmpty { body["client_timezone"] = .string(hint) }
        if let currentTime = options.context?.currentTime {
            body["context"] = ["current_time": .bool(currentTime)]
        }
        let language = options.language.flatMap { $0.isEmpty ? nil : $0 }
        if language != nil || options.overrides != nil {
            var overrides: [String: JSONValue] = [:]
            // `language` is short for overrides.language; an explicit override wins.
            if let value = options.overrides?.language ?? language { overrides["language"] = .string(value) }
            if let value = options.overrides?.firstMessage { overrides["first_message"] = .string(value) }
            if let value = options.overrides?.firstMessagePrompt { overrides["first_message_prompt"] = .string(value) }
            if let value = options.overrides?.systemPrompt { overrides["system_prompt"] = .string(value) }
            if let value = options.overrides?.voiceId { overrides["voice_id"] = .string(value) }
            if let value = options.overrides?.asrModel { overrides["asr"] = ["model": .string(value)] }
            body["overrides"] = .object(overrides)
        }
        if let variables = options.dynamicVariables { body["dynamic_variables"] = .object(variables) }
        if let endUserId = options.endUserId, !endUserId.isEmpty { body["end_user_id"] = .string(endUserId) }
        if let metadata = options.metadata { body["metadata"] = .object(metadata) }
        if let toolEvents = options.toolEvents { body["tool_events"] = .bool(toolEvents) }
        return .object(body)
    }

    private func sessionError(_ response: HTTPResponse, originSent: Bool) -> FishAgentError {
        let body = try? JSONValue(data: response.body)
        let status = response.status
        let message = body?["message"]?.stringValue ?? body?["error"]?.stringValue
            ?? "Session request failed with HTTP \(status)"
        // 409 alone is ambiguous (the server also uses it for an unpublished
        // agent); only the coded arm means "this SDK is too old".
        if status == 409, body?["code"]?.stringValue == "unsupported_transport" {
            return FishAgentError(.unsupportedTransport, "\(message); please upgrade the Fish Agent SDK", statusCode: status)
        }
        if status == 402 {
            return FishAgentError(.insufficientCredit, message, statusCode: status)
        }
        if status == 403 {
            guard message.range(of: "origin", options: .caseInsensitive) != nil else {
                return FishAgentError(.agentNotPublic, message, statusCode: status)
            }
            let hint = originSent ? "" : "; the agent restricts origins, so pass `origin` with one of its allowed origins"
            return FishAgentError(.originForbidden, message + hint, statusCode: status)
        }
        return FishAgentError(.sessionRequestFailed, message, statusCode: status)
    }
}
