// Public surface. Everything exported here is a long-term commitment (apps ship
// with a fixed SDK version): the component, its props and the theme shape.
export {
  FishAgentWidget,
  type ConsentStorage,
  type FishAgentWidgetErrorDetail,
  type FishAgentWidgetHandle,
  type FishAgentWidgetProps,
  type WidgetInsets,
} from "./widget.js";
export type { WidgetTheme } from "./theme.js";
export { DEFAULT_TEXTS } from "./texts.js";
export type {
  SessionTokenProvider,
  WidgetPosition,
  WidgetTextContents,
} from "@fishaudio/agent-widget-shared";
