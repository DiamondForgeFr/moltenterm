# Agent states: let MoltenTerm know when your agent waits for you

MoltenTerm shows, in the header of a terminal running a coding agent, the agent, its project and its branch, and a
dot with the agent's state: **working**, **waiting** for you, **done**, **error**. The tab and the workspace icon in
the rail show the most urgent state of their panes (waiting, then error, then working, then done). An agent that
waits or is done while you look elsewhere raises a notification; opening it brings you to the pane.

MoltenTerm recognises Claude Code (`claude`), Codex (`codex`), Gemini CLI (`gemini`) and OpenCode (`opencode`) in a
MoltenTerm terminal. It never reads the screen to guess what an agent does.

## How MoltenTerm finds the agent

- **The command line**: `claude`, `clear; claude`, `cd app && codex`, `FOO=1 npx @openai/codex`.
- **The terminal's processes** (macOS and Linux): MoltenTerm looks at what runs in the foreground of each local
  terminal and recognises the agent by its executable (Claude Code's native binary, named after its version, and
  agents running in Node.js included). This finds an agent started by a script or an alias, an agent run as a
  block's command, and, after MoltenTerm restarts, every agent still running in a terminal that survived it: the
  header, the dots, clean copy and the companion find it again within a couple of seconds. An agent found this way
  after a restart shows **idle** until its next signal (a bell, a hook, or Enter in the pane). The processes are
  only looked at while a command runs, and once at startup: a terminal at its prompt costs nothing.
- **The agent's hooks** (below), which name the agent with `--agent`.

Not covered: an agent inside tmux or screen running in the terminal (it runs under the tmux server, not under the
terminal), agents in remote (SSH) and WSL terminals unless their command line or hooks name them, and the process
view on Windows (the command line and hooks still work there).

## The state

MoltenTerm learns the state from three sources:

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

## The agent companion: link the session

Clicking the agent in the pane header (or `Cmd+Shift+J`) opens the **agent companion** to the right of the pane. It
reads the agent's own session transcript, in place and read-only, and shows the latest answer with a Copy button on
every code block, the earlier answers, the files changed with their diffs, the task list and a pending permission
request. MoltenTerm never writes, copies or sends the transcript anywhere. Claude Code and Codex have a companion;
other agents do not yet.

Without any setup, the companion looks for the session of the pane's folder started after the agent: in
`~/.claude/projects/` for Claude Code (or `$CLAUDE_CONFIG_DIR/projects/`), in `~/.codex/sessions/` for Codex (or
`$CODEX_HOME/sessions/`). A resumed session (`--resume`) started before the agent: the companion takes it when it is
the only session of the folder written since the agent started and no other terminal holds it. When two panes run
the same agent in the same folder it cannot tell their sessions apart, so it asks you to pick one, as it does when
several sessions are candidates. A hook removes the guess: the agent tells the pane which transcript is its own.

```
molten agent session [<transcript-path>] [--agent <name>] [--stdin]
```

- `--stdin` takes the path from the `transcript_path` field of the JSON the hook receives on its standard input.
- The path must be in the agent's session folder above, or in one from `agent:sessionroots`; any other file is
  refused.

For Claude Code, add a `SessionStart` hook (it also runs after `/clear` and when a session is resumed):

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "[ -n \"$WAVETERM_BLOCKID\" ] && molten agent session --agent claude --stdin || true" }] }
    ]
  }
}
```

### Sessions in another folder

MoltenTerm does not see the variables set in your shell's startup files. If you set `CLAUDE_CONFIG_DIR` or
`CODEX_HOME` there, add the same folders to MoltenTerm's settings (`settings.json`, in MoltenTerm's configuration
folder), per agent:

```json
{
  "agent:sessionroots": {
    "claude": ["~/work/.claude"],
    "codex": ["~/work/.codex"]
  }
}
```

The companion then also reads `projects/` (Claude Code) or `sessions/` (Codex) inside each folder, for discovery and
for the paths hooks report. A folder is used only when it is an absolute path (or starts with `~/`) to an existing
folder you own that other users cannot write to; any other is ignored, and MoltenTerm's log says why.

## Checking

In a MoltenTerm terminal, `molten agent state waiting --agent claude` turns the pane's dot to waiting and raises a
notification; press Enter in the pane, or run `molten agent state working`, to go back to working.
