import AVFoundation
import Foundation
import LiveKit

/// The real device. LiveKit and AVFoundation types stay in this file and the room adapter.
@MainActor
final class AppleEnvironment: ConversationEnvironment {
    let scheduler: Scheduler = TaskScheduler()

    let tokens = SessionTokenResolver(
        http: URLSessionHTTPClient(),
        now: { Int64((Date().timeIntervalSince1970 * 1000).rounded()) },
        clientTimezone: { TimeZone.current.identifier },
        sdkHeader: "agent-ios/\(FishAgentSDK.version)"
    )

    func requestMicrophonePermission() async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: return true
        case .notDetermined: return await AVCaptureDevice.requestAccess(for: .audio)
        default: return false
        }
    }

    func makeTransport() -> Transport {
        LiveKitTransport(
            room: LiveKitRoomAdapter(),
            scheduler: scheduler,
            now: { Int64((Date().timeIntervalSince1970 * 1000).rounded()) }
        )
    }

    // LiveKit configures, activates and deactivates the audio session by
    // itself as the call's audio starts and stops. The SDK does not touch
    // activation: two parties toggling it is what left the microphone silent
    // on a second call in the React Native SDK. It only states a preference.
    func applyAudioOutput(_ route: AudioOutputRoute, callActive: Bool) {
        #if os(iOS)
        // With the speaker preferred, a headset still takes over; without it, the receiver is the default.
        AudioManager.shared.audioSession.isSpeakerOutputPreferred = route != .earpiece
        guard callActive else { return }
        // "speaker" means the loudspeaker even with a headset connected.
        try? AVAudioSession.sharedInstance().overrideOutputAudioPort(route == .speaker ? .speaker : .none)
        #endif
    }

    func callDidEnd() {
        #if os(iOS)
        // LiveKit deactivates the session when the call's audio stops but
        // leaves the call category behind, which would make other audio in the
        // app quieter and ignore the silent switch. Only the category goes
        // back to the system default; activation stays LiveKit's.
        try? AVAudioSession.sharedInstance().setCategory(.soloAmbient, mode: .default, options: [])
        #endif
    }
}
