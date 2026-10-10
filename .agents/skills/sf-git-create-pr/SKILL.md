---
name: sf-git-create-pr
description: "Create and push PR with auto-generated title and description"
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



# Create PR

Create pull request with concise, meaningful description.

## Context

- Current branch: run `git branch --show-current` and read its output
- Working tree status: run `git status --short` and read its output
- Recent commits: run `git log --oneline -5` and read its output
- Remote tracking: run `git rev-parse --abbrev-ref @{upstream} 2>/dev/null || echo "none"` and read its output

## Configured SaaSFoundry workflow

When `.saasfoundry.json` configures a workflow, read `sf-workflow` and use its guarded CLI: `create-pr <ticket> --draft` for Human Testing, then `ready-pr <ticket>` after approval and required tests. Internal/solo routes can create a ready PR directly. Follow configured branch names. The generic flow below only applies without a configured workflow.

## Workflow

1. **Verify**: Check `git status` and current branch
2. **Branch Safety**: **CRITICAL** - If on main/master, create descriptive branch from changes
3. **Push**: `git push -u origin HEAD`
4. **Base branch**: `BASE=$(jq -r '.workflow.prTargetBranch // .workflow.workingBranch // empty' .saasfoundry.json 2>/dev/null)`; without a manifest, `BASE=$(gh repo view --json defaultBranchRef --jq .defaultBranchRef.name)`
5. **Analyze**: `git diff "origin/$BASE...HEAD" --stat`
6. **Generate PR**:
   - Title: One-line summary (max 72 chars)
   - Body: Bullet points of key changes
7. **Submit**: `gh pr create --base "$BASE" --title "..." --body "..."`
8. **Return**: Display PR URL

## PR Format

```markdown
## Summary

• [Main change or feature]
• [Secondary changes]
• [Any fixes included]

## Type

[feat/fix/refactor/docs/chore]
```

## Rules

- NO verbose descriptions
- NO "Generated with" signatures
- Target `$BASE` from step 4, never a hardcoded `main`
- Use HEREDOC for multi-line body
- If PR exists, return existing URL

User: the current user request
