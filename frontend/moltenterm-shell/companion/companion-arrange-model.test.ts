// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
    ColumnChoices,
    handleTarget,
    makeLayoutCommit,
    moveSection,
    moveSectionBy,
    positionOf,
    resetLayout,
    SectionNameKeys,
    setSectionColumn,
    setSectionHidden,
} from "./companion-arrange-model";
import {
    CompanionLayout,
    CompanionSectionIds,
    DefaultCompanionLayout,
    isDefaultLayout,
    sectionBands,
} from "./companion-layout";

const ids = (layout: CompanionLayout) => layout.map((p) => p.id);
const all = () => true;

describe("arranging the companion's sections (#2395)", () => {
    it("names every registered section, by the title it carries in the companion", () => {
        expect(Object.keys(SectionNameKeys).sort()).toEqual([...CompanionSectionIds].sort());
        expect([...ColumnChoices]).toEqual(["full", "left", "right"]);
    });

    it("moves a section to the place it is dropped, the others keeping their order", () => {
        const moved = moveSection(DefaultCompanionLayout, 7, 2);
        expect(ids(moved)).toEqual(["usage", "tasks", "files", "agents", "permission", "topics", "answer", "task"]);
        expect(ids(moveSection(DefaultCompanionLayout, 0, 7))).toEqual([
            "tasks",
            "agents",
            "permission",
            "topics",
            "answer",
            "task",
            "files",
            "usage",
        ]);
        expect(ids(moveSection(DefaultCompanionLayout, 3, 3))).toEqual(ids(DefaultCompanionLayout));
    });

    it("keeps each section's column and visibility when it moves", () => {
        const layout = setSectionHidden(setSectionColumn(DefaultCompanionLayout, "files", "right"), "files", true);
        const moved = moveSection(layout, 7, 0);
        expect(moved[0]).toEqual({ id: "files", column: "right", hidden: true });
        expect(DefaultCompanionLayout[7]).toEqual({ id: "files", column: "full" });
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
        expect(ids(moveSection(DefaultCompanionLayout, 99, 0))).toEqual(ids(DefaultCompanionLayout));
    });

    it("moves a section one place up or down, and stays at the ends", () => {
        expect(ids(moveSectionBy(DefaultCompanionLayout, "agents", -1))).toEqual([
            "usage",
            "agents",
            "tasks",
            "permission",
            "topics",
            "answer",
            "task",
            "files",
        ]);
        expect(ids(moveSectionBy(DefaultCompanionLayout, "tasks", 1))[2]).toBe("tasks");
        expect(ids(moveSectionBy(DefaultCompanionLayout, "usage", -1))).toEqual(ids(DefaultCompanionLayout));
        expect(ids(moveSectionBy(DefaultCompanionLayout, "files", 1))).toEqual(ids(DefaultCompanionLayout));
    });

    it("shows and hides a section, and the hidden one leaves its band", () => {
        const hidden = setSectionHidden(DefaultCompanionLayout, "tasks", true);
        expect(hidden.find((p) => p.id === "tasks")).toEqual({ id: "tasks", column: "left", hidden: true });
        expect(sectionBands(hidden, all)[1]).toEqual({ kind: "columns", ids: ["agents"], left: [], right: ["agents"] });
        const shown = setSectionHidden(hidden, "tasks", false);
        expect(shown.find((p) => p.id === "tasks")).toEqual({ id: "tasks", column: "left" });
        expect(isDefaultLayout(shown)).toBe(true);
    });

    it("puts a section in a column, full width included", () => {
        const left = setSectionColumn(DefaultCompanionLayout, "topics", "left");
        expect(sectionBands(left, all).map((b) => (b.kind === "full" ? b.id : b.ids.join("+")))).toEqual([
            "usage",
            "tasks+agents",
            "permission",
            "topics",
            "answer",
            "task",
            "files",
        ]);
        const together = moveSection(left, 4, 2);
        expect(sectionBands(together, all).map((b) => (b.kind === "full" ? b.id : b.ids.join("+")))[1]).toBe(
            "tasks+topics+agents"
        );
        expect(setSectionColumn(DefaultCompanionLayout, "agents", "full").find((p) => p.id === "agents").column).toBe(
            "full"
        );
        expect(isDefaultLayout(setSectionColumn(left, "topics", "full"))).toBe(true);
    });

    it("ignores an edit to a section it does not know", () => {
        expect(ids(setSectionHidden(DefaultCompanionLayout, "nope" as never, true))).toEqual(
            ids(DefaultCompanionLayout)
        );
        expect(isDefaultLayout(setSectionColumn(DefaultCompanionLayout, "nope" as never, "left"))).toBe(true);
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

    it("says where a section stands, for the screen reader", () => {
        expect(positionOf(DefaultCompanionLayout, "tasks")).toEqual({ position: 2, total: 8 });
        expect(positionOf(moveSection(DefaultCompanionLayout, 7, 0), "files")).toEqual({ position: 1, total: 8 });
    });

    // The handle's keyboard: the drag's twin, with or without Alt.
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
