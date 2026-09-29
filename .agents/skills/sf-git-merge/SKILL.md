---
name: sf-git-merge
description: "Intelligently merge branches with context-aware conflict resolution"
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



# Merge

Merge branches intelligently by understanding feature context and resolving conflicts efficiently.

## Context

- Current branch: run `git branch --show-current` and read its output
- Working tree status: run `git status --short` and read its output
- Target branch: $1
- Recent commits: run `git log --oneline -5` and read its output

## Workflow

1. **CONTEXT GATHERING**:
   - `git branch --show-current` to identify current branch
   - `git status` to ensure clean working tree
   - **CRITICAL**: Abort if uncommitted changes exist

2. **FEATURE ANALYSIS**:
   - Search PR with `gh pr list --head <branch-name>`
   - Get PR details with `gh pr view <number> --json title,body,files`
   - Use Task agents to gather context from PR/issue descriptions

3. **MERGE ATTEMPT**:
   - `git fetch origin <branch-name>`
   - `git merge origin/<branch-name> --no-commit`
   - Check status with `git status --porcelain`

4. **CONFLICT DETECTION**:
   - Clean merge: `git commit` with descriptive message
   - Conflicts: Parse `git diff --name-only --diff-filter=U`

5. **SMART RESOLUTION**: For each conflicted file:
   - Read file to understand conflict markers
   - Apply resolution based on context:
     - **Feature additions**: Keep both if non-overlapping
     - **Bug fixes**: Prefer incoming if fixing known issue
     - **Refactors**: Analyze intent and merge carefully
   - Use MultiEdit to resolve all conflicts
   - **STOP**: If >10 files conflicted, ask user

6. **VERIFICATION**:
   - `git diff --cached` to review changes
   - Check no conflict markers remain: `grep -r "<<<<<<< HEAD"`
   - `git add -A` and commit

## Conflict Resolution by Type

- **package.json**: Merge dependencies, prefer higher versions
- **Config files**: Combine settings unless mutually exclusive
- **Source code**: Use PR/issue context to understand intent
- **Tests**: Keep all tests unless duplicates
- **Imports**: Merge all, deduplicate

## Rules

- ALWAYS gather context before merging
- NEVER blindly accept theirs/ours without analysis
- ABORT if conflicts exceed 10 files
- Max 3 resolution attempts per file
- If stuck: `git merge --abort` and report blockers
