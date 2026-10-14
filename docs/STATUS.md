# Status

Each agent keeps its own section current: **Doing**, **Done** (with what was measured or verified), **Blocked**. Cross-cutting needs go under **Requests**, bugs under **Bugs**, out-of-scope ideas under **Ideas**. Append; don't rewrite other agents' entries. Mark resolved items `[x]`.

## Lead / Integrator
- Done: Phase 0. Scaffold (Vite 8, TS 6.0 strict, ESLint 10, Vitest 5, Playwright 1.64), Monaco 0.57 DiffEditor rendered in vs-dark with its worker loaded (verified in a browser, no console errors), interfaces in `src/types.ts` + `docs/INTERFACES.md`, factory stubs in each module.
- Doing: waiting for Phase 1; integration.

## Editor and Diff Core (`src/editor/`)
- Todo: DiffEngine per INTERFACES.md, worker, huge-string models, options, hideUnchangedRegions, navigation, stats, events, perf marks, degraded mode, local perf tuning against `fixtures/large-*`.

## UI / UX (`src/app/`, `src/styles/`, `src/persist/`)
- Done (7f75dcc, harness-verified; real engine not yet available): `createApp` in plain TS + DOM (`src/app/index.ts`, `dom.ts`), one CSS file `src/styles/app.css` (custom properties, dark default, light via `[data-theme=light]`), `SettingsStore` in `src/persist/settings.ts` + 10 Vitest tests (defaults, merge, clamp, wrong types, corrupt JSON, blocked/full storage, no pane text). Every testid in INTERFACES.md exists exactly once, plus P2 `btn-add-language` / `add-language-dialog` (Install buttons are `btn-install-<id>`).
- Notes for QA: `#app` gets `data-ready="true"` once the engine is mounted and settings applied (`"error"` if startup failed). `progress` is always visible: idle shows "Ready", computing shows a spinner + "Computing diff… N vs M lines" (`data-state` per contract). `change-position` text is `no changes` or `change N of M` (N is 0 before the first navigation), also in `data-index`/`data-total`. Extra testid `diff-error` = the `diff:error` banner. Pane line/byte counts show in each pane header.
- Dev harness: `/src/app/harness.html` on any dev server mounts the app on fakes (`src/app/dev/fakes.ts`). A Playwright script over it passed 40 checks: testids, dark default, shortcuts from inside an editor textarea (F7, Shift+F7, Alt+Up/Down, Alt+H; `?` ignored while typing, Esc closes), labels + swap, clamps, theme toggle, persistence across reload (theme, labels, options, language; no pane text in storage), startup call order mount→setTheme→setLanguage→setOptions, file picker + detect, copy, clear, drop onto a pane header, diff:error banner, degraded banner, spinner animation running while the main thread is blocked 1.5 s, add-language install success/error.
- Doing: verify through `/` against the real engine + registry once `createDiffEngine` stops throwing; screenshots of the large fixture in both themes.

## Languages (`src/languages/`, `languages/`)
- Todo: registry, bundled csharp/xml/plaintext, detect, manifest + validator + IndexedDB cache + loader, unit tests (oversized, malformed, hash mismatch), format decision in DECISIONS.md, P2 install with a real pinned pack.

## QA / Performance (`scripts/`, `fixtures/`, `tests/`)
- **FIXTURES READY** (cf4a725). Run `pnpm fixtures` (≈5 s; `--only large` for one, `--no-verify` to skip the Monaco check). Files are gitignored, only `fixtures/*.changes.json` is committed.
  - `small` 2,265 lines / 0.11 MB · `medium` 30,007 / 1.7 MB · `large` 150,115 / 8.7 MB · `stress` 500,295 / 28.7 MB (degraded by lines) · `csharp-large` 150,235 / 7.3 MB (`.cs`).
  - `expected.trimWhitespace` / `expected.noTrimWhitespace` in each sidecar come from Monaco 0.57's own `DefaultLinesDiffComputer` run in Node (maxComputationTimeMs 0) and equal the stats derived from the edit list exactly. Large, trim on: added 311, removed 311, modified 1474, changes 1478; trim off: modified 2037, changes 2041. Tolerance: `|actual − expected| ≤ 2% + 3`.
  - Edits on B: ~1.5% scattered single-line edits (attribute value, single C# token, leading/trailing whitespace, attribute/named-arg reorder), each ≥12 unchanged lines apart so hunks never merge, plus one 300-line insert, one 300-line delete (both inside CDATA/class bodies), one moved `<Table>`/`<Page>` element (C#: a moved member). `small` uses 100-line blocks.
- Doing: `pnpm bench`, then e2e for section 9, unit tests.

## Reviewer / Docs (`docs/REVIEW.md`, `README.md` drafts, `docs/SHORTCUTS.md`)
- Done (pass 1): `docs/SHORTCUTS.md`, `docs/README.draft.md` (language-pack details and bench numbers are placeholders), `docs/REVIEW.md`. Ran: dev server + Playwright (stub app shows the startup error, no cross-origin requests). Read only: persist/dom helpers, CSP, ESLint config. Not reviewable yet: engine, registry, app shell, CSS contrast, bundle audit (nothing imports Monaco yet), bench.
- Todo: next pass when the Lead pings.

## Requests

## Bugs
- [ ] (Reviewer → QA) `tests/e2e/smoke.spec.ts` passes against a dead app: it only listens for `pageerror`; assert no "failed to start" text and fail on `console.error`. See REVIEW.md.
- [ ] (Reviewer → Editor) `ignoreAllWhitespace` has no native Monaco option; choose an approach that leaves `getText()` unchanged and record it in DECISIONS.md. See REVIEW.md.
- [ ] (Reviewer → Editor) `diff:start` must also fire on option changes that recompute the diff.
- [x] (Reviewer → UI) `Alt+H`/`F7`/`Alt+Up/Down` must not be gated by `isTextTarget` (`src/app/dom.ts:31`), and must stop Monaco's move-line on `Alt+Up/Down`. — UI: only `?` is gated; the others are handled in the capture phase with preventDefault + stopPropagation (harness-verified from inside a textarea; re-check with Monaco).
- [x] (Reviewer → UI) Persisted `language` may name an unavailable pack; catch `ensureLoaded` rejection at startup and fall back to `plaintext` (`src/persist/settings.ts:77`). — UI: done in `startApp` (falls back to plaintext and re-saves).
- [ ] (Reviewer → Languages) Check size before `JSON.parse`, hash raw bytes, jsDelivr-only host; document pack format for the README.
- [ ] (Reviewer → Lead) CSP `script-src 'self'` (`index.html:5`) breaks the P2 single-file build; INTERFACES.md omits `getPosition/isComputing/focus/layout/dispose` semantics.

## Ideas
