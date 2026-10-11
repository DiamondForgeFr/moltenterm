// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { describe, expect, it } from "vitest";
import { BrowserLifecycleModel, scrollScript, shouldRestore } from "./browser-lifecycle";

describe("discarded browser tabs (#459)", () => {
    it("drops a tab's page and gives it back with its scroll position once, after it loaded", () => {
        const m = new BrowserLifecycleModel("b1");
        m.discard("t1", { x: 0, y: 840 });
        expect(m.isDiscarded("t1")).toBe(true);
        m.restore("t1");
        expect(m.isDiscarded("t1")).toBe(false);
        expect(globalStore.get(m.restoringAtom)).toEqual({ t1: { x: 0, y: 840 } });
        expect(m.finishRestoring("t1")).toEqual({ x: 0, y: 840 });
        expect(m.finishRestoring("t1")).toBe(null);
    });

    it("restores nothing for a tab that was not discarded, and forgets a closed tab", () => {
        const m = new BrowserLifecycleModel("b2");
        m.restore("t1");
        expect(globalStore.get(m.restoringAtom)).toEqual({});
        m.discard("t2", null);
        m.forget("t2");
        expect(m.isDiscarded("t2")).toBe(false);
    });

    it("restores a tab shown in a view on screen, or one an agent drives, and no other", () => {
        expect(shouldRestore(true, true, false)).toBe(true);
        expect(shouldRestore(false, false, true)).toBe(true);
        expect(shouldRestore(true, false, false)).toBe(false);
        expect(shouldRestore(false, true, false)).toBe(false);
    });

    it("scrolls with integers only, whatever the page reported", () => {
        expect(scrollScript({ x: 10.4, y: 2000 })).toBe("window.scrollTo(10, 2000)");
        expect(scrollScript({ x: "alert(1)" as any, y: -5 })).toBe("window.scrollTo(0, 0)");
    });
});
