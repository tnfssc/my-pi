---
name: jira-cli
description: Use this skill when user wants view, inspect, summarize, search, create, edit, transition, comment on, assign, clone, link, or report on Jira issues from terminal with ankitpokhrel/jira-cli (`jira`). Issue/ticket view = main path. Also use for sprint, epic, release, board, project, JQL, worklog, or Jira automation, even when user says “ticket”, “story”, “bug”, “standup”, “current sprint”, or “what’s assigned to me” instead of Jira CLI.
compatibility: Requires `jira` command from https://github.com/ankitpokhrel/jira-cli and configured Jira account (`jira init` or `JIRA_CONFIG_FILE`).
---

# Jira CLI skill

Use `jira` for Atlassian Jira terminal work. Keep context small. Issue view = common path. Load focused refs only when needed.

## Default path: issue view

User gives key like `ABC-123`, asks “what ticket?”, wants status, assignee, desc, comments, links, or quick summary → view first.

```sh
jira issue view ABC-123
jira issue view ABC-123 --plain
jira issue view ABC-123 --comments 5
jira issue view ABC-123 --raw
jira open ABC-123
```

Use `--raw` for structured fields/comments. Use `--plain` for readable terminal view. Summarize in user terms: status, owner, priority, core ask/bug, latest useful comment, blockers, next action.

Need multi-ticket, comment-heavy, raw JSON, or summary patterns → read `references/issue-view.md`.

## Route other work

- Find/list/report/JQL/assigned-to-me/stale/CSV/plain output → `references/issue-search.md`.
- Change Jira data: create/edit/assign/transition/comment/worklog/link/clone/delete → `references/issue-write.md`.
- Sprint/epic/release/board/project/standup/current sprint handoff → `references/agile.md`.
- Install/auth/config/multiple configs/command missing/Cloud vs Server → `references/setup.md`. Do not load setup for normal ticket work.

## Safety defaults

- Read-only commands: ok run direct.
- Write/change commands: state intended change, show exact command, ask confirm unless user explicitly asked exact change now.
- Destructive/broad changes need confirm: delete, cascade delete, bulk edit/comment/transition, moving many issues.
- Never print tokens, passwords, `.netrc`, full config.
- Need parse output → prefer `--plain`, `--raw`, `--csv`; avoid interactive UI.
- Quote user values safely. Multiline desc/comment → pipe stdin or temp template file.

## Output habit

When command run/proposed, include command. User can reproduce. Reports: small scoped table, then what needs attention.
