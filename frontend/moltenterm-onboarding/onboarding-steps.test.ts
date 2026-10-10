// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { EmptyOnboardingState, pageAfter, panelPage, progressLabel, reopenPage } from "./onboarding-state";
import { findFirstRunStep, FirstRunSteps, ShownFirstRunSteps, ShownStepIds, visibleSteps } from "./onboarding-steps";

const started = { ...EmptyOnboardingState, welcomets: 1 };

describe("first run steps (FR-SHELL-053-AC4)", () => {
    it("leaves the agent step out until #162 detects the agents", () => {
        expect(FirstRunSteps.find((s) => s.id === "agent")?.hidden).toBe(true);
        expect(ShownStepIds).toEqual(["morph", "project"]);
        expect(visibleSteps([{ ...FirstRunSteps[0], hidden: false }]).map((s) => s.id)).toEqual(["agent"]);
        expect(findFirstRunStep("agent")).toBeNull();
    });

    it("gives every shown step a way on: its own primary or the footer's Next", () => {
        for (const step of ShownFirstRunSteps) {
            expect(step.placeholder, step.id).toBe(true);
        }
    });

    it("walks the shown steps only", () => {
        expect(reopenPage(started, ShownStepIds)).toBe("step:morph");
        expect(progressLabel("step:morph", ShownStepIds)).toBe("Step 1 of 2");
        expect(pageAfter(started, "morph", ShownStepIds)).toBe("step:project");
        expect(pageAfter(started, "project", ShownStepIds)).toBe("summary");
        expect(panelPage(started, "step:agent", ShownStepIds)).toBe("step:morph");
    });
});
