# `.saasfoundry.json` — Manifest Schema

Every SaaSFoundryAI skill reads its configuration from a single manifest at the project root: **`.saasfoundry.json`**. This file is the project's source of truth — never hardcode branch names, project
URLs, or backend names inside a skill or script.

## Read snippets (copy-paste for skill scripts)

```bash
# Workflow plumbing
jq -r '.workflow.tool'                .saasfoundry.json   # github-projects | jira | notion | linear
jq -r '.workflow.workingBranch'       .saasfoundry.json   # default branch for feature work
jq -r '.workflow.prTargetBranch'      .saasfoundry.json   # target of feature PRs
jq -r '.workflow.releaseBranch'       .saasfoundry.json   # target of release PRs
jq -r '.workflow.projectUrl'          .saasfoundry.json   # GitHub Projects URL (github-projects only)
jq -r '.workflow.branchNaming.feature' .saasfoundry.json  # e.g. "feature/{N}-{description}"
jq -r '.workflow.commitFormat.pattern' .saasfoundry.json  # e.g. "<type>(#<ticket>): <description>"

# SRS wiring
jq -r '.tools.srs.enabled'            .saasfoundry.json   # true | false
jq -r '.tools.srs.backend'            .saasfoundry.json   # notion | atlassian | local-markdown
jq -r '.tools.srs.rootPage.id'        .saasfoundry.json   # root page / parent container ID
jq -r '.tools.srs.scan.exclude[]'     .saasfoundry.json   # gitignore-style patterns

# Output language of AI-produced artefacts — absent means "en"
jq -r '.language.srs          // "en"' .saasfoundry.json  # SRS pages
jq -r '.language.tickets      // "en"' .saasfoundry.json  # tickets and their comments
jq -r '.language.codeComments // "en"' .saasfoundry.json  # code comments and commit messages
```

## Fields read by each skill

| Skill                     | Field                           | Purpose                                                                                                                                                                                                                                     |
| ------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sf-workflow`             | `workflow.tool`                 | Routes CLI calls to the right tool adapter                                                                                                                                                                                                  |
| `sf-workflow`             | `workflow.workingBranch`        | Default branch for `git checkout -b feature/...`                                                                                                                                                                                            |
| `sf-workflow`             | `workflow.prTargetBranch`       | Default PR target                                                                                                                                                                                                                           |
| `sf-workflow`             | `workflow.branchNaming.feature` | Pattern for feature branches                                                                                                                                                                                                                |
| `sf-workflow`             | `workflow.commitFormat.pattern` | Enforced by commitlint hook                                                                                                                                                                                                                 |
| `sf-tool-github-projects` | `workflow.projectUrl`           | GitHub Projects V2 URL (org or user)                                                                                                                                                                                                        |
| `sf-tool-github-projects` | `workflow.workingBranch`        | Used by `create-pr` to target the right base                                                                                                                                                                                                |
| `sf-tool-github-projects` | `workflow.statuses`             | Status options declared on the board                                                                                                                                                                                                        |
| `sf-tool-github-projects` | `workflow.issueTypes`           | Native GitHub Issue Type chips (sf-epic/sf-story/sf-task/sf-issue) — org-level. The `sf-` prefix avoids collisions with vanilla Epic/Story/Task types defined elsewhere in the org and sidesteps the GitHub-reserved singular `Issue` name. |
| `sf-tool-github-projects` | `tools.srs.backend`             | Enables SRS gating on `create-subtask` (Rule 8)                                                                                                                                                                                             |
| `sf-srs`                  | `tools.srs.backend`             | Resolves which `SrsAdapter` to instantiate                                                                                                                                                                                                  |
| `sf-srs`                  | `tools.srs.rootPage.id`         | Default root container for drafters / eval                                                                                                                                                                                                  |
| `sf-srs`                  | `tools.srs.enabled`             | Gates the conversational eval hook                                                                                                                                                                                                          |
| `sf-srs`                  | `tools.srs.scan.exclude`        | Extra exclusion patterns on top of `.gitignore` + `.srsignore`                                                                                                                                                                              |
| `sf-srs`                  | `language.srs`                  | Language of the SRS pages it writes — absent means `en`                                                                                                                                                                                     |
| `sf-workflow`             | `language.tickets`              | Language of ticket bodies and comments — absent means `en`                                                                                                                                                                                  |
| `sf-workflow`             | `language.codeComments`         | Language of code comments and commit messages — absent means `en`                                                                                                                                                                           |

## Canonical shape

```jsonc
{
  "version": "x.y.z",
  "projectName": "my-saas-app",
  "structure": "multirepo | monorepo | cli",
  // Present only after explicit, fingerprinted adoption of a pre-manifest release.
  "adoption": {
    "kind": "legacy",
    "sourcePackage": "saasfoundry-cli",
    "sourceVersion": "1.0.0-beta",
    "sourceIntegrity": "sha512-...",
    "layout": "multirepo",
    "planFingerprint": "<sha256>",
    // Cleared only after the first current-template comparison succeeds.
    "refreshPending": true
  },
  // Present only in the independent API/web checkouts of a multirepo project.
  // Profile transitions remain coordinated by the root project.
  "projection": { "kind": "multirepo-child", "rootProjectName": "my-saas-app", "app": "api | web" },
  "mainBranch": "main | master", // git main branch chosen at sf new; absent on older manifests — fall back when reading
  // Existing files that matched a technical template during adoption but stay user-owned.
  "unmanagedPaths": ["path/to/pre-existing-compatible-file"],
  "language": {
    // Language of what the AI writes, per surface. Optional, and so is every key:
    // an absent block means English everywhere. Split by surface because a French
    // SRS can legitimately coexist with English code comments.
    "srs": "en",
    "tickets": "en",
    "codeComments": "en"
  },
  "workflow": {
    "tool": "github-projects",
    "template": "SaaSFoundry AI",
    "projectUrl": "https://github.com/orgs/<owner>/projects/<N>",
    "workingBranch": "develop",
    "prTargetBranch": "develop",
    "releaseBranch": "master",
    "branchNaming": {
      "feature": "feature/{N}-{description}",
      "fix": "fix/{N}-{description}",
      "release": "rc-{version}"
    },
    "commitFormat": {
      "pattern": "<type>(#<ticket>): <description>",
      "requireTicket": true,
      "types": ["feat", "fix", "docs", "style", "refactor", "perf", "test", "chore", "ci", "build", "revert"]
    },
    "statuses": [
      { "name": "Backlog", "color": "GRAY" },
      { "name": "Ready", "color": "YELLOW" },
      { "name": "In progress", "color": "BLUE" },
      { "name": "AI testing", "color": "PURPLE" },
      { "name": "Human testing", "color": "ORANGE" },
      { "name": "In review", "color": "PINK" },
      { "name": "Done", "color": "GREEN" }
    ],
    "issueTypes": [
      { "name": "sf-epic", "description": "Grouper for related sf-stories/sf-tasks (no PR, no branch)", "color": "PURPLE" },
      { "name": "sf-story", "description": "Delivers user-observable value", "color": "BLUE" },
      { "name": "sf-task", "description": "Delivers a technical action", "color": "GRAY" },
      { "name": "sf-issue", "description": "Defect or unexpected behavior to investigate and fix", "color": "RED" }
    ]
  },
  "tools": {
    "srs": {
      "enabled": true,
      "backend": "notion",
      "rootPage": { "id": "<uuid>", "url": "https://...", "name": "<human-name>" },
      "scan": { "exclude": ["scaffolds/", "docs/"] }
    },
    "tracker": { "name": "github-projects" },
    "docs": { "name": "notion", "account": "default" },
    "design": [{ "name": "figma", "account": "work" }]
  }
}
```

> `tools.{tracker,docs,design}` is the tools-first selection registry (FR-CONFIG-ENGINE-04): one selected entry-point tool per category (`design` is a list). Additive and optional — readers fall back
> to `workflow.tool` (tracker) and `tools.srs.backend` (docs) when the registry is absent. Connection status (ok/warn) is recomputed live by `sf status`, never persisted here.

## Contract

- **Presence detection** — if `.saasfoundry.json` exists at the working directory root, the repo is a SaaSFoundryAI-managed project. Skills and agents may branch behavior on that alone.
- **Single source of truth** — skills must never persist duplicated values; read the manifest, do not cache in `.env` or per-skill config.
- **Fail closed on missing fields** — scripts exit with a non-zero code and a `jq` `// empty` fallback rather than silently defaulting.
- **Write in the project's language, not the conversation's** — everything an agent produces (SRS pages, tickets, code comments, commit messages) follows `language.*`, which defaults to English. The
  language the user speaks in chat is never the signal: a session held in French still yields English artefacts unless the manifest says otherwise.
