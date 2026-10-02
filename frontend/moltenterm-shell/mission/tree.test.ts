// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Ported from Notulia (src/lib/devTree.test.ts), with the branch names given by the project.

import { describe, expect, it } from "vitest";
import { layoutTree, stackCards, type TreeData } from "./tree";

const NOW = new Date("2026-09-26T12:00:00Z");
const at = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString();
const OPTIONS = { now: NOW, days: 20, width: 700, height: 800, card: { width: 190, height: 64 } };

const branch = (name: string, forkDaysAgo: number, tipDaysAgo: number, commits = 2) => ({
    name,
    sha: name,
    date: at(tipDaysAgo),
    fork: { sha: "f", date: at(forkDaysAgo) },
    commits: Array.from({ length: commits }, (_, i) => ({
        sha: `${name}-${i}`,
        date: at(tipDaysAgo + i * 0.2),
        subject: `commit ${i}`,
    })),
});

const DATA: TreeData = {
    branches: [
        {
            name: "develop",
            sha: "d",
            date: at(0),
            fork: null,
            commits: [
                { sha: "d0", date: at(0), subject: "latest" },
                { sha: "d1", date: at(10), subject: "older" },
                { sha: "d2", date: at(40), subject: "out of view" },
            ],
        },
        {
            name: "main",
            sha: "m",
            date: at(3),
            fork: null,
            commits: [{ sha: "m0", date: at(3), subject: "chore(release): v1.0.0-6" }],
        },
        branch("feature/a", 8, 6),
        branch("feature/b", 5, 1),
        branch("feature/c", 2, 0),
    ],
    tags: [
        { name: "v1.0.0-6", sha: "m0", date: at(3), notes: "notes", notesInternal: null },
        { name: "v1.0.0", sha: "x", date: at(30), notes: null, notesInternal: null },
    ],
    trunk: "develop",
    release: "main",
};

describe("the branches as a tree", () => {
    const tree = layoutTree(DATA, OPTIONS);

    it("time runs upward: now at the top, the window's start at the bottom", () => {
        const [latest, older] = tree.trunkNodes;
        expect(latest.y).toBeCloseTo(tree.top, 0);
        expect(older.y).toBeGreaterThan(latest.y);
        // A commit older than the window is not drawn.
        expect(tree.trunkNodes.map((n) => n.sha)).toEqual(["d0", "d1"]);
    });

    it("main is a vine on the trunk's left, carrying the releases in view", () => {
        expect(tree.releaseNodes[0].x).toBeLessThan(tree.cx);
        expect(tree.releases.map((r) => [r.name, r.rc])).toEqual([["v1.0.0-6", true]]);
        expect(tree.releases[0].y).toBeCloseTo(tree.releaseNodes[0].y, 5);
    });

    it("limbs alternate — right first — and rise from their fork to their tip", () => {
        expect(tree.limbs.map((l) => [l.name, l.side])).toEqual([
            ["feature/a", 1],
            ["feature/b", -1],
            ["feature/c", 1],
        ]);
        for (const limb of tree.limbs) {
            expect(limb.tip.y).toBeLessThan(tree.bottom);
            expect(Math.sign(limb.tip.x - tree.cx)).toBe(limb.side);
            expect(limb.nodes).toHaveLength(2);
        }
    });

    it("cards sit at the edges and never overlap", () => {
        const right = tree.limbs.filter((l) => l.side === 1).map((l) => l.card);
        expect(right.every((c) => c.x === 700 - 190 - 8)).toBe(true);
        const ys = right.map((c) => c.y).sort((a, b) => a - b);
        for (let k = 1; k < ys.length; k++) expect(ys[k] - ys[k - 1]).toBeGreaterThanOrEqual(64 + 10);
        expect(tree.limbs.find((l) => l.side === -1)!.card.x).toBe(8);
    });

    it("no card on the left covers a release's label", () => {
        for (const limb of tree.limbs.filter((l) => l.side === -1)) {
            for (const r of tree.releases) {
                const covers = limb.card.y < r.y + 13 && limb.card.y + 64 > r.y - 13;
                expect(covers, `${limb.name} covers ${r.name}`).toBe(false);
            }
        }
    });
});

describe("stacking the cards of one side", () => {
    it("keeps each card at its tip when there is room", () => {
        expect(stackCards([100, 300], 60, 10, 0, 800)).toEqual([100, 300]);
    });

    it("pushes a card down below the one above it", () => {
        expect(stackCards([100, 120, 130], 60, 10, 0, 800)).toEqual([100, 170, 240]);
    });

    it("pushes the column back up when it runs off the bottom", () => {
        const ys = stackCards([700, 710, 720], 60, 10, 0, 800);
        expect(ys[2]).toBe(740);
        expect(ys[1]).toBe(670);
        expect(ys[0]).toBe(600);
    });

    it("steps around a band something else occupies — a release's label", () => {
        expect(stackCards([100], 60, 10, 0, 800, [[120, 140]])).toEqual([150]);
        expect(stackCards([100], 60, 10, 0, 800, [[300, 320]])).toEqual([100]);
    });

    it("keeps each card with its own tip, whatever order they come in", () => {
        expect(stackCards([300, 100], 60, 10, 0, 800)).toEqual([300, 100]);
    });
});

describe("branch names come from the project", () => {
    it("draws any trunk and release branch", () => {
        const renamed: TreeData = {
            ...DATA,
            trunk: "dev",
            release: "stable",
            branches: DATA.branches.map((b) => ({
                ...b,
                name: b.name === "develop" ? "dev" : b.name === "main" ? "stable" : b.name,
            })),
        };
        const tree = layoutTree(renamed, OPTIONS);
        expect(tree.trunkNodes.map((n) => n.sha)).toEqual(["d0", "d1"]);
        expect(tree.releaseNodes).toHaveLength(1);
        expect(tree.limbs).toHaveLength(3);
    });

    it("a single-branch project has a trunk and no vine commits", () => {
        const single: TreeData = {
            ...DATA,
            trunk: "main",
            release: "main",
            branches: DATA.branches.filter((b) => b.name !== "develop"),
        };
        const tree = layoutTree(single, OPTIONS);
        expect(tree.trunkNodes.map((n) => n.sha)).toEqual(["m0"]);
        expect(tree.releaseNodes).toEqual([]);
        expect(tree.limbs.map((l) => l.name)).toEqual(["feature/a", "feature/b", "feature/c"]);
    });
});
