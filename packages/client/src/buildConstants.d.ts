// Build-time constants. tsup `define` (mirrored in vitest.config.ts) replaces
// them with values read from package.json, so they cannot drift from a release.
declare const __SDK_VERSION__: string;
