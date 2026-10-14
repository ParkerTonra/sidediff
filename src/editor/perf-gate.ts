// Editor-local perf gate (GOAL-PROMPT section 8) against the harness page.
// Run: node src/editor/perf-gate.ts [lines] [--stress] [--headed]
// Needs a dev server on 5318: ./node_modules/.bin/vite --port 5318 --strictPort
// QA's `pnpm bench` is the official gate; this is for tuning the engine.
import { chromium } from '@playwright/test';
import type { Page } from '@playwright/test';

const BASE = process.env.HARNESS_URL ?? 'http://localhost:5318/src/editor/harness.html';
const args = process.argv.slice(2);
const lines = Number(args.find((a) => /^\d+$/.test(a)) ?? 150_000);
const stress = args.includes('--stress');
const headed = args.includes('--headed');
const fixture = args.find((a) => a.startsWith('--fixture='))?.slice('--fixture='.length);

async function markTime(page: Page, name: string, timeoutMs: number): Promise<number> {
  const handle = await page.waitForFunction(
    (n) => {
      const m = performance.getEntriesByName(n, 'mark');
      return m.length ? m[m.length - 1]!.startTime : null;
    },
    name,
    { timeout: timeoutMs, polling: 50 },
  );
  return (await handle.jsonValue()) as number;
}

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: !headed, args: ['--enable-precise-memory-info'] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const consoleErrors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || /web worker/i.test(m.text())) consoleErrors.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
  let crashed = false;
  page.on('crash', () => (crashed = true));

  await page.goto(BASE);
  await page.waitForFunction(() => !!window.__engine);
  await page.evaluate(() => {
    const w = window as unknown as { __lt: { start: number; dur: number }[]; __ev: string[] };
    w.__lt = [];
    w.__ev = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.__lt.push({ start: e.startTime, dur: e.duration });
    }).observe({ type: 'longtask', buffered: true });
    const eng = window.__engine!;
    eng.on('diff:done', () => w.__ev.push('done'));
    eng.on('diff:error', (e) => w.__ev.push('error:' + e.message));
    eng.on('degraded', (d) => w.__ev.push('degraded:' + (d ? d.sides.join(',') : 'null')));
  });

  const n = stress ? 500_000 : lines;
  const sizes = await page.evaluate(
    async ({ n, fixture }) => {
      const w = window as unknown as { __A: string; __B: string };
      if (fixture) {
        const ext = fixture.startsWith('csharp') ? 'cs' : 'xml';
        const get = async (s: string) => (await fetch(`/fixtures/${fixture}-${s}.${ext}`)).text();
        w.__A = await get('a');
        w.__B = await get('b');
        window.__engine!.setLanguage(ext === 'cs' ? 'csharp' : 'xml');
      } else {
        const g = window.__gen!(n);
        w.__A = g.a;
        w.__B = g.b;
      }
      return { a: w.__A.length, b: w.__B.length };
    },
    { n, fixture },
  );
  console.log(`input: ${fixture ?? `${n} generated lines`}, A ${(sizes.a / 1e6).toFixed(1)} MB, B ${(sizes.b / 1e6).toFixed(1)} MB`);

  const timeout = stress ? 90_000 : 20_000;
  // Side A.
  const tA = await page.evaluate(() => {
    const t = performance.now();
    window.__engine!.setText('a', (window as unknown as { __A: string }).__A);
    return t;
  });
  const frA = await markTime(page, 'sidediff:first-render:a', timeout);
  await page.evaluate(() => new Promise((r) => setTimeout(r, 300)));
  const tB = await page.evaluate(() => {
    (window as unknown as { __ev: string[] }).__ev.length = 0;
    const t = performance.now();
    window.__engine!.setText('b', (window as unknown as { __B: string }).__B);
    return t;
  });
  const frB = await markTime(page, 'sidediff:first-render:b', timeout);
  const ev = await page.waitForFunction(
    () => {
      const w = window as unknown as { __ev: string[] };
      return w.__ev.find((e) => e === 'done' || e.startsWith('error')) ?? null;
    },
    undefined,
    { timeout: stress ? 75_000 : 30_000, polling: 100 },
  );
  const outcome = (await ev.jsonValue()) as string;
  const done = await page.evaluate(() => {
    const d = performance.getEntriesByName('sidediff:diff-done', 'mark');
    return d.length ? d[d.length - 1]!.startTime : null;
  });
  const stats = await page.evaluate(() => window.__engine!.getStats());
  const longDuringDiff = await page.evaluate(
    ({ from, to }) => {
      const w = window as unknown as { __lt: { start: number; dur: number }[] };
      return w.__lt.filter((l) => l.start + l.dur >= from && l.start <= to).map((l) => Math.round(l.dur));
    },
    { from: tB, to: done ?? performance.now() },
  );
  const allLong = await page.evaluate(() =>
    (window as unknown as { __lt: { start: number; dur: number }[] }).__lt.map((l) => `${Math.round(l.start)}+${Math.round(l.dur)}`),
  );
  const providerActive = await page.evaluate(() => window.__providerActive?.() ?? false);
  const workers = page.workers().map((w) => w.url().split('/').pop());

  console.log(`first render A: ${Math.round(frA - tA)} ms, B: ${Math.round(frB - tB)} ms   (gate < 2000)`);
  console.log(`diff outcome: ${outcome}`);
  if (done) console.log(`diff ready after B set: ${Math.round(done - tB)} ms; from A set: ${Math.round(done - tA)} ms   (gate < 5000, hard 10000)`);
  console.log(`stats: ${JSON.stringify(stats)}`);
  console.log(`long tasks during diff (ms): [${longDuringDiff.join(', ')}] max ${Math.max(0, ...longDuringDiff)}   (gate <= 200)`);
  console.log(`all long tasks (start+dur): ${allLong.join(' ')}`);
  console.log(`diff provider override active: ${providerActive}; workers: ${JSON.stringify(workers)}`);

  if (!stress && outcome === 'done') {
    // Diff-only toggle on and off.
    for (const on of [true, false]) {
      const t = await page.evaluate((v) => {
        performance.clearMarks('sidediff:diffonly-done');
        const t0 = performance.now();
        window.__engine!.setOptions({ diffOnly: v });
        return t0;
      }, on);
      const d = await markTime(page, 'sidediff:diffonly-done', 5000);
      console.log(`diffOnly ${on ? 'on' : 'off'}: ${Math.round(d - t)} ms   (gate < 1000)`);
      if (on) {
        const nav = await page.evaluate(async () => {
          const e = window.__engine!;
          const out: string[] = [];
          for (let i = 0; i < 3; i++) {
            const t0 = performance.now();
            e.nextChange();
            await new Promise((r) => requestAnimationFrame(() => r(null)));
            const p = e.getPosition();
            out.push(`${p.index}/${p.total} ${Math.round(performance.now() - t0)}ms`);
          }
          e.prevChange();
          out.push(`prev→${e.getPosition().index}`);
          e.goToChange(e.getPosition().total);
          e.nextChange();
          out.push(`wrap→${e.getPosition().index}`);
          return out.join(', ');
        });
        console.log(`nav with diff-only: ${nav}`);
        await page.screenshot({ path: process.env.SHOT_DIR ? `${process.env.SHOT_DIR}/diffonly.png` : 'test-results/editor-diffonly.png' });
      }
    }
    const textSame = await page.evaluate(() => {
      const w = window as unknown as { __A: string; __B: string };
      return window.__engine!.getText('a') === w.__A && window.__engine!.getText('b') === w.__B;
    });
    console.log(`getText unchanged after diff-only on/off: ${textSame}`);

    // Scripted 5 s scroll: move the modified editor ~120 lines per frame (a
    // full viewport repaint every frame, harsher than wheel scrolling).
    const frames = await page.evaluate(async () => {
      const ed = (window as unknown as { __monacoModified?: () => { getScrollTop(): number; setScrollTop(n: number): void } }).__monacoModified?.();
      if (!ed) return { count: 0, max: -1, over50: -1, endTop: 0 };
      const f: number[] = [];
      const t0 = performance.now();
      let last = t0;
      await new Promise<void>((resolve) => {
        const tick = (t: number) => {
          f.push(t - last);
          last = t;
          ed.setScrollTop(ed.getScrollTop() + 2400);
          if (t - t0 < 5000) requestAnimationFrame(tick);
          else resolve();
        };
        requestAnimationFrame(tick);
      });
      const g = f.slice(1);
      return { count: g.length, max: Math.round(Math.max(...g)), over50: g.filter((x) => x > 50).length, endTop: ed.getScrollTop() };
    });
    console.log(`scroll 5 s (to scrollTop ${frames.endTop}): ${frames.count} frames, max ${frames.max} ms, frames > 50 ms: ${frames.over50}   (gate: none > 100)`);
    await page.screenshot({ path: process.env.SHOT_DIR ? `${process.env.SHOT_DIR}/scrolled.png` : 'test-results/editor-scrolled.png' });
  }

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const { metrics } = (await cdp.send('Performance.getMetrics')) as { metrics: { name: string; value: number }[] };
  const metric = (k: string) => metrics.find((m) => m.name === k)?.value ?? 0;
  console.log(
    `memory: JS heap used ${(metric('JSHeapUsedSize') / 1e6).toFixed(0)} MB, total ${(metric('JSHeapTotalSize') / 1e6).toFixed(0)} MB, DOM nodes ${metric('Nodes')}   (gate < 2000 MB)`,
  );
  console.log(`crashed: ${crashed}; console errors: ${consoleErrors.length ? '\n  ' + consoleErrors.slice(0, 10).join('\n  ') : 'none'}`);
  const evs = await page.evaluate(() => (window as unknown as { __ev: string[] }).__ev);
  console.log(`events: ${evs.join(' | ')}`);
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
