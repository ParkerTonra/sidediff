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
  /** Optional so older stored settings stay valid; defaults in DEFAULT_EXPLORER. */
  explorer?: ExplorerSettings;
}

export const DEFAULT_EXPLORER: ExplorerSettings = { open: true, width: 300, filter: 'changed' };

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
  /** The engine switched between the full texts (null) and an item view (its key). */
  view: { key: string | null };
  /** A whole-text replacement was undone or redone (see TextHistoryApi). */
  history: { side: Side | 'both'; action: 'undo' | 'redo'; reason: ReplaceReason };
}

// --- Whole-text undo (Editor) ------------------------------------------------

/** Why a side's text was replaced wholesale; shown in "Undid <reason>" toasts. */
export type ReplaceReason = 'set' | 'paste' | 'load' | 'clear' | 'swap';

/**
 * Undo/redo for whole-text replacements (setText, paste-replace-all, file
 * load, clear, swap), which build a fresh Monaco model and so are not on
 * Monaco's own undo stack. Ctrl+Z/Ctrl+Y inside an editor use Monaco's stack
 * first and fall through to this one when it is empty.
 */
export interface TextHistoryApi {
  /** setText with a reason recorded in the history. */
  replaceText(side: Side, text: string, reason: ReplaceReason): void;
  /** Undo the latest replacement on `side` (or the latest of either side). False if none. */
  undoReplace(side?: Side): boolean;
  redoReplace(side?: Side): boolean;
  canUndoReplace(side?: Side): boolean;
  canRedoReplace(side?: Side): boolean;
}

// --- Item views (Editor) -------------------------------------------------------

/** A pair of texts the engine shows instead of the full A/B texts. */
export interface ItemView {
  /** Stable key, e.g. `${ProjectItem.id}#code`. */
  key: string;
  /** null = the item does not exist on that side (pane shows empty). */
  a: string | null;
  b: string | null;
  language: LanguageId;
}

export interface ItemViewApi {
  /**
   * Show `view` in the diff editor. The full-text models stay alive and
   * unchanged; getText() keeps returning the full texts. Item views are
   * read-only. Diff options, theme, navigation, stats and events all apply to
   * whatever is shown. Calling again with another view replaces it.
   */
  openView(view: ItemView): void;
  /** Back to the full texts, restoring their scroll position. */
  closeView(): void;
  /** Key of the open view, or null when the full texts are shown. */
  getView(): string | null;
  /** Show the full texts and put `line` (1-based) of `side` in the centre. */
  revealLine(side: Side, line: number): void;
}

// --- Acumatica project index (src/project/) ------------------------------------

export type ProjectGroup =
  | 'code'
  | 'screens'
  | 'tables'
  | 'sql'
  | 'reports'
  | 'inquiries'
  | 'sitemap'
  | 'integration'
  | 'files'
  | 'other';

/**
 * same: identical bytes. whitespace: differs only in leading/trailing
 * whitespace per line. modified: differs otherwise. only-a / only-b: present
 * on one side.
 */
export type ItemStatus = 'same' | 'whitespace' | 'modified' | 'only-a' | 'only-b';

/** One way to look at an item: its code (CDATA body) or its raw XML element. */
export interface ItemViewKind {
  id: 'code' | 'xml';
  label: string;
  language: LanguageId;
}

export interface ProjectItemSide {
  /** 1-based inclusive line range of the element in the full text. */
  startLine: number;
  endLine: number;
}

export interface ProjectItem {
  /** Stable match key across sides: `${element}:${identity}`, `#2`... for duplicates. */
  id: string;
  group: ProjectGroup;
  /** XML element name, e.g. "Graph". */
  element: string;
  /** Display name, e.g. "SOOrderEntry_Extension" or "SO301000". */
  name: string;
  /** Secondary text, e.g. "Graph extension" or the file path. */
  detail: string;
  /** Upper-cased screen id when the item belongs to a screen (Page, File, PerTenantFile, SiteMapNode, EditorUpdatedFields). */
  screenId?: string;
  /** Status of the default (first) view. */
  status: ItemStatus;
  /** First entry is the default view. Always includes 'xml'. */
  views: ItemViewKind[];
  a: ProjectItemSide | null;
  b: ProjectItemSide | null;
}

export interface ProjectSideInfo {
  /** Root element is <Customization>. */
  isProject: boolean;
  /** Root attributes, e.g. product-version, description. */
  attributes: Record<string, string>;
  items: number;
  parseMs: number;
  /** Set when the text looked like a project but could not be scanned. */
  error?: string;
}

export interface ProjectIndex {
  sides: Record<Side, ProjectSideInfo>;
  /** Grouped and sorted: by group order above, then name. */
  items: ProjectItem[];
  counts: Record<ItemStatus, number>;
}

export interface ProjectIndexer {
  /**
   * Scan both texts off the main thread and match items. A newer call
   * supersedes an older one (the older promise rejects with an AbortError).
   * Resolves with isProject false on both sides for non-project text.
   */
  index(a: string, b: string): Promise<ProjectIndex>;
  /**
   * Text of one view of one item on one side, from the texts last indexed;
   * null if absent. Async because some views are decoded on demand (Page
   * pageSource is base64 raw-deflate).
   */
  viewText(itemId: string, view: ItemViewKind['id'], side: Side): Promise<string | null>;
  dispose(): void;
}

export type ItemFilter = 'all' | 'changed' | 'only-a' | 'only-b';

export interface ExplorerSettings {
  open: boolean;
  width: number;
  filter: ItemFilter;
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
  /** Optional while the explorer lands; the UI hides features whose dep is missing. */
  project?: ProjectIndexer;
  views?: ItemViewApi;
  history?: TextHistoryApi;
}

/** Exposed as window.__sidediff for e2e tests and the bench. */
export interface SideDiffHooks {
  engine: DiffEngine;
  registry: LanguageRegistry;
  project?: ProjectIndexer;
}

declare global {
  interface Window {
    __sidediff?: SideDiffHooks;
  }
}
