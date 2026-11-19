// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
    CompanionSectionIds,
    DefaultCompanionLayout,
    defaultWorkBand,
    normalizeLayout,
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
