# moltenterm

AI-assisted workflow harness installed by SaaSFoundryAI (CLI v1.0.0). This project keeps its own technical stack — SaaSFoundryAI only manages the AI collaboration layer (workflow, skills, SRS).

## Product vision

Read `MANIFESTO.md` before proposing features or architecture: it defines what Moltenterm is, its principles (non-negotiables), its non-goals and its roadmap phases.

## 🧭 Preconditions first (read before asking questions)

Before asking the user anything about scope, workflow, or tooling, **read the manifest and check the configured tools**:

1. Read `.saasfoundry.json` — source of truth for the workflow configuration, SRS backend, and installed modules. Never re-ask what is already declared there.
2. Run `sf status --claude-friendly --no-network` for a summary of the manifest and preconditions. On a configured session this is auto-injected via the `SessionStart` hook in `.claude/settings.json`.
3. If a precondition is `fail`, route the user to the relevant install/config CLI (`sf workflow`, `sf update --add-modules srs`, `sf skill install`) instead of asking scope questions.

## Managed project capabilities

Treat the capability block from `sf status --claude-friendly --no-network` as authoritative. When an eligible managed `harness` project should become `full`, preview the additive transition with
`sf update --target-profile full --dry-run --json`. Do not run `sf new --profile full` inside this repository. Keep a retained external product on the harness path; rebuild a throwaway POC only
through the documented POC-preservation and clean-project flow.

## Coding-agent identity and onboarding

Use the coding-agent identity explicitly supplied by the current host or session. Never infer it from a model/provider name, executable, repository file, or PATH. If the identity is absent or
ambiguous, ask the user to choose a registered coding-agent profile and do not change the project.

Run `sf agents list --json`. When the current supported tool is undeclared, ask the user to choose one action: add it, replace the declaration with an explicitly named non-empty set, or leave the
project unchanged. Ask whether the choice is local to this checkout or shared through the repository only after add or replace is accepted. Use `sf agents enable` for add and `sf agents replace` for
exact replacement. No change runs no mutating command. Replacement changes inventory only and never deletes existing instructions, skills, hooks, settings, credentials, or exclusions.

## Output language

Everything you produce — SRS pages, tickets and their comments, code comments, commit messages — is written in the language declared in `.saasfoundry.json` → `language`, which defaults to English on all three surfaces (`srs`, `tickets`, `codeComments`).

**The language of the conversation is not the signal.** Talking with the user in French does not make the artefacts French. `sf status --claude-friendly` prints the resolved values.

## Git Workflow

- Main branch: `main` (see `.saasfoundry.json` → `workflow.workingBranch` / `prTargetBranch` — never hardcode branch names)
- **Branch naming — the ticket number is mandatory.** Read the patterns from `.saasfoundry.json` → `workflow.branchNaming`; the defaults are `feature/{N}-{description}` and `fix/{N}-{description}`.
- **Why the `{N}` prefix is not cosmetic:** the workflow guards resolve a ticket's PR by matching `^(feature|fix)/<ticket>(-|$)` against open PR head branches. A branch without the ticket number matches nothing, so the `→ In Review` PR-existence guard and the `→ Done` PR-merged guard both fail — and the only way forward becomes `SF_WORKFLOW_BYPASS_*` on every ticket, silently disabling the guards project-wide. If the pattern and the regex ever disagree, realign `branchNaming`; never "fix" the regex.
- Commit format: see `.saasfoundry.json` → `workflow.commitFormat` (a ticket reference is required when `requireTicket` is true).

## Workflow System

**This project uses an AI-assisted workflow system. All workflow documentation is managed by the `sf-workflow` skill.**

### Quick Reference

- **Tool**: GitHub Projects
- **Project URL**: https://github.com/orgs/DiamondForgeFr/projects/5
- **Working Branch**: `develop`
- **PR Target Branch**: `develop`
- **Workflow Template**: SaaSFoundry Solo

### Branch Naming

- Features: `feature/{N}-{description}`
- Fixes: `fix/{N}-{description}`
- Releases: `rc-{version}`

### Commit Format

Pattern: `type(#N): description`

**Ticket reference is required in commit messages.**

Allowed types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `chore`, `ci`, `build`, `revert`

### Workflow Commands

Use the `sf-workflow` skill CLI to check your current status and next steps:

```bash
# Check current ticket status and what to do
.claude/skills/sf-workflow/workflow-cli.sh status <ticket-number>

# Show next status in the workflow
.claude/skills/sf-workflow/workflow-cli.sh next <ticket-number>

# Display full workflow documentation
.claude/skills/sf-workflow/workflow-cli.sh help
```

**IMPORTANT**: The workflow skill contains detailed status descriptions, mandatory actions, and exit conditions for each workflow phase. Always consult it before moving tickets between statuses.

## Development Commands

Moltenterm is a soft fork of Wave Terminal, so the toolchain and commands are Wave's. `UPSTREAM.md` holds the details and the upstream sync procedure.

- **Toolchain:** Go 1.25.6 (pinned by `go.mod`; Task exports `GOTOOLCHAIN` so `go` switches to it, `task check:go` verifies), Task v3, Node 22 with npm 10.9.2, Zig (CGO builds on Linux and Windows only).
- `task init`: install the npm dependencies (app and docs site) and tidy the Go modules (first run, and after dependency changes).
- `task dev`: run the app through the Vite dev server. The renderer hot-reloads; Electron main needs a restart; re-run the task to rebuild wavesrv. Dev mode uses the `waveterm-dev` configuration and data directories.
- `task start` runs the app without the dev server; `task package` builds a distributable into `make/`.
- **Validation:** `task check:ts` (TypeScript, frontend and Electron), `npx vitest run` (frontend unit tests), `go test ./cmd/... ./pkg/...` (backend), `node scripts/moltenterm-check-ledger.mjs` (every changed Wave file is ledgered and marked). Run `task generate` after changing Go RPC types. Never call `go build` directly; use the Task targets.
- **CI:** `.github/workflows/ci.yml` runs these checks, ESLint and the builds on pull requests; drafts get only the quick checks (see `UPSTREAM.md`, "Continuous integration").

## Git remotes

- `origin` is Moltenterm. `upstream` is Wave Terminal, fetch-only, without tags.
- `gh` resolves a remote named `upstream` before `origin`. Pin the default repository once per clone with `gh repo set-default DiamondForgeFr/moltenterm`, otherwise ticket and PR commands target Wave's repository.

## Codebase conventions (upstream Wave)

Wave's own agent instructions stay in the repository and apply to its code. Where they disagree with the SaaSFoundryAI workflow above (tickets, branches, commits, output language), the workflow wins.

@.kilocode/rules/rules.md

---

## Skill Guides

This project uses a set of "skill" guides — focused how-to documents for common implementation tasks. When your task matches one of the descriptions below, **read the linked SKILL.md file before proceeding** and follow its instructions precisely.

| Skill        | File                                     | Description                                                                                                                                                                                                                                 |
| ------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| add-config   | `.kilocode/skills/add-config/SKILL.md`   | Guide for adding new configuration settings to Wave Terminal. Use when adding a new setting to the configuration system, implementing a new config key, or adding user-customizable settings.                                               |
| add-rpc      | `.kilocode/skills/add-rpc/SKILL.md`      | Guide for adding new RPC calls to Wave Terminal. Use when implementing new RPC commands, adding server-client communication methods, or extending the RPC interface with new functionality.                                                 |
| add-wshcmd   | `.kilocode/skills/add-wshcmd/SKILL.md`   | Guide for adding new wsh commands to Wave Terminal. Use when implementing new CLI commands, adding command-line functionality, or extending the wsh command interface.                                                                      |
| context-menu | `.kilocode/skills/context-menu/SKILL.md` | Guide for creating and displaying context menus in Wave Terminal. Use when implementing right-click menus, adding context menu items, creating submenus, or handling menu interactions with checkboxes and separators.                      |
| create-view  | `.kilocode/skills/create-view/SKILL.md`  | Guide for implementing a new view type in Wave Terminal. Use when creating a new view component, implementing the ViewModel interface, registering a new view type in BlockRegistry, or adding a new content type to display within blocks. |
| electron-api | `.kilocode/skills/electron-api/SKILL.md` | Guide for adding new Electron APIs to Wave Terminal. Use when implementing new frontend-to-electron communications via preload/IPC.                                                                                                         |
| waveenv      | `.kilocode/skills/waveenv/SKILL.md`      | Guide for creating WaveEnv narrowings in Wave Terminal. Use when writing a named subset type of WaveEnv for a component tree, documenting environmental dependencies, or enabling mock environments for preview/test server usage.          |
| wps-events   | `.kilocode/skills/wps-events/SKILL.md`   | Guide for working with Wave Terminal's WPS (Wave PubSub) event system. Use when implementing new event types, publishing events, subscribing to events, or adding asynchronous communication between components.                            |
