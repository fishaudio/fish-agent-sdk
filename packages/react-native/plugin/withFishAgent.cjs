// Expo config plugin for @fishaudio/agent-react-native.
//
// iOS: microphone usage text and the `audio` background mode, so a call keeps
// running when the app leaves the foreground.
// Android needs nothing here: the package's own AndroidManifest (merged at
// build time) declares the permissions and the microphone foreground service.
const { withInfoPlist } = require("expo/config-plugins");

const DEFAULT_MICROPHONE_TEXT = "Allow $(PRODUCT_NAME) to use the microphone for voice calls.";

/**
 * @param {import('expo/config').ExpoConfig} config
 * @param {{ microphonePermission?: string | false, backgroundAudio?: boolean }} [options]
 */
function withFishAgent(config, options = {}) {
  const { microphonePermission, backgroundAudio = true } = options;
  return withInfoPlist(config, (mod) => {
    const plist = mod.modResults;
    if (microphonePermission !== false) {
      plist.NSMicrophoneUsageDescription =
        microphonePermission ?? plist.NSMicrophoneUsageDescription ?? DEFAULT_MICROPHONE_TEXT;
    }
    if (backgroundAudio) {
      const modes = new Set(plist.UIBackgroundModes ?? []);
      modes.add("audio");
      plist.UIBackgroundModes = [...modes];
    }
    return mod;
  });
}

module.exports = withFishAgent;
