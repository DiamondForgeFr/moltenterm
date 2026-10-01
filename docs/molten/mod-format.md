# Moltenterm mods

A mod changes Moltenterm from the outside: it is a folder in the configuration directory that Moltenterm loads when a
tab opens. Mods only see `MoltenApi`, described below, and never Wave's internal modules. This page documents API
version 1.

## Folder

```
<config>/mods/<mod-id>/
    mod.json
    main.js
```

`<config>` is Moltenterm's configuration directory (`~/.config/moltenterm` on macOS and Linux, `moltenterm-dev` for
development builds; `wsh wavepath config` prints it). Folders whose name starts with `.` are ignored.

A mod runs only once it is enabled. The enabled mods are listed in `<config>/molten/mods.json`
(`{"enabled": ["<mod-id>", …]}`), outside the mod folders, and `molten mod enable|disable` changes it; every open tab
applies the change at once. A mod that is not listed is reported as `disabled` and none of its code is read.

## Trust

A mod runs inside Moltenterm with the user's rights: it can read and change files and run commands. So no mod code
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
| `main`         | yes      | Path of the module inside the folder, ending in `.js` or `.mjs`; no `.` or `..` segment       |
| `capabilities` | no       | List of strings declaring what the mod uses, shown when the user is asked to trust it (#21)   |

## `main`

`main` is one self-contained ES module: it cannot import other files, relative or from npm, because Moltenterm loads it
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
- `api.log.info|warn|error(...)`: writes to the tab's developer console, prefixed with the mod id.

Every `register` and `show` returns a function that undoes it. Moltenterm calls them all, in reverse order, when the
mod stops.

## Built-in mods

Some mods ship inside Moltenterm. They are written exactly like user mods, against the same API, and are part of
the app: they need no trust prompt and run unless turned off with `molten mod disable <id>` (listed under
`"disabled"` in `mods.json`). `molten mod list` marks them `(built-in)`; they cannot be removed or untrusted. A
folder in `<config>/mods/` named like a built-in mod is ignored.

## A complete example: the copy box

The copy box is the first built-in mod and the reference example: its source is
`frontend/molten/builtin/copy-box/` in the Moltenterm repository. It registers one command:

```
molten copy [--title <title>] <text…>
<command> | molten copy [--title <title>]
```

The command shows the text in a box next to the terminal it ran in, with a copy button that copies exactly the text
(several lines, any Unicode; one trailing newline from a pipe is dropped). Coding agents use it for every piece of
text the user has to copy: a token, a command, a URL.

```js
export function activate(api) {
    api.commands.register(
        "copy",
        ({ args, stdin, blockId }) => {
            const { title, text: argText } = parseCopyArgs(args); // --title anywhere, "--" ends the options
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
                        label: "Copy",
                        run: async () => {
                            await api.clipboard.writeText(text);
                            return "Copied";
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

`molten` is installed next to `wsh` in every local Moltenterm terminal (`wsh molten …` is the same command). Every
command accepts `--json` and exits non-zero on failure; with `--json` an error is printed on stderr as
`{"error": "…"}`.

```
molten mod new <id> [--name <name>] [--description <text>]   # a working mod from a template, disabled
molten mod validate [<id>…]   # manifest, API version, syntax: file:line:column of each problem; runs no code
molten mod enable <id>        # in every open tab; asks you to trust the mod first
molten mod untrust <id>       # stops the mod and forgets the trust
molten mod disable <id>
molten mod list               # ID, state (disabled, untrusted, active, failed, refused), version, commands, error
molten mod remove <id>        # disables the mod, forgets its trust and moves its folder to the trash
molten help                   # built-in commands and the commands of the enabled mods
molten [--json] [--timeout <seconds>] <command> [args…]   # runs a mod command (default timeout 60 s)
```

Options of `molten` itself go before the command name; everything after it goes to the mod command. Each tab loads
its own copy of every enabled mod, and `molten` talks to the tab it runs in.

The usual loop for an agent: `molten mod new <id>`, edit `main.js`, `molten mod validate <id>`,
`molten mod enable <id>` (the user answers the trust prompt), `molten <command>`, `molten mod list` to see errors.

## Not in API version 1 yet

Reloading on save (#19), undo and safe mode (#20), and free-form panels (Mission Control, #31). Until #20,
`molten mod remove` moves the folder to the system trash on macOS and to `<data>/molten/removed/` elsewhere.
