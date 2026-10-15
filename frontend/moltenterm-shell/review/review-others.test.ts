// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { translate } from "../i18n/i18n-core";
import { cleanupRebaseAsks, rebaseAskKey } from "../reviews/reviews-model";
import type { ReviewCleanupPr, ReviewCleanupResult, ReviewCleanupStepResult } from "./review-cleanup";
import type { ReviewMergeRecord } from "./review-client";
import { buildValidateSteps, Translate, ValidateStep } from "./review-stepper";

const en: Translate = (key, vars) => translate("en", key, vars);
const fr: Translate = (key, vars) => translate("fr", key, vars);

const merged: ReviewMergeRecord = {
    planid: "p1",
    method: "squash",
    planhead: "a".repeat(40),
    head: "a".repeat(40),
    state: "merged",
    code: "merged",
    startedat: 1,
    endedat: 2,
};

function result(others: Partial<ReviewCleanupStepResult>): ReviewCleanupResult {
    return {
        repo: "o/n",
        number: 670,
        branch: "feature/670-x",
        base: "develop",
        startedat: 3,
        endedat: 40,
        steps: [{ id: "other-prs", state: "done", code: "otherprs", base: "develop", ...others }],
    };
}

function othersStep(t: Translate, cleanup: ReviewCleanupResult): ValidateStep {
    const steps = buildValidateSteps(t, { plan: null, record: merged, cleanup, headref: "x", baseref: "develop" });
    return steps.find((s) => s.id === "others");
}

const prs: ReviewCleanupPr[] = [
    { number: 1, branch: "feature/1-a", state: "done" },
    {
        number: 2,
        branch: "feature/2-b",
        state: "done",
        flag: "rebase-asked",
        agent: "Jérôme",
        url: "https://x/2",
        headoid: "b".repeat(40),
    },
    { number: 3, branch: "feature/3-c", state: "done", flag: "rebase-typed", agent: "Paul" },
    { number: 4, branch: "feature/4-d", state: "skipped", flag: "agent-busy", agent: "Rita" },
    { number: 5, branch: "feature/5-e", state: "skipped", flag: "needs-agent" },
    { number: 6, branch: "feature/6-f", state: "skipped", flag: "checking" },
    {
        number: 7,
        branch: "feature/7-g",
        state: "failed",
        flag: "needs-rebase",
        error: "the brief could not be written",
    },
];

describe("Validate's other PRs step (#691)", () => {
    it("counts the unaffected PRs and gives one row per PR the merge concerns", () => {
        const step = othersStep(en, result({ prs, unaffected: 1, conflicting: 5, checking: 1, failed: 1 }));
        expect(step.lines).toEqual(["1 unaffected · 5 now conflict with develop · 1 still being checked by GitHub"]);
        expect(step.rows.map((r) => r.id)).toEqual(["pr-2", "pr-3", "pr-4", "pr-5", "pr-6", "pr-7"]);
        const byId = Object.fromEntries(step.rows.map((r) => [r.id, r]));
        expect(byId["pr-2"]).toMatchObject({ state: "done", url: "https://x/2", label: "#2 feature/2-b" });
        expect(byId["pr-2"].lines).toEqual(["Conflicts with develop → rebase asked to Jérôme."]);
        expect(byId["pr-3"].lines[0]).toMatch(/^Conflicts with develop → rebase typed in Paul's prompt/);
        expect(byId["pr-4"]).toMatchObject({ state: "needs" });
        expect(byId["pr-4"].lines[0]).toMatch(/Rita is busy and was not interrupted/);
        expect(byId["pr-5"].startAgent?.number).toBe(5);
        expect(byId["pr-4"].startAgent).toBeUndefined();
        expect(byId["pr-6"]).toMatchObject({ state: "skipped" });
        expect(byId["pr-7"]).toMatchObject({ state: "failed", error: "the brief could not be written" });
        expect(step.state).toBe("failed");
    });

    it("is done with only a count when no PR is affected", () => {
        const step = othersStep(en, result({ prs: [prs[0], { ...prs[0], number: 9 }], unaffected: 2 }));
        expect(step.rows).toEqual([]);
        expect(step.lines).toEqual(["2 unaffected"]);
        expect(step.state).toBe("done");
    });

    it("needs the developer while a PR waits for an agent", () => {
        const step = othersStep(en, result({ prs: [prs[1], prs[4]], conflicting: 2 }));
        expect(step.state).toBe("needs");
    });

    it("words every outcome in French without a missing key", () => {
        const step = othersStep(fr, result({ prs, unaffected: 1, conflicting: 5, checking: 1, failed: 1 }));
        const all = [...step.lines, ...step.rows.flatMap((r) => r.lines)];
        expect(all.join("\n")).not.toMatch(/review\.validate/);
        expect(step.rows[0].lines[0]).toBe("En conflit avec develop → rebase demandé à Jérôme.");
    });
});

describe("cleanupRebaseAsks (#691)", () => {
    it("marks the Reviews rows of the PRs whose agent got the rebase", () => {
        const asks = cleanupRebaseAsks({}, "/p", result({ prs }));
        expect(asks).toEqual({
            [rebaseAskKey("/p", 2)]: { name: "Jérôme", head: "b".repeat(40), at: 40 },
            [rebaseAskKey("/p", 3)]: { name: "Paul", head: "", at: 40 },
        });
    });

    it("keeps an ask recorded since and returns the same object when nothing changes", () => {
        const newer = {
            [rebaseAskKey("/p", 2)]: { name: "Ana", head: "", at: 99 },
            [rebaseAskKey("/p", 3)]: { name: "Paul", head: "", at: 40 },
        };
        expect(cleanupRebaseAsks(newer, "/p", result({ prs }))).toBe(newer);
        expect(cleanupRebaseAsks({}, "/p", null)).toEqual({});
    });
});
