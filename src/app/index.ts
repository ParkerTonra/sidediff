// App shell: toolbar, pane headers, stats bar, dialogs, shortcuts. Owned by UI / UX.
// Talks only to DiffEngine, LanguageRegistry and the optional project explorer
// deps (ProjectIndexer, ItemViewApi, TextHistoryApi); never imports Monaco.
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
  type ItemViewKind,
  type LanguageId,
  type ProjectIndex,
  type ProjectItem,
  type ReplaceReason,
  type Side,
  type ThemeId,
  DEFAULT_EXPLORER,
} from '../types';
import { FONT_SIZE_MAX, FONT_SIZE_MIN, LABEL_MAX_LENGTH, clamp, createSettingsStore } from '../persist/settings';
import { fmt, h, isTextTarget } from './dom';
import { GROUP_LABELS, changedCount, createExplorer, glyph, statusWord } from './explorer';
import { fuzzyItem } from './fuzzy';

const SIDES: readonly Side[] = ['a', 'b'];
const DETECT_SAMPLE = 8 * 1024;
const REINDEX_DELAY_MS = 400;
const QUICK_OPEN_LIMIT = 60;
const ITEM_LOADING_DELAY_MS = 150;
const SHORTCUTS: ReadonlyArray<[string, string]> = [
  ['F7 / Alt+↓', 'Next change'],
  ['Shift+F7 / Alt+↑', 'Previous change'],
  ['Alt+H', 'Toggle “diff only”'],
  ['Ctrl+F', 'Find in the focused pane'],
  ['?', 'Show this cheat sheet'],
  ['Ctrl+M', 'Toggle Tab focus mode (Tab moves focus out of the editor)'],
  ['Ctrl+Z / Ctrl+Y', 'Undo / redo a paste, clear, file load or swap (outside the editor, or when its own undo is empty)'],
  ['Ctrl+B', 'Show or hide the project explorer'],
  ['Ctrl+P', 'Quick open a project item'],
  ['Alt+← / Esc', 'Back from an item to the whole project'],
  ['Alt+PgUp / Alt+PgDn', 'Previous / next item'],
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

async function startApp({ root, engine, registry, project, views, history }: AppDeps): Promise<void> {
  // 1. Settings first, and the theme before anything paints.
  const store = createSettingsStore();
  const settings: AppSettings = store.load();
  const save = (): void => store.save(settings);
  const explorerSettings = (settings.explorer ??= { ...DEFAULT_EXPLORER });
  applyThemeAttr(settings.theme);

  let ready = false;
  let position: ChangePosition = { index: 0, total: 0 };
  const empty: Record<Side, boolean> = { a: true, b: true };

  // ---------- DOM ----------
  const btnDiffOnly = h('button', { type: 'button', class: 'btn toggle', 'data-testid': 'btn-diff-only', 'aria-pressed': 'false', title: 'Show only changed regions (Alt+H)' }, 'Diff only');
  const inputContext = h('input', { type: 'number', class: 'num', id: 'sd-context', min: CONTEXT_LINES_MIN, max: CONTEXT_LINES_MAX, step: 1, 'data-testid': 'input-context-lines' });
  const btnPrev = h('button', { type: 'button', class: 'btn', 'data-testid': 'btn-prev', title: 'Previous change (Shift+F7, Alt+Up)', 'aria-label': 'Prev change' }, '↑ Prev');
  const btnNext = h('button', { type: 'button', class: 'btn', 'data-testid': 'btn-next', title: 'Next change (F7, Alt+Down)', 'aria-label': 'Next change' }, 'Next ↓');
  const changePos = h('span', { class: 'change-pos', 'data-testid': 'change-position', 'aria-live': 'polite' }, 'no changes');
  const selectView = h('select', { id: 'sd-view', 'data-testid': 'opt-view-mode', title: 'View' },
    h('option', { value: 'side-by-side' }, 'Side by side'),
    h('option', { value: 'inline' }, 'Inline'));
  const selectLang = h('select', { id: 'sd-lang', 'data-testid': 'select-language', title: 'Language (both panes)' });
  const optTrim = checkbox('opt-trim-ws', 'Trim whitespace', 'Ignore leading and trailing whitespace');
  const optAllWs = checkbox('opt-ignore-all-ws', 'Ignore all whitespace', 'Ignore every whitespace difference');
  const optWrap = checkbox('opt-wrap', 'Wrap', 'Word wrap');
  const optMinimap = checkbox('opt-minimap', 'Minimap', 'Show the minimap');
  const inputFont = h('input', { type: 'number', class: 'num', id: 'sd-font', min: FONT_SIZE_MIN, max: FONT_SIZE_MAX, step: 1, 'data-testid': 'input-font-size' });
  const btnAddLang = h('button', { type: 'button', class: 'btn', 'data-testid': 'btn-add-language', title: 'Install an extra syntax-highlighting language' }, '+ Language');
  const btnTheme = h('button', { type: 'button', class: 'btn', 'data-testid': 'btn-theme' });
  const btnHelp = h('button', { type: 'button', class: 'btn', title: 'Keyboard shortcuts (?)', 'aria-label': 'Keyboard shortcuts', 'aria-haspopup': 'dialog' }, '?');

  const explorerSummary = h('span', { class: 'ex-summary' });
  const btnExplorer = h('button', {
    type: 'button', class: 'btn toggle btn-explorer', 'data-testid': 'btn-explorer', 'aria-pressed': 'false',
    'aria-controls': 'sd-explorer', title: 'Project explorer (Ctrl+B)', hidden: true,
  }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('span', { class: 'ex-icon', 'aria-hidden': 'true' }, '☰'), explorerSummary);

  const toolbar = h('div', { class: 'toolbar', role: 'toolbar', 'aria-label': 'Diff controls' },
    h('span', { class: 'brand' }, 'SideDiff'),
    btnExplorer,
    group(btnDiffOnly, h('label', { for: 'sd-context', class: 'field' }, 'Context', inputContext)),
    group(btnPrev, changePos, btnNext),
    // The selects' values are self-describing; their captions stay for screen readers.
    group(h('label', { for: 'sd-view', class: 'visually-hidden' }, 'View'), selectView, h('label', { for: 'sd-lang', class: 'visually-hidden' }, 'Language'), selectLang),
    group(optTrim.wrap, optAllWs.wrap, optWrap.wrap, optMinimap.wrap),
    group(h('label', { for: 'sd-font', class: 'field' }, 'Font', inputFont)),
    h('span', { class: 'spacer' }),
    group(btnAddLang, btnTheme, btnHelp),
  );

  const panes = {} as Record<Side, {
    header: HTMLElement; label: HTMLInputElement; file: HTMLInputElement; meta: HTMLElement;
    hint: HTMLElement; drop: HTMLElement; statLabel: HTMLElement;
    btnOpen: HTMLButtonElement; btnCopy: HTMLButtonElement; btnClear: HTMLButtonElement;
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
    panes[side] = { header, label, file, meta, hint, drop, statLabel, btnOpen, btnCopy, btnClear };

    btnOpen.addEventListener('click', () => file.click());
    file.addEventListener('change', () => {
      const f = file.files?.[0];
      file.value = '';
      if (f) void loadFile(side, f);
    });
    btnCopy.addEventListener('click', () => void copySide(side));
    btnClear.addEventListener('click', () => {
      if (!ready) return;
      // Focus stays on the button, so Ctrl+Z right away undoes the clear.
      replaceText(side, '', 'clear');
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
  const missing: Record<Side, HTMLElement> = {
    a: h('div', { class: 'empty-hint hint-a missing-hint', 'data-testid': 'missing-hint-a', hidden: true }),
    b: h('div', { class: 'empty-hint hint-b missing-hint', 'data-testid': 'missing-hint-b', hidden: true }),
  };
  const itemLoadingText = h('span', {});
  const itemLoading = h('div', { class: 'item-loading', 'data-testid': 'item-loading', role: 'status', hidden: true },
    h('span', { class: 'spinner', 'aria-hidden': 'true' }), itemLoadingText);
  const editorWrap = h('div', { class: 'editor-wrap' }, editorEl, panes.a.hint, panes.b.hint, missing.a, missing.b, panes.a.drop, panes.b.drop, itemLoading);
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

  // ---------- item view breadcrumb ----------
  const btnBack = h('button', { type: 'button', class: 'btn small', 'data-testid': 'btn-back', title: 'Back to the whole project (Alt+Left, Esc)' }, '← Project');
  const crumbGroup = h('span', { class: 'crumb-group' });
  const crumbName = h('strong', { class: 'crumb-name' });
  const crumbDetail = h('span', { class: 'crumb-detail' });
  const crumbStatus = h('span', { class: 'crumb-status' });
  // One button per view kind of the open item (code / changes / xml), labelled by the indexer.
  const viewSwitch = h('div', { class: 'seg-group', role: 'group', 'aria-label': 'Item view', 'data-testid': 'item-view-switch' });
  const btnShowInProject = h('button', { type: 'button', class: 'btn small', 'data-testid': 'btn-show-in-project', title: 'Show this item in the whole project' }, 'Show in project');
  const itemPos = h('span', { class: 'item-pos' });
  const relatedBox = h('span', { class: 'item-related', 'data-testid': 'item-related', role: 'group', 'aria-label': 'Related items of this screen', hidden: true });
  const btnPrevItem = h('button', { type: 'button', class: 'btn small', 'data-testid': 'btn-prev-item', 'aria-label': 'Previous item', title: 'Previous item (Alt+PageUp)' }, '‹');
  const btnNextItem = h('button', { type: 'button', class: 'btn small', 'data-testid': 'btn-next-item', 'aria-label': 'Next item', title: 'Next item (Alt+PageDown)' }, '›');
  const itemBar = h('nav', { class: 'item-bar', 'data-testid': 'item-bar', 'aria-label': 'Item view', hidden: true },
    btnBack, h('span', { class: 'crumb-sep', 'aria-hidden': 'true' }, '/'), crumbGroup, h('span', { class: 'crumb-sep', 'aria-hidden': 'true' }, '/'),
    crumbStatus, crumbName, crumbDetail, viewSwitch, relatedBox, h('span', { class: 'spacer' }), btnShowInProject, btnPrevItem, itemPos, btnNextItem);

  // ---------- quick open ----------
  const qoInput = h('input', {
    type: 'text', class: 'qo-input', 'data-testid': 'quick-open-input', placeholder: 'Type part of an item name or path…',
    role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'sd-qo-list', 'aria-autocomplete': 'list', 'aria-label': 'Find an item', spellcheck: 'false', autocomplete: 'off',
  });
  const qoList = h('ul', { class: 'qo-list', id: 'sd-qo-list', role: 'listbox', 'aria-label': 'Matching items' });
  const qoFoot = h('p', { class: 'qo-foot muted' });
  const quickOpen = h('dialog', { class: 'dialog quick-open', 'data-testid': 'quick-open', 'aria-label': 'Quick open' }, qoInput, qoList, qoFoot);

  // ---------- toasts ----------
  const toast = h('div', { class: 'toast', 'data-testid': 'toast', role: 'status', 'aria-live': 'polite', hidden: true });

  const explorer = createExplorer({
    settings: explorerSettings,
    save,
    labels: () => settings.labels,
    open: views ? (item) => void openItem(item) : null,
  });
  explorer.drawer.id = 'sd-explorer';
  const mainCol = h('div', { class: 'main-col' }, itemBar, paneRow, degradedBanner, errorBanner, editorWrap);
  const workspace = h('div', { class: 'workspace' }, explorer.drawer, explorer.splitter, mainCol);

  root.classList.add('sd-app');
  root.replaceChildren(toolbar, workspace, statsBar, toast, shortcutsDialog, addLangDialog, quickOpen);

  // ---------- rendering ----------
  function renderLabels(syncInputs: boolean): void {
    for (const side of SIDES) {
      const p = panes[side];
      const name = settings.labels[side];
      if (syncInputs) p.label.value = name;
      p.statLabel.textContent = name;
      // Distinct accessible names per pane; each contains the visible text (WCAG 2.5.3).
      p.btnOpen.setAttribute('aria-label', `Open a file into side ${side.toUpperCase()}: ${name}`);
      p.btnCopy.setAttribute('aria-label', `Copy all of side ${side.toUpperCase()}: ${name}`);
      p.btnClear.setAttribute('aria-label', `Clear side ${side.toUpperCase()}: ${name}`);
    }
    document.title = `${settings.labels.a} ↔ ${settings.labels.b} · SideDiff`;
    explorer.relabel();
    renderItemBar();
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
    for (const side of SIDES) panes[side].hint.hidden = !empty[side] || current !== null;
  }

  function renderDegraded(info: DegradedInfo | null): void {
    degradedBanner.hidden = info === null;
    if (!info) return;
    const which = info.sides.map((s) => `${settings.labels[s]} (${fmt(info.lines[s])} lines, ${formatBytes(info.bytes[s])})`).join(' and ');
    degradedBanner.textContent = `Degraded mode for large input: ${which}. ${info.reason}`;
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
    replaceText(side, text, 'load');
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

  /** Whole-text replacement that Ctrl+Z can undo when the engine supports it. */
  function replaceText(side: Side, text: string, reason: ReplaceReason): void {
    if (history) history.replaceText(side, text, reason);
    else engine.setText(side, text);
  }

  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  function showToast(text: string): void {
    toast.textContent = text;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast.hidden = true), 5000);
  }

  function historyText(side: Side | 'both', action: 'undo' | 'redo', reason: ReplaceReason): string {
    const verb = action === 'undo' ? 'Undid' : 'Redid';
    const label = side === 'both' ? '' : settings.labels[side];
    const what: Record<ReplaceReason, string> = {
      clear: `clear of ${label}`,
      load: `file load into ${label}`,
      paste: `paste into ${label}`,
      set: `replacement of ${label}`,
      swap: `swap of ${settings.labels.a} and ${settings.labels.b}`,
    };
    return `${verb} ${what[reason]} · ${action === 'undo' ? 'Ctrl+Y to redo' : 'Ctrl+Z to undo'}`;
  }

  // ---------- project explorer and item views ----------
  let index: ProjectIndex | null = null;
  let current: { item: ProjectItem; view: ItemViewKind } | null = null;
  const fullMeta: Record<Side, string> = { a: 'empty', b: 'empty' };
  const isProject = (): boolean => !!index && (index.sides.a.isProject || index.sides.b.isProject);

  function renderExplorerChrome(): void {
    const on = isProject();
    btnExplorer.hidden = !on;
    const open = on && explorerSettings.open;
    explorer.drawer.hidden = !open;
    explorer.splitter.hidden = !open;
    btnExplorer.setAttribute('aria-pressed', String(open));
    if (index && on) {
      const changed = changedCount(index);
      explorerSummary.textContent = `${fmt(index.items.length)} items · ${fmt(changed)} changed`;
      btnExplorer.setAttribute('aria-label', `Project explorer: ${fmt(index.items.length)} items, ${fmt(changed)} changed`);
    }
  }

  function toggleExplorer(open = !explorerSettings.open): void {
    explorerSettings.open = open;
    save();
    renderExplorerChrome();
    if (open) explorer.focusList();
  }

  let indexTimer: ReturnType<typeof setTimeout> | undefined;
  function scheduleIndex(): void {
    if (!project) return;
    clearTimeout(indexTimer);
    indexTimer = setTimeout(() => void runIndex(), REINDEX_DELAY_MS);
  }

  function setIndexing(on: boolean): void {
    btnExplorer.dataset.indexing = String(on);
    root.dataset.indexing = String(on);
  }

  async function runIndex(): Promise<void> {
    if (!project) return;
    setIndexing(true);
    let next: ProjectIndex;
    try {
      performance.mark('sidediff:index-start');
      next = await project.index(engine.getText('a'), engine.getText('b'));
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return; // a newer call owns the spinner
      setIndexing(false);
      showNotice(`Could not index the project: ${errorText(err)}`, 'error');
      return;
    }
    setIndexing(false);
    performance.mark('sidediff:index-done');
    index = next;
    explorer.setIndex(isProject() ? next : null);
    renderExplorerChrome();
    performance.mark('sidediff:explorer-rendered');
    if (!current) return;
    const id = current.item.id;
    const still = isProject() ? next.items.find((i) => i.id === id) : undefined;
    if (still) {
      void openItem(still, current.view.id);
    } else {
      const name = current.item.name;
      views?.closeView();
      showToast(`${name} is no longer in either side; back to the whole project`);
    }
  }

  let openSeq = 0;
  let loadingTimer: ReturnType<typeof setTimeout> | undefined;
  async function openItem(item: ProjectItem, viewId?: ItemViewKind['id']): Promise<void> {
    if (!views || !project || !ready) return;
    const kind = item.views.find((v) => v.id === viewId) ?? item.views[0];
    if (!kind) return;
    const seq = ++openSeq;
    // viewText may decode (Page sources are base64 raw-deflate): show a small loading state only if it is slow.
    clearTimeout(loadingTimer);
    loadingTimer = setTimeout(() => {
      if (seq !== openSeq) return;
      itemLoadingText.textContent = `Opening ${item.name}…`;
      itemLoading.hidden = false;
    }, ITEM_LOADING_DELAY_MS);
    const done = (): void => {
      if (seq !== openSeq) return;
      clearTimeout(loadingTimer);
      itemLoading.hidden = true;
    };
    let language = kind.language;
    let a: string | null;
    let b: string | null;
    try {
      [a, b] = await Promise.all([project.viewText(item.id, kind.id, 'a'), project.viewText(item.id, kind.id, 'b')]);
    } catch (err) {
      done();
      if (seq === openSeq) showToast(`Could not open ${item.name}: ${errorText(err)}`);
      return;
    }
    try {
      await registry.ensureLoaded(language);
    } catch {
      language = 'plaintext';
    }
    done();
    if (seq !== openSeq) return; // a newer open (or Back) won
    current = { item, view: kind };
    views.openView({ key: `${item.id}#${kind.id}`, a, b, language });
    selectLang.value = language;
    explorer.setActive(item.id);
    renderItemBar();
  }

  function renderItemBar(): void {
    const open = current !== null;
    itemBar.hidden = !open;
    root.dataset.itemView = String(open);
    selectLang.disabled = open;
    selectLang.title = open ? 'Language: the item view picks its own' : 'Language (both panes)';
    for (const side of SIDES) {
      const p = panes[side];
      p.meta.textContent = open ? 'read-only item view' : fullMeta[side];
      p.btnOpen.disabled = open;
      p.btnClear.disabled = open;
      const absent = open && current?.item[side] === null;
      missing[side].hidden = !absent;
      if (absent) {
        const other = settings.labels[side === 'a' ? 'b' : 'a'];
        missing[side].replaceChildren(h('strong', {}, `Not in ${settings.labels[side]}`), h('span', {}, `This item exists only in ${other}.`));
      }
    }
    btnSwap.disabled = open;
    renderEmpty();
    if (!current) {
      selectLang.value = settings.language;
      return;
    }
    const { item, view } = current;
    crumbGroup.textContent = GROUP_LABELS[item.group];
    crumbStatus.replaceChildren(glyph(item.status), h('span', { class: 'visually-hidden' }, statusWord(item.status, settings.labels)));
    crumbName.textContent = item.name;
    crumbName.title = item.id;
    crumbDetail.textContent = item.detail;
    viewSwitch.hidden = item.views.length < 2;
    viewSwitch.replaceChildren(...item.views.map((v) => {
      const b = h('button', { type: 'button', class: 'btn small seg', 'data-testid': `item-view-${v.id}`, 'aria-pressed': String(v.id === view.id) }, v.label);
      b.addEventListener('click', () => {
        if (current && v.id !== current.view.id) void openItem(current.item, v.id);
      });
      return b;
    }));
    renderRelated(item);
    const list = explorer.visibleItems();
    const i = list.findIndex((x) => x.id === item.id);
    itemPos.textContent = i >= 0 ? `${fmt(i + 1)} / ${fmt(list.length)}` : `– / ${fmt(list.length)}`;
    itemPos.title = 'Position in the explorer’s current filter';
    btnPrevItem.disabled = list.length === 0 || (list.length === 1 && i === 0);
    btnNextItem.disabled = btnPrevItem.disabled;
  }

  /** Other items of the same screen (page, its files, site map entry, editor fields), one click apart. */
  function renderRelated(item: ProjectItem): void {
    const related = item.screenId && index ? index.items.filter((x) => x.screenId === item.screenId && x.id !== item.id) : [];
    relatedBox.hidden = related.length === 0;
    relatedBox.replaceChildren(h('span', { class: 'related-label' }, `${item.screenId ?? ''}:`), ...related.map((x) => {
      const link = h('button', {
        type: 'button', class: 'related-link', 'data-id': x.id,
        title: `${x.element}: ${x.detail}`, 'aria-label': `${x.name}, ${x.detail}: ${statusWord(x.status, settings.labels)}`,
      }, glyph(x.status), h('span', { class: 'related-name' }, x.element === 'Page' ? 'Page' : x.name));
      link.addEventListener('click', () => {
        void openItem(x);
        if (!explorer.drawer.hidden) explorer.reveal(x.id);
      });
      return link;
    }));
  }

  function stepItem(delta: 1 | -1): void {
    if (!views || !current) return;
    const list = explorer.visibleItems();
    if (list.length === 0) return;
    const i = list.findIndex((x) => x.id === current?.item.id);
    const next = i < 0 ? (delta > 0 ? list[0] : list[list.length - 1]) : list[(i + delta + list.length) % list.length];
    if (!next) return;
    void openItem(next);
    if (!explorer.drawer.hidden) explorer.reveal(next.id);
  }

  function back(): void {
    if (!current || !views) return;
    openSeq++;
    clearTimeout(loadingTimer);
    itemLoading.hidden = true;
    const id = current.item.id;
    views.closeView();
    if (!explorer.drawer.hidden) {
      explorer.reveal(id);
      explorer.focusList();
    }
  }

  function showInProject(): void {
    if (!current || !views) return;
    const side: Side = current.item.b ? 'b' : 'a';
    views.revealLine(side, current.item[side]?.startLine ?? 1);
  }

  // Quick open (Ctrl+P): fuzzy over every item, ignoring the explorer filter.
  let qoResults: ProjectItem[] = [];
  let qoCursor = 0;
  function renderQuickOpen(): void {
    const q = qoInput.value.trim();
    const items = index?.items ?? [];
    qoResults = q === ''
      ? items.slice(0, QUICK_OPEN_LIMIT)
      : items.map((it) => [it, fuzzyItem(q, it.name, it.detail)] as const)
        .filter((x): x is readonly [ProjectItem, number] => x[1] !== null)
        .sort((x, y) => y[1] - x[1])
        .slice(0, QUICK_OPEN_LIMIT)
        .map((x) => x[0]);
    qoCursor = Math.min(qoCursor, Math.max(0, qoResults.length - 1));
    qoList.replaceChildren(...qoResults.map((it, i) => {
      const li = h('li', {
        id: `sd-qo-${i}`, role: 'option', class: 'qo-item', 'data-testid': 'quick-open-item', 'data-id': it.id, 'data-status': it.status,
        'aria-selected': String(i === qoCursor), 'aria-label': `${it.name}, ${GROUP_LABELS[it.group]}: ${statusWord(it.status, settings.labels)}`,
      }, glyph(it.status), h('span', { class: 'qo-name' }, it.name), h('span', { class: 'qo-detail' }, it.detail), h('span', { class: 'qo-group' }, GROUP_LABELS[it.group]));
      li.addEventListener('mousedown', (e) => e.preventDefault());
      li.addEventListener('click', () => chooseQuickOpen(i));
      return li;
    }));
    if (qoResults.length) qoInput.setAttribute('aria-activedescendant', `sd-qo-${qoCursor}`);
    else qoInput.removeAttribute('aria-activedescendant');
    qoList.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
    const more = q === '' && items.length > QUICK_OPEN_LIMIT ? ` · showing ${QUICK_OPEN_LIMIT} of ${fmt(items.length)}, type to search` : '';
    qoFoot.textContent = qoResults.length === 0 ? 'No matching items.' : `${views ? 'Enter opens' : 'Enter shows it in the explorer'} · ↑↓ move · Esc closes${more}`;
  }
  function chooseQuickOpen(i: number): void {
    const it = qoResults[i];
    if (!it) return;
    quickOpen.close();
    if (views) void openItem(it);
    else if (!explorerSettings.open) toggleExplorer(true);
    if (explorerSettings.open) explorer.reveal(it.id);
  }
  function openQuickOpen(): void {
    if (!isProject()) return;
    qoInput.value = '';
    qoCursor = 0;
    renderQuickOpen();
    openDialog(quickOpen);
    qoInput.focus();
  }
  qoInput.addEventListener('input', () => {
    qoCursor = 0;
    renderQuickOpen();
  });
  qoInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') qoCursor = Math.min(qoCursor + 1, qoResults.length - 1);
    else if (e.key === 'ArrowUp') qoCursor = Math.max(qoCursor - 1, 0);
    else if (e.key === 'Enter') {
      e.preventDefault();
      chooseQuickOpen(qoCursor);
      return;
    } else return;
    e.preventDefault();
    renderQuickOpen();
  });

  btnExplorer.addEventListener('click', () => toggleExplorer());
  btnBack.addEventListener('click', back);
  btnShowInProject.addEventListener('click', showInProject);
  btnPrevItem.addEventListener('click', () => stepItem(-1));
  btnNextItem.addEventListener('click', () => stepItem(1));

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
    for (const d of [shortcutsDialog, addLangDialog, quickOpen]) {
      if (d.open) {
        d.close();
        closed = true;
      }
    }
    return closed;
  }

  /** Esc should stay with the filter box (clears it) or Monaco's find widget (closes it). */
  function escapeBelongsToTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    if (target instanceof HTMLInputElement && target.value !== '' && target.type === 'search') return true;
    return target.closest('.editor') !== null && editorEl.querySelector('.find-widget.visible') !== null;
  }

  function undoOrRedo(action: 'undo' | 'redo'): void {
    if (!history || !ready) return;
    const done = action === 'undo' ? history.undoReplace() : history.redoReplace();
    if (!done) showToast(action === 'undo' ? 'Nothing to undo' : 'Nothing to redo');
  }

  // ---------- keyboard shortcuts: document, capture phase, so Monaco can't swallow them ----------
  document.addEventListener('keydown', (e) => {
    const dialogOpen = shortcutsDialog.open || addLangDialog.open || quickOpen.open;
    const stop = (): void => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (e.key === 'Escape') {
      if (closeDialogs()) stop();
      else if (current && !escapeBelongsToTarget(e.target)) {
        back();
        stop();
      }
      return;
    }
    if (dialogOpen) return;
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      const key = e.key.toLowerCase();
      if (key === 'b' && !e.shiftKey && isProject()) toggleExplorer();
      else if (key === 'p' && !e.shiftKey && isProject()) openQuickOpen();
      // Inside an editor the engine owns Ctrl+Z (Monaco's stack first, then the replace history).
      else if (key === 'z' && !e.shiftKey && history && !isTextTarget(e.target)) undoOrRedo('undo');
      else if (((key === 'y' && !e.shiftKey) || (key === 'z' && e.shiftKey)) && history && !isTextTarget(e.target)) undoOrRedo('redo');
      else return;
      stop();
      return;
    }
    if (e.ctrlKey || e.metaKey) return;
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
    } else if (e.altKey && !e.shiftKey && e.key === 'ArrowLeft' && current) {
      back();
    } else if (e.altKey && !e.shiftKey && (e.key === 'PageUp' || e.key === 'PageDown') && current) {
      stepItem(e.key === 'PageUp' ? -1 : 1);
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
  renderItemBar();
  renderExplorerChrome();

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
    fullMeta[side] = bytes === 0 ? 'empty' : `${fmt(lines)} ${lines === 1 ? 'line' : 'lines'} · ${formatBytes(bytes)}`;
    if (!current) panes[side].meta.textContent = fullMeta[side];
    renderEmpty();
    scheduleIndex();
  });
  engine.on('view', ({ key }) => {
    if (key !== null) return;
    current = null;
    explorer.setActive(null);
    renderItemBar();
  });
  engine.on('history', ({ side, action, reason }) => {
    if (reason === 'swap') {
      settings.labels = { a: settings.labels.b, b: settings.labels.a };
      renderLabels(true);
      save();
    }
    showToast(historyText(side, action, reason));
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
