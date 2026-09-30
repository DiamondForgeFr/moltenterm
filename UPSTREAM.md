# Upstream: Wave Terminal

Moltenterm is a soft fork of [Wave Terminal](https://github.com/wavetermdev/waveterm) (Apache-2.0, Command Line Inc.).
This file explains how the fork is built, how Wave releases are merged, and every place where Moltenterm changes Wave's
code.

## Current base

| Wave release | Commit    | Merged by                         |
| ------------ | --------- | --------------------------------- |
| v0.14.5      | `97e5600` | #3 (merge commit `b20f802`)       |

## Toolchain

- Go ≥ 1.25.6 (the `go` directive of the merged release), Task v3, Node 22 with npm 10.9.2, and Zig for the CGO builds
  on Linux and Windows. On macOS, the Xcode Command Line Tools are also required.
- macOS setup: `brew install go go-task`, Node 22 through nvm or Homebrew.

| Command                             | What it does                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------------- |
| `task init`                         | Install the npm dependencies (app and docs site) and tidy the Go modules. Run once, then after dependency changes. |
| `task dev`                          | Run the app through the Vite dev server (renderer hot reload). Uses `waveterm-dev` directories. |
| `task start`                        | Run the app without the dev server.                                                   |
| `task package`                      | Build a distributable for the current platform into `make/`.                          |
| `task check:ts`                     | Type-check the frontend and Electron code.                                            |
| `npx vitest run`                    | Frontend unit tests.                                                                  |
| `go test ./cmd/... ./pkg/...`       | Backend tests.                                                                        |
| `task generate`                     | Regenerate TypeScript bindings after changing Go RPC types.                           |

## Remotes, once per clone

```bash
git remote add upstream https://github.com/wavetermdev/waveterm.git
git config remote.upstream.tagOpt --no-tags          # never fetch Wave's tags
git remote set-url --push upstream NO_PUSH_TO_UPSTREAM
git config rerere.enabled true                       # replay conflict resolutions
gh repo set-default DiamondForgeFr/moltenterm
```

`gh` resolves a remote named `upstream` before `origin`. Without `gh repo set-default`, ticket and pull request commands
(including the SaaSFoundryAI workflow scripts) silently target Wave's repository.

## Merging a Wave release

1. Open a ticket and a branch `feature/<N>-merge-wave-<version>` from `develop`.
2. Resolve the release commit: `git ls-remote --tags upstream refs/tags/<version>`, then `git fetch upstream main` (or
   `git fetch upstream <sha>` if the release is not on `main`).
3. `git merge --no-ff <sha>` and resolve conflicts with the policy below.
4. Check that no Wave automation came back: `git diff --name-status <sha> HEAD -- .github CNAME` must list only
   Moltenterm's own files. Delete any new Wave workflow, Dependabot or funding file.
5. Validate: `task init`, `node scripts/moltenterm-check-icons.mjs` (Wave targets Font Awesome Pro: any new Pro-only
   icon must get an alias in `public/moltenterm-icons.css`), `task check:ts`, `npx vitest run`,
   `go test ./cmd/... ./pkg/...`, then `task dev`.
6. Update the "Current base" table and the patch ledger.
7. Open the pull request to `develop` and merge it with a **merge commit**. Never squash or rebase: both drop Wave's
   history and make every later merge a conflict.

Never push Wave's tags: `git push` without `--tags`, and `tagOpt` keeps them out of the local repository.

## Files Moltenterm owns

| Path | Policy when merging |
| --- | --- |
| `CLAUDE.md` | Keep ours. Re-sync its "Codebase conventions (upstream Wave)" section with upstream's `CLAUDE.md`. |
| `.gitignore` | Union of both, but never ignore `.claude` (it holds the SaaSFoundryAI harness). |
| `.github/` | Keep ours. Delete any new upstream workflow, `dependabot.yml` or `FUNDING.yml`. |
| `CNAME` | Stays deleted: it points to Wave's documentation domain. |
| `README.md`, `NOTICE` | Keep ours. `NOTICE` must keep Wave Terminal's notice line. `README.ko.md` and `README.zh-TW.md` stay deleted. |
| `public/fontawesome/`, `docs/static/fontawesome/` | Stay deleted: Font Awesome Pro is not redistributable. If Wave adds or updates Pro files, delete them again and extend `public/moltenterm-icons.css`. |
| `LICENSE` | Upstream's file (Apache-2.0). |
| `.claude/`, `.agents/`, `.saasfoundry.json`, `AGENTS.md`, `GEMINI.md`, `MANIFESTO.md`, `UPSTREAM.md` | Moltenterm only; no upstream counterpart. |

## Identity and rename procedure

Moltenterm's identity lives in a few places, so renaming the product is a short, mechanical change:

1. `frontend/util/moltenterm-identity.ts`: product names, window title, tagline, repository URL, directory base name and
   the `MOLTENTERM_*` override variables.
2. `pkg/wavebase/moltenterm_identity.go`: directory base name and repository URL for Go.
3. `package.json`: `name`, `productName`, `description`, `homepage`, `build.appId` (then `npm install
   --package-lock-only`).
4. `build/moltenterm/`: `icon.svg` (source), `icon.png`, `icon.icns`, `deb-postinstall.tpl`; `public/logos/moltenterm-logo.png`;
   `frontend/app/asset/logo.svg`.

Everything else (directories, lock, socket, menus, About panel, permission prompts) derives from these. Changing
`build.appId` or the directory name makes the OS treat the result as a new application, with fresh settings and data.

## Patch ledger

Every change to a Wave file is listed here and, where the format allows comments, marked with `MOLTENTERM-PATCH` in the
file. Code that lives in new files is not listed.

`node scripts/moltenterm-check-ledger.mjs` enforces this against the release in "Current base". It fails when a
modified, deleted or retyped Wave file matches no entry here or in "Files Moltenterm owns", when an entry here matches no
changed Wave file, or when a modified Wave file in a format that accepts comments (`.ts`, `.tsx`, `.js`, `.cjs`, `.mjs`,
`.go`, `.yml`, `.yaml`, `.html`, `.css`, `.scss`, `.svg`, `.sh`) has no `MOLTENTERM-PATCH` marker; files Moltenterm owns
need no marker. It reads only the backticked tokens of the first column: each is a full path, a directory ending in
`/`, or a glob whose `*` stays within one path segment.

| Wave file | Change | Why | Ticket |
| --- | --- | --- | --- |
| `.gitignore` | Drops the `.claude` rule; ignores `.claude/settings.local.json` and `.env*.local` | The harness lives in `.claude/` and must stay tracked | #3 |
| `CLAUDE.md` | Replaced by the harness instructions, which import Wave's rules | One entry point for agents | #3 |
| `.github/workflows/*` (9 files), `.github/dependabot.yml`, `.github/FUNDING.yml`, `CNAME` | Deleted | They would build, publish, open pull requests or redirect on Moltenterm's repository | #3 |
| `pkg/wcloud/wcloud.go` | Endpoints always empty; dev mode no longer requires `WCLOUD_*` | Telemetry, no-telemetry and ping stop before any connection | #5 |
| `pkg/telemetry/telemetry.go` | `IsTelemetryEnabled` always false | Telemetry is never uploaded | #5 |
| `pkg/wconfig/settingsconfig.go` | `ReadFullConfig` forces `telemetry:enabled` off | A user setting cannot turn telemetry on; frontend and backend agree | #5 |
| `pkg/aiusechat/uctypes/uctypes.go` | `DefaultAIEndpoint` empty | "wave" AI modes can never reach Wave's cloud proxy | #5 |
| `pkg/aiusechat/usechat.go` | Error message for cloud modes | Points to user-defined providers instead of "enable telemetry" | #5 |
| `pkg/wconfig/defaultconfig/settings.json` | Telemetry, auto-update and cloud modes off; no `waveai:defaultmode` | Defaults match the product (JSON, no marker) | #5 |
| `pkg/wconfig/defaultconfig/waveai.json` | Emptied | No Wave cloud AI modes (JSON, no marker) | #5 |
| `pkg/wconfig/defaultconfig/presets/ai.json` | `ai@wave` removed | No Wave proxy preset (JSON, no marker) | #5 |
| `emain/updater.ts` | Updater never configured (`MoltentermUpdateFeedEnabled`) | No update check against Wave's feed | #5 |
| `emain/emain-menu.ts` | "Check for Updates" removed | It polled Wave's feed even with auto-update off | #5 |
| `electron-builder.config.cjs` | `publish: null` | No update feed in packaged builds | #5 |
| `frontend/app/aipanel/aipanel.tsx` | Access depends on user-defined modes; "bring your own AI" screen | No telemetry gate, no Wave cloud modes | #5 |
| `frontend/app/aipanel/waveai-model.tsx` | Default to the user's first mode | Instead of "unknown" when no default is set | #5 |
| `frontend/app/onboarding/onboarding.tsx` | Telemetry toggle, opt-out page and AI panel auto-open removed | Moltenterm sends no usage data | #5 |
| `frontend/app/workspace/widgets.tsx` | "Help" item removed | It opened Wave's online docs | #5 |
| `Taskfile.yml` | No `WCLOUD_*` or `WAVETERM_ENVFILE` in dev tasks | No Wave dev cloud; the SRS token in `.env` stays out of the app | #5 |
| `package.json`, `package-lock.json` | Name, product name, description, homepage, author, `build.appId: fr.diamondforge.moltenterm` (JSON, no marker) | Moltenterm is its own application | #4 |
| `emain/emain-platform.ts` | Directory and app names from `frontend/util/moltenterm-identity.ts`; user overrides read from `MOLTENTERM_*`; Electron `userData` moved to `<data>/electron` | Separate directories, lock and socket from Wave | #4 |
| `pkg/wavebase/wavebase.go` | Cache directory from `MoltentermDirName` | Never Wave's cache | #4 |
| `electron-builder.config.cjs` | Icons from `build/moltenterm/`, deb script path, permission prompts from the product name | Packaged builds carry Moltenterm's identity | #4 |
| `frontend/wave.ts`, `index.html` | Window title | Moltenterm, not Wave Terminal | #4 |
| `emain/emain-menu.ts` | "About Moltenterm" | Moltenterm's menu | #4 |
| `frontend/app/modals/modalregistry.tsx` | Registers `moltenterm-about.tsx` as "AboutModal" | Moltenterm's About panel | #4 |
| `frontend/app/asset/logo.svg` | Moltenterm mark | Used by About and onboarding | #4 |
| `emain/emain-window.ts`, `emain/emain-builder.ts` | Linux window icon `public/logos/moltenterm-logo.png` | Moltenterm's icon | #4 |
| `pkg/wcore/layout.go`, `pkg/wconfig/defaultconfig/settings.json` | Starter web block and default web URL point to the Moltenterm repository | No Wave page on first run | #4 |
| `Taskfile.yml` | Dev helper tasks target `moltenterm-dev` directories | `dev:cleardata` and friends must not touch Wave's directories | #4 |
| `public/fontawesome/` (11 files), `docs/static/fontawesome/` (5 files) | Deleted; replaced by `public/fontawesome-free/` and `public/moltenterm-icons.css` (new files) | Font Awesome Pro is not redistributable | #6 |
| `index.html`, `frontend/preview/index.html`, `docs/docusaurus.config.ts` | Load Font Awesome Free and the compatibility layer; preview page title and icon | Same | #6 |
| `frontend/app/asset/dots-anim-4.svg` | Original animation | The previous file was a Nucleo icon (commercial licence) | #6 |
| `README.md`, `NOTICE` (Moltenterm-owned); `README.ko.md`, `README.zh-TW.md` deleted | Moltenterm README, NOTICE with Wave's line kept | Attribution and non-affiliation | #6 |
| `frontend/app/onboarding/onboarding.tsx` | Welcome, GitHub row point to Moltenterm; Discord row removed | Moltenterm is not presented as Wave | #6 |
| `frontend/app/workspace/widgets.tsx` | "Release Notes" item removed; dev-build badge names the product | Same | #6 |
| `emain/emain.ts`, `emain/emain-platform.ts` | Quit and ARM64 dialogs name the product; ARM64 "Learn More" opens the repository | Same | #6 |
| `frontend/app/onboarding/onboarding-durable.tsx`, `frontend/app/onboarding/onboarding-command.tsx` | Product name; the demo shows the Moltenterm logo | Same | #6 |
| `frontend/app/element/quicktips.tsx`, `frontend/app/aipanel/aipanel.tsx` | Discord links replaced by Moltenterm's GitHub | Same | #6 |
| `tsunami/frontend/public/wave-logo-256.png` | Image replaced by the Moltenterm logo (binary, no marker) | Waveapp favicon | #6 |
| `frontend/preview/mock/defaultconfig.ts`, `frontend/preview/mock/preview-electron-api.ts`, `frontend/preview/previews/processviewer.preview.tsx` | Mocks completed: `version`, `buildtime`, `getPathForFile`, `numthreads` | They lagged behind the types, so `task check:ts` failed on v0.14.5 | #7 |
| `pkg/tsgen/tsgenevent_test.go` | Expects the multi-line `WaveEventName` union | The generator and the committed `frontend/types/waveevent.d.ts` use it; the test failed on v0.14.5 | #7 |

## Known upstream items

- **Font Awesome Pro 6:** resolved by #6 (FR-FORK-004). HEAD ships Font Awesome Free plus `public/moltenterm-icons.css`;
  the Pro files remain in Wave's history, which Moltenterm keeps (decision of 2026-09-29).
- **Wave branding left on purpose:** "Wave AI" (renamed with the Automorph decision on the AI panel), links to
  docs.waveterm.dev (still the only documentation of the configuration), `wsh` help texts, the AI system prompt, and
  pages that are no longer reachable (the opt-out "star us" page, release notes and upgrade modals). The `docs/` site is
  Wave's documentation (Algolia index, Plausible analytics); it is not built or shipped.
- **Identity:** resolved by #4 (FR-FORK-002). Still shared with Wave, on purpose or for later: `~/.waveterm` on remote
  hosts reached over SSH or WSL (WSL uses a fixed socket there), `~/waveapps` (app builder only), `TERM_PROGRAM=waveterm`
  (kept so that tools which detect Wave keep working), the `WAVETERM_*` variables that hand directories to wavesrv, and
  the version number (0.14.5, Wave's) until Moltenterm's own numbering is decided.
- **Outbound services:** resolved by #5 (FR-FORK-003). No update feed, no Wave cloud, no telemetry upload, and the Wave AI
  panel runs only on user-defined modes. Events are still recorded locally (dormant), and "wave" mode definitions are
  still parsed but always refused.
- **Baseline failures inherited from v0.14.5:** resolved by #7 (FR-FORK-005); still present on upstream `main` on
  2026-09-30. `task check:ts` reported 17 errors from three stale mocks in `frontend/preview/`, and `pkg/tsgen`
  `TestGenerateWaveEventTypes` expected a one-line `WaveEventName` union while the generator emits a multi-line one.
  Both fixes stay Moltenterm patches (decision of 2026-09-30: not offered upstream).
- **Default content:** the first-run layout opens a web block on Wave's GitHub page, and onboarding still links to
  Wave's GitHub and Discord. Addressed by #4 (the Wave AI panel no longer opens by default since #5).
- **`task dev` environment:** resolved by #5. The dev tasks no longer set `WCLOUD_*` (Wave's development cloud) or
  `WAVETERM_ENVFILE`, so the SRS token in `.env` stays out of the app.
