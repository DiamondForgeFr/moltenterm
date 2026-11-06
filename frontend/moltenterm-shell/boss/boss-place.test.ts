// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { BossBubbleMetaKey } from "./boss-name";
import {
    BubbleMarginPx,
    bubbleMetaValue,
    BubbleSizePx,
    clampRect,
    collapsesWhileTyping,
    DefaultBubbleState,
    DefaultPlace,
    isTypingKey,
    peekStyle,
    pennantRightPx,
    placeStyle,
    placeToRect,
    readBubbleState,
    Rect,
    rectsOverlap,
    rectToPlace,
    sameBubbleState,
} from "./boss-place";

const Area = { width: 1000, height: 700 };

function rect(left: number, top: number, size = BubbleSizePx): Rect {
    return { left, top, width: size, height: size };
}

describe("the bubble's place in the window's meta (FR-BOSS-001, AC2)", () => {
    it("is the bottom right, off the corner, until it is moved", () => {
        expect(readBubbleState(null)).toEqual(DefaultBubbleState);
        expect(readBubbleState({})).toEqual(DefaultBubbleState);
        expect(DefaultPlace.corner).toBe("br");
    });

    it("reads what it wrote", () => {
        const state = { place: { corner: "tl" as const, dx: 30, dy: 40 }, collapsed: true };
        expect(readBubbleState({ [BossBubbleMetaKey]: bubbleMetaValue(state) })).toEqual(state);
    });

    it("takes anything odd for the default", () => {
        expect(readBubbleState({ [BossBubbleMetaKey]: "tl" })).toEqual(DefaultBubbleState);
        const odd = readBubbleState({
            [BossBubbleMetaKey]: { corner: "middle", dx: "far", dy: NaN, collapsed: "yes" },
        });
        expect(odd).toEqual(DefaultBubbleState);
        const wild = readBubbleState({ [BossBubbleMetaKey]: { corner: "bl", dx: -50, dy: 1e9 } });
        expect(wild.place.dx).toBe(0);
        expect(wild.place.dy).toBeLessThanOrEqual(20000);
    });

    it("compares two states by what they hold", () => {
        expect(sameBubbleState(DefaultBubbleState, { ...DefaultBubbleState })).toBe(true);
        expect(sameBubbleState(DefaultBubbleState, { ...DefaultBubbleState, collapsed: true })).toBe(false);
        expect(sameBubbleState(DefaultBubbleState, { ...DefaultBubbleState, place: { ...DefaultPlace, dx: 1 } })).toBe(
            false
        );
    });
});

describe("dragging the bubble anywhere in the window (AC2)", () => {
    it("is kept as an offset from the corner nearest its centre", () => {
        expect(rectToPlace(rect(40, 30), Area)).toEqual({ corner: "tl", dx: 40, dy: 30 });
        expect(rectToPlace(rect(900, 30), Area)).toEqual({ corner: "tr", dx: 1000 - 900 - BubbleSizePx, dy: 30 });
        expect(rectToPlace(rect(40, 600), Area)).toEqual({ corner: "bl", dx: 40, dy: 700 - 600 - BubbleSizePx });
        expect(rectToPlace(rect(900, 600), Area)).toEqual({
            corner: "br",
            dx: 1000 - 900 - BubbleSizePx,
            dy: 700 - 600 - BubbleSizePx,
        });
    });

    it("lands where it was dropped", () => {
        for (const r of [rect(40, 30), rect(900, 30), rect(40, 600), rect(900, 600), rect(480, 330)]) {
            expect(placeToRect(rectToPlace(r, Area), Area)).toEqual(r);
        }
    });

    it("stays in view when the window shrinks (the offset is from the corner)", () => {
        const place = rectToPlace(rect(900, 600), Area);
        const smaller = placeToRect(place, { width: 500, height: 400 });
        expect(smaller.left).toBeGreaterThanOrEqual(BubbleMarginPx);
        expect(smaller.left + smaller.width).toBeLessThanOrEqual(500 - BubbleMarginPx);
        expect(smaller.top + smaller.height).toBeLessThanOrEqual(400 - BubbleMarginPx);
        // The offset is the same from the same corner while it fits.
        expect(smaller.left).toBe(500 - BubbleSizePx - place.dx);
    });

    it("never leaves the frame's margin, nor the area", () => {
        const dragged = clampRect(rect(-200, 5000), Area);
        expect(dragged.left).toBe(BubbleMarginPx);
        expect(dragged.top).toBe(700 - BubbleSizePx - BubbleMarginPx);
        const tiny = clampRect(rect(10, 10), { width: 20, height: 20 });
        expect(tiny.left).toBe(BubbleMarginPx);
        expect(tiny.top).toBe(BubbleMarginPx);
    });

    it("is drawn by CSS anchored to its corner, so a resize needs no measuring", () => {
        const style = placeStyle({ corner: "br", dx: 16, dy: 24 });
        expect(style.right).toBe("max(8px, min(16px, calc(100% - 52px)))");
        expect(style.bottom).toBe("max(8px, min(24px, calc(100% - 52px)))");
        expect(style.left).toBeUndefined();
        expect(style.top).toBeUndefined();
        const topLeft = placeStyle({ corner: "tl", dx: 5, dy: 6 });
        expect(Object.keys(topLeft).sort()).toEqual(["left", "top"]);
    });

    it("puts the peek on the inner side of the bubble's corner", () => {
        const bottom = peekStyle({ corner: "br", dx: 16, dy: 16 });
        expect(Object.keys(bottom).sort()).toEqual(["bottom", "right"]);
        expect(bottom.bottom).toContain("52px");
        const top = peekStyle({ corner: "tl", dx: 16, dy: 16 });
        expect(Object.keys(top).sort()).toEqual(["left", "top"]);
    });
});

describe("overlap and the collapse while typing (AC4)", () => {
    const bubble = rect(900, 600);
    const terminalUnder: Rect = { left: 500, top: 300, width: 500, height: 400 };
    const terminalAway: Rect = { left: 0, top: 0, width: 400, height: 300 };

    it("tells rectangles that share an area from those that only touch", () => {
        expect(rectsOverlap(bubble, terminalUnder)).toBe(true);
        expect(rectsOverlap(bubble, terminalAway)).toBe(false);
        expect(rectsOverlap(rect(0, 0, 10), rect(10, 0, 10))).toBe(false);
        expect(rectsOverlap(rect(0, 0, 10), rect(9, 0, 10))).toBe(true);
    });

    it("counts a letter, Enter or Backspace as typing, not a modifier alone nor an application shortcut", () => {
        for (const key of ["a", "Enter", "Backspace", "ArrowUp", "Tab", "Escape", " "]) {
            expect(isTypingKey({ key }), key).toBe(true);
        }
        for (const key of ["Shift", "Control", "Alt", "Meta", "CapsLock", "AltGraph", ""]) {
            expect(isTypingKey({ key }), key).toBe(false);
        }
        expect(isTypingKey({ key: "k", metaKey: true })).toBe(false);
        expect(isTypingKey({ key: "c", metaKey: false })).toBe(true);
    });

    const base = { enabled: true, manual: false, key: { key: "a" }, bubble, terminal: terminalUnder };

    it("collapses at the first keystroke that reaches a terminal under the bubble", () => {
        expect(collapsesWhileTyping(base)).toBe(true);
    });

    it("leaves the bubble when the terminal lies elsewhere or the key reaches no terminal", () => {
        expect(collapsesWhileTyping({ ...base, terminal: terminalAway })).toBe(false);
        expect(collapsesWhileTyping({ ...base, terminal: null })).toBe(false);
        expect(collapsesWhileTyping({ ...base, bubble: null })).toBe(false);
        expect(collapsesWhileTyping({ ...base, key: { key: "Shift" } })).toBe(false);
    });

    it("never collapses by itself when the setting is off, nor over a manual collapse", () => {
        expect(collapsesWhileTyping({ ...base, enabled: false })).toBe(false);
        expect(collapsesWhileTyping({ ...base, manual: true })).toBe(false);
    });
});

describe("the pennant's place", () => {
    it("is off the corner, and clear of the window controls drawn on the right elsewhere", () => {
        expect(pennantRightPx(true)).toBeLessThan(pennantRightPx(false));
    });
});
