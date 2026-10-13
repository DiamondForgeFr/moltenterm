// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { CiState } from "../mission/ci-model";
import { Milestone } from "../mission/github";
import { terminusText } from "../mission/line-map-geometry";
import { buildLineMap } from "../mission/line-map-model";
import { MissionGit, PipelineDef } from "../mission/mission-model";
import { ReleaseSession } from "../mission/release-model";
import {
    countsLine,
    githubBase,
    nextStation,
    runCiTarget,
    stationSchedule,
    tickerItems,
    waitingCounts,
} from "./next-station-model";

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

describe("the next station's schedule", () => {
    const station = { tag: "v1.0.0", state: "decision" as const, chip: "to decide", note: "" };
    const m = (number: number, title: string, extra: Partial<Milestone> = {}): Milestone => ({
        number,
        title,
        open_issues: 0,
        closed_issues: 0,
        html_url: `https://github.com/o/r/milestone/${number}`,
        ...extra,
    });
    const Oct12 = new Date("2026-10-12T12:00:00Z").getTime();

    it("shows the due date and the milestone due first after it", () => {
        const milestones = [
            m(14, "Later", { due_on: "2026-10-15T07:00:00Z", created_at: "2026-09-01T00:00:00Z" }),
            m(13, "1.1.0", { due_on: "2026-10-20T07:00:00Z", created_at: "2026-10-04T00:00:00Z" }),
            m(15, "1.2.0", { due_on: "2026-11-02T07:00:00Z", created_at: "2026-10-03T00:00:00Z" }),
            m(12, "1.0.0", { due_on: "2026-10-13T07:00:00Z", created_at: "2026-09-20T00:00:00Z" }),
        ];
        expect(stationSchedule(station, milestones, "v", Oct12)).toEqual({
            due: "due Oct 13",
            overdue: false,
            chip: "due tomorrow",
            urgent: false,
            title: "Due Oct 13 (milestone 1.0.0)",
            then: {
                label: "then v1.1.0 · Oct 20",
                url: "https://github.com/o/r/milestone/13",
                title: "Open the milestone 1.1.0 on GitHub",
            },
        });
        expect(stationSchedule(station, milestones, "v", new Date("2026-10-14T09:00:00Z").getTime()).overdue).toBe(
            true
        );
    });

    it("without due dates, takes the next milestone created after the station's, never a bucket", () => {
        const milestones = [
            m(12, "1.0.0", { created_at: "2026-09-20T00:00:00Z" }),
            m(14, "Later", { created_at: "2026-09-25T00:00:00Z" }),
            m(16, "v1.2.0", { created_at: "2026-10-06T00:00:00Z" }),
            m(13, "1.1.0", { created_at: "2026-10-04T00:00:00Z" }),
            m(11, "0.9.0", { created_at: "2026-09-01T00:00:00Z" }),
        ];
        expect(stationSchedule(station, milestones, "v", Oct12)).toEqual({
            due: null,
            overdue: false,
            chip: null,
            urgent: false,
            title: null,
            then: {
                label: "then v1.1.0",
                url: "https://github.com/o/r/milestone/13",
                title: "Open the milestone 1.1.0 on GitHub",
            },
        });
    });

    it("shows nothing without a following milestone or a due date", () => {
        const alone = [m(12, "1.0.0", { created_at: "2026-09-20T00:00:00Z" }), m(14, "Later")];
        expect(stationSchedule(station, alone, "v", Oct12)).toBeNull();
        expect(stationSchedule(station, [], "v", Oct12)).toBeNull();
        expect(stationSchedule({ tag: null, state: "nothing", chip: null, note: "" }, [], "v", Oct12)).toBeNull();
    });

    it("reads the due date from today in UTC days", () => {
        const dueOn = (due_on: string) => [m(12, "1.0.0", { due_on })];
        const chip = (due_on: string, now: string) => {
            const s = stationSchedule(station, dueOn(due_on), "v", new Date(now).getTime());
            return [s.chip, s.urgent];
        };
        expect(chip("2026-10-13T07:00:00Z", "2026-10-13T00:10:00Z")).toEqual(["due today", true]);
        expect(chip("2026-10-13T07:00:00Z", "2026-10-13T23:50:00Z")).toEqual(["due today", true]);
        expect(chip("2026-10-13T07:00:00Z", "2026-10-12T23:59:00Z")).toEqual(["due tomorrow", false]);
        expect(chip("2026-10-16T07:00:00Z", "2026-10-13T23:00:00Z")).toEqual(["due in 3 days", false]);
        expect(chip("2026-10-19T07:00:00Z", "2026-10-13T09:00:00Z")).toEqual(["due in 6 days", false]);
        expect(chip("2026-10-20T07:00:00Z", "2026-10-13T09:00:00Z")).toEqual(["due Oct 20", false]);
        expect(chip("2026-10-12T07:00:00Z", "2026-10-13T00:01:00Z")).toEqual(["overdue by 1 day", true]);
        expect(chip("2026-10-11T07:00:00Z", "2026-10-13T09:00:00Z")).toEqual(["overdue by 2 days", true]);
        // A due date a few hours later in the day is the same day, whatever time GitHub stored.
        expect(chip("2026-10-13T00:00:00Z", "2026-10-13T22:00:00Z")).toEqual(["due today", true]);
    });
});

describe("the next station with its milestone's due date", () => {
    const m = (title: string, due_on?: string): Milestone => ({
        number: title.length,
        title,
        open_issues: 0,
        closed_issues: 0,
        html_url: `https://github.com/o/r/milestone/${title}`,
        due_on,
    });
    const Oct13 = new Date("2026-10-13T09:00:00Z").getTime();

    it("shows the schedule in the chip and keeps 'to decide' in the note", () => {
        expect(nextStation(git(), null, [m("1.0.0", "2026-10-13T07:00:00Z")], Oct13)).toEqual({
            tag: "v1.0.0",
            state: "decision",
            chip: "due today",
            urgent: true,
            chiptitle: "Due Oct 13 (milestone 1.0.0)",
            note: "First public release: the number is a choice, pick it in the Release menu.",
        });
        expect(nextStation(git(), null, [m("1.0.0", "2026-10-16T07:00:00Z")], Oct13)).toMatchObject({
            chip: "due in 3 days",
            urgent: false,
        });
        expect(nextStation(git(), null, [m("1.0.0", "2026-10-11T07:00:00Z")], Oct13)).toMatchObject({
            chip: "overdue by 2 days",
            urgent: true,
        });
    });

    it("keeps the bump level in the note of a derived station", () => {
        const s = nextStation(Released, null, [m("1.2.0", "2026-10-20T07:00:00Z")], Oct13);
        expect(s).toMatchObject({ tag: "v1.2.0", state: "derived", chip: "due Oct 20", urgent: false });
        expect(s.note).toMatch(/^A minor release, derived from the commits: 3 new feature/);
        const chosen = nextStation(Released, session("public", "2.0.0"), [m("v2", "2026-10-13T07:00:00Z")], Oct13);
        expect(chosen).toMatchObject({ tag: "v2.0.0", state: "chosen", chip: "due today", urgent: true });
        expect(chosen.note).toContain("Chosen in the Release menu");
    });

    it("is unchanged without a due date on the station's own milestone", () => {
        const plain = nextStation(git(), null);
        expect(nextStation(git(), null, [], Oct13)).toEqual(plain);
        expect(nextStation(git(), null, [m("1.0.0")], Oct13)).toEqual(plain);
        expect(nextStation(git(), null, [m("1.1.0", "2026-10-20T07:00:00Z")], Oct13)).toEqual(plain);
        expect(nextStation(git({ ...Released, sincepublic: commits("chore: x") }), null, [m("1.0.0")], Oct13)).toEqual(
            nextStation(git({ ...Released, sincepublic: commits("chore: x") }), null)
        );
    });

    it("reads the same chip as the line map's terminus", () => {
        const milestones = [m("1.0.0", "2026-10-11T07:00:00Z")];
        const station = nextStation(git(), null, milestones, Oct13);
        const model = buildLineMap({ git: git(), milestones, now: Oct13, days: 21 });
        expect(model.terminus).toMatchObject({ chip: station.chip, note: station.note, urgent: true });
        expect(terminusText(model).status).toBe("overdue by 2 days");
        const derived = [m("1.2.0", "2026-10-16T07:00:00Z")];
        const map = buildLineMap({ git: Released, milestones: derived, now: Oct13, days: 21 });
        expect(terminusText(map).status).toBe("due in 3 days · 6 changes waiting");
        expect(nextStation(Released, null, derived, Oct13).chip).toBe("due in 3 days");
    });
});
