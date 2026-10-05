// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    assignLanes,
    chooseLabels,
    FullPxPerDay,
    LabelGap,
    layoutLineMap,
    OverviewMaxLanes,
    OverviewMinWidth,
    spreadStations,
    StationGap,
    tickStep,
} from "./line-map-geometry";
import { buildLineMap, LineMapBranch, LineMapModel, LineMapStation } from "./line-map-model";
import { MissionGit, RawCommit } from "./mission-model";

const Day = 86_400_000;
const NOW = new Date("2026-10-05T12:00:00Z").getTime();

function station(name: string, at: number, kind: "rc" | "public" = "rc", source: number = null): LineMapStation {
    return {
        name,
        sha: name,
        at,
        date: new Date(at).toISOString(),
        kind,
        notes: null,
        source: source == null ? null : { sha: "s" + name, at: source, date: "", subject: "" },
        latest: false,
        url: null,
    };
}

function branch(id: string, fork: number, merge: number, state: "merged" | "open" = "merged"): LineMapBranch {
    return {
        id,
        name: id,
        ticket: null,
        state,
        fork,
        forkKnown: true,
        merge: state === "open" ? null : merge,
        mergeSha: null,
        commits: [],
        count: 2,
        countCapped: false,
        pr: null,
        prNumber: null,
        ci: null,
        url: null,
    };
}

function model(over: Partial<LineMapModel> = {}): LineMapModel {
    return {
        start: NOW - 21 * Day,
        now: NOW,
        days: 21,
        trunk: "develop",
        release: "main",
        head: null,
        commits: [],
        branches: [],
        stations: [],
        earlier: [],
        terminus: { version: "1.0.0", tag: "v1.0.0", how: "decision", reason: "", waiting: 3 },
        github: "",
        historyFrom: null,
        ...over,
    };
}

describe("scale and ticks", () => {
    it("keeps a minimum width on narrow panes and fits wider ones", () => {
        expect(layoutLineMap(model(), { width: 400 }).width).toBe(OverviewMinWidth);
        expect(layoutLineMap(model(), { width: 1400 }).width).toBe(1400);
    });

    it("gives the full size room per day, wider than its pane when the window is long", () => {
        const geo = layoutLineMap(model({ days: 90, start: NOW - 90 * Day }), { width: 1200, full: true });
        expect(geo.width).toBeGreaterThan(1200);
        expect((geo.nowX - geo.left) / 90).toBeCloseTo(FullPxPerDay, 0);
    });

    it("dates ticks back from now, a week apart on a wide 21-day map", () => {
        const geo = layoutLineMap(model(), { width: 1400 });
        expect(geo.ticks.map((t) => t.label)).toEqual(["14 Sept", "21 Sept", "28 Sept", "now"]);
        expect(geo.ticks[0].x).toBeCloseTo(geo.left);
        expect(geo.ticks[3].x).toBe(geo.nowX);
    });

    it("picks the tick step from the room per day", () => {
        expect(tickStep(150)).toBe(1);
        expect(tickStep(70)).toBe(2);
        expect(tickStep(50)).toBe(7);
        expect(tickStep(1)).toBe(90);
    });

    it("leaves the future room for the route and the terminus on main", () => {
        const geo = layoutLineMap(model(), { width: 1400 });
        expect(geo.terminus.x).toBeGreaterThan(geo.nowX);
        expect(geo.terminus.y).toBe(geo.mainY);
        expect(geo.devY).toBeGreaterThan(geo.mainY);
        expect(geo.route.startsWith(`M ${geo.nowX} ${geo.devY}`)).toBe(true);
        expect(geo.terminus.textX + "public release".length * 6.6).toBeLessThanOrEqual(geo.width);
        expect(geo.terminus).toMatchObject({ title: "v1.0.0", sub: "public release", status: "to decide" });
    });
});

describe("stations", () => {
    it("keeps tags of one day apart, in order, inside the line", () => {
        const xs = spreadStations([300, 300, 301, 302], 84, 1000);
        for (let i = 1; i < xs.length; i++) {
            expect(xs[i] - xs[i - 1]).toBeGreaterThanOrEqual(StationGap - 1e-9);
        }
        expect(xs[0]).toBe(300);
    });

    it("pushes stations back from now when they overflow", () => {
        const xs = spreadStations([990, 995, 1000], 84, 1000);
        expect(xs[2]).toBe(1000);
        expect(xs[1]).toBe(1000 - StationGap);
        expect(xs[0]).toBe(1000 - 2 * StationGap);
    });

    it("tightens the gap when even that does not fit, never leaving the line", () => {
        const xs = spreadStations(new Array(50).fill(500), 100, 600);
        expect(Math.min(...xs)).toBeGreaterThanOrEqual(100);
        expect(Math.max(...xs)).toBeLessThanOrEqual(600);
        expect(xs[1] - xs[0]).toBeCloseTo(500 / 49);
    });

    it("keeps public releases' labels first, then the latest, then the most recent", () => {
        const kept = chooseLabels([
            { x: 100, kind: "rc", latest: false, at: 1 },
            { x: 110, kind: "public", latest: false, at: 2 },
            { x: 120, kind: "rc", latest: false, at: 3 },
            { x: 200, kind: "rc", latest: false, at: 4 },
            { x: 210, kind: "rc", latest: true, at: 5 },
        ]);
        expect(kept).toEqual([false, true, false, false, true]);
    });

    it("labels every station of a sparse line, and draws the connector from develop", () => {
        const at = NOW - 5 * Day;
        const geo = layoutLineMap(model({ stations: [station("v1.0.0-1", at, "rc", at - Day)] }), { width: 1400 });
        const s = geo.stations[0];
        expect(s.label).toMatchObject({ name: "v1.0.0-1", date: "30 Sept" });
        expect(s.source.y).toBe(geo.devY);
        expect(s.source.x).toBeLessThan(s.x);
        expect(s.connector.startsWith(`M ${s.source.x} ${geo.devY}`)).toBe(true);
        expect(s.connector.endsWith(`${s.x} ${geo.mainY}`)).toBe(true);
    });

    it("draws a public release larger than a candidate", () => {
        const geo = layoutLineMap(
            model({ stations: [station("v1", NOW - 9 * Day), station("v2", NOW - 2 * Day, "public")] }),
            { width: 1400 }
        );
        expect(geo.stations[1].r).toBeGreaterThan(geo.stations[0].r);
    });

    it("drops labels that would overlap and keeps every station", () => {
        const many = Array.from({ length: 40 }, (_, i) => station(`v1.0.0-${i + 1}`, NOW - 2 * Day + i * 60_000));
        const geo = layoutLineMap(model({ stations: many }), { width: 900 });
        expect(geo.stations).toHaveLength(40);
        const labelled = geo.stations.filter((s) => s.label).map((s) => s.x);
        for (let i = 1; i < labelled.length; i++) {
            expect(Math.abs(labelled[i] - labelled[i - 1])).toBeGreaterThanOrEqual(LabelGap - 1e-9);
        }
        expect(labelled.length).toBeLessThan(40);
    });

    it("collapses the tags before the window into one marker at the left edge", () => {
        const geo = layoutLineMap(model({ earlier: [station("v0.1.0", NOW - 90 * Day)] }), { width: 1400 });
        expect(geo.earlier).toMatchObject({ x: geo.left, y: geo.mainY, count: 1 });
    });
});

describe("branches", () => {
    it("puts overlapping branches in different lanes and reuses a free one", () => {
        const lanes = assignLanes(
            [
                { start: 0, end: 100, labelStart: 30 },
                { start: 50, end: 150, labelStart: 80 },
                { start: 120, end: 200, labelStart: 150 },
            ],
            5
        );
        expect(lanes.map((l) => l.lane)).toEqual([0, 1, 0]);
        expect(lanes.every((l) => l.labelled)).toBe(true);
    });

    it("shares the lane that frees first past the cap, without a label that would run over", () => {
        const items = Array.from({ length: 4 }, (_, i) => ({ start: i, end: 1000 + i, labelStart: i + 30 }));
        const lanes = assignLanes(items, 3);
        expect(lanes[3]).toEqual({ lane: 0, labelled: false });
    });

    it("leaves develop at the fork and rejoins it at the merge", () => {
        const b = branch("feature/1", NOW - 10 * Day, NOW - 6 * Day);
        const geo = layoutLineMap(model({ branches: [b] }), { width: 1400 });
        const g = geo.branches[0];
        expect(g.path.startsWith(`M ${g.x1} ${geo.devY}`)).toBe(true);
        expect(g.path.endsWith(`${g.x2} ${geo.devY}`)).toBe(true);
        expect(g.laneY).toBeGreaterThan(geo.devY);
        expect(g.merge).toEqual({ x: g.x2, y: geo.devY });
        expect(g.label.text).toBe("feature/1");
    });

    it("gives a branch of a few minutes a visible width", () => {
        const b = branch("fix/2", NOW - 3 * Day, NOW - 3 * Day + 60_000);
        const g = layoutLineMap(model({ branches: [b] }), { width: 1400 }).branches[0];
        expect(g.x2 - g.x1).toBeGreaterThanOrEqual(20);
    });

    it("enters a branch older than the window from the left edge", () => {
        const b = branch("feature/3", NOW - 40 * Day, NOW - 15 * Day);
        const geo = layoutLineMap(model({ branches: [b] }), { width: 1400 });
        expect(geo.branches[0].clipped).toBe(true);
        expect(geo.branches[0].path.startsWith(`M ${geo.left} ${geo.branches[0].laneY}`)).toBe(true);
    });

    it("runs an open branch to now with its tip and its commit count", () => {
        const b = { ...branch("fix/4-x", NOW - 2 * Day, null, "open"), count: 3, prNumber: 9 };
        const geo = layoutLineMap(model({ branches: [b] }), { width: 1400 });
        const g = geo.branches[0];
        expect(g.tip).toEqual({ x: geo.nowX, y: g.laneY });
        expect(g.merge).toBeNull();
        expect(g.label.text).toBe("fix/4-x · 3 commits · PR #9");
        expect(g.label.x).toBeGreaterThan(geo.nowX);
    });

    it("caps the overview's lanes and grows the height with them", () => {
        const many = Array.from({ length: 12 }, (_, i) => branch(`b${i}`, NOW - 10 * Day, NOW - Day));
        const geo = layoutLineMap(model({ branches: many }), { width: 1400 });
        expect(geo.lanes).toBe(OverviewMaxLanes);
        const one = layoutLineMap(model({ branches: many.slice(0, 1) }), { width: 1400 });
        expect(geo.height).toBeGreaterThan(one.height);
    });
});

describe("degraded projects", () => {
    it("shades the part of a long window before the history read", () => {
        const geo = layoutLineMap(model({ days: 90, start: NOW - 90 * Day, historyFrom: NOW - 30 * Day }), {
            width: 1400,
        });
        expect(geo.unread.x1).toBe(geo.left);
        expect(geo.unread.x2).toBeGreaterThan(geo.left);
        expect(geo.unread.label).toMatch(/^history read from /);
    });

    it("draws one line for a single-branch project, stations on it", () => {
        const geo = layoutLineMap(model({ release: null, stations: [station("v1.0.0", NOW - Day, "public")] }), {
            width: 1000,
        });
        expect(geo.single).toBe(true);
        expect(geo.mainY).toBe(geo.devY);
        expect(geo.stations[0].connector).toBeNull();
        expect(geo.future).toBeNull();
    });

    it("draws an empty project: lines, now and the terminus", () => {
        const geo = layoutLineMap(
            model({ terminus: { version: null, tag: null, how: "nothing", reason: "", waiting: 0 } }),
            {
                width: 1000,
            }
        );
        expect(geo.stations).toEqual([]);
        expect(geo.branches).toEqual([]);
        expect(geo.terminus).toMatchObject({ title: "next", status: "nothing to release yet" });
    });
});

// NFR-MC-005 (proposed): a 21-day window of 300 commits and 40 branches renders within 100 ms. The data and
// geometry are measured here; the SVG itself was measured in the app (PR #235's report).
describe("cost", () => {
    function bigGit(): MissionGit {
        const commits: RawCommit[] = [];
        for (let i = 0; i < 300; i++) {
            const at = NOW - (i / 300) * 21 * Day;
            const ticket = 100 + Math.floor(i / 5);
            commits.push({
                sha: `c${i}`,
                date: new Date(at).toISOString(),
                authordate: new Date(at - 3 * 3_600_000).toISOString(),
                subject: `feat(#${ticket}): change ${i}`,
                parents: [`c${i + 1}`],
            });
        }
        const release = commits.filter((_, i) => i % 15 === 0).map((c) => ({ ...c, sha: `r${c.sha}` }));
        const branches = Array.from({ length: 40 }, (_, i) => ({
            name: `feature/${500 + i}-work`,
            sha: `b${i}`,
            date: new Date(NOW - i * 3_600_000).toISOString(),
            commits: Array.from({ length: 5 }, (_, k) => ({
                sha: `b${i}-${k}`,
                date: new Date(NOW - i * 3_600_000 - k * 60_000).toISOString(),
                subject: `feat(#${500 + i}): step ${k}`,
            })),
            fork: { sha: `c${i * 7}`, date: commits[i * 7].date },
        }));
        const tags = release.slice(0, 20).map((c, i) => ({
            name: `v1.0.0-${20 - i}`,
            sha: c.sha,
            date: c.date,
        }));
        return {
            trunk: "develop",
            release: "main",
            remoteurl: "https://github.com/acme/app",
            branches: [
                { name: "main", sha: release[0].sha, date: release[0].date, commits: release, fork: null },
                { name: "develop", sha: "c0", date: commits[0].date, commits, fork: null },
                ...branches,
            ],
            tags,
            merges: [],
            ahead: commits.slice(0, 50),
            sincepublic: commits,
            tagprefix: "v",
        };
    }

    it("computes 300 commits and 40 branches well within 100 ms", () => {
        const git = bigGit();
        const runs: number[] = [];
        let out: ReturnType<typeof layoutLineMap>;
        for (let i = 0; i < 7; i++) {
            const t0 = performance.now();
            const m = buildLineMap({ git, now: NOW, days: 21 });
            out = layoutLineMap(m, { width: 1400 });
            runs.push(performance.now() - t0);
        }
        runs.sort((a, b) => a - b);
        const median = runs[3];
        console.log(`line map data + geometry, 300 commits / 40 open branches: median ${median.toFixed(2)} ms`);
        expect(out.branches.length).toBeGreaterThanOrEqual(40);
        expect(out.stations.length).toBe(20);
        expect(median).toBeLessThan(100);
    });
});
