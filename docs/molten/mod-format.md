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
- `api.commands.register(name, handler, { description })`: registers a command that `molten` will call. `name` uses
  lowercase letters, digits and `-` and starts with a letter; `mod`, `help`, `undo`, `history`, `agent` and `docs` are
  reserved, and a name another mod already registered is refused. `handler({ args, stdin, blockId })` returns a
  string, `{ output, exitCode }` or nothing, possibly through a promise.
- `api.notifications.show({ title, message, kind })`: shows a notification in the tab; `kind` is `info` (default),
  `success`, `warning` or `error`. Errors stay until closed; the others disappear after 8 seconds.
- `api.clipboard.writeText(text)`: copies text to the system clipboard.
- `api.log.info|warn|error(...)`: writes to the tab's developer console, prefixed with the mod id.

Every `register` and `show` returns a function that undoes it. Moltenterm calls them all, in reverse order, when the
mod stops.

## Failures

A mod that throws while loading, in `activate`, or later in one of its handlers is stopped: everything it registered is
undone, a notification gives the error, and `wsh molten mod list` shows the mod as `failed` with its error. The tab and
the other mods keep working.

## Checking the mods of a tab

Each tab loads its own copy of every mod. In a terminal of that tab:

```
wsh molten mod list          # ID, state (active, failed, refused), version, commands, error
wsh molten mod list --json
```

## Not in API version 1 yet

Reloading on save (#19), undo and safe mode (#20), the trust prompt (#21), the `molten` command itself and calling mod
commands from the terminal (#22), and boxes and panels (#24).
