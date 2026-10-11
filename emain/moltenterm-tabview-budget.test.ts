// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it } from "vitest";
import {
    beginShowingTabView,
    BudgetTabView,
    chooseTabViewsToEvict,
    DefaultHiddenTabViews,
    DefaultHiddenTabViewsMb,
    endShowingTabView,
    enforceTabViewBudget,
    hideParkedTabView,
    noteTabViewBudgetSettings,
    noteTabViewLeftScreenForBudget,
    noteTabViewWorkspace,
    readTabViewBudgetConfig,
    resetTabViewBudgetForTests,
    revealTabView,
    TabViewBudgetDeps,
    tabViewWorkspace,
} from "./moltenterm-tabview-budget";

type FakeView = BudgetTabView & {
    visible: boolean;
    getVisible(): boolean;
    setVisible(v: boolean): void;
    calls: boolean[];
    pinned?: boolean;
    page?: boolean;
    mem?: number;
};

const Now = 1_000_000;

function makeView(tabId: string, lastUsedTs: number, extra: Partial<FakeView> = {}): FakeView {
    const view: FakeView = {
        waveTabId: tabId,
        isActiveTab: false,
        isDestroyed: false,
        isWaveReady: true,
        lastUsedTs,
        visible: true,
        calls: [],
        getVisible: () => view.visible,
        setVisible: (v: boolean) => {
            view.calls.push(v);
            view.visible = v;
        },
        ...extra,
    };
    return view;
}

function makeDeps(views: FakeView[], spare: FakeView = null) {
    const evicted: string[] = [];
    const deps: TabViewBudgetDeps<FakeView> = {
        tabViews: () => views.filter((v) => !v.isDestroyed),
        isHotSpare: (v) => v === spare,
        isPinned: (v) => !!v.pinned,
        keepsPage: (v) => !!v.page,
        memoryMb: (vs) => new Map(vs.map((v) => [v, v.mem ?? 50])),
        evict: (v) => {
            evicted.push(v.waveTabId);
            v.isDestroyed = true;
        },
        log: () => {},
        now: () => Now,
    };
    return { deps, evicted };
}

beforeEach(() => {
    resetTabViewBudgetForTests();
});

describe("tab view budget settings (#454)", () => {
    it("defaults to on, 3 hidden views", () => {
        expect(readTabViewBudgetConfig(null)).toEqual({
            enabled: true,
            maxHidden: DefaultHiddenTabViews,
            maxHiddenMb: DefaultHiddenTabViewsMb,
        });
        expect(DefaultHiddenTabViews).toBe(3);
    });

    it("keeps the count within 1 to 10 and ignores invalid values", () => {
        expect(readTabViewBudgetConfig({ "moltenterm:hiddentabviews": 0 }).maxHidden).toBe(1);
        expect(readTabViewBudgetConfig({ "moltenterm:hiddentabviews": 50 }).maxHidden).toBe(10);
        expect(readTabViewBudgetConfig({ "moltenterm:hiddentabviews": 4.4 }).maxHidden).toBe(4);
        expect(readTabViewBudgetConfig({ "moltenterm:hiddentabviews": "5" }).maxHidden).toBe(3);
        expect(readTabViewBudgetConfig({ "moltenterm:hiddentabviewsmb": 10 }).maxHiddenMb).toBe(200);
    });

    it("is turned off only by false", () => {
        expect(readTabViewBudgetConfig({ "moltenterm:tabviewbudget": false }).enabled).toBe(false);
        expect(readTabViewBudgetConfig({ "moltenterm:tabviewbudget": true }).enabled).toBe(true);
    });
});

describe("real hiding (#454)", () => {
    it("hides a parked view once, and reveals it once", () => {
        const v = makeView("a", Now);
        expect(hideParkedTabView(v)).toBe(true);
        expect(hideParkedTabView(v)).toBe(false);
        expect(revealTabView(v)).toBe(true);
        expect(revealTabView(v)).toBe(false);
        expect(v.calls).toEqual([false, true]);
    });

    it("never hides a view being shown", () => {
        const v = makeView("a", Now);
        beginShowingTabView(v);
        expect(hideParkedTabView(v)).toBe(false);
        endShowingTabView(v);
        expect(hideParkedTabView(v)).toBe(true);
    });

    it("leaves views shown when the flag is off (previous behaviour), but still reveals a hidden one", () => {
        const v = makeView("a", Now);
        hideParkedTabView(v);
        noteTabViewBudgetSettings({ "moltenterm:tabviewbudget": false });
        const w = makeView("b", Now);
        expect(hideParkedTabView(w)).toBe(false);
        expect(w.calls).toEqual([]);
        expect(revealTabView(v)).toBe(true);
    });

    it("does nothing to a destroyed view", () => {
        const v = makeView("a", Now, { isDestroyed: true });
        expect(hideParkedTabView(v)).toBe(false);
        v.visible = false;
        expect(revealTabView(v)).toBe(false);
        expect(v.calls).toEqual([]);
    });
});

describe("choosing the views to evict (#454)", () => {
    const cfg = { enabled: true, maxHidden: 3, maxHiddenMb: 10000 };
    const cand = (name: string, ts: number, extra: Record<string, unknown> = {}) => ({
        view: name,
        lastUsedTs: ts,
        onScreen: false,
        pinned: false,
        busy: false,
        keepsPage: false,
        memoryMb: 50,
        ...extra,
    });

    it("evicts nothing within the budget", () => {
        expect(chooseTabViewsToEvict([cand("a", 1), cand("b", 2), cand("c", 3)], cfg)).toEqual([]);
    });

    it("evicts the least recently used past the budget", () => {
        const c = [cand("a", 5), cand("b", 1), cand("c", 3), cand("d", 4), cand("e", 2)];
        expect(chooseTabViewsToEvict(c, cfg)).toEqual(["b", "e"]);
    });

    it("never counts or evicts the views on screen", () => {
        const c = [cand("on", 0, { onScreen: true }), cand("a", 1), cand("b", 2), cand("c", 3)];
        expect(chooseTabViewsToEvict(c, cfg)).toEqual([]);
    });

    it("counts pinned and busy views within the budget but never evicts them", () => {
        const c = [cand("p", 0, { pinned: true }), cand("busy", 1, { busy: true }), cand("a", 2), cand("b", 3)];
        expect(chooseTabViewsToEvict(c, cfg)).toEqual(["a"]);
        const allPinned = [cand("p1", 0, { pinned: true }), cand("p2", 1, { pinned: true })];
        expect(
            chooseTabViewsToEvict([...allPinned, cand("p3", 2, { pinned: true }), cand("p4", 3, { pinned: true })], cfg)
        ).toEqual([]);
    });

    it("evicts views keeping a browser page after the others", () => {
        const c = [cand("page", 0, { keepsPage: true }), cand("a", 1), cand("b", 2), cand("c", 3), cand("d", 4)];
        expect(chooseTabViewsToEvict(c, cfg)).toEqual(["a", "b"]);
    });

    it("evicts past the memory budget even within the count", () => {
        const c = [cand("a", 1, { memoryMb: 300 }), cand("b", 2, { memoryMb: 300 })];
        expect(chooseTabViewsToEvict(c, { ...cfg, maxHiddenMb: 400 })).toEqual(["a"]);
    });

    it("evicts nothing when the budget is off", () => {
        const c = [cand("a", 1), cand("b", 2), cand("c", 3), cand("d", 4), cand("e", 5)];
        expect(chooseTabViewsToEvict(c, { ...cfg, enabled: false })).toEqual([]);
    });
});

describe("enforcing the budget (#454)", () => {
    function sixWorkspaces() {
        const active = makeView("active", Now - 100, { isActiveTab: true });
        const hidden = [1, 2, 3, 4, 5].map((i) => makeView("h" + i, Now - 100000 + i * 1000));
        return { active, hidden, all: [active, ...hidden] };
    }

    it("destroys the least recently used hidden views down to 3", () => {
        const { all } = sixWorkspaces();
        const { deps, evicted } = makeDeps(all);
        expect(enforceTabViewBudget(deps)).toBe(2);
        expect(evicted).toEqual(["h1", "h2"]);
    });

    it("never destroys the view on screen, the spare, a view being shown, a recent or a loading view", () => {
        const active = makeView("active", 0, { isActiveTab: true });
        const spare = makeView("spare", 0);
        const showing = makeView("showing", 0);
        const recent = makeView("recent", Now - 10);
        const loading = makeView("loading", 0, { isWaveReady: false });
        const old = [makeView("o1", 1), makeView("o2", 2)];
        beginShowingTabView(showing);
        const { deps, evicted } = makeDeps([active, spare, showing, recent, loading, ...old], spare);
        enforceTabViewBudget(deps);
        expect(evicted).toEqual(["o1", "o2"]);
    });

    it("keeps a view pinned for a working agent", () => {
        const { all, hidden } = sixWorkspaces();
        hidden[0].pinned = true;
        const { deps, evicted } = makeDeps(all);
        enforceTabViewBudget(deps);
        expect(evicted).toEqual(["h2", "h3"]);
    });

    it("destroys nothing when the flag is off (previous behaviour)", () => {
        noteTabViewBudgetSettings({ "moltenterm:tabviewbudget": false });
        const { all } = sixWorkspaces();
        const { deps, evicted } = makeDeps(all);
        expect(enforceTabViewBudget(deps)).toBe(0);
        expect(evicted).toEqual([]);
    });

    it("follows a smaller budget from the settings", () => {
        noteTabViewBudgetSettings({ "moltenterm:hiddentabviews": 1 });
        const { all } = sixWorkspaces();
        const { deps, evicted } = makeDeps(all);
        enforceTabViewBudget(deps);
        expect(evicted).toEqual(["h1", "h2", "h3", "h4"]);
    });

    it("counts a view as used until it left the screen", () => {
        const { all, hidden } = sixWorkspaces();
        const realNow = Date.now;
        Date.now = () => Now - 50000;
        try {
            noteTabViewLeftScreenForBudget(hidden[0]);
        } finally {
            Date.now = realNow;
        }
        const { deps, evicted } = makeDeps(all);
        enforceTabViewBudget(deps);
        expect(evicted).toEqual(["h2", "h3"]);
    });

    it("remembers the workspace a view was shown for", () => {
        const v = makeView("a", Now);
        noteTabViewWorkspace(v, "ws1");
        expect(tabViewWorkspace(v)).toBe("ws1");
        expect(tabViewWorkspace(makeView("b", Now))).toBe(null);
    });
});
