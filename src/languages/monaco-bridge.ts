// Remote TextMate packs → Monaco. Loaded with a dynamic import from index.ts
// only when a remote pack activates, so vscode-textmate and the oniguruma
// WASM stay out of the initial bundle (and the registry tests stay Monaco-free).
import { monaco } from '../editor/monaco-setup';
import onigWasmUrl from 'vscode-oniguruma/release/onig.wasm?url';
import { createLineTokenizer, type LineTokenizer } from './textmate';
import type { StateStack } from 'vscode-textmate';

class TmState implements monaco.languages.IState {
  constructor(readonly stack: StateStack) {}
  clone(): TmState {
    return new TmState(this.stack);
  }
  equals(other: monaco.languages.IState): boolean {
    return other instanceof TmState && (other.stack === this.stack || other.stack.equals(this.stack));
  }
}

async function loadOnigWasm(): Promise<ArrayBuffer | Uint8Array> {
  // The single-file build inlines the asset as a data: URL, which CSP
  // connect-src would block for fetch(); decode it directly instead.
  if (onigWasmUrl.startsWith('data:')) {
    const b64 = onigWasmUrl.slice(onigWasmUrl.indexOf(',') + 1);
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  }
  const res = await fetch(onigWasmUrl);
  if (!res.ok) throw new Error(`onig.wasm HTTP ${res.status}`);
  return res.arrayBuffer();
}

const activated = new Map<string, string>(); // id → sha256 of the active grammar

/** Registers a remote TextMate grammar as a Monaco language. Idempotent per hash. */
export async function activateTextMate(def: { id: string; displayName: string; grammarText: string; sha256: string }): Promise<void> {
  if (activated.get(def.id) === def.sha256) return;
  const tok: LineTokenizer = await createLineTokenizer(def.grammarText, def.id, loadOnigWasm);
  if (!monaco.languages.getLanguages().some((l) => l.id === def.id)) {
    monaco.languages.register({ id: def.id, aliases: [def.displayName] });
  }
  monaco.languages.setTokensProvider(def.id, {
    getInitialState: () => new TmState(tok.initialState),
    tokenize(line, state) {
      const stack = state instanceof TmState ? state.stack : tok.initialState;
      const r = tok.tokenizeLine(line, stack);
      return { tokens: r.tokens.map((t) => ({ startIndex: t.startIndex, scopes: t.type })), endState: new TmState(r.endState) };
    },
  });
  activated.set(def.id, def.sha256);
}
