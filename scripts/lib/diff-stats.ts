// The DiffStats counting rule from docs/INTERFACES.md, plus a Node-side runner
// for Monaco's own line diff algorithm so fixtures carry exact expectations.

export interface Hunk {
  /** Lines on the A side (0 for a pure insertion). */
  a: number;
  /** Lines on the B side (0 for a pure deletion). */
  b: number;
}

export interface CountedStats {
  added: number;
  removed: number;
  modified: number;
  changes: number;
}

export function countHunks(hunks: readonly Hunk[]): CountedStats {
  const s: CountedStats = { added: 0, removed: 0, modified: 0, changes: hunks.length };
  for (const { a, b } of hunks) {
    if (a === 0) s.added += b;
    else if (b === 0) s.removed += a;
    else {
      s.modified += Math.min(a, b);
      s.added += Math.max(0, b - a);
      s.removed += Math.max(0, a - b);
    }
  }
  return s;
}

export interface Tolerance {
  /** Fraction of the expected value. */
  relative: number;
  /** Absolute slack, added to the relative part. */
  absolute: number;
}

export function withinTolerance(actual: number, expected: number, tol: Tolerance): boolean {
  return Math.abs(actual - expected) <= expected * tol.relative + tol.absolute;
}

interface MonacoLineRange {
  startLineNumber: number;
  endLineNumberExclusive: number;
}
interface MonacoLinesDiff {
  changes: readonly { original: MonacoLineRange; modified: MonacoLineRange }[];
  hitTimeout: boolean;
}
interface MonacoDiffComputer {
  computeDiff(
    a: string[],
    b: string[],
    options: { ignoreTrimWhitespace: boolean; maxComputationTimeMs: number; computeMoves: boolean; extendToSubwords: boolean },
  ): MonacoLinesDiff;
}

const MONACO_DIFF_MODULE =
  'monaco-editor/editor/common/diff/defaultLinesDiffComputer/defaultLinesDiffComputer.js';

/** Runs Monaco's DefaultLinesDiffComputer (the one the DiffEditor worker uses) in Node. */
export async function monacoDiffStats(
  aText: string,
  bText: string,
  ignoreTrimWhitespace: boolean,
): Promise<CountedStats & { hitTimeout: boolean }> {
  const specifier = MONACO_DIFF_MODULE;
  const mod = (await import(specifier)) as { DefaultLinesDiffComputer: new () => MonacoDiffComputer };
  const computer = new mod.DefaultLinesDiffComputer();
  const result = computer.computeDiff(aText.split(/\r?\n/), bText.split(/\r?\n/), {
    ignoreTrimWhitespace,
    maxComputationTimeMs: 0,
    computeMoves: false,
    extendToSubwords: false,
  });
  const hunks = result.changes.map((c) => ({
    a: c.original.endLineNumberExclusive - c.original.startLineNumber,
    b: c.modified.endLineNumberExclusive - c.modified.startLineNumber,
  }));
  return { ...countHunks(hunks), hitTimeout: result.hitTimeout };
}
