// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "vitest";
import { agentWorkText, batchOriginOf, branchTicketNumber, shownNumber } from "./agent-work-model";
import { I18nModel } from "./i18n/i18n";
import { OriginMetaKey } from "./reviews/agent-origin";
import type { BatchItem, BatchRun } from "./reviews/reviews-batch-model";
import { batchHeadline, batchSummary, batchTitle } from "./reviews/reviews-batch-model";

const At = Date.UTC(2026, 9, 25, 19, 30);

function origin(kind: string, extra: Record<string, unknown> = {}) {
    return { [OriginMetaKey]: { kind, repo: "o/r", number: 0, branch: "", mode: "background", at: At, ...extra } };
}

function item(number: number, ticket: number, state: BatchItem["state"]): BatchItem {
    return { number, ticket, headref: `feature/${ticket}-x`, headoid: "h", state, source: "batch" };
}

// The gold's case (#1123): #1118 for ticket #1102 merged, #1119 for #1105 voided after a push.
function goldRun(): BatchRun {
    return {
        id: "r",
        dir: "/p",
        repo: "o/r",
        base: "develop",
        state: "running",
        current: 1,
        items: [item(1118, 1102, "merged"), item(1119, 1105, "waitingchecks")],
        ciruns: 1,
        blockid: "b1",
        startedat: At,
    };
}

describe("agent work (#1123)", () => {
    afterEach(() => I18nModel.getInstance().setLanguageSetting("en"));

    it("reads a branch's ticket and the number a card shows", () => {
        expect(branchTicketNumber("feature/1102-pipeline")).toBe(1102);
        expect(branchTicketNumber("fix/7")).toBe(7);
        expect(branchTicketNumber("worktree-agent-ab1")).toBe(0);
        expect(shownNumber(1118, 1102)).toBe(1102);
        expect(shownNumber(1118, 0, "feature/1102-x")).toBe(1102);
        expect(shownNumber(1118, 0, "main")).toBe(1118);
    });

    it("names the group merge's PRs in order with the cards' numbers and how many merged", () => {
        I18nModel.getInstance().setLanguageSetting("fr");
        const meta = origin("batch", { base: "develop", count: 2 });
        expect(batchOriginOf(meta)?.base).toBe("develop");
        expect(agentWorkText(meta, goldRun())).toBe("fusion groupée : #1102 → #1105 · 1 sur 2 fusionnée");
        const both = { ...goldRun(), items: [item(1118, 1102, "merged"), item(1119, 1105, "merged")] };
        expect(agentWorkText(meta, both)).toBe("fusion groupée : #1102 → #1105 · 2 sur 2 fusionnées");
        I18nModel.getInstance().setLanguageSetting("en");
        expect(agentWorkText(meta, goldRun())).toBe("group merge: #1102 → #1105 · 1 of 2 merged");
        // The run not read yet, or another run's: the origin's count and base.
        expect(agentWorkText(meta, null)).toBe("group merge of 2 PRs into develop");
    });

    it("names a review agent's PR by its ticket", () => {
        I18nModel.getInstance().setLanguageSetting("fr");
        expect(agentWorkText(origin("rebase", { number: 1110, branch: "feature/1108-one-number" }))).toBe(
            "rebase de #1108"
        );
        expect(agentWorkText(origin("restart", { number: 1110, branch: "main" }))).toBe(
            "commentaires de revue sur #1110"
        );
        expect(agentWorkText(origin("investigate", { number: 1110, branch: "fix/1107-x" }))).toBe("CI de #1107");
        expect(agentWorkText(origin("finish", { number: 1110, branch: "fix/1107-x" }))).toBe("finition de #1107");
        expect(agentWorkText(origin("release", { tag: "v1.0.0-6" }))).toBe("version v1.0.0-6");
        expect(
            agentWorkText({ "molten:reviewsession": { repo: "o/r", number: 1111, headref: "feature/1107-x" } })
        ).toBe("revue de #1107");
    });

    it("says nothing for a terminal MoltenTerm did not start for a task", () => {
        expect(agentWorkText({})).toBe("");
        expect(agentWorkText(null)).toBe("");
        expect(agentWorkText({ [OriginMetaKey]: { kind: "other", number: 1, at: At } })).toBe("");
        expect(batchOriginOf(origin("rebase", { number: 3 }))).toBeNull();
    });

    it("leads the queue's banner with the agent and the cards' numbers", () => {
        I18nModel.getInstance().setLanguageSetting("fr");
        const run = goldRun();
        expect(batchHeadline(run, "Pauline")).toBe("Pauline · fusion groupée : #1102 → #1105");
        expect(batchHeadline(run, "")).toBe("Fusion groupée : #1102 → #1105");
        const validated = { ...run, items: run.items.map((it) => ({ ...it, source: "validate" as const })) };
        expect(batchHeadline(validated, "Pauline")).toBe("Pauline · file de fusion : #1102 → #1105");
        expect(batchTitle(run)).toContain("#1105 attend ses checks");
        expect(batchHeadline(run, "Pauline", { 1118: 1118, 1119: 1119 })).toBe(
            "Pauline · fusion groupée : #1118 → #1119"
        );
        const ended = { ...run, state: "done" as const, current: -1, items: [run.items[0], { ...run.items[1], state: "voided" as const, reason: "pushed" as const }] };
        expect(batchSummary(ended)).toContain("Fusionnées : #1102.");
        expect(batchSummary(ended)).toContain("#1105 (");
    });
});
