// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The pour's navigation and records (FR-ONB-007 AC-1, AC-2, AC-9, TC-ONB-007).

import { describe, expect, it } from "vitest";
import {
    heatStates,
    initialPourState,
    isLastScene,
    nextLabelKey,
    pourKeyAction,
    pourReduce,
    PourSceneCount,
    recordOnLeaving,
    sparksAllowed,
} from "./onboarding-pour-model";

describe("the pour's scenes (FR-ONB-007)", () => {
    it("has five scenes, from the pour to the three starts", () => {
        expect(PourSceneCount).toBe(5);
        expect(isLastScene(4)).toBe(true);
        expect(isLastScene(3)).toBe(false);
        expect(nextLabelKey(0)).toBe("onboarding.pour.next.pour");
        expect(nextLabelKey(4)).toBe("onboarding.pour.next.start");
    });

    it("moves on and back, and never past either end", () => {
        let state = initialPourState();
        state = pourReduce(state, { type: "back" });
        expect(state.scene).toBe(0);
        for (let i = 0; i < 7; i++) {
            state = pourReduce(state, { type: "next" });
        }
        expect(state.scene).toBe(4);
        state = pourReduce(state, { type: "back" });
        expect(state.scene).toBe(3);
    });

    it("replays a scene's animations on each visit, not when nothing moves", () => {
        const first = pourReduce(initialPourState(), { type: "next" });
        const back = pourReduce(first, { type: "back" });
        expect(back.visit).toBe(2);
        expect(pourReduce(back, { type: "back" })).toBe(back);
    });

    it("lights the heat bars up to the current scene", () => {
        expect(heatStates(0)).toEqual(["now", "cold", "cold", "cold", "cold"]);
        expect(heatStates(2)).toEqual(["done", "done", "now", "cold", "cold"]);
    });

    it("reads Enter and → as next, ← as back, and leaves buttons, fields and shortcuts alone", () => {
        expect(pourKeyAction("Enter")).toBe("next");
        expect(pourKeyAction("ArrowRight")).toBe("next");
        expect(pourKeyAction("ArrowLeft")).toBe("back");
        expect(pourKeyAction("Enter", { onButton: true })).toBeNull();
        expect(pourKeyAction("ArrowRight", { onButton: true })).toBe("next");
        expect(pourKeyAction("ArrowLeft", { inField: true })).toBeNull();
        expect(pourKeyAction("ArrowRight", { modifier: true })).toBeNull();
        expect(pourKeyAction("Escape")).toBeNull();
    });

    it("keeps one start chosen, project by default", () => {
        let state = initialPourState(4);
        expect(state.start).toBe("project");
        state = pourReduce(state, { type: "choose", start: "morph" });
        expect(state.start).toBe("morph");
        state = pourReduce(state, { type: "choose", start: "nope" as any });
        expect(state.start).toBe("morph");
    });

    it("opens one agent card at a time, and closes it again", () => {
        let state = pourReduce(initialPourState(1), { type: "toggle", card: "kimi" });
        expect(state.open).toBe("kimi");
        state = pourReduce(state, { type: "toggle", card: "deepseek" });
        expect(state.open).toBe("deepseek");
        expect(pourReduce(state, { type: "toggle", card: "deepseek" }).open).toBeNull();
    });

    it("records the welcome when scene 1 is passed and the agent step when scene 2 is", () => {
        expect(recordOnLeaving(0)).toBe("welcome");
        expect(recordOnLeaving(1)).toBe("agents");
        expect(recordOnLeaving(2)).toBeNull();
        expect(recordOnLeaving(4)).toBeNull();
    });

    it("draws no sparks under reduced motion or a hidden document", () => {
        expect(sparksAllowed(false, false)).toBe(true);
        expect(sparksAllowed(true, false)).toBe(false);
        expect(sparksAllowed(false, true)).toBe(false);
    });
});
