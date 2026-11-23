// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
    moveSection,
    setSectionHidden,
    setSectionSpan,
    setSectionUnfolded,
    setUsageMinimal,
} from "./companion-arrange-model";
import { readCompanionPrefs } from "./companion-files-model";
import {
    CompanionSectionIds,
    DefaultCompanionLayout,
    isDefaultLayout,
    isUnfolded,
    normalizeLayout,
    readStoredLayout,
    sameLayout,
    SectionPlacement,
    usageOf,
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

describe("the usage block's minimal form and its attaching (#2450)", () => {
    const usageOfStored = (value: unknown) => readStoredLayout(value).find((p) => p.id === "usage");
    const full = { shown: true, minimal: false, attached: false };

    it("reads a layout saved without them as the full block, standing on its own: the default", () => {
        const before = [
            { id: "usage", span: "flow" },
            { id: "files", span: "full", hidden: true },
        ];
        expect(usageOfStored(before)).toEqual({ id: "usage", span: "flow" });
        expect(usageOf(readStoredLayout(before))).toEqual(full);
        expect(usageOf(DefaultCompanionLayout)).toEqual(full);
        // A layout of #2395, whose placements said a column, reads the same way.
        expect(usageOf(readStoredLayout([{ id: "usage", column: "full" }]))).toEqual(full);
        expect(isDefaultLayout(readStoredLayout(DefaultCompanionLayout.map((p) => ({ ...p }))))).toBe(true);
    });

    it("keeps the two choices as the developer saved them, and a layout round trips whole", () => {
        const saved = [
            { id: "files", span: "full" },
            { id: "usage", span: "full", minimal: true, attached: true },
            { id: "tasks", span: "flow", hidden: true },
        ];
        expect(usageOfStored(saved)).toEqual({ id: "usage", span: "full", minimal: true, attached: true });
        const once = readStoredLayout(saved);
        expect(readStoredLayout(JSON.parse(JSON.stringify(once)))).toEqual(once);
        expect(usageOf(once)).toEqual({ shown: true, minimal: true, attached: true });
        expect(usageOfStored([{ id: "usage", span: "flow", minimal: true }])).toEqual({
            id: "usage",
            span: "flow",
            minimal: true,
        });
        expect(usageOfStored([{ id: "usage", span: "flow", attached: true }])).toEqual({
            id: "usage",
            span: "flow",
            attached: true,
        });
    });

    it("stores only a choice that is true, and only for the usage block", () => {
        expect(usageOfStored([{ id: "usage", span: "flow", minimal: false, attached: "yes" }])).toEqual({
            id: "usage",
            span: "flow",
        });
        const other = readStoredLayout([{ id: "files", span: "flow", minimal: true, attached: true }]);
        expect(other.find((p) => p.id === "files")).toEqual({ id: "files", span: "flow" });
    });

    it("compares layouts by them: a layout that is minimal or attached is no longer the default", () => {
        const minimal = DefaultCompanionLayout.map((p) => (p.id === "usage" ? { ...p, minimal: true } : p));
        const attached = DefaultCompanionLayout.map((p) => (p.id === "usage" ? { ...p, attached: true } : p));
        expect(sameLayout(DefaultCompanionLayout, minimal)).toBe(false);
        expect(sameLayout(DefaultCompanionLayout, attached)).toBe(false);
        expect(sameLayout(minimal, attached)).toBe(false);
        expect(
            sameLayout(
                minimal,
                minimal.map((p) => ({ ...p }))
            )
        ).toBe(true);
        expect(isDefaultLayout(minimal)).toBe(false);
        expect(isDefaultLayout(attached)).toBe(false);
    });

    it("says a hidden usage stands nowhere, attached or not, and keeps the choices for when it shows", () => {
        const hidden = readStoredLayout([{ id: "usage", span: "flow", hidden: true, minimal: true, attached: true }]);
        expect(usageOf(hidden)).toEqual({ shown: false, minimal: true, attached: false });
        expect(hidden.find((p) => p.id === "usage")).toEqual({
            id: "usage",
            span: "flow",
            hidden: true,
            minimal: true,
            attached: true,
        });
    });

    it("keeps them among the companion's other remembered choices", () => {
        const layout = [{ id: "usage", span: "flow", minimal: true, attached: true }];
        expect(readCompanionPrefs({ filesopen: true, layout }).layout.find((p) => p.id === "usage")).toEqual({
            id: "usage",
            span: "flow",
            minimal: true,
            attached: true,
        });
    });
});

describe("the usage rows the developer hid (#2462)", () => {
    const usageOfStored = (value: unknown) => readStoredLayout(value).find((p) => p.id === "usage");

    it("reads a layout saved before them as hiding nothing: the default", () => {
        expect(usageOfStored([{ id: "usage", span: "flow", minimal: true }]).hiddenrows).toBeUndefined();
        expect(isDefaultLayout(readStoredLayout(DefaultCompanionLayout.map((p) => ({ ...p }))))).toBe(true);
    });

    it("keeps the keys hidden per provider, in one canonical order, and a layout round trips whole", () => {
        const saved = [
            {
                id: "usage",
                span: "flow",
                hiddenrows: { kimi: ["month", "session", "month"], claude: ["model:fable"] },
            },
        ];
        const once = readStoredLayout(saved);
        expect(usageOfStored(saved).hiddenrows).toEqual({ claude: ["model:fable"], kimi: ["month", "session"] });
        expect(Object.keys(usageOfStored(saved).hiddenrows)).toEqual(["claude", "kimi"]);
        expect(readStoredLayout(JSON.parse(JSON.stringify(once)))).toEqual(once);
    });

    it("drops what is not a provider's list of keys, an empty list and a key that is no text", () => {
        const stored = (hiddenrows: unknown) => usageOfStored([{ id: "usage", span: "flow", hiddenrows }]);
        expect(stored("week")).toEqual({ id: "usage", span: "flow" });
        expect(stored(["week"])).toEqual({ id: "usage", span: "flow" });
        expect(stored({ kimi: [] })).toEqual({ id: "usage", span: "flow" });
        expect(stored({ kimi: "month", "": ["week"] })).toEqual({ id: "usage", span: "flow" });
        expect(stored({ kimi: ["", 3, null, "month", { id: "week" }], claude: 7 }).hiddenrows).toEqual({
            kimi: ["month"],
        });
    });

    it("bounds what a stored layout can make the app keep", () => {
        const many = Array.from({ length: 80 }, (_, i) => `model:${String(i).padStart(2, "0")}`);
        const long = "x".repeat(200);
        const rows = usageOfStored([{ id: "usage", span: "flow", hiddenrows: { kimi: [...many, long] } }]).hiddenrows;
        expect(rows.kimi).toHaveLength(32);
        expect(rows.kimi).not.toContain(long);
        const providers = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`p${i}`, ["week"]]));
        expect(
            Object.keys(usageOfStored([{ id: "usage", span: "flow", hiddenrows: providers }]).hiddenrows)
        ).toHaveLength(16);
    });

    it("stores them for the usage block alone", () => {
        const other = readStoredLayout([{ id: "files", span: "flow", hiddenrows: { kimi: ["month"] } }]);
        expect(other.find((p) => p.id === "files")).toEqual({ id: "files", span: "flow" });
    });

    it("compares layouts by them, whatever the order the keys came in", () => {
        const hide = (hiddenrows: unknown) =>
            readStoredLayout(
                DefaultCompanionLayout.map((p) => ({ ...p, ...(p.id === "usage" ? { hiddenrows } : {}) }))
            );
        const month = hide({ kimi: ["month"] });
        expect(sameLayout(DefaultCompanionLayout, month)).toBe(false);
        expect(isDefaultLayout(month)).toBe(false);
        expect(sameLayout(month, hide({ kimi: ["session"] }))).toBe(false);
        expect(sameLayout(month, hide({ claude: ["week"] }))).toBe(false);
        expect(
            sameLayout(
                hide({ kimi: ["session", "month"], claude: ["week"] }),
                hide({ claude: ["week"], kimi: ["month", "session"] })
            )
        ).toBe(true);
    });

    it("keeps them among the companion's other remembered choices", () => {
        const layout = [{ id: "usage", span: "flow", hiddenrows: { kimi: ["month"] } }];
        expect(readCompanionPrefs({ filesopen: true, layout }).layout.find((p) => p.id === "usage")).toEqual({
            id: "usage",
            span: "flow",
            hiddenrows: { kimi: ["month"] },
        });
    });
});

describe("the blocks the developer unfolded (#2477)", () => {
    const placement = (value: unknown, id: string) => readStoredLayout(value).find((p) => p.id === id);
    const restart = (layout: unknown) => readStoredLayout(JSON.parse(JSON.stringify(layout)));

    it("reads a layout saved before them as every block capped: the default", () => {
        const before = [
            { id: "files", span: "full" },
            { id: "usage", span: "flow", minimal: true },
        ];
        for (const id of CompanionSectionIds) {
            expect(isUnfolded(readStoredLayout(before), id), id).toBe(false);
            expect(isUnfolded(DefaultCompanionLayout, id), id).toBe(false);
        }
        expect(placement(before, "files")).toEqual({ id: "files", span: "full" });
        // A layout of #2395, whose placements said a column, is capped too.
        expect(isUnfolded(readStoredLayout([{ id: "files", column: "full" }]), "files")).toBe(false);
        expect(isDefaultLayout(readStoredLayout(DefaultCompanionLayout.map((p) => ({ ...p }))))).toBe(true);
    });

    it("keeps the choice per block, any block's, and a layout round trips whole through a restart", () => {
        const saved = [
            { id: "files", span: "flow", unfolded: true },
            { id: "answer", span: "flow", unfolded: true, hidden: true },
            { id: "usage", span: "flow", minimal: true, unfolded: true },
            { id: "permission", span: "full" },
        ];
        const once = readStoredLayout(saved);
        expect(placement(saved, "files")).toEqual({ id: "files", span: "flow", unfolded: true });
        expect(placement(saved, "answer")).toEqual({ id: "answer", span: "flow", hidden: true, unfolded: true });
        expect(placement(saved, "usage")).toEqual({ id: "usage", span: "flow", minimal: true, unfolded: true });
        expect(CompanionSectionIds.filter((id) => isUnfolded(once, id)).sort()).toEqual(["answer", "files", "usage"]);
        expect(restart(once)).toEqual(once);
        expect(restart(restart(once))).toEqual(once);
    });

    it("stores only a choice that is true", () => {
        for (const unfolded of [false, "yes", 1, null, "true"]) {
            expect(placement([{ id: "files", span: "flow", unfolded }], "files")).toEqual({
                id: "files",
                span: "flow",
            });
        }
    });

    it("compares layouts by it: a layout with a block unfolded is no longer the default", () => {
        const files = (unfolded: boolean) =>
            DefaultCompanionLayout.map((p) => (p.id === "files" ? { ...p, unfolded } : p));
        expect(sameLayout(files(true), DefaultCompanionLayout)).toBe(false);
        expect(isDefaultLayout(files(true))).toBe(false);
        expect(sameLayout(files(false), DefaultCompanionLayout)).toBe(true);
        expect(isDefaultLayout(files(false))).toBe(true);
        expect(sameLayout(files(true), files(true))).toBe(true);
    });

    it("unfolds and folds a block with the other blocks and their choices untouched", () => {
        const start = setSectionHidden(setUsageMinimal(DefaultCompanionLayout, true), "answer", true);
        const open = setSectionUnfolded(start, "files", true);
        expect(isUnfolded(open, "files")).toBe(true);
        expect(CompanionSectionIds.filter((id) => isUnfolded(open, id))).toEqual(["files"]);
        expect(usageOf(open).minimal).toBe(true);
        expect(open.find((p) => p.id === "answer").hidden).toBe(true);
        expect(open.map((p) => p.id)).toEqual(start.map((p) => p.id));
        // Folding it again leaves no trace: the layout is the one it was, which is stored as no layout at all.
        const folded = setSectionUnfolded(open, "files", false);
        expect(folded).toEqual(normalizeLayout(start));
        expect(setSectionUnfolded(DefaultCompanionLayout, "files", true)).not.toEqual(DefaultCompanionLayout);
        expect(isDefaultLayout(setSectionUnfolded(DefaultCompanionLayout, "files", false))).toBe(true);
    });

    it("keeps the choice when a block is moved, made wide or hidden, and when the layout is normalised again", () => {
        const open = setSectionUnfolded(DefaultCompanionLayout, "topics", true);
        expect(isUnfolded(moveSection(open, 4, 0), "topics")).toBe(true);
        expect(isUnfolded(setSectionSpan(open, "topics", "full"), "topics")).toBe(true);
        expect(isUnfolded(setSectionHidden(open, "topics", true), "topics")).toBe(true);
        expect(isUnfolded(normalizeLayout(normalizeLayout(open)), "topics")).toBe(true);
    });

    it("keeps it among the companion's other remembered choices", () => {
        const layout = [{ id: "files", span: "flow", unfolded: true }];
        expect(readCompanionPrefs({ filesopen: true, layout }).layout.find((p) => p.id === "files")).toEqual({
            id: "files",
            span: "flow",
            unfolded: true,
        });
    });
});
