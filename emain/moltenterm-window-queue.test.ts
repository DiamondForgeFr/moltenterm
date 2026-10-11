// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Characterization of a window's action queue (#449, FR-PERF-003): the real emain-window.ts and emain-tabview.ts run
// against a fake backend, fake tab view renderers and a fake electron. Times are virtual (fake timers).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type FakeWs = { oid: string; name: string; icon: string; tabids: string[]; activetabid: string };

const BackendCallMs = 1;
const RendererBootMs = 300;
const RendererLoadMs = 20;
const RendererRenderMs = 60;

class FakeBackend {
    workspaces = new Map<string, FakeWs>();
    order: string[] = [];
    tabs = new Set<string>();
    windows = new Map<string, { oid: string; workspaceid: string }>();
    next = 1;
    calls: string[] = [];
    switchReturnsNull = false;

    newId(prefix: string) {
        return `${prefix}${this.next++}`;
    }

    addWorkspace(name = "ws", icon = "icon"): FakeWs {
        const tabId = this.newId("tab-");
        const ws: FakeWs = { oid: this.newId("ws-"), name, icon, tabids: [tabId], activetabid: tabId };
        this.tabs.add(tabId);
        this.workspaces.set(ws.oid, ws);
        this.order.push(ws.oid);
        return ws;
    }

    getWs(id: string): FakeWs {
        const ws = this.workspaces.get(id);
        if (ws == null) {
            throw new Error(`workspace not found ${id}`);
        }
        return structuredClone(ws);
    }

    windowOf(wsId: string): string {
        for (const w of this.windows.values()) {
            if (w.workspaceid === wsId) {
                return w.oid;
            }
        }
        return "";
    }

    deleteWs(id: string, force: boolean): { deleted: boolean; claimable: string } {
        const ws = this.workspaces.get(id);
        if (ws == null) {
            return { deleted: true, claimable: "" };
        }
        if (!force && ws.name && ws.icon) {
            return { deleted: false, claimable: "" };
        }
        const list = this.order.slice();
        for (const t of ws.tabids) {
            this.tabs.delete(t);
        }
        this.workspaces.delete(id);
        this.order = this.order.filter((o) => o !== id);
        const winId = this.windowOf(id);
        if (winId === "") {
            return { deleted: true, claimable: "" };
        }
        let unclaimed = "";
        let findAfter = false;
        for (const wsId of list) {
            if (wsId === id) {
                if (unclaimed !== "") {
                    break;
                }
                findAfter = true;
                continue;
            }
            if (this.windowOf(wsId) === "") {
                unclaimed = wsId;
                if (findAfter) {
                    break;
                }
            }
        }
        if (unclaimed === "") {
            this.windows.delete(winId);
        }
        return { deleted: true, claimable: unclaimed };
    }
}

class FakeWebContents {
    static nextId = 1;
    id = FakeWebContents.nextId++;
    destroyed = false;
    listeners = new Map<string, ((...args: any[]) => void)[]>();
    sent: { channel: string; args: any[] }[] = [];

    on(ev: string, fn: (...args: any[]) => void) {
        this.listeners.set(ev, [...(this.listeners.get(ev) ?? []), fn]);
        return this;
    }

    emit(ev: string, ...args: any[]) {
        for (const fn of this.listeners.get(ev) ?? []) {
            fn(...args);
        }
    }

    loadURL() {}
    loadFile() {
        h.scheduleBoot(this);
    }
    send(channel: string, ...args: any[]) {
        this.sent.push({ channel, args });
        if (channel === "wave-init") {
            h.scheduleRender(this, args[0]);
        }
    }
    close() {
        if (this.destroyed) {
            return;
        }
        this.destroyed = true;
        h.closedRenderers.push(this.id);
        this.emit("destroyed");
    }
    isDestroyed() {
        return this.destroyed;
    }
    focus() {}
    isFocused() {
        return true;
    }
    isDevToolsOpened() {
        return true;
    }
    openDevTools() {}
    setWindowOpenHandler() {}
    session = {};
}

class FakeWebContentsView {
    webContents = new FakeWebContents();
    bounds = { x: 0, y: 0, width: 0, height: 0 };
    constructor(_opts: any) {
        h.allViews.push(this);
    }
    setBounds(b: any) {
        this.bounds = { ...b };
        h.recordScreen();
    }
    getBounds() {
        return { ...this.bounds };
    }
    setBackgroundColor() {}
}

class FakeBaseWindow {
    destroyed = false;
    visible = false;
    listeners = new Map<string, ((...args: any[]) => void)[]>();
    contentView = {
        children: [] as any[],
        addChildView: (v: any) => {
            this.contentView.children.push(v);
            h.recordScreen();
        },
        removeChildView: (v: any) => {
            this.contentView.children = this.contentView.children.filter((c) => c !== v);
            h.recordScreen();
        },
    };
    constructor(_opts: any) {
        h.windows.push(this);
    }
    on(ev: string, fn: (...args: any[]) => void) {
        this.listeners.set(ev, [...(this.listeners.get(ev) ?? []), fn]);
        return this;
    }
    once(ev: string, fn: (...args: any[]) => void) {
        return this.on(ev, fn);
    }
    isDestroyed() {
        return this.destroyed;
    }
    destroy() {
        this.destroyed = true;
    }
    close() {
        this.destroyed = true;
    }
    show() {
        this.visible = true;
    }
    isVisible() {
        return this.visible;
    }
    setMenu() {}
    setFullScreen() {}
    getContentBounds() {
        return { x: 0, y: 0, width: 1200, height: 800 };
    }
    getBounds() {
        return { x: 0, y: 0, width: 1200, height: 800 };
    }
}

// Harness state shared with the fakes above.
const h = {
    backend: null as FakeBackend,
    windows: [] as FakeBaseWindow[],
    allViews: [] as FakeWebContentsView[],
    closedRenderers: [] as number[],
    rendererErrors: [] as string[],
    screen: [] as [number, string][],
    ipc: new Map<string, (...args: any[]) => any>(),
    dialogs: [] as string[],
    isDev: false,
    tabviewModule: null as any,
    scheduleBoot(wc: FakeWebContents) {
        setTimeout(() => {
            if (wc.destroyed) {
                return;
            }
            const tv = h.tabviewModule.getWaveTabViewByWebContentsId(wc.id);
            if (tv?.initResolve == null) {
                return;
            }
            tv.initResolve();
            if (tv.savedInitOpts) {
                wc.send("wave-init", tv.savedInitOpts);
            }
        }, RendererBootMs);
    },
    scheduleRender(wc: FakeWebContents, opts: any) {
        setTimeout(() => {
            if (wc.destroyed) {
                return;
            }
            if (!h.backend.tabs.has(opts.tabId)) {
                h.rendererErrors.push(`Error in initialization ${opts.tabId}: reading 'layoutstate'`);
                return;
            }
            setTimeout(() => {
                if (wc.destroyed) {
                    return;
                }
                h.tabviewModule.getWaveTabViewByWebContentsId(wc.id)?.waveReadyResolve();
            }, RendererRenderMs);
        }, RendererLoadMs);
    },
    onScreen(): string {
        const win = h.windows[0];
        if (win == null) {
            return "";
        }
        return win.contentView.children
            .filter((c) => c.bounds.x === 0 && c.bounds.y === 0 && c.bounds.width > 0)
            .map((c) => c.waveTabId)
            .join(",");
    },
    recordScreen() {
        const on = h.onScreen();
        const last = h.screen[h.screen.length - 1];
        if (last == null || last[1] !== on) {
            h.screen.push([Date.now(), on]);
        }
    },
};

function backendCall<T>(fn: () => T): Promise<T> {
    return new Promise((resolve, reject) => {
        setTimeout(() => {
            try {
                resolve(fn());
            } catch (e) {
                reject(e);
            }
        }, BackendCallMs);
    });
}

function makeServices() {
    const b = () => h.backend;
    const WorkspaceService = {
        GetWorkspace: (id: string) => backendCall(() => (b().workspaces.has(id) ? b().getWs(id) : null)),
        ListWorkspaces: () =>
            backendCall(() => b().order.map((id) => ({ workspaceid: id, windowid: b().windowOf(id) }))),
        CanCloseWorkspace: (id: string) =>
            backendCall(() => {
                const shown = b().windowOf(id) !== "";
                return !shown || b().order.some((o) => o !== id && b().windowOf(o) === "");
            }),
        CreateWorkspace: () =>
            backendCall(() => {
                b().calls.push("CreateWorkspace");
                return b().addWorkspace("New Workspace").oid;
            }),
        DeleteWorkspace: (id: string) =>
            backendCall(() => {
                b().calls.push(`DeleteWorkspace ${id}`);
                return b().deleteWs(id, true).claimable;
            }),
        SetActiveTab: (wsId: string, tabId: string) =>
            backendCall(() => {
                const ws = b().workspaces.get(wsId);
                if (ws) {
                    ws.activetabid = tabId;
                }
            }),
        CreateTab: (wsId: string) =>
            backendCall(() => {
                const tabId = b().newId("tab-");
                b().tabs.add(tabId);
                const ws = b().workspaces.get(wsId);
                ws.tabids.push(tabId);
                ws.activetabid = tabId;
                return tabId;
            }),
        CloseTab: (wsId: string, tabId: string) =>
            backendCall(() => {
                const ws = b().workspaces.get(wsId);
                if (ws == null) {
                    return null;
                }
                ws.tabids = ws.tabids.filter((t) => t !== tabId);
                b().tabs.delete(tabId);
                if (ws.tabids.length === 0) {
                    return { closewindow: true };
                }
                ws.activetabid = ws.tabids[0];
                return { newactivetabid: ws.activetabid };
            }),
        ResetWorkspace: (wsId: string) =>
            backendCall(() => {
                const ws = b().workspaces.get(wsId);
                for (const t of ws.tabids) {
                    b().tabs.delete(t);
                }
                const tabId = b().newId("tab-");
                b().tabs.add(tabId);
                ws.tabids = [tabId];
                ws.activetabid = tabId;
                return tabId;
            }),
    };
    const WindowService = {
        GetWindow: (winId: string) => backendCall(() => structuredClone(b().windows.get(winId))),
        SwitchWorkspace: (winId: string, wsId: string) =>
            backendCall(() => {
                b().calls.push(`SwitchWorkspace ${wsId}`);
                const ws = b().getWs(wsId);
                if (b().switchReturnsNull) {
                    return null;
                }
                const win = b().windows.get(winId);
                const cur = win.workspaceid;
                if (cur === wsId) {
                    return null;
                }
                if (b().windowOf(wsId) !== "") {
                    return null;
                }
                win.workspaceid = wsId;
                b().deleteWs(cur, false);
                return ws;
            }),
        SetWindowPosAndSize: () => backendCall(() => null),
        CloseWindow: () => backendCall(() => null),
        CreateWindow: () => backendCall(() => null),
    };
    const ClientService = {
        GetClientData: () => backendCall(() => ({ oid: "client-1" })),
        FocusWindow: () => backendCall(() => null),
    };
    return { WorkspaceService, WindowService, ClientService, ObjectService: {} };
}

let win: any;
let mod: any;

async function setup(opts: { isDev?: boolean } = {}) {
    vi.resetModules();
    h.backend = new FakeBackend();
    h.windows = [];
    h.allViews = [];
    h.closedRenderers = [];
    h.rendererErrors = [];
    h.screen = [];
    h.ipc = new Map();
    h.dialogs = [];
    h.isDev = opts.isDev ?? false;
    vi.doMock("electron", () => ({
        BaseWindow: FakeBaseWindow,
        WebContentsView: FakeWebContentsView,
        dialog: {
            showMessageBoxSync: (_w: any, o: any) => {
                h.dialogs.push(o?.message);
                return 1;
            },
        },
        globalShortcut: { register: () => true, unregisterAll: () => {} },
        ipcMain: {
            on: (ch: string, fn: any) => h.ipc.set(ch, fn),
            handle: (ch: string, fn: any) => h.ipc.set(ch, fn),
        },
        screen: {
            getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 2000, height: 1200 } }],
            getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 2000, height: 1200 }, workAreaSize: { width: 2000, height: 1200 } }),
        },
        shell: { openExternal: () => {} },
    }));
    vi.doMock("@/app/store/services", () => makeServices());
    vi.doMock("@/app/store/wps", () => ({ waveEventSubscribeSingle: () => {} }));
    vi.doMock("@/app/store/wshclientapi", () => ({
        RpcApi: { GetFullConfigCommand: async () => ({ settings: {} }) },
    }));
    vi.doMock("emain/emain-events", () => ({ globalEvents: { emit: () => {}, on: () => {} } }));
    vi.doMock("./emain-activity", () => ({
        getGlobalIsQuitting: () => false,
        getGlobalIsRelaunching: () => false,
        setGlobalIsRelaunching: () => {},
        setWasActive: () => {},
        setWasInFg: () => {},
    }));
    vi.doMock("./emain-log", () => ({ log: () => {} }));
    vi.doMock("./emain-platform", () => ({
        getElectronAppBasePath: () => "/app",
        get isDev() {
            return h.isDev;
        },
        isDevVite: false,
        unamePlatform: "darwin",
    }));
    vi.doMock("./emain-util", () => ({
        delay: (ms: number) => new Promise((r) => setTimeout(r, ms)),
        ensureBoundsAreVisible: (b: any) => b,
        waveKeyToElectronKey: (k: string) => k,
        handleCtrlShiftFocus: () => {},
        handleCtrlShiftState: () => {},
        shNavHandler: () => {},
        shFrameNavHandler: () => {},
        increaseZoomLevel: () => {},
        decreaseZoomLevel: () => {},
        resetZoomLevel: () => {},
    }));
    vi.doMock("./emain-wsh", () => ({ ElectronWshClient: {} }));
    vi.doMock("./updater", () => ({ updater: null }));
    vi.doMock("./authkey", () => ({ configureAuthKeyRequestInjection: () => {} }));
    vi.doMock("./moltenterm-browseragent", () => ({
        hostsBrowserPage: () => false,
        hostsControlledTab: () => false,
    }));
    vi.doMock("./moltenterm-popups", () => ({ attachWebviewWindowOpen: () => {} }));
    vi.doMock("./moltenterm-tabview-repaint", () => ({
        checkReusedTabViewPainted: () => {},
        noteTabViewLeftScreen: () => {},
    }));
    h.tabviewModule = await import("./emain-tabview");
    mod = await import("./emain-window");
    const ws = h.backend.addWorkspace("Starter");
    h.backend.windows.set("win-1", { oid: "win-1", workspaceid: ws.oid });
    const waveWindow = { oid: "win-1", workspaceid: ws.oid, pos: { x: 0, y: 0 }, winsize: { width: 1200, height: 800 } };
    const created = mod.createBrowserWindow(waveWindow, { settings: {} }, {
        unamePlatform: "darwin",
        isPrimaryStartupWindow: true,
    });
    await vi.advanceTimersByTimeAsync(2000);
    win = await created;
    expect(h.onScreen()).toBe(ws.activetabid);
    return ws;
}

function senderEvent() {
    return { sender: { id: win.activeTabView.webContents.id } };
}

function ipc(channel: string, ...args: any[]) {
    return h.ipc.get(channel)(senderEvent(), ...args);
}

// Workspaces created ahead of a test, visited once so that their views are cached and warm.
async function addVisitedWorkspace(): Promise<FakeWs> {
    const ws = h.backend.addWorkspace("Other");
    ipc("switch-workspace", ws.oid);
    await vi.advanceTimersByTimeAsync(2000);
    return ws;
}

async function warmSpare() {
    h.tabviewModule.ensureHotSpareTab({ settings: {} });
    await vi.advanceTimersByTimeAsync(RendererBootMs + 50);
}

function liveTabViews(): string[] {
    return h.allViews.filter((v) => !v.webContents.destroyed).map((v: any) => v.waveTabId ?? "(spare)");
}

function screenSince(t0: number): [number, string][] {
    return h.screen.filter((e) => e[0] >= t0).map((e) => [e[0] - t0, e[1]]);
}

beforeEach(() => {
    vi.useFakeTimers();
    if (!process.env.MT_QUEUE_LOG) {
        vi.spyOn(console, "log").mockImplementation(() => {});
    }
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("window action queue: single operations", () => {
    it("creates a workspace and shows its tab", async () => {
        const starter = await setup();
        await warmSpare();
        const t0 = Date.now();
        ipc("create-workspace");
        await vi.advanceTimersByTimeAsync(1000);
        const created = h.backend.order.find((id) => id !== starter.oid);
        const tab = h.backend.workspaces.get(created).activetabid;
        expect(h.onScreen()).toBe(tab);
        expect(win.workspaceId).toBe(created);
        const shownAt = screenSince(t0).find((e) => e[1] === tab)[0];
        expect(shownAt).toBeLessThan(300);
        expect(h.rendererErrors).toEqual([]);
    });

    it("switches to a visited workspace and back", async () => {
        const starter = await setup();
        const other = await addVisitedWorkspace();
        expect(h.onScreen()).toBe(other.activetabid);
        const t0 = Date.now();
        ipc("switch-workspace", starter.oid);
        await vi.advanceTimersByTimeAsync(1000);
        expect(h.onScreen()).toBe(starter.activetabid);
        expect(win.workspaceId).toBe(starter.oid);
        expect(screenSince(t0).find((e) => e[1] === starter.activetabid)[0]).toBeLessThan(150);
    });

    it("deletes a workspace that is not on screen", async () => {
        const starter = await setup();
        const other = h.backend.addWorkspace("Other");
        ipc("delete-workspace", other.oid);
        await vi.advanceTimersByTimeAsync(1000);
        expect(h.backend.workspaces.has(other.oid)).toBe(false);
        expect(h.onScreen()).toBe(starter.activetabid);
        expect(win.workspaceId).toBe(starter.oid);
    });

    it("deletes the current workspace and lands on another one", async () => {
        const starter = await setup();
        const other = await addVisitedWorkspace();
        ipc("delete-workspace", other.oid);
        await vi.advanceTimersByTimeAsync(1000);
        expect(h.backend.workspaces.has(other.oid)).toBe(false);
        expect(win.workspaceId).toBe(starter.oid);
        expect(h.onScreen()).toBe(starter.activetabid);
        expect(h.backend.windows.get("win-1").workspaceid).toBe(starter.oid);
    });
});

describe("window action queue: interleavings", () => {
    it("create then delete within 10 ms", async () => {
        const starter = await setup();
        await warmSpare();
        const t0 = Date.now();
        ipc("create-workspace");
        await vi.advanceTimersByTimeAsync(2);
        const created = h.backend.order.find((id) => id !== starter.oid);
        const createdTab = h.backend.workspaces.get(created).activetabid;
        await vi.advanceTimersByTimeAsync(8);
        ipc("delete-workspace", created);
        await vi.advanceTimersByTimeAsync(8000);
        const screen = screenSince(t0);
        // Before #449: the new tab's renderer fails on the deleted tab, the queue waits 5 s, the dead view is shown,
        // then the window goes back to the starter workspace and the dead view is kept off-screen.
        expect(h.rendererErrors).toHaveLength(1);
        expect(screen.some((e) => e[1] === createdTab)).toBe(true);
        const back = screen.find((e) => e[0] > 0 && e[1] === starter.activetabid);
        expect(back[0]).toBeGreaterThanOrEqual(5000);
        expect(win.workspaceId).toBe(starter.oid);
        expect(h.onScreen()).toBe(starter.activetabid);
        expect(win.allLoadedTabViews.has(createdTab)).toBe(true);
    });

    it("two switches within 10 ms land on the last one", async () => {
        const starter = await setup();
        const a = h.backend.addWorkspace("A");
        const b = h.backend.addWorkspace("B");
        await warmSpare();
        const t0 = Date.now();
        ipc("switch-workspace", a.oid);
        await vi.advanceTimersByTimeAsync(10);
        ipc("switch-workspace", b.oid);
        await vi.advanceTimersByTimeAsync(5000);
        expect(win.workspaceId).toBe(b.oid);
        expect(h.onScreen()).toBe(b.activetabid);
        expect(h.backend.windows.get("win-1").workspaceid).toBe(b.oid);
        // Before #449: the first switch runs to the end, so its view is shown before the second one.
        expect(screenSince(t0).some((e) => e[1] === a.activetabid)).toBe(true);
        expect(starter).toBeTruthy();
    });

    it("delete of the current workspace while a switch to it is pending", async () => {
        const starter = await setup();
        const other = await addVisitedWorkspace();
        ipc("switch-workspace", starter.oid);
        await vi.advanceTimersByTimeAsync(2);
        ipc("delete-workspace", starter.oid);
        await vi.advanceTimersByTimeAsync(8000);
        expect(h.backend.workspaces.has(starter.oid)).toBe(false);
        expect(h.backend.workspaces.has(other.oid)).toBe(true);
        expect(win.workspaceId).toBe(other.oid);
        expect(h.onScreen()).toBe(other.activetabid);
    });
});

describe("window action queue: never stuck", () => {
    it("a switch the backend answers with nothing does not block the next action", async () => {
        const starter = await setup();
        const other = await addVisitedWorkspace();
        await warmSpare();
        h.backend.switchReturnsNull = true;
        ipc("switch-workspace", starter.oid);
        await vi.advanceTimersByTimeAsync(0);
        const third = h.backend.addWorkspace("Third");
        ipc("switch-workspace", third.oid);
        await vi.advanceTimersByTimeAsync(5);
        h.backend.switchReturnsNull = false;
        await vi.advanceTimersByTimeAsync(2000);
        // Before #449: the `return` inside processActionQueue leaves the second switch in the queue forever, and
        // every later action is queued behind it.
        expect(win.workspaceId).toBe(other.oid);
        ipc("create-tab");
        await vi.advanceTimersByTimeAsync(2000);
        expect(h.onScreen()).toBe(other.activetabid);
    });
});
