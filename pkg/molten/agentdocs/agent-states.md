# Agent states: let MoltenTerm know when your agent waits for you

MoltenTerm shows, in the header of a terminal running a coding agent, the agent, its project and its branch, and a
dot with the agent's state: **working**, **waiting** for you, **done**, **error**. The tab and the workspace icon in
the rail show the most urgent state of their panes (waiting, then error, then working, then done). An agent that
waits or is done while you look elsewhere raises a notification; opening it brings you to the pane.

MoltenTerm recognises Claude Code (`claude`), Codex (`codex`), Gemini CLI (`gemini`) and OpenCode (`opencode`) when
you start them from a MoltenTerm terminal. It never reads the screen to guess what an agent does. It learns the
state from three sources:

1. **The command itself** (always): working while the agent runs, error when it exits with a failure. With nothing
   else, this is all MoltenTerm knows: working, or idle.
2. **The agent's notifications** (no setup in MoltenTerm): the terminal bell, OSC 9 and OSC 777 mean the agent
   waits for you; a notification saying the turn is complete or finished means done.
3. **The agent's hooks** (most precise): the agent runs `molten agent state <state>` at the right moments.

MoltenTerm never changes your agent's configuration by itself. The settings below are yours to add.

## The command

```
molten agent state <working|waiting|done|error|idle> [--agent <name>] [--message <text>] [--stdin]
```

- It reports for the terminal it runs in (agents run their hooks in their own terminal).
- `--agent` names the agent: `claude`, `codex`, `gemini`, `opencode`, or any short lowercase name for another
  agent. It is required when MoltenTerm did not see the agent start.
- `--message` adds a short text to the notification; `--stdin` takes it from the `message` field of the JSON the
  hook receives on its standard input (Claude Code's `Notification` hook).
- `waiting` and `done` raise a notification when the state changes; MoltenTerm drops the agent's own OSC signal for
  the same moment, so you are not notified twice.
- Outside MoltenTerm, `molten` is not there: the commands below test `WAVETERM_BLOCKID` first, so the same settings
  work in any terminal.

## Claude Code

Either let Claude Code notify through the terminal (waiting only):

```
claude config set --global preferredNotifChannel iterm2
```

or, for all states, add these hooks to `~/.claude/settings.json` (or a project's `.claude/settings.json`), merged
with the hooks you already have:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "[ -n \"$WAVETERM_BLOCKID\" ] && molten agent state working --agent claude || true" }] }
    ],
    "Notification": [
      { "hooks": [{ "type": "command", "command": "[ -n \"$WAVETERM_BLOCKID\" ] && molten agent state waiting --agent claude --stdin || true" }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "[ -n \"$WAVETERM_BLOCKID\" ] && molten agent state done --agent claude || true" }] }
    ]
  }
}
```

`Notification` fires when Claude Code asks for a permission or has waited for your input for a while; `Stop` when it
ends its turn; `UserPromptSubmit` when you send a prompt.

## Codex

Codex runs its `notify` program when a turn completes, with a JSON argument MoltenTerm ignores. In
`~/.codex/config.toml`:

```toml
notify = ["sh", "-c", "[ -n \"$WAVETERM_BLOCKID\" ] && molten agent state done --agent codex || true"]
```

Codex's own terminal notifications (`[tui] notifications = true`) send OSC 9, which MoltenTerm reads as well.

## Gemini CLI, OpenCode and other agents

Call the same commands from whatever the agent offers: hooks, plugins (an OpenCode plugin can run
`molten agent state done --agent opencode` on `session.idle`), or a notification command. An agent with none of
these still shows working and idle, and its bell or OSC 9 notifications still mark it as waiting.

## Checking

In a MoltenTerm terminal, `molten agent state waiting --agent claude` turns the pane's dot to waiting and raises a
notification; press Enter in the pane, or run `molten agent state working`, to go back to working.
