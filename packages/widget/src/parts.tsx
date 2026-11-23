import type { AgentMode, AgentSession } from "@fishaudio/agent-client";
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { WidgetTextContents } from "./config.js";
import { IconChevronDown, IconSend } from "./icons.js";
import { formatToolPayload, type ToolEntry, type TranscriptEntry } from "@fishaudio/agent-widget-shared";

function reducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

interface OrbProps {
  size: number;
  mode?: AgentMode;
  /** Drives the speaking glow from live output volume; omit for a static orb. */
  session?: AgentSession | null;
}

export function Orb({ size, mode, session }: OrbProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element || !session || mode !== "speaking" || reducedMotion()) {
      return;
    }
    let frame = 0;
    const loop = () => {
      element.style.setProperty("--fa-orb-glow", session.getOutputVolume().toFixed(3));
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(frame);
      element.style.removeProperty("--fa-orb-glow");
    };
  }, [session, mode]);

  return (
    <div
      ref={ref}
      class="fa-orb"
      data-mode={mode}
      style={`width:${size}px;height:${size}px`}
      aria-hidden="true"
    />
  );
}

interface WaveformProps {
  session: AgentSession | null;
  bars?: number;
  barWidth?: number;
  gap?: number;
  height?: number;
  class?: string;
}

/** Idle waveform silhouette (bar heights out of 22). */
const IDLE_LEVELS = [6, 10, 16, 22, 18, 12, 8, 14, 20, 16, 10, 6, 12, 18, 10, 6].map((h) => h / 22);

/** Canvas bars fed by `getOutputFrequencyData()`; static bars under reduced motion. */
export function Waveform({
  session,
  bars = 16,
  barWidth = 3,
  gap = 3,
  height = 22,
  class: className,
}: WaveformProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const width = bars * (barWidth + gap) - gap;

  useEffect(() => {
    const canvas = ref.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) {
      return;
    }
    const scale = typeof devicePixelRatio === "number" ? devicePixelRatio : 1;
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    context.scale(scale, scale);
    const color = getComputedStyle(canvas).color || "#0f0e0d";

    const draw = (levels: number[]) => {
      context.clearRect(0, 0, width, height);
      context.fillStyle = color;
      levels.forEach((level, index) => {
        const barHeight = Math.max(3, level * height);
        const x = index * (barWidth + gap);
        const y = (height - barHeight) / 2;
        if (typeof context.roundRect === "function") {
          context.beginPath();
          context.roundRect(x, y, barWidth, barHeight, barWidth / 2);
          context.fill();
        } else {
          context.fillRect(x, y, barWidth, barHeight);
        }
      });
    };

    if (!session || reducedMotion()) {
      draw(Array.from({ length: bars }, (_, index) => IDLE_LEVELS[index % IDLE_LEVELS.length]!));
      return;
    }

    let frame = 0;
    const loop = () => {
      const data = session.getOutputFrequencyData();
      const step = Math.max(1, Math.floor(data.length / bars));
      draw(
        Array.from({ length: bars }, (_, index) => (data[Math.min(index * step, data.length - 1)] ?? 0) / 255),
      );
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [session, bars, barWidth, gap, height, width]);

  return (
    <canvas
      ref={ref}
      class={`fa-wave${className ? ` ${className}` : ""}`}
      style={`width:${width}px;height:${height}px`}
      aria-hidden="true"
    />
  );
}

function ToolChip({ entry, texts }: { entry: ToolEntry; texts: WidgetTextContents }) {
  const [expanded, setExpanded] = useState(false);
  const statusLabel =
    entry.status === "running"
      ? texts.toolRunning
      : entry.status === "done"
        ? texts.toolDone
        : texts.toolFailed;
  return (
    <div class="fa-tool">
      <button
        type="button"
        class="fa-tool-chip"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span class={`fa-tool-dot fa-tool-dot--${entry.status}`} aria-hidden="true" />
        <span class="fa-tool-name">{entry.toolName}</span>
        <span class="fa-tool-chevron">
          <IconChevronDown size={12} />
        </span>
        <span class="fa-visually-hidden">{statusLabel}</span>
      </button>
      {expanded ? (
        <div class="fa-tool-detail">
          {entry.input !== undefined ? (
            <div>
              <div class="fa-tool-detail-label">input</div>
              {formatToolPayload(entry.input, entry.inputTruncated)}
            </div>
          ) : null}
          {entry.output !== undefined ? (
            <div>
              <div class="fa-tool-detail-label">output</div>
              {formatToolPayload(entry.output, entry.outputTruncated)}
            </div>
          ) : null}
          {entry.error !== undefined ? (
            <div>
              <div class="fa-tool-detail-label">error</div>
              {entry.error}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function Transcript({
  entries,
  texts,
}: {
  entries: readonly TranscriptEntry[];
  texts: WidgetTextContents;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (element) {
      element.scrollTop = element.scrollHeight;
    }
  }, [entries]);

  return (
    <div ref={ref} class="fa-transcript" role="log" aria-live="polite">
      {entries.map((entry) =>
        entry.kind === "message" ? (
          <div key={entry.id} class={`fa-bubble fa-bubble--${entry.role}`}>
            {entry.text}
          </div>
        ) : entry.kind === "divider" ? (
          <div key={entry.id} class="fa-divider" role="separator">
            <span>{entry.label}</span>
          </div>
        ) : (
          <ToolChip key={entry.id} entry={entry} texts={texts} />
        ),
      )}
    </div>
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
  const [value, setValue] = useState("");

  const submit = (event: JSX.TargetedEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = value.trim();
    if (!text || disabled) {
      return;
    }
    setValue("");
    onSend(text);
  };

  return (
    <form class={`fa-composer${divided ? " fa-composer--divided" : ""}`} onSubmit={submit}>
      <input
        class="fa-input"
        type="text"
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onInput={(event) => {
          setValue(event.currentTarget.value);
          onActivity?.();
        }}
      />
      <button type="submit" class="fa-send" aria-label={sendLabel} disabled={disabled || !value.trim()}>
        <IconSend size={16} />
      </button>
    </form>
  );
}
