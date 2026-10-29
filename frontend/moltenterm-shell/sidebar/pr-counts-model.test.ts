// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { cardState } from "../reviews/reviews-card-model";
import { rebaseAskKey, ReviewPr, ReviewsAnswer } from "../reviews/reviews-model";
import type { AgentBarFacts } from "../reviews/reviews-upcoming-model";
import {
    emptyPrCounts,
    firstPilotageTab,
    hasPrCounts,
    PrCountKinds,
    prCountKind,
    prCounts,
    shownPrKinds,
} from "./pr-counts-model";

function pr(number: number, extra: Partial<ReviewPr> = {}): ReviewPr {
    return {
        number,
        title: `PR ${number}`,
        url: `https://github.com/a/b/pull/${number}`,
        branch: `feature/${number}-x`,
        base: "develop",
        createdat: "2026-10-10T10:00:00Z",
        updatedat: "2026-10-12T10:00:00Z",
        merge: "clean",
        ci: { state: "success", success: 3, failure: 0, pending: 0, checks: [] },
        report: { state: "unknown" },
        unpublished: 0,
        ...extra,
    };
}

function answer(extra: Partial<ReviewsAnswer> = {}): ReviewsAnswer {
    return { dir: "/p", state: "ok", ready: [], drafts: [], githubat: 100, ...extra };
}

function agent(state: AgentBarFacts["state"]): AgentBarFacts {
    return { kind: "panel", blockId: "b1", agent: "claude", name: "Olivia", state, since: 1 };
}

const running = { state: "pending" as const, success: 1, failure: 0, pending: 2, checks: [] };
const failing = {
    state: "failure" as const,
    success: 1,
    failure: 1,
    pending: 0,
    checks: [{ name: "Unit tests", state: "failure" as const }],
};

describe("the status dots' kinds (FR-SHELL-085, #1304)", () => {
    it("read top to bottom blocked, ready, CI running, the agents' turn", () => {
        expect(PrCountKinds).toEqual(["blocked", "ready", "ci", "draft"]);
        expect(shownPrKinds({ blocked: 1, ready: 0, ci: 2, draft: 3 })).toEqual(["blocked", "ci", "draft"]);
        expect(shownPrKinds(emptyPrCounts())).toEqual([]);
    });

    it("moves a failing CI out of the CI dot into the blocked one", () => {
        const counts = prCounts(answer({ ready: [pr(1), pr(2, { ci: running }), pr(3, { ci: failing })] }));
        expect(counts).toEqual({ blocked: 1, ready: 1, ci: 1, draft: 0 });
    });

    it("reads a merge state that says CI fails as blocked, one that says it runs as CI", () => {
        expect(prCountKind(pr(1, { merge: "failing" }))).toBe("blocked");
        expect(prCountKind(pr(2, { merge: "running" }))).toBe("ci");
    });

    it("counts a conflict as blocked, never as ready", () => {
        expect(prCountKind(pr(1, { merge: "conflicts" }))).toBe("blocked");
    });

    it("counts each PR once, drafts in the agents' turn", () => {
        const counts = prCounts(
            answer({
                ready: [pr(1), pr(2), pr(3, { ci: running }), pr(4, { ci: failing }), pr(5, { merge: "conflicts" })],
                drafts: [pr(6, { draft: true }), pr(7, { draft: true })],
            })
        );
        expect(counts).toEqual({ blocked: 2, ready: 2, ci: 1, draft: 2 });
    });

    it("follows the panel's split: a draft marked ready here counts as ready", () => {
        const readied = { [rebaseAskKey("/p", 9)]: 200 };
        expect(prCounts(answer({ drafts: [pr(9, { draft: true })] }), readied)).toEqual({
            blocked: 0,
            ready: 1,
            ci: 0,
            draft: 0,
        });
    });

    it("shows nothing while GitHub could not be read", () => {
        expect(prCounts(answer({ state: "loggedout", ready: [pr(1)] }))).toEqual(emptyPrCounts());
        expect(prCounts(null)).toEqual(emptyPrCounts());
        expect(hasPrCounts(prCounts(null))).toBe(false);
        expect(hasPrCounts({ blocked: 0, ready: 0, ci: 0, draft: 1 })).toBe(true);
    });
});

describe("the status dots follow the panel's card states (#1304)", () => {
    it("an agent waiting on a question blocks, even on a clean PR or a draft", () => {
        const clean = pr(1);
        expect(prCountKind(clean, cardState({ pr: clean, agents: [agent("waiting")] }))).toBe("blocked");
        const draft = pr(2, { draft: true });
        expect(prCountKind(draft, cardState({ pr: draft, agents: [agent("waiting")] }))).toBe("blocked");
    });

    it("a conflict an agent works on is the agents' turn; nobody on it, it blocks", () => {
        const conflict = pr(1, { merge: "conflicts" });
        expect(prCountKind(conflict, cardState({ pr: conflict, agents: [agent("working")] }))).toBe("draft");
        expect(prCountKind(conflict, cardState({ pr: conflict, agents: [] }))).toBe("blocked");
    });

    it("a failing CI nobody works on blocks; CI running stays orange; a clean PR is ready", () => {
        const failed = pr(1, { ci: failing });
        expect(prCountKind(failed, cardState({ pr: failed, agents: [] }))).toBe("blocked");
        const pending = pr(2, { ci: running });
        expect(prCountKind(pending, cardState({ pr: pending, agents: [] }))).toBe("ci");
        const clean = pr(3);
        expect(prCountKind(clean, cardState({ pr: clean, agents: [] }))).toBe("ready");
    });

    it("a draft whose agent stopped before marking it ready stays the agents' turn", () => {
        const draft = pr(1, { draft: true, ci: failing });
        expect(prCountKind(draft, cardState({ pr: draft, agents: [], agentReadies: true }))).toBe("draft");
    });

    it("prCounts reads each PR's card when given", () => {
        const a = pr(1);
        const b = pr(2, { merge: "conflicts" });
        const cards = {
            1: cardState({ pr: a, agents: [agent("waiting")] }),
            2: cardState({ pr: b, agents: [agent("working")] }),
        };
        expect(prCounts(answer({ ready: [a, b] }), undefined, cards)).toEqual({
            blocked: 1,
            ready: 0,
            ci: 0,
            draft: 1,
        });
    });
});

describe("firstPilotageTab (FR-SHELL-085: one place per area)", () => {
    it("picks the first block whose view holds the panel", () => {
        expect(
            firstPilotageTab([
                { tabId: "a", views: ["term"] },
                { tabId: "b", views: ["term", "molten-reviews"] },
                { tabId: "c", views: ["molten-reviews"] },
            ])
        ).toBe("b");
    });

    it("gives none when no block shows the panel", () => {
        expect(firstPilotageTab([{ tabId: "a", views: ["web"] }])).toBe("");
        expect(firstPilotageTab([])).toBe("");
    });
});
