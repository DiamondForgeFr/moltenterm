# morph: turn a request into a morph of MoltenTerm

The user asked for a change:

{{REQUEST}}

MoltenTerm is the terminal you run in. It changes shape through mods: small JavaScript modules it loads without a
restart. You build the change as a mod with the `molten` command; you never edit MoltenTerm itself.

You work in nine steps, always in this order: look first, ask a few questions, give a plan, ask for trust when the
user agrees to it, open the design view, build live, adjust, validate, and say where the mod lives. The steps are the
same for every coding agent, because every one of them goes through `molten`. Speak to the user in the language of
the conversation, in plain words; commands, ids and file names stay as they are.

The steps run in this terminal, or in MoltenTerm's dedicated design view when the installed version has it: a tab with a
guiding panel beside a terminal, that you keep in step with the conversation. Step 5 tells you how to open it, and the
steps and their order stay the same.

## Preconfigured morphs

Some requests have a ready guide in the `molten docs` folder. When the request is one of these, follow that guide
instead of the nine steps below (the two checks of "Before the steps" still apply):

| The request | Guide |
| --- | --- |
| Translate MoltenTerm into a language, complete a translation, or change some of its texts (any language, English and French included) | `language-pack.md` |

## Before the steps

- Check that you run inside MoltenTerm: `molten help` must work. If `molten` is not found, tell the user to run
  this request from a MoltenTerm terminal, and stop.
- Read the documentation of the installed version: run `molten docs`, then read `mod-format.md` in the folder it
  prints, and the complete example in `examples/copy-box/`. If the request is a preconfigured morph (above), read
  its guide there too and follow it.
- Read what earlier designs learned of the developer: `molten learn defaults morph-design` (`learning.md` in the same
  folder). Start from those answers instead of asking again, say that you do, and let the developer change them.

{{SANDBOX_RULE}}

## The split rule

A mod has two parts, and every piece of the request goes in exactly one of them:

- **The MoltenTerm part** (`mod.json` and `main.js`): the data, the interface, and anything that serves every agent.
  Any agent reaches it through `molten`, so the mod keeps working whichever agent the user runs.
- **The agent part**: only what lives inside one agent session (a band above the prompt, a status line entry, hooks
  on that agent's tool calls, a slash command of that agent). Nothing the user needs from another agent goes here.

A request that needs both builds both, and the plan says which is which. When in doubt, a piece goes in the
MoltenTerm part. A request that is neither (MoltenTerm's own code, or something no mod can reach): say so and stop.
<!-- not:claude-code -->

What lives only in your own session (your prompt, your tool calls, your status line, your interface) is the agent
part. This version of MoltenTerm cannot change that for your agent: build the MoltenTerm part of the request, and
tell the user plainly which piece you left out and why.
<!-- /not -->
<!-- only:claude-code -->

The agent part of a mod is a Claude Code plugin folder inside the mod, `agents/claude-code/`. Also read
`claude-code-parts.md` in the `molten docs` folder, and the complete example `examples/test-band/`, which has both
parts. The two parts reach each other this way: the agent part runs `molten <command>` (arguments or stdin) and
`wsh` (for example `wsh notify`) through `$.process.run`; they work because Claude Code inherits the terminal's
environment. The MoltenTerm part cannot call into Claude Code: the agent part pulls, by running a `molten` command.
<!-- /only -->

## Steps

1. **Look first.** Run `molten mod list --json`. If a mod already covers this feature, tell the user which one and
   edit it instead of creating a new one, unless the user asked for a new one. This step only reads: it creates,
   enables and changes nothing. Then open the design view if the installed version has it (step 5 says how), so the
   questions and the plan show in its panel: pick the id the mod will have, short, lowercase, with hyphens.

2. **Ask one to three questions, only about what is missing.**
   - Ask only what the request leaves open and what looking (the project, the mods, `molten`) cannot tell you. At
     most three, in one message; fewer is better, and a request that leaves nothing open gets none.
   - Prefer choices the user can pick (numbered, the one you recommend first) to open questions. Ask about what they
     want to see and use (what to show, where the data comes from, which files, how often), never about how you
     build it.
   - A request that says to just do it ("fais-le", "just do it", "go ahead", or the same in any language) skips this
     step: ask nothing, take the safest default for each open point, and say which defaults you took in the plan.
     It skips the questions only: the user still agrees to the plan (steps 3 and 4).
   - With the design view open (step 5), ask each question in its panel: `molten morph design ask <key> "<question>"
     --choice "<label>" …`. The user's pick reaches you as a line in your prompt. An answer they give in the terminal
     goes to the panel with `molten morph design answer <key> "<answer>"`.

3. **Reformulate the request and give a plan scaled to it.** Write, in the user's language:
   - the request in your own words, in a sentence or two, so they see you understood;
   - a plan whose detail matches how precise the request was: a short request gets a short plan (a few lines), a
     detailed request a detailed plan, with a paragraph per part. Never pad it.

   Whatever its size, the plan states three things:
   - **What goes where**, by the split rule above: the pieces in the MoltenTerm part, and the pieces in the agent
     part.
   - **What the mod will access**, one per line: the files it reads or writes (with their paths), the MoltenTerm
     settings it reads or changes, the sources and services it reaches (and the secret each would need), the
     programs it runs, the capabilities it declares in `mod.json`, and the agent part if there is one (it runs
     inside the agent with the user's rights). Write "nothing else" when there is none. The user approves exactly
     this list in step 4.
   - **What waits**: any piece the installed API cannot do yet ("Out of reach for now" below), with its story.

   With the design view open, also show the plan in its panel with `molten morph design plan` (`morph-design.md` lists
   its options). The user agrees with a click there, which reaches you as a line in your prompt, or in the terminal.

   Example of a short plan, for "a box that shows the branch": "I will add a `branch` command that shows the current
   branch in a box next to the terminal. MoltenTerm part: the command and the box. Agent part: none. Accesses: the
   branch name, passed in by the shell; nothing else. Do you agree?" End by asking whether the user agrees, then
   wait. Until they do, you create nothing and enable nothing.

4. **Ask for trust when the user agrees to the plan.** The agreement is the moment for trust: the user approves what
   they have just read, once, before any code you write runs. Never run `molten mod enable` before that agreement.
   Once they agree:
<!-- not:claude-code -->
   - create the mod: `molten mod new <id> --name "<name>" --description "<one sentence>"`. Leave `main.js` as the
     template for now;
<!-- /not -->
<!-- only:claude-code -->
   - create the mod: `molten mod new <id> --name "<name>" --description "<one sentence>"`, with `--claude-code` when
     the plan has an agent part. Leave `main.js` as the template for now;
<!-- /only -->
   - declare in `mod.json` the capabilities the plan listed, and no more;
<!-- not:claude-code -->
   - enable it: `molten mod enable <id>`. MoltenTerm shows its trust prompt with the mod's declared capabilities,
     which are the plan's list; wait for the answer. If the user declines, stop and say so: nothing ran.
<!-- /not -->
<!-- only:claude-code -->
   - enable it: `molten mod enable <id>`. MoltenTerm shows its trust prompt with the mod's declared capabilities and
     its agent part, which are the plan's list; wait for the answer. If the user declines, stop and say so: nothing
     ran.
<!-- /only -->

   Trust is remembered for the mod, so later saves ask nothing: the plan's list is the contract. If the build needs
   an access the plan did not list (a capability, an agent part, a file, a service), stop, say which and why, update
   the plan and ask again before you write it. Never widen the accesses silently. `molten mod untrust <id>` takes the
   trust back and stops the mod. When you edit a mod that already exists (step 1), there is nothing to create: the
   user's agreement to the plan covers the new accesses it lists, and a disabled mod is enabled as above.

5. **Open the design view when the installed version has it.** Run `molten help`. If it lists `morph design`, run
   `molten morph design <id> --name "<the mod's name>"`, with the id the mod will have (step 4 creates it): MoltenTerm
   opens a design tab with a guiding panel beside a terminal. Do it right after step 1, so steps 2 to 4 show in the
   panel; reaching this step without having opened it, open it now and show what steps 2 to 4 settled (`answer`, `plan`).
   Keep the panel in step as you go with `molten morph design step|ask|answer|plan|draft` (`morph-design.md` in the
   `molten docs` folder); the steps keep the same order, and the terminal stays the free way to say anything the panel
   does not offer. If `molten help` does not list `morph design`, or the command says the view did not open, the
   installed version has no design view for you: skip this step and run the steps here, in this terminal, with the same
   words and the same order. Never present that as a problem.

6. **Build live, with sample data first.**
   - Show it is a draft: the installed version has no draft badge yet (story #1895), so end the mod's `name` in
     `mod.json` with ` (draft)` until step 8. With the design view open, tell its panel what the draft draws:
     `molten morph design draft --state sample --command <name> --box <title>`, and `--state real` once the real data is
     wired.
   - Show the shape with invented sample data before wiring anything real, so the user sees a result at once. Once
     they confirm the look, replace the sample with the real data the plan listed.
   - Write `main.js` in the folder `molten mod new` printed. `mod.json` keeps the capabilities of the plan's list,
     and no others. A mod is one self-contained ES module: no import, only the `api` given to `activate`, never
     `document` or the page (`mod-format.md` says why).
   - Check it: `molten mod validate <id>`. Fix every problem it names (file:line:column) until it says ok.
   - Try it: run its commands (`molten <command> …`) and `molten mod list` to check that it is `active` with no
     error. Saving a file of the mod reloads it within a second, so the user sees each change as you save it. Every
     tab runs the mod, so keep its idle work small: its CPU column must stay under the budget (`mod-format.md`, Cost
     and budget).
<!-- only:claude-code -->
   - The agent part: write it only in the mod's `agents/claude-code/` folder, the one `molten mod new
     --claude-code` printed: `hooks/register.ts` (or `.tsx`), `hooks/hooks.json`, `.claude-plugin/plugin.json`
     whose `name` stays the mod id. A mod with only an agent part keeps a `main.js` whose `activate` does nothing.
     `molten mod validate` also runs `claude plugin validate` on it, and warns when the installed Claude Code is not
     the version the part targets (`targetVersion` in `mod.json`).
   - Use Claude Code's `plugin-authoring` skill as the reference for the plugin API (typings, examples,
     `claude plugin validate`, `tsc`, `claude plugin test`). It also says where to write and how to load; where it
     disagrees with this guide, this guide wins:
     - **Where to write.** The skill says to write each mod in a folder under its `dev-mods` folder. Do not: write
       in the mod's `agents/claude-code/` folder and nowhere else, so there is one copy.
     - **Hot reloading.** The skill turns its hot reloading on with the question "Turn on the mods Claude writes in
       this session?", which appears when a file lands under its `dev-mods` folder. That stays off: you never write
       there, so the question never comes up. If it comes up anyway, do not answer it for the user; tell them to
       choose "Not now". Do not use `claude --plugin-dir`, and never set `CLAUDE_CODE_PLUGIN_DIRS`: MoltenTerm
       loads the part itself, as below. What the skill says about a mod loading "when the turn ends" does not apply
       to the part.
     - **Panels.** The skill answers a request for a panel with a pane inside the Claude Code session. For a panel
       the user wants in MoltenTerm, follow the split rule instead: it is interface, so it goes in the MoltenTerm
       part (see "Out of reach for now"). The skill's pane is for what lives only in that session, beside the chat.
   - The agent part does **not** load in this session. Tell the user that it loads in a new Claude Code session
     started in a new MoltenTerm terminal: open a new terminal, and run `claude --continue` there to keep this
     conversation. A terminal that was open before the part existed never loads it. After that, saving a file of the
     part reloads it in that session by itself: Claude Code watches the folders MoltenTerm names for it, which is not
     the skill's hot reloading and needs nothing from you. `molten mod list` shows the part as `active`.
<!-- /only -->

7. **Adjust through the conversation.** The user looks at the draft and asks for changes in plain words. Make each
   one, save, check `molten mod list` for errors, and say in a line what changed. Do not ask again what they already
   answered. A change that needs an access the plan did not list goes back to step 4. With the design view open, keep
   the panel on `molten morph design step adjust --say "<what changed>"`.

8. **Validate: name, icon, category.** When the user is happy, ask for the finishing choices in one message: a
   **name** for the mod, **three icons** to pick from (Font Awesome names, with a word each) and a **category**.
   Apply the name in `mod.json` and drop ` (draft)`. The icon and the category are `mod.json` fields only when
   `mod-format.md` lists them; if it does not, say that these two choices wait for story #1895 and put them in your
   report. If the user gives up instead, run `molten undo`, repeating it (check `molten history`) until the mod is
   gone, never further back than the change that created it, and say so. With the design view open, ask these three in
   its panel (`molten morph design ask name … --step finish`, `ask icon … --icons --step finish` and
   `ask category … --step finish`), then `molten morph design step validate`: the user validates or gives up there,
   and the click reaches you as a line in your prompt.

9. **Your mods, and the report.** Tell the user what the mod does, how to use it and the folder `molten mod new`
   printed (never guess the configuration path), and where to find it: `molten mod list`, and Library > Tools > Your
   mods from the version that has that page (story #1636). Ask them to check the result, and tell them that
   `molten undo` reverts the last change (repeat it to go further back) and `molten mod disable <id>` turns the mod
   off. With the design view open, end with `molten morph design step collect --say "<where it lives>"`.

## Out of reach for now

MoltenTerm API version 1 adds commands, boxes next to a terminal, notifications and interface texts (language
packs). When a request needs more, build what is reachable, then tell the user plainly which part waits and for
which planned capability, with its story:

| The request needs | Planned capability | Story |
| --- | --- | --- |
| Colours, accent, fonts, density | Mod themes | #721 |
| Hiding or replacing a part of the interface | Hide list | #722 |
| A setting, a rail tool, an agent preset, a terminal theme | Settings, widgets, presets and terminal themes in mods | #723 |
| A command in the palette or the command panel, a keybinding | Mod commands in the palette, the command panel and keys | #724 |
| Reacting to an event ("an agent finished", "a tab opened"), reading the workspace, project or agents | Events and read-only state | #725 |
| A Mission Control card, a status bar item | Cards and status bar items | #726 |
| A layout, a panel of its own | Declarative mod panel drawn by the host (Morph v7) | #1890 |
| Reading or writing a file the user chose, from the mod | Declared files (Morph v7) | #1892 |
| A service with a token (Atlassian, GitHub, an API of their own) feeding the mod | Host-side sources fed by Secrets (Morph v7) | #1897 |
| A notification when a source has something new | Notifications from a source (Morph v7) | #1898 |

The stories are on https://github.com/DiamondForgeFr/moltenterm/issues/<number>. For example: "Hiding the radar
waits for the hide list (#722); I added nothing." or "I added `molten staging`, which shows the deployed branch in a
box; a Mission Control card for it waits for #726."

Never work around a missing capability by reaching into the page (`document`, injected styles, MoltenTerm's internal
objects): it is unsupported, breaks on updates, and stays on screen after `molten mod disable` or `molten undo`.
<!-- only:claude-code -->
Inside Claude Code sessions, the agent part may already cover part of such a request (a hook on Claude Code's own
events, a status line entry): build it there, and say that other agents and the rest of the workspace still wait for
the story.
<!-- /only -->

## Rules

- Work only through `molten` and the mod's folder. Never change MoltenTerm's own files, settings or other mods
  unless the user asked for it.
<!-- only:claude-code -->
- Never edit `~/.claude` (settings, plugins) and never set `CLAUDE_CODE_PLUGIN_DIRS`: MoltenTerm loads the
  agent part itself.
<!-- /only -->
- One feature per mod.
- The mod is the user's, under the license they choose (`mod-format.md`, "License of a mod"): do not give it
  MoltenTerm's license or copyright header unless the user asks for one.
- This version of the MoltenTerm API cannot run programs or read the terminal's folder: when a feature needs them (for example
  `git`), say so plainly and let the shell pass the value in (an argument or a pipe into `molten <command>`).
- Read `molten` output with `--json`.
- Text the user has to copy: when `molten mod list` shows the `copy-box` mod active, also give every token, command
  or URL the user has to copy with `molten copy --title "<what it is>" "<text>"` (or pipe it into `molten copy`).
- When something fails, read the mod's state and error in `molten mod list`, fix the file and save; never restart
  MoltenTerm. If the workspace is broken, tell the user about **Restart in Safe Mode** in the app menu.
