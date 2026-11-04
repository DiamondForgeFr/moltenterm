# Settling an agent's stop: tell the Integration panel a decision is made

An agent that stops to ask the developer for a decision ("stopped for a decision: Backend stays red, flaky test") shows
as waiting for them in MoltenTerm's Integration panel, in "Needs you", with an Answer button. The panel cannot read the
decision being made somewhere else: when the lead agent marked the pull requests ready, or fixed what was asked about,
or told the agent in another way, the card keeps saying the developer must answer. The developer then acts on a
question nobody asks any more, or stops trusting the panel.

When you decided it, say so. This holds for any agent CLI: the command names a ticket or a first name, nothing of your
own tooling.

## The command

```sh
molten agent decision settle <ticket|agent> [--note "<why>"] [--json]
```

- `<ticket>`: the ticket number the card shows (`1872` or `#1872`). It settles the stop of every agent of your project
  working on that ticket's branch (the folder's checked-out branch, by the project's branch naming).
- `<agent>`: an agent's first name (`molten agent list --active` lists them), without case or accents.
- `--note`: why, in one line, 200 characters at most. The Integration panel shows it as written beside your first name:
  "settled by Arthur: Backend is flaky, #1874 fixes it". Write it for the developer, in their language.
- Run it from a MoltenTerm terminal, in your own tab. Outside one it fails. Run from a plain shell with no agent it
  settles as the developer.

```sh
molten agent decision settle 1872 --note "Backend is flaky, #1874 fixes it: go on"
molten agent decision settle Julien --note "I marked the PR ready myself"
```

The output is in English and says whom it settled (`--json` gives `{"settled": [{"firstname": ...}], "by", "note"}`).

## What happens

- The card leaves "Needs you" for the section its pull request belongs to (Ready to merge, In progress...), the
  agent's line shows it idle, the sidebar and tab marks stop saying it waits for the developer, and its notification is
  resolved. The card keeps one muted line: "settled by Arthur: <note>".
- A settlement belongs to the stop it answers. If that agent works again, or stops for another reason, the developer is
  asked again.
- Replying to the agent also settles it: a `molten agent send` (or the `send_to_agent` tool) that is delivered and
  submitted to a waiting agent counts as its sender settling the stop, with the brief's goal as the note.
- A pull request found ready on GitHub settles nothing by itself: MoltenTerm cannot tell who marked it nor whether they
  read the question. Settle it explicitly.

## When it refuses

- Nothing waits on the target: `No agent on #1872 has a stop that waits for the developer: nothing to settle.`
- The agent is blocked on a prompt of its own terminal (a permission, a question it asked in its session): MoltenTerm
  does not hold that one, answer it in the agent's terminal or with `molten agent send`.
- You cannot settle your own stop: your lead or the developer does.
- No agent has that first name: the error lists the active ones.

Do not settle a question you did not decide. If the developer must choose, leave it: that is what the card is for.
