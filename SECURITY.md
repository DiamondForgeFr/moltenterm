# Security policy

## Report a vulnerability

Report it privately, through GitHub's private vulnerability reporting:

1. Open the [Security tab of the MoltenTerm repository](https://github.com/DiamondForgeFr/moltenterm/security).
2. Choose **Report a vulnerability** and fill in the form.

**Please do not report a vulnerability in a public issue, pull request or discussion.** Those are visible to everyone
before a fix exists.

A useful report says which MoltenTerm version it concerns (About MoltenTerm shows it), on which system, how to
reproduce the problem, and what an attacker could do with it.

## Supported versions

Security fixes go into:

- the latest public release;
- the latest release candidate, while the next public release is being prepared.

Older versions are not patched: update to the latest release. MoltenTerm tells you when one is available.

## What to expect

- We read every report and acknowledge it within 7 days.
- We tell you whether we consider it a vulnerability, and keep you posted at least every 30 days until it is fixed.
- A confirmed vulnerability is fixed in the next release (a release candidate first when the fix cannot wait). Its
  advisory is published on GitHub once the fix ships, crediting you unless you prefer not to be named.
- Please give us time to fix it before you disclose it publicly. We do not run a bug bounty.

## Scope

In scope: the MoltenTerm app and its helper programs (`wavesrv`, `wsh`, `molten`), its mod interface, and the files
published on the [releases page](https://github.com/DiamondForgeFr/moltenterm/releases). Each release lists a
`SHA256SUMS.txt`, signed with the DiamondForge release key ([release-signing-key.asc](release-signing-key.asc)).

MoltenTerm is a fork of [Wave Terminal](https://github.com/wavetermdev/waveterm) and still contains much of its code.
A vulnerability in that code is in scope here too. If you found it in Wave Terminal itself, tell us as well: we
check whether MoltenTerm is affected.

Out of scope: the coding agents you run inside MoltenTerm (Claude Code, Codex, Gemini CLI and others) and the services
they connect to, which are reported to their own vendors.
