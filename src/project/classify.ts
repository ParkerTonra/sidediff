// Data-driven classification of <Customization> children. One row per element
// name; add a row to support a new element. Unknown elements go to "other".
// Formats follow INTERFACES.md "Project explorer" (checked against a real export).
import type { LanguageId, ProjectGroup } from '../types';
import type { CdataSection, DescendantWants, RawItem } from './scan';

export const GROUP_ORDER: readonly ProjectGroup[] = ['code', 'screens', 'tables', 'sql', 'reports', 'inquiries', 'sitemap', 'integration', 'files', 'other'];

/** Identity fallback when an element has none of its own key attributes. */
export const GENERIC_KEYS = ['Name', 'name', 'ScreenID', 'ClassName', 'TableName', 'ReportName', 'path', 'AppRelativePath', 'Title', 'Key'] as const;

/** Where an item's code view comes from (offsets into that side's text). */
export type CodeSource =
  /** CDATA bodies; several are joined with `// ---- name ----` lines. */
  | { kind: 'cdata'; sections: CdataSection[] }
  /** DAC: one block per <Field>: a header comment, then its CDATA body. */
  | { kind: 'fields'; fields: { header: string; sections: CdataSection[] }[] }
  /** Page pageSource: base64 of raw-deflate. Decoded on demand. */
  | { kind: 'deflate'; base64: string }
  /** EditorUpdatedFields: bare CDATA holding JSON, pretty-printed when it parses. */
  | { kind: 'json'; sections: CdataSection[] };

export interface CodeSpec {
  label: string;
  /** null = detect from the text. 'json' falls back to plaintext unless that pack is installed. */
  language: LanguageId | null;
  source: CodeSource;
}

export interface Classified {
  group: ProjectGroup;
  /** Identity before duplicate numbering. */
  identity: string;
  name: string;
  detail: string;
  screenId?: string;
  code: CodeSpec | null;
  /** Label of the XML view ("Changes" for a Page whose element holds the control delta). */
  xmlLabel: string;
}

interface Rule {
  elements: readonly string[];
  group: ProjectGroup | ((item: RawItem) => ProjectGroup);
  /** Start-tag attributes tried in order for the identity. */
  keys: readonly string[];
  /** First descendant `row` having one of these; its values are tried next, in order. */
  firstRow?: { element: string; anyOf: readonly string[] };
  /** Descendant attributes tried after that (default: GENERIC_KEYS). */
  descendantKeys?: readonly string[];
  /** Descendant element names to count (for detail). */
  count?: readonly string[];
  /** Descendant elements whose attrs and CDATA the code view needs. */
  capture?: readonly string[];
  identity?: (item: RawItem, base: string) => string;
  name?: (item: RawItem, identity: string) => string;
  detail?: (item: RawItem) => string;
  screenId?: (item: RawItem) => string | undefined;
  /** Custom code view; default: all CDATA sections, labelled `codeLabel`. */
  code?: (item: RawItem) => CodeSpec | null;
  codeLabel?: string | ((item: RawItem) => string);
  codeLanguage?: LanguageId | ((item: RawItem) => LanguageId | null);
  xmlLabel?: (item: RawItem) => string;
}

const GRAPH_TYPES: Record<string, string> = {
  ExistingGraph: 'Graph extension',
  NewGraph: 'New graph',
  ExistingDac: 'DAC extension',
  NewDac: 'New DAC',
  NewFile: 'Code file',
};

export const baseName = (p: string): string => p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1);
const stem = (p: string): string => {
  const b = baseName(p);
  const dot = b.lastIndexOf('.');
  return dot <= 0 ? b : b.slice(0, dot);
};
const ext = (p: string): string => {
  const b = baseName(p);
  const dot = b.lastIndexOf('.');
  return dot === -1 ? '' : b.slice(dot + 1).toLowerCase();
};
const fileLanguage = (path: string): LanguageId => {
  const e = ext(path);
  if (e === 'cs') return 'csharp';
  if (['aspx', 'xml', 'config', 'ascx', 'master', 'rpx', 'html', 'htm'].includes(e)) return 'xml';
  return 'plaintext';
};
/** `Pages\SO\SO301000.aspx(.cs)` → SO301000 */
const SCREEN_PATH_RE = /(?:^|[\\/])pages[\\/][a-z0-9]{2}[\\/]([a-z]{2}[0-9]{6})\.aspx(?:\.cs)?$/i;
export const screenIdFromPath = (p: string): string | undefined => SCREEN_PATH_RE.exec(p)?.[1]?.toUpperCase();
const upper = (s: string | undefined): string | undefined => (s ? s.toUpperCase() : undefined);

const fieldsCode = (it: RawItem): CodeSpec | null => {
  const fields = it.captured.filter((c) => c.element === 'Field');
  if (!fields.length) return null;
  return {
    label: 'Fields',
    language: 'csharp',
    source: {
      kind: 'fields',
      fields: fields.map((f) => {
        const a = f.attrs;
        const fname = a.FieldName ?? a.Name ?? a.name ?? '?';
        const type = a.TypeName ?? a.Type ?? '';
        const storage = a.StorageName ?? '';
        const header = `// ${fname}${type ? ` : ${type}` : ''}${storage ? ` (${storage})` : ''}`;
        return { header, sections: f.cdata.filter((s) => s.name === 'TextAttributes' || f.cdata.length === 1) };
      }),
    },
  };
};

export const RULES: readonly Rule[] = [
  {
    elements: ['Graph'],
    group: 'code',
    keys: ['ClassName'],
    detail: (it) => {
      const ft = it.attrs.FileType ?? '';
      return GRAPH_TYPES[ft] ?? ft;
    },
    codeLabel: 'C#',
    codeLanguage: 'csharp',
  },
  {
    elements: ['DAC'],
    group: 'code',
    keys: ['type'],
    count: ['Field'],
    capture: ['Field'],
    name: (it, id) => {
      const t = it.attrs.type;
      return t ? t.slice(Math.max(t.lastIndexOf('.'), t.lastIndexOf('+')) + 1) : id;
    },
    detail: (it) => {
      const n = it.descendantCounts.Field ?? 0;
      return `DAC customization · ${n} field${n === 1 ? '' : 's'}`;
    },
    code: fieldsCode,
  },
  {
    elements: ['Page'],
    group: 'screens',
    keys: ['path'],
    name: (it, id) => (it.attrs.path ? stem(it.attrs.path).toUpperCase() : id),
    screenId: (it) => (it.attrs.path ? stem(it.attrs.path).toUpperCase() : undefined),
    detail: (it) => (it.attrs.isModernUIOnlyNode === 'True' ? 'Modern UI page' : it.childCount > 0 ? 'Screen customization' : 'Page'),
    code: (it) => {
      const src = it.attrs.pageSource;
      if (!src || src === '#CDATA') {
        // Some generators keep the page in a CDATA wrapper instead.
        return it.cdata.length ? { label: 'ASPX', language: 'xml', source: { kind: 'cdata', sections: it.cdata } } : null;
      }
      return { label: ext(it.attrs.path ?? '') === 'html' ? 'HTML' : 'ASPX', language: 'xml', source: { kind: 'deflate', base64: src } };
    },
    xmlLabel: (it) => (it.childCount > 0 ? 'Changes' : 'XML'),
  },
  {
    elements: ['File'],
    group: (it) => (ext(it.attrs.AppRelativePath ?? '') === 'cs' ? 'code' : 'files'),
    keys: ['AppRelativePath'],
    name: (it, id) => (it.attrs.AppRelativePath ? baseName(it.attrs.AppRelativePath) : id),
    detail: (it) => it.attrs.AppRelativePath ?? '',
    screenId: (it) => screenIdFromPath(it.attrs.AppRelativePath ?? ''),
    codeLabel: (it) => (ext(it.attrs.AppRelativePath ?? '') === 'cs' ? 'C#' : 'Content'),
    codeLanguage: (it) => fileLanguage(it.attrs.AppRelativePath ?? ''),
  },
  {
    elements: ['PerTenantFile'],
    group: 'files',
    keys: ['AppRelativePath'],
    name: (it, id) => (it.attrs.AppRelativePath ? baseName(it.attrs.AppRelativePath) : id),
    detail: (it) => `Modern UI file · ${it.attrs.AppRelativePath ?? ''}`,
    screenId: (it) => upper(it.attrs.ScreenId),
    code: () => null,
  },
  {
    elements: ['EditorUpdatedFields'],
    group: 'screens',
    keys: ['ScreenId'],
    name: (it, id) => `${it.attrs.ScreenId ?? id} editor fields`,
    detail: () => 'Modern UI editor metadata',
    screenId: (it) => upper(it.attrs.ScreenId),
    code: (it) => {
      const bare = it.cdata.filter((s) => s.name === '');
      return bare.length ? { label: 'JSON', language: 'json', source: { kind: 'json', sections: bare } } : null;
    },
  },
  {
    elements: ['Table'],
    group: 'tables',
    keys: ['TableName'],
    count: ['Column'],
    detail: (it) => {
      const n = it.descendantCounts.Column ?? 0;
      return `${n} column${n === 1 ? '' : 's'}`;
    },
  },
  {
    elements: ['Sql'],
    group: 'sql',
    keys: ['TableName', 'Name'],
    detail: () => 'Table schema',
    code: (it) => {
      const schema = it.cdata.filter((s) => s.name === 'TableSchemaXml');
      const sections = schema.length ? schema : it.cdata;
      return sections.length ? { label: 'Schema', language: 'xml', source: { kind: 'cdata', sections } } : null;
    },
  },
  { elements: ['Report', 'ReportDefinition'], group: 'reports', keys: ['ReportName', 'Name'], codeLabel: 'Report', codeLanguage: 'xml' },
  {
    elements: ['SiteMapNode'],
    group: 'sitemap',
    keys: [],
    firstRow: { element: 'row', anyOf: ['ScreenID'] },
    detail: (it) => it.firstRow?.Title ?? '',
    screenId: (it) => upper(it.firstRow?.ScreenID),
    code: () => null,
  },
  {
    elements: ['GenericInquiryScreen', 'GIDesign', 'DashboardMaintenance'],
    group: 'inquiries',
    keys: [],
    firstRow: { element: 'row', anyOf: ['Name', 'DesignID'] },
    code: () => null,
  },
  {
    elements: ['EntityEndpoint', 'XportScenario', 'ImportScenario', 'WebHook', 'BusinessEvent'],
    group: 'integration',
    keys: ['Name'],
    identity: (it, base) => (it.attrs.Version ? `${base} ${it.attrs.Version}` : base),
    code: () => null,
  },
];

const BY_ELEMENT = new Map<string, Rule>();
for (const r of RULES) for (const e of r.elements) BY_ELEMENT.set(e, r);

export const ruleFor = (element: string): Rule | undefined => BY_ELEMENT.get(element);

/** Tells the scanner what to collect from an element's descendants. */
export function wantsFor(element: string, attrs: Record<string, string>): DescendantWants | null {
  const rule = BY_ELEMENT.get(element);
  const hasOwn = (rule ? rule.keys : GENERIC_KEYS).some((k) => attrs[k]);
  const w: DescendantWants = {
    attrs: hasOwn ? [] : (rule?.descendantKeys ?? GENERIC_KEYS),
    count: rule?.count ?? [],
    ...(rule?.capture ? { capture: rule.capture } : {}),
    ...(rule?.firstRow ? { firstRow: rule.firstRow } : {}),
  };
  return w.attrs.length || w.count.length || w.capture || w.firstRow ? w : null;
}

const pick = (keys: readonly string[], from: Record<string, string> | null): string | undefined => {
  if (!from) return undefined;
  for (const k of keys) {
    const v = from[k];
    if (v && v.trim()) return v.trim();
  }
  return undefined;
};

/**
 * Classifies one scanned element. `ordinal` is its 1-based position among
 * siblings with the same element name (the last-resort identity).
 */
export function classify(item: RawItem, ordinal: number): Classified {
  const rule = BY_ELEMENT.get(item.element);
  const base =
    pick(rule ? rule.keys : GENERIC_KEYS, item.attrs) ??
    (rule?.firstRow ? pick(rule.firstRow.anyOf, item.firstRow) : undefined) ??
    pick(rule?.descendantKeys ?? GENERIC_KEYS, item.descendantAttrs) ??
    (rule ? pick(GENERIC_KEYS, item.attrs) : undefined) ??
    String(ordinal);

  const defaultCode = (label: string, language: LanguageId | null): CodeSpec | null =>
    item.cdata.length ? { label, language, source: { kind: 'cdata', sections: item.cdata } } : null;

  if (!rule) {
    return { group: 'other', identity: base, name: base, detail: item.element, code: defaultCode('Code', null), xmlLabel: 'XML' };
  }
  const identity = rule.identity ? rule.identity(item, base) : base;
  const label = typeof rule.codeLabel === 'function' ? rule.codeLabel(item) : (rule.codeLabel ?? 'Code');
  const language = typeof rule.codeLanguage === 'function' ? rule.codeLanguage(item) : (rule.codeLanguage ?? null);
  const screenId = rule.screenId?.(item);
  return {
    group: typeof rule.group === 'function' ? rule.group(item) : rule.group,
    identity,
    name: rule.name ? rule.name(item, identity) : identity,
    detail: rule.detail ? rule.detail(item) : '',
    ...(screenId ? { screenId } : {}),
    code: rule.code ? rule.code(item) : defaultCode(label, language),
    xmlLabel: rule.xmlLabel ? rule.xmlLabel(item) : 'XML',
  };
}
