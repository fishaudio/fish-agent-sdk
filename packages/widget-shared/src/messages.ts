import type { AgentSession } from "@fishaudio/agent-client";

export interface SpeechEntry {
  kind: "message";
  id: string;
  role: "user" | "agent";
  text: string;
  final: boolean;
}

export interface ToolEntry {
  kind: "tool";
  id: string;
  callId: string;
  toolName: string;
  source: string;
  status: "running" | "done" | "error";
  input?: string;
  inputTruncated?: boolean;
  output?: string;
  outputTruncated?: boolean;
  error?: string;
}

/** Inline marker between calls in one continuous transcript (e.g. "Call ended · 3:24"). */
export interface DividerEntry {
  kind: "divider";
  id: string;
  label: string;
}

export type TranscriptEntry = SpeechEntry | ToolEntry | DividerEntry;

type SessionEvents = Pick<AgentSession, "on" | "off">;

/**
 * Orders the session's streams into one chat log: transcript segments stream
 * in place (same id ⇒ replace), tool calls appear as chip entries updated by
 * callId. Pure aggregation — no DOM, unit-testable.
 */
export class TranscriptStore {
  #entries: TranscriptEntry[] = [];
  readonly #listeners = new Set<() => void>();
  #generation = 0;
  #dividerCount = 0;

  get entries(): readonly TranscriptEntry[] {
    return this.#entries;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  clear(): void {
    if (this.#entries.length > 0) {
      this.#entries = [];
      this.#emit();
    }
  }

  /** Append an end-of-call divider (no-op on an empty transcript). */
  pushDivider(label: string): void {
    if (this.#entries.length === 0) {
      return;
    }
    const id = `divider:${++this.#dividerCount}`;
    this.#upsert(id, { kind: "divider", id, label });
  }

  /** Wire a live session; returns the detach function. */
  attach(session: SessionEvents): () => void {
    // Segment/call ids are session-local (e.g. "typed_1" restarts per session);
    // namespace them per attach so a new call appends instead of overwriting.
    const generation = ++this.#generation;
    const scoped = (id: string) => `${generation}:${id}`;
    const onUserTranscript = ({
      segmentId,
      text,
      final,
    }: {
      segmentId: string;
      text: string;
      final: boolean;
    }) => this.#upsertSpeech(scoped(`u:${segmentId}`), "user", text, final);
    const onAgentDelta = ({ segmentId, text }: { segmentId: string; text: string }) =>
      this.#upsertSpeech(scoped(`a:${segmentId}`), "agent", text, false);
    const onAgentResponse = ({ segmentId, text }: { segmentId: string; text: string }) =>
      this.#upsertSpeech(scoped(`a:${segmentId}`), "agent", text, true);
    const onToolStarted = (event: {
      callId: string;
      toolName: string;
      source: string;
      input: string;
      inputTruncated: boolean;
    }) =>
      this.#upsertTool({
        kind: "tool",
        id: scoped(`t:${event.callId}`),
        callId: event.callId,
        toolName: event.toolName,
        source: event.source,
        status: "running",
        input: event.input,
        inputTruncated: event.inputTruncated,
      });
    const onToolCompleted = (event: {
      callId: string;
      toolName: string;
      source: string;
      output: string;
      outputTruncated: boolean;
    }) =>
      this.#upsertTool({
        kind: "tool",
        id: scoped(`t:${event.callId}`),
        callId: event.callId,
        toolName: event.toolName,
        source: event.source,
        status: "done",
        output: event.output,
        outputTruncated: event.outputTruncated,
      });
    const onToolFailed = (event: {
      callId: string;
      toolName: string;
      source: string;
      error: string;
    }) =>
      this.#upsertTool({
        kind: "tool",
        id: scoped(`t:${event.callId}`),
        callId: event.callId,
        toolName: event.toolName,
        source: event.source,
        status: "error",
        error: event.error,
      });

    session.on("userTranscript", onUserTranscript);
    session.on("agentResponseDelta", onAgentDelta);
    session.on("agentResponse", onAgentResponse);
    session.on("toolCallStarted", onToolStarted);
    session.on("toolCallCompleted", onToolCompleted);
    session.on("toolCallFailed", onToolFailed);
    return () => {
      session.off("userTranscript", onUserTranscript);
      session.off("agentResponseDelta", onAgentDelta);
      session.off("agentResponse", onAgentResponse);
      session.off("toolCallStarted", onToolStarted);
      session.off("toolCallCompleted", onToolCompleted);
      session.off("toolCallFailed", onToolFailed);
    };
  }

  #upsertSpeech(id: string, role: "user" | "agent", text: string, final: boolean): void {
    const entry: SpeechEntry = { kind: "message", id, role, text, final };
    this.#upsert(id, entry);
  }

  #upsertTool(entry: ToolEntry): void {
    // A terminal event repeats name/source but not input; keep what we have.
    // Match by scoped id so a reused callId never merges across sessions.
    const existing = this.#entries.find(
      (candidate): candidate is ToolEntry => candidate.kind === "tool" && candidate.id === entry.id,
    );
    this.#upsert(entry.id, existing ? { ...existing, ...entry } : entry);
  }

  #upsert(id: string, entry: TranscriptEntry): void {
    const index = this.#entries.findIndex((candidate) => candidate.id === id);
    const next = [...this.#entries];
    if (index === -1) {
      next.push(entry);
    } else {
      next[index] = entry;
    }
    this.#entries = next;
    this.#emit();
  }

  #emit(): void {
    for (const listener of this.#listeners) {
      listener();
    }
  }
}
