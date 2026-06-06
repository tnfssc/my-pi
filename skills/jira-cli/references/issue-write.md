# Jira write ops

Use for Jira changes: create, edit, assign, transition, comment, worklog, link, clone, delete, bulk changes.

## Confirm rule

Before write command: summarize change, show exact command, ask confirm. Exception: user explicitly asked exact change now.

Always confirm destructive/broad:

- `jira issue delete`, especially `--cascade`
- bulk transition/edit/comment
- moving many issues into/out of sprint/epic
- replacing desc/custom fields

Use `--no-input` when all required fields known. Avoid surprise interactive prompt.

## Multiline text

For multiline desc/comment, avoid fragile inline shell quoting. Use temp file or stdin.

```sh
cat >/tmp/jira-body.md <<'EOF'
Steps:
1. Open checkout
2. Enter SAVE10
3. Click Apply

Expected: discount appears.
Actual: spinner never stops.
EOF

jira issue create -p PAY -tBug -s"Checkout page hangs on coupon apply" \
  -yHigh -lcheckout -lregression --template /tmp/jira-body.md --no-input
```

Pipe ok:

```sh
cat /tmp/comment.md | jira issue comment add ABC-123 --template -
```

## Create issue

```sh
jira issue create -pABC -tTask -s"Summary" -b"Description" --no-input
jira issue create -pABC -tBug -s"New bug" -yHigh -lbug -lurgent -b"Bug description" --no-input
jira issue create -tStory -s"Story title" -PEPIC-42 --no-input
jira issue create -tStory -s"Custom field story" --custom story-points=3 --no-input
jira issue create --raw -pABC -tTask -s"Summary" -b"Description" --no-input
```

Common create flags:

```text
-p, --project            project context, inherited global flag
-t, --type               issue type
-P, --parent             parent/epic; mandatory for subtasks
-s, --summary            summary/title
-b, --body               description
-y, --priority           priority
-r, --reporter           reporter
-a, --assignee           assignee
-l, --label              repeatable labels
-C, --component          repeatable components
--fix-version            repeatable fixVersions
--affects-version        repeatable affectsVersions
-e, --original-estimate  original estimate
--custom key=value       custom fields
-T, --template           desc file or - for stdin
--web                    open browser after create
--no-input               skip prompts for non-required fields
--raw                    JSON output
```

## Edit issue

```sh
jira issue edit ABC-123 -s"New summary" --no-input
jira issue edit ABC-123 -yHigh -lbug -lurgent -CBackend -b"Description" --no-input
jira issue edit ABC-123 --label -old --label new --component -FE --component BE --fix-version -v1.0 --fix-version v2.0 --no-input
cat body.md | jira issue edit ABC-123 -s"New summary" --no-input
```

Aliases: `update`, `modify`.

Useful flag: `--skip-notify` if user wants avoid watcher notifications.

## Assign / unassign

```sh
jira issue assign ABC-123 "User Name"
jira issue assign ABC-123 $(jira me)
jira issue assign ABC-123 default
jira issue assign ABC-123 x
```

## Transition / move

```sh
jira issue move ABC-123 "In Progress"
jira issue move ABC-123 Done
jira issue move ABC-123 Done --comment "Ready for QA"
jira issue move ABC-123 Done -RFixed -a$(jira me)
```

Aliases: `transition`, `mv`.

## Comments

```sh
jira issue comment add ABC-123 "My comment"
jira issue comment add ABC-123 $'Supports\n\nNew line'
jira issue comment add ABC-123 --template comment.md
cat comment.md | jira issue comment add ABC-123 --template -
jira issue comment add ABC-123 "Internal note" --internal
```

## Worklogs

```sh
jira issue worklog add ABC-123 "2d 1h 30m" --no-input
jira issue worklog add ABC-123 "10m" --comment "Investigated logs" --no-input
jira issue worklog add ABC-123 "1h" --started "2026-05-23 09:30:00" --timezone "America/Los_Angeles" --no-input
jira issue worklog add ABC-123 "1h 30m" --started "2026-05-23T09:30:00.000+0200" --new-estimate 0h --no-input
```

## Links / clone / delete

```sh
jira issue link ABC-123 ABC-456 Blocks
jira issue link remote ABC-123 https://example.com "Design doc"
jira issue unlink ABC-123 ABC-456

jira issue clone ABC-123
jira issue clone ABC-123 -s"Modified summary" -yHigh -a$(jira me)
jira issue clone ABC-123 -H"old text:new text"

jira issue delete ABC-123
jira issue delete ABC-123 --cascade
```

Delete/cascade destructive. Confirm first.
