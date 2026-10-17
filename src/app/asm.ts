// Assembly browser view: namespace → type tree with Acumatica badges, type detail
// with member signatures, search, Decompile and IL (shown in the editor through
// showCode). Owned by UI / UX. Talks only to the AssemblyBrowser dep.
import type { AppMode, AsmSearchHit, AsmType, AssemblyBrowser, AssemblyInfo, ItemStatus, Side } from '../types';
import { fmt, h } from './dom';
import { glyph } from './explorer';
import type { Rendered } from './render';

export interface AsmViewOptions {
  browser: AssemblyBrowser;
  mode: AppMode;
  labels: Record<Side, string>;
  itemId: string;
  name: string;
  bytes: Record<Side, Uint8Array | null>;
  /** Shows text in the read-only editor (decompiled C#, IL, outline); a/b per side. */
  showCode(title: string, a: string | null, b: string | null, language: string): void;
  announce(text: string): void;
  /** Type (and member) to select once loaded, e.g. from a search hit. */
  select?: { type: string; member?: string };
}

const ROLE: Record<NonNullable<AsmType['acumatica']>, string> = {
  graph: 'Graph',
  graphExtension: 'Graph ext',
  dac: 'DAC',
  dacExtension: 'DAC ext',
  attribute: 'Attribute',
};

export function roleBadge(t: AsmType): HTMLElement | null {
  if (!t.acumatica) return null;
  const text = (t.acumatica === 'graphExtension' || t.acumatica === 'dacExtension') && t.extends ? `${ROLE[t.acumatica]} of ${t.extends}` : ROLE[t.acumatica];
  return h('span', { class: `asm-badge role-${t.acumatica}`, 'data-role': t.acumatica }, text);
}

const typeSig = (t: AsmType): string => `${t.visibility} ${t.kind} ${t.fullName}${t.baseType && t.baseType !== 'object' ? ` : ${t.baseType}` : ''}`;

/** One line per type and member, sorted, so two versions diff cleanly as text. */
export function outline(info: AssemblyInfo | null): string {
  if (!info) return '';
  const head = [`// ${info.name} ${info.version}${info.targetFramework ? ` (${info.targetFramework})` : ''}`, ...info.references.map((r) => `// ref ${r.name} ${r.version}`).sort(), ''];
  const types = [...info.types].sort((x, y) => x.fullName.localeCompare(y.fullName));
  return head.concat(types.flatMap((t) => [
    ...t.attributes.map((a) => `[${a}]`),
    typeSig(t),
    ...[...t.members].sort((x, y) => x.name.localeCompare(y.name) || x.signature.localeCompare(y.signature)).flatMap((m) => [...m.attributes.map((a) => `    [${a}]`), `    ${m.signature}`]),
    '',
  ])).join('\n');
}

function typeStatus(a: AsmType | undefined, b: AsmType | undefined): ItemStatus {
  if (!a) return 'only-b';
  if (!b) return 'only-a';
  const sig = (t: AsmType): string => [typeSig(t), ...t.attributes, ...t.members.map((m) => `${m.attributes.join(',')}|${m.signature}`).sort()].join('\n');
  return sig(a) === sig(b) ? 'same' : 'modified';
}

export function createAssemblyView(o: AsmViewOptions): Rendered {
  const compare = o.mode === 'compare';
  const sides: Side[] = compare ? ['a', 'b'] : ['a'];
  const keyOf = (side: Side): string => `${side}:${o.itemId}`;
  const info: Partial<Record<Side, AssemblyInfo>> = {};
  let selected: string | null = null;
  let disposed = false;

  // Visible only: its text ticks every second while decompiling, so it is not a live region.
  // Start, finish and errors are announced once through o.announce.
  const status = h('p', { class: 'asm-status muted' }, 'Reading metadata…');
  const hitsCount = h('span', { class: 'muted asm-hits-count', hidden: true });
  const header = h('div', { class: 'asm-head' });
  const search = h('input', { type: 'search', class: 'ex-filter asm-search', 'data-testid': 'asm-search', placeholder: 'Search types, members and strings…', 'aria-label': 'Search this assembly', spellcheck: 'false', autocomplete: 'off' });
  const btnOutline = h('button', { type: 'button', class: 'btn small', 'data-testid': 'btn-asm-outline', title: 'Diff the type and member outline of both versions', hidden: !compare }, 'Compare outlines');
  const btnAll = h('button', { type: 'button', class: 'btn small', 'data-testid': 'btn-decompile-all', title: 'Decompile the whole assembly to C# (large assemblies take a while)' }, 'Decompile all');
  const allHint = h('span', { class: 'asm-hint muted' }, 'Whole assembly can take many seconds; a single type takes well under a second.');
  const tree = h('div', { class: 'asm-tree', role: 'tree', 'aria-label': 'Namespaces and types', tabindex: 0 });
  const detail = h('div', { class: 'asm-detail', 'data-testid': 'asm-detail' }, h('p', { class: 'muted' }, 'Pick a type on the left.'));
  const el = h('div', { class: 'rendered asm-view', 'data-testid': 'assembly-view' },
    header, h('div', { class: 'asm-tools' }, search, hitsCount, btnOutline, btnAll, allHint), status,
    h('div', { class: 'asm-body' }, tree, detail));

  const typesBy = (side: Side): Map<string, AsmType> => new Map((info[side]?.types ?? []).map((t) => [t.fullName, t]));

  function renderHeader(): void {
    header.replaceChildren(h('h2', {}, o.name), ...sides.map((s) => {
      const i = info[s];
      return h('p', { class: 'asm-facts' }, compare ? h('strong', {}, `${o.labels[s]}: `) : '',
        i ? `${i.name} ${i.version}${i.targetFramework ? ` · ${i.targetFramework}` : ''} · ${fmt(i.types.length)} types · ${fmt(i.references.length)} references · ${fmt(i.stringCount)} strings` : `Not in ${o.labels[s]}`);
    }));
  }

  function renderTree(): void {
    tree.setAttribute('role', 'tree');
    tree.setAttribute('aria-label', 'Namespaces and types');
    hitsCount.hidden = true;
    const ta = typesBy('a');
    const tb = compare ? typesBy('b') : new Map<string, AsmType>();
    const names = [...new Set([...ta.keys(), ...tb.keys()])].sort();
    const byNs = new Map<string, string[]>();
    for (const n of names) {
      const t = ta.get(n) ?? tb.get(n);
      const ns = t?.namespace || '(global)';
      let arr = byNs.get(ns);
      if (!arr) byNs.set(ns, (arr = []));
      arr.push(n);
    }
    tree.replaceChildren(...[...byNs.entries()].map(([ns, list]) => h('div', { class: 'asm-ns', role: 'group' },
      h('div', { class: 'asm-ns-name', role: 'treeitem', 'aria-level': 1, 'aria-expanded': 'true' }, ns),
      ...list.map((n) => {
        const t = (ta.get(n) ?? tb.get(n)) as AsmType;
        const st = compare ? typeStatus(ta.get(n), tb.get(n)) : null;
        const row = h('button', {
          type: 'button', class: `asm-type${selected === n ? ' is-active' : ''}`, role: 'treeitem', 'aria-level': 2, 'data-testid': 'asm-type', 'data-type': n,
          'aria-current': selected === n ? 'true' : undefined, title: n,
        }, st ? glyph(st) : '', h('span', { class: 'asm-type-name' }, t.name), roleBadge(t) ?? '');
        row.addEventListener('click', () => select(n));
        return row;
      }))));
  }

  function memberRows(t: AsmType, other: AsmType | undefined, side: Side): HTMLElement[] {
    const otherSigs = new Set(other?.members.map((m) => m.signature) ?? []);
    return t.members.map((m) => {
      const st: ItemStatus | null = compare ? (otherSigs.has(m.signature) ? 'same' : side === 'a' ? 'only-a' : 'only-b') : null;
      const il = m.kind === 'method' || m.kind === 'ctor'
        ? h('button', { type: 'button', class: 'btn small', 'data-testid': 'btn-il', title: `IL of ${m.name}` }, 'IL') : null;
      il?.addEventListener('click', () => void showIl(side, t, m.token, m.name));
      return h('tr', { 'data-member': m.name, class: st && st !== 'same' ? `row-${st}` : '' },
        compare ? h('td', { class: 'sum-st' }, st ? glyph(st) : '') : null,
        h('td', { class: 'asm-kind' }, m.kind),
        h('td', {}, h('code', {}, m.signature), ...m.attributes.map((a) => h('div', { class: 'asm-attr' }, `[${a}]`))),
        h('td', {}, il ?? ''));
    });
  }

  function select(fullName: string, member?: string): void {
    selected = fullName;
    renderTree();
    const ta = typesBy('a').get(fullName);
    const tb = compare ? typesBy('b').get(fullName) : undefined;
    const t = (ta ?? tb) as AsmType | undefined;
    if (!t) return;
    const decompile = h('button', { type: 'button', class: 'btn', 'data-testid': 'btn-decompile', title: 'Decompile this type to C# (read-only)', disabled: busy !== null }, 'Decompile');
    decompile.addEventListener('click', () => void decompileType(fullName, decompile));
    const parts: (HTMLElement | null)[] = [
      h('div', { class: 'asm-type-head' }, h('h3', {}, t.name), roleBadge(t), h('span', { class: 'spacer' }), decompile),
      h('dl', { class: 'bin-facts' },
        h('dt', {}, 'Full name'), h('dd', {}, h('code', {}, t.fullName)),
        h('dt', {}, 'Kind'), h('dd', {}, `${t.visibility} ${t.kind}`),
        t.baseType ? h('dt', {}, 'Base') : null, t.baseType ? h('dd', {}, h('code', {}, t.baseType)) : null,
        t.interfaces.length ? h('dt', {}, 'Interfaces') : null, t.interfaces.length ? h('dd', {}, t.interfaces.join(', ')) : null,
        t.attributes.length ? h('dt', {}, 'Attributes') : null, t.attributes.length ? h('dd', {}, t.attributes.map((a) => `[${a}]`).join(' ')) : null),
    ];
    for (const side of sides) {
      const tt = side === 'a' ? ta : tb;
      if (compare) parts.push(h('h4', {}, `${o.labels[side]}${tt ? '' : ' — not present'}`));
      if (tt) parts.push(h('table', { class: 'sum-table asm-members' }, h('tbody', {}, ...memberRows(tt, side === 'a' ? tb : ta, side))));
    }
    detail.replaceChildren(...parts.filter((x): x is HTMLElement => x !== null));
    if (member) detail.querySelector(`[data-member="${CSS.escape(member)}"]`)?.scrollIntoView({ block: 'center' });
  }

  // ---------- decompiling: runs in a worker, so a ticking timer here stays smooth ----------
  let busy: { what: string; t0: number; timer: ReturnType<typeof setInterval>; button: HTMLButtonElement | null; label: string } | null = null;
  let decompileSeq = 0;

  function renderBusy(): void {
    const on = busy !== null;
    btnAll.disabled = on;
    detail.querySelectorAll<HTMLButtonElement>('[data-testid="btn-decompile"]').forEach((b) => (b.disabled = on));
    el.toggleAttribute('aria-busy', on);
    if (!busy) return;
    const secs = Math.floor((performance.now() - busy.t0) / 1000);
    const text = o.browser.decompilerReady()
      ? `Decompiling ${busy.what}… ${secs} s`
      : `Loading decompiler… (first use only, runs in your browser), then ${busy.what} · ${secs} s`;
    status.replaceChildren(h('span', { class: 'spinner', 'aria-hidden': 'true' }), ` ${text}`);
    if (busy.button) busy.button.textContent = `Decompiling… ${secs} s`;
  }

  function startBusy(what: string, button: HTMLButtonElement | null): void {
    stopBusy();
    busy = { what, t0: performance.now(), timer: setInterval(renderBusy, 1000), button, label: button?.textContent ?? '' };
    renderBusy();
    o.announce(o.browser.decompilerReady() ? `Decompiling ${what}` : `Loading decompiler, then decompiling ${what}`);
  }

  function stopBusy(): void {
    if (!busy) return;
    clearInterval(busy.timer);
    if (busy.button) busy.button.textContent = busy.label;
    busy = null;
    status.textContent = '';
    renderBusy();
  }

  /** Runs one decompile request; a newer request (or closing the view) makes this one's result stale. */
  async function runDecompile(what: string, button: HTMLButtonElement | null, work: () => Promise<(string | null)[]>): Promise<(string | null)[] | null> {
    const seq = ++decompileSeq;
    startBusy(what, button);
    const t0 = performance.now();
    try {
      const r = await work();
      if (seq !== decompileSeq || disposed) return null;
      stopBusy();
      const secs = (performance.now() - t0) / 1000;
      if (secs >= 2) o.announce(`Decompiled ${what} in ${secs.toFixed(1)} s`);
      return r;
    } catch (err) {
      if (seq !== decompileSeq || disposed) return null;
      const lostFocus = document.activeElement === document.body;
      stopBusy();
      if (lostFocus) button?.focus();
      status.textContent = `Decompiler unavailable: ${err instanceof Error ? err.message : String(err)}. IL is still available per method.`;
      o.announce(status.textContent);
      return null;
    }
  }

  async function decompileType(fullName: string, button: HTMLButtonElement | null): Promise<void> {
    if (busy) return;
    const name = fullName.split('.').pop() ?? fullName;
    const r = await runDecompile(name, button, () => Promise.all(sides.map((s) => (typesBy(s).has(fullName) ? o.browser.decompile(keyOf(s), fullName) : Promise.resolve(null)))));
    if (r) o.showCode(`Decompiled ${fullName}`, r[0] ?? null, compare ? (r[1] ?? null) : null, 'csharp');
  }

  async function decompileAll(): Promise<void> {
    if (busy) return;
    const r = await runDecompile(o.name, btnAll, () => Promise.all(sides.map((s) => (info[s] ? o.browser.decompile(keyOf(s), null) : Promise.resolve(null)))));
    if (r) o.showCode(`Decompiled ${o.name}`, r[0] ?? null, compare ? (r[1] ?? null) : null, 'csharp');
  }

  async function showIl(side: Side, t: AsmType, token: number, name: string): Promise<void> {
    try {
      const text = await o.browser.il(keyOf(side), token);
      // In compare mode, show the other side's IL of the same member when it exists.
      let other: string | null = null;
      if (compare) {
        const os: Side = side === 'a' ? 'b' : 'a';
        const om = typesBy(os).get(t.fullName)?.members.find((m) => m.name === name);
        other = om ? await o.browser.il(keyOf(os), om.token).catch(() => null) : null;
      }
      if (disposed) return;
      const [a, b] = side === 'a' ? [text, other] : [other, text];
      o.showCode(`IL ${t.name}.${name}`, a, compare ? b : null, 'plaintext');
    } catch (err) {
      status.textContent = `IL unavailable: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  let searchSeq = 0;
  async function runSearch(): Promise<void> {
    const q = search.value.trim();
    const seq = ++searchSeq;
    if (!q) {
      renderTree();
      return;
    }
    const res = await Promise.all(sides.map((s) => (info[s] ? o.browser.search(keyOf(s), q, { limit: 200 }).then((hits) => hits.map((x) => ({ side: s, x }))) : Promise.resolve([]))));
    if (seq !== searchSeq || disposed) return;
    const hits = res.flat() as { side: Side; x: AsmSearchHit }[];
    const count = `${fmt(hits.length)} match${hits.length === 1 ? '' : 'es'}`;
    hitsCount.textContent = count;
    hitsCount.hidden = false;
    o.announce(count);
    // Search results are a plain list of buttons, not tree items.
    tree.setAttribute('role', 'list');
    tree.setAttribute('aria-label', 'Search results');
    tree.replaceChildren(...hits.map(({ side, x }) => {
      const b = h('button', { type: 'button', class: 'asm-hit', 'data-testid': 'asm-hit', 'data-kind': x.kind },
        h('span', { class: `asm-hit-kind k-${x.kind}` }, x.kind), compare ? h('span', { class: 'muted' }, ` ${o.labels[side]}`) : '',
        h('span', { class: 'asm-hit-where' }, `${x.typeFullName.split('.').pop() ?? x.typeFullName}${x.memberName ? `.${x.memberName}` : ''}`),
        h('code', { class: 'asm-hit-preview' }, x.preview));
      b.addEventListener('click', () => select(x.typeFullName, x.memberName));
      return h('div', { role: 'listitem' }, b);
    }));
  }
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void runSearch(), 150);
  });
  btnAll.addEventListener('click', () => void decompileAll());
  btnOutline.addEventListener('click', () => o.showCode(`Outline ${o.name}`, outline(info.a ?? null), outline(info.b ?? null), 'csharp'));

  void (async () => {
    const results = await Promise.all(sides.map(async (s) => {
      const b = o.bytes[s];
      if (!b) return null;
      try {
        info[s] = await o.browser.load(keyOf(s), b);
        return null;
      } catch (err) {
        return `${o.labels[s]}: ${err instanceof Error ? err.message : String(err)}`;
      }
    }));
    if (disposed) return;
    const errors = results.filter((x): x is string => x !== null);
    status.textContent = errors.join(' · ');
    renderHeader();
    renderTree();
    if (o.select && (typesBy('a').has(o.select.type) || typesBy('b').has(o.select.type))) {
      select(o.select.type, o.select.member);
      return;
    }
    const first = (info.a ?? info.b)?.types.find((t) => t.acumatica) ?? (info.a ?? info.b)?.types[0];
    if (first) select(first.fullName);
  })();

  return {
    el,
    dispose: () => {
      disposed = true;
      decompileSeq++;
      stopBusy();
    },
  };
}
