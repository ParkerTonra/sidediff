// Dev-only fakes for building the UI before the real engine and registry land.
// Used by src/app/harness.html; never imported by the production app.
import type {
  ChangePosition,
  DiffEngine,
  DiffEngineEvents,
  DiffOptions,
  DiffStats,
  LanguageId,
  LanguageInfo,
  LanguagePack,
  LanguageRegistry,
  Side,
  ThemeId,
  Unsubscribe,
} from '../../types';
import { LARGE_BYTES, LARGE_LINES } from '../../types';

type Handler = (payload: never) => void;

export interface FakeEngine extends DiffEngine {
  /** Milliseconds the fake blocks the main thread per diff, to test the progress animation. */
  busyMs: number;
  calls: string[];
}

export function createFakeEngine(): FakeEngine {
  const handlers = new Map<string, Set<Handler>>();
  const text: Record<Side, string> = { a: '', b: '' };
  const areas = {} as Record<Side, HTMLTextAreaElement>;
  let container: HTMLElement | null = null;
  let options: Partial<DiffOptions> = {};
  let hunks: Array<{ start: number }> = [];
  let position: ChangePosition = { index: 0, total: 0 };
  let stats: DiffStats | null = null;
  let computing = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastFocused: Side = 'a';
  let degraded = false;

  function emit<K extends keyof DiffEngineEvents>(event: K, payload: DiffEngineEvents[K]): void {
    for (const fn of handlers.get(event) ?? []) (fn as (p: DiffEngineEvents[K]) => void)(payload);
  }

  const lineCount = (s: string): number => (s === '' ? 0 : s.split('\n').length);

  function contentChanged(side: Side): void {
    emit('content', { side, lines: lineCount(text[side]), bytes: new Blob([text[side]]).size });
    const big = (['a', 'b'] as const).filter((s) => lineCount(text[s]) > LARGE_LINES || text[s].length > LARGE_BYTES);
    if (big.length > 0 !== degraded) {
      degraded = big.length > 0;
      emit('degraded', degraded ? {
        sides: big,
        lines: { a: lineCount(text.a), b: lineCount(text.b) },
        bytes: { a: text.a.length, b: text.b.length },
        reason: 'Over 400,000 lines or 40 MB.',
      } : null);
    }
    schedule();
  }

  function schedule(): void {
    clearTimeout(timer);
    computing = true;
    emit('diff:start', { linesA: lineCount(text.a), linesB: lineCount(text.b) });
    const t0 = performance.now();
    timer = setTimeout(() => {
      const end = performance.now() + fake.busyMs;
      while (performance.now() < end) { /* simulate a busy main thread */ }
      if (text.a.includes('FAIL') || text.b.includes('FAIL')) {
        computing = false;
        emit('diff:error', { message: 'fake engine: input contained FAIL' });
        return;
      }
      stats = computeStats(t0);
      computing = false;
      emit('diff:done', stats);
      position = { index: 0, total: stats.changes };
      emit('position', position);
    }, 400);
  }

  function normalize(line: string): string {
    if (options.ignoreAllWhitespace) return line.replace(/\s+/g, '');
    if (options.ignoreTrimWhitespace ?? true) return line.trim();
    return line;
  }

  // Naive positional comparison: good enough to drive the UI.
  function computeStats(t0: number): DiffStats {
    const la = text.a === '' ? [] : text.a.split('\n');
    const lb = text.b === '' ? [] : text.b.split('\n');
    const n = Math.max(la.length, lb.length);
    hunks = [];
    let added = 0, removed = 0, modified = 0;
    let i = 0;
    while (i < n) {
      if (i < la.length && i < lb.length && normalize(la[i] ?? '') === normalize(lb[i] ?? '')) { i++; continue; }
      const start = i;
      while (i < n && !(i < la.length && i < lb.length && normalize(la[i] ?? '') === normalize(lb[i] ?? ''))) i++;
      const a = Math.max(0, Math.min(i, la.length) - start);
      const b = Math.max(0, Math.min(i, lb.length) - start);
      if (a === 0) added += b;
      else if (b === 0) removed += a;
      else { modified += Math.min(a, b); added += Math.max(0, b - a); removed += Math.max(0, a - b); }
      hunks.push({ start });
    }
    return { added, removed, modified, changes: hunks.length, linesA: la.length, linesB: lb.length, computeMs: performance.now() - t0 + fake.busyMs, identical: hunks.length === 0, quitEarly: false };
  }

  function go(index: number): void {
    if (hunks.length === 0) return;
    const i = ((index % hunks.length) + hunks.length) % hunks.length;
    position = { index: i + 1, total: hunks.length };
    const line = hunks[i]?.start ?? 0;
    for (const side of ['a', 'b'] as const) {
      const area = areas[side];
      if (!area) continue;
      const lh = parseFloat(getComputedStyle(area).lineHeight) || 16;
      area.scrollTop = Math.max(0, (line - 3) * lh);
    }
    emit('position', position);
  }

  function applyStyle(): void {
    for (const side of ['a', 'b'] as const) {
      const area = areas[side];
      if (!area) continue;
      area.style.fontSize = `${options.fontSize ?? 13}px`;
      area.style.whiteSpace = options.wordWrap ? 'pre-wrap' : 'pre';
      area.style.display = options.viewMode === 'inline' && side === 'a' ? 'none' : '';
    }
  }

  const fake: FakeEngine = {
    busyMs: 0,
    calls: [],
    mount(el) {
      container = el;
      el.style.display = 'flex';
      for (const side of ['a', 'b'] as const) {
        const area = document.createElement('textarea');
        area.spellcheck = false;
        area.setAttribute('aria-label', `Fake pane ${side.toUpperCase()}`);
        area.style.cssText = 'flex:1;margin:0;border:0;border-right:1px solid var(--border);resize:none;background:var(--bg);color:var(--fg);font-family:Consolas,monospace;padding:4px 8px;outline-offset:-2px;overflow:auto';
        area.addEventListener('input', () => { text[side] = area.value; contentChanged(side); });
        area.addEventListener('focus', () => (lastFocused = side));
        area.addEventListener('paste', (e) => {
          const sample = (e.clipboardData?.getData('text/plain') ?? '').slice(0, 8192);
          queueMicrotask(() => emit('paste', { side, sample }));
        });
        areas[side] = area;
        el.append(area);
      }
      applyStyle();
      fake.calls.push('mount');
    },
    setText(side, value) {
      fake.calls.push(`setText:${side}`);
      text[side] = value;
      if (areas[side]) areas[side].value = value;
      contentChanged(side);
    },
    getText: (side) => text[side],
    setLanguage(id: LanguageId) { fake.calls.push(`setLanguage:${id}`); },
    setOptions(partial) {
      fake.calls.push(`setOptions:${Object.keys(partial).join(',')}`);
      const rediff = ['ignoreTrimWhitespace', 'ignoreAllWhitespace'].some((k) => k in partial);
      options = { ...options, ...partial };
      applyStyle();
      if (rediff && container) schedule();
    },
    setTheme(theme: ThemeId) { fake.calls.push(`setTheme:${theme}`); },
    swap() {
      [text.a, text.b] = [text.b, text.a];
      if (areas.a) areas.a.value = text.a;
      if (areas.b) areas.b.value = text.b;
      emit('content', { side: 'a', lines: lineCount(text.a), bytes: text.a.length });
      contentChanged('b');
    },
    nextChange: () => go(position.index),
    prevChange: () => go(position.index - 2),
    goToChange: (i) => go(i - 1),
    getStats: () => stats,
    getPosition: () => position,
    isComputing: () => computing,
    focus(side) { areas[side]?.focus(); },
    find(side) { areas[side ?? lastFocused]?.focus(); },
    layout() { /* textareas lay themselves out */ },
    on(event, handler): Unsubscribe {
      let set = handlers.get(event);
      if (!set) handlers.set(event, (set = new Set()));
      set.add(handler as Handler);
      return () => set.delete(handler as Handler);
    },
    dispose() { container?.replaceChildren(); },
  };
  return fake;
}

export function createFakeRegistry(): LanguageRegistry {
  const packs = new Map<LanguageId, LanguageInfo>([
    ['csharp', { id: 'csharp', displayName: 'C#', source: 'bundled', installed: true }],
    ['xml', { id: 'xml', displayName: 'XML', source: 'bundled', installed: true }],
    ['plaintext', { id: 'plaintext', displayName: 'Plain Text', source: 'bundled', installed: true }],
    ['sql', { id: 'sql', displayName: 'SQL', source: 'remote', installed: false, license: 'MIT' }],
    ['json', { id: 'json', displayName: 'JSON', source: 'remote', installed: false, license: 'MIT' }],
  ]);
  const listeners = new Set<() => void>();
  const changed = (): void => listeners.forEach((fn) => fn());
  return {
    list: () => [...packs.values()].map((p) => ({ ...p })),
    get: (id) => packs.get(id),
    register(pack: LanguagePack) {
      packs.set(pack.id, { id: pack.id, displayName: pack.displayName, source: pack.source, installed: true, license: pack.license });
      changed();
    },
    detect(text) {
      const t = text.slice(0, 8192);
      if (/^\s*</.test(t)) return 'xml';
      if (/^\s*(using|namespace)\b/m.test(t)) return 'csharp';
      return null;
    },
    async ensureLoaded(id) {
      const p = packs.get(id);
      if (!p) throw new Error(`unknown language ${id}`);
      if (!p.installed) throw new Error(`${p.displayName} is not installed`);
    },
    async install(id) {
      await new Promise((r) => setTimeout(r, 900));
      const p = packs.get(id);
      if (!p || p.source !== 'remote') return { ok: false, error: `${id} is not in the manifest` };
      if (id === 'json') return { ok: false, error: 'SHA-256 mismatch (fake)' };
      p.installed = true;
      changed();
      return { ok: true };
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
