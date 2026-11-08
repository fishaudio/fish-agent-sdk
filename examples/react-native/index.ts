// registerGlobals must run before livekit-client is used anywhere: it installs
// WebRTC, TextEncoder/TextDecoder and ReadableStream on the RN global.
import { registerGlobals } from '@livekit/react-native';
registerGlobals();

import { registerRootComponent } from 'expo';
import App from './App';

registerRootComponent(App);
