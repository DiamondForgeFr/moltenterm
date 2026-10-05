// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { PullRequest } from "./github";
import {
    branchTicket,
    buildLineMap,
    DefaultFullLineMapDays,
    DefaultLineMapDays,
    lineMapDays,
    mergedBranchName,
    stationKind,
    stationSource,
    withLineMapDays,
} from "./line-map-model";
import { MissionGit, RawCommit } from "./mission-model";

const NOW = new Date("2026-10-05T12:00:00Z").getTime();

function c(sha: string, date: string, subject: string, extra: Partial<RawCommit> = {}): RawCommit {
    return { sha, date, subject, parents: ["p" + sha], authordate: date, ...extra };
}

function makeGit(over: Partial<MissionGit> = {}): MissionGit {
    return {
        trunk: "develop",
        release: "main",
        remoteurl: "https://github.com/acme/app",
        branches: [
            { name: "main", sha: "m1", date: "2026-10-01T00:00:00Z", commits: [], fork: null },
            { name: "develop", sha: "d1", date: "2026-10-04T00:00:00Z", commits: [], fork: null },
        ],
        tags: [],
        merges: [],
        ahead: [],
        sincepublic: [],
        tagprefix: "v",
        ...over,
    };
}

function withTrunk(git: MissionGit, commits: RawCommit[], release: RawCommit[] = []): MissionGit {
    return {
        ...git,
        branches: git.branches.map((b) =>
            b.name === git.trunk ? { ...b, commits } : b.name === git.release ? { ...b, commits: release } : b
        ),
    };
}

describe("merged branches from a linear history", () => {
    // develop's first-parent history, newest first: a squash merge, a commit made on develop, a ticket committed on
    // develop, and one rebase that landed #10 (two commits) and #11 together.
    const trunk = [
        c("s13", "2026-10-04T10:00:00Z", "feat(#13): thing (#40)"),
        c("d2", "2026-10-03T10:00:00Z", "fix(#12): quick"),
        c("d1", "2026-10-02T10:00:00Z", "docs: readme"),
        c("a3", "2026-10-01T10:00:30Z", "feat(#11): c", { authordate: "2026-09-30T08:00:00Z" }),
        c("a2", "2026-10-01T10:00:10Z", "fix(#10): b", { authordate: "2026-09-29T08:00:00Z" }),
        c("a1", "2026-10-01T10:00:00Z", "feat(#10): a", { authordate: "2026-09-28T08:00:00Z" }),
        c("old", "2026-09-01T10:00:00Z", "feat(#1): before the window", { authordate: "2026-08-01T00:00:00Z" }),
    ];
    const git = withTrunk(makeGit(), trunk);
    git.branches.push({ name: "feature/11-cool", sha: "a3", date: "2026-10-01T10:00:30Z", commits: [], fork: null });
    const model = buildLineMap({ git, now: NOW, days: 21 });

    it("splits a landing by ticket, each leaving develop when its first commit was written", () => {
        const ten = model.branches.find((b) => b.ticket === "10");
        expect(ten).toMatchObject({ name: "feature/10", state: "merged", count: 2, forkKnown: true, mergeSha: "a2" });
        expect(ten.fork).toBe(new Date("2026-09-28T08:00:00Z").getTime());
        expect(ten.merge).toBe(new Date("2026-10-01T10:00:10Z").getTime());
        expect(ten.commits.map((x) => x.sha)).toEqual(["a2", "a1"]);
        expect(ten.url).toBe("https://github.com/acme/app/issues/10");
    });

    it("takes the real name when a branch still carries the ticket", () => {
        expect(model.branches.find((b) => b.ticket === "11").name).toBe("feature/11-cool");
    });

    it("draws a squash merge short, linked to its pull request", () => {
        const squash = model.branches.find((b) => b.ticket === "13");
        expect(squash).toMatchObject({ forkKnown: false, prNumber: 40, url: "https://github.com/acme/app/pull/40" });
        expect(squash.fork).toBe(squash.merge);
    });

    it("keeps commits made on develop itself as commits, and nothing before the window", () => {
        expect(model.commits.map((x) => x.sha)).toEqual(["d2", "d1"]);
        expect(model.branches.map((b) => b.ticket).sort()).toEqual(["10", "11", "13"]);
    });

    it("names a ticket by its commit types", () => {
        const fixOnly = withTrunk(makeGit(), [
            c("f1", "2026-10-01T10:00:00Z", "fix(#30): x", { authordate: "2026-09-30T00:00:00Z" }),
            c("f2", "2026-10-01T09:00:00Z", "chore(#31): y", { authordate: "2026-09-30T00:00:00Z" }),
        ]);
        const names = buildLineMap({ git: fixOnly, now: NOW, days: 21 }).branches.map((b) => b.name);
        expect(names.sort()).toEqual(["#31", "fix/30"]);
    });
});

describe("merged branches from merge commits", () => {
    const merge = (sha: string, subject: string) =>
        c(sha, "2026-10-02T10:00:00Z", subject, { parents: ["d0", "side" + sha] });
    const git = withTrunk(
        makeGit({
            merges: [
                {
                    sha: "m5",
                    date: "2026-10-02T10:00:00Z",
                    subject: "Merge pull request #5 from acme/feature/7-x",
                    fork: { sha: "d0", date: "2026-09-25T10:00:00Z" },
                    commits: 4,
                    firstdate: "2026-09-26T10:00:00Z",
                },
                {
                    sha: "back",
                    date: "2026-10-03T10:00:00Z",
                    subject: "Merge branch 'main' into develop",
                    fork: { sha: "d0", date: "2026-09-25T10:00:00Z" },
                    commits: 1,
                },
            ],
        }),
        [merge("back", "Merge branch 'main' into develop"), merge("m5", "Merge pull request #5 from acme/feature/7-x")]
    );
    const model = buildLineMap({ git, now: NOW, days: 21 });

    it("reads the branch, its fork and its pull request", () => {
        expect(model.branches).toHaveLength(1);
        expect(model.branches[0]).toMatchObject({
            name: "feature/7-x",
            ticket: "7",
            prNumber: 5,
            count: 4,
            forkKnown: true,
            url: "https://github.com/acme/app/pull/5",
        });
        expect(model.branches[0].fork).toBe(new Date("2026-09-25T10:00:00Z").getTime());
    });

    it("draws no merge commit as a commit of develop", () => {
        expect(model.commits).toEqual([]);
    });
});

describe("open branches", () => {
    const git = makeGit();
    git.branches.push({
        name: "feature/20-wip",
        sha: "w3",
        date: "2026-10-05T08:00:00Z",
        commits: [
            c("w3", "2026-10-05T08:00:00Z", "feat(#20): three"),
            c("w2", "2026-10-04T08:00:00Z", "feat(#20): two"),
            c("w1", "2026-10-03T08:00:00Z", "feat(#20): one"),
        ],
        fork: { sha: "d1", date: "2026-10-02T08:00:00Z" },
    });
    git.branches.push({ name: "feature/21-done", sha: "d1", date: "2026-10-01T00:00:00Z", commits: [], fork: null });
    const prs = [
        { headRefName: "feature/20-wip", number: 77, url: "https://github.com/acme/app/pull/77", isDraft: true },
    ] as PullRequest[];
    const model = buildLineMap({
        git,
        prs,
        ciBranches: [{ name: "feature/20-wip", sha: "w3", date: 0, verdict: "success" }],
        now: NOW,
        days: 21,
    });

    it("shows a branch with work ahead, its count, its pull request and its local CI", () => {
        expect(model.branches).toHaveLength(1);
        const open = model.branches[0];
        expect(open).toMatchObject({ name: "feature/20-wip", state: "open", count: 3, prNumber: 77, ci: "success" });
        expect(open.url).toBe("https://github.com/acme/app/pull/77");
        expect(open.fork).toBe(new Date("2026-10-02T08:00:00Z").getTime());
        expect(open.pr.draft).toBe(true);
    });
});

describe("stations", () => {
    const tags = [
        { name: "v1.0.0", sha: "t3", date: "2026-10-04T10:00:00Z", notes: "First public" },
        { name: "v1.0.0-2", sha: "t2", date: "2026-09-30T10:00:00Z" },
        { name: "v1.0.0-1", sha: "t1", date: "2026-09-29T10:00:00Z" },
        { name: "v0.9.0", sha: "t0", date: "2026-08-01T10:00:00Z" },
    ];
    const git = makeGit({ tags, firstpublic: "" });
    const model = buildLineMap({
        git,
        releases: [{ tagName: "v1.0.0", isDraft: false } as never],
        now: NOW,
        days: 21,
    });

    it("puts every tag of the window on main with its kind, the older ones in one marker", () => {
        expect(model.stations.map((s) => [s.name, s.kind])).toEqual([
            ["v1.0.0-1", "rc"],
            ["v1.0.0-2", "rc"],
            ["v1.0.0", "public"],
        ]);
        expect(model.stations[2]).toMatchObject({ latest: true, notes: "First public" });
        expect(model.earlier.map((s) => s.name)).toEqual(["v0.9.0"]);
    });

    it("links a published release to its page, a bare tag to its tree", () => {
        expect(model.stations[2].url).toBe("https://github.com/acme/app/releases/tag/v1.0.0");
        expect(model.stations[0].url).toBe("https://github.com/acme/app/tree/v1.0.0-1");
    });

    it("links nothing without GitHub", () => {
        const local = buildLineMap({ git: { ...git, remoteurl: "" }, now: NOW, days: 21 });
        expect(local.stations.every((s) => s.url == null)).toBe(true);
        expect(local.github).toBe("");
    });

    it("leaves out tags below versions.firstpublic, keeps a loose version by the dash rule", () => {
        const rules = { tagprefix: "v", firstpublic: "1.0.0" };
        expect(stationKind("v0.9.0", rules)).toBeNull();
        expect(stationKind("v1.0.0-1", rules)).toBe("rc");
        expect(stationKind("v2.0.0-beta.1", rules)).toBe("rc");
        expect(stationKind("v2", rules)).toBe("public");
        expect(stationKind("release-1.0.0", rules)).toBeNull();
    });
});

describe("where develop was pushed to main", () => {
    const develop = [
        c("d3", "2026-10-03T10:00:00Z", "feat(#3): c", { authordate: "2026-10-03T09:00:00Z" }),
        c("d2", "2026-10-02T10:00:00Z", "feat(#2): b", { authordate: "2026-10-02T09:00:00Z" }),
        c("d1", "2026-10-01T10:00:00Z", "feat(#1): a", { authordate: "2026-10-01T09:00:00Z" }),
    ];
    const at = (iso: string) => new Date(iso).getTime();

    it("is the tag commit itself when develop has it", () => {
        expect(stationSource({ sha: "d2", at: at("2026-10-02T11:00:00Z") }, develop, []).sha).toBe("d2");
    });

    it("is the second parent of a merge of develop into main", () => {
        const main = [c("mm", "2026-10-04T10:00:00Z", "Merge branch 'develop'", { parents: ["m0", "d3"] })];
        expect(stationSource({ sha: "mm", at: at("2026-10-04T10:00:00Z") }, develop, main).sha).toBe("d3");
    });

    it("is the develop commit a rebased main copied, by subject and author date", () => {
        const main = [
            c("rel", "2026-10-04T10:00:00Z", "chore(release): v1.0.0-2"),
            c("copy", "2026-10-04T09:59:00Z", "feat(#2): b", { authordate: "2026-10-02T09:00:00Z" }),
        ];
        expect(stationSource({ sha: "rel", at: at("2026-10-04T10:00:00Z") }, develop, main).sha).toBe("d2");
    });

    it("falls back on the last develop commit before the tag", () => {
        expect(stationSource({ sha: "elsewhere", at: at("2026-10-02T12:00:00Z") }, develop, []).sha).toBe("d2");
        expect(stationSource({ sha: "elsewhere", at: at("2026-09-01T00:00:00Z") }, develop, [])).toBeNull();
    });
});

describe("the terminus", () => {
    it("is a decision before the first public release", () => {
        const git = makeGit({ tags: [{ name: "v1.0.0-1", sha: "t", date: "2026-10-01T00:00:00Z" }] });
        const model = buildLineMap({ git, now: NOW, days: 21 });
        expect(model.terminus.how).toBe("decision");
    });

    it("is derived from the commits after a public release", () => {
        const feat = c("f", "2026-10-02T00:00:00Z", "feat(#4): new");
        const git = makeGit({
            tags: [{ name: "v1.2.0", sha: "t", date: "2026-10-01T00:00:00Z" }],
            lastpublic: "v1.2.0",
            ahead: [feat],
            sincepublic: [feat],
        });
        const model = buildLineMap({ git, now: NOW, days: 21 });
        expect(model.terminus).toMatchObject({ how: "derived", version: "1.3.0", tag: "v1.3.0", waiting: 1 });
    });
});

describe("a single-branch project", () => {
    it("has no release line and no connector", () => {
        const git = withTrunk(
            makeGit({
                release: "main",
                trunk: "main",
                branches: [{ name: "main", sha: "a", date: "2026-10-01T00:00:00Z", commits: [], fork: null }],
                tags: [{ name: "v1.0.0", sha: "a", date: "2026-10-01T00:00:00Z" }],
            }),
            [c("a", "2026-10-01T00:00:00Z", "feat: a")]
        );
        const model = buildLineMap({ git, now: NOW, days: 21 });
        expect(model.release).toBeNull();
        expect(model.stations[0].source).toBeNull();
        expect(model.head.sha).toBe("a");
    });
});

describe("names", () => {
    it("reads merge subjects", () => {
        expect(mergedBranchName("Merge pull request #12 from acme/fix/12-x")).toEqual({ name: "fix/12-x", pr: 12 });
        expect(mergedBranchName("Merge branch 'feature/3-y' into develop")).toEqual({ name: "feature/3-y", pr: null });
        expect(mergedBranchName("Merge remote-tracking branch 'origin/feature/4'")).toEqual({
            name: "feature/4",
            pr: null,
        });
        expect(mergedBranchName("feat: nothing to see")).toEqual({ name: null, pr: null });
    });

    it("reads a branch's ticket", () => {
        expect(branchTicket("feature/235-line-map")).toBe("235");
        expect(branchTicket("fix/9")).toBe("9");
        expect(branchTicket("42-quick")).toBe("42");
        expect(branchTicket("feature/v2-ui")).toBeNull();
    });
});

describe("the remembered window", () => {
    it("defaults, and ignores what is not a choice", () => {
        expect(lineMapDays(null, "/p", false)).toBe(DefaultLineMapDays);
        expect(lineMapDays({ "/p": { days: 13 } }, "/p", false)).toBe(DefaultLineMapDays);
        expect(lineMapDays({ "/p": { days: 60 } }, "/p", true)).toBe(DefaultFullLineMapDays);
        expect(lineMapDays({ "/p": { days: 60, fulldays: 180 } }, "/p", true)).toBe(180);
    });

    it("keeps each project and each size apart", () => {
        const prefs = withLineMapDays({ "/a": { days: 7 } }, "/b", false, 30);
        const both = withLineMapDays(prefs, "/b", true, 90);
        expect(both).toEqual({ "/a": { days: 7 }, "/b": { days: 30, fulldays: 90 } });
        expect(lineMapDays(both, "/a", false)).toBe(7);
    });
});
