// Tiny DOM helpers for the app shell. Owned by UI / UX.

type Attrs = Record<string, string | number | boolean | undefined>;
type Child = Node | string | null | undefined | false;

/** Creates an element. Attributes set to `false` or `undefined` are skipped; `true` sets an empty attribute. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === false || value === undefined) continue;
    el.setAttribute(name, value === true ? '' : String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child);
  }
  return el;
}

/** Formats an integer with thousands separators. */
export function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

/** True when keyboard focus is in something that takes text (inputs, Monaco's textarea, contenteditable). */
export function isTextTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return target.closest('input, textarea, select, .monaco-editor') !== null;
}
