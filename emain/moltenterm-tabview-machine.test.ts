// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    InvalidTabViewTransition,
    isAllowedTransition,
    TabViewRegistry,
    TabViewState,
    TabViewTransitions,
} from "./moltenterm-tabview-machine";

type View = { name: string };

const AllStates = Object.keys(TabViewTransitions) as TabViewState[];

function makeRegistry(strict = true) {
    const logs: string[] = [];
    let now = 1000;
    const reg = new TabViewRegistry<View>({
        strict: () => strict,
        log: (msg) => logs.push(msg),
        now: () => now,
    });
    return { reg, logs, tick: (ms: number) => (now += ms) };
}

function shownView(reg: TabViewRegistry<View>, name: string, tabId: string, windowId = "w1"): View {
    const view = { name };
    reg.add(view);
    reg.assign(view, tabId, windowId, "test");
    reg.adopt(view, windowId);
    reg.markReady(view, "test");
    reg.activate(windowId, view, "test");
    return view;
}

describe("transition table", () => {
    it("lists every state, and destroyed is terminal", () => {
        expect(AllStates.sort()).toEqual(
            ["destroyed", "evicting", "failed", "hidden", "loading", "ready", "shown", "spare"].sort()
        );
        expect(TabViewTransitions.destroyed).toEqual([]);
        expect(TabViewTransitions.evicting).toEqual(["destroyed"]);
    });

    it("lets every live state be destroyed, by the host (evicting) or by its renderer going away", () => {
        for (const s of AllStates.filter((s) => s !== "destroyed" && s !== "evicting")) {
            expect(isAllowedTransition(s, "evicting")).toBe(true);
            expect(isAllowedTransition(s, "destroyed")).toBe(true);
        }
    });

    it("never goes back to spare, nor to loading from anything but spare", () => {
        for (const s of AllStates) {
            expect(isAllowedTransition(s, "spare")).toBe(false);
            expect(isAllowedTransition(s, "loading")).toBe(s === "spare");
        }
    });

    it("shows only a view that has a tab and a live renderer", () => {
        expect(AllStates.filter((s) => isAllowedTransition(s, "shown")).sort()).toEqual(["hidden", "loading", "ready"]);
    });
});

describe("tab view registry: lifecycle", () => {
    it("takes a view from spare to shown, then hidden when another is shown, then destroyed", () => {
        const { reg } = makeRegistry();
        const a = { name: "a" };
        reg.add(a);
        expect(reg.stateOf(a)).toBe("spare");
        expect(reg.windowOf(a)).toBeNull();
        reg.assign(a, "tab-a", "w1", "test");
        expect(reg.stateOf(a)).toBe("loading");
        expect(reg.viewForTab("tab-a")).toBe(a);
        expect(reg.windowViews("w1").size).toBe(0);
        reg.adopt(a, "w1");
        expect(reg.windowViews("w1").get("tab-a")).toBe(a);
        expect(reg.markReady(a, "test")).toBe("ready");
        expect(reg.activate("w1", a, "test")).toBeNull();
        expect(reg.stateOf(a)).toBe("shown");
        expect(reg.activeOf("w1")).toBe(a);

        const b = shownView(reg, "b", "tab-b");
        expect(reg.stateOf(a)).toBe("hidden");
        expect(reg.stateOf(b)).toBe("shown");
        expect(reg.activeOf("w1")).toBe(b);

        expect(reg.evict(a, "budget")).toBe(true);
        expect(reg.stateOf(a)).toBe("evicting");
        expect(reg.viewForTab("tab-a")).toBeNull();
        expect(reg.windowViews("w1").has("tab-a")).toBe(false);
        expect(reg.tabViews()).toEqual([b]);
        reg.destroyed(a, "renderer closed");
        expect(reg.has(a)).toBe(false);
        expect(reg.invalidCount).toBe(0);
    });

    it("keeps a view activated while loading (Wave's flow) loading, and shows it once rendered", () => {
        const { reg } = makeRegistry();
        const old = shownView(reg, "old", "tab-old");
        const fresh = { name: "fresh" };
        reg.add(fresh);
        reg.assign(fresh, "tab-new", "w1", "test");
        reg.adopt(fresh, "w1");
        expect(reg.activate("w1", fresh, "test")).toBe(old);
        expect(reg.stateOf(fresh)).toBe("loading");
        expect(reg.stateOf(old)).toBe("hidden");
        expect(reg.markReady(fresh, "test")).toBe("shown");
        expect(reg.invalidCount).toBe(0);
    });

    it("gives the window its previous view back when a view fails to load", () => {
        const { reg } = makeRegistry();
        const old = shownView(reg, "old", "tab-old");
        const fresh = { name: "fresh" };
        reg.add(fresh);
        reg.assign(fresh, "tab-new", "w1", "test");
        reg.adopt(fresh, "w1");
        reg.activate("w1", fresh, "test");
        reg.activate("w1", old, "restored");
        reg.fail(fresh, "readiness deadline");
        reg.evict(fresh, "failed view");
        expect(reg.stateOf(old)).toBe("shown");
        expect(reg.activeOf("w1")).toBe(old);
        expect(reg.stateOf(fresh)).toBe("evicting");
        expect(reg.invalidCount).toBe(0);
    });

    it("leaves the window without an active view when its active view goes", () => {
        const { reg } = makeRegistry();
        const a = shownView(reg, "a", "tab-a");
        reg.evict(a, "rebuild");
        expect(reg.activeOf("w1")).toBeNull();
        expect(reg.isActive(a)).toBe(false);
    });

    it("destroys idempotently", () => {
        const { reg } = makeRegistry();
        const spare = { name: "spare" };
        reg.add(spare);
        expect(reg.evict(spare, "wake")).toBe(true);
        expect(reg.evict(spare, "again")).toBe(false);
        reg.destroyed(spare, "closed");
        reg.destroyed(spare, "closed again");
        expect(reg.invalidCount).toBe(0);
    });

    it("takes any live view straight to destroyed when its renderer goes away by itself", () => {
        const { reg } = makeRegistry();
        const a = shownView(reg, "a", "tab-a");
        reg.destroyed(a, "renderer gone");
        expect(reg.has(a)).toBe(false);
        expect(reg.activeOf("w1")).toBeNull();
        expect(reg.invalidCount).toBe(0);
    });

    it("indexes the newest live view of a tab, and counts every live view with a tab", () => {
        const { reg } = makeRegistry();
        const older = shownView(reg, "older", "tab-a");
        reg.evict(older, "rebuild");
        const newer = shownView(reg, "newer", "tab-a");
        expect(reg.viewForTab("tab-a")).toBe(newer);
        const loading = { name: "loading" };
        reg.add(loading);
        reg.assign(loading, "tab-b", "w1", "test");
        const spare = { name: "spare" };
        reg.add(spare);
        expect(reg.tabViews()).toEqual([newer, loading]);
        expect(Array.from(reg.windowViews("w1").values())).toEqual([newer]);
    });

    it("keeps each window's views and active view apart", () => {
        const { reg } = makeRegistry();
        const a = shownView(reg, "a", "tab-a", "w1");
        const b = shownView(reg, "b", "tab-b", "w2");
        expect(reg.activeOf("w1")).toBe(a);
        expect(reg.activeOf("w2")).toBe(b);
        expect(reg.stateOf(a)).toBe("shown");
        expect(Array.from(reg.windowViews("w2").keys())).toEqual(["tab-b"]);
    });

    it("reports each view's state in a snapshot", () => {
        const { reg, tick } = makeRegistry();
        const a = shownView(reg, "a", "tab-a");
        tick(250);
        shownView(reg, "b", "tab-b");
        tick(50);
        expect(reg.snapshot()).toEqual([
            { tabId: "tab-a", windowId: "w1", state: "hidden", adopted: true, active: false, forMs: 50 },
            { tabId: "tab-b", windowId: "w1", state: "shown", adopted: true, active: true, forMs: 50 },
        ]);
        expect(reg.isActive(a)).toBe(false);
    });
});

describe("tab view registry: invalid transitions", () => {
    function cases(reg: TabViewRegistry<View>): [string, () => void][] {
        return [
            [
                "shows a spare",
                () => {
                    const v = { name: "spare" };
                    reg.add(v);
                    reg.activate("w1", v, "test");
                },
            ],
            [
                "loads a hidden view again",
                () => {
                    const a = shownView(reg, "a", "tab-a");
                    shownView(reg, "b", "tab-b");
                    reg.assign(a, "tab-a", "w1", "test");
                },
            ],
            [
                "shows a view being destroyed",
                () => {
                    const a = shownView(reg, "a", "tab-a");
                    reg.evict(a, "closed");
                    reg.activate("w1", a, "test");
                },
            ],
            [
                "shows a failed view",
                () => {
                    const v = { name: "v" };
                    reg.add(v);
                    reg.assign(v, "tab-v", "w1", "test");
                    reg.fail(v, "deadline");
                    reg.activate("w1", v, "test");
                },
            ],
            [
                "shows a destroyed view",
                () => {
                    const a = shownView(reg, "a", "tab-a");
                    reg.destroyed(a, "gone");
                    reg.activate("w1", a, "test");
                },
            ],
            [
                "fails a view that already rendered",
                () => {
                    const a = shownView(reg, "a", "tab-a");
                    reg.fail(a, "deadline");
                },
            ],
            [
                "shows a view in a window that does not own it",
                () => {
                    const a = shownView(reg, "a", "tab-a", "w1");
                    shownView(reg, "b", "tab-b", "w1");
                    reg.activate("w2", a, "test");
                },
            ],
            [
                "adopts a view into another window",
                () => {
                    const v = { name: "v" };
                    reg.add(v);
                    reg.assign(v, "tab-v", "w1", "test");
                    reg.adopt(v, "w2");
                },
            ],
            ["adds a view twice", () => reg.add(shownView(reg, "a", "tab-a"))],
        ];
    }

    it("throws when strict", () => {
        for (const [name, run] of cases(makeRegistry(true).reg)) {
            expect(run, name).toThrow(InvalidTabViewTransition);
        }
    });

    it("logs and applies when not strict", () => {
        const { reg, logs } = makeRegistry(false);
        const all = cases(reg);
        for (const [, run] of all) {
            expect(run).not.toThrow();
        }
        expect(reg.invalidCount).toBeGreaterThanOrEqual(all.length);
        expect(logs.every((l) => l.startsWith("[#461] invalid tab view "))).toBe(true);
        expect(logs.some((l) => l.includes("transition hidden → loading"))).toBe(true);
        expect(logs.some((l) => l.includes("owned by w1"))).toBe(true);
    });

    it("names the states, the reason and the tab in the error", () => {
        const { reg } = makeRegistry(true);
        const a = shownView(reg, "a", "tab-a");
        reg.evict(a, "budget");
        try {
            reg.activate("w1", a, "switch back");
            expect.unreachable();
        } catch (e) {
            expect(e).toBeInstanceOf(InvalidTabViewTransition);
            expect(e.from).toBe("evicting");
            expect(e.to).toBe("shown");
            expect(e.message).toBe("invalid tab view transition evicting → shown: switch back (tab tab-a, window w1)");
        }
    });
});
