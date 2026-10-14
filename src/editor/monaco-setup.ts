// Minimal Monaco bundle: editor API + csharp + xml only. Never import the
// `monaco-editor` barrel. Paths follow the 0.57 package `exports` map.
import * as monaco from 'monaco-editor/editor/editor.api';
import 'monaco-editor/languages/definitions/csharp/register';
import 'monaco-editor/languages/definitions/xml/register';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';

self.MonacoEnvironment = {
  getWorker(): Worker {
    return new EditorWorker();
  },
};

export { monaco };
