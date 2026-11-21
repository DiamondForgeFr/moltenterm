// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
    handleTarget,
    makeLayoutCommit,
    moveSection,
    moveSectionBy,
    positionOf,
    resetLayout,
    SectionNameKeys,
    setSectionHidden,
    setSectionSpan,
} from "./companion-arrange-model";
import { CompanionLayout, CompanionSectionIds, DefaultCompanionLayout, isDefaultLayout } from "./companion-layout";

const ids = (layout: CompanionLayout) => layout.map((p) => p.id);
const Default = ["permission", "tasks", "agents", "usage", "topics", "answer", "task", "files"];

describe("arranging the companion's sections (#2395, #2441)", () => {
    it("names every registered section, by the title it carries in the companion", () => {
        expect(Object.keys(SectionNameKeys).sort()).toEqual([...CompanionSectionIds].sort());
    });

    it("moves a section to the place it is dropped, the others keeping their order", () => {
        expect(ids(moveSection(DefaultCompanionLayout, 7, 2))).toEqual([
            "permission",
            "tasks",
            "files",
            "agents",
            "usage",
            "topics",
            "answer",
            "task",
        ]);
        expect(ids(moveSection(DefaultCompanionLayout, 0, 7))).toEqual([...Default.slice(1), "permission"]);
        expect(ids(moveSection(DefaultCompanionLayout, 3, 3))).toEqual(Default);
    });

    it("keeps each section's span and visibility when it moves", () => {
        const layout = setSectionHidden(setSectionSpan(DefaultCompanionLayout, "files", "full"), "files", true);
        expect(moveSection(layout, 7, 0)[0]).toEqual({ id: "files", span: "full", hidden: true });
        expect(DefaultCompanionLayout[7]).toEqual({ id: "files", span: "flow" });
    });

    it("never loses or duplicates a section, whatever it is asked", () => {
        for (const [from, to] of [
            [-1, 2],
            [99, 0],
            [2, -5],
            [2, 99],
            [1.5, 3],
            [2, NaN],
        ]) {
            expect(ids(moveSection(DefaultCompanionLayout, from, to)).sort()).toEqual([...CompanionSectionIds].sort());
        }
        expect(ids(moveSection(DefaultCompanionLayout, 2, 99))[7]).toBe("agents");
        expect(ids(moveSection(DefaultCompanionLayout, 99, 0))).toEqual(Default);
    });

    it("moves a section one place up or down, and stays at the ends", () => {
        expect(ids(moveSectionBy(DefaultCompanionLayout, "agents", -1)).slice(0, 3)).toEqual([
            "permission",
            "agents",
            "tasks",
        ]);
        expect(ids(moveSectionBy(DefaultCompanionLayout, "tasks", 1))[2]).toBe("tasks");
        expect(ids(moveSectionBy(DefaultCompanionLayout, "permission", -1))).toEqual(Default);
        expect(ids(moveSectionBy(DefaultCompanionLayout, "files", 1))).toEqual(Default);
    });

    it("shows and hides a section", () => {
        const hidden = setSectionHidden(DefaultCompanionLayout, "tasks", true);
        expect(hidden.find((p) => p.id === "tasks")).toEqual({ id: "tasks", span: "flow", hidden: true });
        const shown = setSectionHidden(hidden, "tasks", false);
        expect(shown.find((p) => p.id === "tasks")).toEqual({ id: "tasks", span: "flow" });
        expect(isDefaultLayout(shown)).toBe(true);
    });

    it("sets a section full width or fluid", () => {
        const wide = setSectionSpan(DefaultCompanionLayout, "topics", "full");
        expect(wide.find((p) => p.id === "topics").span).toBe("full");
        expect(isDefaultLayout(setSectionSpan(wide, "topics", "flow"))).toBe(true);
        expect(setSectionSpan(DefaultCompanionLayout, "permission", "flow")[0]).toEqual({
            id: "permission",
            span: "flow",
        });
    });

    it("ignores an edit to a section it does not know", () => {
        expect(ids(setSectionHidden(DefaultCompanionLayout, "nope" as never, true))).toEqual(Default);
        expect(isDefaultLayout(setSectionSpan(DefaultCompanionLayout, "nope" as never, "full"))).toBe(true);
    });

    it("goes back to the default layout, whatever was arranged", () => {
        const arranged = setSectionHidden(moveSection(DefaultCompanionLayout, 7, 0), "answer", true);
        expect(isDefaultLayout(arranged)).toBe(false);
        expect(isDefaultLayout(resetLayout())).toBe(true);
        expect(resetLayout()).toEqual(DefaultCompanionLayout);
    });

    // Leaving the mode saves, once, and only a change: nothing reorders or writes by itself.
    it("saves the draft when the mode is left, once, and nothing when nothing changed", () => {
        const saved: CompanionLayout[] = [];
        const commit = makeLayoutCommit(DefaultCompanionLayout, (layout) => saved.push(layout));
        expect(commit(DefaultCompanionLayout)).toBe(false);
        expect(commit(moveSection(moveSection(DefaultCompanionLayout, 7, 0), 0, 7))).toBe(false);
        expect(saved).toHaveLength(0);
        const arranged = setSectionHidden(moveSection(DefaultCompanionLayout, 7, 0), "answer", true);
        expect(commit(arranged)).toBe(true);
        expect(commit(arranged)).toBe(false);
        expect(saved).toEqual([arranged]);
        expect(commit(resetLayout())).toBe(true);
        expect(saved).toHaveLength(2);
        expect(isDefaultLayout(saved[1])).toBe(true);
    });

    it("says where a section stands, for its rank and the screen reader", () => {
        expect(positionOf(DefaultCompanionLayout, "tasks")).toEqual({ position: 2, total: 8 });
        expect(positionOf(moveSection(DefaultCompanionLayout, 7, 0), "files")).toEqual({ position: 1, total: 8 });
    });

    it("takes the up and down arrows, Home and End on a handle, and no other key", () => {
        expect(handleTarget("ArrowUp", 3, 8)).toBe(2);
        expect(handleTarget("ArrowDown", 3, 8)).toBe(4);
        expect(handleTarget("ArrowUp", 0, 8)).toBe(0);
        expect(handleTarget("ArrowDown", 7, 8)).toBe(7);
        expect(handleTarget("Home", 5, 8)).toBe(0);
        expect(handleTarget("End", 5, 8)).toBe(7);
        for (const key of ["ArrowLeft", "ArrowRight", "Enter", " ", "Tab", "a", "Escape"]) {
            expect(handleTarget(key, 3, 8)).toBeNull();
        }
    });

    it("lets the keyboard reach any order: every section can be moved to every place", () => {
        for (let from = 0; from < 8; from++) {
            for (let to = 0; to < 8; to++) {
                let layout: CompanionLayout = DefaultCompanionLayout;
                let at = from;
                const id = layout[from].id;
                for (let guard = 0; guard < 20 && at !== to; guard++) {
                    const next = handleTarget(to > at ? "ArrowDown" : "ArrowUp", at, 8);
                    layout = moveSection(layout, at, next);
                    at = next;
                }
                expect(ids(layout)[to]).toBe(id);
            }
        }
    });
});
