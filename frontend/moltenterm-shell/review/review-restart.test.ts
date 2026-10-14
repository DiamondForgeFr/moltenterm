// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { ReviewRound, ReviewState } from "./review-client";
import {
    folderName,
    lastPublished,
    pushedSinceRound,
    restartButtonTitle,
    restartLine,
    restartResultTone,
    RestartText,
} from "./review-restart";

const A = "a".repeat(40);
const B = "b".repeat(40);

function stateWith(rounds: ReviewRound[]): ReviewState {
    return { repo: "acme/app", number: 9, viewed: {}, rounds };
}

describe("Restart work (FR-REV-011)", () => {
    it("is enabled once a round is published, on the last published one (AC1)", () => {
        expect(lastPublished(stateWith([]))).toBeNull();
        expect(lastPublished(null)).toBeNull();
        const draft = stateWith([{ id: "r1", startedat: 1, headoid: A }]);
        expect(lastPublished(draft)).toBeNull();
        expect(restartButtonTitle(lastPublished(draft))).toBe(RestartText.noRound);
        const two = stateWith([
            { id: "r1", startedat: 1, headoid: A, publishedat: 2 },
            { id: "r2", startedat: 3, headoid: B, publishedat: 4 },
            { id: "r3", startedat: 5, headoid: B },
        ]);
        const last = lastPublished(two);
        expect(last.round.id).toBe("r2");
        expect(last.number).toBe(2);
        expect(restartButtonTitle(last)).toContain("review round 2");
    });

    it("shows the agent's state, then that its terminal closed (AC3)", () => {
        const round: ReviewRound = { id: "r1", startedat: 1, headoid: A, publishedat: 2 };
        expect(restartLine({ round, number: 1 }, null)).toBe("");
        const restarted = { round: { ...round, restartedat: 3, restartblockid: "b1" }, number: 1 };
        expect(restartLine(restarted, { blockid: "b1", version: 1, agentname: "Claude Code", state: "working" })).toBe(
            "Claude Code working on review round 1"
        );
        expect(
            restartLine(restarted, {
                blockid: "b1",
                version: 2,
                agentname: "Codex",
                firstname: "Jérôme",
                state: "waiting",
            })
        ).toBe("[Jérôme] Codex waiting for you on review round 1");
        expect(restartLine(restarted, null)).toBe(RestartText.noAgentNow(1));
        expect(restartButtonTitle(restarted)).toBe(RestartText.again(1));
    });

    it("tells the agent pushed once the head moved past the round (AC3)", () => {
        const round: ReviewRound = { id: "r1", startedat: 1, headoid: A, publishedat: 2 };
        expect(pushedSinceRound({ round, number: 1 }, B)).toBe(false);
        const restarted = { round: { ...round, restartedat: 3 }, number: 1 };
        expect(pushedSinceRound(restarted, A)).toBe(false);
        expect(pushedSinceRound(restarted, null)).toBe(false);
        expect(pushedSinceRound(restarted, B)).toBe(true);
    });

    it("names the worktree by its folder and tones the outcome", () => {
        expect(folderName("/code/app/.claude/worktrees/feature-9-x")).toBe("feature-9-x");
        expect(folderName("/code/app/")).toBe("app");
        expect(folderName("")).toBe("");
        expect(restartResultTone({ status: "started" })).toBe("ok");
        expect(restartResultTone({ status: "sent" })).toBe("ok");
        expect(restartResultTone({ status: "busy" })).toBe("warn");
        expect(restartResultTone({ status: "typed" })).toBe("warn");
        expect(restartResultTone({ status: "failed" })).toBe("fail");
    });
});
