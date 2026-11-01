# Claude Code

The project instructions are in `AGENTS.md`, which Claude Code reads natively. This rule adds what only Claude Code does.

- **Session start.** `.claude/settings.json` declares a `SessionStart` hook that runs `sf status --claude-friendly --no-network` (an alias of `--agent-friendly`) and injects its output: the preconditions are already in context
  when the session opens.
- **Skills.** Invoke a skill by name with `/sf-<name>` (for example `/sf-workflow`); Claude Code discovers them under `.claude/skills/`.
- **Permissions.** The harness's read-only commands (`workflow-cli.sh status|next|help`, the board CLI's read commands, `sf status`, `sf agents list`, `sf agents route`, `sf agents routing report`) are
  allowed in `.claude/settings.json`; commands that change a ticket, a board or a pull request, or write evidence the routing acts on (`sf agents outcome record|mark`, and `sf agents route` with
  `--record` or `--retry-of`, listed under `permissions.ask`), still ask.
- **Delegation capture.** `SubagentStop` (for `sf-*` agents) and `PostToolUse` (on `Agent`) hooks in `.claude/settings.json` record every delegation without any action from the session; see "Measured
  delegations" in the workflow skill.
- **File edits.** Use the Read, Edit and Write tools, never interpreter heredocs or scripts that rewrite files (`python3 - <<EOF`, `node -e`): Claude Code cannot analyse those calls, so each one asks
  for permission, even in bypass mode.
