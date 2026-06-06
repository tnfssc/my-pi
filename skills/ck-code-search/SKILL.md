---
name: "ck-code-search"
description: "Use ck (seek) for common local code indexing and semantic/hybrid code search workflows."
version: 2
created: "2026-06-05"
updated: "2026-06-05"
---
## When to Use
Use when user wants common ck workflows: create/check a local code index, switch embedding model, search code by meaning, or quickly verify ck works. Keep scope practical. Avoid rare/edge-case flags unless user asks or current failure needs them.

## Procedure
1. Check ck exists: `ck --version`.
2. Check index: `ck --status .`. Use `ck --status-verbose .` when verifying completion or diagnosing timeout.
3. Build index: `ck --index .`. To use code-focused Jina model: `ck --switch-model jina-code --force .`. Use long timeout for large repos.
4. If indexing hits bad non-code files and user only wants code index, add common binary/doc excludes to `.ckignore` (for example `*.pdf`) and rerun indexing.
5. Run common searches: exact/grep-style `ck "TODO" .`, semantic `ck --sem --limit 5 "authentication logic" .`, hybrid `ck --hybrid --limit 5 "file upload" .`.
6. Verify quality with 2-3 queries user actually cares about. Use `--scores` only if tuning relevance.

## Pitfalls
- Do not over-document rare ck options in this skill. Keep to common commands.
- `--switch-model` removes/rebuilds old index; only use when user asked for different model or current index model is wrong.
- Large repos can exceed agent command timeout. Confirm with `ck --status-verbose .`; success means embedded chunks equal total chunks.
- Some PDFs can crash ck indexing via `pdf-extract`; if user wants code search, excluding PDFs is enough.

## Verification
1. `ck --status .` shows expected model and nonzero indexed files/chunks.
2. `ck --status-verbose .` shows `Embedded chunks` equals `Total chunks` after build.
3. Semantic and hybrid sample queries return relevant code files.