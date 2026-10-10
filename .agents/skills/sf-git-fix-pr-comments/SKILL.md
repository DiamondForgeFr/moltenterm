---
name: sf-git-fix-pr-comments
description: "Fetch PR review comments and implement all requested changes"
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



# Fix PR Comments

Systematically address ALL unresolved review comments until PR is approved.

## Context

- Current branch: run `git branch --show-current` and read its output
- Working tree status: run `git status --short` and read its output
- Recent commits: run `git log --oneline -3` and read its output

## Workflow

1. **FETCH COMMENTS**:
   - Identify PR: `gh pr status --json number,headRefName`
   - Get reviews: `gh pr review list --state CHANGES_REQUESTED`
   - Get inline: `gh api repos/{owner}/{repo}/pulls/{number}/comments`
   - Capture BOTH review comments AND inline code comments
   - STOP if no PR found - ask user for PR number

2. **ANALYZE & PLAN**:
   - Extract exact file:line references
   - Group by file for MultiEdit efficiency
   - STAY IN SCOPE: NEVER fix unrelated issues
   - Create checklist: one item per comment

3. **IMPLEMENT FIXES**:
   - BEFORE editing: ALWAYS `Read` target file first
   - Batch changes with `MultiEdit` for same-file modifications
   - Make EXACTLY what reviewer requested
   - Check off each resolved comment

4. **COMMIT & PUSH**:
   - Stage: `git add -A`
   - Commit: `fix(#<N>): address PR review comments`, in the project's commit format (`workflow.commitFormat` in `.saasfoundry.json`), with `<N>` the ticket of the PR branch (`feature/<N>-…`, `fix/<N>-…`). Without a configured format: `fix: address PR review comments`
   - Push: `git push`
   - NEVER include co-author tags

## Rules

- Every unresolved comment MUST be addressed
- Read files BEFORE any edits - no exceptions
- FORBIDDEN: Style changes beyond reviewer requests
- On failure: Return to ANALYZE phase, never skip comments

User: the current user request
