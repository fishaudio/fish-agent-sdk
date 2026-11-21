import Foundation

/// The wire contract, as in packages/protocol/src/realtime.ts and
/// docs/protocol.md. Compatibility is additive-only: unknown message types and
/// unknown fields are ignored.
enum WireProtocol {
    static let agentEventTopic = "agent-event"
    static let clientEventTopic = "client-event"

    /// Set by the agent, to epoch ms, once its pipeline is live. The only ready signal.
    static let agentReadyAttribute = "fish.agent.ready"
    /// Set by the agent framework seconds before the ready attribute. Proves the agent joined.
    static let agentStateAttribute = "lk.agent.state"
    /// Set by the client: "pending" after joining, then epoch ms once the agent's audio can be heard.
    static let clientAudioReadyAttribute = "fish.client.audio_ready"
    static let clientAudioReadyPending = "pending"

    static let transportLiveKit = "livekit"

    static let transcriptionTopic = "lk.transcription"
    static let segmentIdAttribute = "lk.segment_id"
    static let transcriptionFinalAttribute = "lk.transcription_final"

    /// Upper bound on a serialized `client_tool.result`. The data channel
    /// rejects packets above 64 000 bytes; this leaves room for the packet envelope.
    static let maxClientToolResultBytes = 60_000
}

/// Messages the client sends on `client-event`. Field names are written out, never derived.
enum ClientMessages {
    /// `audio: false` asks for a text-only reply. With audio on, the field is left out.
    static func userMessage(text: String, audio: Bool) -> JSONValue {
        var message: [String: JSONValue] = ["type": "user.message", "text": .string(text)]
        if !audio { message["audio"] = false }
        return .object(message)
    }

    static let userActivity: JSONValue = ["type": "user.activity"]
    static let userInterrupt: JSONValue = ["type": "user.interrupt"]
    static let userHangup: JSONValue = ["type": "user.hangup"]

    static func audioReady(atEpochMs: Int64) -> JSONValue {
        ["type": "client.audio_ready", "at": .number(Double(atEpochMs))]
    }

    /// `result` nil leaves the field out; `isError` false leaves that out too.
    static func toolResult(callId: String, result: JSONValue?, isError: Bool) -> JSONValue {
        var message: [String: JSONValue] = ["type": "client_tool.result", "callId": .string(callId)]
        if isError { message["isError"] = true }
        if let result { message["result"] = result }
        return .object(message)
    }
}

/// Reads the `expires_at` of a session token: `2026-11-21T04:47:21Z`, with
/// optional fractional seconds and a `Z` or `+08:00` style offset.
enum ISO8601 {
    /// Epoch milliseconds, or nil when the text is not in that format.
    static func parseEpochMs(_ text: String) -> Int64? {
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        for options: ISO8601DateFormatter.Options in [
            [.withInternetDateTime, .withFractionalSeconds],
            [.withInternetDateTime],
        ] {
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = options
            if let date = formatter.date(from: trimmed) {
                return Int64((date.timeIntervalSince1970 * 1000).rounded())
            }
        }
        return nil
    }
}
