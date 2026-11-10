// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { globalStore } from "@/app/store/jotaiStore";
import { atom, PrimitiveAtom } from "jotai";
import { describe, expect, it, vi } from "vitest";
import { makeShownAsk } from "./shown-ask";
import type { ActivityState } from "./tab-activity-model";

function fixture(state: ActivityState) {
    const stateAtom = atom(state) as PrimitiveAtom<ActivityState>;
    const ask = vi.fn();
    const shown = makeShownAsk(ask, { stateAtom });
    const move = (next: ActivityState) => globalStore.set(stateAtom, next);
    return { ask, shown, move };
}

describe("a shown ask (#2154)", () => {
    it("asks at once, each time, while the view shows", () => {
        const { ask, shown } = fixture("active");
        shown.event();
        shown.event();
        expect(ask).toHaveBeenCalledTimes(2);
        shown.stop();
    });

    it("asks at once in a window that shows without the focus too", () => {
        const { ask, shown } = fixture("visible");
        shown.event();
        expect(ask).toHaveBeenCalledTimes(1);
        shown.stop();
    });

    it("asks nothing while the view is hidden, whatever the number of events", () => {
        const { ask, shown } = fixture("hidden");
        for (let i = 0; i < 5; i++) {
            shown.event();
        }
        expect(ask).not.toHaveBeenCalled();
        shown.stop();
    });

    it("asks nothing in a minimised window", () => {
        const { ask, shown } = fixture("minimized");
        shown.event();
        expect(ask).not.toHaveBeenCalled();
        shown.stop();
    });

    it("asks once when the view shows again, for all the events it missed", () => {
        const { ask, shown, move } = fixture("hidden");
        shown.event();
        shown.event();
        shown.event();
        move("active");
        expect(ask).toHaveBeenCalledTimes(1);
        move("visible");
        move("active");
        expect(ask).toHaveBeenCalledTimes(1);
        shown.stop();
    });

    it("asks nothing when the view shows again if no event came while it was away", () => {
        const { ask, shown, move } = fixture("active");
        move("hidden");
        move("active");
        expect(ask).not.toHaveBeenCalled();
        shown.stop();
    });

    it("asks nothing while it goes from hidden to minimised, and once it shows", () => {
        const { ask, shown, move } = fixture("hidden");
        shown.event();
        move("minimized");
        expect(ask).not.toHaveBeenCalled();
        move("visible");
        expect(ask).toHaveBeenCalledTimes(1);
        shown.stop();
    });

    it("asks again for an event that comes after the view went away a second time", () => {
        const { ask, shown, move } = fixture("hidden");
        shown.event();
        move("active");
        move("hidden");
        shown.event();
        move("active");
        expect(ask).toHaveBeenCalledTimes(2);
        shown.stop();
    });

    it("asks nothing once stopped, not even for an event it owed", () => {
        const { ask, shown, move } = fixture("hidden");
        shown.event();
        shown.stop();
        move("active");
        shown.event();
        expect(ask).not.toHaveBeenCalled();
    });
});
