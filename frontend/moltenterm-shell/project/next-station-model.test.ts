// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { CiState } from "../mission/ci-model";
import { terminusText } from "../mission/line-map-geometry";
import { buildLineMap } from "../mission/line-map-model";
import { MissionGit, PipelineDef } from "../mission/mission-model";
import { ReleaseSession } from "../mission/release-model";
import { countsLine, githubBase, nextStation, runCiTarget, tickerItems, waitingCounts } from "./next-station-model";

const Now = new Date("2026-10-05T12:00:00Z").getTime();

function commits(...subjects: string[]) {
    return subjects.map((subject, i) => ({ sha: `c${i}`, date: "2026-10-01T10:00:00Z", subject }));
}

// TC-MC-019's project: 3 feat, 2 fix and 1 chore on develop that main does not have, oldest first as git cherry
// lists them (the collector's "ahead"); "sincepublic" comes from git log, newest first.
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
        sincepublic: [...Pending].reverse(),
        tagprefix: "v",
        ...extra,
    };
}

const Released = git({
    tags: [{ name: "v1.1.0", sha: "t1", date: "2026-09-20T10:00:00Z" }],
    lastpublic: "v1.1.0",
});

const Pipeline = { schema: 1, name: "p", ci: { jobs: [{ name: "lint", run: "true" }] } } as unknown as PipelineDef;

function session(channel: "rc" | "public", version: string, tag = `v${version}`): ReleaseSession {
    return { channel, version, tag, startedat: Now };
}

describe("next station", () => {
    it("reads 'to decide' before the first public release", () => {
        expect(nextStation(git(), null)).toEqual({
            tag: "v1.0.0",
            state: "decision",
            chip: "to decide",
            note: "First public release: a choice, not a calculation.",
        });
    });

    it("shows the number chosen in the Release menu once a public release is on its way", () => {
        const s = nextStation(git(), session("public", "2.0.0"));
        expect(s).toMatchObject({ tag: "v2.0.0", state: "chosen", chip: "chosen" });
        expect(s.note).toContain("Chosen in the Release menu");
    });

    it("a release candidate on its way chooses nothing", () => {
        expect(nextStation(git(), session("rc", "1.0.0", "v1.0.0-1"))).toMatchObject({
            tag: "v1.0.0",
            state: "decision",
        });
    });

    it("derives the next version from the commits after a public release", () => {
        const s = nextStation(Released, null);
        expect(s).toMatchObject({ tag: "v1.2.0", state: "derived", chip: "minor" });
        expect(s.note).toMatch(/^Derived from the commits: 3 new feature/);
        expect(nextStation(Released, session("public", "1.2.0"))).toMatchObject({
            tag: "v1.2.0",
            state: "derived",
            chip: "minor",
        });
    });

    it("has no version when nothing a user sees changed", () => {
        const g = git({ ...Released, sincepublic: commits("chore: bump", "docs: readme") });
        const s = nextStation(g, null);
        expect(s.tag).toBeNull();
        expect(s.state).toBe("nothing");
        expect(s.note).toMatch(/^Nothing a user would see since v1\.1\.0/);
    });

    it("follows the project's tag prefix", () => {
        expect(nextStation(git({ tagprefix: "release-" }), null).tag).toBe("release-1.0.0");
    });

    it("names the same version in the same state as the line map's terminus, in every state", () => {
        const since = (...subjects: string[]) => git({ ...Released, sincepublic: commits(...subjects) });
        const cases: [string, MissionGit, ReleaseSession, string][] = [
            ["to decide", git(), null, "to decide"],
            ["a release candidate on its way", git(), session("rc", "1.0.0", "v1.0.0-1"), "to decide"],
            ["major", since("feat(#1)!: drop the old format"), null, "major"],
            ["minor", Released, null, "minor"],
            ["patch", since("fix(#2): a crash"), null, "patch"],
            ["the derived number on its way", Released, session("public", "1.2.0"), "minor"],
            ["the first number chosen", git(), session("public", "1.0.0"), "chosen"],
            ["another number chosen", Released, session("public", "2.0.0"), "chosen"],
            ["nothing", since("chore: x"), null, null],
        ];
        for (const [name, g, s, chip] of cases) {
            const station = nextStation(g, s);
            const model = buildLineMap({ git: g, session: s, now: Now, days: 21 });
            const { status } = terminusText(model);
            expect({ name, chip: station.chip }).toEqual({ name, chip });
            expect({ name, tag: model.terminus.tag, state: model.terminus.state }).toEqual({
                name,
                tag: station.tag,
                state: station.state,
            });
            expect({ name, status: chip ? status.startsWith(chip) : status === "nothing to release yet" }).toEqual({
                name,
                status: true,
            });
        }
    });

    it("waits for the history", () => {
        expect(nextStation(null, null)).toBeNull();
    });
});

describe("waiting on develop", () => {
    it("counts features, fixes and other from the commit format", () => {
        const counts = waitingCounts(git());
        expect(counts).toEqual({
            title: "Waiting on develop",
            total: 6,
            features: 3,
            fixes: 2,
            other: 1,
            scope: "changes, not yet on main",
        });
        expect(countsLine(counts)).toBe("3 features · 2 fixes · 1 other");
    });

    it("on a single-branch project, counts what came since the last public release", () => {
        const counts = waitingCounts(
            git({ release: "main", trunk: "main", ahead: [], lastpublic: "v1.1.0", sincepublic: commits("fix: a") })
        );
        expect(counts).toMatchObject({ title: "Waiting on main", total: 1, fixes: 1, scope: "change since v1.1.0" });
        expect(countsLine(counts)).toBe("0 features · 1 fix · 0 other");
    });

    it("reads nothing waiting as zero", () => {
        expect(waitingCounts(git({ ahead: [] }))).toMatchObject({ total: 0, features: 0, fixes: 0, other: 0 });
        expect(countsLine(null)).toBe("");
    });
});

describe("ticker", () => {
    it("lists the pending changes, newest first, ticket and subject", () => {
        const items = tickerItems(git());
        expect(items).toHaveLength(6);
        expect(items[0]).toEqual({ key: "c5", ticket: "16", text: "bump dependencies", url: null });
        expect(items.map((i) => i.ticket)).toEqual(["16", "15", "14", "13", "12", "11"]);
        const single = tickerItems(git({ release: "develop", ahead: [], lastpublic: "v0.9.0" }));
        expect(single.map((i) => i.ticket)).toEqual(["16", "15", "14", "13", "12", "11"]);
    });

    it("links a ticket to its GitHub issue when the remote is on GitHub", () => {
        const items = tickerItems(git({ remoteurl: "https://github.com/acme/app.git" }));
        expect(items[0].url).toBe("https://github.com/acme/app/issues/16");
        expect(tickerItems(git({ remoteurl: "https://gitlab.com/acme/app" }))[0].url).toBeNull();
    });

    it("keeps a subject without ticket or type as it is", () => {
        const items = tickerItems(git({ ahead: commits("fix: no ticket", "Merge branch 'x'") }));
        expect(items.map((i) => [i.ticket, i.text])).toEqual([
            [null, "Merge branch 'x'"],
            [null, "no ticket"],
        ]);
    });

    it("is empty when nothing waits, and capped", () => {
        expect(tickerItems(git({ ahead: [] }))).toEqual([]);
        expect(tickerItems(null)).toEqual([]);
        expect(tickerItems(git(), 2)).toHaveLength(2);
    });
});

describe("githubBase", () => {
    it("keeps a GitHub web address only", () => {
        expect(githubBase("https://github.com/acme/app.git")).toBe("https://github.com/acme/app");
        expect(githubBase("https://github.com/acme/app/")).toBe("https://github.com/acme/app");
        expect(githubBase("https://gitlab.com/acme/app")).toBe("");
        expect(githubBase(null)).toBe("");
    });
});

describe("run CI on develop", () => {
    const run = (id: string, branch: string) => ({
        id,
        dir: "/p",
        sha: "s",
        tree: "t",
        branch,
        startedat: Now,
        status: "running" as const,
        jobs: [],
    });

    it("targets the trunk, not the checked-out branch", () => {
        const ci: CiState = { runs: [], branches: [], current: "feature/42-x" };
        expect(runCiTarget(git({ current: "feature/42-x" }), Pipeline, ci)).toEqual({
            branch: "develop",
            running: false,
            disabled: null,
        });
    });

    it("reads as running while the CI runs on the trunk", () => {
        const ci: CiState = { runs: [run("r1", "develop")], running: "r1", branches: [] };
        expect(runCiTarget(git(), Pipeline, ci)).toMatchObject({ running: true, disabled: null });
    });

    it("cannot start while a run is on its way elsewhere, nor without CI jobs", () => {
        const ci: CiState = { runs: [run("r1", "feature/3")], running: "r1", branches: [] };
        expect(runCiTarget(git(), Pipeline, ci)).toMatchObject({
            running: false,
            disabled: "A CI run is already on its way on feature/3.",
        });
        expect(runCiTarget(git(), null, null).disabled).toBe("The pipeline declares no CI job.");
        expect(runCiTarget(null, Pipeline, null).disabled).toBe("The project's trunk is not known yet.");
    });
});
