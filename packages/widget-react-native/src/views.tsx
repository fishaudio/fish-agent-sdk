import type { AgentMode } from "@fishaudio/agent-client";
import { formatTimer, type TranscriptEntry, type WidgetSettings } from "@fishaudio/agent-widget-shared";
import { useEffect, useState, type ReactNode } from "react";
import { Linking, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { IconAudioLines, IconMic, IconMicOff, IconMinimize, IconPhone, IconPhoneOff, IconX } from "./icons.js";
import { Composer, Orb, Transcript, Waveform } from "./parts.js";
import { useTheme, type WidgetTheme } from "./theme.js";

function shadow(theme: WidgetTheme, radius: number, opacity: number): ViewStyle {
  return {
    shadowColor: "#0f0e0d",
    shadowOpacity: opacity,
    shadowRadius: radius,
    shadowOffset: { width: 0, height: radius / 3 },
    elevation: Math.round(radius / 2),
    backgroundColor: theme.background,
  };
}

function openUrl(url: string): void {
  void Linking.openURL(url).catch(() => undefined);
}

interface FabViewProps {
  settings: WidgetSettings;
  proactiveVisible: boolean;
  alignEnd: boolean;
  onOpen(): void;
  onDismissProactive(): void;
}

export function FabView({ settings, proactiveVisible, alignEnd, onOpen, onDismissProactive }: FabViewProps) {
  const theme = useTheme();
  const top = settings.position.startsWith("top");
  const bubble =
    proactiveVisible && settings.proactiveMessage ? (
      <View
        style={[
          styles.proactive,
          shadow(theme, 20, 0.14),
          { borderColor: theme.border },
          top ? { marginTop: 12 } : { marginBottom: 12 },
        ]}
      >
        <Text style={[styles.proactiveText, { color: theme.text }]}>{settings.proactiveMessage}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={settings.texts.dismissLabel}
          hitSlop={10}
          onPress={onDismissProactive}
          style={[
            styles.proactiveDismiss,
            alignEnd ? { right: -9 } : { left: -9 },
            { borderColor: theme.border, backgroundColor: theme.background },
          ]}
        >
          <IconX size={11} color={theme.textSecondary} />
        </Pressable>
      </View>
    ) : null;
  const fab = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={settings.texts.openLabel}
      onPress={onOpen}
      style={({ pressed }) => [
        shadow(theme, 24, 0.22),
        {
          width: theme.fabSize,
          height: theme.fabSize,
          borderRadius: theme.fabSize / 2,
          backgroundColor: theme.accent,
          alignItems: "center",
          justifyContent: "center",
          transform: [{ scale: pressed ? 0.95 : 1 }],
        },
      ]}
    >
      <IconAudioLines size={26} color={theme.accentText} />
    </Pressable>
  );
  return (
    <View style={{ alignItems: alignEnd ? "flex-end" : "flex-start" }}>
      {top ? fab : bubble}
      {top ? bubble : fab}
    </View>
  );
}

interface PanelShellProps {
  settings: WidgetSettings;
  status: ReactNode;
  mode?: AgentMode;
  live?: boolean;
  starting?: boolean;
  muted?: boolean;
  onToggleMute?(): void;
  onEnd?(): void;
  onMinimize(): void;
  onClose(): void;
  style: StyleProp<ViewStyle>;
  children: ReactNode;
}

export function PanelShell({
  settings,
  status,
  mode,
  live,
  starting,
  muted,
  onToggleMute,
  onEnd,
  onMinimize,
  onClose,
  style,
  children,
}: PanelShellProps) {
  const theme = useTheme();
  const { texts } = settings;
  const inCall = live || starting;
  return (
    <View style={[styles.panel, { backgroundColor: theme.background, borderColor: theme.border }, style]}>
      <View style={[styles.header, { borderBottomColor: theme.border }]}>
        <View style={styles.headerLeft}>
          <Orb size={32} mode={mode} />
          <View style={styles.headerNames}>
            <Text numberOfLines={1} style={[styles.headerTitle, { color: theme.text }]}>
              {settings.agentName}
            </Text>
            {status != null ? <View style={styles.headerStatus}>{status}</View> : null}
          </View>
        </View>
        <View style={styles.headerActions}>
          <IconButton label={texts.minimizeLabel} onPress={onMinimize}>
            <IconMinimize size={16} color={theme.textSecondary} />
          </IconButton>
          {inCall ? (
            <>
              {settings.micMuting ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={muted ? texts.unmuteLabel : texts.muteLabel}
                  accessibilityState={{ selected: muted, disabled: !live }}
                  disabled={!live}
                  onPress={onToggleMute}
                  style={[
                    styles.headerPill,
                    { backgroundColor: muted ? theme.accent : "rgba(128, 128, 128, 0.14)", opacity: live ? 1 : 0.5 },
                  ]}
                >
                  {muted ? (
                    <IconMic size={13} color={theme.accentText} />
                  ) : (
                    <IconMicOff size={13} color={theme.text} />
                  )}
                  <Text style={[styles.headerPillText, { color: muted ? theme.accentText : theme.text }]}>
                    {muted ? texts.unmuteShort : texts.muteShort}
                  </Text>
                </Pressable>
              ) : null}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={texts.endCallLabel}
                hitSlop={6}
                onPress={onEnd}
                style={[styles.headerEnd, { backgroundColor: theme.danger }]}
              >
                <IconPhoneOff size={15} color="#ffffff" />
              </Pressable>
            </>
          ) : (
            <IconButton label={texts.closeLabel} onPress={onClose}>
              <IconX size={16} color={theme.textSecondary} />
            </IconButton>
          )}
        </View>
      </View>
      {children}
      <Pressable accessibilityRole="link" onPress={() => openUrl("https://fish.audio")} style={styles.footer}>
        <Text style={[styles.footerText, { color: theme.textSecondary }]}>{texts.poweredBy}</Text>
      </Pressable>
    </View>
  );
}

function IconButton({ label, onPress, children }: { label: string; onPress(): void; children: ReactNode }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      onPress={onPress}
      style={({ pressed }) => [styles.iconButton, pressed ? { opacity: 0.6 } : null]}
    >
      {children}
    </Pressable>
  );
}

export function LiveStatus({ label, color, dot }: { label: string; color: string; dot?: string }) {
  return (
    <>
      {dot ? <View style={[styles.liveDot, { backgroundColor: dot }]} /> : null}
      <Text style={[styles.headerStatusText, { color }]}>{label}</Text>
    </>
  );
}

function ErrorLine({ error }: { error: string | null }) {
  const theme = useTheme();
  return error ? (
    <Text accessibilityRole="alert" style={[styles.error, { color: theme.danger }]}>
      {error}
    </Text>
  ) : null;
}

function Cta({ label, wide, onPress }: { label: string; wide?: boolean; onPress(): void }) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.cta,
        wide ? styles.ctaWide : null,
        { backgroundColor: theme.accent, opacity: pressed ? 0.85 : 1 },
      ]}
    >
      <IconPhone size={16} color={theme.accentText} />
      <Text style={[styles.ctaText, { color: theme.accentText }]}>{label}</Text>
    </Pressable>
  );
}

interface HomeViewProps {
  settings: WidgetSettings;
  /** Full-screen sheet: center the greeting and keep the composer at the bottom. */
  fill?: boolean;
  error: string | null;
  onStartVoice(): void;
  onSendText(text: string): void;
}

export function HomeView({ settings, fill, error, onStartVoice, onSendText }: HomeViewProps) {
  const theme = useTheme();
  const { texts } = settings;
  return (
    <>
      <View style={[styles.home, fill ? styles.fill : null]}>
        <Orb size={72} />
        <Text style={[styles.homeGreeting, { color: theme.text }]}>{texts.greeting}</Text>
        <Text style={[styles.homeHint, { color: theme.textSecondary }]}>
          {settings.textInput ? texts.homeHint : texts.startVoice}
        </Text>
        <Cta label={texts.startVoice} onPress={onStartVoice} />
      </View>
      <ErrorLine error={error} />
      {settings.textInput ? (
        <Composer placeholder={texts.composerPlaceholder} sendLabel={texts.sendLabel} onSend={onSendText} />
      ) : null}
    </>
  );
}

interface ConsentViewProps {
  settings: WidgetSettings;
  fill?: boolean;
  onAgree(): void;
  onDecline(): void;
}

export function ConsentView({ settings, fill, onAgree, onDecline }: ConsentViewProps) {
  const theme = useTheme();
  const { texts, termsUrl, privacyUrl } = settings;
  return (
    <View style={[styles.consent, fill ? styles.fill : null]}>
      <Text style={[styles.consentTitle, { color: theme.text }]}>{texts.consentTitle}</Text>
      <Text style={[styles.consentTerms, { color: theme.text, backgroundColor: theme.bubbleUserBackground }]}>
        {texts.consentBody}
      </Text>
      {termsUrl || privacyUrl ? (
        <View style={styles.consentLinks}>
          {termsUrl ? (
            <Text accessibilityRole="link" onPress={() => openUrl(termsUrl)} style={[styles.link, { color: theme.text }]}>
              Terms of Service
            </Text>
          ) : null}
          {privacyUrl ? (
            <Text
              accessibilityRole="link"
              onPress={() => openUrl(privacyUrl)}
              style={[styles.link, { color: theme.text }]}
            >
              Privacy Policy
            </Text>
          ) : null}
        </View>
      ) : null}
      <View style={styles.consentButtons}>
        <Pressable
          accessibilityRole="button"
          onPress={onDecline}
          style={[styles.button, { borderWidth: 1, borderColor: theme.border, backgroundColor: theme.background }]}
        >
          <Text style={[styles.buttonText, { color: theme.text }]}>{texts.consentDecline}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" onPress={onAgree} style={[styles.button, { backgroundColor: theme.accent }]}>
          <Text style={[styles.buttonText, { color: theme.accentText, fontWeight: "500" }]}>{texts.consentAgree}</Text>
        </Pressable>
      </View>
    </View>
  );
}

export type CallPhase = "starting" | "live" | "ended";

interface CallViewProps {
  settings: WidgetSettings;
  entries: readonly TranscriptEntry[];
  phase: CallPhase;
  mode: AgentMode;
  error: string | null;
  onRestartVoice(): void;
  onSendText(text: string): void;
  onActivity(): void;
}

export function CallView({
  settings,
  entries,
  phase,
  mode,
  error,
  onRestartVoice,
  onSendText,
  onActivity,
}: CallViewProps) {
  const theme = useTheme();
  const { texts } = settings;
  const live = phase === "live";
  const ended = phase === "ended";
  // As on the web: the ended view hides the composer behind "continue by
  // typing"; a new call resets it.
  const [typingRevealed, setTypingRevealed] = useState(false);
  useEffect(() => {
    if (!ended) {
      setTypingRevealed(false);
    }
  }, [ended]);
  return (
    <>
      {settings.transcript ? (
        <Transcript entries={entries} texts={texts} />
      ) : (
        <View style={[styles.home, { flex: 1, justifyContent: "center" }]}>
          <Orb size={72} mode={live ? mode : undefined} />
        </View>
      )}
      <ErrorLine error={error} />
      {!ended ? (
        <View style={[styles.modeStatus, { borderTopColor: theme.border }]}>
          <Waveform active={live} bars={5} barWidth={2} gap={3} height={12} color={theme.textSecondary} />
          <Text style={[styles.modeStatusText, { color: theme.textSecondary }]}>
            {live ? texts[mode] : texts.statusConnecting}
          </Text>
        </View>
      ) : null}
      {settings.textInput && (!ended || typingRevealed) ? (
        <Composer
          placeholder={texts.composerPlaceholder}
          sendLabel={texts.sendLabel}
          disabled={phase === "starting"}
          divided={ended}
          onSend={onSendText}
          onActivity={onActivity}
        />
      ) : null}
      {ended ? (
        <View style={[styles.ended, { borderTopColor: theme.border }]}>
          <Cta label={texts.restartVoice} wide onPress={onRestartVoice} />
          {settings.textInput && !typingRevealed ? (
            <Pressable accessibilityRole="button" onPress={() => setTypingRevealed(true)} style={styles.linkButton}>
              <Text style={[styles.linkButtonText, { color: theme.textSecondary }]}>{texts.continueWithText}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </>
  );
}

interface MinimizedPillProps {
  settings: WidgetSettings;
  seconds: number;
  live: boolean;
  onExpand(): void;
  onEnd(): void;
}

export function MinimizedPill({ settings, seconds, live, onExpand, onEnd }: MinimizedPillProps) {
  const theme = useTheme();
  const { texts } = settings;
  return (
    <View style={[styles.pill, shadow(theme, 24, 0.18), { borderColor: theme.border }]}>
      <Pressable accessibilityRole="button" accessibilityLabel={texts.expandLabel} onPress={onExpand} style={styles.pillExpand}>
        <Orb size={32} mode="speaking" />
        <Waveform active={live} bars={6} barWidth={2.5} gap={2.5} height={18} color={theme.text} />
        <Text style={[styles.pillTimer, { color: theme.text }]}>{formatTimer(seconds)}</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={texts.endCallLabel}
        onPress={onEnd}
        style={[styles.pillEnd, { backgroundColor: theme.danger }]}
      >
        <IconPhoneOff size={14} color="#ffffff" />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  proactive: {
    maxWidth: 260,
    borderWidth: 1,
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  proactiveText: { fontSize: 14, lineHeight: 20 },
  proactiveDismiss: {
    position: "absolute",
    top: -9,
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  panel: { overflow: "hidden", flexDirection: "column" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerLeft: { flexDirection: "row", alignItems: "center", gap: 10, flexShrink: 1 },
  headerNames: { flexShrink: 1 },
  headerTitle: { fontSize: 15, fontWeight: "600" },
  headerStatus: { flexDirection: "row", alignItems: "center", gap: 5 },
  headerStatusText: { fontSize: 12 },
  liveDot: { width: 6, height: 6, borderRadius: 3 },
  headerActions: { flexDirection: "row", alignItems: "center", gap: 6 },
  iconButton: { width: 32, height: 32, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  headerPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    height: 30,
    paddingHorizontal: 11,
    borderRadius: 999,
  },
  headerPillText: { fontSize: 13 },
  headerEnd: { width: 30, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center" },
  modeStatus: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingTop: 10,
    paddingBottom: 4,
    paddingHorizontal: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  modeStatusText: { fontSize: 12 },
  footer: { paddingTop: 6, paddingBottom: 10, alignItems: "center" },
  footerText: { fontSize: 12 },
  error: { fontSize: 13, textAlign: "center", paddingTop: 8, paddingHorizontal: 16 },
  fill: { flex: 1, justifyContent: "center" },
  home: { paddingTop: 36, paddingBottom: 28, paddingHorizontal: 24, alignItems: "center", gap: 6 },
  homeGreeting: { marginTop: 14, fontSize: 16, fontWeight: "600", textAlign: "center" },
  homeHint: { fontSize: 14, textAlign: "center" },
  cta: {
    marginTop: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    height: 44,
    paddingHorizontal: 22,
    borderRadius: 999,
  },
  ctaWide: { marginTop: 0, alignSelf: "stretch" },
  ctaText: { fontSize: 15, fontWeight: "500" },
  consent: { paddingTop: 24, paddingBottom: 28, paddingHorizontal: 24, alignItems: "center", gap: 14 },
  consentTitle: { fontSize: 16, fontWeight: "600" },
  consentTerms: { borderRadius: 12, padding: 14, fontSize: 13, lineHeight: 20, overflow: "hidden" },
  consentLinks: { flexDirection: "row", gap: 12 },
  link: { fontSize: 13, textDecorationLine: "underline" },
  consentButtons: { flexDirection: "row", gap: 10 },
  button: { height: 42, paddingHorizontal: 18, borderRadius: 999, alignItems: "center", justifyContent: "center" },
  buttonText: { fontSize: 15 },
  ended: {
    alignItems: "center",
    gap: 4,
    paddingTop: 12,
    paddingBottom: 14,
    paddingHorizontal: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  linkButton: { paddingVertical: 6, paddingHorizontal: 8 },
  linkButtonText: { fontSize: 14 },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderWidth: 1,
    borderRadius: 999,
    padding: 10,
  },
  pillExpand: { flexDirection: "row", alignItems: "center", gap: 10 },
  pillTimer: { fontSize: 14, fontVariant: ["tabular-nums"] },
  pillEnd: { width: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center" },
});
