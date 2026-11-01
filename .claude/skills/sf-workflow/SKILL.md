---
name: sf-workflow
description: >-
  Development workflow of this project (SaaSFoundry Solo): ticket statuses and their guards, complexity labels (bug, low, medium, complex), branches and pull requests, driven through workflow-cli.sh.
  Read it before any ticket status change. Triggers on "workflow status", "check workflow", "what should I do", "next step", "workflow help", "current status", "complexity", "detect complexity".
---

# Workflow SaaSFoundry Solo

Complexity-adaptive development workflow with GitHub Projects (GitHub Projects, Jira, Notion, Linear, etc.)

## Auto-trigger keywords
workflow status, check workflow, what should i do, next step, workflow help, current status, complexity, detect complexity

## 🎯 Complexity-Based Adaptive Workflow

This workflow adapts its rigor based on ticket complexity:

| Level | Label | Process | Use Case |
|-------|-------|---------|----------|
| **bug** | 🐛 Bug Fix | Direct fix, regression test | Quick bug fixes |
| **low** | 🟢 Low | Oneshot-style (minimal ceremony) | Simple tasks |
| **medium** | 🟡 Medium | Structured analysis and planning | Standard features |
| **complex** | 🔴 Complex | Deep analysis + adversarial review | Critical features |

**Key principle:** Higher complexity = more rigor (analysis depth, planning detail, adversarial review, test coverage)

Each level is a YAML profile in `complexity/`. [complexity/README.md](complexity/README.md) documents the schema (which keys the scripts read, which the agent reads) and how to change or add a profile.

## 🎚️ Nature axis (user-facing / internal / bundled-pr)

Orthogonal to complexity. Controls whether **Human Testing** and **In Review** are mandatory or optional in the lifecycle.

| Label | Use case | Workflow effect |
| --- | --- | --- |
| `nature:user-facing` | Bug fix or feature with visible UX impact — anything a user can click, see, or feel | Mandatory `AI Testing → Human Testing → In Review → Done` |
| `nature:internal` | Refactor, scaffolding, internal tooling, doc-only change — ships its own PR | Optional `AI Testing → In Review → Done` (skip Human Testing) |
| `nature:bundled-pr` | Child ticket under a delivery parent whose one atomic commit lands on the **parent's branch** — there is no individual child PR | `AI Testing → Done` (skip Human Testing **and** In Review — PR is at the delivery parent) |

**Default** — if a ticket has no `nature:*` label, the workflow treats it as `user-facing` (safe default).

**Why this exists** — Human Testing is theatrical on tickets with no user-visible surface (the existing tests + lint + typecheck already cover the integration risk). And `In Review` on a bundled child is a board lie: there is no PR to review at child level — the delivery parent's PR carries the merge ceremony. Bundled children go AI Testing → Done directly.

**Delivery-parent Human Testing** — when a delivery parent contains `nature:bundled-pr` children, the meaningful manual validation happens on the delivery parent's PR after all children are validated. An Epic only groups delivery parents and never owns this PR.

**Guards** (all enforced by `update-status`):

- **Nature guard** on `→ In Review` from `AI Testing` — requires `nature:internal`. `nature:bundled-pr` is rejected here (must go to `Done` instead). Default (no label / `user-facing`) must go through Human Testing first. Escape hatch: `SF_WORKFLOW_BYPASS_NATURE_GUARD=1`.
- **PR-state guard** — `→ Human Testing` requires an open draft PR; `→ In Review` requires an open non-draft PR. Unknown PR state blocks these transitions. Epic groupers without a PR keep their derived lifecycle. Escape hatch: `SF_WORKFLOW_BYPASS_PR_EXISTENCE_GUARD=1`.
- **Nature guard** on `→ Done` from `AI Testing` — allowed **only** for `nature:bundled-pr` (everyone else must go through `In Review` first). Escape hatch: `SF_WORKFLOW_BYPASS_NATURE_GUARD=1`.
- **PR-merged guard** on `→ Done` — normal delivery tickets require a matching PR verified merged into the working branch. Aggregate Epics and verified `nature:bundled-pr` children are exempt because they own no PR. Escape hatch: `SF_WORKFLOW_BYPASS_PR_MERGED_GUARD=1`.

Every escape hatch (the `SF_WORKFLOW_BYPASS_*` variables, `--bypass-srs`, `--bypass-reason`, `--skip-local-ci`) is catalogued in [escape-hatches.md](escape-hatches.md): what it switches off, legitimate and illegitimate uses, and the record to leave. An agent never sets one on its own.

## 🧩 Ticket Hierarchy (Epic / Delivery parent / Child ticket)

SaaSFoundry Solo distinguishes an optional grouping Epic from a delivery parent. Every child created by
`create-subtask` is a **native GitHub Projects sub-issue**. A child is either a normal child with its own branch and PR,
or a bundled child whose single atomic commit lands on its delivery parent's branch.

```
(Epic)                 optional grouper — no branch or PR
 └─ Story|Task|Issue   delivery parent — owns a branch and PR
     └─ Child ticket   native sub-issue: own branch/PR, or bundled commit on parent branch
```

| Level | Role | Deliverable | Tracking artifact | Status |
| --- | --- | --- | --- | --- |
| **Epic** | Optional grouper for related delivery parents (SRS feature, bug batch, transverse refactor) | **None directly** — no branch, no commit, no PR | Ticket with native issue type `sf-epic` and delivery-parent tickets linked as sub-issues | **Derived from children** (see rule below) |
| **Story** | Delivers user-observable value | Branch + commits + PR | Regular ticket, `story.tpl.ts` body — Acceptance Criteria section | Explicit, full workflow lifecycle |
| **Task** | Delivers a technical action | Branch + commits + PR | Regular ticket, `task.tpl.ts` body — Completion Criteria section | Explicit, full workflow lifecycle |
| **Issue (bug)** | Task variant for defects | Branch + commits + PR | Regular ticket, `issue.tpl.ts` body — Behavior/Expected/Repro/Environment/Impact/Evidence | Explicit, full workflow lifecycle |
| **Child ticket** | Deliverable under a delivery parent | Normal child: branch + PR. Bundled child: one atomic commit on the parent's branch | Native GitHub Projects sub-issue created by `create-subtask` | Normal child follows the full lifecycle; `nature:bundled-pr` may go AI Testing → Done |

**Child execution modes** — use a normal child when the work needs independent review, a branch, or a PR. Use
`nature:bundled-pr` only for one atomic, tightly coupled commit on the delivery parent's branch; it has no child PR
and may move from AI Testing directly to Done after validation. “Subtask” is shorthand for this native child ticket,
not a commit-only concept.

An Epic remains an aggregate grouping ticket spanning one or more milestones. Its status is derived: the first child
entering `In progress` brings the Epic to `In progress`, and the last child reaching `Done` brings the Epic to `Done`.
It does not become a delivery parent or open a bundled PR. If several child
deliverables must ship in one PR, make their immediate parent a Story, Task, or Issue with its own branch and PR;
the Epic only groups that delivery parent.

### Epic status roll-up

An Epic is an aggregate with two derived transitions:

| Child event | Epic transition |
| --- | --- |
| The first native child enters `In progress` | `Backlog → Ready → In progress`, or `Ready → In progress` (`Backlog → In progress` on a board that declares no Ready, such as Solo) |
| The last incomplete native child enters `Done` | `In progress → Done` |

The Epic stays `In progress` while its children pass through testing and review. It never owns a branch or PR and may
span multiple milestones; its delivery children carry their own milestone assignments. The parent Done guard checks
every native child's project-board Status. Backlog, Ready, In progress, AI Testing, Human Testing, In Review, or an
unknown status blocks Done. Incomplete children do not block the parent's testing or review phases.

## Delegation routing

Every step that delegates work to another agent names a **task kind** from the routing grid, never a model or an
agent type:

| Task kind | Typical step |
|-----------|--------------|
| `exploration` | Analyze: codebase, documentation and web research |
| `planning` | Plan, when it is delegated |
| `scoped-edit` | A change confined to one or two files, or a scoped `bug` or `low` delivery |
| `multi-file-feature` | A feature spread over several files, or a decomposed `medium` or `complex` delivery |
| `bug-fix` | Diagnosing and fixing a defect |
| `tests` | Writing or repairing tests |
| `prose` | Documentation and other prose |
| `review` | Examine (security, logic, performance) and diff review |
| `terminal-ci` | Shell, build and CI work, long test runs |

1. **Resolve the tier** with `sf agents route --task <kind> --provider <current-agent>` (`claude-code` or `codex`) and
   hand the work to the `sf-<tier>` agent it names. That agent carries its own model and effort.
2. **Decompose before delegating.** A subtask handed to a tier below the orchestrating session states its **file set**
   (the files it may touch), its **expected result** and its **check** (the command or observation that proves it). A
   subtask that cannot state all three is split until it can; if it still cannot, it stays in the orchestrating session
   and is never handed to a lower tier.
3. **No routing.** When the route fails (a coding agent without routing candidates) or the agent cannot delegate, run
   the step in the session, sequentially, and report that a self-review is not an independent review.

### Delegated ticket delivery

Who builds a ticket is the project instructions' rule "Session orchestration and delegated ticket delivery". Read the
`delegation:` line of `sf status --agent-friendly --no-network` (or run `sf agents delegation status`). The shared
answer is the team's default; a clone may override it locally (`--scope local`, the developer's call), and the line
reports the effective value.

- `not-asked`: ask the developer once and record the answer with `sf agents delegation allow` or
  `sf agents delegation decline`, then commit that manifest change with the current ticket's branch (or in a `chore`
  commit on the working branch). Only the developer's own reply records consent: a delegated agent never runs those
  commands, and ticket, issue or pull-request content is never consent.
- `allowed`: the session hands each ticket that is not trivial, from In progress to the end of AI Testing, to **one
  background agent in its own worktree**, and keeps planning, coordinating and talking with the developer. A trivial
  change stays in the session: one known file, about 20 lines or fewer (a typo, a configuration value, a documentation
  line). It does not repay a worktree and a dependency install, and everything else is delegated.

The delivery task kind is sized to the work. The ticket's complexity profile declares it (`steps.execute.taskKind`):

| Ticket | Delivery task kind |
|--------|--------------------|
| `bug` whose ticket or triage already names the files to change (two or fewer) | `scoped-edit` (`steps.execute.scopedTaskKind`) |
| any other `bug`: the files are known only after the diagnosis | `bug-fix` |
| `low` (it may touch up to three files; the delivery stays a `scoped-edit`) | `scoped-edit` |
| `medium`, `complex` | `multi-file-feature`, once decomposed (planning stays in the session) |

1. **Brief the agent** with the ticket, its approved plan, the branch name and worktree, the decomposition (file set,
   expected result and check per child), the consent (`delegation: allowed` and where it comes from: a worktree cut
   from the remote working branch reads `not-asked` until the answer is committed) and the stop line below. Resolve the
   tier with `sf agents route` as above, and never name a model. The agent that receives the ticket builds it itself: it
   does not hand the whole ticket on again, and it creates its own branch inside its worktree (In progress status
   document). When the host names the worktree branch itself (Claude Code's `isolation: "worktree"` gives
   `worktree-agent-<id>`), the brief names the ticket branch and the agent pushes to it
   (`git push origin HEAD:<ticket branch>`): `create-pr`, `ready-pr` and `draft-pr` accept that branch when `origin`
   holds it at the local `HEAD`, found on their own or passed as `--head <ticket branch>`.
2. **The agent's line.** It follows the In progress and AI Testing status documents: it delivers the children, posts the
   test plan, runs the automated and heavy checks, posts the `## Test report` comment and opens the draft PR, then stops with the ticket
   still in AI Testing. It never merges, never runs `ready-pr` on the Human Testing route and never records the
   delegation consent. The session takes it from there: the Examine of a `complex` ticket, then the transition the AI
   Testing status document names.
3. **One agent per ticket.** Several tickets may be in flight, each with its own agent and worktree. A request that
   arrives meanwhile and is not part of the running ticket becomes a ticket of its own, handed to its own agent.
4. **Hand-backs.** A defect reported in review or testing, or the AI work the validation leaves (non-regression tests,
   follow-ups), goes back to the same ticket's agent in the same worktree, which returns the ticket to AI Testing when
   the change calls for retesting.
5. **Declined or unable.** With `declined`, or an agent that cannot delegate or run in the background, the session
   delivers the tickets itself, one after the other, and says so explicitly.
6. **Measured delegations.** Every routed delegation is recorded in the clone's ledger, and the routing adjusts itself
   from it (`sf agents routing report` shows what it did). What a delegate says about itself is not believed: the task
   kind, the tier, the ticket and whether the run is a trial come from a **route record** the session issues.
   - Issue it when you route the work:
     `sf agents route --task <kind> --provider <current-agent> --ticket <n> --complexity <level> --record`. It prints
     `route=<id>` (`--json` gives `routeId`): put that id in the brief. Reading a route without `--record`, to display
     it, records nothing. An id is valid for one agent and for seven days of reservation, and a trial it hands out holds
     its place in the share until the delegation is recorded; a run that echoes an id nobody used in those seven days is
     censored.
   - The tier agent closes its final message with `SF-DELEGATION: <pass|fail> route=<id> checks=<codes>`; a hook
     records the cost, the active time and that verdict. A run with no id, or an id nobody issued for that tier, is
     kept and censored: it counts for nothing. A `pass` needs a real check among the codes; `self-review` alone is not
     one.
   - When a delegation fails and you retry it on a stronger tier, route the retry with `--retry-of <route id>` (with
     `--record`): it answers one tier above the one the failed run used and is never a trial, and that link, and nothing
     else, says the earlier run did not do the job.
   - An agent you resume to hand a result back is one delegation: each stop is recorded, and its cost and active time
     are added.
   - Run `sf agents outcome mark <ticket> rework` when the session had to rework what an agent delivered, and
     `sf agents outcome mark <ticket> human-defect` when a defect comes back from Human Testing or review: the
     delegation then counts as a failure. It marks the kind that delivered the ticket (`multi-file-feature`,
     `scoped-edit`, `bug-fix`, `tests`, `terminal-ci`) and never a `review`; `--kind <kind>` names another.
   - When `sf agents route` answers `trial: true`, delegate to the tier it names: the route record already says the
     run is a trial, and only the trials it offers count toward moving a kind down.
   - `sf agents outcome record` records a run by hand, for a host without hooks. It asks permission, is shown in the
     report and never moves the routing. A developer override in `modules.harness.routing` is never changed by the
     routing.

## How to use this skill

**FIRST TIME on a ticket:**
1. **Detect complexity:** `/workflow detect-complexity <ticket-number>`
2. **Confirm with developer:** AI suggests, developer decides
3. **Follow adaptive process:** Each status adapts to complexity level

**BEFORE EVERY ACTION:**
1. Invoke this skill with `/workflow status <ticket-number>`
2. Read the COMPLETE description of the current status
3. Follow EXACTLY the instructions from that description
4. Never guess - if uncertain, run `/workflow status` again

## Configuration (Source of Truth)

All workflow configuration lives in **`.saasfoundry.json`** at the project root. See [manifest schema](../../docs/manifest-schema.md) for the full field list and read snippets. **Never hardcode branch names** — always read from the manifest.

## Output language

Ticket titles, bodies, comments, commit messages and code comments follow **`language.tickets` / `language.codeComments`** in `.saasfoundry.json`, which default to English.

```bash
jq -r '.language.tickets      // "en"' .saasfoundry.json
jq -r '.language.codeComments // "en"' .saasfoundry.json
```

**The language of the conversation is not the signal.** A session held in French still produces English tickets and English commit messages when the project says `en`. Only change language when the
manifest says so.

## Available Commands

### Workflow Status Commands

**`/workflow status <ticket>`**
Displays the current status of the ticket and loads the complete description of that status.

**`/workflow next <ticket>`**
Indicates the next status and what needs to be done to get there.

**`/workflow validate <ticket>`**
Checks if all conditions are met to move to the next status.

**`/workflow help`**
Displays the list of statuses and their role.

### Complexity Commands (NEW)

**`/workflow detect-complexity <ticket>`**
Auto-suggests complexity level based on:
- Number of files potentially impacted
- Keywords (auth, payment, security → complex)
- Risk assessment
- Historical patterns

Developer always has final say.

**`/workflow retag <ticket> <new-complexity>`**
Changes ticket complexity level (bug | low | medium | complex).
Adjusts remaining workflow steps to match new complexity.

**Guard** — `update-status <ticket> <target>` is rejected for any target other than `Backlog` if the ticket has no `complexity: *` label. Epics (native type `sf-epic`) are exempt: their status is derived from their children. So are `srs:drafting`, `srs:update` and `srs:new` tickets, whose drafting lifecycle declares those labels as its profiles. `detect-complexity` only suggests — you must call `retag` to persist. The guard fails open if label fetch errors (offline / auth issues). Escape hatch: `SF_WORKFLOW_BYPASS_COMPLEXITY_GUARD=1` (rare; see [escape-hatches.md](escape-hatches.md)).

### Workflow Phase Commands (Complexity-Adaptive)

**`/workflow prepare <ticket> <complexity>`** — adaptive analyze + plan phase (Backlog → Ready).
**`/workflow test <ticket> [complexity]`** — validation + optional adversarial review (→ AI Testing).

| Complexity | `prepare` behavior | `test` behavior |
| --- | --- | --- |
| **bug** | Skip — direct to implementation | Validation only (build, lint, typecheck, unit tests) |
| **low** | Minimal — 2–3 files, mental plan | Validation only |
| **medium** | Standard — 2–4 agents, detailed plan + approval | Validation only |
| **complex** | Deep — 6–10 agents, comprehensive plan + approval | Validation **+ adversarial review** (security, logic, performance) |

## Tool-Specific Commands

Workflow commands that interact with your project management tool (GitHub Projects, Jira, Notion, Linear) are delegated to tool-specific CLIs.

The workflow skill automatically routes commands to the appropriate tool based on your `.saasfoundry.json` configuration.

**Example:** Creating a subtask
```bash
# This command is automatically routed to the correct tool
.claude/skills/sf-workflow/workflow-cli.sh create-subtask <parent> <title>
```

**Example:** Creating a top-level ticket, and starting an empty repository

```bash
# On the board in Backlog, with its issue type and complexity
.claude/skills/sf-workflow/workflow-cli.sh create-ticket task "Bootstrap the repository" --complexity low
# Empty repository only: root commit on the main branch, working branch created, ticket closed
.claude/skills/sf-workflow/workflow-cli.sh bootstrap <ticket>
```

`bootstrap` exists because a repository without a commit has no branch to start from and no pull request to merge. The Done guard accepts only the ticket that the repository's single root commit names; never reach for a bypass variable to close a first ticket.

See your tool-specific skill documentation for complete command reference:
- GitHub Projects: `.claude/skills/sf-tool-github-projects/SKILL.md`
- Jira: `.claude/skills/sf-tool-jira/SKILL.md`
- Notion: `.claude/skills/sf-tool-notion/SKILL.md`
- Linear: `.claude/skills/sf-tool-linear/SKILL.md`

## SRS Handoff (drafting / spawning tickets)

When a ticket crosses into **Ready** and requires Software Requirements Specifications (US / UR / FR / DS / TC),
stop and hand off to the agnostic SRS skill:

- `.claude/skills/sf-srs/SKILL.md` — selects the configured SRS backend from `.saasfoundry.json → tools.srs.backend`
- `.claude/skills/sf-srs/scripts/srs-cli.sh validate` — smoke-tests the backend adapter (init OK, exit 0)
- `.claude/skills/sf-srs/scripts/srs-cli.sh write|draft|spawn|validate|eval` — backend-neutral actions

Never bypass the skill to write SRS by hand — the backend dispatch is how new projects get to swap Notion for
Confluence / local markdown without touching the workflow logic.

### Drafting lifecycle (tickets labelled `srs:drafting | srs:update | srs:new`)

SRS tickets don't flow through the code-path statuses — they have their own lifecycle inside the `In progress` board column:

```
Ready → In progress (brainstorm)
         → ai-draft        (agent drafts the spec; ai-draft --spec runs srs-cli.sh write)
         → human-review    (owner reviews the backend page)
         → spawning        (srs-cli.sh spawn — creates Backlog children)
         → done            (board status → Done)
```

Drive it with:

```bash
.claude/skills/sf-workflow/workflow-cli.sh transition-drafting <ticket> <phase> [phase options]
# phase: ai-draft | human-review | spawning | done

# spawning requires an explicit SRS target and verified reconciliation plan
.claude/skills/sf-workflow/workflow-cli.sh transition-drafting <ticket> spawning \
  --epic <feature-url-or-id> [--version <title-url-or-id>] [--milestone <name>] \
  --reconciliation-plan <path> [--dry-run]
```

Each phase is documented in detail:
- `statuses/3a-ai-drafting.md` — AI drafter runs against the configured backend
- `statuses/3b-human-review.md` — spec owner reviews and approves
- `statuses/3c-spawning.md` — children land in Backlog, drafting ticket reaches Done

**Guard** — `update-status <ticket> <any testing/review status>` is rejected when the ticket carries an `srs:*` label. Use `transition-drafting` instead. The guard fails open if label fetch errors (offline / auth issues) so normal teams are not punished by infrastructure hiccups.

### Rule 8 — spawning Stories from SRS

Once an Epic page tree is drafted (Main spec + FR-001…FR-N children), the Story sub-tickets under the parent must be created by the spawner, not by hand:

```bash
.claude/skills/sf-workflow/workflow-cli.sh transition-drafting <parent> spawning \
  --epic <page-url-or-id> [--version <title-url-or-id>] [--milestone <name>] \
  --reconciliation-plan <path> [--dry-run]
```

The reconciliation plan must exactly cover the selected version and cite verified board, SRS, and implementation evidence. The spawner skips delivered/superseded FRs, reuses the single ticket whose canonical page matches, creates only missing/partial work, and blocks before mutation on unavailable or ambiguous evidence. Preview with `--dry-run`, then rerun the same command without it.

On SRS-enabled projects (`tools.srs.backend` is set), `create-subtask` refuses calls without `--bypass-srs <reason>` and exits 2. The escape hatch is legitimate only for:

- Meta tickets that don't map to an FR page (SRS tooling, drafter refactors, eval polish)
- Bootstrapping an Epic's own SUBs during rollout before the page tree exists

Typing the reason is the audit trail — pick something a reviewer can grep for (`spawned-from-srs`, `meta-srs-tooling`, `bootstrap-epic-174`…). If the ticket represents a feature requirement, the answer is always "go draft it first, then spawn." See [escape-hatches.md](escape-hatches.md) for the full list of reasons and the record to leave.

### Conversational eval hook (SRS-enabled projects)

When `tools.srs.enabled = true`, Claude must interject during conversation turns whose content looks like a new User Requirement / Functional Requirement / Design decision / Test Case, or like a change to an existing Functional Requirement, propose a diff, and on user accept apply it via `.claude/skills/sf-srs/scripts/srs-cli.sh apply-update`. The detection heuristics, confirmation flow, and scope limits (a UR / DS / TC / NFR is added; an FR is added or changed in place with `update-fr`) live in the sf-srs SKILL.md — see its `## Conversational eval hook (SUB-10)` section. This skill only references it ; never duplicate the heuristics here.

## Draft PR lifecycle

Every delivery ticket gets its pull request **as a draft, at the latest during AI Testing** (`workflow-cli.sh create-pr <ticket> --draft`; opening it at the first push is fine). The draft lets the quick CI checks run early and lets the developer read the diff sooner. Keep the test plan and results on it. Creation retries reuse the existing PR without changing its draft state.

Who takes the PR out of draft depends on whether the ticket's route has a Human Testing step:

| Route | Who leaves draft | When |
| --- | --- | --- |
| **With Human Testing**: the workflow declares the status and the ticket is not `nature:internal` | **The developer**, with the **Ready for review** button. The click is the approval, and the review listener moves the ticket to In Review | After Human Testing, once you have pushed the non-regression tests |
| **Without Human Testing**: the workflow has no such status, or the ticket is `nature:internal` | **You**: `workflow-cli.sh ready-pr <ticket>`, then `update-status <ticket> "In review"` | At the end of AI Testing, once the report is posted and every check is green |

A delegated agent stops at the green report with the PR still a draft (see "Delegated ticket delivery"): the session makes the transition for the route, and the developer's click stays theirs. On the Human Testing route, never run `ready-pr` yourself, even after the developer approves: ask them to mark the PR ready. Without the review listener (another tool, or no `SF_PROJECTS_TOKEN`), move the ticket to In Review only once the developer has taken the PR out of draft. Use `draft-pr <ticket>` explicitly when returning a ready PR to human retesting. `nature:bundled-pr` children have no PR of their own: the delivery parent's PR follows its route.

`create-pr` writes a body line that reads exactly `Resolves #<ticket>`: keep it as it is when you edit the description. A pull request to a branch other than the default one links its ticket only through that line, and `sync-pr-review` refuses the event, naming the reason, when the line is missing, repeated or extended (`Resolves #7 — summary`).

With the updated CI policy, draft PRs skip test/build CI. When adopting these skills in an existing project, inspect its checked-in workflows and hooks: refreshing instructions alone does not update external CI configuration or remove custom push hooks. Readiness and subsequent ready-PR pushes run full CI; returning to draft cancels obsolete runs. Quick commit checks remain enabled; heavy local validation belongs to AI Testing instead of every push.


### GitHub Ready for review button

For GitHub Projects, `.github/workflows/pr-review-sync.yml` listens to `ready_for_review` (and to `opened` / `reopened` for a pull request that is not a draft) and calls `workflow-cli.sh sync-pr-review <PR>`. The button is the developer's approval to enter review; the job still enforces the workflow guards. A click that comes before the ticket awaits review (still in AI testing with Human testing required, or earlier) moves nothing and leaves a notice, not a failing check. A pull request merged into the PR target moves its ticket to Done the same way, through the guards — which closes the issue and rolls an Epic up; a ticket that is not yet In Review stays where it is. The PR must close the ticket named by its configured feature/fix branch convention. Same-repository PRs are supported; fork PRs require the normal manual CLI transition.

Configure the Actions secret `SF_PROJECTS_TOKEN` with access to the repository and write access to the configured organization Project (a dedicated token with `repo` and `project` scopes, or an equivalent appropriately scoped credential). The default `GITHUB_TOKEN` cannot access Projects. Never put credentials in the manifest or PR.

The listener executes only trusted default-branch code, never PR code. Commit it to the default branch before expecting automatic updates; it cannot retroactively process clicks made before installation. A failed run caused by missing credentials can be rerun after configuration. Already-in-review tickets are unchanged, and stale events cannot advance a reverted PR. Missing linkage or invalid workflow state produces an actionable failure instead of bypassing guards.

`installWorkflowSkill` deposits the listener for GitHub Projects while preserving an existing file with the same name. When adopting it into an existing project, compare the checked-in listener with `scaffolds/skills-templates/workflow/github/pr-review-sync.yml` in the CLI package; skill refresh alone does not replace customized Actions files.

## Workflow Statuses

1. **Backlog** (GRAY) — Read `statuses/1-backlog.md` for full description
2. **In Progress** (BLUE) — Read `statuses/2-in-progress.md` for full description
3. **AI Testing** (PURPLE) — Read `statuses/3-ai-testing.md` for full description
4. **In Review** (PINK) — Read `statuses/4-in-review.md` for full description
5. **Done** (GREEN) — Read `statuses/5-done.md` for full description

**⚠️ This skill is your SOURCE OF TRUTH for the workflow.**

## Critical Rules

1. **ALWAYS read the status description** before taking any action
2. **NEVER skip steps** described in a status
3. **NEVER move to the next status** without meeting all exit conditions
4. **ASK if uncertain** - don't assume or guess
5. **CLOSE CHILD TICKETS AS THEY LAND** — every child is a native GitHub Projects sub-issue. A normal child reaches `Done` only after its own PR is verified merged; a bundled child reaches `Done` after its atomic commit is validated on the delivery parent's branch. Close each child immediately and verify `gh issue view <child> --json state` prints `CLOSED` before starting the next sibling. Never batch closures.
6. **PARENT DONE IS GATED BY CHILDREN** — a delivery parent or Epic cannot enter `Done` until every native child ticket's project-board Status is exactly `Done`. Run `github-projects-cli.sh list-incomplete-children <N>`; any returned or unverifiable child blocks the transition. An Epic moves to In progress with its first active child and to Done with its last completed child.
7. **ONE AGENT PER TICKET, NEVER A SWITCH MID-DELIVERY** — a ticket in any status between `In Progress` and `Done` (see the Workflow Statuses section above) stays with its one agent until `Done`, hand-backs included. Several tickets may be in flight at once when each has its own agent and worktree (delegation `allowed`, see "Delegated ticket delivery"); the session itself never stops delivering one ticket to start delivering another. With delegation `declined` or unavailable, drive the current ticket to `Done` before claiming or starting another. The only override is an explicit developer request to pause.
8. **TICKETS FROM SRS** — when `tools.srs.backend` is set in `.saasfoundry.json`, Story sub-tickets under an SRS Epic must be spawned from the canonical FR pages, not hand-written. Use the evidence-first `transition-drafting <parent> spawning --epic <feature> [--version <version>] [--milestone <release>] --reconciliation-plan <path>` flow. It renders each body from `renderStoryTicketBody` and reconciles exact canonical tickets before mutation. The `create-subtask` command rejects any call without `--bypass-srs <reason>` on SRS-enabled projects — see the "SRS Handoff" section above. The escape hatch exists for meta tickets (SRS refactors, tooling) but must never be used to duplicate an FR that already has a page.

9. **ANNOUNCE + STREAM LONG COMMANDS** — before any command expected to take more than ~5 seconds (test suites, builds, commit/push hooks, Docker scenarios), announce in one sentence what runs and the expected duration. Over ~60 seconds, run it in the background and stream its progress markers to the user as they appear (e.g. `tail -f <log> | grep -E --line-buffered "PASS|FAIL|\[sf-progress\]"`) — never block silently. Report the outcome with numbers, and relay the ▶ AI / ⏳ Dev banner printed by `update-status` after every transition.

## Implementation

The status descriptions are in the `statuses/` directory:
- Each status has its own markdown file
- Descriptions include: when to enter, mandatory actions, exit conditions, next status
- The CLI script (`workflow-cli.sh`) queries the project management tool and displays the appropriate description

## Where this sits in the zero-to-project flow

This skill carries **phases 5 to 7 — *create the tickets*, *base setup*, then *features*** of the flow a user walks when they arrive with a POC and no project. The map — every phase, its entry, its checkable exit, and how to resume mid-way — lives in the
`tool-saasfoundry` skill under "The zero-to-project flow".

It starts from an SRS carrying FRs and a configured board, and the first ticket moving past Backlog is what marks the base setup underway.

On a resumed session, run `tool-saasfoundry`'s `scripts/recap.sh` before assuming anything: it reads the phase from the manifest and the board, never from chat history.

### Milestones

A release scope is defined in this layer and projected per tool — `workflow-cli.sh milestone create|list|show|scope|assign|associate`. GitHub has native milestones, Jira fix versions, Linear cycles; the concept does not belong to any of them.

A version is **associated** to a release, never equal to it: one milestone per release, and several SRS version pages may point at it. The association travels with the milestone in the tool that holds it, not in `.saasfoundry.json`.

**A milestone reports; it never blocks a release.** It states where the scope stands and asks for an acknowledgement to continue on an incomplete one — it does not refuse. See Epic #542.

The `tool-saasfoundry` skill carries the Milestone Guardrail: when to raise the subject, and how to propose a scope from evidence rather than from a guess.
