// Replaces Monaco's diff provider factory so the engine controls every diff
// run: exact timing, ignore-all-whitespace, degraded mode (no intra-line
// changes), the time cap, and cancellation. The diff runs Monaco's own
// algorithm in a dedicated worker (diff.worker.ts) that the engine terminates
// when a newer request supersedes a running one (DECISIONS.md D11).
//
// Must be installed before anything initializes Monaco's standalone services;
// monaco-setup.ts calls installDiffProvider() at module load.
import * as monaco from 'monaco-editor/editor/editor.api';
import { StandaloneServices } from 'monaco-editor/editor/standalone/browser/standaloneServices';
import type { IDocumentDiffProviderOptions } from 'monaco-editor/editor/common/services/editorWorker';
import { DetailedLineRangeMapping, RangeMapping } from 'monaco-editor/editor/common/diff/rangeMapping';
import type { IDocumentDiff } from 'monaco-editor/editor/common/diff/rangeMapping';
import { LineRange } from 'monaco-editor/editor/common/core/ranges/lineRange';
import DiffWorker from './diff.worker?worker';
import type { DiffWorkerRequest, DiffWorkerResponse, SerializedChange } from './diff-worker-protocol';
import { mapStrippedColumn, stripWhitespace } from './pure';

type TextModel = monaco.editor.ITextModel;

export interface DiffRunInfo {
  /** Wall time of the worker computation, ms. */
  ms: number;
  quitEarly: boolean;
  identical: boolean;
  cancelled: boolean;
}

/** What each engine plugs in. */
export interface DiffController {
  ignoreAllWhitespace: boolean;
  /** Drop intra-line changes from results. */
  lineLevelOnly: boolean;
  /** Overrides the options' maxComputationTimeMs when not null. */
  maxComputationTimeMs: number | null;
  /** False for models that are no longer on screen (a replaced view model's late debounced run). */
  isCurrent(original: TextModel, modified: TextModel): boolean;
  onRunStart(original: TextModel, modified: TextModel): void;
  onRunEnd(info: DiffRunInfo): void;
  onRunError(err: unknown): void;
}

/** One per live engine; a run belongs to the engine that shows its models. */
const controllers = new Set<DiffController>();
let installed = false;
let used = false;
const liveProviders = new Set<EngineDiffProvider>();

export function registerDiffController(c: DiffController): () => void {
  controllers.add(c);
  return () => {
    controllers.delete(c);
  };
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

// --- dedicated diff worker -------------------------------------------------

class Superseded extends Error {
  constructor() {
    super('superseded by a newer diff request');
  }
}

interface SideText {
  /** Model identity + version; the worker keeps the last text per side. */
  key: string;
  text: () => string;
}

function sideOf(m: TextModel): SideText {
  return { key: `${m.uri.toString()}#${m.getVersionId()}`, text: () => m.getValue() };
}

interface PendingRun {
  id: number;
  resolve: (d: IDocumentDiff) => void;
  reject: (e: unknown) => void;
}

class DiffWorkerClient {
  private worker: Worker | null = null;
  private sent: Record<'o' | 'm', string> = { o: '', m: '' };
  private seq = 0;
  private pending: PendingRun | null = null;
  /** Running diffs abandoned because a newer request arrived. */
  superseded = 0;

  private ensure(): Worker {
    if (this.worker) return this.worker;
    const w = new DiffWorker();
    w.onmessage = (ev: MessageEvent<DiffWorkerResponse>) => this.onMessage(ev.data);
    w.onerror = (ev) => {
      ev.preventDefault();
      this.stop(new Error(`diff worker failed: ${ev.message || 'unknown error'}`));
    };
    this.worker = w;
    this.sent = { o: '', m: '' };
    return w;
  }

  /** Terminates the worker and rejects the running computation, if any. */
  private stop(err: unknown): void {
    const p = this.pending;
    this.pending = null;
    this.worker?.terminate();
    this.worker = null;
    p?.reject(err);
  }

  /** Abandons a running computation (its promise rejects with Superseded). */
  supersede(): void {
    if (!this.pending) return;
    this.superseded++;
    this.stop(new Superseded());
  }

  compute(o: SideText, m: SideText, options: IDocumentDiffProviderOptions): Promise<IDocumentDiff> {
    this.supersede();
    const w = this.ensure();
    const post = (msg: DiffWorkerRequest): void => w.postMessage(msg);
    // One string per side: a single block copy, no per-line structured clone.
    if (this.sent.o !== o.key) post({ type: 'text', slot: 'o', key: o.key, text: o.text() });
    if (this.sent.m !== m.key) post({ type: 'text', slot: 'm', key: m.key, text: m.text() });
    this.sent = { o: o.key, m: m.key };
    const id = ++this.seq;
    return new Promise<IDocumentDiff>((resolve, reject) => {
      this.pending = { id, resolve, reject };
      post({
        type: 'diff',
        id,
        o: o.key,
        m: m.key,
        options: {
          ignoreTrimWhitespace: options.ignoreTrimWhitespace,
          maxComputationTimeMs: options.maxComputationTimeMs,
          computeMoves: false,
        },
      });
    });
  }

  private onMessage(msg: DiffWorkerResponse): void {
    const p = this.pending;
    if (!p || p.id !== msg.id) return;
    this.pending = null;
    if (msg.type === 'error') {
      this.sent = { o: '', m: '' };
      p.reject(new Error(msg.message));
      return;
    }
    p.resolve({ identical: msg.identical, quitEarly: msg.quitEarly, changes: msg.changes.map(toMapping), moves: [] });
  }
}

function toMapping(c: SerializedChange): DetailedLineRangeMapping {
  return new DetailedLineRangeMapping(
    new LineRange(c[0], c[1]),
    new LineRange(c[2], c[3]),
    c[4]?.map(
      (r) =>
        new RangeMapping(
          new monaco.Range(r[0] ?? 1, r[1] ?? 1, r[2] ?? 1, r[3] ?? 1),
          new monaco.Range(r[4] ?? 1, r[5] ?? 1, r[6] ?? 1, r[7] ?? 1),
        ),
    ),
  );
}

const diffWorker = new DiffWorkerClient();

/** The last result, keyed by model versions + options (one entry). */
let lastResult: { key: string; diff: IDocumentDiff } | null = null;
let cacheHits = 0;

/** Test hook: diffs answered from the last result instead of the worker. */
export function cachedDiffs(): number {
  return cacheHits;
}

/** Test hook: how many running diffs were abandoned for a newer request. */
export function supersededRuns(): number {
  return diffWorker.superseded;
}

// --- provider --------------------------------------------------------------

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
    if (original.isDisposed() || modified.isDisposed()) {
      return { changes: [], identical: true, quitEarly: false, moves: [] };
    }
    // Replaced models stay alive on the undo history (D13), and their old view
    // model can still fire a debounced run. A run no engine shows must never
    // supersede the run for what is on screen; nobody waits for its result.
    const ctl = [...controllers].find((c) => c.isCurrent(original, modified));
    if (!ctl) return new Promise<IDocumentDiff>(() => {});
    ctl.onRunStart(original, modified);
    const t0 = performance.now();
    try {
      const opts: IDocumentDiffProviderOptions = {
        ...options,
        computeMoves: false,
        maxComputationTimeMs: ctl.maxComputationTimeMs ?? options.maxComputationTimeMs,
      };
      // Any newer request makes a running one stale: stop it so this request
      // does not queue behind it in the worker.
      diffWorker.supersede();
      // Monaco re-asks for the same diff when only presentation changes (the
      // context-lines count, a re-attach for it): answer from the last result.
      const cacheKey = [
        sideOf(original).key,
        sideOf(modified).key,
        opts.ignoreTrimWhitespace,
        opts.maxComputationTimeMs,
        ctl.ignoreAllWhitespace,
        ctl.lineLevelOnly,
      ].join('|');
      let result: IDocumentDiff | null = lastResult?.key === cacheKey ? lastResult.diff : null;
      const cached = result !== null;
      if (!result) result = trivialDiff(original, modified);
      if (!result) {
        result = ctl.ignoreAllWhitespace
          ? await computeIgnoringAllWhitespace(original, modified, opts)
          : await diffWorker.compute(sideOf(original), sideOf(modified), opts);
      }
      if (ctl.lineLevelOnly && !cached) {
        result = { ...result, changes: result.changes.map((c) => new DetailedLineRangeMapping(c.original, c.modified, undefined)) };
      }
      // Approximate results too: the same request gets the same time budget.
      lastResult = { key: cacheKey, diff: result };
      cacheHits += cached ? 1 : 0;
      ctl.onRunEnd({
        ms: performance.now() - t0,
        quitEarly: result.quitEarly,
        identical: result.identical,
        cancelled: token.isCancellationRequested,
      });
      return result;
    } catch (err) {
      if (err instanceof Superseded || token.isCancellationRequested || original.isDisposed() || modified.isDisposed()) {
        ctl.onRunEnd({ ms: performance.now() - t0, quitEarly: true, identical: false, cancelled: true });
      } else {
        ctl.onRunError(err);
      }
      // Leave Monaco waiting: a superseded run has a newer run behind it, and
      // after an error the previous decorations stay until the next edit.
      return new Promise<IDocumentDiff>(() => {});
    }
  }

  dispose(): void {
    liveProviders.delete(this);
    this.emitter.dispose();
  }
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
// The worker diffs each side with all non-newline whitespace removed. Line
// numbers are identical to the real model, so line mappings apply as-is;
// intra-line ranges are mapped back column by column. The real models (what
// the user sees and getText returns) are never touched.

function strippedSide(m: TextModel): SideText {
  const side = sideOf(m);
  return { key: `stripped:${side.key}`, text: () => stripWhitespace(m.getValue()) };
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
): Promise<IDocumentDiff> {
  const r = await diffWorker.compute(strippedSide(original), strippedSide(modified), opts);
  if (original.isDisposed() || modified.isDisposed()) return r;
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
