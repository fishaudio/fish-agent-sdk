import type { SessionLanguage } from '@fishaudio/agent-protocol';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import type { SessionSource } from './src/agent/createSession';
import type { AgentMode, CallMetrics, CallStatus } from './src/agent/FishCall';
import { useAgentCall, type Engine } from './src/agent/useAgentCall';

const ENV_API_KEY = process.env.EXPO_PUBLIC_FISH_API_KEY ?? '';
const ENV_AGENT_ID = process.env.EXPO_PUBLIC_FISH_AGENT_ID ?? '';

type SourceKind = SessionSource['kind'];
const LANGUAGES: { code: SessionLanguage | undefined; label: string }[] = [
  { code: undefined, label: '默认' },
  { code: 'zh', label: '中文' },
  { code: 'en', label: 'English' },
  { code: 'ja', label: '日本語' },
];

export default function App() {
  const call = useAgentCall();
  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.root} edges={['top', 'bottom']}>
        <StatusBar style="light" />
        {call.phase === 'in-call' ? (
          <CallScreen call={call} />
        ) : call.phase === 'ended' ? (
          <EndedScreen call={call} />
        ) : (
          <HomeScreen call={call} />
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

type Call = ReturnType<typeof useAgentCall>;

// ---------------------------------------------------------------- home

function HomeScreen({ call }: { call: Call }) {
  const [kind, setKind] = useState<SourceKind>(ENV_API_KEY ? 'apiKey' : 'public');
  const [agentId, setAgentId] = useState(ENV_AGENT_ID);
  const [tokenJson, setTokenJson] = useState('');
  const [origin, setOrigin] = useState('https://example.com');
  const [language, setLanguage] = useState<SessionLanguage | undefined>('zh');
  const [engine, setEngine] = useState<Engine>('protocol');
  const starting = call.phase === 'starting';

  const onStart = () => {
    let source: SessionSource;
    if (kind === 'apiKey') source = { kind, apiKey: ENV_API_KEY, agentId: agentId.trim() };
    else if (kind === 'public') source = { kind, agentId: agentId.trim(), origin: origin.trim() || undefined };
    else {
      try {
        source = { kind, token: JSON.parse(tokenJson) };
      } catch {
        return;
      }
    }
    void call.start(source, language, engine);
  };

  return (
    <ScrollView contentContainerStyle={styles.home} keyboardShouldPersistTaps="handled">
      <Text style={styles.brand}>小鱼商城</Text>
      <Text style={styles.title}>语音客服</Text>
      <Text style={styles.subtitle}>Fish Agent · React Native protocol demo</Text>

      <Text style={styles.label}>接入方式</Text>
      <Segmented
        value={kind}
        onChange={setKind}
        options={[
          { value: 'apiKey', label: 'API key（开发）' },
          { value: 'token', label: '粘贴 token' },
          { value: 'public', label: '公开 agent' },
        ]}
      />
      {kind === 'apiKey' && !ENV_API_KEY && (
        <Text style={styles.warn}>未设置 EXPO_PUBLIC_FISH_API_KEY（.env.local）</Text>
      )}

      {kind !== 'token' && (
        <>
          <Text style={styles.label}>Agent ID</Text>
          <TextInput style={styles.input} value={agentId} onChangeText={setAgentId} autoCapitalize="none" autoCorrect={false} />
        </>
      )}
      {kind === 'public' && (
        <>
          <Text style={styles.label}>Origin 头（服务端白名单要求，原生 app 只能伪造）</Text>
          <TextInput style={styles.input} value={origin} onChangeText={setOrigin} autoCapitalize="none" autoCorrect={false} />
        </>
      )}
      {kind === 'token' && (
        <>
          <Text style={styles.label}>POST /v1/agent/sessions 的响应 JSON</Text>
          <TextInput
            style={[styles.input, styles.tokenInput]}
            value={tokenJson}
            onChangeText={setTokenJson}
            multiline
            autoCapitalize="none"
            autoCorrect={false}
          />
        </>
      )}

      <Text style={styles.label}>语言</Text>
      <Segmented
        value={language ?? 'default'}
        onChange={(v) => setLanguage(v === 'default' ? undefined : (v as SessionLanguage))}
        options={LANGUAGES.map((l) => ({ value: l.code ?? 'default', label: l.label }))}
      />

      <Text style={styles.label}>实现</Text>
      <Segmented
        value={engine}
        onChange={setEngine}
        options={[
          { value: 'protocol', label: '直接用协议' },
          { value: 'client-sdk', label: 'Web SDK（实验）' },
        ]}
      />

      {call.startError && <Text style={styles.error}>{call.startError}</Text>}

      <Pressable style={[styles.primary, starting && styles.disabled]} onPress={onStart} disabled={starting}>
        {starting ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>开始通话</Text>}
      </Pressable>
      <Text style={styles.hint}>试试说：“帮我查一下订单”、“app 老是卡”、“再见”。</Text>
    </ScrollView>
  );
}

function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <View style={styles.segmented}>
      {options.map((o) => (
        <Pressable key={o.value} onPress={() => onChange(o.value)} style={[styles.segment, value === o.value && styles.segmentOn]}>
          <Text style={[styles.segmentText, value === o.value && styles.segmentTextOn]}>{o.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

// ---------------------------------------------------------------- call

const STATUS_LABEL: Record<CallStatus, string> = {
  connecting: '连接中',
  connected: '通话中',
  reconnecting: '重连中…',
  ended: '已结束',
};
const MODE_LABEL: Record<AgentMode, string> = {
  listening: '在听',
  thinking: '思考中',
  speaking: '说话中',
};
const MODE_COLOR: Record<AgentMode, string> = {
  listening: '#3b82f6',
  thinking: '#f59e0b',
  speaking: '#10b981',
};

function useElapsed(running: boolean): string {
  const [start] = useState(() => Date.now());
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);
  const s = Math.floor((now - start) / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function CallScreen({ call }: { call: Call }) {
  const elapsed = useElapsed(true);
  const [text, setText] = useState('');
  const [voiceReply, setVoiceReply] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const listRef = useRef<FlatList>(null);
  const lastActivity = useRef(0);

  const send = () => {
    const value = text.trim();
    if (!value) return;
    call.sendText(value, voiceReply);
    setText('');
  };
  const onType = (value: string) => {
    setText(value);
    if (Date.now() - lastActivity.current > 2000) {
      lastActivity.current = Date.now();
      call.sendActivity();
    }
  };

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.callHeader}>
        <View style={[styles.pill, call.status === 'reconnecting' && styles.pillWarn]}>
          <Text style={styles.pillText}>{STATUS_LABEL[call.status]}</Text>
        </View>
        <Text style={styles.timer}>{elapsed}</Text>
        <Pressable onPress={() => setShowLog((v) => !v)}>
          <Text style={styles.link}>{showLog ? '对话' : '协议日志'}</Text>
        </Pressable>
      </View>

      <View style={styles.modeRow}>
        <View style={[styles.orb, { backgroundColor: MODE_COLOR[call.mode] }]} />
        <Text style={styles.modeText}>客服{MODE_LABEL[call.mode]}</Text>
      </View>

      {call.tools.length > 0 && (
        <ScrollView horizontal style={styles.chips} contentContainerStyle={styles.chipsInner}>
          {call.tools.map((t) => (
            <View key={t.callId} style={[styles.chip, t.state === 'failed' && styles.chipFail]}>
              <Text style={styles.chipText}>
                {t.state === 'running' ? '⏳' : t.state === 'done' ? '✓' : '✕'} {t.toolName}
              </Text>
            </View>
          ))}
        </ScrollView>
      )}
      {call.errors.length > 0 && <Text style={styles.errorBar}>{call.errors[call.errors.length - 1]}</Text>}

      {showLog ? (
        <LogView call={call} />
      ) : (
        <FlatList
          ref={listRef}
          style={styles.flex}
          contentContainerStyle={styles.transcript}
          data={call.transcript}
          keyExtractor={(t) => t.id}
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
          renderItem={({ item }) => (
            <View style={[styles.bubble, item.role === 'user' ? styles.bubbleUser : styles.bubbleAgent, !item.final && styles.bubbleLive]}>
              <Text style={styles.bubbleText}>{item.text}</Text>
            </View>
          )}
          ListEmptyComponent={<Text style={styles.empty}>等待客服接通…</Text>}
        />
      )}

      <View style={styles.inputRow}>
        <TextInput
          style={[styles.input, styles.flex, styles.inputCompact]}
          value={text}
          onChangeText={onType}
          placeholder="输入文字…"
          placeholderTextColor="#64748b"
          onSubmitEditing={send}
          returnKeyType="send"
        />
        <View style={styles.voiceToggle}>
          <Text style={styles.small}>语音回复</Text>
          <Switch value={voiceReply} onValueChange={setVoiceReply} />
        </View>
      </View>

      <View style={styles.controls}>
        <Control label={call.muted ? '取消静音' : '静音'} active={call.muted} onPress={call.toggleMute} />
        <Control label={call.speaker ? '扬声器' : '听筒'} active={!call.speaker} onPress={call.toggleSpeaker} />
        <Control label="打断" onPress={call.interrupt} />
        <Control label="挂断" danger onPress={call.hangUp} />
      </View>

      <OrderCardModal call={call} />
    </KeyboardAvoidingView>
  );
}

function Control({ label, onPress, active, danger }: { label: string; onPress: () => void; active?: boolean; danger?: boolean }) {
  return (
    <Pressable onPress={onPress} style={[styles.control, active && styles.controlOn, danger && styles.controlDanger]}>
      <Text style={styles.controlText}>{label}</Text>
    </Pressable>
  );
}

function LogView({ call }: { call: Call }) {
  const t0 = call.logs[0]?.at ?? 0;
  return (
    <ScrollView style={styles.flex} contentContainerStyle={styles.log}>
      <Metrics metrics={call.metrics} />
      {call.logs.map((l, i) => (
        <Text key={i} style={[styles.logLine, l.dir === 'in' ? styles.logIn : l.dir === 'out' ? styles.logOut : styles.logSys]}>
          {`+${((l.at - t0) / 1000).toFixed(2)}s ${l.dir === 'in' ? '←' : l.dir === 'out' ? '→' : '·'} ${l.text}`}
        </Text>
      ))}
    </ScrollView>
  );
}

function Metrics({ metrics }: { metrics?: CallMetrics }) {
  if (!metrics) return null;
  const d = (t?: number) => (t ? `${t - metrics.startedAt} ms` : '—');
  return (
    <View style={styles.metrics}>
      <Text style={styles.metricsText}>房间连接 {d(metrics.roomConnectedAt)}</Text>
      <Text style={styles.metricsText}>agent 就绪 {d(metrics.agentReadyAt)}</Text>
      <Text style={styles.metricsText}>首个音频轨 {d(metrics.firstAgentAudioAt)}</Text>
      <Text style={styles.metricsText}>首句文字 {d(metrics.firstAgentTextAt)}</Text>
    </View>
  );
}

function OrderCardModal({ call }: { call: Call }) {
  const card = call.orderCard;
  return (
    <Modal visible={!!card} transparent animationType="slide">
      <View style={styles.modalBackdrop}>
        <View style={styles.card}>
          <Text style={styles.cardKicker}>客服给你发来一张订单卡片</Text>
          <Text style={styles.cardTitle}>{card?.item}</Text>
          <Text style={styles.cardRow}>订单号：{card?.orderId}</Text>
          <Text style={styles.cardRow}>状态：{card?.status}</Text>
          <View style={styles.cardActions}>
            <Pressable style={[styles.cardButton, styles.cardButtonGhost]} onPress={() => call.respondOrderCard(false)}>
              <Text style={styles.cardButtonText}>不是这个</Text>
            </Pressable>
            <Pressable style={styles.cardButton} onPress={() => call.respondOrderCard(true)}>
              <Text style={styles.cardButtonText}>确认</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

// ---------------------------------------------------------------- ended

const END_LABEL: Record<string, string> = {
  user_hangup: '你挂断了通话',
  agent_hangup: '客服结束了通话',
  conversation_timeout: '长时间无对话，通话已结束',
  escalated: '已转接人工',
  llm_endpoint_failure: '模型服务异常，通话结束',
  connection_lost: '连接中断',
};

function EndedScreen({ call }: { call: Call }) {
  const info = call.endInfo;
  const [showLog, setShowLog] = useState(false);
  return (
    <View style={styles.flex}>
      <View style={styles.ended}>
        <Text style={styles.title}>{info ? END_LABEL[info.reason] ?? info.reason : '通话结束'}</Text>
        <Text style={styles.subtitle}>
          reason: {info?.reason}
          {info?.transportReason ? ` · transport: ${info.transportReason}` : ''}
          {info ? ` · ${Math.round(info.durationMs / 1000)} s` : ''}
        </Text>
        <Text style={styles.subtitle}>{call.transcript.length} 条对话</Text>
        <Pressable style={styles.primary} onPress={call.reset}>
          <Text style={styles.primaryText}>返回</Text>
        </Pressable>
        <Pressable onPress={() => setShowLog((v) => !v)}>
          <Text style={styles.link}>{showLog ? '隐藏协议日志' : '查看协议日志'}</Text>
        </Pressable>
      </View>
      {showLog && <LogView call={call} />}
    </View>
  );
}

// ---------------------------------------------------------------- styles

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0b1220' },
  flex: { flex: 1 },
  home: { padding: 20, paddingTop: 32, gap: 8 },
  brand: { color: '#38bdf8', fontSize: 14, fontWeight: '600' },
  title: { color: '#f8fafc', fontSize: 28, fontWeight: '700' },
  subtitle: { color: '#94a3b8', fontSize: 13, marginBottom: 8 },
  label: { color: '#cbd5e1', fontSize: 13, marginTop: 12 },
  input: {
    backgroundColor: '#111a2e',
    borderColor: '#1e2a44',
    borderWidth: 1,
    borderRadius: 10,
    color: '#f1f5f9',
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
  },
  inputCompact: { paddingVertical: 8 },
  tokenInput: { minHeight: 120, textAlignVertical: 'top', fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }), fontSize: 11 },
  segmented: { flexDirection: 'row', backgroundColor: '#111a2e', borderRadius: 10, padding: 3, gap: 3 },
  segment: { flex: 1, paddingVertical: 8, borderRadius: 8, alignItems: 'center' },
  segmentOn: { backgroundColor: '#1d4ed8' },
  segmentText: { color: '#94a3b8', fontSize: 12 },
  segmentTextOn: { color: '#fff', fontWeight: '600' },
  warn: { color: '#fbbf24', fontSize: 12 },
  error: { color: '#f87171', fontSize: 13, marginTop: 12 },
  primary: { marginTop: 24, backgroundColor: '#2563eb', borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  primaryText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  disabled: { opacity: 0.6 },
  hint: { color: '#64748b', fontSize: 12, textAlign: 'center', marginTop: 12 },

  callHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 10 },
  pill: { backgroundColor: '#14532d', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 },
  pillWarn: { backgroundColor: '#78350f' },
  pillText: { color: '#fff', fontSize: 12, fontWeight: '600' },
  timer: { color: '#e2e8f0', fontSize: 16, fontVariant: ['tabular-nums'] },
  link: { color: '#60a5fa', fontSize: 13, textAlign: 'center', marginTop: 8 },
  modeRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingBottom: 8 },
  orb: { width: 14, height: 14, borderRadius: 7 },
  modeText: { color: '#e2e8f0', fontSize: 15 },
  chips: { flexGrow: 0, paddingHorizontal: 12 },
  chipsInner: { gap: 6, paddingVertical: 4 },
  chip: { backgroundColor: '#1e293b', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 },
  chipFail: { backgroundColor: '#7f1d1d' },
  chipText: { color: '#cbd5e1', fontSize: 12 },
  errorBar: { color: '#fca5a5', fontSize: 12, paddingHorizontal: 16, paddingVertical: 4 },
  transcript: { padding: 16, gap: 8 },
  empty: { color: '#64748b', textAlign: 'center', marginTop: 40 },
  bubble: { maxWidth: '85%', borderRadius: 14, paddingHorizontal: 12, paddingVertical: 8 },
  bubbleUser: { alignSelf: 'flex-end', backgroundColor: '#1d4ed8' },
  bubbleAgent: { alignSelf: 'flex-start', backgroundColor: '#1e293b' },
  bubbleLive: { opacity: 0.7 },
  bubbleText: { color: '#f8fafc', fontSize: 15, lineHeight: 21 },
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingTop: 8 },
  voiceToggle: { alignItems: 'center' },
  small: { color: '#94a3b8', fontSize: 10 },
  controls: { flexDirection: 'row', gap: 8, padding: 12 },
  control: { flex: 1, backgroundColor: '#1e293b', paddingVertical: 14, borderRadius: 12, alignItems: 'center' },
  controlOn: { backgroundColor: '#334155' },
  controlDanger: { backgroundColor: '#dc2626' },
  controlText: { color: '#fff', fontSize: 14, fontWeight: '600' },

  log: { padding: 12, gap: 2 },
  logLine: { fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }), fontSize: 10, lineHeight: 14 },
  logIn: { color: '#86efac' },
  logOut: { color: '#93c5fd' },
  logSys: { color: '#94a3b8' },
  metrics: { backgroundColor: '#111a2e', borderRadius: 8, padding: 8, marginBottom: 8 },
  metricsText: { color: '#e2e8f0', fontSize: 12 },

  modalBackdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.5)' },
  card: { backgroundColor: '#f8fafc', borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 24, gap: 6 },
  cardKicker: { color: '#64748b', fontSize: 12 },
  cardTitle: { color: '#0f172a', fontSize: 22, fontWeight: '700', marginBottom: 6 },
  cardRow: { color: '#334155', fontSize: 15 },
  cardActions: { flexDirection: 'row', gap: 12, marginTop: 16 },
  cardButton: { flex: 1, backgroundColor: '#2563eb', borderRadius: 12, paddingVertical: 12, alignItems: 'center' },
  cardButtonGhost: { backgroundColor: '#94a3b8' },
  cardButtonText: { color: '#fff', fontSize: 15, fontWeight: '600' },

  ended: { padding: 24, paddingTop: 60, gap: 6 },
});
