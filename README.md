<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="build/moltenterm/brand/svg/logo-dark.svg" />
    <img src="build/moltenterm/brand/svg/logo-light.svg" alt="MoltenTerm" width="420" />
  </picture>
</p>

<p align="center"><strong>The terminal that takes your shape.</strong></p>

MoltenTerm is an open-source terminal workspace (terminals, a built-in browser, dashboards) that you reshape by talking
to the AI coding agent you already use. Ask your agent for a panel, a layout or a dashboard card: it writes a mod,
MoltenTerm reloads, and the workspace has changed.

- **Bring your own agent.** MoltenTerm ships no model, needs no API key and proxies no tokens. Claude Code, Codex,
  Gemini CLI or any other CLI agent runs in it exactly as in any terminal.
- **Everything is reversible.** Every change is versioned and can be undone; safe mode always boots.
- **Open by design.** Open source code, an open mod format, and versions of MoltenTerm you can share.

The vision, principles, non-goals and roadmap are in [MANIFESTO.md](MANIFESTO.md).

## Status

MoltenTerm **1.0.0** is the first public release. It builds on **Wave Terminal v0.14.5** with its own identity, no
calls to services operated by the Wave project, and openly licensed assets. The mod system, the `molten` command and
Mission Control described in the manifesto are in the box; the community phase (a registry, permissions and signing,
an in-app gallery) comes later.

## Install

Release candidates and releases are on the [releases page](https://github.com/DiamondForgeFr/moltenterm/releases),
for macOS (Apple Silicon and Intel) and Linux (x64 and arm64, AppImage and .deb).

- **macOS 13 or later**: open the `.dmg` and drag MoltenTerm to Applications. The builds are not signed with an Apple Developer ID
  yet, so macOS refuses to open them the first time: right-click MoltenTerm in Applications and choose **Open**, or
  run `xattr -dr com.apple.quarantine /Applications/MoltenTerm.app`.
- **Linux**: make the `.AppImage` executable and run it, or install the `.deb` with `sudo apt install ./<file>.deb`.
  On **Ubuntu 23.10 and later, install the `.deb`**. The AppImage needs unprivileged user namespaces, which AppArmor
  restricts there, and an AppImage cannot carry the `chrome-sandbox` helper that the `.deb` installs with the
  permissions the sandbox needs: it may refuse to start.

`SHA256SUMS.txt` in each release lists the checksum of every file.

## Build from source

Requirements: Go ≥ 1.26.11, [Task](https://taskfile.dev) v3, Node.js 22 with npm 10, and the Xcode Command Line Tools
on macOS.

```bash
task init   # install dependencies
task dev    # run MoltenTerm in development mode
```

[UPSTREAM.md](UPSTREAM.md) documents the full toolchain, the other tasks and how Wave Terminal releases are merged.

## Privacy

MoltenTerm sends no usage data and has no account. [PRIVACY.md](PRIVACY.md) lists the only connections it makes, all
of them at your request. The built-in browser does not block ads or trackers yet: that is planned
([#426](https://github.com/DiamondForgeFr/moltenterm/issues/426)).

## Relationship with Wave Terminal

MoltenTerm is a fork of [Wave Terminal](https://github.com/wavetermdev/waveterm), created by Command Line Inc. and
released under the Apache License 2.0. MoltenTerm keeps Wave's history and merges its releases; every change made to
Wave's files is listed in [UPSTREAM.md](UPSTREAM.md). Many thanks to the Wave Terminal authors.

MoltenTerm is an independent project. It is not affiliated with, sponsored by or endorsed by Command Line Inc. or the
Wave Terminal project.

## Licence

MoltenTerm is **AGPL-3.0-only**; the files that come from Wave Terminal remain **Apache-2.0**. See [NOTICE](NOTICE)
for which parts are under which licence.

- [LICENSE](LICENSE): the GNU Affero General Public License, version 3, for MoltenTerm's own code. Anyone may
  use, change and share it, and nobody can ship a closed version of it.
- [LICENSE-APACHE](LICENSE-APACHE): the Apache License 2.0, for the files from Wave Terminal (patched ones included).
  Each source file says which one applies in its `SPDX-License-Identifier` header.
- [LICENSE-EXCEPTION](LICENSE-EXCEPTION): an additional permission (AGPL section 7). A mod or an agent part that uses
  only the public mod interface is not a covered work: its author licenses it as they wish, paid mods included.
- [TRADEMARKS.md](TRADEMARKS.md): the name and the logo are not licensed. A fork must rename itself and drop the logo.
- [CONTRIBUTING.md](CONTRIBUTING.md) and [CLA.md](CLA.md): how to contribute, and the agreement that lets DiamondForge
  offer its own paid services on top of the free core.

Releases published before this change were published under the Apache License 2.0 and keep it.

MoltenTerm bundles [Font Awesome Free](https://fontawesome.com) (icons CC BY 4.0, fonts SIL OFL 1.1, code MIT).
