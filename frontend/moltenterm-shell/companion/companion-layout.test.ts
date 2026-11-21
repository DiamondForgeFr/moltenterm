// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { readCompanionPrefs } from "./companion-files-model";
import {
    CompanionSectionIds,
    DefaultCompanionLayout,
    isDefaultLayout,
    normalizeLayout,
    readStoredLayout,
    sameLayout,
    SectionPlacement,
} from "./companion-layout";

describe("the companion's sections (#2392, #2441)", () => {
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

    it("puts what the developer acts on first: the permission request across the companion, then the pair", () => {
        expect(DefaultCompanionLayout.map((p) => p.id)).toEqual([
            "permission",
            "tasks",
            "agents",
            "usage",
            "topics",
            "answer",
            "task",
            "files",
        ]);
        expect(DefaultCompanionLayout.filter((p) => p.span === "full").map((p) => p.id)).toEqual(["permission"]);
    });

    it("keeps a layout usable: unknown ids dropped, unknown spans at the default, each section once", () => {
        const layout = normalizeLayout([
            { id: "files", span: "full" },
            { id: "nope" as never, span: "full" },
            { id: "files", span: "flow" },
            { id: "agents", span: "middle" as never },
            { id: "tasks", span: "flow", hidden: true },
        ]);
        expect(layout.slice(0, 3)).toEqual([
            { id: "files", span: "full" },
            { id: "agents", span: "flow" },
            { id: "tasks", span: "flow", hidden: true },
        ]);
        expect(layout.map((p) => p.id).sort()).toEqual([...CompanionSectionIds].sort());
        expect(layout.find((p) => p.id === "permission")).toEqual({ id: "permission", span: "full" });
    });
});

describe("a layout stored by #2395 (left, right and full columns)", () => {
    const old = [
        { id: "files", column: "full" },
        { id: "answer", column: "left", hidden: true },
        { id: "tasks", column: "left" },
        { id: "permission", column: "right" },
        { id: "agents", column: "right" },
        { id: "usage", column: "full" },
        { id: "topics", column: "full" },
        { id: "task", column: "full" },
    ];

    it("keeps its order and its hidden sections, every column becoming the section's default span", () => {
        expect(readStoredLayout(old)).toEqual([
            { id: "files", span: "flow" },
            { id: "answer", span: "flow", hidden: true },
            { id: "tasks", span: "flow" },
            { id: "permission", span: "full" },
            { id: "agents", span: "flow" },
            { id: "usage", span: "flow" },
            { id: "topics", span: "flow" },
            { id: "task", span: "flow" },
        ]);
    });

    it("reads through the companion's remembered choices", () => {
        expect(readCompanionPrefs({ layout: old }).layout[1]).toEqual({ id: "answer", span: "flow", hidden: true });
    });
});

describe("the developer's own layout (#2395, #2441)", () => {
    const own: SectionPlacement[] = [
        { id: "files", span: "full" },
        { id: "answer", span: "flow", hidden: true },
        { id: "tasks", span: "flow" },
        { id: "permission", span: "flow" },
        { id: "agents", span: "flow" },
        { id: "usage", span: "flow" },
        { id: "topics", span: "full" },
        { id: "task", span: "flow" },
    ];

    it("reads a stored layout, and none as the defaults", () => {
        expect(readStoredLayout(undefined)).toBeNull();
        expect(readStoredLayout(null)).toBeNull();
        expect(readStoredLayout([])).toBeNull();
        expect(readStoredLayout("files,answer")).toBeNull();
        expect(readStoredLayout({ id: "files", span: "full" })).toBeNull();
        expect(readStoredLayout(own)).toEqual(own);
    });

    it("keeps a stored layout usable when sections were added or removed since it was saved", () => {
        const stored = readStoredLayout([
            { id: "files", span: "flow" },
            { id: "retired", span: "full" },
            { id: "tasks", span: "flow" },
        ]);
        expect(stored.slice(0, 2).map((p) => p.id)).toEqual(["files", "tasks"]);
        expect(stored.map((p) => p.id).sort()).toEqual([...CompanionSectionIds].sort());
    });

    it("compares layouts by order, span and visibility, never by how they were written", () => {
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
                own.map((p) => (p.id === "files" ? { ...p, span: "flow" } : p))
            )
        ).toBe(false);
        expect(
            sameLayout(
                own,
                own.map((p) => (p.id === "answer" ? { id: p.id, span: p.span } : p))
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
});
