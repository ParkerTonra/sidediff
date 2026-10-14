/goal Build "SideDiff": a local, no-backend web app for comparing two huge text blobs (Acumatica customization XML and C#, up to 150,000 lines per side) with a side-by-side diff, a "diff only" collapse view, dark mode by default, and a pluggable syntax-highlighting language registry. Work as a team of 6 agents in parallel. Done means every item in section 9 passes and the Lead has personally verified it in a browser.

# 1. Context (why this exists)

The user compares exported Acumatica customization projects: one giant `project.xml` (tens of MB) whose elements contain C# source inside CDATA, long attribute lines, deep nesting, and base64 blobs. Existing diff tools choke on paste sizes like this or hide changes in a wall of unchanged text. The user pastes two versions (A and B), tags each with a label, and needs to see only what changed, fast.

# 2. Locked decisions (do not re-debate; record any forced deviation in docs/DECISIONS.md)

- Static single-page web app. TypeScript strict, Vite, pnpm. No backend, no auth, no telemetry, no network at runtime except the optional language-pack download in section 6.
- Editor and diff engine: Monaco Editor's DiffEditor (`monaco-editor`, latest stable, pinned). Reasons: diff computed in a web worker, built-in `hideUnchangedRegions` (this is the "diff only" button), intra-line change highlighting, side-by-side and inline modes, next/previous change navigation, `vs-dark` theme, and bundled Monarch tokenizers for `csharp` and `xml`.
- Bundle only the Monaco features and the two languages we need. Import from `monaco-editor/esm/vs/editor/editor.api` plus the `csharp` and `xml` basic-language contributions only. Never import the full `monaco-editor` barrel. Configure the editor worker correctly for Vite.
- Performance gate (section 8) is the one thing that can override the Monaco decision. If, after honest tuning, Monaco fails the gate, the Lead switches the engine to CodeMirror 6 + `@codemirror/merge` and records why. Do not start on CM6 speculatively.
- Dark theme is the default on first load. Light theme is a toggle, persisted.
- "Diff only" never mutates or deletes text. It collapses unchanged regions visually. Toggling it off restores the full view with no data loss.
- UI framework: plain TypeScript + DOM, or Preact if the UI agent judges component state worth it. No React, no CSS framework. One small CSS file with custom properties for theming.
- Git repo initialised at start. Conventional commits. Lockfile committed. No `any` casts to dodge the type checker.

# 3. Features (P0 ship, P1 ship if nothing P0 is at risk, P2 stretch)

P0
- Two panes, A (left) and B (right). Each has an editable label (defaults "A" and "B") shown above the pane and in the stats bar.
- Paste into either pane. Paste of a 10 MB string renders without freezing the tab (see gate).
- Side-by-side diff with line-level and intra-line character highlighting, synchronized scrolling, line numbers, overview ruler.
- "Diff only" toggle button: collapses unchanged regions with N context lines (default 3, adjustable 0 to 20) and clickable "... 1,240 unchanged lines" separators that expand in place. Keyboard shortcut.
- Next change / previous change buttons and shortcuts (F7 / Shift+F7 and Alt+Down / Alt+Up). Current position "change 12 of 87".
- Stats bar: lines added, removed, modified, total changes, and both labels.
- Options: ignore leading/trailing whitespace (default on), ignore all whitespace, word wrap, side-by-side vs inline view.
- Language selector (applies to both panes): C# and XML, plus Plain Text. Auto-detect on paste: text whose first non-blank character is `<` is XML, text matching `^\s*(using|namespace)\b` is C#, otherwise unchanged. The user can override.
- Dark mode default, light mode toggle.
- Swap A and B. Clear a pane. Copy a pane. Load a file into a pane via file picker and drag-and-drop (reads as text, no upload).
- Progress indicator while a diff is computing, with the UI still responsive.
- Settings persisted in localStorage: labels, language, theme, options, context lines, font size. Pane contents are not persisted (too large).

P1
- Find in pane (Monaco Ctrl+F), bracket matching, folding, font size adjust, minimap toggle.
- Graceful degradation above the gate size: if a side exceeds 400,000 lines or 40 MB, warn, disable intra-line highlighting, and continue rather than crash.
- Empty-state hint text in each pane and a keyboard shortcut cheat sheet (press `?`).

P2
- "Add language" dialog that installs one remote language pack under the rules in section 6, proven with at least one language (SQL or JSON).
- Single-file build (`index.html` with everything inlined) in addition to the normal `dist/`.

# 4. Team and ownership

Spawn these six agents after the Lead finishes Phase 0. Each agent owns the directories listed; it does not edit another agent's directory. Cross-cutting needs go into `docs/STATUS.md` under "Requests" and the owning agent or the Lead resolves them. All agents read `docs/INTERFACES.md` before writing code.

1. Lead / Integrator (this is you, the orchestrator). Owns: repo root config, `src/main.ts`, `src/types.ts`, `docs/`. Does Phase 0 alone, then integrates, resolves requests, runs the final gate, writes README.
2. Editor and Diff Core. Owns `src/editor/`. Wraps Monaco DiffEditor: worker setup, model management for huge strings, options (whitespace, wrap, side-by-side/inline), `hideUnchangedRegions` wiring, change navigation, stats derived from the diff result, progress events, the degradation mode. Exposes the `DiffEngine` interface from `docs/INTERFACES.md`. Also runs the performance gate locally and tunes (`maxComputationTimeMs: 0`, large-file settings, lazy tokenization).
3. UI / UX. Owns `src/app/`, `src/styles/`, `src/persist/`. Layout, toolbar, labels, stats bar, theme switch, shortcuts, file loading and drag-drop, paste handling, progress UI, empty states, settings persistence. Consumes `DiffEngine` and `LanguageRegistry`; never touches Monaco directly.
4. Languages. Owns `src/languages/`. The `LanguageRegistry` interface, bundled C# and XML, Plain Text, auto-detect, the language picker data, and the remote pack design in section 6 (manifest, allowlist, validator, IndexedDB cache, loader). P2: the Add-language dialog logic (UI agent renders it from a spec in INTERFACES.md).
5. QA / Performance. Owns `scripts/`, `fixtures/`, `tests/`. Fixture generator (section 7), benchmark script, Playwright end-to-end tests against `pnpm dev`, unit tests with Vitest, perf gate runner that prints pass/fail against section 8. Files bugs in `docs/STATUS.md` with repro steps; does not fix other agents' code.
6. Reviewer / Docs. Owns `docs/REVIEW.md`, `README.md` drafts, `docs/SHORTCUTS.md`. Reviews every agent's work against sections 3, 8, and 9 as it lands, checks accessibility basics (focus order, contrast in both themes, labels on controls), confirms no runtime network calls other than the language download, confirms Monaco bundle contains only csharp and xml. Reports findings as checklist items in STATUS.md; the owning agent fixes them.

If only 5 agents are available, fold Reviewer / Docs into the Lead.

# 5. Phases

Phase 0 (Lead alone, keep it short): `git init`, pnpm + Vite + TS strict scaffold, ESLint, Vitest, Playwright, Monaco with worker config proven by rendering a trivial DiffEditor in dark mode, `pnpm check` script (tsc + eslint + vitest), `pnpm e2e`, `pnpm bench`. Write `docs/INTERFACES.md` with the `DiffEngine`, `LanguageRegistry`, `AppSettings`, and `DiffStats` TypeScript interfaces and the event names between layers. Write `docs/STATUS.md` with one section per agent. Commit. Only then spawn the team.

Phase 1 (all six in parallel): build against the interfaces. QA produces fixtures first (other agents need them within minutes), then the bench and e2e scaffolding. Each agent commits to its own directories, keeps `pnpm check` green, and updates its STATUS.md section when done or blocked.

Phase 2 (Lead + QA + Reviewer): integrate, run `pnpm bench` on the 150k fixture pair, run e2e, triage findings to owners, iterate until section 9 passes.

Phase 3 (Lead): final `pnpm build`, serve `dist/` with a static server, verify in a real browser by pasting the two 150k fixtures, toggling "diff only", navigating changes, switching theme and language, reloading to confirm settings persisted. Write README. Final commit.

# 6. Language registry and remote packs (safety rules)

- `LanguageRegistry` has `list()`, `get(id)`, `register(pack)`, `detect(text)`, `ensureLoaded(id)`. Bundled packs: `csharp`, `xml`, `plaintext`, loaded with zero network.
- A pack is data plus a Monaco registration step. Remote packs are data only. The app never fetches and executes JavaScript. Acceptable remote formats: TextMate `.tmLanguage.json` grammars (tokenized through `vscode-textmate` + `vscode-oniguruma` wasm shipped with the app), or Monarch definitions expressed as pure JSON with regex strings. The Languages agent picks one, documents it in DECISIONS.md, and keeps the bundled C# and XML on Monaco's native Monarch tokenizers regardless.
- Allowlist: a single `languages/manifest.json` naming each remote pack's id, display name, license, source URL, and SHA-256. Source URLs point at a pinned tag of a public MIT-licensed repository (prefer `microsoft/vscode` `extensions/*/syntaxes/*.tmLanguage.json` through jsDelivr's `gh` CDN at an exact tag). Nothing outside the manifest can be fetched. No user-entered URLs.
- Validation before registration: content length under 2 MB, parses as JSON, matches the expected schema for its format, hash matches the manifest. Failures show a message and leave the registry unchanged.
- Cache validated packs in IndexedDB keyed by id + hash. Offline after first install.
- Leaving room for more is the P0 part: the registry, manifest format, validator, and loader exist and are unit tested with a local fixture even if the P2 dialog is not shipped.

# 7. Fixtures (QA agent, first task)

`scripts/gen-fixtures.ts` produces deterministic (seeded) Acumatica-shaped project XML pairs into `fixtures/`:
- `<Customization level="100" description="..." product-version="24.200.0000">` root with hundreds of `<Graph>`, `<Page>`, `<Table>`, `<File>` children. `<File>` and `<Graph>` entries contain realistic C# in CDATA (graph extensions, DAC extensions, attributes, LINQ) of 50 to 400 lines each. Some elements carry 500+ character attribute lines and base64-looking payloads.
- Sizes: `small` (2k lines), `medium` (30k lines), `large` (150k lines, roughly 8 to 12 MB), `stress` (500k lines).
- The B side of each pair applies about 2 percent scattered edits of every kind: attribute value changes, single-token C# changes inside CDATA, whitespace-only changes, a 300-line block insertion, a 300-line block deletion, a moved element, a reordered attribute list. A sidecar `*.changes.json` lists the expected change count so tests can assert stats within a tolerance.
- Also produce a pure C# pair (`csharp-large`, 150k lines) to test tokenization of C# at scale.

# 8. Performance gate (measured by `pnpm bench` in headless Chromium on the `large` pair, reported as pass/fail)

- Paste or load of one 150k-line side to first render: under 2 s.
- Diff ready (both sides loaded to highlights visible): target under 5 s, hard limit 10 s.
- Main thread never blocked more than 200 ms during diff computation (measure with long-task observer); the progress indicator animates.
- Toggling "diff only" on or off: under 1 s.
- Scrolling through the diff: no frame over 100 ms in a scripted 5-second scroll.
- Tab memory after diff: under 2 GB.
- `stress` pair: no crash, degradation warning shown, diff completes or reports it could not within 60 s.
- Bundle: initial JS under 3 MB gzipped is a warning, not a failure; the Reviewer confirms only csharp and xml language modules are present.

# 9. Acceptance checklist (Lead verifies every line in a real browser before declaring done)

- [ ] `pnpm install && pnpm dev` works on Windows from a clean clone; `pnpm build` produces `dist/` that works from any static server with no console errors.
- [ ] App opens in dark mode on first load; light mode toggle works and persists across reload.
- [ ] Pane labels editable, shown above panes and in stats bar, persisted.
- [ ] Paste 150k-line fixture into A and B: diff renders, stats bar shows counts within tolerance of `*.changes.json`.
- [ ] "Diff only" collapses unchanged regions with context lines, separators expand on click, toggling off restores everything, text content is byte-identical before and after (test asserts this).
- [ ] Next/previous change buttons and shortcuts move the viewport and update "change N of M".
- [ ] Whitespace options change the result (whitespace-only edits disappear with trim-whitespace on).
- [ ] Side-by-side and inline views both work.
- [ ] Language selector offers C#, XML, Plain Text; auto-detect picks XML for the fixture and C# for the C# fixture; highlighting is visibly correct in both themes.
- [ ] Swap, clear, copy, file picker, drag-and-drop all work.
- [ ] Find (Ctrl+F), folding, word wrap, font size work.
- [ ] Language registry unit tests pass, including rejection of an oversized, malformed, and hash-mismatched pack.
- [ ] No runtime network requests other than the optional language-pack download (Reviewer confirms with the network panel).
- [ ] `pnpm check`, `pnpm e2e`, `pnpm bench` all pass; README documents setup, shortcuts, how to add a language pack, and the engine decision.

# 10. Working rules for every agent

- Read `docs/INTERFACES.md` and your STATUS.md section before coding. If an interface needs to change, propose the change in STATUS.md and let the Lead apply it; do not fork it locally.
- Stay in your directories. Do not reformat files you don't own.
- Keep `pnpm check` green on every commit. Add tests with the code, not after.
- Verify in a real browser (Playwright is available to you), not just by reading your own code. Screenshots of the large fixture diff in both themes go in `docs/screenshots/`.
- Do not add features outside section 3. If you see something valuable, add it to STATUS.md under "Ideas" and move on.
- When blocked for more than a few minutes, write the blocker in STATUS.md and pick up your next item; do not idle and do not work around it by touching someone else's code.
- Report completion honestly: list what passed, what you measured, and anything you skipped or could not verify.
