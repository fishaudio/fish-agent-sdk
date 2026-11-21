import Foundation
import XCTest
@testable import FishAgent

final class ValuesTests: XCTestCase {
    // MARK: - ISO 8601

    func testReadsTheFormatsTheAPIUses() {
        let base: Int64 = 1_577_836_800_000 // 2020-01-01T00:00:00Z
        XCTAssertEqual(ISO8601.parseEpochMs("2020-01-01T00:00:00Z"), base)
        XCTAssertEqual(ISO8601.parseEpochMs("2020-01-01T00:00:00.123Z"), base + 123)
        XCTAssertEqual(ISO8601.parseEpochMs("2020-01-01T08:00:00+08:00"), base)
        XCTAssertEqual(ISO8601.parseEpochMs("2020-01-01T08:00:00.500+08:00"), base + 500)
    }

    func testReturnsNilForAnythingElse() {
        for text in ["", "not-a-date", "2020-01-01", "2020-01-01T00:00:00", "2020-13-01T00:00:00Z"] {
            XCTAssertNil(ISO8601.parseEpochMs(text), text)
        }
    }

    // MARK: - JSON values

    func testValuesSurviveARoundTripThroughJSON() throws {
        let value: JSONValue = [
            "text": "hi/there", "count": 2, "ratio": 0.5, "ok": true, "nothing": nil,
            "list": [1, "two", nil, ["deep": false]],
        ]
        XCTAssertEqual(try JSONValue(data: try value.encoded()), value)
        // Slashes are not escaped, so sizes match the other SDKs'.
        XCTAssertTrue(String(decoding: try value.encoded(), as: UTF8.self).contains("hi/there"))
    }

    func testKeepsBooleansAndNumbersApart() throws {
        let parsed = try JSONValue(data: Data(#"{"t":true,"one":1,"zero":0,"s":"true","n":"30"}"#.utf8))
        XCTAssertEqual(parsed["t"], .bool(true))
        XCTAssertEqual(parsed["one"], .number(1))
        XCTAssertEqual(parsed["zero"], .number(0))
        XCTAssertNil(parsed["s"]?.boolValue)
        XCTAssertNil(parsed["n"]?.numberValue)
        XCTAssertNil(parsed["one"]?.boolValue)
    }

    func testWholeNumbersAreWrittenWithoutAFraction() throws {
        let text = String(decoding: try JSONValue.object(["at": .number(1_795_236_340_924), "n": 21]).encoded(), as: UTF8.self)
        XCTAssertEqual(text, #"{"at":1795236340924,"n":21}"#)
    }

    func testRejectsNumbersJSONCannotHold() {
        XCTAssertThrowsError(try JSONValue.number(.nan).encoded())
        XCTAssertThrowsError(try JSONValue.array([.number(.infinity)]).encoded())
    }

    // MARK: - Session token

    func testReadsABackendResponseAsItIs() throws {
        let token = try SessionToken(json: Data(#"""
        {"transport":"livekit","session_id":"sess-9","expires_at":"2099-01-01T00:00:00Z",
         "max_duration_seconds":1800,"livekit_url":"wss://x","token":"jwt","region":"ap"}
        """#.utf8))
        XCTAssertEqual(token.transport, "livekit")
        XCTAssertEqual(token.sessionId, "sess-9")
        XCTAssertEqual(token.maxDurationSeconds, 1800)
        XCTAssertEqual(token.livekitUrl, "wss://x")
        XCTAssertEqual(token.token, "jwt")
    }

    func testRefusesDataThatIsNotASessionToken() {
        for text in ["", "[]", "\"token\"", #"{"session_id":"s"}"#, #"{"transport":"livekit"}"#] {
            XCTAssertThrowsError(try SessionToken(json: Data(text.utf8)), text) { error in
                XCTAssertTrue(error is SessionToken.InvalidTokenError)
            }
        }
    }

    func testDoesNotPrintTheJoinToken() throws {
        let token = try SessionToken(json: Data(#"{"transport":"livekit","session_id":"s","token":"secret-jwt"}"#.utf8))
        XCTAssertFalse("\(token)".contains("secret-jwt"))
    }

    // MARK: - Tool timeout

    func testTheTimeoutMarginIsTheSmallerOfOneSecondAndTenPercent() {
        XCTAssertEqual(ClientToolDispatcher.timeout(fromAgentMs: 30000, fallbackMs: 15000), 29000)
        XCTAssertEqual(ClientToolDispatcher.timeout(fromAgentMs: 5000, fallbackMs: 15000), 4500)
        XCTAssertEqual(ClientToolDispatcher.timeout(fromAgentMs: nil, fallbackMs: 15000), 15000)
        XCTAssertEqual(ClientToolDispatcher.timeout(fromAgentMs: .infinity, fallbackMs: 15000), 15000)
        XCTAssertEqual(ClientToolDispatcher.timeout(fromAgentMs: -1, fallbackMs: 15000), 15000)
    }
}
