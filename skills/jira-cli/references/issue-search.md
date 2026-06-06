# Issue search / lists / JQL / reports

Use when user wants find tickets, list assigned work, report, CSV, stale issues, or JQL.

## Output modes

For agent work, avoid interactive UI:

```sh
jira issue list --plain
jira issue list --raw
jira issue list --csv
jira issue list --plain --no-headers --columns key,summary,status,assignee
```

Use `--plain` for readable tables. Use `--csv` for spreadsheet. Use `--raw` for parse.

Common columns:

```text
type,key,summary,status,assignee,reporter,priority,resolution,created,updated,labels
```

## Common searches

```sh
# Recent issues
jira issue list --plain --columns key,summary,status,assignee

# Assigned to me
jira issue list -a$(jira me) --plain --columns key,summary,status,priority

# Assigned to me, not Done
jira issue list -a$(jira me) -s~Done --plain --columns key,summary,status,priority

# Reported by me this week
jira issue list -r$(jira me) --created week --plain --columns key,summary,status,created

# Unassigned this week
jira issue list -ax --created week --plain --columns key,summary,status,priority

# Assigned, not Done, old
jira issue list -a~x -s~Done --created-before -24w --plain --columns key,summary,status,assignee,updated

# Watched in project ABC
jira issue list -w -pABC --plain --columns key,summary,status

# Recently accessed
jira issue list --history --plain --columns key,summary,status
```

## Filter flags

```sh
-p KEY                     project
-t, --type Bug             issue type: Bug, Story, Task, Epic
-s, --status "In Progress" status; repeatable; ~ negates: -s~Done
-y, --priority High        priority
-a, --assignee NAME        assignee; $(jira me)=self; x=unassigned; ~x=assigned
-r, --reporter NAME        reporter
-l, --label backend        label; repeatable
-C, --component Backend    component
-P, --parent EPIC-123      parent/epic
--created week             today/week/month/year/date/relative like -7d
--updated -2d              today/week/month/year/date/relative
--created-after DATE
--created-before DATE
--updated-after DATE
--updated-before DATE
--order-by updated
--reverse
--paginate 0:50
```

## JQL

Use JQL for complex logic, status categories, OR, sorting, cross-project.

```sh
jira issue list -q 'project = ABC AND statusCategory != Done ORDER BY priority DESC' --plain
jira issue list -q 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC' --plain --columns key,summary,status,priority,updated
jira issue list -q 'project IS NOT EMPTY AND text ~ "login" ORDER BY updated DESC' --plain
jira issue list -q 'labels in (backend, high-prio) AND created >= -7d' --plain
```

Quote JQL as one shell arg.

## Report workflow

1. Scope first: project, assignee, sprint, epic, date, status.
2. Request only needed columns.
3. Need custom fields/comments/exact dates → `--raw`.
4. Show concise table.
5. Highlight blockers, stale issues, high-priority, unclear owners.
6. Include commands run.

## CSV export

```sh
jira issue list -q 'project = ABC AND updated >= -30d' --csv > jira-export.csv
```

Need custom shape and CSV mode lacking it → use `--plain --delimiter ',' --columns ...` carefully.
