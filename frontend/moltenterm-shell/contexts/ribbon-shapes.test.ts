// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import type { ContextInfo } from "./context-model";
import {
    contextShapeId,
    DefaultShapeId,
    drawShape,
    isShapeId,
    RibbonShapes,
    ShapeIds,
    shapesInUse,
    shapesToAssign,
    shownShapeId,
    type ShapeSubject,
} from "./ribbon-shapes";

const GoSource = readFileSync(new URL("../../../pkg/molten/contexts/contexts.go", import.meta.url), "utf8");
const En = JSON.parse(readFileSync(new URL("../i18n/locales/en.json", import.meta.url), "utf8"));
const Fr = JSON.parse(readFileSync(new URL("../i18n/locales/fr.json", import.meta.url), "utf8"));

// A random source that walks through the pool in order: the nth draw takes the nth fraction.
function sequence(...fractions: number[]): () => number {
    let at = 0;
    return () => fractions[at++ % fractions.length];
}

function subject(id: string, shape: string, colour: string): ShapeSubject {
    return { context: { id, shape }, colour };
}

describe("the fifteen end shapes", () => {
    it("are fifteen, each with its own id, name and cut", () => {
        expect(RibbonShapes).toHaveLength(15);
        expect(new Set(ShapeIds).size).toBe(15);
        expect(new Set(RibbonShapes.map((s) => s.clip)).size).toBe(15);
        expect(new Set(RibbonShapes.map((s) => s.nameKey)).size).toBe(15);
    });

    it("keep the V point first, as the mockup's validated list does", () => {
        expect(ShapeIds).toEqual([
            "v",
            "swallowtail",
            "arrow",
            "bevel",
            "bevel-reversed",
            "round",
            "step",
            "step-reversed",
            "saw",
            "split",
            "tenon",
            "mortise",
            "blade",
            "moon",
            "facet",
        ]);
        expect(DefaultShapeId).toBe("v");
    });

    it("are cut with a clip-path polygon or inset, drawn against the notch", () => {
        for (const shape of RibbonShapes) {
            expect(shape.clip, shape.id).toMatch(/^(polygon|inset)\(/);
            expect(shape.clip, shape.id).not.toMatch(/undefined|NaN/);
        }
        expect(RibbonShapes.filter((s) => s.clip.startsWith("polygon")).every((s) => s.clip.startsWith("polygon(0 0"))).toBe(true);
    });

    it("hold the same ids as the Go twin that validates them", () => {
        const block = /var ShapeIds = \[\]string\{([^}]*)\}/.exec(GoSource)?.[1] ?? "";
        const goIds = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
        expect(goIds).toEqual([...ShapeIds]);
    });

    it("are named in English and in French", () => {
        for (const shape of RibbonShapes) {
            const key = shape.nameKey.replace("contexts.shape.", "");
            expect(En.contexts.shape[key], shape.nameKey).toBeTruthy();
            expect(Fr.contexts.shape[key], shape.nameKey).toBeTruthy();
        }
    });

    it("tell an id from anything else", () => {
        expect(isShapeId("moon")).toBe(true);
        expect(isShapeId("triangle")).toBe(false);
        expect(isShapeId("")).toBe(false);
        expect(isShapeId(undefined)).toBe(false);
    });
});

describe("the shape a context wears", () => {
    it("is its own, else the V point for the first context, else none yet", () => {
        expect(contextShapeId({ id: "a", shape: "moon" }, 3)).toBe("moon");
        expect(contextShapeId({ id: "a" }, 0)).toBe("v");
        expect(contextShapeId({ id: "a" }, 1)).toBeNull();
        expect(contextShapeId({ id: "a", shape: "triangle" }, 1)).toBeNull();
    });

    it("is drawn as the V point while the migration has not reached a context", () => {
        expect(shownShapeId({ id: "a" }, 2)).toBe("v");
        expect(shownShapeId({ id: "a", shape: "blade" }, 2)).toBe("blade");
    });
});

describe("drawing a shape for a new context", () => {
    it("takes a random shape among the ones no other context wears", () => {
        const used = ShapeIds.slice(0, 12).map((shape) => ({ shape, colour: "#58c142" }));
        const free = ShapeIds.slice(12);
        for (const fraction of [0, 0.34, 0.67, 0.999]) {
            expect(free).toContain(drawShape(used, "#58c142", () => fraction));
        }
        expect(drawShape(used, "#58c142", () => 0)).toBe(free[0]);
        expect(drawShape(used, "#58c142", () => 0.999)).toBe(free[free.length - 1]);
    });

    it("reaches every free shape: the draw is random, not the first free one", () => {
        const used = ShapeIds.slice(0, 10).map((shape) => ({ shape, colour: "#58c142" }));
        const seen = new Set<string>();
        for (let i = 0; i < 50; i++) {
            seen.add(drawShape(used, "#58c142", () => i / 50));
        }
        expect([...seen].sort()).toEqual(ShapeIds.slice(10).sort());
    });

    it("draws among all fifteen when nothing is taken, and never outside them", () => {
        for (let i = 0; i < 40; i++) {
            expect(ShapeIds).toContain(drawShape([], "", Math.random));
        }
        expect(drawShape([], "", () => 0)).toBe("v");
        expect(drawShape([], "", () => 0.9999)).toBe("facet");
    });

    it("never goes past the pool, whatever the random source gives", () => {
        const used = ShapeIds.slice(1).map((shape) => ({ shape, colour: "" }));
        expect(drawShape(used, "", () => 1)).toBe("v");
        expect(drawShape(used, "", () => 0)).toBe("v");
    });
});

describe("past fifteen contexts", () => {
    // Fifteen contexts wear every shape; each is a different colour.
    const all = ShapeIds.map((shape, i) => ({ shape, colour: `#${(i + 1).toString(16).padStart(2, "0")}0000` }));

    it("repeats the shapes, the least worn first", () => {
        const sixteen = [...all, { shape: "moon", colour: "#aa0000" }];
        for (let i = 0; i < 20; i++) {
            const drawn = drawShape(sixteen, "#00ff00", () => i / 20);
            expect(drawn).not.toBe("moon");
        }
    });

    it("never gives two contexts of the same colour the same shape", () => {
        const same = "#58c142";
        const used = ShapeIds.map((shape, i) => ({ shape, colour: i < 13 ? same : "#ff0000" }));
        const seen = new Set<string>();
        for (let i = 0; i < 30; i++) {
            seen.add(drawShape(used, same, () => i / 30));
        }
        expect([...seen].sort()).toEqual(["facet", "moon"]);
    });

    it("tells a colour apart whatever its spelling", () => {
        const used = ShapeIds.map((shape, i) => ({ shape, colour: i === 0 ? "#58C142" : "#ff0000" }));
        for (let i = 0; i < 30; i++) {
            expect(drawShape(used, " #58c142 ", () => i / 30)).not.toBe("v");
        }
    });

    it("still draws when every shape is worn by a context of that colour", () => {
        const used = ShapeIds.map((shape) => ({ shape, colour: "#58c142" }));
        expect(ShapeIds).toContain(drawShape(used, "#58c142", () => 0.5));
    });

});

describe("the one-time migration of contexts stored without a shape", () => {
    it("keeps the V point for the first context and draws distinct shapes for the others", () => {
        const list = [subject("a", "", "#58c142"), subject("b", "", "#429dff"), subject("c", "", "#ff5fb8"), subject("d", "", "#ffe900")];
        for (let run = 0; run < 20; run++) {
            const given = shapesToAssign(list, () => Math.random());
            expect(Object.keys(given).sort()).toEqual(["a", "b", "c", "d"]);
            expect(given.a).toBe("v");
            expect(new Set(Object.values(given)).size).toBe(4);
            expect(Object.values(given).every(isShapeId)).toBe(true);
        }
    });

    it("never touches a context that already has a shape, and never draws one of theirs", () => {
        const list = [subject("a", "", ""), subject("b", "arrow", ""), subject("c", "", ""), subject("d", "v", "")];
        for (let run = 0; run < 30; run++) {
            const given = shapesToAssign(list, () => Math.random());
            expect(Object.keys(given).sort()).toEqual(["a", "c"]);
            expect(Object.values(given)).not.toContain("arrow");
            expect(given.a).not.toBe("v");
            expect(given.c).not.toBe(given.a);
        }
    });

    it("draws the first context's shape too when another one already wears the V point", () => {
        const given = shapesToAssign([subject("a", "", ""), subject("b", "v", "")], sequence(0));
        expect(given.a).toBe("swallowtail");
    });

    it("gives nothing when every context has a shape", () => {
        expect(shapesToAssign([subject("a", "v", ""), subject("b", "moon", "")])).toEqual({});
    });

    it("gives nothing to the only context: it draws the V point as it is, with nothing written", () => {
        expect(shapesToAssign([subject("a", "", "")])).toEqual({});
        expect(shapesToAssign([])).toEqual({});
    });

    it("keeps two contexts of the same colour apart past fifteen", () => {
        const list: ShapeSubject[] = Array.from({ length: 20 }, (_, i) => subject(`c${i}`, "", i % 2 === 0 ? "#58c142" : "#429dff"));
        const given = shapesToAssign(list, () => Math.random());
        expect(Object.keys(given)).toHaveLength(20);
        for (const colour of ["#58c142", "#429dff"]) {
            const mine = list.filter((s) => s.colour === colour).map((s) => given[s.context.id]);
            expect(new Set(mine).size).toBe(mine.length);
        }
    });
});

describe("the shapes in use", () => {
    const list: ContextInfo[] = [{ id: "a" }, { id: "b", shape: "arrow" }, { id: "c" }];
    const subjects: ShapeSubject[] = list.map((context) => ({ context, colour: "#fff" }));

    it("counts the first context's implicit V point, and none for the contexts the migration has not reached", () => {
        expect(shapesInUse(subjects).map((u) => u.shape)).toEqual(["v", "arrow"]);
    });

    it("leaves out the context being edited, so its own shape is free to keep", () => {
        expect(shapesInUse(subjects, "b").map((u) => u.shape)).toEqual(["v"]);
        expect(shapesInUse(subjects, "a").map((u) => u.shape)).toEqual(["arrow"]);
    });
});
