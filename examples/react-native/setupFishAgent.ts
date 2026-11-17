// Imported first by index.ts, so it runs before any app module: it installs
// WebRTC, TextEncoder/TextDecoder and ReadableStream on the RN global.
import { setupFishAgent } from '@fishaudio/agent-react-native';
setupFishAgent();
