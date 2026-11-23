import { createContext, useContext } from "react";

/**
 * Widget colors and sizes, the React Native counterpart of the web widget's
 * `--fish-*` CSS custom properties. Pass any subset as the `theme` prop.
 */
export interface WidgetTheme {
  accent: string;
  accentText: string;
  orbColor1: string;
  orbColor2: string;
  background: string;
  text: string;
  textSecondary: string;
  border: string;
  bubbleAgentBackground: string;
  bubbleAgentText: string;
  bubbleUserBackground: string;
  bubbleUserText: string;
  danger: string;
  live: string;
  /** Panel corner radius (the card, not the full-screen sheet). */
  radius: number;
  fabSize: number;
  /** Distance from the screen edges, added to the safe-area insets. */
  offset: number;
}

export const LIGHT_THEME: WidgetTheme = {
  accent: "#0f0e0d",
  accentText: "#ffffff",
  orbColor1: "#7cc4ff",
  orbColor2: "#0a3f8f",
  background: "#ffffff",
  text: "#141414",
  textSecondary: "#8a8a86",
  border: "#ebeae8",
  bubbleAgentBackground: "#0f0e0d",
  bubbleAgentText: "#ffffff",
  bubbleUserBackground: "#f4f3f1",
  bubbleUserText: "#141414",
  danger: "#e5484d",
  live: "#30a46c",
  radius: 20,
  fabSize: 60,
  offset: 20,
};

export const DARK_THEME: WidgetTheme = {
  ...LIGHT_THEME,
  accent: "#f4f3f1",
  accentText: "#0f0e0d",
  background: "#1a1918",
  text: "#f4f3f1",
  textSecondary: "#9a9994",
  border: "#2e2d2b",
  bubbleAgentBackground: "#f4f3f1",
  bubbleAgentText: "#0f0e0d",
  bubbleUserBackground: "#2a2927",
  bubbleUserText: "#f4f3f1",
};

export const ThemeContext = createContext<WidgetTheme>(LIGHT_THEME);

export function useTheme(): WidgetTheme {
  return useContext(ThemeContext);
}
