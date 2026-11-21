// Must come first: imports run before this file's body, so the setup lives in
// its own module.
import './setupFishAgent';
import { registerRootComponent } from 'expo';
import App from './App';

registerRootComponent(App);
