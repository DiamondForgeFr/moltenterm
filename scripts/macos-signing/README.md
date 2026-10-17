# macOS release signing

Developer ID signing and notarization of the macOS release (#507): the orchestration and its fixture tests (#878), wired
into `electron-builder.config.cjs` and `.github/workflows/release.yml` (#879). Fixture results are not proof of a
Developer ID release: genuine Apple acceptance and the clean-Mac checks stay open in #880 until the credentials exist.

The code targets the **locked electron-builder 26.17.0** and Electron 42 (#810). The manifest range `^26.15.3` is not
the installed version: production loading rejects any other builder version, because the blockmap adapter uses a
version-specific internal API. Do not copy configuration from the unversioned v27 documentation.

## Modes

`node scripts/macos-signing/package.mjs mode` prints the mode the release job takes:

| Signing inputs set | Mode           | Build                                                                                    |
| ------------------ | -------------- | ---------------------------------------------------------------------------------------- |
| none               | `adhoc`        | `task package … -c.mac.identity=-`, as before #507; the release text says how to open it |
| all seven          | `developer-id` | `package.mjs package`: signed, notarized, stapled and verified                           |
| some               | error          | the run fails before building: a partial set never falls back to ad hoc                  |

Without `MOLTENTERM_MACOS_SIGNING=developer-id`, which only `package.mjs` sets inside its session, the builder
configuration is exactly what it was: a local `task package` and the ad-hoc release are unchanged.

## Credential boundary

`withSigningSession` accepts these inputs only for the packaging step:

| Input                          | Required value                                                                                 |
| ------------------------------ | ---------------------------------------------------------------------------------------------- |
| `MACOS_CERTIFICATE_P12_BASE64` | Single-line base64 of an exported Developer ID Application identity, including its private key |
| `MACOS_CERTIFICATE_PASSWORD`   | Nonempty export password                                                                       |
| `MACOS_SIGNING_IDENTITY`       | Explicit 40-character SHA-1 fingerprint of that certificate                                    |
| `APPLE_TEAM_ID`                | Expected 10-character team identifier                                                          |
| `APPLE_API_KEY_BASE64`         | Single-line base64 of the App Store Connect team API private key (`.p8`)                       |
| `APPLE_API_KEY_ID`             | API key identifier                                                                             |
| `APPLE_API_ISSUER`             | Team API issuer UUID                                                                           |

The notarize 2.5 adapter requires an issuer, so individual API keys without an issuer are unsupported. No Apple ID or
password and no ambient keychain fallback is permitted. Input validation proves the container shape only; the imported
identity and Apple's certificate-chain requirement provide the actual checks.

The session creates a canonical, private temporary directory and a dedicated keychain with a random password, imports
only the expected identity, and restricts key access to Apple's signing tools. It passes `CSC_KEYCHAIN`, `CSC_NAME` (the
fingerprint) and the temporary `APPLE_API_KEY` path to packaging, removes raw certificate, password and key material
from the child environment, and deletes the `.p12` right after import. It never imports into or deletes the login
keychain. Cleanup removes only the owned keychain and files, and keeps the original keychain search list plus any
unrelated entry added during the session.

In `release.yml` the inputs are environment secrets of the protected `release` environment, reachable only by tag
builds; dependency installation and compilation run in earlier steps that never see them. A rehearsal gets no
environment, and the job fails if it ever sees a signing input. Nothing in this directory creates secrets,
environments, credentials or Apple accounts.

## Order of one Developer ID run

`packageRelease` (`package.mjs`):

1. Preflight: all seven inputs, only `-c.publish.provider|owner|repo` as extra builder arguments, no earlier macOS
   output in `make/` (`task clean` first), the expected artifact template.
2. `withSigningSession`: dedicated keychain, identity imported and checked.
3. electron-builder as an owned process (`runOwnedProcess`): `-p never`, both architectures, zip and dmg, with
   `MOLTENTERM_MACOS_SIGNING=developer-id`. The config then sets the explicit identity, hardened runtime,
   `forceCodeSigning`, notarization and the custom `mac.sign` hook (`builder-hooks.cjs`). The builder notarizes and
   staples each app before making its zip and dmg, and writes `latest-mac.yml` with the DMG hashes of that moment.
4. Once the builder has exited, `finalizeArtifacts`: both apps and every nested Mach-O verified (Developer ID chain,
   team, secure timestamp, runtime, safe entitlements, ticket, Gatekeeper); each DMG signed with a timestamp,
   notarized, stapled and assessed; its blockmap regenerated from the final bytes; every `*-mac.yml` rewritten.
5. Keychain cleanup, whatever happened.

The finalization cannot live in `afterAllArtifactBuild`: in the locked builder that hook runs before
`PublishManager.awaitTasks()` writes the update files, so it would find no `latest-mac.yml`, and the builder would then
write DMG hashes taken before notarization.

## Process and cleanup

The builder runs in a detached process group with ignored stdio. Only the fixed progress messages of `package.mjs` are
logged: raw command errors, builder debug output, argv and environment are never forwarded, because upstream
diagnostics can contain credentials. A failed Developer ID build therefore says only which stage failed; reproduce it
with the local fallback (RELEASE.md) to see the builder's own output.

Cancellation sends TERM to the owned process group, escalates to KILL after five seconds, and waits for both the parent
and the group to be gone before keychain cleanup. Persistent OS or probe errors, or a group that is never reaped, fail
after a further five seconds; packaging cannot continue, and the session still revokes and deletes its own credentials
best-effort. A process that escaped its group, an uninterruptible OS task or a hard-killed parent cannot be fully
handled by a JavaScript `finally`: use an ephemeral CI runner, and report a cleanup failure instead of claiming erasure.

## The sign hook

`builder-hooks.cjs` export `sign` wraps upstream `@electron/osx-sign`. It requires the session flag, `publish: never`,
the expected identity and keychain, hardened runtime, forced signing and notarization not disabled. The builder's
Electron file options are preserved. Only the recognized ELF and PE payloads of the embedded binary folder are left
unsigned (their bytes are hashed before signing and checked after); the five Darwin Go helpers get an empty entitlement
dictionary with hardened runtime; Electron keeps its entitlements. The upstream signer signs inside-out.

The required embedded inventory mirrors `Taskfile.yml`: one wavesrv; Darwin arm64/x64 wsh and molten; Linux
arm64/x64/mips/mips64 wsh; Windows arm64/x64 wsh; Linux arm64/x64 molten. All helpers live under
`Contents/Resources/app.asar.unpacked/dist/bin`. Apple also seals these paths as resources, so each executable is
signed before the app and never modified afterwards. An update must replace the whole signed app, not patch nested
helpers in place.

The builder's automatic notarization skips with a warning when credentials are absent, and forced signing alone does
not forbid an ad-hoc identity. The finalization therefore requires positive evidence rather than relying on those
defaults.

## Final bytes and update metadata

After a DMG is stapled, the real pinned builder `buildBlockMap(file, 'gzip', file + '.blockmap')` regenerates its
sidecar. Sidecar mode returns `sha512` and `size`, not an embedded `blockMapSize`. The finalizer checks them against the
final file and updates only the matching entries of each local `*-mac.yml`. ZIP order, unchanged ZIP hashes, release
fields and the legacy top-level ZIP fields are preserved; a legacy DMG hash is updated. Every channel must reference all
four artifacts; unknown URLs, traversal, duplicates, unsupported packages or embedded blockmaps and stale ZIP hashes
fail, and no channel file is written until all are valid.

`SHA256SUMS.txt` and its GPG signature are made later by the `publish` job from the uploaded, final files.

No signing or blockmap algorithm is reimplemented here: Apple's tools and the installed upstream packages sign,
notarize and build blockmaps; standard Node hashing only checks file integrity.

## Credential-free validation

From the repository root:

```sh
node --test scripts/macos-signing/*.node-test.mjs   # Node's test runner; the suffix keeps them out of vitest
```

The tests use deliberately invalid dummy key and certificate containers and injected command, process and builder
adapters: no real `security`, `codesign`, `spctl`, `notarytool`, Apple service or keychain is used. The adapter test
loads the real builder config, the real YAML library and the real blockmap generator on dummy bytes. `package.node-test.mjs`
checks the command order of a whole run (keychain session, builder, final verification and notarization, cleanup) and
its failure paths. These tests validate orchestration and rejection paths, not Apple acceptance. The pull-request run
of `release.yml` runs the tests that need no dependencies; the macOS job runs all of them before packaging.

## Remaining real validation (#880)

Keep #880 open until actual credentials exist. It requires Accepted submissions, validated app and DMG tickets, valid
nested signatures, Gatekeeper assessment, a downloaded app opening on a clean Mac without override, an offline launch,
the embedded CLI behaviour, and arm64 and x64 coverage. Check the extracted ZIP and the mounted DMG contents, not only
the intermediate app folder. Test permissions across two Developer ID releases with the same app, team and designated
requirement; continuity from the earlier ad-hoc or local self-signed builds is not promised.

Primary references: [Apple notarization requirements](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution),
[Apple distribution packaging](https://developer.apple.com/documentation/xcode/packaging-mac-software-for-distribution),
[Apple nested signing and identity](https://developer.apple.com/library/archive/technotes/tn2206/_index.html),
[builder v26 options](https://www.electron.build/v26/docs/mac/). The installed 26.17.0 `MacTargetHelper`, `macPackager`,
`dmg-builder`, blockmap and update-info sources define the exact integration contract.
