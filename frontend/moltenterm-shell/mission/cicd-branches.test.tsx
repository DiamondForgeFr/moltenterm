// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { t } from "../i18n/i18n";
import { BranchCiAnswer, jobElapsedMs, runElapsedMs, waitingReviewCount } from "./branch-ci";
import { BranchesCiList, finishedRunDuration, ReviewsLine, ScheduledBlock } from "./cicd-panels";
import { PullRequest, WorkflowRun } from "./github";
import { MissionGithub } from "./mission-model";

const now = Date.parse("2026-10-16T10:04:30Z");

function pr(number: number, extra: Partial<PullRequest> = {}): PullRequest {
    return {
        number,
        title: `PR ${number}`,
        headRefName: `feature/${number}-x`,
        baseRefName: "develop",
        isDraft: false,
        createdAt: "2026-10-16T09:00:00Z",
        updatedAt: "2026-10-16T09:00:00Z",
        url: `https://github.com/o/r/pull/${number}`,
        ...extra,
    };
}

const answer: BranchCiAnswer = {
    dir: "/p",
    state: "ok",
    awaits: { tag: "v1.0.0-4", branch: "develop", sha: "abc1234", workflows: ["ci.yml"] },
    branches: [
        {
            branch: "develop",
            roles: ["trunk"],
            runs: [
                {
                    databaseId: 30,
                    workflowName: "CI",
                    event: "push",
                    status: "in_progress",
                    conclusion: "",
                    headBranch: "develop",
                    headSha: "abc1234def",
                    displayTitle: "fix(#799): codex terminals",
                    createdAt: "2026-10-16T10:00:00Z",
                    updatedAt: "2026-10-16T10:03:00Z",
                    startedAt: "2026-10-16T10:00:00Z",
                    url: "https://github.com/o/r/actions/runs/30",
                    attempt: 1,
                    usualms: 9 * 60000,
                    ci: { state: "pending", success: 1, failure: 0, pending: 1 },
                    jobs: [
                        {
                            name: "Lint",
                            state: "success",
                            status: "completed",
                            startedat: "2026-10-16T10:00:00Z",
                            completedat: "2026-10-16T10:02:00Z",
                        },
                        {
                            name: "Perf budgets",
                            state: "pending",
                            status: "in_progress",
                            startedat: "2026-10-16T10:01:00Z",
                            usualms: 8 * 60000,
                        },
                    ],
                    awaitedby: "v1.0.0-4",
                },
            ],
        },
        {
            branch: "main",
            roles: ["release"],
            runs: [
                {
                    databaseId: 40,
                    workflowName: "CI",
                    event: "push",
                    status: "completed",
                    conclusion: "failure",
                    headBranch: "main",
                    headSha: "eee",
                    displayTitle: "chore(release): v1.0.0-3",
                    createdAt: "2026-10-16T08:00:00Z",
                    updatedAt: "2026-10-16T08:09:00Z",
                    startedAt: "2026-10-16T08:00:00Z",
                    url: "https://github.com/o/r/actions/runs/40",
                    attempt: 1,
                    ci: { state: "failure", success: 0, failure: 1, pending: 0 },
                    jobs: [
                        {
                            name: "Backend tests",
                            state: "failure",
                            status: "completed",
                            startedat: "2026-10-16T08:00:00Z",
                            completedat: "2026-10-16T08:09:00Z",
                            failedsteps: ["go test"],
                        },
                    ],
                },
            ],
        },
    ],
};

describe("remote CI tab: trunk and release branches (#836)", () => {
    it("counts the pull requests waiting for review as Reviews lists them", () => {
        const prs = [
            pr(1),
            pr(2),
            pr(3, { isDraft: true }),
            pr(4, { baseRefName: "main" }),
            pr(5, { isCrossRepository: true }),
        ];
        expect(waitingReviewCount(prs, "develop")).toBe(2);
        expect(waitingReviewCount(prs, "")).toBe(0);
        const html = renderToStaticMarkup(
            <ReviewsLine github={{ state: "ok", prs, workflows: [] } as MissionGithub} target="develop" dir="/p" />
        );
        expect(html).toContain('data-count="2"');
        expect(html).toContain("2 pull requests waiting for review");
        expect(html).not.toContain("PR 1");
    });

    it("times a running job and a finished run", () => {
        const run = answer.branches[0].runs[0];
        expect(jobElapsedMs(run.jobs[1], now)).toBe(3.5 * 60000);
        expect(jobElapsedMs(run.jobs[0], now)).toBe(2 * 60000);
        expect(
            jobElapsedMs({ name: "x", state: "pending", status: "queued", startedat: "0001-01-01T00:00:00Z" }, now)
        ).toBeNull();
        expect(runElapsedMs(answer.branches[1].runs[0], now)).toBe(9 * 60000);
    });

    it("never says 0 s for a finished run: its jobs' span, else an unknown duration (FR-SHELL-100)", () => {
        const finished = answer.branches[1].runs[0];
        const flat = { ...finished, updatedAt: finished.createdAt, startedAt: "" };
        expect(runElapsedMs(flat, now)).toBe(9 * 60000);
        const bare = { ...flat, jobs: [] };
        expect(runElapsedMs(bare, now)).toBeNull();
        const html = renderToStaticMarkup(
            <BranchesCiList
                dir="/p"
                answer={{ ...answer, branches: [{ ...answer.branches[1], runs: [bare] }] }}
                error={null}
                now={now}
                onRefresh={() => {}}
                onShowRelease={() => {}}
            />
        );
        expect(html).toContain("Unknown duration");
        expect(html).not.toContain(">0 s<");
        expect(finishedRunDuration(t, flat)).toBe("Unknown duration");
        expect(finishedRunDuration(t, finished)).toBe("9 min 00");
    });

    it("says a workflow is scheduled on GitHub when no local file declares it (FR-SHELL-100)", () => {
        const nightly = {
            databaseId: 7,
            workflowName: "Nightly e2e",
            event: "schedule",
            status: "completed",
            conclusion: "failure",
            headBranch: "develop",
            displayTitle: "Nightly e2e",
            createdAt: "2026-10-16T02:00:00Z",
            updatedAt: "2026-10-16T02:20:00Z",
            url: "https://github.com/o/r/actions/runs/7",
        };
        const scheduled = (runs: WorkflowRun[]) =>
            renderToStaticMarkup(
                <ScheduledBlock github={{ state: "ok", prs: [], runs, workflows: [] } as MissionGithub} />
            );
        const html = scheduled([nightly]);
        expect(html).toContain("Nightly e2e");
        expect(html).toContain("Scheduled on GitHub, no local file");
        expect(html).not.toContain("No scheduled workflow.");
        expect(scheduled([])).toContain("No scheduled workflow.");
    });

    it("leads with each branch's latest runs: jobs, a running job against its usual time, failed steps, the release waiting", () => {
        const html = renderToStaticMarkup(
            <BranchesCiList
                dir="/p"
                answer={answer}
                error={null}
                now={now}
                onRefresh={() => {}}
                onShowRelease={() => {}}
            />
        );
        expect(html).toContain('data-branch="develop"');
        expect(html).toContain('data-branch="main"');
        expect(html).toContain("Perf budgets");
        expect(html).toContain("3 min 30, usually ~8 min");
        expect(html).toContain("Failed: go test");
        expect(html).toContain("Awaited by the release v1.0.0-4");
        expect(html.indexOf('data-branch="develop"')).toBeLessThan(html.indexOf('data-branch="main"'));
        expect(html.match(/data-testid="ci-branch-awaited"/g)).toHaveLength(1);
    });
});
