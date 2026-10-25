# Agent states: let MoltenTerm know when your agent waits for you

MoltenTerm shows, in the header of a terminal running a coding agent, the agent, its project and its branch, and a
dot with the agent's state: **working**, **waiting** for you, **done**, **error**. The tab and the workspace icon in
the rail show the most urgent state of their panes (waiting, then error, then working, then done). An agent that
waits or is done while you look elsewhere raises a notification; opening it brings you to the pane. **Done** means
finished and not seen yet: once you look at the pane (it is focused, or shown in the active tab of the window you
use for a moment), its green dot and the marks of its tab and workspace clear, and its "is done" notification is
read. Waiting only clears when the agent moves on.

MoltenTerm recognises Claude Code (`claude`), Codex (`codex`), Gemini CLI (`gemini`) and OpenCode (`opencode`) in a
MoltenTerm terminal. It never reads the screen to guess what an agent does: without hooks it only looks at when the
pane's output comes, never at what it says.

## How MoltenTerm finds the agent

- **The command line**: `claude`, `clear; claude`, `cd app && codex`, `FOO=1 npx @openai/codex`.
- **The terminal's processes** (macOS and Linux): MoltenTerm looks at what runs in the foreground of each local
  terminal and recognises the agent by its executable (Claude Code's native binary, named after its version, and
  agents running in Node.js included). This finds an agent started by a script or an alias, an agent run as a
  block's command, and, after MoltenTerm restarts, every agent still running in a terminal that survived it: the
  header, the dots, clean copy and the companion find it again within a couple of seconds. An agent found this way
  after a restart shows **idle** until its next signal (a bell, a hook, its output activity, or Enter in the pane). The processes are
  only looked at while a command runs, and once at startup: a terminal at its prompt costs nothing.
- **The agent's hooks** (below), which name the agent with `--agent`.

Not covered: an agent inside tmux or screen running in the terminal (it runs under the tmux server, not under the
terminal), agents in remote (SSH) and WSL terminals unless their command line or hooks name them, and the process
view on Windows (the command line and hooks still work there).

## The state

MoltenTerm learns the state from four sources:

1. **The command itself** (always): the agent runs (idle), or it exited with a failure (error). An agent that
   starts, or that you just answered, may as well sit at its prompt: it shows idle. Enter in a pane whose agent
   waits or is done means you answered: the dot goes back to idle.
2. **The agent's notifications** (no setup in MoltenTerm): the terminal bell, OSC 9 and OSC 777 mean the agent
   waits for you; a notification saying the turn is complete or finished means done.
3. **The pane's output activity** (no setup, for an agent whose hooks never reported in the pane): while the agent
   works, its spinner and its streamed text keep coming; output that keeps coming for about two seconds shows
   **working**, and once it has stayed quiet for about four seconds the dot goes back to idle by itself. Only the
   timing of the output counts, never its content. The echo of what you type and the redraw after a resize do not
   count, nor does a single redraw. Output never ends **waiting** or **done**: answer with Enter first.
4. **The agent's hooks** (most precise): Claude Code and Codex run `molten agent hook` at each event, other agents
   `molten agent state <state>`. As soon as a hook reports in a pane (a session start counts), its output activity is
   ignored there, for this agent, until the pane is closed: the hooks alone say when it works, and once its `Stop`
   hook reported a done there, a turn end reported by Codex's notify wrapper adds nothing.

MoltenTerm never changes your agent's configuration by itself.

**Started in a local MoltenTerm terminal, `claude` and `codex` need none of the settings below**: MoltenTerm's
launcher adds the state hooks, the session link and the rest for that run only, without editing your files (see
`agent-integrations.md`: what is added, how to see it with `molten agent integration status`, and how to turn it
off). The settings below are for the other cases: Gemini CLI, OpenCode and other agents, an agent started by its
full path or by another program, or with the integration turned off. They are yours to add.

### The offer in the pane header

While Claude Code or Codex runs in a local terminal without these hooks and without MoltenTerm's integration (an
integrated run never shows it), the pane header shows a small **Set up hooks** chip next to the agent. It opens the snippet below for that agent, where to add it and a Copy button; you
apply it yourself. MoltenTerm only reads the agent's settings to know whether the hooks are already there (Claude
Code: `~/.claude/settings.json` or `$CLAUDE_CONFIG_DIR/settings.json`, its `settings.local.json`, the managed settings,
and the `.claude/settings.json` and `.claude/settings.local.json` of the pane's folder and its parents up to the
repository's root; Codex: `~/.codex/hooks.json` or `$CODEX_HOME/hooks.json` running `molten agent hook`, or the
older notify line running `molten agent state` in its `config.toml`).
The chip does not show once your own hooks for the agent have reported, in this run or an earlier one (the hooks
MoltenTerm's launcher adds do not count), nor for an agent you ran
`molten agent remove` for. Its × (or **Don't offer again**) hides it for that agent for good; the choice is kept in
`agent-guides.json`, in MoltenTerm's data folder under `molten/`.

## The commands

```
molten agent hook [--agent <name>]
```

The hook handler of Claude Code and Codex, which give their hooks the same JSON input on standard input. It reads
the event (`hook_event_name`) and reports what it means, printing nothing:

| Event | Reported |
| --- | --- |
| `SessionStart` | the session link (`transcript_path`, else `session_id`), and the pane's states are precise from now on: idle, unless the agent is working or waiting (after a compaction, the link only) |
| `UserPromptSubmit`, `PostToolUse` | working |
| `Notification` (Claude Code) | waiting, for the notifications that wait for you (see below) |
| `Stop` | done |
| `SubagentStart`, `SubagentStop` | the sub-agent (its id, type and, at its end, its transcript), for the companion, and that it runs or stopped |

Any other event reports nothing. An event fired inside a sub-agent carries its `agent_id`: its `UserPromptSubmit`,
`PostToolUse` or `Stop` is the sub-agent's work, never the session's state. While the session is idle or done and
its sub-agents run, the pane shows working with "N sub-agents running", and its prompt still takes a handoff
(`send_to_agent`). A sub-agent's `Notification` that waits is the pane's waiting: its question shows in the
session's terminal.

```
molten agent state <working|waiting|done|error|idle> [--agent <name>] [--message <text>] [--stdin]
```

For other agents' hooks, plugins or notification commands:

- It reports for the terminal it runs in (agents run their hooks in their own terminal).
- `--agent` names the agent: `claude`, `codex`, `gemini`, `opencode`, or any short lowercase name for another
  agent. It is required when MoltenTerm did not see the agent start.
- `--message` adds a short text to the notification; `--stdin` takes it from the `message` field of the JSON the
  hook receives on its standard input (Claude Code's `Notification` hook). With `waiting`, `--stdin` also reads its
  `notification_type`: a Claude Code notification that asks nothing (`idle_prompt`, `auth_success`...) reports
  nothing.
- `waiting` and `done` raise a notification when the state changes; MoltenTerm drops the agent's own OSC signal for
  the same moment, so you are not notified twice.
- Outside MoltenTerm, `molten` is not there: the commands below test `WAVETERM_BLOCKID` first, so the same settings
  work in any terminal.

## Claude Code

Either let Claude Code notify through the terminal (waiting only):

```
claude config set --global preferredNotifChannel iterm2
```

or, for all states, the session link and the sub-agents, add these hooks to `~/.claude/settings.json` (or a
project's `.claude/settings.json`), merged with the hooks you already have:

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "[ -n \"$WAVETERM_BLOCKID\" ] && molten agent hook --agent claude || true" }] }
    ],
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "[ -n \"$WAVETERM_BLOCKID\" ] && molten agent hook --agent claude || true" }] }
    ],
    "PostToolUse": [
      { "hooks": [{ "type": "command", "command": "[ -n \"$WAVETERM_BLOCKID\" ] && molten agent hook --agent claude || true" }] }
    ],
    "Notification": [
      { "matcher": "permission_prompt|elicitation_dialog|elicitation_url_dialog|agent_needs_input|quota_auto_resume_stale", "hooks": [{ "type": "command", "command": "[ -n \"$WAVETERM_BLOCKID\" ] && molten agent hook --agent claude || true" }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "[ -n \"$WAVETERM_BLOCKID\" ] && molten agent hook --agent claude || true" }] }
    ],
    "SubagentStart": [
      { "hooks": [{ "type": "command", "command": "[ -n \"$WAVETERM_BLOCKID\" ] && molten agent hook --agent claude || true" }] }
    ],
    "SubagentStop": [
      { "hooks": [{ "type": "command", "command": "[ -n \"$WAVETERM_BLOCKID\" ] && molten agent hook --agent claude || true" }] }
    ]
  }
}
```

`Notification` fires, for the types its matcher names, when Claude Code asks for a permission, an MCP server asks a
question, or a session waits for you to continue; `Stop` when it ends its turn; `UserPromptSubmit` when you send a
prompt; `PostToolUse` after each tool it runs, so the dot is working again once you approved a permission;
`SessionStart` when a session starts, also after `/clear`, a resume and a compaction.

Claude Code also notifies about a minute after a turn ended ("Claude is waiting for your input", type `idle_prompt`),
after a login, or when a usage limit lets it go on. Those ask nothing: `molten agent hook` (and
`molten agent state waiting --stdin`) reads the `notification_type` of the hook's input and leaves the state as it is
for them, so a Notification hook without the matcher keeps a finished agent done rather than waiting. Without a
`notification_type` (an older Claude Code), the idle text is recognised the same way.

Hooks pasted from an earlier version of this page (`molten agent state ...`, `molten agent session ...`) keep
working.

### Coffee approvals

While a workspace's coffee is on, MoltenTerm approves the permission requests of the Claude Code sessions in it, except
what its deny list keeps for you (deletions outside the session's folder, force pushes to main branches, credential
files) and the questions only you can answer. A request the hook leaves to you turns the pane waiting. `claude` started in a local MoltenTerm terminal gets this through
MoltenTerm's launcher. For a Claude Code started otherwise in a MoltenTerm terminal, add this hook:

```json
{
  "hooks": {
    "PermissionRequest": [
      { "hooks": [{ "type": "command", "command": "[ -n \"$WAVETERM_BLOCKID\" ] && molten agent permission --agent claude || true", "timeout": 15 }] }
    ]
  }
}
```

With the coffee off it prints nothing, and Claude Code asks you as usual. Every decision taken while a coffee is on is
kept in the status bar's sleep list and in `molten/coffee-approvals.jsonl` in MoltenTerm's data folder.

## Codex

Codex has the same hook events as Claude Code, with the same JSON input (but no `Notification`). Add these hooks to
`~/.codex/hooks.json` (or `$CODEX_HOME/hooks.json`, or a project's `.codex/hooks.json`), merged with the hooks you
already have, then trust them once in Codex's `/hooks`:

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "[ -n \"$WAVETERM_BLOCKID\" ] && molten agent hook --agent codex || true", "timeout": 15 }] }
    ],
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "[ -n \"$WAVETERM_BLOCKID\" ] && molten agent hook --agent codex || true", "timeout": 15 }] }
    ],
    "PostToolUse": [
      { "hooks": [{ "type": "command", "command": "[ -n \"$WAVETERM_BLOCKID\" ] && molten agent hook --agent codex || true", "timeout": 15 }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "[ -n \"$WAVETERM_BLOCKID\" ] && molten agent hook --agent codex || true", "timeout": 15 }] }
    ],
    "SubagentStart": [
      { "hooks": [{ "type": "command", "command": "[ -n \"$WAVETERM_BLOCKID\" ] && molten agent hook --agent codex || true", "timeout": 15 }] }
    ],
    "SubagentStop": [
      { "hooks": [{ "type": "command", "command": "[ -n \"$WAVETERM_BLOCKID\" ] && molten agent hook --agent codex || true", "timeout": 15 }] }
    ]
  }
}
```

Codex waits for you without a hook event of its own: its terminal notifications (`[tui] notifications`, OSC 9, which
MoltenTerm reads) and the coffee approvals' `PermissionRequest` hook below, which reports waiting when it leaves the
request to you, say so. An earlier version of this page offered a `notify` line in `config.toml` running
`molten agent state done --agent codex`: it still works, for the done state only.

In a local MoltenTerm terminal you do not need any of this: `codex` runs MoltenTerm's launcher, which adds, for that
run only:

- the hooks above, `-c hooks.<Event>=[{hooks=[{type="command",command="[ -n \"$WAVETERM_BLOCKID\" ] && molten agent hook --agent codex || true",timeout=15}]}]`.
  Codex holds them for your review: the first time, it warns that hooks need review; type `/hooks` in Codex and trust
  `molten agent hook`. Codex keeps that trust in its own configuration against the hook's definition, which
  MoltenTerm never changes, so one trust is enough. Once trusted, the pane shows working and done from them, the
  companion links the session as soon as Codex starts, and a line typed into an idle Codex by MoltenTerm (a handoff,
  a review question) is sent with Enter. An event you already have hooks for in a `config.toml` or a `hooks.json`
  gets none of MoltenTerm's;
- `-c notify=[<molten>, "agent", "notify", "--agent", "codex", "--", <your own notify>]`, the fallback until the
  hooks are trusted: `molten agent notify` runs your own notify first, with the same JSON argument Codex gives it,
  then reports done and links the companion to the session from the payload's thread id. Once MoltenTerm's `Stop`
  hook reported a done in the pane, its done adds nothing (with your own `Stop` hook in its place, notify keeps
  saying done). Your own `-c notify=...`, a profile or a project `.codex/config.toml` that sets
  notify leave notify as you set it;
- `-c tui.notifications=["approval-requested","plan-mode-prompt","async-question"]`,
  `-c tui.notification_method="osc9"` and `-c tui.notification_condition="always"`, so an approval or a question
  turns the pane waiting even while you look at it (no trust needed). Your own `[tui]` notification settings are kept
  as you set them;
- the MoltenTerm browser server (`-c mcp_servers.molten-browser...`).

Your `config.toml` and `hooks.json` are only read, never written, and a `config.toml` that cannot be read leaves
everything out. Your own `-c hooks...`, hooks turned off (`[features] hooks = false`) or managed hooks only leave
every hook out. `molten agent integration status` shows what a run gets; `MOLTENTERM_AGENT_INTEGRATION=0 codex`
starts it with nothing added. MoltenTerm never trusts a hook for you and never passes
`--dangerously-bypass-hook-trust`.

### Coffee approvals for Codex

The launcher also gives Codex the coffee approvals' `PermissionRequest` hook, for that run only:
`-c hooks.PermissionRequest=[{hooks=[{type="command",command="[ -n \"$WAVETERM_BLOCKID\" ] && molten agent permission --agent codex || true",timeout=15}]}]`,
trusted in `/hooks` the same way as the state hooks. Until then the coffee bud lists the session as still asking.
Once trusted, while the workspace's coffee is on, Codex's approval requests (shell commands, `apply_patch`, MCP
tools) get the same answer as Claude Code's, the deny list included (for `apply_patch`, the files it deletes or
touches); with the coffee off, Codex asks you as usual. MoltenTerm writes nothing in `~/.codex` and never passes
`--dangerously-bypass-hook-trust`. Your own `-c hooks...`, your own `PermissionRequest` hooks in a `config.toml`,
hooks turned off (`[features] hooks = false`) or managed hooks only leave it out. Codex's own app-level approvals
(Computer Use per app, the Full Access selection) are not approval requests: they still wait for you.

## Gemini CLI, OpenCode and other agents

Call the same commands from whatever the agent offers: hooks, plugins (an OpenCode plugin can run
`molten agent state done --agent opencode` on `session.idle`), or a notification command. An agent with none of
these still shows working from its output activity, and its bell or OSC 9 notifications still mark it as waiting.

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

A `claude` or `codex` started in a local MoltenTerm terminal already links its session through MoltenTerm's launcher.
For one started otherwise, the `SessionStart` hook of the snippets above links it (it also runs after `/clear` and
when a session is resumed); `molten agent session --stdin` in a `SessionStart` hook does the same.

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
notification; press Enter in the pane to go back to idle, or run `molten agent state working` to show it working.
