import type { LanguageId } from '../types';

/** Only this many characters are inspected, whatever the paste size. */
export const DETECT_SAMPLE_CHARS = 4096;

const CSHARP_RE = /^\s*(using|namespace)\b/m;

/**
 * Auto-detect per INTERFACES.md: first non-blank char `<` is XML; a line that
 * starts with `using` or `namespace` (multiline) is C#; otherwise null,
 * meaning "keep the current language".
 */
export function detectLanguage(text: string): LanguageId | null {
  let sample = text.length > DETECT_SAMPLE_CHARS ? text.slice(0, DETECT_SAMPLE_CHARS) : text;
  if (sample.charCodeAt(0) === 0xfeff) sample = sample.slice(1);
  const first = sample.search(/\S/);
  if (first === -1) return null;
  if (sample[first] === '<') return 'xml';
  if (CSHARP_RE.test(sample)) return 'csharp';
  return null;
}
