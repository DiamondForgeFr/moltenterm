// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it } from "vitest";
import { I18nModel } from "../i18n/i18n";
import {
    batchConfirmKey,
    BatchItem,
    batchMethodShown,
    batchPlan,
    batchPlanCostText,
    batchReasonText,
    batchRowMark,
    BatchRun,
    batchShown,
    batchStartRequest,
    batchStepText,
    batchSummary,
    batchTitle,
    canWithdraw,
    queueItem,
    queueOrder,
} from "./reviews-batch-model";
import { Forecast } from "./reviews-forecast-model";
import { ReviewPr } from "./reviews-model";

const Base = "b".repeat(40);
const head = (n: number) => `h${n}`.padEnd(40, "0");

function pr(number: number, extra: Partial<ReviewPr> = {}): ReviewPr {
    return {
        number,
        title: `PR ${number}`,
        url: `https://github.com/a/b/pull/${number}`,
        branch: `feature/${number}-x`,
        base: "develop",
        headoid: head(number),
        baseoid: Base,
        createdat: "2026-10-10T10:00:00Z",
        updatedat: "2026-10-12T10:00:00Z",
        merge: "clean",
        ci: { state: "success", success: 1, failure: 0, pending: 0, checks: [{ name: "ci", state: "success" }] },
        report: { state: "unknown" },
        unpublished: 0,
        ...extra,
    };
}

// edges: [a, b] means merging #a puts #b in conflict.
function forecastOf(prs: ReviewPr[], edges: [number, number][], extra: Partial<Forecast> = {}): Forecast {
    return {
        dir: "/p",
        key: "k",
        state: "ready",
        baseoid: Base,
        method: "squash",
        uptodate: "notrequired",
        rows: prs.map((p) => ({
            number: p.number,
            headoid: p.headoid,
            state: "simulated",
            impacts: edges
                .filter(([a]) => a === p.number)
                .map(([, b]) => ({ number: b, headoid: head(b), paths: ["README.md"], pathcount: 1 })),
        })),
        ...extra,
    };
}

function item(number: number, extra: Partial<BatchItem> = {}): BatchItem {
    return {
        number,
        headref: `feature/${number}-x`,
        headoid: head(number),
        title: `PR ${number}`,
        state: "queued",
        ...extra,
    };
}

function run(extra: Partial<BatchRun> = {}): BatchRun {
    return {
        id: "r1",
        dir: "/p",
        repo: "a/b",
        base: "develop",
        state: "running",
        current: 1,
        items: [item(1, { state: "merged" }), item(2, { state: "rebasing" }), item(3), item(4), item(5)],
        ciruns: 0,
        agentname: "Bruno",
        startedat: 1,
        ...extra,
    };
}

describe("batch merge model", () => {
    beforeEach(() => {
        I18nModel.getInstance().setLanguageSetting("en");
    });

    it("orders the selected PRs in the suggested order, with what that order costs", () => {
        const prs = [pr(1), pr(2), pr(3)];
        // #1 puts #2 and #3 in conflict: merged last, it is the only one rebased.
        const plan = batchPlan(
            forecastOf(prs, [
                [1, 2],
                [1, 3],
                [2, 1],
                [3, 1],
            ]),
            prs,
            prs,
            "develop"
        );
        expect(plan.usable).toBe(true);
        expect(plan.steps.map((s) => s.pr.number)).toEqual([2, 3, 1]);
        expect(plan.steps.map((s) => s.rank)).toEqual([1, 2, 3]);
        expect(plan.cost).toBe(1);
        expect(plan.method).toBe("squash");
        expect(plan.steps[2].rebase).toBe(true);
        expect(batchPlanCostText(plan)).toBe("This order should redo 1 CI run.");
    });

    it("orders only the selected PRs, and never a draft", () => {
        const prs = [pr(1), pr(2), pr(3), pr(4, { draft: true })];
        const plan = batchPlan(forecastOf(prs, [[1, 2]]), [pr(2), pr(1), pr(4, { draft: true })], prs, "develop");
        expect(plan.steps.map((s) => s.pr.number)).toEqual([2, 1]);
        expect(plan.cost).toBe(0);
    });

    it("keeps the list's order while the forecast cannot say, and says the cost is unknown", () => {
        const prs = [pr(3), pr(1)];
        const plan = batchPlan({ ...forecastOf(prs, []), state: "" }, prs, prs, "develop");
        expect(plan.usable).toBe(false);
        expect(plan.steps.map((s) => s.pr.number)).toEqual([3, 1]);
        expect(batchPlanCostText(plan)).toContain("not ready");
        const upToDate = batchPlan(forecastOf(prs, [], { uptodate: "required" }), prs, prs, "develop");
        expect(batchPlanCostText(upToDate)).toContain("up to date");
    });

    it("builds the start request in the modal's order, with its method", () => {
        const prs = [pr(1, { tickettitle: "Ticket one", ticket: 11 }), pr(2)];
        const plan = batchPlan(forecastOf(prs, [[1, 2]]), prs, prs, "develop");
        const req = batchStartRequest("/p", "a/b", "develop", plan, "rebase", "ws1");
        expect(req.prs.map((p) => p.number)).toEqual(plan.steps.map((s) => s.pr.number));
        expect(req.prs.find((p) => p.number === 1)).toMatchObject({
            headref: "feature/1-x",
            headoid: head(1),
            title: "Ticket one",
            ticket: 11,
        });
        expect(req.method).toBe("rebase");
        expect(req.workspaceid).toBe("ws1");
        expect(req.tabname).toBe("Merge queue");
        expect(req.source).toBe("batch");
        expect(req.order).toEqual(plan.steps.map((s) => s.pr.number));
        expect(batchStartRequest("/p", "a/b", "develop", plan, "rebase", "ws1", [3, 2, 1]).order).toEqual([3, 2, 1]);
    });

    // FR-REV-026 AC2: the order sent on a join covers the PRs still in the queue and the ones joining.
    it("orders the queue's PRs and the joining ones by the suggested order", () => {
        const prs = [pr(1), pr(2), pr(3)];
        // Merging #1 puts #2 and #3 in conflict: it goes last.
        const forecast = forecastOf(prs, [
            [1, 2],
            [1, 3],
        ]);
        const queue = run({ current: -1, items: [item(1, { state: "waitingchecks" }), item(9, { state: "merged" })] });
        expect(queueOrder(forecast, prs, queue, [3])).toEqual([3, 1]);
        expect(queueOrder(forecast, prs, null, [1, 2])).toEqual([2, 1]);
        expect(queueOrder({ ...forecast, state: "" }, prs, queue, [3])).toEqual([]);
    });

    // #1059: the list's order leaves out a PR already conflicting with the base; the batch still rebases it, last.
    it("keeps the PRs already conflicting with the base, after the order", () => {
        const prs = [pr(1, { merge: "conflicts" }), pr(2), pr(3)];
        const forecast = forecastOf(prs, [[2, 3]]);
        const plan = batchPlan(forecast, prs, prs, "develop");
        expect(plan.steps.map((s) => s.pr.number)).toEqual([3, 2, 1]);
        expect(plan.steps.map((s) => s.rank)).toEqual([1, 2, 3]);
        expect(plan.steps[2]).toMatchObject({
            rebase: true,
            reason: "Already conflicts with develop: rebase in any order",
        });
        expect(plan.cost).toBe(1);
        expect(queueOrder(forecast, prs, null, [1, 2, 3])).toEqual([3, 2, 1]);
    });

    it("finds a PR still in the queue, which can be withdrawn until its merge starts", () => {
        const queue = run({
            items: [
                item(1, { state: "merged" }),
                item(2, { state: "merging" }),
                item(3, { state: "failed" }),
                item(4, { state: "voided" }),
            ],
        });
        expect(queueItem(queue, 1)).toBeNull();
        expect(queueItem(queue, 4)).toBeNull();
        expect(queueItem(queue, 3)?.state).toBe("failed");
        expect(canWithdraw(queueItem(queue, 2))).toBe(false);
        expect(canWithdraw(queueItem(queue, 3))).toBe(true);
        expect(queueItem({ ...queue, state: "done" }, 3)).toBeNull();
    });

    it("answers the modal: Enter starts, Escape cancels, nothing else", () => {
        expect(batchConfirmKey("Enter")).toBe("start");
        expect(batchConfirmKey("Escape")).toBe("cancel");
        expect(batchConfirmKey("a")).toBeNull();
        expect(batchConfirmKey("Tab")).toBeNull();
    });

    it("titles the banner with the progress and names the PR in progress", () => {
        const r = run();
        expect(batchTitle(r)).toBe("Merge queue: 5 PRs validated — 1 of 5 merged, #2 is being rebased");
        expect(batchStepText(r, r.items[1])).toBe("Bruno rebases it on develop");
        expect(batchStepText(r, { ...r.items[1], waiting: true })).toBe("Bruno waits for your answer in its terminal");
        expect(batchStepText(r, { ...r.items[1], state: "waitingchecks", rebases: 1 })).toBe(
            "Waiting for its checks on the rebased head"
        );
        expect(batchTitle(run({ state: "cancelling" }))).toContain("after the current step");
        expect(batchStepText(r, { ...r.items[1], state: "failed", names: ["ci"] })).toBe(
            "CI failed on ci: merged once its checks pass again on the same commit"
        );
    });

    // #887 AC3: the last PR still waiting for its checks is not counted as done.
    it("counts the merged PRs and tells the last one still waits", () => {
        const r = run({
            current: 2,
            items: [
                item(1, { state: "merged" }),
                item(2, { state: "merged" }),
                item(3, { state: "waitingchecks", rebases: 1 }),
            ],
        });
        expect(batchTitle(r)).toBe("Merge queue: 3 PRs validated — 2 of 3 merged, #3 waits for its checks");
        expect(batchTitle({ ...r, items: [...r.items.slice(0, 2), { ...r.items[2], waiting: true }] })).toBe(
            "Merge queue: 3 PRs validated — 2 of 3 merged, #3 waits for your answer"
        );
        expect(batchTitle({ ...r, current: -1 })).toBe("Merge queue: 3 PRs validated — 2 of 3 merged");
    });

    it("sums up an ended run: merged, skipped with reasons, CI runs redone", () => {
        const r = run({
            state: "done",
            current: -1,
            ciruns: 1,
            items: [
                item(1, { state: "merged" }),
                item(2, { state: "merged", rebases: 1 }),
                item(3, { state: "withdrawn", reason: "withdrawn", byyou: true }),
                item(4, { state: "voided", reason: "pushed" }),
            ],
        });
        expect(batchTitle(r)).toBe("Merge queue done: 2 of 4 PRs merged");
        expect(batchSummary(r)).toBe(
            "Merged: #1, #2. Not merged: #3 (Validation cancelled), #4 (Pushed after your validation: back to review). 1 CI run redone."
        );
        expect(batchSummary({ ...r, kept: "unpushed" })).toContain("commits not pushed");
        expect(batchSummary({ ...r, stale: [{ path: "/data/worktrees/p-1/batch-merge-2", kept: "inuse" }] })).toContain(
            "The copy batch-merge-2 of an earlier merge queue is in use by a terminal or a program: it is kept."
        );
        expect(batchTitle({ ...r, state: "cancelled" })).toBe("Merge queue cancelled: 2 of 4 PRs merged");
    });

    it("words every reason, an agent's note as data", () => {
        expect(batchReasonText(item(3, { reason: "ambiguous", note: "f: both sides" }), "develop")).toBe(
            "A conflict your agent left to you: f: both sides"
        );
        expect(batchReasonText(item(3, { reason: "conflict" }), "develop")).toBe(
            "Still conflicts with develop after a rebase"
        );
        expect(batchReasonText(item(3, { reason: "mergefailed", detail: "boom" }), "develop")).toBe(
            "The merge failed: boom"
        );
        expect(batchReasonText(item(3, { reason: "something-new" as any }), "develop")).toBe("Not reached");
    });

    // FR-REV-026 AC7: the row says where the PR is in the queue.
    it("marks each PR's row with its place in the queue", () => {
        const r = run();
        expect(batchRowMark(r, 1)).toMatchObject({ label: "Merged by the queue", tone: "success" });
        expect(batchRowMark(r, 2)).toMatchObject({ label: "Rebasing", tone: "pending", current: true });
        expect(batchRowMark(r, 3)).toMatchObject({ label: "Next in queue", tone: "neutral" });
        expect(batchRowMark(r, 4)).toMatchObject({ label: "In queue: 2", tone: "neutral" });
        expect(batchRowMark(r, 9)).toBeNull();
        const waiting = run({
            items: [item(1, { state: "waitingchecks" }), item(2, { state: "merging" })],
            current: 0,
        });
        expect(batchRowMark(waiting, 1)).toMatchObject({ label: "Validated — waiting for CI", tone: "pending" });
        expect(batchRowMark(waiting, 2)).toMatchObject({ label: "Merging" });
        const stopped = run({
            items: [
                item(1, { state: "failed", reason: "failing", names: ["ci"] }),
                item(2, { state: "stopped", reason: "ambiguous" }),
                item(3, { state: "voided", reason: "pushed" }),
            ],
        });
        expect(batchRowMark(stopped, 1)).toMatchObject({ label: "Validated — CI failed", tone: "failure" });
        expect(batchRowMark(stopped, 2)).toMatchObject({
            label: "Needs you",
            tone: "failure",
            title: "A conflict your agent left to you",
        });
        expect(batchRowMark(stopped, 3)).toMatchObject({ label: "Validation void: new push" });
    });

    it("shows a running queue, and an ended one until it is dismissed", () => {
        expect(batchShown(null)).toBe(false);
        expect(batchShown(run())).toBe(true);
        expect(batchShown(run({ state: "done" }))).toBe(true);
        expect(batchShown(run({ state: "done", dismissed: true }))).toBe(false);
        expect(batchRowMark(run({ state: "done", dismissed: true }), 1)).toBeNull();
    });

    it("words the banner in French", () => {
        I18nModel.getInstance().setLanguageSetting("fr");
        expect(batchTitle(run())).toBe(
            "File de fusion : 5 PR validées — 1 sur 5 fusionnées, #2 est en cours de rebase"
        );
    });

    // #957: the modal's method is the repository's remembered one until the developer picks another it allows.
    it("shows the repository's default method, the pick over it, and none while unknown", () => {
        const methods = { methods: ["merge", "rebase"] as ("merge" | "rebase")[], method: "rebase" as const };
        expect(batchMethodShown(null, "merge")).toBeNull();
        expect(batchMethodShown(methods, null)).toBe("rebase");
        expect(batchMethodShown(methods, "merge")).toBe("merge");
        expect(batchMethodShown(methods, "squash")).toBe("rebase");
        expect(batchMethodShown({ methods: ["squash"], method: "squash", queue: true }, "merge")).toBe("squash");
    });

    it("words a PR stopped because GitHub no longer allows its method", () => {
        const item = { number: 3, state: "stopped", reason: "method", names: ["rebase"] } as BatchItem;
        expect(batchReasonText(item, "develop")).toBe(
            "GitHub no longer allows the method shown (rebase): nothing was merged. Add it again with an allowed method."
        );
        I18nModel.getInstance().setLanguageSetting("fr");
        expect(batchReasonText(item, "develop")).toContain("rebase");
    });
});
