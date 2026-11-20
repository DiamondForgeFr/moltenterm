// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Where a comment is on the live page (FR-BRW-017 AC25, #2422): the anchors that follow a scroll and a resize, the gestures
// that place a mark, the selectors that name an element and the geometry of the captures. A synthetic page three screens
// tall, no DOM: the overlay reads the same functions with the real page.

import { describe, expect, it } from "vitest";
import {
    anchorOf,
    boxContains,
    boxOfPoints,
    buildSelector,
    cropRegion,
    dragBox,
    fromViewport,
    gestureOf,
    hitMark,
    type NodeFacts,
    pathFractions,
    pathPoints,
    pointBox,
    resolveAnchor,
    scrollTarget,
    simplifyPath,
    sliceOffsets,
    stableName,
    toViewport,
} from "./annotate-anchor";
import { type Box, MaxPathPoints, MinMarkPx, PointMarkPx } from "./annotate-wire";

// A synthetic page three screens tall: a 1000 x 800 viewport, a header, three sections of one screen each.
const Viewport = { w: 1000, h: 800 };

type Layout = { width: number; elements: Record<string, Box> };

function layoutAt(width: number): Layout {
    // A narrower panel makes the text wrap: the sections get taller and the page longer, as a real page reflows.
    const grow = width >= 1000 ? 1 : 1.5;
    const section = (n: number): Box => ({ x: 0, y: 100 + (n - 1) * 800 * grow, w: width, h: 800 * grow });
    return {
        width,
        elements: {
            "#header": { x: 0, y: 0, w: width, h: 100 },
            "#top": section(1),
            "#middle": section(2),
            "#bottom": section(3),
        },
    };
}

const envOf = (layout: Layout) => ({ elementBox: (selector: string) => layout.elements[selector] ?? null });

describe("an anchor on an element of a page three screens tall", () => {
    const wide = layoutAt(1000);
    const place = (selector: string, box: Box, fixed = false) =>
        anchorOf(box, { selector, box: wide.elements[selector] }, fixed, []);

    it("is where it was placed while the page does not change, whatever the scroll", () => {
        const top = place("#top", { x: 120, y: 160, w: 300, h: 80 });
        const middle = place("#middle", { x: 200, y: 1000, w: 400, h: 200 });
        const bottom = place("#bottom", { x: 80, y: 1900, w: 500, h: 120 });
        for (const anchor of [top, middle, bottom]) {
            const { box } = resolveAnchor(anchor, envOf(wide));
            for (const key of ["x", "y", "w", "h"] as const) {
                expect(box[key]).toBeCloseTo(anchor.box[key], 6);
            }
        }
        // The page coordinates do not depend on the scroll; only the viewport's view of them does.
        const scrolled = { x: 0, y: 900 };
        expect(toViewport(middle.box, scrolled)).toEqual({ x: 200, y: 100, w: 400, h: 200 });
        expect(toViewport(top.box, scrolled).y).toBeLessThan(0);
        expect(fromViewport(toViewport(bottom.box, scrolled), scrolled)).toEqual(bottom.box);
    });

    it("stays on its element when the panel is resized and the page reflows", () => {
        const anchor = place("#middle", { x: 200, y: 1000, w: 400, h: 200 });
        const narrow = layoutAt(600);
        const moved = resolveAnchor(anchor, envOf(narrow));
        expect(moved.onElement).toBe(true);
        // The section starts lower (the first one grew) and is narrower: the mark kept its fractions of it.
        const section = narrow.elements["#middle"];
        expect(moved.box.y).toBeCloseTo(section.y + ((1000 - 900) / 800) * section.h);
        expect(moved.box.x).toBeCloseTo(0.2 * 600);
        expect(moved.box.w).toBeCloseTo(0.4 * 600);
        expect(moved.box.h).toBeCloseTo((200 / 800) * section.h);
        expect(boxContains(section, moved.box)).toBe(true);
    });

    it("keeps each of the three comments in its own section after the resize", () => {
        const anchors = {
            "#top": place("#top", { x: 120, y: 160, w: 300, h: 80 }),
            "#middle": place("#middle", { x: 200, y: 1000, w: 400, h: 200 }),
            "#bottom": place("#bottom", { x: 80, y: 1900, w: 500, h: 120 }),
        };
        const narrow = layoutAt(600);
        for (const [selector, anchor] of Object.entries(anchors)) {
            const { box } = resolveAnchor(anchor, envOf(narrow));
            expect(boxContains(narrow.elements[selector], box)).toBe(true);
        }
        const order = Object.values(anchors).map((a) => resolveAnchor(a, envOf(narrow)).box.y);
        expect(order).toEqual([...order].sort((a, b) => a - b));
    });

    it("falls back to its page coordinates when its selector names nothing any more", () => {
        const anchor = place("#middle", { x: 200, y: 1000, w: 400, h: 200 });
        const gone = { elementBox: () => null as Box };
        expect(resolveAnchor(anchor, gone)).toEqual({ box: anchor.box, onElement: false });
        const hidden = { elementBox: () => ({ x: 0, y: 0, w: 0, h: 0 }) };
        expect(resolveAnchor(anchor, hidden).onElement).toBe(false);
    });

    it("has only its page coordinates when no element could be named", () => {
        const anchor = anchorOf({ x: 40, y: 2000, w: 100, h: 60 }, null, false, []);
        expect(anchor.selector).toBe("");
        expect(anchor.rel).toBeNull();
        expect(resolveAnchor(anchor, envOf(layoutAt(600))).box).toEqual({ x: 40, y: 2000, w: 100, h: 60 });
        const unnamed = anchorOf({ x: 1, y: 2, w: 3, h: 4 }, { selector: "", box: wide.elements["#top"] }, false, []);
        expect(unnamed.selector).toBe("");
    });

    it("keeps the size of a point marker when its element is resized, and its centre on the same spot of it", () => {
        const click = pointBox({ x: 500, y: 1400 });
        const anchor = place("#middle", click, true);
        expect(anchor.fixed).toBe(true);
        const narrow = layoutAt(600);
        const moved = resolveAnchor(anchor, envOf(narrow)).box;
        expect([moved.w, moved.h]).toEqual([PointMarkPx, PointMarkPx]);
        const section = narrow.elements["#middle"];
        expect(moved.x + moved.w / 2).toBeCloseTo(section.x + 0.5 * section.w);
        expect(moved.y + moved.h / 2).toBeCloseTo(section.y + ((1400 - 900) / 800) * section.h);
    });

    it("follows an element a script moved: a mark placed on a card goes with the card", () => {
        const card: Box = { x: 100, y: 1200, w: 200, h: 100 };
        const anchor = anchorOf({ ...card }, { selector: ".card", box: card }, false, []);
        const moved = resolveAnchor(anchor, { elementBox: () => ({ x: 340, y: 1500, w: 400, h: 200 }) }).box;
        expect(moved).toEqual({ x: 340, y: 1500, w: 400, h: 200 });
    });

    it("carries a freehand outline with its box, as fractions of it", () => {
        const points = [
            { x: 200, y: 1000 },
            { x: 300, y: 1100 },
            { x: 400, y: 1000 },
        ];
        const box = boxOfPoints(points);
        const anchor = place("#middle", box);
        const withPath = anchorOf(box, { selector: "#middle", box: wide.elements["#middle"] }, false, points);
        expect(anchor.path).toBeNull();
        expect(withPath.path).toEqual([0, 0, 0.5, 1, 1, 0]);
        const narrow = layoutAt(600);
        const resolved = resolveAnchor(withPath, envOf(narrow)).box;
        const drawn = pathPoints(withPath.path, resolved);
        expect(drawn[0]).toEqual({ x: resolved.x, y: resolved.y });
        expect(drawn[1].x).toBeCloseTo(resolved.x + resolved.w / 2);
        expect(drawn[2]).toEqual({ x: resolved.x + resolved.w, y: resolved.y });
    });
});

describe("the gestures that place a mark", () => {
    const Marks = [
        { id: 1, box: { x: 100, y: 100, w: 400, h: 300 } },
        { id: 2, box: { x: 150, y: 150, w: 40, h: 30 } },
    ];
    const hit = (x: number, y: number) => hitMark(Marks, { x, y });

    it("takes a drag shorter than a few pixels, in either direction, for a click", () => {
        expect(dragBox({ x: 10, y: 10 }, { x: 10 + MinMarkPx - 1, y: 300 })).toBeNull();
        expect(dragBox({ x: 10, y: 10 }, { x: 300, y: 10 + MinMarkPx - 1 })).toBeNull();
        expect(dragBox({ x: 400, y: 270 }, { x: 100, y: 120 })).toEqual({ x: 100, y: 120, w: 300, h: 150 });
    });

    it("places a marker with the point tool where it is clicked, and a rectangle with the zone tool when dragged", () => {
        const click = gestureOf("point", { x: 700, y: 900 }, { x: 701, y: 900 }, [], null);
        expect(click).toMatchObject({ kind: "place", mark: "point" });
        expect(click.kind === "place" && click.box.w).toBe(PointMarkPx);
        const drag = gestureOf("zone", { x: 600, y: 800 }, { x: 800, y: 900 }, [], null);
        expect(drag).toEqual({ kind: "place", mark: "zone", box: { x: 600, y: 800, w: 200, h: 100 }, path: [] });
    });

    it("places an outline with the freehand tool, boxed, and nothing for a stroke that stays in place", () => {
        const path = [
            { x: 100, y: 100 },
            { x: 160, y: 140 },
            { x: 220, y: 100 },
        ];
        const g = gestureOf("freehand", path[0], path[2], path, null);
        expect(g).toMatchObject({ kind: "place", mark: "freehand", box: { x: 100, y: 100, w: 120, h: 40 } });
        expect(gestureOf("freehand", path[0], { x: 101, y: 100 }, [path[0], { x: 101, y: 100 }], null).kind).toBe("none");
    });

    it("never places a rectangle with the zone tool for a click, nor an outline with the point tool for a drag", () => {
        expect(gestureOf("zone", { x: 5, y: 5 }, { x: 6, y: 6 }, [], null).kind).toBe("none");
        expect(gestureOf("point", { x: 5, y: 5 }, { x: 400, y: 300 }, [], null).kind).toBe("none");
    });

    it("edits the mark clicked, whatever the tool, the smaller of two on top of each other", () => {
        for (const tool of ["point", "zone", "freehand"] as const) {
            expect(gestureOf(tool, { x: 160, y: 160 }, { x: 161, y: 160 }, [], hit(160, 160))).toEqual({ kind: "edit", id: 2 });
        }
        expect(hit(300, 300)?.id).toBe(1);
        expect(hit(900, 900)).toBeNull();
        // A thin outline stays within reach.
        expect(hit(98, 100)?.id).toBe(1);
    });

    it("draws a mark when dragged, even from inside another one", () => {
        expect(gestureOf("zone", { x: 160, y: 160 }, { x: 400, y: 380 }, [], hit(160, 160)).kind).toBe("place");
    });
});

describe("a freehand outline", () => {
    it("keeps its corners and at most the points a mark holds", () => {
        const corner = simplifyPath([
            { x: 0, y: 0 },
            { x: 50, y: 0.2 },
            { x: 100, y: 0 },
            { x: 100.2, y: 50 },
            { x: 100, y: 100 },
        ]);
        expect(corner).toEqual([
            { x: 0, y: 0 },
            { x: 100, y: 0 },
            { x: 100, y: 100 },
        ]);
        const wavy = Array.from({ length: 2000 }, (_, i) => ({ x: i, y: 30 * Math.sin(i / 7) }));
        const simple = simplifyPath(wavy);
        expect(simple.length).toBeLessThanOrEqual(MaxPathPoints);
        expect(simple[0]).toEqual(wavy[0]);
        expect(simple[simple.length - 1]).toEqual(wavy[wavy.length - 1]);
    });

    it("is written as fractions of its box and read back to the same points", () => {
        const points = [
            { x: 10, y: 20 },
            { x: 60, y: 40 },
            { x: 110, y: 20 },
        ];
        const box = boxOfPoints(points);
        expect(pathPoints(pathFractions(points, box), box)).toEqual(points);
        expect(pathFractions([{ x: 5, y: 5 }], { x: 5, y: 5, w: 0, h: 0 })).toEqual([0, 0]);
    });
});

describe("the capture of a mark at send time", () => {
    const Doc = { w: 1000, h: 2500 };

    it("scrolls so the mark is centred in the viewport, within the page", () => {
        expect(scrollTarget({ x: 100, y: 1200, w: 300, h: 100 }, Viewport, Doc)).toEqual({ x: 0, y: 850 });
        expect(scrollTarget({ x: 100, y: 100, w: 300, h: 100 }, Viewport, Doc)).toEqual({ x: 0, y: 0 });
        expect(scrollTarget({ x: 100, y: 2400, w: 300, h: 60 }, Viewport, Doc).y).toBe(Doc.h - Viewport.h);
    });

    it("scrolls to the top of a mark taller than the viewport", () => {
        expect(scrollTarget({ x: 0, y: 1000, w: 1000, h: 1200 }, Viewport, Doc).y).toBe(952);
    });

    it("takes the region around a mark with a margin, at least a minimum, inside the viewport", () => {
        const min = { w: 360, h: 240 };
        const around = cropRegion({ x: 400, y: 300, w: 200, h: 100 }, Viewport, 120, min);
        expect(around).toEqual({ x: 280, y: 180, w: 440, h: 340 });
        const small = cropRegion({ x: 10, y: 10, w: 20, h: 10 }, Viewport, 10, min);
        expect(small).toEqual({ x: 0, y: 0, w: 360, h: 240 });
        const huge = cropRegion({ x: 0, y: 0, w: 2000, h: 3000 }, Viewport, 120, min);
        expect(huge).toEqual({ x: 0, y: 0, w: 1000, h: 800 });
        for (const box of [{ x: 950, y: 790, w: 100, h: 50 }, { x: -50, y: -40, w: 30, h: 30 }]) {
            const region = cropRegion(box, Viewport, 120, min);
            expect(boxContains({ x: 0, y: 0, ...Viewport }, region)).toBe(true);
        }
    });

    it("slices a page into its screens, the last one flush with the page's end, and none when it is too tall", () => {
        expect(sliceOffsets(2500, 800, 12)).toEqual([0, 800, 1600, 1700]);
        expect(sliceOffsets(800, 800, 12)).toEqual([0]);
        expect(sliceOffsets(300, 800, 12)).toEqual([0]);
        expect(sliceOffsets(9600, 800, 12)).toHaveLength(12);
        expect(sliceOffsets(9700, 800, 12)).toEqual([]);
        expect(sliceOffsets(0, 800, 12)).toEqual([]);
    });
});

// What the selector builder reads of an element: a chain of facts from the element up to the root.
function chain(
    ...levels: Partial<Omit<NodeFacts, "parent">>[]
): { node: NodeFacts; all: Record<string, number> } {
    let parent: NodeFacts = null;
    let node: NodeFacts = null;
    for (const level of levels) {
        node = { tag: "DIV", id: "", testId: "", classes: [], sameTag: 1, indexOfTag: 1, ...level, parent };
        parent = node;
    }
    return { node, all: {} };
}

describe("naming an element with a CSS selector", () => {
    const always = () => true;

    it("is an id when the element has a stable one", () => {
        const { node } = chain({ tag: "HTML" }, { tag: "BODY" }, { tag: "MAIN", id: "app" }, { tag: "H2", id: "pricing-title" });
        expect(buildSelector(node, always)).toBe("#pricing-title");
    });

    it("is a test id before a path", () => {
        const { node } = chain({ tag: "HTML" }, { tag: "BODY" }, { tag: "BUTTON", testId: "buy-now" });
        expect(buildSelector(node, always)).toBe('[data-testid="buy-now"]');
    });

    it("climbs, with the stable classes and the place among same-named siblings, until the path names it alone", () => {
        const { node } = chain(
            { tag: "HTML" },
            { tag: "BODY" },
            { tag: "MAIN", classes: ["page"] },
            { tag: "DIV", classes: ["card", "featured"], sameTag: 3, indexOfTag: 2 },
            { tag: "H2" }
        );
        const names: string[] = [];
        const unique = (selector: string) => {
            names.push(selector);
            return selector.split(">").length >= 3;
        };
        expect(buildSelector(node, unique)).toBe("main.page > div.card.featured:nth-of-type(2) > h2");
        expect(names[0]).toBe("h2");
    });

    it("leaves out the classes and ids a build generated", () => {
        expect(["card", "Hero-title", "btn_primary"].every(stableName)).toBe(true);
        expect(["css-1x2y3z4", "sc-bdVaJa", "a1b2c3d4e5f6", "id-12345", ":r1:", "x".repeat(70), ""].some(stableName)).toBe(false);
        const { node } = chain({ tag: "HTML" }, { tag: "BODY" }, { tag: "P", id: ":r1:", classes: ["css-1x2y3z4", "note"] });
        expect(buildSelector(node, (s) => s === "body > p.note")).toBe("body > p.note");
    });

    it("stops climbing at an id, and says nothing when even that does not name it alone", () => {
        const { node } = chain({ tag: "HTML" }, { tag: "BODY" }, { tag: "SECTION", id: "faq" }, { tag: "LI", sameTag: 4, indexOfTag: 3 });
        expect(buildSelector(node, (s) => s === "#faq > li:nth-of-type(3)")).toBe("#faq > li:nth-of-type(3)");
        expect(buildSelector(node, () => false)).toBe("");
    });

    it("gives no selector for a path longer than a selector may be", () => {
        const levels = Array.from({ length: 7 }, () => ({ tag: "DIV", classes: ["x".repeat(45)] }));
        const { node } = chain(...levels);
        expect(buildSelector(node, () => false)).toBe("");
        expect(buildSelector(node, (s) => s.length > 340)).toBe("");
    });

    it("escapes what a name holds that a selector cannot", () => {
        const { node } = chain({ tag: "HTML" }, { tag: "BODY" }, { tag: "DIV", classes: ["a_b"] });
        expect(buildSelector(node, always, (s) => s.replace(/_/g, "\\_"))).toBe("div.a\\_b");
        expect(buildSelector(chain({ tag: "HTML" }, { tag: "DIV", classes: ["a.b"] }).node, always)).toBe("div");
    });
});
