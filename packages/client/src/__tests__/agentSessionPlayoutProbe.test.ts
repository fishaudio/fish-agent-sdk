import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClientSessionMessage, SessionToken } from "@fishaudio/agent-protocol";
import type { Transport, TransportCallbacks, TransportConnectOptions } from "../transport/types.js";

const probes: Array<{
  options: { send(message: ClientSessionMessage): void; getVoiceReceiver?(): unknown };
  setVoiceStream: ReturnType<typeof vi.fn>;
  setInputStream: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}> = [];

vi.mock("../audio/playoutProbe.js", () => ({
  PlayoutProbe: class {
    setVoiceStream = vi.fn();
    setInputStream = vi.fn();
    resume = vi.fn();
    stop = vi.fn();
    constructor(public options: { send(message: ClientSessionMessage): void }) {
      probes.push(this);
    }
  },
}));

const { startAgentSession } = await import("../session/agentSession.js");

const SESSION_TOKEN: SessionToken = {
  transport: "livekit",
  session_id: "sess-probe",
  expires_at: new Date(Date.now() + 120_000).toISOString(),
  max_duration_seconds: 600,
  livekit_url: "wss://example.livekit.cloud",
  token: "tok",
};

class MockTransport implements Transport {
  callbacks?: TransportCallbacks;
  sent: ClientSessionMessage[] = [];
  receiver = { getStats: async () => new Map() };

  async connect(_sessionToken: SessionToken, options: TransportConnectOptions): Promise<void> {
    this.callbacks = options.callbacks;
  }

  async disconnect(): Promise<void> {}

  async setMicEnabled(): Promise<void> {}

  async setInputDevice(): Promise<void> {}

  async sendClientEvent(message: ClientSessionMessage): Promise<void> {
    this.sent.push(message);
  }

  getVoiceReceiver(): RTCRtpReceiver | undefined {
    return this.receiver as unknown as RTCRtpReceiver;
  }
}

afterEach(() => {
  probes.length = 0;
});

describe("AgentSession playout probe", () => {
  it("feeds the probe the voice and microphone streams, sends through the transport, stops at the end", async () => {
    const transport = new MockTransport();
    const session = await startAgentSession({ sessionToken: SESSION_TOKEN, microphone: false }, () => transport);
    expect(probes).toHaveLength(1);
    const probe = probes[0]!;
    const voice = { id: "voice" } as unknown as MediaStream;
    transport.callbacks!.onOutputStream("TR_voice", voice, true);
    transport.callbacks!.onOutputStream("TR_bed", { id: "bed" } as unknown as MediaStream, false);
    expect(probe.setVoiceStream).toHaveBeenCalledTimes(1);
    expect(probe.setVoiceStream).toHaveBeenCalledWith(voice);
    const mic = { id: "mic" } as unknown as MediaStream;
    transport.callbacks!.onInputStream(mic);
    expect(probe.setInputStream).toHaveBeenCalledWith(mic);

    const heard = { type: "client.heard", at: 5, sinceSpeechEndMs: 480, outputLatencyMs: 0 } as const;
    probe.options.send(heard);
    await Promise.resolve();
    expect(transport.sent).toContainEqual(heard);
    expect(probe.options.getVoiceReceiver?.()).toBe(transport.receiver);

    await session.end();
    expect(probe.stop).toHaveBeenCalledTimes(1);
  });

  it("creates no probe when the option is off", async () => {
    const transport = new MockTransport();
    await startAgentSession(
      { sessionToken: SESSION_TOKEN, microphone: false, playoutProbe: false },
      () => transport,
    );
    expect(probes).toHaveLength(0);
    transport.callbacks!.onInputStream({ id: "mic" } as unknown as MediaStream);
    expect(transport.sent).toEqual([]);
  });
});
