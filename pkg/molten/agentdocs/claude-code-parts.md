# The Claude Code part of a mod

A mod changes MoltenTerm (its MoltenTerm part, `main.js`). It may also carry a **Claude Code part**: a Claude Code
plugin folder that runs inside every Claude Code session started in a MoltenTerm terminal, once the mod is enabled
and trusted. With it, one morph changes both the workspace and the agent: a band above the Claude Code prompt, a
pane, a status line entry, toasts, slash commands, hooks on tool calls, prompts or the system prompt.

The Claude Code plugin API is **early access**: it may change between Claude Code releases. Its reference is the
`plugin-authoring` skill bundled with Claude Code (the API's typings, examples, `claude plugin validate`, `tsc`,
`claude plugin test`). This page tells how MoltenTerm carries a part; the complete example is
`examples/test-band/`.

## Folder and `mod.json`

```
<config>/mods/<mod-id>/
    mod.json
    main.js                         # the MoltenTerm part (required; its activate may do nothing)
    agents/claude-code/             # the Claude Code part, a Claude Code plugin folder
        .claude-plugin/plugin.json  # "name" is the mod id
        hooks/hooks.json            # {"modules": ["./register.ts"]}
        hooks/register.ts           # or .tsx: export const register: Register = on => { ... }
        types/index.d.ts            # only when the part keeps values in $.state
        .gitignore                  # .claude-plugin/types/
```

```json
"agents": {
  "claude-code": { "folder": "agents/claude-code", "targetVersion": "2.1.289" }
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `agents` | no | An object keyed by agent id. Only `claude-code` is supported; any other key is an error |
| `agents.claude-code.folder` | yes | The part folder: a relative path inside the mod, no `.` or `..` segment (usually `agents/claude-code`) |
| `agents.claude-code.targetVersion` | yes | The `claude --version` the part was written for, as `MAJOR.MINOR.PATCH` |

`molten mod new <id> --claude-code` writes all of this, with a minimal hooks module for the installed Claude Code
(or the version given with `--claude-code-version`).

## Checks

`molten mod validate <id>` checks the part without running it:

- the folder exists inside the mod (symbolic links included), and holds `.claude-plugin/plugin.json`, valid JSON,
  whose `name` is the mod id: every loaded plugin needs its own name;
- `claude plugin validate` on the folder, when `claude` is on the PATH: its errors fail validation, its warnings do
  not. Without `claude`, a warning says the part was not checked;
- the installed Claude Code against `targetVersion`: a different version is a warning, never an error. Check the part
  against the new version, then update `targetVersion`.

Type-check the hooks module with `tsc -p <part folder>` once Claude Code has loaded the part (it lays its typings in
`.claude-plugin/types/`), and test it with `claude plugin test <part folder>`.

## Trust

The Claude Code part runs inside Claude Code with the user's rights: it can change what Claude Code shows and does,
read files and run commands. The first `molten mod enable <id>` asks the user to trust the mod, and the prompt shows
the part (folder and target version) and says so. The trust is recorded with `"agents": ["claude-code"]` in
`<data>/molten/trust.json`.

A mod trusted before it had a part (an agent added one later) keeps its MoltenTerm part running, but its Claude Code
part stays off and `molten mod list` shows it `untrusted`; `molten mod enable <id>` asks again, for the part only.
Declining keeps the MoltenTerm part running. Undo never grants trust.

## When a change takes effect

Claude Code loads plugins when a session starts. So a part, once enabled:

- loads in the **next Claude Code session** started in a MoltenTerm terminal. A running session keeps what it
  loaded: restart it with `/exit`, then `claude --continue` keeps the conversation;
- after that, saving a file of the part reloads it in that session by itself;
- stops at the next session once disabled, untrusted, removed or undone.

`molten mod enable|disable|untrust|remove` and `molten undo` say which applies; with `--json`, the `claudecode`
field gives `state` and `takeseffect` (`next-session` or `new-terminal`).

**A part added after a terminal opened** needs a new MoltenTerm terminal: that terminal's environment was fixed
before the part existed. `molten` says so.

## How MoltenTerm loads the part

Claude Code loads the plugin folders named in `CLAUDE_CODE_PLUGIN_DIRS`. MoltenTerm gives every local terminal one
entry per mod with a part, a fixed folder `<data>/molten/agent-parts/claude-code/<mod-id>`: a symbolic link that
MoltenTerm points at the part while it may load, and otherwise at a placeholder plugin named `molten-off-<mod-id>`,
with no hooks (Claude Code's `/plugin` list shows it). The path never changes, so even a terminal that survived a
restart follows enable, disable, undo and safe mode at its next Claude Code session.

- The user's own `CLAUDE_CODE_PLUGIN_DIRS` comes first, kept and never reordered; MoltenTerm's entries follow.
- Outside MoltenTerm nothing changes: the variable is only set in MoltenTerm terminals. `~/.claude` is never
  written.
- `env.CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json` replaces the process value, so no part loads;
  `molten mod enable` and `molten mod list` warn about it. Move those folders to the variable in your shell.
- A shell startup file that sets the variable (`export CLAUDE_CODE_PLUGIN_DIRS=/x`) replaces MoltenTerm's entries;
  append instead: `export CLAUDE_CODE_PLUGIN_DIRS="$CLAUDE_CODE_PLUGIN_DIRS:/x"`. `molten` warns when a terminal
  carries no MoltenTerm entry while some exist.

## History, safe mode, remote and Windows

- **History and undo**: the part is snapshotted with the mod, `.claude-plugin/` included. The typings Claude Code
  writes into `.claude-plugin/types/` at each load are left out of the history and never reload the mod.
- **Safe mode** loads no Claude Code part: every placeholder is in place before any terminal starts, so even a
  terminal reattached after the restart starts its next Claude Code session without parts.
- **Remote terminals** (SSH, WSL) get no Claude Code part in this version.
- **Windows**: no Claude Code part in this version (the slots are symbolic links).

## The two layers together

The Claude Code part reaches MoltenTerm by running commands, as the user would:

```ts
await $.process.run(['molten', 'test-results', 'show', '--title', 'Failed tests'], { stdin: output })
await $.process.run(['wsh', 'notify', 'Tests failed'])
```

`molten` talks to the tab of the terminal Claude Code runs in, and a box opens next to that terminal. A MoltenTerm
part cannot call into Claude Code: the Claude Code part pulls, by running a `molten` command the MoltenTerm part
registered.

## The example: test-band

`examples/test-band/` shows the last test run in a band above the Claude Code prompt, and a failing run's output in
a box next to the terminal:

- `main.js` registers `molten test-results show [--title <title>]`, which shows its stdin in a box with a copy
  button;
- `agents/claude-code/hooks/register.tsx` hooks the Bash tool calls: after a test command (`npm test`, `vitest`,
  `go test`, `pytest`…) it keeps the result in `$.state`, draws it above the prompt, and on a failure runs
  `molten test-results show` with the end of the output.
