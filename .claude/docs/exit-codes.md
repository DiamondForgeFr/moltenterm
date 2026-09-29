# Skill CLI Exit Codes

Every SaaSFoundryAI skill CLI (`workflow-cli.sh`, `github-projects-cli.sh`, `srs-cli.sh`, and the TS entrypoints they dispatch to) shares a common exit code taxonomy so that agents and CI pipelines
can react uniformly.

## Canonical codes

| Code | Meaning                             | When                                                                                                                                                                                   |
| ---- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | Success (or "no-op success")        | Operation completed. Includes no-op cases like `eval` finding no FRs, or `list` returning an empty set.                                                                                |
| `1`  | Generic error                       | Unexpected failure: missing dependency (`jq`, `gh`), failed API call, malformed command, filesystem error. Also used by `eval` when `score < threshold` (DRIFT).                       |
| `2`  | Rule / gating refusal               | Caller violated a rule the CLI is enforcing. Today: `github-projects-cli.sh create-subtask` without `--bypass-srs` on an SRS-enabled project (Rule 8). Message prints the remediation. |
| `3`  | Missing manifest configuration      | `.saasfoundry.json` lacks a required field for the requested action. Example: `srs-cli.sh` actions when `tools.srs.backend` is unset.                                                  |
| `4`  | Unknown / invalid manifest value    | A required field is present but carries an unsupported value. Example: `tools.srs.backend: "foo"` when the adapter registry has no `foo`.                                              |
| `5`  | Adapter / integration runtime error | A downstream adapter (Notion SDK, `gh` auth) raised an error that the CLI could not recover from.                                                                                      |

## Per-script mapping

| Script                                                              | Codes in use today           |
| ------------------------------------------------------------------- | ---------------------------- |
| `sf-workflow/workflow-cli.sh`                                       | `0`, `1`                     |
| `sf-tool-github-projects/github-projects-cli.sh`                    | `0`, `1`, `2`                |
| `sf-srs/scripts/srs-cli.sh` (+ TS entrypoints under `src/srs/bin/`) | `0`, `1`, `2`, `3`, `4`, `5` |

## Rules for new CLIs

1. **Prefer `2` for "the CLI said no on purpose"** — reserve `1` for actual errors. This lets agents recognise a rule refusal and try the remediation path (e.g. add `--bypass-srs <reason>`) without
   treating it as a bug.
2. **Print the remediation alongside the error** — every non-zero exit should tell the caller exactly what to do next. Do not rely on callers reading the source to understand the failure.
3. **Never squat codes `3`, `4`, `5` for generic errors** — they are manifest-shape / adapter-specific, used by SRS today. If you need a new category, document it here first.
