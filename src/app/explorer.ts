// Project explorer drawer: filter, chips, grouped tree of items. Owned by UI / UX.
// Pure DOM; knows nothing about the engine. index.ts wires it.
import type { ExplorerSettings, ItemFilter, ItemStatus, ProjectGroup, ProjectIndex, ProjectItem, Side } from '../types';
import { EXPLORER_WIDTH_MAX, EXPLORER_WIDTH_MIN, clamp } from '../persist/settings';
import { fmt, h } from './dom';
import { fuzzyItem } from './fuzzy';

export const GROUP_LABELS: Record<ProjectGroup, string> = {
  code: 'Code',
  screens: 'Screens',
  tables: 'Tables',
  sql: 'SQL',
  reports: 'Reports',
  inquiries: 'Generic inquiries',
  sitemap: 'Site map',
  integration: 'Integration',
  security: 'Security',
  files: 'Files',
  assemblies: 'Assemblies',
  images: 'Images',
  other: 'Other',
};
const GROUP_ORDER: readonly ProjectGroup[] = [
  'code', 'screens', 'tables', 'sql', 'reports', 'inquiries', 'sitemap', 'integration', 'security', 'files', 'assemblies', 'images', 'other',
];

/** Colour and shape, so status never depends on colour alone. */
export const STATUS_GLYPH: Record<ItemStatus, string> = { modified: '~', whitespace: '≈', 'only-a': '−', 'only-b': '+', same: '=' };
const CHANGED: ReadonlySet<ItemStatus> = new Set(['modified', 'whitespace', 'only-a', 'only-b']);

export function statusWord(status: ItemStatus, labels: Record<Side, string>): string {
  switch (status) {
    case 'modified': return 'modified';
    case 'whitespace': return 'whitespace only';
    case 'only-a': return `only in ${labels.a}`;
    case 'only-b': return `only in ${labels.b}`;
    case 'same': return 'same';
  }
}

export function glyph(status: ItemStatus): HTMLElement {
  return h('span', { class: `glyph st-${status}`, 'aria-hidden': 'true' }, STATUS_GLYPH[status]);
}

export function changedCount(index: ProjectIndex): number {
  const c = index.counts;
  return c.modified + c.whitespace + c['only-a'] + c['only-b'];
}

function passesFilter(item: ProjectItem, filter: ItemFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'changed') return CHANGED.has(item.status);
  return item.status === filter;
}

export interface ExplorerHost {
  settings: ExplorerSettings;
  save(): void;
  labels(): Record<Side, string>;
  /** Null when item views are unavailable (rows are then browse-only). */
  open: ((item: ProjectItem) => void) | null;
}

export interface Explorer {
  drawer: HTMLElement;
  splitter: HTMLElement;
  setIndex(index: ProjectIndex | null): void;
  setActive(id: string | null): void;
  /** Items passing the chip and text filter, in display order (collapsed groups included). */
  visibleItems(): ProjectItem[];
  /** Expand the item's group, clear filters that hide it, select and scroll to it. */
  reveal(id: string): void;
  focusList(): void;
  /** Re-render label-dependent text (status words, header). */
  relabel(): void;
  /** Last filter apply time in ms, for measurements. */
  lastRenderMs(): number;
  /** Browse mode: one side, no statuses, no status chips, every item listed. */
  setBrowse(on: boolean): void;
  /** Shows the Overview entry at the top of the drawer (null hides it). */
  setOverview(open: (() => void) | null): void;
  /** Marks the Overview entry as the current page. */
  setOverviewActive(on: boolean): void;
  /** Expands one group, collapses the others, clears the text filter and scrolls to it. */
  showGroup(group: ProjectGroup): void;
}

interface Row {
  el: HTMLElement;
  /** In the DOM: only rows that pass the filters (and aren't in a collapsed group) are attached. */
  shown: boolean;
  kind: 'group' | 'item';
  group: ProjectGroup;
  item?: ProjectItem;
}

let uid = 0;

export function createExplorer(host: ExplorerHost): Explorer {
  const prefix = `sdx${++uid}-`;
  let index: ProjectIndex | null = null;
  let rows: Row[] = [];
  const itemRows = new Map<string, Row>();
  const groupRows = new Map<ProjectGroup, Row>();
  const collapsed = new Set<ProjectGroup>();
  let cursor = -1;
  let activeId: string | null = null;
  let renderMs = 0;

  const versions = h('div', { class: 'ex-versions', hidden: true });
  const errors = h('div', { class: 'ex-errors', role: 'alert', hidden: true });
  const filterInput = h('input', {
    type: 'search', class: 'ex-filter', 'data-testid': 'explorer-filter', placeholder: 'Filter items…',
    'aria-label': 'Filter items by name or path', spellcheck: 'false', autocomplete: 'off',
  });
  const chips: Record<ItemFilter, HTMLButtonElement> = {
    all: chip('all', 'All'),
    changed: chip('changed', 'Changed'),
    'only-a': chip('only-a', ''),
    'only-b': chip('only-b', ''),
  };
  const list = h('div', { class: 'ex-list', role: 'tree', tabindex: 0, 'aria-label': 'Project items' });
  const btnOverview = h('button', { type: 'button', class: 'ex-overview', 'data-testid': 'explorer-overview', hidden: true },
    h('span', { class: 'ex-ov-icon', 'aria-hidden': 'true' }, '◈'), 'Overview');
  let browse = false;
  /** The filter in effect: browse mode always lists everything. */
  const filterNow = (): ItemFilter => (browse ? 'all' : host.settings.filter);
  const empty = h('div', { class: 'ex-empty', hidden: true });
  const drawer = h('aside', { class: 'explorer', 'data-testid': 'explorer', 'aria-label': 'Project explorer', hidden: true },
    h('div', { class: 'ex-head' }, versions, errors, btnOverview, filterInput,
      h('div', { class: 'ex-chips', role: 'group', 'aria-label': 'Show' }, chips.all, chips.changed, chips['only-a'], chips['only-b'])),
    list, empty);
  const splitter = h('div', {
    class: 'ex-splitter', role: 'separator', 'aria-orientation': 'vertical', 'aria-label': 'Resize explorer',
    tabindex: 0, 'aria-valuemin': EXPLORER_WIDTH_MIN, 'aria-valuemax': EXPLORER_WIDTH_MAX, hidden: true,
  });

  function chip(filter: ItemFilter, text: string): HTMLButtonElement {
    const b = h('button', { type: 'button', class: 'chip', 'data-testid': `filter-${filter}`, 'aria-pressed': 'false', 'data-filter': filter }, text);
    b.addEventListener('click', () => setFilter(filter));
    return b;
  }

  function setFilter(filter: ItemFilter): void {
    host.settings.filter = filter;
    host.save();
    apply();
  }

  // ---------- width ----------
  function setWidth(px: number, persist: boolean): void {
    const w = clamp(Math.round(px), EXPLORER_WIDTH_MIN, EXPLORER_WIDTH_MAX);
    host.settings.width = w;
    drawer.style.width = `${w}px`;
    splitter.setAttribute('aria-valuenow', String(w));
    if (persist) host.save();
  }
  splitter.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    splitter.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = host.settings.width;
    splitter.classList.add('dragging');
    const move = (ev: PointerEvent): void => setWidth(startW + ev.clientX - startX, false);
    const up = (): void => {
      splitter.classList.remove('dragging');
      splitter.removeEventListener('pointermove', move);
      splitter.removeEventListener('pointerup', up);
      splitter.removeEventListener('pointercancel', up);
      host.save();
    };
    splitter.addEventListener('pointermove', move);
    splitter.addEventListener('pointerup', up);
    splitter.addEventListener('pointercancel', up);
  });
  splitter.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 64 : 16;
    if (e.key === 'ArrowLeft') setWidth(host.settings.width - step, true);
    else if (e.key === 'ArrowRight') setWidth(host.settings.width + step, true);
    else if (e.key === 'Home') setWidth(EXPLORER_WIDTH_MIN, true);
    else if (e.key === 'End') setWidth(EXPLORER_WIDTH_MAX, true);
    else return;
    e.preventDefault();
  });

  // ---------- building ----------
  function build(): void {
    rows = [];
    itemRows.clear();
    groupRows.clear();
    cursor = -1;
    const frag = document.createDocumentFragment();
    if (!index) {
      list.replaceChildren();
      return;
    }
    const byGroup = new Map<ProjectGroup, ProjectItem[]>();
    for (const item of index.items) {
      let arr = byGroup.get(item.group);
      if (!arr) byGroup.set(item.group, (arr = []));
      arr.push(item);
    }
    let n = 0;
    for (const group of GROUP_ORDER) {
      const items = byGroup.get(group);
      if (!items?.length) continue;
      const caret = h('span', { class: 'ex-caret', 'aria-hidden': 'true' }, '▾');
      const counts = h('span', { class: 'ex-gcounts' });
      const gEl = h('div', {
        class: 'ex-row ex-group', role: 'treeitem', 'aria-level': 1, 'aria-expanded': 'true', id: `${prefix}${n++}`,
        'data-testid': `explorer-group-${group}`, 'data-group': group,
      }, caret, h('span', { class: 'ex-gname' }, GROUP_LABELS[group]), h('span', { class: 'ex-gtotal' }), counts);
      const gRow: Row = { el: gEl, shown: true, kind: 'group', group };
      rows.push(gRow);
      groupRows.set(group, gRow);
      frag.append(gEl);
      for (const item of items) {
        const el = h('div', {
          class: `ex-row ex-item${item.status === 'same' ? ' is-same' : ''}`, role: 'treeitem', 'aria-level': 2, id: `${prefix}${n++}`,
          'data-testid': 'explorer-item', 'data-id': item.id, 'data-status': item.status, 'data-group': group,
          title: `${item.element}: ${item.id.slice(item.element.length + 1)}${item.detail ? `\n${item.detail}` : ''}`,
        }, glyph(item.status), h('span', { class: 'ex-name' }, item.name || '(unnamed)'), h('span', { class: 'ex-detail' }, item.detail));
        const row: Row = { el, shown: true, kind: 'item', group, item };
        rows.push(row);
        itemRows.set(item.id, row);
        frag.append(el);
      }
    }
    list.replaceChildren(frag);
    relabel();
  }

  function relabel(): void {
    const labels = host.labels();
    for (const row of itemRows.values()) {
      const item = row.item;
      if (item) row.el.setAttribute('aria-label', `${item.name}${item.detail ? `, ${item.detail}` : ''}${browse ? '' : `: ${statusWord(item.status, labels)}`}`);
    }
    chips['only-a'].textContent = `Only ${labels.a}`;
    chips['only-b'].textContent = `Only ${labels.b}`;
    renderHeader();
    renderChipCounts();
  }

  function renderHeader(): void {
    if (!index) return;
    const labels = host.labels();
    const va = index.sides.a.attributes['product-version'];
    const vb = index.sides.b.attributes['product-version'];
    const both = index.sides.a.isProject && index.sides.b.isProject;
    versions.hidden = !(both && va !== vb);
    if (!versions.hidden) {
      versions.replaceChildren(
        h('span', { class: 'ex-vlabel' }, 'Versions differ'),
        h('span', { title: index.sides.a.attributes.description ?? '' }, `${labels.a} ${va ?? '?'}`),
        h('span', { 'aria-hidden': 'true' }, '→'),
        h('span', { title: index.sides.b.attributes.description ?? '' }, `${labels.b} ${vb ?? '?'}`));
    }
    const errs = (['a', 'b'] as const).filter((s) => index?.sides[s].error).map((s) => `${labels[s]}: ${index?.sides[s].error}`);
    errors.hidden = errs.length === 0;
    errors.textContent = errs.length ? `Could not fully scan ${errs.join('; ')}. Showing the items found so far.` : '';
  }

  function renderChipCounts(): void {
    if (!index) return;
    const c = index.counts;
    const n: Record<ItemFilter, number> = { all: index.items.length, changed: changedCount(index), 'only-a': c['only-a'], 'only-b': c['only-b'] };
    for (const f of Object.keys(chips) as ItemFilter[]) {
      const b = chips[f];
      const base = f === 'all' ? 'All' : f === 'changed' ? 'Changed' : `Only ${host.labels()[f === 'only-a' ? 'a' : 'b']}`;
      b.replaceChildren(f === 'only-a' || f === 'only-b' ? glyph(f) : '', `${base} `, h('span', { class: 'chip-n' }, fmt(n[f])));
      b.setAttribute('aria-pressed', String(filterNow() === f));
      b.dataset.count = String(n[f]);
    }
  }

  // ---------- filtering ----------
  function matches(item: ProjectItem, query: string): boolean {
    return passesFilter(item, filterNow()) && (query === '' || fuzzyItem(query, item.name, item.detail) !== null);
  }

  function apply(): void {
    const t0 = performance.now();
    const query = filterInput.value.trim();
    const shown = new Map<ProjectGroup, Record<ItemStatus | 'total', number>>();
    for (const row of rows) {
      if (row.kind !== 'item' || !row.item) continue;
      const ok = matches(row.item, query);
      let g = shown.get(row.group);
      if (!g) shown.set(row.group, (g = { total: 0, same: 0, whitespace: 0, modified: 0, 'only-a': 0, 'only-b': 0 }));
      if (ok) {
        g.total++;
        g[row.item.status]++;
      }
      row.shown = ok && !collapsed.has(row.group);
    }
    let any = false;
    for (const [group, row] of groupRows) {
      const g = shown.get(group);
      const total = g?.total ?? 0;
      row.shown = total > 0;
      any ||= total > 0;
      const isCollapsed = collapsed.has(group);
      row.el.setAttribute('aria-expanded', String(!isCollapsed));
      (row.el.querySelector('.ex-caret') as HTMLElement).textContent = isCollapsed ? '▸' : '▾';
      (row.el.querySelector('.ex-gtotal') as HTMLElement).textContent = fmt(total);
      const counts = row.el.querySelector('.ex-gcounts') as HTMLElement;
      counts.replaceChildren(...(['modified', 'whitespace', 'only-a', 'only-b'] as const)
        .filter((s) => (g?.[s] ?? 0) > 0)
        .map((s) => h('span', { class: 'ex-gc' }, glyph(s), fmt(g?.[s] ?? 0))));
    }
    empty.hidden = any || !index;
    if (!any && index) {
      const showAll = h('button', { type: 'button', class: 'btn small' }, 'Show all items');
      showAll.addEventListener('click', () => {
        filterInput.value = '';
        setFilter('all');
      });
      const msg = index.items.length === 0 ? 'No items in this project.'
        : filterNow() === 'changed' && query === '' ? 'No changes: every item is the same on both sides.'
        : 'No items match.';
      empty.replaceChildren(h('p', {}, msg), index.items.length ? showAll : '');
    }
    renderChipCounts();
    // Attach only what is shown: cached elements, so this is a cheap re-parent, not a rebuild.
    list.replaceChildren(...rows.filter((r) => r.shown).map((r) => r.el));
    if (cursor >= 0 && !rows[cursor]?.shown) setCursor(-1, false);
    renderMs = performance.now() - t0;
  }

  let applyQueued = false;
  filterInput.addEventListener('input', () => {
    if (applyQueued) return;
    applyQueued = true;
    requestAnimationFrame(() => {
      applyQueued = false;
      apply();
    });
  });
  filterInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && filterInput.value !== '') {
      filterInput.value = '';
      apply();
      e.preventDefault();
    } else if (e.key === 'ArrowDown' || e.key === 'Enter') {
      e.preventDefault();
      const first = rows.findIndex((r) => r.kind === 'item' && r.shown);
      list.focus();
      if (first >= 0) setCursor(first, true);
      if (e.key === 'Enter' && first >= 0) activate(first);
    }
  });

  // ---------- cursor and keyboard ----------
  function setCursor(i: number, scroll: boolean): void {
    rows[cursor]?.el.classList.remove('is-cursor');
    cursor = i;
    const row = rows[i];
    if (!row) {
      list.removeAttribute('aria-activedescendant');
      return;
    }
    row.el.classList.add('is-cursor');
    list.setAttribute('aria-activedescendant', row.el.id);
    if (scroll) row.el.scrollIntoView({ block: 'nearest' });
  }

  function visibleIndices(): number[] {
    const out: number[] = [];
    rows.forEach((r, i) => {
      if (r.shown) out.push(i);
    });
    return out;
  }

  function toggleGroup(group: ProjectGroup, open?: boolean): void {
    const isOpen = !collapsed.has(group);
    if (open === isOpen) return;
    if (isOpen) collapsed.add(group);
    else collapsed.delete(group);
    apply();
  }

  function activate(i: number): void {
    const row = rows[i];
    if (!row) return;
    if (row.kind === 'group') toggleGroup(row.group);
    else if (row.item && host.open) host.open(row.item);
  }

  // Focus from a mouse press must not move or scroll the list: the scroll would land the
  // mouseup on another row and the click would never reach the row that was pressed.
  let pointerFocus = false;
  list.addEventListener('pointerdown', () => {
    pointerFocus = true;
    setTimeout(() => (pointerFocus = false), 0);
  });
  list.addEventListener('focus', () => {
    if (pointerFocus) return;
    if (cursor < 0 || !rows[cursor]?.shown) {
      const active = activeId ? itemRows.get(activeId) : undefined;
      const i = active?.shown ? rows.indexOf(active) : visibleIndices()[0] ?? -1;
      setCursor(i, true);
    }
  });
  list.addEventListener('keydown', (e) => {
    const vis = visibleIndices();
    const pos = vis.indexOf(cursor);
    const row = rows[cursor];
    let next: number | undefined;
    switch (e.key) {
      case 'ArrowDown': next = vis[Math.min(pos + 1, vis.length - 1)]; break;
      case 'ArrowUp': next = vis[Math.max(pos - 1, 0)]; break;
      case 'Home': next = vis[0]; break;
      case 'End': next = vis[vis.length - 1]; break;
      case 'PageDown': next = vis[Math.min(pos + 15, vis.length - 1)]; break;
      case 'PageUp': next = vis[Math.max(pos - 15, 0)]; break;
      case 'Enter':
      case ' ':
        activate(cursor);
        break;
      case 'ArrowLeft':
        if (row?.kind === 'item') next = rows.indexOf(groupRows.get(row.group) as Row);
        else if (row) toggleGroup(row.group, false);
        break;
      case 'ArrowRight':
        if (row?.kind === 'group') {
          if (collapsed.has(row.group)) toggleGroup(row.group, true);
          else next = vis[pos + 1];
        }
        break;
      default:
        // Typing a character jumps to the filter box.
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && e.key !== '?') {
          filterInput.focus();
          return;
        }
        return;
    }
    e.preventDefault();
    if (next !== undefined) setCursor(next, true);
  });
  list.addEventListener('click', (e) => {
    const el = (e.target as HTMLElement).closest('.ex-row');
    const i = rows.findIndex((r) => r.el === el);
    if (i < 0) return;
    setCursor(i, false);
    activate(i);
  });

  function setActive(id: string | null): void {
    if (activeId) itemRows.get(activeId)?.el.classList.remove('is-active');
    activeId = id;
    const row = id ? itemRows.get(id) : undefined;
    if (row) {
      row.el.classList.add('is-active');
      row.el.setAttribute('aria-current', 'true');
    }
    for (const r of itemRows.values()) if (r !== row) r.el.removeAttribute('aria-current');
  }

  setWidth(host.settings.width, false);

  return {
    drawer,
    splitter,
    setIndex(next) {
      // Keep the scroll position when re-indexing the same project.
      const scroll = list.scrollTop;
      index = next;
      build();
      apply();
      setActive(activeId && itemRows.has(activeId) ? activeId : null);
      list.scrollTop = scroll;
    },
    setActive,
    visibleItems() {
      const query = filterInput.value.trim();
      return index ? index.items.filter((i) => matches(i, query)) : [];
    },
    reveal(id) {
      const row = itemRows.get(id);
      if (!row?.item) return;
      if (!matches(row.item, filterInput.value.trim())) {
        filterInput.value = '';
        if (!passesFilter(row.item, filterNow())) host.settings.filter = 'all';
        host.save();
      }
      collapsed.delete(row.group);
      apply();
      setCursor(rows.indexOf(row), true);
    },
    focusList() {
      list.focus();
    },
    relabel,
    lastRenderMs: () => renderMs,
    setBrowse(on) {
      if (browse === on) return;
      browse = on;
      drawer.classList.toggle('is-browse', on);
      relabel();
      apply();
    },
    setOverview(open) {
      btnOverview.hidden = open === null;
      btnOverview.onclick = open;
    },
    setOverviewActive(on) {
      btnOverview.classList.toggle('is-active', on);
      if (on) btnOverview.setAttribute('aria-current', 'page');
      else btnOverview.removeAttribute('aria-current');
    },
    showGroup(group) {
      filterInput.value = '';
      collapsed.clear();
      for (const g of groupRows.keys()) if (g !== group) collapsed.add(g);
      apply();
      const row = groupRows.get(group);
      if (row) {
        setCursor(rows.indexOf(row), false);
        row.el.scrollIntoView({ block: 'start' });
      }
    },
  };
}
