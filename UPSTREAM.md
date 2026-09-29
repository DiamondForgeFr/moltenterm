# Upstream: Wave Terminal

Morphterm is a soft fork of [Wave Terminal](https://github.com/wavetermdev/waveterm) (Apache-2.0, Command Line Inc.).
This file explains how the fork is built, how Wave releases are merged, and every place where Morphterm changes Wave's
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
gh repo set-default DiamondForgeFr/morphterm
```

`gh` resolves a remote named `upstream` before `origin`. Without `gh repo set-default`, ticket and pull request commands
(including the SaaSFoundryAI workflow scripts) silently target Wave's repository.

## Merging a Wave release

1. Open a ticket and a branch `feature/<N>-merge-wave-<version>` from `develop`.
2. Resolve the release commit: `git ls-remote --tags upstream refs/tags/<version>`, then `git fetch upstream main` (or
   `git fetch upstream <sha>` if the release is not on `main`).
3. `git merge --no-ff <sha>` and resolve conflicts with the policy below.
4. Check that no Wave automation came back: `git diff --name-status <sha> HEAD -- .github CNAME` must list only
   Morphterm's own files. Delete any new Wave workflow, Dependabot or funding file.
5. Validate: `task init`, `task check:ts`, `npx vitest run`, `go test ./cmd/... ./pkg/...`, then `task dev`.
6. Update the "Current base" table and the patch ledger.
7. Open the pull request to `develop` and merge it with a **merge commit**. Never squash or rebase: both drop Wave's
   history and make every later merge a conflict.

Never push Wave's tags: `git push` without `--tags`, and `tagOpt` keeps them out of the local repository.

## Files Morphterm owns

| Path | Policy when merging |
| --- | --- |
| `CLAUDE.md` | Keep ours. Re-sync its "Codebase conventions (upstream Wave)" section with upstream's `CLAUDE.md`. |
| `.gitignore` | Union of both, but never ignore `.claude` (it holds the SaaSFoundryAI harness). |
| `.github/` | Keep ours. Delete any new upstream workflow, `dependabot.yml` or `FUNDING.yml`. |
| `CNAME` | Stays deleted: it points to Wave's documentation domain. |
| `LICENSE` | Upstream's file (Apache-2.0). |
| `.claude/`, `.agents/`, `.saasfoundry.json`, `AGENTS.md`, `GEMINI.md`, `MANIFESTO.md`, `UPSTREAM.md` | Morphterm only; no upstream counterpart. |

## Patch ledger

Every change to a Wave file is listed here and, where the format allows comments, marked with `MORPHTERM-PATCH` in the
file. Code that lives in new files is not listed.

| Wave file | Change | Why | Ticket |
| --- | --- | --- | --- |
| `.gitignore` | Drops the `.claude` rule; ignores `.claude/settings.local.json` and `.env*.local` | The harness lives in `.claude/` and must stay tracked | #3 |
| `CLAUDE.md` | Replaced by the harness instructions, which import Wave's rules | One entry point for agents | #3 |
| `.github/workflows/*` (9 files), `.github/dependabot.yml`, `.github/FUNDING.yml`, `CNAME` | Deleted | They would build, publish, open pull requests or redirect on Morphterm's repository | #3 |

## Known upstream items

- **Font Awesome Pro 6** files in `public/fontawesome/` and `docs/static/fontawesome/` are under a commercial licence,
  not Apache-2.0. They are replaced by an openly licensed icon set in #6 (FR-FORK-004).
- **Identity:** `emain/emain-platform.ts` hardcodes `waveterm` for the configuration and data directories, so a build of
  this repository shares them with an installed Wave. Fixed by #4 (FR-FORK-002).
- **Outbound services:** auto-update from Wave's servers, Wave cloud and telemetry are still enabled. Fixed by #5
  (FR-FORK-003).
- **`task dev` environment:** `Taskfile.yml` points the dev build at Wave's development cloud (`WCLOUD_ENDPOINT`,
  `WCLOUD_PING_ENDPOINT`) and loads the repository's `.env` into the app (`WAVETERM_ENVFILE`). That file holds the
  SaaSFoundryAI SRS token, which then reaches every shell opened in the dev build. Also addressed by #5; until then, run
  `npm run dev` directly with those variables overridden (see #3 for the command).
