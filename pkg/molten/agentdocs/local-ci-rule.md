In a project with a `.molten/project.json` that declares `ci.jobs`, run the local CI through MoltenTerm, not by typing
the declared commands in your shell: `molten ci run [branch] [--only <job,job>] [--force]` starts it in Mission
Control (the run shows in the CI/CD panel), waits for the verdict and exits 0 when green and 1 when red. Read the
verdict of a revision with `molten ci status [rev]` (exit 0 green, 1 red, 2 not run yet; `--json` for a script).
Do this for every test run before you push or ask for a human test. A branch checked out in another worktree works:
name it. Fall back to the declared commands only when `molten` is not available.
