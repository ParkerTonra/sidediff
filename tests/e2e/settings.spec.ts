// Section 9: dark default, light toggle persists; labels editable, shown in
// the stats bar, persisted; font size persists.
import { expect, openApp, test, tid } from './helpers.ts';

test('opens in dark mode; light mode persists across reload', async ({ page }) => {
  await openApp(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('.monaco-diff-editor .monaco-editor').first()).toHaveClass(/vs-dark/);

  await tid(page, 'btn-theme').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('.monaco-diff-editor .monaco-editor').first()).not.toHaveClass(/vs-dark/);

  await page.reload();
  await page.locator('.monaco-diff-editor').first().waitFor();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('.monaco-diff-editor .monaco-editor').first()).not.toHaveClass(/vs-dark/);

  await tid(page, 'btn-theme').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('labels are editable, shown in the stats bar, and persisted', async ({ page }) => {
  await openApp(page);
  await expect(tid(page, 'label-a')).toHaveValue('A');
  await expect(tid(page, 'label-b')).toHaveValue('B');

  await tid(page, 'label-a').fill('Prod 24R2');
  await tid(page, 'label-b').fill('Dev branch');
  await tid(page, 'label-b').press('Enter');
  await expect(tid(page, 'stat-label-a')).toHaveText('Prod 24R2');
  await expect(tid(page, 'stat-label-b')).toHaveText('Dev branch');

  await page.reload();
  await page.locator('.monaco-diff-editor').first().waitFor();
  await expect(tid(page, 'label-a')).toHaveValue('Prod 24R2');
  await expect(tid(page, 'label-b')).toHaveValue('Dev branch');
  await expect(tid(page, 'stat-label-a')).toHaveText('Prod 24R2');
});

test('font size applies to the editor and persists', async ({ page }) => {
  await openApp(page);
  const fontSize = (): Promise<string> =>
    page.locator('.monaco-diff-editor .view-lines').first().evaluate((e) => getComputedStyle(e).fontSize);
  await expect.poll(fontSize).toBe('13px');
  await tid(page, 'input-font-size').fill('18');
  await tid(page, 'input-font-size').press('Enter');
  await expect.poll(fontSize).toBe('18px');
  await page.reload();
  await page.locator('.monaco-diff-editor').first().waitFor();
  await expect(tid(page, 'input-font-size')).toHaveValue('18');
  await expect.poll(fontSize).toBe('18px');
});
