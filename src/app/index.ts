// App shell: toolbar, pane headers, stats bar, dialogs, shortcuts. Owned by UI / UX.
// Talks only to DiffEngine and LanguageRegistry; never imports Monaco.
import '../styles/app.css';
import {
  CONTEXT_LINES_MAX,
  CONTEXT_LINES_MIN,
  type AppDeps,
  type AppSettings,
  type ChangePosition,
  type DegradedInfo,
  type DiffOptions,
  type DiffStats,
  type LanguageId,
  type Side,
  type ThemeId,
} from '../types';
import { FONT_SIZE_MAX, FONT_SIZE_MIN, LABEL_MAX_LENGTH, clamp, createSettingsStore } from '../persist/settings';
import { fmt, h, isTextTarget } from './dom';

const SIDES: readonly Side[] = ['a', 'b'];
const DETECT_SAMPLE = 8 * 1024;
const SHORTCUTS: ReadonlyArray<[string, string]> = [
  ['F7 / Alt+↓', 'Next change'],
  ['Shift+F7 / Alt+↑', 'Previous change'],
  ['Alt+H', 'Toggle “diff only”'],
  ['Ctrl+F', 'Find in the focused pane'],
  ['?', 'Show this cheat sheet'],
  ['Esc', 'Close dialogs'],
];

export function createApp(deps: AppDeps): void {
  startApp(deps).catch((err: unknown) => {
    console.error(err);
    deps.root.dataset.ready = 'error';
    deps.root.prepend(h('div', { class: 'banner banner-error', role: 'alert' }, `SideDiff failed to start: ${errorText(err)}`));
  });
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function startApp({ root, engine, registry }: AppDeps): Promise<void> {
  // 1. Settings first, and the theme before anything paints.
  const store = createSettingsStore();
  const settings: AppSettings = store.load();
  const save = (): void => store.save(settings);
  applyThemeAttr(settings.theme);

  let ready = false;
  let position: ChangePosition = { index: 0, total: 0 };
  const empty: Record<Side, boolean> = { a: true, b: true };

  // ---------- DOM ----------
  const btnDiffOnly = h('button', { type: 'button', class: 'btn toggle', 'data-testid': 'btn-diff-only', 'aria-pressed': 'false', title: 'Show only changed regions (Alt+H)' }, 'Diff only');
  const inputContext = h('input', { type: 'number', class: 'num', id: 'sd-context', min: CONTEXT_LINES_MIN, max: CONTEXT_LINES_MAX, step: 1, 'data-testid': 'input-context-lines' });
  const btnPrev = h('button', { type: 'button', class: 'btn', 'data-testid': 'btn-prev', title: 'Previous change (Shift+F7, Alt+Up)', 'aria-label': 'Previous change' }, '↑ Prev');
  const btnNext = h('button', { type: 'button', class: 'btn', 'data-testid': 'btn-next', title: 'Next change (F7, Alt+Down)', 'aria-label': 'Next change' }, 'Next ↓');
  const changePos = h('span', { class: 'change-pos', 'data-testid': 'change-position', 'aria-live': 'polite' }, 'no changes');
  const selectView = h('select', { id: 'sd-view', 'data-testid': 'opt-view-mode' },
    h('option', { value: 'side-by-side' }, 'Side by side'),
    h('option', { value: 'inline' }, 'Inline'));
  const selectLang = h('select', { id: 'sd-lang', 'data-testid': 'select-language' });
  const optTrim = checkbox('opt-trim-ws', 'Trim whitespace', 'Ignore leading and trailing whitespace');
  const optAllWs = checkbox('opt-ignore-all-ws', 'Ignore all whitespace', 'Ignore every whitespace difference');
  const optWrap = checkbox('opt-wrap', 'Wrap', 'Word wrap');
  const optMinimap = checkbox('opt-minimap', 'Minimap', 'Show the minimap');
  const inputFont = h('input', { type: 'number', class: 'num', id: 'sd-font', min: FONT_SIZE_MIN, max: FONT_SIZE_MAX, step: 1, 'data-testid': 'input-font-size' });
  const btnAddLang = h('button', { type: 'button', class: 'btn', 'data-testid': 'btn-add-language', title: 'Install an extra syntax-highlighting language' }, '+ Language');
  const btnTheme = h('button', { type: 'button', class: 'btn', 'data-testid': 'btn-theme' });
  const btnHelp = h('button', { type: 'button', class: 'btn', title: 'Keyboard shortcuts (?)', 'aria-label': 'Keyboard shortcuts', 'aria-haspopup': 'dialog' }, '?');

  const toolbar = h('div', { class: 'toolbar', role: 'toolbar', 'aria-label': 'Diff controls' },
    h('span', { class: 'brand' }, 'SideDiff'),
    group(btnDiffOnly, h('label', { for: 'sd-context', class: 'field' }, 'Context', inputContext)),
    group(btnPrev, changePos, btnNext),
    group(h('label', { for: 'sd-view', class: 'field' }, 'View', selectView), h('label', { for: 'sd-lang', class: 'field' }, 'Language', selectLang)),
    group(optTrim.wrap, optAllWs.wrap, optWrap.wrap, optMinimap.wrap),
    group(h('label', { for: 'sd-font', class: 'field' }, 'Font', inputFont)),
    h('span', { class: 'spacer' }),
    group(btnAddLang, btnTheme, btnHelp),
  );

  const panes = {} as Record<Side, {
    header: HTMLElement; label: HTMLInputElement; file: HTMLInputElement; meta: HTMLElement;
    hint: HTMLElement; drop: HTMLElement; statLabel: HTMLElement;
  }>;
  for (const side of SIDES) {
    const upper = side.toUpperCase();
    const label = h('input', { type: 'text', class: 'label-input', 'data-testid': `label-${side}`, maxlength: LABEL_MAX_LENGTH, 'aria-label': `Label for side ${upper}`, spellcheck: 'false' });
    const file = h('input', { type: 'file', class: 'visually-hidden', 'data-testid': `file-${side}`, tabindex: -1, 'aria-label': `Open a file into side ${upper}` });
    const btnOpen = h('button', { type: 'button', class: 'btn small', title: `Open a file into ${upper} (or drop one here)` }, 'Open…');
    const btnCopy = h('button', { type: 'button', class: 'btn small', 'data-testid': `btn-copy-${side}`, title: `Copy all of ${upper}` }, 'Copy');
    const btnClear = h('button', { type: 'button', class: 'btn small', 'data-testid': `btn-clear-${side}`, title: `Clear ${upper}` }, 'Clear');
    const meta = h('span', { class: 'pane-meta' }, 'empty');
    const header = h('div', { class: `pane-header pane-${side}`, 'data-testid': `pane-${side}`, 'data-side': side },
      h('span', { class: 'side-tag', 'aria-hidden': 'true' }, upper), label, meta, h('span', { class: 'spacer' }), btnOpen, btnCopy, btnClear, file);
    const hint = h('div', { class: `empty-hint hint-${side}`, 'data-testid': `empty-hint-${side}` },
      h('strong', {}, `Side ${upper} is empty`),
      h('span', {}, 'Paste text here (Ctrl+V), drop a file, or use Open…'));
    const drop = h('div', { class: `drop-overlay drop-${side}`, 'aria-hidden': 'true' }, `Drop to load into ${upper}`);
    const statLabel = h('span', { class: 'stat-label', 'data-testid': `stat-label-${side}` });
    panes[side] = { header, label, file, meta, hint, drop, statLabel };

    btnOpen.addEventListener('click', () => file.click());
    file.addEventListener('change', () => {
      const f = file.files?.[0];
      file.value = '';
      if (f) void loadFile(side, f);
    });
    btnCopy.addEventListener('click', () => void copySide(side));
    btnClear.addEventListener('click', () => {
      if (!ready) return;
      engine.setText(side, '');
      engine.focus(side);
    });
    label.addEventListener('input', () => {
      settings.labels[side] = label.value.trim() || side.toUpperCase();
      renderLabels(false);
      save();
    });
    label.addEventListener('blur', () => renderLabels(true));
    label.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') label.blur();
    });
    addDropTarget(header, () => side);
  }

  const btnSwap = h('button', { type: 'button', class: 'btn small', 'data-testid': 'btn-swap', title: 'Swap A and B (text and labels)', 'aria-label': 'Swap A and B' }, '⇄ Swap');
  const paneRow = h('div', { class: 'pane-row' }, panes.a.header, h('div', { class: 'swap-cell' }, btnSwap), panes.b.header);

  const degradedBanner = h('div', { class: 'banner banner-warn', 'data-testid': 'degraded-warning', role: 'status', hidden: true });
  const errorMsg = h('span', {});
  const btnErrorClose = h('button', { type: 'button', class: 'btn small', 'aria-label': 'Dismiss error' }, 'Dismiss');
  const errorBanner = h('div', { class: 'banner banner-error', 'data-testid': 'diff-error', role: 'alert', hidden: true }, errorMsg, btnErrorClose);
  btnErrorClose.addEventListener('click', () => (errorBanner.hidden = true));

  const editorEl = h('div', { class: 'editor', 'data-testid': 'editor' });
  const editorWrap = h('div', { class: 'editor-wrap' }, editorEl, panes.a.hint, panes.b.hint, panes.a.drop, panes.b.drop);
  addDropTarget(editorWrap, (e) => {
    if (settings.diff.viewMode === 'inline') return 'b';
    const rect = editorWrap.getBoundingClientRect();
    return e.clientX < rect.left + rect.width / 2 ? 'a' : 'b';
  });

  const stat = (id: string, cls: string): HTMLElement => h('span', { class: `stat ${cls}`, 'data-testid': id, 'data-value': '0' });
  const statAdded = stat('stat-added', 'stat-added');
  const statRemoved = stat('stat-removed', 'stat-removed');
  const statModified = stat('stat-modified', 'stat-modified');
  const statChanges = stat('stat-changes', 'stat-changes');
  const statNote = h('span', { class: 'stat-note' });
  const progressText = h('span', { class: 'progress-text' });
  const progress = h('div', { class: 'progress', 'data-testid': 'progress', 'data-state': 'idle', role: 'status', 'aria-live': 'polite' },
    h('span', { class: 'spinner', 'aria-hidden': 'true' }), progressText);
  const notice = h('span', { class: 'notice', role: 'status', 'aria-live': 'polite' });
  const statsBar = h('footer', { class: 'stats-bar', 'data-testid': 'stats-bar' },
    h('span', { class: 'stat-labels' }, panes.a.statLabel, h('span', { class: 'vs' }, 'vs'), panes.b.statLabel),
    statAdded, statRemoved, statModified, statChanges, statNote, progress, h('span', { class: 'spacer' }), notice);

  const shortcutsDialog = h('dialog', { class: 'dialog', 'data-testid': 'shortcuts-dialog', 'aria-labelledby': 'sd-shortcuts-title' },
    h('h2', { id: 'sd-shortcuts-title' }, 'Keyboard shortcuts'),
    h('table', { class: 'shortcuts' }, h('tbody', {}, ...SHORTCUTS.map(([keys, what]) =>
      h('tr', {}, h('td', {}, ...keys.split(' / ').flatMap((k, i) => [i ? ' / ' : '', h('kbd', {}, k)])), h('td', {}, what))))),
    h('form', { method: 'dialog', class: 'dialog-actions' }, h('button', { type: 'submit', class: 'btn' }, 'Close')));

  const addLangList = h('ul', { class: 'lang-list' });
  const addLangDialog = h('dialog', { class: 'dialog', 'data-testid': 'add-language-dialog', 'aria-labelledby': 'sd-addlang-title' },
    h('h2', { id: 'sd-addlang-title' }, 'Add a language'),
    h('p', { class: 'muted' }, 'Packs come from a fixed, hash-checked allowlist and are cached for offline use. Only the grammar data is downloaded; no code runs.'),
    addLangList,
    h('form', { method: 'dialog', class: 'dialog-actions' }, h('button', { type: 'submit', class: 'btn' }, 'Close')));

  root.classList.add('sd-app');
  root.replaceChildren(toolbar, paneRow, degradedBanner, errorBanner, editorWrap, statsBar, shortcutsDialog, addLangDialog);

  // ---------- rendering ----------
  function renderLabels(syncInputs: boolean): void {
    for (const side of SIDES) {
      if (syncInputs) panes[side].label.value = settings.labels[side];
      panes[side].statLabel.textContent = settings.labels[side];
    }
    document.title = `${settings.labels.a} ↔ ${settings.labels.b} · SideDiff`;
  }

  function renderOptions(): void {
    const d = settings.diff;
    btnDiffOnly.setAttribute('aria-pressed', String(d.diffOnly));
    inputContext.value = String(d.contextLines);
    optTrim.input.checked = d.ignoreTrimWhitespace;
    optAllWs.input.checked = d.ignoreAllWhitespace;
    optWrap.input.checked = d.wordWrap;
    optMinimap.input.checked = d.minimap;
    selectView.value = d.viewMode;
    inputFont.value = String(d.fontSize);
    root.dataset.viewMode = d.viewMode;
  }

  function renderTheme(): void {
    const next = settings.theme === 'dark' ? 'light' : 'dark';
    btnTheme.textContent = settings.theme === 'dark' ? '☾ Dark' : '☀ Light';
    btnTheme.setAttribute('aria-label', `Theme: ${settings.theme}. Switch to ${next}`);
    btnTheme.title = `Switch to the ${next} theme`;
  }

  function renderLanguages(): void {
    const installed = registry.list().filter((l) => l.installed);
    selectLang.replaceChildren(...installed.map((l) => h('option', { value: l.id }, l.displayName)));
    selectLang.value = settings.language;
    const remote = registry.list().filter((l) => l.source === 'remote');
    btnAddLang.hidden = remote.length === 0;
    renderAddLanguageList();
  }

  function renderPosition(): void {
    const { index, total } = position;
    changePos.textContent = total === 0 ? 'no changes' : `change ${fmt(index)} of ${fmt(total)}`;
    changePos.dataset.index = String(index);
    changePos.dataset.total = String(total);
    btnPrev.disabled = btnNext.disabled = total === 0;
  }

  function renderStats(s: DiffStats | null): void {
    const set = (el: HTMLElement, n: number, text: string): void => {
      el.dataset.value = String(n);
      el.textContent = text;
    };
    set(statAdded, s?.added ?? 0, `+${fmt(s?.added ?? 0)} added`);
    set(statRemoved, s?.removed ?? 0, `−${fmt(s?.removed ?? 0)} removed`);
    set(statModified, s?.modified ?? 0, `~${fmt(s?.modified ?? 0)} modified`);
    set(statChanges, s?.changes ?? 0, `${fmt(s?.changes ?? 0)} ${s?.changes === 1 ? 'change' : 'changes'}`);
    if (!s || (empty.a && empty.b)) statNote.textContent = '';
    else if (s.identical) statNote.textContent = 'identical';
    else statNote.textContent = `${(s.computeMs / 1000).toFixed(2)} s${s.quitEarly ? ' · approximate (time limit hit)' : ''}`;
  }

  function renderEmpty(): void {
    for (const side of SIDES) panes[side].hint.hidden = !empty[side];
  }

  function renderDegraded(info: DegradedInfo | null): void {
    degradedBanner.hidden = info === null;
    if (!info) return;
    const which = info.sides.map((s) => `${settings.labels[s]} (${fmt(info.lines[s])} lines, ${formatBytes(info.bytes[s])})`).join(' and ');
    degradedBanner.textContent = `Large input: ${which}. ${info.reason} Character-level highlighting is off to keep the tab responsive.`;
  }

  function setComputing(computing: boolean, text = ''): void {
    progress.dataset.state = computing ? 'computing' : 'idle';
    progressText.textContent = computing ? text : 'Ready';
    root.dataset.computing = String(computing);
  }

  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  function showNotice(text: string, kind: 'info' | 'error' = 'info'): void {
    notice.textContent = text;
    notice.dataset.kind = kind;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => (notice.textContent = ''), kind === 'error' ? 8000 : 3000);
  }

  function showError(text: string): void {
    errorMsg.textContent = text;
    errorBanner.hidden = false;
  }

  // ---------- actions ----------
  function setOptions(partial: Partial<DiffOptions>): void {
    Object.assign(settings.diff, partial);
    renderOptions();
    save();
    if (ready) engine.setOptions(partial);
    if (partial.viewMode && ready) requestAnimationFrame(() => engine.layout());
  }

  function toggleDiffOnly(): void {
    setOptions({ diffOnly: !settings.diff.diffOnly });
  }

  function setTheme(theme: ThemeId): void {
    settings.theme = theme;
    applyThemeAttr(theme);
    renderTheme();
    save();
    if (ready) engine.setTheme(theme);
  }

  let langSeq = 0;
  async function applyLanguage(id: LanguageId, reason: 'user' | 'detected'): Promise<void> {
    const seq = ++langSeq;
    const previous = settings.language;
    try {
      await registry.ensureLoaded(id);
    } catch (err) {
      if (seq === langSeq) {
        selectLang.value = previous;
        showNotice(`Could not load language “${id}”: ${errorText(err)}`, 'error');
      }
      return;
    }
    if (seq !== langSeq) return;
    settings.language = id;
    selectLang.value = id;
    save();
    if (ready) engine.setLanguage(id);
    if (reason === 'detected' && id !== previous) showNotice(`Detected ${registry.get(id)?.displayName ?? id}`);
  }

  function detectFrom(text: string): void {
    const id = registry.detect(text.slice(0, DETECT_SAMPLE));
    if (id && id !== settings.language) void applyLanguage(id, 'detected');
  }

  async function loadFile(side: Side, file: File): Promise<void> {
    if (!ready) return;
    let text: string;
    try {
      text = await file.text();
    } catch (err) {
      showNotice(`Could not read ${file.name}: ${errorText(err)}`, 'error');
      return;
    }
    engine.setText(side, text);
    detectFrom(text);
    showNotice(`Loaded ${file.name} into ${settings.labels[side]} (${formatBytes(file.size)})`);
  }

  async function copySide(side: Side): Promise<void> {
    if (!ready) return;
    try {
      await navigator.clipboard.writeText(engine.getText(side));
      showNotice(`Copied ${settings.labels[side]} to the clipboard`);
    } catch (err) {
      showNotice(`Copy failed: ${errorText(err)}`, 'error');
    }
  }

  function swap(): void {
    if (!ready) return;
    engine.swap();
    settings.labels = { a: settings.labels.b, b: settings.labels.a };
    renderLabels(true);
    save();
  }

  // ---------- drag and drop (files only; text drags stay with Monaco) ----------
  let dropTimer: ReturnType<typeof setTimeout> | undefined;
  function showDrop(side: Side | null): void {
    for (const s of SIDES) {
      panes[s].header.classList.toggle('drop-active', s === side);
      panes[s].drop.classList.toggle('active', s === side);
    }
  }
  function addDropTarget(el: HTMLElement, pick: (e: DragEvent) => Side): void {
    el.addEventListener('dragover', (e) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
      showDrop(pick(e));
      clearTimeout(dropTimer);
      dropTimer = setTimeout(() => showDrop(null), 200);
    }, true);
    el.addEventListener('drop', (e) => {
      const f = e.dataTransfer?.files[0];
      if (!f) return;
      e.preventDefault();
      e.stopPropagation();
      showDrop(null);
      void loadFile(pick(e), f);
    }, true);
  }
  // A file dropped anywhere else must not navigate the tab away.
  window.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
  });
  window.addEventListener('drop', (e) => {
    if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
  });

  // ---------- add-language dialog (P2 shell) ----------
  const installState = new Map<LanguageId, { busy: boolean; message?: string; ok?: boolean }>();
  function renderAddLanguageList(): void {
    const remote = registry.list().filter((l) => l.source === 'remote');
    if (remote.length === 0) {
      addLangList.replaceChildren(h('li', { class: 'muted' }, 'No language packs are listed in the manifest.'));
      return;
    }
    addLangList.replaceChildren(...remote.map((l) => {
      const st = installState.get(l.id);
      const btn = h('button', { type: 'button', class: 'btn small', 'data-testid': `btn-install-${l.id}`, 'aria-busy': st?.busy ? 'true' : undefined, disabled: l.installed || st?.busy }, l.installed ? 'Installed' : st?.busy ? 'Installing…' : 'Install');
      btn.addEventListener('click', () => void install(l.id));
      return h('li', { class: 'lang-row' },
        h('span', { class: 'lang-name' }, l.displayName),
        h('span', { class: 'muted' }, l.license ?? ''),
        st?.busy ? h('span', { class: 'spinner', 'aria-hidden': 'true' }) : null,
        st?.message ? h('span', { class: st.ok ? 'ok' : 'err', role: 'status' }, st.message) : null,
        h('span', { class: 'spacer' }), btn);
    }));
  }
  async function install(id: LanguageId): Promise<void> {
    installState.set(id, { busy: true });
    renderAddLanguageList();
    let message: string;
    let ok = false;
    try {
      const res = await registry.install(id);
      ok = res.ok;
      message = res.ok ? 'Installed. Pick it in the Language menu.' : res.error;
    } catch (err) {
      message = errorText(err);
    }
    installState.set(id, { busy: false, message, ok });
    renderLanguages();
  }

  // ---------- control wiring ----------
  btnDiffOnly.addEventListener('click', toggleDiffOnly);
  inputContext.addEventListener('input', () => {
    const n = Number(inputContext.value);
    if (inputContext.value !== '' && Number.isFinite(n)) setOptions({ contextLines: clamp(Math.round(n), CONTEXT_LINES_MIN, CONTEXT_LINES_MAX) });
  });
  inputContext.addEventListener('change', () => renderOptions());
  inputFont.addEventListener('input', () => {
    const n = Number(inputFont.value);
    if (inputFont.value !== '' && Number.isFinite(n) && n >= FONT_SIZE_MIN && n <= FONT_SIZE_MAX) setOptions({ fontSize: Math.round(n) });
  });
  inputFont.addEventListener('change', () => {
    const n = Number(inputFont.value);
    setOptions({ fontSize: Number.isFinite(n) && inputFont.value !== '' ? clamp(Math.round(n), FONT_SIZE_MIN, FONT_SIZE_MAX) : settings.diff.fontSize });
  });
  btnPrev.addEventListener('click', () => ready && engine.prevChange());
  btnNext.addEventListener('click', () => ready && engine.nextChange());
  selectView.addEventListener('change', () => setOptions({ viewMode: selectView.value === 'inline' ? 'inline' : 'side-by-side' }));
  selectLang.addEventListener('change', () => void applyLanguage(selectLang.value, 'user'));
  optTrim.input.addEventListener('change', () => setOptions({ ignoreTrimWhitespace: optTrim.input.checked }));
  optAllWs.input.addEventListener('change', () => setOptions({ ignoreAllWhitespace: optAllWs.input.checked }));
  optWrap.input.addEventListener('change', () => setOptions({ wordWrap: optWrap.input.checked }));
  optMinimap.input.addEventListener('change', () => setOptions({ minimap: optMinimap.input.checked }));
  btnTheme.addEventListener('click', () => setTheme(settings.theme === 'dark' ? 'light' : 'dark'));
  btnHelp.addEventListener('click', () => openDialog(shortcutsDialog));
  btnAddLang.addEventListener('click', () => {
    renderAddLanguageList();
    openDialog(addLangDialog);
  });
  btnSwap.addEventListener('click', swap);
  registry.onChange(renderLanguages);

  function openDialog(d: HTMLDialogElement): void {
    if (!d.open) d.showModal();
  }
  function closeDialogs(): boolean {
    let closed = false;
    for (const d of [shortcutsDialog, addLangDialog]) {
      if (d.open) {
        d.close();
        closed = true;
      }
    }
    return closed;
  }

  // ---------- keyboard shortcuts: document, capture phase, so Monaco can't swallow them ----------
  document.addEventListener('keydown', (e) => {
    const dialogOpen = shortcutsDialog.open || addLangDialog.open;
    if (e.key === 'Escape') {
      if (closeDialogs()) {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }
    if (dialogOpen || e.ctrlKey || e.metaKey) return;
    let handled = true;
    if (e.key === 'F7' && !e.altKey) {
      if (ready) {
        if (e.shiftKey) engine.prevChange();
        else engine.nextChange();
      }
    } else if (e.altKey && !e.shiftKey && e.key === 'ArrowDown') {
      if (ready) engine.nextChange();
    } else if (e.altKey && !e.shiftKey && e.key === 'ArrowUp') {
      if (ready) engine.prevChange();
    } else if (e.altKey && !e.shiftKey && e.code === 'KeyH') {
      toggleDiffOnly();
    } else if (e.key === '?' && !e.altKey && !isTextTarget(e.target)) {
      openDialog(shortcutsDialog);
    } else {
      handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);

  renderLabels(true);
  renderOptions();
  renderTheme();
  renderLanguages();
  renderPosition();
  renderStats(null);
  renderEmpty();

  // 2. Language before mount; fall back to plain text if the saved one is gone.
  try {
    await registry.ensureLoaded(settings.language);
  } catch {
    settings.language = 'plaintext';
    await registry.ensureLoaded(settings.language);
    save();
  }
  renderLanguages();

  // 3. Engine events, then mount, then apply settings.
  engine.on('diff:start', ({ linesA, linesB }) => {
    errorBanner.hidden = true;
    setComputing(true, `Computing diff… ${fmt(linesA)} vs ${fmt(linesB)} lines`);
  });
  engine.on('diff:done', (stats) => {
    setComputing(false);
    renderStats(stats);
  });
  engine.on('diff:error', ({ message }) => {
    setComputing(false);
    showError(`Diff failed: ${message}`);
  });
  engine.on('position', (p) => {
    position = p;
    renderPosition();
  });
  engine.on('degraded', renderDegraded);
  engine.on('content', ({ side, lines, bytes }) => {
    empty[side] = bytes === 0;
    panes[side].meta.textContent = bytes === 0 ? 'empty' : `${fmt(lines)} ${lines === 1 ? 'line' : 'lines'} · ${formatBytes(bytes)}`;
    renderEmpty();
  });
  engine.on('paste', ({ sample }) => detectFrom(sample));

  engine.mount(editorEl);
  engine.setTheme(settings.theme);
  engine.setLanguage(settings.language);
  engine.setOptions({ ...settings.diff });
  ready = true;
  new ResizeObserver(() => engine.layout()).observe(editorEl);
  root.dataset.ready = 'true';
}

function applyThemeAttr(theme: ThemeId): void {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

function group(...children: Node[]): HTMLElement {
  return h('div', { class: 'group' }, ...children);
}

function checkbox(testid: string, text: string, title: string): { wrap: HTMLLabelElement; input: HTMLInputElement } {
  const input = h('input', { type: 'checkbox', 'data-testid': testid });
  return { input, wrap: h('label', { class: 'check', title }, input, text) };
}
