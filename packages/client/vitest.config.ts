import { defineConfig } from "vitest/config";
import pkg from "./package.json";

export default defineConfig({
  // Mirrors the tsup define so tests run against the real version.
  define: { __SDK_VERSION__: JSON.stringify(pkg.version) },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
