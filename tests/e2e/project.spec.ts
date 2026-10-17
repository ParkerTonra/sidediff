// Phase 4 acceptance 1-5 and 7 (docs/INTERFACES.md "Project explorer and
// whole-text undo"). Item 6 (indexing time / long tasks) is in `pnpm bench`.
import type { Locator, Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { closeOverview, clickEditor, expect, fixturePath, loadFile, openApp, ROOT, statValue, test, textHash, tid, visibleLinesB, waitForDiff } from './helpers.ts';
import { join } from 'node:path';

interface Item {
  id: string;
  element: string;
  key: string;
  group: string;
  name: string;
  status: 'same' | 'whitespace' | 'modified' | 'only-a' | 'only-b';
  views: ('code' | 'xml')[];
}
interface ProjectSidecar {
  a: { file: string; lines: number; sha256: string; root: Record<string, string> };
  b: { file: string; lines: number; sha256: string; root: Record<string, string> };
  counts: { total: number; byStatus: Record<Item['status'], number>; byGroup: Record<string, number> };
  cdataSplit: { id: string; mustContain: string };
  relatedScreen: { screenId: string; ids: string[] };
  pageSource: { id: string; mustContain: string };
  items: Item[];
}
const P = JSON.parse(readFileSync(join(ROOT, 'fixtures', 'project.changes.json'), 'utf8')) as ProjectSidecar;
const GLYPH: Record<Item['status'], string> = { modified: '~', whitespace: '≈', 'only-a': '−', 'only-b': '+', same: '=' };
const GROUPS = ['code', 'screens', 'tables', 'sql', 'reports', 'inquiries', 'sitemap', 'integration', 'security', 'files', 'assemblies', 'images', 'other'];

const find = (pred: (i: Item) => boolean, what: string): Item => {
  const it = P.items.find(pred);
  if (!it) throw new Error(`fixture has no ${what}`);
  return it;
};
const onlyAGraph = find((i) => i.status === 'only-a' && i.element === 'Graph', 'only-A Graph');
const modifiedGraph = find((i) => i.status === 'modified' && i.element === 'Graph', 'modified Graph');
const wsGraph = find((i) => i.status === 'whitespace' && i.element === 'Graph', 'whitespace Graph');
const onlyBGraph = find((i) => i.status === 'only-b' && i.element === 'Graph', 'only-B Graph');

const cssStr = (s: string): string => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
/** Row for an item, by its exact id. */
const row = (page: Page, it: Item): Locator =>
  page.locator(`[data-testid="explorer-item"][data-id="${cssStr(it.id)}"]`);
const view = (page: Page): Promise<string | null> =>
  page.evaluate(() => (window.__sidediff?.engine as unknown as { getView?: () => string | null }).getView?.() ?? null);
const paneText = (page: Page, side: 'a' | 'b'): Promise<string> =>
  page.locator(`.monaco-diff-editor .editor.${side === 'a' ? 'original' : 'modified'} .view-lines`).first().innerText();

async function loadProject(page: Page): Promise<void> {
  await openApp(page);
  await expect(tid(page, 'explorer')).toBeHidden();
  await loadFile(page, 'a', P.a.file);
  await loadFile(page, 'b', P.b.file);
  await waitForDiff(page, P.a.lines, P.b.lines);
  await expect(tid(page, 'explorer')).toBeVisible({ timeout: 10_000 });
  await closeOverview(page);
  await tid(page, 'filter-all').click();
  await expect(page.getByTestId('explorer-item')).toHaveCount(P.counts.total, { timeout: 10_000 });
}

async function openItem(page: Page, it: Item, codeView = true): Promise<void> {
  await row(page, it).scrollIntoViewIfNeeded();
  await row(page, it).click();
  await expect(tid(page, 'item-bar')).toBeVisible();
  await expect.poll(() => view(page)).toContain(it.id.split(':')[0]);
  await expect(tid(page, 'item-bar')).toContainText(it.name);
  // Phase 5: items with a summary open on it; these tests look at the code/text view.
  const code = tid(page, 'item-view-code');
  if (codeView && (await code.isVisible().catch(() => false))) {
    await code.click();
    await expect.poll(() => view(page)).toMatch(/#code$/);
  }
}

test.use({ viewport: { width: 1600, height: 1000 } });

test('1. drawer lists every item with the sidecar status, groups in order, Other last, versions shown', async ({ page }) => {
  await loadProject(page);
  const rows = await page.getByTestId('explorer-item').evaluateAll((els) => els.map((e) => [(e as HTMLElement).dataset.id ?? '', (e as HTMLElement).dataset.status ?? '', e.textContent ?? '']));
  const byId = new Map(rows.map(([id, status, text]) => [id, { status, text }]));
  for (const it of P.items) {
    const hit = byId.get(it.id);
    expect(hit, `row for ${it.id}`).toBeDefined();
    expect(hit?.status, it.id).toBe(it.status);
    expect(hit?.text, `${it.id} glyph`).toContain(GLYPH[it.status]);
    expect(hit?.text, `${it.id} name`).toContain(it.name);
  }

  const present = GROUPS.filter((g) => (P.counts.byGroup[g] ?? 0) > 0);
  const shown = await page.locator('[data-testid^="explorer-group-"]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.testid?.replace('explorer-group-', '')));
  expect(shown).toEqual(present);
  expect(shown.at(-1)).toBe('other');
  for (const g of present) await expect(tid(page, `explorer-group-${g}`)).toContainText(String(P.counts.byGroup[g]));

  await expect(tid(page, 'filter-only-a')).toContainText(String(P.counts.byStatus['only-a']));
  await expect(tid(page, 'filter-only-b')).toContainText(String(P.counts.byStatus['only-b']));
  const changed = P.counts.byStatus.modified + P.counts.byStatus.whitespace + P.counts.byStatus['only-a'] + P.counts.byStatus['only-b'];
  await expect(tid(page, 'filter-changed')).toContainText(String(changed));
  await expect(tid(page, 'btn-explorer')).toContainText(String(P.counts.total));
  await tid(page, 'filter-changed').click();
  await expect(page.getByTestId('explorer-item')).toHaveCount(changed);
  await tid(page, 'filter-only-a').click();
  await expect(page.getByTestId('explorer-item')).toHaveCount(P.counts.byStatus['only-a']);

  await expect(tid(page, 'explorer')).toContainText(P.a.root['product-version'] ?? '');
  await expect(tid(page, 'explorer')).toContainText(P.b.root['product-version'] ?? '');

  // Ctrl+B toggles the drawer.
  await page.locator('body').click({ position: { x: 800, y: 5 } });
  await page.keyboard.press('Control+B');
  await expect(tid(page, 'explorer')).toBeHidden();
  await page.keyboard.press('Control+B');
  await expect(tid(page, 'explorer')).toBeVisible();
});

test('1b. the CDATA split around "]]>" is joined in the code view', async ({ page }) => {
  await loadProject(page);
  const text = await page.evaluate(
    ([id]) => (window.__sidediff?.project ? window.__sidediff.project.viewText(id as string, 'code', 'a') : null),
    [P.cdataSplit.id] as const,
  );
  expect(text).toContain(P.cdataSplit.mustContain);
  expect(text).not.toContain('<![CDATA[');
});

test('1c. a Page opens on its decoded pageSource (ASPX), and Related links the screen\'s other pieces', async ({ page }) => {
  await loadProject(page);
  const pg = find((i) => i.id === P.pageSource.id, 'pageSource page');
  await openItem(page, pg);
  await expect(page.locator('.monaco-diff-editor .editor.original .view-lines')).toContainText('<%@ Page');
  const related = tid(page, 'item-related');
  await expect(related).toBeVisible();
  const others = P.relatedScreen.ids.filter((id) => id !== pg.id);
  for (const id of others) await expect(related, id).toContainText(find((i) => i.id === id, id).name);
  // One click opens a related piece (the site map entry).
  const sm = find((i) => i.id === `SiteMapNode:${P.relatedScreen.screenId}`, 'related site map node');
  await related.locator(`[data-id="${sm.id}"]`).first().click();
  await expect.poll(() => view(page)).toContain(sm.id);
});

test('2. an item only in A shows − and opens with an empty B and "Not in B"', async ({ page }) => {
  await loadProject(page);
  await expect(row(page, onlyAGraph)).toHaveAttribute('data-status', 'only-a');
  await expect(row(page, onlyAGraph)).toContainText('−');
  await openItem(page, onlyAGraph);
  await expect(tid(page, 'missing-hint-b')).toBeVisible();
  await expect(tid(page, 'missing-hint-b')).toContainText('Not in B');
  await expect(tid(page, 'missing-hint-a')).toBeHidden();
  await expect.poll(() => paneText(page, 'a')).toMatch(/namespace|using/);
  expect((await paneText(page, 'b')).trim()).toBe('');
  // Full texts are untouched by an item view.
  expect(await textHash(page, 'a')).toBe(P.a.sha256);
  expect(await textHash(page, 'b')).toBe(P.b.sha256);
});

test('3. modified Graph: C# code diff with intra-line changes; diff only, navigation, whitespace, ‹ ›, Back restores scroll', async ({ page }) => {
  await loadProject(page);
  // Park the full diff somewhere recognisable before opening an item.
  await page.evaluate(() => window.__sidediff?.engine.goToChange(12));
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const fullView = await visibleLinesB(page);

  await openItem(page, modifiedGraph);
  await expect(page.locator('.monaco-diff-editor .editor.modified .view-lines')).toContainText('namespace');
  const tokenClasses = (): Promise<number> =>
    page.evaluate(() => new Set([...document.querySelectorAll('.monaco-diff-editor .editor.modified .view-lines span[class^="mtk"]')].map((e) => e.className)).size);
  await expect.poll(tokenClasses).toBeGreaterThanOrEqual(3);
  await expect.poll(() => statValue(page, 'changes')).toBeGreaterThan(0);
  const itemChanges = await statValue(page, 'changes');
  expect(itemChanges).toBeLessThan(10); // the item, not the whole project
  await tid(page, 'btn-next').click();
  await expect(tid(page, 'change-position')).toHaveText(new RegExp(`change 1 of ${itemChanges}`));
  await expect(page.locator('.monaco-diff-editor .char-insert, .monaco-diff-editor .char-delete').first()).toBeAttached();
  await tid(page, 'btn-diff-only').click();
  await expect(page.locator('.monaco-diff-editor .diff-hidden-lines .center').filter({ visible: true }).first()).toBeVisible();
  await tid(page, 'btn-diff-only').click();

  // ‹ › move through the current filter.
  const first = await view(page);
  await tid(page, 'btn-next-item').click();
  await expect.poll(() => view(page)).not.toBe(first);
  await tid(page, 'btn-prev-item').click();
  await expect.poll(() => view(page)).toBe(first);

  await tid(page, 'btn-back').click();
  await expect(tid(page, 'item-bar')).toBeHidden();
  await expect.poll(() => view(page)).toBeNull();
  await expect.poll(() => visibleLinesB(page)).toEqual(fullView);

  // Alt+Left also goes back.
  await openItem(page, modifiedGraph);
  await page.keyboard.press('Alt+ArrowLeft');
  await expect(tid(page, 'item-bar')).toBeHidden();
});

test('3b. whitespace-only item: no changes with trim on, changes with trim off', async ({ page }) => {
  await loadProject(page);
  await openItem(page, wsGraph);
  await expect(row(page, wsGraph)).toContainText('≈');
  await expect.poll(() => statValue(page, 'changes')).toBe(0);
  await tid(page, 'opt-trim-ws').uncheck();
  await expect.poll(() => statValue(page, 'changes')).toBeGreaterThan(0);
  await tid(page, 'opt-trim-ws').check();
  await expect.poll(() => statValue(page, 'changes')).toBe(0);
});

test('4. Ctrl+P finds an item by partial name and opens it (drawer closed)', async ({ page }) => {
  await loadProject(page);
  await page.locator('body').click({ position: { x: 800, y: 5 } });
  await page.keyboard.press('Control+B');
  await expect(tid(page, 'explorer')).toBeHidden();
  await page.keyboard.press('Control+P');
  await expect(tid(page, 'quick-open')).toBeVisible();
  await page.keyboard.type(onlyBGraph.name.slice(-9)); // partial, e.g. "AddedInB"
  await page.keyboard.press('Enter');
  await expect(tid(page, 'quick-open')).toBeHidden();
  await expect.poll(() => view(page)).toContain(onlyBGraph.id);
  await expect(tid(page, 'missing-hint-a')).toContainText('Not in A');
});

test('5. whole-text undo: clear, paste, file load, swap; typed edits use Monaco undo', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await loadProject(page);
  const outside = (): Promise<void> => page.locator('body').click({ position: { x: 800, y: 5 } });

  // Clear B → Ctrl+Z restores byte-identical → Ctrl+Y clears again.
  await tid(page, 'btn-clear-b').click();
  await expect.poll(() => page.evaluate(() => window.__sidediff?.engine.getText('b'))).toBe('');
  await page.keyboard.press('Control+Z');
  await expect.poll(() => textHash(page, 'b')).toBe(P.b.sha256);
  await page.keyboard.press('Control+Y');
  await expect.poll(() => page.evaluate(() => window.__sidediff?.engine.getText('b'))).toBe('');
  await page.keyboard.press('Control+Z');
  await expect.poll(() => textHash(page, 'b')).toBe(P.b.sha256);

  // Paste-replace in A, then undo.
  await page.evaluate(() => navigator.clipboard.writeText('using System;\nnamespace Pasted { }\n'));
  await clickEditor(page, 'a');
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Control+V');
  // The Windows clipboard hands Monaco CRLF; compare line content.
  await expect.poll(() => page.evaluate(() => window.__sidediff?.engine.getText('a').replace(/\r\n/g, '\n'))).toBe('using System;\nnamespace Pasted { }\n');
  await page.keyboard.press('Control+Z');
  await expect.poll(() => textHash(page, 'a')).toBe(P.a.sha256);

  // File load over A, then undo.
  await tid(page, 'file-a').setInputFiles(fixturePath('small-a.xml'));
  await expect.poll(() => textHash(page, 'a')).not.toBe(P.a.sha256);
  await outside();
  await page.keyboard.press('Control+Z');
  await expect.poll(() => textHash(page, 'a')).toBe(P.a.sha256);

  // Swap undoes in one step.
  await tid(page, 'btn-swap').click();
  await expect.poll(() => textHash(page, 'a')).toBe(P.b.sha256);
  await outside();
  await page.keyboard.press('Control+Z');
  await expect.poll(() => textHash(page, 'a')).toBe(P.a.sha256);
  expect(await textHash(page, 'b')).toBe(P.b.sha256);

  // Typed edits still undo through Monaco's own stack.
  await clickEditor(page, 'b');
  await page.keyboard.press('Control+Home');
  await page.keyboard.type('XYZ');
  await expect.poll(() => page.evaluate(() => window.__sidediff?.engine.getText('b').startsWith('XYZ'))).toBe(true);
  await page.keyboard.press('Control+Z');
  await expect.poll(() => textHash(page, 'b')).toBe(P.b.sha256);
});

test('7. non-project text: no drawer, no breadcrumb', async ({ page }) => {
  await openApp(page);
  await tid(page, 'file-a').setInputFiles({ name: 'a.cs', mimeType: 'text/plain', buffer: Buffer.from('using System;\nnamespace A { class X { } }\n') });
  await tid(page, 'file-b').setInputFiles({ name: 'b.txt', mimeType: 'text/plain', buffer: Buffer.from('just some\nplain text\n') });
  await waitForDiff(page, 3, 3);
  await page.waitForTimeout(1_500); // past the 400 ms re-index debounce
  await expect(tid(page, 'explorer')).toBeHidden();
  await expect(tid(page, 'item-bar')).toBeHidden();
  await expect(tid(page, 'btn-explorer')).toBeHidden();
  // An XML document whose root is not <Customization> is not a project either.
  await tid(page, 'file-a').setInputFiles({ name: 'a.xml', mimeType: 'text/xml', buffer: Buffer.from('<configuration>\n  <appSettings />\n</configuration>\n') });
  await waitForDiff(page, 4, 3);
  await page.waitForTimeout(1_500);
  await expect(tid(page, 'explorer')).toBeHidden();
});
