import type { AgentSessionOptions } from "@fishaudio/agent-client";
import {
  useConversation as useWebConversation,
  type UseConversationReturn as WebConversationReturn,
} from "@fishaudio/agent-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { applyAudioOutput, startCallAudio, stopCallAudio, type AudioOutputRoute } from "./audio.js";
import { startCallService, stopCallService, type CallNotification } from "./callService.js";
import { requestMicrophonePermission } from "./permissions.js";
import { hasWebRTCGlobals, setupFishAgent } from "./setup.js";

function startCancelledError(): Error {
  // Same error as @fishaudio/agent-react's hook throws for a start cut short by endSession.
  const error = new Error("Conversation start was cancelled by endSession");
  error.name = "AbortError";
  return error;
}

export interface MobileConversationOptions {
  /** Initial audio route. Default `auto`: headsets first, else the loudspeaker. */
  audioOutput?: AudioOutputRoute;
  /**
   * Android: the ongoing notification shown while a call runs, required to keep
   * the microphone when the app is backgrounded. `false` skips the foreground
   * service, and background capture with it.
   */
  callNotification?: CallNotification | false;
}

/**
 * Browser-only members of the web hook: autoplay unlocking and device IDs or
 * an output volume on media elements, none of which exist in React Native.
 */
type BrowserOnly = "startAudio" | "setOutputVolume" | "setInputDevice" | "setOutputDevice";

export interface UseConversationReturn extends Omit<WebConversationReturn, BrowserOnly> {
  audioOutput: AudioOutputRoute;
  setAudioOutput: (route: AudioOutputRoute) => Promise<void>;
}

/**
 * The `@fishaudio/agent-react` conversation hook plus what a phone needs around
 * a call: the microphone permission (Android), the platform audio session,
 * audio routing, and the Android foreground service for background calls.
 * All of it starts with `startSession` and is released when the call ends.
 */
export function useConversation(
  defaults: Partial<AgentSessionOptions> = {},
  options: MobileConversationOptions = {},
): UseConversationReturn {
  const web = useWebConversation(defaults);
  const defaultsRef = useRef(defaults);
  defaultsRef.current = defaults;
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const [audioOutput, setAudioOutputState] = useState<AudioOutputRoute>(
    options.audioOutput ?? "auto",
  );
  const routeRef = useRef(audioOutput);
  /** Bumped by endSession and unmount: a start begun under an older value is cancelled. */
  const generationRef = useRef(0);
  /**
   * The generation whose start holds the audio session and call service, or
   * null when nothing is held. Tracking the owner, not just a flag, keeps a
   * cancelled start from releasing what the next call has already claimed.
   */
  const platformOwnerRef = useRef<number | null>(null);

  const releasePlatform = useCallback(async () => {
    if (platformOwnerRef.current === null) {
      return;
    }
    platformOwnerRef.current = null;
    stopCallService();
    await stopCallAudio().catch(() => undefined);
  }, []);

  const { startSession: webStart, endSession: webEnd, status } = web;

  const startSession = useCallback(
    async (overrides: Partial<AgentSessionOptions> = {}): Promise<string> => {
      const generation = generationRef.current;
      const cancelled = () => generation !== generationRef.current;
      // Without the globals the connect fails with a bare connection_failed.
      if (!hasWebRTCGlobals()) {
        setupFishAgent();
      }
      const microphone = { ...defaultsRef.current, ...overrides }.microphone !== false;
      if (microphone) {
        await requestMicrophonePermission();
        if (cancelled()) {
          throw startCancelledError();
        }
      }
      if (platformOwnerRef.current === null) {
        // Claimed before the await so a double tap starts the platform once.
        platformOwnerRef.current = generation;
        try {
          await startCallAudio(routeRef.current);
        } catch (error) {
          if (platformOwnerRef.current === generation) {
            platformOwnerRef.current = null;
          }
          throw error;
        }
        if (cancelled()) {
          // endSession ran during the await and released what it saw; the audio
          // session may have come up after that. Undo it unless a newer call
          // has claimed the platform since.
          if (platformOwnerRef.current === generation || platformOwnerRef.current === null) {
            platformOwnerRef.current = null;
            await stopCallAudio().catch(() => undefined);
          }
          throw startCancelledError();
        }
        const notification = optionsRef.current.callNotification;
        if (microphone && notification !== false) {
          startCallService(notification ?? {});
        }
      }
      try {
        return await webStart(overrides);
      } catch (error) {
        // Only what this start still holds: after a hangup and a quick redial
        // the platform may already belong to the next call.
        if (platformOwnerRef.current === generation) {
          await releasePlatform();
        }
        throw error;
      }
    },
    [webStart, releasePlatform],
  );

  const endSession = useCallback(async () => {
    generationRef.current += 1;
    try {
      await webEnd();
    } finally {
      await releasePlatform();
    }
  }, [webEnd, releasePlatform]);

  // A call can also end from the other side or the network.
  useEffect(() => {
    if (status === "ended") {
      void releasePlatform();
    }
  }, [status, releasePlatform]);

  useEffect(
    () => () => {
      generationRef.current += 1;
      void releasePlatform();
    },
    [releasePlatform],
  );

  const setAudioOutput = useCallback(async (route: AudioOutputRoute) => {
    routeRef.current = route;
    setAudioOutputState(route);
    if (platformOwnerRef.current !== null) {
      await applyAudioOutput(route);
    }
  }, []);

  const {
    startAudio: _startAudio,
    setOutputVolume: _setOutputVolume,
    setInputDevice: _setInputDevice,
    setOutputDevice: _setOutputDevice,
    ...shared
  } = web;
  return { ...shared, startSession, endSession, audioOutput, setAudioOutput };
}
