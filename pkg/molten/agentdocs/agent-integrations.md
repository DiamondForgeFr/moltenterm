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
| Claude Code | Agent state hooks (working, waiting, done), the session link (`SessionStart`), the status line relay around your own status line (for the plan usage gauges), the coffee approvals hook, the MoltenTerm browser server | `--settings <file>` and `--mcp-config <file>`, added before your arguments |
| Codex | A notify wrapper that runs your own `notify` first, then reports done and links the session; the MoltenTerm browser server; the coffee approvals hook, which Codex runs once you trust it in `/hooks` | `-c notify=...`, `-c mcp_servers.molten-browser...` and `-c hooks.PermissionRequest=...`, added before your arguments |

What you already have is left alone and listed as such: your own hooks for a state, your own `SessionStart` hook
running `molten agent session`, your own `-c notify=...`, your own `molten-browser` server, `--strict-mcp-config`.
Claude Code with `disableAllHooks` gets nothing.

Nothing is added outside a MoltenTerm terminal (another terminal app, SSH, WSL), inside an agent's own tools (a
`claude -p` that Claude Code runs), for commands that start no session (`claude --version`, `codex login`), or when
MoltenTerm cannot read your settings in time: the launcher never keeps the agent from starting and, on any doubt,
adds nothing.

## Seeing what was added

- **The companion**: an integrated session's bar says **Integrated by MoltenTerm**. Click it for what this run got,
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
