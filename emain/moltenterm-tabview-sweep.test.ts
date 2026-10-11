// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    makeTabViewSweeper,
    sweepDeletedTabViews,
    SweptTabView,
    SweptWindow,
    TabViewSweepDeps,
} from "./moltenterm-tabview-sweep";

type FakeView = SweptTabView & { destroyed: number };

function makeView(waveTabId: string, opts: { active?: boolean } = {}): FakeView {
    const view: FakeView = {
        waveTabId,
        isActiveTab: opts.active ?? false,
        isDestroyed: false,
        destroyed: 0,
        destroy() {
            view.destroyed++;
            view.isDestroyed = true;
        },
    };
    return view;
}

// Mirrors WaveBrowserWindow.removeTabView: refuses the active view unless forced, otherwise drops and destroys it.
function makeWindow(id: string, views: FakeView[]): SweptWindow<FakeView> & { removed: string[] } {
    const win = {
        waveWindowId: id,
        allLoadedTabViews: new Map(views.map((v) => [v.waveTabId, v])),
        removed: [] as string[],
        removeTabView(tabId: string, force: boolean) {
            const view = win.allLoadedTabViews.get(tabId);
            if (view == null || (!force && view.isActiveTab)) {
                return;
            }
            win.allLoadedTabViews.delete(tabId);
            win.removed.push(tabId);
            view.destroy();
        },
    };
    return win;
}

type Setup = {
    cache?: FakeView[];
    windows?: SweptWindow<FakeView>[];
    spare?: FakeView;
    existing: string[] | (() => Promise<Set<string>>);
};

function makeDeps(setup: Setup): TabViewSweepDeps<FakeView> & { asked: string[][] } {
    const deps = {
        asked: [] as string[][],
        cachedViews: () => (setup.cache ?? []).filter((v) => !v.isDestroyed),
        windows: () => setup.windows ?? [],
        isHotSpare: (view: FakeView) => view === setup.spare,
        existingTabIds: async (tabIds: string[]) => {
            deps.asked.push(tabIds);
            if (typeof setup.existing === "function") {
                return setup.existing();
            }
            return new Set(setup.existing);
        },
        log: () => {},
    };
    return deps;
}

describe("sweepDeletedTabViews", () => {
    it("destroys the hidden views of deleted tabs in every window and keeps the others", async () => {
        const a1 = makeView("a1", { active: true });
        const a2 = makeView("a2");
        const d1 = makeView("d1");
        const d2 = makeView("d2");
        const d3 = makeView("d3");
        const w1 = makeWindow("w1", [a1, a2, d1, d2]);
        const w2 = makeWindow("w2", [d3]);
        const deps = makeDeps({ cache: [a1, a2, d1, d2, d3], windows: [w1, w2], existing: ["a1", "a2"] });

        expect(await sweepDeletedTabViews("test", deps)).toBe(3);

        expect([d1, d2, d3].map((v) => v.destroyed)).toEqual([1, 1, 1]);
        expect(a2.destroyed).toBe(0);
        expect(w1.removed).toEqual(["d1", "d2"]);
        expect(w2.removed).toEqual(["d3"]);
        expect(Array.from(w1.allLoadedTabViews.keys())).toEqual(["a1", "a2"]);
    });

    it("never destroys the view on screen, even when its tab is gone", async () => {
        const gone = makeView("gone", { active: true });
        const deps = makeDeps({ cache: [gone], windows: [makeWindow("w", [gone])], existing: [] });

        expect(await sweepDeletedTabViews("test", deps)).toBe(0);
        expect(gone.destroyed).toBe(0);
        expect(deps.asked).toEqual([]);
    });

    it("never touches the hot spare or a view without a tab", async () => {
        const spare = makeView(null);
        const bare = makeView(null);
        const deps = makeDeps({ cache: [spare, bare], spare, existing: [] });

        expect(await sweepDeletedTabViews("test", deps)).toBe(0);
        expect(spare.destroyed + bare.destroyed).toBe(0);
    });

    it("destroys a view only the tab view cache holds (no window, e.g. a window closed meanwhile)", async () => {
        const orphan = makeView("orphan");
        const deps = makeDeps({ cache: [orphan], windows: [], existing: [] });

        expect(await sweepDeletedTabViews("test", deps)).toBe(1);
        expect(orphan.destroyed).toBe(1);
    });

    it("destroys nothing when the backend cannot tell which tabs exist", async () => {
        const v = makeView("t");
        const deps = makeDeps({
            cache: [v],
            windows: [makeWindow("w", [v])],
            existing: () => Promise.reject(new Error("rpc down")),
        });

        expect(await sweepDeletedTabViews("test", deps)).toBe(0);
        expect(v.destroyed).toBe(0);
    });

    it("keeps a view that came on screen while the backend answered", async () => {
        const v = makeView("t");
        const deps = makeDeps({
            cache: [v],
            windows: [makeWindow("w", [v])],
            existing: async () => {
                v.isActiveTab = true;
                return new Set<string>();
            },
        });

        expect(await sweepDeletedTabViews("test", deps)).toBe(0);
        expect(v.destroyed).toBe(0);
    });

    it("asks the backend once per sweep, for each tab once", async () => {
        const v = makeView("t");
        const deps = makeDeps({ cache: [v], windows: [makeWindow("w1", [v])], existing: ["t"] });

        await sweepDeletedTabViews("test", deps);

        expect(deps.asked).toEqual([["t"]]);
    });

    it("destroys a view the cache and another window hold under the same deleted tab", async () => {
        // the cache entry and a window's entry for one tab can differ (a view released from another window)
        const inWindow = makeView("t");
        const inCache = makeView("t");
        const w = makeWindow("w", [inWindow]);
        const deps = makeDeps({ cache: [inCache], windows: [w], existing: [] });

        expect(await sweepDeletedTabViews("test", deps)).toBe(2);
        expect(inWindow.destroyed).toBe(1);
        expect(inCache.destroyed).toBe(1);
    });
});

describe("makeTabViewSweeper", () => {
    it("runs one sweep at a time and folds the asks made meanwhile into one more sweep", async () => {
        let release: () => void;
        const gate = new Promise<void>((r) => {
            release = r;
        });
        const v = makeView("t");
        let calls = 0;
        const deps = makeDeps({
            cache: [v],
            existing: async () => {
                calls++;
                if (calls == 1) {
                    await gate;
                }
                return new Set<string>(["t"]);
            },
        });
        const sweep = makeTabViewSweeper(deps);

        const first = sweep("a");
        const second = sweep("b");
        const third = sweep("c");
        expect(second).toBe(third);
        release();
        await Promise.all([first, second, third]);

        expect(calls).toBe(2);
    });

    it("sweeps again after a failed sweep", async () => {
        let fail = true;
        const v = makeView("t");
        const deps = makeDeps({
            cache: [v],
            existing: async () => {
                if (fail) {
                    fail = false;
                    throw new Error("rpc down");
                }
                return new Set<string>();
            },
        });
        const sweep = makeTabViewSweeper(deps);

        expect(await sweep("a")).toBe(0);
        expect(await sweep("b")).toBe(1);
        expect(v.destroyed).toBe(1);
    });
});
