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
- Todo: review landed work against sections 3, 8, 9; a11y; network audit; bundle language audit; README draft; SHORTCUTS.md.

## Requests

## Bugs

## Ideas
