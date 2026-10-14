# SideDiff keyboard shortcuts

Source: `docs/INTERFACES.md` (UI contract). The UI registers its shortcuts on `document` in the capture phase so Monaco cannot swallow them. Press `?` in the app for the same list (`data-testid="shortcuts-dialog"`).

| Keys | Action | Notes |
|---|---|---|
| `F7` or `Alt+Down` | Next change | Wraps around. With "diff only" on, reveals the target region. |
| `Shift+F7` or `Alt+Up` | Previous change | Wraps around. |
| `Alt+H` | Toggle "diff only" | Same as the **Diff only** button (`aria-pressed`). |
| `Ctrl+F` | Find | Monaco's find widget in the focused pane. |
| `Ctrl+H` | Find and replace | Monaco built-in, in editable panes. |
| `Ctrl+Z` / `Ctrl+Y` | Undo / redo | Monaco built-in, per pane. |
| `Ctrl+A` | Select all in the focused pane | Monaco built-in. |
| `?` | Show this cheat sheet | Only when focus is not in an editor or input. |
| `Esc` | Close the open dialog | Cheat sheet, Add language. |

## Conflicts to keep an eye on

- `Alt+Up` / `Alt+Down` are Monaco's "move line up/down". SideDiff's handler must `preventDefault()` and `stopPropagation()` in the capture phase, or the shortcut edits the pane text instead of navigating.
- `F7` / `Shift+F7` is also Monaco's own "next/previous difference" in a diff editor; the capture handler keeps one code path so "change N of M" always updates.
- `?` must not fire while typing in a pane or label input.
