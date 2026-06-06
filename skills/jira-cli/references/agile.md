# Sprints / epics / releases / boards / projects

Use for sprint, standup, current sprint, epic, release/version, board, project discovery.

## Sprints

```sh
jira sprint list
jira sprint list --table
jira sprint list --table --plain --columns id,name,start,end,state
jira sprint list --state future,active --table --plain
```

Current/prev/next sprint issues:

```sh
jira sprint list --current --plain --columns key,summary,status,assignee,priority
jira sprint list --current -a$(jira me) --plain --columns key,summary,status,assignee,priority
jira sprint list --prev --plain --columns key,summary,status
jira sprint list --next --plain --columns key,summary,status
```

Specific sprint:

```sh
jira sprint list SPRINT_ID --plain --columns key,summary,status,assignee,priority
jira sprint list SPRINT_ID -yHigh -a$(jira me) --plain --columns key,summary,status,priority
jira sprint list SPRINT_ID --order-by rank --reverse --plain
```

Sprint filters mostly same as issue list. Extras:

```text
--current              current active sprint
--prev                 previous sprint
--next                 next planned sprint
--state future,active  sprint states
--table                sprint table, not explorer
--show-all-issues      sprint issues from all projects
```

Add to sprint = Jira change. Confirm first.

```sh
jira sprint add SPRINT_ID ABC-1 ABC-2
```

## Standup / handoff

For “current sprint handoff”, “standup”, “what assigned to me this sprint”:

```sh
jira sprint list --current -a$(jira me) --plain --columns key,summary,status,priority,updated
```

Summarize:

- In-progress / blocked
- High-priority
- Done vs not-done counts if useful
- Stale by `updated`
- Next action per attention item

## Epics

List epics:

```sh
jira epic list
jira epic list --table
jira epic list --plain --columns key,summary,status,assignee
```

List epic issues:

```sh
jira epic list EPIC-123 --plain --columns key,summary,status,assignee,priority
jira epic list EPIC-123 -ax -yHigh --plain --columns key,summary,status,priority
jira epic list EPIC-123 --order-by rank --reverse --plain
```

Create epic = write op. Confirm first.

```sh
jira epic create -n"Epic name" -s"Epic summary" -b"Description" --no-input
```

Add/remove epic issues = write op. Confirm first.

```sh
jira epic add EPIC-123 ABC-1 ABC-2
jira epic remove ABC-1 ABC-2
```

## Projects / boards

```sh
jira project list
jira board list -pABC
jira open        # open configured project
jira open ABC-123
```

Use discovery when user lacks project key or asks available projects/boards.

## Releases / versions

```sh
jira release list -pABC
jira release list --project ABC
```

Release support needs Jira versions enabled.
