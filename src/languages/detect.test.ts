import { describe, expect, it } from 'vitest';
import { DETECT_SAMPLE_CHARS, detectLanguage } from './detect';

describe('detectLanguage', () => {
  it.each([
    ['<?xml version="1.0"?><Customization/>', 'xml'],
    ['\n\n   \t<Customization level="100">', 'xml'],
    ['﻿<root/>', 'xml'],
    ['using System;\nnamespace X {}', 'csharp'],
    ['   namespace PX.Objects.SO\n{', 'csharp'],
    ['// header comment\r\nusing PX.Data;', 'csharp'],
    ['/* license */\n\nnamespace Foo;', 'csharp'],
  ])('%j → %s', (text, id) => {
    expect(detectLanguage(text)).toBe(id);
  });

  it.each([
    [''],
    ['   \n\t  '],
    ['SELECT * FROM t'],
    ['usingX = 1'],
    ['var namespaced = 2;'],
    ['{"a": "<b>"}'],
    ['hello\n  <tag>'],
  ])('%j → null (keep current)', (text) => {
    expect(detectLanguage(text)).toBeNull();
  });

  it('only inspects the first few KB', () => {
    const pad = 'x'.repeat(DETECT_SAMPLE_CHARS) + '\n';
    expect(detectLanguage(`${pad}using System;`)).toBeNull();
    expect(detectLanguage(`${' '.repeat(DETECT_SAMPLE_CHARS + 10)}<a/>`)).toBeNull();
  });

  it('is fast on a huge string', () => {
    const big = `using System;\n${'x'.repeat(20_000_000)}`;
    const t = performance.now();
    expect(detectLanguage(big)).toBe('csharp');
    expect(performance.now() - t).toBeLessThan(50);
  });
});
