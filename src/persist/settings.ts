// Settings persistence. Owned by UI / UX. Pane text is never stored here.
import {
  CONTEXT_LINES_MAX,
  CONTEXT_LINES_MIN,
  DEFAULT_EXPLORER,
  DEFAULT_SETTINGS,
  type AppMode,
  type AppSettings,
  type DiffOptions,
  type ExplorerSettings,
  type ItemFilter,
  type SettingsStore,
  type ThemeId,
  type ViewMode,
} from '../types';

export const SETTINGS_KEY = 'sidediff:settings:v1';
export const FONT_SIZE_MIN = 8;
export const FONT_SIZE_MAX = 32;
export const LABEL_MAX_LENGTH = 60;
export const EXPLORER_WIDTH_MIN = 200;
export const EXPLORER_WIDTH_MAX = 600;
const FILTERS: readonly ItemFilter[] = ['all', 'changed', 'only-a', 'only-b'];

/** The subset of `Storage` the store uses, so tests can inject a fake. */
export type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

/** Returns window.localStorage, or null when it is missing or blocked. */
function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function int(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? clamp(Math.round(value), min, max) : fallback;
}

function label(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim().slice(0, LABEL_MAX_LENGTH);
  return trimmed === '' ? fallback : trimmed;
}

/** Deep copy of the defaults so callers can mutate the result freely. */
export function defaultSettings(): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    labels: { ...DEFAULT_SETTINGS.labels },
    diff: { ...DEFAULT_SETTINGS.diff },
    explorer: { ...DEFAULT_EXPLORER },
  };
}

/** Merges an unknown value (parsed JSON) over the defaults, field by field, clamping numbers. */
export function normalizeSettings(raw: unknown): AppSettings {
  const out = defaultSettings();
  if (!isRecord(raw)) return out;

  if (isRecord(raw.labels)) {
    out.labels.a = label(raw.labels.a, out.labels.a);
    out.labels.b = label(raw.labels.b, out.labels.b);
  }
  if (typeof raw.language === 'string' && raw.language.trim() !== '') out.language = raw.language;
  if (raw.theme === 'dark' || raw.theme === 'light') out.theme = raw.theme satisfies ThemeId;
  if (raw.mode === 'browse' || raw.mode === 'compare') out.mode = raw.mode satisfies AppMode;

  if (isRecord(raw.diff)) {
    const d = raw.diff;
    const def = out.diff;
    const viewMode: ViewMode = d.viewMode === 'inline' || d.viewMode === 'side-by-side' ? d.viewMode : def.viewMode;
    const diff: DiffOptions = {
      ignoreTrimWhitespace: bool(d.ignoreTrimWhitespace, def.ignoreTrimWhitespace),
      ignoreAllWhitespace: bool(d.ignoreAllWhitespace, def.ignoreAllWhitespace),
      wordWrap: bool(d.wordWrap, def.wordWrap),
      viewMode,
      diffOnly: bool(d.diffOnly, def.diffOnly),
      contextLines: int(d.contextLines, def.contextLines, CONTEXT_LINES_MIN, CONTEXT_LINES_MAX),
      fontSize: int(d.fontSize, def.fontSize, FONT_SIZE_MIN, FONT_SIZE_MAX),
      minimap: bool(d.minimap, def.minimap),
    };
    out.diff = diff;
  }

  // Settings saved before the explorer existed have no `explorer`: keep the defaults.
  if (isRecord(raw.explorer)) {
    const e = raw.explorer;
    const def = { ...DEFAULT_EXPLORER };
    const explorer: ExplorerSettings = {
      open: bool(e.open, def.open),
      width: int(e.width, def.width, EXPLORER_WIDTH_MIN, EXPLORER_WIDTH_MAX),
      filter: FILTERS.find((f) => f === e.filter) ?? def.filter,
    };
    out.explorer = explorer;
  }
  return out;
}

/**
 * localStorage-backed store under `sidediff:settings:v1`. Corrupt JSON, a
 * blocked storage, or a full quota never throw: load falls back to defaults
 * and save is a no-op.
 */
export function createSettingsStore(storage: StorageLike | null = defaultStorage()): SettingsStore {
  return {
    load(): AppSettings {
      if (!storage) return defaultSettings();
      try {
        const text = storage.getItem(SETTINGS_KEY);
        return text === null ? defaultSettings() : normalizeSettings(JSON.parse(text));
      } catch {
        return defaultSettings();
      }
    },
    save(settings: AppSettings): void {
      if (!storage) return;
      try {
        storage.setItem(SETTINGS_KEY, JSON.stringify(normalizeSettings(settings)));
      } catch {
        // Quota exceeded or storage blocked: settings stay in memory only.
      }
    },
  };
}
