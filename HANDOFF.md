# SideDiff handoff (Lead / Integrator)

## Goal
Build "SideDiff", a static no-backend web app that diffs two huge Acumatica customization XML/C# blobs (150k lines a side), per `D:\code\sd\GOAL-PROMPT.md`. Done = every section 9 item passes and the Lead has verified it in a real browser.

## Status
- [x] Phase 0 (Lead): scaffold, Monaco proof, `src/types.ts`, `docs/INTERFACES.md`
- [x] Phase 1 (5 sessions in parallel): editor, UI, languages, QA, review pass 1
- [x] Phase 2 (Lead + team): review pass 2, 4 bugs fixed, single-file build decided against (D10)
- [x] Phase 3 (Lead): prod build walked item by item in a real browser, 2 Editor bugs found and fixed (52254c8, 6eb9dc6, D11), README.md written, final gates green.
- [x] Phase 4 (user request): Acumatica project explorer + whole-text undo. Languages: `src/project/` indexer; Editor: item views, undo history, long-line diff (D14); UI: drawer, quick open, breadcrumb, toasts; QA: `project` fixture, e2e, bench; Reviewer: pass 3 (eea1246). Spec: INTERFACES.md "Project explorer and whole-text undo"; D12-D15. Lead verified acceptance 1-7 in the browser on fixtures and on the user's real export.
- [x] Phase 5 (user request, 2026-10-17): browse mode for one package, `.zip` customization packages (dependency-free zip reader), every zip file listed, summaries (DAC fields, screen outline, GI, rights, tables, site map, user-defined field values), overview with warnings, search everywhere (Ctrl+Shift+F), assembly browser (TS metadata reader, IL, Acumatica role badges) and the ILSpy engine on .NET WebAssembly (prebuilt, committed in `public/decompiler/`, D17/D19), third-party notices (D20). Review pass 4 fixed. Lead verified acceptance 1-8 on fixtures and on real packages (staged in ignored dist/, deleted after).

## Current state
- `pnpm check` 266/266, `pnpm e2e` 42/42, `pnpm bench` all PASS twice (`bench-results/bench-2026-10-17T12-53-07-813Z.json`): diff ready 859 ms, explorer 894 ms, search 37 ms, package open 478 ms, decompile cold 391 ms / warm 24 ms, stress 3.1 s.
- Public GitHub repo: https://github.com/ParkerTonra/sidediff (remote `origin`). Pushed through Phase 5 (2026-10-18); push later work only when the user says so. No hosting (user declined GitHub Pages; coworkers build locally).
- **Privacy:** the user's real export (`C:\Users\parke\Desktop\project.xml`) and the 35 packages in `C:\Users\parke\Downloads\*.zip` are client/vendor code. Never copy them, their names, code or decompiled output into the repo (public). Team sessions may read them locally and report aggregates only. `.gitignore` blocks `/project.xml`, `/local/`, `*.real.xml`; stage real files only under ignored `dist/__fx/` and delete them after.
- Licensed MIT (root `LICENSE`, copyright Parker Tonra, user's choice 2026-10-18). Third-party notices ship in `public/THIRD-PARTY-NOTICES.txt` (D20).

## Next steps (optional, only if the user asks)
1. A "renamed" status pairing items whose key changed but whose content matches.
2. Faster whole-assembly decompile (per-namespace streaming); today ~17 s for a 480 KB DLL, single types < 1 s.
3. STATUS.md "Ideas".

Team sessions (idle): QA `local_7fd7dcf4-1045-4fdd-9340-adc6843aefbf`, Editor `local_d415b487-2aa1-42e2-ad98-42894626d594`, UI `local_8aa17423-9c02-4852-95be-c47d35047114`, Languages `local_d6e78847-8081-4502-bf2d-226d41ef58d8`, Reviewer `local_31bd449d-d2fe-4a7c-b2fe-273f1160d3c6`.

## Decisions & rationale
See `D:\code\sd\docs\DECISIONS.md` D1-D20. Highlights: pnpm shim (D1); TS pinned ~6.0 (D2); Monaco 0.57 deep imports (D3); port 5317 (D4); remote packs are TextMate JSON (D5); engine owns the diff provider (D6); ignore-all-whitespace on stripped text (D7/D11); 10 s / 30 s budget (D8); no single-file build (D10); diffs in a dedicated cancellable worker (D11); explorer with read-only item views matched by identity (D12); whole-text undo keeps old models (D13); no char-level diff on lines over 1,000 chars (D14); repeat diff requests answered from the last result (D15); own zip reader and browse mode (D16); prebuilt committed decompiler (D17, D19); summaries as table data (D18); third-party notices (D20).

## Gotchas
- Port 5173 is taken on this machine; SideDiff uses 5317. A stale dev server may hold 5317; Playwright reuses it.
- `pnpm exec tsc` misbehaves in Git Bash; use `./node_modules/.bin/<tool>` or `pnpm <script>`.
- The browser pane's `type` action doesn't fire keydown and `shift+slash` doesn't arrive as `?`; dispatch KeyboardEvents to test shortcuts. Fold via a real gutter click.
- To load fixtures in the browser pane, copy them into `dist/__fx/` temporarily and feed the file inputs via DataTransfer; delete `dist/__fx` afterwards.
- On Windows, stopping a background Bash task leaves node running; kill by PID.
- Several sessions share one checkout: commit with `git commit -- <paths>`, never `git add -A`.

## How to verify
- `pnpm fixtures` (once; includes the project and package zips), then `pnpm check` (266), `pnpm e2e` (42/42), `pnpm bench` (all PASS).

Last updated: 2026-10-17, end of Phase 5.
