// swift-tools-version: 5.9
// Swift Package Manager reads this manifest from the repository root, so it
// lives here while the sources are under ios/.
import PackageDescription

let package = Package(
    name: "FishAgent",
    platforms: [
        .iOS(.v15),
        // The SDK is for iOS. macOS is declared so `swift build` and `swift test`
        // run the platform-independent core on a development machine and in CI.
        .macOS(.v12),
    ],
    products: [
        .library(name: "FishAgent", targets: ["FishAgent"]),
    ],
    dependencies: [
        // 2.19.0 is the version the transport was recorded and tested against.
        // No LiveKit type appears in the public API, so an app can move to a
        // newer 2.x by itself.
        .package(url: "https://github.com/livekit/client-sdk-swift.git", from: "2.19.0"),
    ],
    targets: [
        .target(
            name: "FishAgent",
            dependencies: [.product(name: "LiveKit", package: "client-sdk-swift")],
            path: "ios/Sources/FishAgent",
            // Reports what Swift 6 language mode would reject, as warnings, so the
            // sources stay ready for it.
            swiftSettings: [.enableExperimentalFeature("StrictConcurrency")]
        ),
        .testTarget(
            name: "FishAgentTests",
            dependencies: ["FishAgent"],
            path: "ios/Tests/FishAgentTests",
            // Read from disk by the tests, through the test file's own path.
            exclude: ["Recordings"]
        ),
    ]
)
