import { FishAgentError } from "../errors.js";

/** Throws `device_change_failed` where the browser cannot route audio output (`setSinkId`). */
export function assertOutputSelectionSupported(): void {
  if (typeof HTMLMediaElement === "undefined" || !("setSinkId" in HTMLMediaElement.prototype)) {
    throw new FishAgentError(
      "device_change_failed",
      "This browser does not support selecting an audio output device",
    );
  }
}

/**
 * Agent audio playback, one detached <audio> element per remote track (browser
 * only; inert elsewhere). The agent may publish speech and background ambience
 * as separate tracks, so a later track must never replace an earlier one.
 */
export class AudioOutput {
  private readonly elements = new Map<string, HTMLAudioElement>();
  /** Created by setSinkId() before any audio arrives; the first track adopts it. */
  private spare?: HTMLAudioElement;
  private volume = 1;
  private sinkId?: string;

  private createElement(): HTMLAudioElement | undefined {
    if (typeof document === "undefined") {
      return undefined;
    }
    const element = document.createElement("audio");
    element.autoplay = true;
    // Same-effect attribute as playsInline for iOS Safari without DOM typings noise.
    element.setAttribute("playsinline", "");
    element.volume = this.volume;
    if (this.sinkId !== undefined) {
      // Validated when it was chosen; a device lost since then keeps the default route.
      void element.setSinkId(this.sinkId).catch(() => {});
    }
    return element;
  }

  private allElements(): HTMLAudioElement[] {
    const all = [...this.elements.values()];
    if (this.spare) {
      all.push(this.spare);
    }
    return all;
  }

  setStream(id: string, stream: MediaStream): void {
    let element = this.elements.get(id);
    if (!element) {
      element = this.spare ?? this.createElement();
      this.spare = undefined;
      if (!element) {
        return;
      }
      this.elements.set(id, element);
    }
    element.srcObject = stream;
    void element.play().catch(() => {
      // Autoplay policy: playback stays pending until startAudio() runs in a user gesture.
    });
  }

  removeStream(id: string): void {
    const element = this.elements.get(id);
    if (element) {
      element.srcObject = null;
      element.remove();
      this.elements.delete(id);
    }
  }

  /** Call from a user gesture to satisfy browser autoplay policies. */
  async startAudio(): Promise<void> {
    await Promise.all([...this.elements.values()].map((element) => element.play()));
  }

  /**
   * Route playback to an output device. An element is created on demand so
   * the browser validates the device id right here, even before the agent's
   * audio arrives. Rejects with `device_change_failed` where output selection
   * is unsupported or the device cannot be used.
   */
  async setSinkId(sinkId: string): Promise<void> {
    assertOutputSelectionSupported();
    if (this.elements.size === 0) {
      this.spare ??= this.createElement();
    }
    try {
      await Promise.all(this.allElements().map((element) => element.setSinkId(sinkId)));
    } catch (error) {
      throw new FishAgentError(
        "device_change_failed",
        "Could not switch to the requested audio output device",
        { cause: error },
      );
    }
    this.sinkId = sinkId;
  }

  setVolume(volume: number): void {
    this.volume = Math.min(1, Math.max(0, volume));
    for (const element of this.allElements()) {
      element.volume = this.volume;
    }
  }

  getVolume(): number {
    return this.volume;
  }

  dispose(): void {
    for (const element of this.allElements()) {
      element.srcObject = null;
      element.remove();
    }
    this.elements.clear();
    this.spare = undefined;
  }
}
