---
name: create-pr
description: Create and push PR with auto-generated title and description
model: haiku
allowed-tools: Bash(git :*), Bash(gh :*)
---

# Create PR

Create pull request with concise, meaningful description.

## Context

- Current branch: !`git branch --show-current`
- Working tree status: !`git status --short`
- Recent commits: !`git log --oneline -5`
- Remote tracking: !`git rev-parse --abbrev-ref @{upstream} 2>/dev/null || echo "none"`

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

User: $ARGUMENTS
