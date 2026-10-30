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
    leftoverState,
    leftoverSteps,
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
            "après la fusion de #4\u00a0: 2 nouveaux commits"
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

describe("what else a done PR left (#1121)", () => {
    const closed: UpcomingLeftover = {
        branch: "fix/126-external-org",
        ticket: 126,
        pr: 135,
        state: "closed",
        base: "develop",
        worktree: "/p/.claude/worktrees/agent-126",
        lock: "ended",
        lockpid: 75896,
        local: true,
    };

    it("says why each part is a leftover, in English and in French", () => {
        expect(leftoverState(en, closed)).toBe("#135 closed · its content is already in develop");
        expect(leftoverState(fr, closed)).toBe("#135 fermée · son contenu est déjà dans develop");
        expect(leftoverState(en, leftover)).toBe("#1078 merged · leftovers");
        expect(leftoverParts(en, closed, []).map((p) => p.text)).toEqual([
            "worktree agent-126, locked by an agent session that ended",
            "local branch fix/126-external-org",
        ]);
        expect(leftoverParts(fr, { ...closed, lock: "held" }, [])[0].text).toBe(
            "worktree agent-126, verrouillé\u00a0: le nettoyage le conserve"
        );
        const copies: UpcomingLeftover = {
            branch: "feature/164-x",
            pr: 164,
            state: "merged",
            reviewtree: "/data/molten/worktrees/p-1/review-164",
            copies: ["pr164"],
        };
        expect(leftoverParts(en, copies, []).map((p) => [p.kind, p.text])).toEqual([
            ["review", "review worktree review-164, left by a merge outside Validate"],
            ["copy", "local copy pr164 of the pull request"],
        ]);
        expect(leftoverParts(fr, copies, []).map((p) => p.text)).toEqual([
            "worktree de revue review-164, laissé par une fusion hors de Valider",
            "copie locale pr164 de la pull request",
        ]);
    });

    it("asks only the steps the card's facts need", () => {
        expect(leftoverSteps(leftover)).toEqual(["review-worktree", "agent-worktree", "local-branch"]);
        expect(leftoverSteps({ branch: "b", pr: 164, copies: ["pr164"] })).toEqual(["review-worktree", "copy-branches"]);
    });

    it("words the kept copies and a closed PR's kept branches", () => {
        const res = result([
            { id: "copy-branches", state: "skipped", code: "copieskept", names: ["pr164", "pr-164"] },
            { id: "local-branch", state: "skipped", code: "kept", branch: closed.branch, base: "develop" },
            { id: "remote-branch", state: "skipped", code: "kept", branch: closed.branch, base: "develop" },
            { id: "agent-worktree", state: "skipped", code: "lockheld", path: closed.worktree },
        ]);
        expect(cleanupNotes(en, res, closed)).toEqual([
            "Kept pr164, pr-164: they hold commits that are not in the pull request or in the base branch.",
            "Kept: fix/126-external-org holds commits that are not in develop.",
            "Kept: origin/fix/126-external-org holds commits that are not in develop.",
            "Left as it is: the session that locked the worktree is still running.",
        ]);
        expect(cleanupNotes(fr, res, closed)).toEqual([
            "pr164, pr-164 conservées\u00a0: elles contiennent des commits absents de la pull request et de la branche de base.",
            "Conservée\u00a0: fix/126-external-org contient des commits absents de develop.",
            "Conservée\u00a0: origin/fix/126-external-org contient des commits absents de develop.",
            "Laissé tel quel\u00a0: la session qui a verrouillé le worktree tourne encore.",
        ]);
        expect(cleanedUp(res)).toBe(false);
    });
});
