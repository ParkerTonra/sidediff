// Shared e2e helpers. Tests drive the UI through the data-testid contract in
// docs/INTERFACES.md and read state through window.__sidediff only to assert.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test as base } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import type { Side } from '../../src/types.ts';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export type StatKey = 'added' | 'removed' | 'modified' | 'changes';
export interface ChangesJson {
  a: { file: string; lines: number; bytes: number; sha256: string };
  b: { file: string; lines: number; bytes: number; sha256: string };
  expected: Record<'trimWhitespace' | 'noTrimWhitespace', Record<StatKey, number>>;
  tolerance: { relative: number; absolute: number };
}

export function changes(name: string): ChangesJson {
  return JSON.parse(readFileSync(join(ROOT, 'fixtures', `${name}.changes.json`), 'utf8')) as ChangesJson;
}

export const fixturePath = (file: string): string => join(ROOT, 'fixtures', file);

export function withinTolerance(actual: number, expected: number, tol: ChangesJson['tolerance']): boolean {
  return Math.abs(actual - expected) <= expected * tol.relative + tol.absolute;
}

const isLocal = (url: string): boolean => {
  if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('about:')) return true;
  const host = new URL(url).hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
};

/**
 * `test` with two automatic checks on every test: no request leaves
 * localhost, and no uncaught page error.
 */
export const test = base.extend<{ guard: void }>({
  guard: [
    async ({ page }, use) => {
      const external: string[] = [];
      const pageErrors: string[] = [];
      page.on('request', (r) => {
        if (!isLocal(r.url())) external.push(r.url());
      });
      page.on('pageerror', (e) => pageErrors.push(e.message));
      await use();
      expect(external, 'network requests outside localhost').toEqual([]);
      expect(pageErrors, 'uncaught page errors').toEqual([]);
    },
    { auto: true },
  ],
});
export { expect };

export const tid = (page: Page, id: string): Locator => page.getByTestId(id);

/** Opens the app and waits until the diff editor is mounted. */
export async function openApp(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => !!window.__sidediff);
  await page.locator('.monaco-diff-editor').first().waitFor();
}

/** Loads a fixture file into a side through the real file input. */
export async function loadFile(page: Page, side: Side, file: string): Promise<void> {
  await tid(page, `file-${side}`).setInputFiles(fixturePath(file));
}

/** Waits for a finished diff whose line counts match. */
export async function waitForDiff(page: Page, linesA: number, linesB: number, timeout = 60_000): Promise<void> {
  await page.waitForFunction(
    ([a, b]) => {
      const e = window.__sidediff?.engine;
      const s = e?.getStats();
      return !!e && !e.isComputing() && !!s && s.linesA === a && s.linesB === b;
    },
    [linesA, linesB] as const,
    { timeout, polling: 50 },
  );
  await expect(tid(page, 'progress')).toHaveAttribute('data-state', 'idle');
}

/** Loads a fixture pair and waits for its diff. */
export async function loadPair(page: Page, name: string): Promise<ChangesJson> {
  const c = changes(name);
  await loadFile(page, 'a', c.a.file);
  await loadFile(page, 'b', c.b.file);
  await waitForDiff(page, c.a.lines, c.b.lines);
  return c;
}

/** Waits for the next diff:done after `action` runs. */
export async function afterRediff(page: Page, action: () => Promise<void>): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __rediff?: boolean };
    w.__rediff = false;
    const off = window.__sidediff?.engine.on('diff:done', () => {
      w.__rediff = true;
      off?.();
    });
  });
  await action();
  await page.waitForFunction(() => (window as unknown as { __rediff?: boolean }).__rediff === true, undefined, { timeout: 60_000 });
  await expect(tid(page, 'progress')).toHaveAttribute('data-state', 'idle');
}

export async function statValue(page: Page, key: StatKey): Promise<number> {
  return Number(await tid(page, `stat-${key}`).getAttribute('data-value'));
}

/** SHA-256 of a side's text, computed in the page (avoids shipping 9 MB over CDP). */
export async function textHash(page: Page, side: Side): Promise<string> {
  return page.evaluate(async (s) => {
    const text = window.__sidediff?.engine.getText(s) ?? '';
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('');
  }, side);
}

/** Line numbers currently rendered in the modified (B) editor. */
export async function visibleLinesB(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const root = document.querySelector('.monaco-diff-editor .editor.modified') ?? document.querySelector('.monaco-diff-editor');
    return [...(root?.querySelectorAll('.line-numbers') ?? [])].map((e) => Number(e.textContent)).filter((n) => n > 0);
  });
}

/** Parses "change N of M" (with thousands separators) into [N, M]. */
export async function changePosition(page: Page): Promise<[number, number]> {
  const text = (await tid(page, 'change-position').textContent()) ?? '';
  const m = /change\s+([\d,.\s]+)\s+of\s+([\d,.\s]+)/i.exec(text);
  if (!m) return [0, 0];
  const num = (s: string | undefined): number => Number((s ?? '').replace(/[^\d]/g, ''));
  return [num(m[1]), num(m[2])];
}

/**
 * Focuses a pane by clicking a visible spot inside its viewport-sized
 * `.overflow-guard` (`.view-lines` is as tall as the model and scrolls, so
 * its own coordinates can be far off screen).
 */
export async function clickEditor(page: Page, side: Side): Promise<void> {
  await page
    .locator(`.monaco-diff-editor .editor.${side === 'a' ? 'original' : 'modified'} .overflow-guard`)
    .first()
    .click({ position: { x: 120, y: 30 } });
}
