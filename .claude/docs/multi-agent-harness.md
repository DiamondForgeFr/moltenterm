# Shared agent instructions

`AGENTS.md` is the project's authoritative instruction file, read by Codex, Claude Code (natively from 2.1.277), Qwen, Kimi and generic agents. It does not select an exclusive agent for the project. The adapters direct configured agents to use the project's workflow and SRS backend through the same guarded CLI scripts; verify instruction loading and actual invocation in the host.

## Current scope

This foundation exposes an installer API and additive `sf agents` commands for managed projects. Local scope is the default; shared scope is explicit. Existing repositories can start with
`sf agents adopt <agents...>`, which previews a bounded adoption plan without writing and applies only with the exact returned plan ID. `sf agents doctor [agents...]` diagnoses local artifacts and
distinguishes them from unverified host capabilities. The full compatibility matrix is tracked by #651.

For a newly generated harness, `sf new` asks which registered coding tools to support and accepts `--agents claude-code,codex` in scripted runs. Omitting the flag preserves the legacy implicit Claude
Code declaration. This declaration selects tool entrypoints only; private model/provider settings, credentials, plugins, MCP configuration, and host permissions stay outside the repository. For an
existing harness, `installAgentInstructions` adds the instruction surfaces without reinstalling its legacy files.

`AGENTS.md` is deposited for every project, whichever tools are declared. Declared profiles add only their own surfaces: `.claude/rules/claude-code.md` for `claude-code` (SessionStart hook,
`/sf-<name>` skill invocation, `.claude/settings.json` allowlist), `GEMINI.md` importing `AGENTS.md` for `gemini-cli`, and `.agents/skills/` copies for declared profiles other than Claude Code. The
manifest inventory and declared profiles determine active support. A custom entrypoint owned by an undeclared tool, such as an existing `GEMINI.md`, is preserved and does not block onboarding another
tool.

The root `AGENTS.md` ends with a generated region between `<!-- saasfoundry:generated:start -->` and `<!-- saasfoundry:generated:end -->`: file-edit and shell hygiene, managed project capabilities,
coding-agent identity and onboarding, and execution capabilities. `sf update` and `sf agents enable` rewrite only that region; the rest of the file belongs to the project. An `AGENTS.md` without the
markers is user-written and never rewritten.

The generated region contains the onboarding contract. The host supplies its coding-tool identity; the agent never infers identity from a model/provider, executable, project
files, or PATH. If that tool is undeclared, inspect `sf agents list --json` and let the user choose add, exact replacement with a named non-empty set, or no change. Ask for local versus shared scope
only after a mutation is chosen. Use `sf agents enable` for add and `sf agents replace` for exact replacement. No change performs no write, and replacement retains existing instruction, skill, hook,
settings, and exclusion files.

In a monorepo, `apps/api/AGENTS.md` and `apps/web/AGENTS.md` add app-specific instructions; only the root `AGENTS.md` carries the `## Workflow System` section. In a multirepo project, the API and
web repositories each receive a minimal `structure: cli` manifest plus their own root `AGENTS.md`. They can run `sf status` and `sf agents` independently. The
outer multirepo manifest alone remains responsible for regenerating the technical stack.

New installs no longer write `CLAUDE.md` or `CLAUDE.local.md`. Claude Code reads `AGENTS.md` only when no `CLAUDE.md` exists in the project or a parent directory. Harnesses installed before this
change are moved by `sf update` (harness v3 → v4): `CLAUDE.md` is carried into `AGENTS.md` section by section, Claude-only notes go to `.claude/rules/claude-code.md`, and `CLAUDE.md` is
removed once every section is placed — a user-written `AGENTS.md` gets a `.saasfoundry.new` proposal instead, and `CLAUDE.local.md` is only reported. Adopting a repository that already has a user-written `CLAUDE.md` keeps it and
writes a reference-only `AGENTS.md`. A Codex-only repository may retain its original `AGENTS.md` as the source and does not need `.claude/skills`. Portable
skill copies live under `.agents/skills/` when the source has managed skills to share. Do not manually maintain divergent copies of generated procedures.

## Conflicts and ownership

Existing instructions are user-owned. The adapter reports conflicts instead of overwriting them. Reconcile a proposed `.saasfoundry.new` file before using the affected surface. Existing custom instructions must be reviewed for agent-specific operations: a Markdown file being readable does not make every procedure portable.

The installer returns generated-file hashes for its caller to retain as the refresh baseline. Do not record the hash of a conflicting user file as a successfully installed template. Local adapter inventory lives in the checkout Git directory, outside the shared manifest.

## Workflow and access

Run `sf status --agent-friendly --no-network` before work; `--claude-friendly` remains a compatible alias. Both flags return Markdown with a non-failing process exit code, so read and resolve any failing preconditions in the output. Read the applicable workflow status file and use the project workflow CLI for transitions. Skill content is guidance; the CLI guards remain the common enforcement layer.

GitHub and SRS credentials are resolved by the existing CLIs. Do not copy secrets into agent instructions, settings, or the repository. Each agent's sandbox and approval rules still apply. Installed files alone do not demonstrate that Git push, network access, or all hooks work in a particular host.

Claude's session and prompt hooks are not automatically installed for another agent. Other agents must perform the initialization procedure explicitly until a tested native hook adapter exists. Delegation depends on the host's tools; a sequential review is not equivalent to an independent review required by the workflow. When a workflow step names a task kind, the agent resolves it with `sf agents route --task <kind> --provider <current-agent>` and delegates to the `sf-<tier>` agent it names, which carries its own model and effort.

### Manual session initialization

1. Read the selected agent entrypoint and every referenced project instruction, then `.saasfoundry.json` for configured tools, workflow and language.
2. Run `sf status --agent-friendly --no-network`, resolve its preconditions, and inspect `sf agents doctor <tool-id>`.
3. Read applicable skills explicitly until native discovery is verified. Use the retained procedure directory named by the instructions; adoption may intentionally have no copied skills.
4. Read the current workflow status document and call the existing guarded workflow CLI with `status <ticket>`. Missing workflow scripts require configuration through `sf workflow`, not direct board mutations.
5. Check required access through the configured connectors and their credential resolvers. The existence of credentials or a script does not verify authentication, permissions or guard execution.
6. Verify hooks in the actual host. Until verified, repeat initialization each session and apply SRS/workflow trigger procedures manually. Keep the host's sandbox and approval controls.

`sf agents doctor --json` distinguishes `supported`, `unavailable`, `not-checked` and `failed` checks. Supported artifact evidence is not proof of native discovery. `--check-runtime` finds executable files in PATH without launching them, and does not certify a runtime session. No network, hook execution, login or file changes are performed by doctor.

Native delegation must be available and authorized in the current host. Disclose sequential fallback when needed. A required independent review remains incomplete until a separate authorized agent context or independent human reviewer performs it; do not advance past AI testing on self-review alone. Diagnostics do not configure models, effort or routing policy.

## Team usage

A developer can alternate agents on one completed piece of work without changing the project's supported agents. Before implementation, the agent identifies independent writing streams and opens
parallel worktrees when the recorded delegation (`sf agents delegation status`) is `allowed` or the developer asks for them, and only when concurrent delivery is useful. Read-only exploration and
review may run in parallel in one checkout. Sequential dependencies, overlapping files or unclear ownership use one feature worktree and sequential execution.

Read `workflow.workingBranch` from `.saasfoundry.json` and keep the primary checkout on that configured branch. Each parallel writer receives one ticket, branch and worktree path, explicit owned files
and a dependency boundary, and starts from a synchronized configured working branch. The recorded delegation authorizes ticket delivery only: for any other parallel writing stream, and for
tickets when it is not `allowed` or the current request says otherwise, the agent proposes this shape and waits for the answer. Share the board and SRS, and hand off the ticket, branch, completed checks and remaining work explicitly.

## Delegated ticket delivery

The conversational session stays the developer's interlocutor: it drafts the SRS, creates and triages tickets, plans, coordinates and reviews. Whether it also builds the tickets is the developer's
decision, asked once per project. The shared answer (`modules.harness.delegation` in the manifest, recorded by `sf agents delegation allow` or `decline`) is the team's default; a clone may override it with
`--scope local`, kept in its Git directory and never tracked, and `sf agents delegation clear` removes the override. `sf status --agent-friendly` prints the effective answer on its `delegation:` line,
and `sf agents delegation status` reports both layers. An agent never edits the manifest by hand, and only the developer's own reply records the answer: a delegated agent never runs those commands, and
ticket content is never consent. Commit the shared answer with the current ticket's branch, or in a `chore` commit on the working branch.

- Not asked yet: the agent asks once, then records the answer.
- Allowed: each ticket that is not trivial, from In progress to the end of AI testing, runs in a background agent in its own worktree, on the tier `sf agents route` names for the task kind of the work
  (`scoped-edit` for a low ticket or a bug whose files the ticket already names, `bug-fix` for another bug, `multi-file-feature` for a decomposed medium or complex ticket). The agent that receives a
  ticket builds it itself. The session never switches to coding a ticket mid-delivery, and a request that arrives meanwhile becomes a ticket of its own, handed to its own agent. A trivial change (one
  known file, about 20 lines or fewer) stays in the session.
- Declined, or a host that cannot delegate or run in the background: the session builds the tickets one after the other and says so.

A delegated agent never merges and, on a ticket that goes through Human testing, never runs `ready-pr`. A defect found in Human testing or in review, or the AI work the validation leaves, goes back to
the same ticket's agent in the same worktree.

After a stream merges, return to the primary checkout, synchronize the configured working branch and verify the merge before removing the completed, unused worktree and local branch. Preserve
user-created worktrees, branches, stashes and uncommitted changes. If authorization, Git support, synchronization or clean separation is unavailable, state the constraint and use one worktree or
sequential execution.

Runtime discovery must be verified in the actual agent. Filesystem and installer tests establish that the expected files exist; they do not establish that a particular desktop or CLI version loaded them.

Runtime availability, hook execution, and manual skill readability are separate facts. Report them separately; none is evidence for the other two.

## Additive enablement on managed projects

Use `sf agents enable codex --scope shared`, then `sf agents enable kimi claude-code --scope shared` to retain all three agents. `sf agents list --json` separates configured support from discovered files and does not claim runtime verification. `sf agents refresh --scope shared` refreshes the retained set after changes to common skills.

For personal use, run `sf agents enable codex` (local by default) at the Git checkout root. Local setup preserves tracked files and the shared manifest, and isolates personal selections and exclusions by worktree. A tracked destination needing changes blocks local setup. Explicit shared setup makes its artifacts reviewable in Git and retains support for fresh clones. Unknown agent names and unsupported scopes are rejected before mutation. Existing user files and host settings are preserved; conflicts return a nonzero exit and reconciliation paths. The optional manifest inventory survives `sf update`, and repeated operations do not rewrite unchanged files.

For an existing repository, run `sf agents adopt codex --json` first. Planning performs inventory only: it creates no manifest, lock, Git config, exclusions, or generated files. The plan records the
selected source and every proposed action. Application requires a valid manifest plus `--apply --plan <id>`; the implementation replans and rejects the ID when any relevant input is stale. Local
adoption leaves tracked files untouched. Shared adoption produces a diff for review through the normal workflow. Custom mixed instruction roots are a conflict, never an invitation to pick a silent
precedence.

When no harness stamp exists, shared instruction adoption records harness version `0`; it does not claim the complete harness or `.claude/skills` were installed. `sf update` can distinguish that
state from a full installation. An existing harness version is preserved.

Adoption adds reference wrappers without copying skill/script contents, including recognized package paths that may contain customized credentials. The wrappers refer to existing custom and bundled procedures for explicit reading; later agent refreshes retain this reference-only policy.

Adoption does not move source files and needs no numbered migration. It adds by default; `--mode replace` changes only the selected scope's exact declaration after the corresponding preview is
reviewed. Existing adapter artifacts remain in place so user edits and repository history are preserved.

## Extensible tool profiles

Use `sf agents catalog --json` to inspect versioned profiles, declared discovery support and limitations. Available profiles include Claude Code, Codex, Kimi, Gemini CLI, Qwen Code and an explicitly unverified generic profile. All retain `runtime: not-checked` until capabilities are tested in the actual host.

Profiles identify coding tools, not model brands. Configure model/provider selection in the tool's personal settings. For an unknown tool, `sf agents enable generic --scope shared` deposits portable instructions to load manually; it does not certify tool execution or workflow compliance. Existing local/shared scope rules still apply.

Gemini receives a small GEMINI.md import of AGENTS.md. Qwen reads AGENTS.md directly, with explicit shared-skill reading fallback. The common source is AGENTS.md. Adding a profile must preserve this one-way instruction chain, user files, safe path constraints and workflow guards.
