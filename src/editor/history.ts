// Whole-text undo/redo bookkeeping (DECISIONS.md D13). Generic over the kept
// value (a Monaco model in the engine, plain objects in unit tests), so the
// ordering and bounding rules are tested without Monaco.
import type { ReplaceReason, Side } from '../types';

export const HISTORY_MAX_ENTRIES = 10;
export const HISTORY_MAX_BYTES = 300 * 1024 * 1024;

export interface HistoryEntry<M> {
  /** One side, or both for a swap. */
  sides: Side[];
  reason: ReplaceReason;
  /**
   * The text state to switch back to. Undo entries hold the replaced models,
   * redo entries the ones an undo took off screen. A swap holds none: undoing
   * it swaps again.
   */
  models: Partial<Record<Side, M>>;
}

export interface ReplaceHistoryOptions<M> {
  /** Size of a kept value in bytes (the engine uses UTF-16 code units). */
  size(m: M): number;
  /** Called once for every value the history lets go of. */
  drop(m: M): void;
  maxEntries?: number;
  maxBytes?: number;
}

function touches<M>(e: HistoryEntry<M>, side: Side | undefined): boolean {
  return side === undefined || e.sides.includes(side);
}

export class ReplaceHistory<M> {
  private readonly undoList: HistoryEntry<M>[] = [];
  private readonly redoList: HistoryEntry<M>[] = [];
  private readonly maxEntries: number;
  private readonly maxBytes: number;

  constructor(private readonly opts: ReplaceHistoryOptions<M>) {
    this.maxEntries = opts.maxEntries ?? HISTORY_MAX_ENTRIES;
    this.maxBytes = opts.maxBytes ?? HISTORY_MAX_BYTES;
  }

  /** A new replacement: clears redo for the sides it touches, then bounds. */
  record(entry: HistoryEntry<M>): void {
    this.clearRedo(entry.sides);
    this.undoList.push(entry);
    this.trim();
  }

  /** Typing (or a new replacement) on a side invalidates its redo entries. */
  clearRedo(sides: readonly Side[]): void {
    for (let i = this.redoList.length - 1; i >= 0; i--) {
      const e = this.redoList[i]!;
      if (e.sides.some((s) => sides.includes(s))) {
        this.redoList.splice(i, 1);
        this.dropEntry(e);
      }
    }
  }

  canUndo(side?: Side): boolean {
    return this.undoList.some((e) => touches(e, side));
  }

  canRedo(side?: Side): boolean {
    return this.redoList.some((e) => touches(e, side));
  }

  /** Removes and returns the latest undo entry touching `side` (or any side). */
  takeUndo(side?: Side): HistoryEntry<M> | null {
    return take(this.undoList, side);
  }

  takeRedo(side?: Side): HistoryEntry<M> | null {
    return take(this.redoList, side);
  }

  /** After an undo: the state it replaced, for redo. */
  pushRedo(entry: HistoryEntry<M>): void {
    this.redoList.push(entry);
    this.trim();
  }

  /** After a redo: the state it replaced, for undo (does not clear redo). */
  pushUndo(entry: HistoryEntry<M>): void {
    this.undoList.push(entry);
    this.trim();
  }

  bytes(): number {
    let n = 0;
    for (const e of [...this.undoList, ...this.redoList]) for (const m of Object.values(e.models)) if (m !== undefined) n += this.opts.size(m);
    return n;
  }

  /** Entry counts per side, undo and redo together. */
  counts(): Record<Side, number> {
    const c = { a: 0, b: 0 };
    for (const e of [...this.undoList, ...this.redoList]) for (const s of e.sides) c[s]++;
    return c;
  }

  clear(): void {
    for (const e of this.undoList.splice(0)) this.dropEntry(e);
    for (const e of this.redoList.splice(0)) this.dropEntry(e);
  }

  /** Oldest first: undo entries before redo entries. */
  private dropOldest(predicate: (e: HistoryEntry<M>) => boolean): boolean {
    for (const list of [this.undoList, this.redoList]) {
      const i = list.findIndex(predicate);
      if (i >= 0) {
        this.dropEntry(list.splice(i, 1)[0]!);
        return true;
      }
    }
    return false;
  }

  private trim(): void {
    for (const side of ['a', 'b'] as const) {
      while (this.counts()[side] > this.maxEntries && this.dropOldest((e) => e.sides.includes(side))) {
        // keep dropping
      }
    }
    while (this.bytes() > this.maxBytes && this.dropOldest(() => true)) {
      // keep dropping
    }
  }

  private dropEntry(e: HistoryEntry<M>): void {
    for (const m of Object.values(e.models)) if (m !== undefined) this.opts.drop(m);
  }
}

function take<M>(list: HistoryEntry<M>[], side: Side | undefined): HistoryEntry<M> | null {
  for (let i = list.length - 1; i >= 0; i--) {
    if (touches(list[i]!, side)) return list.splice(i, 1)[0]!;
  }
  return null;
}
