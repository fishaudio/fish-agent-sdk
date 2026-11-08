// Experiment: drive the call with the unmodified web SDK (@fishaudio/agent-client)
// instead of FishCall, to see what breaks in React Native. Same surface as
// FishCall so the UI can switch engines.
import type { SessionToken } from '@fishaudio/agent-protocol';
import { AgentSession } from '@fishaudio/agent-client';
import { AudioSession } from '@livekit/react-native';
import type { CallCallbacks, ClientToolHandler, EndReason } from './FishCall';

export class ClientSdkCall {
  private constructor(private readonly session: AgentSession) {}

  static async start(
    token: SessionToken,
    options: { clientTools?: Record<string, ClientToolHandler>; callbacks: CallCallbacks },
  ): Promise<ClientSdkCall> {
    const cb = options.callbacks;
    const log = (text: string) => cb.onLog?.({ at: Date.now(), dir: 'sys', text });
    const startedAt = Date.now();
    let firstText = false;

    await AudioSession.startAudioSession();
    log('[agent-client] AgentSession.start');
    const session = await AgentSession.start({
      sessionToken: token,
      clientTools: options.clientTools,
      // The SDK's 15 s default is shorter than the server-side tool timeout and
      // too short for a tool that waits on the user; the call message does not say.
      clientToolTimeoutMs: 28_000,
      // The SDK's wake lock and output element are browser-only and skip themselves here.
      callbacks: {
        onConnect: ({ sessionId }) => log(`[agent-client] connect ${sessionId} (${Date.now() - startedAt} ms)`),
        onStatusChange: (status) => {
          log(`[agent-client] status ${status}`);
          if (status !== 'ended') cb.onStatus?.(status);
        },
        onModeChange: (mode) => cb.onMode?.(mode),
        onUserTranscript: (e) => cb.onTranscript?.({ id: e.segmentId, role: 'user', text: e.text, final: e.final }),
        onAgentResponseDelta: (e) => {
          if (!firstText) {
            firstText = true;
            log(`[agent-client] first agent text (${Date.now() - startedAt} ms)`);
          }
          cb.onTranscript?.({ id: e.segmentId, role: 'agent', text: e.text, final: false });
        },
        onAgentResponse: (e) => cb.onTranscript?.({ id: e.segmentId, role: 'agent', text: e.text, final: true }),
        onToolCallStarted: (e) =>
          cb.onToolEvent?.({
            type: 'tool.started',
            callId: e.callId,
            toolName: e.toolName,
            toolSource: e.source,
            nodeId: '', // not surfaced by the SDK; the UI ignores it
            input: e.input,
          }),
        onToolCallCompleted: (e) =>
          cb.onToolEvent?.({
            type: 'tool.completed',
            callId: e.callId,
            toolName: e.toolName,
            toolSource: e.source,
            nodeId: '', // not surfaced by the SDK; the UI ignores it
            output: e.output,
          }),
        onToolCallFailed: (e) =>
          cb.onToolEvent?.({
            type: 'tool.failed',
            callId: e.callId,
            toolName: e.toolName,
            toolSource: e.source,
            nodeId: '', // not surfaced by the SDK; the UI ignores it
            error: e.error,
          }),
        onError: (error) => {
          log(`[agent-client] error ${error.code}: ${error.message}`);
          cb.onError?.(`${error.code}: ${error.message}`);
        },
        onDisconnect: ({ reason }) => {
          log(`[agent-client] disconnect ${reason}`);
          void AudioSession.stopAudioSession().catch(() => undefined);
          cb.onEnded?.(reason as EndReason);
        },
      },
    });
    return new ClientSdkCall(session);
  }

  sendText(text: string, audio = false): void {
    this.session.sendUserMessage(text, { audio });
  }

  sendActivity(): void {
    this.session.sendUserActivity();
  }

  interrupt(): void {
    this.session.interrupt();
  }

  async setMuted(muted: boolean): Promise<void> {
    await this.session.setMicMuted(muted);
  }

  async hangUp(): Promise<void> {
    await this.session.end();
  }
}
