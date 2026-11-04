# Contributing to MoltenTerm

MoltenTerm is an opinionated project with a small team. Contributions are welcome, but **alignment matters more than
volume**. This page helps you decide whether and how to contribute in a way that is likely to be accepted, and says
what you agree to when you do.

MoltenTerm is a soft fork of [Wave Terminal](https://github.com/wavetermdev/waveterm). The vision and the non-goals are
in [MANIFESTO.md](MANIFESTO.md); how the fork works and how Wave's releases are merged is in
[UPSTREAM.md](UPSTREAM.md). A bug that is Wave's own, and not MoltenTerm's, is best sent to Wave too.

## High-level expectations

- MoltenTerm has a strong product direction and centralized ownership.
- Review bandwidth is limited.
- Not all contributions can or will be accepted, even if they are technically correct.

## What makes a great contribution

The most likely to be accepted:

- **Bug fixes**, especially with clear reproduction steps.
- **Documentation improvements**: typos, clarifications, examples.
- **Translations** of the interface (see "Interface languages" in `.kilocode/rules/rules.md`).
- **Discussed features**, after alignment in an issue.
- **Small, focused changes** that are easy to review and low risk.

If your change is small and obvious (a typo, a narrowly scoped bug fix, a small docs improvement), open a pull request
directly.

## Keep changes focused

**Only change what is necessary to accomplish your stated goal.** If you fix a bug in `file.ts`, do not reformat other
files, clean up unrelated code, or combine unrelated fixes. **One pull request, one logical change.**

## Discuss first (required for larger changes)

Open an issue at <https://github.com/DiamondForgeFr/moltenterm/issues> and wait for an answer before you open a pull
request for: new features, UI or UX changes, changes to a default, refactors, performance rewrites, architecture
changes, or anything that touches many files or systems. Larger pull requests without a prior discussion are closed
without a detailed review.

## What this project is not

- It is not a "first open source contribution" project, and it does not curate beginner issues.
- Mechanical refactors, broad style changes and drive-by rewrites are not helpful.
- AI-assisted contributions are welcome, but the pull request must show that you understand the context, the existing
  patterns and the direction. Low-effort or poorly supervised changes are closed.

## Licenses of what you contribute

- **New files** are MoltenTerm's own code: AGPL-3.0-only. Start a source file with
  `// Copyright 2026, <your name or DiamondForge>` and `// SPDX-License-Identifier: AGPL-3.0-only`
  (in the comment syntax of the language).
- **Changes to a file that comes from Wave Terminal** stay under Apache-2.0: keep its header as it is, mark your
  change with `MOLTENTERM-PATCH` and add a row to the patch ledger in [UPSTREAM.md](UPSTREAM.md).
- `node scripts/moltenterm-check-license.mjs` checks the headers, and `node scripts/moltenterm-check-ledger.mjs` the
  ledger. CI runs both.
- **Mods and agent parts** that use only the public mod interface are yours, under the terms you choose
  ([LICENSE-EXCEPTION](LICENSE-EXCEPTION)). They are not Contributions unless you submit them to this repository.
- Do not copy code you are not allowed to relicense. Say in your pull request where third-party material comes from
  and under which license.

See [NOTICE](NOTICE) for the whole picture, and [TRADEMARKS.md](TRADEMARKS.md) for the name and the logo.

## Contributor License Agreement (CLA)

Every contribution needs a signed CLA ([CLA.md](CLA.md)). **You keep the copyright of your contribution.** The CLA
gives DiamondForge a license to use it, including the right to relicense it, so that DiamondForge can offer its own paid
services on top of the free core while the core stays AGPL-3.0. The CLA also commits DiamondForge to keep your
contribution available in the public repository under an open source license.

To sign, add your entry to the list in [`.github/cla/cla.json`](.github/cla/cla.json) in your first pull request:

```json
{ "login": "your-github-login", "name": "Your Name", "date": "2026-11-05", "version": "1.0" }
```

The entry is your signature: it means "I have read CLA.md, version 1.0, and I agree to it" (for your employer too, if
you contribute on its behalf and are authorized to). Your `login` must be the GitHub account that opens the pull
request, and every author of its commits must have signed, in their own pull request if they did not. If your employer
has rights in your work, make sure it agrees before you sign.

The `CLA` check on the pull request reads that file. **A signed CLA is required before a pull request can be merged.**
Bots such as Dependabot and the maintainers listed in the file's `exempt` list do not need to sign.

## Style guide

American English. Follow the existing formatting and conventions: `gofmt`, `prettier` (4 spaces), the rules in
[`.kilocode/rules/rules.md`](.kilocode/rules/rules.md). Every user-facing string goes through an i18n key, in
`en.json` and `fr.json`.

## Development setup

See [README.md](README.md) and [UPSTREAM.md](UPSTREAM.md) ("Toolchain"), and [BUILD.md](BUILD.md) for the Wave build
notes. The checks before a pull request: `task check:ts`, `npx vitest run`, `go test ./cmd/... ./pkg/...`,
`node scripts/moltenterm-check-ledger.mjs`, `node scripts/moltenterm-check-license.mjs`.

## Code of Conduct

All contributors are expected to follow the project's [Code of Conduct](CODE_OF_CONDUCT.md).

---

Thank you for your interest in MoltenTerm. Clear expectations help keep the project moving.
