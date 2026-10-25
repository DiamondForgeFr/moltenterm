// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { translate } from "../i18n/i18n-core";
import type { ReviewCleanupResult, ReviewCleanupStepResult } from "../review/review-cleanup";
import {
    busyAgents,
    cleanedUp,
    cleanupNotes,
    keptAgentStep,
    leftoverParts,
    leftoverRows,
    panelsClosable,
} from "./reviews-leftovers-model";
import type { ReviewsAnswer } from "./reviews-model";
import { afterPrText, AgentBarFacts, UpcomingAnswer, UpcomingBranch, UpcomingLeftover } from "./reviews-upcoming-model";

const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const fr = (key: string, vars?: Record<string, string | number>) => translate("fr", key, vars);

const leftover: UpcomingLeftover = {
    branch: "chore/1078-release",
    ticket: 1078,
    pr: 1078,
    title: "Release v1.1.0",
    worktree: "/p/.claude/worktrees/agent-1078",
    local: true,
    remote: true,
};

const camille: AgentBarFacts = { kind: "panel", blockId: "b1", name: "Camille", state: "idle", since: 1 };

function result(steps: ReviewCleanupStepResult[]): ReviewCleanupResult {
    return { repo: "o/r", number: 1078, steps, startedat: 1, endedat: 2 };
}

describe("after-PR wording (#1088)", () => {
    const branch = (b: Partial<UpcomingBranch>): UpcomingBranch => ({
        branch: "feature/5-a",
        ticket: 5,
        ahead: 2,
        ...b,
    });

    it("says the follow-up commits after a merged PR", () => {
        expect(afterPrText(en, branch({ afterpr: 4, afterstate: "merged", aftercount: 2 }))).toBe(
            "after #4 was merged: 2 new commits"
        );
        expect(afterPrText(en, branch({ afterpr: 4, afterstate: "merged", aftercount: 1 }))).toBe(
            "after #4 was merged: 1 new commit"
        );
        expect(afterPrText(en, branch({ afterpr: 4, afterstate: "merged", aftercount: -1 }))).toBe(
            "after #4 was merged: new commits"
        );
        expect(afterPrText(fr, branch({ afterpr: 4, afterstate: "merged", aftercount: 2 }))).toBe(
            "après la fusion de #4 : 2 nouveaux commits"
        );
    });

    it("says a PR closed without merging, with or without commits after it", () => {
        expect(afterPrText(en, branch({ afterpr: 7, afterstate: "closed" }))).toBe("PR #7 closed without merging");
        expect(afterPrText(en, branch({ afterpr: 7, afterstate: "closed", aftercount: 3 }))).toBe(
            "after #7 was closed: 3 new commits"
        );
    });

    it("says nothing for a branch without a closed PR", () => {
        expect(afterPrText(en, branch({}))).toBe("");
    });
});

describe("leftovers (#1088)", () => {
    it("leaves out a branch whose PR the Reviews list shows open again", () => {
        const upcoming = {
            dir: "/p",
            branches: [],
            agents: [],
            leftovers: [leftover, { ...leftover, branch: "fix/9-x", pr: 9 }],
            at: 1,
        } as UpcomingAnswer;
        const reviews = { ready: [], drafts: [{ branch: "fix/9-x" }] } as unknown as ReviewsAnswer;
        expect(leftoverRows(upcoming, reviews).map((l) => l.pr)).toEqual([1078]);
        expect(leftoverRows(null, reviews)).toEqual([]);
    });

    it("names what remains, the idle session as inactive", () => {
        const parts = leftoverParts(en, leftover, [camille]);
        expect(parts.map((p) => p.text)).toEqual([
            "worktree agent-1078",
            "Camille is inactive",
            "local branch chore/1078-release",
            "chore/1078-release on origin",
        ]);
        expect(parts[0].title).toBe(leftover.worktree);
        expect(leftoverParts(fr, leftover, [camille])[1].text).toBe("Camille est inactif");
    });

    it("counts as busy the agents still at work, never the resting ones", () => {
        const agents: AgentBarFacts[] = [
            camille,
            { ...camille, blockId: "b2", state: "done" },
            { ...camille, blockId: "b3", state: "working" },
            { ...camille, blockId: "b4", state: "waiting" },
            { kind: "background", name: "", state: "background", since: 1 },
            { kind: "subagent", name: "", state: "done", since: 1, subState: "done" },
            { kind: "subagent", name: "", state: "working", since: 1, subState: "running" },
        ];
        expect(busyAgents(agents).map((a) => a.blockId ?? a.kind)).toEqual(["b3", "b4", "background", "subagent"]);
    });

    it("closes resting agent sessions by itself, asks for anything else", () => {
        const inuse = (agent: string): ReviewCleanupStepResult => ({
            id: "agent-worktree",
            state: "skipped",
            code: "inuse",
            panels: [{ blockid: "b1", agent }],
        });
        expect(panelsClosable(inuse("idle"), false)).toBe(true);
        expect(panelsClosable(inuse("done"), false)).toBe(true);
        expect(panelsClosable(inuse("working"), false)).toBe(false);
        expect(panelsClosable(inuse("working"), true)).toBe(true);
        expect(panelsClosable(inuse(""), true)).toBe(false);
        expect(panelsClosable({ ...inuse("idle"), code: "kept" }, true)).toBe(false);
    });

    it("finds the kept agent worktree and says what else stayed", () => {
        const kept: ReviewCleanupStepResult = {
            id: "agent-worktree",
            state: "skipped",
            code: "kept",
            path: leftover.worktree,
            loss: { changes: ["a.txt"], changecount: 1, commits: [], commitcount: 0, ignored: [], ignoredcount: 0 },
        };
        const res = result([
            { id: "pr", state: "done", code: "merged" },
            { id: "review-worktree", state: "skipped", code: "noreviewtree" },
            kept,
            { id: "local-branch", state: "skipped", code: "inkepttree", branch: leftover.branch },
            { id: "remote-branch", state: "skipped", code: "pushedafter", branch: leftover.branch },
        ]);
        expect(keptAgentStep(res)).toBe(kept);
        expect(cleanupNotes(en, res, leftover)).toEqual([
            "Kept: origin/chore/1078-release has commits pushed after the merge.",
        ]);
        expect(cleanedUp(res)).toBe(false);
    });

    it("reads a full cleanup as done, a refused merge as a failure", () => {
        const done = result([
            { id: "pr", state: "done", code: "merged" },
            { id: "review-worktree", state: "skipped", code: "noreviewtree" },
            { id: "agent-worktree", state: "done", code: "removed", path: leftover.worktree },
            { id: "local-branch", state: "done", code: "deleted" },
            { id: "remote-branch", state: "done", code: "deleted" },
        ]);
        expect(cleanedUp(done)).toBe(true);
        expect(cleanupNotes(en, done, leftover)).toEqual([]);
        const refused = result([
            { id: "pr", state: "failed", code: "notmerged", error: "open" },
            { id: "agent-worktree", state: "skipped", code: "prunconfirmed" },
        ]);
        expect(cleanedUp(refused)).toBe(false);
        expect(cleanupNotes(en, refused, leftover)).toEqual(["Not everything could be cleaned up: open"]);
    });
});
