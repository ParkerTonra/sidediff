// Dev-only harness: mounts the app on fakes. Open /src/app/harness.html on the dev server.
import { createApp } from './index';
import { createFakeEngine, createFakeRegistry } from './dev/fakes';

const root = document.getElementById('app');
if (!root) throw new Error('#app missing');
const engine = createFakeEngine();
const registry = createFakeRegistry();
window.__sidediff = { engine, registry };
(window as unknown as { __fakeEngine: typeof engine }).__fakeEngine = engine;
createApp({ root, engine, registry });
