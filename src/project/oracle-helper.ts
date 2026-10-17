// Test helper (not shipped): compares indexer items with a QA fixture sidecar.
import type { ProjectItem } from '../types';

export interface OracleItem {
  id: string;
  element: string;
  group: string;
  name: string;
  detail: string;
  screenId?: string | null;
  status: string;
  views: string[];
  a: { startLine: number; endLine: number } | null;
  b: { startLine: number; endLine: number } | null;
  /** Which sides have the item (package sidecar). */
  sides?: ('a' | 'b')[];
  /** Fields the sidecar leaves open: any of detail, views, ranges, … */
  loose?: string[];
}

/**
 * Indexer changes the QA sidecar hasn't caught up with yet; each entry names
 * the change. Remove an entry once QA regenerates the fixture.
 */
export function applyPendingSidecarChanges(items: OracleItem[]): void {
  for (const it of items) {
    // CSAttribute gained a structured summary (allowed values), so Summary is listed first.
    if (it.element === 'CSAttribute' && it.views.includes('summary') && it.views[0] !== 'summary') {
      it.views = ['summary', ...it.views.filter((v) => v !== 'summary')];
    }
  }
}

/**
 * Field-by-field differences, empty when everything matches. The 'summary'
 * view is compared only when the sidecar lists it; 'ranges' covers a and b.
 */
export function oracleDiffs(items: ProjectItem[], expected: OracleItem[]): string[] {
  const got = new Map(items.map((i) => [i.id, i]));
  const diffs: string[] = [];
  for (const e of expected) {
    const g = got.get(e.id);
    if (!g) {
      diffs.push(`missing ${e.id}`);
      continue;
    }
    got.delete(e.id);
    const loose = new Set(e.loose ?? []);
    if (loose.has('ranges')) loose.add('a').add('b');
    const views = g.views.map((v) => v.id).filter((v) => v !== 'summary' || e.views.includes('summary'));
    const actual: Record<string, unknown> = { element: g.element, group: g.group, name: g.name, detail: g.detail, screenId: g.screenId ?? null, status: g.status, views, a: g.a, b: g.b };
    const want: Record<string, unknown> = { element: e.element, group: e.group, name: e.name, detail: e.detail, screenId: e.screenId ?? null, status: e.status, views: e.views, a: e.a, b: e.b };
    for (const k of Object.keys(want)) {
      if (loose.has(k)) continue;
      if (JSON.stringify(actual[k]) !== JSON.stringify(want[k])) diffs.push(`${e.id}.${k}: got ${JSON.stringify(actual[k])}, want ${JSON.stringify(want[k])}`);
    }
    if (e.sides) {
      const sides = [g.a ? 'a' : '', g.b ? 'b' : ''].filter(Boolean);
      if (JSON.stringify(sides) !== JSON.stringify(e.sides)) diffs.push(`${e.id}.sides: got ${JSON.stringify(sides)}, want ${JSON.stringify(e.sides)}`);
    }
  }
  for (const id of got.keys()) diffs.push(`unexpected ${id}`);
  return diffs;
}
