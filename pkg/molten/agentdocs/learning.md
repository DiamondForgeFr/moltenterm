# Learning: what a guided workflow remembers of the developer

A guided workflow is a multi-step flow MoltenTerm opens in its own view: the pipeline setup, the mod design that
`/morph` opens, and the flows to come. It learns from the developer: the answers they give, the steps they always skip,
the proposals they correct and the options they prefer are remembered on this computer, so the next run asks less.
What was learned is listed in plain words in Settings, "What MoltenTerm learned", where the developer edits, forgets
and resets it. You read the same memory and feed it through `molten learn`, whichever agent CLI you are.

## When you start a guided workflow: read the defaults

```sh
molten learn defaults pipeline-setup          # the answers to prefill, the steps to fold
molten learn defaults morph-design --json     # {"workflow", "prefill": [item], "folded": [item]}
```

The workflows that learn are `pipeline-setup` and `morph-design`. Any other name fails and the error lists them.

- **Prefill** lists the answers, corrections and preferences the developer gave in earlier runs: `key = value`, with how
  many times it was seen. Start from those values instead of the workflow's own proposal, and say they come from the
  developer's earlier choices ("based on your earlier choices"). The developer can change each one; a value they
  already gave in this run always wins.
- **Fold** lists the steps the developer skipped in the last runs in a row. Show them folded, with a way to open them:
  never remove a step, never skip it for them.
- With nothing learned, the command says so and you start from the workflow's proposals.

## While the workflow runs: record what the developer adjusts

```sh
molten learn record pipeline-setup --correction merge=squash --proposed merge --run my-project
molten learn record pipeline-setup --preference tagprefix=rel-
molten learn record morph-design --answer audience=team
molten learn record morph-design --skip icon
molten learn record morph-design --done icon          # they did the step this time: no longer skipped
```

Give exactly one of:

| Flag | Records |
| --- | --- |
| `--answer key=value` | an answer the developer gave to a question |
| `--preference key=value` | an option the developer prefers among several |
| `--correction key=value` | a proposal the developer changed; `--proposed value` says what the workflow proposed |
| `--skip step` | a step the developer skipped in this run |
| `--done step` | a step the developer did in this run; it clears an earlier `--skip` |

`--run label` names the run that adjusted (a project name, a mod name), shown as the source in the list. Recording the
same value again counts one more sighting; another value replaces it and starts again at one. A step skipped in two runs
in a row is folded.

**Record only what the developer decided in this workflow.** Never record something you guessed, something read from
the project's files, history or terminals, a secret, a token, a path of the project or a file's content: a value that
looks like a credential is refused. Keys are 1 to 64 characters among `a-z`, `0-9`, `.`, `_` and `-`; a value is one line
of at most 200 characters; a workflow keeps its 200 most recent items. Use the same keys the workflow's view uses, so
the view and you share one memory: `molten learn list <workflow>` shows the keys already in use.

### The keys the views use

| Workflow | Keys | Kind | Meaning |
| --- | --- | --- | --- |
| `pipeline-setup` | `merge`, `rcformat`, `tagprefix`, `notes`, `milestone`, `syncback` | `correction` | the choices of the description step the developer changed from the proposal (values are the option ids the step shows, `true` or `false` for a switch, the prefix itself) |
| `morph-design` | the key of each question asked in the design panel (`audience`, `refresh`…); `name`, `icon`, `category` | `answer` | what the developer picked or said (the label, or the Font Awesome name of an icon); `molten morph design answer` records it for you |
| `morph-design` | `need`, `questions`, `plan`, `preview`, `adjust`, `finish`, `validate`, `collect` | `skip` | a step of the design the developer skipped (folded after two runs in a row) |

## Read and forget

```sh
molten learn list                     # every workflow: id, value, seen N times, who recorded it
molten learn list pipeline-setup --json
molten learn forget pipeline-setup correction:merge   # the id as `list` prints it
```

When the developer asks you to forget something, forget it with `molten learn forget`. You cannot change a value nor
reset a whole workflow: the developer does that in Settings, "What MoltenTerm learned".

## Good to know

- Everything stays on this computer, in MoltenTerm's data folder. Nothing is sent anywhere, and a workflow never reads
  another workflow's items.
- The output is English, one item per line, or JSON with `--json`. Exit codes: 2 for bad usage, 1 for any other failure.
- The command works in a MoltenTerm terminal of this computer only; run outside one, it fails with a message saying so.
- The panel of a workflow reads the same memory, so what you record appears there, and what the developer changes there
  is what `molten learn defaults` gives you next.
