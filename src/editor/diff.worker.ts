// Dedicated diff worker. Runs Monaco's own DefaultLinesDiffComputer (the
// 'advanced' algorithm the editor worker uses), but lives in a worker the
// engine owns, so a superseded run can be stopped by terminating it. See
// DECISIONS.md D11.
import { DefaultLinesDiffComputer } from 'monaco-editor/editor/common/diff/defaultLinesDiffComputer/defaultLinesDiffComputer';
import type { DiffWorkerRequest, DiffWorkerResponse, SerializedChange } from './diff-worker-protocol';
import { fixLongLineChanges, maskLongLines } from './long-lines';

const texts: Record<'o' | 'm', { key: string; lines: string[] } | null> = { o: null, m: null };
const computer = new DefaultLinesDiffComputer();

function linesEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function reply(msg: DiffWorkerResponse): void {
  self.postMessage(msg);
}

self.onmessage = (ev: MessageEvent<DiffWorkerRequest>) => {
  const msg = ev.data;
  if (msg.type === 'text') {
    // Monaco models hold no \r or \n inside a line, so this matches getLinesContent().
    texts[msg.slot] = { key: msg.key, lines: msg.text.split(/\r\n|\r|\n/) };
    return;
  }
  const o = texts.o;
  const m = texts.m;
  if (!o || !m || o.key !== msg.o || m.key !== msg.m) {
    reply({ type: 'error', id: msg.id, message: 'diff worker: text out of sync' });
    return;
  }
  try {
    const t0 = performance.now();
    // Long lines are diffed as content-hash tokens: no character diff (D14).
    const mo = maskLongLines(o.lines, msg.options.ignoreTrimWhitespace);
    const mm = maskLongLines(m.lines, msg.options.ignoreTrimWhitespace);
    const r = computer.computeDiff(mo.lines, mm.lines, msg.options);
    const raw: SerializedChange[] = r.changes.map((c) => [
      c.original.startLineNumber,
      c.original.endLineNumberExclusive,
      c.modified.startLineNumber,
      c.modified.endLineNumberExclusive,
      c.innerChanges?.map((i) => [
        i.originalRange.startLineNumber,
        i.originalRange.startColumn,
        i.originalRange.endLineNumber,
        i.originalRange.endColumn,
        i.modifiedRange.startLineNumber,
        i.modifiedRange.startColumn,
        i.modifiedRange.endLineNumber,
        i.modifiedRange.endColumn,
      ]),
    ]);
    const changes = fixLongLineChanges(raw, o.lines, m.lines, mo.long, mm.long);
    reply({
      type: 'result',
      id: msg.id,
      changes,
      quitEarly: r.hitTimeout,
      identical: changes.length === 0 && linesEqual(o.lines, m.lines),
      ms: performance.now() - t0,
    });
  } catch (err) {
    reply({ type: 'error', id: msg.id, message: err instanceof Error ? err.message : String(err) });
  }
};
