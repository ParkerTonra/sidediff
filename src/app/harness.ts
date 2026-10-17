// Dev-only harness: mounts the app on fakes. Open /src/app/harness.html on the dev server.
//   ?registry=real                the real LanguageRegistry (the engine stays fake)
//   ?deps=none|project|p4|all     explorer deps to pass (default all: project, views, history, packages, assemblies;
//                                 p4 = Phase 4 deps only, without packages and assemblies)
//   ?load=gen&n=2000              preload a synthetic project pair with n items
//   ?load=fixture                 preload fixtures/project-{a,b}.xml (run `pnpm fixtures` first)
//   ?load=pkg | pkg2              open the synthetic package (pkg2: A and B) through the file inputs
import { createApp } from './index';
import { createFakeEngine, createFakeRegistry } from './dev/fakes';
import { createFakeProjectIndexer, genProject } from './dev/fake-project';
import { createFakeAssemblyBrowser, createFakePackageReader, fakeZipBlob } from './dev/fake-package';
import { createLanguageRegistry } from '../languages';
import type { AppDeps } from '../types';

const root = document.getElementById('app');
if (!root) throw new Error('#app missing');
const params = new URLSearchParams(location.search);
const engine = createFakeEngine();
const registry = params.get('registry') === 'real' ? createLanguageRegistry() : createFakeRegistry();
const project = createFakeProjectIndexer();
const packages = createFakePackageReader();
const assemblies = createFakeAssemblyBrowser();
const deps = params.get('deps') ?? 'all';
const appDeps: AppDeps = { root, engine, registry };
if (deps !== 'none') appDeps.project = project;
if (deps === 'all' || deps === 'p4') {
  appDeps.views = engine;
  appDeps.history = engine;
}
if (deps === 'all') {
  appDeps.packages = packages;
  appDeps.assemblies = assemblies;
}
window.__sidediff = { engine, registry, ...(appDeps.project ? { project } : {}) };
Object.assign(window, { __fakeEngine: engine, __fakeProject: project, __fakeAssemblies: assemblies, __genProject: genProject, __fakeZipBlob: fakeZipBlob });
createApp(appDeps);

function pickFile(side: 'a' | 'b', file: File): void {
  const input = document.querySelector<HTMLInputElement>(`[data-testid="file-${side}"]`);
  if (!input) return;
  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  input.dispatchEvent(new Event('change'));
}

async function preload(): Promise<void> {
  const load = params.get('load');
  if (!load) return;
  await new Promise((r) => setTimeout(r, 50));
  if (load === 'pkg' || load === 'pkg2') {
    pickFile('a', new File([fakeZipBlob('a')], 'Fake.Customization.24R2.zip'));
    if (load === 'pkg2') pickFile('b', new File([fakeZipBlob('b')], 'Fake.Customization.25R1.zip'));
    return;
  }
  let pair: { a: string; b: string };
  if (load === 'fixture') {
    const [a, b] = await Promise.all(['a', 'b'].map((s) => fetch(`/fixtures/project-${s}.xml`).then((r) => r.text())));
    pair = { a: a ?? '', b: b ?? '' };
  } else pair = genProject(Number(params.get('n') ?? 2000));
  engine.setText('a', pair.a);
  engine.setText('b', pair.b);
}
void preload();
