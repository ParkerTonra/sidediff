# SideDiff

SideDiff is a local, no-backend web app for comparing two very large text blobs side by side. It is built for exported Acumatica customization projects: a single `project.xml` of tens of MB (up to about 150,000 lines per side) whose elements carry C# source in CDATA, very long attribute lines and base64 payloads. Paste or load version A and version B, label them, and see only what changed.

Everything runs in the browser. There is no server, no account, no telemetry. The only network request the app can ever make is the optional download of a syntax-highlighting language pack (see [Adding a language pack](#adding-a-language-pack)).

## Features

- Side-by-side diff (or inline) with line-level and intra-line character highlighting, synchronized scrolling, line numbers and an overview ruler.
- **Diff only**: collapses unchanged regions to N context lines (0 to 20, default 3). Click a "... 1,240 unchanged lines" separator to expand it in place. It never changes the text; toggling it off restores the full view.
- Next/previous change with "change N of M".
- Stats bar: added, removed, modified, total changes, with both pane labels.
- Options: ignore leading/trailing whitespace (default on), ignore all whitespace, word wrap, minimap, font size.
- Languages: C#, XML, Plain Text, auto-detected on paste (XML if the first non-blank character is `<`, C# if the text starts with `using` or `namespace`). Override with the picker.
- Dark theme by default, light theme toggle. Settings (labels, language, theme, options, context lines, font size) persist in `localStorage`. Pane text is not persisted.
- Swap A/B, clear, copy, load a file (picker or drag-and-drop; read locally as text).
- Degrades gracefully above 400,000 lines or 40 MB per side: warns, turns off intra-line highlighting and keeps going.

## Setup (Windows)

Requirements: Node.js 22 or newer and pnpm 12 (`packageManager` is pinned in `package.json`).

pnpm comes through corepack. On Windows, `corepack enable` fails with a permission error when Node is installed in `C:\Program Files\nodejs`. Put the shim in a folder you own that is already on `PATH` instead (decision D1):

```powershell
corepack enable --install-directory "$env:APPDATA\npm"
```

Then:

```powershell
pnpm install
pnpm dev        # http://localhost:5317 (port 5173 is avoided; the port is strict)
```

Other commands:

| Command | What it does |
|---|---|
| `pnpm build` | Type-checks, then writes the production site to `dist/` |
| `pnpm preview` | Serves `dist/` with Vite's preview server |
| `pnpm check` | `tsc` + ESLint + Vitest |
| `pnpm e2e` | Playwright end-to-end tests against `pnpm dev` |
| `pnpm fixtures` | Generates the seeded Acumatica-shaped test pairs into `fixtures/` |
| `pnpm bench` | Runs the performance gate in headless Chromium and prints pass/fail |

### Serving `dist/`

`dist/` is plain static files with relative asset paths (`base: './'`), so any static server works:

```powershell
pnpm build
npx serve dist        # or: python -m http.server -d dist 8080
```

It also works from a sub-folder of a web server. Monaco's worker is loaded from `dist/assets` as a same-origin file; browsers do not support module workers from `file://`, so open it through a server rather than double-clicking `index.html`.

## Usage

1. Paste into pane A and pane B, or drop a file onto a pane, or use the file button. Language is detected on paste.
2. Edit the labels above the panes (for example "prod 24.200" and "dev"). They show in the stats bar too.
3. Read the stats bar, then press **Diff only** (`Alt+H`) to hide everything that did not change. Adjust context lines in the toolbar.
4. Step through changes with `F7` / `Shift+F7` (or `Alt+Down` / `Alt+Up`).
5. Toggle whitespace options, wrap, inline view, theme and font size as needed.

Shortcuts are listed in [SHORTCUTS.md](SHORTCUTS.md) and in the app under `?`.

## Adding a language pack

> To be completed from the Languages session's documentation (format, schema, manifest tooling). The contract so far:

Bundled languages (`csharp`, `xml`, `plaintext`) need no network. Other languages are *data-only* packs listed in `languages/manifest.json`; the app never downloads or runs JavaScript. To add one:

1. Choose a pinned tag of a public, MIT-licensed repository and an exact file URL, preferably `https://cdn.jsdelivr.net/gh/microsoft/vscode@<exact-tag>/extensions/<lang>/syntaxes/<lang>.tmLanguage.json`.
2. Download the file and compute its SHA-256 (`certutil -hashfile file.json SHA256` on Windows).
3. Add an entry to `languages/manifest.json`:

   ```json
   {
     "id": "sql",
     "displayName": "SQL",
     "format": "tmlanguage-json",
     "license": "MIT",
     "url": "https://cdn.jsdelivr.net/gh/microsoft/vscode@<exact-tag>/extensions/sql/syntaxes/sql.tmLanguage.json",
     "sha256": "<hex>"
   }
   ```

   `format` is `tmlanguage-json` or `monarch-json` (TODO: final choice per DECISIONS.md).
4. Rebuild. The pack appears in the **Add language** dialog. Installing validates it (under 2 MB, valid JSON, matches the schema, SHA-256 equals the manifest) and caches it in IndexedDB keyed by `id@sha256`, so it works offline afterwards. A failed check shows a message and changes nothing.

There is no URL field: only manifest entries can be fetched, and the page CSP allows `connect-src` to `https://cdn.jsdelivr.net` only.

## Engine decision

SideDiff uses Monaco Editor's `DiffEditor` (`monaco-editor` 0.57, pinned). It computes the diff in a web worker, has a built-in `hideUnchangedRegions` (the "diff only" feature), intra-line highlighting, side-by-side and inline modes, change navigation and `vs`/`vs-dark` themes, and ships Monarch tokenizers for C# and XML. Only the editor API plus the C# and XML registrations are imported (never the `monaco-editor` barrel), which keeps the bundle to those two language chunks.

The fallback, if Monaco had missed the performance gate, was CodeMirror 6 with `@codemirror/merge`. Outcome: _TBD from `pnpm bench`_.

## Performance gate

Measured by `pnpm bench` in headless Chromium on the 150k-line `large` pair. Results: _placeholders until the bench reports._

| Check | Limit | Measured |
|---|---|---|
| One 150k-line side to first render | < 2 s | _TBD_ |
| Diff ready, both sides | target < 5 s, hard < 10 s | _TBD_ |
| Longest main-thread block during diff | <= 200 ms | _TBD_ |
| Toggle "diff only" | < 1 s | _TBD_ |
| Worst frame in a 5 s scripted scroll | <= 100 ms | _TBD_ |
| Tab memory after diff | < 2 GB | _TBD_ |
| `stress` pair (500k lines) | no crash, warning shown, finishes or reports within 60 s | _TBD_ |
| Initial JS, gzipped | < 3 MB (warning only) | _TBD_ |

## Privacy

No telemetry, no analytics, no upload. Files you load are read locally with the File API. Pane contents are never written to `localStorage`.
