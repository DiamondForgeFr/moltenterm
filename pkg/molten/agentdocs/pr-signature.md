# Signing your work: commits and pull requests

Coding agents commit and open pull requests with the developer's GitHub account, so GitHub cannot tell which agent did
the work. MoltenTerm gives each agent session a first name and knows its CLI, its model and its effort level; you sign
your work with them, so the signature stays with the work outside MoltenTerm too. MoltenTerm's Control room shows it
on each pull request.

## Who you are

```sh
molten agent whoami            # Valentin · Claude Code · Opus 5.5 · medium, then each part
molten agent whoami --json     # {"firstname", "agent", "model", "effort", "line", "trailer", ...}
molten agent whoami --trailer  # Molten-Agent: Valentin (Claude Code, Opus 5.5, medium)
```

The model and effort are the ones your agent last reported to MoltenTerm (Claude Code's status line, Codex's last
turn). A part MoltenTerm does not know is left out. Outside a MoltenTerm terminal, or before MoltenTerm saw your agent,
the command fails: then you have no signature. Never write one by hand or guess one.

## Each commit: a trailer

Add the trailer to every commit you make, next to the project's own trailers (`Co-Authored-By`...):

```sh
git commit -m "feat(#12): ..." --trailer "$(molten agent whoami --trailer)"
```

When the command fails, commit without it.

MoltenTerm does not add the trailer itself through a git hook: git has one hooks folder per repository
(`core.hooksPath`), so a MoltenTerm hook would replace or shadow the project's own hooks (husky, lefthook, the
workflow's guards) and change commits the developer makes by hand.

## Each pull request: the signature block

After opening a pull request, and after each later round of work you push to it:

```sh
molten agent sign-pr 123
```

It writes a block at the end of the PR body (above a final "Generated with" line), through your `gh`:

```
<!-- molten:agents -->
---
Made by Valentin · Claude Code · Opus 5.5 · medium
Earlier: Jérôme · Codex · gpt-5.5-codex · high
Reviewed by Anthony · 2026-10-16 · [review](...)
<!-- /molten:agents -->
```

"Made by" is the last agent who worked on the PR; "Earlier" lists the others, newest first, each once. Keep the
markers when you rewrite the body yourself, or run `molten agent sign-pr` again after.

## The reviewer

When the developer validates (merges) a PR from MoltenTerm's Review tab, MoltenTerm writes "Reviewed by <first name> ·
<date>" in the block, with a link to the review MoltenTerm published when there is one. The first name is the
`review:reviewername` setting, else the first word of the project's `git config user.name`.

This is a line in the body, not a GitHub approval: GitHub does not let the author of a PR approve it, and the PR's
author is the developer's own account. Do not try to approve, request reviews or write a "Reviewed by" line yourself.

## How MoltenTerm reads it

The Control room shows, on each card, the last agent: the newest commit's `Molten-Agent` trailer, else the "Made by"
line of the body, else "unknown agent". Hovering it lists every agent found in the commits and the block.
