// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The pour's navigation and records (FR-ONB-007 AC-1, AC-2, AC-9, P-1, P-7, TC-ONB-007), its six scenes since #1709.

import { describe, expect, it } from "vitest";
import {
    heatStates,
    initialPourState,
    isLastScene,
    nextLabelKey,
    offersLater,
    pourKeyAction,
    pourReduce,
    PourSceneCount,
    PourScenes,
    recordOnLeaving,
    sceneIndex,
    sparksAllowed,
} from "./onboarding-pour-model";

describe("the pour's scenes (FR-ONB-007)", () => {
    it("has six scenes, from the welcome to ready", () => {
        expect(PourSceneCount).toBe(6);
        expect([...PourScenes]).toEqual(["pour", "agents", "project", "view", "place", "start"]);
        expect(isLastScene(5)).toBe(true);
        expect(isLastScene(4)).toBe(false);
        expect(nextLabelKey(0)).toBe("onboarding.pour.next.pour");
        expect(nextLabelKey(5)).toBe("onboarding.pour.next.start");
    });

    it("moves on and back, and never past either end", () => {
        let state = initialPourState();
        state = pourReduce(state, { type: "back" });
        expect(state.scene).toBe(0);
        for (let i = 0; i < 9; i++) {
            state = pourReduce(state, { type: "next" });
        }
        expect(state.scene).toBe(5);
        state = pourReduce(state, { type: "back" });
        expect(state.scene).toBe(4);
    });

    it("replays a scene's animations on each visit, not when nothing moves", () => {
        const first = pourReduce(initialPourState(), { type: "next" });
        const back = pourReduce(first, { type: "back" });
        expect(back.visit).toBe(2);
        expect(pourReduce(back, { type: "back" })).toBe(back);
    });

    it("lights the heat bars up to the current scene", () => {
        expect(heatStates(0)).toEqual(["now", "cold", "cold", "cold", "cold", "cold"]);
        expect(heatStates(2)).toEqual(["done", "done", "now", "cold", "cold", "cold"]);
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
        expect(recordOnLeaving(5)).toBeNull();
    });

    it("draws no sparks under reduced motion or a hidden document", () => {
        expect(sparksAllowed(false, false)).toBe(true);
        expect(sparksAllowed(true, false)).toBe(false);
        expect(sparksAllowed(false, true)).toBe(false);
    });
});

describe("Later on the project and the view (P-1)", () => {
    it("is offered on the project and the view only", () => {
        expect(PourScenes.map((_, i) => offersLater(i))).toEqual([false, false, true, true, false, false]);
    });

    it("skips the project to the view, and the view with its place to ready", () => {
        let state = pourReduce(initialPourState(sceneIndex("project")), { type: "laterProject" });
        expect(PourScenes[state.scene]).toBe("view");
        expect(state.projectSkipped).toBe(true);
        expect(state.projectSet).toBeNull();
        state = pourReduce(state, { type: "laterView" });
        expect(PourScenes[state.scene]).toBe("start");
        expect(state.viewSkipped).toBe(true);
        state = pourReduce(state, { type: "back" });
        expect(PourScenes[state.scene]).toBe("view");
        expect(state.viewSkipped).toBe(false);
        state = pourReduce(state, { type: "back" });
        expect(PourScenes[state.scene]).toBe("project");
        expect(state.projectSkipped).toBe(false);
    });
});

describe("the project and view choices (FR-ONB-007 P-4, FR-ONB-009)", () => {
    it("starts on Find my project, git checked, and the view on Scoping pinned everywhere", () => {
        const state = initialPourState();
        expect(state.project).toMatchObject({ mode: "find", git: true });
        expect(state.tools).toEqual(["browser", "files"]);
        expect(state.place).toBe("everywhere");
        expect(state.named).toBe(false);
    });

    it("keeps the project draft and what leaving the scene set", () => {
        let state = pourReduce(initialPourState(2), { type: "project", patch: { mode: "new", name: "atlas" } });
        expect(state.project).toMatchObject({ mode: "new", name: "atlas", git: true });
        state = pourReduce(state, {
            type: "projectSet",
            result: { name: "Atlas", path: "~/Projets/atlas", colour: "#fff" },
        });
        expect(state.projectSet?.name).toBe("Atlas");
    });

    it("lets a preset set the tools and give the name back to the suggestion", () => {
        let state = pourReduce(initialPourState(3), { type: "name", text: "Mine" });
        expect(state.named).toBe(true);
        state = pourReduce(state, { type: "tool", kind: "integration" });
        expect(state.viewName).toBe("Mine");
        state = pourReduce(state, { type: "preset", id: "delivery" });
        expect(state.tools).toEqual(["integration"]);
        expect(state.named).toBe(false);
        expect(pourReduce(state, { type: "name", text: "  " }).named).toBe(false);
    });

    it("keeps one place, everywhere or this workspace", () => {
        const state = pourReduce(initialPourState(4), { type: "place", place: "workspace" });
        expect(state.place).toBe("workspace");
        expect(pourReduce(state, { type: "place", place: "nope" as any }).place).toBe("everywhere");
    });
});
