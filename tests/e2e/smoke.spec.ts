import { expect, test, tid } from './helpers.ts';

test('app starts, mounts the diff editor, and logs no console errors', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  await page.goto('/');
  await expect(page).toHaveTitle(/SideDiff/);
  await expect(page.locator('.monaco-diff-editor').first()).toBeVisible();
  await expect(page.locator('#app')).not.toContainText('failed to start');
  await expect(tid(page, 'empty-hint-a')).toBeVisible();
  await expect(tid(page, 'empty-hint-b')).toBeVisible();
  await expect(tid(page, 'progress')).toHaveAttribute('data-state', 'idle');
  await page.waitForTimeout(500);
  expect(consoleErrors).toEqual([]);
});

test('? opens the shortcut cheat sheet and Esc closes it', async ({ page }) => {
  await page.goto('/');
  await page.locator('.monaco-diff-editor').first().waitFor();
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('?');
  await expect(tid(page, 'shortcuts-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(tid(page, 'shortcuts-dialog')).toBeHidden();
});
