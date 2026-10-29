// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { AgentStatesData } from "../agent-state-model";
import En from "../i18n/locales/en.json";
import Fr from "../i18n/locales/fr.json";
import { cardState } from "../reviews/reviews-card-model";
import { rebaseAskKey, ReviewPr, ReviewsAnswer } from "../reviews/reviews-model";
import { cardStates, sectionsByTurn } from "../reviews/reviews-sections-model";
import type { AgentBarFacts } from "../reviews/reviews-upcoming-model";
import {
    emptyPrCounts,
    firstPilotageTab,
    hasPrCounts,
    PrCountKinds,
    prCountKind,
    prCountSectionKey,
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

const reviewRequired = { merge: "blocked" as const, reviewdecision: "REVIEW_REQUIRED" };

describe("the status dots' kinds (FR-SHELL-098, #1327)", () => {
    it("read top to bottom blocked, yours, ready, running, with the agents", () => {
        expect(PrCountKinds).toEqual(["blocked", "yours", "ready", "waiting", "agents"]);
        expect(shownPrKinds({ blocked: 1, yours: 0, ready: 0, waiting: 2, agents: 3 })).toEqual([
            "blocked",
            "waiting",
            "agents",
        ]);
        expect(shownPrKinds(emptyPrCounts())).toEqual([]);
    });

    it("are named after the panel's own section titles", () => {
        expect(PrCountKinds.map(prCountSectionKey)).toEqual([
            "reviews.sections.blocked",
            "reviews.sections.yours",
            "reviews.sections.ready",
            "reviews.sections.waiting",
            "reviews.sections.agents",
        ]);
        for (const locale of [En, Fr]) {
            for (const kind of PrCountKinds) {
                const key = prCountSectionKey(kind).split(".");
                expect(typeof key.reduce((node: any, part) => node?.[part], locale)).toBe("string");
            }
        }
    });

    it("moves a failing CI into blocked, a running one into running", () => {
        const counts = prCounts(answer({ ready: [pr(1), pr(2, { ci: running }), pr(3, { ci: failing })] }));
        expect(counts).toEqual({ blocked: 1, yours: 0, ready: 1, waiting: 1, agents: 0 });
    });

    it("reads a merge state that says CI runs as running, as the panel's card does", () => {
        expect(prCountKind(pr(2, { merge: "running" }))).toBe("waiting");
    });

    it("counts a conflict as blocked, never as ready", () => {
        expect(prCountKind(pr(1, { merge: "conflicts" }))).toBe("blocked");
    });

    it("never counts a PR the panel shows as Review required as ready (AC2)", () => {
        const counts = prCounts(answer({ ready: [pr(1), pr(2, reviewRequired)] }));
        expect(counts).toEqual({ blocked: 0, yours: 1, ready: 1, waiting: 0, agents: 0 });
    });

    it("counts each PR once, drafts with the agents or yours as their card says", () => {
        const agentDraft = pr(6, { draft: true });
        const cards = { 6: cardState({ pr: agentDraft, agents: [agent("working")] }) };
        const counts = prCounts(
            answer({
                ready: [pr(1), pr(2), pr(3, { ci: running }), pr(4, { ci: failing }), pr(5, { merge: "conflicts" })],
                drafts: [agentDraft, pr(7, { draft: true })],
            }),
            undefined,
            cards
        );
        expect(counts).toEqual({ blocked: 2, yours: 1, ready: 2, waiting: 1, agents: 1 });
    });

    it("follows the panel's split: a draft marked ready here counts as ready", () => {
        const readied = { [rebaseAskKey("/p", 9)]: 200 };
        expect(prCounts(answer({ drafts: [pr(9, { draft: true })] }), readied)).toEqual({
            blocked: 0,
            yours: 0,
            ready: 1,
            waiting: 0,
            agents: 0,
        });
    });

    it("shows nothing while GitHub could not be read", () => {
        expect(prCounts(answer({ state: "loggedout", ready: [pr(1)] }))).toEqual(emptyPrCounts());
        expect(prCounts(null)).toEqual(emptyPrCounts());
        expect(hasPrCounts(prCounts(null))).toBe(false);
        expect(hasPrCounts({ ...emptyPrCounts(), agents: 1 })).toBe(true);
    });
});

describe("the status dots count what the panel's sections list (FR-SHELL-098 AC1, #1327)", () => {
    it("one PR per state: every dot's count is the length of the section of the same name", () => {
        const prs = [
            pr(1),
            pr(2, reviewRequired),
            pr(3, { ci: running }),
            pr(4, { merge: "conflicts" }),
            pr(5, { ci: failing }),
            pr(6, { draft: true }),
            pr(7),
        ];
        const cards = cardStates(prs, {}, (n) => `/p#${n}`, {
            upcoming: {
                dir: "/p",
                branches: [],
                agents: [
                    {
                        branch: "feature/6-x",
                        worktree: "/w/6",
                        kind: "panel",
                        blockid: "b1",
                        started: 1,
                    },
                ],
                drafts: [],
                at: 1,
            },
            states: { states: { b1: { state: "working", firstname: "Olivia", since: 1 } } } as unknown as AgentStatesData,
            now: 100_000,
            boardText: (s) => s,
        });
        const counts = prCounts(answer({ ready: prs.filter((p) => !p.draft), drafts: [prs[5]] }), undefined, cards);
        const sections = sectionsByTurn(prs, cards, "state");
        for (const kind of PrCountKinds) {
            expect(counts[kind], kind).toBe(sections.find((s) => s.turn === kind)?.prs.length ?? 0);
        }
        expect(counts).toEqual({ blocked: 2, yours: 1, ready: 2, waiting: 1, agents: 1 });
    });
});

describe("the status dots follow the panel's card states (#1304)", () => {
    it("an agent waiting on a question is yours, on a clean PR or a draft", () => {
        const clean = pr(1);
        expect(prCountKind(clean, cardState({ pr: clean, agents: [agent("waiting")] }))).toBe("yours");
        const draft = pr(2, { draft: true });
        expect(prCountKind(draft, cardState({ pr: draft, agents: [agent("waiting")] }))).toBe("yours");
    });

    it("a conflict an agent works on is with the agents; nobody on it, it blocks", () => {
        const conflict = pr(1, { merge: "conflicts" });
        expect(prCountKind(conflict, cardState({ pr: conflict, agents: [agent("working")] }))).toBe("agents");
        expect(prCountKind(conflict, cardState({ pr: conflict, agents: [] }))).toBe("blocked");
    });

    it("a failing CI nobody works on blocks; CI running is running; a clean PR is ready", () => {
        const failed = pr(1, { ci: failing });
        expect(prCountKind(failed, cardState({ pr: failed, agents: [] }))).toBe("blocked");
        const pending = pr(2, { ci: running });
        expect(prCountKind(pending, cardState({ pr: pending, agents: [] }))).toBe("waiting");
        const clean = pr(3);
        expect(prCountKind(clean, cardState({ pr: clean, agents: [] }))).toBe("ready");
    });

    it("a draft whose agent stopped before marking it ready stays with the agents", () => {
        const draft = pr(1, { draft: true, ci: failing });
        expect(prCountKind(draft, cardState({ pr: draft, agents: [], agentReadies: true }))).toBe("agents");
    });

    it("prCounts reads each PR's card when given", () => {
        const a = pr(1);
        const b = pr(2, { merge: "conflicts" });
        const cards = {
            1: cardState({ pr: a, agents: [agent("waiting")] }),
            2: cardState({ pr: b, agents: [agent("working")] }),
        };
        expect(prCounts(answer({ ready: [a, b] }), undefined, cards)).toEqual({
            blocked: 0,
            yours: 1,
            ready: 0,
            waiting: 0,
            agents: 1,
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
