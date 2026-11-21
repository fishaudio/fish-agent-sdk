import XCTest
@testable import FishAgent

final class VersionTests: XCTestCase {
    /// Version.swift is generated from ios/package.json; a release that bumps
    /// one without the other would ship the wrong version in the SDK header.
    func testVersionMatchesTheMarkerPackage() throws {
        let manifestURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // FishAgentTests
            .deletingLastPathComponent() // Tests
            .deletingLastPathComponent() // ios
            .appendingPathComponent("package.json")
        let manifest = try JSONSerialization.jsonObject(with: Data(contentsOf: manifestURL))
        let version = try XCTUnwrap((manifest as? [String: Any])?["version"] as? String)
        XCTAssertEqual(FishAgentSDK.version, version)
    }
}
