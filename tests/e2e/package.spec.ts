// Phase 5 acceptance 1-8 (docs/INTERFACES.md "Packages, browse mode,
// assemblies and search"). Fixtures: `pnpm fixtures --only project,package`.
// Every test also fails on any non-localhost request (acceptance 8, via the
// guard fixture), including while the decompiler loads.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { readZip } from '../../scripts/lib/zip.ts';
import { expect, fixturePath, ROOT, test, textHash, tid } from './helpers.ts';

interface PkgItem {
  id: string;
  element: string;
  key: string;
  group: string;
  name: string;
  status: 'same' | 'whitespace' | 'modified' | 'only-a' | 'only-b';
  views: string[];
  sides: ('a' | 'b')[];
}
interface PkgSidecar {
  items: PkgItem[];
  overview: Record<'a' | 'b', { counts: Record<string, number>; screensInclude: string[]; assemblies: { path: string; size: number }[]; warningsInclude: string[] }>;
  searches: { query: string; itemId: string; side: 'a' | 'b'; line?: number; what: string }[];
}
const P = JSON.parse(readFileSync(join(ROOT, 'fixtures', 'package.changes.json'), 'utf8')) as PkgSidecar;
const PROJ = JSON.parse(readFileSync(join(ROOT, 'fixtures', 'project.changes.json'), 'utf8')) as { a: { sha256: string }; b: { sha256: string }; items: { id: string; a: unknown; b: unknown }[] };
const ZIP = { a: readZip(readFileSync(fixturePath('package-a.zip'))), b: readZip(readFileSync(fixturePath('package-b.zip'))) };

const find = (pred: (i: PkgItem) => boolean, what: string): PkgItem => {
  const it = P.items.find(pred);
  if (!it) throw new Error(`fixture has no ${what}`);
  return it;
};
const cssStr = (s: string): string => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
const row = (page: Page, id: string): Locator => page.locator(`[data-testid="explorer-item"][data-id="${cssStr(id)}"]`);
const view = (page: Page): Promise<string | null> =>
  page.evaluate(() => (window.__sidediff?.engine as unknown as { getView?: () => string | null }).getView?.() ?? null);

/** Drops a fixture file onto an element with a synthesized DataTransfer, like a real drag from the desktop. */
async function dropFile(page: Page, target: Locator, file: string, mime = 'application/zip'): Promise<void> {
  const b64 = readFileSync(fixturePath(file)).toString('base64');
  await target.evaluate(
    (el, [data, name, type]) => {
      const bin = Uint8Array.from(atob(data as string), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bin], name as string, { type: type as string }));
      for (const t of ['dragenter', 'dragover', 'drop']) el.dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: dt }));
    },
    [b64, file, mime] as const,
  );
}

async function cold(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => !!window.__sidediff);
  await expect(tid(page, 'start-screen')).toBeVisible();
}

async function browse(page: Page, file = 'package-a.zip'): Promise<void> {
  await cold(page);
  await dropFile(page, tid(page, 'start-drop-browse'), file, file.endsWith('.zip') ? 'application/zip' : 'text/xml');
  await expect(tid(page, 'explorer')).toBeVisible({ timeout: 15_000 });
}

async function compare(page: Page, a = 'package-a.zip', b = 'package-b.zip', readyId = 'Zip:Images/contoso-banner.jpg', readyStatus = 'only-a'): Promise<void> {
  await cold(page);
  await dropFile(page, tid(page, 'empty-hint-a'), a, a.endsWith('.zip') ? 'application/zip' : 'text/xml');
  await dropFile(page, page.locator('[data-testid="empty-hint-b"], [data-testid="pane-b"]').first(), b, b.endsWith('.zip') ? 'application/zip' : 'text/xml');
  await expect(tid(page, 'explorer')).toBeVisible({ timeout: 15_000 });
  await tid(page, 'filter-all').click().catch(() => undefined);
  await expect(row(page, readyId)).toHaveAttribute('data-status', readyStatus, { timeout: 15_000 });
}

/** Opens an item; with `code`, switches off a summary-first view to the text/code view. */
async function open(page: Page, id: string, code = false): Promise<void> {
  const r = row(page, id);
  await r.scrollIntoViewIfNeeded();
  await r.click();
  await expect(tid(page, 'item-bar')).toBeVisible();
  const sw = tid(page, 'item-view-code');
  if (code && (await sw.isVisible().catch(() => false))) await sw.click();
}

/** The editor that is actually on screen (browse mode hides one of the diff editors). */
const shown = (page: Page): Locator => page.locator('.monaco-editor .view-lines').filter({ visible: true }).first();

test.use({ viewport: { width: 1600, height: 1000 } });
test.setTimeout(180_000);

test('1. cold start offers Browse and Compare; dropping the zip opens the overview with counts, screens, assemblies, warnings', async ({ page }) => {
  await cold(page);
  await expect(tid(page, 'start-browse')).toBeVisible();
  await expect(tid(page, 'start-compare')).toBeVisible();
  await expect(tid(page, 'start-screen')).toContainText('nothing is uploaded');
  await dropFile(page, tid(page, 'start-drop-browse'), 'package-a.zip');
  const ov = tid(page, 'overview-view');
  await expect(ov).toBeVisible({ timeout: 15_000 });
  await expect(tid(page, 'explorer-overview')).toBeVisible();
  await expect(tid(page, 'btn-mode')).toContainText(/browse/i);
  for (const [g, n] of Object.entries(P.overview.a.counts)) {
    await expect(ov.locator(`[data-group="${g}"]`), `group ${g}`).toContainText(String(n));
  }
  for (const s of P.overview.a.screensInclude.filter((x) => x.startsWith('SO301') || x.startsWith('PO302'))) await expect(ov, s).toContainText(s);
  await expect(ov).toContainText('Contoso.Extensions.dll');
  for (const w of P.overview.a.warningsInclude) await expect(ov).toContainText(w.split('/').pop() ?? w);
});

test('2. browse lists every project.xml item and zip file; files show zip content; images preview; .esc opens as text; download gives the original bytes', async ({ page }) => {
  await browse(page);
  const inA = P.items.filter((i) => i.sides.includes('a'));
  await expect(page.getByTestId('explorer-item')).toHaveCount(inA.length);
  await expect(tid(page, 'filter-changed')).toBeHidden();
  for (const z of inA.filter((i) => i.element === 'Zip')) await expect(row(page, z.id), z.id).toContainText(z.name);
  await expect(row(page, 'Zip:Docs/release-notes.txt')).toHaveAttribute('title', /not in project\.xml/i);

  await open(page, 'File:Pages\\SO\\SO301000.aspx.cs');
  await expect(shown(page)).toContainText('CONTOSO-PAGE-MARKER-5520');

  await open(page, 'File:Images\\contoso-logo.png');
  const img = tid(page, 'image-view').locator('img').first();
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((e) => (e as HTMLImageElement).naturalWidth)).toBe(32);
  await expect(tid(page, 'image-view')).toContainText('32');

  await open(page, 'Zip:App_Data/SnapshotConfigs/ContosoRoutes.esc');
  await expect(shown(page)).toContainText('CONTOSO-SNAPSHOT-ZONE');

  await open(page, 'Zip:Data/routes.bin');
  await expect(tid(page, 'binary-view')).toContainText('2,048');

  // Download returns the zip entry's exact bytes.
  await open(page, 'File:Bin\\Contoso.Extensions.dll');
  const dl = page.waitForEvent('download');
  await tid(page, 'btn-download').click();
  const saved = readFileSync(await (await dl).path());
  expect(saved.equals(ZIP.a.get('Bin/Contoso.Extensions.dll') ?? Buffer.alloc(0))).toBe(true);
});

test('3. summaries render for DAC, Table, Sql, Page, GI, ScreenWithRights and a site map node', async ({ page }) => {
  await browse(page);
  const summary = async (id: string, expected: (string | RegExp)[]): Promise<void> => {
    await open(page, id);
    const sw = tid(page, 'item-view-summary');
    if (await sw.isVisible().catch(() => false)) await sw.click();
    const s = tid(page, 'summary-view');
    await expect(s, id).toBeVisible();
    for (const e of expected) await expect(s, `${id}: ${String(e)}`).toContainText(e);
  };
  const dac = find((i) => i.element === 'DAC', 'DAC');
  await summary(dac.id, ['Field', 'Type', 'Storage', 'AddColumn']);
  await summary(find((i) => i.element === 'Table' && i.sides.includes('a'), 'Table').id, ['Column', 'Type', 'Usr']);
  await summary(find((i) => i.element === 'Sql' && i.sides.includes('a'), 'Sql').id, ['Column', 'CompanyID', /index/i]);
  await summary('Page:~/Pages/SO/SO301000.aspx', ['SO301000', 'PX.Objects.SO', 'Document', 'PXFormView']);
  await summary(find((i) => i.element === 'GenericInquiryScreen', 'GI').id, ['CT-', 'PX.Objects.SO.']);
  await summary('ScreenWithRights:SO301000', ['Administrator', 'Contoso Sales']);
  await summary('SiteMapNode:SO301000', ['SO301000', 'Orders & Returns', '~/Pages/SO/SO301000.aspx']);
});

test('4. assembly browser: types, Acumatica roles, string search, IL, decompile from the committed bundle', async ({ page }) => {
  await browse(page);
  await open(page, 'File:Bin\\Contoso.Extensions.dll');
  const asm = tid(page, 'assembly-view');
  await expect(asm).toBeVisible({ timeout: 15_000 });
  const type = (name: string): Locator => asm.locator(`[data-testid="asm-type"][data-type$="${name}"]`).first();
  const roles: [string, string][] = [['ContosoRouteMaint', 'graph'], ['ContosoRouteMaintExt', 'graphExtension'], ['ContosoRoute', 'dac'], ['ContosoRouteExt', 'dacExtension'], ['RouteCodeAttribute', 'attribute']];
  for (const [name, role] of roles) {
    await expect(type(name), name).toBeVisible();
    await expect(type(name).locator(`[data-role="${role}"]`), `${name} badge`).toBeVisible();
  }
  await expect(asm).toContainText('Contoso.Extensions');

  await tid(page, 'asm-search').fill('CONTOSO-ROUTE-AUDIT-7731');
  await expect(asm.locator('[data-testid="asm-hit"][data-kind="string"]').first()).toBeVisible();
  await tid(page, 'asm-search').fill('');

  await type('ContosoRouteMaint').click();
  const detail = tid(page, 'asm-detail');
  await expect(detail).toContainText('TotalWeight');
  await expect(detail).toContainText('PXGraph');
  // IL of TotalWeight (foreach + string switch): the compares load the case labels.
  const member = detail.locator('*:has(> [data-testid="btn-il"])').filter({ hasText: 'TotalWeight' }).first();
  await member.locator('[data-testid="btn-il"]').click();
  await expect(shown(page)).toContainText('ldstr "max"', { timeout: 15_000 });

  await tid(page, 'btn-decompile').click();
  await expect(shown(page)).toContainText('public class ContosoRouteMaint : PXGraph<ContosoRouteMaint>', { timeout: 90_000 });
});

test('5. search everywhere finds decoded ASPX, CDATA C#, zip text files and a DLL literal; a hit opens the item at its line', async ({ page }) => {
  await browse(page);
  await page.locator('body').click({ position: { x: 800, y: 5 } });
  await page.keyboard.press('Control+Shift+F');
  const panel = tid(page, 'search-panel');
  await expect(panel).toBeVisible();
  const hit = (id: string): Locator => panel.locator(`[data-testid="search-hit"][data-id="${cssStr(id)}"]`).first();
  for (const s of P.searches.filter((x) => x.side === 'a' || x.itemId.startsWith('Zip:'))) {
    if (s.what.startsWith('DLL')) continue;
    await tid(page, 'search-input').fill(s.query);
    await expect(hit(s.itemId), `${s.what}: ${s.query}`).toBeVisible({ timeout: 10_000 });
    if (s.line) await expect(hit(s.itemId)).toHaveAttribute('data-line', String(s.line));
  }
  // DLL literal: load the package's assemblies into the search.
  const dllHit = P.searches.find((x) => x.what.startsWith('DLL'));
  if (dllHit) {
    await tid(page, 'search-input').fill(dllHit.query);
    await tid(page, 'btn-search-assemblies').click({ timeout: 15_000 });
    await expect(panel).toContainText('Contoso', { timeout: 30_000 });
  }
  // Clicking a zip text hit opens that item at the line.
  const notes = P.searches.find((x) => x.itemId === 'Zip:Docs/release-notes.txt');
  if (notes) {
    await tid(page, 'search-input').fill(notes.query);
    await hit(notes.itemId).click();
    await expect.poll(() => view(page)).toContain(notes.itemId);
    await expect(shown(page)).toContainText(notes.query);
  }
});

test('6. compare two zips: statuses, file content diff, assembly outline diff, summary row diff', async ({ page }) => {
  await compare(page);
  for (const it of P.items.filter((i) => i.element === 'Zip' || i.element === 'File' || i.element === 'PerTenantFile')) {
    await expect(row(page, it.id), it.id).toHaveAttribute('data-status', it.status);
  }
  await open(page, 'File:Pages\\SO\\SO301000.aspx', true);
  await expect.poll(() => page.getByTestId('stat-changes').getAttribute('data-value')).not.toBe('0');
  await expect(page.locator('.monaco-diff-editor .editor.modified .view-lines')).toContainText('UsrRushOrder');

  await open(page, 'File:Bin\\Contoso.Extensions.dll');
  await tid(page, 'btn-asm-outline').click({ timeout: 15_000 });
  await expect.poll(() => page.getByTestId('stat-changes').getAttribute('data-value'), { timeout: 30_000 }).not.toBe('0');
  await expect(page.locator('.monaco-diff-editor .editor.modified .view-lines')).toContainText('HasRoute');

  await open(page, 'CSAttribute:CTZONE');
  const sw = tid(page, 'item-view-summary');
  if (await sw.isVisible().catch(() => false)) await sw.click();
  await expect(tid(page, 'summary-view')).toContainText('EAST');
});

test('7a. a bare project.xml works in browse mode', async ({ page }) => {
  await browse(page, 'project-a.xml');
  const inA = PROJ.items.filter((i) => i.a !== null).length;
  await expect(page.getByTestId('explorer-item')).toHaveCount(inA);
  await open(page, 'Graph:POOrderEntry_AllocationExt0');
  await expect(shown(page)).toContainText('namespace');
});

test('7b. a bare project.xml pair still compares; text diff is unchanged', async ({ page }) => {
  await compare(page, 'project-a.xml', 'project-b.xml', 'Graph:SOOrderExt_AddedInB', 'only-b');
  await expect(tid(page, 'btn-mode')).toContainText(/compare/i);
  // The full texts are the files, byte for byte.
  expect(await textHash(page, 'a')).toBe(PROJ.a.sha256);
  expect(await textHash(page, 'b')).toBe(PROJ.b.sha256);
});
