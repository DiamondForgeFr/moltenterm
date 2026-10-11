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
    faults = new Map<string, "throw" | "null">();

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
    // Renderers created while set never report "ready"; renderers never report "wave-ready" while set.
    silentBoot: false,
    silentRender: false,
    tabviewModule: null as any,
    scheduleBoot(wc: FakeWebContents) {
        const silent = h.silentBoot;
        setTimeout(() => {
            if (wc.destroyed || silent) {
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
                if (wc.destroyed || h.silentRender) {
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
    // Read once the current task has run, as a compositor would: a view moved on and off screen within one task is
    // never painted.
    recordScreen() {
        queueMicrotask(() => {
            const on = h.onScreen();
            const last = h.screen[h.screen.length - 1];
            if (last == null || last[1] !== on) {
                h.screen.push([Date.now(), on]);
            }
        });
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
    const ObjectService = {
        GetObject: (oref: string) =>
            backendCall(() => (b().tabs.has(oref.replace(/^tab:/, "")) ? { oid: oref } : null)),
    };
    // A fault set on a method applies to its next call only: it throws, or answers null.
    for (const svc of [WorkspaceService, WindowService, ObjectService] as Record<string, any>[]) {
        for (const name of Object.keys(svc)) {
            const real = svc[name];
            svc[name] = (...args: any[]) => {
                const fault = b().faults.get(name);
                if (fault == null) {
                    return real(...args);
                }
                b().faults.delete(name);
                return backendCall(() => {
                    if (fault === "throw") {
                        throw new Error(`injected failure of ${name}`);
                    }
                    return null;
                });
            };
        }
    }
    return { WorkspaceService, WindowService, ClientService, ObjectService };
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
    h.silentBoot = false;
    h.silentRender = false;
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
            getPrimaryDisplay: () => ({
                workArea: { x: 0, y: 0, width: 2000, height: 1200 },
                workAreaSize: { width: 2000, height: 1200 },
            }),
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
    const waveWindow = {
        oid: "win-1",
        workspaceid: ws.oid,
        pos: { x: 0, y: 0 },
        winsize: { width: 1200, height: 800 },
    };
    const created = mod.createBrowserWindow(
        waveWindow,
        { settings: {} },
        {
            unamePlatform: "darwin",
            isPrimaryStartupWindow: true,
        }
    );
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

function queueLength(): number {
    return win.actionQueue.length;
}

function backendWindowWs(): string {
    return h.backend.windows.get("win-1")?.workspaceid;
}

describe("window action queue: interleavings", () => {
    it.each([false, true])("create then delete within 10 ms (dev %s)", async (isDev) => {
        const starter = await setup({ isDev });
        await warmSpare();
        const t0 = Date.now();
        ipc("create-workspace");
        await vi.advanceTimersByTimeAsync(2);
        const created = h.backend.order.find((id) => id !== starter.oid);
        const createdTab = h.backend.workspaces.get(created).activetabid;
        await vi.advanceTimersByTimeAsync(8);
        ipc("delete-workspace", created);
        await vi.advanceTimersByTimeAsync(290);
        // Before #449: the new tab's renderer failed on the deleted tab ('reading layoutstate'), the queue waited 5 s,
        // the dead view was shown, then the window went back to the starter workspace and leaked the dead view.
        expect(queueLength()).toBe(0);
        expect(h.backend.workspaces.has(created)).toBe(false);
        expect(win.workspaceId).toBe(starter.oid);
        expect(backendWindowWs()).toBe(starter.oid);
        expect(h.onScreen()).toBe(starter.activetabid);
        await vi.advanceTimersByTimeAsync(8000);
        expect(h.rendererErrors).toEqual([]);
        expect(screenSince(t0).every((e) => e[1] === starter.activetabid)).toBe(true);
        expect(win.allLoadedTabViews.has(createdTab)).toBe(false);
        expect(liveTabViews()).not.toContain(createdTab);
        expect(h.onScreen()).toBe(starter.activetabid);
    });

    it("two switches within 10 ms land on the last one, the first is never shown", async () => {
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
        expect(backendWindowWs()).toBe(b.oid);
        // Before #449: the first switch ran to the end, so its view was shown before the second one.
        expect(screenSince(t0).some((e) => e[1] === a.activetabid)).toBe(false);
        expect(liveTabViews()).not.toContain(a.activetabid);
        expect(win.allLoadedTabViews.has(starter.activetabid)).toBe(true);
    });

    it("seven quick clicks across workspaces land on the last one and show nothing else", async () => {
        const starter = await setup();
        const targets = [1, 2, 3].map((i) => h.backend.addWorkspace(`W${i}`));
        await warmSpare();
        const t0 = Date.now();
        const clicks = [0, 1, 2, 0, 1, 2, 1];
        for (const i of clicks) {
            ipc("switch-workspace", targets[i].oid);
            await vi.advanceTimersByTimeAsync(3);
        }
        await vi.advanceTimersByTimeAsync(10000);
        const last = targets[clicks[clicks.length - 1]];
        expect(win.workspaceId).toBe(last.oid);
        expect(backendWindowWs()).toBe(last.oid);
        expect(h.onScreen()).toBe(last.activetabid);
        const shown = new Set(screenSince(t0).map((e) => e[1]));
        expect([...shown].filter((t) => t !== "" && t !== starter.activetabid)).toEqual([last.activetabid]);
        expect(queueLength()).toBe(0);
    });

    it("coming back to the workspace on screen cancels a switch under way", async () => {
        const starter = await setup();
        const a = h.backend.addWorkspace("A");
        await warmSpare();
        const t0 = Date.now();
        ipc("switch-workspace", a.oid);
        await vi.advanceTimersByTimeAsync(10);
        ipc("switch-workspace", starter.oid);
        await vi.advanceTimersByTimeAsync(2000);
        expect(win.workspaceId).toBe(starter.oid);
        expect(backendWindowWs()).toBe(starter.oid);
        expect(h.onScreen()).toBe(starter.activetabid);
        expect(screenSince(t0).every((e) => e[1] === starter.activetabid)).toBe(true);
        expect(liveTabViews()).not.toContain(a.activetabid);
    });

    it("workspaceId changes only once the new view is on screen", async () => {
        const starter = await setup();
        const a = h.backend.addWorkspace("A");
        await warmSpare();
        ipc("switch-workspace", a.oid);
        await vi.advanceTimersByTimeAsync(30);
        expect(backendWindowWs()).toBe(a.oid);
        expect(win.workspaceId).toBe(starter.oid);
        expect(h.onScreen()).toBe(starter.activetabid);
        await vi.advanceTimersByTimeAsync(500);
        expect(h.onScreen()).toBe(a.activetabid);
        expect(win.workspaceId).toBe(a.oid);
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
        expect(backendWindowWs()).toBe(other.oid);
    });

    it("a delete drops a pending switch to the workspace it deletes", async () => {
        const starter = await setup();
        const a = h.backend.addWorkspace("A");
        const b = h.backend.addWorkspace("B");
        await warmSpare();
        const t0 = Date.now();
        h.silentBoot = true;
        ipc("switch-workspace", a.oid);
        await vi.advanceTimersByTimeAsync(5);
        h.silentBoot = false;
        ipc("switch-workspace", b.oid);
        await vi.advanceTimersByTimeAsync(5);
        ipc("delete-workspace", b.oid);
        await vi.advanceTimersByTimeAsync(12000);
        expect(h.backend.workspaces.has(b.oid)).toBe(false);
        expect(screenSince(t0).some((e) => e[1] === b.activetabid)).toBe(false);
        expect(h.rendererErrors).toEqual([]);
        expect(win.workspaceId).toBe(starter.oid);
        expect(queueLength()).toBe(0);
    });
});

describe("window action queue: one readiness deadline", () => {
    it.each([
        [false, 10000],
        [true, 5000],
    ])("gives up on a view that never initializes at the deadline (dev %s, %i ms)", async (isDev, deadlineMs) => {
        const starter = await setup({ isDev });
        await warmSpare();
        const a = h.backend.addWorkspace("A");
        h.silentBoot = true;
        h.tabviewModule.discardHotSpareTab();
        h.tabviewModule.ensureHotSpareTab({ settings: {} });
        const t0 = Date.now();
        ipc("switch-workspace", a.oid);
        await vi.advanceTimersByTimeAsync(deadlineMs - 100);
        expect(queueLength()).toBe(1);
        await vi.advanceTimersByTimeAsync(200);
        // Before #449: 5 s for the spare, then 15 s for the fresh view (35 s and more with the init wait).
        expect(queueLength()).toBe(0);
        expect(Date.now() - t0).toBeLessThanOrEqual(deadlineMs + 100);
        expect(win.workspaceId).toBe(starter.oid);
        expect(backendWindowWs()).toBe(starter.oid);
        expect(h.onScreen()).toBe(starter.activetabid);
        expect(win.allLoadedTabViews.has(a.activetabid)).toBe(false);
        expect(liveTabViews()).not.toContain(a.activetabid);
        h.silentBoot = false;
        h.tabviewModule.discardHotSpareTab();
        await warmSpare();
        ipc("switch-workspace", a.oid);
        await vi.advanceTimersByTimeAsync(1000);
        expect(h.onScreen()).toBe(a.activetabid);
    });

    it("shows a view that initialized but did not report ready by the deadline (#68)", async () => {
        await setup();
        await warmSpare();
        const a = h.backend.addWorkspace("A");
        h.silentRender = true;
        const t0 = Date.now();
        ipc("switch-workspace", a.oid);
        await vi.advanceTimersByTimeAsync(9900);
        expect(h.onScreen()).not.toBe(a.activetabid);
        await vi.advanceTimersByTimeAsync(200);
        expect(h.onScreen()).toBe(a.activetabid);
        expect(win.workspaceId).toBe(a.oid);
        expect(screenSince(t0).find((e) => e[1] === a.activetabid)[0]).toBeLessThanOrEqual(10050);
    });

    it("drops a view whose tab was deleted meanwhile instead of showing it", async () => {
        const starter = await setup();
        await warmSpare();
        const a = h.backend.addWorkspace("A");
        h.silentRender = true;
        ipc("switch-workspace", a.oid);
        await vi.advanceTimersByTimeAsync(500);
        h.backend.tabs.delete(a.activetabid);
        await vi.advanceTimersByTimeAsync(10000);
        expect(h.onScreen()).toBe(starter.activetabid);
        expect(win.workspaceId).toBe(starter.oid);
        expect(backendWindowWs()).toBe(starter.oid);
        expect(liveTabViews()).not.toContain(a.activetabid);
    });
});

describe("window action queue: never stuck", () => {
    type Step = { name: string; method: string; fault: "throw" | "null"; act: () => Promise<void> };
    const steps: Step[] = [
        { name: "createtab", method: "CreateTab", fault: "throw", act: async () => ipc("create-tab") },
        { name: "createtab", method: "CreateTab", fault: "null", act: async () => ipc("create-tab") },
        {
            name: "switchtab",
            method: "SetActiveTab",
            fault: "throw",
            act: async () => {
                const ws = h.backend.workspaces.get(win.workspaceId);
                const tabId = h.backend.newId("tab-");
                h.backend.tabs.add(tabId);
                ws.tabids.push(tabId);
                ipc("set-active-tab", tabId);
            },
        },
        {
            name: "closetab",
            method: "CloseTab",
            fault: "null",
            act: async () => h.ipc.get("close-tab")(senderEvent(), win.workspaceId, win.activeTabView.waveTabId, false),
        },
        {
            name: "closetab",
            method: "CloseTab",
            fault: "throw",
            act: async () => h.ipc.get("close-tab")(senderEvent(), win.workspaceId, win.activeTabView.waveTabId, false),
        },
        {
            name: "switchworkspace",
            method: "SwitchWorkspace",
            fault: "null",
            act: async () => ipc("switch-workspace", h.backend.addWorkspace("X").oid),
        },
        {
            name: "switchworkspace",
            method: "SwitchWorkspace",
            fault: "throw",
            act: async () => ipc("switch-workspace", h.backend.addWorkspace("X").oid),
        },
        {
            name: "deleteworkspace",
            method: "GetWorkspace",
            fault: "throw",
            act: async () => win.queueDeleteWorkspace(win.workspaceId),
        },
        {
            name: "deleteworkspace",
            method: "DeleteWorkspace",
            fault: "throw",
            act: async () => win.queueDeleteWorkspace(h.backend.addWorkspace("X").oid),
        },
        {
            name: "deleteworkspace",
            method: "DeleteWorkspace",
            fault: "null",
            act: async () => win.queueDeleteWorkspace(win.workspaceId),
        },
        {
            name: "resetworkspace",
            method: "ResetWorkspace",
            fault: "throw",
            act: async () => win.queueResetWorkspace(),
        },
        { name: "resetworkspace", method: "GetWorkspace", fault: "throw", act: async () => win.queueResetWorkspace() },
    ];

    it.each(steps)("$name with $method answering $fault: the next action still runs", async (step) => {
        await setup();
        await warmSpare();
        const next = h.backend.addWorkspace("Next");
        h.backend.faults.set(step.method, step.fault);
        // The failing action is running when the next one is queued, then runs alone.
        const failing = step.act();
        await vi.advanceTimersByTimeAsync(0);
        ipc("switch-workspace", next.oid);
        await vi.advanceTimersByTimeAsync(3000);
        await failing;
        expect(queueLength()).toBe(0);
        if (!win.isDestroyed()) {
            ipc("switch-workspace", next.oid);
            await vi.advanceTimersByTimeAsync(3000);
            expect(win.workspaceId).toBe(next.oid);
            expect(h.onScreen()).toBe(next.activetabid);
        }
    });

    it("a switch the backend answers with nothing does not block the action queued behind it", async () => {
        const starter = await setup();
        const other = await addVisitedWorkspace();
        await warmSpare();
        h.backend.faults.set("SwitchWorkspace", "null");
        ipc("switch-workspace", starter.oid);
        await vi.advanceTimersByTimeAsync(3);
        ipc("create-tab");
        await vi.advanceTimersByTimeAsync(2000);
        // Before #449: the `return` inside processActionQueue left the next action in the queue for good, and every
        // later action queued behind it.
        expect(queueLength()).toBe(0);
        expect(win.workspaceId).toBe(other.oid);
        expect(h.backend.workspaces.get(other.oid).tabids).toHaveLength(2);
        expect(h.onScreen()).toBe(h.backend.workspaces.get(other.oid).activetabid);
        const third = h.backend.addWorkspace("Third");
        ipc("switch-workspace", third.oid);
        await vi.advanceTimersByTimeAsync(2000);
        expect(h.onScreen()).toBe(third.activetabid);
    });
});
