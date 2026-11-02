# Files: show what you found in the file panel

When the developer asks you to find files in the project, show them in the file panel of your tab as well as in your
answer: they see the matches, open them, change the filter or clear it themselves. `molten files` works the same for
any agent that runs in a MoltenTerm terminal.

```sh
molten files src --filter test                 # the entries of src whose name contains "test"
molten files src --filter '*.tsx' --recursive  # every .tsx file below src, as one flat list
molten files --filter readme                   # the workspace folder
molten files src                               # src with no filter (clears the panel's filter)
molten files src --filter '*.go' --json        # the same, as JSON
```

- `<folder>` is relative to your working directory; without it, the workspace folder is used.
- The pattern matches file and folder names, ignoring case: a substring, or a glob when it holds `*`, `?` or `[`
  (`*` and `?` never cross a `/`; `[abc]`, `[a-z]` and `[^a]` are character sets; `\` escapes the next character).
  Quote globs so the shell does not expand them. At most 200 characters, no control characters.
- `--recursive` searches every subfolder (it needs `--filter`). It skips `.git` and `node_modules`, includes hidden
  files only when the panel shows them, never follows links and stops at 1000 matches.
- The panel used: the one your last `molten files` used, else the file panel of your tab the developer focused last,
  else a new one opened to the right of your terminal. Your terminal keeps the keyboard focus, and nothing opens in
  another tab or workspace.
- The panel shows the filter with the chip "Set by <your first name>". The developer may edit it (it becomes theirs)
  or clear it; opening another folder clears it too. Run `molten files` again to show a new search.

## Output

One match per line, relative to the folder, folders ending with `/`, then a summary line:

```text
ui/
button.test.tsx
2 matches in /Users/me/code/app/src
```

When the list was cut, the summary line ends with `(truncated: the search stops at 1000 matches)`. Zero matches is a
success (`0 matches in ...`). With `--json`:

```json
{
  "folder": "/Users/me/code/app/src",
  "pattern": "test",
  "recursive": false,
  "matches": [
    { "path": "ui", "type": "dir" },
    { "path": "button.test.tsx", "type": "file" }
  ],
  "truncated": false
}
```

## Outside the project

In a workspace linked to a project, the file panel stays inside the project. A folder outside it is asked to the
developer in the panel, naming you; `molten files` prints a line on stderr and waits for the answer:

- Open outside the project: the command prints the matches as above and exits 0.
- Stay: the panel keeps what it showed, and the command exits 1 with
  `The user kept the file panel inside the project.` Do not ask again unless the developer tells you to.

## Errors and exit codes

Errors are one English line on stderr (`{"error": "..."}` with `--json`).

- 2: bad usage (too many folders, a pattern too long, with control characters or a malformed glob, `--recursive`
  without `--filter`, an unknown flag).
- 1: anything else (not run in a MoltenTerm terminal, a folder that does not exist, the user chose Stay, the panel was
  closed while waiting). A folder that does not exist leaves the panel unchanged.
