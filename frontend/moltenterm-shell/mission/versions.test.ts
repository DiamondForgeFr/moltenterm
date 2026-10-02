// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { RawTag } from "./tree";
import { applyBump, decideBump, nextRc, parseCommit, readableSubject, releaseState } from "./versions";

const c = (subject: string, body?: string) => ({ subject, body });
const tag = (name: string, date: string): RawTag => ({ name, sha: name, date, notes: null, notesInternal: null });
const commit = (subject: string) => ({ sha: subject, date: "2026-09-01T00:00:00Z", subject });

describe("decideBump", () => {
    it("reads the level from conventional commits", () => {
        expect(decideBump("1.2.3", [c("fix(#1): a"), c("feat(#2): b")]).version).toBe("1.3.0");
        expect(decideBump("1.2.3", [c("fix(#1): a")]).version).toBe("1.2.4");
        expect(decideBump("1.2.3", [c("feat(#1)!: a")]).level).toBe("major");
        expect(decideBump("1.2.3", [c("fix: a", "BREAKING CHANGE: gone")]).version).toBe("2.0.0");
    });

    it("refuses to release silent commits", () => {
        expect(decideBump("1.2.3", [c("chore(#1): a"), c("ci: b"), c("docs: c")])).toBeNull();
        expect(decideBump("1.2.3", [])).toBeNull();
    });

    it("counts commits outside the convention without guessing", () => {
        const decision = decideBump("1.0.0", [c("Merge branch x"), c("fix: y")]);
        expect(decision.counts["(unconventional)"]).toBe(1);
        expect(parseCommit(c("Merge branch x"))).toBeNull();
    });

    it("bumps versions", () => {
        expect(applyBump("0.9.9", "major")).toBe("1.0.0");
        expect(() => applyBump("v1", "patch")).toThrow();
    });
});

describe("releaseState", () => {
    it("the first public release is a decision", () => {
        const state = releaseState([tag("v1.0.0-6", "2026-09-20T00:00:00Z")], [], []);
        expect(state.next).toMatchObject({ version: "1.0.0", how: "decision" });
        expect(state.lastRc.name).toBe("v1.0.0-6");
        expect(state.lastPublic).toBeNull();
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

    it("says when there is nothing to release", () => {
        const state = releaseState([tag("v1.0.0", "2026-09-01T00:00:00Z")], [], [commit("chore: x")]);
        expect(state.next.how).toBe("nothing");
    });
});

describe("helpers", () => {
    it("reads a subject's ticket", () => {
        expect(readableSubject("feat(#31): panels")).toEqual({ ticket: "31", text: "panels" });
        expect(readableSubject("Merge pull request")).toEqual({ ticket: null, text: "Merge pull request" });
    });

    it("numbers the next release candidate", () => {
        expect(nextRc("1.1.0", ["v1.1.0-1", "v1.1.0-3", "v1.0.0-9", "v1.1.0"])).toBe(4);
        expect(nextRc("2.0.0", [])).toBe(1);
    });
});
