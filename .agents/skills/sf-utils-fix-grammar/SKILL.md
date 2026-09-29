---
name: sf-utils-fix-grammar
description: "Fix grammar and spelling errors in one or multiple files while preserving formatting"
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



# Fix Grammar

Fix grammar and spelling errors in files while preserving formatting and meaning.

## Workflow

1. **PARSE FILES**: Split arguments into individual file paths
   - **STOP** if no files specified - ask user for file paths

2. **DETERMINE STRATEGY**:
   - **Single file**: Process directly
   - **Multiple files**: Launch parallel fix-grammar agents

3. **SINGLE FILE MODE**:
   - `Read` the file completely
   - Apply grammar and spelling corrections
   - `Edit` to update file with corrections

4. **MULTIPLE FILES MODE**:
   - Use native delegation when available (otherwise execute the same work sequentially) to launch fix-grammar agent for each file
   - Process all files simultaneously
   - Wait for all agents to complete

5. **REPORT**: Show files processed and confirm corrections

## Correction Rules

- Fix ONLY spelling and grammar errors
- **DO NOT** change meaning or word order
- **DO NOT** translate anything
- **DO NOT** modify special tags (MDX, custom syntax, code blocks)
- **PRESERVE**: All formatting, structure, technical terms
- Remove any `"""` markers if present
- Keep the same language used in each sentence
- Handle multilingual content (keep anglicisms, technical terms)

## Output Format

```
✓ Fixed grammar in [filename]
- [number] corrections made
```

## Rules

- ONLY spelling and grammar corrections
- PARALLEL processing for multiple files
- PRESERVE everything: formatting, structure, technical terms
- MINIMAL changes - corrections only, no improvements
- Never add explanations or commentary to file content

User: the current user request
