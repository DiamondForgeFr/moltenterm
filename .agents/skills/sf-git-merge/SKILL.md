---
name: sf-git-merge
description: "Bring the current ticket branch up to date with the project's pull request target branch (workflow.prTargetBranch) and resolve the conflicts that have a deterministic answer. Use before opening a pull request or when it reports conflicts. Not for merging a pull request, which a human does on the forge."
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

Rebase the ticket branch on the pull request target branch, resolve what has one right answer, and hand back everything else.

## Context

- Current branch: run `git branch --show-current` and read its output
- Working tree status: run `git status --short` and read its output
- Target branch: run `jq -r '.workflow.prTargetBranch // .workflow.workingBranch // empty' .saasfoundry.json 2>/dev/null` and read its output

## Workflow

1. **Check**: the working tree is clean and the current branch is a ticket branch, not the target branch itself. Otherwise stop and say why.
2. **Target**: `TARGET=$(jq -r '.workflow.prTargetBranch // .workflow.workingBranch // empty' .saasfoundry.json)`. Without a manifest, ask which branch to target; never assume `main`.
3. **Fetch and rebase**: `git fetch origin "$TARGET"` then `git rebase "origin/$TARGET"`.
4. **For each conflicted file** (`git diff --name-only --diff-filter=U`), apply the first rule that fits:
   - **Lockfile** (`package-lock.json`): take the target's version with `git checkout --ours -- package-lock.json` (during a rebase, _ours_ is the target and _theirs_ the commit being replayed), then `npm install --package-lock-only`, then `git add`.
   - **Generated file** the project can rebuild (a codegen output, a built client): take the target's version with `git checkout --ours -- <file>`, rerun its generator, then `git add`.
   - **Both sides add distinct entries** to the same list (imports, exports, routes, translation keys) with no overlapping line edited: keep both, then `git add`.
   - **Anything else**: stop. Run `git rebase --abort`, list the conflicted files with the two competing versions of each hunk, and hand back to the developer.
5. **Verify**: no conflict marker remains (`git diff --check`), then `git rebase --continue` until the rebase ends.
6. **Publish**: `git push --force-with-lease`. Never a plain `--force`.

## Rules

- Never merge a pull request, and never push to the target branch.
- Never resolve a conflict in source code by picking a side: that is the developer's call.
- Never stage a file that still holds conflict markers.
- One rebase attempt. If it has to be aborted, report and stop; do not retry with other strategies.

User: the current user request
