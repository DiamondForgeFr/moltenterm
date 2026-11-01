# Workflow escape hatches

The workflow guards refuse a transition or a command when an entry condition, an exit condition or a piece of external proof is missing. A refusal is evidence, not an obstacle: the first move is
always to supply what is missing (label the ticket, open the PR, wait for the merge, run the local CI). An escape hatch exists for the narrow case where the guard is wrong or cannot be satisfied, and
it must leave a trace a reviewer can find.

This file lists every hatch the workflow scripts accept, what each one switches off, when using it is legitimate, when it is not, and what record to leave.

## Ground rules

1. **Fix the condition first.** Every guard message says how. If the fix takes minutes, do it instead of bypassing.
2. **An agent never sets a hatch on its own.** It stops, reports the refused transition and the guard message, and asks the developer. The developer's explicit instruction is what authorizes a hatch.
3. **Scope it to one command.** Set the variable inline for the single command that needs it, never with `export` and never in a shell profile or a CI job:

   ```bash
   SF_WORKFLOW_BYPASS_PR_MERGED_GUARD=1 SF_WORKFLOW_BYPASS_REASON="hotfix a1b2c3d pushed directly" \
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

Guards run in this order on `update-status`: SRS, complexity, Epic derived status, nature, incomplete children, bundled-PR parent, PR existence, PR merged. A refusal exits with code `2`.

## Quick reference

| Hatch                                       | Switches off                                                        | Applies to                                                |
| ------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------- |
| `SF_WORKFLOW_BYPASS_SRS_GUARD=1`            | SRS drafting guard (`srs:*` tickets stay off the code path)         | `update-status` to AI testing, Human testing, In review   |
| `SF_WORKFLOW_BYPASS_COMPLEXITY_GUARD=1`     | Complexity label required                                           | `update-status` to any status except Backlog              |
| `SF_WORKFLOW_BYPASS_NATURE_GUARD=1`         | Nature axis (Human testing / In review routing)                     | `update-status` from AI testing to In review or Done      |
| `SF_WORKFLOW_BYPASS_CHILDREN_GUARD=1`       | Parent Done requires every native child Done                        | `update-status` to Done                                   |
| `SF_WORKFLOW_BYPASS_BUNDLED_PARENT_GUARD=1` | Bundled-PR child must have a verified, non-Epic native parent       | `update-status` to Done for `nature:bundled-pr` tickets   |
| `SF_WORKFLOW_BYPASS_PR_EXISTENCE_GUARD=1`   | Matching open PR (draft or ready) required                          | `update-status` to Human testing or In review             |
| `SF_WORKFLOW_BYPASS_PR_MERGED_GUARD=1`      | Verified merged PR required                                         | `update-status` to Done                                   |
| `--bypass-srs <reason>`                     | Rule 8: SRS-enabled projects spawn tickets from drafted SRS pages   | `create-ticket`, `create-subtask`, `create-epic`          |
| `--bypass-reason <text>`                    | Sets the `--bypass-srs` reason the SRS spawner passes (not a guard) | `srs-cli.sh spawn`, `transition-drafting <t> spawning`    |
| `--skip-local-ci "<reason>"`                | Local CI statuses green on the head commit                          | `create-pr` (not draft), `ready-pr`                       |
| `SF_CACHE_BUST=1`                           | Nothing: refetches the cached board schema                          | any `github-projects-cli.sh` command that reads the board |
| `SF_DISABLE_SRS_HOOK=1`                     | Nothing: silences the SRS intent-detector reminder                  | the `UserPromptSubmit` hook of the `sf-srs` skill         |

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

## Transition guards

### `SF_WORKFLOW_BYPASS_SRS_GUARD`

- **Protects:** a ticket labelled `srs:drafting`, `srs:update` or `srs:new` follows the drafting lifecycle (`transition-drafting`), not the code path. The guard blocks it from entering AI testing,
  Human testing or In review.
- **Applies to:** `update-status <ticket> "AI testing" | "Human testing" | "In review"`. The guard fails open when the labels cannot be read.
- **Legitimate:** `transition-drafting <ticket> done` sets it for you when it closes the drafting ticket. That is the only routine use, and you never type it. By hand: practically never; a drafting
  ticket that really must show a code-path status is a labelling mistake, so fix the labels instead.
- **Illegitimate:** moving a drafting ticket through the testing statuses so the board looks active; using it to skip human review of the SRS pages.
- **Record:** none for the internal use in `transition-drafting`. A manual use needs the ticket comment.

### `SF_WORKFLOW_BYPASS_COMPLEXITY_GUARD`

- **Protects:** every ticket carries a `complexity: bug | low | medium | complex` label before it leaves Backlog, because the adaptive workflow (analysis depth, plan approval, review) keys off it.
  Epics and `srs:*` tickets are exempt without any hatch.
- **Applies to:** `update-status` to any status except Backlog. Fails open when the labels cannot be read.
- **Legitimate:** the label genuinely cannot be written (for example the repository label is missing and you lack permission to create it) and the ticket must move today. Add the label afterwards.
- **Illegitimate:** avoiding the complexity decision. `detect-complexity <ticket>` suggests a level and `retag <ticket> <level>` persists it in seconds.
- **Record:** ticket comment, and a follow-up to set the label.

### `SF_WORKFLOW_BYPASS_NATURE_GUARD`

- **Protects:** the nature axis. From AI testing, a ticket reaches In review only when it is `nature:internal` (default and `nature:user-facing` tickets go through Human testing); it reaches Done only
  when it is `nature:bundled-pr`; a `nature:bundled-pr` ticket never enters In review. Solo workflows without a Human testing status skip the In review check.
- **Applies to:** `update-status` from AI testing to In review or Done. Fails open when the labels cannot be read.
- **Legitimate:** the correct label cannot be applied (permissions) and the routing is justified by facts you can show: the ticket has no user-visible surface, or it is delivered by its parent's PR.
  Normally you add the label (`gh issue edit <ticket> --add-label nature:internal`) and no hatch is needed.
- **Illegitimate:** skipping Human testing on user-facing work because the tests are green; sending a bundled child to Done without a verified parent PR.
- **Record:** ticket comment naming the facts that justify the routing, and the label to add.

### `SF_WORKFLOW_BYPASS_CHILDREN_GUARD`

- **Protects:** a parent ticket or Epic reaches Done only when every native child has the board status Done. Children whose status cannot be read count as not Done.
- **Applies to:** `update-status <parent> Done`. Fails closed when child statuses cannot be verified.
- **Legitimate:** a child was cancelled or closed as a duplicate and carries no Done status on this board (removed from the board, or in another project), and you list it in the comment. Or the child
  status API is down and you verified the statuses on the board yourself.
- **Illegitimate:** closing an Epic to tidy the board while delivery children are still open; hiding unfinished work.
- **Record:** ticket comment listing every child with its real status and why it does not block.

### `SF_WORKFLOW_BYPASS_BUNDLED_PARENT_GUARD`

- **Protects:** a `nature:bundled-pr` child skips its own PR only if GitHub verifies a native sub-issue link to a delivery parent that is not an aggregate Epic. The PR lives on the parent.
- **Applies to:** `update-status <child> Done` for `nature:bundled-pr` tickets. Fails closed; each refusal names the hatch.
- **Legitimate:** the parent relation exists but cannot be verified through the API (outage), and you checked it by hand. A missing link is not a case for the hatch: add it with `link-subtask`.
- **Illegitimate:** declaring a child bundled to avoid opening a PR; pointing a bundled child at an Epic.
- **Record:** ticket comment naming the parent ticket and its PR.

### `SF_WORKFLOW_BYPASS_PR_EXISTENCE_GUARD`

- **Protects:** Human testing needs an open draft PR and In review needs an open, ready PR whose head branch matches the ticket (`feature/<N>-...`, `fix/<N>-...` or the project's `branchNaming`) and
  targets the configured branch. Release PRs follow the RC branch pattern and an explicit `Closes #<N>`.
- **Applies to:** `update-status` to Human testing or In review. Fails closed when the PR state is unknown or ambiguous.
- **Legitimate:** the PR is real but opened from a differently named branch that cannot be renamed. State the PR URL.
- **Illegitimate:** moving on without a PR; working around a `branchNaming` pattern that has no `{N}` placeholder. In that case realign `branchNaming` in `.saasfoundry.json`; the guard is correct.
- **Record:** ticket comment with the PR URL and the branch name.

### `SF_WORKFLOW_BYPASS_PR_MERGED_GUARD`

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

### `--skip-local-ci "<reason>"`

- **Protects:** a project that declares `workflow.localCi.requiredStatuses` in `.saasfoundry.json` gates review on its local CI. A PR opened for review, or marked ready, needs every declared commit
  status green on its exact head commit. No diff is too small. A draft PR opens early and waits.
- **Applies to:** `create-pr <ticket>` without `--draft`, and `ready-pr <ticket>`. A project that declares no required status has no gate.
- **Legitimate:** the local CI infrastructure is unavailable (runner offline, status publisher broken) and the same checks were verified another way that you describe in the reason.
- **Illegitimate:** "the diff is small", "a narrower check passed" (`lint`, `check`), "CI is slow". Run the local CI on the exact head commit instead.
- **Record:** automatic. The CLI prints a warning, then writes `Local CI gate skipped: <reason>` in the PR body (`create-pr`) or as a PR comment (`ready-pr`). Add the evidence of the alternative check
  to the PR test plan.

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

| The guard says                        | Do this first                                                   | Hatch only if                                           |
| ------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------- |
| no `complexity:` label                | `detect-complexity`, then `retag <ticket> <level>`              | the label cannot be written at all                      |
| lacks `nature:internal`               | take the ticket through Human testing, or add the label if true | the label cannot be applied and routing is justified    |
| no open PR / wrong draft state        | `create-pr`, `ready-pr`, or rename the branch to the convention | the PR exists on a branch that cannot be renamed        |
| no verified merged PR                 | wait for the merge, then `update-status <ticket> Done`          | the work is on the working branch without a matching PR |
| children not Done                     | finish or close each child                                      | a child has no Done status on the board and says why    |
| SRS enabled, `create-subtask` refused | draft the page, then `transition-drafting <t> spawning`         | meta-SRS or bootstrap work, with a grep-able reason     |
| local CI not green                    | run the local CI on the exact head commit                       | the local CI infrastructure is down                     |
