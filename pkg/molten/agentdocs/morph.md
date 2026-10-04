# morph: turn a request into a morph of MoltenTerm

The user asked for a change:

{{REQUEST}}

MoltenTerm is the terminal you run in. It changes shape through mods: small JavaScript modules it loads without a
restart. You build the change as a mod with the `molten` command; you never edit MoltenTerm itself.

## Steps

1. Check that you run inside MoltenTerm: `molten help` must work. If `molten` is not found, tell the user to run
   this request from a MoltenTerm terminal, and stop.
2. Read the documentation of the installed version: run `molten docs`, then read `mod-format.md` in the folder it
   prints, and the complete example in `examples/copy-box/`.
<!-- not:claude-code -->
3. Decide what the request changes:
   - **The workspace**: panes, boxes, notifications, commands, anything around the terminals. This is a MoltenTerm
     mod, built with the steps below.
   - **Your own session**: how you, the coding agent, draw your interface or behave (your prompt, your tool calls,
     your status line). This version of MoltenTerm cannot change that for your agent. Build the part of the request
     that concerns the workspace, if there is one, and tell the user plainly which part you could not do and why.
   - **Both**: build the workspace part, and say which part was left out.
   - **Neither** (MoltenTerm's own code, or something no mod can reach): say so and stop.
<!-- /not -->
<!-- only:claude-code -->
3. Decide what the request changes. A mod has two layers, and a request may need one or both:
   - **The MoltenTerm part**: the workspace, around the terminals (commands, boxes next to a terminal,
     notifications). This is `main.js`, built as today with the steps below.
   - **The Claude Code part**: inside this Claude Code session and the next ones (a band above the prompt, a pane, a
     status line entry, toasts, slash commands, hooks on tool calls, on prompts or on the system prompt). It is a
     Claude Code plugin folder inside the mod, `agents/claude-code/`. Also read `claude-code-parts.md` in the
     `molten docs` folder, and the complete example `examples/test-band/`, which has both layers.
   - **How they reach each other**: the Claude Code part runs `molten <command>` (arguments or stdin) and `wsh`
     (for example `wsh notify`) through `$.process.run`; they work because Claude Code inherits the terminal's
     environment. A MoltenTerm part cannot call into Claude Code: the Claude Code part pulls, by running a `molten`
     command.
   - **Neither** (MoltenTerm's own code, or something no mod can reach): say so and stop.
<!-- /only -->
4. See what exists: `molten mod list --json`. If a mod already covers this feature, edit it instead of creating a
   new one.
<!-- not:claude-code -->
5. Create the mod: `molten mod new <id> --name "<name>" --description "<one sentence>"`, then write `main.js` in the
   folder it prints, and list in `mod.json` the capabilities it uses. A mod is one self-contained ES module: no
   import, only the `api` given to `activate`.
<!-- /not -->
<!-- only:claude-code -->
5. Create the mod: `molten mod new <id> --name "<name>" --description "<one sentence>"`, with `--claude-code` when
   the request needs the Claude Code part. Then:
   - write `main.js` in the folder it prints, and list in `mod.json` the capabilities it uses. A mod is one
     self-contained ES module: no import, only the `api` given to `activate`. A mod with only a Claude Code part
     keeps a `main.js` whose `activate` does nothing.
   - write the Claude Code part in the `agents/claude-code/` folder `molten mod new` printed: `hooks/register.ts`
     (or `.tsx`), `hooks/hooks.json`, `.claude-plugin/plugin.json` whose `name` stays the mod id. Use the
     `plugin-authoring` skill bundled with Claude Code for the API and its checks (`claude plugin validate`, `tsc`,
     `claude plugin test`), **but write in that folder, not in the skill's dev-mods folder, and do not turn on the
     skill's hot reloading.**
<!-- /only -->
6. Check it: `molten mod validate <id>`. Fix every problem it names (file:line:column) until it says ok.
<!-- only:claude-code -->
   It also runs `claude plugin validate` on the Claude Code part, and warns when the installed Claude Code is not
   the version the part targets (`targetVersion` in `mod.json`).
<!-- /only -->
7. Enable it: `molten mod enable <id>`. MoltenTerm asks the user to trust the mod; wait for the answer. If the user
   declines, stop and say so.
8. Try it: run its commands (`molten <command> …`) and `molten mod list` to check that it is `active` with no error.
   Saving a file of the mod reloads it within a second.
<!-- only:claude-code -->
   The Claude Code part does **not** load in this session: tell the user that it loads in their next Claude Code
   session started in a MoltenTerm terminal (`/exit`, then `claude --continue` keeps the conversation), and that
   after that, saved edits of the part reload by themselves. `molten mod list` shows the part as `active`.
<!-- /only -->
9. Report: tell the user what the mod does, how to use it and the folder `molten mod new` printed (never guess
   the configuration path), ask them to check the result, and tell them that
   `molten undo` reverts the last change (repeat it to go further back) and `molten mod disable <id>` turns the mod
   off.

## Rules

- Work only through `molten` and the mod's folder. Never change MoltenTerm's own files, settings or other mods
  unless the user asked for it.
<!-- only:claude-code -->
- Never edit `~/.claude` (settings, plugins) and never set `CLAUDE_CODE_PLUGIN_DIRS`: MoltenTerm loads the
  Claude Code part itself.
<!-- /only -->
- One feature per mod.
- This version of the MoltenTerm API cannot run programs or read the terminal's folder: when a feature needs them (for example
  `git`), say so plainly and let the shell pass the value in (an argument or a pipe into `molten <command>`).
- Read `molten` output with `--json`.
- Text the user has to copy: when `molten mod list` shows the `copy-box` mod active, also give every token, command
  or URL the user has to copy with `molten copy --title "<what it is>" "<text>"` (or pipe it into `molten copy`).
- When something fails, read the mod's state and error in `molten mod list`, fix the file and save; never restart
  MoltenTerm. If the workspace is broken, tell the user about **Restart in Safe Mode** in the app menu.
