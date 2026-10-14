// Performance gate (GOAL-PROMPT section 8). Run with `pnpm bench`.
//
// Builds with `vite build`, serves dist/ with `vite preview` on 5321, drives
// headless Chromium and measures every gate line on the `large` fixture pair,
// then the `stress` pair. Prints a PASS/FAIL table, writes JSON to
// bench-results/, and exits non-zero on any FAIL or ERROR.
//
// Flags: --no-build (reuse dist/), --headed, --skip-stress

import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { chromium } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import type { DiffEngineEvents, DiffStats } from '../src/types.ts';
import { withinTolerance } from './lib/diff-stats.ts';
import type { Tolerance } from './lib/diff-stats.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5321;
const BASE = `http://localhost:${PORT}/`;
const VITE = join(ROOT, 'node_modules/vite/bin/vite.js');
const args = new Set(process.argv.slice(2));

type Status = 'PASS' | 'FAIL' | 'WARN' | 'INFO' | 'ERROR' | 'SKIP';
interface Row {
  metric: string;
  value: string;
  target: string;
  status: Status;
  note?: string;
  raw?: unknown;
}
const rows: Row[] = [];
const add = (row: Row): void => {
  rows.push(row);
  console.log(`  ${row.status.padEnd(5)} ${row.metric}: ${row.value}${row.note ? ` (${row.note})` : ''}`);
};
const ms = (n: number): string => `${Math.round(n)} ms`;
const mb = (n: number): string => `${(n / 1024 / 1024).toFixed(1)} MB`;
const gate = (value: number, limit: number): Status => (value < limit ? 'PASS' : 'FAIL');
const sleep = (t: number): Promise<void> => new Promise((r) => setTimeout(r, t));
const errText = (e: unknown): string => (e instanceof Error ? e.message.split('\n')[0] ?? e.message : String(e));

// ------------------------------------------------------------------ page-side state

interface BenchEvent {
  ev: keyof DiffEngineEvents;
  t: number;
  p: unknown;
}
interface BenchState {
  longtasks: { start: number; dur: number }[];
  events: BenchEvent[];
  progress: { t: number; state: string | null; running: number }[];
  hookError?: string;
}
declare global {
  interface Window {
    __bench?: BenchState;
  }
}

/** Runs in the page before any app script. */
function benchInit(): void {
  const b: BenchState = { longtasks: [], events: [], progress: [] };
  window.__bench = b;
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) b.longtasks.push({ start: e.startTime, dur: e.duration });
    }).observe({ type: 'longtask', buffered: true });
  } catch (e) {
    b.hookError = `longtask observer: ${String(e)}`;
  }
  const names = ['diff:start', 'diff:done', 'diff:error', 'degraded', 'content', 'position'] as const;
  const hook = (): void => {
    const s = window.__sidediff;
    if (!s) {
      setTimeout(hook, 10);
      return;
    }
    for (const ev of names) {
      try {
        s.engine.on(ev, (p: unknown) => b.events.push({ ev, t: performance.now(), p }));
      } catch (e) {
        b.hookError = `engine.on(${ev}): ${String(e)}`;
      }
    }
  };
  hook();
  const watch = (): void => {
    const el = document.querySelector('[data-testid="progress"]');
    if (!el) {
      setTimeout(watch, 50);
      return;
    }
    const sample = (): void => {
      const running = el.getAnimations({ subtree: true }).filter((a) => a.playState === 'running').length;
      b.progress.push({ t: performance.now(), state: el.getAttribute('data-state'), running });
    };
    new MutationObserver(() => {
      sample();
      // Animations start on the next style recalc; sample again shortly after.
      requestAnimationFrame(() => requestAnimationFrame(sample));
    }).observe(el, { attributes: true, attributeFilter: ['data-state'] });
  };
  watch();
  document.addEventListener(
    'change',
    (e) => {
      const id = e.target instanceof HTMLElement ? e.target.dataset.testid : undefined;
      if (id === 'file-a' || id === 'file-b') performance.mark(`bench:file-change:${id.slice(5)}`);
    },
    true,
  );
}

/** First performance mark `name` at or after `after` (page time), or null on timeout. */
async function waitMark(page: Page, name: string, after: number, timeout: number): Promise<number | null> {
  try {
    const handle = await page.waitForFunction(
      ([n, a]) => performance.getEntriesByName(n as string).find((e) => e.startTime >= (a as number))?.startTime ?? false,
      [name, after] as const,
      { timeout, polling: 25 },
    );
    return (await handle.jsonValue()) as number;
  } catch {
    return null;
  }
}

/** First engine event `ev` at or after `after`, or null on timeout. */
async function waitEvent(page: Page, ev: string, after: number, timeout: number): Promise<BenchEvent | null> {
  try {
    const handle = await page.waitForFunction(
      ([n, a]) => window.__bench?.events.find((e) => e.ev === n && e.t >= (a as number)) ?? false,
      [ev, after] as const,
      { timeout, polling: 25 },
    );
    return (await handle.jsonValue()) as BenchEvent;
  } catch {
    return null;
  }
}

const pageNow = (page: Page): Promise<number> => page.evaluate(() => performance.now());
const twoFrames = (page: Page): Promise<number> =>
  page.evaluate(() => new Promise<number>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(performance.now())))));

// ------------------------------------------------------------------ build, serve, bundle

function ensureFixtures(names: string[]): void {
  const missing = names.filter((n) => !existsSync(join(ROOT, `fixtures/${n}-a.xml`)) || !existsSync(join(ROOT, `fixtures/${n}-b.xml`)));
  if (missing.length === 0) return;
  console.log(`generating fixtures: ${missing.join(', ')}`);
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts/gen-fixtures.ts'), '--only', missing.join(','), '--no-verify'], { stdio: 'inherit', cwd: ROOT });
  if (r.status !== 0) throw new Error('fixture generation failed');
}

function build(): void {
  console.log('vite build ...');
  const t = performance.now();
  const r = spawnSync(process.execPath, [VITE, 'build', '--logLevel', 'warn'], { stdio: 'inherit', cwd: ROOT });
  if (r.status !== 0) throw new Error('vite build failed');
  console.log(`vite build done in ${ms(performance.now() - t)}`);
}

async function serve(): Promise<ChildProcess> {
  const proc = spawn(process.execPath, [VITE, 'preview', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout?.on('data', (d: Buffer) => (out += d.toString()));
  proc.stderr?.on('data', (d: Buffer) => (out += d.toString()));
  for (let i = 0; i < 100; i++) {
    if (proc.exitCode !== null) throw new Error(`vite preview exited: ${out.trim()}`);
    try {
      const res = await fetch(BASE);
      if (res.ok) return proc;
    } catch {
      // not up yet
    }
    await sleep(100);
  }
  proc.kill();
  throw new Error(`vite preview did not start on ${PORT}: ${out.trim()}`);
}

function bundleReport(): void {
  const dist = join(ROOT, 'dist');
  const html = readFileSync(join(dist, 'index.html'), 'utf8');
  const initial = new Set<string>();
  for (const m of html.matchAll(/<script[^>]*type="module"[^>]*src="([^"]+)"/g)) if (m[1]) initial.add(m[1]);
  for (const m of html.matchAll(/<link[^>]*rel="modulepreload"[^>]*href="([^"]+)"/g)) if (m[1]) initial.add(m[1]);
  let gz = 0;
  let raw = 0;
  for (const src of initial) {
    const file = join(dist, src.replace(/^\.?\//, ''));
    if (!existsSync(file)) continue;
    const buf = readFileSync(file);
    raw += buf.length;
    gz += gzipSync(buf, { level: 9 }).length;
  }
  add({
    metric: 'Initial JS (gzip)',
    value: `${mb(gz)} (${mb(raw)} raw, ${initial.size} files)`,
    target: '< 3 MB gzip (warning only)',
    status: initial.size === 0 ? 'ERROR' : gz < 3 * 1024 * 1024 ? 'PASS' : 'WARN',
    raw: { gzipBytes: gz, rawBytes: raw, files: [...initial] },
  });

  const known = readdirSync(join(ROOT, 'node_modules/monaco-editor/esm/vs/languages/definitions'), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  const assets = readdirSync(join(dist, 'assets')).filter((f) => f.endsWith('.js'));
  const chunks = assets.filter((f) => known.some((l) => f.startsWith(`${l}-`) || f.startsWith(`${l}.`)));
  const allJs = assets.map((f) => readFileSync(join(dist, 'assets', f), 'utf8')).join('\n');
  const registered = known.filter((l) => new RegExp(`id:\\s*["'\`]${l.replace(/[-.]/g, '\\$&')}["'\`]\\s*,\\s*extensions`).test(allJs));
  const extra = registered.filter((l) => l !== 'csharp' && l !== 'xml');
  add({
    metric: 'Monaco language modules',
    value: `chunks [${chunks.join(', ')}]; registered [${registered.join(', ')}]`,
    target: 'csharp and xml only',
    status: extra.length === 0 && registered.includes('csharp') && registered.includes('xml') ? 'PASS' : 'WARN',
    ...(extra.length ? { note: `unexpected: ${extra.join(', ')}` } : {}),
    raw: { chunks, registered, assets },
  });
}

/** Working set of the largest renderer under the browser process (Windows only). */
function rendererMemory(browserPid: number | undefined): number | null {
  if (process.platform !== 'win32' || browserPid === undefined) return null;
  const r = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,CommandLine | ConvertTo-Json -Compress'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (r.status !== 0) return null;
  const procs = JSON.parse(r.stdout) as { ProcessId: number; ParentProcessId: number; WorkingSetSize: number; CommandLine: string | null }[];
  const tree = new Set([browserPid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of procs) {
      if (tree.has(p.ParentProcessId) && !tree.has(p.ProcessId)) {
        tree.add(p.ProcessId);
        grew = true;
      }
    }
  }
  const renderers = procs.filter((p) => tree.has(p.ProcessId) && (p.CommandLine ?? '').includes('--type=renderer'));
  return renderers.length ? Math.max(...renderers.map((p) => p.WorkingSetSize)) : null;
}

// ------------------------------------------------------------------ app driving

type LoadPath = 'file-input' | 'engine.setText';

async function openApp(browser: Browser): Promise<{ page: Page; path: LoadPath; crashed: () => boolean; errors: string[] }> {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await context.addInitScript(benchInit);
  const page = await context.newPage();
  const errors: string[] = [];
  let crashed = false;
  page.on('crash', () => (crashed = true));
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(BASE);
  await page.waitForFunction(() => !!window.__sidediff, undefined, { timeout: 15_000 }).catch(() => undefined);
  await page.locator('.monaco-diff-editor').first().waitFor({ timeout: 15_000 }).catch(() => undefined);
  const path: LoadPath = (await page.locator('[data-testid="file-a"]').count()) > 0 ? 'file-input' : 'engine.setText';
  return { page, path, crashed: () => crashed, errors };
}

interface LoadResult {
  /** Page time when loading began (file input change, or the setText call). */
  start: number;
  textSet: number | null;
  firstRender: number | null;
}

async function loadSide(page: Page, path: LoadPath, side: 'a' | 'b', file: string, timeout: number): Promise<LoadResult> {
  const before = await pageNow(page);
  if (path === 'file-input') {
    await page.locator(`[data-testid="file-${side}"]`).setInputFiles(file);
  } else {
    const text = readFileSync(file, 'utf8');
    await page.evaluate(
      ([s, t]) => {
        performance.mark(`bench:settext-call:${s}`);
        window.__sidediff?.engine.setText(s as 'a' | 'b', t as string);
      },
      [side, text] as const,
    );
  }
  const startMark = path === 'file-input' ? `bench:file-change:${side}` : `bench:settext-call:${side}`;
  const start = (await waitMark(page, startMark, before, 5_000)) ?? before;
  const textSet = await waitMark(page, `sidediff:text-set:${side}`, start, timeout);
  const firstRender = await waitMark(page, `sidediff:first-render:${side}`, start, timeout);
  return { start, textSet, firstRender };
}

function longestTask(tasks: { start: number; dur: number }[], from: number, to: number): number {
  let worst = 0;
  for (const t of tasks) if (t.start < to && t.start + t.dur > from) worst = Math.max(worst, t.dur);
  return worst;
}

async function toggleDiffOnly(page: Page, on: boolean): Promise<{ ms: number | null; via: string }> {
  const btn = page.locator('[data-testid="btn-diff-only"]');
  const before = await pageNow(page);
  let via = 'btn-diff-only';
  if ((await btn.count()) > 0) {
    const pressed = (await btn.getAttribute('aria-pressed')) === 'true';
    if (pressed !== on) await btn.click();
  } else {
    via = 'engine.setOptions';
    await page.evaluate((v) => window.__sidediff?.engine.setOptions({ diffOnly: v }), on);
  }
  const s = await waitMark(page, 'sidediff:diffonly-start', before, 5_000);
  const d = await waitMark(page, 'sidediff:diffonly-done', before, 10_000);
  if (s !== null && d !== null) return { ms: d - s, via: `${via}, marks` };
  return { ms: null, via: `${via}, diffonly marks missing` };
}

async function scrollTest(page: Page): Promise<{ worst: number; frames: number; moved: boolean; wheels: number }> {
  const target = page.locator('.monaco-diff-editor .editor.modified, .monaco-diff-editor .modified-in-monaco-diff-editor').first();
  const box = (await target.boundingBox()) ?? (await page.locator('[data-testid="editor"]').boundingBox());
  if (!box) throw new Error('no editor to scroll');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const firstLine = (): Promise<string> =>
    page.evaluate(() => {
      const nums = [...document.querySelectorAll('.monaco-diff-editor .line-numbers')].map((e) => Number(e.textContent)).filter((n) => n > 0);
      return nums.length ? String(Math.min(...nums)) : '';
    });
  const startLine = await firstLine();
  const recorder = page.evaluate(
    () =>
      new Promise<number[]>((resolve) => {
        const deltas: number[] = [];
        let last = performance.now();
        const end = last + 5_000;
        const tick = (t: number): void => {
          deltas.push(t - last);
          last = t;
          if (t < end) requestAnimationFrame(tick);
          else resolve(deltas);
        };
        requestAnimationFrame(tick);
      }),
  );
  const stop = Date.now() + 5_000;
  let wheels = 0;
  while (Date.now() < stop) {
    await page.mouse.wheel(0, wheels % 40 < 30 ? 900 : -600);
    wheels++;
    await sleep(30);
  }
  const deltas = await recorder;
  const endLine = await firstLine();
  return { worst: Math.max(...deltas.slice(1)), frames: deltas.length, moved: startLine !== endLine, wheels };
}

// ------------------------------------------------------------------ scenarios

interface ChangesJson {
  a: { lines: number };
  b: { lines: number };
  expected: { trimWhitespace: Record<'added' | 'removed' | 'modified' | 'changes', number> };
  tolerance: Tolerance;
}

async function largeScenario(browser: Browser, browserPid: number | undefined): Promise<void> {
  const fa = join(ROOT, 'fixtures/large-a.xml');
  const fb = join(ROOT, 'fixtures/large-b.xml');
  const { page, path, crashed, errors } = await openApp(browser);
  const engineUp = await page.evaluate(() => !!window.__sidediff);
  add({ metric: 'Load path', value: path, target: 'file-input preferred', status: engineUp ? 'INFO' : 'ERROR', ...(engineUp ? {} : { note: 'window.__sidediff missing' }) });
  if (!engineUp) {
    add({ metric: 'App start', value: (await page.locator('#app').innerText()).slice(0, 200), target: 'app starts', status: 'ERROR' });
    await page.context().close();
    return;
  }

  const loads: Partial<Record<'a' | 'b', LoadResult>> = {};
  for (const [side, file] of [['a', fa], ['b', fb]] as const) {
    const r = await loadSide(page, path, side, file, 30_000);
    loads[side] = r;
    if (r.firstRender === null) {
      add({ metric: `Load ${side.toUpperCase()} to first render`, value: 'no sidediff:first-render mark in 30 s', target: '< 2000 ms', status: 'ERROR' });
      continue;
    }
    const total = r.firstRender - r.start;
    const engineOnly = r.textSet === null ? null : r.firstRender - r.textSet;
    add({
      metric: `Load ${side.toUpperCase()} to first render`,
      value: ms(total),
      target: '< 2000 ms',
      status: gate(total, 2000),
      note: `${path}${engineOnly === null ? '' : `; setText→render ${ms(engineOnly)}`}`,
      raw: r,
    });
  }

  // Diff ready: from B's load start (both sides in) to the diff-done mark.
  const from = loads.b?.start ?? 0;
  const doneMark = await waitMark(page, 'sidediff:diff-done', from, 30_000);
  const startMark = await waitMark(page, 'sidediff:diff-start', from, 1_000);
  const doneEvent = await waitEvent(page, 'diff:done', from, 1_000);
  if (doneMark === null) {
    const err = await waitEvent(page, 'diff:error', from, 100);
    add({ metric: 'Diff ready', value: err ? `diff:error ${JSON.stringify(err.p)}` : 'no sidediff:diff-done mark in 30 s', target: '< 5000 ms (hard 10000)', status: 'ERROR' });
  } else {
    const t = doneMark - from;
    add({ metric: 'Diff ready (B load start → diff-done)', value: ms(t), target: '< 5000 ms (hard 10000)', status: t < 5000 ? 'PASS' : t < 10_000 ? 'WARN' : 'FAIL', ...(startMark !== null ? { note: `diff-start→done ${ms(doneMark - startMark)}` } : {}) });
  }

  const bench = (await page.evaluate(() => window.__bench)) as BenchState;
  if (doneMark !== null) {
    const windowStart = startMark ?? from;
    const lt = longestTask(bench.longtasks, windowStart, doneMark);
    add({ metric: 'Longest task during diff', value: ms(lt), target: '< 200 ms', status: gate(lt, 200), note: `window ${ms(doneMark - windowStart)}; longest overall ${ms(Math.max(0, ...bench.longtasks.map((x) => x.dur)))}` });
    const computing = bench.progress.filter((p) => p.state === 'computing' && p.t >= from - 50 && p.t <= doneMark + 50);
    const animated = computing.some((p) => p.running > 0);
    add({ metric: 'Progress indicator', value: computing.length ? `computing, ${animated ? 'animating' : 'no running animation'}` : 'never entered computing', target: 'computing + animates', status: computing.length && animated ? 'PASS' : 'FAIL' });
  }
  if (bench.hookError) add({ metric: 'Bench hooks', value: bench.hookError, target: 'none', status: 'WARN' });

  // Stats vs changes.json.
  const changes = JSON.parse(readFileSync(join(ROOT, 'fixtures/large.changes.json'), 'utf8')) as ChangesJson;
  const stats = (doneEvent?.p ?? (await page.evaluate(() => window.__sidediff?.engine.getStats() ?? null))) as DiffStats | null;
  if (stats) {
    const keys = ['added', 'removed', 'modified', 'changes'] as const;
    const ok = keys.every((k) => withinTolerance(stats[k], changes.expected.trimWhitespace[k], changes.tolerance));
    add({
      metric: 'Stats vs large.changes.json (trim ws)',
      value: keys.map((k) => `${k} ${stats[k]}/${changes.expected.trimWhitespace[k]}`).join(', '),
      target: 'within tolerance',
      status: ok ? 'PASS' : 'FAIL',
      note: `computeMs ${stats.computeMs}, quitEarly ${stats.quitEarly}`,
    });
  }

  // Diff only on / off.
  for (const on of [true, false]) {
    const r = await toggleDiffOnly(page, on);
    add({ metric: `Diff only ${on ? 'on' : 'off'}`, value: r.ms === null ? 'n/a' : ms(r.ms), target: '< 1000 ms', status: r.ms === null ? 'ERROR' : gate(r.ms, 1000), note: r.via });
    await sleep(300);
  }

  // Scripted scroll.
  try {
    await twoFrames(page);
    const s = await scrollTest(page);
    add({ metric: 'Worst frame in 5 s scroll', value: ms(s.worst), target: '< 100 ms', status: s.moved ? gate(s.worst, 100) : 'ERROR', note: `${s.frames} frames, ${s.wheels} wheel events${s.moved ? '' : ', viewport did not move'}` });
  } catch (e) {
    add({ metric: 'Worst frame in 5 s scroll', value: errText(e), target: '< 100 ms', status: 'ERROR' });
  }

  // Memory.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  await cdp.send('HeapProfiler.collectGarbage').catch(() => undefined);
  const { metrics } = await cdp.send('Performance.getMetrics');
  const metric = (n: string): number => metrics.find((m) => m.name === n)?.value ?? 0;
  const heap = metric('JSHeapTotalSize');
  const rss = rendererMemory(browserPid);
  const worst = Math.max(heap, rss ?? 0);
  add({
    metric: 'Tab memory after diff',
    value: rss === null ? `JS heap ${mb(heap)}` : `renderer ${mb(rss)}, JS heap ${mb(heap)}`,
    target: '< 2048 MB',
    status: gate(worst, 2 * 1024 * 1024 * 1024),
    note: `JS heap used ${mb(metric('JSHeapUsedSize'))}, DOM nodes ${metric('Nodes')}`,
  });

  add({ metric: 'Console errors (large run)', value: errors.length ? errors.slice(0, 3).join(' | ') : 'none', target: 'none', status: errors.length ? 'FAIL' : 'PASS' });
  if (crashed()) add({ metric: 'Renderer crash (large)', value: 'crashed', target: 'no crash', status: 'FAIL' });
  await page.context().close();
}

async function stressScenario(browser: Browser): Promise<void> {
  const { page, path, crashed } = await openApp(browser);
  if (!(await page.evaluate(() => !!window.__sidediff))) {
    add({ metric: 'Stress pair', value: 'app did not start', target: 'degrade, finish ≤ 60 s', status: 'ERROR' });
    await page.context().close();
    return;
  }
  const t0 = Date.now();
  let outcome: string;
  let status: Status;
  try {
    await loadSide(page, path, 'a', join(ROOT, 'fixtures/stress-a.xml'), 60_000);
    const b = await loadSide(page, path, 'b', join(ROOT, 'fixtures/stress-b.xml'), 60_000);
    const remaining = Math.max(1_000, 60_000 - (Date.now() - t0));
    const done = await Promise.race([
      waitMark(page, 'sidediff:diff-done', b.start, remaining).then((t) => (t === null ? null : { kind: 'done', t })),
      waitEvent(page, 'diff:error', b.start, remaining).then((e) => (e === null ? null : { kind: 'error', t: e.t, p: e.p })),
    ]);
    const warning = await page.locator('[data-testid="degraded-warning"]').isVisible().catch(() => false);
    const degradedEvt = await waitEvent(page, 'degraded', 0, 100);
    const elapsed = done ? done.t - b.start : null;
    outcome = `${done ? `${done.kind} after ${ms(elapsed ?? 0)}` : 'neither done nor error in 60 s'}; warning ${warning ? 'shown' : 'NOT shown'}; degraded event ${degradedEvt ? 'yes' : 'no'}`;
    status = !crashed() && done !== null && warning ? 'PASS' : 'FAIL';
  } catch (e) {
    outcome = errText(e);
    status = crashed() ? 'FAIL' : 'ERROR';
  }
  if (crashed()) outcome += '; renderer crashed';
  add({ metric: 'Stress pair (500k lines)', value: outcome, target: 'no crash, degraded warning, done/error ≤ 60 s', status, note: `wall ${ms(Date.now() - t0)}` });
  await page.context().close();
}

// ------------------------------------------------------------------ main

function printTable(): void {
  const w = [34, 46, 30, 6];
  const line = (c: string[]): string => c.map((x, i) => x.padEnd(w[i] ?? 10).slice(0, w[i] ?? 10)).join(' | ');
  console.log('\n' + line(['Metric', 'Value', 'Target', 'Status']));
  console.log(w.map((n) => '-'.repeat(n)).join('-+-'));
  for (const r of rows) console.log(line([r.metric, r.value, r.target, r.status]));
}

async function main(): Promise<number> {
  ensureFixtures(args.has('--skip-stress') ? ['large'] : ['large', 'stress']);
  if (!args.has('--no-build')) build();
  bundleReport();
  const server = await serve();
  const browserServer = await chromium.launchServer({ headless: !args.has('--headed') });
  const pid = browserServer.process().pid;
  const browser = await chromium.connect(browserServer.wsEndpoint());
  try {
    console.log('\nlarge pair:');
    await largeScenario(browser, pid);
    if (!args.has('--skip-stress')) {
      console.log('\nstress pair:');
      await stressScenario(browser);
    }
  } catch (e) {
    add({ metric: 'Bench run', value: errText(e), target: 'completes', status: 'ERROR' });
  } finally {
    await browser.close().catch(() => undefined);
    await browserServer.close().catch(() => undefined);
    server.kill();
  }
  printTable();
  const failed = rows.filter((r) => r.status === 'FAIL' || r.status === 'ERROR');
  mkdirSync(join(ROOT, 'bench-results'), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const report = { when: new Date().toISOString(), node: process.version, platform: process.platform, passed: failed.length === 0, rows };
  writeFileSync(join(ROOT, `bench-results/bench-${stamp}.json`), JSON.stringify(report, null, 2));
  writeFileSync(join(ROOT, 'bench-results/latest.json'), JSON.stringify(report, null, 2));
  console.log(`\n${failed.length === 0 ? 'PASS' : `FAIL (${failed.length} failing)`} → bench-results/bench-${stamp}.json`);
  return failed.length === 0 ? 0 : 1;
}

process.exit(await main());
