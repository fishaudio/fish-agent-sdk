export { setupFishAgent } from "./setup.js";
export {
  useConversation,
  type MobileConversationOptions,
  type UseConversationReturn,
} from "./useConversation.js";
export { applyAudioOutput, type AudioOutputRoute } from "./audio.js";
export { requestMicrophonePermission } from "./permissions.js";
export { startCallService, stopCallService, type CallNotification } from "./callService.js";
// The platform-neutral pieces are the React SDK's, re-exported so app code
// stays on one import. (AgentAudioVisualizer draws on a DOM canvas and is left out.)
export {
  AgentSessionProvider,
  useAgentSessionContext,
  useOptionalAgentSessionContext,
  useAgentMessages,
  useAudioLevels,
  type AgentSessionProviderProps,
  type ChatMessage,
  type AudioLevels,
  type ConversationStatus,
} from "@fishaudio/agent-react";
export {
  AgentSession,
  FishAgentError,
  type AgentMode,
  type AgentSessionOptions,
  type ConversationMessage,
  type EndReason,
  type SessionStatus,
  type SessionToken,
  type TranscriptSegment,
} from "@fishaudio/agent-client";
