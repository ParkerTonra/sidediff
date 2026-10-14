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
  LanguageId,
  Side,
  ThemeId,
  Unsubscribe,
} from '../types';
import { invalidateDiffs, setDiffController } from './diff-provider';
import type { DiffController, DiffRunInfo } from './diff-provider';
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

export function createDiffEngine(): DiffEngine {
  const listeners = new Map<keyof DiffEngineEvents, Set<(p: never) => void>>();
  const disposables: monaco.IDisposable[] = [];
  const domCleanups: (() => void)[] = [];

  let diffEditor: monaco.editor.IStandaloneDiffEditor | null = null;
  let options: DiffOptions = { ...DEFAULT_SETTINGS.diff };
  let language: LanguageId = 'plaintext';
  let modelSeq = 0;
  const models: Record<Side, TextModel> = {
    a: monaco.editor.createModel('', language, nextUri('a')),
    b: monaco.editor.createModel('', language, nextUri('b')),
  };
  const sizes: Record<Side, SideSize> = { a: { lines: 1, bytes: 0 }, b: { lines: 1, bytes: 0 } };
  let degraded: DegradedInfo | null = null;
  let attachScheduled = false;
  let pendingDispose: TextModel[] = [];

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

  function nextUri(side: Side): monaco.Uri {
    return monaco.Uri.parse(`inmemory://sidediff/${side}/${++modelSeq}`);
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

  // --- options / degraded -------------------------------------------------

  function applyEditorOptions(): void {
    if (!diffEditor) return;
    const mapped = mapDiffOptions(options, degraded !== null);
    diffEditor.updateOptions(mapped);
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
    diffEditor.getModifiedEditor().updateOptions(sub);
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
    ctl.lineLevelOnly = next !== null;
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
    emit('diff:start', { linesA: sizes.a.lines, linesB: sizes.b.lines });
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
    onRunStart(original, modified) {
      if (original !== models.a || modified !== models.b) return;
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
    stats = {
      ...countHunks(hunks),
      linesA: models.a.getLineCount(),
      linesB: models.b.getLineCount(),
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
    const current = diffEditor.getModel();
    if (current?.original !== models.a || current?.modified !== models.b) {
      diffEditor.setModel({ original: models.a, modified: models.b });
    }
    for (const m of pendingDispose) if (m !== models.a && m !== models.b && !m.isDisposed()) m.dispose();
    pendingDispose = [];
  }

  function scheduleAttach(): void {
    // Coalesce setText(a) + setText(b) in the same task into one setModel, so
    // the worker never diffs the new A against the old B.
    if (attachScheduled) return;
    attachScheduled = true;
    queueMicrotask(attachModels);
  }

  function replaceModel(side: Side, text: string): void {
    mark(`sidediff:text-set:${side}`);
    const old = models[side];
    // A fresh model (instead of setValue) lets Monaco's large-file checks,
    // which run only at construction, turn off tokenization above 20 MB / 300k
    // lines, and drops the old undo stack with the old text.
    models[side] = monaco.editor.createModel(text, language, nextUri(side));
    pendingDispose.push(old);
    measure(side);
    setPosition(0, position.total);
    placedLine = null;
    if (diffEditor) {
      scheduleAttach();
      afterNextFrame(() => mark(`sidediff:first-render:${side}`));
    }
    emitContent(side);
    updateDegraded();
    if (diffEditor) beginWait();
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
        replaceModel(side, text);
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
      ed.onDidChangeModelContent(() => {
        const m = ed.getModel();
        if (!m || m !== models[side]) return;
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

  const engine: DiffEngine = {
    mount(container) {
      if (diffEditor) throw new Error('DiffEngine.mount: already mounted');
      diffEditor = monaco.editor.createDiffEditor(container, {
        ...BASE_EDITOR_OPTIONS,
        ...mapDiffOptions(options, degraded !== null),
      });
      applyEditorOptions();
      installSeparatorClick(container);
      wireEditor('a', diffEditor.getOriginalEditor());
      wireEditor('b', diffEditor.getModifiedEditor());
      disposables.push(diffEditor.onDidUpdateDiff(onDiffUpdated));
      attachModels();
      beginWait();
    },

    setText(side, text) {
      replaceModel(side, text);
    },

    getText(side) {
      return models[side].getValue();
    },

    setLanguage(id) {
      language = id;
      monaco.editor.setModelLanguage(models.a, id);
      monaco.editor.setModelLanguage(models.b, id);
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
        diffEditor.setModel({ original: models.a, modified: models.b });
        beginWait();
      }
      if (allWsChanged) invalidateDiffs();
    },

    setTheme(theme: ThemeId) {
      monaco.editor.setTheme(theme === 'light' ? 'vs' : 'vs-dark');
    },

    swap() {
      const a = models.a;
      models.a = models.b;
      models.b = a;
      const s = sizes.a;
      sizes.a = sizes.b;
      sizes.b = s;
      setPosition(0, position.total);
      placedLine = null;
      if (diffEditor) {
        scheduleAttach();
        beginWait();
      }
      emitContent('a');
      emitContent('b');
      updateDegraded();
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
      models.a.dispose();
      models.b.dispose();
      for (const m of pendingDispose) if (!m.isDisposed()) m.dispose();
      pendingDispose = [];
      listeners.clear();
    },
  };

  return engine;
}
