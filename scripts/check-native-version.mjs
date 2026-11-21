// Checks that the native SDKs carry the same version as the JavaScript
// packages, and that the generated Swift constant is up to date.
//
// All packages are released together under one version number. The native
// SDKs follow through marker packages (ios/package.json, android/package.json)
// that changesets bumps with the rest. This fails when a marker was edited by
// hand, or when Version.swift was not regenerated after a bump.
//
// Run from the repo root: `node scripts/check-native-version.mjs`.
import { readFileSync } from "node:fs";
import { versionSwift } from "./sync-native-version.mjs";

const root = new URL("..", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const versionOf = (path) => JSON.parse(read(path)).version;

const reference = versionOf("packages/client/package.json");
const problems = [];

for (const marker of ["ios/package.json", "android/package.json"]) {
  const version = versionOf(marker);
  if (version !== reference) {
    problems.push(`${marker} is at ${version}, but @fishaudio/agent-client is at ${reference}`);
  }
}

if (read("ios/Sources/FishAgent/Version.swift") !== versionSwift(versionOf("ios/package.json"))) {
  problems.push(
    "ios/Sources/FishAgent/Version.swift is out of date; run `node scripts/sync-native-version.mjs`",
  );
}

if (problems.length > 0) {
  console.error(problems.map((problem) => `✗ ${problem}`).join("\n"));
  process.exit(1);
}
console.log(`✓ native SDK versions match ${reference}`);
