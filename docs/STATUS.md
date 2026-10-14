# Status

Each agent keeps its own section current: **Doing**, **Done** (with what was measured or verified), **Blocked**. Cross-cutting needs go under **Requests**, bugs under **Bugs**, out-of-scope ideas under **Ideas**. Append; don't rewrite other agents' entries. Mark resolved items `[x]`.

## Lead / Integrator
- Done: Phase 0. Scaffold (Vite 8, TS 6.0 strict, ESLint 10, Vitest 5, Playwright 1.64), Monaco 0.57 DiffEditor rendered in vs-dark with its worker loaded (verified in a browser, no console errors), interfaces in `src/types.ts` + `docs/INTERFACES.md`, factory stubs in each module.
- Doing: waiting for Phase 1; integration.

## Editor and Diff Core (`src/editor/`)
- Todo: DiffEngine per INTERFACES.md, worker, huge-string models, options, hideUnchangedRegions, navigation, stats, events, perf marks, degraded mode, local perf tuning against `fixtures/large-*`.

## UI / UX (`src/app/`, `src/styles/`, `src/persist/`)
- Todo: layout, toolbar, labels, stats bar, theme, shortcuts, file load + drag-drop, paste → detect, progress, empty states, settings store, cheat sheet, P2 dialog shell. All testids from INTERFACES.md.

## Languages (`src/languages/`, `languages/`)
- Todo: registry, bundled csharp/xml/plaintext, detect, manifest + validator + IndexedDB cache + loader, unit tests (oversized, malformed, hash mismatch), format decision in DECISIONS.md, P2 install with a real pinned pack.

## QA / Performance (`scripts/`, `fixtures/`, `tests/`)
- Todo (first): `scripts/gen-fixtures.ts` → small/medium/large/stress/csharp-large pairs + `*.changes.json`. Then `pnpm bench` (perf gate, section 8), e2e for section 9, unit tests.

## Reviewer / Docs (`docs/REVIEW.md`, `README.md` drafts, `docs/SHORTCUTS.md`)
- Done (pass 1): `docs/SHORTCUTS.md`, `docs/README.draft.md` (language-pack details and bench numbers are placeholders), `docs/REVIEW.md`. Ran: dev server + Playwright (stub app shows the startup error, no cross-origin requests). Read only: persist/dom helpers, CSP, ESLint config. Not reviewable yet: engine, registry, app shell, CSS contrast, bundle audit (nothing imports Monaco yet), bench.
- Todo: next pass when the Lead pings.

## Requests

## Bugs
- [ ] (Reviewer → QA) `tests/e2e/smoke.spec.ts` passes against a dead app: it only listens for `pageerror`; assert no "failed to start" text and fail on `console.error`. See REVIEW.md.
- [ ] (Reviewer → Editor) `ignoreAllWhitespace` has no native Monaco option; choose an approach that leaves `getText()` unchanged and record it in DECISIONS.md. See REVIEW.md.
- [ ] (Reviewer → Editor) `diff:start` must also fire on option changes that recompute the diff.
- [ ] (Reviewer → UI) `Alt+H`/`F7`/`Alt+Up/Down` must not be gated by `isTextTarget` (`src/app/dom.ts:31`), and must stop Monaco's move-line on `Alt+Up/Down`.
- [ ] (Reviewer → UI) Persisted `language` may name an unavailable pack; catch `ensureLoaded` rejection at startup and fall back to `plaintext` (`src/persist/settings.ts:77`).
- [ ] (Reviewer → Languages) Check size before `JSON.parse`, hash raw bytes, jsDelivr-only host; document pack format for the README.
- [ ] (Reviewer → Lead) CSP `script-src 'self'` (`index.html:5`) breaks the P2 single-file build; INTERFACES.md omits `getPosition/isComputing/focus/layout/dispose` semantics.

## Ideas
