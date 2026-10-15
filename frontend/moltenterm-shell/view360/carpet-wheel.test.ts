// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { canScrollX, hasRoomX, horizontalWheelDelta, routeHorizontalWheel, wheelDeltaPx } from "./carpet-wheel";

type FakeOpts = {
    overflowX?: string;
    direction?: string;
    scrollLeft?: number;
    scrollWidth?: number;
    clientWidth?: number;
    classes?: string[];
    slider?: { trackWidth: number; left: number; width: number };
};

// A minimal stand-in for the DOM the routing walks: elements, their computed overflow and scroll metrics.
function fakeDoc() {
    const styles = new Map<any, { overflowX: string; direction: string }>();
    const doc: any = {
        scrollingElement: null,
        defaultView: { getComputedStyle: (el: any) => styles.get(el) },
    };
    const make = (parent: any, opts: FakeOpts = {}): any => {
        const classes = new Set(opts.classes ?? []);
        const el: any = {
            nodeType: 1,
            ownerDocument: doc,
            parentElement: parent,
            scrollLeft: opts.scrollLeft ?? 0,
            scrollWidth: opts.scrollWidth ?? 100,
            clientWidth: opts.clientWidth ?? 100,
            classList: { contains: (c: string) => classes.has(c) },
            querySelector: () => null,
        };
        if (opts.slider != null) {
            const slider = { offsetLeft: opts.slider.left, offsetWidth: opts.slider.width };
            const track = { clientWidth: opts.slider.trackWidth, querySelector: () => slider };
            el.querySelector = (sel: string) => (sel.includes("scrollbar.horizontal") ? track : null);
        }
        styles.set(el, { overflowX: opts.overflowX ?? "visible", direction: opts.direction ?? "ltr" });
        return el;
    };
    return { doc, make };
}

describe("horizontalWheelDelta", () => {
    it("takes a horizontal gesture's deltaX", () => {
        expect(horizontalWheelDelta({ deltaX: 30, deltaY: 4, shiftKey: false })).toBe(30);
        expect(horizontalWheelDelta({ deltaX: -30, deltaY: 4, shiftKey: false })).toBe(-30);
    });

    it("leaves a vertical gesture to the panel", () => {
        expect(horizontalWheelDelta({ deltaX: 4, deltaY: 30, shiftKey: false })).toBeNull();
        expect(horizontalWheelDelta({ deltaX: 0, deltaY: 0, shiftKey: false })).toBeNull();
    });

    it("turns Shift + a vertical wheel sideways", () => {
        expect(horizontalWheelDelta({ deltaX: 0, deltaY: 40, shiftKey: true })).toBe(40);
        expect(horizontalWheelDelta({ deltaX: 0, deltaY: 0, shiftKey: true })).toBeNull();
    });

    it("converts lines and pages to pixels", () => {
        expect(wheelDeltaPx(3, 0, 800)).toBe(3);
        expect(wheelDeltaPx(3, 1, 800)).toBe(48);
        expect(wheelDeltaPx(1, 2, 800)).toBe(800);
    });
});

describe("routeHorizontalWheel", () => {
    it("gives an unfocused panel's scroll to the carpet, whatever the panel could scroll", () => {
        expect(routeHorizontalWheel(false, true)).toBe("carpet");
        expect(routeHorizontalWheel(false, false)).toBe("carpet");
    });

    it("lets a focused panel keep a scroll it can still make", () => {
        expect(routeHorizontalWheel(true, true)).toBe("panel");
    });

    it("hands a focused panel's scroll to the carpet at its edge or when nothing scrolls", () => {
        expect(routeHorizontalWheel(true, false)).toBe("carpet");
    });
});

describe("hasRoomX", () => {
    it("knows both edges of a left-to-right scroller", () => {
        expect(hasRoomX(0, 300, 100, false, 10)).toBe(true);
        expect(hasRoomX(0, 300, 100, false, -10)).toBe(false);
        expect(hasRoomX(200, 300, 100, false, 10)).toBe(false);
        expect(hasRoomX(200, 300, 100, false, -10)).toBe(true);
    });

    it("knows both edges of a right-to-left scroller", () => {
        expect(hasRoomX(0, 300, 100, true, 10)).toBe(false);
        expect(hasRoomX(0, 300, 100, true, -10)).toBe(true);
        expect(hasRoomX(-200, 300, 100, true, -10)).toBe(false);
        expect(hasRoomX(-200, 300, 100, true, 10)).toBe(true);
    });

    it("finds no room in a box that does not overflow", () => {
        expect(hasRoomX(0, 100, 100, false, 10)).toBe(false);
        expect(hasRoomX(0, 101, 100, false, 10)).toBe(false);
    });
});

describe("canScrollX", () => {
    it("finds a scrolling ancestor with room in the gesture's direction", () => {
        const { make } = fakeDoc();
        const block = make(null);
        const scroller = make(block, { overflowX: "auto", scrollWidth: 400, clientWidth: 100 });
        const target = make(scroller);
        expect(canScrollX(target, 10, block)).toBe(true);
        expect(canScrollX(target, -10, block)).toBe(false);
        scroller.scrollLeft = 300;
        expect(canScrollX(target, 10, block)).toBe(false);
        expect(canScrollX(target, -10, block)).toBe(true);
    });

    it("ignores overflow a box hides, and stops at the panel", () => {
        const { make } = fakeDoc();
        const outer = make(null, { overflowX: "auto", scrollWidth: 400, clientWidth: 100 });
        const block = make(outer);
        const hidden = make(block, { overflowX: "hidden", scrollWidth: 400, clientWidth: 100 });
        const target = make(hidden);
        expect(canScrollX(target, 10, block)).toBe(false);
        expect(canScrollX(target, 10)).toBe(true);
    });

    it("counts the page's own scroller unless the page hides its horizontal overflow", () => {
        const { doc, make } = fakeDoc();
        const html = make(null, { overflowX: "visible", scrollWidth: 4000, clientWidth: 800 });
        doc.scrollingElement = html;
        const target = make(make(html));
        expect(canScrollX(target, 10)).toBe(true);
        expect(canScrollX(target, -10)).toBe(false);
        const { doc: doc2, make: make2 } = fakeDoc();
        const clipped = make2(null, { overflowX: "hidden", scrollWidth: 4000, clientWidth: 800 });
        doc2.scrollingElement = clipped;
        expect(canScrollX(make2(clipped), 10)).toBe(false);
    });

    it("reads a code editor's own horizontal scrollbar", () => {
        const { make } = fakeDoc();
        const block = make(null);
        const editor = make(block, {
            overflowX: "hidden",
            classes: ["monaco-scrollable-element"],
            slider: { trackWidth: 500, left: 0, width: 100 },
        });
        const target = make(editor);
        expect(canScrollX(target, 10, block)).toBe(true);
        expect(canScrollX(target, -10, block)).toBe(false);
        const atEnd = make(block, {
            classes: ["monaco-scrollable-element"],
            slider: { trackWidth: 500, left: 400, width: 100 },
        });
        expect(canScrollX(make(atEnd), 10, block)).toBe(false);
        expect(canScrollX(make(atEnd), -10, block)).toBe(true);
        const short = make(block, {
            classes: ["monaco-scrollable-element"],
            slider: { trackWidth: 500, left: 0, width: 500 },
        });
        expect(canScrollX(make(short), 10, block)).toBe(false);
    });

    it("finds nothing to scroll without a target element", () => {
        expect(canScrollX(null, 10)).toBe(false);
    });
});
