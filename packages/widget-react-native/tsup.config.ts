import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm", "cjs"],
  // The shared widget logic is an internal, unpublished package: inline it
  // (code and types) so the published dist never imports it.
  dts: { resolve: ["@fishaudio/agent-widget-shared"] },
  sourcemap: true,
  clean: true,
  external: ["react", "react-native", "react-native-svg"],
  noExternal: ["@fishaudio/agent-widget-shared"],
});
