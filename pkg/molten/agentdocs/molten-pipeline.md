# molten-pipeline: connect a project to Mission Control

The user asked you to connect the project in the current folder to MoltenTerm's Mission Control:

{{REQUEST}}

Mission Control shows a project's timeline, CI and releases, and runs the project's own pipeline: local CI, local
builds (the "gold" build the user keeps), release candidates and public releases. It learns the pipeline from one
file, `.molten/project.json`, which you write. You **connect** what the project already has; you **create** only
what is missing, and only after the user agreed.

## Steps

1. Check that you run inside MoltenTerm: `molten help` must work. If `molten` is not found, tell the user to run
   this request from a MoltenTerm terminal, and stop.
2. Read the format: run `molten docs`, then read `pipeline-format.md` in the folder it prints.
3. Link the workspace if it is not: `molten project show --json`; when it says the workspace is not linked, run
   `molten project link` from the project's folder.
4. Detect the project's harness and follow it for everything you change:
   - `.saasfoundry.json` (SaaSFoundryAI): its `workflow` gives the working branch, the pull request target, the
     branch naming (`feature/{N}-…`) and the commit format (`type(#N): …`, ticket required). Changes go through a
     ticket, a branch and a pull request as that workflow says; read the project's own skills and CLAUDE.md or
     AGENTS.md before acting.
   - Otherwise `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`: follow what they ask.
5. Inventory what exists, before proposing anything:
   - scripts: `package.json` scripts, `Taskfile.yml`, `Makefile`, `justfile`, `scripts/`;
   - CI: `.github/workflows/*.yml` (what runs on pull requests, on tags, on a schedule);
   - builds and releases: build scripts, where the build puts its result, release or version-bump scripts, tags
     (`git tag -l`), release notes (`releases/`, `CHANGELOG.md`).
6. Map it onto the pipeline (see `pipeline-format.md`):
   - `ci.jobs`: the checks a developer runs before pushing (typecheck, lint, tests, build), reusing the commands
     the GitHub workflows already run, split into lanes that may run side by side;
   - `builds`: the local builds the user installs (`gold` at least when the project ships an app), with where the
     result lands (`artifact`);
   - `release.rc` and `release.public`: the steps that cut, build and publish a version, in order;
   - `steps`: anything else project-specific the user wants in a panel.
   - `icon`: the project's square app icon (not a wide logo), relative to the project folder, when it is not at a
     usual place such as `icon.svg` or `build/icon.png`.
7. Show the user the mapping and what is missing. Propose the smallest additions (for example a `scripts/ci-local.sh`
   running the same checks as the GitHub workflow), and ask before creating anything. Never invent a release
   process: when the project has none, leave `release` out and say so.
8. Make the agreed changes the way the harness asks (ticket, branch, commits, pull request when it says so).
9. Write `.molten/project.json` last, then run `molten project validate`. Fix every error it names until it says
   the pipeline is valid. Do not run the declared commands to "test" them: Mission Control runs them, through the
   user's trust prompt.
10. Report: what you connected, what you created, what is still missing, and tell the user that Mission Control's
    Timeline and CI/CD panels now show the pipeline (open them from the "+" button).

## Rules

- `.molten/project.json` describes commands; it never holds a secret, a token or a password. Commands use the
  user's own tools (`gh`, the package manager) already signed in.
- Keep `branches` out of the file when `.saasfoundry.json` declares them: Mission Control reads them from there.
- Commands run from the project's root unless `cwd` says otherwise; keep `cwd` inside the project.
- Prefer the project's existing entry points (`bun run check`, `task build`, `./scripts/release.sh`) over long
  inline shell lines.
- Steps that push, tag or publish are fine to declare: MoltenTerm always asks the user before running a release
  step.
- Read `molten` output with `--json`.
