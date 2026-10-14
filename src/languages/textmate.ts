// TextMate grammar → line tokenizer, via vscode-textmate + vscode-oniguruma
// (WASM regex engine shipped with the app). No Monaco here, so it runs in
// node tests too; monaco-bridge.ts adapts it to a Monaco TokensProvider.
import * as vsctm from 'vscode-textmate';
import * as onig from 'vscode-oniguruma';

export type WasmLoader = () => Promise<ArrayBuffer | Uint8Array>;

let onigLib: Promise<vsctm.IOnigLib> | undefined;

/** loadWASM may only run once per realm; memoize (and retry after failure). */
export function initOniguruma(loadWasm: WasmLoader): Promise<vsctm.IOnigLib> {
  onigLib ??= (async () => {
    const data = await loadWasm();
    await onig.loadWASM(data);
    return {
      createOnigScanner: (patterns: string[]) => new onig.OnigScanner(patterns),
      createOnigString: (s: string) => new onig.OnigString(s),
    };
  })().catch((err: unknown) => {
    onigLib = undefined;
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      /wasm|WebAssembly|Content Security Policy|CSP/i.test(msg)
        ? `Could not start the grammar engine (WebAssembly blocked or failed to load): ${msg}`
        : `Could not start the grammar engine: ${msg}`,
    );
  });
  return onigLib;
}

export interface LineTokenizer {
  initialState: vsctm.StateStack;
  /** Returns Monaco-style tokens: start offset + mapped token type. */
  tokenizeLine(line: string, state: vsctm.StateStack): { tokens: { startIndex: number; type: string }[]; endState: vsctm.StateStack };
}

/** Per-line time budget; a pathological line stops early instead of hanging. */
const LINE_TIME_LIMIT_MS = 50;

export async function createLineTokenizer(grammarText: string, languageId: string, loadWasm: WasmLoader): Promise<LineTokenizer> {
  const lib = await initOniguruma(loadWasm);
  const raw = vsctm.parseRawGrammar(grammarText, `${languageId}.tmLanguage.json`);
  const registry = new vsctm.Registry({
    onigLib: Promise.resolve(lib),
    // Self-contained only: includes of other scopes resolve to nothing.
    loadGrammar: (scope) => Promise.resolve(scope === raw.scopeName ? raw : null),
  });
  const grammar = await registry.loadGrammar(raw.scopeName);
  if (!grammar) throw new Error(`Grammar "${raw.scopeName}" could not be loaded.`);
  // Compile the root rule now so a broken regex fails here, not mid-render.
  grammar.tokenizeLine('', vsctm.INITIAL);
  return {
    initialState: vsctm.INITIAL,
    tokenizeLine(line, state) {
      try {
        const r = grammar.tokenizeLine(line, state, LINE_TIME_LIMIT_MS);
        const tokens = r.tokens.map((t) => ({ startIndex: t.startIndex, type: scopesToToken(t.scopes, languageId) }));
        return { tokens, endState: r.stoppedEarly ? state : r.ruleStack };
      } catch {
        return { tokens: [{ startIndex: 0, type: '' }], endState: state };
      }
    },
  };
}

// TextMate scope prefix → Monaco theme token (vs / vs-dark rule names).
const SCOPE_MAP: [string, string][] = [
  ['comment', 'comment'],
  ['support.type.property-name', 'string.key'],
  ['string.regexp', 'regexp'],
  ['string', 'string'],
  ['constant.numeric', 'number'],
  ['constant.character.escape', 'string.escape'],
  ['constant.language', 'keyword'],
  ['constant', 'constant'],
  ['invalid', 'invalid'],
  ['keyword.operator', 'operator'],
  ['keyword', 'keyword'],
  ['storage.type', 'type'],
  ['storage', 'keyword'],
  ['entity.name.type', 'type'],
  ['entity.name.tag', 'tag'],
  ['entity.other.attribute-name', 'attribute.name'],
  ['entity.name.function', 'identifier'],
  ['support.function', 'predefined'],
  ['support.type', 'type'],
  ['support.constant', 'constant'],
  ['variable', 'variable'],
  ['punctuation', 'delimiter'],
];

function mapScope(scope: string): string | null {
  for (const [prefix, token] of SCOPE_MAP) {
    if (scope === prefix || scope.startsWith(`${prefix}.`)) return token;
  }
  return null;
}

/**
 * Picks the Monaco token for a TextMate scope stack. Comments and strings win
 * over anything nested in them (so quote punctuation stays string-coloured);
 * otherwise the innermost mappable scope. The language suffix lets the
 * built-in language-specific theme rules apply (`string.sql`, `keyword.json`).
 */
export function scopesToToken(scopes: readonly string[], languageId: string): string {
  let inner: string | null = null;
  for (let i = scopes.length - 1; i >= 0; i--) {
    const scope = scopes[i];
    if (scope === undefined) continue;
    const t = mapScope(scope);
    if (!t) continue;
    if (t === 'comment' || t === 'string' || t === 'string.key' || t === 'regexp') {
      inner = t;
      break;
    }
    inner ??= t;
  }
  if (!inner) return '';
  if (languageId === 'json' && inner === 'string') inner = 'string.value';
  return `${inner}.${languageId}`;
}
