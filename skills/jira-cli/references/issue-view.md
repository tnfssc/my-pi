# Issue view / ticket inspect

Use when user asks about specific ticket(s), gives issue key, wants summary/status/comments/links/desc, or asks “what going on here?”

## Core commands

```sh
jira issue view ABC-123
jira issue view ABC-123 --plain
jira issue view ABC-123 --comments 5
jira issue view ABC-123 --raw
jira open ABC-123
```

Flags:

- `--plain`: readable terminal output. Good quick view.
- `--raw`: Jira API JSON. Best for exact fields, comments, custom fields, parse.
- `--comments N`: include N recent comments in rendered view.

Alias exists: `jira issue show ABC-123`. Prefer `view`.

## Pick plain vs raw

Use `--plain` when:

- User wants quick read.
- Need summary/status/desc/recent comments only.
- Output shown direct to human.

Use `--raw` when:

- Need exact fields for summary/report/automation.
- Need comments, links, custom fields, parent/epic, metadata.
- Plan parse with `jq` or Python.

```sh
jira issue view ABC-123 --raw > /tmp/ABC-123.json
python3 - <<'PY'
import json
p='/tmp/ABC-123.json'
data=json.load(open(p))
f=data.get('fields', {})
print('Key:', data.get('key'))
print('Summary:', f.get('summary'))
print('Status:', f.get('status', {}).get('name'))
print('Assignee:', (f.get('assignee') or {}).get('displayName'))
print('Priority:', (f.get('priority') or {}).get('name'))
PY
```

## Multi-ticket view

Multiple keys → view each. Keep terse.

```sh
for key in ABC-123 ABC-456 ABC-789; do
  echo "### $key"
  jira issue view "$key" --plain --comments 3
  echo
done
```

Structured compare:

```sh
for key in ABC-123 ABC-456; do
  jira issue view "$key" --raw > "/tmp/$key.json"
done
```

## Summary shape

For “summarize ticket” / “what going on?”:

```md
**ABC-123 — <summary>**
- Status / owner: <status>, <assignee or unassigned>
- Priority / type: <priority>, <issue type>
- What it is: <1-3 sentence plain-English summary>
- Latest signal: <latest relevant comment/update>
- Blockers / risks: <if any>
- Next step: <actionable next step>
```

Do not dump raw issue unless user asks. Show command run.

## Comments-heavy asks

```sh
jira issue view ABC-123 --comments 10
jira issue view ABC-123 --raw
```

Need history → summarize comments chronologically. Otherwise highlight latest decision, blocker, open question.

## Browser asks

```sh
jira open ABC-123
```

Use browser only when user wants UI. For analysis, use `jira issue view`.
