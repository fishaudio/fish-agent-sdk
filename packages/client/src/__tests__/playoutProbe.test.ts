import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientSessionMessage } from "@fishaudio/agent-protocol";
import {
  heardReport,
  jitterBufferMs,
  MIC_AGENT_MARGIN_MS,
  OnsetDetector,
  PlayoutProbe,
  POLL_INTERVAL_MS,
  readVoiceStats,
  rmsOf,
  SPEECH_END_MAX_AGE_MS,
  SpeechEndTracker,
  STATS_INTERVAL_MS,
} from "../audio/playoutProbe.js";

describe("jitterBufferMs", () => {
  it("averages the delay added over the interval", () => {
    // jitterBufferDelay sums every emitted sample's delay in seconds: 2400 s over
    // 24,000 samples is 100 ms each.
    const prev = { jitterBufferDelay: 10, jitterBufferEmittedCount: 48_000 };
    const next = { jitterBufferDelay: 2410, jitterBufferEmittedCount: 72_000 };
    expect(jitterBufferMs(prev, next)).toBe(100);
  });

  it("is null without two readings, without emitted samples, or without the fields", () => {
    const stats = { jitterBufferDelay: 1, jitterBufferEmittedCount: 100 };
    expect(jitterBufferMs(undefined, stats)).toBeNull();
    expect(jitterBufferMs(stats, stats)).toBeNull();
    expect(jitterBufferMs({ jitterBufferDelay: 1 }, stats)).toBeNull();
  });
});

describe("readVoiceStats", () => {
  it("reads the nominated pair's round trip and the inbound audio entry", () => {
    const report = [
      { type: "candidate-pair", nominated: false, currentRoundTripTime: 0.9 },
      { type: "candidate-pair", nominated: true, currentRoundTripTime: 0.0426 },
      { type: "inbound-rtp", kind: "video", jitterBufferDelay: 5, jitterBufferEmittedCount: 5 },
      { type: "inbound-rtp", kind: "audio", jitterBufferDelay: 3.5, jitterBufferEmittedCount: 4800 },
    ];
    expect(readVoiceStats(report)).toEqual({
      rttMs: 43,
      inbound: { jitterBufferDelay: 3.5, jitterBufferEmittedCount: 4800 },
    });
  });

  it("is empty for a report without them", () => {
    expect(readVoiceStats([{ type: "transport" }])).toEqual({ rttMs: null, inbound: undefined });
  });
});

describe("OnsetDetector", () => {
  it("reports the first sound, then only a sound after 300 ms of silence", () => {
    const onsets = new OnsetDetector();
    expect(onsets.sample(0.001, 0)).toBeUndefined();
    expect(onsets.sample(0.05, 10)).toBe(10);
    expect(onsets.sample(0.05, 20)).toBeUndefined();
    expect(onsets.sample(0.0, 30)).toBeUndefined();
    // A pause inside the sentence is no new stretch.
    expect(onsets.sample(0.03, 300)).toBeUndefined();
    expect(onsets.sample(0.0, 310)).toBeUndefined();
    expect(onsets.sample(0.03, 610)).toBe(610);
  });
});

describe("SpeechEndTracker", () => {
  it("keeps the last mic sample over the threshold as the caller's speech end", () => {
    const speech = new SpeechEndTracker();
    speech.sample(0.01, 0, 0);
    expect(speech.speechEndBefore(10)).toBeUndefined();
    speech.sample(0.1, 0, 10);
    speech.sample(0.05, 0, 20);
    speech.sample(0.029, 0, 30);
    expect(speech.speechEndBefore(500)).toBe(20);
  });

  it("ignores the mic while the agent has sounded within the margin", () => {
    const speech = new SpeechEndTracker();
    speech.sample(0.1, 0, 0);
    // The agent speaks: the mic hears it through the speakers.
    speech.sample(0.1, 0.05, 100);
    speech.sample(0.1, 0, 100 + MIC_AGENT_MARGIN_MS);
    expect(speech.speechEndBefore(300)).toBe(0);
    // Past the margin the caller counts again.
    speech.sample(0.1, 0, 101 + MIC_AGENT_MARGIN_MS);
    expect(speech.speechEndBefore(300)).toBe(101 + MIC_AGENT_MARGIN_MS);
  });

  it("forgets speech older than the cap", () => {
    const speech = new SpeechEndTracker();
    speech.sample(0.1, 0, 1000);
    expect(speech.speechEndBefore(1000 + SPEECH_END_MAX_AGE_MS)).toBe(1000);
    expect(speech.speechEndBefore(1001 + SPEECH_END_MAX_AGE_MS)).toBeUndefined();
  });
});

describe("heardReport", () => {
  it("adds the output latency and measures from the caller's speech end", () => {
    expect(heardReport(1000, 12, 400)).toEqual({
      type: "client.heard",
      at: 1012,
      sinceSpeechEndMs: 612,
      outputLatencyMs: 12,
    });
  });

  it("carries null without caller speech", () => {
    expect(heardReport(1000, 0, undefined)).toEqual({
      type: "client.heard",
      at: 1000,
      sinceSpeechEndMs: null,
      outputLatencyMs: 0,
    });
  });
});

describe("rmsOf", () => {
  it("is 0 for silence and the amplitude for a flat window", () => {
    expect(rmsOf(new Uint8Array(4).fill(128))).toBe(0);
    expect(rmsOf(new Uint8Array(4).fill(192))).toBeCloseTo(0.5, 6);
    expect(rmsOf(new Uint8Array(0))).toBe(0);
  });
});

/** A WebAudio stand-in: each analyser reads the level set on its stream. */
class FakeAnalyser {
  fftSize = 2048;
  level = 128;
  getByteTimeDomainData(samples: Uint8Array): void {
    samples.fill(this.level);
  }
  disconnect(): void {}
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  state = "running";
  outputLatency = 0.012;
  readonly analysers: FakeAnalyser[] = [];
  readonly sources: Array<{ stream: MediaStream; analyser?: FakeAnalyser }> = [];
  constructor() {
    FakeAudioContext.instances.push(this);
  }
  createAnalyser(): FakeAnalyser {
    const analyser = new FakeAnalyser();
    this.analysers.push(analyser);
    return analyser;
  }
  createMediaStreamSource(stream: MediaStream) {
    const source = {
      stream,
      analyser: undefined as FakeAnalyser | undefined,
      connect(analyser: FakeAnalyser) {
        source.analyser = analyser;
      },
      disconnect() {},
    };
    this.sources.push(source);
    return source;
  }
  async resume(): Promise<void> {}
  async close(): Promise<void> {
    this.state = "closed";
  }
}

describe("PlayoutProbe", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    FakeAudioContext.instances.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("reports the voice track's stats every 2 s, the jitter buffer from the second reading on", async () => {
    const sent: ClientSessionMessage[] = [];
    let emitted = 48_000;
    let delay = 10;
    const receiver = {
      getStats: async () =>
        new Map<string, unknown>([
          ["p", { type: "candidate-pair", nominated: true, currentRoundTripTime: 0.03 }],
          ["i", { type: "inbound-rtp", kind: "audio", jitterBufferDelay: delay, jitterBufferEmittedCount: emitted }],
        ]) as unknown as RTCStatsReport,
    } as unknown as RTCRtpReceiver;
    const probe = new PlayoutProbe({ send: (message) => sent.push(message), getVoiceReceiver: () => receiver });
    probe.setVoiceStream({} as MediaStream);
    await vi.advanceTimersByTimeAsync(STATS_INTERVAL_MS);
    emitted += 24_000;
    delay += 1200;
    await vi.advanceTimersByTimeAsync(STATS_INTERVAL_MS);
    expect(sent).toEqual([
      { type: "client.stats", at: 12_000, rttMs: 30, jitterBufferMs: null },
      { type: "client.stats", at: 14_000, rttMs: 30, jitterBufferMs: 50 },
    ]);
    probe.stop();
  });

  it("reports each stretch of agent sound with the time since the caller's speech ended", () => {
    vi.stubGlobal("AudioContext", FakeAudioContext);
    const sent: ClientSessionMessage[] = [];
    const probe = new PlayoutProbe({ send: (message) => sent.push(message) });
    probe.setVoiceStream({ id: "voice" } as unknown as MediaStream);
    probe.setInputStream({ id: "mic" } as unknown as MediaStream);
    const context = FakeAudioContext.instances[0]!;
    expect(context.analysers).toHaveLength(2);
    const [voice, mic] = context.analysers as [FakeAnalyser, FakeAnalyser];
    // The caller speaks for 200 ms, then is quiet.
    mic.level = 160;
    vi.advanceTimersByTime(20 * POLL_INTERVAL_MS);
    mic.level = 128;
    vi.advanceTimersByTime(50 * POLL_INTERVAL_MS);
    const speechEndAt = 10_000 + 20 * POLL_INTERVAL_MS;
    // The agent starts at the next poll, 510 ms after the caller stopped.
    voice.level = 150;
    vi.advanceTimersByTime(POLL_INTERVAL_MS);
    const onsetAt = speechEndAt + 51 * POLL_INTERVAL_MS;
    expect(sent).toEqual([
      { type: "client.heard", at: onsetAt + 12, sinceSpeechEndMs: onsetAt + 12 - speechEndAt, outputLatencyMs: 12 },
    ]);
    // The mic hears the agent through the speakers: no new speech end, and no second report inside the stretch.
    mic.level = 160;
    vi.advanceTimersByTime(30 * POLL_INTERVAL_MS);
    mic.level = 128;
    voice.level = 128;
    vi.advanceTimersByTime(40 * POLL_INTERVAL_MS);
    voice.level = 150;
    vi.advanceTimersByTime(POLL_INTERVAL_MS);
    expect(sent).toHaveLength(2);
    expect((sent[1] as { sinceSpeechEndMs: number | null }).sinceSpeechEndMs).toBe(
      (sent[1] as { at: number }).at - speechEndAt,
    );
    probe.stop();
    expect(context.state).toBe("closed");
  });

  it("reports null without caller speech, and nothing before the voice stream", () => {
    vi.stubGlobal("AudioContext", FakeAudioContext);
    const sent: ClientSessionMessage[] = [];
    const probe = new PlayoutProbe({ send: (message) => sent.push(message) });
    probe.setInputStream({ id: "mic" } as unknown as MediaStream);
    vi.advanceTimersByTime(50 * POLL_INTERVAL_MS);
    expect(sent).toEqual([]);
    probe.setVoiceStream({ id: "voice" } as unknown as MediaStream);
    const [, voice] = FakeAudioContext.instances[0]!.analysers as [FakeAnalyser, FakeAnalyser];
    voice.level = 150;
    vi.advanceTimersByTime(POLL_INTERVAL_MS);
    expect(sent).toEqual([{ type: "client.heard", at: 10_000 + 51 * POLL_INTERVAL_MS + 12, sinceSpeechEndMs: null, outputLatencyMs: 12 }]);
    probe.stop();
  });

  it("sends nothing after stop and nothing without streams, and never a ping", () => {
    const sent: ClientSessionMessage[] = [];
    const probe = new PlayoutProbe({ send: (message) => sent.push(message) });
    vi.advanceTimersByTime(60_000);
    expect(sent).toEqual([]);
    probe.stop();
    probe.setVoiceStream({} as MediaStream);
    probe.setInputStream({} as MediaStream);
    vi.advanceTimersByTime(60_000);
    expect(sent).toEqual([]);
  });
});
