// Dev-only harness: mounts the app on fakes. Open /src/app/harness.html on the dev server.
//   ?registry=real          the real LanguageRegistry (the engine stays fake)
//   ?deps=none|project|all  which explorer deps to pass (default all: project + views + history)
//   ?load=gen&n=2000        preload a synthetic project pair with n items
//   ?load=fixture           preload fixtures/project-{a,b}.xml (run `pnpm fixtures` first)
import { createApp } from './index';
import { createFakeEngine, createFakeRegistry } from './dev/fakes';
import { createFakeProjectIndexer, genProject } from './dev/fake-project';
import { createLanguageRegistry } from '../languages';
import type { AppDeps } from '../types';

const root = document.getElementById('app');
if (!root) throw new Error('#app missing');
const params = new URLSearchParams(location.search);
const engine = createFakeEngine();
const registry = params.get('registry') === 'real' ? createLanguageRegistry() : createFakeRegistry();
const project = createFakeProjectIndexer();
const deps = params.get('deps') ?? 'all';
const appDeps: AppDeps = { root, engine, registry };
if (deps !== 'none') appDeps.project = project;
if (deps === 'all') {
  appDeps.views = engine;
  appDeps.history = engine;
}
window.__sidediff = { engine, registry, ...(appDeps.project ? { project } : {}) };
Object.assign(window, { __fakeEngine: engine, __fakeProject: project, __genProject: genProject });
createApp(appDeps);

async function preload(): Promise<void> {
  const load = params.get('load');
  if (!load) return;
  await new Promise((r) => setTimeout(r, 50));
  let pair: { a: string; b: string };
  if (load === 'fixture') {
    const [a, b] = await Promise.all(['a', 'b'].map((s) => fetch(`/fixtures/project-${s}.xml`).then((r) => r.text())));
    pair = { a: a ?? '', b: b ?? '' };
  } else pair = genProject(Number(params.get('n') ?? 2000));
  engine.setText('a', pair.a);
  engine.setText('b', pair.b);
}
void preload();
