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
- `nextChange()` / `prevChange()` / `goToChange(i)` (`i` is 1-based, like `ChangePosition.index`; `getPosition()` is `{0, 0}` before the first diff): move both the viewport and the cursor, wrap around, and emit `position`. Works with diff-only on (it reveals the target region).
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

## Project explorer and whole-text undo (feature 2, Phase 4)

Goal (user): load two Acumatica `project.xml` exports, see every item in them (code files, screen mods, tables, SQL, reports, site map, inquiries, …), spot what one side is missing, and open any item as its own focused diff. Everything that can't be categorized still appears, under **Other**. Ctrl+Z must undo pastes, clears, loads and swaps. Types: `src/types.ts` (`ProjectIndexer`, `ProjectIndex`, `ProjectItem`, `ItemViewApi`, `TextHistoryApi`, `ExplorerSettings`).

### Ownership

| Piece | Owner | Where |
|---|---|---|
| Scanner, classifier, matcher, worker, `createProjectIndexer(): ProjectIndexer` | Languages | new `src/project/` (`src/project/index.ts`) |
| `ItemViewApi` + `TextHistoryApi` on the engine (`createDiffEngine()` returns `DiffEngine & ItemViewApi & TextHistoryApi`), Ctrl+Z/Ctrl+Y fall-through | Editor | `src/editor/` |
| Explorer drawer, quick-open, breadcrumb, toasts, shortcuts, settings | UI | `src/app/`, `src/styles/`, `src/persist/` |
| `project` fixture pair, unit/e2e tests, bench lines | QA | `scripts/`, `fixtures/`, `tests/` |
| Wiring in `main.ts`, these contracts, README | Lead | |

The new `AppDeps` fields (`project`, `views`, `history`) are optional until all three land; the Lead then wires them in `main.ts` and folds `ItemViewApi`/`TextHistoryApi` into `DiffEngine`.

### Scanner and classifier (`src/project/`)

- Runs in a Web Worker (no `DOMParser` there): a hand-written linear scanner over the text, not a full XML parser. When the root element is `<Customization …>` the side is a project and each **direct child element** of the root is one item. It records the element name, its start-tag attributes, its 1-based line range, and every `<CDATA name="…"><![CDATA[…]]></CDATA>` inside it (body offsets; adjacent sections split around `]]>`, i.e. `]]]]><![CDATA[>`, are joined back). Comments, processing instructions and text between items are skipped. Unexpected structure never throws: the side gets `error` plus the items found so far.
- Targets: scanning one 150k-line side takes < 500 ms in the worker; main-thread work per `index()` call < 50 ms. A newer call aborts an older one (terminate + respawn, like D11).
- Classification is a **data table** (one entry per element name, easy to extend). Identity = the first attribute present from the element's key list, else the first of `Name, name, ScreenID, ClassName, TableName, ReportName, path, AppRelativePath, Title, Key` found on the element or its first descendants (scan at most 64 KB), else the ordinal among siblings of that element name. Unknown elements go to `other` with `name` = identity and `detail` = element name. Duplicate ids get `#2`, `#3` in document order.

Verified against a real export (2026-10-14, user-supplied, 233 KB / 3,192 lines; **never copy it or its names/code into the repo, which is public**). Real exports: no `<?xml>` header, CRLF line endings, lines up to ~36k characters, attribute values may contain entities (`&quot;`, `&amp;`, `&lt;`, `&gt;`, `&apos;`, `&#…;`): decode them. Many items are self-closing.

| Element | Group | Key | Name / detail / screenId | Views (default first) |
|---|---|---|---|---|
| `Graph` | code | `ClassName` | ClassName; detail from `FileType`: ExistingGraph → "Graph extension", NewGraph → "New graph", ExistingDac → "DAC extension", NewDac → "New DAC", NewFile → "Code file", else FileType | code: CDATA `Source` (csharp, label "C#"); xml |
| `DAC` | code | `type` | last segment of `type` after `.`/`+` (`PX.Objects.PO.POOrder` → POOrder); detail "DAC customization · N fields" | code (label "Fields", csharp): one block per `<Field>`: a line `// FieldName : TypeName (StorageName)` then the field's `TextAttributes` CDATA body, blocks separated by a blank line; xml |
| `Page` | screens | `path` | file name without extension, upper-cased (`~/pages/po/po301000.aspx` → PO301000) = screenId; detail = "Screen customization" when it has child elements, else "Page"; `isModernUIOnlyNode="True"` → "Modern UI page" | code: `pageSource` attribute = **base64 of raw-deflate** of the full page; decode with `DecompressionStream('deflate-raw')` (label "ASPX", language xml; "HTML" for .html). When it has child elements, a second view **changes** = the element's XML (the control delta). xml always. Status: equal base64 → same without decoding |
| `File` | code if path ends `.cs`, else files | `AppRelativePath` | file name; detail = path; screenId from a `Pages\XX\XXnnnnnn.aspx(.cs)` path. Real exports carry **no content** here (files live in the package zip): when there is no CDATA, xml view only and status compares the element | code: CDATA `Content` if present (csharp / xml / plaintext by extension); xml |
| `PerTenantFile` | files | `AppRelativePath` | file name; detail "Modern UI file · path"; screenId from `ScreenId` | xml (reference only) |
| `EditorUpdatedFields` | screens | `ScreenId` | "<ScreenId> editor fields"; detail "Modern UI editor metadata"; screenId | code: the **bare** CDATA directly inside the element (no `<CDATA name>` wrapper), pretty-printed with `JSON.stringify(JSON.parse(x), null, 2)` when it parses (label "JSON", plaintext, or `json` if that pack is installed); xml |
| `Table` | tables | `TableName` | TableName; detail "N columns" (`<Column>` children) | xml |
| `Sql` | sql | `TableName`, `Name` | detail "Table schema" | code: CDATA `TableSchemaXml` (label "Schema", xml); xml |
| `Report`, `ReportDefinition` | reports | `ReportName`, `Name` | | code: its CDATA (xml); xml |
| `SiteMapNode` | sitemap | first `<row>` descendant with `ScreenID` | ScreenID = screenId; detail = that row's `Title` | xml |
| `GenericInquiryScreen`, `GIDesign`, `DashboardMaintenance` | inquiries | first `<row>` descendant with `Name` or `DesignID` | | xml |
| `EntityEndpoint`, `XportScenario`, `ImportScenario`, `WebHook`, `BusinessEvent` | integration | `Name`; id is `EntityEndpoint:<Name>@<Version>` when `Version` is present (one name can exist in several versions), else `EntityEndpoint:<Name>`. Other integration elements: `<Element>:<Name>` | | xml |
| anything else | other | generic list above | `<Element> identity` | xml (its CDATA as code view if any) |

- `views`: `code` comes first when the element has CDATA (one section → its body; several → bodies joined with a `// ---- <name> ----` separator line), then `xml` (the element's own lines, verbatim). No CDATA → `xml` only.
- Status compares the default view's text: identical → `same`; equal after trimming each line → `whitespace`; else `modified`. Moving an element doesn't make it differ (matching is by id, not position).
- `viewText(id, view, side)` is async: it slices the texts from the last `index()` (the indexer keeps references) and decodes `pageSource` / pretty-prints JSON on demand, caching the last few results.
- Line endings: views keep the source's line endings; the diff ignores CR differences the same way as for the full texts.

### Engine additions (`src/editor/`)

- `openView` builds two read-only models (a null side = empty model) and shows them in the diff editor. The full-text models stay alive, and `closeView` restores their view state. `setText`/`replaceText`/`swap` while a view is open update the full models and leave the view open (the UI re-indexes, then re-opens or closes it). Emits `view`.
- `TextHistoryApi`: every whole-text replacement pushes the replaced model onto that side's history instead of disposing it (swap pushes one entry covering both sides). Bounded to 10 entries and 300 MB of text across both sides, oldest dropped first. A Monaco command on Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z in each editor uses Monaco's own undo/redo when the model has entries, else `undoReplace(side)` / `redoReplace(side)`. Typing after an undo clears that side's redo. Emits `history`. The paste fast path records reason `paste`; Clear, Open, drop and Swap go through `replaceText`/`swap` with their reasons (the UI switches its calls from `setText`).

### UI (`src/app/`)

Principle: nothing new on screen until a project is loaded; then one drawer and one breadcrumb, and everything else is keyboard-first.

- **Explorer drawer** to the left of the panes (`data-testid="explorer"`), shown when either side `isProject`. Toolbar toggle `btn-explorer` with a one-line summary ("412 items · 37 changed"), and Ctrl+B. Resizable (drag its edge, 200–600 px); width, open state and filter persist in `AppSettings.explorer`.
  - Header: both projects' `product-version` (and `description` on hover) when they differ, so a version mismatch is visible at once.
  - Filter input `explorer-filter` (fuzzy on name + detail) and chips `filter-all`, `filter-changed` (default: modified + whitespace + only-a + only-b), `filter-only-a`, `filter-only-b`, each with its count.
  - Groups (`explorer-group-<group>`) in table order, collapsible; the header shows name, count and small per-status counts. Empty groups are hidden; **Other** is always last when non-empty.
  - Rows (`explorer-item`, `data-id`, `data-status`): a status glyph with colour **and** shape (`~` modified, `≈` whitespace only, `−` only in A, `+` only in B, `=` same, dimmed), the name, and a dim detail; title attribute = full key/path. The open item is highlighted. Arrow keys move, Enter opens, Home/End jump.
- **Item view**: clicking a row calls `openView`. A breadcrumb bar (`item-bar`) appears above the panes: `← Project` (`btn-back`; also Alt+Left, and Esc when no dialog is open) · group · item name · `Code | XML` switch (`item-view-switch`, only when both exist) · `Show in project` (`btn-show-in-project`, `revealLine` on a side that has it) · **Related** (`item-related`): other items with the same `screenId` (page, its .aspx/.cs files, Modern UI files, site map entry, editor fields) as small links, so one screen's pieces are one click apart · `‹ ›` previous/next item in the current filter (`btn-prev-item`, `btn-next-item`, Alt+PageUp / Alt+PageDown). A missing side shows a centred hint in its pane (`missing-hint-a|b`: "Not in <label>"). Language follows the view kind; stats and change navigation describe the item. Pane headers say "read-only item view".
- **Quick open** Ctrl+P (`quick-open` dialog): fuzzy search over all items regardless of filter, with status glyphs; Enter opens. Works with the drawer closed.
- **Undo toasts**: on `history`, a toast "Undid clear of <label> · Ctrl+Y to redo". Ctrl+Z with focus outside the editors (e.g. right after clicking Clear) calls `undoReplace()`.
- Re-index after content changes, debounced 400 ms; a small spinner in `btn-explorer` while indexing. If the open item vanished, close the view with a toast.
- Cheat sheet and SHORTCUTS.md gain: Ctrl+B, Ctrl+P, Alt+Left / Esc (back), Alt+PageUp/PageDown (prev/next item), Ctrl+Z / Ctrl+Y.

### Acceptance (Lead verifies in the browser)

1. Loading the `project` fixture pair shows the drawer with every group, correct counts and statuses per the sidecar, and an **Other** group with the unknown elements.
2. An item only in A shows `−`; opening it shows A's code and an empty B with "Not in B".
3. Opening a modified Graph shows a C#-highlighted code diff with intra-line changes; diff only, navigation and whitespace options work in the item view; `‹ ›` and Back work; Back restores the project scroll position.
4. Ctrl+P finds an item by partial name and opens it.
5. Clear B, then Ctrl+Z restores B byte-identical; Ctrl+Y clears again. Paste-replace and file load undo likewise; Swap undoes in one step. Typed edits still undo with Monaco's stack.
6. Large pair: indexing never blocks the main thread > 50 ms and finishes < 1.5 s after load; existing bench lines still pass.
7. Non-project text (C# pair, plain text): no drawer, no breadcrumb, nothing else changes.

## Packages, browse mode, assemblies and search (Phase 5)

Goal (user): coworkers can open **one** customization package (`.zip` or `project.xml`) and browse everything in it, without waiting on Acumatica's Customization Project Editor. Drag in `.zip` packages, list every file in them (not only what project.xml references), browse and decompile DLLs (built-in ILSpy engine), and search everything. Compare mode keeps working, now with zips too. Decisions D16–D18. Types: `src/types.ts` (`PackageReader`, `PackageSource`, `ItemSummary`, `PackageOverview`, `SearchHit`, `AssemblyBrowser`, `AsmType`, `AppMode`).

Verified against the user's 35 real packages (local only; **never copy them, their names or code into the repo**): a zip is `project.xml` at the root plus each file at its `AppRelativePath` with `/` separators (`Bin/*.dll`, `Pages/XX/*.aspx(.cs)`, `screens/XX/…/*.ts|html`, `App_Data/SnapshotConfigs/*.esc`, images), all entries deflate (method 8). Elements seen beyond Phase 4: `ScreenWithRights` (269), `GenericInquiryScreen` (126), `Automation`, `WidgetFilterRow`, `Report`, `MobileSiteMap`, `MobileSiteMapWorkspaces`, `XportScenario`, `CSAttribute`, `DashboardV2`, `WikiArticle`, `Images`, `Info`.

### Ownership

| Piece | Owner | Where |
|---|---|---|
| Zip reader, `createPackageReader()`; indexer support for packages (file items, new element kinds, summaries, overview, search) | Languages | new `src/package/`; `src/project/` |
| `createAssemblyBrowser()`: TS metadata reader, IL disassembler, search; ICSharpCode.Decompiler on .NET WebAssembly in a worker; `ItemViewApi.setSingle` | Editor | new `src/assembly/`, new `decompiler/` (.NET project), output committed to `public/decompiler/`; `src/editor/` |
| Start screen, browse/compare mode, drop anywhere, viewers (summary tables, image, binary, assembly browser), overview page, search panel | UI | `src/app/`, `src/styles/`, `src/persist/` |
| Synthetic package fixture (zip + small DLL), tests, bench lines | QA | `scripts/`, `fixtures/`, `tests/` |
| Contracts, `main.ts`, `vite.config.ts`/CSP, README | Lead | |

### Zip reader (`src/package/`)

- No dependency: read the End of Central Directory, walk the central directory, read each local header lazily. Methods 0 (stored) and 8 (deflate → `DecompressionStream('deflate-raw')`). UTF-8 names (flag bit 11) and CP437 fallback. Reject encrypted entries and zip64 with a clear message. Check CRC-32 on read (cheap, catches corrupt downloads).
- Normalise paths to `/`; match `AppRelativePath` case-insensitively with `\` → `/`.
- `kind` by extension: text (`cs aspx ascx ts js html htm css scss xml config json txt esc rpx sql resx md`), image (`png jpg jpeg gif svg ico bmp webp`), assembly (`dll exe` with an MZ header), else binary.
- Performance: opening a 50 MB zip (central directory only) < 200 ms; inflating one 1 MB entry < 50 ms. Runs on the main thread only for the directory; inflation is streaming.

### Indexer with packages (`src/project/`)

- `index(a, b, packages)`: when a side has a package, its `projectXml` is the side's text (the app also puts it in the editor). Zip entries become items:
  - Entries referenced by a `File`/`PerTenantFile` element enrich that item: its `code` view becomes the file content (text) or `image`/`assembly`/`binary`, and status compares content bytes (a reference-only XML side vs a zip side compares the element only).
  - Unreferenced entries become items too, id `Zip:<path>`, group by kind: `assemblies` (dll), `images`, `files` (text and other). They are listed with a dim "not in project.xml" detail. Missing referenced files become overview warnings.
- New element kinds: `ScreenWithRights` → security (key: ScreenID from its row data), `GenericInquiryScreen`/`DashboardV2`/`WidgetFilterRow` → inquiries, `Automation` → screens (key: ScreenID), `Report` → reports, `MobileSiteMap`/`MobileSiteMapWorkspaces` → sitemap, `XportScenario` → integration, `CSAttribute` → tables (user-defined fields; key AttributeID), `WikiArticle` → other with a proper name, `Images`/`Info` → other. Keep the data table; unknown still → other.
- **Summary views** (`viewSummary`, view id `summary`, listed first when available), built from data already parsed (no network, no guessing beyond the XML/ASPX):
  - DAC customization: Field / Type / Storage / DisplayName / attributes (one row per field).
  - New DAC / DAC extension Graph (C#): properties with their `[PX…]` attributes, best-effort regex over the CDATA (field name, type, DisplayName, DB attribute); say "best effort" in a fact row.
  - Table / Sql schema: Column / Type / Nullable / Length / Default, plus indexes for Sql.
  - Page (ASPX or Modern UI HTML): Screen id, title (from the site map item when present), PXDataSource TypeName + PrimaryView, then one section per container (PXFormView/PXGrid/PXTab… or `qp-*` fieldsets) with DataMember and the DataFields in order.
  - GenericInquiryScreen: design name, tables (with aliases), relations, parameters, result columns, conditions, from the data-set rows.
  - ScreenWithRights: role / rights rows.
  - SiteMapNode / MobileSiteMap: screen, title, URL, workspace, category.
  - Anything else with attributes: a single facts list.
- **Overview** (`overview(side)`): name, kind, size, root attributes, counts per group, screens (screenId + title, from site map / pages), assemblies, warnings.
- **Search** (`search(query)`): runs in the indexer worker over every text view (decoded pages, pretty JSON, CDATA, element XML, package text files), literal by default, optional case/regex, capped at `limit`. < 300 ms for the large pair. Assemblies are searched by the assembly browser; the UI merges both.

### Assembly browser (`src/assembly/`, `decompiler/`)

- **Metadata reader in TypeScript, in a worker:** PE/COFF → CLI header → metadata root → streams (#~, #Strings, #US, #Blob, #GUID); tables TypeDef, TypeRef, TypeSpec, MethodDef, Field, Property(Map), Event(Map), Param, InterfaceImpl, CustomAttribute, MemberRef, NestedClass, Assembly, AssemblyRef, GenericParam. Decode signatures to C#-like strings, custom attribute type names (and string args for `PXUIField(DisplayName=…)`, `PXCacheName`). Acumatica roles by base-type name chain (no Acumatica assemblies needed). Load a 2 MB DLL < 300 ms.
- **IL disassembler (TS):** method body header, opcode table, tokens resolved to names. Fallback when the decompiler isn't available.
- **Decompiler:** `decompiler/` is a small .NET 8 `Microsoft.NET.Sdk.WebAssembly` project referencing `ICSharpCode.Decompiler` (MIT; record the version and license in DECISIONS/README). It exposes `[JSExport]` `DecompileType(byte[] assembly, string typeName)` and `DecompileModule(byte[])`, and runs **in a dedicated worker**, never on the main thread. References that aren't available (PX.*) are fine: the decompiler emits fully qualified names. `pnpm build:decompiler` publishes it (Release, trimmed, no AOT) into `public/decompiler/`, which is **committed**, so `pnpm build` needs only Node. It's loaded only the first time the user decompiles. Measure and record: bundle size, cold load, decompiling a 500-line type. CSP: `'wasm-unsafe-eval'` is already set; anything else the .NET runtime needs goes to the Lead for `index.html`.
- `ItemViewApi.setSingle(true)`: browse mode shows only side A in a plain editor (full text or item view), keeping find, folding, wrap, font size and theme.

### UI (`src/app/`)

- **Start screen** when both sides are empty: two cards, **Browse a package** (one drop zone: "Drop a customization .zip or project.xml") and **Compare two packages** (A / B drop zones), plus "Files are read in your browser; nothing is uploaded." Dropping anywhere on the window works too. Mode switch in the toolbar (`btn-mode`: Browse | Compare), persisted in `AppSettings.mode`. Open/drop goes through `packages.open()` when present.
- **Browse mode:** one side (A). The explorer shows groups and items without status glyphs or the Changed filter (chips become hidden, the filter defaults to All). The item view shows a single editor (`setSingle`) or a rendered view. The stats bar shows package facts instead of diff stats. Swap/B controls hidden. Switching to Compare keeps A loaded and asks for B.
- **Overview** as the first explorer entry (`explorer-overview`) and the default view after loading: facts, counts per group (clickable to filter), screens list (click → its page item), assemblies (click → browser), warnings. In compare mode: A and B columns with differences highlighted.
- **Rendered views:** `summary` → tables from `ItemSummary` (compare: two columns, rows diffed by keyColumn; added/removed/changed rows marked by colour **and** a glyph). `image` → preview with size/dimensions (compare: side by side). `binary` → size, SHA-256, first 4 KB hex. `assembly` → assembly browser: namespace → type tree (Acumatica roles badged: Graph, Graph ext of X, DAC, DAC ext of X), type detail (base, interfaces, attributes, members with signatures), search box (types, members, strings), **Decompile** (C# into the editor, read-only; first use shows "Loading decompiler…") and IL per method. Compare mode for assemblies: a text outline diff (one line per type/member signature) plus decompiled diff per type on demand.
- **Search everywhere** `Ctrl+Shift+F` (`search-panel`): one box, toggles for case/regex, results grouped by item (with group and side), each hit opens the item at that line. Includes assembly hits for assemblies already loaded, and "Search in assemblies" to load and search all DLLs in the package.
- Downloads: every file item has **Download** (`btn-download`) saving its original bytes (no network).
- Keyboard: `Ctrl+Shift+F` search, `Ctrl+O` open, existing keys unchanged. Cheat sheet and SHORTCUTS.md updated.

### Acceptance (Lead verifies in the browser)

1. From a cold start, the start screen offers Browse and Compare; dropping the fixture package zip in Browse opens the overview with correct counts, screens, assemblies and warnings.
2. Browse: every project.xml item and every zip file is listed (unreferenced files marked); File items show the zip content; images preview; an `.esc` opens as text.
3. Summaries render for a DAC customization, a Table/Sql, a Page (screen outline with containers and fields), a GI, ScreenWithRights and a site map node.
4. The assembly browser lists namespaces/types/members, badges Acumatica roles correctly, searches strings, shows IL, and decompiles a type to C# from the committed bundle without any network request.
5. Search everywhere finds a string inside decoded ASPX, a CDATA C# body, a zip text file and a DLL string literal; clicking opens the right item at the right line.
6. Compare mode with two zips: file content diffs, assembly outline diff, summary row diffs.
7. A bare project.xml still works in both modes; the C#/plain-text diff workflow is unchanged; all Phase 1–4 gates still pass.
8. No network requests other than the optional language packs, even while decompiling.

## Ports

`pnpm dev` serves on **5317** (5173 is taken on this machine). Playwright uses 5317 with `reuseExistingServer`. For ad-hoc runs of your own, use `./node_modules/.bin/vite --port <5318–5329>`.
