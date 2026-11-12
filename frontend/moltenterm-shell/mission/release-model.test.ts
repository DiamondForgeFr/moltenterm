// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { RawTag } from "./mission-model";
import {
    computedReasonText,
    MaxListedMilestoneIssues,
    milestoneWarning,
    plannedConfirmText,
    plannedRelease,
    preparationSteps,
    releaseBaseOf,
    releaseChoiceTag,
    releaseNote,
    releasePlan,
} from "./release-model";
import { releaseState } from "./versions";

const tag = (name: string, date: string): RawTag => ({ name, date, sha: "c" + name, notes: null, notesInternal: null });

describe("Release menu (FR-MC-015)", () => {
    it("numbers the next candidate after the last one, and asks for the first public number", () => {
        const tags = [tag("v1.0.0-1", "2026-09-01"), tag("v1.0.0-2", "2026-09-10")];
        const plan = releasePlan(
            releaseState(tags, [], []),
            tags.map((t) => t.name)
        );
        expect(plan).toMatchObject({
            rc: "v1.0.0-3",
            publicVersion: "1.0.0",
            publicIsDecision: true,
            reason: "First public release: a choice, not a calculation.",
            prefix: "v",
        });
        expect(releaseChoiceTag(plan, "rc", "")).toBe("v1.0.0-3");
        expect(releaseChoiceTag(plan, "public", "1.0.0")).toBe("v1.0.0");
        expect(releaseChoiceTag(plan, "public", "1.0")).toBeNull();
        expect(releaseChoiceTag(plan, null, "1.0.0")).toBeNull();
    });

    it("numbers the next candidate in the project's format, across a switch (#1155)", () => {
        const tags = [tag("v1.0.1", "2026-09-01"), tag("v1.1.0-1", "2026-09-05"), tag("v1.1.0-2", "2026-09-10")];
        const commits = [{ sha: "a", subject: "feat(#3): a thing" } as any];
        const names = tags.map((t) => t.name);
        const rcdot = { tagprefix: "v", rcformat: "rcdot" };
        const plan = releasePlan(releaseState(tags, [], commits, rcdot), names, rcdot);
        expect(plan.rc).toBe("v1.1.0-rc.3");
        expect(releaseChoiceTag(plan, "rc", "")).toBe("v1.1.0-rc.3");
        expect(releaseChoiceTag(plan, "public", "")).toBeNull();
        expect(releaseBaseOf(rcdot, "v1.1.0-rc.3")).toBe("1.1.0");

        const numeric = { tagprefix: "v" };
        expect(releasePlan(releaseState(tags, [], commits, numeric), names, numeric).rc).toBe("v1.1.0-3");
        const afterRc = [...names, "v1.1.0-rc.3"];
        expect(releasePlan(releaseState(tags, [], commits, numeric), afterRc, numeric).rc).toBe("v1.1.0-rc.4");
    });

    it("derives the next public release from the commits since the last one", () => {
        const tags = [tag("v1.2.0", "2026-09-01")];
        const plan = releasePlan(
            releaseState(tags, [], [{ sha: "a", subject: "feat(#3): a thing" } as any]),
            tags.map((t) => t.name)
        );
        expect(plan.rc).toBe("v1.3.0-1");
        expect(plan.publicVersion).toBe("1.3.0");
        expect(plan.publicIsDecision).toBe(false);
        const nothing = releasePlan(
            releaseState(tags, [], [{ sha: "b", subject: "chore(#4): tidy" } as any]),
            tags.map((t) => t.name)
        );
        expect(nothing.rc).toBeNull();
        expect(nothing.publicVersion).toBeNull();
        expect(nothing.reason).toMatch(/^Nothing a user would see since v1.2.0 /);
    });

    it("says what starts right away", () => {
        const steps = [
            { id: "warm", title: "Warm the cache", phase: "prepare" as const, run: "x" },
            { id: "promote", title: "Promote develop", phase: "prepare" as const, run: "x" },
            { id: "cut", phase: "cut" as const, run: "x" },
        ];
        expect(preparationSteps(steps).map((s) => s.id)).toEqual(["warm", "promote"]);
        expect(
            preparationSteps([
                { id: "a", run: "x" },
                { id: "b", run: "x" },
            ]).map((s) => s.id)
        ).toEqual(["a"]);
        expect(releaseNote(steps)).toBe(
            "The preparation starts right away: Warm the cache, Promote develop. Each next step will wait for your click in the Project view."
        );
        expect(releaseNote([{ id: "cut", phase: "cut", run: "x" }])).toMatch(/^Nothing runs right away/);
    });

    it("numbers releases with the project's tag prefix, even one holding a dash", () => {
        const tags = [
            tag("release-2.0.0", "2026-09-01"),
            tag("release-2.1.0-1", "2026-09-10"),
            tag("v9.9.9", "2026-09-11"),
        ];
        const rules = { tagprefix: "release-" };
        const state = releaseState(tags, [], [{ sha: "a", subject: "fix(#2): a fix" } as any], rules);
        expect(state.lastPublic.name).toBe("release-2.0.0");
        expect(state.lastRc.name).toBe("release-2.1.0-1");
        const plan = releasePlan(
            state,
            tags.map((t) => t.name),
            rules
        );
        expect(plan.rc).toBe("release-2.0.1-1");
        expect(releaseChoiceTag(plan, "public", "2.0.1")).toBe("release-2.0.1");
    });

    it("refuses a first public number below versions.firstpublic", () => {
        const tags = [tag("v0.14.5", "2026-09-01")];
        const rules = { tagprefix: "v", firstpublic: "1.0.0" };
        const plan = releasePlan(
            releaseState(tags, [], [], rules),
            tags.map((t) => t.name),
            rules
        );
        expect(plan.rc).toBe("v1.0.0-1");
        expect(plan.publicVersion).toBe("1.0.0");
        expect(releaseChoiceTag(plan, "public", "0.15.0")).toBeNull();
        expect(releaseChoiceTag(plan, "public", "1.0.0")).toBe("v1.0.0");
        expect(releaseChoiceTag(plan, "public", "")).toBeNull();
    });
});

describe("the milestone a release ships", () => {
    const rules = { tagprefix: "v", firstpublic: "1.0.0" };

    it("reads the public version a tag leads to", () => {
        expect(releaseBaseOf(rules, "v1.0.0-3")).toBe("1.0.0");
        expect(releaseBaseOf(rules, "v1.2.0")).toBe("1.2.0");
        expect(releaseBaseOf(rules, "v0.14.5")).toBeNull();
        expect(releaseBaseOf(rules, null)).toBeNull();
    });

    it("lists open issues as a warning that never blocks", () => {
        const issues = Array.from({ length: MaxListedMilestoneIssues + 2 }, (_, i) => ({
            number: 40 + i,
            title: `Issue ${i}`,
            url: "",
        }));
        const warning = milestoneWarning("1.0.0", { number: 12, title: "1.0.0", url: "", opencount: 8, issues });
        expect(warning.warn).toBe(true);
        expect(warning.text).toContain("8 open issues");
        expect(warning.text).toContain("can still go ahead");
        expect(warning.issues).toHaveLength(MaxListedMilestoneIssues);
        expect(warning.more).toBe(2);
    });

    it("says when nothing is left open, or when there is no milestone", () => {
        const done = milestoneWarning("1.0.0", { number: 12, title: "1.0.0", url: "", opencount: 0, issues: [] });
        expect(done.warn).toBe(false);
        expect(done.text).toContain("no issue left open");
        const none = milestoneWarning("1.1.0", null);
        expect(none.warn).toBe(false);
        expect(none.text).toBe("No open milestone for 1.1.0.");
    });
});

// #2268, synthetic: last tag v1.1.0, milestone v1.1.1 due first with its issues closed, 2 features on develop.
describe("the planned next version comes first in the Release menu (FR-MC-015, #2268)", () => {
    const features = ["feat(#1): a tour", "feat(#2): help pages"].map((subject, i) => ({
        sha: `f${i}`,
        date: "2026-11-05",
        subject,
    }));
    const planOf = (names: string[]) =>
        releasePlan(
            releaseState(
                names.map((n) => tag(n, "2026-11-01")),
                features,
                features
            ),
            names
        );
    const Station = { tag: "v1.1.1", milestonefirst: true, bigger: true };

    it("offers the station's candidate and public release, and asks once because the commits call for more", () => {
        const plan = planOf(["v1.1.0"]);
        expect(plan).toMatchObject({ publicVersion: "1.2.0", rc: "v1.2.0-1", level: "minor" });
        expect(plannedRelease(plan, Station)).toEqual({
            version: "1.1.1",
            tag: "v1.1.1",
            rc: "v1.1.1-1",
            refused: null,
            confirm: true,
        });
        expect(computedReasonText(plan)).toBe("v1.2.0 follows the commits: 2 new features, a minor version.");
        expect(plannedConfirmText(plan, "v1.1.1")).toBe(
            "The commits call for a minor version (v1.2.0): 2 new features. Start v1.1.1 as planned all the same?"
        );
    });

    it("numbers the station's candidate after its existing ones, and does not confirm a bigger planned number", () => {
        const plan = planOf(["v1.1.0", "v1.3.0-1"]);
        expect(plannedRelease(plan, { tag: "v1.3.0", milestonefirst: true, bigger: false })).toMatchObject({
            rc: "v1.3.0-2",
            tag: "v1.3.0",
            confirm: false,
        });
    });

    it("leaves the menu as it was when the station is the computed number, a derived one, or a first release", () => {
        const plan = planOf(["v1.1.0"]);
        expect(plannedRelease(plan, { tag: "v1.2.0", milestonefirst: true })).toBeNull();
        expect(plannedRelease(plan, { tag: "v1.2.0" })).toBeNull();
        expect(plannedRelease(plan, null)).toBeNull();
        expect(plannedRelease(planOf([]), Station)).toBeNull();
        expect(plannedRelease(null, Station)).toBeNull();
    });

    it("does not offer the station's number once it is tagged, and says why", () => {
        const plan = { ...planOf(["v1.1.0"]), tags: ["v1.1.0", "v1.1.1"] };
        expect(plannedRelease(plan, Station)).toEqual({
            version: "1.1.1",
            tag: "v1.1.1",
            rc: null,
            refused: "v1.1.1, the next station, is already tagged: only the computed number is offered.",
            confirm: false,
        });
    });
});
