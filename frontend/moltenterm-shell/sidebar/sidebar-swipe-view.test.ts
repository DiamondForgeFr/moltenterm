// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Box, overlapArea } from "../switch-layout/layout-memory";
import { ringTurns, SidebarSwipeController, SwipeActions, SwipeView } from "./sidebar-swipe-view";

function fakeElement(width = 240, holds?: string): HTMLElement {
    const classes = new Set<string>();
    return {
        style: {} as CSSStyleDeclaration,
        dataset: {},
        classList: {
            toggle: (c: string, on: boolean) => (on ? classes.add(c) : classes.delete(c)),
            add: (c: string) => classes.add(c),
            remove: (c: string) => classes.delete(c),
            contains: (c: string) => classes.has(c),
        },
        addEventListener: () => {},
        removeEventListener: () => {},
        getBoundingClientRect: () => ({ width }),
        querySelectorAll: () => [],
        contains: (target: any) => holds != null && target?.where === holds,
    } as unknown as HTMLElement;
}

type LeaveRecord = { drawnFor: string; progress: number; seen: number[]; clears: number };

type Fixture = {
    controller: SidebarSwipeController;
    actions: { [K in keyof SwipeActions]: ReturnType<typeof vi.fn> };
    pull: (side: -1 | 1) => HTMLElement;
    view: SwipeView;
    leave: LeaveRecord;
    el: (key: string) => HTMLElement;
};

function fixture(
    opts: {
        ids?: string[];
        activeId?: string;
        creating?: boolean;
        reduced?: boolean;
        libraryOpen?: boolean;
        noLayout?: boolean;
    } = {}
): Fixture {
    const page = fakeElement();
    const aside = fakeElement(240, "aside");
    const libraryEl = fakeElement(1200, "library");
    let library = opts.libraryOpen ? libraryEl : null;
    const leave: LeaveRecord = { drawnFor: null, progress: 0, seen: [], clears: 0 };
    const els = new Map<string, HTMLElement>();
    const el = (key: string) => {
        if (!els.has(key)) {
            els.set(key, fakeElement());
        }
        return els.get(key);
    };
    const view: SwipeView = {
        page: () => page,
        ghost: (side) => el(`ghost${side}`),
        leave: {
            prepare: (id) => {
                leave.drawnFor = id;
                leave.progress = 0;
                return opts.noLayout !== true;
            },
            progress: (p) => {
                leave.progress = p;
                leave.seen.push(p);
            },
            clear: () => {
                leave.drawnFor = null;
                leave.progress = 0;
                leave.clears++;
            },
        },
        pull: (side) => el(`pull${side}`),
        shadow: (side) => el(`shadow${side}`),
        library: () => library,
        aside: () => aside,
        position: () => ({
            ids: opts.ids ?? ["a", "b", "c"],
            activeId: opts.activeId ?? "b",
            creating: opts.creating ?? false,
            otherPage: false,
        }),
        reduced: () => opts.reduced ?? false,
    };
    const actions = {
        switchTo: vi.fn(),
        openLibrary: vi.fn(() => {
            library = libraryEl;
        }),
        closeLibrary: vi.fn(() => {
            library = null;
        }),
        startCreate: vi.fn(),
        leaveCreate: vi.fn(),
    };
    return { controller: new SidebarSwipeController(view, actions), actions, pull: view.pull, view, leave, el };
}

// Feeds deltas every 8 ms on the faked clock, as a 120 Hz trackpad does.
function feed(controller: SidebarSwipeController, dxs: number[]) {
    for (const dx of dxs) {
        controller.handle(dx, 0, performance.now(), "sidebar");
        vi.advanceTimersByTime(8);
    }
}

function momentum(from: number, count: number): number[] {
    const out: number[] = [];
    let v = from;
    for (let i = 0; i < count; i++) {
        v *= 0.93;
        out.push(Math.max(1, Math.round(v)));
    }
    return out;
}

describe("workspace swipe on screen (FR-SHELL-082, #1248, TC-SHELL-201 to TC-SHELL-205)", () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] });
        vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) =>
            setTimeout(() => fn(performance.now()), 16)
        );
        vi.stubGlobal("cancelAnimationFrame", (id: any) => clearTimeout(id));
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it("asks one switch once the settle landed on the neighbour, and absorbs the momentum (#1261)", () => {
        const { controller, actions } = fixture();
        feed(controller, [...Array(14).fill(12), ...momentum(12, 8)]);
        expect(actions.switchTo).not.toHaveBeenCalled();
        feed(controller, momentum(5, 60));
        expect(actions.switchTo).toHaveBeenCalledTimes(1);
        const [target, side, swipe] = actions.switchTo.mock.calls[0];
        expect(target).toBe("c");
        expect(side).toBe(1);
        expect(swipe).toMatchObject({ offset: 1, v0: 0 });
        expect(swipe.absorb).toMatchObject({ sign: 1 });
    });

    it("in the view the switch reached, ignores the momentum and takes the next touch at once", () => {
        const { controller, actions } = fixture({ activeId: "c" });
        controller.arrived({
            workspaceId: "c",
            direction: 1,
            from: "",
            at: Date.now(),
            absorb: { sign: 1, lastAbs: 11, lastAt: Date.now() },
        });
        feed(controller, momentum(11, 20));
        expect(actions.switchTo).not.toHaveBeenCalled();
        expect(actions.startCreate).not.toHaveBeenCalled();
        feed(controller, Array(14).fill(-12));
        vi.advanceTimersByTime(600);
        expect(actions.switchTo).toHaveBeenCalledWith("b", -1, expect.anything());
    });

    it("opens the new-workspace page once the ring is full, with the fingers still moving, and leaves it by a swipe back", () => {
        const { controller, actions, pull } = fixture({ activeId: "c" });
        feed(controller, Array(16).fill(12));
        expect(actions.startCreate).toHaveBeenCalledTimes(1);
        expect(pull(1).classList.contains("is-done")).toBe(true);
        // The rest of the gesture, even coming back, is spent: it neither opens again nor leaves.
        feed(controller, [...Array(10).fill(12), ...Array(10).fill(-12)]);
        vi.advanceTimersByTime(600);
        expect(actions.startCreate).toHaveBeenCalledTimes(1);
        expect(pull(1).classList.contains("is-done")).toBe(false);
        const back = fixture({ activeId: "c", creating: true });
        feed(back.controller, Array(12).fill(-12));
        vi.advanceTimersByTime(600);
        expect(back.actions.leaveCreate).toHaveBeenCalledTimes(1);
        expect(back.actions.switchTo).not.toHaveBeenCalled();
    });

    it("holds a half pull while the fingers rest, and opens nothing from it (#1261, #1312)", () => {
        const { controller, actions } = fixture({ activeId: "c" });
        feed(controller, Array(10).fill(12));
        vi.advanceTimersByTime(1200);
        expect(controller.state.phase).toBe("tracking");
        vi.advanceTimersByTime(2000);
        expect(controller.state.phase).toBe("idle");
        expect(actions.startCreate).not.toHaveBeenCalled();
    });

    it("goes on with a pull after a rest, and opens the library past the first workspace (#1312)", () => {
        const { controller, actions } = fixture({ activeId: "a" });
        feed(controller, Array(8).fill(-12));
        vi.advanceTimersByTime(1000);
        expect(actions.openLibrary).not.toHaveBeenCalled();
        feed(controller, Array(10).fill(-12));
        expect(actions.openLibrary).toHaveBeenCalledTimes(1);
    });

    it("with a touch phase source, opens when full and lets a half pull go at the lift (#1261, #1312)", () => {
        const { controller, actions } = fixture({ activeId: "c" });
        controller.touch("begin");
        feed(controller, Array(8).fill(12));
        vi.advanceTimersByTime(3000);
        expect(controller.state.phase).toBe("tracking");
        controller.touch("end");
        expect(actions.startCreate).not.toHaveBeenCalled();
        vi.advanceTimersByTime(600);
        controller.touch("begin");
        feed(controller, Array(20).fill(12));
        expect(actions.startCreate).toHaveBeenCalledTimes(1);
    });

    it("under reduced motion switches at the release, with nothing moved", () => {
        const { controller, actions } = fixture({ reduced: true });
        feed(controller, Array(14).fill(12));
        vi.advanceTimersByTime(200);
        expect(actions.switchTo).toHaveBeenCalledTimes(1);
    });
});

describe("where a swipe starts: over the sidebar only (FR-SHELL-082, #1389)", () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] });
        vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) =>
            setTimeout(() => fn(performance.now()), 16)
        );
        vi.stubGlobal("cancelAnimationFrame", (id: any) => clearTimeout(id));
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    const inAside = { where: "aside" } as unknown as EventTarget;
    const inContent = { where: "content" } as unknown as EventTarget;
    const inLibrary = { where: "library" } as unknown as EventTarget;

    function wheels(listener: (e: WheelEvent) => void, target: EventTarget, dxs: number[]): number {
        let prevented = 0;
        for (const dx of dxs) {
            listener({
                deltaX: dx,
                deltaY: 0,
                ctrlKey: false,
                timeStamp: performance.now(),
                target,
                preventDefault: () => prevented++,
            } as unknown as WheelEvent);
            vi.advanceTimersByTime(8);
        }
        return prevented;
    }

    it("a sideways wheel over the content, a browser panel's included, never starts one", () => {
        const { controller, actions, view } = fixture();
        wheels(controller.onWindowWheel, inContent, Array(20).fill(12));
        vi.advanceTimersByTime(600);
        expect(actions.switchTo).not.toHaveBeenCalled();
        expect(controller.state.phase).toBe("idle");
        expect(view.page().style.transform).toBeUndefined();    });

    it("over the sidebar it starts one and switches", () => {
        const { controller, actions } = fixture();
        const prevented = wheels(controller.onAsideWheel, inAside, Array(14).fill(12));
        vi.advanceTimersByTime(600);
        expect(prevented).toBeGreaterThan(0);
        expect(actions.switchTo).toHaveBeenCalledWith("c", 1, expect.anything());
    });

    it("over the open library, which covers the sidebar, a swipe back still leaves it", () => {
        const { controller, actions } = fixture({ libraryOpen: true });
        wheels(controller.onWindowWheel, inContent, Array(14).fill(12));
        vi.advanceTimersByTime(600);
        expect(actions.closeLibrary).not.toHaveBeenCalled();
        wheels(controller.onWindowWheel, inLibrary, Array(14).fill(12));
        vi.advanceTimersByTime(600);
        expect(actions.closeLibrary).toHaveBeenCalledTimes(1);
        expect(actions.switchTo).not.toHaveBeenCalled();
    });

    // The pointer stays where the gesture began, over the sidebar; while the library is open it lies over it.
    function replay(f: Fixture, dxs: number[]): { libraryShown: number; pageMoved: number } {
        let libraryShown = 0;
        let pageMoved = 0;
        for (const dx of dxs) {
            if (f.view.library() != null) {
                wheels(f.controller.onWindowWheel, inLibrary, [dx]);
                libraryShown++;
            } else {
                wheels(f.controller.onAsideWheel, inAside, [dx]);
                if (f.view.page().style.transform) {
                    pageMoved++;
                }
            }
        }
        return { libraryShown, pageMoved };
    }

    it("a library opened by a pull and closed by a swipe back stays closed through a long momentum tail (#1392)", () => {
        const f = fixture({ activeId: "a" });
        replay(f, [...Array(20).fill(-12), ...momentum(-12, 60)]);
        vi.advanceTimersByTime(400);
        expect(f.actions.openLibrary).toHaveBeenCalledTimes(1);
        expect(f.view.library()).not.toBeNull();
        replay(f, Array(14).fill(14));
        const tail = replay(f, momentum(14, 240));
        vi.advanceTimersByTime(2000);
        expect(f.actions.closeLibrary).toHaveBeenCalledTimes(1);
        expect(f.actions.openLibrary).toHaveBeenCalledTimes(1);
        expect(f.view.library()).toBeNull();
        expect(tail.pageMoved).toBe(0);
        expect(f.actions.switchTo).not.toHaveBeenCalled();
        expect(f.actions.startCreate).not.toHaveBeenCalled();
    });
});

// Chromium's frame order: the wheel events of a frame are dispatched first, then its requestAnimationFrame callbacks
// run. The fixtures above run the frame first whenever both fall due, which hid #1405.
describe("a swipe leaving the library or the new-workspace page lands, whatever its momentum does (#1405)", () => {
    let queued = new Map<number, FrameRequestCallback>();
    let nextId = 1;

    beforeEach(() => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] });
        queued = new Map();
        vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
            const id = nextId++;
            queued.set(id, fn);
            return id;
        });
        vi.stubGlobal("cancelAnimationFrame", (id: number) => queued.delete(id));
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    const inAside = { where: "aside" } as unknown as EventTarget;
    const inLibrary = { where: "library" } as unknown as EventTarget;

    function runFrame() {
        const callbacks = Array.from(queued.values());
        queued.clear();
        callbacks.forEach((fn) => fn(performance.now()));
    }

    // One wheel event per 60 Hz frame, dispatched before the frame's callbacks. The pointer stays where the gesture
    // began, over the sidebar; while the library is open it lies over it. The library's look is checked after each
    // frame: once moved, it never shows back at rest while it is open.
    function frames(f: Fixture, dxs: number[]): { flashes: number } {
        let flashes = 0;
        let moved = false;
        for (const dx of dxs) {
            vi.advanceTimersByTime(16);
            const lib = f.view.library();
            const wheel = {
                deltaX: dx,
                deltaY: 0,
                ctrlKey: false,
                timeStamp: performance.now(),
                target: lib != null ? inLibrary : inAside,
                preventDefault: () => {},
            } as unknown as WheelEvent;
            if (lib != null) {
                f.controller.onWindowWheel(wheel);
            } else {
                f.controller.onAsideWheel(wheel);
            }
            runFrame();
            if (lib == null) {
                continue;
            }
            if (lib.style.transform) {
                moved = true;
            } else if (moved && f.view.library() === lib) {
                flashes++;
                moved = false;
            }
        }
        return { flashes };
    }

    // A trackpad's momentum at 60 Hz: a tail decaying to nothing over about 1.5 s, with now and then a delta a pixel or
    // two the other way.
    function tail(from: number, reversals = false): number[] {
        const out: number[] = [];
        for (let v = Math.abs(from) * 0.96, i = 0; Math.round(v) > 0; v *= 0.96, i++) {
            out.push(Math.sign(from) * (reversals && i > 4 && i % 9 === 0 ? -2 : Math.round(v)));
        }
        return out;
    }

    it("closes the library when its momentum outlasts the settle", () => {
        const f = fixture({ libraryOpen: true });
        const lib = f.view.library();
        const shown = frames(f, [...Array(10).fill(20), ...tail(20)]);
        vi.advanceTimersByTime(2000);
        runFrame();
        expect(f.actions.closeLibrary).toHaveBeenCalledTimes(1);
        expect(f.view.library()).toBeNull();
        expect(shown.flashes).toBe(0);
        // It keeps its leaving look until React removes it: cleared, it would show at rest for a frame.
        expect(lib.style.transform).toMatch(/^translate3d\(-/);
    });

    it("closes it for good through a tail with small reversals", () => {
        const f = fixture({ libraryOpen: true });
        const shown = frames(f, [...Array(10).fill(20), ...tail(20, true)]);
        vi.advanceTimersByTime(2000);
        runFrame();
        expect(f.actions.closeLibrary).toHaveBeenCalledTimes(1);
        expect(f.view.library()).toBeNull();
        expect(shown.flashes).toBe(0);
    });

    it("a library opened by a pull and closed by a swipe back never opens again from that swipe", () => {
        const f = fixture({ activeId: "a" });
        frames(f, [...Array(20).fill(-12), ...tail(-12)]);
        vi.advanceTimersByTime(400);
        runFrame();
        expect(f.actions.openLibrary).toHaveBeenCalledTimes(1);
        frames(f, [...Array(10).fill(20), ...tail(20, true)]);
        vi.advanceTimersByTime(2000);
        runFrame();
        expect(f.actions.closeLibrary).toHaveBeenCalledTimes(1);
        expect(f.actions.openLibrary).toHaveBeenCalledTimes(1);
        expect(f.view.library()).toBeNull();
        expect(f.actions.switchTo).not.toHaveBeenCalled();
        expect(f.actions.startCreate).not.toHaveBeenCalled();
    });

    it("leaves the new-workspace page when its momentum outlasts the settle", () => {
        const f = fixture({ activeId: "c", creating: true });
        frames(f, [...Array(10).fill(-20), ...tail(-20, true)]);
        vi.advanceTimersByTime(2000);
        runFrame();
        expect(f.actions.leaveCreate).toHaveBeenCalledTimes(1);
        expect(f.actions.switchTo).not.toHaveBeenCalled();
    });
});

describe("the pull's ring", () => {
    it("fills the right half first, then the left", () => {
        expect(ringTurns(0)).toEqual({ right: 0, left: 0 });
        expect(ringTurns(0.25)).toEqual({ right: 90, left: 0 });
        expect(ringTurns(0.75)).toEqual({ right: 180, left: 90 });
        expect(ringTurns(2)).toEqual({ right: 180, left: 180 });
    });
});

describe("side panels edge to edge, the content into the next layout (FR-SHELL-082, #2407)", () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] });
        vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) =>
            setTimeout(() => fn(performance.now()), 16)
        );
        vi.stubGlobal("cancelAnimationFrame", (id: any) => clearTimeout(id));
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    const Width = 240;
    type Frame = { page: Box; ghost: Box; progress: number };

    function shiftOf(el: HTMLElement): number {
        const m = /translate3d\((-?[\d.e-]+)px/.exec(el.style.transform ?? "");
        return m == null ? null : parseFloat(m[1]);
    }

    function rect(x: number): Box {
        return { left: x, top: 0, width: Width, height: 600 };
    }

    // The rectangles of the page and of the neighbour coming in, as the last display frame drew them.
    function sample(f: Fixture, side: -1 | 1, out: Frame[]) {
        const px = shiftOf(f.view.page());
        const gx = shiftOf(f.el(`ghost${side}`));
        if (px != null && gx != null) {
            out.push({ page: rect(px), ghost: rect(gx), progress: f.leave.progress });
        }
    }

    function runFrames(f: Fixture, side: -1 | 1, out: Frame[], count = 60) {
        for (let i = 0; i < count; i++) {
            vi.advanceTimersByTime(16);
            sample(f, side, out);
        }
    }

    it("never overlaps the outgoing and the incoming sidebars at any step of a slow scroll, its settle included", () => {
        const f = fixture();
        const frames: Frame[] = [];
        // A slow two-finger scroll: 3 px every 16 ms, then the release and the settle.
        for (let i = 0; i < 40; i++) {
            f.controller.handle(3, 0, performance.now(), "sidebar");
            vi.advanceTimersByTime(16);
            sample(f, 1, frames);
        }
        runFrames(f, 1, frames);
        expect(frames.length).toBeGreaterThan(40);
        for (const fr of frames) {
            expect(overlapArea(fr.page, fr.ghost)).toBeLessThanOrEqual(0);
            // Edge to edge: the incoming panel starts where the outgoing one ends, no gap either.
            expect(Math.abs(fr.ghost.left - (fr.page.left + fr.page.width))).toBeLessThan(0.5);
            // The content has faded into the next layout by the share the sidebar travelled (wholly in once landed).
            if (fr.progress < 1) {
                expect(fr.progress).toBeCloseTo(-fr.page.left / Width, 5);
            }
        }
        // The slow scroll moved it slowly: 3 px a frame while the fingers moved.
        expect(Math.abs(frames[1].page.left - frames[0].page.left)).toBeLessThanOrEqual(3.01);
        expect(f.actions.switchTo).toHaveBeenCalledTimes(1);
        expect(f.actions.switchTo.mock.calls[0][2]).toMatchObject({ offset: 1, layout: true });
        expect(f.leave.drawnFor).toBe("c");
    });

    it("puts everything back exactly as it was when the gesture is let go half way", () => {
        const f = fixture();
        for (let i = 0; i < 12; i++) {
            f.controller.handle(4, 0, performance.now(), "sidebar");
            vi.advanceTimersByTime(16);
        }
        expect(f.leave.progress).toBeGreaterThan(0.1);
        vi.advanceTimersByTime(2000);
        expect(f.actions.switchTo).not.toHaveBeenCalled();
        expect(f.view.page().style.transform).toBe("");
        expect(f.el("ghost1").style.transform).toBe("");
        expect(f.leave.drawnFor).toBeNull();
        expect(f.leave.progress).toBe(0);
        expect(f.leave.clears).toBeGreaterThan(0);
        expect(f.controller.state.phase).toBe("idle");
    });

    it("plays a dot's switch to a neighbour as the swipe's own eased settle, then asks the switch", () => {
        const f = fixture();
        const frames: Frame[] = [];
        expect(f.controller.autoSwitch("c", 1)).toBe(true);
        runFrames(f, 1, frames);
        expect(frames.length).toBeGreaterThan(5);
        for (const fr of frames) {
            expect(overlapArea(fr.page, fr.ghost)).toBeLessThanOrEqual(0);
        }
        const seen = f.leave.seen;
        expect(seen[seen.length - 1]).toBe(1);
        for (let i = 1; i < seen.length; i++) {
            expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1] - 1e-9);
        }
        expect(f.actions.switchTo).toHaveBeenCalledWith("c", 1, expect.objectContaining({ offset: 1, layout: true }));
    });

    it("leaves a dot's switch to a workspace that is not a neighbour, or under reduced motion, to the cross-fade", () => {
        expect(fixture().controller.autoSwitch("a", 1)).toBe(false);
        expect(fixture({ reduced: true }).controller.autoSwitch("c", 1)).toBe(false);
    });

    it("under reduced motion shows the layout at once, then switches: the same steps without the slide", () => {
        const f = fixture({ reduced: true });
        feed(f.controller, Array(14).fill(12));
        vi.advanceTimersByTime(200);
        expect(f.leave.seen).toContain(1);
        expect(f.actions.switchTo.mock.calls[0][2]).toMatchObject({ layout: true });
        expect(shiftOf(f.view.page()) ?? 0).toBe(0);
    });

    it("tells the switch there is no layout when the neighbour has none yet", () => {
        const f = fixture({ noLayout: true });
        f.controller.autoSwitch("c", 1);
        runFrames(f, 1, []);
        expect(f.actions.switchTo.mock.calls[0][2]).toMatchObject({ layout: false });
        expect(f.leave.seen).toEqual([]);
    });
});
