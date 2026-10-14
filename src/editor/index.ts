// DiffEngine: one Monaco DiffEditor, A = original (left), B = modified (right).
// Contract: docs/INTERFACES.md. Owned by Editor and Diff Core.
import { monaco } from './monaco-setup';
import { DEFAULT_SETTINGS } from '../types';
import type {
  ChangePosition,
  DegradedInfo,
  DiffEngine,
  DiffEngineEvents,
  DiffOptions,
  DiffStats,
  ItemView,
  ItemViewApi,
  LanguageId,
  ReplaceReason,
  Side,
  TextHistoryApi,
  ThemeId,
  Unsubscribe,
} from '../types';
import { invalidateDiffs, setDiffController } from './diff-provider';
import type { DiffController, DiffRunInfo } from './diff-provider';
import { ReplaceHistory } from './history';
import {
  DIFF_TIMEOUT_MS,
  clampContextLines,
  countHunks,
  degradedInfo,
  hunkFromLineChange,
  indexFromLine,
  mapDiffOptions,
  nextIndex,
} from './pure';
import type { SideSize } from './pure';

type TextModel = monaco.editor.ITextModel;
type CodeEditor = monaco.editor.ICodeEditor;
type Handler<K extends keyof DiffEngineEvents> = (payload: DiffEngineEvents[K]) => void;

/** Max characters of a paste handed to the `paste` event for language detection. */
const PASTE_SAMPLE = 8 * 1024;
/** Pastes this large into a non-empty pane skip Monaco's paste pipeline. */
const BIG_PASTE = 256 * 1024;

/** Optional internal API on Monaco's DiffEditorWidget (present in 0.57, not in the .d.ts). */
interface DiffComputationResultApi {
  getDiffComputationResult(): { quitEarly: boolean; identical: boolean } | null;
}

function hasComputationResult(e: object): e is DiffComputationResultApi {
  return typeof (e as Partial<DiffComputationResultApi>).getDiffComputationResult === 'function';
}

/**
 * Runs `cb` after the next frame has been rendered (rAF, then a task after
 * paint). Hidden tabs get no frames, so a timeout fires it anyway.
 */
function afterNextFrame(cb: () => void): void {
  let done = false;
  const run = (): void => {
    if (done) return;
    done = true;
    clearTimeout(fallback);
    cb();
  };
  const fallback = setTimeout(run, 1000);
  requestAnimationFrame(() => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => {
      ch.port1.close();
      run();
    };
    ch.port2.postMessage(null);
  });
}

function mark(name: string): void {
  try {
    performance.mark(name);
  } catch {
    // marks are diagnostics only
  }
}

/** Editor options that keep huge models cheap. Applied to both sides. */
const BASE_EDITOR_OPTIONS: monaco.editor.IDiffEditorConstructionOptions = {
  automaticLayout: true,
  originalEditable: true,
  readOnly: false,
  diffAlgorithm: 'advanced',
  experimental: { showMoves: false },
  renderMarginRevertIcon: false,
  renderGutterMenu: false,
  renderOverviewRuler: true,
  enableSplitViewResizing: true,
  scrollBeyondLastLine: false,
  // Features that scan the whole model or chatter with the worker.
  links: false,
  codeLens: false,
  quickSuggestions: false,
  suggestOnTriggerCharacters: false,
  parameterHints: { enabled: false },
  occurrencesHighlight: 'off',
  selectionHighlight: false,
  bracketPairColorization: { enabled: false },
  guides: { bracketPairs: false, indentation: true },
  stickyScroll: { enabled: false },
  unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: false, nonBasicASCII: false },
  lightbulb: { enabled: monaco.editor.ShowLightbulbIconMode.Off },
  matchBrackets: 'always',
};

export type SideDiffEngine = DiffEngine & ItemViewApi & TextHistoryApi;

interface OpenView {
  key: string;
  models: Record<Side, TextModel>;
  language: LanguageId;
  /** Full-text view state when the view opened, restored by closeView. */
  saved: monaco.editor.IDiffEditorViewState | null;
  /** The full models that `saved` belongs to. */
  savedModels: Record<Side, TextModel>;
}

export function createDiffEngine(): SideDiffEngine {
  const listeners = new Map<keyof DiffEngineEvents, Set<(p: never) => void>>();
  const disposables: monaco.IDisposable[] = [];
  const domCleanups: (() => void)[] = [];

  let diffEditor: monaco.editor.IStandaloneDiffEditor | null = null;
  let options: DiffOptions = { ...DEFAULT_SETTINGS.diff };
  let language: LanguageId = 'plaintext';
  let modelSeq = 0;
  /** The full texts. getText() always reads these, even while an item view is shown. */
  const models: Record<Side, TextModel> = {
    a: monaco.editor.createModel('', language, nextUri('a')),
    b: monaco.editor.createModel('', language, nextUri('b')),
  };
  const sizes: Record<Side, SideSize> = { a: { lines: 1, bytes: 0 }, b: { lines: 1, bytes: 0 } };
  let degraded: DegradedInfo | null = null;
  let attachScheduled = false;
  let pendingDispose: TextModel[] = [];
  let view: OpenView | null = null;

  // Diff lifecycle.
  let computing = false;
  let waitStart = 0;
  let inflight = 0;
  let lastRun: DiffRunInfo | null = null;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let stats: DiffStats | null = null;
  let finalizeSeq = 0;
  /** Runs once after the next diff result is shown (re-anchors the viewport). */
  let restoreView: (() => void) | null = null;

  // Navigation.
  let revealLines: number[] = [];
  let position: ChangePosition = { index: 0, total: 0 };
  let placedLine: number | null = null;
  let lastFocused: Side = 'b';

  function nextUri(side: Side | 'view-a' | 'view-b'): monaco.Uri {
    return monaco.Uri.parse(`inmemory://sidediff/${side}/${++modelSeq}`);
  }

  /** What the diff editor shows: the item view's models, or the full texts. */
  function shown(): Record<Side, TextModel> {
    return view ? view.models : models;
  }

  function emit<K extends keyof DiffEngineEvents>(event: K, payload: DiffEngineEvents[K]): void {
    const set = listeners.get(event);
    if (!set) return;
    for (const h of [...set]) {
      try {
        (h as Handler<K>)(payload);
      } catch (err) {
        console.error(`sidediff: ${event} handler failed`, err);
      }
    }
  }

  function editorFor(side: Side): CodeEditor | null {
    if (!diffEditor) return null;
    // Inline mode shows one editor (the modified one); both sides map to it.
    if (side === 'a' && options.viewMode === 'side-by-side') return diffEditor.getOriginalEditor();
    return diffEditor.getModifiedEditor();
  }

  /** Disposes a model now, or once the diff editor no longer shows it. */
  function release(m: TextModel): void {
    if (m.isDisposed()) return;
    const cur = diffEditor?.getModel();
    if (cur?.original === m || cur?.modified === m || attachScheduled) pendingDispose.push(m);
    else m.dispose();
  }

  const history = new ReplaceHistory<TextModel>({
    size: (m) => (m.isDisposed() ? 0 : m.getValueLength()),
    drop: release,
  });

  // --- options / degraded -------------------------------------------------

  /** Degraded mode describes the full texts; item views are always small enough. */
  function effectiveDegraded(): boolean {
    return degraded !== null && view === null;
  }

  function applyEditorOptions(): void {
    if (!diffEditor) return;
    const mapped = mapDiffOptions(options, effectiveDegraded());
    ctl.lineLevelOnly = effectiveDegraded();
    diffEditor.updateOptions({ ...mapped, readOnly: view !== null, originalEditable: view === null });
    // The DiffEditor forces minimap and folding off on both sides on every
    // updateOptions; set them on the sub-editors directly afterwards.
    const sub = { minimap: mapped.minimap, folding: mapped.folding };
    // Inline mode hides the original editor but leaves it focusable; keep it
    // out of the tab order so keyboard focus never lands in an invisible pane.
    // Monaco sets wordWrapOverride2 'off' on the hidden original editor in
    // inline mode and never resets it, so A stayed unwrapped after inline →
    // side-by-side. Reset it here.
    diffEditor.getOriginalEditor().updateOptions({
      ...sub,
      tabIndex: mapped.renderSideBySide ? 0 : -1,
      ...(mapped.renderSideBySide ? { wordWrapOverride2: 'inherit' as const } : {}),
    });
    // Item views are read-only; the DiffEditor does not pass readOnly on to the right-hand editor.
    diffEditor.getModifiedEditor().updateOptions({ ...sub, readOnly: view !== null });
  }

  function measure(side: Side): void {
    const m = models[side];
    // `bytes` counts UTF-16 code units: equal to UTF-8 bytes for ASCII, and
    // O(1) to read on every keystroke (see DECISIONS.md).
    sizes[side] = { lines: m.getLineCount(), bytes: m.getValueLength() };
  }

  function updateDegraded(): void {
    const next = degradedInfo(sizes);
    const changed = (next === null) !== (degraded === null) || next?.sides.join() !== degraded?.sides.join();
    degraded = next;
    if (!changed) return;
    emit('degraded', next);
    applyEditorOptions();
    invalidateDiffs();
  }

  function emitContent(side: Side): void {
    emit('content', { side, lines: sizes[side].lines, bytes: sizes[side].bytes });
  }

  // --- diff lifecycle -----------------------------------------------------

  function beginWait(): void {
    if (computing) return;
    computing = true;
    waitStart = performance.now();
    mark('sidediff:diff-start');
    const s = shown();
    emit('diff:start', { linesA: s.a.getLineCount(), linesB: s.b.getLineCount() });
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      if (!computing) return;
      computing = false;
      emit('diff:error', { message: `The diff did not finish within ${DIFF_TIMEOUT_MS / 1000} s.` });
    }, DIFF_TIMEOUT_MS);
  }

  function endWait(): void {
    computing = false;
    clearTimeout(watchdog);
  }

  const ctl: DiffController = {
    ignoreAllWhitespace: options.ignoreAllWhitespace,
    lineLevelOnly: false,
    maxComputationTimeMs: null,
    isCurrent(original, modified) {
      const s = shown();
      return original === s.a && modified === s.b;
    },
    onRunStart(original, modified) {
      const s = shown();
      if (original !== s.a || modified !== s.b) return;
      inflight++;
      lastRun = null;
      beginWait();
    },
    onRunEnd(info) {
      inflight = Math.max(0, inflight - 1);
      if (!info.cancelled) lastRun = info;
    },
    onRunError(err) {
      inflight = Math.max(0, inflight - 1);
      endWait();
      emit('diff:error', { message: err instanceof Error ? err.message : String(err) });
    },
  };
  setDiffController(ctl);

  function onDiffUpdated(): void {
    if (!diffEditor || inflight > 0) return;
    const changes = diffEditor.getLineChanges();
    if (!changes) return;
    const seq = ++finalizeSeq;
    const result = hasComputationResult(diffEditor) ? diffEditor.getDiffComputationResult() : null;
    const run = lastRun;
    const hunks = changes.map(hunkFromLineChange);
    revealLines = changes.map((c) => Math.max(1, c.modifiedStartLineNumber));
    if (!computing) beginWait();
    const computeMs = run ? run.ms : performance.now() - waitStart;
    const s = shown();
    stats = {
      ...countHunks(hunks),
      linesA: s.a.getLineCount(),
      linesB: s.b.getLineCount(),
      computeMs: Math.round(computeMs),
      identical: result ? result.identical : changes.length === 0,
      quitEarly: run ? run.quitEarly : (result?.quitEarly ?? false),
    };
    const total = stats.changes;
    const index = position.index <= total ? position.index : 0;
    afterNextFrame(() => {
      if (seq !== finalizeSeq || !stats) return;
      const restore = restoreView;
      restoreView = null;
      restore?.();
      endWait();
      mark('sidediff:diff-done');
      emit('diff:done', stats);
      setPosition(index, total, true);
    });
  }

  // --- models -------------------------------------------------------------

  function attachModels(): void {
    attachScheduled = false;
    if (!diffEditor) return;
    const s = shown();
    const current = diffEditor.getModel();
    if (current?.original !== s.a || current?.modified !== s.b) {
      diffEditor.setModel({ original: s.a, modified: s.b });
    }
    const keep = pendingDispose.filter((m) => m === s.a || m === s.b);
    for (const m of pendingDispose) if (!keep.includes(m) && !m.isDisposed()) m.dispose();
    pendingDispose = keep;
  }

  function scheduleAttach(): void {
    // Coalesce setText(a) + setText(b) in the same task into one setModel, so
    // the worker never diffs the new A against the old B.
    if (attachScheduled) return;
    attachScheduled = true;
    queueMicrotask(attachModels);
  }

  /** Puts `model` on `side` of the full texts (no history bookkeeping). */
  function setSideModel(side: Side, model: TextModel): void {
    models[side] = model;
    if (model.getLanguageId() !== language) monaco.editor.setModelLanguage(model, language);
    measure(side);
    afterFullTextChange([side]);
  }

  /** Shared tail of every whole-text change on the full models. */
  function afterFullTextChange(sides: Side[]): void {
    if (!view) {
      setPosition(0, position.total);
      placedLine = null;
    }
    if (diffEditor && !view) {
      scheduleAttach();
      for (const side of sides) afterNextFrame(() => mark(`sidediff:first-render:${side}`));
    }
    for (const side of sides) emitContent(side);
    updateDegraded();
    // While an item view is shown the full texts are not diffed, so there is
    // no run to wait for.
    if (diffEditor && !view) beginWait();
  }

  function replaceModel(side: Side, text: string, reason: ReplaceReason): void {
    mark(`sidediff:text-set:${side}`);
    const old = models[side];
    // A fresh model (instead of setValue) lets Monaco's large-file checks,
    // which run only at construction, turn off tokenization above 20 MB / 300k
    // lines. The replaced model goes on the history (D13), undo stack and all.
    const fresh = monaco.editor.createModel(text, language, nextUri(side));
    history.record({ sides: [side], reason, models: { [side]: old } });
    setSideModel(side, fresh);
  }

  function swapModels(): void {
    const a = models.a;
    models.a = models.b;
    models.b = a;
    const s = sizes.a;
    sizes.a = sizes.b;
    sizes.b = s;
    afterFullTextChange(['a', 'b']);
  }

  // --- whole-text undo ------------------------------------------------------

  function undoOrRedo(action: 'undo' | 'redo', side?: Side): boolean {
    const entry = action === 'undo' ? history.takeUndo(side) : history.takeRedo(side);
    if (!entry) return false;
    const back = action === 'undo' ? history.pushRedo.bind(history) : history.pushUndo.bind(history);
    if (entry.sides.length === 2) {
      // Swap: swapping again restores the other arrangement.
      swapModels();
      back({ sides: ['a', 'b'], reason: entry.reason, models: {} });
      emit('history', { side: 'both', action, reason: entry.reason });
      return true;
    }
    const s = entry.sides[0]!;
    const target = entry.models[s];
    if (!target || target.isDisposed()) return false;
    const current = models[s];
    setSideModel(s, target);
    back({ sides: [s], reason: entry.reason, models: { [s]: current } });
    emit('history', { side: s, action, reason: entry.reason });
    return true;
  }

  /** Ctrl+Z / Ctrl+Y in a focused pane: Monaco's own stack first, then the whole-text history. */
  function keyUndoRedo(action: 'undo' | 'redo'): void {
    if (!diffEditor) return;
    const side: Side | null = diffEditor.getOriginalEditor().hasTextFocus()
      ? 'a'
      : diffEditor.getModifiedEditor().hasTextFocus()
        ? 'b'
        : null;
    if (!side) return;
    const ed = side === 'a' ? diffEditor.getOriginalEditor() : diffEditor.getModifiedEditor();
    const model = ed.getModel();
    if (!model) return;
    const own = action === 'undo' ? model.canUndo() : model.canRedo();
    if (own) {
      ed.trigger('keyboard', action, null);
      return;
    }
    // Item views are read-only; whole-text undo would change texts that are not on screen.
    if (view) return;
    undoOrRedo(action, side);
  }

  // --- item views -----------------------------------------------------------

  function openItemView(v: ItemView): void {
    const previous = view;
    const saved = previous ? previous.saved : (diffEditor?.saveViewState() ?? null);
    const savedModels = previous ? previous.savedModels : { a: models.a, b: models.b };
    view = {
      key: v.key,
      language: v.language,
      saved,
      savedModels,
      models: {
        a: monaco.editor.createModel(v.a ?? '', v.language, nextUri('view-a')),
        b: monaco.editor.createModel(v.b ?? '', v.language, nextUri('view-b')),
      },
    };
    if (previous) {
      release(previous.models.a);
      release(previous.models.b);
    }
    restoreView = null;
    setPosition(0, 0, true);
    placedLine = null;
    revealLines = [];
    stats = null;
    applyEditorOptions();
    if (diffEditor) {
      attachModels();
      diffEditor.getModifiedEditor().setScrollTop(0);
      beginWait();
    }
    emit('view', { key: v.key });
  }

  function closeItemView(after?: () => void): void {
    if (!view) return;
    const closing = view;
    view = null;
    release(closing.models.a);
    release(closing.models.b);
    setPosition(0, 0, true);
    placedLine = null;
    revealLines = [];
    stats = null;
    applyEditorOptions();
    if (diffEditor) {
      const ed = diffEditor;
      const sameModels = closing.savedModels.a === models.a && closing.savedModels.b === models.b;
      // Restore once the diff (and with diff only, its collapsed regions) is back.
      restoreView = () => {
        if (closing.saved && sameModels) ed.restoreViewState(closing.saved);
        after?.();
      };
      attachModels();
      beginWait();
    } else {
      after?.();
    }
    emit('view', { key: null });
  }

  function revealFullLine(side: Side, line: number): void {
    const ed = editorFor(side);
    if (!ed) return;
    const model = ed.getModel();
    const n = Math.min(Math.max(1, Math.round(line)), model?.getLineCount() ?? 1);
    // The cursor move also expands a collapsed region hiding the line.
    ed.setPosition({ lineNumber: n, column: 1 });
    ed.revealLineInCenter(n, monaco.editor.ScrollType.Immediate);
    ed.focus();
  }

  // --- navigation ---------------------------------------------------------

  function setPosition(index: number, total: number, force = false): void {
    if (!force && index === position.index && total === position.total) return;
    position = { index, total };
    emit('position', { ...position });
  }

  function reveal(index: number, scroll = monaco.editor.ScrollType.Smooth): void {
    const ed = diffEditor?.getModifiedEditor();
    const line = revealLines[index - 1];
    if (!ed || line === undefined) return;
    // Moving the cursor makes Monaco expand a collapsed region that hides it.
    ed.setPosition({ lineNumber: line, column: 1 });
    ed.revealLineInCenter(line, scroll);
    placedLine = line;
  }

  function step(dir: 1 | -1): void {
    const total = revealLines.length;
    if (!diffEditor || total === 0) return;
    const cursor = diffEditor.getModifiedEditor().getPosition()?.lineNumber ?? 1;
    let index: number;
    if (position.index > 0 && cursor === placedLine) index = nextIndex(position.index, total, dir);
    else if (position.index === 0 && placedLine === null && cursor === 1) index = nextIndex(0, total, dir);
    else index = indexFromLine(revealLines, cursor, dir);
    reveal(index);
    setPosition(index, total);
  }

  // --- paste --------------------------------------------------------------

  function installPaste(side: Side, ed: CodeEditor): void {
    const node = ed.getContainerDomNode();
    const onPaste = (e: ClipboardEvent): void => {
      // Item views are read-only: let Monaco show its read-only notice.
      if (view) return;
      const text = e.clipboardData?.getData('text/plain');
      if (text === undefined || text === '') return;
      const model = models[side];
      const sel = ed.getSelection();
      const replacesAll =
        model.getValueLength() === 0 || (sel !== null && sel.equalsRange(model.getFullModelRange()));
      if (replacesAll) {
        // Fast path: build a new model straight from the clipboard string.
        e.preventDefault();
        e.stopImmediatePropagation();
        replaceModel(side, text, 'paste');
        ed.focus();
      } else if (text.length >= BIG_PASTE) {
        e.preventDefault();
        e.stopImmediatePropagation();
        const sels = ed.getSelections() ?? [];
        ed.pushUndoStop();
        ed.executeEdits('sidediff.paste', sels.map((range) => ({ range, text, forceMoveMarkers: true })));
        ed.pushUndoStop();
      }
      // Small pastes go through Monaco's own handler; content events follow.
      const sample = text.slice(0, PASTE_SAMPLE);
      setTimeout(() => emit('paste', { side, sample }), 0);
    };
    node.addEventListener('paste', onPaste, true);
    domCleanups.push(() => node.removeEventListener('paste', onPaste, true));
  }

  /**
   * Monaco expands a collapsed region on double-click of its "N hidden lines"
   * label (or via the small unfold icon). The spec wants a plain click.
   */
  function installSeparatorClick(container: HTMLElement): void {
    const onClick = (e: MouseEvent): void => {
      if (e.button !== 0 || !(e.target instanceof Element)) return;
      const label = e.target.closest('.diff-hidden-lines .center .content-row > span:first-child');
      if (!label) return;
      label.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, button: 0 }));
    };
    container.addEventListener('click', onClick);
    domCleanups.push(() => container.removeEventListener('click', onClick));
  }

  function wireEditor(side: Side, ed: CodeEditor): void {
    disposables.push(
      ed.onDidChangeModelContent((e) => {
        const m = ed.getModel();
        if (!m || m !== models[side]) return;
        // Typing (not Monaco's own undo/redo) invalidates that side's whole-text redo.
        if (!e.isUndoing && !e.isRedoing) history.clearRedo([side]);
        measure(side);
        emitContent(side);
        updateDegraded();
        beginWait();
      }),
      ed.onDidFocusEditorText(() => {
        lastFocused = side;
      }),
    );
    installPaste(side, ed);
  }

  // --- engine -------------------------------------------------------------

  const engine: SideDiffEngine = {
    mount(container) {
      if (diffEditor) throw new Error('DiffEngine.mount: already mounted');
      diffEditor = monaco.editor.createDiffEditor(container, {
        ...BASE_EDITOR_OPTIONS,
        ...mapDiffOptions(options, effectiveDegraded()),
      });
      applyEditorOptions();
      installSeparatorClick(container);
      wireEditor('a', diffEditor.getOriginalEditor());
      wireEditor('b', diffEditor.getModifiedEditor());
      disposables.push(diffEditor.onDidUpdateDiff(onDiffUpdated));
      // Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z while a pane has text focus (D13).
      const { KeyMod, KeyCode } = monaco;
      const undoId = `sidediff.undo.${++modelSeq}`;
      const redoId = `sidediff.redo.${modelSeq}`;
      disposables.push(
        monaco.editor.addCommand({ id: undoId, run: () => keyUndoRedo('undo') }),
        monaco.editor.addCommand({ id: redoId, run: () => keyUndoRedo('redo') }),
        monaco.editor.addKeybindingRules([
          { keybinding: KeyMod.CtrlCmd | KeyCode.KeyZ, command: undoId, when: 'editorTextFocus' },
          { keybinding: KeyMod.CtrlCmd | KeyCode.KeyY, command: redoId, when: 'editorTextFocus' },
          { keybinding: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyZ, command: redoId, when: 'editorTextFocus' },
        ]),
      );
      attachModels();
      beginWait();
    },

    setText(side, text) {
      replaceModel(side, text, 'set');
    },

    replaceText(side, text, reason) {
      replaceModel(side, text, reason);
    },

    getText(side) {
      return models[side].getValue();
    },

    setLanguage(id) {
      language = id;
      monaco.editor.setModelLanguage(models.a, id);
      monaco.editor.setModelLanguage(models.b, id);
      if (view) {
        view.language = id;
        monaco.editor.setModelLanguage(view.models.a, id);
        monaco.editor.setModelLanguage(view.models.b, id);
      }
    },

    setOptions(partial) {
      const prev = options;
      options = { ...options, ...partial };
      const diffOnlyChanged = prev.diffOnly !== options.diffOnly;
      const allWsChanged = prev.ignoreAllWhitespace !== options.ignoreAllWhitespace;
      // Set before updateOptions: an ignoreTrimWhitespace change starts a run synchronously.
      ctl.ignoreAllWhitespace = options.ignoreAllWhitespace;
      // Monaco carries the previous visible ranges over to newly computed
      // unchanged regions, so a smaller context count would never hide the
      // extra lines. A fresh view model (detach + reattach) starts clean.
      const contextChanged = clampContextLines(prev.contextLines) !== clampContextLines(options.contextLines);
      const reattach = contextChanged && diffEditor?.getModel() != null;
      if (reattach && diffEditor) {
        // Pixel offsets change with the new layout: re-anchor on the current
        // change (or the top visible line) once the fresh regions exist.
        const ed = diffEditor.getModifiedEditor();
        const anchorIndex = position.index;
        const anchorLine = ed.getVisibleRanges()[0]?.startLineNumber ?? 1;
        const cursor = ed.getPosition();
        restoreView = () => {
          if (anchorIndex > 0 && anchorIndex <= revealLines.length) {
            reveal(anchorIndex, monaco.editor.ScrollType.Immediate);
          } else {
            if (cursor) ed.setPosition(cursor);
            ed.setScrollTop(ed.getTopForLineNumber(anchorLine));
          }
        };
        diffEditor.setModel(null);
      }
      if (diffOnlyChanged) mark('sidediff:diffonly-start');
      applyEditorOptions();
      if (diffOnlyChanged) afterNextFrame(() => mark('sidediff:diffonly-done'));
      if (reattach && diffEditor) {
        const s = shown();
        diffEditor.setModel({ original: s.a, modified: s.b });
        beginWait();
      }
      if (allWsChanged) invalidateDiffs();
    },

    setTheme(theme: ThemeId) {
      monaco.editor.setTheme(theme === 'light' ? 'vs' : 'vs-dark');
    },

    swap() {
      history.record({ sides: ['a', 'b'], reason: 'swap', models: {} });
      swapModels();
    },

    undoReplace(side) {
      return undoOrRedo('undo', side);
    },

    redoReplace(side) {
      return undoOrRedo('redo', side);
    },

    canUndoReplace(side) {
      return history.canUndo(side);
    },

    canRedoReplace(side) {
      return history.canRedo(side);
    },

    openView(v) {
      openItemView(v);
    },

    closeView() {
      closeItemView();
    },

    getView() {
      return view?.key ?? null;
    },

    revealLine(side, line) {
      if (view) closeItemView(() => revealFullLine(side, line));
      else revealFullLine(side, line);
    },

    nextChange() {
      step(1);
    },

    prevChange() {
      step(-1);
    },

    goToChange(index) {
      const total = revealLines.length;
      if (total === 0) return;
      const i = Math.min(total, Math.max(1, Math.round(index)));
      reveal(i);
      setPosition(i, total);
    },

    getStats() {
      return stats ? { ...stats } : null;
    },

    getPosition() {
      return { ...position };
    },

    isComputing() {
      return computing;
    },

    focus(side) {
      editorFor(side)?.focus();
    },

    find(side) {
      const ed = editorFor(side ?? lastFocused);
      if (!ed) return;
      ed.focus();
      void ed.getAction('actions.find')?.run();
    },

    layout() {
      diffEditor?.layout();
    },

    on(event, handler) {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      const h = handler as (p: never) => void;
      set.add(h);
      return (() => {
        set.delete(h);
      }) satisfies Unsubscribe;
    },

    dispose() {
      clearTimeout(watchdog);
      setDiffController(null);
      for (const c of domCleanups.splice(0)) c();
      for (const d of disposables.splice(0)) d.dispose();
      diffEditor?.dispose();
      diffEditor = null;
      attachScheduled = false;
      history.clear();
      if (view) {
        view.models.a.dispose();
        view.models.b.dispose();
        view = null;
      }
      models.a.dispose();
      models.b.dispose();
      for (const m of pendingDispose) if (!m.isDisposed()) m.dispose();
      pendingDispose = [];
      listeners.clear();
    },
  };

  return engine;
}

/** Test hook: every model Monaco still holds (dispose() must leave none of ours). */
export function liveModelCount(): number {
  return monaco.editor.getModels().filter((m) => m.uri.authority === 'sidediff').length;
}
