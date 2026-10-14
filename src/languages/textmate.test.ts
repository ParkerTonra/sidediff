import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { createLineTokenizer, scopesToToken } from './textmate';

// The real oniguruma WASM shipped with the app, read from node_modules.
const require = createRequire(import.meta.url);
const loadWasm = () => Promise.resolve(new Uint8Array(readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm'))));
const GRAMMAR = readFileSync(new URL('./__fixtures__/mini.tmLanguage.json', import.meta.url), 'utf8');

describe('TextMate tokenizer (vscode-textmate + oniguruma wasm)', () => {
  it('tokenizes a line into Monaco theme tokens', async () => {
    const tok = await createLineTokenizer(GRAMMAR, 'mini', loadWasm);
    const line = "SELECT 42 FROM t -- note";
    const { tokens } = tok.tokenizeLine(line, tok.initialState);
    const at = (s: string) => tokens.filter((t) => t.startIndex <= line.indexOf(s)).at(-1)?.type;
    expect(at('SELECT')).toBe('keyword.mini');
    expect(at('42')).toBe('number.mini');
    expect(at('FROM')).toBe('keyword.mini');
    expect(at('t ')).toBe('');
    expect(at('-- note')).toBe('comment.mini');
  });

  it('carries state across lines (multi-line block comment)', async () => {
    const tok = await createLineTokenizer(GRAMMAR, 'mini', loadWasm);
    const l1 = tok.tokenizeLine('select /* open', tok.initialState);
    const l2 = tok.tokenizeLine('still comment select', l1.endState);
    expect(l2.tokens.map((t) => t.type)).toEqual(['comment.mini']);
    const l3 = tok.tokenizeLine('*/ select', l2.endState);
    expect(l3.tokens.map((t) => t.type)).toContain('keyword.mini');
    expect(l1.endState.equals(tok.initialState)).toBe(false);
  });

  it('a grammar with a broken regex fails at creation, not mid-render', async () => {
    const bad = JSON.stringify({ scopeName: 'source.bad', patterns: [{ match: '(unclosed', name: 'keyword.bad' }] });
    await expect(createLineTokenizer(bad, 'bad', loadWasm)).rejects.toThrow();
  });
});

describe('scopesToToken', () => {
  it.each([
    [['source.sql', 'keyword.other.DML.sql'], 'sql', 'keyword.sql'],
    [['source.sql', 'string.quoted.single.sql', 'punctuation.definition.string.begin.sql'], 'sql', 'string.sql'],
    [['source.sql', 'comment.line.double-dash.sql', 'punctuation.definition.comment.sql'], 'sql', 'comment.sql'],
    [['source.sql', 'constant.numeric.sql'], 'sql', 'number.sql'],
    [['source.json', 'meta.structure.dictionary.json', 'support.type.property-name.json', 'punctuation.support.type.property-name.begin.json'], 'json', 'string.key.json'],
    [['source.json', 'meta.structure.dictionary.value.json', 'string.quoted.double.json'], 'json', 'string.value.json'],
    [['source.json', 'constant.language.json'], 'json', 'keyword.json'],
    [['source.json', 'punctuation.separator.dictionary.pair.json'], 'json', 'delimiter.json'],
    [['source.sql'], 'sql', ''],
  ])('%j → %s', (scopes, lang, token) => {
    expect(scopesToToken(scopes, lang)).toBe(token);
  });
});
