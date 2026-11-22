// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
    dropSection,
    handleTarget,
    makeLayoutCommit,
    moveSection,
    moveSectionBy,
    positionOf,
    resetLayout,
    SectionNameKeys,
    setSectionHidden,
    setSectionSpan,
    setUsageAttached,
    setUsageMinimal,
    usageSummaryKey,
} from "./companion-arrange-model";
import {
    CompanionLayout,
    CompanionSectionIds,
    DefaultCompanionLayout,
    isDefaultLayout,
    usageOf,
} from "./companion-layout";

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

    it("gives the usage its minimal form and takes it back, nothing else changing", () => {
        const minimal = setUsageMinimal(DefaultCompanionLayout, true);
        expect(minimal.find((p) => p.id === "usage")).toEqual({ id: "usage", span: "flow", minimal: true });
        expect(ids(minimal)).toEqual(Default);
        expect(usageOf(minimal)).toEqual({ shown: true, minimal: true, attached: false });
        expect(isDefaultLayout(minimal)).toBe(false);
        const full = setUsageMinimal(minimal, false);
        expect(full.find((p) => p.id === "usage")).toEqual({ id: "usage", span: "flow" });
        expect(isDefaultLayout(full)).toBe(true);
        expect(DefaultCompanionLayout.find((p) => p.id === "usage")).toEqual({ id: "usage", span: "flow" });
    });

    it("attaches the usage to the main agent and detaches it, at the rank, size and span it had", () => {
        const arranged = setSectionSpan(
            moveSection(setUsageMinimal(DefaultCompanionLayout, true), 3, 1),
            "usage",
            "full"
        );
        const attached = setUsageAttached(arranged, true);
        expect(usageOf(attached)).toEqual({ shown: true, minimal: true, attached: true });
        // It keeps its place in the list while it stands in the hero, so the day it leaves the hero it comes back to it.
        expect(ids(attached)).toEqual(ids(arranged));
        expect(attached.find((p) => p.id === "usage")).toEqual({
            id: "usage",
            span: "full",
            minimal: true,
            attached: true,
        });
        expect(setUsageAttached(attached, false)).toEqual(arranged);
        expect(positionOf(setUsageAttached(attached, false), "usage")).toEqual({ position: 2, total: 8 });
    });

    it("keeps the choices of the usage when it moves, is hidden and shown, or goes back to the flow", () => {
        const attached = setUsageAttached(setUsageMinimal(DefaultCompanionLayout, true), true);
        const moved = moveSection(attached, 3, 0);
        expect(moved[0]).toEqual({ id: "usage", span: "flow", minimal: true, attached: true });
        const hidden = setSectionHidden(attached, "usage", true);
        expect(usageOf(hidden)).toEqual({ shown: false, minimal: true, attached: false });
        const shown = setSectionHidden(hidden, "usage", false);
        expect(shown).toEqual(attached);
        expect(setSectionSpan(attached, "usage", "full").find((p) => p.id === "usage")).toEqual({
            id: "usage",
            span: "full",
            minimal: true,
            attached: true,
        });
    });

    it("saves an attaching when the mode is left, and nothing for one undone", () => {
        const saved: CompanionLayout[] = [];
        const commit = makeLayoutCommit(DefaultCompanionLayout, (layout) => saved.push(layout));
        const attached = setUsageAttached(DefaultCompanionLayout, true);
        expect(commit(setUsageAttached(attached, false))).toBe(false);
        expect(commit(attached)).toBe(true);
        expect(saved).toEqual([attached]);
        expect(commit(resetLayout())).toBe(true);
        expect(isDefaultLayout(saved[1])).toBe(true);
    });

    it("goes back to the full block standing on its own with the rest of the defaults", () => {
        const arranged = setUsageAttached(setUsageMinimal(DefaultCompanionLayout, true), true);
        expect(isDefaultLayout(arranged)).toBe(false);
        expect(usageOf(resetLayout())).toEqual({ shown: true, minimal: false, attached: false });
    });

    it("puts back a usage block the layout forgot before the choice applies, like any other section", () => {
        const without = DefaultCompanionLayout.filter((p) => p.id !== "usage");
        expect(usageOf(without)).toEqual({ shown: true, minimal: false, attached: false });
        const attached = setUsageAttached(without, true);
        expect(ids(attached).sort()).toEqual([...CompanionSectionIds].sort());
        expect(usageOf(attached)).toEqual({ shown: true, minimal: false, attached: true });
    });

    it("tells in its summary line how the usage is drawn", () => {
        expect(usageSummaryKey({})).toBe("companion.dash.sum.usage");
        expect(usageSummaryKey({ minimal: true })).toBe("companion.dash.sum.usageMinimal");
        expect(usageSummaryKey({ attached: true })).toBe("companion.dash.sum.usageAttached");
        expect(usageSummaryKey({ minimal: true, attached: true })).toBe("companion.dash.sum.usageAttached");
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

describe("dropping a dragged section (#2459)", () => {
    it("sets the rank of the section dropped in the list, the others keeping their order", () => {
        for (let from = 0; from < 8; from++) {
            for (let to = 0; to < 8; to++) {
                const id = DefaultCompanionLayout[from].id;
                const dropped = dropSection(DefaultCompanionLayout, id, { to: "list", index: to });
                expect(dropped).toEqual(moveSection(DefaultCompanionLayout, from, to));
                expect(ids(dropped)[to]).toBe(id);
            }
        }
    });

    it("keeps every choice of the section it moves, and never loses or doubles one", () => {
        const arranged = setUsageMinimal(setSectionSpan(DefaultCompanionLayout, "files", "full"), true);
        const dropped = dropSection(arranged, "files", { to: "list", index: 0 });
        expect(dropped[0]).toEqual({ id: "files", span: "full" });
        expect(dropped.find((p) => p.id === "usage")).toEqual({ id: "usage", span: "flow", minimal: true });
        expect(ids(dropped).sort()).toEqual([...CompanionSectionIds].sort());
    });

    it("attaches the usage dropped on the main agent's block, at the rank it had", () => {
        const arranged = setUsageMinimal(moveSection(DefaultCompanionLayout, 3, 1), true);
        const dropped = dropSection(arranged, "usage", { to: "attach" });
        expect(usageOf(dropped)).toEqual({ shown: true, minimal: true, attached: true });
        expect(ids(dropped)).toEqual(ids(arranged));
        expect(setUsageAttached(dropped, false)).toEqual(arranged);
    });

    it("leaves any other section where it was when it is dropped on the main agent's block", () => {
        for (const id of CompanionSectionIds.filter((s) => s !== "usage")) {
            expect(dropSection(DefaultCompanionLayout, id, { to: "attach" })).toEqual(DefaultCompanionLayout);
        }
    });

    it("detaches the attached usage dragged out into the list, at the rank it is dropped, in the size it was left", () => {
        const attached = setUsageAttached(setUsageMinimal(DefaultCompanionLayout, true), true);
        const dropped = dropSection(attached, "usage", { to: "list", index: 1 });
        expect(usageOf(dropped)).toEqual({ shown: true, minimal: true, attached: false });
        expect(positionOf(dropped, "usage")).toEqual({ position: 2, total: 8 });
        expect(dropped.find((p) => p.id === "usage")).toEqual({ id: "usage", span: "flow", minimal: true });
    });

    it("detaches it even when it is dropped at the rank it already has, since it left the main agent's block", () => {
        const attached = setUsageAttached(DefaultCompanionLayout, true);
        const dropped = dropSection(attached, "usage", { to: "list", index: 3 });
        expect(usageOf(dropped).attached).toBe(false);
        expect(isDefaultLayout(dropped)).toBe(true);
    });

    it("does not attach the usage by moving it in the list, nor detach it when another section moves", () => {
        const dropped = dropSection(DefaultCompanionLayout, "usage", { to: "list", index: 0 });
        expect(usageOf(dropped).attached).toBe(false);
        const attached = setUsageAttached(DefaultCompanionLayout, true);
        expect(usageOf(dropSection(attached, "files", { to: "list", index: 0 })).attached).toBe(true);
    });

    it("keeps the usage's hidden state when a drop attaches it", () => {
        const hidden = setSectionHidden(DefaultCompanionLayout, "usage", true);
        expect(dropSection(hidden, "usage", { to: "attach" }).find((p) => p.id === "usage")).toEqual({
            id: "usage",
            span: "flow",
            hidden: true,
            attached: true,
        });
    });

    it("saves what the drops made when the mode is left", () => {
        const saved: CompanionLayout[] = [];
        const commit = makeLayoutCommit(DefaultCompanionLayout, (layout) => saved.push(layout));
        const afterMove = dropSection(DefaultCompanionLayout, "files", { to: "list", index: 0 });
        const afterAttach = dropSection(afterMove, "usage", { to: "attach" });
        expect(commit(afterAttach)).toBe(true);
        expect(saved).toEqual([afterAttach]);
        expect(ids(saved[0])[0]).toBe("files");
        expect(usageOf(saved[0]).attached).toBe(true);
        expect(commit(dropSection(afterAttach, "usage", { to: "list", index: 3 }))).toBe(true);
        expect(usageOf(saved[1]).attached).toBe(false);
    });
});
