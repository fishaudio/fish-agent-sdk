import { defineConfig } from "tsup";
import pkg from "./package.json";

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  // Keep in sync with vitest.config.ts, declared in src/buildConstants.d.ts.
  define: { __SDK_VERSION__: JSON.stringify(pkg.version) },
});
