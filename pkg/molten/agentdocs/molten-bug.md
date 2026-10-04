# molten-bug: report a MoltenTerm bug to its developers

The user is reporting a problem with MoltenTerm, the terminal you run in:

{{REQUEST}}

You turn it into a report on MoltenTerm's issue tracker, so the developers can fix it. You search the existing issues
first: a bug already reported gets the user's case added to it, a bug already fixed gets the user an update instead of
a new report. Nothing is filed without the user's approval.

## Steps

1. Check that you run inside MoltenTerm: `molten help` must work. If `molten` is not found, tell the user to run
   this request from a MoltenTerm terminal, and stop.
2. Make sure it is a MoltenTerm bug, not the user's project, their shell or another tool: ask what they did, what
   they saw and what they expected when it is not clear. A request for a new feature is not a bug: suggest
   `/molten-feature` instead.
3. Search: `molten bug search <a few words> --json`, then again with other words when nothing matches. Each match
   says what to do (`advice`):
   - `comment`: the bug is open. Prepare `molten bug comment <issue> --what "<the user's case>"` instead of a new
     report.
   - `update`: it was fixed after the user's build. Tell the user to update MoltenTerm, and stop.
   - `regression`: it was fixed before this build and is back. Report it with `--regression <issue>`.
   - `not-planned`: the developers chose not to change it. Tell the user, and stop unless their case differs.
4. Prepare the report (nothing is filed yet):
   `molten bug report --title "<the bug in one line>" --what "<what happened>" --expected "<what should have
   happened>" --steps "<1. … 2. …>"`. Keep to facts the user gave or you saw; never invent steps. Include the exact
   error text when there is one. MoltenTerm adds its version, build, OS and architecture, and removes tokens, keys,
   passwords, e-mail addresses and home paths; still leave out anything private from the user's project.
5. Show the user what will be filed (the repository, title and body the command printed) and ask whether to file it.
6. Only once the user approved, run the same command again with `--yes`.
   - If it answers that an open issue already looks the same, read that issue: if it is the same bug, run
     `molten bug comment <issue> --what "…" --yes` (after the user approved that comment); if it differs, tell the
     user why and file with `--new --yes`.
   - Without a GitHub login, the prepared issue opens in the browser: tell the user to check it and submit it there.
7. Report: give the user the link to the issue or the comment, or what to do next (update MoltenTerm, submit the page
   in the browser).

## Rules

- Never pass `--yes` before the user said yes to that exact report or comment.
- One bug per report.
- Read `molten bug` output with `--json`.
- When you notice MoltenTerm itself misbehave while working on something else (a `molten` command failing in a way
  that is not the user's mistake, a crash, a wrong display), say so and offer to report it; never report it on your
  own.
