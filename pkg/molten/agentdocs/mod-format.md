# MoltenTerm mods

`molten docs` prints the folder holding this page, the `morph.md` guide for coding agents, the guides of the
preconfigured morphs (`language-pack.md`) and complete example mods, all matching the installed version.

A mod changes MoltenTerm from the outside: it is a folder in the configuration directory that MoltenTerm loads when a
tab opens. Mods are supported only through `MoltenApi`, described below: a mod cannot import Wave's internal
modules, and the page around it is not part of the API (see "The page is not part of the API"). This page documents
API version 1.

## Folder

```
<config>/mods/<mod-id>/
    mod.json
    main.js
```

`<config>` is MoltenTerm's configuration directory (`~/.config/moltenterm` on macOS and Linux, `moltenterm-dev` for
development builds; `wsh wavepath config` prints it). Folders whose name starts with `.` are ignored.

A mod runs only once it is enabled. The enabled mods are listed in `<config>/molten/mods.json`
(`{"enabled": ["<mod-id>", …]}`), outside the mod folders, and `molten mod enable|disable` changes it; every open tab
applies the change at once. A mod that is not listed is reported as `disabled` and none of its code is read.

## Reload on save

MoltenTerm watches `<config>/mods/`, `mods.json` and the trust file. Saving a file of a mod reloads that mod in every
open tab within about a second: everything the previous version registered (commands, boxes, notifications) is
undone first, so nothing appears twice. A save that breaks the mod stops it and reports why, as when it fails to
load; the next valid save brings it back. A new mod folder appears in `molten mod list` as soon as it is created,
and editing `mods.json` by hand takes effect the same way. Files whose name starts with `.` or ends with `~`, `.swp`
or `.tmp` are ignored, so an editor's temporary files never reload a mod.

## History, undo and safe mode

Every change to the mods is recorded: a file of a mod added, edited or removed, a mod enabled or disabled. Each
record is a snapshot of `<config>/mods/` and `mods.json` under `<data>/molten/history/`, and the last 50 are kept;
no system git is needed. The trust file is not part of the history, so undoing never grants trust: a restored mod
that is no longer trusted comes back `untrusted`.

```
molten history [--json]   # newest first; -> marks the change the mods are at now
molten undo [--json]      # restores the mods as before that change; repeat to keep going back
```

An undo is itself recorded, and an edit made after undoing can be undone too. A mod's Claude Code part is
snapshotted with the mod, its `.claude-plugin/` folder included; the typings Claude Code writes into
`.claude-plugin/types/` are not part of the history.

For regular mod files, snapshots preserve ordinary read, write and execute permissions (`0777` bits), including
restricted files and executable helpers. Permission-only changes are recorded and undo restores them, just like
content edits. Unchanged permission notifications do not reload a mod or add history. This policy uses the file
permissions supported by the platform; Windows does not provide Unix executable permission bits. Ownership, ACLs,
special permission bits and directory permissions are not preserved. `mods.json` records enabled state as data;
its file permissions are not part of snapshot identity.

History supports directory containers and ordinary files at included paths. Symbolic links, including links to
another file inside the same mod, and special files such as FIFOs, sockets and devices are rejected rather than
followed or flattened. This also applies to managed history roots, enabled-state files, metadata and existing
snapshots. The usual hidden/editor and generated-typing exclusions apply before these checks: ignored entries are
not followed. Empty directories are not part of snapshot identity or independently preserved.

Before undo changes any current mod or enabled state, it checks the complete selected snapshot and current mod
tree, reads both enabled-state files, and stages every replacement. Unsupported entries or preparation failures
leave current mod contents, ordinary file permissions and enabled state intact. A missing selected snapshot is an
error; an older snapshot without `mods.json` retains the legacy empty-enabled-list fallback. Invalid snapshot
metadata is reported rather than used to select a different restore target.

These checks protect history recording and restore preparation; they do not change the mod loader's trust model.
Unix reads also use no-follow/nonblocking flags and check the opened file's type and identity; Windows uses portable
path and descriptor checks. Neither provides a transaction against another process replacing ancestor directories,
a crash, or arbitrary I/O failures after live replacements begin. Storage budgets and crash recovery are separate
policies, not guarantees of this preflight check.

Safe mode starts MoltenTerm with no mod loaded, so a mod that breaks the workspace can always be repaired. Choose
**Restart in Safe Mode** in the app menu, or start MoltenTerm with `MOLTENTERM_SAFE_MODE=1`. A banner says so in
every window and `molten mod list` reports it. No Claude Code part of a mod loads either, in new terminals and in
terminals that survived the restart. `molten mod disable`, `molten mod remove` and `molten undo` still
work; then choose **Restart Normally** in the app menu.

## Trust

A mod runs inside MoltenTerm with the user's rights: it can read and change files and run commands. So no mod code
runs before the user trusts it. The first `molten mod enable <id>` shows a prompt in the tab with the mod's name,
version, description, declared capabilities and folder, and `molten` waits for the answer:

- **Trust and enable:** the mod is enabled and starts in every tab. Trust is remembered per mod id in
  `<data>/molten/trust.json`, so the agent can keep editing the mod without a prompt on every save.
- **Don't trust**, Escape or closing the prompt: the mod stays disabled and `molten` exits 1.
- **No answer within 5 minutes:** the prompt closes and `molten` exits 1; run the command again.

A mod enabled in `mods.json` but not trusted is reported as `untrusted`, and none of its code is read.
`molten mod untrust <id>` stops the mod and forgets the trust; `molten mod remove` forgets it too.

Mods are not sandboxed in this version. The prompt keeps code from running by mistake; it does not stop a program
that already runs with the user's rights, such as a hostile agent, from writing the trust file itself.

## `mod.json`

| Field          | Required | Meaning                                                                                       |
| -------------- | -------- | --------------------------------------------------------------------------------------------- |
| `id`           | yes      | Same as the folder name: lowercase letters, digits, `.`, `_`, `-`                             |
| `name`         | yes      | Name shown to the user                                                                        |
| `version`      | yes      | The mod's own version, free text (semantic versioning recommended)                            |
| `description`  | no       | One sentence shown to the user                                                                |
| `apiVersion`   | yes      | `1`. Any other value is refused, with a message naming the supported versions                 |
| `main`         | yes (no for a language pack) | Path of the module inside the folder, ending in `.js` or `.mjs`; no `.` or `..` segment |
| `capabilities` | no       | List of strings declaring what the mod uses, shown when the user is asked to trust it (#21); `background` keeps its timers running in hidden tabs (see Cost and budget) |
| `agents`       | no       | The mod's Claude Code part: `{"claude-code": {"folder", "targetVersion"}}`; see `claude-code-parts.md` |
| `languages`    | no       | Makes the mod a language pack: `[{"code", "name", "file"}]`; see Language packs below          |

A mod may also carry a **Claude Code part**, a Claude Code plugin folder that runs inside the Claude Code sessions
started in MoltenTerm terminals (a band above the prompt, hooks on tool calls…). `claude-code-parts.md`, next to this
page, documents it, with the complete example `examples/test-band/`.

## Language packs

A mod whose `mod.json` declares `languages` is a language pack: it holds data only and runs no code. Each entry
names a language code (BCP 47, optionally with a region: `es`, `pt-br`), the language's own name as the picker shows it
(`Español`) and a JSON dictionary inside the folder (`locales/es.json`), shaped like MoltenTerm's English one: nested
objects of strings addressed by dotted keys. A pack has no `main` and no `agents`: a manifest with both `languages`
and `main` is refused (put code in a separate mod).

- **No trust prompt.** MoltenTerm reads the files as JSON and never evaluates them; their texts are shown as plain
  text, never as HTML. `molten mod enable` enables a pack at once. History, `molten undo` and safe mode apply as to any
  mod; in safe mode no pack loads.
- **A new code** adds a language: it appears in Settings > General > Language and `app:language` accepts its code.
  A key the pack lacks, or leaves empty, shows English.
- **A shipped code** (`en`, `fr`) overrides only the keys the pack holds; disabling the pack or `molten undo` brings
  the shipped texts back.
- **Checked at load.** Each key's `{placeholders}` must be the same as English's: a pack where one key differs is
  refused whole (`molten mod list` shows it `refused`, naming the key and the placeholder) and none of it applies.
  Keys English does not know are ignored with a warning.
- **Two packs for one code:** the most recently enabled is used; the other is reported.
- After an update adds strings, MoltenTerm says how many are not translated in a pack's language and offers the
  `/morph` request that completes it.

`language-pack.md`, next to this page, is the guide a coding agent follows to write one. The `molten i18n` commands
help:

```
molten mod new <id> --language <code> [--language-name <own name>]   # a pack with an empty dictionary
molten i18n export [--lang <code>] [--missing] [--json]   # English reference; --lang current translation;
                                                          # --missing only the keys still to translate (in English)
molten i18n check <file> [--lang <code>]   # the check MoltenTerm applies at load; exit 1 when refused
molten i18n status                         # each language, where it comes from, how many strings it lacks
```

## `main`

`main` is one self-contained ES module: it cannot import other files, relative or from npm, because MoltenTerm loads it
from memory. Bundle it first if needed. It exports `activate`:

```js
export function activate(api) {
    api.commands.register("hello", ({ args }) => `hello ${args.join(" ") || "world"}`, {
        description: "Say hello",
    });
}
```

`activate` may be `async`. It must finish within 10 seconds.

## `MoltenApi` v1

- `api.apiVersion`: `1`.
- `api.mod`: `{ id, name, version }` from `mod.json`.
- `api.commands.register(name, handler, { description })`: registers a command that `molten <name> [args…]` runs. `name` uses
  lowercase letters, digits and `-` and starts with a letter; `mod`, `help`, `undo`, `history`, `agent` and `docs` are
  reserved, and a name another mod already registered is refused. `handler({ args, stdin, blockId })` returns a
  string, `{ output, exitCode }` or nothing, possibly through a promise. `args` are the words after the command name,
  `stdin` the text piped into `molten` (up to 1 MB), `blockId` the terminal it was run from. The output is printed
  and `exitCode` (default 0) becomes the exit code of `molten`; a handler that throws exits with 1.
- `api.notifications.show({ title, message, kind })`: shows a notification in the tab; `kind` is `info` (default),
  `success`, `warning` or `error`. Errors stay until closed; the others disappear after 8 seconds.
- `api.boxes.show({ blockId, title, text, monospace, actions })`: shows a box over the bottom-right corner of the
  terminal block `blockId` (the `blockId` a command handler receives), or in the window's corner without one. Boxes
  stack, close with their button or with Escape once clicked, and never take the keyboard by themselves. Each action
  is `{ icon, label, run }`: `icon` is a Font Awesome name such as `copy`, and `run` may return a short message shown
  on the button for a moment, such as `"Copied"`. A box is declarative, so a mod never depends on React.
- `api.clipboard.writeText(text)`: copies text to the system clipboard.
- `api.locale`: the interface language's code (`en`, `fr`, or an installed language), read live: the `app:language`
  setting, else the OS preferred language MoltenTerm speaks. A mod ships its own strings (MoltenTerm does not
  translate them) and falls back to English for a language it lacks.
- `api.onLocaleChange(handler)`: calls `handler(locale)` with the new code each time the interface language changes,
  without a restart. Use it to redraw text that stays on screen; text built at each call can read `api.locale` instead.
- `api.log.info|warn|error(...)`: writes to the tab's developer console, prefixed with the mod id.

Output a command handler returns stays English whatever the interface language: coding agents parse `molten`'s
output.

Every `register` and `show` returns a function that undoes it. MoltenTerm calls them all, in reverse order, when the
mod stops.

## The page is not part of the API

A mod's code runs in the tab, so `document`, `window` and the renderer's globals are within its reach. Using them is
unsupported, and a mod built on them is not accepted as a morph:

- MoltenTerm can only undo what it knows about. Everything a mod does through `api` is undone when it stops
  (`molten mod disable`, `molten mod remove`, `molten undo`, a reload on save, a failure); a change made directly in
  the page is not, so the workspace would not come back as it was.
- MoltenTerm's class names, elements and globals change between versions and with each update from Wave Terminal: a
  mod that relies on them breaks without warning.

As a safety net, MoltenTerm removes, when a mod stops, the elements its code added directly to `<html>`, `<head>` or
`<body>` (with `appendChild`, `insertBefore`, `replaceChild`, `append`, `prepend`, `insertAdjacentElement` or
`insertAdjacentHTML`), from `activate`, a command, a timer or any later callback; an element a stopped mod's leftover
code adds there is removed at once. Everything else stays until the tab reloads: changes inside existing elements,
attributes and inline styles (such as `document.documentElement.style`), an element of the app a mod replaced or
removed, elements added with `before`, `after`, `replaceWith` or `innerHTML`, and event listeners on `window` or
`document`. In safe mode no mod code runs, so nothing of a mod reaches the page.

Two mods cannot register the same command name. Built-in mods load first, then the others in id order, and a mod
loaded later never takes a name from a running one: the first keeps the command, and the second gets an error naming
both mods (a notification, and `molten mod list`). Rename the command in one of them.

## Cost and budget

Every MoltenTerm tab runs its own copy of each mod, so a mod's idle work is paid once per open tab. To keep that small:

- A tab loads the mods' code when it is first shown (or when a `molten` command run in it needs them), not before.
- While a tab is hidden or minimised, the mod's timers are held: `setTimeout` and `setInterval` called from the mod's
  module (MoltenTerm gives each mod its own) wait, and a timer that came due runs once when the tab shows again.
  A mod that must keep working in hidden tabs declares the `background` capability in `mod.json`.
- The module may also export `suspend()` and `resume()`, called when its tab is hidden and shown again, to pause work
  that is not a timer (an animation, a watcher).

MoltenTerm measures each mod: the time of `activate`, the time of everything it runs (commands, box actions, timer
callbacks), its idle CPU over the last 30 seconds, its timers, and the memory its activation took. The budget is
**2 % of one core while idle** and **20 MB**. A mod above it gets a warning notification and is marked over budget,
with its numbers, in Settings > Mods and in `molten mod list` (CPU column). It keeps running: turn it off with
`molten mod disable <id>`, or make it do less while idle.

## Built-in mods

Some mods ship inside MoltenTerm. They are written exactly like user mods, against the same API, and are part of
the app: they need no trust prompt and run unless turned off with `molten mod disable <id>` (listed under
`"disabled"` in `mods.json`). `molten mod list` marks them `(built-in)`; they cannot be removed or untrusted. A
folder in `<config>/mods/` named like a built-in mod is ignored.

## Coding agents: /morph

The user asks their own coding agent for a change with `/morph <request>`; the agent follows the `morph.md` guide to
build the mod with `molten`. MoltenTerm installs the guides itself, at user level: at every start, for each agent
below found on the login shell's PATH, and again when its version changes. Nothing is needed for an agent that is
already there; an agent installed later gets them at the next start, or at once with `molten agent install`.

```
molten agent list                 # coding agents: installed, version, capabilities; where the guides go
molten agent install <agent>      # shows the path, asks, writes (--yes to skip the question)
molten agent remove <agent>       # deletes only a file molten wrote; MoltenTerm stops installing for that agent
```

The `generic` file is never installed at start: it is for an agent outside the list, set up by hand.

| Agent | Installed as | The user types |
| --- | --- | --- |
| `claude-code` | skill `~/.claude/skills/morph/SKILL.md` | `/morph <request>` |
| `codex` | skill `~/.agents/skills/morph/SKILL.md` | `$morph <request>` |
| `gemini-cli` | command `~/.gemini/commands/morph.toml` | `/morph <request>` |
| `qwen-code` | command `~/.qwen/commands/morph.md` | `/morph <request>` |
| `kimi` | skill `~/.kimi-code/skills/morph/SKILL.md` | `/skill:morph <request>` |
| `generic` | file `<data>/molten/agents/morph.md` | "Read <file> and follow it with my request: …" |

The agents follow the SaaSFoundryAI agent catalog. `~/.agents/skills/` is also read by Gemini CLI and Kimi.
`/morph` replaced `/molten-feature`: `molten agent install` deletes a `molten-feature` guide that molten wrote, and
leaves a file of the same name that someone else wrote.

## A complete example: the copy box

The copy box is the first built-in mod and the reference example: its source is
`examples/copy-box/` next to this file (`frontend/molten/builtin/copy-box/` in the MoltenTerm repository). It
registers one command:

```
molten copy [--title <title>] <text…>
<command> | molten copy [--title <title>]
```

The command shows the text in a box next to the terminal it ran in, with a copy button that copies exactly the text
(several lines, any Unicode; one trailing newline from a pipe is dropped). Coding agents use it for every piece of
text the user has to copy: a token, a command, a URL. The box speaks the interface language (`api.locale`, English
for a language the mod lacks); the command's own output stays English.

```js
export const Strings = {
    en: { title: "Copy", copy: "Copy", copied: "Copied" },
    fr: { title: "Copier", copy: "Copier", copied: "Copié" },
};

export function activate(api) {
    api.commands.register(
        "copy",
        ({ args, stdin, blockId }) => {
            const strings = Strings[api.locale] ?? Strings.en; // read at each call: a language change applies at once
            const { title, text: argText } = parseCopyArgs(args, strings.title); // --title anywhere, "--" ends the options
            const text = argText !== "" ? argText : textFromStdin(stdin); // drops one trailing newline
            if (text === "") {
                return { output: "molten copy: nothing to copy: give a text or pipe one", exitCode: 1 };
            }
            api.boxes.show({
                blockId,
                title,
                text,
                monospace: true,
                actions: [
                    {
                        icon: "copy",
                        label: strings.copy,
                        run: async () => {
                            await api.clipboard.writeText(text);
                            return strings.copied;
                        },
                    },
                ],
            });
            return "";
        },
        { description: "show text in a box with a copy button" }
    );
}
```

## Failures

A mod that throws while loading, in `activate`, or later in one of its handlers is stopped: everything it registered is
undone, a notification gives the error, and `molten mod list` shows the mod as `failed` with its error. The tab and
the other mods keep working.

## The molten command

`molten` is installed next to `wsh` in every local MoltenTerm terminal (`wsh molten …` is the same command). Every
command accepts `--json` and exits non-zero on failure; with `--json` an error is printed on stderr as
`{"error": "…"}`.

```
molten mod new <id> [--name <name>] [--description <text>]   # a working mod from a template, disabled
molten mod new <id> --claude-code [--claude-code-version X.Y.Z]   # the same, with a Claude Code part
molten mod new <id> --language <code> [--language-name <name>]   # a language pack (data only)
molten mod validate [<id>…]   # manifest, API version, syntax: file:line:column of each problem; runs no code
                              # (and claude plugin validate on a Claude Code part; warnings never fail)
molten mod enable <id>        # in every open tab; asks you to trust the mod first
molten mod untrust <id>       # stops the mod and forgets the trust
molten mod disable <id>
molten mod list               # ID, state (disabled, untrusted, active, failed, refused), version, commands, error;
                              # then the state of each Claude Code part (active, disabled, untrusted, invalid, safemode)
molten mod remove <id>        # disables the mod, forgets its trust and moves its folder to the trash
molten undo                   # restores the mods as before the last change
molten history                # the recorded changes
molten help                   # built-in commands and the commands of the enabled mods
molten [--json] [--timeout <seconds>] <command> [args…]   # runs a mod command (default timeout 60 s)
```

Options of `molten` itself go before the command name; everything after it goes to the mod command. Each tab loads
its own copy of every enabled mod, and `molten` talks to the tab it runs in.

The usual loop for an agent: `molten mod new <id>`, edit `main.js`, `molten mod validate <id>`,
`molten mod enable <id>` (the user answers the trust prompt), `molten <command>`, `molten mod list` to see errors.

## Not in API version 1 yet

A mod cannot restyle, hide or replace what MoltenTerm shows, add a panel or a card, put a command in the palette or
on a key, or react to events. These are the next steps, each declared by the mod and owned by the host (undone on
disable and `molten undo`, skipped in safe mode, recorded in `molten history`):

| Planned capability | What it will allow | Story |
| --- | --- | --- |
| Themes | override the colour, typography and density tokens and the accent, as data in `mod.json` | #721 |
| Hide list | hide named parts of the interface (the 360 radar, a status bar item…) | #722 |
| Settings, widgets, presets, terminal themes | carry settings, rail tools, agent presets and terminal themes in the mod | #723 |
| Palette, command panel, keys | show a mod command in the palette and the command panel, and bind it to a key | #724 |
| Events and state | react to "an agent finished", "a tab opened"…, read the workspace, project and agents | #725 |
| Cards and status bar items | add Mission Control cards and status bar items, drawn by the host like boxes | #726 |

Layouts and free-form panels come later. Until then, use only `api`: a mod that reaches into the page (`document`,
injected styles, MoltenTerm's internal objects) is unsupported, breaks on any update, and what it changes stays on
screen after the mod stops or is undone, beyond the safety net described in "The page is not part of the API".

`molten mod remove` also moves the folder to the system trash on macOS (`<data>/molten/removed/` elsewhere), and
`molten undo` brings the mod back.
