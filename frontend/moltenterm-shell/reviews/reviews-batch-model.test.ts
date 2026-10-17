// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it } from "vitest";
import { I18nModel } from "../i18n/i18n";
import {
    batchConfirmKey,
    batchDecisions,
    BatchItem,
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
    toggleBatchSelection,
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
        const req = batchStartRequest("/p", "a/b", "develop", plan, "ws1");
        expect(req.prs.map((p) => p.number)).toEqual(plan.steps.map((s) => s.pr.number));
        expect(req.prs.find((p) => p.number === 1)).toMatchObject({
            headref: "feature/1-x",
            headoid: head(1),
            title: "Ticket one",
            ticket: 11,
        });
        expect(req.method).toBe("squash");
        expect(req.workspaceid).toBe("ws1");
        expect(req.tabname).toBe("Batch merge");
    });

    it("answers the modal: Enter starts, Escape cancels, nothing else", () => {
        expect(batchConfirmKey("Enter")).toBe("start");
        expect(batchConfirmKey("Escape")).toBe("cancel");
        expect(batchConfirmKey("a")).toBeNull();
        expect(batchConfirmKey("Tab")).toBeNull();
    });

    it("toggles a PR in and out of the selection", () => {
        expect(toggleBatchSelection([], 3)).toEqual([3]);
        expect(toggleBatchSelection([3, 4], 3)).toEqual([4]);
    });

    it("titles the banner with the progress and names the PR in progress", () => {
        const r = run();
        expect(batchTitle(r)).toBe("An agent is merging 5 PRs — 1 of 5 merged, #2 is being rebased");
        expect(batchStepText(r, r.items[1])).toBe("Bruno rebases it on develop");
        expect(batchStepText(r, { ...r.items[1], waiting: true })).toBe("Bruno waits for your answer in its terminal");
        expect(batchStepText(r, { ...r.items[1], state: "waitingchecks", rebases: 1 })).toBe(
            "Waiting for its checks on the rebased head"
        );
        expect(batchTitle(run({ state: "cancelling" }))).toContain("after the current step");
        expect(batchTitle(run({ state: "paused" }))).toBe("The batch merge stopped on #2 — 1 of 5 merged");
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
        expect(batchTitle(r)).toBe("An agent is merging 3 PRs — 2 of 3 merged, #3 waits for its checks");
        expect(batchTitle({ ...r, items: [...r.items.slice(0, 2), { ...r.items[2], waiting: true }] })).toBe(
            "An agent is merging 3 PRs — 2 of 3 merged, #3 waits for your answer"
        );
        expect(batchTitle({ ...r, current: -1 })).toBe("An agent is merging 3 PRs — 2 of 3 merged");
    });

    it("sums up an ended run: merged, skipped with reasons, CI runs redone", () => {
        const r = run({
            state: "done",
            current: -1,
            ciruns: 1,
            items: [
                item(1, { state: "merged" }),
                item(2, { state: "merged", rebases: 1 }),
                item(3, { state: "skipped", reason: "failing", names: ["ci", "lint"], byyou: true }),
                item(4, { state: "skipped", reason: "notreached" }),
            ],
        });
        expect(batchTitle(r)).toBe("Batch merge done: 2 of 4 PRs merged");
        expect(batchSummary(r)).toBe(
            "Merged: #1, #2. Skipped: #3 (Checks failing: ci, lint), #4 (Not reached). 1 CI run redone."
        );
        expect(batchSummary({ ...r, kept: "unpushed" })).toContain("commits not pushed");
        expect(batchTitle({ ...r, state: "cancelled" })).toBe("Batch merge cancelled: 2 of 4 PRs merged");
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

    it("offers Merge anyway only for warnings, never for a failing check", () => {
        expect(batchDecisions(item(2, { state: "stopped", reason: "failing" }))).toEqual(["retry", "skip", "end"]);
        expect(batchDecisions(item(2, { state: "stopped", reason: "warnings" }))).toEqual(["override", "skip", "end"]);
        expect(batchDecisions(item(2, { state: "rebasing" }))).toEqual([]);
    });

    it("marks each PR's row with its place in the run", () => {
        const r = run();
        expect(batchRowMark(r, 1)).toMatchObject({ label: "Merged by the batch", tone: "success" });
        expect(batchRowMark(r, 2)).toMatchObject({ label: "Batch: in progress", tone: "pending", current: true });
        expect(batchRowMark(r, 4)).toMatchObject({ label: "Batch: 4", tone: "neutral" });
        expect(batchRowMark(r, 9)).toBeNull();
        const stopped = run({
            state: "paused",
            items: [item(1, { state: "merged" }), item(2, { state: "stopped", reason: "failing", names: ["ci"] })],
        });
        expect(batchRowMark(stopped, 2)).toMatchObject({
            label: "Stopped the batch",
            tone: "failure",
            title: "Checks failing: ci",
        });
    });

    it("shows a running run, and an ended one until it is dismissed", () => {
        expect(batchShown(null)).toBe(false);
        expect(batchShown(run())).toBe(true);
        expect(batchShown(run({ state: "done" }))).toBe(true);
        expect(batchShown(run({ state: "done", dismissed: true }))).toBe(false);
        expect(batchRowMark(run({ state: "done", dismissed: true }), 1)).toBeNull();
    });

    it("words the banner in French", () => {
        I18nModel.getInstance().setLanguageSetting("fr");
        expect(batchTitle(run())).toBe("Un agent fusionne 5 PR — 1 sur 5 fusionnées, #2 est en cours de rebase");
    });
});
