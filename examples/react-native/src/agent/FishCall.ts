// A minimal Fish agent call built only on `livekit-client` and
// `@fishaudio/agent-protocol`, the way a third party would integrate from the
// protocol alone. It mirrors packages/client/src/transport/livekit.ts and
// session/agentSession.ts, minus the browser audio plumbing: in React Native
// the native WebRTC stack plays remote audio on its own.
import {
  AGENT_EVENT_TOPIC,
  AGENT_READY_ATTRIBUTE,
  CLIENT_AUDIO_READY_ATTRIBUTE,
  CLIENT_AUDIO_READY_PENDING,
  CLIENT_EVENT_TOPIC,
  type AgentSessionMessage,
  type ClientSessionMessage,
  type SessionEndedReason,
  type SessionToken,
  type ToolCallEventMessage,
} from '@fishaudio/agent-protocol';
import { AudioSession } from '@livekit/react-native';
import {
  ConnectionState,
  createLocalAudioTrack,
  DisconnectReason,
  Room,
  RoomEvent,
  Track,
  type LocalAudioTrack,
  type RemoteTrack,
} from 'livekit-client';

/** Not exported by the protocol package; the web SDK hardcodes it too. */
const AGENT_STATE_ATTRIBUTE = 'lk.agent.state';
const AGENT_JOIN_TIMEOUT_MS = 15_000;
/** How long to wait for fish.agent.ready before trusting lk.agent.state alone (older runtimes). */
const READY_FALLBACK_MS = 8_000;
const SESSION_ENDED_GRACE_MS = 10_000;
const CLIENT_TOOL_TIMEOUT_MS = 25_000;
const KNOWN_END_REASONS = new Set<string>([
  'user_hangup',
  'agent_hangup',
  'conversation_timeout',
  'escalated',
  'llm_endpoint_failure',
]);

export type CallStatus = 'connecting' | 'connected' | 'reconnecting' | 'ended';
export type AgentMode = 'listening' | 'thinking' | 'speaking';
export type EndReason = SessionEndedReason | 'connection_lost';

export interface TranscriptItem {
  id: string;
  role: 'user' | 'agent';
  text: string;
  final: boolean;
  typed?: boolean;
}

export interface LogEntry {
  at: number;
  dir: 'in' | 'out' | 'sys';
  text: string;
}

export interface CallMetrics {
  startedAt: number;
  roomConnectedAt?: number;
  agentReadyAt?: number;
  firstAgentAudioAt?: number;
  firstAgentTextAt?: number;
}

export type ClientToolHandler = (
  params: Record<string, unknown>,
  context: { callId: string; toolName: string },
) => unknown | Promise<unknown>;

export interface CallCallbacks {
  onStatus?: (status: CallStatus) => void;
  onMode?: (mode: AgentMode) => void;
  onTranscript?: (item: TranscriptItem) => void;
  onToolEvent?: (event: ToolCallEventMessage) => void;
  onError?: (message: string) => void;
  onEnded?: (reason: EndReason, transportReason?: string) => void;
  onLog?: (entry: LogEntry) => void;
  onMetrics?: (metrics: CallMetrics) => void;
}

export interface FishCallOptions {
  clientTools?: Record<string, ClientToolHandler>;
  callbacks: CallCallbacks;
}

function hasType(value: unknown): value is { type: string } {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';
}

export class FishCall {
  readonly sessionId: string;
  private readonly room: Room;
  private readonly cb: CallCallbacks;
  private readonly tools: Record<string, ClientToolHandler>;

  private status: CallStatus = 'connecting';
  private mode: AgentMode = 'listening';
  private agentPresent = false;
  private pending: ClientSessionMessage[] = [];
  private audioReadyStamp?: string;
  private announcedEnd?: EndReason;
  private endedByClient = false;
  private joinTimer?: ReturnType<typeof setTimeout>;
  private graceTimer?: ReturnType<typeof setTimeout>;
  private readyFallbackTimer?: ReturnType<typeof setTimeout>;
  private typedCount = 0;
  private micTrack?: LocalAudioTrack;
  readonly metrics: CallMetrics = { startedAt: Date.now() };

  private constructor(token: SessionToken, options: FishCallOptions) {
    this.sessionId = token.session_id;
    this.cb = options.callbacks;
    this.tools = options.clientTools ?? {};
    this.room = new Room();
  }

  static async start(token: SessionToken, options: FishCallOptions): Promise<FishCall> {
    const call = new FishCall(token, options);
    try {
      await call.connect(token);
    } catch (error) {
      await call.room.disconnect().catch(() => undefined);
      call.micTrack?.stop();
      await AudioSession.stopAudioSession().catch(() => undefined);
      call.finalize('connection_lost');
      throw error;
    }
    return call;
  }

  // ---- public API ----

  sendText(text: string, audio = false): void {
    this.sendWhenReady({ type: 'user.message', text, audio });
    const id = `typed_${++this.typedCount}`;
    this.cb.onTranscript?.({ id, role: 'user', text, final: true, typed: true });
  }

  sendActivity(): void {
    this.sendWhenReady({ type: 'user.activity' });
  }

  interrupt(): void {
    this.sendWhenReady({ type: 'user.interrupt' });
  }

  async setMuted(muted: boolean): Promise<void> {
    await this.room.localParticipant.setMicrophoneEnabled(!muted);
    this.log('sys', muted ? 'mic muted' : 'mic unmuted');
  }

  async hangUp(): Promise<void> {
    if (this.status === 'ended') return;
    this.endedByClient = true;
    try {
      await this.publish({ type: 'user.hangup' });
    } catch {
      // best effort: the participant leaving is the runtime's fallback signal
    }
    await this.room.disconnect();
    this.finalize('user_hangup');
  }

  getStatus(): CallStatus {
    return this.status;
  }

  // ---- connect ----

  private async connect(token: SessionToken): Promise<void> {
    const room = this.room;
    this.wireRoomEvents(room);

    await AudioSession.startAudioSession();
    this.log('sys', 'audio session started');

    // Capture before joining so a mic denial fails the start without
    // dispatching an agent (same order as the web transport).
    this.micTrack = await createLocalAudioTrack({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    });
    this.log('sys', 'microphone captured');

    await room.connect(token.livekit_url, token.token);
    this.metrics.roomConnectedAt = Date.now();
    this.emitMetrics();
    this.log('sys', `room connected (${Date.now() - this.metrics.startedAt} ms)`);

    // Announce "pending" right away: the runtime holds its opener for a client
    // that promises to report playback readiness.
    this.publishAudioReady(this.audioReadyStamp ?? CLIENT_AUDIO_READY_PENDING);
    // Agent attributes are sticky; an agent that set them before we joined fires no change event.
    this.replayAgentAttributes();

    await room.localParticipant.publishTrack(this.micTrack);
    this.log('sys', 'microphone published');

    if (this.status === 'connecting') this.setStatus('connected');
    if (!this.agentPresent) {
      this.joinTimer = setTimeout(() => {
        if (this.agentPresent || this.status === 'ended') return;
        this.cb.onError?.('The agent did not join within 15 s');
        void this.room.disconnect();
        this.finalize('connection_lost');
      }, AGENT_JOIN_TIMEOUT_MS);
    }
  }

  private wireRoomEvents(room: Room): void {
    room.on(RoomEvent.DataReceived, (payload, _participant, _kind, topic) => {
      if (topic !== AGENT_EVENT_TOPIC) return;
      let message: unknown;
      try {
        message = JSON.parse(new TextDecoder().decode(payload));
      } catch {
        this.log('in', `unparseable payload on ${topic}`);
        return;
      }
      if (hasType(message)) {
        this.log('in', JSON.stringify(message));
        this.handleAgentEvent(message as AgentSessionMessage);
      }
    });

    room.on(RoomEvent.ParticipantAttributesChanged, (changed, participant) => {
      if (participant.isLocal) return;
      this.log('in', `attrs ${JSON.stringify(changed)}`);
      this.handleAgentAttributes(changed);
    });
    room.on(RoomEvent.ParticipantConnected, (participant) => {
      this.log('sys', `participant joined: ${participant.identity}`);
      this.handleAgentAttributes(participant.attributes ?? {});
    });

    room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
      if (track.kind !== Track.Kind.Audio) return;
      this.log('sys', `agent audio subscribed (${track.source})`);
      // Native WebRTC starts playout as soon as the track is subscribed and the
      // audio session is active; there is no autoplay gate to wait for.
      if (track.source === Track.Source.Microphone) this.markAudioReady();
    });

    room.registerTextStreamHandler('lk.transcription', async (reader, participantInfo) => {
      const attrs = reader.info.attributes ?? {};
      const segmentId = attrs['lk.segment_id'];
      if (!segmentId) return;
      const role = participantInfo.identity === room.localParticipant.identity ? 'user' : 'agent';
      const finalAttr = attrs['lk.transcription_final'] === 'true';
      let text = '';
      let aborted = false;
      let deltas = 0;
      const openedAt = Date.now();
      let firstDeltaAt = 0;
      try {
        for await (const delta of reader) {
          text += delta;
          deltas += 1;
          if (!firstDeltaAt) firstDeltaAt = Date.now();
          this.handleTranscript({ id: segmentId, role, text, final: false });
        }
      } catch {
        aborted = true;
      }
      if (role === 'agent') {
        // Timing probe: playout-synced streams should spread deltas over the utterance.
        this.log(
          'sys',
          `agent segment ${segmentId.slice(-6)}: ${deltas} deltas, first after ${firstDeltaAt ? firstDeltaAt - openedAt : -1} ms, closed after ${Date.now() - openedAt} ms`,
        );
      }
      if (text) {
        const final = role === 'agent' ? true : finalAttr && !aborted;
        this.handleTranscript({ id: segmentId, role, text, final });
      }
    });

    room.on(RoomEvent.Reconnecting, () => {
      this.log('sys', 'reconnecting');
      if (this.status !== 'ended') this.setStatus('reconnecting');
    });
    // A signal-only resume (the common case on a network blip) fires only this
    // event, not Reconnecting; without it the UI says "connected" through the outage.
    room.on(RoomEvent.SignalReconnecting, () => {
      this.log('sys', 'signal reconnecting');
      if (this.status !== 'ended') this.setStatus('reconnecting');
    });
    room.on(RoomEvent.Reconnected, () => {
      this.log('sys', `reconnected, remote participants: ${room.remoteParticipants.size}`);
      // A full reconnect recreates our participant without its attributes.
      this.publishAudioReady(this.audioReadyStamp ?? CLIENT_AUDIO_READY_PENDING);
      if (room.remoteParticipants.size === 0) {
        this.handleAgentLeft();
        return;
      }
      this.replayAgentAttributes();
      if (this.status === 'reconnecting') this.setStatus('connected');
    });
    room.on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
      const name = reason === undefined ? undefined : DisconnectReason[reason];
      this.log('sys', `disconnected: ${name ?? 'unknown'}`);
      this.handleTransportEnd(name);
    });
    room.on(RoomEvent.ParticipantDisconnected, (participant) => {
      this.log('sys', `participant left: ${participant.identity}`);
      if (room.remoteParticipants.size === 0) {
        queueMicrotask(() => {
          if (room.state === ConnectionState.Connected && room.remoteParticipants.size === 0) {
            this.handleAgentLeft();
          }
        });
      }
    });
  }

  // ---- inbound ----

  private replayAgentAttributes(): void {
    for (const participant of this.room.remoteParticipants.values()) {
      this.log('in', `replayed attrs of ${participant.identity}: ${JSON.stringify(participant.attributes ?? {})}`);
      this.handleAgentAttributes(participant.attributes ?? {});
    }
  }

  private handleAgentAttributes(attrs: Record<string, string>): void {
    if (attrs[AGENT_READY_ATTRIBUTE]) this.handleAgentPresent();
    const state = attrs[AGENT_STATE_ATTRIBUTE];
    if (state) {
      // The agent publishes lk.agent.state ("listening") seconds before
      // fish.agent.ready, so treating any state as "ready" (what the web SDK
      // does) flushes queued messages too early. Only fall back to it for
      // runtimes that never send the ready attribute.
      if (!this.agentPresent && !this.readyFallbackTimer) {
        this.readyFallbackTimer = setTimeout(() => {
          if (!this.agentPresent) {
            this.log('sys', `no ${AGENT_READY_ATTRIBUTE} after ${READY_FALLBACK_MS} ms, using ${AGENT_STATE_ATTRIBUTE}`);
            this.handleAgentPresent();
          }
        }, READY_FALLBACK_MS);
      }
      if (state === 'thinking') this.setMode('thinking');
    }
  }

  private handleAgentPresent(): void {
    if (this.agentPresent) return;
    this.agentPresent = true;
    this.metrics.agentReadyAt = Date.now();
    this.emitMetrics();
    this.log('sys', `agent ready (${Date.now() - this.metrics.startedAt} ms after start)`);
    if (this.joinTimer) clearTimeout(this.joinTimer);
    if (this.readyFallbackTimer) clearTimeout(this.readyFallbackTimer);
    const queued = this.pending;
    this.pending = [];
    for (const message of queued) void this.publish(message).catch(() => undefined);
  }

  private handleTranscript(item: TranscriptItem): void {
    if (item.role === 'agent') {
      if (!this.metrics.firstAgentTextAt) {
        this.metrics.firstAgentTextAt = Date.now();
        this.emitMetrics();
      }
      // Agent segments are playout-synced: streaming = audibly speaking.
      this.setMode(item.final ? 'listening' : 'speaking');
    }
    this.cb.onTranscript?.(item);
  }

  private handleAgentEvent(message: AgentSessionMessage): void {
    switch (message.type) {
      case 'client_tool.call':
        void this.dispatchTool(message);
        return;
      case 'tool.started':
      case 'tool.completed':
      case 'tool.failed':
        this.cb.onToolEvent?.(message);
        return;
      case 'session.ended':
        if (this.announcedEnd || !KNOWN_END_REASONS.has(message.reason)) return;
        this.announcedEnd = message.reason;
        // The runtime tears the room down right after; force it if it doesn't.
        this.graceTimer = setTimeout(() => {
          void this.room.disconnect();
          this.finalize(message.reason);
        }, SESSION_ENDED_GRACE_MS);
        return;
      case 'error':
        this.cb.onError?.(
          `${message.code}${message.stage ? ` (${message.stage})` : ''}${
            message.recovered === true ? ', retrying' : message.recovered === false ? ', turn lost' : ''
          }`,
        );
        return;
      default:
        return; // unknown types are ignored by contract
    }
  }

  private async dispatchTool(call: Extract<AgentSessionMessage, { type: 'client_tool.call' }>): Promise<void> {
    const handler = this.tools[call.toolName];
    const reply = (body: { result?: unknown; isError?: boolean }) =>
      call.expectsResponse
        ? this.publish({ type: 'client_tool.result', callId: call.callId, ...body }).catch((e: unknown) =>
            this.cb.onError?.(`tool result not delivered: ${String(e)}`),
          )
        : Promise.resolve();
    if (!handler) {
      this.cb.onError?.(`Client tool "${call.toolName}" is not registered`);
      await reply({ isError: true, result: 'Tool is not registered' });
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        Promise.resolve(handler(call.params, { callId: call.callId, toolName: call.toolName })),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('timed out')), CLIENT_TOOL_TIMEOUT_MS);
        }),
      ]);
      await reply(result === undefined ? {} : { result });
    } catch (error) {
      this.cb.onError?.(`Client tool "${call.toolName}" failed: ${String(error)}`);
      await reply({ isError: true, result: String(error) });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // ---- outbound ----

  private markAudioReady(): void {
    if (this.audioReadyStamp !== undefined) return;
    this.audioReadyStamp = Date.now().toString();
    this.metrics.firstAgentAudioAt = Date.now();
    this.emitMetrics();
    this.publishAudioReady(this.audioReadyStamp);
  }

  private publishAudioReady(value: string): void {
    this.log('out', `attr ${CLIENT_AUDIO_READY_ATTRIBUTE}=${value}`);
    void this.room.localParticipant
      .setAttributes({ [CLIENT_AUDIO_READY_ATTRIBUTE]: value })
      .catch((e: unknown) => this.log('sys', `audio_ready attribute rejected: ${String(e)}`));
    if (value !== CLIENT_AUDIO_READY_PENDING) {
      void this.publish({ type: 'client.audio_ready', at: Number(value) }).catch(() => undefined);
    }
  }

  /** Messages sent before the agent's pipeline is up would be dropped; hold them until it is. */
  private sendWhenReady(message: ClientSessionMessage): void {
    if (!this.agentPresent) {
      this.pending.push(message);
      this.log('sys', `queued ${message.type} until agent is ready`);
      return;
    }
    void this.publish(message).catch((e: unknown) => this.cb.onError?.(`send failed: ${String(e)}`));
  }

  private async publish(message: ClientSessionMessage): Promise<void> {
    this.log('out', JSON.stringify(message));
    await this.room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify(message)), {
      reliable: true,
      topic: CLIENT_EVENT_TOPIC,
    });
  }

  // ---- end ----

  private handleAgentLeft(): void {
    this.log('sys', 'agent left the room');
    this.handleTransportEnd('AGENT_LEFT');
    void this.room.disconnect();
  }

  private handleTransportEnd(transportReason?: string): void {
    if (this.status === 'ended') return;
    const reason: EndReason = this.endedByClient
      ? 'user_hangup'
      : (this.announcedEnd ??
        (transportReason === 'AGENT_LEFT' ||
        transportReason === 'ROOM_DELETED' ||
        transportReason === 'ROOM_CLOSED'
          ? 'agent_hangup'
          : 'connection_lost'));
    this.finalize(reason, transportReason);
  }

  private finalize(reason: EndReason, transportReason?: string): void {
    if (this.status === 'ended') return;
    if (this.joinTimer) clearTimeout(this.joinTimer);
    if (this.graceTimer) clearTimeout(this.graceTimer);
    if (this.readyFallbackTimer) clearTimeout(this.readyFallbackTimer);
    this.setStatus('ended');
    void AudioSession.stopAudioSession().catch(() => undefined);
    this.cb.onEnded?.(reason, transportReason);
  }

  // ---- helpers ----

  private setStatus(status: CallStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.cb.onStatus?.(status);
  }

  private setMode(mode: AgentMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.log('sys', `mode -> ${mode}`);
    this.cb.onMode?.(mode);
  }

  private emitMetrics(): void {
    this.cb.onMetrics?.({ ...this.metrics });
  }

  private log(dir: LogEntry['dir'], text: string): void {
    if (__DEV__) console.log(`[fish] ${dir === 'in' ? '<-' : dir === 'out' ? '->' : '..'} ${text}`);
    this.cb.onLog?.({ at: Date.now(), dir, text });
  }
}
