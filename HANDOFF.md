# SideDiff handoff (Lead / Integrator)

## Goal
Build "SideDiff", a static no-backend web app that diffs two huge Acumatica customization XML/C# blobs (150k lines a side), per `D:\code\sd\GOAL-PROMPT.md`. Done = every section 9 item passes and the Lead has verified it in a real browser.

## Status
- [x] Phase 0 (Lead): scaffold, Monaco proof, `src/types.ts`, `docs/INTERFACES.md`, commit `0f7bc1d`
- [x] Phase 1 (5 sessions in parallel): editor, UI, languages, QA, review pass 1, all committed (latest `2616e2d` + Lead docs commit)
- [ ] Phase 2 (Lead + QA + Reviewer): integrate, bench, e2e, review pass 2, triage, iterate until section 9 passes, then **/molt** (user's instruction)
- [ ] Phase 3 (Lead): `pnpm build`, serve `dist/`, full browser walkthrough of section 9, finalize README.md (from `docs/README.draft.md`), final commit
- [ ] P2: single-file build (not started; CSP needs rewriting for the inlined build, see the Reviewer bug in STATUS.md); Add-language dialog not yet verified through `/` after the CSP fix

## Current state
- Working tree clean apart from this handoff commit. `pnpm check` green (103 tests) at 11:06 on 2026-10-14.
- Last known results (from the agents, not re-run by the Lead yet): `pnpm bench` all PASS (diff ready ~0.5-0.8 s, diff-only toggle 310/87 ms, worst scroll frame 17 ms, heap 48 MB, stress done in ~3 s degraded); `pnpm e2e` 25/25 per the Editor session.
- All STATUS.md Bugs and Requests are `[x]`; nothing open is known. Ideas: use the file name as the pane label (out of scope, leave).

## Next steps
1. Run `pnpm e2e` and `pnpm bench` yourself (dev server on 5317 is reused by Playwright; restart it with `--force` first, see Gotchas).
2. Ask the Reviewer for pass 2 via SendMessage to `local_31bd449d-d2fe-4a7c-b2fe-273f1160d3c6`: full review against sections 3/8/9, a11y contrast in both themes, network audit, bundle audit, Add-language through `/`.
3. Triage findings into STATUS.md Bugs and message the owners. Each session keeps its own context, so use SendMessage, not new sessions:
   - QA `local_7fd7dcf4-1045-4fdd-9340-adc6843aefbf` (scripts/, fixtures/, tests/)
   - Editor `local_d415b487-2aa1-42e2-ad98-42894626d594` (src/editor/)
   - UI `local_8aa17423-9c02-4852-95be-c47d35047114` (src/app/, src/styles/, src/persist/)
   - Languages `local_d6e78847-8081-4502-bf2d-226d41ef58d8` (src/languages/, languages/)
   - Reviewer `local_31bd449d-d2fe-4a7c-b2fe-273f1160d3c6` (docs/REVIEW.md, docs/SHORTCUTS.md, docs/README.draft.md)
4. Decide on the P2 single-file build (optional stretch).
5. When section 9 passes in automated checks, update this file and **/molt** before Phase 3.

## Decisions & rationale
See `D:\code\sd\docs\DECISIONS.md` D1-D9. Highlights: pnpm shim in `%APPDATA%\npm` (D1); TS pinned ~6.0 for typescript-eslint (D2); Monaco 0.57 import paths `monaco-editor/editor/editor.api` and `monaco-editor/languages/definitions/<id>/register` (D3); port 5317 (D4); remote packs are TextMate JSON via vscode-textmate + oniguruma wasm (D5); the engine overrides Monaco's diff provider (D6); ignore-all-whitespace uses hidden shadow models (D7); diff budget is 10 s (30 s degraded), not unlimited (D8). Monaco passed the perf gate, so there is no CodeMirror switch.

## Gotchas
- Port 5173 is taken by something else on this machine; SideDiff uses 5317.
- `pnpm exec tsc` misbehaves in Git Bash; use `./node_modules/.bin/<tool>` or `pnpm <script>`.
- Vite pre-bundles Monaco deep imports; if find/folding/codicons break in dev, restart `pnpm dev --force`.
- Five sessions share one checkout: commit with `git commit -- <paths>`, never `git add -A`.
- The preview tool in this desktop session was bound to the old folder (`D:\code\ab-text`) for `preview_start` by name; open the browser with `preview_start { url: "http://localhost:5317" }` after starting Vite yourself.
- The Windows clipboard stores CRLF; the copy test normalizes it.

## Key files
- `D:\code\sd\GOAL-PROMPT.md`: the full spec (sections 3, 8, 9 are the acceptance criteria)
- `D:\code\sd\docs\STATUS.md`: per-agent status, measured numbers, Requests/Bugs/Ideas
- `D:\code\sd\docs\INTERFACES.md`, `D:\code\sd\src\types.ts`: contracts (Lead-owned)
- `D:\code\sd\docs\DECISIONS.md`: deviations and choices
- `D:\code\sd\docs\REVIEW.md`, `D:\code\sd\docs\README.draft.md`: Reviewer output
- `D:\code\sd\src\main.ts`, `D:\code\sd\index.html`: composition root and CSP (Lead-owned)
- `D:\code\sd\scripts\bench.ts`, `D:\code\sd\tests\e2e\`: the perf gate and the e2e suite

## How to verify
- `pnpm check`: tsc + eslint + vitest, expect 103+ tests passing
- `pnpm fixtures`: regenerate the gitignored fixtures (~5 s) if `fixtures/*.xml` are missing
- `pnpm e2e`: expect 25/25
- `pnpm bench`: expect every line PASS, JSON in `bench-results/`

## Open questions
- None waiting on the user. P2 single-file build: whether to do it is the Lead's call.

Last updated: 2026-10-14, end of Phase 1.
