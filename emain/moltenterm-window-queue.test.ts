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
    sent: { channel: string; args: any[]; t: number }[] = [];

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
        this.sent.push({ channel, args, t: Date.now() });
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
    isCrashed() {
        return false;
    }
    getOSProcessId() {
        return 0;
    }
    // Chromium backgrounds a view's renderer while its throttling is allowed and it is not shown (#450).
    throttling = true;
    setBackgroundThrottling(allowed: boolean) {
        this.throttling = allowed;
    }
    getBackgroundThrottling() {
        return this.throttling;
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
    // A hidden view is not painted, wherever it is (#454).
    visible = true;
    setVisible(v: boolean) {
        this.visible = v;
        h.recordScreen();
    }
    getVisible() {
        return this.visible;
    }
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
    settings: {} as Record<string, unknown>,
    // Renderers created while set never report "ready"; renderers never report "wave-ready" while set.
    silentBoot: false,
    silentRender: false,
    tabviewModule: null as any,
    priorityModule: null as any,
    startup: null as Promise<any>,
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
            .filter((c) => c.bounds.x === 0 && c.bounds.y === 0 && c.bounds.width > 0 && c.visible !== false)
            .map((c) => (c.moltenPendingView ? "(pending)" : c.waveTabId))
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

async function setup(opts: { isDev?: boolean; settings?: Record<string, unknown>; silentStart?: boolean } = {}) {
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
    h.silentBoot = opts.silentStart ?? false;
    h.silentRender = false;
    h.settings = opts.settings ?? {};
    vi.doMock("electron", () => ({
        app: { getAppMetrics: (): any[] => [] },
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
        RpcApi: { GetFullConfigCommand: async () => ({ settings: h.settings }) },
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
    h.priorityModule = await import("./moltenterm-tabview-priority");
    h.tabviewModule.ensureHotSpareTab({ settings: h.settings });
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
        { settings: h.settings },
        {
            unamePlatform: "darwin",
            isPrimaryStartupWindow: true,
        }
    );
    if (opts.silentStart) {
        h.startup = created;
        return ws;
    }
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
    h.tabviewModule.ensureHotSpareTab({ settings: h.settings });
    await vi.advanceTimersByTimeAsync(RendererBootMs + 50);
}

function liveTabViews(): string[] {
    return h.allViews
        .filter((v: any) => !v.webContents.destroyed && !v.moltenPendingView)
        .map((v: any) => v.waveTabId ?? "(spare)");
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

    it("quick clicks while the spare is still booting reuse it instead of booting a renderer per click", async () => {
        await setup();
        const targets = [1, 2, 3].map((i) => h.backend.addWorkspace(`W${i}`));
        h.tabviewModule.discardHotSpareTab();
        h.tabviewModule.ensureHotSpareTab({ settings: h.settings });
        const viewsBefore = h.allViews.length;
        const clicks = [0, 1, 2, 0, 1, 2, 1];
        for (const i of clicks) {
            ipc("switch-workspace", targets[i].oid);
            await vi.advanceTimersByTimeAsync(30);
        }
        await vi.advanceTimersByTimeAsync(5000);
        const last = targets[clicks[clicks.length - 1]];
        expect(win.workspaceId).toBe(last.oid);
        expect(h.onScreen()).toBe(last.activetabid);
        // The spare taken by each superseded switch went back as the spare: one view for the target, one new spare.
        expect(h.allViews.length - viewsBefore).toBeLessThanOrEqual(2);
        expect(liveTabViews().filter((t) => targets.some((w) => w.activetabid === t))).toEqual([last.activetabid]);
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

function pendingMessages(view: any): [number, any][] {
    return view.webContents.sent
        .filter((m: any) => m.channel === "moltenterm-view-pending")
        .map((m: any) => [m.t, m.args[0]]);
}

function lastPending(view: any): any {
    const all = pendingMessages(view);
    return all.length === 0 ? undefined : all[all.length - 1][1];
}

function viewsForTab(tabId: string): any[] {
    return h.allViews.filter((v: any) => v.waveTabId === tabId);
}

function pendingAction(view: any, action: string) {
    h.ipc.get("moltenterm-view-pending-action")({ sender: { id: view.webContents.id } }, action);
}

describe("window action queue: one readiness deadline, one retry (#449, #450)", () => {
    it.each([
        [false, 10000],
        [true, 5000],
    ])(
        "keeps a view still loading at the deadline, retries once, then offers Reload (dev %s, %i ms)",
        async (isDev, deadlineMs) => {
            const starter = await setup({ isDev });
            await warmSpare();
            const a = h.backend.addWorkspace("A");
            h.silentBoot = true;
            h.tabviewModule.discardHotSpareTab();
            h.tabviewModule.ensureHotSpareTab({ settings: h.settings });
            const starterView = win.activeTabView;
            const t0 = Date.now();
            ipc("switch-workspace", a.oid);
            await vi.advanceTimersByTimeAsync(100);
            expect(lastPending(starterView)).toEqual({ phase: "loading", workspaceName: "A" });
            await vi.advanceTimersByTimeAsync(deadlineMs);
            // Before #450: the view was dropped at the deadline and nothing retried.
            expect(queueLength()).toBe(1);
            expect(lastPending(starterView)).toEqual({ phase: "retrying", workspaceName: "A" });
            expect(viewsForTab(a.activetabid).map((v) => v.webContents.destroyed)).toEqual([false]);
            expect(h.onScreen()).toBe(starter.activetabid);
            await vi.advanceTimersByTimeAsync(deadlineMs);
            expect(queueLength()).toBe(0);
            expect(Date.now() - t0).toBeLessThanOrEqual(2 * deadlineMs + 200);
            expect(win.workspaceId).toBe(starter.oid);
            expect(backendWindowWs()).toBe(starter.oid);
            expect(h.onScreen()).toBe(starter.activetabid);
            expect(lastPending(starterView)).toEqual({ phase: "failed", workspaceName: "A" });
            // One view for the tab the whole time: kept and retried, never destroyed and recreated before giving up.
            expect(viewsForTab(a.activetabid)).toHaveLength(1);
            expect(liveTabViews()).not.toContain(a.activetabid);
            h.silentBoot = false;
            h.tabviewModule.discardHotSpareTab();
            await warmSpare();
            pendingAction(starterView, "reload");
            await vi.advanceTimersByTimeAsync(1000);
            expect(h.onScreen()).toBe(a.activetabid);
            expect(win.workspaceId).toBe(a.oid);
            expect(lastPending(starterView)).toBeNull();
        }
    );

    it("shows a view that finishes booting during the retry, without recreating it", async () => {
        await setup();
        await warmSpare();
        const a = h.backend.addWorkspace("A");
        h.silentBoot = true;
        h.tabviewModule.discardHotSpareTab();
        h.tabviewModule.ensureHotSpareTab({ settings: h.settings });
        h.silentBoot = false;
        const starterView = win.activeTabView;
        ipc("switch-workspace", a.oid);
        await vi.advanceTimersByTimeAsync(12000);
        expect(lastPending(starterView)).toEqual({ phase: "retrying", workspaceName: "A" });
        const [view] = viewsForTab(a.activetabid);
        view.initResolve();
        await vi.advanceTimersByTimeAsync(500);
        expect(h.onScreen()).toBe(a.activetabid);
        expect(win.workspaceId).toBe(a.oid);
        expect(viewsForTab(a.activetabid)).toEqual([view]);
        expect(lastPending(starterView)).toBeNull();
    });

    it("dismisses a failed pending state and stays on the workspace on screen", async () => {
        const starter = await setup({ isDev: true });
        await warmSpare();
        const a = h.backend.addWorkspace("A");
        h.silentBoot = true;
        h.tabviewModule.discardHotSpareTab();
        h.tabviewModule.ensureHotSpareTab({ settings: h.settings });
        const starterView = win.activeTabView;
        ipc("switch-workspace", a.oid);
        await vi.advanceTimersByTimeAsync(10200);
        expect(lastPending(starterView)?.phase).toBe("failed");
        pendingAction(starterView, "dismiss");
        expect(lastPending(starterView)).toBeNull();
        expect(h.onScreen()).toBe(starter.activetabid);
    });

    it("shows a view that initialized but did not report ready after the retry (#68)", async () => {
        await setup();
        await warmSpare();
        const a = h.backend.addWorkspace("A");
        h.silentRender = true;
        const starterView = win.activeTabView;
        const t0 = Date.now();
        ipc("switch-workspace", a.oid);
        await vi.advanceTimersByTimeAsync(10100);
        expect(h.onScreen()).not.toBe(a.activetabid);
        expect(lastPending(starterView)?.phase).toBe("retrying");
        await vi.advanceTimersByTimeAsync(9800);
        expect(h.onScreen()).not.toBe(a.activetabid);
        await vi.advanceTimersByTimeAsync(300);
        expect(h.onScreen()).toBe(a.activetabid);
        expect(win.workspaceId).toBe(a.oid);
        expect(screenSince(t0).find((e) => e[1] === a.activetabid)[0]).toBeLessThanOrEqual(20200);
        expect(lastPending(starterView)).toBeNull();
    });

    it("drops a view whose tab was deleted meanwhile instead of showing it", async () => {
        const starter = await setup();
        await warmSpare();
        const a = h.backend.addWorkspace("A");
        h.silentRender = true;
        const starterView = win.activeTabView;
        ipc("switch-workspace", a.oid);
        await vi.advanceTimersByTimeAsync(500);
        h.backend.tabs.delete(a.activetabid);
        await vi.advanceTimersByTimeAsync(20500);
        expect(h.onScreen()).toBe(starter.activetabid);
        expect(win.workspaceId).toBe(starter.oid);
        expect(backendWindowWs()).toBe(starter.oid);
        expect(liveTabViews()).not.toContain(a.activetabid);
        // Not a readiness failure: no Reload is offered for a workspace that is gone.
        expect(lastPending(starterView)).toBeNull();
    });
});

describe("window pending state (#450)", () => {
    it("shows the pending state within 100 ms while a view loads and clears it when the view is on screen", async () => {
        await setup();
        const a = h.backend.addWorkspace("A");
        h.tabviewModule.discardHotSpareTab();
        const starterView = win.activeTabView;
        const t0 = Date.now();
        ipc("switch-workspace", a.oid);
        await vi.advanceTimersByTimeAsync(50);
        expect(pendingMessages(starterView)).toEqual([]);
        await vi.advanceTimersByTimeAsync(50);
        const [[shownAt, state]] = pendingMessages(starterView);
        expect(shownAt - t0).toBeLessThanOrEqual(100);
        expect(state).toEqual({ phase: "loading", workspaceName: "A" });
        await vi.advanceTimersByTimeAsync(1000);
        expect(h.onScreen()).toBe(a.activetabid);
        const clearedAt = pendingMessages(starterView).find((m) => m[1] == null)[0];
        const shownOnScreenAt = screenSince(t0).find((e) => e[1] === a.activetabid)[0] + t0;
        expect(clearedAt).toBeGreaterThanOrEqual(shownOnScreenAt);
        expect(clearedAt - shownOnScreenAt).toBeLessThan(20);
        // The view that was loading never draws the pending state of its own switch.
        expect(pendingMessages(win.activeTabView)).toEqual([]);
    });

    it("names the last workspace asked for when clicks come during a pending switch, and lands on it", async () => {
        const starter = await setup();
        const a = h.backend.addWorkspace("A");
        const b = h.backend.addWorkspace("B");
        h.tabviewModule.discardHotSpareTab();
        const starterView = win.activeTabView;
        const t0 = Date.now();
        ipc("switch-workspace", a.oid);
        await vi.advanceTimersByTimeAsync(150);
        expect(lastPending(starterView)).toEqual({ phase: "loading", workspaceName: "A" });
        ipc("switch-workspace", b.oid);
        await vi.advanceTimersByTimeAsync(20);
        expect(lastPending(starterView)).toEqual({ phase: "loading", workspaceName: "B" });
        // The pending state stays on screen between the two switches.
        const states = pendingMessages(starterView).map((m) => m[1]);
        expect(states.indexOf(null)).toBe(-1);
        await vi.advanceTimersByTimeAsync(3000);
        expect(win.workspaceId).toBe(b.oid);
        expect(h.onScreen()).toBe(b.activetabid);
        expect(screenSince(t0).some((e) => e[1] === a.activetabid)).toBe(false);
        expect(screenSince(t0).every((e) => e[1] === starter.activetabid || e[1] === b.activetabid)).toBe(true);
        expect(lastPending(starterView)).toBeNull();
    });

    it("a launch whose first tab is slow shows the pending page, never an empty window, and offers Reload", async () => {
        const ws = await setup({ silentStart: true });
        await vi.advanceTimersByTimeAsync(100);
        const w = h.windows[0];
        await vi.advanceTimersByTimeAsync(2800);
        expect(w.visible).toBe(false);
        await vi.advanceTimersByTimeAsync(200);
        expect(w.visible).toBe(true);
        expect(h.onScreen()).toBe("(pending)");
        const page: any = h.allViews.find((v: any) => v.moltenPendingView);
        expect(page.moltenPendingState).toBe("loading");
        await vi.advanceTimersByTimeAsync(7000);
        expect(page.moltenPendingState).toBe("retrying");
        await vi.advanceTimersByTimeAsync(10100);
        expect(page.moltenPendingState).toBe("failed");
        expect(h.onScreen()).toBe("(pending)");
        win = await h.startup;
        h.silentBoot = false;
        h.tabviewModule.discardHotSpareTab();
        await warmSpare();
        page.webContents.emit("will-navigate", { preventDefault: () => {} }, "moltenterm-pending://reload");
        await vi.advanceTimersByTimeAsync(1000);
        expect(h.onScreen()).toBe(ws.activetabid);
        expect(page.webContents.destroyed).toBe(true);
        // Once the window is visible it always shows the pending page or a tab, never nothing.
        expect(h.screen.filter((e) => e[0] >= 3000 && e[1] === "")).toEqual([]);
    });

    it("a launch whose first tab loads in time never shows the pending page", async () => {
        const ws = await setup();
        expect(h.allViews.some((v: any) => v.moltenPendingView)).toBe(false);
        expect(h.onScreen()).toBe(ws.activetabid);
    });
});

describe("tab view priority (#450, FR-PERF-004 AC1)", () => {
    // The newest view with no tab (a view taken for a tab gets its tab id only once acquired).
    function spare(): any {
        return h.allViews
            .filter((v: any) => v.waveTabId == null && !v.moltenPendingView && !v.webContents.destroyed)
            .pop();
    }

    it("raises the spare and the view being switched to, and restores the view once it is on screen", async () => {
        await setup();
        await warmSpare();
        expect(spare().webContents.throttling).toBe(false);
        expect(win.activeTabView.webContents.throttling).toBe(true);
        const a = h.backend.addWorkspace("A");
        ipc("switch-workspace", a.oid);
        await vi.advanceTimersByTimeAsync(30);
        const [view] = viewsForTab(a.activetabid);
        expect(view.webContents.throttling).toBe(false);
        await vi.advanceTimersByTimeAsync(1000);
        expect(h.onScreen()).toBe(a.activetabid);
        expect(view.webContents.throttling).toBe(true);
        expect(spare().webContents.throttling).toBe(false);
    });

    it("raises a cached view being switched back to for the time of the switch", async () => {
        const starter = await setup();
        await addVisitedWorkspace();
        const starterView = viewsForTab(starter.activetabid)[0];
        const seen: boolean[] = [];
        const orig = starterView.webContents.setBackgroundThrottling.bind(starterView.webContents);
        starterView.webContents.setBackgroundThrottling = (allowed: boolean) => {
            seen.push(allowed);
            orig(allowed);
        };
        ipc("switch-workspace", starter.oid);
        await vi.advanceTimersByTimeAsync(1000);
        expect(h.onScreen()).toBe(starter.activetabid);
        expect(seen).toEqual([false, true]);
    });

    it("a spare made while a view is being shown is raised only once that view is done", async () => {
        await setup();
        const a = h.backend.addWorkspace("A");
        h.tabviewModule.discardHotSpareTab();
        h.silentBoot = true;
        ipc("switch-workspace", a.oid);
        await vi.advanceTimersByTimeAsync(100);
        h.silentBoot = false;
        await vi.advanceTimersByTimeAsync(1000);
        expect(spare()).toBeDefined();
        expect(spare().webContents.throttling).toBe(true);
        await vi.advanceTimersByTimeAsync(20000);
        expect(queueLength()).toBe(0);
        expect(spare().webContents.throttling).toBe(false);
    });

    it("moltenterm:tabviewpriority false keeps Chromium's backgrounding", async () => {
        await setup({ settings: { "moltenterm:tabviewpriority": false } });
        await warmSpare();
        expect(spare().webContents.throttling).toBe(true);
        const a = h.backend.addWorkspace("A");
        ipc("switch-workspace", a.oid);
        await vi.advanceTimersByTimeAsync(30);
        expect(viewsForTab(a.activetabid)[0].webContents.throttling).toBe(true);
        await vi.advanceTimersByTimeAsync(1000);
        expect(h.onScreen()).toBe(a.activetabid);
        expect(h.allViews.every((v: any) => v.webContents.throttling)).toBe(true);
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

describe("hidden tab view budget (#454, FR-PERF-008)", () => {
    async function visitSixWorkspaces() {
        const starter = await setup();
        const others: FakeWs[] = [];
        for (let i = 0; i < 5; i++) {
            await warmSpare();
            others.push(await addVisitedWorkspace());
        }
        return { starter, others };
    }

    function liveViews(): any[] {
        return h.allViews.filter((v: any) => !v.webContents.destroyed && v.waveTabId != null);
    }

    it("keeps at most 3 hidden views, really hidden, and rebuilds an evicted workspace within 1 s", async () => {
        const { starter, others } = await visitSixWorkspaces();
        const onScreen = h.onScreen();
        expect(onScreen).toBe(others[4].activetabid);
        const hidden = liveViews().filter((v) => v.waveTabId !== onScreen);
        expect(hidden.map((v) => v.waveTabId).sort()).toEqual(
            [others[1].activetabid, others[2].activetabid, others[3].activetabid].sort()
        );
        expect(hidden.every((v) => v.visible === false)).toBe(true);
        expect(liveTabViews()).not.toContain(starter.activetabid);
        await warmSpare();
        const t0 = Date.now();
        ipc("switch-workspace", starter.oid);
        await vi.advanceTimersByTimeAsync(2000);
        expect(h.onScreen()).toBe(starter.activetabid);
        expect(screenSince(t0).find((e) => e[1] === starter.activetabid)[0]).toBeLessThan(1000);
        expect(h.rendererErrors).toEqual([]);
    });

    it("shows a cached hidden view again, visible and on screen", async () => {
        const { others } = await visitSixWorkspaces();
        const t0 = Date.now();
        ipc("switch-workspace", others[2].oid);
        await vi.advanceTimersByTimeAsync(1000);
        expect(h.onScreen()).toBe(others[2].activetabid);
        const view = liveViews().find((v) => v.waveTabId === others[2].activetabid);
        expect(view.visible).toBe(true);
        expect(screenSince(t0).find((e) => e[1] === others[2].activetabid)[0]).toBeLessThan(150);
    });

    it("restores the previous behaviour with moltenterm:tabviewbudget false", async () => {
        const starter = await setup();
        const budget = await import("./moltenterm-tabview-budget");
        budget.noteTabViewBudgetSettings({ "moltenterm:tabviewbudget": false });
        for (let i = 0; i < 5; i++) {
            await warmSpare();
            await addVisitedWorkspace();
        }
        const live = liveViews();
        expect(live.length).toBe(6);
        expect(live.every((v) => v.visible !== false)).toBe(true);
        expect(liveTabViews()).toContain(starter.activetabid);
    });
});
