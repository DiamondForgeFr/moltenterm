---
name: merge
description: Bring the current ticket branch up to date with the project's pull request target branch (workflow.prTargetBranch) and resolve the conflicts that have a deterministic answer. Use before opening a pull request or when it reports conflicts. Not for merging a pull request, which a human does on the forge.
allowed-tools: Bash(git :*), Bash(jq :*), Bash(npm :*), Read, Edit
---

# Merge

Rebase the ticket branch on the pull request target branch, resolve what has one right answer, and hand back everything else.

## Context

- Current branch: !`git branch --show-current`
- Working tree status: !`git status --short`
- Target branch: !`jq -r '.workflow.prTargetBranch // .workflow.workingBranch // empty' .saasfoundry.json 2>/dev/null`

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

User: $ARGUMENTS
