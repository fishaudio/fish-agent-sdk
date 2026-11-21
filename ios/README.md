# Fish Agent iOS SDK

Voice calls with a [Fish Audio](https://fish.audio) agent in a native iOS app. The Swift package is declared in [`Package.swift`](../Package.swift) at the repository root; its sources are here.

```swift
import FishAgent

@StateObject private var conversation = Conversation()

let token = try SessionToken(json: responseBodyFromYourBackend)
try await conversation.startSession(.sessionToken(token))
```

- **Docs:** [`docs/ios.md`](../docs/ios.md)
- **Example app:** [`examples/ios`](../examples/ios)
- **Requirements:** iOS 15, Xcode 16.3

It has been checked on an iPhone 12 and a simulator. The docs list what was checked and what is still open.

## Working on it

```sh
swift build        # from the repository root
swift test
```

The tests run on the Mac. They include the conformance fixtures shared with the other SDKs (`packages/protocol/fixtures`) and replays of event sequences recorded from real calls (`Tests/FishAgentTests/Recordings`).

`Sources/FishAgent/Version.swift` is generated from `package.json` in this directory, which only exists so the SDK is versioned together with the JavaScript packages. Do not edit either by hand: `pnpm version-packages` updates both.
