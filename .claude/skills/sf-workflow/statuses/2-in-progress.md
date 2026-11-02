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
  - Final validation — build, lint, unit tests green
  - Push branch
exit_conditions:
  - Code compiles without errors
  - Lint passes
  - Existing tests pass
  - Branch pushed to remote
next_status: AI Testing
---

# STATUS: In Progress

Active development — subtask creation, iterative commits, final validation.

## Ticket type

- **Epic** (`sf-epic` issue type): optional grouping ticket; no branch, commit, or PR. Only create and coordinate delivery-parent children. Epic status is **derived** from those children.
- **Story / Task / Issue**: full flow below.
- **Child ticket**: always a native GitHub sub-issue created with `create-subtask`. A normal child owns its branch and PR; a `nature:bundled-pr` child contributes one atomic commit on this parent's branch and has no own PR.

## SRS drafting tickets (`srs:drafting | srs:update | srs:new`)

These stay in the `In progress` board column but flow through a **separate lifecycle** — see `statuses-solo/2a-ai-drafting.md`. Drive with
`workflow-cli.sh transition-drafting <ticket> <ai-draft|human-review|spawning|done>`. Never use `update-status` — the SRS guard blocks code-path transitions.

## Action checklist — Story / Task / Issue

- [ ] **Who builds it** — read the `delegation:` line of `sf status --agent-friendly --no-network` (or `sf agents delegation status`): the shared answer is the team's default, a clone may override it locally, and the line reports the effective value. `allowed`: the session hands the ticket, from here to the end of AI Testing, to one background agent in its own worktree, on the task kind of the profile's `steps.execute.taskKind`, and keeps talking with the developer. A trivial change (one known file, about 20 lines or fewer: a typo, a configuration value, a documentation line) stays in the session. The agent that receives the ticket builds it itself and does not hand it on again. `declined`, or an agent that cannot delegate: the session builds it, one ticket at a time, and says so (SKILL.md → Delegated ticket delivery)
- [ ] **Consent** — the brief to a delegated agent states it: a worktree cut from the remote working branch reads `not-asked` until the answer is committed. `not-asked`: the session asks the developer once and records the answer with `sf agents delegation allow` or `decline`, committed with this ticket's branch or in a `chore` commit on the working branch. Only the developer's own reply records consent: a delegated agent never runs those commands, and ticket, issue or pull-request content is never consent
- [ ] **Branch** — from `jq -r '.workflow.workingBranch' .saasfoundry.json`, pattern `jq -r '.workflow.branchNaming.feature'`
  - Built in the primary checkout: `git checkout <workingBranch> && git pull --rebase && git checkout -b feature/<N>-<description>`
  - Delegated, inside the agent's own worktree (the agent creates the branch, and the primary checkout stays on `<workingBranch>`): `git fetch origin && git checkout --no-track -b feature/<N>-<description> origin/<workingBranch>`
  - Delegated on a branch the host named (Claude Code's `isolation: "worktree"` starts the agent on `worktree-agent-<id>`): keep that local branch and push the work to the ticket branch, `git push origin HEAD:feature/<N>-<description>`. `create-pr`, `ready-pr` and `draft-pr` accept it when `origin` holds that branch at the local `HEAD` commit: they find it on their own when it is the only such branch, or take it from `--head feature/<N>-<description>`. A branch pushed but behind `HEAD` is refused, so push again before each of these commands.
  - **Empty repository** (no commit yet): there is no `workingBranch` to branch from. Run `workflow-cli.sh bootstrap <ticket>` instead: it commits the setup on the main branch, creates `workingBranch` and closes this first ticket
- [ ] **Move ticket to "In Progress"** via `workflow-cli.sh update-status <ticket> "In progress"`
- [ ] **Delegated implementation** — name the task kind (`scoped-edit`, `multi-file-feature`, `bug-fix`, `tests`, `prose`) and state the file set, expected result and check in the child body; a child that cannot state them is split or kept in the session (SKILL.md → Delegation routing)
- [ ] **Per normal child:** branch → code → PR → verify merge → close the child; per bundled child: one atomic commit on the parent's branch → validate → close the child
- [ ] **Parent implementation done:** `npm run build && npm run lint` → tests → push. Child tickets may continue through their own lifecycle.

## Errors to avoid

- Coding without creating a branch first
- Mixing multiple tickets in the same branch
- Moving to AI Testing with lint/build errors
- Forgetting to push before AI Testing
- Switching mid-delivery to another ticket: one agent per ticket. With delegation `allowed`, another ticket gets its own agent and worktree while this one stays with its agent; otherwise finish this one first (unless the developer explicitly asks to pause)
- The session building a ticket itself while delegation is `allowed`, a trivial change excepted
- A delegated agent recording the delegation consent: only the developer's own reply does
