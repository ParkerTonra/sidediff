// Builds the synthetic test assembly (fixtures-src/SampleCustomization) twice,
// A and B (VARIANT_B), deterministically, and copies the DLLs to
// fixtures/static/. The outputs are committed so tests never need .NET.
//
// Usage: node scripts/build-test-dll.ts   (needs the .NET SDK on PATH)

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT = join(ROOT, 'fixtures-src/SampleCustomization/SampleCustomization.csproj');
const OUT = join(ROOT, 'fixtures/static');

function build(variant: 'A' | 'B'): string {
  const out = join(tmpdir(), 'sidediff-test-dll', 'out', variant);
  rmSync(out, { recursive: true, force: true });
  // Same obj/ for both variants, so rebuild from scratch each time.
  const args = ['build', PROJECT, '-c', 'Release', '-p:Deterministic=true', '--no-incremental', '-o', out, '--nologo', '-v', 'q'];
  if (variant === 'B') args.push('-p:DefineConstants=VARIANT_B');
  const r = spawnSync('dotnet', args, { stdio: 'inherit', cwd: dirname(PROJECT) });
  if (r.status !== 0) throw new Error(`dotnet build ${variant} failed`);
  return join(out, 'Contoso.Extensions.dll');
}

mkdirSync(OUT, { recursive: true });
for (const [variant, name] of [['A', 'Contoso.Extensions.dll'], ['B', 'Contoso.Extensions.B.dll']] as const) {
  const dll = build(variant);
  copyFileSync(dll, join(OUT, name));
  const bytes = readFileSync(dll);
  console.log(`${name}: ${bytes.length} bytes, sha256 ${createHash('sha256').update(bytes).digest('hex')}`);
}
