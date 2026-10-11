// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The close guard's decisions (FR-SHELL-061, DS-SHELL-107): what closes at once, what asks, and that one close never
// asks twice. The reader and the dialog are replaced by stubs; the worktree rule is the real one.

import { beforeEach, describe, expect, it, vi } from "vitest";

const app = vi.hoisted(() => ({
    objects: {} as Record<string, any>,
    inLayout: new Set<string>(),
    enabled: true,
    running: {} as Record<string, any[]>,
    readCalls: [] as string[][],
    asks: [] as any[],
    answer: true,
}));

vi.mock("@/app/store/wos", async () => {
    const { atom } = await import("jotai");
    return {
        makeORef: (otype: string, oid: string) => `${otype}:${oid}`,
        getWaveObjectAtom: (oref: string) => atom(() => app.objects[oref] ?? null),
        loadAndPinWaveObject: (oref: string) => Promise.resolve(app.objects[oref] ?? null),
    };
});
vi.mock("@/layout/index", async () => {
    const { atom } = await import("jotai");
    return {
        getLayoutModelForStaticTab: () => ({
            getNodeByBlockId: (blockId: string) => (app.inLayout.has(blockId) ? { id: `node-${blockId}` } : null),
            ephemeralNode: atom(null),
        }),
    };
});
vi.mock("./notifications-store", () => ({ registerNotificationGesture: () => () => {} }));
vi.mock("./worktree-store", () => ({
    removeWorktree: vi.fn(),
    resolveKeptWorktreeNotice: vi.fn(),
    worktreePlan: vi.fn(() => new Promise(() => {})),
}));
vi.mock("./busy-close", () => ({ BusyCloseHost: () => null, DangerButton: "danger", RunningList: () => null }));
vi.mock("./busy-close-store", () => ({
    busyCloseEnabled: () => app.enabled,
    busyDialogOpen: () => false,
    isTerminalMeta: (meta: any) => meta?.view === "term",
    closingTerminalOf: (block: any) => (block == null ? null : { blockId: block.oid, meta: block.meta }),
    readRunning: async (terminals: any[]) => {
        const ids = terminals.map((t) => t.blockId);
        app.readCalls.push(ids);
        return ids.flatMap((id) => app.running[id] ?? []);
    },
    askBusyClose: async (request: any) => {
        app.asks.push(request);
        return app.answer;
    },
}));

// A fresh guard per test: its approvals, answers and open dialogs live in the module.
let guard: typeof import("./worktree-close");
const interceptTerminalClose = (...args: Parameters<typeof guard.interceptTerminalClose>) =>
    guard.interceptTerminalClose(...args);
const closeTabAskingFirst = (...args: Parameters<typeof guard.closeTabAskingFirst>) =>
    guard.closeTabAskingFirst(...args);

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function block(id: string, meta: Record<string, any>) {
    app.objects[`block:${id}`] = { oid: id, meta };
    app.inLayout.add(id);
}

function busy(id: string, label = "cat") {
    app.running[id] = [{ blockId: id, kind: "command", label, tab: "api" }];
}

// A close function the way the call sites write them: it comes back through the guard.
function closer(id: string, action: "pane" | "replace" = "pane") {
    const closed: string[] = [];
    const close = () => {
        if (interceptTerminalClose(id, close, action)) {
            return;
        }
        closed.push(id);
    };
    return { close, closed };
}

beforeEach(async () => {
    vi.resetModules();
    guard = await import("./worktree-close");
    app.objects = {};
    app.inLayout = new Set();
    app.enabled = true;
    app.running = {};
    app.readCalls = [];
    app.asks = [];
    app.answer = true;
});

describe("closing a pane (FR-SHELL-061 AC1, AC2, AC4, AC6)", () => {
    it("lets a panel that is not a terminal close at once, without reading anything", () => {
        block("p1", { view: "preview" });
        expect(interceptTerminalClose("p1", () => {})).toBe(false);
        expect(app.readCalls).toEqual([]);
    });

    it("lets every terminal close at once when the setting is off", () => {
        app.enabled = false;
        block("b1", { view: "term" });
        busy("b1");
        expect(interceptTerminalClose("b1", () => {})).toBe(false);
        expect(app.readCalls).toEqual([]);
    });

    it("closes an idle terminal right after reading it, with no dialog", async () => {
        block("b1", { view: "term" });
        const { close, closed } = closer("b1");
        close();
        expect(closed).toEqual([]);
        await flush();
        expect(closed).toEqual(["b1"]);
        expect(app.asks).toEqual([]);
    });

    it("asks before closing a busy terminal and keeps it on Cancel", async () => {
        block("b1", { view: "term" });
        busy("b1", "npm run dev");
        app.answer = false;
        const { close, closed } = closer("b1");
        close();
        await flush();
        expect(app.asks).toHaveLength(1);
        expect(app.asks[0]).toMatchObject({ action: "pane", blockId: "b1" });
        expect(app.asks[0].running[0].label).toBe("npm run dev");
        expect(closed).toEqual([]);
    });

    it("closes once Close anyway is chosen, without asking again", async () => {
        block("b1", { view: "term" });
        busy("b1");
        const { close, closed } = closer("b1");
        close();
        await flush();
        expect(closed).toEqual(["b1"]);
        expect(app.asks).toHaveLength(1);
    });

    it("names the replace when Ctrl+Shift+X replaces a busy terminal", async () => {
        block("b1", { view: "term" });
        busy("b1");
        closer("b1", "replace").close();
        await flush();
        expect(app.asks[0].action).toBe("replace");
    });

    it("reads once when the same close is pressed again meanwhile", async () => {
        block("b1", { view: "term" });
        busy("b1");
        app.answer = false;
        const { close } = closer("b1");
        close();
        close();
        await flush();
        expect(app.readCalls).toEqual([["b1"]]);
        expect(app.asks).toHaveLength(1);
    });

    it("never closes a terminal that went while the dialog was open", async () => {
        block("b1", { view: "term" });
        busy("b1");
        const { close, closed } = closer("b1");
        close();
        app.inLayout.delete("b1");
        await flush();
        expect(closed).toEqual([]);
    });

    it("shows the worktree dialog instead of a second one when a worktree is linked (AC7)", async () => {
        block("b1", { view: "term", "molten:worktree": "/w/feat-42" });
        busy("b1");
        const { close, closed } = closer("b1");
        close();
        await flush();
        expect(app.asks).toEqual([]);
        expect(closed).toEqual([]);
    });
});

describe("closing a tab (FR-SHELL-061 AC3, AC8)", () => {
    function tab(id: string, blockIds: string[]) {
        app.objects[`tab:${id}`] = { oid: id, name: "T1", blockids: blockIds };
    }

    it("closes a tab where nothing runs as before, Electron's own confirmation included", async () => {
        block("b1", { view: "term" });
        tab("t1", ["b1"]);
        const closeTab = vi.fn(async () => true);
        expect(await closeTabAskingFirst(closeTab, "ws", "t1", true)).toBe(true);
        expect(closeTab).toHaveBeenCalledWith("ws", "t1", true);
        expect(app.asks).toEqual([]);
    });

    it("asks once for every terminal of the tab and skips Electron's confirmation after the answer", async () => {
        block("b1", { view: "term" });
        block("b2", { view: "term" });
        tab("t1", ["b1", "b2"]);
        busy("b1");
        busy("b2", "ssh host");
        const closeTab = vi.fn(async () => true);
        expect(await closeTabAskingFirst(closeTab, "ws", "t1", true)).toBe(true);
        expect(app.asks).toHaveLength(1);
        expect(app.asks[0]).toMatchObject({ action: "tab", tabId: "t1", tabName: "api" });
        expect(app.asks[0].running.map((r: any) => r.label)).toEqual(["cat", "ssh host"]);
        expect(closeTab).toHaveBeenCalledWith("ws", "t1", false);
    });

    it("keeps the tab on Cancel", async () => {
        block("b1", { view: "term" });
        tab("t1", ["b1"]);
        busy("b1");
        app.answer = false;
        const closeTab = vi.fn(async () => true);
        expect(await closeTabAskingFirst(closeTab, "ws", "t1", false)).toBe(false);
        expect(closeTab).not.toHaveBeenCalled();
    });

    it("does not ask again for the tab its last terminal's answer closes", async () => {
        block("b1", { view: "term" });
        tab("t1", ["b1"]);
        busy("b1");
        closer("b1").close();
        await flush();
        expect(app.asks).toHaveLength(1);
        const closeTab = vi.fn(async () => true);
        await closeTabAskingFirst(closeTab, "ws", "t1", true);
        expect(app.asks).toHaveLength(1);
        expect(app.readCalls.at(-1)).toEqual([]);
        expect(closeTab).toHaveBeenCalledWith("ws", "t1", false);
    });

    it("lets the tab close as before when the setting is off", async () => {
        app.enabled = false;
        block("b1", { view: "term" });
        tab("t1", ["b1"]);
        busy("b1");
        const closeTab = vi.fn(async () => true);
        await closeTabAskingFirst(closeTab, "ws", "t1", true);
        expect(app.asks).toEqual([]);
        expect(closeTab).toHaveBeenCalledWith("ws", "t1", true);
    });
});
