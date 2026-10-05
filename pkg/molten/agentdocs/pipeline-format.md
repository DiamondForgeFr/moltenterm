# The pipeline file: `.molten/project.json`

A project's pipeline tells MoltenTerm's Mission Control which commands make up the project's local CI, local builds
and releases. It lives at `.molten/project.json` in the project's root, is written by the user's coding agent (the
`molten-pipeline` guide), and is checked with `molten project validate`, which runs nothing.

MoltenTerm never runs a declared command on its own: the user starts it from a panel, the first run of a project's
commands (and every change to them) asks the user to trust them, and every release step waits for the user's click.

## Example

```json
{
    "schema": 1,
    "name": "Notulia",
    "versions": {
        "tagprefix": "v",
        "notes": "releases/{tag}.md",
        "firstpublic": "1.0.0",
        "files": [
            { "path": "package.json", "format": "json", "keys": [["version"]] },
            { "path": "src-tauri/Cargo.toml", "format": "regex", "pattern": "(?m)^version = \"([^\"]+)\"" }
        ]
    },
    "ci": {
        "jobs": [
            { "name": "check", "title": "Checks", "lane": "web", "run": "bun run check" },
            { "name": "e2e", "title": "End-to-end", "lane": "web", "run": "bun run test:e2e" },
            { "name": "rust", "title": "Rust", "lane": "rust", "run": "cargo clippy -- -D warnings", "cwd": "src-tauri" }
        ]
    },
    "builds": [
        {
            "id": "gold",
            "title": "Gold",
            "run": "./scripts/build-local.sh gold",
            "artifact": "~/Library/Application Support/Notulia Local Builds/gold/Notulia.app"
        }
    ],
    "release": {
        "rc": [
            { "id": "promote", "title": "Promote develop", "phase": "prepare", "run": "bun scripts/promote.mjs --yes" },
            { "id": "cut", "title": "Cut the release candidate", "phase": "cut", "confirm": "{tag} is public once pushed.", "run": "./scripts/release.sh {version} --internal" },
            { "id": "sync-back", "title": "Carry the release commit back", "phase": "back", "run": "./scripts/sync-back.sh {tag}" }
        ],
        "public": [
            { "id": "promote", "title": "Promote develop", "phase": "prepare", "run": "bun scripts/promote.mjs --yes" },
            { "id": "cut", "title": "Cut the release", "phase": "cut", "confirm": "{tag} goes to every user once pushed.", "run": "./scripts/release.sh {version} --public" },
            { "id": "sync-back", "title": "Carry the release commit back", "phase": "back", "run": "./scripts/sync-back.sh {tag}" }
        ]
    },
    "steps": [
        { "id": "verify-updater", "title": "Verify the updater", "section": "cd", "run": "bun scripts/verify.mjs --expect {tag}" }
    ]
}
```

## Fields

All fields are lowercase. Unknown fields are refused, so a typo does not go unnoticed.

| Field | Required | What it is |
| --- | --- | --- |
| `schema` | yes | Always `1`. |
| `name` | yes | The project's name, as Mission Control shows it. |
| `icon` | no | The project's own icon, relative to the project folder (svg, png, ico, jpg, webp or gif): offered first for the workspace, the status bar and Mission Control, before any icon MoltenTerm would guess. Use the square app icon, not a wide logo. |
| `branches` | no | `{ "trunk": "develop", "release": "main" }`: where work is merged, and where releases are cut. Leave it out when `.saasfoundry.json` declares them; without either, MoltenTerm uses `develop` then `main`. |
| `versions` | no | `tagprefix` (default `v`): the release tags start with it, and only those are read as releases: `X.Y.Z` for a public release, `X.Y.Z-N` (N from 1) for a release candidate, e.g. `release-1.2.0-3`; any other form is not a release. `notes`: where a version's release notes are, with `{tag}` (default `releases/{tag}.md`); internal notes sit beside them (`releases/{tag}.internal.md`). `firstpublic` (`X.Y.Z`): the number proposed for the first public release, which is a choice, not a calculation (default: the version the release candidates lead to, else `1.0.0`); tags below its first candidate are not the project's releases (a fork's upstream tags). `files`: the files that carry the version, the first one holding the project's current version; each is `{ "path", "format": "json", "keys": [["version"], ["packages", "", "version"]] }` (each key path names a string; the empty key is a key) or `{ "path", "format": "regex", "pattern" }` (exactly one capture group, matching exactly once). After the last public release, the next number is read from the conventional commits since it: a breaking change (`feat!:` or `BREAKING CHANGE:`) makes a major release, a `feat` a minor one, anything else a user sees a patch; only `chore`, `ci`, `docs`, `test`, `style`, `build` or `refactor` commits justify no release unless a version is given explicitly. |
| `ci.jobs` | no | The local CI: each job has a `name` (id), a `title`, a `lane` and a command. Jobs of the same lane run in order (a failed job stops the rest of its lane); lanes run side by side. MoltenTerm runs them in a worktree of its own and keeps each job's verdict per code tree: a run reruns only what is not green yet. |
| `ci.prepare` | no | A command run once in the CI worktree before the jobs, e.g. `bun install --frozen-lockfile`. |
| `ci.statuses` | no | `"github"`: each job's verdict is published as the commit status `local-<job>` through the user's `gh`, so pull requests show it. A pre-push hook can call `wsh molten ci status` (exit 0 green, 1 red, 2 not run yet) to warn before pushing. |
| `builds` | no | Local builds, made by MoltenTerm from the trunk as it is on the remote, in a worktree of its own: `id` (`gold`, `rc`, …), `title`, a command, `artifact` (the file or folder the build produces, `~` allowed), and optionally `kind` (`gold` or `rc`), `description` (one line shown in the Build local menu), `phases` (`[{ "id", "title", "text" }]`, the phases the command announces with `▶ phase: <id>`, shown from the start with their text), `verify: "ci"` (the local CI runs on the build's commit first; the build stops unless it is green), `prepare` (a command run in the worktree first, e.g. installing dependencies) and `manifest` (the delivered build's manifest, default `manifest.json` beside the artifact: `productName`, `version`, `buildId`, `builtAt`, `commit`, `notes`). The command gets `MOLTEN_BUILD_COMMIT`. |
| `release.rc`, `release.public` | no | The ordered steps that make a release candidate or a public release. Each step has an `id`, a `title`, a command and, preferably, a `phase`: `prepare`, `cut`, `build`, `publish` or `back` (back to the trunk). It may add `confirm` (a warning shown, and confirmed, `{tag}` and `{version}` allowed, before a step that cannot be taken back, e.g. the cut that pushes the tag) and `notes: true` (the step rewrites the public notes: the Timeline offers it as "Rewrite" beside them instead of running it in order). How the steps are run is the release contract, below. |
| `steps` | no | Project-specific actions shown in a panel: `id`, `title`, `section` (`timeline`, `cilocal`, `ciremote` or `cd`) and a command. Each section lists its steps with a Run button, the last run's state and its log; they run through the trust rule, one at a time. |

### Commands

Every job, build and step has:

- `run`: the shell command, run with the user's login shell environment;
- `cwd` (optional): the folder to run in, relative to the project's root, inside the project;
- `env` (optional): variables added to the environment, never secrets.

`run` may use `{version}` (the release's number without its candidate suffix, e.g. `1.4.0`), `{tag}` (the full tag with the project's `tagprefix`, e.g. `v1.4.0-2`) and `{branch}` (the trunk for a build, the branch under test for a CI job, the branch checked out in the project for release and adapter steps); other `{…}` words are refused.
A script the command starts (`./scripts/x.sh`, `scripts/x.mjs`) must exist.

A long step may print `▶ phase: <name>` lines; Mission Control shows the current phase. A release step that drafts
the public notes prints `▶ notes: <path>` (absolute, or relative to its folder): the Timeline edits that file before the
cut, which waits until the notes are saved; without it, `versions.notes` in the project is used. The exit code decides
success.

## The release contract

A release is started from the Timeline's Release menu (a release candidate `X.Y.Z-N`, or a public release `X.Y.Z`)
and followed on the Timeline through five phases. Every declared step runs, in its declared order within its phase,
one at a time, whatever its id: the ids are the project's own (`prepare`, `cut`, `finalize`… are fine).

**Phases.**

- With phases (recommended): each step runs in the phase it declares. A step without a `phase` in a list that
  declares phases joins the phase of the step before it (the first step: `prepare`). Phases run in the order
  `prepare`, `cut`, `build`, `publish`, `back`, so declare the steps in that order.
- Without any phase: the first step is the preparation; the next ones run in order, each on its click, until the tag
  is on origin; the steps that had not run by then come after the release, in `back`. This is how a pipeline such as
  `warm-cache`, `promote`, `prepare`, `finalize`, `sync-back` runs: warm-cache at the start, then promote, prepare
  and finalize on their clicks, sync-back once the release is published.

**When each step runs.**

- `prepare`: its steps run as soon as the release starts, chained in one run (the first failure stops the rest); a
  failure offers to run them all again. A list with no preparation starts nothing.
- Every later step waits for the user's click on the Timeline. Only the next step of the current phase is offered;
  after a failure, the failed step is offered again, and the step before it in the phase too (for a cut that must be
  prepared again before it can be finalized again).
- A step with `confirm` asks for it before it runs. A cut step that waits after a step of this release drafted the
  notes is read as the cut when no step declares `confirm`: the notes are offered for editing and the click is
  confirmed. Declare `confirm` on the step that pushes the tag rather than relying on this.

**When each phase is done.**

- `prepare`: the preparation succeeded.
- `cut`: the tag is on origin (`git ls-remote`). A tag that only exists locally, left by a push that failed, is not a
  cut; a project without an origin is read from its local tags.
- `build`: the `build` steps succeeded; without any, the GitHub runs the tag started are green; a project that is not
  on GitHub, with no `build` step, has nothing to wait for.
- `publish`: the GitHub release is published (a draft waits for its promotion on GitHub), then the `publish` steps;
  without a GitHub release, the `publish` steps alone; not on GitHub and no `publish` step: nothing to wait for.
- `back`: the release commit is on the trunk (merged or cherry-picked). Its steps are offered from the tag on, and
  become the next thing to do once the release is published. An open pull request carrying the release back is
  waited for.

**Notes.** The public notes edited before the cut are, in order: the file a step of this release announced with
`▶ notes: <path>`; `versions.notes` in the project; or `versions.notes` in another worktree of the project's
repository (a release worktree beside it, made with `git worktree add`) written since the release started.

**Abandoning.** "Abandon this release" stops following it; nothing pushed is undone. Starting the same tag again starts
from scratch: the runs of the abandoned attempt are not read. The runs of the release on its way are kept until it
ends, whatever else runs meanwhile.

**Writing the steps.**

- Each step is a non-interactive command (no input is given), run from the project's root unless `cwd` says
  otherwise, with `{version}`, `{tag}` and `{branch}` expanded. Its exit code decides: 0 is done, anything else
  failed. Its last lines are shown when it fails: make the last line say why.
- A step may be run again after a failure: make it start from a clean state (reset its worktree, refuse what is
  already done), as a retry must not fail the same way because of what the failed run left.
- Steps that work beside the checkout (a release worktree) keep the checkout untouched; the cut pushes the tag to
  `origin` atomically with its commit (`git push --atomic origin main <tag>`).
- `molten project validate` warns about what would make a step run where it is not expected: a step without a phase
  among phased ones, a step declared after a step of a later phase, a list without phases (how it is read), and a
  list without any `confirm`.

## Ids

Ids (`name` of a job, `id` of a build or step) are lowercase letters, digits, `.`, `_` and `-`, unique in their list.
