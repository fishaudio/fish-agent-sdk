/**
 * The playout probe: the turn latency as the caller's ear has it, measured in
 * the browser and reported to the agent (the console shows it as the heard
 * voice-to-voice next to the agent's own). Two reports ride the client-event
 * channel while the agent's voice track is subscribed: the voice track's
 * WebRTC stats every 2 s (round trip to the media edge, jitter buffer delay),
 * and `client.heard` at the first sample of every stretch of agent speech,
 * with the time since the caller's own speech ended at the microphone. Both
 * ends of that number are on the browser's clock, so it needs no clock sync
 * and includes both network legs. Browser only: without WebAudio or getStats
 * the probe sends what it can, or nothing at all.
 */
import type { ClientSessionMessage } from "@fishaudio/agent-protocol";

export const STATS_INTERVAL_MS = 2000;
export const POLL_INTERVAL_MS = 10;
/** RMS of full scale from which the voice track counts as sound. */
export const ONSET_RMS = 0.02;
/** Silence at least this long before a sound starts a new stretch of speech. */
export const ONSET_GAP_MS = 300;
/** RMS of full scale from which the microphone counts as the caller speaking (the capture runs with AGC). */
export const MIC_RMS = 0.03;
/** A mic sample this soon after agent sound is the agent through the speakers, not the caller. */
export const MIC_AGENT_MARGIN_MS = 100;
/** Caller speech older than this before the agent's sound is not the turn being answered. */
export const SPEECH_END_MAX_AGE_MS = 10_000;
/** The analyser's window, about 10 ms at 48 kHz, so a 10 ms poll misses no sound. */
const FFT_SIZE = 512;

export type ClientHeard = Extract<ClientSessionMessage, { type: "client.heard" }>;

/** The fields of an `inbound-rtp` audio stats entry the jitter buffer delay is read from. */
export interface InboundRtpStats {
  jitterBufferDelay?: number;
  jitterBufferEmittedCount?: number;
}

/**
 * The jitter buffer's average delay over the interval between two inbound-rtp
 * readings, in whole ms. Null without two readings or when nothing was emitted.
 */
export function jitterBufferMs(
  prev: InboundRtpStats | undefined,
  next: InboundRtpStats | undefined,
): number | null {
  if (
    prev?.jitterBufferDelay === undefined ||
    prev.jitterBufferEmittedCount === undefined ||
    next?.jitterBufferDelay === undefined ||
    next.jitterBufferEmittedCount === undefined
  ) {
    return null;
  }
  const delay = next.jitterBufferDelay - prev.jitterBufferDelay;
  const count = next.jitterBufferEmittedCount - prev.jitterBufferEmittedCount;
  if (!(count > 0) || !(delay >= 0)) {
    return null;
  }
  return Math.round((1000 * delay) / count);
}

export interface VoiceStats {
  /** The nominated candidate pair's round trip, whole ms, null when the report has none. */
  rttMs: number | null;
  inbound: InboundRtpStats | undefined;
}

/** What the probe reads out of the voice track's stats report. */
export function readVoiceStats(report: Iterable<unknown>): VoiceStats {
  let rttMs: number | null = null;
  let inbound: InboundRtpStats | undefined;
  for (const entry of report) {
    const stats = entry as Record<string, unknown>;
    if (stats.type === "inbound-rtp" && stats.kind === "audio") {
      inbound = {
        jitterBufferDelay: numberOrUndefined(stats.jitterBufferDelay),
        jitterBufferEmittedCount: numberOrUndefined(stats.jitterBufferEmittedCount),
      };
    } else if (
      stats.type === "candidate-pair" &&
      stats.nominated === true &&
      typeof stats.currentRoundTripTime === "number"
    ) {
      rttMs = Math.round(1000 * stats.currentRoundTripTime);
    }
  }
  return { rttMs, inbound };
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Onsets of agent speech from the voice track's RMS samples: a sound after silence. */
export class OnsetDetector {
  private lastSoundAt?: number;

  /** The onset's time when this sample starts a stretch of speech, else undefined. */
  sample(rms: number, at: number): number | undefined {
    if (!(rms >= ONSET_RMS)) {
      return undefined;
    }
    const onset = this.lastSoundAt === undefined || at - this.lastSoundAt >= ONSET_GAP_MS;
    this.lastSoundAt = at;
    return onset ? at : undefined;
  }
}

/**
 * When the caller last spoke at the microphone, from the mic's and the voice
 * track's RMS at every poll. A mic sample within MIC_AGENT_MARGIN_MS of agent
 * sound is the agent through the speakers (echo cancellation leaves some) and
 * does not count.
 */
export class SpeechEndTracker {
  private lastAgentSoundAt?: number;
  private lastSpeechAt?: number;

  sample(micRms: number, agentRms: number, at: number): void {
    if (agentRms >= ONSET_RMS) {
      this.lastAgentSoundAt = at;
    }
    const agentSounding =
      this.lastAgentSoundAt !== undefined && at - this.lastAgentSoundAt <= MIC_AGENT_MARGIN_MS;
    if (micRms >= MIC_RMS && !agentSounding) {
      this.lastSpeechAt = at;
    }
  }

  /** The end of the caller's last speech before `at`, undefined when none within SPEECH_END_MAX_AGE_MS. */
  speechEndBefore(at: number): number | undefined {
    if (this.lastSpeechAt === undefined || at - this.lastSpeechAt > SPEECH_END_MAX_AGE_MS) {
      return undefined;
    }
    return this.lastSpeechAt;
  }
}

/** The `client.heard` report of an onset at client time `at` (output latency not yet added). */
export function heardReport(
  at: number,
  outputLatencyMs: number,
  speechEndAt: number | undefined,
): ClientHeard {
  const heardAt = at + outputLatencyMs;
  return {
    type: "client.heard",
    at: heardAt,
    sinceSpeechEndMs: speechEndAt === undefined ? null : Math.max(0, heardAt - speechEndAt),
    outputLatencyMs,
  };
}

/** RMS of full scale over an analyser's latest window. */
export function rmsOf(samples: Uint8Array): number {
  let sumOfSquares = 0;
  for (const sample of samples) {
    const centered = (sample - 128) / 128;
    sumOfSquares += centered * centered;
  }
  return samples.length === 0 ? 0 : Math.sqrt(sumOfSquares / samples.length);
}

export interface PlayoutProbeOptions {
  send(message: ClientSessionMessage): void;
  /** The voice track's RTP receiver, for its stats. Undefined where there is none. */
  getVoiceReceiver?(): RTCRtpReceiver | undefined;
  now?(): number;
}

/** One analyser on one stream. */
interface Tap {
  analyser: AnalyserNode;
  source: MediaStreamAudioSourceNode;
  samples: Uint8Array<ArrayBuffer>;
}

export class PlayoutProbe {
  private readonly onsets = new OnsetDetector();
  private readonly speech = new SpeechEndTracker();
  private context?: AudioContext;
  private voice?: Tap;
  private mic?: Tap;
  private statsTimer?: ReturnType<typeof setInterval>;
  private pollTimer?: ReturnType<typeof setInterval>;
  private previousInbound?: InboundRtpStats;
  private stopped = false;

  constructor(private readonly options: PlayoutProbeOptions) {}

  /** The agent's voice track is playing: the reports start, or follow the new stream. */
  setVoiceStream(stream: MediaStream): void {
    if (this.stopped) {
      return;
    }
    this.voice = this.attach(stream, this.voice);
    this.statsTimer ??= setInterval(() => void this.stats(), STATS_INTERVAL_MS);
    this.startPolling();
  }

  /** The caller's microphone, whenever it appears: its speech ends anchor the heard reports. */
  setInputStream(stream: MediaStream): void {
    if (this.stopped) {
      return;
    }
    this.mic = this.attach(stream, this.mic);
    this.startPolling();
  }

  /** AudioContexts start suspended under autoplay policies: safe to call any time. */
  resume(): void {
    if (this.context?.state === "suspended") {
      void this.context.resume().catch(() => {});
    }
  }

  stop(): void {
    this.stopped = true;
    for (const timer of [this.statsTimer, this.pollTimer]) {
      if (timer) {
        clearInterval(timer);
      }
    }
    this.statsTimer = this.pollTimer = undefined;
    for (const tap of [this.voice, this.mic]) {
      tap?.source.disconnect();
      tap?.analyser.disconnect();
    }
    void this.context?.close().catch(() => {});
    this.voice = this.mic = this.context = undefined;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private startPolling(): void {
    if (!this.pollTimer && (this.voice || this.mic)) {
      this.pollTimer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
    }
  }

  /** An analyser on `stream`, reusing `previous`'s analyser. Undefined without WebAudio. */
  private attach(stream: MediaStream, previous: Tap | undefined): Tap | undefined {
    if (typeof AudioContext === "undefined") {
      return undefined;
    }
    try {
      this.context ??= new AudioContext();
      previous?.source.disconnect();
      const analyser = previous?.analyser ?? this.context.createAnalyser();
      analyser.fftSize = FFT_SIZE;
      const source = this.context.createMediaStreamSource(stream);
      source.connect(analyser);
      this.resume();
      return { analyser, source, samples: previous?.samples ?? new Uint8Array(analyser.fftSize) };
    } catch {
      // No analyser: the stats still go out.
      return undefined;
    }
  }

  private async stats(): Promise<void> {
    const receiver = this.options.getVoiceReceiver?.();
    if (!receiver || typeof receiver.getStats !== "function") {
      return;
    }
    let report: RTCStatsReport;
    try {
      report = await receiver.getStats();
    } catch {
      return;
    }
    if (this.stopped) {
      return;
    }
    const { rttMs, inbound } = readVoiceStats(report.values());
    const jitter = jitterBufferMs(this.previousInbound, inbound);
    this.previousInbound = inbound;
    this.options.send({ type: "client.stats", at: this.now(), rttMs, jitterBufferMs: jitter });
  }

  private level(tap: Tap | undefined): number {
    if (!tap) {
      return 0;
    }
    tap.analyser.getByteTimeDomainData(tap.samples);
    return rmsOf(tap.samples);
  }

  private poll(): void {
    const now = this.now();
    const voiceRms = this.level(this.voice);
    this.speech.sample(this.level(this.mic), voiceRms, now);
    if (!this.voice) {
      return;
    }
    const onset = this.onsets.sample(voiceRms, now);
    if (onset === undefined) {
      return;
    }
    const outputLatency = this.context?.outputLatency;
    const outputLatencyMs = typeof outputLatency === "number" ? Math.round(1000 * outputLatency) : 0;
    this.options.send(heardReport(onset, outputLatencyMs, this.speech.speechEndBefore(onset)));
  }
}
