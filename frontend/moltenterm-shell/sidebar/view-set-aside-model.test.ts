// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// A temporary view closed in one click waits aside for its toast's Undo (#1656): who shows the toast, when the view
// closes for good, and which view comes on screen meanwhile.

import { describe, expect, it } from "vitest";
import { HiddenTabsMetaKey } from "../hidden-tabs";
import {
    readSetAside,
    SetAsideMetaKey,
    SetAsideStaleMs,
    setAsideStep,
    setAsideSurvivor,
    withHidden,
} from "./view-set-aside-model";

const Now = 1_000_000;

function ws(mark: Record<string, any>, opts: { active?: string; hidden?: string[]; tabids?: string[] } = {}) {
    return {
        tabids: opts.tabids ?? ["a", "b", "c"],
        activetabid: opts.active ?? "a",
        meta: { [SetAsideMetaKey]: mark, [HiddenTabsMetaKey]: opts.hidden ?? (mark ? [mark.tabid] : []) },
    };
}

const mark = (extra: Record<string, any> = {}) => ({ tabid: "b", at: Now, id: "m1", wasactive: true, ...extra });

describe("setAsideStep", () => {
    it("the view on screen shows the toast, once", () => {
        expect(setAsideStep(ws(mark()), { ownTabId: "a", showingId: null, now: Now })).toBe("show");
        expect(setAsideStep(ws(mark({ shownby: "a" })), { ownTabId: "a", showingId: "m1", now: Now })).toBe("none");
    });

    it("a view not on screen, and the view set aside itself, do nothing", () => {
        expect(setAsideStep(ws(mark()), { ownTabId: "c", showingId: null, now: Now })).toBe("none");
        expect(setAsideStep(ws(mark(), { active: "b" }), { ownTabId: "b", showingId: null, now: Now })).toBe("none");
    });

    it("the toast follows the screen: the new view takes it, the old one drops it", () => {
        const taken = ws(mark({ shownby: "c" }), { active: "c" });
        expect(setAsideStep(taken, { ownTabId: "a", showingId: "m1", now: Now })).toBe("drop");
        expect(
            setAsideStep(ws(mark({ shownby: "a" }), { active: "c" }), { ownTabId: "c", showingId: null, now: Now })
        ).toBe("show");
    });

    it("drops a toast whose mark went (Undo, or the view closed)", () => {
        expect(setAsideStep(ws(null), { ownTabId: "a", showingId: "m1", now: Now })).toBe("drop");
        expect(setAsideStep(ws(null), { ownTabId: "a", showingId: null, now: Now })).toBe("none");
    });

    it("forgets the mark of a view gone or shown again by another path", () => {
        expect(setAsideStep(ws(mark(), { tabids: ["a", "c"] }), { ownTabId: "a", showingId: null, now: Now })).toBe(
            "forget"
        );
        expect(setAsideStep(ws(mark(), { hidden: [] }), { ownTabId: "a", showingId: null, now: Now })).toBe("forget");
    });

    it("closes for good a view whose toast was lost", () => {
        const stale = ws(mark({ shownby: "gone" }));
        expect(setAsideStep(stale, { ownTabId: "a", showingId: null, now: Now + SetAsideStaleMs + 1 })).toBe("finish");
    });
});

describe("setAsideSurvivor", () => {
    it("prefers the opener, then the view shown before, then the left neighbour, then the right", () => {
        const base = { tabids: ["a", "b", "c"], meta: {} as Record<string, any> };
        expect(setAsideSurvivor(base, "b", "c")).toBe("c");
        expect(setAsideSurvivor({ ...base, meta: { "molten:tabhistory": ["b", "c"] } }, "b", "")).toBe("c");
        expect(setAsideSurvivor(base, "b", "")).toBe("a");
        expect(setAsideSurvivor(base, "a", "")).toBe("b");
    });

    it("skips hidden views, and finds none when no other view shows", () => {
        const hidden = { tabids: ["a", "b", "c"], meta: { [HiddenTabsMetaKey]: ["a"] } };
        expect(setAsideSurvivor(hidden, "b", "a")).toBe("c");
        expect(setAsideSurvivor({ tabids: ["a", "b"], meta: { [HiddenTabsMetaKey]: ["a"] } }, "b", "")).toBeNull();
    });
});

describe("readSetAside and withHidden", () => {
    it("reads a well-formed mark only", () => {
        expect(readSetAside({ meta: { [SetAsideMetaKey]: { tabid: "b" } } })).toBeNull();
        expect(readSetAside(ws(mark()))).toMatchObject({ tabid: "b", id: "m1", wasactive: true });
    });

    it("keeps the agents' hidden views and takes the key away once empty", () => {
        const w = { meta: { [HiddenTabsMetaKey]: ["agent"] } };
        expect(withHidden(w, "b", true)).toEqual(["agent", "b"]);
        expect(withHidden({ meta: { [HiddenTabsMetaKey]: ["b"] } }, "b", false)).toBeNull();
    });
});
