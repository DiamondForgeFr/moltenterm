// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { DependencyState, GroupMember, ProjectGroup } from "./group-model";
import { shortAgo, stripMember, stripMembers } from "./group-strip-model";

const NOW = new Date("2026-10-08T12:00:00Z").getTime();
const Minute = 60_000;

function staleDep(over: Partial<DependencyState> = {}): DependencyState {
    return {
        index: 0,
        project: "notulia",
        sourcename: "Notulia",
        paths: ["features/*.json"],
        output: ["src/features.json"],
        sync: "node scripts/sync-features.mjs",
        branch: "develop",
        ref: "origin/develop",
        state: "stale",
        synced: { sha: "aaa", time: NOW - 60 * Minute, subject: "chore: sync" },
        changed: ["features/live-notes.json"],
        commits: [
            { sha: "7f51307abcdef", time: NOW - Minute, subject: "feat(#1151): live notes are Pro", tickets: ["1151"] },
        ],
        ...over,
    };
}

const app: GroupMember = {
    dir: "/r/Notulia",
    name: "Notulia",
    group: "Notulia",
    workspaces: [{ id: "w-app", name: "App" }],
    state: {
        collectedat: NOW,
        trunk: "develop",
        trunkci: "success",
        remoteci: "failure",
        build: "success",
        buildid: "gold",
        buildat: NOW - 5 * Minute,
        releasetag: "v1.0.0",
        lasttag: "v1.1.0-rc.2",
    },
};

const site: GroupMember = {
    dir: "/r/notulia-website",
    name: "notulia-website",
    group: "notulia",
    workspaces: [
        { id: "w-site", name: "Site" },
        { id: "w-site-2", name: "Site 2" },
    ],
    state: {
        collectedat: NOW,
        trunk: "main",
        deps: [staleDep(), staleDep({ index: 1, project: "Ghost", sourcename: "", state: "sourcenotfound" })],
    },
};

const group: ProjectGroup = { key: "notulia", name: "Notulia", members: [app, site], worst: "amber" };

function withState(member: GroupMember, state: GroupMember["state"]): GroupMember {
    return { ...member, state };
}

describe("group strip", () => {
    it("lists the members in the group's order and marks the linked one", () => {
        const members = stripMembers(group, "w-app", "/r/Notulia", NOW);
        expect(members.map((m) => [m.member.name, m.current])).toEqual([
            ["Notulia", true],
            ["notulia-website", false],
        ]);
    });

    it("finds the current member by its folder when the workspace is not listed", () => {
        const members = stripMembers(group, "w-other", "/r/notulia-website/", NOW);
        expect(members.map((m) => m.current)).toEqual([false, true]);
    });

    it("shows nothing when the tab's project is not in the group", () => {
        expect(stripMembers(group, "w-x", "/r/x", NOW)).toEqual([]);
        expect(stripMembers(null, "w-app", "/r/Notulia", NOW)).toEqual([]);
    });

    it("switches to the first workspace linked to another member, never from the current one", () => {
        const [current, other] = stripMembers(group, "w-app", "/r/Notulia", NOW);
        expect(current.target).toBeNull();
        expect(other.target).toBe("w-site");
    });

    it("tells the trunk CI local and remote, the last build and the release tags", () => {
        const entry = stripMember(app, true, NOW);
        expect(entry.facts.map((f) => [f.key, f.value, f.tone])).toEqual([
            ["localci", "passed", "ok"],
            ["remoteci", "failed", "bad"],
            ["build", "gold passed 5 min ago", "ok"],
            ["release", "v1.1.0-rc.2 · public v1.0.0", "ok"],
        ]);
    });

    it("says when nothing is known yet instead of empty values", () => {
        const entry = stripMember(withState(app, { collectedat: NOW, trunkci: "missing" }), false, NOW);
        expect(entry.facts.map((f) => f.value)).toEqual(["no verdict", "unknown", "none yet", "none yet"]);
        const unread = stripMember(withState(app, {}), false, NOW);
        expect(unread.note).toMatch(/Not read yet/);
        expect(unread.facts.map((f) => f.key)).toEqual(["build", "release"]);
        const missing = stripMember(withState(app, { missing: true }), false, NOW);
        expect(missing.note).toBe("Its folder is missing");
        expect(missing.facts).toEqual([]);
    });

    it("shows a running job as running, never as a failure", () => {
        const entry = stripMember(
            withState(app, { collectedat: NOW, trunkci: "running", build: "running" }),
            false,
            NOW
        );
        expect(entry.facts.filter((f) => f.tone === "running").map((f) => f.key)).toEqual(["localci", "build"]);
    });

    it("puts a stale dependency on its dependent with the source, paths, commits, tickets and Sync", () => {
        const [current, other] = stripMembers(group, "w-app", "/r/Notulia", NOW);
        expect(current.flagged).toEqual([]);
        expect(other.flagged).toHaveLength(1);
        const flag = other.flagged[0];
        expect(flag.title).toBe("Behind Notulia on develop");
        expect(flag.paths).toEqual(["features/live-notes.json"]);
        expect(flag.commits).toEqual([
            { sha: "7f51307", subject: "feat(#1151): live notes are Pro", tickets: ["1151"] },
        ]);
        expect(flag.sync).toEqual({ dir: "/r/notulia-website", project: "Notulia", index: 0 });
        expect(other.unresolved).toEqual(["Ghost: source not found"]);
    });

    it("tells a never-synced and a synced-not-committed dependency", () => {
        const never = stripMember(
            withState(site, { collectedat: NOW, deps: [staleDep({ synced: undefined })] }),
            false,
            NOW
        );
        expect(never.flagged[0].title).toBe("Behind Notulia on develop: never synced");
        const uncommitted = stripMember(
            withState(site, {
                collectedat: NOW,
                deps: [staleDep({ state: "uncommitted", uncommitted: ["a", "b", "c", "d"] })],
            }),
            false,
            NOW
        );
        expect(uncommitted.flagged[0].title).toBe("Synced with Notulia, not committed");
        expect(uncommitted.flagged[0].uncommitted).toEqual(["a", "b", "c"]);
        expect(uncommitted.flagged[0].moreUncommitted).toBe(1);
    });

    it("offers no Sync without a declared sync command", () => {
        const entry = stripMember(
            withState(site, { collectedat: NOW, deps: [staleDep({ sync: undefined })] }),
            false,
            NOW
        );
        expect(entry.flagged[0].sync).toBeNull();
    });

    it("keeps long lists short", () => {
        const commits = Array.from({ length: 8 }, (_, i) => ({ sha: `c${i}`, time: NOW, subject: `s${i}` }));
        const changed = ["a", "b", "c", "d", "e"];
        const entry = stripMember(
            withState(site, { collectedat: NOW, deps: [staleDep({ commits, changed, morecommits: true })] }),
            false,
            NOW
        );
        const flag = entry.flagged[0];
        expect(flag.commits).toHaveLength(5);
        expect(flag.moreCommits).toBe(3);
        expect(flag.moreCommitsCapped).toBe(true);
        expect(flag.paths).toEqual(["a", "b", "c"]);
        expect(flag.morePaths).toBe(2);
    });

    it("writes short times", () => {
        expect(shortAgo(NOW - 10_000, NOW)).toBe("just now");
        expect(shortAgo(NOW - 3 * 3_600_000, NOW)).toBe("3 h ago");
        expect(shortAgo(NOW - 3 * 86_400_000, NOW)).toBe("3 d ago");
    });
});
