# The pipeline file: `.molten/project.json`

A project's pipeline tells MoltenTerm's Mission Control which commands make up the project's local CI, local builds
and releases. It lives at `.molten/project.json` in the project's root, is written by the user's coding agent (the
`molten-pipeline` guide), and is checked with `molten project validate`, which runs nothing.

MoltenTerm never runs a declared command on its own: the user starts it from a panel, the first run of a project's
commands (and every change to them) asks the user to trust them, and every release step asks for confirmation.

## Example

```json
{
    "schema": 1,
    "name": "Notulia",
    "versions": { "tagprefix": "v", "notes": "releases/{tag}.md" },
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
            { "id": "cut", "title": "Cut the release candidate", "phase": "cut", "run": "./scripts/release.sh {version} --internal" }
        ],
        "public": [
            { "id": "promote", "title": "Promote develop", "phase": "prepare", "run": "bun scripts/promote.mjs --yes" },
            { "id": "cut", "title": "Cut the release", "phase": "cut", "run": "./scripts/release.sh {version} --public" }
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
| `versions` | no | `tagprefix` (default `v`): the release tags start with it, and only those are read as releases (a release candidate has a `-N` suffix after it, e.g. `release-1.2.0-3`). `notes`: where a version's release notes are, with `{tag}` (default `releases/{tag}.md`); internal notes sit beside them (`releases/{tag}.internal.md`). |
| `ci.jobs` | no | The local CI: each job has a `name` (id), a `title`, a `lane` and a command. Jobs of the same lane run in order (a failed job stops the rest of its lane); lanes run side by side. MoltenTerm runs them in a worktree of its own and keeps each job's verdict per code tree: a run reruns only what is not green yet. |
| `ci.prepare` | no | A command run once in the CI worktree before the jobs, e.g. `bun install --frozen-lockfile`. |
| `ci.statuses` | no | `"github"`: each job's verdict is published as the commit status `local-<job>` through the user's `gh`, so pull requests show it. A pre-push hook can call `wsh molten ci status` (exit 0 green, 1 red, 2 not run yet) to warn before pushing. |
| `builds` | no | Local builds, made by MoltenTerm from the trunk as it is on the remote, in a worktree of its own: `id` (`gold`, `rc`, …), `title`, a command, `artifact` (the file or folder the build produces, `~` allowed), and optionally `kind` (`gold` or `rc`), `description` (one line shown in the Build local menu), `phases` (`[{ "id", "title", "text" }]`, the phases the command announces with `▶ phase: <id>`, shown from the start with their text), `verify: "ci"` (the local CI runs on the build's commit first; the build stops unless it is green), `prepare` (a command run in the worktree first, e.g. installing dependencies) and `manifest` (the delivered build's manifest, default `manifest.json` beside the artifact: `productName`, `version`, `buildId`, `builtAt`, `commit`, `notes`). The command gets `MOLTEN_BUILD_COMMIT`. |
| `release.rc`, `release.public` | no | The ordered steps that make a release candidate or a public release. Each step has an `id`, a `title`, a command and a `phase`: `prepare`, `cut`, `build`, `publish` or `back` (back to the trunk). The steps of the `prepare` phase run as soon as the user starts a release from the Timeline's Release menu; every later step waits for the user's click on the Timeline. Without any `phase`, only the first step runs at the start. A step may add `confirm` (a warning shown, and confirmed, `{tag}` and `{version}` allowed, before a step that cannot be taken back, e.g. the cut that pushes the tag) and `notes: true` (the step rewrites the public notes: the Timeline offers it as "Rewrite" beside them instead of running it in order). The Timeline follows the release through five phases: the `cut` is done once the tag exists; the `build` follows the `build` steps, or else the GitHub runs the tag started; `publish` follows the GitHub release (a draft waits for its promotion), then the `publish` steps, or only those steps when the project publishes elsewhere; `back` is done once the release commit is on the trunk (merged or cherry-picked). |
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

## Ids

Ids (`name` of a job, `id` of a build or step) are lowercase letters, digits, `.`, `_` and `-`, unique in their list.
