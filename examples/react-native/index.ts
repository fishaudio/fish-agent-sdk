// Must run before livekit-client is used anywhere: it installs WebRTC,
// TextEncoder/TextDecoder and ReadableStream on the RN global.
import { setupFishAgent } from '@fishaudio/agent-react-native';
setupFishAgent();

import { registerRootComponent } from 'expo';
import App from './App';

registerRootComponent(App);
