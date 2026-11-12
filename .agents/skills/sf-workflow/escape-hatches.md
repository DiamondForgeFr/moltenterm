# Workflow escape hatches

The workflow guards refuse a transition or a command when an entry condition, an exit condition or a piece of external proof is missing. A refusal is evidence, not an obstacle: the first move is
always to supply what is missing (label the ticket, open the PR, wait for the merge, run the local CI). An escape hatch exists for the narrow case where the guard is wrong or cannot be satisfied, and
it must leave a trace a reviewer can find.

This file lists every hatch the workflow scripts accept, what each one switches off, when using it is legitimate, when it is not, and what record to leave.

## Ground rules

1. **Fix the condition first.** Every guard message says how. If the fix takes minutes, do it instead of bypassing.
2. **An agent never sets a hatch on its own, and a hook enforces it.** It stops, reports the refused transition and the guard message, and asks the developer. A `PreToolUse` hook refuses the Bash call
   of an agent that sets a hatch, passes `--skip-local-ci` or labels the nature of its own ticket, and the scripts refuse the same inside the worktree of a delegated agent (see "Who applies a hatch,
   and the guard hook"). The developer's explicit instruction is what authorizes a hatch, and the developer is who applies it.
3. **Scope it to one command, and let the developer run it.** The variable is set inline for the single command that needs it, never with `export` and never in a shell profile or a CI job. In Claude
   Code the developer types the command in the session with a leading `!`, from the primary checkout: it runs directly, without going through the agent's Bash tool and its hook, and its output joins
   the conversation. On any host the developer's own terminal does the same:

   ```bash
   ! SF_WORKFLOW_BYPASS_PR_MERGED_GUARD=1 SF_WORKFLOW_BYPASS_REASON="hotfix a1b2c3d pushed directly" \
     .claude/skills/sf-workflow/workflow-cli.sh update-status 42 Done
   ```

4. **The environment hatches announce themselves.** When `update-status` finds a `SF_WORKFLOW_BYPASS_*` variable set to `1`, it prints a warning naming it and posts a ticket comment listing the
   variables and `SF_WORKFLOW_BYPASS_REASON` (or "no reason given"). That comment is the minimum; complete it with the evidence (template below) and, when a pull request exists, one line in its body.
   If the comment cannot be posted, the warning says so and the transition goes on: record it by hand.
5. **Value is exactly `1`.** `SF_WORKFLOW_BYPASS_*` variables are honored only when set to `1`.
6. **Never bypass the CLI itself.** Editing the board by hand, or calling `gh project item-edit` or a raw GraphQL mutation, is not a hatch: it skips every guard at once and leaves no trace. A rejected
   transition is never fixed that way.
7. **The automated listener ignores them.** The pull-request listener (`sync-pr-review`: Ready for review and merge events) runs `update-status` with every `SF_WORKFLOW_BYPASS_*` variable cleared, so
   a variable present in a CI environment never reaches it.

Guards run in this order on `update-status`: SRS, complexity, Epic derived status, nature, incomplete children, bundled-PR parent, pushed commits, PR existence, local CI, PR merged. A refusal exits
with code `2`.

## Quick reference

| Hatch                                       | Switches off                                                        | Applies to                                                                                 |
| ------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `SF_WORKFLOW_BYPASS_SRS_GUARD=1`            | SRS drafting guard (`srs:*` tickets stay off the code path)         | `update-status` to AI testing, Human testing, In review                                    |
| `SF_WORKFLOW_BYPASS_COMPLEXITY_GUARD=1`     | Complexity label required                                           | `update-status` to any status except Backlog                                               |
| `SF_WORKFLOW_BYPASS_NATURE_GUARD=1`         | Nature axis (Human testing / In review routing)                     | `update-status` from AI testing to In review or Done                                       |
| `SF_WORKFLOW_BYPASS_CHILDREN_GUARD=1`       | Parent Done requires every native child Done                        | `update-status` to Done                                                                    |
| `SF_WORKFLOW_BYPASS_BUNDLED_PARENT_GUARD=1` | Bundled-PR child must have a verified, non-Epic native parent       | `update-status` to Done for `nature:bundled-pr` tickets                                    |
| `SF_WORKFLOW_BYPASS_PUSHED_GUARD=1`         | Ticket work committed and pushed to origin                          | `update-status` to AI testing                                                              |
| `SF_WORKFLOW_BYPASS_PR_EXISTENCE_GUARD=1`   | Matching open PR (draft or ready) required                          | `update-status` to Human testing or In review                                              |
| `SF_WORKFLOW_BYPASS_PR_MERGED_GUARD=1`      | Verified merged PR required                                         | `update-status` to Done                                                                    |
| `--bypass-srs <reason>`                     | Rule 8: SRS-enabled projects spawn tickets from drafted SRS pages   | `create-ticket`, `create-subtask`, `create-epic`                                           |
| `--bypass-reason <text>`                    | Sets the `--bypass-srs` reason the SRS spawner passes (not a guard) | `srs-cli.sh spawn`, `transition-drafting <t> spawning`                                     |
| `--skip-local-ci "<reason>"`                | Local CI statuses green on the head commit                          | `create-pr` (not draft), `ready-pr`, `local-ci-gate`, and `update-status` to Human testing |
| `SF_CACHE_BUST=1`                           | Nothing: refetches the cached board schema                          | any `github-projects-cli.sh` command that reads the board                                  |
| `SF_DISABLE_SRS_HOOK=1`                     | Nothing: silences the SRS intent-detector reminder                  | the `UserPromptSubmit` hook of the `sf-srs` skill                                          |

The Epic derived-status guard (an aggregate Epic cannot enter AI testing, Human testing or In review) has no hatch: an Epic's status is derived from its children, there is nothing to skip.

## Record to leave

`update-status` posts a short comment for every `SF_WORKFLOW_BYPASS_*` variable it honours, and `--bypass-srs` / `--skip-local-ci` record their reason. For every hatch that switches a guard off,
complete that record with a ticket comment before or right after the command:

```text
Escape hatch used: <hatch> on #<ticket> -> <target status or command>
Guard message: <the refusal, one line>
Why it applies: <what is true that the guard cannot see>
Evidence: <PR URL, commit SHA, link, screenshot of the board>
Follow-up: <what restores the normal state, or "none">
```

When a pull request exists, add `Escape hatch: <hatch> (#<ticket>), see ticket comment` to its body. Commit messages need no mention unless the hatch changed what the commit does.

## Who applies a hatch, and the guard hook

An escape hatch is the developer's decision, and so is every choice a guard protects: whether a ticket skips Human testing, whether a pull request is ready, whether it merges. A refusal tells the
agent what is missing and what to run next. It does not tell it how to get past the guard, and a hook refuses the agent that tries anyway.

### What the hook refuses

A `PreToolUse` hook runs before each Bash call (and each PowerShell call on Claude Code) and asks `sf agents guard` whether the command is one of these. The hook is part of the harness: `sf new`,
`sf update` and `sf agents refresh` write it into `.claude/settings.json` (Claude Code) and `.codex/hooks.json` (Codex). It refuses for everyone, the main session as well as a delegated agent:

| The call          | What is refused                                                                                                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A bypass variable | A `SF_WORKFLOW_BYPASS_<X>=…` assignment in front of a command, in `export`, `declare -x`, `env`, `bash -c '…'` or `eval`. The reason variable alone, and the name as a plain argument, are not refused |
| The local CI skip | `--skip-local-ci` given to `workflow-cli.sh` or `github-projects-cli.sh`                                                                                                                               |
| A nature label    | `nature:internal` or `nature:bundled-pr` put on a ticket with `gh issue edit` or `gh api`. Removing `nature:user-facing`, and reading labels, are allowed                                              |

and, only for a **delegated agent** (an `agent_id` in the tool event, or a working directory, `cd` or `git -C` under `.claude/worktrees/` or `.codex/worktrees/`):

| The call                    | What is refused                                                              |
| --------------------------- | ---------------------------------------------------------------------------- |
| The delegation consent      | `sf agents delegation allow`, `decline` or `clear`                           |
| A pull request marked ready | `ready-pr` of either script, and `gh pr ready` (`--undo` is allowed)         |
| A merge                     | `gh pr merge`, and `gh api …/pulls/<n>/merge`                                |
| A nature at creation        | `github-projects-cli.sh create-ticket … --nature internal` (or `bundled-pr`) |

The same calls from the primary checkout are allowed: the session and the developer run them. Every refusal says why and what to do instead (stop, report, ask the developer).

### How the developer applies a hatch

1. **Claude Code: `! <command>`**, typed in the session from the primary checkout. The command runs directly, without going through the Bash tool, so no hook fires, and its output joins the
   conversation. The script still announces the hatch on the ticket.
2. **Any host: the developer's own terminal**, at the root of the primary checkout. `update-status` and `local-ci-gate` find the ticket's worktree or pull request from there.
3. **Nature labels:** the developer adds `nature:internal` or `nature:bundled-pr` on GitHub, or with `!` in Claude Code. At triage, the session's `create-ticket … --nature internal` in the primary
   checkout stays allowed.
4. **Delegation consent, `ready-pr` and merge:** from the primary checkout, by the session or the developer.

### Limits

The hook is a guardrail against the ordinary path the refusals used to teach, not a security boundary.

- **It reads the command the agent wrote**, not what a script does. A bypass written into a script file that is then run or sourced, built through a variable, or decoded at run time is not seen.
  `update-status` still announces every hatch it honours on the ticket, so an evasion is visible, and the scripts refuse a hatch, `--skip-local-ci` and `ready-pr` themselves when they run in the
  worktree of a delegated agent: the developer runs those from the primary checkout.
- **It covers the Bash tool** (and PowerShell). A GitHub MCP tool that adds a label, or a raw GraphQL mutation sent another way, is not covered.
- **It fails open.** With no CLI, a CLI that lacks `agents guard`, or a payload it cannot read, the command runs. `sf status` says so on its `routing:` line and in its `guardHook` precondition.
- **Claude Code** reads its settings when a session starts: a session that is already running keeps its old hooks until it restarts. The developer can switch hooks off (`disableAllHooks`); that is
  theirs to decide, not the agent's.
- **Codex** runs a project hook only once the `.codex/` layer and that hook are trusted: after `sf update`, review and trust the guard with `/hooks`. `sf status` says `declared`, never `enforced`. A
  Codex subagent carries no agent id, so the rules for a delegated agent apply there to a call that runs in a recognised worktree path only; the first three rules apply regardless.

## Transition guards

### SRS guard: `SF_WORKFLOW_BYPASS_SRS_GUARD`

- **Protects:** a ticket labelled `srs:drafting`, `srs:update` or `srs:new` follows the drafting lifecycle (`transition-drafting`), not the code path. The guard blocks it from entering AI testing,
  Human testing or In review.
- **Applies to:** `update-status <ticket> "AI testing" | "Human testing" | "In review"`. The guard fails open when the labels cannot be read.
- **Legitimate:** `transition-drafting <ticket> done` sets it for you when it closes the drafting ticket. That is the only routine use, and you never type it. By hand: practically never; a drafting
  ticket that really must show a code-path status is a labelling mistake, so fix the labels instead.
- **Illegitimate:** moving a drafting ticket through the testing statuses so the board looks active; using it to skip human review of the SRS pages.
- **Record:** none for the internal use in `transition-drafting`. A manual use needs the ticket comment.

### Complexity guard: `SF_WORKFLOW_BYPASS_COMPLEXITY_GUARD`

- **Protects:** every ticket carries a `complexity: bug | low | medium | complex` label before it leaves Backlog, because the adaptive workflow (analysis depth, plan approval, review) keys off it.
  Epics and `srs:*` tickets are exempt without any hatch.
- **Applies to:** `update-status` to any status except Backlog. Fails open when the labels cannot be read.
- **Legitimate:** the label genuinely cannot be written (for example the repository label is missing and you lack permission to create it) and the ticket must move today. Add the label afterwards.
- **Illegitimate:** avoiding the complexity decision. `detect-complexity <ticket>` suggests a level and `retag <ticket> <level>` persists it in seconds.
- **Record:** ticket comment, and a follow-up to set the label.

### Nature guard: `SF_WORKFLOW_BYPASS_NATURE_GUARD`

- **Protects:** the nature axis. From AI testing, a ticket reaches In review only when it is `nature:internal` (default and `nature:user-facing` tickets go through Human testing); it reaches Done only
  when it is `nature:bundled-pr`; a `nature:bundled-pr` ticket never enters In review. Solo workflows without a Human testing status skip the In review check.
- **Applies to:** `update-status` from AI testing to In review or Done. Fails open when the labels cannot be read.
- **Legitimate:** the correct label cannot be applied (permissions) and the routing is justified by facts you can show: the ticket has no user-visible surface, or it is delivered by its parent's PR.
  Normally the developer adds the label on the ticket and no hatch is needed. An agent never labels its own ticket: whether it skips Human testing is the developer's call, and the hook refuses it.
- **Illegitimate:** skipping Human testing on user-facing work because the tests are green; sending a bundled child to Done without a verified parent PR.
- **Record:** ticket comment naming the facts that justify the routing, and the label to add.

### Children guard: `SF_WORKFLOW_BYPASS_CHILDREN_GUARD`

- **Protects:** a parent ticket or Epic reaches Done only when every native child has the board status Done. Children whose status cannot be read count as not Done.
- **Applies to:** `update-status <parent> Done`. Fails closed when child statuses cannot be verified.
- **Legitimate:** a child was cancelled or closed as a duplicate and carries no Done status on this board (removed from the board, or in another project), and you list it in the comment. Or the child
  status API is down and you verified the statuses on the board yourself.
- **Illegitimate:** closing an Epic to tidy the board while delivery children are still open; hiding unfinished work.
- **Record:** ticket comment listing every child with its real status and why it does not block.

### Bundled-PR parent guard: `SF_WORKFLOW_BYPASS_BUNDLED_PARENT_GUARD`

- **Protects:** a `nature:bundled-pr` child skips its own PR only if GitHub verifies a native sub-issue link to a delivery parent that is not an aggregate Epic. The PR lives on the parent.
- **Applies to:** `update-status <child> Done` for `nature:bundled-pr` tickets. Fails closed; each refusal names the hatch.
- **Legitimate:** the parent relation exists but cannot be verified through the API (outage), and you checked it by hand. A missing link is not a case for the hatch: add it with `link-subtask`.
- **Illegitimate:** declaring a child bundled to avoid opening a PR; pointing a bundled child at an Epic.
- **Record:** ticket comment naming the parent ticket and its PR.

### Pushed-commits guard: `SF_WORKFLOW_BYPASS_PUSHED_GUARD`

- **Protects:** a ticket enters AI testing with its work committed and pushed, so that the test plan and the report describe code anyone can fetch. The guard reads git alone, in the checkout that
  holds the work: the ticket branch of this checkout; the delivery parent's branch for a `nature:bundled-pr` child; a branch the host named (`worktree-agent-<id>`) against the one ticket branch of
  `origin`; from the primary checkout, the worktree that holds the ticket branch (with none, `origin` alone is checked and the notice says so). Tracked changes, staged or not, a branch `origin` lacks,
  a commit it does not have, a branch it moved past, an unreachable `origin` and a detached HEAD all refuse, and the message names the add, commit and push (or `git pull --rebase`) command to run.
  Untracked files only warn.
- **Applies to:** `update-status <ticket> "AI testing"`, from any status, so the return from Human testing ("fix, commit, push, return to AI testing") is covered. Every tool: it needs git, not the
  board.
- **Legitimate:** `origin` is down or refuses the push and the work is safe elsewhere (a bundle, another remote) that you name. Not a case for the hatch: a dirty tree (commit it), an unpushed commit
  (push it), a branch named off the convention (rename it, or push to the ticket branch).
- **Illegitimate:** "I will push after the tests", leaving the work uncommitted so a test run is not disturbed, pushing later "for the report".
- **Record:** automatic, a ticket comment naming the variable and `SF_WORKFLOW_BYPASS_REASON`. Complete it with what is unpushed and where the work is.

### PR existence guard: `SF_WORKFLOW_BYPASS_PR_EXISTENCE_GUARD`

- **Protects:** Human testing needs an open draft PR and In review needs an open, ready PR whose head branch matches the ticket (`feature/<N>-...`, `fix/<N>-...` or the project's `branchNaming`) and
  targets the configured branch. Release PRs follow the RC branch pattern and an explicit `Closes #<N>`.
- **Applies to:** `update-status` to Human testing or In review. Fails closed when the PR state is unknown or ambiguous.
- **Legitimate:** the PR is real but opened from a differently named branch that cannot be renamed. State the PR URL.
- **Illegitimate:** moving on without a PR; working around a `branchNaming` pattern that has no `{N}` placeholder. In that case realign `branchNaming` in `.saasfoundry.json`; the guard is correct.
- **Record:** ticket comment with the PR URL and the branch name.

### PR merged guard: `SF_WORKFLOW_BYPASS_PR_MERGED_GUARD`

- **Protects:** a delivery ticket is Done only when a matching PR is verified merged into the working branch (or, for release tickets, the release branch). An open PR blocks Done; a reviewer's
  approval is not a merge. Aggregate Epics, verified `nature:bundled-pr` children, `srs:*` tickets and the bootstrap ticket are exempt without any hatch.
- **Applies to:** `update-status <ticket> Done`. Fails closed when PR state cannot be verified.
- **Legitimate:** the work reached the working branch without a PR that the guard can match (an emergency hotfix pushed directly, a PR merged into a differently configured branch, a squash that lost
  the ticket link), and you can name the commit.
- **Illegitimate:** the PR is still open or awaiting merge; Done "because it was approved"; Done before CI finished.
- **Record:** ticket comment with the commit SHA or PR URL proving the work is on the working branch.

## Ticket and PR commands

### `--bypass-srs <reason>`

- **Protects:** Rule 8. On an SRS-enabled project (`tools.srs.backend` is set in `.saasfoundry.json`), feature tickets must come from a drafted SRS page through the spawner. Without the flag these
  commands exit with code `2`.
- **Applies to:** `create-ticket`, `create-subtask`, `create-epic` of `github-projects-cli.sh`, and the same commands through `workflow-cli.sh`. Both `--bypass-srs <reason>` and
  `--bypass-srs=<reason>` work; the reason is mandatory.
- **Legitimate reasons, written so they can be grepped:**
  - `spawned-from-srs`: the SRS spawner passes it by itself on every ticket it creates. Do not type it by hand.
  - `meta-srs-tooling`: work on the SRS tooling, drafter refactors, evaluation polish; tickets that map to no functional-requirement page.
  - `bootstrap-epic-<N>`: creating an Epic's own subtasks during rollout, before its page tree exists (for example `bootstrap-epic-174`).
  - Free text for a genuine one-off such as an emergency hotfix or infrastructure work, kept to a short phrase.
- **Illegitimate:** any ticket that represents a product feature or requirement. The answer is "draft it first, then spawn". Also a reason invented to get past the refusal.
- **Record:** automatic. The reason is echoed (`(bypassing rule 8 — reason: ...)`) and posted as a comment on the created ticket. If the comment cannot be posted, a warning asks you to add it by hand.
  Reuse the same token for the same kind of work.

### `--bypass-reason <text>`

- **What it is:** an option of the SRS spawner (`srs-cli.sh spawn`, `sf srs spawn`, `transition-drafting <ticket> spawning`). It sets the `--bypass-srs` reason the spawner passes to every ticket it
  creates. Default: `spawned-from-srs`. It disables nothing the spawner enforces: the reconciliation plan and the evidence checks still apply.
- **Legitimate:** `bootstrap-epic-<N>` when spawning an Epic's first tickets during rollout; another grep-able token when a spawn run has a distinct provenance.
- **Illegitimate:** a misleading reason; reusing `meta-srs-tooling` for product work.
- **Record:** the reason appears on each created ticket's creation line; mention it in the drafting ticket's comment.

### Local CI guard: `--skip-local-ci "<reason>"`

- **Protects:** every project gates review on its local CI. A PR opened for review, marked ready or moved to Human testing needs every required commit status green on its exact head commit. No diff is
  too small. A draft PR opens early and waits. The required statuses come from one of three sources, in this order, and the refusal names the one that applies and the command to run:
  1. `workflow.localCi.requiredStatuses` in `.saasfoundry.json`, which always wins (`sf workflow set-local-ci <context...>`). An empty list is a deliberate "this project has no local CI": the gate
     prints a notice and checks nothing (`sf workflow set-local-ci --none`).
  2. With the key absent, the jobs of `.molten/project.json` when it declares at least one job in `ci.jobs` and `"ci": { "statuses": "github" }`: each job publishes `local-<job>` and every one is
     required. A pipeline file that cannot be read is a refusal, never a fallback. A recorded list is pinned: a job added to the pipeline later is not required until the list is recorded again.
  3. Neither: the status `AI testing / Local CI`, published with `workflow-cli.sh ai-status <ticket> "Local CI" success "<what ran>"` once the project's own suite is green on the pushed commit.
- **Applies to:** `create-pr <ticket>` without `--draft`, `ready-pr <ticket>`, `local-ci-gate <ticket>` and `update-status <ticket> "Human testing" --skip-local-ci "<reason>"` (the flag may stand
  anywhere after the ticket). The Human testing guard follows the PR existence guard and reads the head commit of the one pull request it matched, from any checkout. It fails closed: a pull request, a
  commit or statuses that cannot be read refuse. Other workflow tools have no pull request commands, so they get a notice instead of a gate.
- **Legitimate:** the local CI infrastructure is unavailable (runner offline, status publisher broken), a teammate has no MoltenTerm on a project that declares a Molten pipeline, and the same checks
  were verified another way that you describe in the reason. A first run of a changed Molten pipeline waits for the user's trust click in Mission Control: that is not a case for the hatch, the user
  unblocks it.
- **Illegitimate:** "the diff is small", "a narrower check passed" (`lint`, `check`), "CI is slow". Run the local CI on the exact head commit instead.
- **Record:** automatic. The CLI prints a warning, then writes `Local CI gate skipped: <reason>` in the PR body (`create-pr`) or as a PR comment (`ready-pr`, `local-ci-gate`, the move to Human
  testing; on the ticket when the PR existence guard was bypassed and no pull request can carry it). Add the evidence of the alternative check to the PR test plan.

## Not guard bypasses

These are switches you may meet in the same scripts. They do not weaken a guard.

### `SF_CACHE_BUST=1`

- **What it does:** `github-projects-cli.sh` caches the board schema (project id, status field, status options) for one hour in `$SF_CACHE_DIR` (default `/tmp/sf-workflow-cache-$USER`; `SF_CACHE_TTL`
  sets the lifetime in seconds). Any non-empty value of `SF_CACHE_BUST` forces a refetch for that command.
- **Legitimate:** right after the board owner renamed, added or removed a status option, when a valid status is rejected as unknown.
- **Illegitimate / pointless:** on every command. It costs API calls and never fixes a guard refusal.
- **Record:** none.

### `SF_DISABLE_SRS_HOOK=1`

- **What it does:** silences the SRS intent-detector, a `UserPromptSubmit` hook that adds a reminder to consider the `sf-srs` skill when a prompt looks like a new requirement. The hook never blocks.
  The persistent form is `tools.srs.intentDetectorEnabled = false` in `.saasfoundry.json` (or `tools.srs.enabled = false`), which is version-controlled.
- **Legitimate:** a session of exploration or of SRS-tooling work where the reminder is noise.
- **Illegitimate:** silencing it to avoid updating the SRS while implementing a real requirement.
- **Record:** none for the variable; the manifest change is reviewed like any commit.

### Other switches

- `SF_WORKFLOW_BYPASS_REASON="<text>"` is the reason `update-status` writes in its bypass comment. It switches nothing off on its own.
- `SF_SKILL_NO_WARN=1` hides the "installed skill is stale" warning of the `sf` CLI.
- `--force-full --force-reason "<reason>"` is passed by the generated validation workflow on release targets and scheduled or manual runs. It widens the impact-aware checks to the full suite, so it
  tightens validation instead of loosening it.

## Choosing quickly

| The guard says                        | Do this first                                                                 | Hatch only if                                           |
| ------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------- |
| no `complexity:` label                | `detect-complexity`, then `retag <ticket> <level>`                            | the label cannot be written at all                      |
| lacks `nature:internal`               | take the ticket through Human testing, or ask the developer if it is internal | the label cannot be applied and routing is justified    |
| work not committed or not pushed      | commit it, then `git push` (the message names the command)                    | `origin` is down and the work is safe elsewhere         |
| no open PR / wrong draft state        | `create-pr`, `ready-pr`, or rename the branch to the convention               | the PR exists on a branch that cannot be renamed        |
| no verified merged PR                 | wait for the merge, then `update-status <ticket> Done`                        | the work is on the working branch without a matching PR |
| children not Done                     | finish or close each child                                                    | a child has no Done status on the board and says why    |
| SRS enabled, `create-subtask` refused | draft the page, then `transition-drafting <t> spawning`                       | meta-SRS or bootstrap work, with a grep-able reason     |
| local CI not green                    | run the local CI on the exact head commit (the message names it)              | the local CI infrastructure is down                     |
