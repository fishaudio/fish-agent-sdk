// Internal: logic shared by @fishaudio/agent-widget (web) and
// @fishaudio/agent-widget-react-native. Never published; each widget bundles
// it into its own dist, so nothing here is public API.
export * from "./settings.js";
export * from "./messages.js";
export { fetchRemoteConfig } from "./remoteConfig.js";
export { errorText, formatTimer, formatToolPayload } from "./format.js";
