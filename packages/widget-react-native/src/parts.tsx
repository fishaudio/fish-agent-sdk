import type { AgentMode } from "@fishaudio/agent-client";
import {
  formatToolPayload,
  type ToolEntry,
  type TranscriptEntry,
  type WidgetTextContents,
} from "@fishaudio/agent-widget-shared";
import { useEffect, useId, useRef, useState, type ComponentRef } from "react";
import {
  AccessibilityInfo,
  Animated,
  Easing,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import Svg, { Circle, Defs, RadialGradient, Stop } from "react-native-svg";
import { IconChevronDown, IconSend } from "./icons.js";
import { useTheme } from "./theme.js";

const MONO = Platform.select({ ios: "Menlo", default: "monospace" });

/** Follows the system "reduce motion" setting; animations stop while it is on. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled?.()
      .then((value) => active && setReduced(value))
      .catch(() => undefined);
    const subscription = AccessibilityInfo.addEventListener?.("reduceMotionChanged", setReduced);
    return () => {
      active = false;
      subscription?.remove();
    };
  }, []);
  return reduced;
}

/** A looping 0→1 driver, or null while stopped. */
function useLoop(running: boolean, duration: number, easing = Easing.linear): Animated.Value | null {
  const value = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!running) {
      value.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.timing(value, { toValue: 1, duration, easing, useNativeDriver: true }),
    );
    loop.start();
    return () => loop.stop();
  }, [running, duration, easing, value]);
  return running ? value : null;
}

interface OrbProps {
  size: number;
  /** Animates by mode: a pulsing ring while listening, a spinner while thinking, a glow while speaking. */
  mode?: AgentMode;
}

/**
 * The agent's orb. React Native has no output volume yet, so unlike the web
 * orb the speaking glow follows the mode, not the voice level.
 */
export function Orb({ size, mode }: OrbProps) {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const gradientId = `fa-orb-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const animate = mode !== undefined && !reduced;
  const pulse = useLoop(animate && mode === "listening", 1800, Easing.out(Easing.ease));
  const spin = useLoop(animate && mode === "thinking", 900);
  const glow = useLoop(animate && mode === "speaking", 1200, Easing.inOut(Easing.ease));
  const ring = size + 10;

  return (
    <View
      style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {mode === "speaking" ? (
        <Animated.View
          style={[
            styles.ring,
            {
              width: ring + 6,
              height: ring + 6,
              borderRadius: (ring + 6) / 2,
              backgroundColor: theme.orbColor1,
              opacity: glow
                ? glow.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0.18, 0.4, 0.18] })
                : 0.3,
              transform: glow
                ? [{ scale: glow.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0.92, 1.05, 0.92] }) }]
                : [],
            },
          ]}
        />
      ) : null}
      <Svg width={size} height={size}>
        <Defs>
          <RadialGradient id={gradientId} cx="32%" cy="30%" r="80%" fx="32%" fy="30%">
            <Stop offset="0" stopColor={theme.orbColor1} />
            <Stop offset="0.72" stopColor={theme.orbColor2} />
          </RadialGradient>
        </Defs>
        <Circle cx={size / 2} cy={size / 2} r={size / 2} fill={`url(#${gradientId})`} />
      </Svg>
      {mode === "listening" ? (
        <Animated.View
          style={[
            styles.ring,
            {
              width: ring,
              height: ring,
              borderRadius: ring / 2,
              borderColor: theme.orbColor1,
              opacity: pulse
                ? pulse.interpolate({ inputRange: [0, 0.7, 1], outputRange: [0.9, 0, 0] })
                : 0.7,
              transform: pulse
                ? [{ scale: pulse.interpolate({ inputRange: [0, 0.7, 1], outputRange: [0.92, 1.14, 1.14] }) }]
                : [],
            },
          ]}
        />
      ) : null}
      {mode === "thinking" ? (
        <Animated.View
          style={[
            styles.ring,
            {
              width: ring,
              height: ring,
              borderRadius: ring / 2,
              borderColor: "transparent",
              borderTopColor: theme.orbColor2,
              transform: spin
                ? [{ rotate: spin.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] }) }]
                : [],
            },
          ]}
        />
      ) : null}
    </View>
  );
}

/** Idle waveform silhouette (bar heights out of 22), as on the web. */
const IDLE_LEVELS = [6, 10, 16, 22, 18, 12, 8, 14, 20, 16, 10, 6, 12, 18, 10, 6].map((h) => h / 22);

interface WaveformProps {
  /** Bars move while true; static silhouette otherwise. */
  active: boolean;
  bars?: number;
  barWidth?: number;
  gap?: number;
  height?: number;
  color: string;
}

/** Animated bars. Without output levels on React Native they ripple, not track the voice. */
export function Waveform({ active, bars = 16, barWidth = 3, gap = 3, height = 22, color }: WaveformProps) {
  const reduced = useReducedMotion();
  const wave = useLoop(active && !reduced, 1400);
  return (
    <View
      style={{ flexDirection: "row", alignItems: "center", height, gap }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {Array.from({ length: bars }, (_, index) => {
        const level = IDLE_LEVELS[index % IDLE_LEVELS.length]!;
        const base = Math.max(3, level * height);
        const phase = index / bars;
        const scale = wave
          ? wave.interpolate({
              inputRange: [0, phase * 0.5, phase * 0.5 + 0.25, phase * 0.5 + 0.5, 1],
              outputRange: [0.45, 0.45, 1, 0.45, 0.45],
            })
          : 1;
        return (
          <Animated.View
            key={index}
            style={{
              width: barWidth,
              height: base,
              borderRadius: barWidth / 2,
              backgroundColor: color,
              transform: [{ scaleY: scale }],
            }}
          />
        );
      })}
    </View>
  );
}

function ToolChip({ entry, texts }: { entry: ToolEntry; texts: WidgetTextContents }) {
  const theme = useTheme();
  const [expanded, setExpanded] = useState(false);
  const statusLabel =
    entry.status === "running" ? texts.toolRunning : entry.status === "done" ? texts.toolDone : texts.toolFailed;
  const dotColor =
    entry.status === "running" ? "#f5a623" : entry.status === "done" ? theme.live : theme.danger;
  const detail = (label: string, value: string) => (
    <View key={label}>
      <Text style={[styles.toolDetailLabel, { color: theme.textSecondary }]}>{label}</Text>
      <Text style={[styles.toolDetailText, { color: theme.text }]}>{value}</Text>
    </View>
  );
  return (
    <View style={styles.tool}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${entry.toolName}, ${statusLabel}`}
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((value) => !value)}
        style={[styles.toolChip, { borderColor: theme.border, backgroundColor: theme.background }]}
      >
        <View style={[styles.toolDot, { backgroundColor: dotColor }]} />
        <Text style={[styles.toolName, { color: theme.text }]}>{entry.toolName}</Text>
        <View style={expanded ? styles.rotated : undefined}>
          <IconChevronDown size={12} color={theme.textSecondary} />
        </View>
      </Pressable>
      {expanded ? (
        <ScrollView
          style={[styles.toolDetail, { backgroundColor: theme.bubbleUserBackground }]}
          contentContainerStyle={{ gap: 6 }}
          nestedScrollEnabled
        >
          {entry.input !== undefined ? detail("input", formatToolPayload(entry.input, entry.inputTruncated)) : null}
          {entry.output !== undefined
            ? detail("output", formatToolPayload(entry.output, entry.outputTruncated))
            : null}
          {entry.error !== undefined ? detail("error", entry.error) : null}
        </ScrollView>
      ) : null}
    </View>
  );
}

export function Transcript({
  entries,
  texts,
}: {
  entries: readonly TranscriptEntry[];
  texts: WidgetTextContents;
}) {
  const theme = useTheme();
  const ref = useRef<ComponentRef<typeof ScrollView>>(null);
  return (
    <ScrollView
      ref={ref}
      style={styles.transcript}
      contentContainerStyle={styles.transcriptContent}
      onContentSizeChange={() => ref.current?.scrollToEnd({ animated: true })}
      keyboardShouldPersistTaps="handled"
      accessibilityLiveRegion="polite"
    >
      {entries.map((entry) =>
        entry.kind === "message" ? (
          <View
            key={entry.id}
            style={[
              styles.bubble,
              entry.role === "agent"
                ? [styles.bubbleAgent, { backgroundColor: theme.bubbleAgentBackground }]
                : [styles.bubbleUser, { backgroundColor: theme.bubbleUserBackground }],
            ]}
          >
            <Text
              selectable
              style={[
                styles.bubbleText,
                { color: entry.role === "agent" ? theme.bubbleAgentText : theme.bubbleUserText },
              ]}
            >
              {entry.text}
            </Text>
          </View>
        ) : entry.kind === "divider" ? (
          <View key={entry.id} style={styles.divider} accessibilityRole="text">
            <View style={[styles.dividerLine, { backgroundColor: theme.border }]} />
            <Text style={[styles.dividerText, { color: theme.textSecondary }]}>{entry.label}</Text>
            <View style={[styles.dividerLine, { backgroundColor: theme.border }]} />
          </View>
        ) : (
          <ToolChip key={entry.id} entry={entry} texts={texts} />
        ),
      )}
    </ScrollView>
  );
}

interface ComposerProps {
  placeholder: string;
  sendLabel: string;
  disabled?: boolean;
  divided?: boolean;
  onSend(text: string): void;
  onActivity?(): void;
}

export function Composer({ placeholder, sendLabel, disabled, divided, onSend, onActivity }: ComposerProps) {
  const theme = useTheme();
  const [value, setValue] = useState("");
  const canSend = !disabled && value.trim().length > 0;

  const submit = () => {
    const text = value.trim();
    if (!text || disabled) {
      return;
    }
    setValue("");
    onSend(text);
  };

  return (
    <View style={[styles.composer, divided ? { borderTopWidth: 1, borderTopColor: theme.border } : null]}>
      <TextInput
        style={[styles.input, { borderColor: theme.border, color: theme.text, backgroundColor: theme.background }]}
        value={value}
        placeholder={placeholder}
        placeholderTextColor={theme.textSecondary}
        editable={!disabled}
        returnKeyType="send"
        submitBehavior="submit"
        onSubmitEditing={submit}
        onChangeText={(text) => {
          setValue(text);
          onActivity?.();
        }}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={sendLabel}
        accessibilityState={{ disabled: !canSend }}
        disabled={!canSend}
        onPress={submit}
        style={[styles.send, { backgroundColor: theme.accent, opacity: canSend ? 1 : 0.4 }]}
      >
        <IconSend size={16} color={theme.accentText} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  ring: { position: "absolute", borderWidth: 2 },
  tool: { alignSelf: "flex-start", maxWidth: "100%" },
  toolChip: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 8,
    borderWidth: 1,
    borderRadius: 999,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  toolDot: { width: 8, height: 8, borderRadius: 4 },
  toolName: { fontFamily: MONO, fontSize: 12 },
  rotated: { transform: [{ rotate: "180deg" }] },
  toolDetail: { marginTop: 6, maxHeight: 140, borderRadius: 12, paddingVertical: 10, paddingHorizontal: 12 },
  toolDetailLabel: { fontSize: 11 },
  toolDetailText: { fontFamily: MONO, fontSize: 11.5, lineHeight: 17 },
  transcript: { flex: 1 },
  transcriptContent: { padding: 16, gap: 10 },
  bubble: { maxWidth: "80%", paddingVertical: 10, paddingHorizontal: 14 },
  bubbleAgent: {
    alignSelf: "flex-start",
    borderTopLeftRadius: 6,
    borderTopRightRadius: 24,
    borderBottomLeftRadius: 24,
    borderBottomRightRadius: 24,
  },
  bubbleUser: {
    alignSelf: "flex-end",
    borderTopLeftRadius: 24,
    borderTopRightRadius: 6,
    borderBottomLeftRadius: 24,
    borderBottomRightRadius: 24,
  },
  bubbleText: { fontSize: 15, lineHeight: 21 },
  divider: { flexDirection: "row", alignItems: "center", gap: 10, marginVertical: 6 },
  dividerLine: { flex: 1, height: StyleSheet.hairlineWidth },
  dividerText: { fontSize: 12 },
  composer: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 12, paddingHorizontal: 16 },
  input: { flex: 1, minWidth: 0, height: 40, borderWidth: 1, borderRadius: 999, paddingHorizontal: 16, fontSize: 15 },
  send: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
});
