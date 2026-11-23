# Claude Code

The project instructions are in `AGENTS.md`, which Claude Code reads natively. This rule adds what only Claude Code does.

- **Session start.** `.claude/settings.json` declares a `SessionStart` hook that runs `status --agent-friendly --no-network` through the project's own CLI (`node_modules/.bin/saasfoundryai`, then `bin/sf.js` in the
  SaaSFoundryAI CLI repository, then `saasfoundryai` on the PATH; never a bare `sf`) and injects its output: the preconditions are already in context when the session opens. The report states facts; the
  rules for reading it are in `AGENTS.md`, under "Reading the project status".
- **Skills.** Invoke a skill by name with `/sf-<name>` (for example `/sf-workflow`); Claude Code discovers them under `.claude/skills/`.
- **Permissions.** The harness's read-only commands (`workflow-cli.sh status|next|help`, the board CLI's read commands, `sf status`, `sf agents list`, `sf agents route`, `sf agents routing report`) are
  allowed in `.claude/settings.json`; commands that change a ticket, a board or a pull request, or write evidence the routing acts on (`sf agents outcome record|mark`, and `sf agents route` with
  `--record` or `--retry-of`, listed under `permissions.ask`), still ask.
- **Delegation capture.** `SubagentStop` (for `sf-*` agents) and `PostToolUse` (on `Agent`) hooks in `.claude/settings.json` record every delegation without any action from the session; see "Measured
  delegations" in the workflow skill.
- **File edits.** Use the Read, Edit and Write tools, never interpreter heredocs or scripts that rewrite files (`python3 - <<EOF`, `node -e`): Claude Code cannot analyse those calls, so each one asks
  for permission, even in bypass mode.
- **Shell calls.** One plain command per Bash call (`AGENTS.md`, "File edits and shell calls"). A `PreToolUse` hook in `.claude/settings.json` runs `sf agents guard` on the calls whose payload could hold
  a chain (`&&`, `;`, `||`, a newline), a substitution (`$(…)`, backticks), a loop or group, a background `&`, an inline script (`node -e`, `python3 -c`, `bash -c`, `eval`) or a file written through a
  heredoc. It refuses them, and the refusal names the construct and the split to make: run each command in its own call, write a long text to a file with the Write tool and pass the file
  (`git commit -F <file>`, `--body-file <file>`). A pipe, a redirection and a quoted `;` are fine, and so is `git commit -m "$(cat <<'EOF' … EOF)"` (also `gh pr create --body`) with a single-quoted
  delimiter: Claude Code does not ask about that form. The hook reads `modules.harness.guard.shellShape` in `.saasfoundry.json` on every call, `refuse` when it is absent; `sf agents shell-guard <refuse|warn|off|status>`
  records it, and which mode a project uses is the developer's decision.
