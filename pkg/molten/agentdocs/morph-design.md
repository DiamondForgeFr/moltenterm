# The mod design view: keeping its panel in step with the conversation

`/morph` can open a dedicated view for the mod you design with the developer: a tab "Design · <mod>" ("Conception ·
<mod>" in French) with a terminal on the left and a guiding panel on the right. The panel shows the steps of the
`/morph` guide in plain words, and you keep it in step with the conversation through `molten`. Every agent CLI drives it
the same way, because the panel only talks to `molten`.

The panel never blocks. The developer can skip a step, say they do it in the terminal, or ignore the panel and talk to
you: the terminal stays the free way for open precisions and for anything the panel does not offer. Never insist on a
click, and never wait for one the developer did not mean to make.

## Open it

```sh
molten help                                        # does it list `morph design`? If not, this version has no design view
molten morph design branch-box --name "Branch box"
```

- The id is the one the mod will have (`molten mod new <id>` creates it later, at step 4 of the guide). The name is how
  the developer reads it, in their language: it titles the tab.
- The tab opens in the window of this terminal's workspace and is focused. A second call for the same mod focuses the
  tab again and keeps its state. Nothing opens without this command or the developer's own click.
- The command waits for the window. If it exits with "the design view did not open", go on in this terminal with the
  same steps and the same words: never present that as a problem.
- A mod whose id is also a command name (`show`, `step`, `ask`, `answer`, `plan`, `draft`, `open`) opens with
  `molten morph design open <id>`.
- The commands below find the design from the terminal you run them in: the tab's own terminal, else the design you
  opened. With several designs open, name one with `--mod <id>`.

## The steps

The panel shows eight steps, in this order. Each has a title the developer reads in plain words.

| Step | The panel shows | You set it with |
| --- | --- | --- |
| `need` | The request in your own words | `step need --say "…"` |
| `questions` | Your questions, one to three, as choices to click | `ask` |
| `plan` | The plan: what goes where, what the mod will access, what waits | `plan` |
| `preview` | What the draft draws today | `draft` |
| `adjust` | The changes the developer asks for | `step adjust --say "…"` |
| `finish` | The name, the icon and the category, as choices | `ask … --step finish` |
| `validate` | Validate or give up | `step validate` |
| `collect` | Where the mod lives: Your mods (the page comes with story #1895) | `step collect --say "…"` |

`molten morph design step <step> --say "<one plain sentence>"` makes a step the current one: the panel highlights it
and shows your sentence. The steps before it that nobody settled are passed. `--done` and `--skipped` settle a step
without moving to it (use `--skipped` for the questions when the developer said to just do it); `--todo` brings one
back. `ask`, `plan` and `draft` bring their own step in view when it is ahead of the current one.

## Ask, plan, draft

```sh
molten morph design ask audience "Who will use it?" --choice "Just me" --choice "My team::Shared in the project" --recommend "Just me"
molten morph design ask icon "Which icon suits it?" --icons --choice code-branch --choice clock --choice folder --step finish
molten morph design answer category "Tools"        # the developer answered in the terminal: the panel shows it
molten morph design plan --summary "A box next to the terminal that shows the branch." \
  --molten-part "the branch command and its box" --agent-part "none" --access "the branch name, passed in by the shell" \
  --wait "the box in the status bar waits for story #726"
molten morph design draft --state sample --note "Invented branch names" --command branch --box "Branch"
molten morph design show                            # the design as the panel shows it, with the developer's answers
```

- `ask` takes a short key (lowercase letters, digits, `.` `_` `-`), the question, and two to four choices, the one you
  recommend first. `--choice "label::detail"` adds a line under a label. `--icons` makes the labels Font Awesome icon
  names, drawn as icons. A question asked again with the same key replaces the first. Ask in the developer's language.
- **The developer's click reaches you as a line in your prompt**, written by MoltenTerm ("In the mod design view of
  …, the developer picked …"). Take it as their answer and go on: show the next step with `step`, `ask` or `plan`. If
  you were not running when they clicked, `show` still lists their answers.
- `answer` shows in the panel what the developer answered in the terminal, so nothing is asked twice. It also records
  the answer in the memory of the `morph-design` workflow (`molten learn`), so the next design starts from it;
  `--no-learn` records nothing. Use the same keys the panel uses when you can: `name`, `icon`, `category`.
- `plan` shows the plan. Its summary is the request in your words and the plan scaled to how precise it was. List
  what goes in the MoltenTerm part and in the agent part, every access (a file with its path, a setting, a service
  and the secret it needs, a program, a capability), and what waits with its story. The developer agrees in the panel
  (their click reaches you as a line) or in the terminal; **creating and enabling the mod wait for that agreement**
  (step 4 of the guide). Accesses are approved only in MoltenTerm's trust prompt, never in the panel.
- `draft` tells the panel what the draft draws: `sample` while it shows invented data, `real` once it shows the real
  data; its `--command` names and `--box` titles are what API version 1 draws. The panel shows an empty placeholder
  where the declarative panel (story #1890) will plug in.
- `show` prints the steps and their states, every question with the developer's answer and who gave it (the panel or
  the terminal), the plan and whether it was agreed, the draft, and who receives the clicks. Add `--json` to read it as
  data.

## What the developer can do in the panel

Click a choice, agree to the plan, skip a step ("Skip this step"), say they do a step in the terminal ("I'll do it in
the terminal"), validate the mod or give it up. A skip, a choice, an agreement, a validation and a give up reach you as
a line in your prompt; "I'll do it in the terminal" does not, because they are about to tell you. A give up means: run
`molten undo` as step 8 of the guide says.

## Learning

The view remembers what the developer decides, in the workflow `morph-design` (see `learning.md`): the answers they
click or give, the steps they skip. The next design opens with the question they answered before preselected and marked
"Based on your earlier choices", and a step they skipped twice in a row is folded, never removed. Read
`molten learn defaults morph-design` when you start a design, and start from those answers instead of asking again; the
developer can still change each one. The keys the view records:

| Key | Kind | Meaning |
| --- | --- | --- |
| a question's key (`audience`, `refresh`…) | `answer` | what the developer picked or said for that question |
| `name`, `icon`, `category` | `answer` | the finishing choices |
| `need`, `questions`, `plan`, `preview`, `adjust`, `finish`, `validate`, `collect` | `skip` | a step the developer skipped |

## Good to know

- The panel shows and relays; it grants nothing. A choice in the panel never widens an access: an access the plan did
  not list goes back to the developer (step 4 of the guide).
- One agent drives a design at a time: the one that last ran a design command, which also receives the developer's clicks.
  While it runs, another agent elsewhere cannot change the design (`show` stays open to all): the command says who
  drives it. An agent started in the design tab's own terminal takes over by running a command, and a design no agent
  runs is free to any.
- The commands work in a MoltenTerm terminal of this computer only. Everything is English, plain text or `--json`. Exit
  codes: 2 for bad usage, 1 for any other failure.
- The design lives in MoltenTerm while it runs. A restart of MoltenTerm forgets the panel's state (not the mod, which
  lives in its folder): open the view again and re-send the plan and the draft.
