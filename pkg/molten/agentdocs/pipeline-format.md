# The pipeline file: `.molten/project.json`

A project's pipeline tells MoltenTerm's Mission Control which commands make up the project's local CI, local builds
and releases. It lives at `.molten/project.json` in the project's root, is written by the user's coding agent (the
`molten-pipeline` guide), and is checked with `molten project validate`, which runs nothing.

MoltenTerm never runs a declared command on its own: the user starts it from a panel, the first run of a project's
commands (and every change to them) asks the user to trust them, and every release step waits for the user's click.
A run started from a terminal (`molten ci run`, `molten project sync`) on commands not trusted yet runs nothing: MoltenTerm
asks the user by a notification, and tells you in your prompt once they trusted them; then run the command again.

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
        { "id": "verify-updater", "title": "Verify the updater", "section": "cd", "run": "bun scripts/verify.mjs --expect {tag}" },
        { "id": "deploy-staging", "title": "Deploy the website to staging", "section": "cd", "environment": "staging", "run": "./scripts/deploy.sh staging" },
        { "id": "deploy-prod", "title": "Deploy the website", "section": "cd", "environment": "prod", "run": "./scripts/deploy.sh prod" }
    ]
}
```

## Fields

All fields are lowercase. Unknown fields are refused, so a typo does not go unnoticed.

| Field | Required | What it is |
| --- | --- | --- |
| `schema` | yes | Always `1`. |
| `name` | yes | The project's name, as Mission Control shows it. |
| `group` | no | The product the repository belongs to, 1 to 64 characters, e.g. `"Notulia"` in the app and in its website. The projects linked to MoltenTerm workspaces that declare the same group (matched after trimming, ignoring case) form one group, shown together in Mission Control; see "Groups and dependencies". |
| `dependson` | no | What this repository reads from another member of its group: `[{ "project", "paths", "branch", "sync", "output" }]`; see "Groups and dependencies". |
| `icon` | no | The project's own icon, relative to the project folder (svg, png, ico, jpg, webp or gif): offered first for the workspace, the status bar and Mission Control, before any icon MoltenTerm would guess. Use the square app icon, not a wide logo. |
| `branches` | no | `{ "trunk": "develop", "release": "main" }`: where work is merged, and where releases are cut. Leave it out when `.saasfoundry.json` declares them: the trunk from `workflow.workingBranch`, the release branch from `workflow.releaseBranch`, else `mainBranch`. Without either, MoltenTerm uses `develop` and `main`. `molten project show` prints both and where each name was read. |
| `versions` | no | `tagprefix` (default `v`): the release tags start with it, and only those are read as releases: `X.Y.Z` for a public release, `X.Y.Z-N` (N from 1) for a release candidate, e.g. `release-1.2.0-3`; any other form is not a release. `notes`: where a version's release notes are, with `{tag}` (default `releases/{tag}.md`); internal notes sit beside them (`releases/{tag}.internal.md`); the public file may start with a front matter (`---`, `date: YYYY-MM-DD`, `draft: true`, `---`), and `draft: true` marks notes that are not ready, which `molten release finalize` refuses. `notesagent`: the coding agent CLI that writes the public notes, as argv (e.g. `["claude", "-p"]` or `["codex", "exec", "-"]`): the prompt goes to its standard input and the notes come back on its standard output; without it, the notes are the commit subjects. `firstpublic` (`X.Y.Z`): the number proposed for the first public release, which is a choice, not a calculation (default: the version the release candidates lead to, else `1.0.0`); tags below its first candidate are not the project's releases (a fork's upstream tags). `changelogs`: files of the project a release may change beside the version files and the notes (changelogs written by hand before the cut, e.g. `["docs/changelog.md", "docs/fr/changelog.md"]`): `molten release finalize` commits them with the release. `format`: the project's formatter command for the files a release writes, the files appended as arguments (e.g. `"npx prettier --write"`); a command to trust like the others. Without it, the release chain uses the project's prettier when it has one, else formats nothing and says so (see the release contract). `files`: the files that carry the version, the first one holding the project's current version; each is `{ "path", "format": "json", "keys": [["version"], ["packages", "", "version"]] }` (each key path names a string; the empty key is a key) or `{ "path", "format": "regex", "pattern" }` (exactly one capture group, matching exactly once) or, for a version label in a text file, `{ "path", "format": "text", "pattern" }` (a regular expression where `{version}` stands for the version, once, with no capture group of its own, matching exactly once; e.g. `{ "path": "README.md", "format": "text", "pattern": "\\*\\*v{version}\\*\\*" }`). Several entries may name the same file. After the last public release, the next number is read from the conventional commits since it: a breaking change (`feat!:` or `BREAKING CHANGE:`) makes a major release, a `feat` a minor one, anything else a user sees a patch; only `chore`, `ci`, `docs`, `test`, `style`, `build` or `refactor` commits justify no release unless a version is given explicitly. |
| `ci.jobs` | no | The local CI: each job has a `name` (id), a `title`, a `lane` and a command, and optionally a `description` (one sentence saying what the job checks, shown in the CI/CD panel's Jobs tab). Jobs of the same lane run in order (a failed job stops the rest of its lane); lanes run side by side. MoltenTerm runs them in a worktree of its own and keeps each job's verdict per code tree: a run reruns only what is not green yet. A coding agent starts it with `molten ci run [branch] [--only <jobs>]` (it waits for the verdict) and reads it with `molten ci status`, instead of running the commands itself: see molten-pipeline.md. |
| `ci.prepare` | no | A command run once in the CI worktree before the jobs, e.g. `bun install --frozen-lockfile`. |
| `ci.statuses` | no | `"github"`: each job's verdict is published as the commit status `local-<job>` through the user's `gh`, so pull requests show it. A pre-push hook can call `wsh molten ci status` (exit 0 green, 1 red, 2 not run yet) to warn before pushing. |
| `builds` | no | Local builds, made by MoltenTerm from the trunk as it is on the remote, in a worktree of its own: `id` (`gold`, `rc`, …), `title`, a command, `artifact` (the file or folder the build produces, `~` allowed), and optionally `kind` (`gold` or `rc`), `description` (one line shown in the Build local menu), `phases` (`[{ "id", "title", "text" }]`, the phases the command announces with `▶ phase: <id>`, shown from the start with their text), `verify: "ci"` (the local CI runs on the build's commit first; the build stops unless it is green), `prepare` (a command run in the worktree first, e.g. installing dependencies) and `manifest` (the delivered build's manifest, default `manifest.json` beside the artifact: `productName`, `version`, `buildId`, `builtAt`, `commit`, `notes`). The command gets `MOLTEN_BUILD_COMMIT`. |
| `release.rc`, `release.public` | no | The ordered steps that make a release candidate or a public release. Each step has an `id`, a `title`, a command and, preferably, a `phase`: `prepare`, `cut`, `build`, `publish` or `back` (back to the trunk). It may add `confirm` (a warning shown, and confirmed, `{tag}` and `{version}` allowed, before a step that cannot be taken back, e.g. the cut that pushes the tag) and `notes: true` (the step rewrites the public notes: the Project tab offers it as "Rewrite" beside them instead of running it in order). A step the developer does by hand is `manual`: its instructions instead of a command (no `run`, `cwd` or `env`), e.g. a one-time `git merge -s ours origin/main` before the first promotion, or a changelog section to write; the release panel shows the instructions and waits until the developer marks it done, running nothing. A manual step cannot be in the `prepare` phase (it runs at once) nor rewrite the notes, and it is no command to trust. Declare what proves it done whenever a file shows it: `check: { "path", "contains" }` (`{tag}` and `{version}` allowed), e.g. `{ "path": "docs/changelog.md", "contains": "## [{version}]" }` for a changelog section, `{ "path": "AGENTS.md", "contains": "- Current version: {version}" }` for a version line. "Mark as done" reads the file in the release worktree (in the project when there is none) and, when it is missing or lacks the text, records nothing and says what is missing; the developer may confirm it anyway. Only a manual step declares a check. How the steps are run is the release contract, below. |
| `steps` | no | Project-specific actions shown in a panel: `id`, `title`, `section` (`timeline`, `cilocal`, `ciremote` or `cd`) and a command. `timeline` steps show in the Project tab's Project steps card, the others in the CI/CD panel's CI local, CI remote and CD tabs. Each section lists its steps with a Run button, the last run's state and its log; they run through the trust rule, one at a time. A `cd` step that deploys may name its target with `environment` (e.g. `"dev"`, `"staging"`, `"prod"`; lowercase, one step per environment): the Project tab's header then offers it beside Release, as "Deploy to dev" for a single environment or a "Deploy to…" menu listing each environment with its step's title and last run; it runs the step exactly as the CD tab's Run button does. A deploy to an environment named like production (`prod`, `production` or `live`, alone or as a word of the name such as `prod-eu`) asks first, naming the environment and the branch and commit checked out in the project; `confirm: true` asks the same for any other environment. `environment` is not `env`: `env` stays the variables added to the command. |
| `launch` | no | How the Control room's Launch serves a version of the project (a pull request or a branch) on this computer: `where` (`main`, the default: the main checkout, detached at the version's head; `worktree`: the branch's worktree when it has one), `prepare` (`[{ "id", "title", "run", "cwd" }]`, run in order in the served folder, e.g. installing and migrating the dev database), `servers` (`[{ "id", "title", "run", "cwd", "port" }]`, each started in a session of its own and ready once its port accepts a connection) and `url` (opened in the browser once every server is ready). MoltenTerm only proposes it: the developer confirms or edits the recipe in the launch recipe dialog, MoltenTerm keeps that copy in its own data folder, and Launch runs only that copy. Without `launch`, the recipe is proposed from the package.json scripts. |

### Commands

Every job, build and step has:

- `run`: the shell command, run with the user's login shell environment;
- `cwd` (optional): the folder to run in, relative to the project's root, inside the project;
- `env` (optional): variables added to the environment, never secrets.

`run` may use `{version}` (the release's number without its candidate suffix, e.g. `1.4.0`), `{tag}` (the full tag with the project's `tagprefix`, e.g. `v1.4.0-2`) and `{branch}` (the trunk for a build, the branch under test for a CI job, the branch checked out in the project for release and adapter steps); other `{…}` words are refused.
A script the command starts (`./scripts/x.sh`, `scripts/x.mjs`) must exist.

A long step may print `▶ phase: <name>` lines; Mission Control shows the current phase. A release step that drafts
the public notes prints `▶ notes: <path>` (absolute, or relative to its folder): the Project tab edits that file before the
cut, which waits until the notes are saved; without it, `versions.notes` in the project is used. The exit code decides
success.

## Groups and dependencies

A product made of several repositories (an app, its website, its release repository) is one **group**: each
repository declares `"group": "<product>"` in its own `.molten/project.json`. There is no group file, and MoltenTerm
writes nothing in any repository: a repository leaves the group by removing the field.

- Each repository keeps one `.molten/project.json` at its root, never nested, with its own CI, builds and releases: the
  website keeps its build and deploy, the app its release candidates, gold and release steps. A file below another
  repository's root is never read as a member.
- Only repositories linked to a MoltenTerm workspace are members; one that declares the group but no workspace links
  is not shown. A workspace stays linked to one repository: Mission Control shows the group around it.
- The group's name is the spelling of its first member in the workspace rail's order.
- `molten project group` lists the group of this workspace's project: each member with its workspace, folder and
  state (trunk CI, last build, last release).
- The Project tab of a member shows the group strip above its next station: every member in rail order with its trunk
  CI (local and GitHub), last build, last release tag and stale dependencies, the linked one marked. A click on
  another member switches to its workspace. The strip offers only Sync on a stale dependency: each member's Run CI,
  Build local, Release and Clean branches stay in its own workspace. A project in no group has no strip.
- The workspace rail shows a group of two members or more as one product: its icon is the member named like the
  group (else the first member's), with a red badge when a member's trunk CI or last build failed and an amber one for
  a stale dependency. A click expands or collapses it; MoltenTerm remembers that on this machine. Its members' workspaces
  stay together: a member moves within its product, and the product moves as a block.

A repository that reads another member's files (a website reading the app's feature registry) declares it, as the
dependent, in `dependson`:

```json
{
    "schema": 1,
    "name": "notulia-website",
    "group": "Notulia",
    "dependson": [
        {
            "project": "Notulia",
            "paths": ["features/*.json"],
            "branch": "develop",
            "sync": "node scripts/sync-features.mjs",
            "output": ["src/data/features.json"]
        }
    ]
}
```

| Field | Required | What it is |
| --- | --- | --- |
| `project` | yes | The source's `name`, a member of the same group (matched ignoring case). Not the project itself. |
| `paths` | yes | Globs relative to the source's root (`*` within a folder, `**` across folders), without `..`: the files this repository reads. |
| `branch` | no | The source's branch to watch; default the source's trunk. |
| `sync` | no | The command that brings this repository up to date, run in its root with the user's login shell environment, through the trust rule like every declared command. While it runs, `MOLTEN_DEP_SOURCE_DIR` points at a clean worktree of the source's watched branch: read the source from there first, and keep a relative path (`../Notulia/`) as a fallback. |
| `output` | yes | Globs relative to this repository's root, without `..`: the files the sync writes. Their last commit tells when the dependency was last synced. |

The dependency is stale when the source's last commit touching `paths` on the watched branch is newer than this
repository's last commit touching `output` on its trunk (or when `output` was never committed there). `molten project
validate` checks the shape only: whether `project` names a member depends on the workspace links, so it is shown at
run time.

How Mission Control reads it, on each refresh of a project, from the local git only (no fetch, nothing written):

- The source's watched branch is read on `origin` when it exists there, else locally. A change counts from when it
  landed on that branch: a commit made on a feature branch before the last sync and merged after it makes the
  dependency stale.
- This repository's last sync is its newest commit touching `output` on its trunk, local or on `origin`, whichever is
  newer. A sync committed on a feature branch counts once it reaches the trunk.
- While stale, the files of `output` changed and not committed read **synced, not committed**: the flag stays until
  the commit lands.
- A stale dependency turns the member amber and raises one notification (subject Dependencies) naming the source, the
  branch, the changed paths and the commits since the last sync with their tickets; it resolves itself once the flag
  clears. A `project` that names no linked member of the group reads **source not found**, a `branch` that exists
  neither on `origin` nor locally **branch not found**: neither is ever stale.
- `molten project deps [--json]` prints each dependency of this workspace's project with its state: in sync, stale,
  synced not committed, source not found or branch not found.

Sync brings a stale dependency up to date. It is offered on the stale flag in Mission Control, as the notification's
action and as `molten project sync [source]`; it never starts on its own, and MoltenTerm commits nothing:

- The first sync of a project, and any change to its `sync`, asks the user to trust the project's commands, like every
  declared command. From a terminal, `molten project sync` cannot trust: it asks the user by a notification and runs nothing.
- MoltenTerm checks the source's watched branch tip out in a worktree of its own (in MoltenTerm's data folder, the
  source's hooks off), then runs `sync` in this repository's root, with:
  - `MOLTEN_DEP_SOURCE_DIR`: that worktree. The user's own checkout of the source may be on another branch, or dirty;
    the worktree is exactly the watched branch's tip. A script that ignores it still runs (reading `../Notulia/`).
  - `MOLTEN_DEP_SOURCE_COMMIT`: the commit checked out there; `MOLTEN_DEP_PROJECT`: the source's name.
- The worktree is removed when the sync ends. One sync runs at a time per repository; each keeps its log and exit code
  in the project's run history.
- Exit 0 with `output` changed: **synced, not committed**, with the changed files; review and commit them, and the flag
  clears once the commit reaches the trunk. Exit 0 with nothing changed: **in sync, no change**: MoltenTerm records it
  in its own data folder and the flag clears for that source commit, without an empty commit (a later change to the
  source's `paths` makes it stale again). Non-zero: the flag stays stale and shows the log and the exit code.
- Without `sync`, the flag says that no sync command is declared, and offers no button.

## Setting the release up: the pipeline setup

The user can also set the `release` and `versions` blocks up from MoltenTerm itself: the Release menu's "Set up the
release" (or "Update the release setup", or "Open the pipeline setup" once it is up to date) opens the pipeline
setup, a stepper of four steps. It never writes the folder opened: everything it changes reaches the repository
through a draft pull request it opens from a worktree of its own (or a patch to copy when `origin` is not on GitHub),
and the Release menu uses the pipeline once that pull request is merged.

1. **Detect.** The app type (desktop app, command-line tool / npm package, web app / SaaS, library, something else)
   from the build files, and whether the project already ships: version tags, GitHub releases, workflows publishing on
   a tag, changelogs with dated sections, this file. It recommends 2a when the project ships, 2b otherwise.
2. **Understand.**
   - 2a, analyse: the existing pipeline drawn, with numbered points ("what we understood"), each with its source,
     confirmed or adjusted; the points marked "to confirm" must be answered before step 3. For a project already set
     up, 2a is the update: the declared pipeline drawn with a badge on each change this version of MoltenTerm proposes,
     each change taken or kept.
   - 2b, describe: start from a saved template, another linked project as a model, MoltenTerm's standard pipeline or
     the user's own words; then the questions (the trunk, the published branch, where versions are published, a release
     candidate: none, published under a pre-release tag, or internal). A missing publish workflow is proposed as a file
     of the same pull request.
3. **Prepare and validate.** The result drawn (steps added marked `+`, changed `~`), the exact changes file by file
   (one row per release step added, changed or removed, each `versions` field; every other key of this file stays byte
   for byte), `.molten/release-setup.json` (the steps MoltenTerm wrote, so a later update tells them from the user's),
   the technical documentation, the commands that will ask for trust once merged, and the pull request followed until
   it is merged. The coding agent may be asked for a proposal here (below).
4. **Template** (optional): save the pipeline on this computer, to set it up on the user's other projects of the same
   type.

**Agent proposals.** "Ask the agent for a proposal" (step 3, for a new setup and for an update) sends the project's
coding agent, read-only, a request for step changes: answer with a JSON object `{"changes": [...]}`, each change
`{"op": "add" | "change" | "remove" | "versions", "channel": "rc" | "public", "id": "<step id>", "after" | "before":
"<step id>", "step": {...}, "versions": {...}, "why": "..."}`, never a whole file. Only `release` steps and the
`versions` block can change; a change outside them, or one that would make the file invalid, is dropped and listed.
Each kept change is a card the user ticks. Any other agent can answer the same request: the user copies it and pastes
the answer back. With no coding agent installed, the setup says so at step 3 and the copy and paste stays offered.

**The technical documentation** (`docs/engineering/release-pipeline.md`, or the page of the project's documentation
backend) is generated from the pipeline with each setup or update, never by hand. It is written in the project's
documentation language, `.saasfoundry.json` → `language.srs` (English and French; any other language, or none
declared, writes English).

**When something is missing,** the setup says what happened, what still works and what to do next, and only blocks
what the system refuses:

- nothing to read (no build file, workflow or tag): describe the pipeline, or start from a saved template;
- GitHub not reachable (`gh` not installed, signed out, or failing): the published branch's protection is assumed to
  require a pull request and marked to confirm; `gh auth login` in a terminal, then "Read again", or go on;
- not a git repository, or no `origin`: the pipeline is still prepared; the pull request needs both, the patch only a
  commit;
- this file not valid: its validation errors, to fix first (`molten project validate`); the setup reads the committed
  file and builds nothing on an invalid one;
- uncommitted edits of this file: the setup reads the committed file, never overwrites the edits, and can include
  them as changes to check;
- the base moved since the draft (`origin` changed this file), or a branch of the same name already exists on `origin`:
  nothing is pushed; prepare again, or use another ticket.

## The release contract

A release is started from the Project tab's Release menu (a release candidate `X.Y.Z-N`, or a public release `X.Y.Z`)
and followed in the Project tab through five phases. Every declared step runs, in its declared order within its phase,
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
- Every later step waits for the user's click in the Project tab. Only the next step of the current phase is offered;
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

### Generic release commands

A project without release scripts of its own can call `molten release`, which reads everything from
`.molten/project.json`: `branches` (trunk and release branch), `versions.files` (where the version is written),
`versions.tagprefix` and `versions.notes`. Each command follows the rules above: non-interactive, safe to run again,
and the cut is prepared in a release worktree beside the main checkout (`../<repo>-release`), never in the checkout.

| Command | Phase | What it does |
| --- | --- | --- |
| `molten release promote --workflow <file>` | `prepare` | Brings the trunk onto the release branch: a fast-forward, else a merge commit, refused when the result's tree differs from the trunk's (a release commit not carried back). The named GitHub workflows must be green on the trunk's commit: a missing run is started and waited for (up to 90 minutes), a red one stops the promotion. Pushed without force. `--dry-run` pushes and starts nothing. |
| `molten release prepare {tag}` | `prepare` | Checks the tag (a release of the project, the next candidate number, above the last public release, not taken here or on origin), writes the version in every `versions.files` place (read back), writes the engineering record (`.internal.md`: the tickets the commits since the previous release claim, with their titles, the milestone's closed issues, the commits claiming no ticket) and the public notes, unless the release branch already has them (then it only stamps their `date`): written by `versions.notesagent` from the record and audited, else (no agent, two refused attempts, or `MOLTEN_RELEASE_NOTES_AI=off`) the conventional commit subjects (`feat` under New; `fix`, `perf`, `revert` under Fixed; no scope, no ticket number). Announces them with `▶ notes:`. Commits nothing. |
| `molten release notes {tag}` | none, `notes: true` | Rewrites the record and the public notes of the prepared release (`--plain`: from the commit subjects). `--check` only audits them as finalize does. In a terminal, it then offers accept, edit, redo, plain or quit. |
| `molten release finalize {tag}` | `cut`, with `confirm` | Checks the prepared tree again (the version read back, only the release files changed, the release branch not moved, the notes present, not a draft and accepted by the audit: no ticket reference, no link into the repository, no commit or ticket count, at most 25 non-empty lines), commits `chore(release): {tag} (rc\|public)`, tags it and pushes the release branch and the tag atomically. A refused push undoes the local commit and tag, so the step can be run again. |
| `molten release prepare {tag} --pr` | `prepare` | For a release branch that takes pull requests only (a ruleset or a branch protection requiring a pull request or checks, nobody able to bypass it): the same checks, bump and notes, on the RC branch (`.saasfoundry.json` `workflow.branchNaming.release`, else `rc-{version}`, `{version}` being X.Y.Z) made from the trunk as origin has it. When the release branch is not in the RC branch's history, it is merged in first if that merge is clean and changes no file of the trunk (after a release by pull request: the same release commit on both sides); else it says so, for the reconciliation. |
| `molten release reconcile {tag}` | `prepare`, after `prepare --pr` | When the release branch and the trunk diverged although every commit of the release branch has its equivalent on the trunk (`git cherry`), merges the release branch into the RC branch with `-s ours`: the tree stays the trunk's and the pull request merges. Refused, naming them, when a commit of the release branch has no equivalent on the trunk. Nothing when the release branch is already in the RC branch's history (the usual case once releases come back by merge commit), so the step stays in the pipeline for good. |
| `molten release open-pr {tag}` | `cut`, with `confirm` | Checks the prepared tree as finalize does, commits `chore(release): {tag} (rc\|public)` on the RC branch, refuses (undoing the commit) when the RC branch does not hold the release branch, which GitHub's strict checks require, pushes the RC branch (`--force-with-lease`) and opens its pull request to the release branch, titled like the commit (or updates the open one); when the commits name the release's ticket, the body holds one `Closes #ticket` line, alone. `merge-pr` keeps GitHub's own merge message. |
| `molten release merge-pr {tag} [--method merge\|squash\|rebase]` | `cut`, with `confirm` | Waits for the pull request's required checks (`gh pr checks --required`, up to 90 minutes) and for GitHub to let it merge, then merges it (`--merge` by default, `--match-head-commit`). A failed check, a branch behind its base or a conflict stops it; an already merged pull request is reported as merged. The `confirm` is the developer's approval of the merge. |
| `molten release tag {tag}` | `cut`, with `confirm` | Finds the commit the merged pull request left on the release branch (the merge commit), reads the version back from it, tags it and pushes the tag only. |
| `molten release tag {tag} --rc-branch` | `cut`, with `confirm` | For a release candidate nothing publishes (no publish workflow starts on its tag; tests may still run on it): commits the prepared release on the RC branch and pushes the branch and the tag on its head together. Nothing reaches the release branch or the trunk; the labels bumped to the candidate's version stay on the RC branch, and the public release sets them to its own. |
| `molten release sync-back {tag} --merge` | `back`, with `confirm` | Opens the pull request of the release branch itself into the trunk (no intermediate branch, no closing keyword) and merges it with a merge commit once its required checks are green, never squash or rebase: the merge's second parent is the release's own merge commit, and the release branch becomes part of the trunk's history. Stops, saying why, when the release branch moved past the tag, or when the trunk's strict checks want the release branch brought up to date (its rules take pull requests only). Nothing when the trunk already holds the tag. |

Commits the chain makes follow the project's commit convention: when `.saasfoundry.json` `workflow.commitFormat.requireTicket` is set, or a commitlint config wants a `(#N)` scope, they read `chore(#N): release v1.2.0`, `chore(#N): sync release candidate with master`, within commitlint's header length. The ticket is `--ticket N`, else `MOLTEN_RELEASE_TICKET`, else the issue of the version's milestone titled "Release vX.Y.Z". Every release commit carries a `Molten-Release: {tag}` trailer. When the project's git hooks need its dependencies (husky, lefthook, commitlint, lint-staged), `prepare` installs them in the release worktree first: `ci.prepare`, else the package manager's clean install read from the lockfile. `close-milestone` waits until every run the tag started ended green (an environment approval keeps it waiting) and the GitHub release, if any, is published. The files the chain writes or commits (the notes, the engineering record, `versions.changelogs`, the version files) go through the project's formatter in the release worktree, after `prepare` and `notes` wrote them and again before the `finalize`, `open-pr` and `tag --rc-branch` commit, so a CI that checks the formatting stays green: `versions.format` when declared, else the project's prettier (a prettier config, or prettier in package.json) from its `node_modules` (installed as for the git hooks when missing). Each pass prints `▶ format: formatted <formatter>`, `▶ format: none` or `▶ format: failed <command>`; the release panel says, before the commit, when no formatter was found or it failed. A missing or failing formatter never stops the chain.
| `molten release close-milestone {tag}` | `publish` | For a public release whose GitHub release is published: closes the open milestone named after its version (or its line, `v1` for 1.x.y), listing its open issues as a warning. A release candidate leaves the milestone open. |
| `molten release sync-back {tag}` | `back` | Cherry-picks the release commit (for a tag on a pull request's merge commit, the release commit it merged) onto the trunk in `chore/sync-back-{tag}`, pushes it and opens the pull request (or reuses the open one); nothing when the trunk already has it. |
| `molten release dispatch <file> [--ref <branch or tag>] [--field key=value]` | `publish`, or a `cd` step | Starts a GitHub workflow by `workflow_dispatch` on the trunk (or `--ref`, e.g. `{tag}` for a docs deploy at the release), follows the run it started to its end (up to 90 minutes) and fails when it fails. While a job waits for an environment's approval it prints `▶ approval: <environment> <run url>` (then `▶ approved: <environment>`): the release panel shows "Waiting for approval of <environment>" with the link. |
| `molten release rehearse --workflow <file> [--ref <branch>] [--field key=value] [--download <folder>]` | a `cd` step, outside the release | Builds the release files without a tag, to install and check them before a release: starts the project's release workflow by `workflow_dispatch` on the trunk (or `--ref`), waits for it (up to 90 minutes), then lists the run's artifacts and their expiry, and with `--download` fetches them into `<folder>/<short commit>/`. The workflow must publish nothing when dispatched. Run again on the same commit, it follows the rehearsal still running, or reuses the green one whose artifacts are still there; a run with `--field` is always a new one. |

`molten release plan [--rc|--public] [--version X.Y.Z] [--json]` shows what the Release menu would start: the tag,
the milestone it ships and the milestone's open issues. A finished milestone comes first: an open milestone naming a
version above the last public release, with every issue closed and no tag yet, is the release proposed (the lowest of
them), and the version the commits suggest is shown beside it as a note when it differs, never in its place; a
milestone with open issues is never proposed over the commits. `--version` always wins. Off GitHub, nothing waits for CI, opens a pull request or
closes a milestone. Steps run by Mission Control find `molten` first on their PATH: it is the running app's own.

## Ids

Ids (`name` of a job, `id` of a build or step) are lowercase letters, digits, `.`, `_` and `-`, unique in their list.
