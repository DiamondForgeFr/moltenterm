# Acknowledgements

MoltenTerm stands on a lot of open-source work. This file names what it builds on and where each licence is. The
legal notices are in [NOTICE](NOTICE); this page is the thank-you.

## Wave Terminal

MoltenTerm is a fork of [Wave Terminal](https://github.com/wavetermdev/waveterm), created by Command Line Inc. and
released under the Apache License 2.0. The files that come from Wave keep that licence
([LICENSE-APACHE](LICENSE-APACHE)), and every change made to them is listed in [UPSTREAM.md](UPSTREAM.md). Many thanks
to the Wave Terminal authors. MoltenTerm is an independent project, not affiliated with, sponsored by or endorsed by
Command Line Inc.

## Fonts and icons

The fonts in `public/fonts/` each have their licence text beside them:

- IBM Plex Sans, by IBM Corp. (SIL Open Font License 1.1)
- Inter, by The Inter Project Authors (SIL Open Font License 1.1)
- JetBrains Mono, by The JetBrains Mono Project Authors (SIL Open Font License 1.1)
- Hack, by the Source Foundry Authors (MIT License), built on Bitstream Vera Sans Mono (Bitstream Vera License), and
  patched into Hack Nerd Font Mono by the Nerd Fonts project (MIT License)

Font Awesome Free, by Fonticons, Inc., supplies the icons (its licences are in `public/fontawesome-free/LICENSE.txt`).

## Other dependencies

MoltenTerm is built with Electron (and so Chromium), React, Go and many npm packages and Go modules, each under its own
licence. The complete list is in `package-lock.json` and `go.sum`. A third-party notices file generated from what
really ships, with every licence text, comes with
[#2126](https://github.com/DiamondForgeFr/moltenterm/issues/2126); until it lands, this page does not replace it.

`@diamondforge/character` is DiamondForge's own private package, not under any open-source licence (see
[NOTICE](NOTICE)).
