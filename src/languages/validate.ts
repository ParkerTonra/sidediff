// Pure validation for the remote pack pipeline: manifest shape, download
// size cap, JSON + TextMate grammar schema, SHA-256. No Monaco, no DOM.

export const MAX_PACK_BYTES = 2 * 1024 * 1024;
/** Remote packs may only come from here (also the page CSP connect-src). */
export const ALLOWED_URL_PREFIX = 'https://cdn.jsdelivr.net/gh/';
export const PACK_FORMATS = ['tmlanguage-json'] as const;
export type PackFormat = (typeof PACK_FORMATS)[number];

export interface ManifestPack {
  id: string;
  displayName: string;
  format: PackFormat;
  license: string;
  url: string;
  sha256: string;
}

export interface LanguageManifest {
  version: 1;
  packs: ManifestPack[];
}

const ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const RESERVED_IDS = new Set(['csharp', 'xml', 'plaintext']);
// A pinned ref: `@<tag-or-sha>/` right after `gh/<owner>/<repo>`. Rejects
// floating refs such as `@latest`, `@main` or no ref at all.
const PINNED_RE = /^https:\/\/cdn\.jsdelivr\.net\/gh\/[\w.-]+\/[\w.-]+@(v?\d+(\.\d+)+|[0-9a-f]{40})\/[^?#]+\.json$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isFormat(v: unknown): v is PackFormat {
  return typeof v === 'string' && (PACK_FORMATS as readonly string[]).includes(v);
}

/** Throws a readable Error if the manifest is not exactly what we expect. */
export function parseManifest(raw: unknown): LanguageManifest {
  if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.packs)) {
    throw new Error('Language manifest must be { "version": 1, "packs": [...] }.');
  }
  const seen = new Set<string>();
  const packs: ManifestPack[] = raw.packs.map((p: unknown, i: number) => {
    const where = `Language manifest entry ${i + 1}`;
    if (!isRecord(p)) throw new Error(`${where} is not an object.`);
    const { id, displayName, format, license, url, sha256 } = p;
    if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error(`${where}: invalid id.`);
    if (RESERVED_IDS.has(id)) throw new Error(`${where}: "${id}" is a bundled language.`);
    if (seen.has(id)) throw new Error(`${where}: duplicate id "${id}".`);
    seen.add(id);
    if (typeof displayName !== 'string' || !displayName.trim()) throw new Error(`${where}: missing displayName.`);
    if (!isFormat(format)) throw new Error(`${where}: unsupported format "${String(format)}".`);
    if (license !== 'MIT') throw new Error(`${where}: license must be MIT.`);
    if (typeof url !== 'string' || !url.startsWith(ALLOWED_URL_PREFIX) || !PINNED_RE.test(url)) {
      throw new Error(`${where}: url must be a pinned ${ALLOWED_URL_PREFIX} JSON file.`);
    }
    if (typeof sha256 !== 'string' || !SHA_RE.test(sha256)) throw new Error(`${where}: sha256 must be 64 lowercase hex chars.`);
    return { id, displayName, format, license, url, sha256 };
  });
  return { version: 1, packs };
}

// --- TextMate grammar schema ------------------------------------------------

const MAX_DEPTH = 64;
const MAX_RULES = 20_000;
const STRING_KEYS = ['name', 'contentName', 'match', 'begin', 'end', 'while', 'include'] as const;
const CAPTURE_KEYS = ['captures', 'beginCaptures', 'endCaptures', 'whileCaptures'] as const;

/**
 * Structural check of a `.tmLanguage.json` grammar: top-level `scopeName` and
 * `patterns`, and every rule's known keys have the right types. Unknown keys
 * are allowed (grammars carry comments and metadata). Returns an error
 * message or null.
 */
export function checkTextMateGrammar(raw: unknown): string | null {
  if (!isRecord(raw)) return 'Grammar is not a JSON object.';
  if (typeof raw.scopeName !== 'string' || !/^[\w.-]+$/.test(raw.scopeName)) return 'Grammar has no valid "scopeName".';
  if (!Array.isArray(raw.patterns)) return 'Grammar has no top-level "patterns" array.';
  let count = 0;

  const checkRule = (rule: unknown, path: string, depth: number): string | null => {
    if (++count > MAX_RULES) return `Grammar has more than ${MAX_RULES} rules.`;
    if (depth > MAX_DEPTH) return `Grammar nests deeper than ${MAX_DEPTH} levels at ${path}.`;
    if (!isRecord(rule)) return `${path} is not an object.`;
    for (const k of STRING_KEYS) {
      if (k in rule && typeof rule[k] !== 'string') return `${path}.${k} must be a string.`;
    }
    if ('end' in rule && !('begin' in rule)) return `${path} has "end" without "begin".`;
    if ('patterns' in rule) {
      const err = checkList(rule.patterns, `${path}.patterns`, depth + 1);
      if (err) return err;
    }
    if ('repository' in rule) {
      const err = checkRepo(rule.repository, `${path}.repository`, depth + 1);
      if (err) return err;
    }
    for (const k of CAPTURE_KEYS) {
      if (!(k in rule)) continue;
      const caps = rule[k];
      // Some grammars write captures as an array; vscode-textmate accepts both.
      const entries = Array.isArray(caps) ? caps.map((c, i) => [String(i), c] as const) : isRecord(caps) ? Object.entries(caps) : null;
      if (!entries) return `${path}.${k} must be an object.`;
      for (const [ck, cv] of entries) {
        const err = checkRule(cv, `${path}.${k}.${ck}`, depth + 1);
        if (err) return err;
      }
    }
    return null;
  };
  const checkList = (list: unknown, path: string, depth: number): string | null => {
    if (!Array.isArray(list)) return `${path} must be an array.`;
    for (let i = 0; i < list.length; i++) {
      const err = checkRule(list[i], `${path}[${i}]`, depth);
      if (err) return err;
    }
    return null;
  };
  const checkRepo = (repo: unknown, path: string, depth: number): string | null => {
    if (!isRecord(repo)) return `${path} must be an object.`;
    for (const [k, v] of Object.entries(repo)) {
      const err = checkRule(v, `${path}.${k}`, depth);
      if (err) return err;
    }
    return null;
  };

  return checkList(raw.patterns, 'patterns', 1) ?? ('repository' in raw ? checkRepo(raw.repository, 'repository', 1) : null);
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Decoded, parsed, schema-checked, hash-verified pack content. */
export interface VerifiedPack {
  text: string;
  grammar: Record<string, unknown>;
  sha256: string;
}

/**
 * Size → JSON.parse → schema → SHA-256, in that order. Throws an Error with
 * a user-readable message on the first failure.
 */
export async function verifyPackBytes(pack: ManifestPack, bytes: Uint8Array): Promise<VerifiedPack> {
  const name = pack.displayName;
  if (bytes.byteLength >= MAX_PACK_BYTES) {
    throw new Error(`${name} pack is ${formatBytes(bytes.byteLength)}, over the ${formatBytes(MAX_PACK_BYTES)} limit.`);
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${name} pack is not valid UTF-8 text.`);
  }
  let grammar: unknown;
  try {
    grammar = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (err) {
    throw new Error(`${name} pack is not valid JSON (${err instanceof Error ? err.message : String(err)}).`, { cause: err });
  }
  const schemaErr = checkTextMateGrammar(grammar);
  if (schemaErr || !isRecord(grammar)) {
    throw new Error(`${name} pack is not a valid TextMate grammar: ${schemaErr ?? 'not an object'}`);
  }
  const sha256 = await sha256Hex(bytes);
  if (sha256 !== pack.sha256) {
    throw new Error(`${name} pack failed the integrity check (SHA-256 ${sha256.slice(0, 12)}… does not match the manifest's ${pack.sha256.slice(0, 12)}…).`);
  }
  return { text, grammar, sha256 };
}

/**
 * Reads a response body, refusing anything at or over `limit` bytes: checks
 * Content-Length first, then counts the actual bytes while streaming.
 */
export async function readCapped(res: Response, limit: number, name: string): Promise<Uint8Array> {
  const tooBig = (n: number) => new Error(`${name} pack is ${formatBytes(n)}${n >= limit ? '' : '+'}, over the ${formatBytes(limit)} limit.`);
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared >= limit) throw tooBig(declared);
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength >= limit) throw tooBig(buf.byteLength);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total >= limit) {
      await reader.cancel().catch(() => undefined);
      throw tooBig(total);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
