// Public surface. Everything exported here is a long-term commitment (apps ship
// with a fixed SDK version), so keep it to what an app needs; internals such as
// the call service and audio routing helpers stay behind useConversation.
export { setupFishAgent } from "./setup.js";
export {
  useConversation,
  type MobileConversationOptions,
  type UseConversationReturn,
} from "./useConversation.js";
export type { AudioOutputRoute } from "./audio.js";
export type { CallNotification } from "./callService.js";
// The platform-neutral pieces are the React SDK's, re-exported so app code
// stays on one import. Left out: AgentAudioVisualizer (draws on a DOM canvas)
// and useAudioLevels (React Native has no audio levels yet).
export {
  AgentSessionProvider,
  useAgentSessionContext,
  useOptionalAgentSessionContext,
  useAgentMessages,
  type AgentSessionProviderProps,
  type ChatMessage,
  type ConversationStatus,
} from "@fishaudio/agent-react";
// AgentSession is exported as a type only: starting one directly would skip the
// permission, audio session and call service that useConversation manages. A
// type alias (not `export { type AgentSession }`) keeps it type-only in the
// bundled .d.ts, where re-export modifiers are merged away.
import type { AgentSession as ClientAgentSession } from "@fishaudio/agent-client";
export type AgentSession = ClientAgentSession;
export {
  FishAgentError,
  type AgentMode,
  type AgentSessionOptions,
  type ConversationMessage,
  type EndReason,
  type FishAgentErrorCode,
  type SessionStatus,
  type SessionToken,
  type TranscriptSegment,
} from "@fishaudio/agent-client";
