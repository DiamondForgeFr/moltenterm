// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    firstUnfinishedStep,
    hasOnboardingState,
    isPending,
    isWelcomeDone,
    OnboardingMetaKey,
    pageAfter,
    pageStep,
    panelPage,
    parsePage,
    progressLabel,
    readOnboardingState,
    reopenPage,
    stepStatus,
} from "./onboarding-state";

function meta(value: any): MetaType {
    return { [OnboardingMetaKey]: value } as MetaType;
}

const welcomed = readOnboardingState(meta({ v: 1, startedts: 1, welcomets: 2 }));

describe("reading the record", () => {
    it("reads an absent or malformed record as a run not started", () => {
        for (const m of [null, {}, meta("x"), meta([1]), meta(null)]) {
            const state = readOnboardingState(m);
            expect(state.done).toBe(false);
            expect(isWelcomeDone(state)).toBe(false);
            expect(state.steps).toEqual({});
        }
        expect(hasOnboardingState(meta("x"))).toBe(false);
        expect(hasOnboardingState(meta({ v: 1 }))).toBe(true);
    });

    it("keeps known steps and statuses only", () => {
        const state = readOnboardingState(
            meta({
                steps: { agent: "done", morph: "skipped", project: "maybe", tour: "done" },
                data: { agent: { a: 1 }, x: {} },
            })
        );
        expect(state.steps).toEqual({ agent: "done", morph: "skipped" });
        expect(stepStatus(state, "project")).toBe("todo");
        expect(state.data).toEqual({ agent: { a: 1 } });
    });

    it("tells a run in progress from one done", () => {
        expect(isPending(meta({ v: 1, done: false }))).toBe(true);
        expect(isPending(meta({ v: 1, done: true, by: "existing" }))).toBe(false);
        expect(isPending(null)).toBe(false);
    });
});

describe("pages", () => {
    it("shows the welcome page until it is passed, whatever was requested", () => {
        const fresh = readOnboardingState(meta({ v: 1 }));
        expect(panelPage(fresh, "step:morph")).toBe("welcome");
        expect(panelPage(fresh, "summary")).toBe("welcome");
    });

    it("goes to the requested page once welcomed, else where reopening lands", () => {
        expect(panelPage(welcomed, "step:project")).toBe("step:project");
        expect(panelPage(welcomed, "welcome")).toBe("welcome");
        expect(panelPage(welcomed, "step:tour")).toBe("step:agent");
        expect(panelPage(welcomed, undefined)).toBe("step:agent");
    });

    it("reopens at the first step not done, a skipped step counting as unfinished", () => {
        const state = readOnboardingState(
            meta({ v: 1, welcomets: 2, done: true, steps: { agent: "done", morph: "skipped", project: "done" } })
        );
        expect(firstUnfinishedStep(state)).toBe("morph");
        expect(reopenPage(state)).toBe("step:morph");
        expect(reopenPage(readOnboardingState(meta({ v: 1 })))).toBe("welcome");
    });

    it("reopens on the summary when every step is done", () => {
        const state = readOnboardingState(
            meta({ v: 1, welcomets: 2, steps: { agent: "done", morph: "done", project: "done" } })
        );
        expect(firstUnfinishedStep(state)).toBeNull();
        expect(reopenPage(state)).toBe("summary");
    });

    it("moves forward after a step, past the steps already done", () => {
        const skippedFirst = readOnboardingState(meta({ v: 1, welcomets: 2, steps: { agent: "skipped" } }));
        expect(pageAfter(skippedFirst, "agent")).toBe("step:morph");
        const morphDone = readOnboardingState(meta({ v: 1, welcomets: 2, steps: { agent: "done", morph: "done" } }));
        expect(pageAfter(morphDone, "agent")).toBe("step:project");
        expect(pageAfter(welcomed, "project")).toBe("summary");
        const laterDone = readOnboardingState(meta({ v: 1, welcomets: 2, steps: { project: "done" } }));
        expect(pageAfter(laterDone, "morph")).toBe("summary");
    });

    it("parses pages and labels progress", () => {
        expect(parsePage("summary")).toBe("summary");
        expect(parsePage("step:morph")).toBe("step:morph");
        expect(parsePage("step:nope")).toBeNull();
        expect(parsePage(3)).toBeNull();
        expect(pageStep("step:project")).toBe("project");
        expect(pageStep("summary")).toBeNull();
        expect(progressLabel("step:morph")).toBe("Step 2 of 3");
        expect(progressLabel("welcome")).toBe("Welcome");
        expect(progressLabel("summary")).toBe("All steps");
    });
});
