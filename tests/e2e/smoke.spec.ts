import { expect, test } from '@playwright/test';

test('page loads without console errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page).toHaveTitle('SideDiff');
  expect(errors).toEqual([]);
});
