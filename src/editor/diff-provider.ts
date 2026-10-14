// Replaces Monaco's diff provider factory so the engine controls every diff
// run: exact timing, ignore-all-whitespace, degraded mode (no intra-line
// changes), and the time cap. The diff itself still runs in Monaco's editor
// web worker through IEditorWorkerService.computeDiff (same call Monaco makes).
//
// Must be installed before anything initializes Monaco's standalone services;
// monaco-setup.ts calls installDiffProvider() at module load.
import * as monaco from 'monaco-editor/editor/editor.api';
import { StandaloneServices } from 'monaco-editor/editor/standalone/browser/standaloneServices';
import { IEditorWorkerService } from 'monaco-editor/editor/common/services/editorWorker';
import type { IDocumentDiffProviderOptions } from 'monaco-editor/editor/common/services/editorWorker';
import { DetailedLineRangeMapping, RangeMapping } from 'monaco-editor/editor/common/diff/rangeMapping';
import type { IDocumentDiff } from 'monaco-editor/editor/common/diff/rangeMapping';
import { LineRange } from 'monaco-editor/editor/common/core/ranges/lineRange';
import { mapStrippedColumn, stripWhitespace } from './pure';

type TextModel = monaco.editor.ITextModel;

export interface DiffRunInfo {
  /** Wall time of the worker computation, ms. */
  ms: number;
  quitEarly: boolean;
  identical: boolean;
  cancelled: boolean;
}

/** What the engine plugs in. One engine per page. */
export interface DiffController {
  ignoreAllWhitespace: boolean;
  /** Drop intra-line changes from results. */
  lineLevelOnly: boolean;
  /** Overrides the options' maxComputationTimeMs when not null. */
  maxComputationTimeMs: number | null;
  onRunStart(original: TextModel, modified: TextModel): void;
  onRunEnd(info: DiffRunInfo): void;
  onRunError(err: unknown): void;
}

let controller: DiffController | null = null;
let installed = false;
let used = false;
const liveProviders = new Set<EngineDiffProvider>();

export function setDiffController(c: DiffController | null): void {
  controller = c;
}

/** Tells every live provider that results would differ now (Monaco recomputes). */
export function invalidateDiffs(): void {
  for (const p of liveProviders) p.fire();
}

/** True once Monaco has asked our factory for a provider (proves the override took). */
export function isDiffProviderActive(): boolean {
  return used;
}

interface CancellationTokenLike {
  readonly isCancellationRequested: boolean;
}

class EngineDiffProvider {
  private readonly emitter = new monaco.Emitter<void>();
  readonly onDidChange = this.emitter.event;

  fire(): void {
    this.emitter.fire();
  }

  async computeDiff(
    original: TextModel,
    modified: TextModel,
    options: IDocumentDiffProviderOptions,
    token: CancellationTokenLike,
  ): Promise<IDocumentDiff> {
    const ctl = controller;
    if (original.isDisposed() || modified.isDisposed()) {
      return { changes: [], identical: true, quitEarly: false, moves: [] };
    }
    ctl?.onRunStart(original, modified);
    const t0 = performance.now();
    try {
      const opts: IDocumentDiffProviderOptions = {
        ...options,
        computeMoves: false,
        maxComputationTimeMs: ctl?.maxComputationTimeMs ?? options.maxComputationTimeMs,
      };
      if (!ctl?.ignoreAllWhitespace && shadowInflight === 0) disposeShadows();
      let result = trivialDiff(original, modified);
      if (!result) {
        result = ctl?.ignoreAllWhitespace
          ? await computeIgnoringAllWhitespace(original, modified, opts)
          : await worker().computeDiff(original.uri, modified.uri, opts, 'advanced');
      }
      if (!result && (original.isDisposed() || modified.isDisposed())) {
        // The models were replaced while the worker ran; a newer run follows.
        ctl?.onRunEnd({ ms: performance.now() - t0, quitEarly: true, identical: false, cancelled: true });
        return { changes: [], identical: false, quitEarly: true, moves: [] };
      }
      if (!result) throw new Error('no diff result available');
      if (ctl?.lineLevelOnly) {
        result = { ...result, changes: result.changes.map((c) => new DetailedLineRangeMapping(c.original, c.modified, undefined)) };
      }
      ctl?.onRunEnd({
        ms: performance.now() - t0,
        quitEarly: result.quitEarly,
        identical: result.identical,
        cancelled: token.isCancellationRequested,
      });
      return result;
    } catch (err) {
      if (token.isCancellationRequested) {
        ctl?.onRunEnd({ ms: performance.now() - t0, quitEarly: true, identical: false, cancelled: true });
      } else {
        ctl?.onRunError(err);
      }
      // Leave Monaco waiting: the previous decorations stay, the engine has
      // already reported the error, and the next edit starts a fresh run.
      return new Promise<IDocumentDiff>(() => {});
    }
  }

  dispose(): void {
    liveProviders.delete(this);
    this.emitter.dispose();
  }
}

function worker() {
  return StandaloneServices.get(IEditorWorkerService);
}

function isEmptyModel(m: TextModel): boolean {
  return m.getLineCount() === 1 && m.getLineMaxColumn(1) === 1;
}

/** Empty-side shortcuts, so loading A while B is empty never reaches the worker. */
function trivialDiff(original: TextModel, modified: TextModel): IDocumentDiff | null {
  const oEmpty = isEmptyModel(original);
  const mEmpty = isEmptyModel(modified);
  if (!oEmpty && !mEmpty) return null;
  if (oEmpty && mEmpty) return { changes: [], identical: true, quitEarly: false, moves: [] };
  const change = new DetailedLineRangeMapping(
    oEmpty ? new LineRange(1, 1) : new LineRange(1, original.getLineCount() + 1),
    mEmpty ? new LineRange(1, 1) : new LineRange(1, modified.getLineCount() + 1),
    undefined,
  );
  return { changes: [change], identical: false, quitEarly: false, moves: [] };
}

// --- ignore all whitespace -------------------------------------------------
// Hidden "shadow" models hold each side with all non-newline whitespace
// removed. Line numbers are identical to the real model, so line mappings
// apply as-is; intra-line ranges are mapped back column by column. The real
// models (what the user sees and getText returns) are never touched.

interface Shadow {
  model: TextModel;
  version: number;
}

const shadows = new Map<TextModel, Shadow>();
let shadowSeq = 0;
let shadowInflight = 0;

function shadowFor(real: TextModel): TextModel {
  let s = shadows.get(real);
  if (s && s.version === real.getVersionId() && !s.model.isDisposed()) return s.model;
  const text = stripWhitespace(real.getValue());
  if (s && !s.model.isDisposed()) {
    s.model.setValue(text);
    s.version = real.getVersionId();
    return s.model;
  }
  const model = monaco.editor.createModel(text, 'plaintext', monaco.Uri.parse(`inmemory://sidediff/shadow/${++shadowSeq}`));
  s = { model, version: real.getVersionId() };
  shadows.set(real, s);
  real.onWillDispose(() => {
    shadows.get(real)?.model.dispose();
    shadows.delete(real);
  });
  return model;
}

function disposeShadows(): void {
  for (const s of shadows.values()) s.model.dispose();
  shadows.clear();
}

function mapRange(r: monaco.Range, real: TextModel): monaco.Range {
  const last = real.getLineCount();
  const sl = Math.min(r.startLineNumber, last);
  const el = Math.min(r.endLineNumber, last);
  const sc = mapStrippedColumn(real.getLineContent(sl), r.startColumn, false);
  const ec = r.isEmpty() && sl === el ? sc : mapStrippedColumn(real.getLineContent(el), r.endColumn, true);
  return new monaco.Range(sl, sc, el, sl === el ? Math.max(sc, ec) : ec);
}

async function computeIgnoringAllWhitespace(
  original: TextModel,
  modified: TextModel,
  opts: IDocumentDiffProviderOptions,
): Promise<IDocumentDiff | null> {
  const so = shadowFor(original);
  const sm = shadowFor(modified);
  shadowInflight++;
  let r: IDocumentDiff | null;
  try {
    r = await worker().computeDiff(so.uri, sm.uri, opts, 'advanced');
  } finally {
    shadowInflight--;
  }
  if (!r || original.isDisposed() || modified.isDisposed()) return r;
  return {
    ...r,
    changes: r.changes.map(
      (c) =>
        new DetailedLineRangeMapping(
          c.original,
          c.modified,
          c.innerChanges?.map((i) => new RangeMapping(mapRange(i.originalRange, original), mapRange(i.modifiedRange, modified))),
        ),
    ),
  };
}

// --- install ---------------------------------------------------------------

const factory = {
  _serviceBrand: undefined,
  createDiffProvider(): EngineDiffProvider {
    used = true;
    const p = new EngineDiffProvider();
    liveProviders.add(p);
    return p;
  },
};

export function installDiffProvider(): void {
  if (installed) return;
  installed = true;
  StandaloneServices.initialize({ diffProviderFactoryService: factory });
}
