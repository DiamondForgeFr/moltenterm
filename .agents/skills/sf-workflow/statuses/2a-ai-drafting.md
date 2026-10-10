---
status: AI Drafting (drafting lifecycle — board column stays "In progress")
banner_ai: Draft the DraftCandidate[] spec from the ticket, write it through the SRS backend and post the page links on the ticket
banner_human: Wait for the draft — your review comes next (human-review phase)
complexity_profiles: [srs-drafting, srs-update, srs-new]
entry_conditions:
  - Ticket board status is `In progress`
  - Ticket carries exactly one `srs:*` label (`srs:drafting | srs:update | srs:new`)
  - Brainstorm phase complete — ticket body is sharp enough to draft
mandatory_actions:
  - Draft the `DraftCandidate[]` spec from the ticket and the conversation (`transition-drafting <ticket> ai-draft` prints the procedure)
  - Check it offline with `srs-cli.sh validate --spec <file>`, then write it via `transition-drafting <ticket> ai-draft --spec <file>`
  - Post the backend page URL as a ticket comment
  - Do not touch the board column — it stays `In progress`
exit_conditions:
  - `transition-drafting <ticket> ai-draft --spec <file>` exited 0 (the spec is written)
  - Backend page URL posted as ticket comment
  - No backend error left unresolved
next_status: Human review (see `statuses/2b-human-review.md`)
---

# STATUS (drafting lifecycle): AI Drafting

AI produces the first draft of the SRS pages in the configured backend (Notion, Confluence, local markdown, …). No CLI drafts a new feature from a ticket: the agent writes the `DraftCandidate[]` spec,
and the CLI writes it.

## Action checklist

- [ ] **Read the procedure:** `.claude/skills/sf-workflow/workflow-cli.sh transition-drafting <ticket> ai-draft` (no option: prints it, touches nothing)
- [ ] **Draft the spec** as a `DraftCandidate[]` JSON file: one `epic` candidate for the feature, one per version (`parentId` = the feature id), one `fr` candidate per FR (`parentEpicId` = its version
      id) — see `.claude/skills/sf-srs/templates/examples/example-three-levels.spec.json`
  - to start from existing material: `ai-draft --from notion-pages --ids <id,...>` or `ai-draft --from codebase [--path <dir>]` prints it as JSON
- [ ] **Check it offline:** `.claude/skills/sf-srs/scripts/srs-cli.sh validate --spec <file>` (no backend call)
- [ ] **Write it:** `transition-drafting <ticket> ai-draft --spec <file>` — dispatches to `srs-cli.sh write --spec <file>`, which resolves the `SrsAdapter` from `tools.srs.backend` and writes every
      page
- [ ] **Post the page URL** as a ticket comment so the reviewer can jump without leaving the board
- [ ] **Leave the board** — column stays `In progress` until the lifecycle closes with `transition-drafting done`

## Errors to avoid

- Hand-drafting the spec (always go through the skill CLI — the backend adapter is the single integration point)
- Moving the ticket to `AI testing` — code-path statuses are blocked by the SRS guard
- Bypassing `srs-cli.sh write` with direct backend SDK calls
- Passing `--ticket` to `ai-draft` — no drafter takes a ticket; the phase refuses it
- Deleting the `srs:*` label before `spawning` succeeds — the label keeps the ticket in the drafting lifecycle
