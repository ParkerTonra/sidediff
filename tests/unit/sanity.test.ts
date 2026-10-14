import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/types';

describe('defaults', () => {
  it('opens in dark mode with trim-whitespace on and 3 context lines', () => {
    expect(DEFAULT_SETTINGS.theme).toBe('dark');
    expect(DEFAULT_SETTINGS.diff.ignoreTrimWhitespace).toBe(true);
    expect(DEFAULT_SETTINGS.diff.contextLines).toBe(3);
  });
});
