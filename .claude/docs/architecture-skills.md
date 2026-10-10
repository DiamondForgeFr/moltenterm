## Skills Architecture (CRITICAL — Read when adding/modifying Skills)

SaaSFoundryAI integrates **Claude Code skills** into generated projects. All skills are prefixed with `sf-` to avoid conflicts with users' global skills.

### Skill Types & Classification

| Type                            | Location                                                | Credentials | Multi-Account | Examples                                                                          |
| ------------------------------- | ------------------------------------------------------- | ----------- | ------------- | --------------------------------------------------------------------------------- |
| **Core Skills**                 | `skills-templates/core/`                                | ❌ No       | ❌ No         | `sf-git-commit`, `sf-utils-fix-errors`, `sf-integration-rules`                    |
| **Tool Skills (Public API)**    | `skills-templates/optional/`                            | ❌ No       | ❌ No         | `sf-tool-context7`                                                                |
| **Tool Skills (Auth Required)** | `skills-templates/tools/`, `skills-templates/optional/` | ✅ Yes      | ✅ Yes        | `sf-tool-github-projects`, `sf-tool-notion`, `sf-tool-atlassian`, `sf-tool-figma` |

### Architecture Patterns

Every skill has one source under `scaffolds/skills-templates/`; installers copy it into the generated project's `.claude/skills/<name>/` (tool skills as `sf-tool-<name>`). No blueprint carries a
skill.

#### 1. Multirepo Structure

Each repository is a root: `apps/<project>-api/.claude/skills/` and `apps/<project>-web/.claude/skills/` each receive the core skills.

#### 2. Monorepo Structure (Centralized)

A single `.claude/` at the repository root holds every skill; `apps/api` and `apps/web` have no `.claude/` of their own.

### Current Skills Inventory

#### Core Skills (7 total)

- `sf-git-commit` - Quick commit and push
- `sf-git-create-pr` - Create pull requests
- `sf-git-fix-pr-comments` - Implement PR feedback
- `sf-git-merge` - Rebase the ticket branch on the PR target branch
- `sf-utils-fix-errors` - Fix ESLint/TypeScript errors
- `sf-utils-fix-grammar` - Fix spelling/grammar
- `sf-integration-rules` - Integration grammar of the generated stack (left out on a project without a technical stack)

#### Tool Skills (4 total)

- `sf-tool-context7` - Library documentation (free public API, no credentials)
- `sf-tool-atlassian` - Jira/Confluence integration (requires credentials)
- `sf-tool-notion` - Notion workspace integration (requires credentials)
- `sf-tool-figma` - Figma design system integration (requires credentials)

#### SRS Host Skill (agnostic, backend-dispatched)

- `sf-srs` — Software Requirements Specifications host. Reads `.saasfoundry.json → tools.srs.backend` and routes drafting / spawning / evaluation through the matching `SrsAdapter` implementation in
  `src/srs/`.
  - Bundle: `.claude/skills/sf-srs/` (SKILL.md + `scripts/srs-cli.sh` + `scripts/drafters/` + `templates/`)
  - Scaffold source of truth: `scaffolds/skills-templates/sf-srs/` (drift-guarded in `tool-skill-drift.spec.ts`)
  - Installer: `src/installers/srs-skill.installer.ts` copies the bundle and preserves the `srs-cli.sh` executable bit
  - Backend registry: `src/srs/registry.ts` + `src/srs/factory.ts` (`createSrsAdapter`, `SrsConfigError`)
  - Current backends: `notion` (ships); `confluence`, `local-markdown` are future additions that register via `src/srs/<name>-backend.ts` without touching the agnostic surface.
  - Notion-import guard: `src/__tests__/unit/srs/no-notion-leak.spec.ts` — only `src/srs/notion-backend.ts` may import `@notionhq/client` or `../tools/notion`.

### Multi-Account Credential System

**Only applies to Tool Skills with authentication** (atlassian, notion, figma).

#### Architecture

- **Centralized storage**: `~/.claude/credentials/{tool}/{account}.env`
- **Project configuration**: `.saasfoundry.json` → `skillsAccounts: { tool: "account" }`
- **CLI management**: `sf tools` command (list, accounts, add, use, current)

#### Credential Loading (in CLI scripts)

Each tool skill's CLI script (`{tool}-cli.sh`) loads credentials in this order:

1. Check if in a SaaSFoundryAI project (`.saasfoundry.json` exists)
2. Read configured account from manifest → `skillsAccounts.{tool}`
3. Load from `~/.claude/credentials/{tool}/{account}.env`
4. Fallback to local `.env` file in skill directory
5. Error if no credentials found

#### Files Involved in Multi-Account System

| File                                                    | Purpose                            | When to Modify                                        |
| ------------------------------------------------------- | ---------------------------------- | ----------------------------------------------------- |
| `src/commands/tools.ts`                                 | CLI command implementation         | Adding new tool with credentials                      |
| `src/prompts/skills.prompts.ts`                         | Credential collection prompts      | Adding new tool with credentials                      |
| `src/prompts/update.prompts.ts`                         | Update command credential flow     | Adding new tool with credentials                      |
| `src/types.ts` → `SaaSFoundryManifest.skillsAccounts`   | Manifest type definition           | Adding new tool with credentials                      |
| `scaffolds/skills-templates/tools/{name}/{name}-cli.sh` | CLI script with credential loading | Adding new tool OR modifying credential loading logic |

### Skill Installation System

Skills are installed via `src/installers/skills.installer.ts`:

```typescript
export async function installSkills({
  isMonorepo,
  apiPath,
  webPath,
  selectedSkills,
  credentials
}) {
  if (isMonorepo) {
    // Install once at root (centralized)
    await installSkillsAtRoot({ ... })
  } else {
    // Install separately for API and Web
    await installSkillsForApp({ appPath: apiPath, ... })
    await installSkillsForApp({ appPath: webPath, ... })
  }
}
```

**Key points**:

- Core skills are ALWAYS installed
- Tool skills are OPTIONAL (user selects during `sf new` or `sf update`)
- Credentials are stored in skill's `.env` file during `sf new`
- Users can later switch accounts via `sf tools use`

### Adding a New Core Skill — Checklist

**Core skills** = methodology/utility skills with no external dependencies (e.g., git workflows, code quality)

1. **Create skill directory** in `scaffolds/skills-templates/core/sf-{skill-name}/`

   - `SKILL.md` - Skill documentation and instructions
   - Any supporting scripts/files

2. **Register it** in the `coreSkills` list of `src/installers/core-skills.installer.ts` (and in `STACK_SKILLS` if it only applies to the generated stack)

3. **Update the `.claude/README.md` templates** (`scaffolds/blueprints/{api,web}/.claude/`, `scaffolds/overlays/monorepo/root/.claude/`)

   - Add the skill to the structure and the skill list

4. **Update the CLAUDE.md templates**

   - Add skill to the skills section of the API, Web and monorepo root templates
   - Update skills priority section if needed

5. **Update `docs/skills/core-skills.md`** (and its French mirror)

6. **Test**
   - Generate a multirepo project → verify skill in both api/.claude/ and web/.claude/
   - Generate a monorepo project → verify skill in root/.claude/
   - Test skill invocation in generated project

### Adding a New Tool Skill (Public API) — Checklist

**Tool skills with public API** = no credentials required (e.g., context7)

1. **Create skill directory** in `scaffolds/skills-templates/tools/{name}/` (installed as `.claude/skills/sf-tool-{name}/`)

   - `SKILL.md` - Skill documentation
   - `{name}-cli.sh` - CLI script (no credential loading needed)
   - `.env.example` - Empty or info message (no credentials needed)

2. **Duplicate to Web blueprint**

3. **Add to monorepo overlay**

4. **Update skill prompts** in `src/prompts/skills.prompts.ts`

   - Add to `promptAdvancedSkills()` choices
   - Add label `[free, no credentials]`
   - Create `prompt{Name}Credentials()` that returns empty object with info message

5. **Update update prompts** in `src/prompts/update.prompts.ts`

   - Add to skill descriptions in `getAvailableModules()`
   - Add label `[free, no credentials]`
   - Add case in `getSkillCredentials()` to return empty object

6. **Update skills installer** in `src/installers/skills.installer.ts`

   - Add skill to detection/installation logic if needed

7. **Update documentation**

   - README.md
   - Blueprint CLAUDE.md files

8. **Test**
   - Generate project with skill → verify no credentials prompted
   - Test CLI script works without `.env` file

### Adding a New Tool Skill (Auth Required) — Checklist

**Tool skills with authentication** = requires API tokens/credentials (e.g., atlassian, notion, figma)

1. **Create skill directory** in `scaffolds/skills-templates/tools/{name}/` (installed as `.claude/skills/sf-tool-{name}/`)

   - `SKILL.md` - Skill documentation
   - `{name}-cli.sh` - CLI script with multi-account credential loading
   - `.env.example` - Example credentials format

2. **Implement multi-account credential loading** in `{name}-cli.sh`

   ```bash
   load_credentials() {
     local TOOL_NAME="{name}"
     local CREDENTIALS_DIR="$HOME/.claude/credentials/$TOOL_NAME"
     local MANIFEST_PATH=".saasfoundry.json"

     # Check for project-level account configuration
     if [[ -f "$MANIFEST_PATH" ]]; then
       ACCOUNT_NAME=$(python3 -c "...")
       if [[ -n "$ACCOUNT_NAME" ]]; then
         CREDENTIALS_FILE="$CREDENTIALS_DIR/$ACCOUNT_NAME.env"
         if [[ -f "$CREDENTIALS_FILE" ]]; then
           source "$CREDENTIALS_FILE"
           return
         fi
       fi
     fi

     # Fallback to local .env
     if [[ -f "$SCRIPT_DIR/.env" ]]; then
       source "$SCRIPT_DIR/.env"
     else
       echo "Error: No credentials found. Run: sf tools add {name} <account>" >&2
       exit 1
     fi
   }

   load_credentials
   ```

3. **Duplicate to Web blueprint** (keep CLI scripts in sync)

4. **Add to monorepo overlay**

5. **Add to tools command** in `src/commands/tools.ts`

   - Add `'{name}'` to `validTools` array in `addAccount()`
   - Add case in credential prompting switch
   - Tool will automatically appear in `sf tools list`

6. **Create credential prompt** in `src/prompts/skills.prompts.ts`

   - Create `prompt{Name}Credentials()` function
   - Opens browser to API token page
   - Prompts for all required credentials
   - Returns credential object

7. **Update skill selection prompts** in `src/prompts/skills.prompts.ts`

   - Add to `promptAdvancedSkills()` choices
   - Use clear description (no `[free]` label)

8. **Update update prompts** in `src/prompts/update.prompts.ts`

   - Add to skill descriptions in `getAvailableModules()`
   - Add case in `getSkillCredentials()` to call prompt function

9. **Update types** in `src/types.ts`

   - Add credential fields to `AdvancedSkillCredentials` interface
   - Example:
     ```typescript
     export interface AdvancedSkillCredentials {
       // ... existing
       {name}ApiToken?: string
       {name}OtherField?: string
     }
     ```

10. **Update skills installer** in `src/installers/skills.installer.ts`

    - Add credential writing logic for the new tool
    - Update `.env` file generation

11. **Update documentation**

    - README.md
    - Blueprint CLAUDE.md files
    - This CLAUDE.md (add to Current Skills Inventory)

12. **Test complete workflow**
    - `sf new` → select skill → verify credentials prompted
    - `sf update` → add skill → verify credentials prompted
    - `sf tools add {name} account1` → verify credentials prompted and saved
    - `sf tools use {name} account1` → verify manifest updated
    - Test CLI script reads from centralized credentials
    - Test CLI script falls back to local `.env`

### Modifying Existing Skills

#### When modifying a Core Skill:

1. Update `scaffolds/skills-templates/core/<name>/`, the single source
2. If this repository dogfoods the skill (`.claude/skills/<name>/`), mirror it: `tool-skill-drift.spec.ts` checks the copies
3. Update documentation if behavior changed

#### When modifying a Tool Skill:

1. Update `scaffolds/skills-templates/tools/<name>/` (or `optional/sf-tool-<name>/` for the legacy tool skills)
2. If credential structure changed → update prompts and types
3. If CLI script changed → ensure credential loading logic stays consistent
4. Update documentation

### Important Considerations

**DO**:

- ✅ Always prefix skills with `sf-` to avoid global conflicts
- ✅ Keep API, Web, and Monorepo skills in sync
- ✅ Test both multirepo and monorepo generation
- ✅ Use multi-account system for tools requiring credentials
- ✅ Provide helpful error messages in CLI scripts
- ✅ Document skill purpose and usage in SKILL.md

**DON'T**:

- ❌ Never create skills without `sf-` prefix
- ❌ Don't add tools to multi-account system if they use public APIs
- ❌ Don't modify credential loading pattern without updating all tools
- ❌ Don't forget to update monorepo overlay when changing skills
- ❌ Don't hardcode credentials in skill files
- ❌ Don't ask for credentials for public/free APIs (like context7)

### Tool Skills — Query Strategy Against GitHub Projects V2

The `sf-tool-github-projects` CLI talks to GitHub Projects V2 via the `gh` CLI (GraphQL under the hood). Board-wide scans are forbidden — they scale linearly with team size and exhaust the
5000-point/hour GraphQL budget on active projects. Follow these rules when editing the CLI or adding similar tool skills:

**Targeted queries, never scans**

- Resolve a ticket's project item id + status via `repository.issue(number).projectItems` and filter client-side on `project.number`. O(1) in board size.
- Never use `gh project item-list --limit N` to find a single issue — that's what the #135 refactor killed. It's fine for the `list` subcommand (where a scan IS the user intent) but never inside
  transition commands.

**Schema cache, never state cache**

- Project id, Status field id, and Status option ids change only when the board owner edits them — safe to persist to `/tmp/sf-workflow-cache-$USER/project-<owner>-<number>.json` with a ~1h TTL.
- Item state (Status value, labels, assignees) is modified by every teammate's CLI run — caching it leads to stale reads and silent write conflicts. **Always refetch.**
- Expose a `cache-clear` escape hatch for when the owner renames options mid-hour.

**Dogfood + scaffold parity**

- The in-repo copy at `.claude/skills/sf-tool-github-projects/` and the scaffold template at `scaffolds/skills-templates/tools/github-projects/` must stay byte-identical. A jest drift guard enforces
  this at pre-commit; if you edit one, copy to the other in the same commit.

### Known classifier failure modes (`sf-srs` intent-detector hook, #317)

The `UserPromptSubmit` hook uses a small bash regex classifier in `scripts/detect-eval-signals.sh`. Calibrated against a 64-prompt dataset (`eval-datasets/intent-detector.jsonl`) it currently scores
precision 1.000 / recall 0.938 / F1 0.968 — comfortably past the spec pins (precision ≥ 0.85, recall ≥ 0.70 — "better to miss than to spam"). The two known false negatives are intentional gaps
documented in the dataset and **safe to ignore unless they trip a real workflow**:

1. **FR-language `décision :` (DS marker)** — the DS regex only matches the English `decision:` form. A French prompt like _"décision : les tokens JWT expirent après 15 minutes"_ falls through to
   `none`. Fix: add `décision\s*:` to the DS regex; risk is dragging in opinion phrasings ("c'est ma décision") so test before merging.
2. **FR-language `cas de test` (TC marker)** — the TC regex misses idiomatic FR test phrasings (`cas de test`, `ajouter un test`). Fix: extend the TC regex; same precision risk as above.

Other patterns to **avoid** when extending the classifier:

- **Anchored prefixes win over later content.** The trivial-read-only check (`^(show me|explain|…)`) eats the whole turn. A prompt like _"show me the config and also add a feature to override it per
  env"_ classifies as `trivial` even though the second clause is a real FR. Fixing this means splitting on conjunctions, which is out of scope for the v1 regex classifier — accept it as a known
  limitation.
- **Soft "it'd be nice if…" wishlist phrasings** are intentionally not fired. They are not formal requirements; surfacing them as SRS candidates would balloon the false-positive rate.
- **Bug reports phrased as questions** (`why is X gray?`) are not requirements and must not fire — the regex deliberately has no why/comment-based hook.
- **Revision is checked LAST and stays at confidence=low** so the hook never auto-fires on it. Adding a "revisit" / "actually" rule earlier in the cascade WILL swallow legitimate FR/UR/DS/TC content
  from the same turn. Don't.

Regression guard: `src/__tests__/integration/skill/srs-intent-detector-eval.spec.ts` runs in the default Jest project and fails if precision drops below 0.85 or recall below 0.70. Any change to
`detect-eval-signals.sh` rules must keep both pins or update the dataset to reflect new ground truth.

### Skills Priority in Generated Projects

Generated projects have this note in their CLAUDE.md:

```markdown
## 🎯 Skills Priority

**IMPORTANT**: Always prefer SaaSFoundryAI skills (prefix `sf-*`):

- ✅ Use `sf-git-commit` instead of `git-commit`
- ✅ Use `sf-utils-fix-errors` instead of `utils-fix-errors`
```

This ensures Claude uses project-specific skills over global ones when there are conflicts.
