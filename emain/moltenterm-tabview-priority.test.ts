// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it } from "vitest";
import {
    beginTabViewWork,
    endTabViewWork,
    isTabViewPriorityRaised,
    noteTabViewPrioritySetting,
    raiseSparePriority,
    raiseTabViewPriority,
    resetTabViewPriorityForTests,
    restoreTabViewPriority,
} from "./moltenterm-tabview-priority";

function makeView() {
    const calls: boolean[] = [];
    return {
        isDestroyed: false,
        calls,
        webContents: {
            setBackgroundThrottling: (allowed: boolean) => calls.push(allowed),
            isDestroyed: () => false,
        },
    };
}

beforeEach(() => {
    resetTabViewPriorityForTests();
});

describe("tab view priority (#450)", () => {
    it("raises a view once and restores it once", () => {
        const v = makeView();
        raiseTabViewPriority(v);
        raiseTabViewPriority(v);
        expect(isTabViewPriorityRaised(v)).toBe(true);
        restoreTabViewPriority(v);
        restoreTabViewPriority(v);
        expect(v.calls).toEqual([false, true]);
    });

    it("never touches a view it did not raise, nor a destroyed one", () => {
        const v = makeView();
        restoreTabViewPriority(v);
        const dead = makeView();
        dead.isDestroyed = true;
        raiseTabViewPriority(dead);
        expect(v.calls).toEqual([]);
        expect(dead.calls).toEqual([]);
    });

    it("raises the spare only once no view is being shown, whichever view is the spare by then", () => {
        const first = makeView();
        const second = makeView();
        let spare = first;
        beginTabViewWork();
        raiseSparePriority(() => spare);
        expect(first.calls).toEqual([]);
        spare = second;
        endTabViewWork();
        expect(first.calls).toEqual([]);
        expect(second.calls).toEqual([false]);
    });

    it("the setting false keeps Chromium's backgrounding; unset or true raises", () => {
        noteTabViewPrioritySetting({ settings: { "moltenterm:tabviewpriority": false } } as any);
        const v = makeView();
        raiseTabViewPriority(v);
        raiseSparePriority(() => v);
        expect(v.calls).toEqual([]);
        noteTabViewPrioritySetting({ settings: {} } as any);
        raiseTabViewPriority(v);
        expect(v.calls).toEqual([false]);
    });
});
