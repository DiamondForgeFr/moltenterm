// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { CiState } from "../mission/ci-model";
import { Milestone } from "../mission/github";
import { MissionGit, RunRecord, toTreeData } from "../mission/mission-model";
import { releaseState, treeRules } from "../mission/versions";
import {
    agoText,
    clockElapsed,
    commitKind,
    lastBuildLine,
    nextReleaseView,
    notesExcerpt,
    pickMilestone,
    releaseBars,
    releasesView,
    trunkCiLine,
} from "./overview-cards-model";

const Now = new Date("2026-10-05T12:00:00Z").getTime();

function commits(...subjects: string[]) {
    return subjects.map((subject, i) => ({ sha: `c${i}`, date: "2026-10-01T10:00:00Z", subject }));
}

// develop holds 3 features, 2 fixes and 1 chore that main does not have (TC-MC-019's project).
const Pending = commits(
    "feat(#11): a welcome tour",
    "feat(#12): help pages",
    "feat(#13): dark editor",
    "fix(#14): tour skips a step",
    "fix(#15): links open twice",
    "chore(#16): bump dependencies"
);

function git(extra: Partial<MissionGit> = {}): MissionGit {
    return {
        trunk: "develop",
        release: "main",
        branches: [],
        tags: [],
        ahead: Pending,
        sincepublic: [],
        tagprefix: "v",
        ...extra,
    };
}

function stateOf(g: MissionGit) {
    const tree = toTreeData(g);
    return releaseState(tree.tags, g.ahead ?? [], g.sincepublic ?? [], treeRules(tree));
}

function milestone(title: string, open: number, closed: number, due?: string): Milestone {
    return {
        number: 1,
        title,
        open_issues: open,
        closed_issues: closed,
        due_on: due,
        html_url: `https://github.com/a/b/milestone/${title}`,
    };
}

describe("next public release card", () => {
    it("counts features, fixes and the rest by conventional type", () => {
        expect(commitKind("feat(#1): x")).toBe("feat");
        expect(commitKind("fix!: x")).toBe("fix");
        expect(commitKind("chore(release): v1.0.0")).toBe("other");
        expect(commitKind("Merge branch 'x'")).toBe("other");
        const { total, bars } = releaseBars(Pending);
        expect(total).toBe(6);
        expect(bars.map((b) => [b.label, b.count])).toEqual([
            ["features", 3],
            ["fixes", 2],
            ["the rest", 1],
        ]);
        expect(bars.map((b) => b.share)).toEqual([0.5, 2 / 6, 1 / 6]);
    });

    it("has empty bars and no division by zero when nothing waits", () => {
        const { total, bars } = releaseBars([]);
        expect(total).toBe(0);
        expect(bars.every((b) => b.count === 0 && b.share === 0)).toBe(true);
    });

    it("reads what waits on the trunk, without the next version (the header holds it)", () => {
        const g = git();
        const view = nextReleaseView(stateOf(g), g, [], "ok");
        expect(view.total).toBe(6);
        expect(view.scope).toBe("on develop, not yet on main");
        expect(view.milestone).toBeNull();
        expect(view.milestoneNote).toBe("No open milestone on GitHub.");
    });

    it("on a single-branch project, counts what came since the last public release", () => {
        const g = git({
            release: "main",
            trunk: "main",
            ahead: [],
            lastpublic: "v1.1.0",
            sincepublic: commits("feat: a", "fix: b"),
            tags: [{ name: "v1.1.0", sha: "t", date: "2026-09-01T10:00:00Z" }],
        });
        const view = nextReleaseView(stateOf(g), g, [], "ok");
        expect(view.scope).toBe("since v1.1.0");
        expect(view.bars.map((b) => b.count)).toEqual([1, 1, 0]);
    });

    it("picks the milestone of the next version, then its line, then the one due first", () => {
        const list = [
            milestone("Backlog", 9, 0),
            milestone("v1", 0, 12, "2026-12-01"),
            milestone("1.1.0", 2, 2, "2026-11-01"),
        ];
        expect(pickMilestone(list, "1.1.0").title).toBe("1.1.0");
        expect(pickMilestone(list, "1.4.2").title).toBe("v1");
        expect(pickMilestone(list, "2.0.0").title).toBe("1.1.0");
        expect(pickMilestone([milestone("Backlog", 1, 0)], null).title).toBe("Backlog");
        expect(pickMilestone([], "1.0.0")).toBeNull();
    });

    it("shows the milestone's progress and open count", () => {
        const g = git();
        const view = nextReleaseView(stateOf(g), g, [milestone("v1", 1, 3)], "ok");
        expect(view.milestone).toMatchObject({ title: "v1", percent: 75, open: 1, closed: 3 });
        expect(view.milestoneNote).toBeNull();
        const empty = nextReleaseView(stateOf(g), g, [milestone("v1", 0, 0)], "ok");
        expect(empty.milestone.percent).toBe(0);
    });

    it("says why there is no milestone on a project without GitHub", () => {
        const g = git();
        expect(nextReleaseView(stateOf(g), g, undefined, "norepo").milestoneNote).toBe(
            "Milestone progress needs the project on GitHub."
        );
        expect(nextReleaseView(stateOf(g), g, undefined, undefined).milestoneNote).toBe(
            "Milestone progress shows once GitHub has been read."
        );
    });

    it("waits while the history is not read", () => {
        expect(nextReleaseView(null, null, [], "ok")).toBeNull();
    });
});

describe("releases card", () => {
    it("reads the last candidate and its notes from the git tags alone (no GitHub)", () => {
        const g = git({
            tags: [
                {
                    name: "v1.0.0-2",
                    sha: "b",
                    date: "2026-10-03T10:00:00Z",
                    notes: "# v1.0.0-2\n\nEvery page's help now ends by showing where that page is configured.\n\n## Fixes\n- The tour",
                },
                { name: "v1.0.0-1", sha: "a", date: "2026-09-20T10:00:00Z", notes: "# v1.0.0-1\n\nFirst." },
            ],
        });
        const view = releasesView(stateOf(g));
        expect(view.rc).toMatchObject({ tag: "v1.0.0-2", date: "2026-10-03T10:00:00Z" });
        expect(view.rc.excerpt).toBe(
            "Every page's help now ends by showing where that page is configured.\n• The tour"
        );
        expect(view.public).toBeNull();
        expect(view.firstPublic).toBe("v1.0.0 will be the first.");
    });

    it("shows the last public release and the candidate after it", () => {
        const g = git({
            lastpublic: "v1.0.0",
            tags: [
                { name: "v1.1.0-1", sha: "c", date: "2026-10-04T10:00:00Z", notesinternal: "Internal notes only" },
                { name: "v1.0.0", sha: "b", date: "2026-09-30T10:00:00Z" },
                { name: "v1.0.0-1", sha: "a", date: "2026-09-20T10:00:00Z" },
            ],
        });
        const view = releasesView(stateOf(g));
        expect(view.rc.tag).toBe("v1.1.0-1");
        expect(view.rc.excerpt).toBe("Internal notes only");
        expect(view.public).toMatchObject({ tag: "v1.0.0", excerpt: "" });
        expect(view.firstPublic).toBe("");
    });

    it("has nothing to show before the first tag", () => {
        const view = releasesView(stateOf(git()));
        expect(view.rc).toBeNull();
        expect(view.public).toBeNull();
    });

    it("cuts long notes on a word", () => {
        const long = "word ".repeat(80).trim();
        const excerpt = notesExcerpt(long, 40);
        expect(excerpt.endsWith("…")).toBe(true);
        expect(excerpt.length).toBeLessThanOrEqual(41);
        expect(excerpt).not.toMatch(/ …$/);
        expect(notesExcerpt(null)).toBe("");
    });
});

describe("now card", () => {
    const ciRun = (id: string, branch: string, status: any, startedat: number, finishedat?: number) => ({
        id,
        dir: "/p",
        sha: "s",
        tree: "t",
        branch,
        startedat,
        finishedat,
        status,
        jobs: [
            { name: "lint", status: "success" as const },
            { name: "test", status: status === "running" ? ("running" as const) : status },
        ],
    });

    it("shows the CI running on the trunk with its elapsed time", () => {
        const ci: CiState = { runs: [ciRun("r1", "develop", "running", Now - 134_000)], running: "r1", branches: [] };
        expect(trunkCiLine(ci, "develop", Now)).toMatchObject({
            label: "CI on develop",
            text: "running · 02:14",
            tone: "running",
            title: "1 of 2 jobs done",
        });
    });

    it("ignores a CI running on another branch and shows the trunk's last result", () => {
        const ci: CiState = {
            runs: [
                ciRun("r2", "feature/3", "running", Now - 5_000),
                ciRun("r1", "develop", "failure", Now - 3_600_000, Now - 3_000_000),
            ],
            running: "r2",
            branches: [],
        };
        expect(trunkCiLine(ci, "develop", Now)).toMatchObject({ text: "failed · 50 minutes ago", tone: "failure" });
    });

    it("follows the trunk's head, as the status bar does on a checkout of it (#234)", () => {
        const head = (verdict: any) => [{ name: "develop", sha: "new", date: 0, verdict }];
        const older = ciRun("r1", "develop", "success", Now - 7_200_000, Now - 7_000_000);
        expect(trunkCiLine({ runs: [older], branches: head("missing") }, "develop", Now)).toMatchObject({
            text: "not run on the latest commit",
            tone: "neutral",
            title: "Last run, on s: passed · 2 hours ago",
        });
        // Same code under a new commit (a merge that changed nothing): the verdict on the code holds.
        expect(trunkCiLine({ runs: [older], branches: head("success") }, "develop", Now)).toMatchObject({
            text: "passed",
            tone: "success",
        });
        const current = { ...older, sha: "new" };
        expect(trunkCiLine({ runs: [current], branches: head("success") }, "develop", Now)).toMatchObject({
            text: "passed · 2 hours ago",
        });
    });

    it("falls back to the kept verdict, then to not run", () => {
        const verdict: CiState = { runs: [], branches: [{ name: "develop", sha: "s", date: 0, verdict: "success" }] };
        expect(trunkCiLine(verdict, "develop", Now)).toMatchObject({ text: "passed", tone: "success" });
        expect(trunkCiLine({ runs: [], branches: [] }, "develop", Now)).toMatchObject({
            text: "not run",
            tone: "neutral",
        });
        expect(trunkCiLine(null, "develop", Now).text).toBe("not run");
        expect(trunkCiLine(null, "", Now)).toBeNull();
    });

    it("shows the last local build's result and when", () => {
        const build = {
            id: "b1",
            dir: "/p",
            kind: "build",
            stepid: "gold",
            title: "Gold",
            command: "x",
            startedat: Now - 7_200_000,
            finishedat: Now - 7_000_000,
            state: "success",
            phases: [],
            commit: "0123456789",
        } as RunRecord;
        expect(lastBuildLine(build, Now)).toMatchObject({
            label: "Gold",
            text: "succeeded · 2 hours ago",
            tone: "success",
            title: "Commit 0123456",
        });
        expect(
            lastBuildLine({ ...build, state: "running", finishedat: 0, startedat: Now - 65_000 }, Now)
        ).toMatchObject({
            text: "running · 01:05",
            tone: "running",
        });
        expect(lastBuildLine({ ...build, state: "failure" }, Now).tone).toBe("failure");
        expect(lastBuildLine(null, Now)).toMatchObject({ label: "No local build yet", tone: "neutral" });
    });

    it("says times the way a person reads them", () => {
        expect(agoText(Now - 20_000, Now)).toBe("just now");
        expect(agoText(Now - 5 * 60_000, Now)).toBe("5 minutes ago");
        expect(agoText(Now - 3 * 3_600_000, Now)).toBe("3 hours ago");
        expect(agoText(Now - 3 * 86_400_000, Now)).toBe("3 days ago");
        expect(agoText(0, Now)).toBe("");
        expect(clockElapsed(3_725_000)).toBe("1:02:05");
        expect(clockElapsed(-5)).toBe("00:00");
    });
});
