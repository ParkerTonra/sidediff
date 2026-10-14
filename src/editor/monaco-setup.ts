// Minimal Monaco bundle: editor API + csharp + xml + the editor features the
// app needs. Never import the `monaco-editor` barrel. Paths follow the 0.57
// package `exports` map (`monaco-editor/<x>` → `esm/vs/<x>.js`).
import * as monaco from 'monaco-editor/editor/editor.api';
import 'monaco-editor/languages/definitions/csharp/register';
import 'monaco-editor/languages/definitions/xml/register';
// editor.api ships no contributions: without these there is no find widget,
// folding, bracket matching, clipboard/context menu, or codicon font (the
// diff-only separators would show empty boxes). See DECISIONS.md.
import 'monaco-editor/features/codicon/register';
import 'monaco-editor/features/diffEditor/register';
import 'monaco-editor/features/find/register';
import 'monaco-editor/features/folding/register';
import 'monaco-editor/features/bracketMatching/register';
import 'monaco-editor/features/clipboard/register';
import 'monaco-editor/features/contextmenu/register';
import 'monaco-editor/features/cursorUndo/register';
import 'monaco-editor/features/multicursor/register';
import 'monaco-editor/features/wordOperations/register';
import 'monaco-editor/features/linesOperations/register';
import 'monaco-editor/features/gotoLine/register';
// Ctrl+M (toggle Tab moves focus): without it the panes are a keyboard trap.
import 'monaco-editor/features/toggleTabFocusMode/register';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import { installDiffProvider } from './diff-provider';
import { applyMonacoPatches } from './monaco-patches';

self.MonacoEnvironment = {
  getWorker(): Worker {
    return new EditorWorker();
  },
};

// Must run after the feature imports above (they register services) and
// before anything else touches Monaco's services. The Languages module
// imports `monaco` from here, so this always runs first.
installDiffProvider();
applyMonacoPatches();

// The UI owns F7 / Shift+F7 / Alt+Up / Alt+Down (change navigation). Drop
// Monaco's own bindings for them so a focused pane never moves lines or opens
// the accessible diff viewer instead.
const { KeyMod, KeyCode } = monaco;
monaco.editor.addKeybindingRules([
  { keybinding: KeyMod.Alt | KeyCode.UpArrow, command: '-editor.action.moveLinesUpAction' },
  { keybinding: KeyMod.Alt | KeyCode.DownArrow, command: '-editor.action.moveLinesDownAction' },
  { keybinding: KeyCode.F7, command: '-editor.action.accessibleDiffViewer.next' },
  { keybinding: KeyMod.Shift | KeyCode.F7, command: '-editor.action.accessibleDiffViewer.prev' },
]);

export { monaco };
