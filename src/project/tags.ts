// Tolerant markup reader for summaries: works on export XML, ASPX (server
// tags, unquoted attributes) and Modern UI HTML. Not a validating parser; it
// never throws, and unbalanced tags are closed as best it can.
import { decodeEntities } from './scan';

export interface Node {
  name: string;
  attrs: Record<string, string>;
  children: Node[];
  parent: Node | null;
  /** Text of CDATA sections directly inside this element, joined. */
  cdata: string;
}

const VOID = new Set(['br', 'img', 'input', 'hr', 'meta', 'link', 'col', 'area', 'base', 'source', 'wbr']);
const ATTR_RE = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/g;
const TAG_RE = /<(\/?)([A-Za-z_][\w.:-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/y;

export function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(ATTR_RE)) {
    const k = m[1];
    if (!k || k in out) continue;
    out[k] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return out;
}

/** Builds a forgiving element tree. The returned root is a synthetic '#root'. */
export function parseTree(text: string): Node {
  const root: Node = { name: '#root', attrs: {}, children: [], parent: null, cdata: '' };
  let cur = root;
  let i = 0;
  const n = text.length;
  let lowerText: string | null = null;
  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt === -1) break;
    i = lt;
    if (text.startsWith('<!--', i)) {
      const e = text.indexOf('-->', i + 4);
      i = e === -1 ? n : e + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', i)) {
      const e = text.indexOf(']]>', i + 9);
      cur.cdata += text.slice(i + 9, e === -1 ? n : e);
      i = e === -1 ? n : e + 3;
      continue;
    }
    if (text.startsWith('<%', i)) {
      const e = text.indexOf('%>', i + 2);
      i = e === -1 ? n : e + 2;
      continue;
    }
    if (text.startsWith('<?', i) || text.startsWith('<!', i)) {
      const e = text.indexOf('>', i + 2);
      i = e === -1 ? n : e + 1;
      continue;
    }
    TAG_RE.lastIndex = i;
    const m = TAG_RE.exec(text);
    if (!m) {
      i++;
      continue;
    }
    i = TAG_RE.lastIndex;
    const [, close, name = '', rest = '', self] = m;
    if (close) {
      // Pop to the nearest open element with this name; ignore strays.
      for (let p: Node | null = cur; p && p !== root; p = p.parent) {
        if (p.name === name) {
          cur = p.parent ?? root;
          break;
        }
      }
      continue;
    }
    const node: Node = { name, attrs: parseAttrs(rest), children: [], parent: cur, cdata: '' };
    cur.children.push(node);
    const lower = name.toLowerCase();
    if (lower === 'script' || lower === 'style') {
      lowerText ??= text.toLowerCase();
      const e = lowerText.indexOf(`</${lower}`, i);
      i = e === -1 ? n : e;
      continue;
    }
    if (!self && !VOID.has(lower)) cur = node;
  }
  return root;
}

/** Depth-first descendants (not including `node`). */
export function* descendants(node: Node): Generator<Node> {
  const stack = [...node.children].reverse();
  while (stack.length) {
    const x = stack.pop() as Node;
    yield x;
    for (let k = x.children.length - 1; k >= 0; k--) stack.push(x.children[k] as Node);
  }
}

/** Element name without its prefix: `px:PXGrid` → `PXGrid`. */
export const localName = (name: string): string => name.slice(name.indexOf(':') + 1);

export const findAll =(node: Node, name: string): Node[] => [...descendants(node)].filter((x) => x.name === name);
export const findFirst = (node: Node, pred: (n: Node) => boolean): Node | undefined => {
  for (const x of descendants(node)) if (pred(x)) return x;
  return undefined;
};
export const ancestor = (node: Node, pred: (n: Node) => boolean): Node | undefined => {
  for (let p = node.parent; p; p = p.parent) if (pred(p)) return p;
  return undefined;
};
