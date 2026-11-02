// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The merge queue's agent on the cards (#1128, FR-REV-026 AC13): the card of the PR the running queue works on is in
// "Agents on it" with the agent's line at each step, back in its own section once the queue leaves it; a hidden ended
// run keeps its pointer while its agent's session is open.

import { describe, expect, it } from "vitest";
import type { AgentStatesData } from "../agent-state-model";
import { wordPhrase } from "../i18n/phrase";
import { batchPointerShown, batchWorkItem } from "./reviews-batch-agent";
import type { BatchItem, BatchItemState, BatchRun } from "./reviews-batch-model";
import { cardState } from "./reviews-card-model";
import type { ReviewPr } from "./reviews-model";
import { CardContext, cardInputOf } from "./reviews-sections-model";

const Now = 10 * 3_600_000;

function pr(number: number, over: Partial<ReviewPr> = {}): ReviewPr {
    return {
        number,
        title: `PR ${number}`,
        url: `https://github.com/acme/app/pull/${number}`,
        branch: `feature/${number}-x`,
        base: "develop",
        headoid: "abc",
        createdat: "",
        updatedat: "",
        merge: "conflicts",
        ci: { state: "success", success: 1, failure: 0, pending: 0, checks: [{ name: "Backend", state: "success" }] },
        report: { state: "present" },
        unpublished: 0,
        ...over,
    };
}

function item(number: number, ticket: number, state: BatchItemState, over: Partial<BatchItem> = {}): BatchItem {
    return { number, ticket, headref: `feature/${ticket}-x`, headoid: "abc", state, source: "batch", ...over };
}

function run(first: BatchItem, over: Partial<BatchRun> = {}): BatchRun {
    return {
        id: "r1",
        dir: "/p",
        repo: "acme/app",
        base: "develop",
        state: "running",
        current: 0,
        items: [first, item(1119, 1105, "queued")],
        ciruns: 0,
        agent: "claude",
        agentname: "Claude Code",
        blockid: "remi",
        startedat: Now - 600_000,
        ...over,
    };
}

const States: AgentStatesData = {
    states: { remi: { state: "idle", firstname: "Rémi", agent: "claude", since: Now - 60_000 } },
} as unknown as AgentStatesData;

function ctxOf(r: BatchRun, states: AgentStatesData = States): CardContext {
    return { upcoming: null, states, now: Now, boardText: (s) => s, batchRun: (base) => (base === r?.base ? r : null) };
}

function cardOf(p: ReviewPr, r: BatchRun, states?: AgentStatesData) {
    return cardState(cardInputOf(p, null, ctxOf(r, states)));
}

describe("the card of a PR in a running group merge", () => {
    it("is in the agents' section while the queue reads it, rebases it, waits for its checks and merges it", () => {
        const steps: [BatchItemState, Partial<BatchItem>, string][] = [
            ["checking", {}, "Read on GitHub before its merge"],
            ["rebasing", {}, "Rémi rebases it on develop"],
            ["waitingchecks", { rebases: 1 }, "Rebased by Rémi, waits for its checks"],
            ["waitingchecks", {}, "Waits for its checks before its merge"],
            ["merging", {}, "Merging"],
        ];
        for (const [state, over, sentence] of steps) {
            const card = cardOf(pr(1118), run(item(1118, 1102, state, over)));
            expect(card.turn, state).toBe("agents");
            expect(card.kind).toBe("agent-working");
            expect(wordPhrase(card.sentence)).toBe(sentence);
            expect(card.agent?.batch).toBe(true);
            expect(card.agent?.name).toBe("Rémi");
            expect(wordPhrase(card.agent?.work)).toBe("group merge: #1102 → #1105");
            // Go to the agent's terminal; the queue's agent is never stopped from a card (the banner stops the queue).
            expect(card.primary?.id).toBe("follow");
            expect(card.primary?.blockId).toBe("remi");
            expect(card.menu.map((a) => a.id)).not.toContain("stop");
            expect(card.menu.map((a) => a.id)).not.toContain("open-work");
        }
    });

    it("says nothing of the conflict the agent is rebasing away, or rebased before the list read GitHub again", () => {
        for (const it of [item(1118, 1102, "rebasing"), item(1118, 1102, "waitingchecks", { rebases: 1 })]) {
            const card = cardOf(pr(1118), run(it));
            expect(card.why).toBeUndefined();
            expect(card.facts.map((f) => f.id)).not.toContain("conflicts");
        }
    });

    it("keeps its own section while it waits its turn", () => {
        const r = run(item(1118, 1102, "rebasing"));
        const waiting = cardOf(pr(1119), r);
        expect(waiting.turn).toBe("blocked");
        expect(waiting.agent).toBeUndefined();
    });

    it("goes back to its own section once the queue left it: done, voided, set aside or the queue ended", () => {
        expect(cardOf(pr(1118), run(item(1118, 1102, "merged"))).turn).toBe("blocked");
        expect(cardOf(pr(1118), run(item(1118, 1102, "voided"))).turn).toBe("blocked");
        expect(cardOf(pr(1118, { merge: "clean" }), run(item(1118, 1102, "failed"))).turn).toBe("ready");
        expect(cardOf(pr(1118), run(item(1118, 1102, "rebasing"), { state: "cancelled" })).turn).toBe("blocked");
    });

    it("is the developer's when the agent waits for an answer", () => {
        const card = cardOf(pr(1118), run(item(1118, 1102, "rebasing", { waiting: true })));
        expect(card.turn).toBe("yours");
        expect(card.kind).toBe("agent-waiting");
        expect(card.primary?.id).toBe("answer");
        expect(card.primary?.blockId).toBe("remi");
    });

    it("names the agent before its terminal is known, without a terminal to reach", () => {
        const r = run(item(1118, 1102, "rebasing"), { blockid: "", agentname: "" });
        const card = cardOf(pr(1118), r, { states: {} } as unknown as AgentStatesData);
        expect(card.turn).toBe("agents");
        expect(wordPhrase(card.sentence)).toBe("Your agent rebases it on develop");
        expect(card.primary).toBeNull();
    });

    it("is no agent's work when a queue without an agent waits for a green PR's checks", () => {
        const r = run(item(1118, 1102, "waitingchecks", { source: "validate" }), { blockid: "", agentname: "" });
        expect(batchWorkItem(r, pr(1118, { merge: "clean" }))).toBeNull();
        const card = cardOf(pr(1118, { merge: "clean" }), r);
        expect(card.turn).toBe("ready");
    });

    it("names the merge queue when the PRs came from Validate", () => {
        const r = run(item(1118, 1102, "rebasing", { source: "validate" }), {
            items: [item(1118, 1102, "rebasing", { source: "validate" })],
        });
        expect(wordPhrase(cardOf(pr(1118), r).agent?.work)).toBe("merge queue: #1102");
    });
});

describe("the pointer of a hidden ended run", () => {
    const ended = run(item(1118, 1102, "merged"), { state: "done", dismissed: true });

    it("shows while the agent's session is open", () => {
        expect(batchPointerShown(ended, States)).toBe(true);
    });

    it("goes when the session closes, and never shows for a run still on screen or running", () => {
        expect(batchPointerShown(ended, { states: {} } as unknown as AgentStatesData)).toBe(false);
        expect(batchPointerShown({ ...ended, dismissed: false }, States)).toBe(false);
        expect(batchPointerShown({ ...ended, state: "running" }, States)).toBe(false);
        expect(batchPointerShown({ ...ended, blockid: "" }, States)).toBe(false);
        expect(batchPointerShown(null, States)).toBe(false);
    });
});
