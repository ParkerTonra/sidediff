// Section 9: swap, clear, copy, file picker, drag-and-drop; side-by-side vs
// inline; language selector, detection (file and paste), highlighting; find,
// folding, word wrap.
import { readFileSync } from 'node:fs';
import { clickEditor, expect, fixturePath, loadPair, openApp, test, textHash, tid, waitForDiff, changes } from './helpers.ts';

test.use({ viewport: { width: 1600, height: 1000 } });

test('swap exchanges texts and labels', async ({ page }) => {
  await openApp(page);
  const c = await loadPair(page, 'small');
  await tid(page, 'label-a').fill('Left');
  await tid(page, 'label-b').fill('Right');
  await tid(page, 'btn-swap').click();
  await waitForDiff(page, c.b.lines, c.a.lines);
  expect(await textHash(page, 'a')).toBe(c.b.sha256);
  expect(await textHash(page, 'b')).toBe(c.a.sha256);
  await expect(tid(page, 'label-a')).toHaveValue('Right');
  await expect(tid(page, 'label-b')).toHaveValue('Left');
  await expect(tid(page, 'stat-label-a')).toHaveText('Right');
});

test('clear empties one pane and shows its hint', async ({ page }) => {
  await openApp(page);
  const c = await loadPair(page, 'small');
  await expect(tid(page, 'empty-hint-a')).toBeHidden();
  await tid(page, 'btn-clear-a').click();
  await expect.poll(() => page.evaluate(() => window.__sidediff?.engine.getText('a'))).toBe('');
  await expect(tid(page, 'empty-hint-a')).toBeVisible();
  expect(await textHash(page, 'b')).toBe(c.b.sha256);
});

test('copy puts the pane text on the clipboard', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openApp(page);
  await loadPair(page, 'small');
  await tid(page, 'btn-copy-b').click();
  const [clip, text] = await page.evaluate(async () => [await navigator.clipboard.readText(), window.__sidediff?.engine.getText('b')]);
  // The Windows clipboard stores CRLF; compare line content.
  expect(clip?.replace(/\r\n/g, '\n')).toBe(text);
  expect(clip?.length).toBeGreaterThan(1000);
});

test('file picker loads a file as text (no upload)', async ({ page }) => {
  await openApp(page);
  const c = changes('small');
  const uploads: string[] = [];
  page.on('request', (r) => {
    if (r.method() !== 'GET') uploads.push(`${r.method()} ${r.url()}`);
  });
  await tid(page, 'file-a').setInputFiles(fixturePath(c.a.file));
  await expect.poll(() => textHash(page, 'a')).toBe(c.a.sha256);
  expect(uploads).toEqual([]);
});

test('drag-and-drop a file onto pane B loads it', async ({ page }) => {
  await openApp(page);
  const c = changes('small');
  const text = readFileSync(fixturePath(c.b.file), 'utf8');
  await page.evaluate(
    ([content, name]) => {
      const target = document.querySelector('[data-testid="pane-b"]');
      if (!target) throw new Error('pane-b missing');
      const dt = new DataTransfer();
      dt.items.add(new File([content as string], name as string, { type: 'text/xml' }));
      for (const type of ['dragenter', 'dragover', 'drop']) {
        target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
      }
    },
    [text, c.b.file] as const,
  );
  await expect.poll(() => textHash(page, 'b')).toBe(c.b.sha256);
  await expect.poll(() => page.evaluate(() => window.__sidediff?.engine.getText('a'))).toBe('');
});

test('side-by-side and inline views both render the diff', async ({ page }) => {
  await openApp(page);
  await loadPair(page, 'small');
  const editor = page.locator('.monaco-diff-editor').first();
  await expect(tid(page, 'opt-view-mode')).toHaveValue('side-by-side');
  await expect(editor).toHaveClass(/side-by-side/);
  await expect(page.locator('.monaco-diff-editor .editor.original .view-lines')).toBeVisible();

  await tid(page, 'opt-view-mode').selectOption('inline');
  await expect(editor).not.toHaveClass(/side-by-side/);
  await page.evaluate(() => window.__sidediff?.engine.goToChange(1));
  // Inline mode shows removed lines as view zones inside the modified editor.
  await expect(page.locator('.monaco-diff-editor .editor.modified .view-zones .view-lines, .monaco-diff-editor .inline-deleted-text, .monaco-diff-editor .line-delete').first()).toBeAttached();

  await tid(page, 'opt-view-mode').selectOption('side-by-side');
  await expect(editor).toHaveClass(/side-by-side/);
});

test('language selector offers C#, XML, Plain Text; C# fixture detects as csharp', async ({ page }) => {
  await openApp(page);
  const options = await tid(page, 'select-language').locator('option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
  expect(options).toEqual(expect.arrayContaining(['csharp', 'xml', 'plaintext']));
  const c = await loadPair(page, 'csharp-large');
  await expect(tid(page, 'select-language')).toHaveValue('csharp');
  expect(await textHash(page, 'a')).toBe(c.a.sha256);
});

test('paste detects the language (XML then C#)', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openApp(page);
  await expect(tid(page, 'select-language')).toHaveValue('plaintext');
  const paste = async (side: 'a' | 'b', text: string): Promise<void> => {
    await page.evaluate((t) => navigator.clipboard.writeText(t), text);
    await clickEditor(page, side);
    await page.keyboard.press('Control+V');
  };
  await paste('a', '<Customization level="100">\n  <Graph ClassName="SOOrderEntry" />\n</Customization>\n');
  await expect(tid(page, 'select-language')).toHaveValue('xml');
  await paste('b', 'using System;\nnamespace Foo\n{\n    public class Bar { }\n}\n');
  await expect(tid(page, 'select-language')).toHaveValue('csharp');
  await expect.poll(() => page.evaluate(() => window.__sidediff?.engine.getText('b').startsWith('using System;'))).toBe(true);
});

test('syntax highlighting differs per language and works in both themes', async ({ page }) => {
  await openApp(page);
  await loadPair(page, 'small');
  const tokenClasses = (): Promise<number> =>
    page.evaluate(() => new Set([...document.querySelectorAll('.monaco-diff-editor .editor.modified .view-lines span[class^="mtk"]')].map((e) => e.className)).size);
  const tokenColors = (): Promise<string[]> =>
    page.evaluate(() => [...new Set([...document.querySelectorAll('.monaco-diff-editor .editor.modified .view-lines span[class^="mtk"]')].map((e) => getComputedStyle(e).color))].sort());
  await expect(tid(page, 'select-language')).toHaveValue('xml');
  await expect.poll(tokenClasses).toBeGreaterThanOrEqual(3);
  const darkColors = await tokenColors();
  await tid(page, 'btn-theme').click();
  await expect.poll(tokenClasses).toBeGreaterThanOrEqual(3);
  const lightColors = await tokenColors();
  expect(lightColors).not.toEqual(darkColors);
  await tid(page, 'select-language').selectOption('plaintext');
  await expect.poll(tokenClasses).toBeLessThanOrEqual(2);
});

test('Ctrl+F opens find in the focused pane', async ({ page }) => {
  await openApp(page);
  await loadPair(page, 'small');
  await clickEditor(page, 'b');
  await page.keyboard.press('Control+F');
  await expect(page.locator('.monaco-diff-editor .editor.modified .find-widget.visible')).toBeVisible();
  await page.keyboard.type('Customization');
  await expect(page.locator('.monaco-diff-editor .editor.modified .find-widget .matchesCount')).toHaveText(/of/);
});

test('folding controls are present for XML', async ({ page }) => {
  await openApp(page);
  await loadPair(page, 'small');
  const fold = page.locator('.monaco-diff-editor .editor.modified .margin .codicon-folding-expanded').first();
  await page.locator('.monaco-diff-editor .editor.modified .margin').first().hover();
  await expect(fold).toBeAttached();
  const before = await page.evaluate(() => document.querySelectorAll('.monaco-diff-editor .editor.modified .codicon-folding-collapsed').length);
  await fold.click({ force: true });
  await expect.poll(() => page.evaluate(() => document.querySelectorAll('.monaco-diff-editor .editor.modified .codicon-folding-collapsed').length)).toBeGreaterThan(before);
});

test('word wrap removes the horizontal scrollbar for long lines', async ({ page }) => {
  await openApp(page);
  await loadPair(page, 'medium'); // small has no <Page> elements, which carry the long lines
  const scrollWidth = (): Promise<number> =>
    page.evaluate(() => (document.querySelector('.monaco-diff-editor .editor.modified .view-lines') as HTMLElement | null)?.scrollWidth ?? 0);
  const editorWidth = await page.locator('.monaco-diff-editor .editor.modified').first().evaluate((e) => e.clientWidth);
  await expect(tid(page, 'opt-wrap')).not.toBeChecked();
  // Walk the changes until a 500+ character attribute line is on screen.
  const longLineVisible = (): Promise<boolean> =>
    page.evaluate(() => [...document.querySelectorAll('.monaco-diff-editor .editor.modified .view-line')].some((e) => (e.textContent ?? '').length > 400));
  const total = (await page.evaluate(() => window.__sidediff?.engine.getStats()?.changes)) ?? 0;
  for (let i = 1; i <= total && !(await longLineVisible()); i++) {
    await page.evaluate((n) => window.__sidediff?.engine.goToChange(n), i);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  }
  expect(await longLineVisible(), 'a long line is on screen').toBe(true);
  await expect.poll(scrollWidth).toBeGreaterThan(editorWidth * 1.5);
  await tid(page, 'opt-wrap').check();
  await expect.poll(scrollWidth).toBeLessThanOrEqual(editorWidth + 2);
});
