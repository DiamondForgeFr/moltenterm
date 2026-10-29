// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { contentMayStart, ringTurns, SidebarSwipeController, SwipeActions, SwipeView } from "./sidebar-swipe-view";

function fakeElement(width = 240): HTMLElement {
    const classes = new Set<string>();
    return {
        style: {} as CSSStyleDeclaration,
        dataset: {},
        classList: {
            toggle: (c: string, on: boolean) => (on ? classes.add(c) : classes.delete(c)),
            remove: (c: string) => classes.delete(c),
        },
        getBoundingClientRect: () => ({ width }),
        querySelectorAll: () => [],
        contains: () => false,
    } as unknown as HTMLElement;
}

type Fixture = { controller: SidebarSwipeController; actions: { [K in keyof SwipeActions]: ReturnType<typeof vi.fn> } };

function fixture(opts: { ids?: string[]; activeId?: string; creating?: boolean; reduced?: boolean } = {}): Fixture {
    const page = fakeElement();
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
        library: () => null,
        aside: () => el("aside"),
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
    return { controller: new SidebarSwipeController(view, actions), actions };
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

    it("opens the new-workspace page from a full pull past the last workspace, and leaves it by a swipe back", () => {
        const { controller, actions } = fixture({ activeId: "c" });
        feed(controller, Array(40).fill(12));
        vi.advanceTimersByTime(200);
        expect(actions.startCreate).toHaveBeenCalledTimes(1);
        const back = fixture({ activeId: "c", creating: true });
        feed(back.controller, Array(12).fill(-12));
        vi.advanceTimersByTime(600);
        expect(back.actions.leaveCreate).toHaveBeenCalledTimes(1);
        expect(back.actions.switchTo).not.toHaveBeenCalled();
    });

    it("holds a half pull while the fingers rest, and opens nothing from it (#1261)", () => {
        const { controller, actions } = fixture({ activeId: "c" });
        feed(controller, Array(18).fill(12));
        vi.advanceTimersByTime(400);
        expect(controller.state.phase).toBe("tracking");
        vi.advanceTimersByTime(2000);
        expect(controller.state.phase).toBe("idle");
        expect(actions.startCreate).not.toHaveBeenCalled();
    });

    it("lets a touch phase source release the pull at the lift (#1261)", () => {
        const { controller, actions } = fixture({ activeId: "c" });
        controller.touch("begin");
        feed(controller, Array(40).fill(12));
        vi.advanceTimersByTime(3000);
        expect(actions.startCreate).not.toHaveBeenCalled();
        controller.touch("end");
        expect(actions.startCreate).toHaveBeenCalledTimes(1);
    });

    it("under reduced motion switches at the release, with nothing moved", () => {
        const { controller, actions } = fixture({ reduced: true });
        feed(controller, Array(14).fill(12));
        vi.advanceTimersByTime(200);
        expect(actions.switchTo).toHaveBeenCalledTimes(1);
    });
});

describe("where a gesture over the content may start", () => {
    const never = () => false;
    it("only when clearly sideways, not taken, and nothing scrolls that way", () => {
        const e = { deltaX: 10, deltaY: 2, defaultPrevented: false, target: null as EventTarget };
        expect(contentMayStart(e, never)).toBe(true);
        expect(contentMayStart({ ...e, deltaY: 6 }, never)).toBe(false);
        expect(contentMayStart({ ...e, defaultPrevented: true }, never)).toBe(false);
        expect(contentMayStart(e, () => true)).toBe(false);
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
