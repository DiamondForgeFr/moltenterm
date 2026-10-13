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
- The release key exists, its public key is committed and its two secrets are set (below, "The release key"). Until
  then, releases are published unsigned and the run's log says so.

## The release key

Every release is signed with the DiamondForge release key (#576), the same GPG key as Notulia's Linux packages
(DiamondForgeFr/Notulia#1110): a company key, not a product key. `release.yml` signs `SHA256SUMS.txt` into
`SHA256SUMS.txt.asc` (`scripts/moltenterm-release-sign.sh`), so one signature covers every file, and adds a detached
`.asc` beside each AppImage and deb. Linux has no Gatekeeper or SmartScreen: this is provenance, not a condition to
open the app, and it prepares a future apt repository. The rehearsal signs too.

- **Fingerprint:** not created yet. Once it is, write it here, in `UPSTREAM.md` ("Releases") and on the website.
- **Public key:** `release-signing-key.asc` at the root of the repository.
- **Secrets:** `RELEASE_GPG_PRIVATE_KEY` (the armoured private key) and `RELEASE_GPG_PASSPHRASE`.

The switch is the committed public key together with the secrets, as in Notulia:

| Committed public key | Secrets | Result |
| --- | --- | --- |
| no | no | nothing is signed, the log says so, the release is published unsigned |
| yes | yes, the same key | every signature is made, verified against the committed key alone (`gpgv`), then published |
| one without the other, another key, or a wrong passphrase | | **the run fails** before anything is published |

The key is created by the developer, on their Mac, never by an agent or the CI.

### Create it (once, for every DiamondForge product)

If it was already created for Notulia, skip to "Set it": the same key signs both. Otherwise, in a throwaway GnuPG
folder so that it never enters the machine's keyring (a short path: gpg-agent's socket lives in it):

```bash
brew install gnupg
export GNUPGHOME="$(mktemp -d /tmp/release-key.XXXXXX)"
cd "$GNUPGHOME"
gpg --quick-generate-key "DiamondForge Releases <releases@diamondforge.fr>" ed25519 sign 5y
# asks for a passphrase: generate it in the password manager
gpg --armor --export-secret-keys > release-signing-private.asc   # asks for the passphrase again
gpg --armor --export > release-signing-key.asc
gpg --fingerprint
```

**Back up offline**, in the password manager: `release-signing-private.asc`, the passphrase, and the revocation
certificate GnuPG wrote in `$GNUPGHOME/openpgp-revocs.d/`. The private key never goes into a repository.

### Set it

From the same folder:

```bash
gh secret set RELEASE_GPG_PRIVATE_KEY --repo DiamondForgeFr/moltenterm < release-signing-private.asc
gh secret set RELEASE_GPG_PASSPHRASE --repo DiamondForgeFr/moltenterm   # asks for the value, keeps it out of the history
gh secret list --repo DiamondForgeFr/moltenterm                        # both appear
cp release-signing-key.asc <checkout>/release-signing-key.asc            # then commit it on a ticket branch, with its PR
```

Write the fingerprint above in the same pull request, then move `$GNUPGHOME` to the trash. The secrets and the public
key arrive **together**: a release or a rehearsal run with only one of them fails, on purpose. Run a rehearsal once
the pull request is merged: its summary names the fingerprint.

### Extend, rotate, revoke

- **Expiry** (five years): before it, import the backup in a throwaway `GNUPGHOME`, run
  `gpg --quick-set-expire <fingerprint> 5y`, export both files again, set `RELEASE_GPG_PRIVATE_KEY` again and commit
  the new `release-signing-key.asc`. The fingerprint does not change. An expired key fails the run.
- **Rotation**: create a new key as above, then replace the two secrets and the committed public key in one pull
  request, and publish the new fingerprint. Older releases stay verifiable with the old public key: keep its
  fingerprint listed here as retired.
- **Compromise**: import the revocation certificate (`gpg --import <fingerprint>.rev`, once the colon GnuPG puts
  before its `-----BEGIN` line is removed), export the revoked public key, publish it in place of the old one with a
  new key, and say so in the next release notes.

### What a user does

```bash
curl -fsSL https://raw.githubusercontent.com/DiamondForgeFr/moltenterm/main/release-signing-key.asc | gpg --import
gpg --verify SHA256SUMS.txt.asc SHA256SUMS.txt   # names the fingerprint above
sha256sum --ignore-missing -c SHA256SUMS.txt     # shasum -a 256 --ignore-missing -c on macOS
```

The release text carries these commands, with the fingerprint once the release is signed.

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
- [ ] Once the release key exists: `SHA256SUMS.txt.asc` and a `.asc` per AppImage and deb are there, and
      `gpg --verify SHA256SUMS.txt.asc SHA256SUMS.txt` says "Good signature" and names the fingerprint of "The release
      key". Before it exists, the run's log says the release is unsigned.

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

- [ ] The title, the notes (plain words, no ticket numbers), the install text and the Verify section (its
      fingerprint once the release is signed) are right. A candidate is a
      prerelease and not the latest release; a public release waits as a draft until it is published.
