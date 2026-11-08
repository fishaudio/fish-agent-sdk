import type { SessionLanguage, ToolCallEventMessage } from '@fishaudio/agent-protocol';
import { AudioSession } from '@livekit/react-native';
import * as Battery from 'expo-battery';
import * as Device from 'expo-device';
import * as Network from 'expo-network';
import { useCallback, useRef, useState } from 'react';
import { PermissionsAndroid, Platform } from 'react-native';
import { ClientSdkCall } from './ClientSdkCall';
import { createSession, type SessionSource } from './createSession';
import {
  FishCall,
  type AgentMode,
  type CallMetrics,
  type CallStatus,
  type EndReason,
  type LogEntry,
  type TranscriptItem,
} from './FishCall';

const ORDER_CARD_TIMEOUT_MS = 24_000;

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

/** `protocol`: FishCall on the raw protocol. `client-sdk`: the unmodified web SDK, as an experiment. */
export type Engine = 'protocol' | 'client-sdk';

type CallHandle = Pick<FishCall, 'sendText' | 'sendActivity' | 'interrupt' | 'setMuted' | 'hangUp'>;

export type Phase = 'idle' | 'starting' | 'in-call' | 'ended';

export interface EndInfo {
  reason: EndReason;
  transportReason?: string;
  durationMs: number;
}

async function ensureMicPermission(): Promise<void> {
  if (Platform.OS !== 'android') return; // iOS prompts on first capture
  const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
  if (result !== PermissionsAndroid.RESULTS.GRANTED) {
    throw new Error('Microphone permission was denied');
  }
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

export function useAgentCall() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [status, setStatus] = useState<CallStatus>('connecting');
  const [mode, setMode] = useState<AgentMode>('listening');
  const [transcript, setTranscript] = useState<TranscriptItem[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [tools, setTools] = useState<ToolChip[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [metrics, setMetrics] = useState<CallMetrics>();
  const [muted, setMuted] = useState(false);
  const [speaker, setSpeaker] = useState(true);
  const [orderCard, setOrderCard] = useState<OrderCard>();
  const [endInfo, setEndInfo] = useState<EndInfo>();
  const [startError, setStartError] = useState<string>();

  const callRef = useRef<CallHandle | undefined>(undefined);
  const orderResolver = useRef<((confirmed: boolean) => void) | undefined>(undefined);
  const startedAt = useRef(0);

  const pushLog = useCallback((entry: LogEntry) => {
    setLogs((prev) => [...prev.slice(-300), entry]);
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

  const onToolEvent = useCallback((event: ToolCallEventMessage) => {
    setTools((prev) => {
      const others = prev.filter((t) => t.callId !== event.callId);
      const state = event.type === 'tool.started' ? 'running' : event.type === 'tool.completed' ? 'done' : 'failed';
      const detail = event.type === 'tool.failed' ? event.error : undefined;
      return [...others, { callId: event.callId, toolName: event.toolName, state, detail }];
    });
  }, []);

  const start = useCallback(
    async (source: SessionSource, language?: SessionLanguage, engine: Engine = 'protocol') => {
      setPhase('starting');
      setStartError(undefined);
      setTranscript([]);
      setLogs([]);
      setTools([]);
      setErrors([]);
      setMetrics(undefined);
      setEndInfo(undefined);
      setMuted(false);
      setSpeaker(true);
      setStatus('connecting');
      setMode('listening');
      startedAt.current = Date.now();
      try {
        await ensureMicPermission();
        pushLog({ at: Date.now(), dir: 'sys', text: 'requesting session token' });
        const token = await createSession(source, { language });
        pushLog({
          at: Date.now(),
          dir: 'sys',
          text: `token ok: ${token.session_id} (${Date.now() - startedAt.current} ms), expires ${token.expires_at}`,
        });
        const Impl = engine === 'client-sdk' ? ClientSdkCall : FishCall;
        pushLog({ at: Date.now(), dir: 'sys', text: `engine: ${engine}` });
        const call = await Impl.start(token, {
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
            onStatus: setStatus,
            onMode: setMode,
            onTranscript: upsertTranscript,
            onToolEvent,
            onLog: pushLog,
            onMetrics: setMetrics,
            onError: (message) => setErrors((prev) => [...prev.slice(-4), message]),
            onEnded: (reason, transportReason) => {
              orderResolver.current?.(false);
              callRef.current = undefined;
              setEndInfo({ reason, transportReason, durationMs: Date.now() - startedAt.current });
              setPhase('ended');
            },
          },
        });
        callRef.current = call;
        setPhase((p) => (p === 'starting' ? 'in-call' : p));
        await applySpeaker(true);
      } catch (error) {
        setStartError(error instanceof Error ? error.message : String(error));
        setPhase('idle');
      }
    },
    [onToolEvent, pushLog, upsertTranscript],
  );

  const hangUp = useCallback(() => {
    void callRef.current?.hangUp();
  }, []);

  const sendText = useCallback((text: string, audio: boolean) => {
    callRef.current?.sendText(text, audio);
  }, []);

  const sendActivity = useCallback(() => callRef.current?.sendActivity(), []);
  const interrupt = useCallback(() => callRef.current?.interrupt(), []);

  const toggleMute = useCallback(async () => {
    const next = !muted;
    await callRef.current?.setMuted(next);
    setMuted(next);
  }, [muted]);

  const toggleSpeaker = useCallback(async () => {
    const next = !speaker;
    await applySpeaker(next);
    setSpeaker(next);
  }, [speaker]);

  const respondOrderCard = useCallback((confirmed: boolean) => {
    orderResolver.current?.(confirmed);
  }, []);

  const reset = useCallback(() => setPhase('idle'), []);

  return {
    phase,
    status,
    mode,
    transcript,
    logs,
    tools,
    errors,
    metrics,
    muted,
    speaker,
    orderCard,
    endInfo,
    startError,
    start,
    hangUp,
    sendText,
    sendActivity,
    interrupt,
    toggleMute,
    toggleSpeaker,
    respondOrderCard,
    reset,
  };
}

async function applySpeaker(on: boolean): Promise<void> {
  try {
    if (Platform.OS === 'ios') {
      await AudioSession.selectAudioOutput(on ? 'force_speaker' : 'default');
    } else {
      await AudioSession.selectAudioOutput(on ? 'speaker' : 'earpiece');
    }
  } catch {
    // route not available (e.g. headset plugged in)
  }
}
