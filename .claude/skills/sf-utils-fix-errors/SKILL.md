---
name: fix-errors
description: Fix all ESLint and TypeScript errors with parallel processing using snipper agents
allowed-tools: Bash(npm :*), Bash(npx :*), Read, Task, Grep
---

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
   - Use Task tool with multiple agents simultaneously
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
- PARALLEL ONLY - use Task tool for concurrent processing
- Every error must be assigned to an area

User: $ARGUMENTS
