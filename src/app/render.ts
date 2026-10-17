// Rendered (non-text) item views: summary tables, image preview, binary info,
// and the package overview. Owned by UI / UX. Pure DOM; index.ts wires data in.
import type { AppMode, ItemStatus, ItemSummary, PackageOverview, ProjectGroup, Side, SummarySection } from '../types';
import { fmt, h } from './dom';
import { GROUP_LABELS, glyph } from './explorer';

export interface Rendered {
  el: HTMLElement;
  dispose(): void;
}

const SIDES: readonly Side[] = ['a', 'b'];

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${fmt(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function rowStatusWord(s: ItemStatus, labels: Record<Side, string>): string {
  return s === 'modified' ? 'changed' : s === 'only-a' ? `only in ${labels.a}` : s === 'only-b' ? `only in ${labels.b}` : 'same';
}

// ---------- summary ----------

/** Facts as a definition table; in compare mode a column per side with changed values marked. */
function factsTable(a: ItemSummary | null, b: ItemSummary | null, compare: boolean, labels: Record<Side, string>): HTMLElement | null {
  const keys = [...new Set([...(a?.facts ?? []), ...(compare ? (b?.facts ?? []) : [])].map(([k]) => k))];
  if (keys.length === 0) return null;
  const val = (s: ItemSummary | null, k: string): string | undefined => s?.facts.find(([kk]) => kk === k)?.[1];
  return h('table', { class: 'sum-table sum-facts' },
    compare ? h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, ''), h('th', { scope: 'col' }, labels.a), h('th', { scope: 'col' }, labels.b))) : null,
    h('tbody', {}, ...keys.map((k) => {
      const va = val(a, k);
      const vb = val(b, k);
      const differs = compare && va !== vb;
      return h('tr', { class: differs ? 'row-changed' : '' },
        h('th', { scope: 'row' }, differs ? glyph('modified') : '', k),
        h('td', {}, va ?? '—'),
        compare ? h('td', {}, vb ?? '—') : null);
    })));
}

interface DiffRow {
  key: string;
  status: ItemStatus;
  a?: string[];
  b?: string[];
}

/** Rows diffed by keyColumn (or by whole-row text when there is no key), in A's order with B-only rows after. */
export function diffRows(a: SummarySection | undefined, b: SummarySection | undefined): DiffRow[] {
  const keyCol = a?.keyColumn ?? b?.keyColumn;
  const keyOf = (r: string[]): string => (keyCol === undefined ? r.join('\u0001') : (r[keyCol] ?? ''));
  const mapB = new Map((b?.rows ?? []).map((r) => [keyOf(r), r]));
  const seen = new Set<string>();
  const out: DiffRow[] = [];
  for (const ra of a?.rows ?? []) {
    const k = keyOf(ra);
    seen.add(k);
    const rb = mapB.get(k);
    out.push(rb ? { key: k, status: rb.join('\u0001') === ra.join('\u0001') ? 'same' : 'modified', a: ra, b: rb } : { key: k, status: 'only-a', a: ra });
  }
  for (const rb of b?.rows ?? []) if (!seen.has(keyOf(rb))) out.push({ key: keyOf(rb), status: 'only-b', b: rb });
  return out;
}

function sectionTable(a: SummarySection | undefined, b: SummarySection | undefined, compare: boolean, labels: Record<Side, string>): HTMLElement {
  const columns = a?.columns ?? b?.columns ?? [];
  const heading = a?.heading ?? b?.heading ?? '';
  if (!compare) {
    const rows = a?.rows ?? [];
    return h('section', { class: 'sum-section' },
      h('h3', {}, heading, h('span', { class: 'sum-count' }, ` ${fmt(rows.length)}`)),
      rows.length === 0 ? h('p', { class: 'muted' }, 'None.') : h('table', { class: 'sum-table' },
        h('thead', {}, h('tr', {}, ...columns.map((c) => h('th', { scope: 'col' }, c)))),
        h('tbody', {}, ...rows.map((r) => h('tr', {}, ...columns.map((_, i) => h('td', {}, r[i] ?? '')))))));
  }
  const rows = diffRows(a, b);
  const changed = rows.filter((r) => r.status !== 'same').length;
  return h('section', { class: 'sum-section' },
    h('h3', {}, heading, h('span', { class: 'sum-count' }, ` ${fmt(rows.length)}${changed ? ` · ${fmt(changed)} differ` : ''}`)),
    rows.length === 0 ? h('p', { class: 'muted' }, 'None.') : h('table', { class: 'sum-table sum-diff' },
      h('thead', {}, h('tr', {}, h('th', { scope: 'col', class: 'sum-st' }, h('span', { class: 'visually-hidden' }, 'Status')), ...columns.map((c) => h('th', { scope: 'col' }, c)))),
      h('tbody', {}, ...rows.map((r) => {
        const cells = columns.map((_, i) => {
          const va = r.a?.[i];
          const vb = r.b?.[i];
          if (r.status === 'modified' && va !== vb) {
            return h('td', { class: 'cell-changed' }, h('del', { title: labels.a }, va ?? ''), h('span', { 'aria-hidden': 'true' }, ' → '), h('ins', { title: labels.b }, vb ?? ''));
          }
          return h('td', {}, (r.a ?? r.b)?.[i] ?? '');
        });
        return h('tr', { class: `row-${r.status}`, 'data-status': r.status },
          h('td', { class: 'sum-st' }, glyph(r.status), h('span', { class: 'visually-hidden' }, rowStatusWord(r.status, labels))), ...cells);
      }))));
}

export function renderSummary(a: ItemSummary | null, b: ItemSummary | null, mode: AppMode, labels: Record<Side, string>): Rendered {
  const compare = mode === 'compare';
  const title = a?.title ?? b?.title ?? 'Summary';
  const headings = [...new Set([...(a?.sections ?? []), ...(compare ? (b?.sections ?? []) : [])].map((s) => s.heading))];
  const el = h('div', { class: 'rendered summary-view', 'data-testid': 'summary-view' },
    h('h2', {}, title),
    compare && (!a || !b) ? h('p', { class: 'muted' }, `Not in ${!a ? labels.a : labels.b}.`) : null,
    factsTable(a, b, compare, labels),
    ...headings.map((hd) => sectionTable(a?.sections.find((s) => s.heading === hd), b?.sections.find((s) => s.heading === hd), compare, labels)));
  return { el, dispose: () => {} };
}

// ---------- image ----------

function mimeOf(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', ico: 'image/x-icon', bmp: 'image/bmp', webp: 'image/webp' } as Record<string, string>)[ext] ?? 'application/octet-stream';
}

export function renderImage(bytes: Record<Side, Uint8Array | null>, name: string, mode: AppMode, labels: Record<Side, string>): Rendered {
  const urls: string[] = [];
  const sides = mode === 'compare' ? SIDES : (['a'] as const);
  const el = h('div', { class: 'rendered image-view', 'data-testid': 'image-view' }, ...sides.map((side) => {
    const b = bytes[side];
    const meta = h('figcaption', {}, mode === 'compare' ? h('strong', {}, `${labels[side]} `) : '', b ? formatSize(b.length) : `Not in ${labels[side]}`);
    if (!b) return h('figure', { class: 'img-cell is-missing' }, meta);
    // Never let an SVG run script: it is shown through <img>, which does not execute it.
    const url = URL.createObjectURL(new Blob([b as BlobPart], { type: mimeOf(name) }));
    urls.push(url);
    const img = h('img', { src: url, alt: `${name} (${labels[side]})` });
    img.addEventListener('load', () => meta.append(` · ${img.naturalWidth} × ${img.naturalHeight} px`), { once: true });
    img.addEventListener('error', () => meta.append(' · could not be decoded'), { once: true });
    return h('figure', { class: 'img-cell' }, h('div', { class: 'img-frame' }, img), meta);
  }));
  return { el, dispose: () => urls.forEach((u) => URL.revokeObjectURL(u)) };
}

// ---------- binary ----------

export function hexDump(bytes: Uint8Array, max = 4096): string {
  const lines: string[] = [];
  const n = Math.min(bytes.length, max);
  for (let off = 0; off < n; off += 16) {
    const chunk = bytes.subarray(off, Math.min(off + 16, n));
    const hex = [...chunk].map((x) => x.toString(16).padStart(2, '0')).join(' ').padEnd(47, ' ');
    const ascii = [...chunk].map((x) => (x >= 0x20 && x < 0x7f ? String.fromCharCode(x) : '.')).join('');
    lines.push(`${off.toString(16).padStart(8, '0')}  ${hex}  ${ascii}`);
  }
  return lines.join('\n');
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export function renderBinary(bytes: Record<Side, Uint8Array | null>, mode: AppMode, labels: Record<Side, string>, note = ''): Rendered {
  const sides = mode === 'compare' ? SIDES : (['a'] as const);
  const el = h('div', { class: 'rendered binary-view', 'data-testid': 'binary-view' },
    note ? h('p', { class: 'muted' }, note) : null,
    h('div', { class: 'bin-cols' }, ...sides.map((side) => {
      const b = bytes[side];
      if (!b) return h('div', { class: 'bin-col' }, h('p', { class: 'muted' }, `Not in ${labels[side]}`));
      const hash = h('code', { class: 'bin-hash' }, '…');
      void sha256(b).then((x) => (hash.textContent = x), () => (hash.textContent = 'unavailable'));
      return h('div', { class: 'bin-col' },
        mode === 'compare' ? h('h3', {}, labels[side]) : null,
        h('dl', { class: 'bin-facts' }, h('dt', {}, 'Size'), h('dd', {}, `${formatSize(b.length)} (${fmt(b.length)} bytes)`), h('dt', {}, 'SHA-256'), h('dd', {}, hash)),
        h('pre', { class: 'hex', tabindex: 0, 'aria-label': `First ${fmt(Math.min(b.length, 4096))} bytes as hex` }, hexDump(b)),
        b.length > 4096 ? h('p', { class: 'muted' }, `Showing the first 4 KB of ${formatSize(b.length)}.`) : null);
    })));
  return { el, dispose: () => {} };
}

// ---------- overview ----------

export interface OverviewHandlers {
  group(group: ProjectGroup): void;
  screen(screenId: string): void;
  assembly(path: string): void;
}

export function renderOverview(ov: Record<Side, PackageOverview | null>, mode: AppMode, labels: Record<Side, string>, on: OverviewHandlers): Rendered {
  const compare = mode === 'compare';
  const sides = compare ? SIDES : (['a'] as const);
  const cell = (side: Side, content: Node | string, differs: boolean): HTMLElement => h('td', { class: differs ? 'cell-changed' : '' }, content);
  const factRows: [string, (o: PackageOverview) => string][] = [
    ['File', (o) => o.name],
    ['Kind', (o) => (o.kind === 'zip' ? 'Customization package (.zip)' : 'project.xml')],
    ['Size', (o) => (o.bytes ? formatSize(o.bytes) : '—')],
    ['Product version', (o) => o.attributes['product-version'] ?? '—'],
    ['Level', (o) => o.attributes.level ?? '—'],
    ['Description', (o) => o.attributes.description || '—'],
  ];
  const facts = h('table', { class: 'sum-table sum-facts' },
    compare ? h('thead', {}, h('tr', {}, h('th', {}, ''), ...sides.map((s) => h('th', { scope: 'col' }, labels[s])))) : null,
    h('tbody', {}, ...factRows.map(([k, f]) => {
      const vals = sides.map((s) => (ov[s] ? f(ov[s] as PackageOverview) : '—'));
      const differs = compare && vals[0] !== vals[1] && k !== 'File' && k !== 'Size';
      return h('tr', { class: differs ? 'row-changed' : '' }, h('th', { scope: 'row' }, differs ? glyph('modified') : '', k), ...sides.map((s, i) => cell(s, vals[i] ?? '—', differs)));
    })));

  const groups = [...new Set(sides.flatMap((s) => Object.keys(ov[s]?.counts ?? {})))] as ProjectGroup[];
  const order = Object.keys(GROUP_LABELS) as ProjectGroup[];
  groups.sort((x, y) => order.indexOf(x) - order.indexOf(y));
  const counts = h('div', { class: 'ov-groups', role: 'list' }, ...groups.map((g) => {
    const n = sides.map((s) => ov[s]?.counts[g] ?? 0);
    const btn = h('button', { type: 'button', class: 'ov-group', role: 'listitem', 'data-group': g, title: `Show ${GROUP_LABELS[g]} in the explorer` },
      h('span', { class: 'ov-n' }, compare ? `${fmt(n[0] ?? 0)} / ${fmt(n[1] ?? 0)}` : fmt(n[0] ?? 0)), h('span', {}, GROUP_LABELS[g]));
    btn.addEventListener('click', () => on.group(g));
    return btn;
  }));

  const list = (title: string, side: Side, entries: { label: string; detail: string; onClick: () => void }[]): HTMLElement =>
    h('section', { class: 'ov-list' }, h('h3', {}, title, compare ? ` · ${labels[side]}` : '', h('span', { class: 'sum-count' }, ` ${fmt(entries.length)}`)),
      entries.length === 0 ? h('p', { class: 'muted' }, 'None.') : h('ul', {}, ...entries.map((e) => {
        const b = h('button', { type: 'button', class: 'link' }, e.label);
        b.addEventListener('click', e.onClick);
        return h('li', {}, b, e.detail ? h('span', { class: 'muted' }, ` ${e.detail}`) : '');
      })));

  const perSide = sides.map((s) => {
    const o = ov[s];
    if (!o) return h('div', { class: 'ov-side' }, h('p', { class: 'muted' }, `${labels[s]} is empty.`));
    return h('div', { class: 'ov-side' },
      o.warnings.length ? h('section', { class: 'ov-warn', role: 'note' }, h('h3', {}, `Warnings${compare ? ` · ${labels[s]}` : ''}`), h('ul', {}, ...o.warnings.map((w) => h('li', {}, w)))) : null,
      list('Screens', s, o.screens.map((x) => ({ label: x.screenId, detail: x.title, onClick: () => on.screen(x.screenId) }))),
      list('Assemblies', s, o.assemblies.map((x) => ({ label: x.path.split('/').pop() ?? x.path, detail: formatSize(x.size), onClick: () => on.assembly(x.path) }))));
  });

  const el = h('div', { class: 'rendered overview-view', 'data-testid': 'overview-view' },
    h('h2', {}, 'Overview'), facts, h('h3', {}, 'Items by group'), counts, h('div', { class: compare ? 'ov-cols' : '' }, ...perSide));
  return { el, dispose: () => {} };
}
