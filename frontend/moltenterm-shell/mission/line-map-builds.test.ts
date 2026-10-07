// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { BuildFacts } from "./builds-model";
import { latestBuildPerFlavor, LocalBuild, localBuildsOf } from "./line-map-builds";
import { layoutLineMap } from "./line-map-geometry";
import { buildLineMap } from "./line-map-model";
import { MissionGit, RawCommit } from "./mission-model";

const NOW = new Date("2026-10-05T12:00:00Z").getTime();

function c(sha: string, date: string, subject: string, extra: Partial<RawCommit> = {}): RawCommit {
    return { sha, date, subject, parents: ["p" + sha], authordate: date, ...extra };
}

function makeGit(trunk: RawCommit[], release: RawCommit[] = [], over: Partial<MissionGit> = {}): MissionGit {
    return {
        trunk: "develop",
        release: "main",
        remoteurl: "https://github.com/acme/app",
        branches: [
            { name: "main", sha: "m1", date: "2026-10-01T00:00:00Z", commits: release, fork: null },
            { name: "develop", sha: "d1", date: "2026-10-04T00:00:00Z", commits: trunk, fork: null },
        ],
        tags: [],
        merges: [],
        ahead: [],
        sincepublic: [],
        tagprefix: "v",
        ...over,
    };
}

function build(over: Partial<LocalBuild> & { commit: string; builtAt?: string }): LocalBuild {
    const { commit, builtAt, ...rest } = over;
    return {
        id: "gold",
        kind: "gold",
        title: "Gold",
        artifact: "/builds/gold/Moltenterm.app",
        manifest: { commit, builtAt: builtAt ?? "2026-10-04T08:00:00Z", buildId: 1759564800 },
        ...rest,
    };
}

// develop, newest first: two commits since the build's, one merge commit that counts for nothing, and one before
// the 21-day window.
const Trunk = [
    c("d5555555aaaa", "2026-10-04T10:00:00Z", "feat(#5): newest"),
    c("d4444444aaaa", "2026-10-03T10:00:00Z", "Merge branch 'x' into develop", { parents: ["a", "b"] }),
    c("d3333333aaaa", "2026-10-02T10:00:00Z", "fix(#3): second"),
    c("d2222222aaaa", "2026-09-30T10:00:00Z", "feat(#2): the gold's commit"),
    c("d1111111aaaa", "2026-09-01T10:00:00Z", "feat(#1): before the window"),
];

function place(builds: LocalBuild[], git: MissionGit, days = 21) {
    return buildLineMap({ git, builds, now: NOW, days }).builds;
}

describe("placing a local build on the line map", () => {
    it("puts a build whose commit is on develop inside the window at that commit, with the commits since", () => {
        const [marker] = place([build({ commit: "d2222222aaaa" })], makeGit(Trunk));
        expect(marker).toMatchObject({
            place: "develop",
            label: "Gold",
            subject: "feat(#2): the gold's commit",
            behind: 2,
            behindCapped: false,
        });
        expect(marker.at).toBe(new Date("2026-09-30T10:00:00Z").getTime());
    });

    it("matches a manifest's abbreviated commit", () => {
        const [marker] = place([build({ commit: "d222222" })], makeGit(Trunk));
        expect(marker.place).toBe("develop");
    });

    it("puts a build made from a tag on main, at the tag, with the develop commits since its source", () => {
        const tagCommit = c("t9999999aaaa", "2026-10-01T10:00:00Z", "chore(release): v1.0.0-1", {
            parents: ["x", "d2222222aaaa"],
        });
        const git = makeGit(Trunk, [tagCommit], {
            tags: [{ name: "v1.0.0-1", sha: "t9999999aaaa", date: "2026-10-01T10:00:00Z" }],
        });
        const [marker] = place([build({ id: "rc", kind: "rc", title: "RC", commit: "t9999999aaaa" })], git);
        expect(marker).toMatchObject({ place: "main", label: "RC local", tag: "v1.0.0-1", behind: 2 });
        expect(marker.at).toBe(new Date("2026-10-01T10:00:00Z").getTime());
    });

    it("keeps a commit older than the window off the line, with how far behind it is", () => {
        const [marker] = place([build({ commit: "d1111111aaaa" })], makeGit(Trunk));
        expect(marker).toMatchObject({ place: "before", behind: 3 });
    });

    it("finds the same build on the line once the window reaches it", () => {
        const [marker] = place([build({ commit: "d1111111aaaa" })], makeGit(Trunk), 60);
        expect(marker.place).toBe("develop");
    });

    it("draws nothing for a build without a manifest", () => {
        const facts: BuildFacts[] = [{ id: "gold", kind: "gold", title: "Gold" }];
        expect(localBuildsOf(facts)).toEqual([]);
        expect(place(localBuildsOf(facts), makeGit(Trunk))).toEqual([]);
        const model = buildLineMap({ git: makeGit(Trunk), builds: [], now: NOW, days: 21 });
        expect(layoutLineMap(model, { width: 1000 }).builds).toEqual([]);
    });

    it("says so when the commit is in no history read", () => {
        const [marker] = place([build({ commit: "ffffffffffff" })], makeGit(Trunk));
        expect(marker).toMatchObject({ place: "unknown", behind: null, subject: "" });
    });

    it("counts a floor when the build is older than the history the collector reads", () => {
        const many = Array.from({ length: 300 }, (_, i) =>
            c(`k${String(i).padStart(11, "0")}`, new Date(NOW - i * 3_600_000).toISOString(), `fix(#${i}): x`)
        );
        const [marker] = place([build({ commit: "ffffffffffff" })], makeGit(many));
        expect(marker).toMatchObject({ place: "beyond", behind: 300, behindCapped: true });
    });

    it("keeps the most recent build of each flavor only", () => {
        const older = build({ commit: "d1111111aaaa", builtAt: "2026-09-02T00:00:00Z" });
        const newer = build({ commit: "d2222222aaaa", builtAt: "2026-10-04T00:00:00Z" });
        const rc = build({ id: "rc", kind: "rc", commit: "d3333333aaaa" });
        const kept = latestBuildPerFlavor([older, rc, newer]);
        expect(kept.map((b) => b.manifest.commit)).toEqual(["d2222222aaaa", "d3333333aaaa"]);
    });
});

describe("the build markers' geometry", () => {
    const geoOf = (builds: LocalBuild[], days = 21) =>
        layoutLineMap(buildLineMap({ git: makeGit(Trunk), builds, now: NOW, days }), { width: 1200 });

    it("stands a pill above develop at its commit, with a tick down to the line", () => {
        const geo = geoOf([build({ commit: "d2222222aaaa" })]);
        const [pill] = geo.builds;
        expect(pill.chip).toBe(false);
        expect(pill.y + pill.h).toBeLessThan(geo.devY);
        expect(pill.tick).toMatchObject({ y1: pill.y + pill.h, y2: geo.devY });
        expect(pill.tick.x).toBeGreaterThan(geo.left);
        expect(pill.x).toBeLessThanOrEqual(pill.tick.x);
        expect(pill.x + pill.w).toBeGreaterThanOrEqual(pill.tick.x);
    });

    it("turns an off-window build into a chip at the left edge, with no tick", () => {
        const geo = geoOf([build({ commit: "d1111111aaaa" })]);
        const [chip] = geo.builds;
        expect(chip.chip).toBe(true);
        expect(chip.tick).toBeNull();
        expect(chip.text).toBe("Gold ← 3 commits behind");
        expect(chip.x).toBeGreaterThanOrEqual(geo.left);
        expect(chip.x).toBeLessThan(geo.left + 12);
    });

    it("moves a pill that would overlap another one a row up", () => {
        const geo = geoOf([build({ commit: "d2222222aaaa" }), build({ id: "rc", kind: "rc", commit: "d2222222aaaa" })]);
        const [a, b] = geo.builds;
        expect(a.y).not.toBe(b.y);
    });
});
