// Search everywhere (Ctrl+Shift+F): indexer hits over every text view plus
// assembly hits, grouped by item. Owned by UI / UX.
import type { AppMode, AssemblyBrowser, ItemViewKind, ProjectIndexer, ProjectItem, SearchHit, SearchOptions, Side } from '../types';
import { fmt, h } from './dom';
import { GROUP_LABELS } from './explorer';

export interface OpenHit {
  itemId: string;
  side: Side;
  view: ItemViewKind['id'];
  line?: number;
  asm?: { type: string; member?: string };
}

export interface SearchHost {
  project: ProjectIndexer;
  assemblies?: AssemblyBrowser;
  items(): ProjectItem[];
  mode(): AppMode;
  labels(): Record<Side, string>;
  /** Assembly keys (`${side}:${itemId}`) already loaded by the browser. */
  loadedAssemblies(): Set<string>;
  /** Loads every assembly item of the package(s) into the browser. */
  loadAllAssemblies(): Promise<number>;
  open(hit: OpenHit): void;
}

interface Row {
  itemId: string;
  side: Side;
  view: ItemViewKind['id'];
  line?: number;
  preview: string;
  asm?: { type: string; member?: string };
}

export interface SearchPanel {
  dialog: HTMLDialogElement;
  open(): void;
}

const LIMIT = 500;

export function createSearchPanel(host: SearchHost): SearchPanel {
  const input = h('input', { type: 'search', class: 'qo-input', 'data-testid': 'search-input', placeholder: 'Search every item, file and loaded assembly…', 'aria-label': 'Search everywhere', spellcheck: 'false', autocomplete: 'off' });
  const optCase = h('input', { type: 'checkbox', 'data-testid': 'search-case' });
  const optRegex = h('input', { type: 'checkbox', 'data-testid': 'search-regex' });
  const btnAsm = h('button', { type: 'button', class: 'btn small', 'data-testid': 'btn-search-assemblies', title: 'Load every DLL in the package and search it too' }, 'Search in assemblies');
  const status = h('p', { class: 'qo-foot muted', role: 'status', 'aria-live': 'polite' });
  const results = h('div', { class: 'search-results', role: 'list', 'aria-label': 'Search results' });
  const dialog = h('dialog', { class: 'dialog quick-open search-panel', 'data-testid': 'search-panel', 'aria-label': 'Search everywhere' },
    h('div', { class: 'search-row' }, input),
    h('div', { class: 'search-row search-opts' },
      h('label', { class: 'check' }, optCase, 'Match case'), h('label', { class: 'check' }, optRegex, 'Regex'), h('span', { class: 'spacer' }), btnAsm),
    status, results);

  let seq = 0;
  async function run(): Promise<void> {
    const q = input.value;
    const mySeq = ++seq;
    if (q.trim() === '') {
      results.replaceChildren();
      status.textContent = 'Type to search. Enter on a result opens it.';
      return;
    }
    const opts: SearchOptions = { caseSensitive: optCase.checked, regex: optRegex.checked, limit: LIMIT };
    if (opts.regex) {
      try {
        new RegExp(q);
      } catch {
        status.textContent = 'That regular expression is not valid.';
        return;
      }
    }
    status.textContent = 'Searching…';
    const t0 = performance.now();
    const browse = host.mode() === 'browse';
    const [textHits, asmHits] = await Promise.all([
      host.project.search ? host.project.search(q, opts).catch(() => [] as SearchHit[]) : Promise.resolve([] as SearchHit[]),
      Promise.all([...host.loadedAssemblies()].map(async (key) => {
        const side = key.slice(0, 1) as Side;
        const itemId = key.slice(2);
        const hits = await host.assemblies?.search(key, q, opts).catch(() => []) ?? [];
        return hits.map((x): Row => ({ itemId, side, view: 'assembly', preview: `${x.kind}: ${x.preview}`, asm: { type: x.typeFullName, ...(x.memberName ? { member: x.memberName } : {}) } }));
      })),
    ]);
    if (mySeq !== seq) return;
    const rows: Row[] = [
      ...textHits.map((x) => ({ itemId: x.itemId, side: x.side, view: x.view, line: x.line, preview: x.preview })),
      ...asmHits.flat(),
    ].filter((r) => !browse || r.side === 'a');
    render(rows, Math.round(performance.now() - t0));
  }

  function render(rows: Row[], ms: number): void {
    const items = new Map(host.items().map((i) => [i.id, i]));
    const groups = new Map<string, Row[]>();
    for (const r of rows) {
      const k = `${r.itemId}\u0001${r.side}`;
      let arr = groups.get(k);
      if (!arr) groups.set(k, (arr = []));
      arr.push(r);
    }
    const labels = host.labels();
    const compare = host.mode() === 'compare';
    results.replaceChildren(...[...groups.values()].map((list) => {
      const first = list[0] as Row;
      const item = items.get(first.itemId);
      return h('section', { class: 'search-group', role: 'listitem' },
        h('h3', { class: 'search-item' }, h('span', {}, item?.name ?? first.itemId),
          h('span', { class: 'muted' }, ` ${item ? GROUP_LABELS[item.group] : ''}${compare ? ` · ${labels[first.side]}` : ''} · ${fmt(list.length)}`)),
        ...list.slice(0, 50).map((r) => {
          const b = h('button', { type: 'button', class: 'search-hit', 'data-testid': 'search-hit', 'data-id': r.itemId, 'data-side': r.side, 'data-view': r.view, 'data-line': r.line ?? '' },
            h('span', { class: 'search-line' }, r.line ? `${r.view} ${r.line}` : r.view), h('code', {}, r.preview));
          b.addEventListener('click', () => choose(r));
          return b;
        }));
    }));
    const capped = rows.length >= LIMIT ? ` (first ${fmt(LIMIT)})` : '';
    const loaded = host.loadedAssemblies().size;
    status.textContent = rows.length === 0
      ? `No matches${loaded ? '' : '. Assemblies are not searched until loaded; use “Search in assemblies”'}.`
      : `${fmt(rows.length)} match${rows.length === 1 ? '' : 'es'}${capped} in ${fmt(groups.size)} item${groups.size === 1 ? '' : 's'} · ${ms} ms${loaded ? ` · ${loaded} assembl${loaded === 1 ? 'y' : 'ies'} included` : ''}`;
  }

  function choose(r: Row): void {
    dialog.close();
    host.open({ itemId: r.itemId, side: r.side, view: r.view, ...(r.line ? { line: r.line } : {}), ...(r.asm ? { asm: r.asm } : {}) });
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => void run(), 200);
  };
  input.addEventListener('input', schedule);
  optCase.addEventListener('change', schedule);
  optRegex.addEventListener('change', schedule);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      (results.querySelector('.search-hit') as HTMLButtonElement | null)?.click();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      (results.querySelector('.search-hit') as HTMLButtonElement | null)?.focus();
    }
  });
  results.addEventListener('keydown', (e) => {
    const hits = [...results.querySelectorAll<HTMLButtonElement>('.search-hit')];
    const i = hits.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown' && i >= 0) hits[Math.min(i + 1, hits.length - 1)]?.focus();
    else if (e.key === 'ArrowUp' && i > 0) hits[i - 1]?.focus();
    else if (e.key === 'ArrowUp' && i === 0) input.focus();
    else return;
    e.preventDefault();
  });
  btnAsm.addEventListener('click', () => {
    status.textContent = 'Loading assemblies…';
    void host.loadAllAssemblies().then((n) => {
      status.textContent = `${n} assembl${n === 1 ? 'y' : 'ies'} loaded.`;
      if (input.value.trim()) void run();
    });
  });

  return {
    dialog,
    open() {
      btnAsm.hidden = !host.assemblies;
      if (!dialog.open) dialog.showModal();
      input.focus();
      input.select();
      if (input.value.trim()) void run();
      else status.textContent = 'Type to search. Enter on a result opens it.';
    },
  };
}
