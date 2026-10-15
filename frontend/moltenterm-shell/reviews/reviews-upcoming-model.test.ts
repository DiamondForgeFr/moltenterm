// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { AgentStatesData } from "../agent-state-model";
import { t } from "../i18n/i18n";
import type { ReviewPr, ReviewsAnswer } from "./reviews-model";
import {
    aheadText,
    barTimeText,
    branchAgent,
    draftIsYours,
    durationText,
    UpcomingAnswer,
    upcomingRows,
} from "./reviews-upcoming-model";

const Now = new Date(2026, 9, 15, 20, 53).getTime();

function answer(extra: Partial<UpcomingAnswer> = {}): UpcomingAnswer {
    return { dir: "/p", branches: [], agents: [], at: Now, ...extra };
}

function states(infos: Record<string, Partial<AgentStatesData["states"][string]>>): AgentStatesData {
    const rtn: AgentStatesData = { states: {}, versions: {} };
    for (const [blockid, info] of Object.entries(infos)) {
        rtn.states[blockid] = { blockid, version: 1, ...info };
        rtn.versions[blockid] = 1;
    }
    return rtn;
}

describe("upcomingRows (#712 AC1)", () => {
    it("drops a branch as soon as the Reviews list shows its PR", () => {
        const upcoming = answer({
            branches: [
                { branch: "feature/1-a", ticket: 1, ahead: 2 },
                { branch: "feature/2-b", ticket: 2, ahead: 1 },
            ],
        });
        const reviews = { dir: "/p", ready: [], drafts: [{ branch: "feature/2-b" } as ReviewPr] } as ReviewsAnswer;
        expect(upcomingRows(upcoming, reviews).map((b) => b.branch)).toEqual(["feature/1-a"]);
        expect(upcomingRows(null, reviews)).toEqual([]);
    });
});

describe("branchAgent (#712 AC2, AC4)", () => {
    const upcoming = answer({
        agents: [
            {
                branch: "feature/1-a",
                worktree: "/w/a",
                kind: "panel",
                blockid: "b1",
                agent: "claude",
                started: Now - 12 * 60_000,
            },
            {
                branch: "feature/1-a",
                worktree: "/w/a",
                kind: "panel",
                blockid: "b2",
                agent: "codex",
                started: Now - 60_000,
            },
            {
                branch: "feature/2-b",
                worktree: "/w/b",
                kind: "background",
                agent: "claude",
                activeat: Now - 3 * 60_000,
                parentblockid: "b9",
            },
            { branch: "feature/3-c", worktree: "/w/c", kind: "panel", blockid: "gone" },
        ],
    });

    it("reads the live state and first name, the most urgent panel first", () => {
        const live = states({
            b1: { agent: "claude", firstname: "Valentin", state: "working" },
            b2: { agent: "codex", firstname: "Jérôme", state: "waiting" },
        });
        expect(branchAgent(upcoming, live, "feature/1-a")).toMatchObject({
            kind: "panel",
            blockId: "b2",
            name: "Jérôme",
            state: "waiting",
        });
        const working = states({
            b1: { agent: "claude", firstname: "Valentin", state: "working" },
            b2: { agent: "codex", state: "idle" },
        });
        expect(branchAgent(upcoming, working, "feature/1-a")).toMatchObject({
            blockId: "b1",
            name: "Valentin",
            state: "working",
            since: Now - 12 * 60_000,
        });
    });

    it("names a background agent's parent from the live states", () => {
        const live = states({ b9: { agent: "claude", firstname: "Valentin" } });
        expect(branchAgent(upcoming, live, "feature/2-b")).toMatchObject({
            kind: "background",
            state: "background",
            parentBlockId: "b9",
            parentName: "Valentin",
        });
    });

    it("shows nothing for a closed panel or a branch without agent", () => {
        expect(branchAgent(upcoming, states({}), "feature/3-c")).toBeNull();
        expect(branchAgent(upcoming, states({}), "feature/9-z")).toBeNull();
        expect(branchAgent(null, states({}), "feature/1-a")).toBeNull();
    });
});

describe("draftIsYours (#712 AC3)", () => {
    it("marks a draft without agent only", () => {
        expect(draftIsYours(true, null)).toBe(true);
        expect(draftIsYours(true, { kind: "panel", name: "V", state: "working", since: 1 })).toBe(false);
        expect(draftIsYours(false, null)).toBe(false);
    });
});

describe("the bar's time line", () => {
    it("says how long and since when, at minute granularity", () => {
        expect(durationText(t, 30_000)).toBe("less than a minute");
        expect(durationText(t, 12 * 60_000 + 59_000)).toBe("12 min");
        expect(durationText(t, 125 * 60_000)).toBe("2 h 05");
        expect(durationText(t, 50 * 3_600_000)).toBe("2 d");
        const since = new Date(2026, 9, 15, 20, 41).getTime();
        expect(barTimeText(t, { kind: "panel", name: "V", state: "working", since }, Now)).toBe(
            "for 12 min · since 20:41"
        );
        expect(
            barTimeText(t, { kind: "background", name: "", state: "background", since: Now - 3 * 60_000 }, Now)
        ).toBe("last change 3 min ago");
        expect(barTimeText(t, { kind: "panel", name: "V", state: "working", since: 0 }, Now)).toBe("");
    });

    it("counts commits ahead", () => {
        expect(aheadText(t, 0)).toBe("no commit yet");
        expect(aheadText(t, 1)).toBe("1 commit ahead");
        expect(aheadText(t, 3)).toBe("3 commits ahead");
    });
});
