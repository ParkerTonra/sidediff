// Section 9 on the 150k-line pair: stats within tolerance, diff only
// (collapse, expand a separator, restore, byte-identical text), navigation
// buttons and shortcuts, whitespace options, language auto-detect.
import type { Page } from '@playwright/test';
import { clickEditor, afterRediff, changePosition, expect, loadPair, openApp, statValue, test, textHash, tid, visibleLinesB, withinTolerance } from './helpers.ts';
import type { ChangesJson, StatKey } from './helpers.ts';

// Tests share one loaded page (the pair takes seconds to load) and run in file order.

let page: Page;
let c: ChangesJson;
const KEYS: StatKey[] = ['added', 'removed', 'modified', 'changes'];

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await openApp(page);
  c = await loadPair(page, 'large');
});
test.afterAll(async () => {
  await page.close();
});

test('large pair: loaded byte-exact, stats within changes.json tolerance', async () => {
  expect(await textHash(page, 'a')).toBe(c.a.sha256);
  expect(await textHash(page, 'b')).toBe(c.b.sha256);
  for (const k of KEYS) {
    const actual = await statValue(page, k);
    expect(withinTolerance(actual, c.expected.trimWhitespace[k], c.tolerance), `${k}: ${actual} vs ${c.expected.trimWhitespace[k]}`).toBe(true);
  }
  await expect(tid(page, 'empty-hint-a')).toBeHidden();
  await expect(tid(page, 'degraded-warning')).toBeHidden();
});

test('language auto-detect picks XML for the XML fixture', async () => {
  await expect(tid(page, 'select-language')).toHaveValue('xml');
});

test('diff only collapses, a separator expands on click, off restores, text byte-identical', async () => {
  const before = [await textHash(page, 'a'), await textHash(page, 'b')];
  const fullView = await visibleLinesB(page);

  await tid(page, 'btn-diff-only').click();
  await expect(tid(page, 'btn-diff-only')).toHaveAttribute('aria-pressed', 'true');
  const separators = page.locator('.monaco-diff-editor .diff-hidden-lines .center');
  await expect(separators.filter({ visible: true }).first()).toBeVisible();
  const hiddenText = (await separators.filter({ visible: true }).first().textContent()) ?? '';
  expect(hiddenText).toMatch(/\d[\d,]* hidden lines/);

  // Context lines: fewer context lines hide more lines in the same separators.
  const hiddenSum = (): Promise<number> =>
    page.evaluate(() =>
      [...document.querySelectorAll('.monaco-diff-editor .editor.modified .diff-hidden-lines')]
        .map((e) => Number(/([\d,]+) hidden lines/.exec(e.textContent ?? '')?.[1]?.replace(/,/g, '') ?? 0))
        .reduce((x, y) => x + y, 0),
    );
  await expect(tid(page, 'input-context-lines')).toHaveValue('3');

  // Expand the first separator in view: the lines it hid become visible.
  const collapsedMax = Math.max(...(await visibleLinesB(page)));
  const sumBefore = await hiddenSum();
  await page.locator('.monaco-diff-editor .editor.modified .diff-hidden-lines a.default-control').first().click();
  await expect.poll(async () => Math.max(...(await visibleLinesB(page)))).toBeLessThan(collapsedMax);
  await expect.poll(hiddenSum).not.toBe(sumBefore);

  await tid(page, 'btn-diff-only').click();
  await expect(tid(page, 'btn-diff-only')).toHaveAttribute('aria-pressed', 'false');
  await expect(separators).toHaveCount(0);
  expect(await visibleLinesB(page)).toEqual(fullView);
  expect([await textHash(page, 'a'), await textHash(page, 'b')]).toEqual(before);
  expect(before).toEqual([c.a.sha256, c.b.sha256]);
});

test('Alt+H toggles diff only', async () => {
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Alt+h');
  await expect(tid(page, 'btn-diff-only')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Alt+h');
  await expect(tid(page, 'btn-diff-only')).toHaveAttribute('aria-pressed', 'false');
});

test('context lines input changes how much is hidden, both up and down', async () => {
  await tid(page, 'btn-diff-only').click();
  await page.evaluate(() => window.__sidediff?.engine.goToChange(5));
  // Hidden-line counts of the separators on screen, top to bottom.
  const onScreen = (): Promise<string> =>
    page.evaluate(() =>
      [...document.querySelectorAll('.monaco-diff-editor .editor.modified .diff-hidden-lines')]
        .filter((e) => e.getBoundingClientRect().y > 0)
        .map((e) => /([\d,]+) hidden lines/.exec(e.textContent ?? '')?.[1] ?? '?')
        .join(' '),
    );
  const setContext = async (n: number): Promise<void> => {
    await tid(page, 'input-context-lines').fill(String(n));
    await tid(page, 'input-context-lines').press('Enter');
  };
  try {
    await expect.poll(onScreen).not.toBe('');
    const at3 = await onScreen();
    await setContext(10);
    await expect.poll(onScreen, { message: 'raising context lines 3 → 10 shows more lines' }).not.toBe(at3);
    await setContext(3);
    await expect.poll(onScreen, { message: 'lowering context lines 10 → 3 restores the original separators' }).toBe(at3);
    await setContext(0);
    await expect.poll(onScreen, { message: 'lowering context lines 3 → 0 hides more lines' }).not.toBe(at3);
  } finally {
    await setContext(3);
    await tid(page, 'btn-diff-only').click();
    await expect(tid(page, 'btn-diff-only')).toHaveAttribute('aria-pressed', 'false');
  }
});

test('next/prev buttons and F7/Shift+F7/Alt+Down/Alt+Up update "change N of M" and move the viewport', async () => {
  const total = c.expected.trimWhitespace.changes;
  await tid(page, 'btn-next').click();
  const [first, m] = await changePosition(page);
  expect(m).toBe(await statValue(page, 'changes'));
  expect(withinTolerance(m, total, c.tolerance)).toBe(true);
  expect(first).toBeGreaterThanOrEqual(1);

  const expectAt = async (n: number): Promise<void> => {
    await expect.poll(async () => (await changePosition(page))[0]).toBe(n);
  };
  await tid(page, 'btn-next').click();
  await expectAt(first + 1);
  await tid(page, 'btn-prev').click();
  await expectAt(first);

  // Shortcuts work with focus inside the editor (capture phase).
  await clickEditor(page, 'b');
  // Navigation is relative to the cursor, and the click just moved it: re-anchor (focus stays in B).
  await page.evaluate((n) => window.__sidediff?.engine.goToChange(n), first);
  await expectAt(first);
  expect(await page.evaluate(() => !!document.activeElement?.closest('.monaco-diff-editor'))).toBe(true);
  await page.keyboard.press('F7');
  await expectAt(first + 1);
  await page.keyboard.press('Shift+F7');
  await expectAt(first);
  await page.keyboard.press('Alt+ArrowDown');
  await expectAt(first + 1);
  await page.keyboard.press('Alt+ArrowUp');
  await expectAt(first);
  // Alt+Up/Down must not move lines in Monaco.
  expect(await textHash(page, 'b')).toBe(c.b.sha256);

  // Wrap around to the last change: the viewport lands near the end of B.
  await page.evaluate(() => window.__sidediff?.engine.goToChange(1));
  await expectAt(1);
  await tid(page, 'btn-prev').click();
  await expectAt(m);
  await expect.poll(async () => Math.max(...(await visibleLinesB(page)))).toBeGreaterThan(c.b.lines * 0.8);
  await tid(page, 'btn-next').click();
  await expectAt(1);
  await expect.poll(async () => Math.min(...(await visibleLinesB(page)))).toBeLessThan(c.b.lines * 0.2);
});

test('trim-whitespace changes the result: whitespace-only edits appear when off', async () => {
  const checkbox = tid(page, 'opt-trim-ws');
  await expect(checkbox).toBeChecked();
  await afterRediff(page, () => checkbox.uncheck());
  for (const k of KEYS) {
    const actual = await statValue(page, k);
    expect(withinTolerance(actual, c.expected.noTrimWhitespace[k], c.tolerance), `${k}: ${actual} vs ${c.expected.noTrimWhitespace[k]}`).toBe(true);
  }
  expect(await statValue(page, 'changes')).toBeGreaterThan(c.expected.trimWhitespace.changes);
  await afterRediff(page, () => checkbox.check());
  expect(await statValue(page, 'changes')).toBe(c.expected.trimWhitespace.changes);
});

test('ignore-all-whitespace never changes the displayed text', async () => {
  await afterRediff(page, () => tid(page, 'opt-ignore-all-ws').check());
  expect(await textHash(page, 'a')).toBe(c.a.sha256);
  expect(await textHash(page, 'b')).toBe(c.b.sha256);
  expect(await statValue(page, 'changes')).toBeLessThanOrEqual(c.expected.trimWhitespace.changes);
  await afterRediff(page, () => tid(page, 'opt-ignore-all-ws').uncheck());
});
