// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { readCompanionPrefs } from "./companion-files-model";
import {
    CompanionSectionIds,
    DefaultCompanionLayout,
    defaultWorkBand,
    isDefaultLayout,
    normalizeLayout,
    readStoredLayout,
    sameLayout,
    sectionBands,
    SectionPlacement,
} from "./companion-layout";

const all = () => true;

describe("the companion's sections (#2392, ready for #2395)", () => {
    it("registers each section once under a stable id", () => {
        expect([...CompanionSectionIds]).toEqual([
            "usage",
            "tasks",
            "agents",
            "permission",
            "topics",
            "answer",
            "task",
            "files",
        ]);
        expect(DefaultCompanionLayout.map((p) => p.id).sort()).toEqual([...CompanionSectionIds].sort());
    });

    it("puts the Tasks block first, on the left, the agents at work on the right, the rest full width", () => {
        expect(sectionBands(DefaultCompanionLayout, all)).toEqual([
            { kind: "full", id: "usage" },
            { kind: "columns", ids: ["tasks", "agents"], left: ["tasks"], right: ["agents"] },
            { kind: "full", id: "permission" },
            { kind: "full", id: "topics" },
            { kind: "full", id: "answer" },
            { kind: "full", id: "task" },
            { kind: "full", id: "files" },
        ]);
        expect(defaultWorkBand()).toEqual({
            kind: "columns",
            ids: ["tasks", "agents"],
            left: ["tasks"],
            right: ["agents"],
        });
    });

    it("leaves out the hidden sections and those with nothing to show", () => {
        const layout: SectionPlacement[] = DefaultCompanionLayout.map((p) =>
            p.id === "topics" ? { ...p, hidden: true } : p
        );
        const bands = sectionBands(layout, (id) => id !== "usage");
        expect(bands.map((b) => (b.kind === "full" ? b.id : b.ids.join("+")))).toEqual([
            "tasks+agents",
            "permission",
            "answer",
            "task",
            "files",
        ]);
    });

    it("keeps a layout usable: unknown ids and columns dropped, each section once, forgotten ones at their default", () => {
        const layout = normalizeLayout([
            { id: "files", column: "left" },
            { id: "nope" as never, column: "full" },
            { id: "files", column: "right" },
            { id: "agents", column: "middle" as never },
            { id: "tasks", column: "right", hidden: true },
        ]);
        expect(layout.slice(0, 2)).toEqual([
            { id: "files", column: "left" },
            { id: "tasks", column: "right", hidden: true },
        ]);
        expect(layout.map((p) => p.id).sort()).toEqual([...CompanionSectionIds].sort());
        expect(layout.find((p) => p.id === "agents")).toEqual({ id: "agents", column: "right" });
    });
});

describe("the developer's own layout (#2395)", () => {
    const own: SectionPlacement[] = [
        { id: "files", column: "full" },
        { id: "answer", column: "left", hidden: true },
        { id: "tasks", column: "left" },
        { id: "permission", column: "right" },
        { id: "agents", column: "right" },
        { id: "usage", column: "full" },
        { id: "topics", column: "full" },
        { id: "task", column: "full" },
    ];

    it("reads a stored layout, and none as the defaults", () => {
        expect(readStoredLayout(undefined)).toBeNull();
        expect(readStoredLayout(null)).toBeNull();
        expect(readStoredLayout([])).toBeNull();
        expect(readStoredLayout("files,answer")).toBeNull();
        expect(readStoredLayout({ id: "files", column: "full" })).toBeNull();
        expect(readStoredLayout(own)).toEqual(own);
    });

    it("keeps a stored layout usable when sections were added or removed since it was saved", () => {
        const stored = readStoredLayout([
            { id: "files", column: "full" },
            { id: "retired", column: "full" },
            { id: "tasks", column: "left" },
        ]);
        expect(stored.slice(0, 2).map((p) => p.id)).toEqual(["files", "tasks"]);
        expect(stored.map((p) => p.id).sort()).toEqual([...CompanionSectionIds].sort());
        expect(stored.find((p) => p.id === "agents")).toEqual({ id: "agents", column: "right" });
    });

    it("compares layouts by order, column and visibility, never by how they were written", () => {
        expect(
            sameLayout(
                own,
                own.map((p) => ({ ...p }))
            )
        ).toBe(true);
        expect(sameLayout(own, [...own].reverse())).toBe(false);
        expect(
            sameLayout(
                own,
                own.map((p) => (p.id === "files" ? { ...p, column: "left" } : p))
            )
        ).toBe(false);
        expect(
            sameLayout(
                own,
                own.map((p) => (p.id === "answer" ? { id: p.id, column: p.column } : p))
            )
        ).toBe(false);
        expect(isDefaultLayout(DefaultCompanionLayout)).toBe(true);
        expect(isDefaultLayout(DefaultCompanionLayout.slice(0, 3))).toBe(true);
        expect(isDefaultLayout(own)).toBe(false);
        expect(
            isDefaultLayout(DefaultCompanionLayout.map((p) => (p.id === "files" ? { ...p, hidden: true } : p)))
        ).toBe(false);
    });

    it("keeps the layout among the companion's other remembered choices", () => {
        expect(readCompanionPrefs({ filesopen: true, layout: own }).layout).toEqual(own);
        expect(readCompanionPrefs({ filesopen: true }).layout).toBeUndefined();
        expect(readCompanionPrefs({ layout: "files" }).layout).toBeUndefined();
    });

    it("forms the bands of the layout: the hidden section gone, the columns where they were put", () => {
        const bands = sectionBands(own, (id) => id !== "usage");
        expect(bands.map((b) => (b.kind === "full" ? b.id : `${b.ids.join("+")}`))).toEqual([
            "files",
            "tasks+permission+agents",
            "topics",
            "task",
        ]);
        expect(bands[1]).toEqual({
            kind: "columns",
            ids: ["tasks", "permission", "agents"],
            left: ["tasks"],
            right: ["permission", "agents"],
        });
    });

    // The Tasks block and the agents at work are drawn by the work area, never from a slot: at full width they come as
    // a band of their own, which neither joins the columns around it nor breaks them.
    it("gives the Tasks block and the agents at work a band of their own at full width", () => {
        const layout: SectionPlacement[] = [
            { id: "tasks", column: "full" },
            { id: "topics", column: "left" },
            { id: "answer", column: "right" },
            { id: "agents", column: "full" },
            { id: "files", column: "full" },
        ];
        const present = (id: string) => layout.some((p) => p.id === id);
        expect(sectionBands(layout, present)).toEqual([
            { kind: "columns", ids: ["tasks"], left: ["tasks"], right: [] },
            { kind: "columns", ids: ["topics", "answer"], left: ["topics"], right: ["answer"] },
            { kind: "columns", ids: ["agents"], left: ["agents"], right: [] },
            { kind: "full", id: "files" },
        ]);
    });
});
