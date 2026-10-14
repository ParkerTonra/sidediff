// Messages between the engine and src/editor/diff.worker.ts.

export interface DiffWorkerOptions {
  ignoreTrimWhitespace: boolean;
  maxComputationTimeMs: number;
  computeMoves: boolean;
}

export type DiffWorkerRequest =
  /** Sets the text of the original ('o') or modified ('m') side; `key` identifies model + version. */
  | { type: 'text'; slot: 'o' | 'm'; key: string; text: string }
  | { type: 'diff'; id: number; o: string; m: string; options: DiffWorkerOptions };

/** [origStart, origEndExclusive, modStart, modEndExclusive, inner ranges as 8 numbers each]. */
export type SerializedChange = [number, number, number, number, number[][] | undefined];

export type DiffWorkerResponse =
  | { type: 'result'; id: number; changes: SerializedChange[]; quitEarly: boolean; identical: boolean; ms: number }
  | { type: 'error'; id: number; message: string };
