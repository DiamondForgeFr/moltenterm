// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
    channelOfTag,
    CommitInput,
    compareVersions,
    decideBump,
    formatVersion,
    lastPublic,
    lastRc,
    nextRc,
    parseBase,
    parseVersion,
    planRelease,
    PlanResult,
    UnconventionalCount,
    VersionRules,
} from "./versions";

// must match the reader in pkg/molten/versions/versions_test.go
type Vectors = {
    order: string[];
    invalid: string[];
    channels: { rules: VersionRules; tag: string; channel: string }[];
    nextrc: { rules: VersionRules; base: string; tags: string[]; rc: number }[];
    lastpublic: { rules: VersionRules; tags: string[]; lastpublic: string; lastrc: string }[];
    bumps: { last: string; commits: CommitInput[]; expect: { level: string; version: string; reason: string } }[];
    plans: {
        name: string;
        rules: VersionRules;
        tags: string[];
        commits: CommitInput[];
        channel: string;
        override: string;
        expect: PlanResult;
    }[];
};

const vectors: Vectors = JSON.parse(
    readFileSync(resolve(__dirname, "../../../pkg/molten/versions/testdata/vectors.json"), "utf8")
);

describe("the vectors shared with pkg/molten/versions", () => {
    it("orders versions as semver", () => {
        vectors.order.forEach((a, i) => {
            const va = parseVersion(a);
            expect(va, a).not.toBeNull();
            expect(formatVersion(va)).toBe(a);
            vectors.order.forEach((b, j) => {
                expect(compareVersions(va, parseVersion(b)), `${a} vs ${b}`).toBe(Math.sign(i - j));
            });
        });
        for (const s of vectors.invalid) {
            expect(parseVersion(s), s).toBeNull();
        }
    });

    it("reads tags", () => {
        for (const c of vectors.channels) {
            expect(channelOfTag(c.rules, c.tag) ?? "", c.tag).toBe(c.channel);
        }
        for (const c of vectors.nextrc) {
            expect(nextRc(c.rules, parseBase(c.base), c.tags)).toBe(c.rc);
        }
        for (const c of vectors.lastpublic) {
            expect(lastPublic(c.rules, c.tags) ?? "").toBe(c.lastpublic);
            expect(lastRc(c.rules, c.tags) ?? "").toBe(c.lastrc);
        }
    });

    it("decides the bump", () => {
        for (const c of vectors.bumps) {
            const got = decideBump(parseBase(c.last), c.commits);
            if (c.expect == null) {
                expect(got).toBeNull();
                continue;
            }
            expect({ level: got?.level, version: got?.version, reason: got?.reason }).toEqual(c.expect);
        }
    });

    for (const c of vectors.plans) {
        it(`plans: ${c.name}`, () => {
            expect(planRelease(c.rules, c.tags, c.commits, c.channel, c.override)).toEqual(c.expect);
        });
    }
});

describe("decideBump", () => {
    it("counts the commits outside the convention", () => {
        const got = decideBump(parseBase("1.0.0"), [{ subject: "Update" }, { subject: "fix: a" }]);
        expect(got.counts).toEqual({ fix: 1, [UnconventionalCount]: 1 });
    });
});
