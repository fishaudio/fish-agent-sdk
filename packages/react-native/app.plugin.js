// Expo resolves the plugin by this exact file name; the package is ESM, so the
// CommonJS implementation is loaded through createRequire.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export default require("./plugin/withFishAgent.cjs");
