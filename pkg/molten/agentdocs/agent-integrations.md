# Agent integrations: what MoltenTerm adds to `claude` and `codex`

Start Claude Code or Codex in a local MoltenTerm terminal the way you always do: `claude`, `codex`, with your own
arguments. The pane then shows the agent's precise state, the companion opens on this terminal's session, the plan
usage gauges fill and the agent can use the MoltenTerm browser, with nothing for you to copy or paste.

## How it works

In a local MoltenTerm terminal, `claude` and `codex` are MoltenTerm's launchers, first on `PATH`. A launcher finds
your real binary (the next `claude` or `codex` on `PATH`), adds MoltenTerm's integration **for that run only**
through the agent's own per-run options, and starts your binary with your arguments. **Nothing of yours is edited**:
your settings files are only read, and what is added lives in MoltenTerm's data folder (`molten/agent-launch/`).

| Agent | Added to the run | How |
| --- | --- | --- |
| Claude Code | Agent state hooks (working, waiting, done; the `Notification` hook only for the notifications that wait for you, not the idle reminder a minute after a turn ends), the session link (`SessionStart`), the sub-agents (`SubagentStart`, `SubagentStop`), the status line relay around your own status line (for the plan usage gauges), the coffee approvals hook, the MoltenTerm browser server | `--settings <file>` and `--mcp-config <file>`, added before your arguments |
| Codex | The same state hooks (`SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Stop`, `SubagentStart`, `SubagentStop`) and the coffee approvals hook, which Codex runs once you trust them in `/hooks`; until then, a notify wrapper that runs your own `notify` first, then reports done and links the session; Codex's own notifications for what waits for you (approvals, questions), sent to the pane whatever the focus; the MoltenTerm browser server | `-c hooks.<Event>=...`, `-c notify=...`, `-c tui.notifications=...` and `-c mcp_servers.molten-browser...`, added before your arguments |

Both agents' hooks run the same command, `molten agent hook --agent <claude|codex>`: Claude Code and Codex give a
hook the same JSON input, and the handler reads the event from it (`hook_event_name`). Codex trusts a hook against
its exact definition, which MoltenTerm never changes: trust MoltenTerm's hooks once in Codex's `/hooks` (the first
run warns that hooks need review) and every later run uses them. MoltenTerm never trusts them for you and never
passes `--dangerously-bypass-hook-trust`.

The MoltenTerm browser server also carries `list_agents` and `send_to_agent`: tell an agent "send this to Jérôme"
and it hands its work to the agent of that first name with a brief (goal, context, files, links) written in
MoltenTerm's data folder, after you allow it. Its instructions tell the agent its own first name. From a shell, the
same is `molten agent list --active` and `molten agent send <name> --goal "..."`.

What you already have is left alone and listed as such: your own hooks for a state, your own `SessionStart` hook
running `molten agent session` or `molten agent hook`, your own `-c notify=...`, your own `molten-browser` server,
`--strict-mcp-config`. For Codex, an event you already have hooks for (in a `config.toml` or a `hooks.json`) gets
none of MoltenTerm's, your own `-c hooks...`, hooks turned off or managed hooks only leave every hook out, and your
own `[tui]` notification settings stay as you set them. Claude Code with `disableAllHooks` gets nothing.

Nothing is added outside a MoltenTerm terminal (another terminal app, SSH, WSL), inside an agent's own tools (a
`claude -p` that Claude Code runs), for commands that start no session (`claude --version`, `codex login`), or when
MoltenTerm cannot read your settings in time: the launcher never keeps the agent from starting and, on any doubt,
adds nothing.

## The `molten` command inside the agent's sandbox

The `molten` command the guides name (`molten agent send`, `molten worktree link`, `molten ci run`...) talks to
MoltenTerm through a local socket, `wave.sock`. Codex's `workspace-write` sandbox, and Claude Code's when you turn it
on, refuse that socket like any network. MoltenTerm does **not** open it to the sandbox: the terminal's token is in
the agent's environment, so every sandboxed command (a test script, an install hook) would then reach all of
MoltenTerm, not only the `molten` command the agent meant to run.

Instead the agent uses its own escalation, which asks you: it reruns that one `molten` command outside the
sandbox. Codex shows the command with a one-line reason and a suggested rule naming only that subcommand (for
example `molten agent send`); keep the rule in Codex's prompt to stop being asked for it. Claude Code asks to run the
command outside its sandbox; to stop being asked, add the command to the sandbox's `excludedCommands` in your own
settings. The guides MoltenTerm installs tell the agent to do this, and only for `molten` commands.

## Seeing what was added

- **The companion**: an integrated session's bar says **Hooked up by MoltenTerm**. Click it for what this run got,
  what was left alone because you already had it, this guide, and the switches to turn the integration off.
- **The terminal**: `molten agent integration status` prints, for each agent, the real binary and what a session
  started now would get, or why nothing. Run inside an integrated agent (its tools' shell), it prints what that run
  got.

## Turning it off

From the next launch, without restarting MoltenTerm (`settings.json` in MoltenTerm's configuration folder, the
Settings screen under Agents, or the companion's settings):

```json
{
  "agent:integrate": false
}
```

turns it off for every agent, and

```json
{
  "agent:integrateoff": ["codex"]
}
```

for some agents only (`claude`, `codex`; other ids are ignored, and `molten agent integration status` names them).
For one command only: `MOLTENTERM_AGENT_INTEGRATION=0 claude`.

Nothing needs cleaning up afterwards, since nothing of yours was written. Without the integration, the pane header
offers **Set up hooks** again for Claude Code and Codex, and `agent-states.md` has the hooks to add yourself. That is
also the way for Gemini CLI, OpenCode, an agent started by its full path, or one started by another program.
