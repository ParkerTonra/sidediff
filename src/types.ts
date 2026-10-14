// Shared contracts between layers. Owned by the Lead. Change only via a
// request in docs/STATUS.md. See docs/INTERFACES.md for semantics.

export type Side = 'a' | 'b';
export type LanguageId = string; // 'csharp' | 'xml' | 'plaintext' | remote pack ids
export type ThemeId = 'dark' | 'light';
export type ViewMode = 'side-by-side' | 'inline';

/** Above either threshold on either side the engine enters degraded mode. */
export const LARGE_LINES = 400_000;
export const LARGE_BYTES = 40 * 1024 * 1024;

export const CONTEXT_LINES_MIN = 0;
export const CONTEXT_LINES_MAX = 20;

export interface DiffOptions {
  ignoreTrimWhitespace: boolean;
  ignoreAllWhitespace: boolean;
  wordWrap: boolean;
  viewMode: ViewMode;
  diffOnly: boolean;
  contextLines: number;
  fontSize: number;
  minimap: boolean;
}

export interface AppSettings {
  version: 1;
  labels: Record<Side, string>;
  language: LanguageId;
  theme: ThemeId;
  diff: DiffOptions;
}

export const DEFAULT_SETTINGS: AppSettings = {
  version: 1,
  labels: { a: 'A', b: 'B' },
  language: 'plaintext',
  theme: 'dark',
  diff: {
    ignoreTrimWhitespace: true,
    ignoreAllWhitespace: false,
    wordWrap: false,
    viewMode: 'side-by-side',
    diffOnly: false,
    contextLines: 3,
    fontSize: 13,
    minimap: true,
  },
};

export interface DiffStats {
  /** Lines added: pure insertions plus surplus B lines in a modified hunk. */
  added: number;
  /** Lines removed: pure deletions plus surplus A lines in a modified hunk. */
  removed: number;
  /** Paired lines in modified hunks: min(linesA, linesB) per hunk. */
  modified: number;
  /** Number of change hunks (what "change N of M" counts). */
  changes: number;
  linesA: number;
  linesB: number;
  /** Wall time from diff start to result, ms. */
  computeMs: number;
  identical: boolean;
  /** True when the diff hit a time limit and the result is approximate. */
  quitEarly: boolean;
}

export interface ChangePosition {
  /** 1-based index of the current change, 0 when none selected. */
  index: number;
  total: number;
}

export interface DegradedInfo {
  sides: Side[];
  lines: Record<Side, number>;
  bytes: Record<Side, number>;
  reason: string;
}

export interface DiffEngineEvents {
  'diff:start': { linesA: number; linesB: number };
  'diff:done': DiffStats;
  'diff:error': { message: string };
  position: ChangePosition;
  /** null when leaving degraded mode. */
  degraded: DegradedInfo | null;
  /** Content of a side changed (typing, paste, setText, swap, clear). */
  content: { side: Side; lines: number; bytes: number };
  /** A paste landed in a pane. `sample` is the first <= 8 KB, for detection. */
  paste: { side: Side; sample: string };
}

export type Unsubscribe = () => void;

export interface DiffEngine {
  mount(container: HTMLElement): void;
  setText(side: Side, text: string): void;
  getText(side: Side): string;
  /** The language must be loaded (registry.ensureLoaded) first. */
  setLanguage(id: LanguageId): void;
  setOptions(options: Partial<DiffOptions>): void;
  setTheme(theme: ThemeId): void;
  swap(): void;
  nextChange(): void;
  prevChange(): void;
  goToChange(index: number): void;
  getStats(): DiffStats | null;
  getPosition(): ChangePosition;
  isComputing(): boolean;
  focus(side: Side): void;
  /** Opens Monaco find widget in the given (or last focused) side. */
  find(side?: Side): void;
  layout(): void;
  on<K extends keyof DiffEngineEvents>(event: K, handler: (payload: DiffEngineEvents[K]) => void): Unsubscribe;
  dispose(): void;
}

export interface LanguageInfo {
  id: LanguageId;
  displayName: string;
  source: 'bundled' | 'remote';
  /** Bundled: always true. Remote: true once validated and cached. */
  installed: boolean;
  license?: string;
}

export interface LanguagePack {
  id: LanguageId;
  displayName: string;
  source: 'bundled' | 'remote';
  license?: string;
  /** Registers tokenizer and config with Monaco. Must be idempotent. */
  activate(): Promise<void>;
}

export type InstallResult = { ok: true } | { ok: false; error: string };

export interface LanguageRegistry {
  list(): LanguageInfo[];
  get(id: LanguageId): LanguageInfo | undefined;
  register(pack: LanguagePack): void;
  /** Returns a language id, or null meaning "leave the current one". */
  detect(text: string): LanguageId | null;
  /** Bundled or cached packs only; never touches the network. */
  ensureLoaded(id: LanguageId): Promise<void>;
  /** Downloads a manifest pack, validates, caches, registers. P2 dialog uses it. */
  install(id: LanguageId): Promise<InstallResult>;
  onChange(handler: () => void): Unsubscribe;
}

export interface SettingsStore {
  load(): AppSettings;
  save(settings: AppSettings): void;
}

export interface AppDeps {
  root: HTMLElement;
  engine: DiffEngine;
  registry: LanguageRegistry;
}

/** Exposed as window.__sidediff for e2e tests and the bench. */
export interface SideDiffHooks {
  engine: DiffEngine;
  registry: LanguageRegistry;
}

declare global {
  interface Window {
    __sidediff?: SideDiffHooks;
  }
}
