import FishAgent
import SwiftUI

@main
struct FishAgentExampleApp: App {
    var body: some Scene {
        WindowGroup {
            CallScreen()
        }
    }
}

/// One screen: start a call, talk or type, hang up.
///
/// The app never holds the Fish API key. It asks a backend of yours for a
/// session token (see the README) and hands the response to the SDK as it is.
private let launched = Date()

struct CallScreen: View {
    // One Conversation for the screen. It can make any number of calls.
    @StateObject private var conversation = Conversation(
        defaults: SessionOptions(
            // Tools the agent can call in the app. Configure a client tool with
            // the same name on the agent for it to be used.
            clientTools: [
                "get_device_info": { _, _ in
                    await [
                        "model": .string(UIDevice.current.model),
                        "system": .string(UIDevice.current.systemName),
                        "systemVersion": .string(UIDevice.current.systemVersion),
                    ]
                },
            ]
        )
    )
    @State private var draft = ""
    @State private var errorText: String?

    private var isCalling: Bool {
        [.connecting, .connected, .reconnecting].contains(conversation.status)
    }

    private var isLive: Bool {
        [.connected, .reconnecting].contains(conversation.status)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(statusLine).font(.headline)
            if let errorText {
                Text(errorText).font(.footnote).foregroundColor(.red)
            }
            HStack {
                Button(isCalling ? "Hang up" : "Start call") {
                    if isCalling { endCall() } else { startCall() }
                }
                .buttonStyle(.borderedProminent)
                Button(conversation.micMuted ? "Unmute" : "Mute") { setMuted(!conversation.micMuted) }
                    .disabled(!isLive)
                Button("Audio: \(conversation.audioOutput.rawValue)") {
                    let routes = AudioOutputRoute.allCases
                    let next = routes[(routes.firstIndex(of: conversation.audioOutput)! + 1) % routes.count]
                    conversation.setAudioOutput(next)
                }
            }
            .buttonStyle(.bordered)

            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 10) {
                        ForEach(conversation.messages) { message in
                            Text("\(message.role == .user ? "You" : "Agent"): \(message.text)\(message.isFinal ? "" : " …")")
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .id(message.id)
                        }
                    }
                }
                .onChange(of: conversation.messages.last) { last in
                    if let last { proxy.scrollTo(last.id, anchor: .bottom) }
                }
            }

            HStack {
                TextField("Type a message", text: $draft)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit(send)
                Button("Send", action: send).disabled(!isLive)
            }
        }
        .padding()
        .task { await watchEvents() }
        .task { await runAutomationScript() }
        .onChange(of: stateLine) { line in log("state \(line)") }
    }

    private var statusLine: String {
        var line = conversation.status.rawValue
        if isLive { line += " · agent \(conversation.mode.rawValue)" }
        if let reason = conversation.endReason { line += " · \(reason.rawValue)" }
        return line
    }

    // MARK: - The call

    private func startCall(microphone: Bool = true) {
        Task {
            errorText = nil
            do {
                let token = try await fetchSessionToken()
                // Asks for the microphone permission if the user has not been asked yet.
                try await conversation.startSession(.sessionToken(token)) { $0.microphone = microphone }
            } catch is CancellationError {
                // Hung up while the call was starting. Nothing to show.
            } catch let error as FishAgentError {
                show(error)
            } catch {
                show(error.localizedDescription)
            }
        }
    }

    /// A public agent needs no backend: the SDK creates the session itself from
    /// the agent's ID. Anyone with the ID can do the same, so prefer a backend
    /// for an app with signed-in users. `origin` is only for an agent that
    /// restricts origins.
    private func startPublicCall(agentId: String, serverUrl: URL? = nil, origin: String? = nil) {
        Task {
            errorText = nil
            do {
                try await conversation.startSession(.agentId(agentId)) {
                    $0.serverUrl = serverUrl
                    $0.origin = origin
                }
            } catch is CancellationError {
            } catch let error as FishAgentError {
                show(error)
            } catch {
                show(error.localizedDescription)
            }
        }
    }

    private func endCall() {
        Task {
            do {
                try await conversation.endSession()
            } catch {
                show(error.localizedDescription)
            }
        }
    }

    private func setMuted(_ muted: Bool) {
        Task {
            do {
                try await conversation.setMicMuted(muted)
            } catch let error as FishAgentError {
                show(error)
            } catch {
                show(error.localizedDescription)
            }
        }
    }

    private func send() {
        conversation.sendUserMessage(draft)
        draft = ""
    }

    /// Your backend creates the session with your API key and returns the response unchanged.
    private func fetchSessionToken() async throws -> SessionToken {
        let configured = ProcessInfo.processInfo.environment["FISH_AGENT_TOKEN_URL"]
            ?? Bundle.main.object(forInfoDictionaryKey: "FishAgentTokenURL") as? String ?? ""
        guard let url = URL(string: configured) else { throw URLError(.badURL) }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data("{}".utf8)
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200 ... 299).contains(http.statusCode) else {
            throw NSError(domain: "FishAgentExample", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "The token backend answered \((response as? HTTPURLResponse)?.statusCode ?? 0): \(String(decoding: data, as: UTF8.self))",
            ])
        }
        return try SessionToken(json: data)
    }

    // MARK: - Events

    private func watchEvents() async {
        for await event in conversation.events() {
            switch event {
            // A failure that does not end the call. The end of a call arrives as disconnect.
            case let .error(error):
                log("error code=\(error.code.rawValue) recovered=\(String(describing: error.recovered))")
                if error.recovered != true { show("\(error.code.rawValue): \(error.message)") }
            case let .message(role, text): log("message role=\(role.rawValue) text=\(text)")
            case let .connect(sessionId): log("connect sessionId=\(sessionId)")
            case let .disconnect(reason): log("disconnect reason=\(reason.rawValue)")
            case let .toolCallStarted(call): log("tool.started tool=\(call.toolName) source=\(call.source.rawValue)")
            case let .toolCallCompleted(call): log("tool.completed tool=\(call.toolName) output=\(call.output)")
            case let .toolCallFailed(call): log("tool.failed tool=\(call.toolName) error=\(call.error)")
            default: break
            }
        }
    }

    private func show(_ message: String) {
        errorText = message
        log("shown-error message=\(message)")
    }

    private func show(_ error: FishAgentError) {
        show("\(error.code.rawValue): \(error.message)")
        if let underlying = error.underlyingError { log("underlying-error \(underlying)") }
    }

    // MARK: - Scripted checks

    private var stateLine: String {
        "status=\(conversation.status.rawValue) mode=\(conversation.mode.rawValue) muted=\(conversation.micMuted) "
            + "route=\(conversation.audioOutput.rawValue) endReason=\(conversation.endReason?.rawValue ?? "nil")"
    }

    /// One line per state change and event, for reading from the app's console.
    private func log(_ line: String) {
        print("FishExample \(String(format: "%7.2f", Date().timeIntervalSince(launched))) \(line)")
    }

    /// Runs a script of commands given in the `FISH_EXAMPLE_SCRIPT` environment
    /// variable, so a call can be checked without touching the screen (see the
    /// README). Debug builds only.
    ///
    ///     start; wait 12; msg Where is my order?; wait 10; route earpiece; wait 2; hangup
    private func runAutomationScript() async {
        #if DEBUG
        setvbuf(stdout, nil, _IOLBF, 0)
        guard let script = ProcessInfo.processInfo.environment["FISH_EXAMPLE_SCRIPT"] else { return }
        log("state \(stateLine)")
        for step in script.split(separator: ";").map({ $0.trimmingCharacters(in: .whitespaces) }) where !step.isEmpty {
            let parts = step.split(separator: " ", maxSplits: 1).map(String.init)
            let argument = parts.count > 1 ? parts[1] : ""
            log("cmd \(step)")
            switch parts[0] {
            case "start": startCall()
            case "start-text": startCall(microphone: false)
            case "start-public":
                // agentId|serverUrl|origin; the last two are optional.
                let fields = argument.split(separator: "|", omittingEmptySubsequences: false).map(String.init)
                startPublicCall(
                    agentId: fields[0],
                    serverUrl: fields.count > 1 && !fields[1].isEmpty ? URL(string: fields[1]) : nil,
                    origin: fields.count > 2 && !fields[2].isEmpty ? fields[2] : nil
                )
            case "hangup": endCall()
            case "mute": setMuted(true)
            case "unmute": setMuted(false)
            case "msg": conversation.sendUserMessage(argument)
            case "interrupt": conversation.interrupt()
            case "route": if let route = AudioOutputRoute(rawValue: argument) { conversation.setAudioOutput(route) }
            case "wait": try? await Task.sleep(nanoseconds: UInt64((Double(argument) ?? 1) * 1_000_000_000))
            case "audio": logAudioSession()
            default: log("unknown command \(step)")
            }
        }
        log("script.done")
        #endif
    }

    #if DEBUG
    private func logAudioSession() {
        let session = AVAudioSession.sharedInstance()
        log("audio category=\(session.category.rawValue) mode=\(session.mode.rawValue) options=\(session.categoryOptions.rawValue) "
            + "outputs=\(session.currentRoute.outputs.map(\.portType.rawValue))")
    }
    #endif
}

#if DEBUG
import AVFoundation
#endif
