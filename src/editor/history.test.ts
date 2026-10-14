import { describe, expect, it } from 'vitest';
import { HISTORY_MAX_BYTES, HISTORY_MAX_ENTRIES, ReplaceHistory } from './history';

interface Fake {
  name: string;
  size: number;
}

function setup(maxBytes?: number) {
  const dropped: string[] = [];
  const h = new ReplaceHistory<Fake>({
    size: (m) => m.size,
    drop: (m) => dropped.push(m.name),
    ...(maxBytes !== undefined ? { maxBytes } : {}),
  });
  return { h, dropped };
}

const m = (name: string, size = 1): Fake => ({ name, size });

describe('ReplaceHistory', () => {
  it('uses the documented bounds', () => {
    expect(HISTORY_MAX_ENTRIES).toBe(10);
    expect(HISTORY_MAX_BYTES).toBe(300 * 1024 * 1024);
  });

  it('undoes the latest entry, per side or overall', () => {
    const { h } = setup();
    h.record({ sides: ['a'], reason: 'load', models: { a: m('a0') } });
    h.record({ sides: ['b'], reason: 'clear', models: { b: m('b0') } });
    expect(h.canUndo()).toBe(true);
    expect(h.canUndo('a')).toBe(true);
    expect(h.takeUndo('a')?.models.a?.name).toBe('a0');
    expect(h.canUndo('a')).toBe(false);
    expect(h.takeUndo()?.reason).toBe('clear');
    expect(h.takeUndo()).toBeNull();
  });

  it('a swap is one entry touching both sides and shadows older entries', () => {
    const { h } = setup();
    h.record({ sides: ['a'], reason: 'paste', models: { a: m('a0') } });
    h.record({ sides: ['a', 'b'], reason: 'swap', models: {} });
    expect(h.takeUndo('b')?.reason).toBe('swap');
    expect(h.takeUndo('b')).toBeNull();
    expect(h.takeUndo('a')?.reason).toBe('paste');
  });

  it('redo works and a new replacement or typing clears that side only', () => {
    const { h, dropped } = setup();
    h.pushRedo({ sides: ['a'], reason: 'clear', models: { a: m('ra') } });
    h.pushRedo({ sides: ['b'], reason: 'clear', models: { b: m('rb') } });
    expect(h.canRedo('a') && h.canRedo('b')).toBe(true);
    h.clearRedo(['a']); // typing in A
    expect(h.canRedo('a')).toBe(false);
    expect(h.canRedo('b')).toBe(true);
    expect(dropped).toEqual(['ra']);
    h.record({ sides: ['b'], reason: 'load', models: { b: m('b1') } });
    expect(h.canRedo()).toBe(false);
    expect(dropped).toEqual(['ra', 'rb']);
    expect(h.takeUndo('b')?.models.b?.name).toBe('b1');
  });

  it('keeps at most 10 entries per side, dropping the oldest', () => {
    const { h, dropped } = setup();
    for (let i = 0; i < 12; i++) h.record({ sides: ['a'], reason: 'set', models: { a: m(`a${i}`) } });
    h.record({ sides: ['b'], reason: 'set', models: { b: m('b0') } });
    expect(h.counts()).toEqual({ a: 10, b: 1 });
    expect(dropped).toEqual(['a0', 'a1']);
    expect(h.takeUndo('a')?.models.a?.name).toBe('a11');
  });

  it('keeps at most maxBytes across both sides, oldest first', () => {
    const { h, dropped } = setup(100);
    h.record({ sides: ['a'], reason: 'load', models: { a: m('a0', 60) } });
    h.record({ sides: ['b'], reason: 'load', models: { b: m('b0', 30) } });
    h.record({ sides: ['a'], reason: 'load', models: { a: m('a1', 30) } });
    expect(dropped).toEqual(['a0']);
    expect(h.bytes()).toBe(60);
    h.record({ sides: ['b'], reason: 'load', models: { b: m('huge', 500) } });
    // Everything goes, including the entry that is itself over the limit.
    expect(h.bytes()).toBe(0);
    expect(h.canUndo()).toBe(false);
  });

  it('clear drops every kept value once', () => {
    const { h, dropped } = setup();
    h.record({ sides: ['a'], reason: 'load', models: { a: m('a0') } });
    h.pushRedo({ sides: ['b'], reason: 'clear', models: { b: m('b0') } });
    h.clear();
    expect(dropped.sort()).toEqual(['a0', 'b0']);
    expect(h.canUndo() || h.canRedo()).toBe(false);
  });
});
