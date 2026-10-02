# molten-feature: turn a request into a MoltenTerm mod

The user asked for a change to their MoltenTerm workspace:

{{REQUEST}}

MoltenTerm is the terminal you run in. It changes shape through mods: small JavaScript modules it loads without a
restart. You build the change as a mod with the `molten` command; you never edit MoltenTerm itself.

## Steps

1. Check that you run inside MoltenTerm: `molten help` must work. If `molten` is not found, tell the user to run
   this request from a MoltenTerm terminal, and stop.
2. Read the documentation of the installed version: run `molten docs`, then read `mod-format.md` in the folder it
   prints, and the complete example in `examples/copy-box/`.
3. See what exists: `molten mod list --json`. If a mod already covers this feature, edit it instead of creating a
   new one.
4. Create the mod: `molten mod new <id> --name "<name>" --description "<one sentence>"`, then write `main.js` in the
   folder it prints, and list in `mod.json` the capabilities it uses. A mod is one self-contained ES module: no
   import, only the `api` given to `activate`.
5. Check it: `molten mod validate <id>`. Fix every problem it names (file:line:column) until it says ok.
6. Enable it: `molten mod enable <id>`. MoltenTerm asks the user to trust the mod; wait for the answer. If the user
   declines, stop and say so.
7. Try it: run its commands (`molten <command> …`) and `molten mod list` to check that it is `active` with no error.
   Saving a file of the mod reloads it within a second.
8. Report: tell the user what the mod does, how to use it and the folder `molten mod new` printed (never guess
   the configuration path), ask them to check the result, and tell them that
   `molten undo` reverts the last change (repeat it to go further back) and `molten mod disable <id>` turns the mod
   off.

## Rules

- Work only through `molten` and the mod's folder. Never change MoltenTerm's own files, settings or other mods
  unless the user asked for it.
- One feature per mod.
- This version of the API cannot run programs or read the terminal's folder: when a feature needs them (for example
  `git`), say so plainly and let the shell pass the value in (an argument or a pipe into `molten <command>`).
- Read `molten` output with `--json`.
- Text the user has to copy: when `molten mod list` shows the `copy-box` mod active, also give every token, command
  or URL the user has to copy with `molten copy --title "<what it is>" "<text>"` (or pipe it into `molten copy`).
- When something fails, read the mod's state and error in `molten mod list`, fix the file and save; never restart
  MoltenTerm. If the workspace is broken, tell the user about **Restart in Safe Mode** in the app menu.
