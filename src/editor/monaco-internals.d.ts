// Types for the few Monaco 0.57 internals the engine uses. Monaco ships no
// .d.ts for these paths, so the shapes below mirror the JS in
// node_modules/monaco-editor/esm/vs/editor/... and must be re-checked on every
// Monaco upgrade. See docs/DECISIONS.md (Editor: diff provider override).

declare module 'monaco-editor/editor/standalone/browser/standaloneServices' {
  import type { ServiceIdentifier } from 'monaco-editor/editor/common/services/editorWorker';
  export namespace StandaloneServices {
    function get<T>(id: ServiceIdentifier<T>): T;
    /** Only the first call wins; later calls ignore `overrides`. */
    function initialize(overrides: Record<string, unknown>): unknown;
  }
}

declare module 'monaco-editor/editor/common/services/editorWorker' {
  import type { Uri } from 'monaco-editor/editor/editor.api';
  import type { IDocumentDiff } from 'monaco-editor/editor/common/diff/rangeMapping';

  export interface ServiceIdentifier<T> {
    (...args: unknown[]): void;
    type: T;
  }

  export interface IDocumentDiffProviderOptions {
    ignoreTrimWhitespace: boolean;
    maxComputationTimeMs: number;
    computeMoves: boolean;
  }

  export interface IEditorWorkerService {
    computeDiff(
      original: Uri,
      modified: Uri,
      options: IDocumentDiffProviderOptions,
      algorithm: 'legacy' | 'advanced',
    ): Promise<IDocumentDiff | null>;
  }

  export const IEditorWorkerService: ServiceIdentifier<IEditorWorkerService>;
}

declare module 'monaco-editor/editor/common/diff/rangeMapping' {
  import type { Range } from 'monaco-editor/editor/editor.api';

  export interface LineRange {
    readonly startLineNumber: number;
    readonly endLineNumberExclusive: number;
    readonly length: number;
    readonly isEmpty: boolean;
  }

  export class RangeMapping {
    constructor(originalRange: Range, modifiedRange: Range);
    readonly originalRange: Range;
    readonly modifiedRange: Range;
  }

  export class LineRangeMapping {
    readonly original: LineRange;
    readonly modified: LineRange;
  }

  export class DetailedLineRangeMapping extends LineRangeMapping {
    constructor(original: LineRange, modified: LineRange, innerChanges: RangeMapping[] | undefined);
    readonly innerChanges: RangeMapping[] | undefined;
  }

  export interface IDocumentDiff {
    readonly identical: boolean;
    readonly quitEarly: boolean;
    readonly changes: readonly DetailedLineRangeMapping[];
    readonly moves: readonly unknown[];
  }
}

declare module 'monaco-editor/editor/common/core/ranges/lineRange' {
  import type { LineRange as ILineRange } from 'monaco-editor/editor/common/diff/rangeMapping';
  export class LineRange implements ILineRange {
    constructor(startLineNumber: number, endLineNumberExclusive: number);
    readonly startLineNumber: number;
    readonly endLineNumberExclusive: number;
    readonly length: number;
    readonly isEmpty: boolean;
  }
}

declare module 'monaco-editor/editor/browser/viewParts/overlayWidgets/overlayWidgets' {
  export class ViewOverlayWidgets {
    private constructor();
    _updateMaxMinWidth(): void;
  }
}
