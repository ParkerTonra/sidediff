// pnpm build:decompiler: publishes decompiler/ (.NET 8 WebAssembly, Release,
// trimmed, no AOT) and copies the runtime into public/decompiler/_framework,
// which is committed so building SideDiff needs only Node. DECISIONS.md D19.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = mkdtempSync(join(tmpdir(), 'sidediff-decompiler-'));
const target = join(here, '..', 'public', 'decompiler', '_framework');

execFileSync('dotnet', ['publish', join(here, 'Decompiler.csproj'), '-c', 'Release', '-o', out, '--nologo'], {
  stdio: 'inherit',
  cwd: here,
});
rmSync(target, { recursive: true, force: true }); // public/decompiler/.gitattributes stays
cpSync(join(out, 'wwwroot', '_framework'), target, { recursive: true });
rmSync(out, { recursive: true, force: true });

let total = 0;
for (const f of readdirSync(target)) total += statSync(join(target, f)).size;
console.log(`public/decompiler/_framework: ${readdirSync(target).length} files, ${(total / 1024 / 1024).toFixed(1)} MB`);
