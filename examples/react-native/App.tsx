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
import type { CallSource } from './src/agent/createSession';
import { useAgentCall, type AgentMode, type CallMetrics, type CallStatus } from './src/agent/useAgentCall';
import { WidgetDemo } from './src/WidgetDemo';

// Recommended: your backend's token endpoint (server/index.mjs in this folder).
// The API key stays on that server; the app only receives a short-lived token.
const ENV_TOKEN_URL = process.env.EXPO_PUBLIC_TOKEN_URL ?? '';
// Public agent: its ID and an origin on its allowlist (no key, no backend).
const ENV_AGENT_ID = process.env.EXPO_PUBLIC_AGENT_ID ?? '';
const ENV_ORIGIN = process.env.EXPO_PUBLIC_AGENT_ORIGIN ?? '';
const LANGUAGES: { code: SessionLanguage | undefined; label: string }[] = [
  { code: undefined, label: '默认' },
  { code: 'zh', label: '中文' },
  { code: 'en', label: 'English' },
  { code: 'ja', label: '日本語' },
];

type WidgetTarget = { source: CallSource; language?: SessionLanguage };

export default function App() {
  const call = useAgentCall();
  const [widget, setWidget] = useState<WidgetTarget | null>(null);
  if (widget) {
    return (
      <SafeAreaProvider>
        <StatusBar style="dark" />
        <WidgetDemo source={widget.source} language={widget.language} onBack={() => setWidget(null)} />
      </SafeAreaProvider>
    );
  }
  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.root} edges={['top', 'bottom']}>
        <StatusBar style="light" />
        {call.phase === 'in-call' ? (
          <CallScreen call={call} />
        ) : call.phase === 'ended' ? (
          <EndedScreen call={call} />
        ) : (
          <HomeScreen call={call} onOpenWidget={setWidget} />
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

type Call = ReturnType<typeof useAgentCall>;

// ---------------------------------------------------------------- home

function HomeScreen({ call, onOpenWidget }: { call: Call; onOpenWidget: (target: WidgetTarget) => void }) {
  const [kind, setKind] = useState<CallSource['kind']>(ENV_TOKEN_URL || !ENV_AGENT_ID ? 'backend' : 'public');
  const [tokenUrl, setTokenUrl] = useState(ENV_TOKEN_URL);
  const [agentId, setAgentId] = useState(ENV_AGENT_ID);
  const [origin, setOrigin] = useState(ENV_ORIGIN);
  const [language, setLanguage] = useState<SessionLanguage | undefined>('zh');
  const starting = call.phase === 'starting';

  const source: CallSource | undefined =
    kind === 'backend'
      ? tokenUrl.trim()
        ? { kind, tokenUrl: tokenUrl.trim() }
        : undefined
      : agentId.trim() && origin.trim()
        ? { kind, agentId: agentId.trim(), origin: origin.trim() }
        : undefined;
  const onStart = () => {
    if (source) void call.start(source, language);
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
          { value: 'backend', label: '你的后端（推荐）' },
          { value: 'public', label: '公开 agent（实验性）' },
        ]}
      />

      {kind === 'backend' ? (
        <>
          <Text style={styles.label}>后端 token 接口</Text>
          <TextInput
            style={styles.input}
            value={tokenUrl}
            onChangeText={setTokenUrl}
            placeholder="http://192.168.1.20:3001/agent-session"
            placeholderTextColor="#5b6478"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />
          <Text style={styles.fieldHint}>App 向你自己的后端要 session token，API key 只在后端。示例后端见 server/index.mjs。</Text>
        </>
      ) : (
        <>
          <Text style={styles.label}>Agent ID</Text>
          <TextInput style={styles.input} value={agentId} onChangeText={setAgentId} autoCapitalize="none" autoCorrect={false} />
          <Text style={styles.label}>域名（agent 白名单里的 origin）</Text>
          <TextInput
            style={styles.input}
            value={origin}
            onChangeText={setOrigin}
            placeholder="https://www.example.com"
            placeholderTextColor="#5b6478"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />
          <Text style={styles.fieldHint}>实验性接口，后续版本可能调整。不需要 key 和后端；拿到 ID 的人都能用它通话，费用记在 agent 主人账上。</Text>
        </>
      )}

      <Text style={styles.label}>语言</Text>
      <Segmented
        value={language ?? 'default'}
        onChange={(v) => setLanguage(v === 'default' ? undefined : (v as SessionLanguage))}
        options={LANGUAGES.map((l) => ({ value: l.code ?? 'default', label: l.label }))}
      />

      {call.startError && <Text style={styles.error}>{call.startError}</Text>}

      <Pressable
        style={[styles.primary, (starting || !source) && styles.disabled]}
        onPress={onStart}
        disabled={starting || !source}
      >
        {starting ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>开始通话</Text>}
      </Pressable>
      <Pressable
        style={[styles.secondary, (starting || !source) && styles.disabled]}
        onPress={() => source && onOpenWidget({ source, language })}
        disabled={starting || !source}
      >
        <Text style={styles.secondaryText}>挂件演示（FishAgentWidget）</Text>
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
  segmented: { flexDirection: 'row', backgroundColor: '#111a2e', borderRadius: 10, padding: 3, gap: 3 },
  segment: { flex: 1, paddingVertical: 8, borderRadius: 8, alignItems: 'center' },
  segmentOn: { backgroundColor: '#1d4ed8' },
  segmentText: { color: '#94a3b8', fontSize: 12 },
  segmentTextOn: { color: '#fff', fontWeight: '600' },
  fieldHint: { color: '#64748b', fontSize: 12, marginTop: 6 },
  error: { color: '#f87171', fontSize: 13, marginTop: 12 },
  primary: { marginTop: 24, backgroundColor: '#2563eb', borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  primaryText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  secondary: { marginTop: 12, borderColor: '#2563eb', borderWidth: 1, borderRadius: 12, paddingVertical: 13, alignItems: 'center' },
  secondaryText: { color: '#93b4ff', fontSize: 15, fontWeight: '500' },
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
