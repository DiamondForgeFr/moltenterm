---
status: AI Testing
banner_ai: Post the test plan, run automated + manual tests, fix on red, post the report, mark the draft PR ready
banner_human: Nothing yet — get ready to review the PR (your review is the validation gate)
complexity_profiles: [bug, low, medium, complex]
entry_conditions:
  - All child tickets completed in In Progress
  - Code pushed and ready for testing
mandatory_actions:
  - Generate test plan and post as ticket comment, starting with the heading `## Test plan`
  - Move ticket to `AI Testing`
  - Open the draft PR if it is not open yet (`create-pr <ticket> --draft`)
  - Run automated tests (build, lint, type-check, unit tests)
  - Execute the test plan manually (nominal + edge cases)
  - Adversarial review — only for complexity `complex` (`examine.sh`)
  - If problems found — fix, commit, push, restart from automated tests
  - Post test report summary as comment when all green, starting with the heading `## Test report`
  - Mark the PR ready (`ready-pr <ticket>`): the solo workflow has no Human Testing, so leaving draft is yours
exit_conditions:
  - All automated tests pass
  - Test plan fully executed and validated
  - Adversarial review complete (complex tickets only)
  - All Critical/High findings fixed
  - Code pushed
next_status: In Review (you mark the PR ready) | Done (nature:bundled-pr Subs only)
---

# STATUS: AI Testing

Automated validation + test plan execution. In the solo workflow this is the only testing status — the developer validates during PR review, so the test report must give them everything they need to review efficiently.

Aggregate Epics never enter this status. They stay `In progress` while their delivery children pass through testing
and review, then roll directly to `Done` after the last child reaches `Done`.

## Action checklist

- [ ] **Test plan** — post a comment starting with the heading `## Test plan`, covering: setup, nominal + edge scenarios, expected results per scenario, non-regression coverage
- [ ] **Move ticket** to `AI Testing` via `workflow-cli.sh update-status`
- [ ] **Automated tests:** `npm run build` → `npm run lint` → `npm run type-check` (if TS) → `npm run test:unit`
- [ ] **Heavy local validation** — run the project's declared local pipeline on the pushed commit before marking the PR ready. When `.molten/project.json` exists and `molten ci status` answers (exit 0, 1
      or 2: a MoltenTerm runner is reachable), run `molten ci run <branch>` and record its verdict. Otherwise run the project's configured build/integration suite (for example `npm test` and `npm run test:pre-push`
      when declared in `package.json`). Record command, commit and results.
- [ ] **Local CI gate** — when `.saasfoundry.json` declares `workflow.localCi.requiredStatuses`, run the project's local CI on the exact pushed commit until every declared status is green.
      No diff is too small for it: a narrower check (`lint`, `check`) does not count. `ready-pr` refuses a head without them; `--skip-local-ci "<reason>"` is the explicit escape hatch, recorded on
      the pull request.
- [ ] **Show progress on the PR** — around every heavy run, `workflow-cli.sh ai-status <ticket> "<step>" pending "<what runs>"`, then `success` or `failure` with a one-line result. The developer follows it from the PR's checks, which link to one progress comment; open the draft PR first (`create-pr <ticket> --draft`).
- [ ] **Execute test plan** step by step — verify each scenario, document any failure
- [ ] **On failure** — document, fix, commit, push, restart from automated tests
- [ ] **Complex only:** `.claude/skills/sf-workflow/scripts/examine.sh <ticket>` — 3 parallel `review` delegations (security / logic / perf). Fix Critical/High findings. If any fix committed, restart from
      automated tests.
- [ ] **Delegated ticket** — the agent that built it stops when the report is posted and every check is green, with the ticket still in AI Testing and the PR still a draft. It never merges, never records the delegation consent and never moves the ticket itself past AI Testing. On a branch the host named (`worktree-agent-<id>`), the PR commands take the ticket branch from the tip match or from `--head <branch>`, and need it pushed at `HEAD` (`2-in-progress.md`). The session takes over: it runs the Examine of a `complex` ticket (the agent that built the work does not review it) and hands the Critical/High findings back to that agent, then does what "On green" below says, `ready-pr` included (SKILL.md → Delegated ticket delivery)
- [ ] **On green** — post the test report as a comment starting with the heading `## Test report` (layout below; include examine findings if complex), then:
  - default: take the PR out of draft with `workflow-cli.sh ready-pr <ticket>`, then move to **In Review**
  - `nature:bundled-pr` children: move to **Done** directly (no individual PR — the delivery parent owns the branch and PR)

## Plan and report headings

The test plan comment starts with the exact heading `## Test plan`, and the report comment with `## Test report`. Tools that look for them match on these headings, so a comment under another title
("AI Testing report", "AI testing results") may not be found. The report carries the content of the checklist above, laid out like this:

```markdown
## Test report

**Commit:** <sha> · **Result:** pass | fail

| Check | Result |
| --- | --- |
| lint | … |
| unit tests | … |

### Test plan execution
- Scenario 1 — …: OK

### Examine findings (complex only)
…
```

## Errors to avoid

- Moving to In Review with failing tests
- Skipping test plan steps
- Saying "it should work" — RUN the tests
- Skipping examine for complex tickets
- Ignoring Critical/High security findings
- Marking the PR ready before the test report is posted — the report (`## Test report`) is the reviewer's map
- Posting the test plan or the report under another heading than `## Test plan` and `## Test report`
- A delegated agent merging, or moving its ticket past AI Testing: the session makes that transition
