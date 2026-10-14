// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    CatalogueJob,
    CatalogueLocal,
    conditionWords,
    cronWords,
    describeOutcome,
    jobLabel,
    lastWorkflowRun,
    localAfterWords,
    localWhenWords,
    needsWords,
    triggerWords,
} from "./ci-jobs-model";
import { WorkflowRun } from "./github";

// The triggers wavesrv reads from pkg/molten/mission/testdata/cijobs (cijobs_test.go checks the same files).
const Fixtures = {
    nightly: [
        { event: "schedule", crons: ["30 2 * * *", "0 6 * * 1"] },
        { event: "workflow_dispatch", inputs: ["suite", "dry"] },
    ],
    paths: [
        { event: "push", branches: ["develop"], tags: ["v*"], paths: ["docs/**", "mkdocs.yml"] },
        {
            event: "pull_request",
            branchesignore: ["gh-pages"],
            types: ["opened", "synchronize", "ready_for_review"],
            pathsignore: ["**/*.png"],
        },
        { event: "workflow_run", workflows: ["CI"], types: ["completed"] },
    ],
    moltenterm: [
        {
            event: "pull_request",
            branches: ["develop", "main"],
            types: ["opened", "synchronize", "reopened", "ready_for_review", "converted_to_draft"],
        },
        { event: "push", branches: ["develop", "main"] },
        { event: "workflow_dispatch" },
        { event: "push", tags: ["v*"] },
        { event: "pull_request", paths: [".github/workflows/release.yml", "scripts/a.sh"] },
        { event: "pull_request_target", types: ["opened", "closed"] },
    ],
};

describe("triggerWords", () => {
    it("reads schedules and runs by hand", () => {
        expect(Fixtures.nightly.map(triggerWords)).toEqual([
            "On a schedule: every day at 02:30 UTC; every Monday at 06:00 UTC",
            "By hand (Run workflow on GitHub), asking for suite and dry",
        ]);
    });

    it("reads branches, tags, activities and path filters", () => {
        expect(Fixtures.paths.map(triggerWords)).toEqual([
            "On push to develop, of tags v*, only when docs/** or mkdocs.yml change",
            "On pull requests except to gh-pages, when opened, updated with new commits or marked ready for review, unless only **/*.png change",
            "After the workflow CI is completed",
        ]);
    });

    it("reads MoltenTerm's own workflows", () => {
        expect(Fixtures.moltenterm.map(triggerWords)).toEqual([
            "On pull requests to develop or main, when opened, updated with new commits, reopened, marked ready for review or returned to draft",
            "On push to develop or main",
            "By hand (Run workflow on GitHub)",
            "On push of tags v*",
            "On pull requests, only when .github/workflows/release.yml or scripts/a.sh change",
            "On pull requests, with the repository's own permissions, when opened or closed or merged",
        ]);
    });

    it("names events it has no sentence for", () => {
        expect(triggerWords({ event: "push" })).toBe("On every push");
        expect(triggerWords({ event: "release", types: ["published"] })).toBe("On releases, when published");
        expect(triggerWords({ event: "something_new" })).toBe("On the something_new event");
    });
});

describe("cronWords", () => {
    it("reads intervals and days of the month, else the existing shapes", () => {
        expect(cronWords("*/15 * * * *")).toBe("every 15 minutes");
        expect(cronWords("0 */6 * * *")).toBe("every 6 hours at minute 0 (UTC)");
        expect(cronWords("5 * * * *")).toBe("every hour at minute 5");
        expect(cronWords("0 4 1 * *")).toBe("on day 1 of every month at 04:00 UTC");
        expect(cronWords("0 3 * * 1-5")).toBe("Monday to Friday at 03:00 UTC");
        expect(cronWords("nonsense")).toBe('cron "nonsense"');
    });
});

describe("conditionWords", () => {
    it("reads the draft rule of ci.yml as one phrase", () => {
        expect(conditionWords("github.event_name != 'pull_request' || !github.event.pull_request.draft")).toBe(
            "except on draft pull requests"
        );
        expect(
            conditionWords("${{ github.event_name != 'pull_request' || github.event.pull_request.draft == false }}")
        ).toBe("except on draft pull requests");
    });

    it("reads release.yml's needs outputs", () => {
        expect(conditionWords("needs.meta.outputs.mode != 'check'")).toBe(`meta's mode is not "check"`);
        expect(conditionWords("needs.meta.outputs.mode == 'release'")).toBe(`meta's mode is "release"`);
    });

    it("reads pr-review-sync.yml's condition", () => {
        expect(
            conditionWords(
                "github.event.pull_request.head.repo.full_name == github.repository && (github.event.action == 'closed' && github.event.pull_request.merged == true || github.event.action != 'closed' && github.event.pull_request.draft == false)"
            )
        ).toBe(
            `the pull request comes from this repository, not a fork and ((the event is "closed" and the pull request was merged), or (the event is not "closed" and the pull request is not a draft))`
        );
    });

    it("reads refs, events, status functions and inputs", () => {
        expect(conditionWords("${{ github.ref == 'refs/heads/develop' && github.event_name == 'push' }}")).toBe(
            "on the branch develop and on a push"
        );
        expect(conditionWords("startsWith(github.ref, 'refs/tags/v')")).toBe("on a tag starting with v");
        expect(conditionWords("always()")).toBe("always, even when an earlier job failed or the run was cancelled");
        expect(conditionWords("failure()")).toBe("when a job before it failed");
        expect(conditionWords("github.event_name == 'schedule' || inputs.suite == 'all'")).toBe(
            `on the schedule, or the input suite is "all"`
        );
        expect(conditionWords("contains(github.event.pull_request.labels.*.name, 'deploy')")).toBe(
            "the pull request has the label deploy"
        );
        expect(conditionWords("needs.build.result == 'success'")).toBe("build succeeded");
        expect(conditionWords("!cancelled()")).toBe("not when the run was cancelled");
    });

    it("gives up on what it cannot read", () => {
        expect(conditionWords("")).toBeNull();
        expect(conditionWords("github.event.number > 3")).toBeNull();
        expect(conditionWords("fromJSON(needs.a.outputs.list)[0]")).toBeNull();
        expect(conditionWords("'unterminated")).toBeNull();
    });
});

describe("jobs", () => {
    const jobs: CatalogueJob[] = [
        { id: "meta", name: "Release tag", line: 56 },
        { id: "macos", name: "macOS (arm64, x64)", line: 135, needs: ["meta"] },
        { id: "linux", name: "Linux (${{ matrix.arch }})", line: 193, needs: ["meta"] },
        { id: "publish", line: 314, needs: ["meta", "macos", "linux"] },
    ];

    it("names a job and the jobs it waits for", () => {
        expect(jobLabel(jobs[2])).toBe("Linux (arch)");
        expect(jobLabel(jobs[3])).toBe("publish");
        expect(needsWords(jobs[3].needs, jobs)).toBe("Release tag, macOS (arm64, x64) and Linux (arch)");
        expect(needsWords(["gone"], jobs)).toBe("gone");
        expect(needsWords([], jobs)).toBeNull();
    });

    it("tells when and after what a local job runs", () => {
        const local: CatalogueLocal = {
            path: "/p/.molten/project.json",
            verifybuilds: ["Gold"],
            jobs: [
                { name: "ledger", title: "Patch ledger", lane: "quick", order: 1 },
                { name: "typecheck", title: "TypeScript", lane: "frontend", order: 1 },
                { name: "lint", title: "ESLint", lane: "frontend", order: 2 },
                { name: "vitest", lane: "frontend", order: 3 },
            ],
        };
        expect(localWhenWords(local)).toBe(
            "When you or an agent run the local CI (Run CI, or molten ci run), and before the Gold build"
        );
        expect(localWhenWords({ path: "", jobs: [] })).toBe(
            "When you or an agent run the local CI (Run CI, or molten ci run)"
        );
        expect(localAfterWords(local.jobs[0], local)).toBeNull();
        expect(localAfterWords(local.jobs[3], local)).toBe(
            "TypeScript and ESLint, in the frontend lane (a failure stops the rest of the lane)"
        );
    });

    it("finds a workflow's last run by its name", () => {
        const run = (id: number, name: string, at: string) =>
            ({ databaseId: id, workflowName: name, createdAt: at }) as WorkflowRun;
        const runs = [
            run(1, "CI", "2026-10-13T10:00:00Z"),
            run(2, "CI", "2026-10-14T10:00:00Z"),
            run(3, "Release", "2026-10-15T10:00:00Z"),
        ];
        const wf = { file: "ci.yml", path: "", name: "CI", triggers: [], jobs: [] };
        expect(lastWorkflowRun(runs, wf)?.databaseId).toBe(2);
        expect(lastWorkflowRun(runs, { ...wf, name: "" })).toBeNull();
    });

    it("says what happened to the request", () => {
        expect(describeOutcome({ sent: true, submitted: true, message: "" }, "Claude Code").text).toBe(
            "Sent to Claude Code: the description will come as a change to review."
        );
        expect(describeOutcome({ sent: true, message: "" }, "Codex").text).toContain("press Enter");
        expect(
            describeOutcome({ sent: false, message: "Codex is working: wait for its turn to end." }, "Codex")
        ).toEqual({
            ok: false,
            text: "Codex is working: wait for its turn to end.",
        });
    });
});
