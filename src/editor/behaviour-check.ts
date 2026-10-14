// Functional checks of the engine in headless Chromium against the harness.
// Run: node src/editor/behaviour-check.ts   (dev server on 5318)
import { chromium } from '@playwright/test';
import type { Page } from '@playwright/test';

const BASE = process.env.HARNESS_URL ?? 'http://localhost:5318/src/editor/harness.html';
const SHOT = process.env.SHOT_DIR ?? 'test-results';
let failures = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

/** Resolves with the next diff:done (or error) after `action` runs in the page. */
async function untilDiff(page: Page, action: string, timeout = 30_000): Promise<string> {
  return page.evaluate(
    ({ action, timeout }) =>
      new Promise<string>((resolve) => {
        const e = window.__engine!;
        const offs = [
          e.on('diff:done', (s) => finish(JSON.stringify(s))),
          e.on('diff:error', (x) => finish('error:' + x.message)),
        ];
        const t = setTimeout(() => finish('timeout'), timeout);
        function finish(v: string): void {
          clearTimeout(t);
          offs.forEach((o) => o());
          resolve(v);
        }
        new Function('e', action)(e);
      }),
    { action, timeout },
  );
}

async function main(): Promise<void> {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE);
  await page.waitForFunction(() => !!window.__engine);
  await page.evaluate(() => {
    const w = window as unknown as { __lt: { start: number; dur: number }[] };
    w.__lt = [];
    new PerformanceObserver((l) => l.getEntries().forEach((e) => w.__lt.push({ start: e.startTime, dur: e.duration }))).observe({ type: 'longtask' });
  });

  // --- small pair, whitespace options --------------------------------------
  await page.evaluate(() => {
    (window as unknown as { __SA: string }).__SA = 'a\n  b c\nd\ne\nf\n';
  });
  const base = JSON.parse(
    await untilDiff(page, "e.setText('a', 'a\\n  b c\\nd\\ne\\nf\\n'); e.setText('b', 'a\\nb  c  \\nd\\nE\\nf\\n');"),
  ) as { changes: number };
  check('trim ws on: inner-space change still differs', base.changes === 2, `changes=${base.changes}`);
  const allWs = JSON.parse(await untilDiff(page, "e.setOptions({ ignoreAllWhitespace: true });")) as { changes: number };
  check('ignore all ws: whitespace-only line disappears', allWs.changes === 1, `changes=${allWs.changes}`);
  const textKept = await page.evaluate(() => window.__engine!.getText('a') === 'a\n  b c\nd\ne\nf\n' && window.__engine!.getText('b') === 'a\nb  c  \nd\nE\nf\n');
  check('ignore all ws leaves getText unchanged', textKept);
  await untilDiff(page, "e.setOptions({ ignoreAllWhitespace: false, ignoreTrimWhitespace: false });").then((s) =>
    check('trim ws off: same 2 changes (b line differs either way)', (JSON.parse(s) as { changes: number }).changes === 2, s),
  );
  await untilDiff(page, "e.setText('b', 'a\\n  b c   \\nd\\ne\\nf\\n');").then((s) =>
    check('trim ws off: trailing-space-only edit counts', (JSON.parse(s) as { changes: number }).changes === 1, s),
  );
  await untilDiff(page, "e.setOptions({ ignoreTrimWhitespace: true });").then((s) =>
    check('trim ws on: trailing-space-only edit ignored', (JSON.parse(s) as { identical: boolean; changes: number }).changes === 0, s),
  );

  // --- empty sides ---------------------------------------------------------
  await untilDiff(page, "e.setText('a', ''); e.setText('b', 'x\\ny\\n');").then((s) => {
    const st = JSON.parse(s) as { added: number; changes: number };
    check('empty A vs 3 lines: all added', st.added === 3 && st.changes === 1, s);
  });

  // --- 30k pair: nav, diff-only separators, swap, inline --------------------
  const gen = await untilDiff(page, "const g = window.__gen(30000); window.__A = g.a; window.__B = g.b; e.setText('a', g.a); e.setText('b', g.b);");
  const s30 = JSON.parse(gen) as { changes: number; added: number; removed: number };
  check('30k pair diff done', s30.changes > 50, gen);

  const pos = await page.evaluate(() => {
    const e = window.__engine!;
    const out: number[] = [];
    e.nextChange();
    out.push(e.getPosition().index);
    e.nextChange();
    out.push(e.getPosition().index);
    e.prevChange();
    e.prevChange();
    out.push(e.getPosition().index); // wraps to total
    return { out, total: e.getPosition().total };
  });
  check('next/next/prev/prev wraps', pos.out[0] === 1 && pos.out[1] === 2 && pos.out[2] === pos.total, JSON.stringify(pos));

  await page.evaluate(() => window.__engine!.setOptions({ diffOnly: true, contextLines: 2 }));
  await page.waitForTimeout(400);
  const sepCount = await page.locator('.diff-hidden-lines').count();
  const ctxOk = await page.evaluate(() => {
    // With context 2, every visible run of unchanged lines next to a separator is <= 2 lines long.
    const m = (window as unknown as { __monacoModified: () => { getVisibleRanges(): { startLineNumber: number; endLineNumber: number }[] } }).__monacoModified();
    return m.getVisibleRanges().map((r) => `${r.startLineNumber}-${r.endLineNumber}`).join(',');
  });
  console.log(`INFO visible ranges with context 2: ${ctxOk}`);
  check('diff-only shows collapsed separators', sepCount > 2, `separators=${sepCount}`);
  // Pick a separator that is on screen in the right-hand editor.
  const visibleSep = async () =>
    page.evaluate(() => {
      const all = [...document.querySelectorAll<HTMLElement>('.modified-in-monaco-diff-editor .diff-hidden-lines .center')];
      const el = all.find((e) => {
        const r = e.getBoundingClientRect();
        return r.top > 40 && r.bottom < 760 && r.width > 0;
      });
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const span = el.querySelector('.content-row > span') ?? el;
      const s = span.getBoundingClientRect();
      return { text: el.textContent ?? '', x: s.left + s.width / 2, y: r.top + r.height / 2, top: r.top };
    });
  const before = await visibleSep();
  await page.screenshot({ path: `${SHOT}/sep-before.png` });
  if (before) await page.mouse.click(before.x, before.y);
  await page.waitForTimeout(400);
  const linesAfter = await page.evaluate(() => {
    const m = (window as unknown as { __monacoModified: () => { getVisibleRanges(): { startLineNumber: number; endLineNumber: number }[] } }).__monacoModified();
    return m.getVisibleRanges().reduce((n, r) => n + r.endLineNumber - r.startLineNumber + 1, 0);
  });
  const after = await visibleSep();
  check('clicking a separator expands it in place', !!before && (after?.text !== before.text || after.top !== before.top), `"${before?.text.trim()}" @${Math.round(before?.top ?? 0)} → "${after?.text.trim()}" @${Math.round(after?.top ?? 0)}, visible lines ${linesAfter}`);
  await page.screenshot({ path: `${SHOT}/sep-after.png` });

  const navDiffOnly = await page.evaluate(async () => {
    const e = window.__engine!;
    e.goToChange(e.getPosition().total);
    await new Promise((r) => setTimeout(r, 200));
    const m = (window as unknown as { __monacoModified: () => { getPosition(): { lineNumber: number }; getVisibleRanges(): { startLineNumber: number; endLineNumber: number }[] } }).__monacoModified();
    const line = m.getPosition().lineNumber;
    const visible = m.getVisibleRanges().some((r) => r.startLineNumber <= line && line <= r.endLineNumber);
    return { index: e.getPosition().index, total: e.getPosition().total, line, visible };
  });
  check('goToChange(last) with diff-only reveals the change', navDiffOnly.visible && navDiffOnly.index === navDiffOnly.total, JSON.stringify(navDiffOnly));

  await page.evaluate(() => window.__engine!.setOptions({ diffOnly: false }));
  const same = await page.evaluate(() => {
    const w = window as unknown as { __A: string; __B: string };
    return window.__engine!.getText('a') === w.__A && window.__engine!.getText('b') === w.__B;
  });
  check('diff-only on/off: text byte-identical', same);

  const swapped = JSON.parse(await untilDiff(page, 'e.swap();')) as { added: number; removed: number; changes: number };
  const swapText = await page.evaluate(() => {
    const w = window as unknown as { __A: string; __B: string };
    return window.__engine!.getText('a') === w.__B && window.__engine!.getText('b') === w.__A;
  });
  check('swap exchanges texts and mirrors stats', swapText && swapped.added === s30.removed && swapped.removed === s30.added, JSON.stringify(swapped));
  await untilDiff(page, 'e.swap();');

  await page.evaluate(() => window.__engine!.setOptions({ viewMode: 'inline' }));
  await page.waitForTimeout(300);
  const inlineW = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.original-in-monaco-diff-editor, .modified-in-monaco-diff-editor')].map((e) => Math.round(e.getBoundingClientRect().width)),
  );
  check('inline mode: one full-width editor', (inlineW[0] ?? 0) < 100 && (inlineW[1] ?? 0) > 1400, JSON.stringify(inlineW));
  await page.screenshot({ path: `${SHOT}/inline.png` });
  await page.evaluate(() => window.__engine!.setOptions({ viewMode: 'side-by-side' }));
  await page.setViewportSize({ width: 700, height: 900 });
  await page.waitForTimeout(300);
  const narrowSbs = await page.evaluate(() => {
    const orig = document.querySelector<HTMLElement>('.original-in-monaco-diff-editor');
    return !!orig && orig.getBoundingClientRect().width > 200;
  });
  check('side-by-side stays side-by-side at 700 px', narrowSbs);
  await page.setViewportSize({ width: 1600, height: 900 });


  // --- find, folding, theme, font ------------------------------------------
  await page.evaluate(() => window.__engine!.find('b'));
  await page.waitForTimeout(300);
  check('find() opens the find widget', (await page.locator('.find-widget.visible').count()) === 1);
  await page.keyboard.press('Escape');
  const folding = await page.locator('.modified-in-monaco-diff-editor .cldr.codicon-folding-expanded, .modified-in-monaco-diff-editor .codicon-folding-expanded').count();
  check('folding controls present on B', folding > 0, `count=${folding}`);
  await page.evaluate(() => {
    window.__engine!.setTheme('light');
    window.__engine!.setOptions({ fontSize: 18 });
  });
  await page.waitForTimeout(200);
  const light = await page.evaluate(() => getComputedStyle(document.querySelector('.monaco-editor .monaco-editor-background')!).backgroundColor);
  check('light theme applies', light === 'rgb(255, 255, 254)', light); // vs background is #fffffe
  await page.screenshot({ path: `${SHOT}/light.png` });
  await page.evaluate(() => {
    window.__engine!.setTheme('dark');
    window.__engine!.setOptions({ fontSize: 13 });
  });

  // --- Monaco's own Alt+Up/Down and F7 bindings are gone --------------------
  const keys = await page.evaluate(() => window.__engine!.getText('b'));
  await page.evaluate(() => window.__engine!.focus('b'));
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Alt+ArrowUp');
  await page.keyboard.press('Alt+ArrowDown');
  await page.keyboard.press('F7');
  await page.waitForTimeout(200);
  const keysAfter = await page.evaluate(() => window.__engine!.getText('b'));
  const viewer = await page.locator('.diff-review:visible, .accessible-diff-viewer:visible').count();
  check('Alt+Up/Down do not move lines; F7 opens no diff viewer', keys === keysAfter && viewer === 0, `viewer=${viewer}`);

  // --- keyboard focus can leave the panes (Ctrl+M = Tab moves focus) -------
  const focusAt = () =>
    page.evaluate(() => {
      const a = document.activeElement;
      if (a?.closest('.original-in-monaco-diff-editor')) return 'A';
      if (a?.closest('.modified-in-monaco-diff-editor')) return 'B';
      return 'outside';
    });
  const focusTrail: string[] = [];
  for (const [mode, side] of [['side-by-side', 'a'], ['side-by-side', 'b'], ['inline', 'b']] as const) {
    await page.evaluate((m) => window.__engine!.setOptions({ viewMode: m }), mode);
    await page.waitForTimeout(150);
    const textBefore = await page.evaluate(() => window.__engine!.getText('a') + '\u0000' + window.__engine!.getText('b'));
    await page.evaluate((s) => window.__engine!.focus(s), side);
    await page.keyboard.press('Control+m');
    await page.keyboard.press(side === 'a' ? 'Shift+Tab' : 'Tab');
    const out = await focusAt();
    await page.evaluate((s) => window.__engine!.focus(s), side);
    await page.keyboard.press('Shift+Tab');
    const back = await focusAt();
    await page.evaluate((s) => window.__engine!.focus(s), side);
    await page.keyboard.press('Control+m'); // tab focus mode off again
    const textAfter = await page.evaluate(() => window.__engine!.getText('a') + '\u0000' + window.__engine!.getText('b'));
    focusTrail.push(`${mode}/${side}: tab→${out} shift-tab→${back}${textBefore === textAfter ? '' : ' TEXT CHANGED'}`);
  }
  await page.evaluate(() => window.__engine!.setOptions({ viewMode: 'side-by-side' }));
  check(
    'Ctrl+M then Tab/Shift+Tab leaves the panes; inline skips hidden A',
    focusTrail.join('|') === 'side-by-side/a: tab→outside shift-tab→outside|side-by-side/b: tab→outside shift-tab→A|inline/b: tab→outside shift-tab→outside',
    focusTrail.join(' | '),
  );

  // --- paste 10 MB into an empty pane --------------------------------------
  await untilDiff(page, "e.setText('a', ''); e.setText('b', '');");
  const paste = await page.evaluate(async () => {
    const e = window.__engine!;
    const big = window.__gen!(180_000).a; // ~10 MB
    const events: string[] = [];
    const offs = [e.on('paste', (p) => events.push(`paste:${p.side}:${p.sample.length}`)), e.on('content', (c) => events.push(`content:${c.side}:${c.lines}`))];
    e.focus('a');
    const target = document.activeElement as HTMLElement;
    const dt = new DataTransfer();
    dt.setData('text/plain', big);
    performance.clearMarks('sidediff:first-render:a');
    const t0 = performance.now();
    target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    const tSync = performance.now() - t0;
    await new Promise<void>((r) => {
      const poll = () => (performance.getEntriesByName('sidediff:first-render:a').length ? r() : setTimeout(poll, 20));
      poll();
    });
    const fr = performance.getEntriesByName('sidediff:first-render:a')[0]!.startTime - t0;
    await new Promise((r) => setTimeout(r, 50));
    offs.forEach((o) => o());
    return { mb: big.length / 1e6, tSync: Math.round(tSync), firstRender: Math.round(fr), same: e.getText('a') === big, events, target: target.tagName + '.' + target.className };
  });
  check(
    `paste ${paste.mb.toFixed(1)} MB into empty A lands fast`,
    paste.same && paste.firstRender < 2000 && paste.events.some((x) => x.startsWith('paste:a:8192')),
    JSON.stringify(paste),
  );

  // Small paste into a non-empty pane goes through Monaco and still emits paste.
  const small = await page.evaluate(async () => {
    const e = window.__engine!;
    let got = '';
    const off = e.on('paste', (p) => (got = p.sample));
    e.focus('a');
    const dt = new DataTransfer();
    dt.setData('text/plain', 'XYZ');
    (document.activeElement as HTMLElement).dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 50));
    off();
    return { got, starts: e.getText('a').slice(0, 3) };
  });
  check('small paste into non-empty pane uses Monaco and emits paste', small.got === 'XYZ' && small.starts === 'XYZ', JSON.stringify(small));

  // --- pathological: two unrelated 150k files ------------------------------
  const unrelated = await untilDiff(
    page,
    "const a = window.__gen(150000).a; const b = a.split('\\n').map((l, i) => i % 2 ? l + ' x' : 'y' + l).join('\\n'); window.__t0 = performance.now(); e.setText('a', a); e.setText('b', b);",
    70_000,
  );
  const tU = await page.evaluate(() => Math.round(performance.now() - (window as unknown as { __t0: number }).__t0));
  console.log(`INFO unrelated 150k pair (every line differs): ${tU} ms → ${unrelated.slice(0, 200)}`);
  check('unrelated pair finishes (approximate) within the hard limit + apply', !unrelated.startsWith('error') && tU < 15_000, `${tU} ms`);
  const lt = await page.evaluate(() => {
    const w = window as unknown as { __lt: { start: number; dur: number }[]; __t0: number };
    return w.__lt.filter((l) => l.start >= w.__t0).map((l) => Math.round(l.dur));
  });
  console.log(`INFO long tasks during unrelated run (ms): [${lt.join(', ')}]`);
  const freed = await untilDiff(page, "e.setText('b', e.getText('a').replace('Generated', 'Changed'));");
  check("worker is free again after the capped run", freed.includes('"changes":1'), freed.slice(0, 120));

  // --- a newer setText abandons a running (slow) diff ----------------------
  const sup = await page.evaluate(async () => {
    const e = window.__engine!;
    const g = window.__gen!(150_000);
    const unrelated = g.a.split('\n').map((l, i) => (i % 2 ? l + ' x' : 'y' + l)).join('\n');
    const before = window.__supersededRuns!();
    const done: { t: number; changes: number; quitEarly: boolean }[] = [];
    const off = e.on('diff:done', (s) => done.push({ t: performance.now(), changes: s.changes, quitEarly: s.quitEarly }));
    e.setText('a', unrelated);
    e.setText('b', g.b); // slow: every line differs, runs toward the 10 s budget
    await new Promise((r) => setTimeout(r, 300));
    const t0 = performance.now();
    e.setText('a', g.a); // the real pair
    await new Promise<void>((r) => {
      const poll = () => (done.some((d) => d.t > t0) ? r() : setTimeout(poll, 20));
      poll();
    });
    off();
    const last = done[done.length - 1]!;
    return { ms: Math.round(last.t - t0), changes: last.changes, quitEarly: last.quitEarly, superseded: window.__supersededRuns!() - before, doneCount: done.length };
  });
  check(
    'newer setText abandons the running diff (no wait for the stale run)',
    sup.ms < 3000 && !sup.quitEarly && sup.changes > 100 && sup.superseded >= 1 && sup.doneCount === 1,
    JSON.stringify(sup),
  );

  // --- events: diff:start on option changes; degraded enter/leave ----------
  const ev = await page.evaluate(async () => {
    const e = window.__engine!;
    const seen: string[] = [];
    const offs = [
      e.on('diff:start', () => seen.push('start')),
      e.on('diff:done', () => seen.push('done')),
      e.on('degraded', (d) => seen.push(d ? `degraded:${d.sides.join(',')}` : 'degraded:null')),
    ];
    const wait = () => new Promise<void>((r) => { const off = e.on('diff:done', () => { off(); r(); }); });
    let w = wait(); e.setText('a', 'a\nb\n'); e.setText('b', 'a\nc\n'); await w;
    seen.push('|');
    w = wait(); e.setOptions({ ignoreTrimWhitespace: false }); await w;
    seen.push('|');
    w = wait(); e.setOptions({ ignoreAllWhitespace: true }); await w;
    seen.push('|');
    w = wait(); e.setOptions({ ignoreAllWhitespace: false, ignoreTrimWhitespace: true }); await w;
    seen.push('|');
    w = wait(); e.setText('a', 'x\n'.repeat(400_001)); await w;
    seen.push('|');
    w = wait(); e.setText('a', 'a\nb\n'); await w;
    offs.forEach((o) => o());
    return seen.join(' ');
  });
  check(
    'diff:start on option changes; degraded enters and leaves with null',
    ev === 'start done | start done | start done | start done | degraded:a start done | degraded:null start done',
    ev,
  );

  // Word wrap survives a trip through inline (Monaco left A's wordWrapOverride2 'off').
  const wrapWidths = async (): Promise<number[]> =>
    page.evaluate(() =>
      ['.original-in-monaco-diff-editor', '.modified-in-monaco-diff-editor'].map((sel) => {
        const v = document.querySelector<HTMLElement>(`${sel} .view-lines`);
        const ed = document.querySelector<HTMLElement>(sel);
        return v && ed ? Math.round(v.scrollWidth / ed.getBoundingClientRect().width * 100) / 100 : -1;
      }),
    );
  await untilDiff(
    page,
    "const l = (c) => Array.from({ length: 60 }, (_, i) => c.repeat(3000) + i).join('\\n'); e.setText('a', l('x')); e.setText('b', l('x').replace('x0', 'y0'));",
  );
  await page.evaluate(() => window.__engine!.setOptions({ wordWrap: true }));
  await page.waitForTimeout(300);
  const wrapBefore = await wrapWidths();
  await page.evaluate(() => window.__engine!.setOptions({ viewMode: 'inline' }));
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__engine!.setOptions({ viewMode: 'side-by-side' }));
  await page.waitForTimeout(300);
  const wrapAfter = await wrapWidths();
  await page.evaluate(() => window.__engine!.setOptions({ wordWrap: false }));
  await page.waitForTimeout(300);
  const unwrapped = await wrapWidths();
  // Ratio of content width to pane width: <= ~1 when wrapped, well above 1 with the 600-char lines unwrapped.
  check(
    'word wrap on A survives inline → side-by-side',
    wrapBefore.every((r) => r > 0 && r <= 1.05) && wrapAfter.every((r) => r > 0 && r <= 1.05) && unwrapped.every((r) => r > 1.5),
    `wrapped ${JSON.stringify(wrapBefore)} → after inline trip ${JSON.stringify(wrapAfter)}; wrap off ${JSON.stringify(unwrapped)}`,
  );

  // --- whole-text undo (D13) ------------------------------------------------
  const waitDone = (): Promise<void> =>
    page.evaluate(
      () =>
        new Promise<void>((r) => {
          const off = window.__engine!.on('diff:done', () => {
            off();
            r();
          });
        }),
    );
  const settle = async (action: () => Promise<unknown>): Promise<void> => {
    const d = waitDone();
    await action();
    await d;
  };
  await settle(() =>
    page.evaluate(() => {
      const e = window.__engine!;
      e.setText('a', 'alpha 1\r\nalpha 2\n\talpha 3 é中\n');
      e.setText('b', 'beta 1\nbeta 2\n');
    }),
  );
  const undoClear = await page.evaluate(() => {
    const e = window.__engine!;
    const events: string[] = [];
    const off = e.on('history', (h) => events.push(`${h.action}:${h.side}:${h.reason}`));
    const before = e.getText('b');
    e.replaceText('b', '', 'clear');
    const cleared = e.getText('b') === '';
    const undone = e.undoReplace('b') && e.getText('b') === before;
    const redone = e.redoReplace('b') && e.getText('b') === '';
    e.undoReplace();
    off();
    return { cleared, undone, redone, back: e.getText('b') === before, events: events.join(' ') };
  });
  check(
    'undo/redo of clear restores B byte-identical',
    undoClear.cleared && undoClear.undone && undoClear.redone && undoClear.back && undoClear.events === 'undo:b:clear redo:b:clear undo:b:clear',
    JSON.stringify(undoClear),
  );

  // Paste-replace-all, then Ctrl+Z / Ctrl+Y from the keyboard inside pane A.
  const textA0 = await page.evaluate(() => window.__engine!.getText('a'));
  await page.evaluate(() => window.__engine!.focus('a'));
  await page.keyboard.press('Control+a');
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text/plain', 'pasted\nover everything\n');
    (document.activeElement as HTMLElement).dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  const afterPaste = await page.evaluate(() => window.__engine!.getText('a'));
  await page.evaluate(() => window.__engine!.focus('a'));
  await page.keyboard.press('Control+z');
  const afterUndo = await page.evaluate(() => window.__engine!.getText('a'));
  await page.keyboard.press('Control+y');
  const afterRedo = await page.evaluate(() => window.__engine!.getText('a'));
  await page.keyboard.press('Control+Shift+z'); // nothing left to redo: no change
  const afterRedo2 = await page.evaluate(() => window.__engine!.getText('a'));
  check(
    'paste-replace: Ctrl+Z restores, Ctrl+Y re-applies (keyboard, in the pane)',
    afterPaste === 'pasted\nover everything\n' && afterUndo === textA0 && afterRedo === afterPaste && afterRedo2 === afterPaste,
    JSON.stringify({ afterPaste, afterUndo: afterUndo === textA0, afterRedo: afterRedo === afterPaste }),
  );

  // Typed edits stay on Monaco's own stack; once it is empty Ctrl+Z falls through.
  await page.evaluate(() => window.__engine!.focus('a'));
  await page.keyboard.press('Control+Home');
  await page.keyboard.type('zz');
  const typed = await page.evaluate(() => window.__engine!.getText('a'));
  await page.keyboard.press('Control+z');
  const typedUndone = await page.evaluate(() => window.__engine!.getText('a'));
  await page.keyboard.press('Control+z');
  const fellThrough = await page.evaluate(() => window.__engine!.getText('a'));
  check(
    'typed edit undoes on Monaco stack first, then Ctrl+Z falls through to the replace',
    typed.startsWith('zzpasted') && typedUndone === afterPaste && fellThrough === textA0,
    JSON.stringify({ typed: typed.slice(0, 12), typedUndone: typedUndone === afterPaste, fellThrough: fellThrough === textA0 }),
  );

  // Load and swap; typing after an undo clears that side's redo.
  const loadSwap = await page.evaluate(() => {
    const e = window.__engine!;
    const a0 = e.getText('a');
    const b0 = e.getText('b');
    e.replaceText('a', 'loaded\n', 'load');
    const loadUndo = e.undoReplace('a') && e.getText('a') === a0;
    e.swap();
    const swapped = e.getText('a') === b0 && e.getText('b') === a0;
    let side = '';
    const off = e.on('history', (h) => (side = `${h.side}:${h.reason}`));
    const swapUndo = e.undoReplace() && e.getText('a') === a0 && e.getText('b') === b0;
    off();
    const canRedoSwap = e.canRedoReplace('a');
    return { loadUndo, swapped, swapUndo, side, canRedoSwap };
  });
  check(
    'load undoes; swap undoes in one step for both sides',
    loadSwap.loadUndo && loadSwap.swapped && loadSwap.swapUndo && loadSwap.side === 'both:swap' && loadSwap.canRedoSwap,
    JSON.stringify(loadSwap),
  );
  await page.evaluate(() => window.__engine!.focus('a'));
  await page.keyboard.type('q');
  const redoCleared = await page.evaluate(() => ({ a: window.__engine!.canRedoReplace('a'), b: window.__engine!.canRedoReplace('b') }));
  check('typing after an undo clears that side\'s redo (swap touched both)', !redoCleared.a && !redoCleared.b, JSON.stringify(redoCleared));

  const bound = await page.evaluate(() => {
    const e = window.__engine!;
    for (let i = 0; i < 14; i++) e.replaceText('b', `b${i}\n`, 'set');
    let undos = 0;
    while (e.undoReplace('b')) undos++;
    return { undos, text: e.getText('b') };
  });
  check('history keeps 10 entries per side', bound.undos === 10 && bound.text === 'b3\n', JSON.stringify(bound));

  // --- item views ---------------------------------------------------------
  await settle(() =>
    page.evaluate(() => {
      const g = window.__gen!(30_000);
      const w = window as unknown as { __VA: string; __VB: string };
      w.__VA = g.a;
      w.__VB = g.b;
      window.__engine!.setText('a', g.a);
      window.__engine!.setText('b', g.b);
    }),
  );
  await page.evaluate(() => window.__engine!.setOptions({ diffOnly: true }));
  await page.evaluate(() => window.__engine!.goToChange(40));
  await page.waitForTimeout(400);
  const fullState = await page.evaluate(() => {
    const m = window.__monacoModified!()!;
    return { top: m.getScrollTop(), line: m.getPosition()?.lineNumber, pos: window.__engine!.getPosition().index };
  });
  const viewEvents: string[] = [];
  await page.exposeFunction('__viewEvent', (k: string) => viewEvents.push(k));
  await page.evaluate(() => {
    window.__engine!.on('view', (v) => (window as unknown as { __viewEvent: (k: string) => void }).__viewEvent(String(v.key)));
  });
  await settle(() =>
    page.evaluate(() =>
      window.__engine!.openView({ key: 'Graph:Foo#code', a: 'class Foo {\n  int x = 1;\n}\n', b: 'class Foo {\n  int x = 2;\n}\n', language: 'csharp' }),
    ),
  );
  const inView = await page.evaluate(() => {
    const e = window.__engine!;
    const w = window as unknown as { __VA: string; __VB: string };
    return { key: e.getView(), stats: e.getStats(), full: e.getText('a') === w.__VA && e.getText('b') === w.__VB };
  });
  await page.evaluate(() => window.__engine!.focus('b'));
  await page.keyboard.type('typed into view');
  const readOnly = await page.evaluate(() => {
    const m = window.__monacoModified!()?.getModel();
    return m?.getValue() === 'class Foo {\n  int x = 2;\n}\n';
  });
  await page.screenshot({ path: `${SHOT}/item-view.png` });
  await settle(() => page.evaluate(() => window.__engine!.closeView()));
  await page.waitForTimeout(200);
  const restored = await page.evaluate(() => {
    const m = window.__monacoModified!()!;
    return { top: m.getScrollTop(), line: m.getPosition()?.lineNumber, key: window.__engine!.getView() };
  });
  check(
    'item view: shows the item, read-only, full texts untouched',
    inView.key === 'Graph:Foo#code' && inView.stats?.changes === 1 && inView.stats.modified === 1 && inView.full && readOnly,
    JSON.stringify({ ...inView, readOnly }),
  );
  check(
    'closeView restores the full view scroll and cursor',
    restored.key === null && restored.top === fullState.top && restored.line === fullState.line && viewEvents.join(',') === 'Graph:Foo#code,null',
    JSON.stringify({ fullState, restored, viewEvents }),
  );

  await settle(() => page.evaluate(() => window.__engine!.openView({ key: 'Sql:X#code', a: null, b: 'select 1\nfrom t\n', language: 'plaintext' })));
  const nullSide = await page.evaluate(() => window.__engine!.getStats());
  const replaceInView = await page.evaluate(() => {
    const e = window.__engine!;
    e.replaceText('a', 'changed full A\n', 'load');
    return { key: e.getView(), full: e.getText('a') };
  });
  await settle(() => page.evaluate(() => window.__engine!.closeView()));
  const afterClose = await page.evaluate(() => ({ stats: window.__engine!.getStats(), a: window.__engine!.getText('a') }));
  check(
    'view with a null side; replaceText during a view updates the full text only',
    nullSide?.added === 3 && nullSide.linesA === 1 && replaceInView.key === 'Sql:X#code' && replaceInView.full === 'changed full A\n' && afterClose.a === 'changed full A\n',
    JSON.stringify({ nullSide, replaceInView, afterClose: afterClose.stats }),
  );

  await settle(() => page.evaluate(() => window.__engine!.openView({ key: 'k', a: 'a\n', b: 'b\n', language: 'xml' })));
  await settle(() => page.evaluate(() => window.__engine!.revealLine('b', 20_000)));
  const revealed = await page.evaluate(() => {
    const m = window.__monacoModified!()!;
    const line = m.getPosition()?.lineNumber ?? 0;
    return { key: window.__engine!.getView(), line, visible: m.getVisibleRanges().some((r) => r.startLineNumber <= line && line <= r.endLineNumber) };
  });
  check('revealLine closes the view and centres the line', revealed.key === null && revealed.line === 20_000 && revealed.visible, JSON.stringify(revealed));
  await page.evaluate(() => window.__engine!.setOptions({ diffOnly: false }));

  // dispose() frees every model the engine made, history and views included.
  const leak = await page.evaluate(() => {
    const before = window.__liveModels!();
    const host = document.createElement('div');
    host.style.cssText = 'position:absolute;width:400px;height:200px;left:-9999px';
    document.body.append(host);
    const e2 = window.__createEngine!();
    e2.mount(host);
    for (let i = 0; i < 5; i++) e2.replaceText('a', `x${i}\n`, 'load');
    e2.swap();
    e2.undoReplace();
    e2.openView({ key: 'v', a: 'p\n', b: null, language: 'plaintext' });
    const during = window.__liveModels!();
    e2.dispose();
    host.remove();
    return { before, during, after: window.__liveModels!() };
  });
  check('dispose frees every kept model', leak.during > leak.before && leak.after === leak.before, JSON.stringify(leak));

  check('no console errors', errors.length === 0, errors.slice(0, 5).join(' | '));
  await browser.close();
  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
