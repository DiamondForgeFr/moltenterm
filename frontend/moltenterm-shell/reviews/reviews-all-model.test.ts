// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// #2314, FR-SHELL-087: Integration's All projects holds one Upcoming, one Notes and one Recently merged for every
// project, each card marked with its project. Synthetic project names only.

import { describe, expect, it } from "vitest";
import type { AgentStatesData } from "../agent-state-model";
import type { ReviewNote } from "../review/review-notes";
import type { WorkspaceProjectEntry } from "../sidebar/workspace-projects";
import {
    allLeftovers,
    allMergedGroups,
    allNotes,
    allUpcoming,
    markOf,
    mergeByRecency,
    mergedCount,
    noteCount,
    notesRead,
    projectProblems,
    sourceOf,
} from "./reviews-all-model";
import type { ReviewMergedPr } from "./reviews-merged-model";
import type { ReviewsAnswer } from "./reviews-model";
import type { UpcomingAnswer, UpcomingBranch, UpcomingLeftover } from "./reviews-upcoming-model";

const Desktop: WorkspaceProjectEntry = { id: "p1", type: "Desktop", dir: "/synthetic/desk", branch: "" };
const Mobile: WorkspaceProjectEntry = { id: "p2", type: "Mobile", dir: "/synthetic/mob", branch: "" };
const Website: WorkspaceProjectEntry = { id: "p3", type: "Website", dir: "/synthetic/web", branch: "" };
const Empty: WorkspaceProjectEntry = { id: "p4", type: "Library", dir: "", branch: "" };

const NoStates = { states: {} } as unknown as AgentStatesData;

function answer(repo: string, target: string, over: Partial<ReviewsAnswer> = {}): ReviewsAnswer {
    return { dir: "/x", state: "ok", repo, target, ready: [], drafts: [], ...over } as ReviewsAnswer;
}

function branch(ticket: number, commitat: number, over: Partial<UpcomingBranch> = {}): UpcomingBranch {
    return { branch: `feature/${ticket}-x`, ticket, ahead: 1, commitat, ...over };
}

function upcoming(branches: UpcomingBranch[], over: Partial<UpcomingAnswer> = {}): UpcomingAnswer {
    return { dir: "/x", branches, agents: [], at: 1, ...over };
}

function merged(number: number, mergedat: string, over: Partial<ReviewMergedPr> = {}): ReviewMergedPr {
    return {
        number,
        title: `PR ${number}`,
        url: `https://example.test/pull/${number}`,
        branch: `feature/${number}-x`,
        base: "develop",
        mergedat,
        ...over,
    };
}

function note(id: string, keptat: number, title = `Note ${id}`): ReviewNote {
    return { id, title, explanationid: id, markdown: "text", pr: { number: 1 }, keptat };
}

describe("merging the projects' lists by recency", () => {
    it("takes the most recent first and keeps each list's own order", () => {
        const merged = mergeByRecency(
            [
                [
                    { id: "a1", at: 50 },
                    { id: "a2", at: 10 },
                ],
                [
                    { id: "b1", at: 40 },
                    { id: "b2", at: 30 },
                ],
                [{ id: "c1", at: 60 }],
            ],
            (x) => x.at
        );
        expect(merged.map((x) => x.id)).toEqual(["c1", "a1", "b1", "b2", "a2"]);
    });

    it("puts the earlier list first on the same time, and handles empty lists", () => {
        expect(mergeByRecency([[], [{ id: "b", at: 1 }], [{ id: "c", at: 1 }]], (x) => x.at).map((x) => x.id)).toEqual([
            "b",
            "c",
        ]);
        expect(mergeByRecency([], () => 0)).toEqual([]);
    });
});

describe("one Upcoming for every project", () => {
    it("lists the cards of every project, the most recent first, and counts the branches", () => {
        const sources = [
            sourceOf(Desktop, {
                answer: answer("example/desk", "develop"),
                upcoming: upcoming([branch(1, 100), branch(2, 10)]),
            }),
            sourceOf(Mobile, { answer: answer("example/mob", "main"), upcoming: upcoming([branch(7, 50)]) }),
        ];
        const all = allUpcoming(sources, NoStates, null);
        expect(all.cards.map((c) => `${c.source.project.id}#${c.entry.key}`)).toEqual([
            "p1#feature/1-x",
            "p2#feature/7-x",
            "p1#feature/2-x",
        ]);
        expect(all.cards.map((c) => c.source.dir)).toEqual(["/synthetic/desk", "/synthetic/mob", "/synthetic/desk"]);
        expect(all.count).toBe(3);
        expect(all.started).toBe(true);
        expect(all.ready).toBe(true);
    });

    it("puts what waits for the developer first, whatever the project or the time", () => {
        const waitingAgent = {
            branch: "feature/9-x",
            worktree: "/w/9",
            kind: "panel" as const,
            blockid: "blk",
            agent: "claude",
        };
        const states = { states: { blk: { state: "waiting", firstname: "Flore" } } } as unknown as AgentStatesData;
        const sources = [
            sourceOf(Desktop, { answer: answer("example/desk", "develop"), upcoming: upcoming([branch(1, 100)]) }),
            sourceOf(Mobile, {
                answer: answer("example/mob", "main"),
                upcoming: upcoming([branch(9, 5)], { agents: [waitingAgent] }),
            }),
        ];
        const all = allUpcoming(sources, states, null);
        expect(all.cards.map((c) => c.source.project.id)).toEqual(["p2", "p1"]);
        expect(all.waiting).toBe(1);
    });

    it("leaves a project's entries in its own order when none is more recent than the next", () => {
        const sources = [
            sourceOf(Desktop, {
                answer: answer("example/desk", "develop"),
                upcoming: upcoming([branch(3, 0), branch(1, 0)]),
            }),
            sourceOf(Mobile, { answer: answer("example/mob", "main"), upcoming: upcoming([branch(2, 0)]) }),
        ];
        const keys = allUpcoming(sources, NoStates, null).cards.map((c) => c.entry.key);
        expect(keys).toEqual(["feature/3-x", "feature/1-x", "feature/2-x"]);
    });

    it("hides the branches of a project that already have a pull request, as the project's own view does", () => {
        const sources = [
            sourceOf(Desktop, {
                answer: answer("example/desk", "develop", {
                    ready: [{ number: 5, branch: "feature/1-x", ticket: 1 } as never],
                }),
                upcoming: upcoming([branch(1, 100), branch(2, 10)]),
            }),
        ];
        expect(allUpcoming(sources, NoStates, null).cards.map((c) => c.entry.key)).toEqual(["feature/2-x"]);
    });

    it("is not ready while a project's upcoming work has not answered, and started once one has", () => {
        const sources = [
            sourceOf(Desktop, { answer: answer("example/desk", "develop"), upcoming: upcoming([]) }),
            sourceOf(Mobile, { answer: answer("example/mob", "main") }),
        ];
        const all = allUpcoming(sources, NoStates, null);
        expect(all.started).toBe(true);
        expect(all.ready).toBe(false);
        expect(allUpcoming([sources[1]], NoStates, null).started).toBe(false);
    });

    it("keeps only the branches whose agent the view follows", () => {
        const sources = [
            sourceOf(Desktop, { answer: answer("example/desk", "develop"), upcoming: upcoming([branch(1, 100)]) }),
        ];
        expect(allUpcoming(sources, NoStates, new Set(["flore"])).cards).toEqual([]);
    });
});

describe("one Leftovers group for every project", () => {
    const leftover = (pr: number): UpcomingLeftover => ({ branch: `feature/${pr}-x`, pr });

    it("lists the leftovers of each project that has a repository, each in its own project", () => {
        const sources = [
            sourceOf(Desktop, {
                answer: answer("example/desk", "develop"),
                upcoming: upcoming([], { leftovers: [leftover(4)] }),
            }),
            sourceOf(Mobile, { answer: answer("", "main"), upcoming: upcoming([], { leftovers: [leftover(5)] }) }),
            sourceOf(Website, {
                answer: answer("example/web", "develop"),
                upcoming: upcoming([], { leftovers: [leftover(6)] }),
            }),
        ];
        const found = allLeftovers(sources, NoStates, () => 0);
        expect(found.map((l) => `${l.target.dir}#${l.target.leftover.pr}`)).toEqual([
            "/synthetic/desk#4",
            "/synthetic/web#6",
        ]);
        expect(found.map((l) => l.target.repo)).toEqual(["example/desk", "example/web"]);
    });

    it("drops a leftover cleaned up since wavesrv answered, in its own project only", () => {
        const sources = [
            sourceOf(Desktop, {
                answer: answer("example/desk", "develop"),
                upcoming: upcoming([], { leftovers: [leftover(4)], at: 10 }),
            }),
            sourceOf(Website, {
                answer: answer("example/web", "develop"),
                upcoming: upcoming([], { leftovers: [leftover(4)], at: 10 }),
            }),
        ];
        const found = allLeftovers(sources, NoStates, (dir) => (dir === "/synthetic/desk" ? 20 : 0));
        expect(found.map((l) => l.target.dir)).toEqual(["/synthetic/web"]);
    });
});

describe("one Notes for every project", () => {
    const sources = [
        sourceOf(Desktop, {
            answer: answer("example/desk", "develop"),
            notes: { repo: "example/desk", notes: [note("a", 10), note("b", 30, "Retry the call")] },
        }),
        sourceOf(Mobile, {
            answer: answer("example/mob", "main"),
            notes: { repo: "example/mob", notes: [note("c", 20)] },
        }),
    ];

    it("lists the notes of every project, the newest first, each with its project", () => {
        const found = allNotes(sources, "");
        expect(found.map((n) => `${n.source.project.id}:${n.note.id}`)).toEqual(["p1:b", "p2:c", "p1:a"]);
        expect(noteCount(sources)).toBe(3);
    });

    it("filters across the projects, or inside one project when a merged pull request asked for it", () => {
        expect(allNotes(sources, "retry").map((n) => n.note.id)).toEqual(["b"]);
        expect(allNotes(sources, "", "p2").map((n) => n.note.id)).toEqual(["c"]);
        expect(allNotes(sources, "", "p3")).toEqual([]);
    });

    it("is read once every project with a repository has answered or failed", () => {
        const pending = sourceOf(Website, { answer: answer("example/web", "develop") });
        expect(notesRead([...sources, pending])).toBe(false);
        expect(
            notesRead([...sources, sourceOf(Website, { answer: answer("example/web", "develop"), notesError: "x" })])
        ).toBe(true);
        expect(notesRead([...sources, sourceOf(Website, { answer: answer("", "develop") })])).toBe(true);
        expect(notesRead(sources)).toBe(true);
    });
});

describe("one Recently merged for every project", () => {
    it("groups each project's merged pull requests by version and keeps each group in its project", () => {
        const desk = answer("example/desk", "develop", {
            merged: [
                merged(10, "2026-01-03T10:00:00Z", { ships: "next" }),
                merged(9, "2026-01-02T10:00:00Z", { ships: "tag", shipsin: "v1.2.0" }),
            ],
        });
        const mob = answer("example/mob", "main", {
            merged: [merged(3, "2026-01-03T09:00:00Z", { ships: "next" }), merged(2, "2026-01-01T09:00:00Z")],
        });
        const sources = [sourceOf(Desktop, { answer: desk }), sourceOf(Mobile, { answer: mob })];
        const groups = allMergedGroups(sources);
        expect(groups.map((g) => g.key)).toEqual(["p1:next", "p2:next", "p1:tag:v1.2.0", "p2:unknown"]);
        expect(groups.map((g) => g.source.dir)).toEqual([
            "/synthetic/desk",
            "/synthetic/mob",
            "/synthetic/desk",
            "/synthetic/mob",
        ]);
        expect(mergedCount(sources)).toBe(4);
    });

    it("has no group when nothing merged in any project", () => {
        const sources = [sourceOf(Desktop, { answer: answer("example/desk", "develop") })];
        expect(allMergedGroups(sources)).toEqual([]);
        expect(mergedCount(sources)).toBe(0);
    });
});

describe("a project's mark", () => {
    it("says the project, the branch its pull requests target and whether the workspace has a colour", () => {
        const source = sourceOf(Mobile, { answer: answer("example/mob", "main") });
        expect(markOf(source, true)).toEqual({ id: "p2", label: "Mobile", target: "main", place: true });
        expect(markOf(sourceOf(Mobile, {}), false)).toEqual({ id: "p2", label: "Mobile", target: "", place: false });
    });
});

describe("what is wrong with a project", () => {
    it("is one line per problem, in the workspace's order of projects", () => {
        const problems = projectProblems(
            [Desktop, Empty, Mobile, Website],
            (id) => (id === "p3" ? "GitHub could not be reached" : ""),
            (id) => (id === "p1" ? "/synthetic/desk" : "")
        );
        expect(problems.map((p) => `${p.project.id}:${p.kind}`)).toEqual(["p1:trust", "p4:nofolder", "p3:unreadable"]);
        expect(problems[2]).toMatchObject({ note: "GitHub could not be reached" });
        expect(problems[0]).toMatchObject({ dir: "/synthetic/desk" });
    });

    it("is nothing when every project reads", () => {
        expect(
            projectProblems(
                [Desktop, Mobile],
                () => "",
                () => ""
            )
        ).toEqual([]);
    });

    it("never says a project without a folder is unreadable too", () => {
        const problems = projectProblems(
            [Empty],
            () => "something",
            () => "/synthetic/x"
        );
        expect(problems.map((p) => p.kind)).toEqual(["nofolder"]);
    });
});
