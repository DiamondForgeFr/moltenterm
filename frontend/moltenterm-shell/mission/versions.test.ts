// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { RawTag } from "./mission-model";
import { readableSubject, releaseState, treeRules } from "./versions";

const tag = (name: string, date: string): RawTag => ({ name, sha: name, date, notes: null, notesInternal: null });
const commit = (subject: string) => ({ sha: subject, date: "2026-09-01T00:00:00Z", subject });

describe("releaseState", () => {
    it("the first public release is a decision", () => {
        const state = releaseState([tag("v1.0.0-6", "2026-09-20T00:00:00Z")], [], []);
        expect(state.next).toMatchObject({ version: "1.0.0", how: "decision" });
        expect(state.lastRc.name).toBe("v1.0.0-6");
        expect(state.lastPublic).toBeNull();
    });

    it("proposes versions.firstpublic, and ignores the tags below it", () => {
        const state = releaseState(
            [tag("v0.14.5", "2026-09-01T00:00:00Z"), tag("v0.14.4-1", "2026-08-01T00:00:00Z")],
            [],
            [],
            treeRules({ tagPrefix: "v", firstPublic: "1.0.0" })
        );
        expect(state.lastPublic).toBeNull();
        expect(state.lastRc).toBeNull();
        expect(state.next).toMatchObject({ version: "1.0.0", how: "decision" });
    });

    it("derives the next public release and splits what is pending", () => {
        const state = releaseState(
            [tag("v1.0.0", "2026-09-01T00:00:00Z"), tag("v1.1.0-1", "2026-09-10T00:00:00Z")],
            [commit("feat(#2): b"), commit("fix(#3): c"), commit("chore: d")],
            [commit("feat(#2): b")]
        );
        expect(state.next).toMatchObject({ version: "1.1.0", how: "derived", level: "minor" });
        expect(state.pending).toMatchObject({ total: 3, other: 1 });
        expect(state.pending.feat).toHaveLength(1);
    });

    it("reads the last releases in semver order, not by date", () => {
        const state = releaseState(
            [
                tag("v1.10.0", "2026-09-01T00:00:00Z"),
                tag("v1.9.0", "2026-09-20T00:00:00Z"),
                tag("v1.11.0-2", "2026-09-02T00:00:00Z"),
                tag("v1.11.0-10", "2026-09-01T00:00:00Z"),
            ],
            [],
            [commit("fix: a")]
        );
        expect(state.lastPublic.name).toBe("v1.10.0");
        expect(state.lastRc.name).toBe("v1.11.0-10");
        expect(state.next.version).toBe("1.10.1");
    });

    it("says when there is nothing to release", () => {
        const state = releaseState([tag("v1.0.0", "2026-09-01T00:00:00Z")], [], [commit("chore: x")]);
        expect(state.next.how).toBe("nothing");
        expect(state.next.version).toBeNull();
    });
});

describe("helpers", () => {
    it("reads a subject's ticket", () => {
        expect(readableSubject("feat(#31): panels")).toEqual({ ticket: "31", text: "panels" });
        expect(readableSubject("Merge pull request")).toEqual({ ticket: null, text: "Merge pull request" });
    });
});
