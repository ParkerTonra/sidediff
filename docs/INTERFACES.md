# SideDiff interfaces

The TypeScript source of truth is [`src/types.ts`](../src/types.ts). This file explains semantics. If you need a change, write it under **Requests** in `docs/STATUS.md`; the Lead edits `src/types.ts`. Never fork an interface locally.

## Module layout and factories

| Module | Owner | Entry point |
|---|---|---|
| `src/main.ts`, `src/types.ts` | Lead | composition root, shared types |
| `src/editor/` | Editor and Diff Core | `createDiffEngine(): DiffEngine` in `src/editor/index.ts` |
| `src/languages/` | Languages | `createLanguageRegistry(opts?): LanguageRegistry` in `src/languages/index.ts` |
| `src/app/`, `src/styles/`, `src/persist/` | UI / UX | `createApp(deps: AppDeps): void` in `src/app/index.ts` |
| `languages/manifest.json` | Languages | remote pack allowlist (served as a static file, see below) |
| `scripts/`, `fixtures/`, `tests/` | QA | |

`main.ts` builds the engine and registry, exposes both as `window.__sidediff` (tests and the bench use it), then calls `createApp`. Startup order inside `createApp`: load settings, `await registry.ensureLoaded(settings.language)`, `engine.mount(container)`, apply settings via `setTheme` / `setLanguage` / `setOptions`.

Monaco is imported **only** through `src/editor/monaco-setup.ts` (`export { monaco }`). The Languages module may import `monaco` from there to register tokenizers. The UI module never imports Monaco.

## DiffEngine (Editor agent)

One Monaco `DiffEditor` mounted into one container. A = original (left), B = modified (right).

- `mount(container)`: creates the diff editor. Called once.
- `setText(side, text)` / `getText(side)`: full model replace and read. `setText` must not freeze the tab for a 10 MB string. `getText` returns exactly what the model holds (used to prove "diff only" never changes text).
- `setLanguage(id)`: applies to both models. The caller has already run `registry.ensureLoaded(id)`.
- `setOptions(partial)`: any subset of `DiffOptions`. `diffOnly` maps to `hideUnchangedRegions` with `contextLineCount = contextLines`. `ignoreAllWhitespace` must not change the displayed text; how it is implemented is the Editor agent's call (record it in DECISIONS.md). `minimap` and `fontSize` apply to both sides.
- `setTheme(theme)`: `dark` → `vs-dark`, `light` → `vs`.
- `swap()`: swaps texts (labels are swapped by the UI) and emits `content` for both sides.
- `nextChange()` / `prevChange()` / `goToChange(i)`: move both the viewport and the cursor, wrap around, and emit `position`. Works with diff-only on (it reveals the target region).
- `getStats()`: stats from the last completed diff, or `null`.
- `find(side?)`: opens Monaco's find widget.
- `getPosition()`: current `ChangePosition` (same value as the last `position` event).
- `isComputing()`: true between `diff:start` and `diff:done`/`diff:error`.
- `focus(side)`: focuses that side's editor (in inline mode, both map to the single editor).
- `layout()`: re-measures the container; `automaticLayout` may make it a no-op.
- `dispose()`: disposes the editor, models and listeners. The engine can't be reused afterwards.
- `on(event, handler)`: returns an unsubscribe function.

### Events

| Event | When | Payload |
|---|---|---|
| `diff:start` | the engine begins waiting for a diff (after a content or option change) | `{ linesA, linesB }` |
| `diff:done` | a diff result is applied and decorations are visible | `DiffStats` |
| `diff:error` | the computation failed or timed out | `{ message }` |
| `position` | the current change changed, or the total changed | `ChangePosition` |
| `degraded` | entering (info) or leaving (`null`) degraded mode | `DegradedInfo \| null` |
| `content` | a side's text changed for any reason | `{ side, lines, bytes }` |
| `paste` | a paste landed in a pane | `{ side, sample }` (first ≤ 8 KB) |

The UI shows progress between `diff:start` and `diff:done`/`diff:error`. On `paste` the UI runs `registry.detect(sample)` and, when it returns an id, does `ensureLoaded` and then `setLanguage`, and updates the picker.

### DiffStats counting rule

For each line-change hunk, let `a` = lines on the A side and `b` = lines on the B side (0 for a pure insert or delete):
- `a == 0`: `added += b`
- `b == 0`: `removed += a`
- otherwise `modified += min(a, b)`, `added += max(0, b - a)`, `removed += max(0, a - b)`

`changes` = number of hunks. QA's `*.changes.json` uses the same rule.

### Degraded mode

If either side exceeds `LARGE_LINES` (400,000) or `LARGE_BYTES` (40 MB): emit `degraded`, turn off intra-line (character) diffing and anything else that is expensive, and keep working. Never crash. If the diff can't finish, emit `diff:error` within 60 s.

### Performance marks (for the bench)

The engine calls `performance.mark()` with these names:
- `sidediff:text-set:a` / `:b`: at the start of `setText`
- `sidediff:first-render:a` / `:b`: first frame after that side's model is rendered
- `sidediff:diff-start`, `sidediff:diff-done`: at the same moments as the matching events
- `sidediff:diffonly-start`, `sidediff:diffonly-done`: around a `diffOnly` toggle, with done after the next rendered frame

## LanguageRegistry (Languages agent)

- `list()`: bundled packs (`csharp` "C#", `xml` "XML", `plaintext` "Plain Text"), then manifest packs (`installed` is false until cached).
- `get(id)`: info, or undefined.
- `register(pack)`: adds or replaces a pack and fires `onChange`.
- `detect(text)`: the first non-blank character is `<` → `xml`; matches `^\s*(using|namespace)\b` (multiline, so the first non-blank line counts) → `csharp`; otherwise `null`. Only look at the first few KB.
- `ensureLoaded(id)`: activates a bundled pack or a cached remote pack. **Never fetches.** Rejects with a clear message if a remote pack isn't installed.
- `install(id)`: only for ids in `languages/manifest.json`. Fetch the URL from the manifest → size < 2 MB → JSON parse → schema check → SHA-256 equals the manifest value → cache in IndexedDB (key `${id}@${sha256}`) → register. Any failure returns `{ ok: false, error }` and leaves the registry unchanged.
- `onChange(handler)`: fires after register/install.

`createLanguageRegistry({ manifestUrl, fetchFn, indexedDB })` takes injectable dependencies so the unit tests run with a local fixture and `fake-indexeddb`.

### Manifest format (`languages/manifest.json`, copied to `public/` or imported, Languages agent's call)

```json
{
  "version": 1,
  "packs": [
    {
      "id": "sql",
      "displayName": "SQL",
      "format": "tmlanguage-json",
      "license": "MIT",
      "url": "https://cdn.jsdelivr.net/gh/microsoft/vscode@<exact-tag>/extensions/sql/syntaxes/sql.tmLanguage.json",
      "sha256": "<hex>"
    }
  ]
}
```

`format` is either `tmlanguage-json` or `monarch-json`; the Languages agent picks one and records it in DECISIONS.md. The page CSP allows `connect-src` to `https://cdn.jsdelivr.net` only.

### Add-language dialog spec (P2, UI renders, Languages provides logic)

The UI renders a modal (`data-testid="add-language-dialog"`) that lists the `registry.list()` entries where `source === 'remote'`, each showing its name, license and an Install button. The button calls `registry.install(id)`, shows a spinner, then a success message or the returned error. There is no URL field.

## AppSettings and persistence (UI agent)

`SettingsStore` (in `src/persist/`) uses the localStorage key `sidediff:settings:v1`. `load()` merges the stored values over `DEFAULT_SETTINGS`, clamps `contextLines` to 0–20, and falls back to the defaults on corrupt JSON or a storage error. Pane text is never persisted.

## UI contract for tests (UI agent implements, QA consumes)

Required `data-testid` values:

| testid | Element |
|---|---|
| `label-a`, `label-b` | editable label inputs above the panes |
| `pane-a`, `pane-b` | pane header / drop zones |
| `editor` | container the engine mounts into |
| `btn-diff-only` | toggle; `aria-pressed` reflects state |
| `input-context-lines` | number input 0–20 |
| `btn-prev`, `btn-next` | change navigation |
| `change-position` | text "change N of M" (or "no changes") |
| `stats-bar` | contains `stat-added`, `stat-removed`, `stat-modified`, `stat-changes`, `stat-label-a`, `stat-label-b` (numbers as plain digits in `data-value`) |
| `opt-trim-ws`, `opt-ignore-all-ws`, `opt-wrap`, `opt-minimap` | checkboxes |
| `opt-view-mode` | select: `side-by-side` / `inline` |
| `select-language` | select of language ids |
| `btn-theme` | theme toggle; `document.documentElement.dataset.theme` is `dark` or `light` |
| `btn-swap`, `btn-clear-a`, `btn-clear-b`, `btn-copy-a`, `btn-copy-b` | pane actions |
| `file-a`, `file-b` | `<input type=file>` (can be hidden behind a button) |
| `input-font-size` | number input |
| `progress` | `data-state="idle"` or `"computing"` |
| `degraded-warning` | visible only in degraded mode |
| `empty-hint-a`, `empty-hint-b` | empty-state hints |
| `shortcuts-dialog` | cheat sheet opened with `?` |
| `btn-add-language`, `add-language-dialog` | P2 |

### Keyboard shortcuts (UI owns, registered on `document` in the capture phase so Monaco can't swallow them)

| Keys | Action |
|---|---|
| F7 / Alt+Down | next change |
| Shift+F7 / Alt+Up | previous change |
| Alt+H | toggle "diff only" |
| Ctrl+F | find (Monaco built-in, in the focused pane) |
| ? | shortcut cheat sheet (only when focus is not in an editor or input) |
| Esc | close dialogs |

## Ports

`pnpm dev` serves on **5317** (5173 is taken on this machine). Playwright uses 5317 with `reuseExistingServer`. For ad-hoc runs of your own, use `./node_modules/.bin/vite --port <5318–5329>`.
