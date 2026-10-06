// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { PullRequest } from "./github";
import {
    branchTicket,
    buildLineMap,
    DefaultFullLineMapDays,
    DefaultLineMapDays,
    gitFingerprint,
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

describe("work landed on a rebase or squash project", () => {
    // develop's first-parent history, newest first: no merge commit, so nothing tells where branches were.
    const trunk = [
        c("s13", "2026-10-04T10:00:00Z", "feat(#13): thing (#40)"),
        c("d2", "2026-10-03T10:00:00Z", "fix(#12): quick"),
        c("a2", "2026-10-01T10:00:10Z", "fix(#10): b", { authordate: "2026-09-29T08:00:00Z" }),
        c("a1", "2026-10-01T10:00:00Z", "feat(#10): a", { authordate: "2026-09-28T08:00:00Z" }),
        c("old", "2026-09-01T10:00:00Z", "feat(#1): before the window"),
    ];
    const model = buildLineMap({ git: withTrunk(makeGit(), trunk), now: NOW, days: 21 });

    it("draws no branch it would have to guess", () => {
        expect(model.branches).toEqual([]);
    });

    it("shows every commit of the window on develop, oldest first", () => {
        expect(model.commits.map((x) => x.sha)).toEqual(["a1", "a2", "d2", "s13"]);
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

describe("branches already landed", () => {
    it("drops a squashed branch left undeleted, keeps a follow-up on the same ticket", () => {
        const git = withTrunk(makeGit(), [c("s", "2026-10-03T10:00:00Z", "feat(#50): thing (#51)")]);
        const leftover = (name: string, at: string) => ({
            name,
            sha: name,
            date: at,
            commits: [c(name + "c", at, "feat(#50): thing")],
            fork: { sha: "d0", date: "2026-10-01T00:00:00Z" },
        });
        git.branches.push(leftover("feature/50-thing", "2026-10-02T10:00:00Z"));
        expect(buildLineMap({ git, now: NOW, days: 21 }).branches).toEqual([]);
        git.branches[2] = leftover("feature/50-thing", "2026-10-04T10:00:00Z");
        expect(buildLineMap({ git, now: NOW, days: 21 }).branches.map((b) => b.state)).toEqual(["open"]);
    });

    it("orders the lanes: the two freshest open branches, the merged ones, then the other open ones", () => {
        const git = makeGit({
            merges: [
                {
                    sha: "m60",
                    date: "2026-10-03T10:00:00Z",
                    subject: "Merge branch 'feature/60-late'",
                    fork: { sha: "d0", date: "2026-10-02T10:00:00Z" },
                    commits: 2,
                },
            ],
        });
        const open = (name: string, at: string) => ({
            name,
            sha: name,
            date: at,
            commits: [c(name, at, "feat: work")],
            fork: { sha: "d0", date: "2026-09-19T00:00:00Z" },
        });
        git.branches.push(open("feature/61-old", "2026-09-20T00:00:00Z"));
        git.branches.push(open("feature/62-new", "2026-10-05T00:00:00Z"));
        git.branches.push(open("feature/63-new", "2026-10-04T00:00:00Z"));
        expect(buildLineMap({ git, now: NOW, days: 21 }).branches.map((b) => b.name)).toEqual([
            "feature/62-new",
            "feature/63-new",
            "feature/60-late",
            "feature/61-old",
        ]);
    });

    it("skips merges of tags, and keeps no fork for a walk that hit its cap", () => {
        const merge = (sha: string, subject: string, commits: number) => ({
            sha,
            date: "2026-10-02T10:00:00Z",
            subject,
            fork: null as { sha: string; date: string },
            commits,
            firstdate: "2026-06-01T00:00:00Z",
        });
        const git = makeGit({
            merges: [merge("t", "Merge tag 'v1.2' into develop", 3), merge("x", "Merge branch 'feature/9-big'", 150)],
        });
        const branches = buildLineMap({ git, now: NOW, days: 21 }).branches;
        expect(branches.map((b) => [b.name, b.forkKnown])).toEqual([["feature/9-big", false]]);
    });
});

describe("the history read", () => {
    it("says from when the map is complete when the window starts before it", () => {
        const commits = Array.from({ length: 300 }, (_, i) =>
            c(`h${i}`, new Date(NOW - i * 3_600_000).toISOString(), "docs: x")
        );
        const git = withTrunk(makeGit(), commits);
        expect(buildLineMap({ git, now: NOW, days: 7 }).historyFrom).toBeNull();
        expect(buildLineMap({ git, now: NOW, days: 21 }).historyFrom).toBe(NOW - 299 * 3_600_000);
    });

    it("keys the git answer on what the map draws", () => {
        const a = makeGit({ tags: [{ name: "v1", sha: "a", date: "2026-10-01T00:00:00Z" }] });
        const b = { ...a, fetcherror: "offline", current: "x" };
        expect(gitFingerprint(b)).toBe(gitFingerprint(a));
        expect(gitFingerprint({ ...a, tags: [] })).not.toBe(gitFingerprint(a));
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

    it("never takes a develop commit made after the tag", () => {
        const main = [
            c("rel", "2026-10-02T12:00:00Z", "chore(release): v1"),
            c("copy", "2026-10-02T11:59:00Z", "feat(#3): c", { authordate: "2026-10-03T09:00:00Z" }),
        ];
        expect(stationSource({ sha: "rel", at: at("2026-10-02T12:00:00Z") }, develop, main).sha).toBe("d2");
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
        expect(model.terminus).toMatchObject({ state: "decision", chip: "to decide" });
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
        expect(model.terminus).toMatchObject({ state: "derived", chip: "minor", tag: "v1.3.0", waiting: 1 });
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
