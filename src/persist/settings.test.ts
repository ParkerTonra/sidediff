import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../types';
import { SETTINGS_KEY, createSettingsStore, type StorageLike } from './settings';

function memoryStorage(initial?: string): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  if (initial !== undefined) data.set(SETTINGS_KEY, initial);
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
  };
}

describe('SettingsStore', () => {
  it('returns the defaults when nothing is stored', () => {
    expect(createSettingsStore(memoryStorage()).load()).toEqual(DEFAULT_SETTINGS);
  });

  it('defaults to the dark theme', () => {
    expect(createSettingsStore(memoryStorage()).load().theme).toBe('dark');
  });

  it('round-trips saved settings', () => {
    const storage = memoryStorage();
    const store = createSettingsStore(storage);
    const s = store.load();
    s.labels = { a: 'Prod', b: 'Dev' };
    s.theme = 'light';
    s.language = 'xml';
    s.diff.diffOnly = true;
    s.diff.contextLines = 7;
    s.diff.fontSize = 16;
    s.diff.viewMode = 'inline';
    store.save(s);
    expect(storage.data.has(SETTINGS_KEY)).toBe(true);
    expect(createSettingsStore(storage).load()).toEqual(s);
  });

  it('merges partial stored values over the defaults', () => {
    const store = createSettingsStore(memoryStorage(JSON.stringify({ theme: 'light', diff: { wordWrap: true } })));
    const s = store.load();
    expect(s.theme).toBe('light');
    expect(s.diff.wordWrap).toBe(true);
    expect(s.diff.ignoreTrimWhitespace).toBe(true);
    expect(s.labels).toEqual({ a: 'A', b: 'B' });
  });

  it('clamps context lines and font size', () => {
    const high = createSettingsStore(memoryStorage(JSON.stringify({ diff: { contextLines: 99, fontSize: 500 } }))).load();
    expect(high.diff.contextLines).toBe(20);
    expect(high.diff.fontSize).toBe(32);
    const low = createSettingsStore(memoryStorage(JSON.stringify({ diff: { contextLines: -4, fontSize: 1 } }))).load();
    expect(low.diff.contextLines).toBe(0);
    expect(low.diff.fontSize).toBe(8);
    const frac = createSettingsStore(memoryStorage(JSON.stringify({ diff: { contextLines: 2.6 } }))).load();
    expect(frac.diff.contextLines).toBe(3);
  });

  it('ignores fields with the wrong type', () => {
    const raw = { theme: 'neon', language: 42, labels: { a: 7, b: '   ' }, diff: { minimap: 'yes', viewMode: 'diagonal', contextLines: 'x' } };
    expect(createSettingsStore(memoryStorage(JSON.stringify(raw))).load()).toEqual(DEFAULT_SETTINGS);
  });

  it('falls back to the defaults on corrupt JSON', () => {
    expect(createSettingsStore(memoryStorage('{not json')).load()).toEqual(DEFAULT_SETTINGS);
    expect(createSettingsStore(memoryStorage('null')).load()).toEqual(DEFAULT_SETTINGS);
    expect(createSettingsStore(memoryStorage('[1,2]')).load()).toEqual(DEFAULT_SETTINGS);
  });

  it('survives blocked or full storage', () => {
    const throwing: StorageLike = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    const store = createSettingsStore(throwing);
    expect(store.load()).toEqual(DEFAULT_SETTINGS);
    expect(() => store.save(DEFAULT_SETTINGS)).not.toThrow();
    const none = createSettingsStore(null);
    expect(none.load()).toEqual(DEFAULT_SETTINGS);
    expect(() => none.save(DEFAULT_SETTINGS)).not.toThrow();
  });

  it('returns a fresh copy so callers cannot mutate the defaults', () => {
    const s = createSettingsStore(memoryStorage()).load();
    s.labels.a = 'changed';
    s.diff.contextLines = 9;
    expect(DEFAULT_SETTINGS.labels.a).toBe('A');
    expect(DEFAULT_SETTINGS.diff.contextLines).toBe(3);
  });

  it('never stores pane text or unknown keys', () => {
    const storage = memoryStorage();
    const store = createSettingsStore(storage);
    const s = { ...store.load(), paneText: 'secret' } as unknown as typeof DEFAULT_SETTINGS;
    store.save(s);
    expect(storage.data.get(SETTINGS_KEY)).not.toContain('secret');
  });
});
