# SideDiff handoff (Lead / Integrator)

## Goal
Build "SideDiff", a static no-backend web app that diffs two huge Acumatica customization XML/C# blobs (150k lines a side), per `D:\code\sd\GOAL-PROMPT.md`. Done = every section 9 item passes and the Lead has verified it in a real browser.

## Status
- [x] Phase 0 (Lead): scaffold, Monaco proof, `src/types.ts`, `docs/INTERFACES.md`
- [x] Phase 1 (5 sessions in parallel): editor, UI, languages, QA, review pass 1
- [x] Phase 2 (Lead + team): review pass 2, 4 bugs fixed, single-file build decided against (D10)
- [x] Phase 3 (Lead): prod build walked item by item in a real browser, 2 Editor bugs found and fixed (52254c8, 6eb9dc6, D11), README.md written, final gates green. **Project done.**

## Current state
- `pnpm check` 103/103, `pnpm e2e` 25/25, `pnpm bench` all PASS (`bench-results/bench-2026-10-14T18-44-50-634Z.json`). Details per item: STATUS.md, Lead section, "Phase 3 closed".
- Public GitHub repo: https://github.com/ParkerTonra/sidediff (remote `origin`, `main` tracks it). The user asked for it; push further commits only when the user says so.
- No LICENSE file (user not asked yet).
- Not re-checked by the Reviewer: b6c50ff, af1d529, 52254c8, 6eb9dc6 (all verified by the Lead in the browser and by e2e).

## Next steps (optional)
1. Reviewer pass on the four commits above if the user wants one (`local_31bd449d-d2fe-4a7c-b2fe-273f1160d3c6`).
2. STATUS.md "Ideas" (e.g. use the loaded file name as the pane label) only if the user asks; they are outside section 3.

Team sessions (idle): QA `local_7fd7dcf4-1045-4fdd-9340-adc6843aefbf`, Editor `local_d415b487-2aa1-42e2-ad98-42894626d594`, UI `local_8aa17423-9c02-4852-95be-c47d35047114`, Languages `local_d6e78847-8081-4502-bf2d-226d41ef58d8`, Reviewer `local_31bd449d-d2fe-4a7c-b2fe-273f1160d3c6`.

## Decisions & rationale
See `D:\code\sd\docs\DECISIONS.md` D1-D11. Highlights: pnpm shim (D1); TS pinned ~6.0 (D2); Monaco 0.57 deep imports (D3); port 5317 (D4); remote packs are TextMate JSON (D5); engine owns the diff provider (D6); ignore-all-whitespace on stripped text (D7/D11); 10 s / 30 s budget (D8); no single-file build (D10); diffs in a dedicated cancellable worker (D11).

## Gotchas
- Port 5173 is taken on this machine; SideDiff uses 5317. A stale dev server may hold 5317; Playwright reuses it.
- `pnpm exec tsc` misbehaves in Git Bash; use `./node_modules/.bin/<tool>` or `pnpm <script>`.
- The browser pane's `type` action doesn't fire keydown and `shift+slash` doesn't arrive as `?`; dispatch KeyboardEvents to test shortcuts. Fold via a real gutter click.
- To load fixtures in the browser pane, copy them into `dist/__fx/` temporarily and feed the file inputs via DataTransfer; delete `dist/__fx` afterwards.
- On Windows, stopping a background Bash task leaves node running; kill by PID.
- Several sessions share one checkout: commit with `git commit -- <paths>`, never `git add -A`.

## How to verify
- `pnpm fixtures` (once), then `pnpm check` (103), `pnpm e2e` (25/25), `pnpm bench` (all PASS).

Last updated: 2026-10-14, end of Phase 3.
