// Messages between createAssemblyBrowser() and its two workers.
import type { AsmSearchHit, AssemblyInfo, SearchOptions } from '../types';

export type AsmRequest =
  | { id: number; type: 'load'; key: string; bytes: Uint8Array }
  | { id: number; type: 'search'; key: string; query: string; options?: SearchOptions }
  | { id: number; type: 'il'; key: string; token: number }
  | { id: number; type: 'unload'; key: string };

export type AsmResponse =
  | { id: number; ok: true; result: AssemblyInfo | AsmSearchHit[] | string | null }
  | { id: number; ok: false; error: string };

export type DecompilerRequest =
  /** `base`: absolute URL of the folder holding _framework/ (public/decompiler/). */
  | { id: number; type: 'init'; base: string }
  /** `key` identifies the assembly bytes; the decompiler reuses its type system for the same key. */
  | { id: number; type: 'decompile'; key: string; bytes: Uint8Array; typeName: string | null };

export type DecompilerResponse =
  | { id: number; ok: true; result: string; ms: number; loadMs?: number }
  | { id: number; ok: false; error: string };
