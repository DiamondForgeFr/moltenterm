// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentStateName, AgentStatesData } from "../agent-state-model";
import { wordPhrase } from "../i18n/phrase";
import { QueuedAsk, ReviewsAskQueue } from "./reviews-ask-queue";
import type { RebaseOutcome, ReviewPr } from "./reviews-model";

function pr(number: number, headoid = "aaa"): ReviewPr {
    return {
        number,
        title: `PR ${number}`,
        url: `https://github.com/a/b/pull/${number}`,
        branch: `feature/${number}-x`,
        base: "develop",
        headoid,
        createdat: "",
        updatedat: "",
        merge: "conflicts",
        ci: { state: "success", success: 1, failure: 0, pending: 0, checks: [] },
        report: { state: "present" },
        unpublished: 0,
    };
}

// The fake agents' states, as the windows publish them.
function states(of: Record<string, AgentStateName>): AgentStatesData {
    const rtn: AgentStatesData = { states: {}, versions: {} };
    for (const [blockid, state] of Object.entries(of)) {
        rtn.states[blockid] = { blockid, state, version: 1 };
    }
    return rtn;
}

const Nathan = { blockId: "blk-nathan", name: "Nathan" };

// Lets the sender's promise settle.
async function settled() {
    await Promise.resolve();
    await Promise.resolve();
}

describe("queued asks for a busy agent (#1062, FR-REV-022 AC12)", () => {
    let queue: ReviewsAskQueue;
    let current: AgentStatesData;
    let sent: QueuedAsk[];
    let answer: RebaseOutcome;

    beforeEach(() => {
        ReviewsAskQueue.resetInstance();
        queue = ReviewsAskQueue.getInstance();
        current = states({ "blk-nathan": "working" });
        sent = [];
        answer = { kind: "asked", name: "Nathan", text: { key: "reviews.rebase.asked" } };
        queue.statesOf = () => current;
        queue.sender = vi.fn(async (ask: QueuedAsk) => {
            sent.push(ask);
            return answer;
        });
    });
    afterEach(() => ReviewsAskQueue.resetInstance());

    it("waits while the agent works, and hands the rebase over once it is idle", async () => {
        queue.queue({ dir: "/p", repo: "a/b", pr: pr(4), kind: "rebase", agent: Nathan, mergedPr: 3 });
        expect(sent).toEqual([]);
        expect(queue.get("/p", 4)).toMatchObject({ kind: "rebase", agent: Nathan });
        current = states({ "blk-nathan": "waiting" });
        queue.check(current);
        expect(sent).toEqual([]);
        current = states({ "blk-nathan": "idle" });
        queue.check(current);
        expect(queue.get("/p", 4).sending).toBe(true);
        // A second state change while it is being handed over sends nothing more.
        queue.check(states({ "blk-nathan": "done" }));
        await settled();
        expect(sent).toHaveLength(1);
        expect(sent[0]).toMatchObject({ kind: "rebase", mergedPr: 3, pr: { number: 4 } });
        expect(queue.get("/p", 4)).toBeUndefined();
    });

    it("sends at once when the agent is already free", async () => {
        current = states({ "blk-nathan": "idle" });
        queue.queue({ dir: "/p", repo: "a/b", pr: pr(4, "aaa"), kind: "investigate", agent: Nathan });
        await settled();
        expect(sent.map((a) => a.kind)).toEqual(["investigate"]);
    });

    it("follows the PR's new head while it waits, and drops the ask when the PR leaves the list", () => {
        queue.queue({ dir: "/p", repo: "a/b", pr: pr(4, "aaa"), kind: "rebase", agent: Nathan });
        queue.refresh("/p", [pr(4, "bbb")]);
        expect(queue.get("/p", 4).pr.headoid).toBe("bbb");
        queue.refresh("/p", []);
        expect(wordPhrase(queue.get("/p", 4).failed)).toBe("#4 left the list: the queued ask was dropped.");
        queue.check(states({}));
        expect(sent).toEqual([]);
        queue.cancel("/p", 4);
        expect(queue.get("/p", 4)).toBeUndefined();
    });

    it("waits for another busy agent of the worktree, and says why when nobody can take it", async () => {
        queue.queue({ dir: "/p", repo: "a/b", pr: pr(4), kind: "rebase", agent: Nathan });
        answer = {
            kind: "info",
            text: { key: "reviews.rebase.working" },
            busy: { blockId: "blk-jeanne", name: "Jeanne" },
        };
        current = states({ "blk-nathan": "idle", "blk-jeanne": "working" });
        queue.check(current);
        await settled();
        expect(queue.get("/p", 4)).toMatchObject({ agent: { name: "Jeanne" }, sending: false });
        answer = { kind: "offer", text: { key: "reviews.rebase.offer" } };
        queue.check(states({ "blk-nathan": "idle", "blk-jeanne": "done" }));
        await settled();
        expect(wordPhrase(queue.get("/p", 4).failed)).toBe(
            "Jeanne no longer works on the branch: the queued ask was not sent."
        );
        expect(sent).toHaveLength(2);
    });

    it("cancels before the agent is free: nothing is sent", () => {
        queue.queue({ dir: "/p", repo: "a/b", pr: pr(4), kind: "rebase", agent: Nathan });
        queue.cancel("/p", 4);
        queue.check(states({ "blk-nathan": "idle" }));
        expect(sent).toEqual([]);
        expect(globalStore.get(queue.asksAtom)).toEqual({});
    });
});
