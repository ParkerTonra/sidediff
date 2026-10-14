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
import { monacoDiffStats, withinTolerance } from './lib/diff-stats.ts';
import type { CountedStats, Tolerance } from './lib/diff-stats.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'fixtures');

/** How far the app's stats may drift from `expected` (per stat). */
export const TOLERANCE: Tolerance = { relative: 0.02, absolute: 3 };

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
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
      '`detail` null = unspecified by the contract or different per side. `lines` = text.split("\n").length. ' +
      'Items are sorted by group order, then name. Line ranges are 1-based inclusive.',
  };
  writeFileSync(join(OUT, 'project.changes.json'), JSON.stringify(sidecar, null, 2) + '\n');
  const s = p.counts.byStatus;
  console.log(
    `project       A ${lineCount(p.a)} lines ${(Buffer.byteLength(p.a) / 1024 / 1024).toFixed(2)} MB | B ${lineCount(p.b)} lines | ` +
      `${p.counts.total} items: same ${s.same}, modified ${s.modified}, whitespace ${s.whitespace}, only-a ${s['only-a']}, only-b ${s['only-b']} | ${Math.round(performance.now() - t0)} ms`,
  );
}

await main();
