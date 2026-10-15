# SideDiff keyboard shortcuts

Source: `docs/INTERFACES.md` (UI contract). The UI registers its shortcuts on `document` in the capture phase so Monaco cannot swallow them. Press `?` in the app for the same list (`data-testid="shortcuts-dialog"`).

| Keys | Action | Notes |
|---|---|---|
| `F7` or `Alt+Down` | Next change | Wraps around. With "diff only" on, reveals the target region. |
| `Shift+F7` or `Alt+Up` | Previous change | Wraps around. |
| `Alt+H` | Toggle "diff only" | Same as the **Diff only** button (`aria-pressed`). |
| `Ctrl+F` | Find | Monaco's find widget in the focused pane. |
| `Ctrl+H` | Find and replace | Monaco built-in, in editable panes. |
| `Ctrl+Z` / `Ctrl+Y` (or `Ctrl+Shift+Z`) | Undo / redo | Typing uses Monaco's per-pane stack first; once that is empty, undoes whole-text replacements: paste-replace, Clear, Open/drop, Swap (one step for both sides). Also works with focus outside the editors, for example right after clicking Clear. The last 10 replacements (300 MB) are kept. A toast confirms. |
| `Ctrl+B` | Show / hide the project explorer | Only when a side is an Acumatica project. |
| `Ctrl+P` | Quick open | Fuzzy search over every project item, regardless of the drawer filter. `Up`/`Down` choose, `Enter` opens, `Esc` closes. |
| `Alt+Left` or `Esc` | Back to the whole-project diff | While an item view is open. `Esc` is left alone when it would clear the explorer filter or close Monaco's find widget. |
| `Alt+PageUp` / `Alt+PageDown` | Previous / next item | In the item view, following the explorer's current filter. |
| `Ctrl+A` | Select all in the focused pane | Monaco built-in. |
| `Ctrl+M` | Toggle Tab focus mode | Tab then moves focus out of the editor instead of inserting a tab. Needed for keyboard-only use (Mac: `Ctrl+Shift+M`). |
| `?` | Show this cheat sheet | Only when focus is not in an editor or input. |
| `Esc` | Close the open dialog | Cheat sheet, Add language. |

## Inside the explorer list

| Keys | Action |
|---|---|
| `Up` / `Down`, `PageUp` / `PageDown`, `Home` / `End` | Move through the visible rows |
| `Enter` or `Space` | Open the item, or expand/collapse a group |
| `Left` / `Right` | Collapse a group (or jump from an item to its group); expand a group |
| Any printable character | Jumps to the filter box and types it |
| `Esc` in the filter box | Clears the filter |
| Splitter (focus it, then `Left` / `Right`, `Shift` for bigger steps, `Home` / `End`) | Resize the drawer |

## Conflicts to keep an eye on

- `Alt+Up` / `Alt+Down` are Monaco's "move line up/down". SideDiff's handler must `preventDefault()` and `stopPropagation()` in the capture phase, or the shortcut edits the pane text instead of navigating.
- `F7` / `Shift+F7` is also Monaco's own "next/previous difference" in a diff editor; the capture handler keeps one code path so "change N of M" always updates.
- `?` must not fire while typing in a pane or label input.
