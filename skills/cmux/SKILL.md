---
name: cmux
description: End-user control of cmux topology and routing (windows, workspaces, panes/surfaces, focus, moves, reorder, identify, trigger flash). Use when automation needs deterministic placement and navigation in a multi-pane cmux layout.
---

# cmux Core Control

Use this skill to control non-browser cmux topology and routing.

## Core Concepts

- Window: top-level macOS cmux window.
- Workspace: tab-like group within a window.
- Pane: split container in a workspace.
- Surface: a tab within a pane (terminal or browser panel).

## Fast Start

```bash
# identify current caller context
cmux identify --json

# list topology
cmux list-windows
cmux list-workspaces
cmux list-panes
cmux list-pane-surfaces --pane pane:1

# create/focus/move
cmux new-workspace
cmux new-split right --panel pane:1
cmux move-surface --surface surface:7 --pane pane:2 --focus true
cmux split-off --surface surface:7 right
cmux reorder-surface --surface surface:7 --before surface:3

# attention cue
cmux trigger-flash --surface surface:7
```

## Agent Persistent Terminals

Pi has a local `cmux_terminal` tool for commands that should keep running in a cmux terminal and be inspected later. Use normal `bash` for quick finite commands whose output should be captured immediately. Use `cmux_terminal` for background/persistent/interactive commands: dev servers, watchers, log tails, TUIs, REPLs, `k9s`, `lazygit`, `npm run dev`, `tail -f`, `watch`, etc.

Tool actions:

- `start`: start a command in this cmux workspace and track it for the current Pi session.
- `read`: read terminal output later.
- `search`: search terminal scrollback/output for errors, URLs, readiness lines, stack traces, etc.
- `write_stdin`: write raw stdin to the terminal. Include `\n` when Enter is wanted.
- `list`: list terminals started by this Pi session only.

Default policy:

- Simple finite command → `bash`.
- Long-running/interactive/background command → `cmux_terminal action=start`.
- Need to inspect persistent command → `cmux_terminal action=read` or `action=search`.
- Need to interact → `cmux_terminal action=write_stdin`.
- Name terminals with short stable names like `dev`, `tests`, `logs`, `k9s`.
- `cmux_terminal list/read/write_stdin/search` only see terminals opened by the current Pi session. For arbitrary cmux topology, use raw `cmux` CLI from this skill.

Examples:

```json
{"action":"start","name":"dev","command":"npm run dev","placement":"tab"}
{"action":"read","name":"dev","lines":200}
{"action":"search","name":"dev","query":"ready|localhost|error","regex":true,"context":2}
{"action":"write_stdin","name":"dev","input":"rs\n"}
{"action":"list"}
```

Do not use `cmux_terminal` just to run `ls`, `rg`, `git status`, or tests that should complete and return output directly; use `bash`.


## Pi / non-TTY automation notes

When automating cmux from pi or another Node/agent subprocess, do **not** assume the `cmux` CLI behaves the same as it does in an interactive cmux terminal. Pi's bash/tool subprocesses may not provide the terminal/session context cmux expects; in practice `cmux ping` / `cmux new-workspace` can be killed with `SIGTERM` even though the same command works in a normal cmux tab.

Use the cmux Unix socket directly when available:

```bash
printf 'help
' | nc -U "$CMUX_SOCKET_PATH"
printf 'ping
' | nc -U "$CMUX_SOCKET_PATH"
```

Important socket protocol details:

- Socket command names use underscores, not CLI hyphens: `list_workspaces`, `new_workspace`, `select_workspace`, `current_workspace`, `close_workspace`, `list_surfaces`, `send`, `send_key`.
- `new_workspace` returns `OK <workspace-uuid>`. Capture that UUID, then call `select_workspace <uuid>` before sending keystrokes.
- Add a short delay after creating/selecting a workspace before sending text; the terminal may not be ready immediately.
- To run a command in the new workspace, send text then Enter:

```bash
printf 'new_workspace
' | nc -U "$CMUX_SOCKET_PATH"   # -> OK <uuid>
printf 'select_workspace <uuid>
' | nc -U "$CMUX_SOCKET_PATH"
printf "send  cd '/path/to/worktree'
" | nc -U "$CMUX_SOCKET_PATH"
printf 'send_key enter
' | nc -U "$CMUX_SOCKET_PATH"
```

The two spaces after `send` are intentional: the first separates the socket command from its payload, the second becomes a leading space in the shell command. This keeps commands out of shell history when the user's shell honors leading-space history ignores (for example `HISTCONTROL=ignorespace`). Use the same pattern for setup commands:

```text
send  export FOO='bar'; { setup command here; }
send_key enter
```

Workspace title caveat: terminal OSC title sequences (`ESC ] 0 ; title BEL`, `ESC ] 2 ; title BEL`) did not reliably change the cmux workspace sidebar title via socket-driven automation, and no socket `rename_workspace` command was available in `help`. Do not rely on title changes unless cmux adds/ documents a rename command.

## Settings and Docs

Use `cmux docs settings` before changing cmux-owned settings. It prints the docs URL, schema URL, raw GitHub resources, cmux.json paths, and reload command.

```bash
cmux docs settings
cmux settings path
```

cmux-owned settings live in `~/.config/cmux/cmux.json`. Legacy `~/.config/cmux/settings.json` and `~/Library/Application Support/com.cmuxterm.app/settings.json` files are read only as fallback for missing keys. Before editing, copy any existing `cmux.json` file to a timestamped `.bak` next to it so the user can revert. Edit the user file, then reload:

```bash
cmux reload-config
```

`cmux reload-config` reloads BOTH `cmux.json` and Ghostty config (`~/.config/ghostty/config`) and refreshes terminals in place. No app restart needed.

Use cmux settings for app behavior, sidebar, notifications, browser behavior, automation, workspace colors, and cmux-owned shortcuts. Terminal rendering settings such as font, cursor style, theme, scrollback, background transparency (`background-opacity`), and blur (`background-blur`) belong in Ghostty config at `~/.config/ghostty/config`.

Open the UI when useful:

```bash
cmux settings
cmux settings cmux-json
cmux settings shortcuts
```

## Handle Model

- Default output uses short refs: `window:N`, `workspace:N`, `pane:N`, `surface:N`.
- UUIDs are still accepted as inputs.
- Request UUID output only when needed: `--id-format uuids|both`.

## Deep-Dive References

| Reference | When to Use |
|-----------|-------------|
| [references/handles-and-identify.md](references/handles-and-identify.md) | Handle syntax, self-identify, caller targeting |
| [references/windows-workspaces.md](references/windows-workspaces.md) | Window/workspace lifecycle and reorder/move |
| [references/panes-surfaces.md](references/panes-surfaces.md) | Splits, surfaces, move/reorder, focus routing |
| [references/trigger-flash-and-health.md](references/trigger-flash-and-health.md) | Flash cue and surface health checks |
| [../cmux-workspace/SKILL.md](../cmux-workspace/SKILL.md) | Current caller workspace rules and non-disruptive automation |
| [../cmux-settings/SKILL.md](../cmux-settings/SKILL.md) | Safe cmux.json settings edits and validation |
| [../cmux-browser/SKILL.md](../cmux-browser/SKILL.md) | Browser automation on surface-backed webviews |
| [../cmux-markdown/SKILL.md](../cmux-markdown/SKILL.md) | Markdown viewer panel with live file watching |
