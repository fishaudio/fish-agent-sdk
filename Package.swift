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
    targets: [
        .target(
            name: "FishAgent",
            path: "ios/Sources/FishAgent"
        ),
        .testTarget(
            name: "FishAgentTests",
            dependencies: ["FishAgent"],
            path: "ios/Tests/FishAgentTests"
        ),
    ]
)
