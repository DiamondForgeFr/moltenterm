# Releasing MoltenTerm

How a MoltenTerm build reaches people, and the checklist to walk before it does. The process is generic and works for
any standalone app: Mission Control runs it from the project's `.molten/project.json` (Project tab › Release, and
CI/CD › CD for the rehearsal), through the `molten release` commands (`pkg/molten/agentdocs/pipeline-format.md`,
"Generic release commands"). MoltenTerm is its first user. `UPSTREAM.md`, "Releases", has the details of each step.
Wave's `RELEASES.md` describes Wave's own process and does not apply.

## Who gets what

| Build | Made by | Who gets it | Identity |
| --- | --- | --- | --- |
| Dev | `task dev` | the developer, from the checkout | `moltenterm-dev` folders |
| Gold | Mission Control › Build local › Gold (`scripts/moltenterm-build-gold.sh`) | the developer's daily app, updated from the local builds folder (#64) | `fr.diamondforge.moltenterm.gold`, `moltenterm-gold` folders, signed "MoltenTerm Local" |
| Rehearsal | CI/CD › CD › Rehearse (`molten release rehearse`, `release.yml` dispatched) | nobody: 14-day artifacts of the run, to install and check | the release's |
| Release candidate `vX.Y.Z-N` | Release › Release candidate | whoever installs it from its GitHub prerelease; never the latest release | `fr.diamondforge.moltenterm`, `moltenterm` folders |
| Public `vX.Y.Z` | Release › Public | everyone, once the developer publishes its draft on GitHub | the same |

Nothing of this is published by an agent: the tag is pushed on the developer's confirmed click (finalize), and a
public release goes to people only when the developer publishes its draft on GitHub.

## The gold and releases on one Mac

The gold and a release can be installed and run side by side. The gold has its own bundle identifier, data and
configuration folders, and single-instance lock. A release never reads the gold's workspaces, and the gold never reads
the release's. The privacy grants given to one never replace the other's: macOS keeps one entry per bundle
identifier, and the gold's stays tied to its "MoltenTerm Local" certificate (#224). Their names and icons differ
(MoltenTerm, MoltenTerm Gold). Two things are shared:

- `~/Library/Caches/moltenterm`, which holds caches only;
- the durable job sockets under `/tmp/waveterm-<uid>`, which are keyed by job id.

Test a release on a **separate macOS user** anyway: it is the only way to see what a new user sees (first run,
onboarding, permission prompts). Never give Full Disk Access to a build whose bundle identifier is the gold's.

## Before the first release (once)

- `release.yml` is on `develop` and reaches `main` with the first promotion. GitHub already knows it, so the
  rehearsal can be dispatched from `develop` before that.
- macOS Developer ID signing and notarization (#507) come before the first public release. Until then, the builds are
  ad-hoc signed and the release text says how to open them.
- The milestone of the release is triaged: `molten release plan` lists its open issues. They are reported, never
  blocking.

## The steps

1. **Rehearse.** CI/CD › CD › "Rehearse the release build". It builds macOS (arm64, x64: dmg, zip) and Linux (x64,
   arm64: AppImage, deb) from `develop`, with no tag and no release, and downloads them into
   `~/Downloads/MoltenTerm-rehearsal/<short sha>/`. Walk the checklist below on these files.
2. **Release candidate.** Release › Release candidate:
   - promote (`develop` onto `main` once CI is green);
   - prepare (bump and notes in `../MoltenTerm-release`): review the notes;
   - finalize (confirm): `release.yml` builds and publishes the prerelease.

   Walk the checklist on the prerelease's files, then merge the sync-back pull request.
3. **Public release.** Release › Public: the same steps, then publish the draft on GitHub, close the milestone, and
   merge the sync-back.

A point that fails: open a ticket, fix it on `develop`, rehearse again, and cut the next candidate (`-N+1`). Never
re-tag a published candidate.

## The checklist

Walk it on every rehearsal and every release candidate, before cutting the next step. Note the build and the machines
on the ticket of the release.

### 0. The run

- [ ] The run is green: `release.yml` for a candidate, the rehearsal run for a rehearsal.
- [ ] Every file is there: 2 dmg, 2 zip, 2 AppImage, 2 deb, `latest-mac.yml`, `latest-linux.yml`,
      `latest-linux-arm64.yml` and `SHA256SUMS.txt`. `scripts/moltenterm-release-files.sh` refuses the run otherwise.
- [ ] `sha256sum --ignore-missing -c SHA256SUMS.txt` (`shasum -a 256 -c` on macOS) passes on the downloaded files.

### 1. macOS (arm64; x64 when an Intel Mac is at hand)

On a separate macOS user that never ran MoltenTerm:

- [ ] Open the `.dmg` and drag MoltenTerm to Applications. Until #507, the first open is refused: right-click › Open
      (or System Settings › Privacy & Security › Open Anyway). Afterwards, MoltenTerm opens normally.
- [ ] About MoltenTerm shows the version (the candidate's `X.Y.Z-N`, or `package.json`'s for a rehearsal) and the
      channel. The status bar badge shows the version.
- [ ] The version history (from the status bar badge or About) shows this version's notes (#187).
- [ ] The first run shows the onboarding; finish it.
- [ ] A terminal works: `wsh version` and `molten version` answer and name this build.
- [ ] An agent session (Claude Code or Codex) starts in a block. Its attention state shows in the tab and in Mission
      Control.
- [ ] A workspace with a durable session: run `sleep 600; echo done` in it, quit MoltenTerm, and reopen it. The
      session is still there and its output continues.
- [ ] Open a file under `~/Documents` from a terminal: macOS asks once for Files and Folders, and the prompt names
      MoltenTerm.
- [ ] Uninstall: quit, then move MoltenTerm.app to the Trash. Its folders stay
      (`~/Library/Application Support/moltenterm`, `~/.config/moltenterm`) and are reused by a reinstall.

### 2. Linux (x64; arm64 when an ARM machine is at hand)

On a machine or VM with a desktop session:

- [ ] AppImage: `chmod +x MoltenTerm-*.AppImage`, then run it. The same points as macOS, from the first run to the
      durable session.
- [ ] deb: `sudo apt install ./moltenterm-linux-*.deb` (dependencies resolve), then start it from the menu. The same
      points. Uninstall with `sudo apt remove moltenterm`.

### 3. Next to the gold (the developer's Mac)

- [ ] With MoltenTerm Gold open, start the release (from the other macOS user, or from this one for this check only).
      Both run at once: neither quits because of the other.
- [ ] The release starts on its own folders: no gold workspace or setting shows in it.
- [ ] Afterwards, the gold still has its Files and Folders and Full Disk Access grants (open a protected folder from
      a gold terminal).

### 4. Update notification (#188)

Needs two successive candidates, the earlier one installed:

- [ ] At start (and at most once a day), the earlier candidate shows "MoltenTerm X is available" with the notes and a
      download link to the release page. The link opens the right release.
- [ ] Turning the notification off in the settings stops it. A gold and a dev build never show it.

### 5. The release page

- [ ] The title, the notes (plain words, no ticket numbers) and the install text are right. A candidate is a
      prerelease and not the latest release; a public release waits as a draft until it is published.
