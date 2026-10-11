# Performance harness

`scripts/perf/` measures MoltenTerm the way the performance audit (#445) did, but repeatably: it launches the built
app in throwaway directories, runs scenarios, writes a JSON and Markdown report, and compares every metric with the
budgets in `budgets.json` and with a stored baseline (FR-PERF-006, NFR-PERF-001 to NFR-PERF-007).

## Commands

| Command            | What it does                                                                                  | Time    |
| ------------------ | --------------------------------------------------------------------------------------------- | ------- |
| `task perf`        | Builds the app (`build:backend`, `npm run build:prod`) and runs every scenario, full sampling | ~15 min |
| `task perf:quick`  | Same scenarios, fewer samples and shorter settles; good for iterating, not for a PR report    | ~6 min  |
| `task perf:ci`     | The CI subset (bundle, JS evaluated, start-up smoke, leaks), gated like CI                    | ~2 min  |
| `task perf:bundle` | Builds the frontend and checks the bundle budgets only                                        | ~1 min  |

Arguments after `--` go to `perf.mjs run`, for example `task perf -- --scenarios startup,session --out /tmp/before`.
Without building first: `node scripts/perf/perf.mjs run --profile full`.

| Option             | Meaning                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------- |
| `--profile`        | `full` (default), `quick` or `ci`                                                                       |
| `--scenarios a,b`  | Subset of `bundle`, `startup`, `session`, `leaks`, `load`, `mods`                                       |
| `--out dir`        | Report folder (default `dist/perf/<timestamp>-<profile>/`): `report.json`, `report.md`, trace           |
| `--gate ci\|local` | Exit 1 when a gated metric fails (or a scenario fails); without it the run only reports                 |
| `--baseline file`  | Compare with another report instead of the stored baseline (a "before" run, for instance)               |
| `--tmp dir`        | Where the throwaway roots are created (default `/tmp`; keep it short, wavesrv's socket path is limited) |
| `--keep`           | Keep the roots (logs, data) after the run for debugging; processes are still stopped                    |
| `--id name`        | Report id (default: the short commit)                                                                   |

Other commands:

- `perf.mjs check <report.json> [--scope ci|local] [--baseline file] [--md out.md]` re-evaluates a report.
- `perf.mjs compare <a.json> <b.json>` compares two runs of the same build and flags each metric whose medians differ
  by more than the noise threshold (FR-PERF-006-AC3).
- `perf.mjs baseline <report.json> --id <name>` stores a report under `baselines/` and points `budgets.json` at it.

## Isolation and clean-up

Each scenario creates its own root, `/tmp/mtperf-XXXXXX`, with `data/` and `config/` passed as `MOLTENTERM_DATA_HOME`
and `MOLTENTERM_CONFIG_HOME` (`MOLTENTERM_HOME` points at a path that never exists, so a legacy home cannot be picked
up), free ports for `--remote-debugging-port` and the main process `--inspect`, `WAVETERM_NOCONFIRMQUIT=1` and
`MOLTENTERM_SKIP_ONBOARDING=1`. The root holds a marker file naming it; the harness refuses to launch on or delete a
directory without its marker, so it never touches the user's data, the dev instance (`moltenterm-dev`) or a gold.

It stops only what it started: the Electron pid it spawned, the process tree captured under it (a pid is killed only
while it still runs the same command) and processes whose command line holds its own root (durable shells, `wsh`
job managers). The busy `yes` processes of the load scenario are its own children. All of this runs in `finally`
blocks, on exit, on Ctrl-C/SIGTERM/SIGHUP and on a crash, then the root is deleted. A failing scenario is recorded in
the report and the next one still runs.

## Scenarios

| Scenario  | Measures                                                                                                                                                                                                                                                                                                    |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bundle`  | `dist/frontend`: JS raw and gzip, CSS, and the JS `index.html` loads up front (entry script + modulepreloads)                                                                                                                                                                                               |
| `startup` | Fresh (cold) and warm launches: launch → wavesrv ready, Init Bare, wave-ready, first tab view init (from `waveapp.log`), JS evaluated by the visible tab view (CDP `Debugger.scriptParsed`)                                                                                                                 |
| `session` | One instance: idle at 1 workspace (visible, then minimised; CPU, memory, renderer metrics and a short trace over CDP), 5 creates, idle at 3 workspaces, relaunch, switches to never-visited (warm spare) and visited workspaces, idle at 6 workspaces with memory per tab view, deletes, create/delete race |
| `leaks`   | 4 creates and 4 deletes, then create/delete loops (views counted after 5, memory over 20; the `ci` profile runs 5): tab views left for deleted workspaces, memory growth per loop                                                                                                                           |
| `load`    | Launch with N busy processes (12 in `full`): time to the first tab, and whether the window is left without a tab view                                                                                                                                                                                       |
| `mods`    | Idle CPU and memory with the built-in mods on and off (`molten/mods.json` disables `copy-box`)                                                                                                                                                                                                              |

Measurement protocol (DS-PERF-001): idle CPU is the whole process tree in % of one core, from cumulative CPU time
(`ps` on macOS, `/proc` on Linux) over consecutive 5 s intervals after a settle (60 s and 12 samples in `full`), the
median reported; memory is macOS `footprint` (phys_footprint) per process, Linux PSS, RSS elsewhere; each tab view's
renderer is attributed through the main process (`webContents.getOSProcessId()`). Workspace operations are timed from
the preload call to the expected tab view on screen, read by a 4 ms poll in the main process (stopped while idle CPU
is sampled); the create and delete samples of `session` and `leaks` are pooled for their p95, and an operation that
never reaches the screen within 30 s counts in `ws.failedOps` instead. Memory is sampled 4 times per condition. The
launched window may take the focus; the harness never forces it, and the focus state of every idle
sample is in the report.

## Budgets and the gate

`budgets.json` is the one place budgets live. Each metric has its NFR, a budget (or `null`), a tolerance (10 % by
default), a noise floor, and a gate:

- `ci`: machine-independent (bundle, JS evaluated, failed launches, views left after 4 deletes). Gated in CI and
  locally.
- `local`: measured on a machine (CPU, memory, latencies). Gated only by `--gate local`, against a baseline taken on
  the same machine.
- `info`: reported only.

A gated metric fails when it regresses from the baseline by more than its tolerance (and its noise floor), or when it
exceeds its budget, unless the baseline was already over the budget and it did not regress: a target not met yet is
grandfathered until the story that meets it stores a new baseline, and from then on the budget holds. A metric whose
samples disagree (split-half medians more than 10 % and more than the floor apart) is flagged **noisy** and never fails
the gate; rerun it. Changing a budget, a tolerance or the baseline needs a reason in the pull request.

The first baseline, `baselines/75f1354a.json`, is a full run of origin/develop 75f1354a (the audit's commit) on an
Apple M1 Max, 64 GB, while other workloads were running (load average 5 to 8): idle CPU is flagged noisy in it. A
second full run of the same build is compared with it in the pull request of #452. Local metrics are only comparable to it on that machine;
on another machine, take your own "before" report and pass it with `--baseline`.

## CI

The `Perf budgets` job of `.github/workflows/ci.yml` (ready pull requests and pushes) builds the app, runs
`perf.mjs run --profile ci --gate ci` under Xvfb, writes the report to the job summary and posts it on the pull request
as one comment it keeps up to date. It fails when a `ci` metric breaks its budget or regresses, or when the app does
not start. Times appear in the report but are not gated there.

## Performance pull requests (FR-PERF-007 and later)

Every FR-PERF story attaches a before and an after report (NFR-PERF-007):

1. On the base commit: `task perf -- --out /tmp/perf-before --id before`.
2. On the branch: `task perf -- --out /tmp/perf-after --id after --baseline /tmp/perf-before/report.json`.
3. Paste both `report.md` (or the after report, which shows the delta from before) in the pull request.
4. When the story meets a target or moves a metric for good, store the after run as the new baseline
   (`perf.mjs baseline /tmp/perf-after/report.json --id <short commit>`) in the same pull request, with the reason.

Run on an otherwise quiet machine and compare runs made under the same conditions; `compare` tells which metrics a
rerun would move by more than 10 %.
