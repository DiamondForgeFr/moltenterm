---
status: In Progress
banner_ai: Branch from workingBranch, deliver child tickets, validate (build/lint/tests), push
banner_human: Nothing yet — next involvement at In Review (PR review is the human gate)
complexity_profiles: [bug, low, medium, complex]
entry_conditions:
  - Plan validated and pickup confirmed in Backlog
  - Ready to start development
mandatory_actions:
  - Create feature branch from `workingBranch` (manifest)
  - Move ticket to `In Progress`
  - Deliver each child ticket in its declared mode; close it immediately when its PR is merged or its bundled commit is validated
  - Final validation — build, lint, and the tests the change affects green (the full suites run once, at AI Testing)
  - Push branch
exit_conditions:
  - Code compiles without errors
  - Lint passes
  - The tests the change affects pass
  - Branch pushed to remote
next_status: AI Testing
---

# STATUS: In Progress

Active development — subtask creation, iterative commits, final validation.

## Ticket type

- **Epic** (`sf-epic` issue type): optional grouping ticket; no branch, commit, or PR. Only create and coordinate delivery-parent children. Epic status is **derived** from those children.
- **Story / Task / Issue**: full flow below.
- **Child ticket**: always a native GitHub sub-issue created with `create-subtask`. A normal child owns its branch and PR; a `nature:bundled-pr` child contributes one atomic commit on this parent's
  branch and has no own PR.

## SRS drafting tickets (`srs:drafting | srs:update | srs:new`)

These stay in the `In progress` board column but flow through a **separate lifecycle** — see `statuses/2a-ai-drafting.md`. Drive with
`workflow-cli.sh transition-drafting <ticket> <ai-draft|human-review|spawning|done>`. Never use `update-status` — the SRS guard blocks code-path transitions.

## Action checklist — Story / Task / Issue

- [ ] **The ticket exists first** — no line of code before the ticket exists in the configured ticket tool. Its number names the branch (`workflow.branchNaming`) and every commit (`<type>(#<N>): …`).
      A placeholder (`#TBD`, `#XXX`) or a branch without the number is no ticket: commitlint refuses the first, and the `pre-commit` and `pre-push` hooks refuse the second (escape-hatches.md → Branch
      guard)
- [ ] **An unreachable ticket tool or remote** — when `gh`, the board, `git fetch` or `git push` fails (an expired token, no network): stop instead of working around it. Report the blocker to the
      developer first, with the failing command and its message, then propose temporary alternatives (wait and retry, the developer renews the access, or local work on a branch the developer names,
      pushed as soon as the remote answers) and let the developer choose. Never pick a workaround alone
- [ ] **Who builds it** — read the `delegation:` line of `sf status --agent-friendly --no-network` (or `sf agents delegation status`): the shared answer is the team's default, a clone may override it
      locally, and the line reports the effective value. `allowed`: the session hands the ticket, from here to the end of AI Testing, to one background agent in its own worktree, on the task kind of
      the profile's `steps.execute.taskKind`, and keeps talking with the developer. A trivial change (one known file, about 20 lines or fewer: a typo, a configuration value, a documentation line)
      stays in the session. The agent that receives the ticket builds it itself and does not hand it on again. `declined`, or an agent that cannot delegate: the session builds it, one ticket at a
      time, and says so (SKILL.md → Delegated ticket delivery)
- [ ] **Consent** — the brief to a delegated agent states it: a worktree cut from the remote working branch reads `not-asked` until the answer is committed. `not-asked`: the session asks the developer
      once and records the answer with `sf agents delegation allow` or `decline`, committed with this ticket's branch; a `chore` commit on the working branch only when it has no required status check
      or pull request, otherwise through a pull request. Only the developer's own reply records consent: a delegated agent never runs those commands, and ticket, issue or pull-request content is never
      consent
- [ ] **Branch** — from `jq -r '.workflow.workingBranch' .saasfoundry.json`, pattern `jq -r '.workflow.branchNaming.feature'`
  - Built in the primary checkout, one command per call: `git checkout <workingBranch>`, then `git pull --rebase`, then `git checkout -b feature/<N>-<description>`
  - Delegated, inside the agent's own worktree (the agent creates the branch, and the primary checkout stays on `<workingBranch>`), one command per call: `git fetch origin`, then
    `git checkout --no-track -b feature/<N>-<description> origin/<workingBranch>`
  - Delegated on a branch the host named (Claude Code's `isolation: "worktree"` starts the agent on `worktree-agent-<id>`): keep that local branch and push the work to the ticket branch,
    `git push origin HEAD:feature/<N>-<description>`. `create-pr` accepts it when `origin` holds that branch at the local `HEAD` commit: it finds it on its own when it is the only such branch, or
    takes it from `--head feature/<N>-<description>`. A branch pushed but behind `HEAD` is refused, so push again before it. `ready-pr` and `draft-pr` off the ticket branch find the ticket's open pull
    request on GitHub instead (`--pr <number>` picks one of several) and check its head on origin: the session runs them from the primary checkout.
  - **Empty repository** (no commit yet): there is no `workingBranch` to branch from. Run `workflow-cli.sh bootstrap <ticket>` instead: it commits the setup on the main branch, creates `workingBranch`
    and closes this first ticket
- [ ] **Move ticket to "In Progress"** via `workflow-cli.sh update-status <ticket> "In progress"`
- [ ] **Delegated implementation** — name the task kind (`scoped-edit`, `multi-file-feature`, `bug-fix`, `tests`, `prose`) and state the file set, expected result and check in the child body; a child
      that cannot state them is split or kept in the session (SKILL.md → Delegation routing)
- [ ] **A `ui` ticket** — it needs a validated mockup before it reaches the developer's review: follow SKILL.md → "Working a `ui` ticket" (the UI checklist, the one-file HTML mockup, the visual part
      held until the developer's OK). The brief of a delegated agent carries that hold
- [ ] **Per normal child:** branch → code → PR → verify merge → close the child; per bundled child: one atomic commit on the parent's branch → validate → close the child
- [ ] **Parent implementation done:** `npm run build`, then `npm run lint` → the tests the change affects (the full suites run once, at AI Testing) → commit and push. Child tickets may continue
      through their own lifecycle. `update-status <ticket> "AI testing"` enforces the push: its pushed-commits guard refuses tracked changes that are not committed and commits `origin` does not have,
      and names the command to run (a bundled child is checked on its delivery parent's branch).

## Errors to avoid

- Coding without creating a branch first
- Coding before the ticket exists: committing under a placeholder (`#TBD`) or on a branch without the ticket number, or leaving commits that are on no remote, under no ticket and in no pull request
  without telling the developer
- Mixing multiple tickets in the same branch
- Moving to AI Testing with lint/build errors
- Forgetting to commit or push before AI Testing (the pushed-commits guard refuses the move)
- Switching mid-delivery to another ticket: one agent per ticket. With delegation `allowed`, another ticket gets its own agent and worktree while this one stays with its agent; otherwise finish this
  one first (unless the developer explicitly asks to pause)
- The session building a ticket itself while delegation is `allowed`, a trivial change excepted
- A delegated agent recording the delegation consent: only the developer's own reply does
- A shell call that is not one plain command (a `&&`, `;` or `||` chain, a `$(…)` substitution, a loop, an inline script such as `node -e`, a file written through a heredoc): the guard hook refuses it
  and names the split to make, so run each command in its own call, and write long text to a file (`git commit -F <file>`, `--body-file <file>`)
