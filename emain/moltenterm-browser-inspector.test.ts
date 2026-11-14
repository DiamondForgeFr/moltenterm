// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const Mocks = vi.hoisted(() => ({
    fromId: vi.fn(),
    on: vi.fn(),
    handle: vi.fn(),
    views: [] as any[],
}));

vi.mock("electron", () => {
    class WebContentsView {
        options: any;
        webContents: any;
        setBounds = vi.fn();
        setVisible = vi.fn();
        constructor(options: any) {
            this.options = options;
            const contents: any = new EventEmitter();
            let destroyed = false;
            Object.assign(contents, {
                id: 500 + Mocks.views.length,
                isDestroyed: () => destroyed,
                // Like Electron: closing destroys the contents, and the destroyed listeners run before the page's DevTools
                // hold is released.
                close: vi.fn(() => {
                    if (contents.holdClose) {
                        return;
                    }
                    destroyed = true;
                    contents.emit("destroyed");
                }),
                finishClose: () => {
                    destroyed = true;
                    contents.emit("destroyed");
                },
                focus: vi.fn(),
                setWindowOpenHandler: vi.fn(),
            });
            this.webContents = contents;
            Mocks.views.push(this);
        }
    }
    return {
        WebContentsView,
        webContents: { fromId: Mocks.fromId },
        ipcMain: { on: Mocks.on, handle: Mocks.handle, removeListener: vi.fn() },
    };
});

import { setKeyUtilPlatform } from "../frontend/util/keyutil";

type Fake = EventEmitter & Record<string, any>;

describe("the web page panel's docked developer tools (FR-BRW-022, DS-BRW-027)", () => {
    let inspector: typeof import("./moltenterm-browser-inspector");
    let host: Fake;
    let other: Fake;
    let page: Fake;
    let ses: Record<string, any>;
    let parent: { addChildView: Mock<(view: any) => void>; removeChildView: Mock<(view: any) => void> };
    let openLink: Mock<(url: string, host: any) => void>;

    const handler = (channel: string) => Mocks.handle.mock.calls.find(([c]) => c === channel)?.[1];
    const listener = (channel: string) => Mocks.on.mock.calls.find(([c]) => c === channel)?.[1];
    const from = (sender: Fake) => ({ sender, senderFrame: sender.mainFrame });
    const open = (pageId: unknown = 42, place: unknown = Place, point: unknown = null, sender = host) =>
        handler(inspector.InspectorOpenChannel)(from(sender), pageId, place, point);
    const close = (pageId = 42) => handler(inspector.InspectorCloseChannel)(from(host), pageId);
    const toWindow = (pageId = 42) => handler(inspector.InspectorWindowChannel)(from(host), pageId);
    const Place = { x: 10, y: 300, width: 640, height: 240, visible: true };

    function makeHost(id: number): Fake {
        return Object.assign(new EventEmitter(), {
            id,
            mainFrame: { url: "file:///fixture/index.html" },
            isDestroyed: () => false,
            getZoomFactor: () => 1.25,
            send: vi.fn(),
        });
    }

    beforeEach(async () => {
        vi.resetModules();
        vi.useFakeTimers();
        setKeyUtilPlatform("darwin");
        Mocks.on.mockReset();
        Mocks.handle.mockReset();
        Mocks.views.length = 0;
        host = makeHost(1);
        other = makeHost(2);
        ses = { id: "panel-session" };
        page = Object.assign(new EventEmitter(), {
            id: 42,
            hostWebContents: host,
            session: ses,
            isDestroyed: () => false,
            getType: () => "webview",
            getZoomFactor: () => 2,
            getURL: () => "http://127.0.0.1:5173/app?x=1",
            isDevToolsOpened: vi.fn(() => false),
            setDevToolsWebContents: vi.fn(),
            openDevTools: vi.fn(),
            closeDevTools: vi.fn(),
            inspectElement: vi.fn(),
            reload: vi.fn(),
        });
        const all = new Map<number, Fake>([
            [1, host],
            [2, other],
            [42, page],
        ]);
        Mocks.fromId.mockImplementation((id: number) => all.get(id));
        parent = { addChildView: vi.fn<(view: any) => void>(), removeChildView: vi.fn<(view: any) => void>() };
        openLink = vi.fn<(url: string, host: any) => void>();
        inspector = await import("./moltenterm-browser-inspector");
        const { configurePrivilegedIpc } = await import("./moltenterm-privileged-ipc");
        configurePrivilegedIpc(
            (event) => (event.sender === host || event.sender === other) && event.senderFrame != null
        );
        inspector.initMoltentermBrowserInspector({
            parentOf: (h) => (h === host ? parent : null),
            openLink,
            mac: true,
        });
    });

    afterEach(() => vi.useRealTimers());

    // The right-click's point is in the window's CSS pixels: Chromium hit-tests a guest in its embedder's coordinates,
    // so the window's zoom (1.25), not the page's (2), makes them DIP.
    it("docks the page's tools in a view of the asking window, on the clicked element", async () => {
        expect(await open(42, Place, { x: 960, y: 405 })).toBe(true);
        expect(Mocks.views).toHaveLength(1);
        const view = Mocks.views[0];
        expect(view.options.webPreferences).toMatchObject({ session: ses, sandbox: true, contextIsolation: true });
        expect(parent.addChildView).toHaveBeenCalledWith(view);
        expect(page.setDevToolsWebContents).toHaveBeenCalledWith(view.webContents);
        expect(page.openDevTools).toHaveBeenCalledWith({ mode: "detach", activate: false });
        expect(page.inspectElement).toHaveBeenCalledWith(1200, 506);
        expect(view.setBounds).toHaveBeenLastCalledWith({ x: 13, y: 375, width: 800, height: 300 });
        expect(view.setVisible).toHaveBeenLastCalledWith(true);
        expect(inspector.isInspected(42)).toBe(true);
        view.webContents.emit("did-finish-load");
        expect(view.webContents.focus).toHaveBeenCalled();
    });

    it("never docks a page of another window, an unknown page or for an unregistered caller", async () => {
        expect(await open(42, Place, null, other)).toBe(false);
        expect(await open(7)).toBe(false);
        expect(await open("42")).toBe(false);
        const stranger = makeHost(3);
        expect(() => open(42, Place, null, stranger)).toThrow("IPC caller not authorized");
        expect(Mocks.views).toHaveLength(0);
        expect(page.setDevToolsWebContents).not.toHaveBeenCalled();
    });

    it("selects another element in the tools it has instead of making a second view", async () => {
        await open(42, Place, { x: 1, y: 1 });
        await open(42, Place, { x: 400, y: 80 });
        expect(Mocks.views).toHaveLength(1);
        expect(page.inspectElement).toHaveBeenLastCalledWith(500, 100);
    });

    it("moves the tools from their window into the panel", async () => {
        page.isDevToolsOpened.mockReturnValue(true);
        await open();
        expect(page.closeDevTools).toHaveBeenCalled();
        expect(page.closeDevTools.mock.invocationCallOrder[0]).toBeLessThan(
            page.setDevToolsWebContents.mock.invocationCallOrder[0]
        );
    });

    it("places and hides the view as the window says, and only for the window that holds it", async () => {
        await open();
        const view = Mocks.views[0];
        const place = listener(inspector.InspectorPlaceChannel);
        place(from(host), 42, { x: 0, y: 0, width: 100, height: 100, visible: false });
        expect(view.setVisible).toHaveBeenLastCalledWith(false);
        place(from(other), 42, { x: 5, y: 5, width: 500, height: 500, visible: true });
        expect(view.setVisible).toHaveBeenLastCalledWith(false);
        place(from(host), 42, { x: 0, y: 0, width: "wide", height: 100, visible: true });
        expect(view.setVisible).toHaveBeenLastCalledWith(false);
    });

    it("closes: the view leaves the window and its contents go", async () => {
        await open();
        const view = Mocks.views[0];
        const done = close();
        await vi.advanceTimersByTimeAsync(0);
        expect(await done).toBe(true);
        expect(page.closeDevTools).toHaveBeenCalled();
        expect(parent.removeChildView).toHaveBeenCalledWith(view);
        expect(view.webContents.close).toHaveBeenCalled();
        expect(inspector.isInspected(42)).toBe(false);
    });

    it("sets the next view only once Electron let go of the last one", async () => {
        await open();
        const first = Mocks.views[0];
        first.webContents.holdClose = true;
        void close();
        const reopened = open();
        await vi.advanceTimersByTimeAsync(0);
        expect(Mocks.views).toHaveLength(1);
        first.webContents.finishClose();
        expect(Mocks.views).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(0);
        expect(await reopened).toBe(true);
        expect(Mocks.views).toHaveLength(2);
        expect(page.setDevToolsWebContents).toHaveBeenLastCalledWith(Mocks.views[1].webContents);
    });

    it("gives up rather than set a view while the last one never went", async () => {
        await open();
        Mocks.views[0].webContents.holdClose = true;
        void close();
        const reopened = open();
        await vi.advanceTimersByTimeAsync(10000);
        expect(await reopened).toBe(false);
        expect(Mocks.views).toHaveLength(1);
    });

    it("opens the separate window after the docked view went, as Electron needs", async () => {
        await open();
        const view = Mocks.views[0];
        view.webContents.holdClose = true;
        const opened = toWindow();
        await vi.advanceTimersByTimeAsync(0);
        expect(page.openDevTools).toHaveBeenCalledTimes(1);
        view.webContents.finishClose();
        await vi.advanceTimersByTimeAsync(0);
        expect(await opened).toBe(true);
        expect(page.openDevTools).toHaveBeenLastCalledWith({ mode: "detach", activate: true });
        expect(host.send).toHaveBeenCalledWith(inspector.InspectorGoneChannel, 42);
    });

    it("opens the separate window straight away when nothing is docked", async () => {
        const opened = toWindow();
        await vi.advanceTimersByTimeAsync(0);
        expect(await opened).toBe(true);
        expect(page.openDevTools).toHaveBeenCalledWith({ mode: "detach", activate: true });
        expect(await toWindow(7)).toBe(false);
    });

    it("leaves the tools their keys and sends back only the inspect toggle, with the page's id", async () => {
        await open();
        const contents = Mocks.views[0].webContents;
        const press = (input: any) => {
            const e = { preventDefault: vi.fn() };
            contents.emit("before-input-event", e, { type: "keyDown", control: false, shift: false, ...input });
            return e;
        };
        for (const input of [
            { key: "f", code: "KeyF", meta: true, alt: false },
            { key: "r", code: "KeyR", meta: true, alt: false },
            { key: "Escape", code: "Escape", meta: false, alt: false },
            { key: "[", code: "BracketLeft", meta: true, alt: false },
        ]) {
            expect(press(input).preventDefault, input.key).not.toHaveBeenCalled();
        }
        expect(host.send).not.toHaveBeenCalled();
        const toggle = press({ key: "ˆ", code: "KeyI", meta: true, alt: true });
        expect(toggle.preventDefault).toHaveBeenCalled();
        expect(host.send).toHaveBeenCalledWith("reinject-key", expect.objectContaining({ code: "KeyI" }), 42);
    });

    it("closes the tools with their page, and tells the window", async () => {
        await open();
        const view = Mocks.views[0];
        page.emit("destroyed");
        expect(view.webContents.close).toHaveBeenCalled();
        expect(host.send).toHaveBeenCalledWith(inspector.InspectorGoneChannel, 42);
        expect(inspector.isInspected(42)).toBe(false);
    });

    it("opens the web addresses the tools open beside the panel, and nothing else", async () => {
        await open();
        const contents = Mocks.views[0].webContents;
        const onOpen = contents.setWindowOpenHandler.mock.calls[0][0];
        expect(onOpen({ url: "https://example.test/doc" })).toEqual({ action: "deny" });
        expect(onOpen({ url: "javascript:alert(1)" })).toEqual({ action: "deny" });
        page.emit("devtools-open-url", {}, "http://localhost:3000/src.js");
        page.emit("devtools-open-url", {}, "file:///etc/hosts");
        expect(openLink.mock.calls.map(([url]) => url)).toEqual([
            "https://example.test/doc",
            "http://localhost:3000/src.js",
        ]);
        const nav = { preventDefault: vi.fn() };
        contents.emit("will-navigate", nav, "https://example.test/");
        expect(nav.preventDefault).toHaveBeenCalled();
    });
});

describe("clearing a page's data (FR-BRW-022 AC7, AC8)", () => {
    let inspector: typeof import("./moltenterm-browser-inspector");
    let host: Fake;
    let page: Fake;
    let ses: Record<string, any>;
    let jar: any[];
    const clear = (kind: unknown, origin?: unknown, pageId: unknown = 42) =>
        Mocks.handle.mock.calls.find(([c]) => c === inspector.ClearDataChannel)[1](
            { sender: host, senderFrame: host.mainFrame },
            pageId,
            kind,
            origin
        );

    beforeEach(async () => {
        vi.resetModules();
        Mocks.on.mockReset();
        Mocks.handle.mockReset();
        host = Object.assign(new EventEmitter(), { id: 1, mainFrame: {}, isDestroyed: () => false, send: vi.fn() });
        jar = [
            { name: "sid", domain: "127.0.0.1", hostOnly: true, path: "/" },
            { name: "deep", domain: "127.0.0.1", hostOnly: true, path: "/sub", secure: true },
            { name: "sid", domain: "localhost", hostOnly: true, path: "/" },
        ];
        ses = {
            clearStorageData: vi.fn(async () => {}),
            clearData: vi.fn(async () => {}),
            clearCache: vi.fn(async () => {}),
            cookies: {
                get: vi.fn(async (filter: any) =>
                    jar.filter((c) => (filter.name != null ? c.name === filter.name : c.domain === filter.domain))
                ),
                remove: vi.fn(async (url: string, name: string) => {
                    const h = new URL(url).hostname;
                    jar = jar.filter((c) => !(c.name === name && (c.domain === h || `.${h}`.endsWith(c.domain))));
                }),
                set: vi.fn(async () => {}),
            },
        };
        page = Object.assign(new EventEmitter(), {
            id: 42,
            hostWebContents: host,
            session: ses,
            isDestroyed: () => false,
            getType: () => "webview",
            getURL: vi.fn(() => "http://127.0.0.1:5173/app"),
            reload: vi.fn(),
        });
        Mocks.fromId.mockImplementation((id: number) => (id === 42 ? page : id === 1 ? host : null));
        inspector = await import("./moltenterm-browser-inspector");
        const { configurePrivilegedIpc } = await import("./moltenterm-privileged-ipc");
        configurePrivilegedIpc((event) => event.sender === host);
        inspector.initMoltentermBrowserInspector({ parentOf: () => null, openLink: vi.fn(), mac: true });
    });

    it("clears the confirmed origin's storage, cached files and own cookies, then reloads", async () => {
        expect(await clear("site", "http://127.0.0.1:5173")).toEqual({ ok: true });
        expect(ses.clearStorageData).toHaveBeenCalledWith({
            origin: "http://127.0.0.1:5173",
            storages: ["filesystem", "indexdb", "localstorage", "serviceworkers", "cachestorage"],
        });
        expect(ses.clearData).toHaveBeenCalledWith({ dataTypes: ["cache"], origins: ["http://127.0.0.1:5173"] });
        expect(ses.cookies.remove.mock.calls).toEqual([
            ["http://127.0.0.1/", "sid"],
            ["https://127.0.0.1/sub", "deep"],
        ]);
        expect(jar).toEqual([{ name: "sid", domain: "localhost", hostOnly: true, path: "/" }]);
        expect(ses.clearCache).not.toHaveBeenCalled();
        expect(page.reload).toHaveBeenCalled();
    });

    it("sets back a parent domain's cookie the removal took along", async () => {
        page.getURL.mockReturnValue("https://app.example.test/");
        const shared = { name: "sid", domain: ".example.test", hostOnly: false, path: "/", value: "sso", secure: true };
        jar = [{ name: "sid", domain: "app.example.test", hostOnly: true, path: "/", secure: true }, shared];
        expect(await clear("site", "https://app.example.test")).toEqual({ ok: true });
        expect(ses.cookies.set).toHaveBeenCalledWith(
            expect.objectContaining({
                name: "sid",
                domain: ".example.test",
                value: "sso",
                url: "https://example.test/",
            })
        );
    });

    it("clears nothing when the page moved to another origin, or is not a web page", async () => {
        expect(await clear("site", "http://localhost:5173")).toEqual({ ok: false, reason: "moved" });
        page.getURL.mockReturnValue("file:///tmp/page.html");
        expect(await clear("site", "file://")).toEqual({ ok: false, reason: "moved" });
        expect(ses.clearStorageData).not.toHaveBeenCalled();
        expect(ses.cookies.remove).not.toHaveBeenCalled();
        expect(page.reload).not.toHaveBeenCalled();
    });

    it("empties only the cache for Clear the browser cache, then reloads", async () => {
        expect(await clear("cache")).toEqual({ ok: true });
        expect(ses.clearCache).toHaveBeenCalled();
        expect(ses.clearStorageData).not.toHaveBeenCalled();
        expect(ses.cookies.remove).not.toHaveBeenCalled();
        expect(page.reload).toHaveBeenCalled();
    });

    it("refuses another page, an unknown kind, and reports a failure", async () => {
        expect(await clear("site", "http://127.0.0.1:5173", 9)).toEqual({ ok: false, reason: "gone" });
        expect(await clear("everything")).toMatchObject({ ok: false, reason: "failed" });
        ses.clearStorageData.mockRejectedValueOnce(new Error("storage busy"));
        expect(await clear("site", "http://127.0.0.1:5173")).toEqual({
            ok: false,
            reason: "failed",
            error: "storage busy",
        });
        expect(page.reload).not.toHaveBeenCalled();
    });
});

describe("the window's side of the channels", () => {
    it("is what the preload calls and listens on", () => {
        const preload = readFileSync(new URL("./preload.ts", import.meta.url), "utf8");
        for (const channel of [
            "moltenterm-inspector-open",
            "moltenterm-inspector-place",
            "moltenterm-inspector-close",
            "moltenterm-inspector-window",
            "moltenterm-browser-clear-data",
        ]) {
            expect(preload).toContain(`"${channel}"`);
        }
        expect(preload).toContain(`ipcRenderer.on("moltenterm-inspector-gone"`);
    });
});
