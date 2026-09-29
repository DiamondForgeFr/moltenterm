---
status: Spawning (drafting lifecycle — board column stays "In progress" → "Done" on transition-drafting done)
banner_ai: Spawn child tickets from the approved FR pages, then move the drafting ticket to Done
banner_human: Nothing — children land in Backlog for later prioritization
complexity_profiles: [srs-drafting, srs-update, srs-new]
entry_conditions:
  - `3b-human-review.md` complete — owner approval signalled
  - Backend page is stable
  - Ticket still carries its `srs:*` label
mandatory_actions:
  - Run the spawner with the feature target and a verified reconciliation plan
  - Verify children (titles, empty complexity tags, back-links to the backend page)
  - Move the drafting ticket to Done via `transition-drafting <ticket> done`
exit_conditions:
  - `srs-cli.sh spawn` exited 0
  - All children exist in Backlog with correct titles and bodies
  - Parent ticket board status is `Done`
next_status: Done — children follow the normal code-path workflow from Backlog
---

# STATUS (drafting lifecycle): Spawning

Turn the approved SRS page into the matching tickets that will drive implementation.

## Action checklist

- [ ] **Record the preflight:** inspect the board, approved SRS version, and implementation; classify every selected FR as `delivered`, `partial`, `missing`, or `superseded` in a version-1 reconciliation JSON file
- [ ] **Preview the spawner:** `.claude/skills/sf-workflow/workflow-cli.sh transition-drafting <ticket> spawning --epic <feature> [--version <version>] [--milestone <release>] --reconciliation-plan <path> --dry-run`
  - dispatches to the SRS CLI with the drafting ticket fixed as the delivery parent
  - blocks on unavailable evidence, incomplete coverage, conflicting FR identities, ambiguous matches, or implicit reparenting
- [ ] **Apply the reviewed plan:** rerun the exact command without `--dry-run`
  - renders ticket templates from `sf-srs/templates/tickets/` (Epic or Story)
  - skips delivered/superseded FRs, reuses canonical tickets, and creates only remaining children in **Backlog**
- [ ] **Verify the children:** `github-projects-cli.sh list-incomplete-children <ticket>` — every newly spawned child must appear with its title and Backlog status; then inspect its backend-page link
- [ ] **Complete the drafting lifecycle:** `.claude/skills/sf-workflow/workflow-cli.sh transition-drafting <ticket> done` — internally calls `update-status <ticket> Done` with
      `SF_WORKFLOW_BYPASS_SRS_GUARD=1`
  - keeps the `srs:*` label as durable provenance; it does not use raw provider commands to rewrite labels

## Errors to avoid

- Spawning before approval
- Spawning without verified board, SRS, and implementation evidence
- Retrying with a changed plan after an uncertain create response — retry the same command so canonical recovery can finish safely
- Editing children to paste code-path statuses — leave them in `Backlog`, the team sequences them normally
- Moving the drafting ticket by hand with `update-status <ticket> Done` — the dedicated transition keeps the lifecycle explicit
