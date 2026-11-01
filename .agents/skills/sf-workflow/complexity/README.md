# Complexity-Based Adaptive Workflow

This directory contains complexity configurations that adapt the workflow process based on ticket complexity.

## Complexity Levels

| Level       | Label      | Style              | Use Case                               |
| ----------- | ---------- | ------------------ | -------------------------------------- |
| **bug**     | 🐛 Bug Fix | Direct fix         | Quick bug fixes, minimal ceremony      |
| **low**     | 🟢 Low     | Oneshot            | Simple tasks, fast iteration           |
| **medium**  | 🟡 Medium  | Structured         | Standard features, structured approach |
| **complex** | 🔴 Complex | Deep + adversarial | Critical features, adversarial review  |

## How It Works

### 1. Complexity Detection

When a ticket enters Backlog, the AI suggests a complexity level based on:

- Number of files potentially impacted
- Keywords in description (auth, payment, security → complex)
- Risk assessment
- Historical similar tickets

**Developer always has final say on complexity tag.**

### 2. Adaptive Steps

Each complexity level enables/disables workflow steps:

#### Bug (🐛)

- Skip: Backlog (direct to In Progress)
- Skip: Analyze, Plan
- Execute: Direct fix (delegated as `bug-fix`, or `scoped-edit` when the ticket or its triage already names two files or fewer)
- Validate: Build + lint + regression test
- Skip: Examine
- Tests: Regression test only

#### Low (🟢)

- Analyze: Minimal (2-3 files, no agents)
- Plan: Mental plan only
- Execute: Direct implementation (delegated as `scoped-edit`, though a `low` ticket may touch up to three files)
- Validate: Lint + typecheck
- Skip: Examine
- Tests: Optional

#### Medium (🟡)

- Analyze: Standard (2-4 agents)
- Plan: Detailed file-by-file (requires approval)
- Execute: Subtasks mandatory (delegated as `multi-file-feature` once decomposed)
- Validate: Build + lint + typecheck + unit tests
- Skip: Examine
- Tests: Unit + E2E recommended

#### Complex (🔴)

- Analyze: Deep (6-10 agents)
- Plan: Comprehensive with dependencies (requires approval)
- Execute: Granular subtasks mandatory (delegated as `multi-file-feature` once decomposed)
- Validate: Full test suite
- **Examine: Adversarial review (security, logic, performance)**
- Tests: Unit + E2E + regression mandatory (80% coverage)

### 3. Configuration Format

Each `.yml` file contains:

```yaml
name: complexity-level
label: "Display label"
description: "Description"

skipStatuses: []  # Which statuses can be skipped

steps:
  analyze:
    enabled: boolean
    depth: "minimal" | "standard" | "deep"
    agents: number  # 0-10
  plan:
    enabled: boolean
    depth: "minimal" | "detailed" | "comprehensive"
    approval: boolean
  subtasks:
    enabled: boolean
    mandatory: boolean
  execute:
    taskKind: task-kind  # delivery by a delegated agent, sized to the work
  examine:
    enabled: boolean
  tests:
    type: "optional" | "recommended" | "mandatory"
    mandatory: boolean

testing:
  unit: boolean
  e2e: boolean
  regression: boolean
  coverage: number | null

aiInstructions: |
  Guidance for AI on how to approach this complexity level
```

## Schema

The format above is the summary; this section is the reference. A profile is one file, `complexity/<name>.yml`, where `<name>` is the value of the ticket label `complexity: <name>` and equals the
`name` key.

Two kinds of keys exist, and the difference matters when you edit one:

- **Script-read** keys are parsed by a shell script. Their exact spelling, indentation and position count (see [How the scripts read a profile](#how-the-scripts-read-a-profile)).
- **Agent-read** keys are read by the coding agent when it opens the file (the `prepare` and `test` commands tell it to follow the profile). No script reads them. Changing one changes the guidance the
  agent works from, not the behaviour of any guard.

| Key                          | Type                        | Required | Read by                        | Meaning                                                                                                                                                              |
| ---------------------------- | --------------------------- | -------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                       | string                      | yes      | agent                          | The level identifier. Must equal the file name without `.yml` and the label suffix.                                                                                  |
| `label`                      | string                      | yes      | agent                          | Display label with its emoji. `detect-complexity.sh` prints its own copy of these labels; it does not read this key.                                                 |
| `description`                | string, quoted              | yes      | `scripts/detect-complexity.sh` | One line printed as "What this means" after a suggestion. Parsed with `grep` + `sed`, which strip one pair of double or single quotes.                               |
| `skipStatuses`               | list of status names        | yes      | agent                          | Statuses the level may skip. `[]` means none. Only `bug` uses it (`Backlog`). No script enforces it: the status guards are in `workflow-cli.sh` and ignore this key. |
| `steps.analyze.enabled`      | boolean                     | yes      | `scripts/analyze.sh`           | `false` makes the script print "Analysis SKIPPED" and exit.                                                                                                          |
| `steps.analyze.depth`        | string or `null`            | yes      | `scripts/analyze.sh`           | `minimal`, `standard` or `deep` (`null` when disabled). Printed as the analysis depth.                                                                               |
| `steps.analyze.agents`       | integer                     | yes      | `scripts/analyze.sh`           | Number of parallel exploration agents to launch (`0` = direct tools only). Printed.                                                                                  |
| `steps.analyze.taskKind`     | task kind                   | no       | agent                          | Task kind of the analysis delegations (`exploration`). Resolved with `sf agents route`, see [SKILL.md → Delegation routing](../SKILL.md#delegation-routing).         |
| `steps.plan.enabled`         | boolean                     | yes      | `scripts/plan.sh`              | `false` makes the script print "Planning SKIPPED" and exit.                                                                                                          |
| `steps.plan.depth`           | string or `null`            | yes      | `scripts/plan.sh`              | `minimal`, `detailed` or `comprehensive` (`null` when disabled). Printed.                                                                                            |
| `steps.plan.approval`        | boolean                     | yes      | `scripts/plan.sh`              | Whether the user must approve the plan before implementation. Printed as "Approval required".                                                                        |
| `steps.subtasks.enabled`     | boolean                     | yes      | agent                          | Whether the work is split into subtasks (real tickets, created with `create-subtask`).                                                                               |
| `steps.subtasks.mandatory`   | boolean                     | yes      | agent                          | Whether skipping subtasks is a violation.                                                                                                                            |
| `steps.subtasks.threshold`   | integer                     | no       | agent                          | Number of impacted files above which subtasks are created although `enabled` is `false` (`low` uses `3`).                                                            |
| `steps.subtasks.detailed`    | boolean                     | no       | agent                          | More granular subtasks (`complex` sets it).                                                                                                                          |
| `steps.execute.taskKind`     | task kind                   | no       | agent                          | Task kind of a delegated whole-ticket delivery, sized to the work. See [SKILL.md → Delegated ticket delivery](../SKILL.md#delegated-ticket-delivery).                |
| `steps.execute.scoped*`      | task kind, integer          | no       | agent                          | `bug` only: `scopedTaskKind` (`scoped-edit`) applies when the ticket or its triage names `scopedMaxFiles` (`2`) files or fewer.                                      |
| `steps.examine.enabled`      | boolean                     | yes      | agent                          | Adversarial review. The `test` command runs `scripts/examine.sh` when the level is literally `complex`, whatever this key says.                                      |
| `steps.examine.agents`       | integer                     | no       | agent                          | Parallel review agents (`complex` sets `3`).                                                                                                                         |
| `steps.examine.taskKind`     | task kind                   | no       | agent                          | Task kind of the review delegations (`review`).                                                                                                                      |
| `steps.examine.checks`       | list of strings             | no       | agent                          | Review lenses: `security`, `logic`, `performance`.                                                                                                                   |
| `steps.tests.type`           | string                      | yes      | agent                          | `regression` (bug), `optional`, `recommended` or `mandatory`.                                                                                                        |
| `steps.tests.mandatory`      | boolean                     | yes      | agent                          | Whether the tests phase can be skipped.                                                                                                                              |
| `testing.unit` `testing.e2e` | boolean                     | yes      | agent                          | Which test kinds the level expects.                                                                                                                                  |
| `testing.regression`         | boolean                     | yes      | agent                          | Whether a regression test is expected.                                                                                                                               |
| `testing.coverage`           | integer (percent) or `null` | yes      | agent                          | Minimum coverage target; `null` means none. Only `complex` sets one (`80`).                                                                                          |
| `aiInstructions`             | block scalar (`\|`)         | yes      | agent                          | Phase-by-phase guidance for the agent: Analyze, Plan, Execute, Validate, Examine, Tests, and optionally Save Mode or Output.                                         |

"Required" means every shipped profile sets the key and the scripts or the agent expect it; nothing validates a profile against a schema, so a missing key fails silently (an empty value in a script,
or a gap in the agent's guidance).

### How the scripts read a profile

The scripts do not parse YAML. `analyze.sh` and `plan.sh` read one key of one step block with a small `awk` function, `step_value`:

```bash
# scripts/analyze.sh (plan.sh reads the "plan" block the same way)
ANALYZE_ENABLED=$(step_value "$CONFIG_FILE" analyze enabled)
```

The block starts at its two-space header and ends at the next two-space header or top-level key, so a key is never read from a neighbouring block.

Consequences to respect when editing:

- The block header must be indented exactly two spaces (`  analyze:`, `  plan:`), under `steps:`.
- The keys are indented four spaces under their header and matched by name; the value is the second whitespace-separated token of the line, with its quotes removed. Write scalar values without spaces;
  a trailing `# comment` is fine.
- `description` stays on one line, in double or single quotes, for `detect-complexity.sh`. Either style works, so a formatter that rewrites the quotes (Prettier does this to YAML) changes nothing.

### Where the level names are fixed

The four level names are not discovered from the directory. They are repeated in code, so a new file in `complexity/` is not picked up on its own:

| Place                                                                      | What it fixes                                                                                        |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `github-projects-cli.sh` `set-complexity` and `create-ticket --complexity` | The accepted values (`bug`, `low`, `medium`, `complex`). `retag` goes through this command.          |
| `workflow-cli.sh` complexity guard and the `sync-pr-review` label check    | The label values the guards recognise.                                                               |
| `scripts/analyze.sh`, `scripts/plan.sh`                                    | A `case` per level holding the long-form guidance text; any other level prints "Unknown complexity". |
| `scripts/detect-complexity.sh`                                             | The keyword scoring and the score thresholds that choose `bug`, `low`, `medium` or `complex`.        |
| `workflow-cli.sh test`                                                     | Adversarial review is tied to the literal level `complex`.                                           |

## Annotated example

`medium.yml`, with each key annotated by who reads it:

```yaml
name: medium # agent: must equal the file name and the label suffix
label: '🟡 Medium Complexity' # agent: display only
description: 'Standard feature with structured analysis and planning' # detect-complexity.sh: one line, either quote style

skipStatuses: [] # agent: no status may be skipped

steps:
  analyze:
    enabled: true # analyze.sh
    depth: 'standard' # analyze.sh
    agents: 3 # analyze.sh: 2-4 parallel agents
    taskKind: exploration # agent: resolved with sf agents route --task exploration
  plan:
    enabled: true # plan.sh
    depth: 'detailed' # plan.sh: file-by-file plan
    approval: true # plan.sh: the user approves before implementation
  subtasks:
    enabled: true # agent: split into real subtask tickets
    mandatory: true # agent
  execute:
    taskKind: multi-file-feature # agent: delivery of the whole ticket by a delegated agent, resolved with sf agents route --task multi-file-feature
  examine:
    enabled: false # agent: no adversarial review at this level
  tests:
    type: 'recommended' # agent
    mandatory: false # agent: recommended, not forced

testing:
  unit: true # agent: unit tests for business logic
  e2e: true # agent: end-to-end for user workflows
  regression: true # agent
  coverage: null # agent: no numeric target

aiInstructions: | # agent: one paragraph per phase
  This is a medium-complexity feature. Use a structured approach:

  **Analyze Phase (STANDARD):**
  - Launch 2-4 parallel exploration agents
  ...
```

The other three profiles follow the same shape. What sets them apart is which steps are on: `bug` turns analyze, plan, subtasks and examine off and keeps a mandatory regression test; `low` keeps a
minimal analyze and plan without approval; `complex` adds mandatory approval, mandatory granular subtasks, the adversarial review (3 agents, three checks) and an 80% coverage target. They also differ
in `steps.execute.taskKind`, the task kind of a delegated delivery sized to the work: `bug-fix` (or `scoped-edit` through `scopedTaskKind` when the ticket or its triage already names two files or
fewer) for `bug`, `scoped-edit` for `low`, `multi-file-feature` for `medium` and `complex`.

## Adding or changing a profile

**Changing the behaviour of an existing level** (the common case): edit its `.yml`.

1. Edit only the values; keep the structure, the two-space indentation of `analyze:` and `plan:`, and the one-line quoted `description`.
2. Mirror the change in the "Adaptive Steps" summary above, and in `aiInstructions` when the agent's guidance changes.
3. Check what the scripts read: `bash scripts/analyze.sh 0 <level>` and `bash scripts/plan.sh 0 <level>` print the values they extracted.
4. The profiles are part of the installed skill: a skill refresh can overwrite a local edit, so keep project-specific changes under review in version control.

**Adding a new level** needs more than a new file, because the names are fixed in code (see the table above):

1. Create `complexity/<name>.yml` from the closest existing profile.
2. Add the name to the accepted values in `set-complexity` and `create-ticket --complexity` (`github-projects-cli.sh`), and to the label checks in `workflow-cli.sh`.
3. Add a `case` branch to `scripts/analyze.sh` and `scripts/plan.sh`, and a score range to `scripts/detect-complexity.sh` if it should be suggested automatically.
4. Create the `complexity: <name>` label on the board repository, document the level in the tables of this file and of `SKILL.md`.
5. Add a test for the new accepted value; a level that exists only as a file is rejected by `retag` and by the guard.

Changing a level's rigor is a workflow change: ticket by ticket, `retag` is the supported way to move a ticket to another level, not editing the profile.

## Changing Complexity

If a ticket's complexity changes during development:

```bash
/workflow retag {ticket-number} {new-complexity}
```

This adjusts remaining steps to match the new complexity level.

## Quality Preservation

- **Bug**: Fast triage, regression test
- **Low**: Oneshot quality (minimal exploration, direct fix)
- **Medium**: Structured quality (planned, no adversarial review)
- **Complex**: Maximum rigor (deep analysis, adversarial review, comprehensive testing)
