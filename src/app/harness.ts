// Dev-only harness: mounts the app on fakes. Open /src/app/harness.html on the dev server.
// `?registry=real` swaps in the real LanguageRegistry (the engine stays fake).
import { createApp } from './index';
import { createFakeEngine, createFakeRegistry } from './dev/fakes';
import { createLanguageRegistry } from '../languages';

const root = document.getElementById('app');
if (!root) throw new Error('#app missing');
const engine = createFakeEngine();
const registry = new URLSearchParams(location.search).get('registry') === 'real' ? createLanguageRegistry() : createFakeRegistry();
window.__sidediff = { engine, registry };
(window as unknown as { __fakeEngine: typeof engine }).__fakeEngine = engine;
createApp({ root, engine, registry });
