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

export interface UseConversationReturn extends WebConversationReturn {
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
  /** The audio session and call service are up for the current call. */
  const platformActiveRef = useRef(false);

  const releasePlatform = useCallback(async () => {
    if (!platformActiveRef.current) {
      return;
    }
    platformActiveRef.current = false;
    stopCallService();
    await stopCallAudio().catch(() => undefined);
  }, []);

  const { startSession: webStart, endSession: webEnd, status } = web;

  const startSession = useCallback(
    async (overrides: Partial<AgentSessionOptions> = {}): Promise<string> => {
      // Without the globals the connect fails with a bare connection_failed.
      if (!hasWebRTCGlobals()) {
        setupFishAgent();
      }
      const microphone = { ...defaultsRef.current, ...overrides }.microphone !== false;
      if (microphone) {
        await requestMicrophonePermission();
      }
      if (!platformActiveRef.current) {
        // Claimed before the await so a double tap starts the platform once.
        platformActiveRef.current = true;
        try {
          await startCallAudio(routeRef.current);
        } catch (error) {
          platformActiveRef.current = false;
          throw error;
        }
        const notification = optionsRef.current.callNotification;
        if (microphone && notification !== false) {
          startCallService(notification ?? {});
        }
      }
      try {
        return await webStart(overrides);
      } catch (error) {
        await releasePlatform();
        throw error;
      }
    },
    [webStart, releasePlatform],
  );

  const endSession = useCallback(async () => {
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
      void releasePlatform();
    },
    [releasePlatform],
  );

  const setAudioOutput = useCallback(async (route: AudioOutputRoute) => {
    routeRef.current = route;
    setAudioOutputState(route);
    if (platformActiveRef.current) {
      await applyAudioOutput(route);
    }
  }, []);

  return { ...web, startSession, endSession, audioOutput, setAudioOutput };
}
