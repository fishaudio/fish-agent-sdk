import { AGENT_EVENT_TOPIC, AGENT_READY_ATTRIBUTE, type SessionLanguage } from '@fishaudio/agent-protocol';
import {
  useConversation,
  type AgentMode,
  type EndReason,
  type SessionStatus,
} from '@fishaudio/agent-react-native';
import * as Battery from 'expo-battery';
import * as Device from 'expo-device';
import * as Network from 'expo-network';
import { RoomEvent, Track, type RemoteParticipant } from 'livekit-client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { createSession, type SessionSource } from './createSession';

const ORDER_CARD_TIMEOUT_MS = 24_000;
/** Above the order card's own timeout, for runtimes that do not send `timeoutMs` yet. */
const CLIENT_TOOL_TIMEOUT_MS = 28_000;

export type CallStatus = Exclude<SessionStatus, 'ended'> | 'ended';
export type { AgentMode, EndReason };

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

export interface OrderCard {
  callId: string;
  orderId: string;
  status: string;
  item: string;
}

export interface ToolChip {
  callId: string;
  toolName: string;
  state: 'running' | 'done' | 'failed';
  detail?: string;
}

export type Phase = 'idle' | 'starting' | 'in-call' | 'ended';

export interface EndInfo {
  reason: EndReason;
  durationMs: number;
}

async function readDeviceInfo() {
  const [battery, network] = await Promise.all([
    Battery.getBatteryLevelAsync().catch(() => -1),
    Network.getNetworkStateAsync().catch(() => undefined),
  ]);
  return {
    os: `${Device.osName ?? Platform.OS} ${Device.osVersion ?? ''}`.trim(),
    model: Device.modelName ?? 'unknown',
    battery_percent: battery >= 0 ? Math.round(battery * 100) : null,
    network: network?.type ?? 'unknown',
    online: network?.isInternetReachable ?? null,
  };
}

/** Demo state on top of the SDK's `useConversation`: transcript, tool chips, the order card, logs and timings. */
export function useAgentCall() {
  const conversation = useConversation({}, { callNotification: { title: '客服通话中' } });
  const [phase, setPhase] = useState<Phase>('idle');
  const [transcript, setTranscript] = useState<TranscriptItem[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [tools, setTools] = useState<ToolChip[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [metrics, setMetrics] = useState<CallMetrics>();
  const [orderCard, setOrderCard] = useState<OrderCard>();
  const [endInfo, setEndInfo] = useState<EndInfo>();
  const [startError, setStartError] = useState<string>();

  const orderResolver = useRef<((confirmed: boolean) => void) | undefined>(undefined);
  const startedAt = useRef(0);
  /** Per agent segment: deltas received and when the first one arrived, to see whether text follows playout. */
  const segmentStats = useRef(new Map<string, { deltas: number; firstAt: number }>());

  const pushLog = useCallback((dir: LogEntry['dir'], text: string) => {
    setLogs((prev) => [...prev.slice(-300), { at: Date.now(), dir, text }]);
  }, []);

  const mark = useCallback((key: Exclude<keyof CallMetrics, 'startedAt'>) => {
    setMetrics((prev) => (prev && prev[key] === undefined ? { ...prev, [key]: Date.now() } : prev));
  }, []);

  const upsertTranscript = useCallback((item: TranscriptItem) => {
    setTranscript((prev) => {
      const index = prev.findIndex((t) => t.id === item.id);
      if (index === -1) return [...prev, item];
      const next = prev.slice();
      next[index] = item;
      return next;
    });
  }, []);

  const setTool = useCallback((chip: ToolChip) => {
    setTools((prev) => [...prev.filter((t) => t.callId !== chip.callId), chip]);
  }, []);

  // Protocol-level view for the log: agent frames, readiness and the first audio track.
  const { session } = conversation;
  useEffect(() => {
    const room = session?.getRoom();
    if (!room) return;
    const decoder = new TextDecoder();
    const checkAgent = (participant: RemoteParticipant) => {
      if (participant.attributes?.[AGENT_READY_ATTRIBUTE]) mark('agentReadyAt');
      for (const publication of participant.audioTrackPublications.values()) {
        if (publication.track && publication.source === Track.Source.Microphone) mark('firstAgentAudioAt');
      }
    };
    room.remoteParticipants.forEach(checkAgent);
    const onData = (payload: Uint8Array, _p: unknown, _k: unknown, topic?: string) => {
      if (topic === AGENT_EVENT_TOPIC) pushLog('in', decoder.decode(payload));
    };
    const onAttributes = (_changed: Record<string, string>, participant: { isLocal?: boolean }) => {
      if (!participant.isLocal) room.remoteParticipants.forEach(checkAgent);
    };
    const onTrack = (track: { kind: string; source: string }) => {
      if (track.kind === Track.Kind.Audio && track.source === Track.Source.Microphone) {
        mark('firstAgentAudioAt');
        pushLog('sys', 'agent audio subscribed');
      }
    };
    const onSignalReconnecting = () => pushLog('sys', 'signal reconnecting');
    const onDisconnected = (reason?: number) => pushLog('sys', `room disconnected (${reason ?? '-'})`);
    room.on(RoomEvent.DataReceived, onData);
    room.on(RoomEvent.ParticipantAttributesChanged, onAttributes);
    room.on(RoomEvent.TrackSubscribed, onTrack);
    room.on(RoomEvent.SignalReconnecting, onSignalReconnecting);
    room.on(RoomEvent.Disconnected, onDisconnected);
    return () => {
      room.off(RoomEvent.DataReceived, onData);
      room.off(RoomEvent.ParticipantAttributesChanged, onAttributes);
      room.off(RoomEvent.TrackSubscribed, onTrack);
      room.off(RoomEvent.SignalReconnecting, onSignalReconnecting);
      room.off(RoomEvent.Disconnected, onDisconnected);
    };
  }, [session, mark, pushLog]);

  const { startSession } = conversation;
  const start = useCallback(
    async (source: SessionSource, language?: SessionLanguage) => {
      setPhase('starting');
      setStartError(undefined);
      setTranscript([]);
      setLogs([]);
      setTools([]);
      setErrors([]);
      setEndInfo(undefined);
      startedAt.current = Date.now();
      setMetrics({ startedAt: startedAt.current });
      try {
        pushLog('sys', 'requesting session token');
        const sessionToken = await createSession(source, { language });
        pushLog(
          'sys',
          `token ok: ${sessionToken.session_id} (${Date.now() - startedAt.current} ms), expires ${sessionToken.expires_at}`,
        );
        await startSession({
          sessionToken,
          clientToolTimeoutMs: CLIENT_TOOL_TIMEOUT_MS,
          clientTools: {
            show_order_card: (params, { callId }) =>
              new Promise<{ confirmed: boolean; timed_out?: boolean }>((resolve) => {
                orderResolver.current?.(false);
                // Answer before either side's tool timeout (server: 30 s for this tool) so the agent hears back.
                const timer = setTimeout(() => finish(false, true), ORDER_CARD_TIMEOUT_MS);
                const finish = (confirmed: boolean, timedOut = false) => {
                  clearTimeout(timer);
                  orderResolver.current = undefined;
                  setOrderCard(undefined);
                  resolve(timedOut ? { confirmed, timed_out: true } : { confirmed });
                };
                orderResolver.current = (confirmed) => finish(confirmed);
                setOrderCard({
                  callId,
                  orderId: String(params.order_id ?? ''),
                  status: String(params.status ?? ''),
                  item: String(params.item ?? ''),
                });
              }),
            get_device_info: () => readDeviceInfo(),
          },
          callbacks: {
            onConnect: () => {
              mark('roomConnectedAt');
              pushLog('sys', 'room connected');
            },
            onStatusChange: (status) => pushLog('sys', `status → ${status}`),
            onModeChange: (mode) => pushLog('sys', `mode → ${mode}`),
            onUserTranscript: ({ segmentId, text, final }) =>
              upsertTranscript({ id: `user-${segmentId}`, role: 'user', text, final, typed: segmentId.startsWith('typed_') }),
            onAgentResponseDelta: ({ segmentId, text }) => {
              mark('firstAgentTextAt');
              const stats = segmentStats.current.get(segmentId) ?? { deltas: 0, firstAt: Date.now() };
              stats.deltas += 1;
              segmentStats.current.set(segmentId, stats);
              upsertTranscript({ id: `agent-${segmentId}`, role: 'agent', text, final: false });
            },
            onAgentResponse: ({ segmentId, text }) => {
              const stats = segmentStats.current.get(segmentId);
              segmentStats.current.delete(segmentId);
              pushLog(
                'sys',
                `agent segment: ${text.length} chars, ${stats?.deltas ?? 0} deltas over ${stats ? Date.now() - stats.firstAt : 0} ms`,
              );
              upsertTranscript({ id: `agent-${segmentId}`, role: 'agent', text, final: true });
            },
            onToolCallStarted: ({ callId, toolName }) => setTool({ callId, toolName, state: 'running' }),
            onToolCallCompleted: ({ callId, toolName }) => setTool({ callId, toolName, state: 'done' }),
            onToolCallFailed: ({ callId, toolName, error }) =>
              setTool({ callId, toolName, state: 'failed', detail: error }),
            onError: (error) => {
              pushLog('sys', `error ${error.code}: ${error.message}`);
              setErrors((prev) => [...prev.slice(-4), `${error.code}: ${error.message}`]);
            },
            onDisconnect: ({ reason }) => {
              orderResolver.current?.(false);
              pushLog('sys', `ended: ${reason}`);
              setEndInfo({ reason, durationMs: Date.now() - startedAt.current });
              setPhase('ended');
            },
          },
        });
        setPhase((p) => (p === 'starting' ? 'in-call' : p));
      } catch (error) {
        setStartError(error instanceof Error ? error.message : String(error));
        setPhase('idle');
      }
    },
    [startSession, mark, pushLog, setTool, upsertTranscript],
  );

  const { endSession, sendUserMessage, sendUserActivity, interrupt, setMicMuted, micMuted, setAudioOutput, audioOutput } =
    conversation;

  const respondOrderCard = useCallback((confirmed: boolean) => {
    orderResolver.current?.(confirmed);
  }, []);

  return {
    phase,
    status: (conversation.status === 'idle' ? 'connecting' : conversation.status) as CallStatus,
    mode: conversation.mode,
    transcript,
    logs,
    tools,
    errors,
    metrics,
    muted: micMuted,
    speaker: audioOutput !== 'earpiece',
    orderCard,
    endInfo,
    startError,
    start,
    hangUp: useCallback(() => void endSession().catch(() => undefined), [endSession]),
    sendText: useCallback((text: string, audio: boolean) => sendUserMessage(text, { audio }), [sendUserMessage]),
    sendActivity: sendUserActivity,
    interrupt,
    toggleMute: useCallback(() => setMicMuted(!micMuted), [setMicMuted, micMuted]),
    toggleSpeaker: useCallback(
      () => setAudioOutput(audioOutput === 'earpiece' ? 'auto' : 'earpiece').catch(() => undefined),
      [setAudioOutput, audioOutput],
    ),
    respondOrderCard,
    reset: useCallback(() => setPhase('idle'), []),
  };
}
