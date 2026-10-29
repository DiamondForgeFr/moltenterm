// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The temporary views as in Arc (FR-SHELL-080, #1253): no title; "+ New view" alone with no view; the separator,
// "+ New view" and the list with some; Clear closes only the temporary views, through the busy-close guard; Undo
// reopens them; Close the finished views stays in a temporary view's menu.

import { atoms, WOS } from "@/app/store/global";
import { initGlobalAtoms } from "@/app/store/global-atoms";
import { WaveEnvContext } from "@/app/waveenv/waveenv";
import { atom } from "jotai";
import fs from "node:fs";
import path from "node:path";
import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { RunningItem } from "../busy-close-model";
import en from "../i18n/locales/en.json";
import fr from "../i18n/locales/fr.json";
import { splitSidebarTabs } from "./sidebar-model";
import { showUndoToast } from "./sidebar-undo";
import {
    ClearDeps,
    clearingIds,
    clearTemporaryViews,
    ClearView,
    foldDelayMs,
    FoldMs,
    foldTotalMs,
} from "./temporary-clear";
import { planRowMotion } from "./temporary-views-motion";
import { closeFinishedItems } from "./view-menu";
import { showClosedViewsToast, ViewPins } from "./view-pins-store";
import { TemporaryViews } from "./workspace-sidebar";

vi.mock("@/util/fetchutil", () => ({ fetch: () => new Promise(() => {}) }));
vi.mock("./sidebar-undo", async (orig) => ({
    ...(await orig<typeof import("./sidebar-undo")>()),
    showUndoToast: vi.fn(() => "toast-1"),
}));

beforeAll(() => {
    initGlobalAtoms({ tabId: "tab-a", windowId: "win-a", clientId: "c", platform: "darwin" } as any);
});

// What a row reads from the environment: settings, the shared atoms and the object store.
const env = {
    getSettingsKeyAtom: () => atom(null),
    atoms,
    wos: WOS,
    showContextMenu: () => {},
};

function render(ids: string[]): string {
    return renderToStaticMarkup(
        <WaveEnvContext.Provider value={env as any}>
            <TemporaryViews ids={ids} activeTabId={null} asideRef={createRef<HTMLElement>()} />
        </WaveEnvContext.Provider>
    );
}

describe("the temporary section's layout (#1253)", () => {
    it("shows only + New view with no temporary view: no title, no separator, no Clear", () => {
        const html = render([]);
        expect(html).toContain('data-testid="sidebar-new-view"');
        expect(html).toContain('data-testid="sidebar-temporary-separator" data-shown="false" aria-hidden="true"');
        expect(html).toMatch(/data-testid="sidebar-temporary-clear"[^>]*disabled/);
        expect(html).not.toContain('data-testid="sidebar-view-row"');
        expect(html).not.toContain("Temporary views");
    });

    it("shows the separator, then + New view, then the list with one or more views", () => {
        for (const ids of [["tab-x"], ["tab-x", "tab-y", "tab-z"]]) {
            const html = render(ids);
            expect(html).toContain('data-testid="sidebar-temporary-separator" data-shown="true"');
            expect(html).not.toMatch(/data-testid="sidebar-temporary-clear"[^>]*disabled/);
            const sep = html.indexOf("sidebar-temporary-separator");
            const newView = html.indexOf("sidebar-new-view");
            const firstRow = html.indexOf('data-testid="sidebar-view-row"');
            expect(sep).toBeGreaterThan(-1);
            expect(newView).toBeGreaterThan(sep);
            expect(firstRow).toBeGreaterThan(newView);
            expect(html.match(/data-testid="sidebar-view-row"/g)).toHaveLength(ids.length);
            expect(html).not.toContain("Temporary views");
        }
    });

    it("ships Close all in en and fr, and no text for the removed title and button", () => {
        for (const dict of [en, fr] as any[]) {
            expect(dict.sidebar.temporary.closeAll).toBeTruthy();
            expect(dict.sidebar.temporary.title).toBeUndefined();
            expect(dict.sidebar.temporary.hint).toBeUndefined();
            expect(dict.sidebar.pins.closeFinishedTitle).toBeUndefined();
            expect(dict.shell.busy.clear.title).toBeTruthy();
        }
        expect(fr.sidebar.temporary.closeAll).toBe("Tout fermer");
        expect(en.sidebar.temporary.closeAll).toBe("Close all");
        expect(fr.sidebar.temporary.closedAll.other).toBe("{count} vues fermées · dans Vues rangées");
        expect(en.sidebar.temporary.closedAll.one).toBe("1 view closed · in Put-away views");
    });
});

// Away from the sidebar the line runs the full width; on hover it gives up Clear's measured width (#1268).
describe("the separator's line (#1268)", () => {
    const css = fs.readFileSync(path.join(__dirname, "temporary-views.css"), "utf8");
    const rule = (selector: string) => {
        const at = css.indexOf(`${selector} {`);
        expect(at, selector).toBeGreaterThanOrEqual(0);
        return css.slice(at, css.indexOf("}", at));
    };

    it("spans the whole separator, and Clear takes no room in the flow", () => {
        const line = rule(".mt-sb-tv-line");
        expect(line).toContain("left: 6px");
        expect(line).toContain("right: 2px");
        expect(line).toContain("clip-path: inset(0 0 0 0)");
        expect(rule(".mt-sb-tv-clear")).toContain("position: absolute");
    });

    it("shortens by Clear's width only on hover", () => {
        expect(
            rule(
                '.mt-sb:hover .mt-sb-tv-sep[data-shown="true"] .mt-sb-tv-line,\n.mt-sb-tv-sep[data-shown="true"]:focus-within .mt-sb-tv-line'
            )
        ).toContain("clip-path: inset(0 calc(var(--tv-clear-w, 0px) + 6px) 0 0)");
    });
});

const running: RunningItem[] = [{ blockId: "b-busy", kind: "command", label: "sleep 600" } as any];

function view(tabId: string, meta: Record<string, any> = { view: "term", controller: "shell" }): ClearView {
    return { tabId, blocks: [{ oid: `b-${tabId}`, meta } as Block] };
}

function makeDeps(over: Partial<ClearDeps> & { views?: Record<string, ClearView> } = {}) {
    const log: string[] = [];
    const views = over.views ?? {};
    const deps: ClearDeps = {
        workspaceId: "ws-1",
        ownTabId: "tile-1",
        temporary: [],
        loadView: async (id) => views[id] ?? view(id),
        busyEnabled: () => true,
        readRunning: async () => [],
        askBusy: vi.fn(async () => true),
        showSurvivor: vi.fn(async () => true),
        markClearing: async (ids) => void log.push(`mark:${ids.join(",")}`),
        endClearing: async () => void log.push("end"),
        wait: async (ms) => void log.push(`wait:${ms}`),
        reducedMotion: () => false,
        closeTab: vi.fn(async (_ws: string, id: string) => (log.push(`close:${id}`), true)),
        closeAsking: vi.fn(async (_ws: string, id: string) => (log.push(`ask:${id}`), true)),
        announce: async (n) => void log.push(`announce:${n}`),
        ...over,
    };
    return { deps, log };
}

describe("Clear (#1253)", () => {
    it("closes only the temporary views, never a pinned one", async () => {
        const ws = { tabids: ["tile-1", "tmp-1", "tmp-2"] };
        const tabs: Record<string, any> = { "tile-1": { meta: { "molten:pin": true } }, "tmp-1": {}, "tmp-2": {} };
        const split = splitSidebarTabs(ws, (id) => tabs[id], ["molten:pin"]);
        const { deps, log } = makeDeps({ temporary: split.temporary });
        expect(await clearTemporaryViews(deps)).toBe(2);
        expect(log).toEqual([
            "mark:tmp-1,tmp-2",
            `wait:${foldTotalMs(2)}`,
            "close:tmp-1",
            "close:tmp-2",
            "end",
            "announce:2",
        ]);
        expect(deps.closeTab).not.toHaveBeenCalledWith("ws-1", "tile-1");
    });

    it("asks once through the busy-close guard when a view runs something; Cancel closes nothing", async () => {
        const askBusy = vi.fn(async () => false);
        const { deps, log } = makeDeps({ temporary: ["tmp-1", "tmp-2"], readRunning: async () => running, askBusy });
        expect(await clearTemporaryViews(deps)).toBe(0);
        expect(askBusy).toHaveBeenCalledTimes(1);
        expect(askBusy).toHaveBeenCalledWith(running);
        expect(log).toEqual([]);
    });

    it("clears them all once the guard is answered Clear anyway", async () => {
        const { deps, log } = makeDeps({ temporary: ["tmp-1", "tmp-2"], readRunning: async () => running });
        expect(await clearTemporaryViews(deps)).toBe(2);
        expect(deps.askBusy).toHaveBeenCalledTimes(1);
        expect(log).toContain("close:tmp-1");
        expect(log).toContain("close:tmp-2");
    });

    it("asks nothing when nothing runs or the guard is off", async () => {
        const { deps } = makeDeps({ temporary: ["tmp-1"], busyEnabled: () => false, readRunning: async () => running });
        await clearTemporaryViews(deps);
        expect(deps.askBusy).not.toHaveBeenCalled();
    });

    it("brings a pinned view on screen first when the view on screen is cleared, and closes it last", async () => {
        const { deps, log } = makeDeps({ temporary: ["tmp-1", "tmp-2"], ownTabId: "tmp-1" });
        expect(await clearTemporaryViews(deps)).toBe(2);
        expect(deps.showSurvivor).toHaveBeenCalledWith(["tmp-1", "tmp-2"]);
        expect(log.slice(-2)).toEqual(["announce:2", "close:tmp-1"]);
    });

    it("keeps the view on screen when nothing else would stay", async () => {
        const { deps, log } = makeDeps({
            temporary: ["tmp-1", "tmp-2"],
            ownTabId: "tmp-1",
            showSurvivor: vi.fn(async () => false),
        });
        expect(await clearTemporaryViews(deps)).toBe(1);
        expect(log).not.toContain("close:tmp-1");
        expect(log[0]).toBe("mark:tmp-2");
    });

    it("lets a view linked to a worktree ask its own worktree dialog, without folding it first", async () => {
        const linked = view("tmp-wt", { view: "term", controller: "shell", "molten:worktree": "/tmp/wt" });
        const { deps, log } = makeDeps({ temporary: ["tmp-1", "tmp-wt"], views: { "tmp-wt": linked } });
        expect(await clearTemporaryViews(deps)).toBe(2);
        expect(log[0]).toBe("mark:tmp-1");
        expect(log).toContain("ask:tmp-wt");
        expect(log).not.toContain("close:tmp-wt");
    });

    it("does nothing without temporary views", async () => {
        const { deps, log } = makeDeps({ temporary: [] });
        expect(await clearTemporaryViews(deps)).toBe(0);
        expect(log).toEqual([]);
    });
});

describe("Undo of a Clear (#1253)", () => {
    beforeEach(() => {
        vi.mocked(showUndoToast).mockClear();
    });

    it("shows an undo toast (⌘Z) whose Undo reopens every cleared view through Reopen what was closed", async () => {
        const reopen = vi.fn(async () => ({ reopened: true }));
        showClosedViewsToast(3, "cleared", reopen);
        expect(showUndoToast).toHaveBeenCalledTimes(1);
        const [title, undo] = vi.mocked(showUndoToast).mock.calls[0];
        expect(title).toBe("3 views closed · in Put-away views");
        await undo();
        expect(reopen).toHaveBeenCalledTimes(3);
    });

    it("offers the same Undo after Cmd+W closes one view (#1345)", async () => {
        const reopen = vi.fn(async () => ({ reopened: true }));
        showClosedViewsToast(1, "view", reopen);
        expect(showUndoToast).toHaveBeenCalledTimes(1);
        const [title, undo] = vi.mocked(showUndoToast).mock.calls[0];
        expect(title).toBe("View closed · in Put-away views");
        await undo();
        expect(reopen).toHaveBeenCalledTimes(1);
    });
});

describe("Close the finished views stays reachable (#1253)", () => {
    it("is an item of a temporary view's menu while some view finished, and of no pinned view's", () => {
        const pins = ViewPins.getInstance();
        const closeFinished = vi.spyOn(pins, "closeFinished").mockResolvedValue();
        Object.defineProperty(pins, "finishedAtom", {
            value: { read: () => ["tmp-1", "tmp-2"] } as any,
            writable: true,
        });
        const temporary = {
            ref: { tabId: "tmp-1" },
            state: "temporary",
            modified: false,
            name: "x",
            icon: null,
            active: true,
        };
        const items = closeFinishedItems(temporary as any);
        expect(items).toHaveLength(1);
        expect(items[0].label).toBe("Close the 2 finished views");
        items[0].click();
        expect(closeFinished).toHaveBeenCalledTimes(1);
        expect(closeFinishedItems({ ...temporary, state: "workspace" } as any)).toEqual([]);
    });
});

describe("the section's motion (#1253)", () => {
    it("staggers the fold top first within 150 ms, and is immediate under reduced motion", () => {
        expect(foldDelayMs(0, 5)).toBe(0);
        expect(foldDelayMs(4, 5)).toBe(120);
        expect(foldDelayMs(9, 10)).toBeLessThanOrEqual(150);
        expect(foldTotalMs(5)).toBe(120 + FoldMs);
        expect(foldTotalMs(5)).toBeLessThanOrEqual(400);
        expect(foldTotalMs(5, true)).toBe(0);
    });

    it("folds only the rows of a fresh mark", () => {
        expect([...clearingIds({ ids: ["a", "b"], at: 1000, id: "x" }, 2000)]).toEqual(["a", "b"]);
        expect(clearingIds({ ids: ["a"], at: 1000, id: "x" }, 60_000).size).toBe(0);
        expect(clearingIds(null, 0).size).toBe(0);
    });

    it("slides a new row in and moves the rows below it, which close the gap of a closed one", () => {
        const before = new Map([
            ["a", 0],
            ["b", 31],
        ]);
        const added = planRowMotion(
            before,
            new Map([
                ["a", 0],
                ["n", 31],
                ["b", 62],
            ])
        );
        expect(added.entering).toEqual(["n"]);
        expect([...added.moves]).toEqual([["b", -31]]);
        const closed = planRowMotion(before, new Map([["b", 0]]));
        expect(closed.entering).toEqual([]);
        expect([...closed.moves]).toEqual([["b", 31]]);
    });
});
