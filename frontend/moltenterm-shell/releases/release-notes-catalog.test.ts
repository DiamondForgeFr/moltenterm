// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    catalogFromFiles,
    groupBuildChanges,
    groupReleases,
    orderedEntries,
    parseReleaseNotes,
    versionOfNotesFile,
    visibleEntries,
} from "./release-notes-catalog";
import { makeReleaseHistory, ThisBuildKey } from "./release-notes-window";

const files = {
    "/releases/v1.0.0-1.md": "---\ndate: 2026-10-01\n---\n\n## First candidate\n",
    "/releases/v1.0.0-2.md": "## Second candidate\n",
    "/releases/v1.0.0-10.md": "## Tenth candidate\n",
    "/releases/v1.0.0.md": "---\ndate: 2026-10-20\n---\n## The release\n",
    "/releases/v1.1.0-1.md": "## Next line\n",
    "/releases/v1.1.0.md": "---\ndraft: true\n---\n## Not ready\n",
    "/releases/v1.0.0.internal.md": "## engineering record",
    "/releases/v1.0.1.md": "   \n",
    "/releases/README.md": "# Release notes",
};

describe("release notes catalog", () => {
    it("reads the front matter like the release body script", () => {
        expect(parseReleaseNotes("---\ndate: 2026-10-20\ndraft: true\n---\n\n## New\n")).toEqual({
            front: { date: "2026-10-20", draft: "true" },
            body: "## New\n",
        });
        expect(parseReleaseNotes("---\nnever closed\n").front).toEqual({});
    });

    it("names a version file and leaves records and other files out", () => {
        expect(versionOfNotesFile("/releases/v1.0.0-3.md")).toBe("1.0.0-3");
        expect(versionOfNotesFile("/releases/v1.0.0.internal.md")).toBeNull();
        expect(versionOfNotesFile("/releases/README.md")).toBeNull();
        expect(versionOfNotesFile("/releases/v1.0.0-rc.1.md")).toBeNull();
    });

    it("lists versions newest first, without drafts, empty notes or records", () => {
        const entries = catalogFromFiles(files);
        expect(entries.map((e) => e.version)).toEqual(["1.1.0-1", "1.0.0", "1.0.0-10", "1.0.0-2", "1.0.0-1"]);
        expect(entries.find((e) => e.version === "1.0.0")).toEqual({
            version: "1.0.0",
            notes: "## The release",
            prerelease: false,
            date: "2026-10-20",
        });
    });

    it("groups each version with its candidates", () => {
        const groups = groupReleases(catalogFromFiles(files));
        expect(groups.map((g) => [g.base, g.release?.version ?? null, g.candidates.map((c) => c.version)])).toEqual([
            ["1.1.0", null, ["1.1.0-1"]],
            ["1.0.0", "1.0.0", ["1.0.0-10", "1.0.0-2", "1.0.0-1"]],
        ]);
        expect(orderedEntries(groups).map((e) => e.version)).toEqual([
            "1.1.0-1",
            "1.0.0",
            "1.0.0-10",
            "1.0.0-2",
            "1.0.0-1",
        ]);
    });

    it("shows a public build the public versions only", () => {
        const entries = catalogFromFiles(files);
        expect(visibleEntries(entries, "public").map((e) => e.version)).toEqual(["1.0.0"]);
        expect(visibleEntries(entries, "rc")).toHaveLength(5);
        expect(visibleEntries(entries, "gold")).toHaveLength(5);
    });

    it("groups This build's changes as New, Fixed and Other, and only counts internal ones", () => {
        const groups = groupBuildChanges([
            { sha: "a", subject: "feat(#1): a thing" },
            { sha: "b", subject: "fix(#2): a crash" },
            { sha: "c", subject: "perf: faster" },
            { sha: "d", subject: "docs(#3): words" },
            { sha: "e", subject: "Merge something" },
            { sha: "f", subject: "test(#4): assert behaviour, not wall time" },
            { sha: "g", subject: "chore(release): v1.0.0-3 (rc)" },
            { sha: "h", subject: "ci: cache go modules" },
            { sha: "i", subject: "refactor(#5)!: split the model" },
            { sha: "j", subject: "build(#6): bump electron" },
            { sha: "k", subject: "style(#7): spacing" },
            { sha: "l", subject: "wip: something untyped" },
        ]);
        expect(groups.features.map((c) => c.sha)).toEqual(["a"]);
        expect(groups.fixes.map((c) => c.sha)).toEqual(["b", "c"]);
        expect(groups.other.map((c) => c.sha)).toEqual(["e", "l"]);
        expect(groups.internal).toBe(7);
    });
});

describe("release history list", () => {
    const entries = catalogFromFiles(files);

    it("starts a gold with This build, and marks a version not released yet as upcoming", () => {
        const history = makeReleaseHistory(entries, { channel: "gold" }, null);
        expect(history.rows.map((r) => r.key)).toEqual([
            ThisBuildKey,
            "upcoming-1.1.0",
            "1.1.0-1",
            "1.0.0",
            "1.0.0-10",
            "1.0.0-2",
            "1.0.0-1",
        ]);
        expect(history.selectable).not.toContain("upcoming-1.1.0");
    });

    it("lists a public build's versions, and an offered version it has no notes for first", () => {
        const history = makeReleaseHistory(entries, { channel: "public" }, { version: "v1.0.1", notes: "## Fixes" });
        expect(history.rows.map((r) => r.key)).toEqual(["1.0.1", "1.0.0"]);
        const offered = history.rows[0];
        expect(offered.kind === "entry" && offered.offered).toBe(true);
    });
});
