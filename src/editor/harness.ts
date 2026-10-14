// Dev-only test page for the engine: /src/editor/harness.html. Not part of the app.
import { createDiffEngine } from './index';
import { isDiffProviderActive, supersededRuns } from './diff-provider';
import { monaco } from './monaco-setup';
import type { DiffEngine, DiffOptions } from '../types';

declare global {
  interface Window {
    __engine?: DiffEngine;
    __gen?: (lines: number) => { a: string; b: string };
    __log?: string[];
    __providerActive?: () => boolean;
    __supersededRuns?: () => number;
    __monacoModified?: () => monaco.editor.ICodeEditor | undefined;
  }
}

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Throwaway Acumatica-shaped XML pair, ~2% scattered edits on B. */
function gen(target: number): { a: string; b: string } {
  const r = rng(42 + target);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
  const names = ['SOOrder', 'ARInvoice', 'POReceipt', 'INItem', 'CRCase', 'APBill', 'GLTran', 'FSAppointment'];
  const lines: string[] = ['<Customization level="100" description="Generated" product-version="24.200.0000">'];
  let n = 0;
  while (lines.length < target - 1) {
    const name = pick(names) + (n++).toString();
    if (r() < 0.15) {
      let b64 = '';
      for (let i = 0; i < 600; i++) b64 += B64[Math.floor(r() * 64)];
      lines.push(`  <File AppRelativePath="Bin\\${name}.dll" FileID="${Math.floor(r() * 1e9)}" Data="${b64}" />`);
      continue;
    }
    lines.push(`  <Graph ClassName="${name}Ext" Source="#CDATA" IsNew="True" FileType="ExistingGraph">`);
    lines.push('    <CDATA name="Source"><![CDATA[using PX.Data;');
    lines.push('using PX.Objects.SO;');
    lines.push(`namespace Custom.${name}`);
    lines.push('{');
    lines.push(`    public class ${name}Ext : PXGraphExtension<${name}Entry>`);
    lines.push('    {');
    const body = 40 + Math.floor(r() * 300);
    for (let i = 0; i < body && lines.length < target - 6; i++) {
      const v = Math.floor(r() * 1000);
      switch (Math.floor(r() * 6)) {
        case 0: lines.push(`        [PXDBString(${v}, IsUnicode = true)]`); break;
        case 1: lines.push(`        public virtual string Usr${name}Field${i} { get; set; }`); break;
        case 2: lines.push(`        var rows = SelectFrom<${name}>.Where<${name}.qty.IsGreater<@P.AsDecimal>>.View.Select(Base, ${v});`); break;
        case 3: lines.push(`        if (row.Qty > ${v}m) row.Status = "${pick(['N', 'H', 'C', 'X'])}";`); break;
        case 4: lines.push(''); break;
        default: lines.push(`        // ${name} note ${v}: ${'lorem ipsum '.repeat(1 + (v % 5))}`);
      }
    }
    lines.push('    }');
    lines.push('}]]></CDATA>');
    lines.push('  </Graph>');
  }
  lines.push('</Customization>');

  const b = lines.slice();
  const edits = Math.floor(lines.length * 0.02);
  for (let i = 0; i < edits; i++) {
    const at = 1 + Math.floor(r() * (b.length - 2));
    const line = b[at] ?? '';
    switch (i % 4) {
      case 0: b[at] = line.replace(/\d+/, (d) => String(Number(d) + 1)); break;
      case 1: b[at] = line + '  '; break; // whitespace-only
      case 2: b[at] = line.replace('string', 'int'); break;
      default: b[at] = line.replace(/"/, '" '); break; // whitespace inside
    }
  }
  // 300-line insert and delete.
  const ins = Math.floor(b.length * 0.3);
  b.splice(ins, 0, ...Array.from({ length: 300 }, (_, i) => `        // inserted line ${i}`));
  b.splice(Math.floor(b.length * 0.7), 300);
  return { a: lines.join('\n'), b: b.join('\n') };
}

const engine = createDiffEngine();
window.__engine = engine;
window.__gen = gen;
window.__providerActive = isDiffProviderActive;
window.__supersededRuns = supersededRuns;
// Test-only: the right-hand editor (its model URI is inmemory://sidediff/b/N).
window.__monacoModified = () => monaco.editor.getEditors().find((e) => e.getModel()?.uri.path.startsWith('/b/'));
const logLines: string[] = [];
window.__log = logLines;

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
};
const logEl = $('log');
function log(msg: string): void {
  const line = `${(performance.now() / 1000).toFixed(2)}s ${msg}`;
  logLines.push(line);
  logEl.textContent = logLines.slice(-200).join('\n');
  logEl.scrollTop = logEl.scrollHeight;
}

engine.mount($('editor'));
engine.setTheme('dark');
engine.setLanguage('xml');

engine.on('diff:start', (p) => {
  $('spinner').classList.add('on');
  log(`diff:start ${JSON.stringify(p)}`);
});
engine.on('diff:done', (s) => {
  $('spinner').classList.remove('on');
  $('stats').textContent = `+${s.added} -${s.removed} ~${s.modified} changes ${s.changes} (${s.computeMs} ms${s.quitEarly ? ', quit early' : ''})`;
  log(`diff:done ${JSON.stringify(s)}`);
});
engine.on('diff:error', (e) => {
  $('spinner').classList.remove('on');
  log(`diff:error ${e.message}`);
});
engine.on('position', (p) => {
  $('pos').textContent = p.total ? `change ${p.index} of ${p.total}` : 'no changes';
  log(`position ${JSON.stringify(p)}`);
});
engine.on('degraded', (d) => log(`degraded ${JSON.stringify(d)}`));
engine.on('content', (c) => log(`content ${JSON.stringify(c)}`));
engine.on('paste', (p) => log(`paste ${p.side} sample=${p.sample.length}`));

for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-gen]')) {
  btn.addEventListener('click', () => {
    const t0 = performance.now();
    const { a, b } = gen(Number(btn.dataset.gen));
    log(`generated in ${Math.round(performance.now() - t0)} ms (${(a.length / 1e6).toFixed(1)} MB)`);
    engine.setText('a', a);
    engine.setText('b', b);
  });
}

const fixtureSel = $<HTMLSelectElement>('fixture');
for (const name of ['small', 'medium', 'large', 'stress', 'csharp-large']) {
  const o = document.createElement('option');
  o.value = name;
  o.textContent = name;
  fixtureSel.append(o);
}
fixtureSel.addEventListener('change', async () => {
  const name = fixtureSel.value;
  if (!name) return;
  const ext = name.startsWith('csharp') ? 'cs' : 'xml';
  try {
    const [a, b] = await Promise.all(
      ['a', 'b'].map(async (s) => {
        const res = await fetch(`/fixtures/${name}-${s}.${ext}`);
        if (!res.ok) throw new Error(`${res.status} ${res.url}`);
        return res.text();
      }),
    );
    engine.setLanguage(ext === 'cs' ? 'csharp' : 'xml');
    engine.setText('a', a ?? '');
    engine.setText('b', b ?? '');
  } catch (err) {
    log(`fixture load failed: ${String(err)}`);
  }
});

$('next').addEventListener('click', () => engine.nextChange());
$('prev').addEventListener('click', () => engine.prevChange());
$('swap').addEventListener('click', () => engine.swap());
$('find').addEventListener('click', () => engine.find());
let dark = true;
$('theme').addEventListener('click', () => {
  dark = !dark;
  engine.setTheme(dark ? 'dark' : 'light');
  document.body.style.background = dark ? '#1e1e1e' : '#fff';
});

const checkbox = (id: string, key: keyof DiffOptions): void => {
  const el = $<HTMLInputElement>(id);
  el.addEventListener('change', () => engine.setOptions({ [key]: el.checked }));
};
checkbox('diffOnly', 'diffOnly');
checkbox('trim', 'ignoreTrimWhitespace');
checkbox('allws', 'ignoreAllWhitespace');
checkbox('wrap', 'wordWrap');
checkbox('minimap', 'minimap');
const inline = $<HTMLInputElement>('inline');
inline.addEventListener('change', () => engine.setOptions({ viewMode: inline.checked ? 'inline' : 'side-by-side' }));
const ctx = $<HTMLInputElement>('ctx');
ctx.addEventListener('change', () => engine.setOptions({ contextLines: Number(ctx.value) }));
