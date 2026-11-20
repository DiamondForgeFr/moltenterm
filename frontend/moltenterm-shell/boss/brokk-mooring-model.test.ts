// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Brokk's open group moored to the sidebar (FR-BOSS-009, AC107, AC108, #2421): where the group and the thread land in each
// mode of the sidebar (pinned, collapsed, floating; shown and hidden), whatever moment of the sidebar's slide the measure
// catches, and the slide that moves them with it.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AjarPx, edgeFaceShiftPx, EdgePx as StripPx } from "./brokk-edge-model";
import { EdgePx, groupGeometry } from "./brokk-group-model";
import {
    groupSlideFrames,
    HiddenOverhangPx,
    matrixXOf,
    mooredFrame,
    MooringInput,
    playSlide,
    sameMooredFrame,
    ScreenRect,
    SidebarDraw,
    sidebarLandingShiftPx,
    slideOf,
    threadSlideFrames,
} from "./brokk-mooring-model";
import { followSlide, Moored, SlideTarget } from "./use-brokk-mooring";

function css(file: string): string {
    return readFileSync(join(__dirname, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
}

// Collected with the file (a read has no timeout), asserted in the tests.
const SidebarCss = css("../sidebar/sidebar.css");
const GroupCss = css("./brokk-group.css");

function rule(sheet: string, selector: string): string {
    const at = sheet.indexOf(`${selector} {`);
    expect(at, selector).toBeGreaterThanOrEqual(0);
    return sheet.slice(at, sheet.indexOf("}", at));
}

const Gap = 8;
const Width = 264;
const Layer: ScreenRect = { left: 0, top: 0, width: 1400, height: 900 };
const g = groupGeometry();
const PeekInset = 12;

const Docked: SidebarDraw = { hidden: false, peek: false, edge: null };
const FloatingOut: SidebarDraw = { hidden: true, peek: true, edge: null };
const HiddenRest: SidebarDraw = { hidden: true, peek: false, edge: "rest" };
const HiddenNoBrokk: SidebarDraw = { hidden: true, peek: false, edge: null };

// The floating sidebar as measured with `shift` of translateX now: its layout box starts at the frame's margin.
function floating(draw: SidebarDraw, shift: number, faceShift = 0, faceEdge = false): MooringInput {
    const layoutLeft = Gap;
    // The face's right edge is the title row's, 12 px inside the sidebar's.
    const faceLayoutLeft = layoutLeft + Width - PeekInset - 26;
    return {
        layer: Layer,
        inset: Gap,
        g,
        sidebar: { box: { left: layoutLeft + shift, top: Gap, width: Width, height: 884 }, shift, draw, gap: Gap },
        face: {
            box: { left: faceLayoutLeft + shift + faceShift, top: 20, width: 26, height: 26 },
            shift: faceShift,
            edge: faceEdge,
            peekInset: PeekInset,
        },
    };
}

// The docked sidebar takes its place in the layout, and the content, Brokk's layer with it, starts at its right edge
// (as measured in the app: sidebar 0 to 264, layer from 264).
function docked(): MooringInput {
    return {
        layer: { ...Layer, left: Width, width: Layer.width - Width },
        inset: Gap,
        g,
        sidebar: { box: { left: 0, top: 0, width: Width, height: 900 }, shift: 0, draw: Docked, gap: Gap },
        face: {
            box: { left: Width - 26, top: 7, width: 26, height: 26 },
            shift: 0,
            edge: false,
            peekInset: PeekInset,
        },
    };
}

const HiddenSidebarRight = Gap + Width - (Width + HiddenOverhangPx);

describe("the sidebar's landing shift matches sidebar.css", () => {
    it("hides the floating sidebar past the window's left edge", () => {
        expect(rule(SidebarCss, ".mt-sb.is-hidden")).toContain(
            `transform: translateX(calc(-100% - ${HiddenOverhangPx}px))`
        );
        expect(sidebarLandingShiftPx(HiddenNoBrokk, Width, Gap)).toBe(-Width - HiddenOverhangPx);
        expect(sidebarLandingShiftPx(HiddenRest, Width, Gap)).toBe(-Width - HiddenOverhangPx);
    });

    it("floats it out at its place", () => {
        expect(rule(SidebarCss, ".mt-sb.is-hidden.is-peek")).toContain("transform: translateX(0)");
        expect(sidebarLandingShiftPx(FloatingOut, Width, Gap)).toBe(0);
    });

    it("lets Brokk's strip and the half open sidebar out by their widths", () => {
        expect(rule(SidebarCss, '.mt-sb.is-hidden[data-edge="peek"]')).toContain(
            "transform: translateX(calc(-100% + var(--mt-edge-px) - var(--mt-frame-gap)))"
        );
        expect(rule(SidebarCss, '.mt-sb.is-hidden[data-edge="ajar"]')).toContain(
            "transform: translateX(calc(-100% + var(--mt-ajar-px) - var(--mt-frame-gap)))"
        );
        expect(sidebarLandingShiftPx({ hidden: true, peek: false, edge: "peek" }, Width, Gap)).toBe(
            -Width + StripPx - Gap
        );
        expect(sidebarLandingShiftPx({ hidden: true, peek: false, edge: "ajar" }, Width, Gap)).toBe(
            -Width + AjarPx - Gap
        );
    });

    it("leaves the docked sidebar where the layout puts it", () => {
        expect(sidebarLandingShiftPx(Docked, Width, Gap)).toBe(0);
    });
});

describe("reading a computed transform", () => {
    it("reads none, a 2D and a 3D matrix", () => {
        expect(matrixXOf("none")).toEqual({ scale: 1, tx: 0 });
        expect(matrixXOf("")).toEqual({ scale: 1, tx: 0 });
        expect(matrixXOf("matrix(1, 0, 0, 1, -144, 0)")).toEqual({ scale: 1, tx: -144 });
        expect(matrixXOf("matrix(2.5, 0, 0, 1, 12, 0)")).toEqual({ scale: 2.5, tx: 12 });
        expect(matrixXOf("matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -30, 0, 0, 1)")).toEqual({ scale: 1, tx: -30 });
    });
});

describe("pinned: the docked sidebar", () => {
    it("stands the group 8 px into the content right of the sidebar, its thread tied to the face", () => {
        const frame = mooredFrame(docked());
        expect(frame.layerX).toBe(Width);
        expect(frame.layerX + frame.place.left).toBe(Width + Gap + EdgePx);
        expect(frame.layerX + frame.thread.x).toBe(Width);
        expect(frame.thread.x + frame.thread.w).toBe(frame.place.left);
    });

    it("hidden from the docked state, lands at the window's edge and runs the thread off it", () => {
        // The class has changed and the slide starts from no transform: the box is the floating one, not moved yet,
        // and the content, the layer with it, has taken the whole width at once.
        const frame = mooredFrame(floating(HiddenRest, 0, 0, true));
        expect(frame.layerX).toBe(0);
        expect(frame.place.left).toBe(Gap + EdgePx);
        expect(frame.thread.x).toBeLessThan(0);
        expect(frame.thread.x + frame.thread.w).toBe(frame.place.left);
    });
});

describe("floating: the sidebar hides and comes back", () => {
    it("shown, the group stands right of the floating sidebar, tied to the face", () => {
        const frame = mooredFrame(floating(FloatingOut, 0));
        expect(frame.place.left).toBe(Gap + Width + EdgePx);
        expect(frame.thread.x).toBe(Gap + Width - PeekInset);
        expect(frame.thread.x + frame.thread.w).toBe(frame.place.left);
    });

    it("hiding, the group lands at the window's edge whatever moment of the slide is measured", () => {
        const landing = -(Width + HiddenOverhangPx);
        for (const caught of [0, landing / 4, landing / 2, landing]) {
            const frame = mooredFrame(floating(HiddenRest, caught, 0, true));
            expect(frame.place.left, `caught at ${caught}`).toBe(Gap + EdgePx);
            // The face goes out of the window with the sidebar: the thread starts there and runs off the left edge.
            expect(frame.thread.x, `caught at ${caught}`).toBe(
                HiddenSidebarRight - PeekInset + edgeFaceShiftPx(PeekInset)
            );
            expect(frame.thread.x).toBeLessThan(0);
            expect(frame.thread.x + frame.thread.w).toBe(frame.place.left);
        }
    });

    it("coming back, the group lands right of it again and the thread ties back to the face", () => {
        const landing = -(Width + HiddenOverhangPx);
        const back = mooredFrame(floating(FloatingOut, landing, edgeFaceShiftPx(PeekInset), false));
        expect(back).toEqual(mooredFrame(floating(FloatingOut, 0)));
    });

    it("with Brokk's face off, hides to the window's edge too", () => {
        const input = { ...floating(HiddenNoBrokk, 0), face: null };
        expect(mooredFrame(input)).toEqual({
            place: expect.objectContaining({ left: Gap + EdgePx }),
            origin: null,
            thread: null,
            layerX: 0,
        });
    });
});

describe("collapsed: Brokk's strip at the window's edge (#2389)", () => {
    it("at rest, the group stands at the window's edge", () => {
        const frame = mooredFrame(floating(HiddenRest, -(Width + HiddenOverhangPx), edgeFaceShiftPx(PeekInset), true));
        expect(frame.place.left).toBe(Gap + EdgePx);
        expect(frame.thread.x).toBeLessThan(0);
    });

    it("peeking out or half open, right of the strip, the thread tied to the face in it", () => {
        const peek = mooredFrame(floating({ hidden: true, peek: false, edge: "peek" }, 0, 0, true));
        expect(peek.place.left).toBe(StripPx + EdgePx);
        // The face's right edge stands where the 20 px face centred in the strip ends.
        expect(peek.thread.x).toBe(StripPx - (StripPx - 20) / 2);
        const ajar = mooredFrame(floating({ hidden: true, peek: false, edge: "ajar" }, 0, 0, true));
        expect(ajar.place.left).toBe(AjarPx + EdgePx);
    });

    it("with no sidebar element, moors to the layer's edge", () => {
        const frame = mooredFrame({ layer: Layer, inset: Gap, g, sidebar: null, edgeOnly: true, face: null });
        expect(frame.place.left).toBe(Gap + EdgePx);
    });
});

describe("two measures that land the same", () => {
    it("keep the frame", () => {
        const a = mooredFrame(floating(HiddenRest, 0, 0, true));
        expect(sameMooredFrame(a, mooredFrame(floating(HiddenRest, -100, 0, true)))).toBe(true);
        expect(sameMooredFrame(a, mooredFrame(floating(FloatingOut, 0)))).toBe(false);
        expect(sameMooredFrame(null, a)).toBe(false);
    });

    it("differ when only the layer moved, as it does when the sidebar docks or undocks", () => {
        const a = mooredFrame(docked());
        expect(sameMooredFrame(a, { ...a, layerX: 0 })).toBe(false);
    });
});

describe("the sidebar's slide", () => {
    const transition = {
        property: "transform",
        running: true,
        durationMs: 180,
        elapsedMs: 0,
        easing: "cubic-bezier(0.2, 0, 0, 1)",
    };

    it("is the running transform transition: its time left and its curve", () => {
        expect(slideOf([{ ...transition, property: "visibility" }, transition])).toEqual({
            durationMs: 180,
            easing: "cubic-bezier(0.2, 0, 0, 1)",
        });
        expect(slideOf([{ ...transition, elapsedMs: 60 }]).durationMs).toBe(120);
    });

    it("is none when the sidebar changes without one (reduced motion, docked again)", () => {
        expect(slideOf([])).toBeNull();
        expect(slideOf([{ ...transition, running: false }])).toBeNull();
        expect(slideOf([{ ...transition, durationMs: 0 }])).toBeNull();
    });
});

function translate(frame: { transform: string }): number {
    return Number(/translateX\((-?[\d.]+)px\)/.exec(frame.transform)[1]);
}

function scale(frame: { transform: string }): number {
    const m = /scaleX\((-?[\d.]+)\)/.exec(frame.transform);
    return m == null ? 1 : Number(m[1]);
}

describe("the group and the thread move together", () => {
    it("plays the group from where it was seen to its place", () => {
        const frames = groupSlideFrames(280, 16);
        expect(translate(frames[0])).toBe(264);
        expect(translate(frames[1])).toBe(0);
        expect(groupSlideFrames(16, 16.2)).toBeNull();
    });

    it("keeps the thread's right end on the square's edge at every moment of the slide", () => {
        const shown = mooredFrame(floating(FloatingOut, 0));
        const hidden = mooredFrame(floating(HiddenRest, 0, 0, true));
        const group = groupSlideFrames(shown.place.left, hidden.place.left);
        const thread = threadSlideFrames(shown.thread, hidden.thread);
        for (const p of [0, 0.25, 0.5, 0.75, 1]) {
            const mix = (a: number, b: number) => a + (b - a) * p;
            const groupLeft = hidden.place.left + mix(translate(group[0]), translate(group[1]));
            const tx = mix(translate(thread[0]), translate(thread[1]));
            const sx = mix(scale(thread[0]), scale(thread[1]));
            const left = hidden.thread.x + tx;
            const right = left + hidden.thread.w * sx;
            expect(right, `at ${p}`).toBeCloseTo(groupLeft, 1);
        }
        expect(hidden.thread.x + translate(thread[0])).toBeCloseTo(shown.thread.x, 3);
    });

    it("stretches the thread from its left end", () => {
        expect(rule(GroupCss, ".mt-tether.mt-brokk-thread")).toContain("transform-origin: 0 0");
    });
});

describe("playing the slide", () => {
    const slide = { durationMs: 180, easing: "cubic-bezier(0.2, 0, 0, 1)" };

    function fake(): SlideTarget & { animate: ReturnType<typeof vi.fn>; cancels: number } {
        const target = { cancels: 0, animate: vi.fn() } as any;
        target.animate.mockImplementation(() => ({ cancel: () => (target.cancels += 1) }));
        return target;
    }

    const Shown: Moored = { left: 280, thread: { x: 260, w: 20 } };
    const Hidden: Moored = { left: 16, thread: { x: -17, w: 33 } };

    it("moves the group and the thread with the sidebar's time and curve", () => {
        const root = fake();
        const thread = fake();
        followSlide({ root, thread }, Shown, Hidden, slide, true, null, () => "none");
        expect(root.animate).toHaveBeenCalledWith(groupSlideFrames(280, 16), { duration: 180, easing: slide.easing });
        expect(thread.animate).toHaveBeenCalledWith(threadSlideFrames(Shown.thread, Hidden.thread), {
            duration: 180,
            easing: slide.easing,
        });
    });

    it("turned back midway, starts from where they are seen and drops the slide under way", () => {
        const root = fake();
        const thread = fake();
        const first = followSlide({ root, thread }, Shown, Hidden, slide, true, null, () => "none");
        const transforms = new Map<SlideTarget, string>([
            [root, "matrix(1, 0, 0, 1, 100, 0)"],
            [thread, "matrix(1.5, 0, 0, 1, 120, 0)"],
        ]);
        followSlide({ root, thread }, Hidden, Shown, slide, true, first, (t) => transforms.get(t));
        expect(root.cancels).toBe(1);
        expect(thread.cancels).toBe(1);
        expect(root.animate).toHaveBeenLastCalledWith(groupSlideFrames(116, 280), expect.anything());
        expect(thread.animate).toHaveBeenLastCalledWith(
            threadSlideFrames({ x: 103, w: 49.5 }, Shown.thread),
            expect.anything()
        );
    });

    it("moves nothing without a slide, before the group is in, or on its first frame", () => {
        for (const [before, s, shown] of [
            [Shown, null, true],
            [Shown, slide, false],
            [null, slide, true],
        ] as const) {
            const root = fake();
            followSlide({ root, thread: null }, before, Hidden, s, shown, null, () => "none");
            expect(root.animate).not.toHaveBeenCalled();
        }
    });

    it("plays nothing where the page cannot animate", () => {
        expect(playSlide({}, groupSlideFrames(0, 100), slide)).toBeNull();
    });
});
