---
name: sf-git-commit
description: "Quick commit and push, with a message in the project's commit format (workflow.commitFormat in .saasfoundry.json)"
---

## Execution capabilities

Use the current agent's native tools for reading, editing, shell commands and delegation.
When delegation is available and authorized, assign independent work to agents; otherwise
execute the same steps sequentially. A sequential self-review is not an independent review:
report that limitation and retain any required human review. Tool names in legacy examples
describe capabilities, not required APIs. Use the user's current request as skill arguments.
Do not assume Claude Code hooks, model selection, tool permissions or credentials transfer.
Run preconditions explicitly, and stop to report a missing capability when no equivalent exists.
Never bypass CLI guards, required approvals, tests or workflow status exit conditions.
The project manifest and workflow rules take precedence over generic skill examples,
including branch names, commit formats, staging, pushing and approval requirements.
Legacy /task examples name roles: use native delegation if available and authorized,
or perform the role's work sequentially with the review limitation stated above.

## Parallel implementation and Git worktrees

Propose parallel worktrees only when the user's request contains independent writing streams
that can be delivered concurrently. Read-only exploration and review may use parallel agents
without separate worktrees. Work with sequential dependencies, overlapping file ownership or
unclear boundaries must use one feature worktree and sequential execution.

Before proposing parallel implementation, read `.saasfoundry.json` and use
`workflow.workingBranch`; never hardcode a branch name. Keep the primary checkout on that
configured working branch. Do not let feature workers write in the primary checkout while
parallel worktrees are active.

For each independent writing stream, define one ticket, branch and worktree path, plus its owned
files and dependency boundary. Start from a synchronized configured working branch. Each worker
must stay inside its assigned worktree and ownership boundary, preserve other agents' changes
and never revert unrelated work. The agent proposes this execution shape; the user retains
control when parallel implementation was not already authorized. If authorization, clean
separation, Git support or a synchronized base is unavailable, explain the constraint and use
one worktree or sequential execution.

After each stream is complete, commit and push through the configured workflow. After its merge,
return to the primary checkout, check out and synchronize the configured working branch, verify
the merge, then remove the completed worktree and local branch only when they are merged and no
longer in use. Never remove or overwrite user-owned worktrees, branches, uncommitted changes,
stashes or credentials implicitly.



# Commit

Quick commit in the project's commit format, then push.

## Context

- Git state: run `git status` and read its output
- Staged changes: run `git diff --cached --stat` and read its output
- Unstaged changes: run `git diff --stat` and read its output
- Recent commits: run `git log --oneline -5` and read its output
- Current branch: run `git branch --show-current` and read its output
- Commit format: run `node -p "JSON.stringify((require('./.saasfoundry.json').workflow || {}).commitFormat || null)" 2>/dev/null || echo null` and read its output

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
