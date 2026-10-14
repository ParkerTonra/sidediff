// Browser perf check for the project indexer (not part of the app build).
// Open /src/project/harness.html on an ad-hoc Vite server after `pnpm fixtures`.
import { createProjectIndexer } from './index';

const out = document.getElementById('log') as HTMLPreElement;
const log = (m: string): void => {
  out.textContent += `${m}\n`;
};

interface Result {
  run: number;
  syncMs: number;
  resolveMs: number;
  totalMs: number;
  scanA: number;
  scanB: number;
  items: number;
  longestTaskMs: number;
}

async function main(): Promise<void> {
  const name = new URLSearchParams(location.search).get('pair') ?? 'large';
  const get = (u: string): Promise<string> => fetch(u).then((r) => r.text());
  const [a, b] = await Promise.all([get(`/fixtures/${name}-a.xml`), get(`/fixtures/${name}-b.xml`)]);
  log(`${name}: A ${a.length} chars, B ${b.length} chars`);
  const tasks: number[] = [];
  new PerformanceObserver((l) => l.getEntries().forEach((e) => tasks.push(e.duration))).observe({ type: 'longtask' });
  const ix = createProjectIndexer();
  const results: Result[] = [];
  for (let run = 1; run <= 5; run++) {
    tasks.length = 0;
    const t0 = performance.now();
    const p = ix.index(a, b);
    const syncMs = performance.now() - t0;
    let tr = 0;
    const idx = await p.then((r) => {
      tr = performance.now();
      return r;
    });
    // Time from the worker reply being handled to our continuation is the
    // main-thread structured-clone + finish(); measure both ends.
    const resolveMs = performance.now() - tr;
    const totalMs = performance.now() - t0;
    await new Promise((r) => setTimeout(r, 50));
    results.push({ run, syncMs, resolveMs, totalMs, scanA: idx.sides.a.parseMs, scanB: idx.sides.b.parseMs, items: idx.items.length, longestTaskMs: Math.max(0, ...tasks) });
  }
  // Supersede check: second call aborts the first.
  const first = ix.index(a, b).then(() => 'resolved', (e: unknown) => (e instanceof DOMException ? e.name : String(e)));
  const second = await ix.index(b, a);
  log(`supersede: first → ${await first}, second items ${second.items.length}`);
  for (const r of results) log(JSON.stringify(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Math.round(v * 10) / 10]))));
  (window as unknown as { results: Result[] }).results = results;
  document.body.dataset.done = '1';
}
main().catch((e: unknown) => log(`error: ${String(e)}`));
