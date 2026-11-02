---
name: sf-utils-fix-errors
description: "Fix all ESLint and TypeScript errors with parallel processing using snipper agents"
---

## Execution capabilities

Use the current agent's native tools for reading, editing, shell commands and delegation.
When delegation is available and authorized, assign independent work to agents; otherwise
execute the same steps sequentially. A sequential self-review is not an independent review:
report that limitation and retain any required human review. Tool names in legacy examples
describe capabilities, not required APIs. Use the user's current request as skill arguments.
Do not assume Claude Code hooks, tool permissions or credentials transfer.
Run preconditions explicitly, and stop to report a missing capability when no equivalent exists.
When a workflow step names a task kind, resolve its tier with
`sf agents route --task <kind> --provider <current-agent>` and delegate the step to the
`sf-<tier>` agent it names: that agent carries its own model and effort, so never name a
model or an effort yourself. When the route fails or the agent cannot delegate, run the step
in the session.
Never bypass CLI guards, required approvals, tests or workflow status exit conditions.
The project manifest and workflow rules take precedence over generic skill examples,
including branch names, commit formats, staging, pushing and approval requirements.
Legacy /task examples name roles: use native delegation if available and authorized,
or perform the role's work sequentially with the review limitation stated above.

Who builds a ticket, and the consent behind it, follow "Session orchestration and delegated ticket delivery" in the project instructions (`AGENTS.md`); read the `delegation:` line of `sf status --agent-friendly --no-network`.

## Parallel implementation and Git worktrees

Open a worktree per ticket when the recorded delegation is `allowed`, or when the developer
asks for parallel work, and only for independent writing streams that can be delivered
concurrently. Read-only exploration and review may use parallel agents without separate
worktrees. Work with sequential dependencies, overlapping file ownership or unclear boundaries
must use one feature worktree and sequential execution.

Before opening a worktree, read `.saasfoundry.json` and use
`workflow.workingBranch`; never hardcode a branch name. Keep the primary checkout on that
configured working branch. Do not let feature workers write in the primary checkout while
parallel worktrees are active.

For each independent writing stream, define one ticket, branch and worktree path, plus its owned
files and dependency boundary. Start from a synchronized configured working branch. Each worker
must stay inside its assigned worktree and ownership boundary, preserve other agents' changes
and never revert unrelated work. The recorded delegation authorizes ticket delivery only: for
any other parallel writing stream, and for tickets when it is not `allowed` or the current
request says otherwise, propose this execution shape and wait for the answer. If clean
separation, Git support or a synchronized base is unavailable, explain the constraint and use
one worktree or sequential execution.

After each stream is complete, commit and push through the configured workflow. After its merge,
return to the primary checkout, check out and synchronize the configured working branch, verify
the merge, then remove the completed worktree and local branch only when they are merged and no
longer in use. Never remove or overwrite user-owned worktrees, branches, uncommitted changes,
stashes or credentials implicitly.

# Fix Errors

Fix all ESLint and TypeScript errors by breaking them into areas and processing in parallel.

## Workflow

1. **DISCOVER COMMANDS**: `npm pkg get scripts` lists the exact script names of the package you are in
   - Use the scripts it returns (`lint`, `typecheck`, `type-check`, `format`, …); never guess a name it does not list
   - In an npm workspace, run them from the package that declares them, or with `npm run <script> -w <workspace>`

2. **RUN DIAGNOSTICS**:
   - Run `npm run <lint script>`
   - Run `npm run <typecheck script>`, or `npx tsc --noEmit` when no such script exists
   - Capture all error output

3. **ANALYZE ERRORS**:
   - Extract file paths from error messages
   - Group errors by file location
   - Count total errors and affected files

4. **CREATE ERROR AREAS**:
   - **MAX 5 FILES PER AREA**
   - Group related files together (same directory/feature)
   - Example: `Area 1: [file1, file2, file3, file4, file5]`

5. **PARALLEL PROCESSING**: Launch snipper agents for each area
   - Use native delegation when available (otherwise execute the same work sequentially) with multiple agents simultaneously
   - Each agent processes one area (max 5 files)
   - Provide specific error details for each file

6. **VERIFICATION**: Re-run diagnostics after fixes
   - Wait for all agents to complete
   - Re-run lint and typecheck
   - Report remaining errors

7. **FORMAT CODE**: Apply Prettier (if available)
   - Run `npm run <format script>` when one exists

## Snipper Agent Instructions

```
Fix all ESLint and TypeScript errors in these files:
[list of files with their specific errors]

Focus only on these files. Make minimal changes to fix errors while preserving functionality.
```

## Rules

- ALWAYS check package.json first for correct commands
- ONLY fix linting and TypeScript errors
- NO feature additions - minimal fixes only
- Prefer parallel delegation when available; otherwise execute sequentially - use native delegation when available (otherwise execute the same work sequentially) for concurrent processing
- Every error must be assigned to an area

User: the current user request
