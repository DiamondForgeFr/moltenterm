// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

type Fixture = {
    controller: SidebarSwipeController;
    actions: { [K in keyof SwipeActions]: ReturnType<typeof vi.fn> };
    pull: (side: -1 | 1) => HTMLElement;
    view: SwipeView;
};

function fixture(
    opts: { ids?: string[]; activeId?: string; creating?: boolean; reduced?: boolean; libraryOpen?: boolean } = {}
): Fixture {
    const page = fakeElement();
    const aside = fakeElement(240, "aside");
    const library = opts.libraryOpen ? fakeElement(1200, "library") : null;
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
        tint: () => el("tint"),
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
        tintColour: (id) => (id ? `tint-${id}` : null),
        reduced: () => opts.reduced ?? false,
    };
    const actions = {
        switchTo: vi.fn(),
        openLibrary: vi.fn(),
        closeLibrary: vi.fn(),
        startCreate: vi.fn(),
        leaveCreate: vi.fn(),
    };
    return { controller: new SidebarSwipeController(view, actions), actions, pull: view.pull, view };
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
});

describe("the pull's ring", () => {
    it("fills the right half first, then the left", () => {
        expect(ringTurns(0)).toEqual({ right: 0, left: 0 });
        expect(ringTurns(0.25)).toEqual({ right: 90, left: 0 });
        expect(ringTurns(0.75)).toEqual({ right: 180, left: 90 });
        expect(ringTurns(2)).toEqual({ right: 180, left: 180 });
    });
});
