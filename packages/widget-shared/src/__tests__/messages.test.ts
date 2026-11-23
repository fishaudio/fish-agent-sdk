import { describe, expect, it, vi } from "vitest";
import { TranscriptStore } from "../index.js";

type Handler = (payload: never) => void;

class FakeEmitter {
  handlers = new Map<string, Set<Handler>>();

  on(event: string, handler: Handler) {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler);
    return this;
  }

  off(event: string, handler: Handler) {
    this.handlers.get(event)?.delete(handler);
    return this;
  }

  emit(event: string, payload: unknown) {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(payload as never);
    }
  }
}

function attach() {
  const store = new TranscriptStore();
  const emitter = new FakeEmitter();
  const detach = store.attach(emitter as never);
  return { store, emitter, detach };
}

describe("TranscriptStore", () => {
  it("replaces streaming segments in place and keeps order", () => {
    const { store, emitter } = attach();
    emitter.emit("userTranscript", { segmentId: "s1", text: "hel", final: false });
    emitter.emit("agentResponseDelta", { segmentId: "a1", text: "Sure" });
    emitter.emit("userTranscript", { segmentId: "s1", text: "hello", final: true });
    emitter.emit("agentResponse", { segmentId: "a1", text: "Sure thing." });

    expect(store.entries).toEqual([
      { kind: "message", id: "1:u:s1", role: "user", text: "hello", final: true },
      { kind: "message", id: "1:a:a1", role: "agent", text: "Sure thing.", final: true },
    ]);
  });

  it("tracks tool calls by callId, merging terminal events over started ones", () => {
    const { store, emitter } = attach();
    emitter.emit("toolCallStarted", {
      callId: "tc1",
      toolName: "check_availability",
      source: "webhook",
      input: '{"day":"friday"}',
      inputTruncated: false,
    });
    emitter.emit("userTranscript", { segmentId: "s1", text: "ok", final: true });
    emitter.emit("toolCallCompleted", {
      callId: "tc1",
      toolName: "check_availability",
      source: "webhook",
      output: '{"slot":"14:30"}',
      outputTruncated: false,
    });

    expect(store.entries[0]).toMatchObject({
      kind: "tool",
      callId: "tc1",
      status: "done",
      input: '{"day":"friday"}',
      output: '{"slot":"14:30"}',
    });
    expect(store.entries[1]).toMatchObject({ kind: "message", text: "ok" });
  });

  it("marks failures and notifies subscribers exactly per change", () => {
    const { store, emitter } = attach();
    const listener = vi.fn();
    store.subscribe(listener);
    emitter.emit("toolCallFailed", {
      callId: "tc2",
      toolName: "book",
      source: "client",
      error: "boom",
    });
    expect(store.entries[0]).toMatchObject({ kind: "tool", status: "error", error: "boom" });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("keeps earlier sessions' entries when segment ids repeat across attaches", () => {
    const store = new TranscriptStore();
    const first = new FakeEmitter();
    const detachFirst = store.attach(first as never);
    first.emit("userTranscript", { segmentId: "typed_1", text: "Hello", final: true });
    detachFirst();

    const second = new FakeEmitter();
    store.attach(second as never);
    second.emit("userTranscript", { segmentId: "typed_1", text: "Second", final: true });

    expect(
      store.entries.map((entry) => (entry.kind === "message" ? entry.text : entry.id)),
    ).toEqual(["Hello", "Second"]);
  });

  it("still coalesces agent deltas within a session after re-attaching", () => {
    const store = new TranscriptStore();
    const first = new FakeEmitter();
    const detachFirst = store.attach(first as never);
    first.emit("agentResponse", { segmentId: "a1", text: "First call." });
    detachFirst();

    const second = new FakeEmitter();
    store.attach(second as never);
    second.emit("agentResponseDelta", { segmentId: "a1", text: "Sec" });
    second.emit("agentResponseDelta", { segmentId: "a1", text: "Second ca" });
    second.emit("agentResponse", { segmentId: "a1", text: "Second call." });

    expect(store.entries).toHaveLength(2);
    expect(store.entries[0]).toMatchObject({ kind: "message", text: "First call.", final: true });
    expect(store.entries[1]).toMatchObject({ kind: "message", text: "Second call.", final: true });
  });

  it("stops receiving after detach and clears on demand", () => {
    const { store, emitter, detach } = attach();
    emitter.emit("userTranscript", { segmentId: "s1", text: "hi", final: true });
    detach();
    emitter.emit("userTranscript", { segmentId: "s2", text: "gone", final: true });
    expect(store.entries).toHaveLength(1);
    store.clear();
    expect(store.entries).toHaveLength(0);
  });

  it("appends end-of-call dividers between sessions, skipping an empty log", () => {
    const store = new TranscriptStore();
    store.pushDivider("Call ended · 0:05");
    expect(store.entries).toEqual([]);

    const first = new FakeEmitter();
    store.attach(first as never);
    first.emit("userTranscript", { segmentId: "s1", text: "Hello", final: true });
    store.pushDivider("Call ended · 0:05");

    const second = new FakeEmitter();
    store.attach(second as never);
    second.emit("userTranscript", { segmentId: "s1", text: "Again", final: true });

    expect(
      store.entries.map((entry) => (entry.kind === "divider" ? entry.label : entry.kind)),
    ).toEqual(["message", "Call ended · 0:05", "message"]);
  });
});
