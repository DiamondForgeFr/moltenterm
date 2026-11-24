// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The ribbon's end shapes (FR-SHELL-159, #2519): fifteen ways to cut the ribbon's right end, one per context, so two
// ribbons that look alike in colour still read apart. A context stores the id of its shape; the drawing is a clip-path
// the ribbon's shape layer applies (--ribbon-clip), cut on a layer of its own so the focus ring and the dot are never
// clipped. The rules apart from the drawing: a new context draws a random shape among the free ones, a context stored
// before shapes existed gets one once (the first keeps the V point), and past fifteen contexts the shapes repeat but
// two contexts of the same colour never wear the same one.

import { normaliseColourChoice } from "../accent";
import type { ContextInfo } from "./context-model";

// The notch's depth: --mt-ribbon-notch (ribbon.css), which the fixed offsets below were drawn against.
const Back = "calc(100% - var(--mt-ribbon-notch, 8px))";
const Behind = (px: number) => `calc(100% - ${px}px)`;

export type RibbonShape = {
    // must match pkg/molten/contexts/contexts.go (ShapeIds)
    id: string;
    nameKey: string;
    clip: string;
};

export const RibbonShapes: readonly RibbonShape[] = [
    { id: "v", nameKey: "contexts.shape.v", clip: `polygon(0 0, 100% 0, ${Back} 50%, 100% 100%, 0 100%)` },
    {
        id: "swallowtail",
        nameKey: "contexts.shape.swallowtail",
        clip: `polygon(0 0, 100% 0, ${Back} 30%, 100% 50%, ${Back} 70%, 100% 100%, 0 100%)`,
    },
    { id: "arrow", nameKey: "contexts.shape.arrow", clip: `polygon(0 0, ${Back} 0, 100% 50%, ${Back} 100%, 0 100%)` },
    { id: "bevel", nameKey: "contexts.shape.bevel", clip: `polygon(0 0, 100% 0, ${Back} 100%, 0 100%)` },
    {
        id: "bevel-reversed",
        nameKey: "contexts.shape.bevelReversed",
        clip: `polygon(0 0, ${Back} 0, 100% 100%, 0 100%)`,
    },
    { id: "round", nameKey: "contexts.shape.round", clip: "inset(0 0 0 0 round 0 11px 11px 0)" },
    {
        id: "step",
        nameKey: "contexts.shape.step",
        clip: `polygon(0 0, 100% 0, 100% 50%, ${Back} 50%, ${Back} 100%, 0 100%)`,
    },
    {
        id: "step-reversed",
        nameKey: "contexts.shape.stepReversed",
        clip: `polygon(0 0, ${Back} 0, ${Back} 50%, 100% 50%, 100% 100%, 0 100%)`,
    },
    {
        id: "saw",
        nameKey: "contexts.shape.saw",
        clip: `polygon(0 0, 100% 0, ${Back} 17%, 100% 33%, ${Back} 50%, 100% 67%, ${Back} 83%, 100% 100%, 0 100%)`,
    },
    {
        id: "split",
        nameKey: "contexts.shape.split",
        clip: `polygon(0 0, ${Behind(6)} 0, 100% 35%, ${Behind(5)} 50%, 100% 65%, ${Behind(6)} 100%, 0 100%)`,
    },
    {
        id: "tenon",
        nameKey: "contexts.shape.tenon",
        clip: `polygon(0 0, ${Back} 0, ${Back} 30%, 100% 30%, 100% 70%, ${Back} 70%, ${Back} 100%, 0 100%)`,
    },
    {
        id: "mortise",
        nameKey: "contexts.shape.mortise",
        clip: `polygon(0 0, 100% 0, 100% 30%, ${Back} 30%, ${Back} 70%, 100% 70%, 100% 100%, 0 100%)`,
    },
    { id: "blade", nameKey: "contexts.shape.blade", clip: `polygon(0 0, 100% 35%, ${Back} 100%, 0 100%)` },
    {
        id: "moon",
        nameKey: "contexts.shape.moon",
        clip: `polygon(0 0, 100% 0, ${Behind(4)} 15%, ${Behind(7)} 33%, ${Back} 50%, ${Behind(7)} 67%, ${Behind(4)} 85%, 100% 100%, 0 100%)`,
    },
    {
        id: "facet",
        nameKey: "contexts.shape.facet",
        clip: `polygon(0 0, ${Back} 0, 100% 30%, 100% 70%, ${Back} 100%, 0 100%)`,
    },
];

export const ShapeIds: readonly string[] = RibbonShapes.map((s) => s.id);

// The shape of a context stored before shapes existed, and of the only context until a second one is made.
export const DefaultShapeId = "v";

export function isShapeId(id: string): boolean {
    return ShapeIds.includes(id);
}

export function ribbonShape(id: string): RibbonShape {
    return RibbonShapes.find((s) => s.id === id) ?? RibbonShapes[0];
}

// What a context wears: its own shape, else the V point for the first context (the one that keeps it at the migration);
// null for another context that has none yet.
export function contextShapeId(context: ContextInfo, index: number): string {
    if (isShapeId(context?.shape ?? "")) {
        return context.shape;
    }
    return index === 0 ? DefaultShapeId : null;
}

// What a ribbon draws: the shape worn, the V point while the migration has not given this context one.
export function shownShapeId(context: ContextInfo, index: number): string {
    return contextShapeId(context, index) ?? DefaultShapeId;
}

// A shape worn by a context, and the colour that context's ribbon has.
export type ShapeUse = { shape: string; colour: string };

function colourKey(choice: string): string {
    return normaliseColourChoice(choice ?? "") || (choice ?? "").trim().toLowerCase();
}

// A shape for a context of this colour, drawn at random. Among the shapes no other context wears when there are any;
// past fifteen contexts, among the least worn, never one worn by a context of the same colour while another is left.
export function drawShape(used: readonly ShapeUse[], colour: string, random: () => number = Math.random): string {
    const worn = new Map<string, number>();
    for (const use of used) {
        worn.set(use.shape, (worn.get(use.shape) ?? 0) + 1);
    }
    let pool = ShapeIds.filter((id) => !worn.has(id));
    if (pool.length === 0) {
        const sameColour = new Set(used.filter((u) => colourKey(u.colour) === colourKey(colour)).map((u) => u.shape));
        const apart = ShapeIds.filter((id) => !sameColour.has(id));
        const candidates = apart.length > 0 ? apart : ShapeIds;
        const fewest = Math.min(...candidates.map((id) => worn.get(id) ?? 0));
        pool = candidates.filter((id) => (worn.get(id) ?? 0) === fewest);
    }
    return pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))];
}

export type ShapeSubject = { context: ContextInfo; colour: string };

// The shapes the contexts that have none are given, once (the migration of contexts stored before shapes existed): the
// first context keeps the V point when no other holds it, the others draw one after the other so no two are alike.
// Nothing for a list that holds a single context: it draws the V point as it is, with nothing written.
export function shapesToAssign(subjects: readonly ShapeSubject[], random: () => number = Math.random): Record<string, string> {
    const assigned: Record<string, string> = {};
    if (subjects.length < 2) {
        return assigned;
    }
    const used: ShapeUse[] = [];
    for (const s of subjects) {
        if (isShapeId(s.context.shape ?? "")) {
            used.push({ shape: s.context.shape, colour: s.colour });
        }
    }
    subjects.forEach((s, i) => {
        if (isShapeId(s.context.shape ?? "")) {
            return;
        }
        const keepsV = i === 0 && !used.some((u) => u.shape === DefaultShapeId);
        const shape = keepsV ? DefaultShapeId : drawShape(used, s.colour, random);
        assigned[s.context.id] = shape;
        used.push({ shape, colour: s.colour });
    });
    return assigned;
}

// The shapes the contexts wear now, for a new context's draw and the picker: the implicit V point of the first context
// counts as worn.
export function shapesInUse(subjects: readonly ShapeSubject[], except = ""): ShapeUse[] {
    const used: ShapeUse[] = [];
    subjects.forEach((s, i) => {
        if (s.context.id === except) {
            return;
        }
        const shape = contextShapeId(s.context, i);
        if (shape != null) {
            used.push({ shape, colour: s.colour });
        }
    });
    return used;
}
