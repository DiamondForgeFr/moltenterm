---
name: commit
description: Quick commit and push, with a message in the project's commit format (workflow.commitFormat in .saasfoundry.json)
model: haiku
allowed-tools: Bash(git :*), Bash(npm :*), Bash(node :*)
---

# Commit

Quick commit in the project's commit format, then push.

## Context

- Git state: !`git status`
- Staged changes: !`git diff --cached --stat`
- Unstaged changes: !`git diff --stat`
- Recent commits: !`git log --oneline -5`
- Current branch: !`git branch --show-current`
- Commit format: !`node -p "JSON.stringify((require('./.saasfoundry.json').workflow || {}).commitFormat || null)" 2>/dev/null || echo null`

## Workflow

1. **Analyze**: Review git status
   - Nothing staged but unstaged changes exist: `git add .`
   - Nothing to commit: inform user and exit

2. **Generate commit message** from the commit format above:
   - **Configured** (an object is printed): follow its `pattern` exactly and use only its `types`. With the default pattern `type(#N): description`, the scope is the ticket number, never a module name.
   - **Ticket number**: when `requireTicket` is true, take it from the branch (`feature/<N>-…`, `fix/<N>-…`) or from the ticket being worked on. If neither gives one, stop and say that the format requires a ticket: never invent one, never drop the `(#N)`.
   - **Not configured** (`null`): conventional commits, `type(scope): description`, types `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `chore`, `ci`, `build`, `revert`
   - Under 72 chars, imperative mood, lowercase after colon
   - Example on branch `feature/42-version-endpoint` with the default format: `feat(#42): add the version endpoint`

3. **Commit**: `git commit -m "message"`

4. **Push**: `git push`

## Rules

- SPEED OVER PERFECTION: Generate one good message and commit
- NO INTERACTION: Never ask questions - analyze and commit. The one stop: a required ticket number that cannot be found
- PROJECT FORMAT FIRST: The commit format of `.saasfoundry.json` wins over the conventional default
- AUTO-STAGE: If nothing staged, stage everything
- AUTO-PUSH: Always push after committing
- IMPERATIVE MOOD: "add", "update", "fix" not past tense
