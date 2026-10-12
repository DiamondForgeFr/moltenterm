// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { EmptyOnboardingState, pageAfter, panelPage, progressLabel, reopenPage } from "./onboarding-state";
import { findFirstRunStep, FirstRunSteps, ShownFirstRunSteps, ShownStepIds, visibleSteps } from "./onboarding-steps";

const started = { ...EmptyOnboardingState, welcomets: 1 };

describe("first run steps (FR-SHELL-053-AC4)", () => {
    it("shows the agent step first, and leaves a hidden step out", () => {
        expect(FirstRunSteps.find((s) => s.id === "agent")?.hidden).toBeFalsy();
        expect(ShownStepIds).toEqual(["agent", "morph", "project"]);
        expect(visibleSteps([{ ...FirstRunSteps[0], hidden: true }, FirstRunSteps[1]]).map((s) => s.id)).toEqual([
            "morph",
        ]);
        expect(findFirstRunStep("agent")?.id).toBe("agent");
    });

    it("gives the agent and morph steps their own primary, the placeholders the footer's Next", () => {
        expect(findFirstRunStep("agent").placeholder).toBeFalsy();
        expect(findFirstRunStep("morph").placeholder).toBeFalsy();
        for (const step of ShownFirstRunSteps.filter((s) => s.id !== "agent" && s.id !== "morph")) {
            expect(step.placeholder, step.id).toBe(true);
        }
    });

    it("walks the shown steps only", () => {
        expect(reopenPage(started, ShownStepIds)).toBe("step:agent");
        expect(progressLabel("step:agent", ShownStepIds)).toBe("Step 1 of 3");
        expect(pageAfter(started, "agent", ShownStepIds)).toBe("step:morph");
        expect(pageAfter(started, "project", ShownStepIds)).toBe("summary");
        expect(panelPage(started, "step:agent", ShownStepIds)).toBe("step:agent");
    });
});
