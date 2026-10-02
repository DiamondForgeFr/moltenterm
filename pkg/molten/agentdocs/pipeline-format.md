# The pipeline file: `.molten/project.json`

A project's pipeline tells Moltenterm's Mission Control which commands make up the project's local CI, local builds
and releases. It lives at `.molten/project.json` in the project's root, is written by the user's coding agent (the
`molten-pipeline` guide), and is checked with `molten project validate`, which runs nothing.

Moltenterm never runs a declared command on its own: the user starts it from a panel, the first run of a project's
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
            { "id": "cut", "title": "Cut the release candidate", "run": "./scripts/release.sh {version} --internal" }
        ],
        "public": [
            { "id": "promote", "title": "Promote develop", "run": "bun scripts/promote.mjs --yes" },
            { "id": "cut", "title": "Cut the release", "run": "./scripts/release.sh {version} --public" }
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
| `branches` | no | `{ "trunk": "develop", "release": "main" }`: where work is merged, and where releases are cut. Leave it out when `.saasfoundry.json` declares them; without either, Moltenterm uses `develop` then `main`. |
| `versions` | no | `tagprefix` (default `v`), and `notes`: where a version's release notes are, with `{tag}` (e.g. `releases/{tag}.md`). |
| `ci.jobs` | no | The local CI: each job has a `name` (id), a `title`, a `lane` and a command. Jobs of the same lane run in order; lanes run side by side. |
| `builds` | no | Local builds: `id` (`gold`, `rc`, …), `title`, a command, and `artifact`: the file or folder the build produces (`~` allowed). Marking a build as gold keeps a copy of it. |
| `release.rc`, `release.public` | no | The ordered steps that make a release candidate or a public release. Each step has an `id`, a `title` and a command. |
| `steps` | no | Project-specific actions shown in a panel: `id`, `title`, `section` (`timeline`, `cilocal`, `ciremote` or `cd`) and a command. |

### Commands

Every job, build and step has:

- `run`: the shell command, run with the user's login shell environment;
- `cwd` (optional): the folder to run in, relative to the project's root, inside the project;
- `env` (optional): variables added to the environment, never secrets.

`run` may use `{version}` (e.g. `1.4.0`), `{tag}` (e.g. `v1.4.0-2`) and `{branch}`; other `{…}` words are refused.
A script the command starts (`./scripts/x.sh`, `scripts/x.mjs`) must exist.

A long step may print `▶ phase: <name>` lines; Mission Control shows the current phase. The exit code decides
success.

## Ids

Ids (`name` of a job, `id` of a build or step) are lowercase letters, digits, `.`, `_` and `-`, unique in their list.
