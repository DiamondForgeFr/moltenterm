---
name: sf-git-fix-pr-comments
description: "Fetch the unresolved review threads and reviews of a PR, implement the requested changes, then reply on each thread and resolve the ones that are fixed"
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
model or an effort yourself. The one exception is a route that prints `alias <name>` (Kimi Code
binds no model in an agent file): pass that alias, copied from the route and never composed, as
the `model` of the delegation call. When the route fails or the agent cannot delegate, run the
step in the session: a refused or failed route is never worked around by starting another coding
agent's CLI (`claude`, `codex`, or any other) or a background session of another host, and a host
with no worktree support delegates sub-tasks only, through its own native sub-agent tool.
Never bypass CLI guards, required approvals, tests or workflow status exit conditions.
An escape hatch is the developer's to apply: when a guard refuses, report it and ask; a hook
refuses an agent call that sets one.
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

# Fix PR Comments

Systematically address ALL unresolved review comments, then answer the reviewer on each one.

## Context

- Current branch: run `git branch --show-current` and read its output
- Working tree status: run `git status --short` and read its output
- Recent commits: run `git log --oneline -3` and read its output

## Where this fits in the workflow

Answering the reviewer and resolving the conversations is part of **In Review** ("answer reviewer comments", "resolve conversation" in the status document). This skill only changes review threads and
posts comments on the PR: it never merges, never approves, never takes a PR out of draft (`ready-pr`) and never moves a ticket. Ticket and board changes stay with `workflow-cli.sh`. On a delegated
ticket, the agent that made the fix posts the replies when its brief hands it the review; otherwise it reports each thread with its commit and the session posts them.

Every command below is one plain command per call: no `&&`, no `;`, no `$(…)`. A GraphQL document is written to a scratch file outside the working tree with the Write tool, then passed with
`-F query=@<file>`. `{owner}` and `{repo}` are filled in by `gh` from the current repository.

## Workflow

1. **FETCH COMMENTS**:
   - Identify the PR of the current branch: `gh pr view --json number,headRefName,url`. STOP if no PR is found: ask the user for the PR number, and pass it to every `gh pr` command below.
   - Write this query to `<scratch>/review-threads.graphql`:

     ```graphql
     query ($owner: String!, $repo: String!, $number: Int!, $endCursor: String) {
       repository(owner: $owner, name: $repo) {
         pullRequest(number: $number) {
           reviewThreads(first: 50, after: $endCursor) {
             pageInfo {
               hasNextPage
               endCursor
             }
             nodes {
               id
               isResolved
               isOutdated
               path
               line
               comments(first: 50) {
                 nodes {
                   databaseId
                   body
                   author {
                     login
                   }
                 }
               }
             }
           }
         }
       }
     }
     ```

   - List the unresolved threads (the inline comments), every page:

     ```bash
     gh api graphql --paginate -F owner='{owner}' -F repo='{repo}' -F number=<N> -F query=@<scratch>/review-threads.graphql --jq '.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved | not)'
     ```

   - List the reviews (the review-level comments, with their state): `gh pr view <N> --json reviews,comments`. A `CHANGES_REQUESTED` review, or a review or PR comment with a body that asks for
     something, is addressed like a thread.
   - A resolved thread is done: skip it. An outdated thread (`isOutdated`) is still open: check the current code before deciding it no longer applies.

2. **ANALYZE & PLAN**:
   - Extract exact file:line references (`path`, `line`; `line` is null on an outdated thread)
   - Group by file for MultiEdit efficiency
   - STAY IN SCOPE: NEVER fix unrelated issues
   - Create checklist: one item per thread or review comment, keeping its thread `id`

3. **IMPLEMENT FIXES**:
   - BEFORE editing: ALWAYS `Read` target file first
   - Batch changes with `MultiEdit` for same-file modifications
   - Make EXACTLY what reviewer requested
   - Check off each resolved comment, or write down why it was not applied

4. **COMMIT & PUSH**:
   - Stage: `git add -A`
   - Commit: `fix(#<N>): address PR review comments`, in the project's commit format (`workflow.commitFormat` in `.saasfoundry.json`), with `<N>` the ticket of the PR branch (`feature/<N>-…`, `fix/<N>-…`). Without a configured format: `fix: address PR review comments`
   - Push: `git push`
   - Note the pushed commit: `git rev-parse --short HEAD`
   - NEVER include co-author tags

5. **REPLY & RESOLVE** (after the push, so the commit the replies name is on the PR):
   - Write the replies in the project's ticket language: `jq -r '.language.tickets // "en"' .saasfoundry.json`
   - Write these two mutations to `<scratch>/reply-thread.graphql` and `<scratch>/resolve-thread.graphql`:

     ```graphql
     mutation ($thread: ID!, $body: String!) {
       addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $thread, body: $body }) {
         comment {
           url
         }
       }
     }
     ```

     ```graphql
     mutation ($thread: ID!) {
       resolveReviewThread(input: { threadId: $thread }) {
         thread {
           isResolved
         }
       }
     }
     ```

   - For each thread: write its reply to `<scratch>/reply-<n>.md` (what changed and the commit SHA, or the reason it was not applied), then post it in the thread:

     ```bash
     gh api graphql -F thread=<thread id> -F body=@<scratch>/reply-<n>.md -F query=@<scratch>/reply-thread.graphql
     ```

   - Resolve a thread only when the fix is complete and pushed. A comment not applied, applied in part, or answered with a question stays open for the reviewer:

     ```bash
     gh api graphql -F thread=<thread id> -F query=@<scratch>/resolve-thread.graphql
     ```

   - Review-level comments have no thread: answer them in one PR comment, `gh pr comment <N> --body-file <scratch>/reply-reviews.md`
   - Check that nothing is left: rerun the thread listing of step 1; only the threads deliberately left open remain

## Rules

- Every unresolved comment MUST be addressed: fixed, or answered with the reason it was not applied
- Every addressed thread gets a reply; only a complete, pushed fix resolves it
- Read files BEFORE any edits - no exceptions
- FORBIDDEN: Style changes beyond reviewer requests
- FORBIDDEN: merging, approving, `ready-pr`, or changing a ticket's status from this skill
- On failure: Return to ANALYZE phase, never skip comments

User: the current user request
