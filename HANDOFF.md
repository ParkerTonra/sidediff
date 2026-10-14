# SideDiff handoff (Lead / Integrator)

## Goal
Build "SideDiff", a static no-backend web app that diffs two huge Acumatica customization XML/C# blobs (150k lines a side), per `D:\code\sd\GOAL-PROMPT.md`. Done = every section 9 item passes and the Lead has verified it in a real browser.

## Status
- [x] Phase 0 (Lead): scaffold, Monaco proof, `src/types.ts`, `docs/INTERFACES.md`, commit `0f7bc1d`
- [x] Phase 1 (5 sessions in parallel): editor, UI, languages, QA, review pass 1
- [x] Phase 2 (Lead + team): Lead re-ran e2e + bench, Reviewer pass 2 (`7a53cac`), 4 bugs fixed and verified (`22e1cd6`, `b6c50ff`, `cf44bfb`, `af1d529`), P2 single-file build decided against (D10)
- [ ] Phase 3 (Lead): `pnpm build`, serve `dist/`, full browser walkthrough of section 9, finalize `README.md` (from `docs/README.draft.md`), final commit

## Current state
- After all Phase 2 fixes (2026-10-14 ~11:22): `pnpm check` 103/103, `pnpm e2e` 25/25, `pnpm bench` all PASS (`bench-results/bench-2026-10-14T18-21-49-935Z.json`: diff ready 826 ms, longest task during diff 0 ms, stats exact 308/308/1689/1693, diff only on/off 325/88 ms, worst scroll frame 17 ms, JS heap 47.7 MB, stress 500k done 2.9 s degraded, initial JS 0.7 MB gzip).
- All STATUS.md Bugs and Requests are `[x]`. The Reviewer verified the network audit, bundle audit, SQL install through `/`, and contrast. `README.draft.md` placeholders are filled in (`7a53cac`).
- Not yet re-checked by the Reviewer: the UI's a11y fixes (`b6c50ff`) and Ctrl+M (`af1d529`). The Editor verified Ctrl+M in prod and dev builds; the UI verified its fixes in its harness; e2e passes.
- A stale Vite dev server (not started by this Lead session) may still be listening on 5317. Playwright reuses it. The Lead's auto mode was denied stopping it; fine to reuse.

## Next steps
1. `pnpm build`, then serve `dist/` (`./node_modules/.bin/vite preview --port 5318 --strictPort` or any static server; 5318 is Editor's harness port, so pick a free one if busy) and open it with `preview_start { url }`.
2. Walk every GOAL-PROMPT.md section 9 item in that real browser: large pair via file inputs (fixtures in `D:\code\sd\fixtures\`), stats, diff only, nav shortcuts, Ctrl+M + Tab escapes the editor, themes, persistence, Add-language SQL, zero non-localhost requests on a cold load, no console errors. Take screenshots into `docs/screenshots/` if useful.
3. Optionally ask the Reviewer (`local_31bd449d-d2fe-4a7c-b2fe-273f1160d3c6`) to re-check `b6c50ff` and `af1d529`.
4. Write `D:\code\sd\README.md` from `docs/README.draft.md` (check its numbers against the latest bench).
5. Update STATUS.md and this file, then make the final commit. Never push.

Team sessions (idle, keep context; use SendMessage, not new sessions):
- QA `local_7fd7dcf4-1045-4fdd-9340-adc6843aefbf` (scripts/, fixtures/, tests/)
- Editor `local_d415b487-2aa1-42e2-ad98-42894626d594` (src/editor/)
- UI `local_8aa17423-9c02-4852-95be-c47d35047114` (src/app/, src/styles/, src/persist/)
- Languages `local_d6e78847-8081-4502-bf2d-226d41ef58d8` (src/languages/, languages/)
- Reviewer `local_31bd449d-d2fe-4a7c-b2fe-273f1160d3c6` (docs/REVIEW.md, docs/SHORTCUTS.md, docs/README.draft.md)

## Decisions & rationale
See `D:\code\sd\docs\DECISIONS.md` D1-D10. Highlights: pnpm shim (D1); TS pinned ~6.0 (D2); Monaco 0.57 deep import paths (D3); port 5317 (D4); remote packs are TextMate JSON via vscode-textmate + oniguruma wasm (D5); engine overrides Monaco's diff provider (D6); ignore-all-whitespace uses shadow models (D7); diff budget 10 s / 30 s degraded (D8); Monaco features/patches (D9); **P2 single-file build not shipped (D10)**. Monaco passed the perf gate: no CodeMirror switch.

## Gotchas
- Port 5173 is taken by something else on this machine; SideDiff uses 5317.
- `pnpm exec tsc` misbehaves in Git Bash; use `./node_modules/.bin/<tool>` or `pnpm <script>`.
- Vite pre-bundles Monaco deep imports; if find/folding/codicons break in dev, restart with `--force`. `vite.config.ts` now pre-bundles vscode-textmate/oniguruma (first pack install in dev used to 504).
- Vite 8 CLI has no `--cacheDir`; for a cold-cache server use a wrapper config with `cacheDir` set.
- On Windows, stopping a background Bash task leaves the node child running; kill it by PID (`netstat -ano | grep :<port>`, then `taskkill //PID <pid> //F`).
- Five sessions share one checkout: commit with `git commit -- <paths>`, never `git add -A`.
- `preview_start` by name is bound to an old folder; use `preview_start { url }`. The browser pane may not draw when hidden; `javascript_tool` / `find` still work.
- The Windows clipboard stores CRLF; the copy test normalizes it.

## Key files
- `D:\code\sd\GOAL-PROMPT.md`: the full spec (sections 3, 8, 9 are the acceptance criteria)
- `D:\code\sd\docs\STATUS.md`: per-agent status, measured numbers, Requests/Bugs/Ideas
- `D:\code\sd\docs\INTERFACES.md`, `D:\code\sd\src\types.ts`: contracts (Lead-owned)
- `D:\code\sd\docs\DECISIONS.md`: deviations and choices
- `D:\code\sd\docs\REVIEW.md`, `D:\code\sd\docs\README.draft.md`, `D:\code\sd\docs\SHORTCUTS.md`: Reviewer output
- `D:\code\sd\src\main.ts`, `D:\code\sd\index.html`, `D:\code\sd\vite.config.ts`: composition root, CSP, build config (Lead-owned)
- `D:\code\sd\scripts\bench.ts`, `D:\code\sd\tests\e2e\`: the perf gate and the e2e suite

## How to verify
- `pnpm check`: tsc + eslint + vitest, expect 103 passing
- `pnpm fixtures`: regenerate the gitignored fixtures (~5 s) if `fixtures/*.xml` are missing
- `pnpm e2e`: expect 25/25
- `pnpm bench`: expect every line PASS, JSON in `bench-results/`

## Open questions
- None waiting on the user.

Last updated: 2026-10-14 ~11:25, end of Phase 2.
