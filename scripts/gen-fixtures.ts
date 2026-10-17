// Writes deterministic fixture pairs to fixtures/:
//   <name>-a.xml, <name>-b.xml (or .cs) and <name>.changes.json
//
// Usage: node scripts/gen-fixtures.ts [--only small,large] [--no-verify]
//
// Expected stats come from Monaco's own line diff (DefaultLinesDiffComputer,
// the algorithm the DiffEditor worker runs) on the generated text, with both
// trim-whitespace settings. The stats derived from the edit list are kept
// alongside as `constructed` and must agree within the tolerance.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXTURE_SPECS, generatePair } from './lib/fixture-gen.ts';
import type { ExpectedStats, GeneratedPair } from './lib/fixture-gen.ts';
import { generateProjectPair, PROJECT_SEED } from './lib/project-gen.ts';
import { generatePackagePair, PACKAGE_SEED } from './lib/package-gen.ts';
import { monacoDiffStats, withinTolerance } from './lib/diff-stats.ts';
import type { CountedStats, Tolerance } from './lib/diff-stats.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'fixtures');

/** How far the app's stats may drift from `expected` (per stat). */
export const TOLERANCE: Tolerance = { relative: 0.02, absolute: 3 };

const sha256 = (s: string | Uint8Array): string => createHash('sha256').update(s).digest('hex');
const lineCount = (s: string): number => s.split('\n').length;

function monacoVersion(): string {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'node_modules/monaco-editor/package.json'), 'utf8')) as { version: string };
  return pkg.version;
}

function agrees(x: CountedStats, y: CountedStats): boolean {
  return (['added', 'removed', 'modified', 'changes'] as const).every((k) => withinTolerance(x[k], y[k], TOLERANCE));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const onlyIdx = args.indexOf('--only');
  const only = onlyIdx >= 0 ? (args[onlyIdx + 1] ?? '').split(',') : null;
  const verify = !args.includes('--no-verify');
  mkdirSync(OUT, { recursive: true });

  let failed = false;
  for (const spec of FIXTURE_SPECS) {
    if (only && !only.includes(spec.name)) continue;
    const t0 = performance.now();
    const pair: GeneratedPair = generatePair(spec);
    const ext = spec.kind === 'xml' ? 'xml' : 'cs';
    const fileA = `${spec.name}-a.${ext}`;
    const fileB = `${spec.name}-b.${ext}`;
    writeFileSync(join(OUT, fileA), pair.a);
    writeFileSync(join(OUT, fileB), pair.b);
    const genMs = Math.round(performance.now() - t0);

    let expected: ExpectedStats = pair.constructed;
    let source = 'construction';
    let diffMs: number | null = null;
    if (verify) {
      const t1 = performance.now();
      const trim = await monacoDiffStats(pair.a, pair.b, true);
      const noTrim = await monacoDiffStats(pair.a, pair.b, false);
      diffMs = Math.round(performance.now() - t1);
      const strip = ({ added, removed, modified, changes }: CountedStats): CountedStats => ({ added, removed, modified, changes });
      expected = { trimWhitespace: strip(trim), noTrimWhitespace: strip(noTrim) };
      source = `monaco-editor@${monacoVersion()} DefaultLinesDiffComputer (Node, maxComputationTimeMs 0)`;
      for (const mode of ['trimWhitespace', 'noTrimWhitespace'] as const) {
        if (!agrees(expected[mode], pair.constructed[mode])) {
          failed = true;
          console.error(`${spec.name} ${mode}: monaco ${JSON.stringify(expected[mode])} vs constructed ${JSON.stringify(pair.constructed[mode])}`);
        }
      }
    }

    const sidecar = {
      fixture: spec.name,
      kind: spec.kind,
      seed: spec.seed,
      generator: 'scripts/gen-fixtures.ts',
      a: { file: fileA, lines: lineCount(pair.a), bytes: Buffer.byteLength(pair.a), sha256: sha256(pair.a) },
      b: { file: fileB, lines: lineCount(pair.b), bytes: Buffer.byteLength(pair.b), sha256: sha256(pair.b) },
      edits: pair.edits,
      expected,
      expectedSource: source,
      constructed: pair.constructed,
      tolerance: TOLERANCE,
      notes:
        '`lines` counts model lines (text.split("\\n").length; files end with a newline, so the last model line is empty). ' +
        'Stats follow the DiffStats counting rule in docs/INTERFACES.md. A stat passes when |actual - expected| <= expected * relative + absolute.',
    };
    writeFileSync(join(OUT, `${spec.name}.changes.json`), JSON.stringify(sidecar, null, 2) + '\n');
    const mb = (sidecar.a.bytes / 1024 / 1024).toFixed(2);
    console.log(
      `${spec.name.padEnd(13)} A ${sidecar.a.lines} lines ${mb} MB | B ${sidecar.b.lines} lines | ` +
        `trim ${JSON.stringify(expected.trimWhitespace)} | gen ${genMs} ms` + (diffMs === null ? '' : `, verify ${diffMs} ms`),
    );
  }
  if (!only || only.includes('project')) writeProject();
  if (!only || only.includes('package')) writePackage();
  if (failed) {
    console.error('gen-fixtures: monaco stats disagree with the constructed edits beyond tolerance');
    process.exit(1);
  }
}

/** The Acumatica project pair for the explorer: project-a.xml, project-b.xml, project.changes.json. */
function writeProject(): void {
  const t0 = performance.now();
  const p = generateProjectPair();
  writeFileSync(join(OUT, 'project-a.xml'), p.a);
  writeFileSync(join(OUT, 'project-b.xml'), p.b);
  const side = (file: string, text: string, root: Record<string, string>): Record<string, unknown> => ({
    file,
    lines: lineCount(text),
    bytes: Buffer.byteLength(text),
    sha256: sha256(text),
    root,
  });
  const sidecar = {
    fixture: 'project',
    kind: 'project',
    seed: PROJECT_SEED,
    generator: 'scripts/gen-fixtures.ts (scripts/lib/project-gen.ts)',
    a: side('project-a.xml', p.a, p.root.a),
    b: side('project-b.xml', p.b, p.root.b),
    counts: p.counts,
    cdataSplit: p.cdataSplit,
    relatedScreen: p.relatedScreen,
    pageSource: p.pageSource,
    edits: p.edits,
    items: p.items,
    notes:
      'Shaped like a real export: no <?xml> header, CRLF line endings, entities in attributes, self-closing items, pageSource = base64(raw deflate(ASPX)). ' +
      'Expected items follow docs/INTERFACES.md "Project explorer": id = `${element}:${identity}` (EntityEndpoint: Name@Version; #2 for duplicates in document order), ' +
      'group from the classification table, status from the default view (CDATA bodies when present, else the element lines). ' +
      '`detail` comes from A when present, else B. `lines` = text.split("\n").length. ' +
      'Items are sorted by group order, then name. Line ranges are 1-based inclusive.',
  };
  writeFileSync(join(OUT, 'project.changes.json'), JSON.stringify(sidecar, null, 2) + '\n');
  const s = p.counts.byStatus;
  console.log(
    `project       A ${lineCount(p.a)} lines ${(Buffer.byteLength(p.a) / 1024 / 1024).toFixed(2)} MB | B ${lineCount(p.b)} lines | ` +
      `${p.counts.total} items: same ${s.same}, modified ${s.modified}, whitespace ${s.whitespace}, only-a ${s['only-a']}, only-b ${s['only-b']} | ${Math.round(performance.now() - t0)} ms`,
  );
}

/** The package pair (Phase 5): package-a.zip, package-b.zip, package.changes.json. */
function writePackage(): void {
  const t0 = performance.now();
  const statics = {
    dllA: readFileSync(join(OUT, 'static/Contoso.Extensions.dll')),
    dllB: readFileSync(join(OUT, 'static/Contoso.Extensions.B.dll')),
    jpg: readFileSync(join(OUT, 'static/contoso-banner.jpg')),
  };
  const p = generatePackagePair(statics);
  for (const side of ['a', 'b'] as const) writeFileSync(join(OUT, `package-${side}.zip`), p.zips[side]);
  const sidecar = {
    fixture: 'package',
    kind: 'package',
    seed: PACKAGE_SEED,
    generator: 'scripts/gen-fixtures.ts (scripts/lib/package-gen.ts, scripts/lib/zip.ts)',
    a: { file: 'package-a.zip', bytes: p.zips.a.length, sha256: sha256(p.zips.a), entries: p.entries.a },
    b: { file: 'package-b.zip', bytes: p.zips.b.length, sha256: sha256(p.zips.b), entries: p.entries.b },
    counts: p.counts,
    overview: p.overview,
    searches: p.searches,
    edits: p.edits,
    items: p.items,
    notes:
      'project.xml in each zip is fixtures/project-a.xml / -b.xml. Items are the project items, with File/PerTenantFile items whose file is in the zip compared by content ' +
      '(views: code | image | assembly | binary, then xml), plus Zip:<path> items for files project.xml does not reference (group by kind; detail "not in project.xml"). ' +
      '`sides` says which zips hold an item; zip items have no line ranges. `loose` lists fields the contract leaves open for that item. ' +
      'Overview: counts per group are exact; screensInclude / warningsInclude are minimums. Pages/PO/PO302000.aspx is referenced but missing from both zips.',
  };
  writeFileSync(join(OUT, 'package.changes.json'), JSON.stringify(sidecar, null, 2) + '\n');
  const st = p.counts.byStatus;
  console.log(
    `package       A ${(p.zips.a.length / 1024).toFixed(0)} KB, ${p.entries.a.length} entries | B ${(p.zips.b.length / 1024).toFixed(0)} KB, ${p.entries.b.length} entries | ` +
      `${p.counts.total} items: same ${st.same}, modified ${st.modified}, whitespace ${st.whitespace}, only-a ${st['only-a']}, only-b ${st['only-b']} | ${Math.round(performance.now() - t0)} ms`,
  );
}

await main();
