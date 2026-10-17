// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The tab view host (#461) at window level: the real emain-window.ts, emain-tabview.ts and host run against a fake
// backend, fake renderers and a fake electron (trimmed from moltenterm-window-queue.test.ts, which stays as the
// characterization of #449, #450 and #454). Times are virtual.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type FakeWs = { oid: string; name: string; icon: string; tabids: string[]; activetabid: string };

const BackendCallMs = 1;
const RendererBootMs = 300;
const RendererLoadMs = 20;
const RendererRenderMs = 60;

const h = {
    next: 1,
    workspaces: new Map<string, FakeWs>(),
    tabs: new Set<string>(),
    windowWs: "",
    activeTabCalls: [] as string[],
    windows: [] as any[],
    allViews: [] as any[],
    screen: [] as [number, string][],
    waveReadyAt: new Map<string, number>(),
    ipc: new Map<string, (...args: any[]) => any>(),
    settings: {} as Record<string, unknown>,
    silentBoot: false,
    silentRender: false,
    tabviewModule: null as any,
    hostModule: null as any,
    onScreen(): string {
        const win = h.windows[0];
        if (win == null) {
            return "";
        }
        return win.contentView.children
            .filter((c: any) => c.bounds.x === 0 && c.bounds.y === 0 && c.bounds.width > 0 && c.visible !== false)
            .map((c: any) => (c.moltenPendingView ? "(pending)" : c.waveTabId))
            .join(",");
    },
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

function newId(prefix: string) {
    return `${prefix}${h.next++}`;
}

function addWorkspace(name: string): FakeWs {
    const tabId = newId("tab-");
    const ws: FakeWs = { oid: newId("ws-"), name, icon: "icon", tabids: [tabId], activetabid: tabId };
    h.tabs.add(tabId);
    h.workspaces.set(ws.oid, ws);
    return ws;
}

class FakeWebContents {
    static nextId = 1;
    id = FakeWebContents.nextId++;
    destroyed = false;
    mainFrame = { url: "file:///fixture/index.html" };
    listeners = new Map<string, ((...args: any[]) => void)[]>();
    sent: { channel: string; args: any[] }[] = [];
    throttling = true;
    session = {};
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
        const silent = h.silentBoot;
        setTimeout(() => {
            if (this.destroyed || silent) {
                return;
            }
            const tv = h.tabviewModule.getWaveTabViewByWebContentsId(this.id);
            tv?.initResolve?.();
            if (tv?.savedInitOpts) {
                this.send("wave-init", tv.savedInitOpts);
            }
        }, RendererBootMs);
    }
    send(channel: string, ...args: any[]) {
        this.sent.push({ channel, args });
        if (channel !== "wave-init") {
            return;
        }
        setTimeout(() => {
            if (this.destroyed || h.silentRender) {
                return;
            }
            const tv = h.tabviewModule.getWaveTabViewByWebContentsId(this.id);
            h.waveReadyAt.set(args[0].tabId, Date.now());
            tv?.waveReadyResolve();
        }, RendererLoadMs + RendererRenderMs);
    }
    close() {
        if (this.destroyed) {
            return;
        }
        this.destroyed = true;
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
    executeJavaScript(): Promise<unknown> {
        return Promise.resolve(false);
    }
    setBackgroundThrottling(allowed: boolean) {
        this.throttling = allowed;
    }
    isDevToolsOpened() {
        return true;
    }
    openDevTools() {}
    setWindowOpenHandler() {}
}

class FakeWebContentsView {
    webContents = new FakeWebContents();
    bounds = { x: 0, y: 0, width: 0, height: 0 };
    visible = true;
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
    getContentBounds() {
        return { x: 0, y: 0, width: 1200, height: 800 };
    }
    getBounds() {
        return { x: 0, y: 0, width: 1200, height: 800 };
    }
}

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
    const ws = (id: string) => h.workspaces.get(id);
    return {
        WorkspaceService: {
            GetWorkspace: (id: string) => backendCall(() => (ws(id) ? structuredClone(ws(id)) : null)),
            ListWorkspaces: () =>
                backendCall(() =>
                    Array.from(h.workspaces.keys()).map((id) => ({
                        workspaceid: id,
                        windowid: id === h.windowWs ? "win-1" : "",
                    }))
                ),
            SetActiveTab: (wsId: string, tabId: string) =>
                backendCall(() => {
                    h.activeTabCalls.push(tabId);
                    ws(wsId).activetabid = tabId;
                }),
            CreateTab: (wsId: string) =>
                backendCall(() => {
                    const tabId = newId("tab-");
                    h.tabs.add(tabId);
                    ws(wsId).tabids.push(tabId);
                    ws(wsId).activetabid = tabId;
                    return tabId;
                }),
            CloseTab: (wsId: string, tabId: string) =>
                backendCall(() => {
                    const w = ws(wsId);
                    w.tabids = w.tabids.filter((t) => t !== tabId);
                    h.tabs.delete(tabId);
                    w.activetabid = w.tabids[0];
                    return { newactivetabid: w.activetabid };
                }),
        },
        WindowService: {
            SwitchWorkspace: (_winId: string, wsId: string) =>
                backendCall(() => {
                    if (h.windowWs === wsId) {
                        return null;
                    }
                    h.windowWs = wsId;
                    return structuredClone(ws(wsId));
                }),
            SetWindowPosAndSize: () => backendCall(() => null),
            CloseWindow: () => backendCall(() => null),
            CreateWindow: () => backendCall(() => null),
        },
        ClientService: {
            GetClientData: () => backendCall(() => ({ oid: "client-1" })),
            FocusWindow: () => backendCall(() => null),
        },
        ObjectService: {
            GetObject: (oref: string) =>
                backendCall(() => (h.tabs.has(oref.replace(/^tab:/, "")) ? { oid: oref } : null)),
        },
    };
}

let win: any;
let starter: FakeWs;
// The starter workspace's first tab (the fake backend changes the workspace's activetabid as tabs come).
let starterTab: string;

async function setup(settings: Record<string, unknown> = {}) {
    vi.resetModules();
    h.next = 1;
    h.workspaces = new Map();
    h.tabs = new Set();
    h.activeTabCalls = [];
    h.windows = [];
    h.allViews = [];
    h.screen = [];
    h.waveReadyAt = new Map();
    h.ipc = new Map();
    h.settings = settings;
    h.silentBoot = false;
    h.silentRender = false;
    const mod = await loadModules();
    h.tabviewModule.ensureHotSpareTab({ settings: h.settings });
    starter = addWorkspace("Starter");
    starterTab = starter.activetabid;
    h.windowWs = starter.oid;
    const created = mod.createBrowserWindow(
        { oid: "win-1", workspaceid: starter.oid, pos: { x: 0, y: 0 }, winsize: { width: 1200, height: 800 } },
        { settings: h.settings },
        { unamePlatform: "darwin", isPrimaryStartupWindow: true }
    );
    await vi.advanceTimersByTimeAsync(2000);
    win = await created;
    expect(h.onScreen()).toBe(starterTab);
}

async function loadModules(): Promise<any> {
    vi.doMock("electron", () => ({
        app: { getAppMetrics: (): any[] => [] },
        BaseWindow: FakeBaseWindow,
        WebContentsView: FakeWebContentsView,
        dialog: { showMessageBoxSync: () => 1 },
        globalShortcut: { register: () => true, unregisterAll: () => {} },
        ipcMain: {
            on: (ch: string, fn: any) => h.ipc.set(ch, fn),
            handle: (ch: string, fn: any) => h.ipc.set(ch, fn),
        },
        screen: {
            getPrimaryDisplay: () => ({ workAreaSize: { width: 2000, height: 1200 } }),
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
        isDev: false,
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
    vi.doMock("./authkey", () => ({ getTrustedAppSession: () => ({}), registerTrustedAppContents: () => {} }));
    vi.doMock("./moltenterm-browseragent", () => ({ hostsBrowserPage: () => false, hostsControlledTab: () => false }));
    vi.doMock("./moltenterm-webview-lifecycle", () => ({
        hostedPagesHaveUnsavedWork: async () => false,
        initMoltentermWebviewLifecycle: () => {},
        noteWebviewLifecycleSettings: () => {},
    }));
    vi.doMock("./moltenterm-popups", () => ({ attachWebviewWindowOpen: () => {} }));
    vi.doMock("./moltenterm-tabview-repaint", () => ({
        checkReusedTabViewPainted: () => {},
        noteTabViewLeftScreen: () => {},
    }));
    const { configurePrivilegedIpc } = await import("./moltenterm-privileged-ipc");
    configurePrivilegedIpc((event) => event.sender instanceof FakeWebContents && !event.sender.isDestroyed() &&
        event.senderFrame === event.sender.mainFrame);
    h.tabviewModule = await import("./emain-tabview");
    const mod: any = await import("./emain-window");
    h.hostModule = await import("./moltenterm-tabview-host");
    return mod;
}

// Loads the module graph once before the tests, under a generous bound that only limits a failing run: each test's
// setup() then re-evaluates modules already transformed, instead of the first test paying for that within its own
// 5 s timeout on a loaded machine (#651).
beforeAll(async () => {
    vi.useFakeTimers();
    try {
        await loadModules();
    } finally {
        vi.useRealTimers();
    }
}, 60_000);

function ipc(channel: string, ...args: any[]) {
    const sender = win.activeTabView.webContents;
    return h.ipc.get(channel)({ sender, senderFrame: sender.mainFrame }, ...args);
}

async function warmSpare() {
    h.tabviewModule.ensureHotSpareTab({ settings: h.settings });
    await vi.advanceTimersByTimeAsync(RendererBootMs + 50);
}

function pendingStates(view: any): any[] {
    return view.webContents.sent.filter((m: any) => m.channel === "moltenterm-view-pending").map((m: any) => m.args[0]);
}

function screenSince(t0: number): [number, string][] {
    return h.screen.filter((e) => e[0] >= t0).map((e) => [e[0] - t0, e[1]]);
}

function states(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const e of h.hostModule.tabViewHostSnapshot()) {
        out[e.tabId ?? "(spare)"] = e.state + (e.active ? " (active)" : "");
    }
    return out;
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("tab view host: a window's views", () => {
    it("is the one source of the window's views and active view, with one state per view", async () => {
        await setup();
        await warmSpare();
        expect(win.activeTabView.waveTabId).toBe(starterTab);
        expect(Array.from(win.allLoadedTabViews.keys())).toEqual([starterTab]);
        expect(states()).toEqual({ [starterTab]: "shown (active)", "(spare)": "spare" });
        expect(h.hostModule.invalidTabViewTransitions()).toBe(0);
    });

    it("hides the view left and shows the cached one at once on a tab switch", async () => {
        await setup();
        await warmSpare();
        ipc("create-tab");
        await vi.advanceTimersByTimeAsync(1000);
        const second = h.workspaces.get(starter.oid).activetabid;
        expect(h.onScreen()).toBe(second);
        const secondView = win.activeTabView;
        const sentBefore = pendingStates(secondView).length;
        const t0 = Date.now();
        ipc("set-active-tab", starterTab);
        await vi.advanceTimersByTimeAsync(500);
        expect(h.onScreen()).toBe(starterTab);
        expect(screenSince(t0)[0][0]).toBeLessThan(20);
        expect(pendingStates(secondView).length).toBe(sentBefore);
        expect(states()[starterTab]).toBe("shown (active)");
        expect(states()[second]).toBe("hidden");
    });
});

describe("tab view host: a new tab inside a workspace (#461, comment item 2)", () => {
    it("keeps the current tab on screen until the new tab has rendered, never its plain background", async () => {
        await setup();
        await warmSpare();
        const t0 = Date.now();
        ipc("create-tab");
        await vi.advanceTimersByTimeAsync(1000);
        const created = h.workspaces.get(starter.oid).activetabid;
        expect(h.onScreen()).toBe(created);
        const shownAt = screenSince(t0).find((e) => e[1] === created)[0] + t0;
        expect(shownAt).toBeGreaterThanOrEqual(h.waveReadyAt.get(created));
        expect(screenSince(t0).every((e) => e[1] === starterTab || e[1] === created)).toBe(true);
        expect(states()[created]).toBe("shown (active)");
        expect(states()[starterTab]).toBe("hidden");
        expect(h.hostModule.invalidTabViewTransitions()).toBe(0);
    });

    it("puts the new tab on screen while it loads with moltenterm:tabviewhost false (Wave's flow)", async () => {
        await setup({ "moltenterm:tabviewhost": false });
        await warmSpare();
        const t0 = Date.now();
        ipc("create-tab");
        await vi.advanceTimersByTimeAsync(1000);
        const created = h.workspaces.get(starter.oid).activetabid;
        expect(h.onScreen()).toBe(created);
        const firstOnScreen = screenSince(t0).find((e) => e[1].split(",").includes(created))[0] + t0;
        expect(firstOnScreen).toBeLessThan(h.waveReadyAt.get(created));
    });

    it("shows the pending state over the current tab when the new tab is slow, retries, then offers Reload", async () => {
        await setup();
        await warmSpare();
        h.silentBoot = true;
        h.tabviewModule.discardHotSpareTab();
        h.tabviewModule.ensureHotSpareTab({ settings: h.settings });
        const starterView = win.activeTabView;
        ipc("create-tab");
        await vi.advanceTimersByTimeAsync(200);
        expect(pendingStates(starterView)).toEqual([]);
        await vi.advanceTimersByTimeAsync(100);
        const created = h.workspaces.get(starter.oid).activetabid;
        expect(pendingStates(starterView)).toEqual([{ phase: "loading", workspaceName: "Starter" }]);
        expect(h.onScreen()).toBe(starterTab);
        await vi.advanceTimersByTimeAsync(10000);
        expect(pendingStates(starterView).at(-1)).toEqual({ phase: "retrying", workspaceName: "Starter" });
        await vi.advanceTimersByTimeAsync(10500);
        expect(pendingStates(starterView).at(-1)).toEqual({ phase: "failed", workspaceName: "Starter" });
        expect(h.onScreen()).toBe(starterTab);
        // the backend's active tab is taken back to the tab on screen
        expect(h.workspaces.get(starter.oid).activetabid).toBe(starterTab);
        expect(h.activeTabCalls).toEqual([starterTab]);
        h.silentBoot = false;
        h.tabviewModule.discardHotSpareTab();
        await warmSpare();
        h.ipc.get("moltenterm-view-pending-action")({ sender: starterView.webContents, senderFrame: starterView.webContents.mainFrame }, "reload");
        await vi.advanceTimersByTimeAsync(1000);
        expect(h.onScreen()).toBe(created);
        expect(h.workspaces.get(starter.oid).activetabid).toBe(created);
        expect(pendingStates(starterView).at(-1)).toBeNull();
        expect(h.hostModule.invalidTabViewTransitions()).toBe(0);
    });

    it("shows no pending state for a new tab that renders within the grace", async () => {
        await setup();
        await warmSpare();
        const starterView = win.activeTabView;
        const t0 = Date.now();
        ipc("create-tab");
        await vi.advanceTimersByTimeAsync(1000);
        const created = h.workspaces.get(starter.oid).activetabid;
        expect(pendingStates(starterView)).toEqual([]);
        expect(screenSince(t0).find((e) => e[1] === created)[0]).toBeLessThan(150);
    });

    it("shows a closed tab's successor once it has rendered when its view was not loaded", async () => {
        await setup();
        await warmSpare();
        ipc("create-tab");
        await vi.advanceTimersByTimeAsync(1000);
        const second = h.workspaces.get(starter.oid).activetabid;
        // the starter tab's view goes (as the budget or a wake would), then the tab on screen is closed
        win.removeTabView(starterTab, false);
        await warmSpare();
        const t0 = Date.now();
        h.ipc.get("close-tab")({ sender: win.activeTabView.webContents, senderFrame: win.activeTabView.webContents.mainFrame }, starter.oid, second, false);
        await vi.advanceTimersByTimeAsync(2000);
        expect(h.onScreen()).toBe(starterTab);
        expect(screenSince(t0).every((e) => e[1] === second || e[1] === starterTab)).toBe(true);
        expect(states()[second]).toBeUndefined();
    });

    it("never lets the wake refresh destroy the view its window is bringing on screen", async () => {
        await setup();
        await warmSpare();
        h.silentRender = true;
        ipc("create-tab");
        await vi.advanceTimersByTimeAsync(1500);
        const created = h.workspaces.get(starter.oid).activetabid;
        expect(states()[created]).toBe("loading");
        const kept = h.tabviewModule.clearTabCache();
        expect(kept.map((v: any) => v.waveTabId)).toContain(created);
        const view = h.allViews.find((v: any) => v.waveTabId === created);
        expect(view.webContents.destroyed).toBe(false);
        view.waveReadyResolve();
        await vi.advanceTimersByTimeAsync(1000);
        expect(h.onScreen()).toBe(created);
        expect(h.hostModule.invalidTabViewTransitions()).toBe(0);
    });
});
