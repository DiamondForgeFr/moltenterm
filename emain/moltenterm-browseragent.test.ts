// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const Mocks = vi.hoisted(() => ({ fromId: vi.fn(), on: vi.fn() }));
vi.mock("electron", () => ({ webContents: { fromId: Mocks.fromId }, ipcMain: { on: Mocks.on } }));
vi.mock("./authkey", () => ({ AuthKey: "test-auth-key" }));

const Token = createHmac("sha256", "test-auth-key").update("molten:browseragent").digest("hex");

describe("browser agent takeover and input", () => {
    let agent: typeof import("./moltenterm-browseragent");
    let wc: EventEmitter & Record<string, any>;
    let session: EventEmitter;
    const ev = () => ({ preventDefault: vi.fn() });
    const held = () => host.send.mock.calls.filter(([channel]: any[]) => channel === agent.UserInputHeldChannel).length;
    let ask: ReturnType<typeof vi.fn<(blockId: string, browserTabId: string, host: string) => Promise<boolean>>>;
    let input: (event: any, payload?: any) => any;
    let attached: boolean;
    let host: Record<string, any>;

    beforeEach(async () => {
        vi.resetModules();
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-10-07T12:00:00Z"));
        Mocks.on.mockReset();
        attached = false;
        session = new EventEmitter();
        host = { id: 1, mainFrame: { url: "file:///fixture/index.html" }, isDestroyed: () => false, send: vi.fn() };
        wc = Object.assign(new EventEmitter(), {
            id: 42,
            hostWebContents: host,
            mainFrame: { url: "https://example.com/login" },
            session,
            isDestroyed: () => false,
            getType: () => "webview",
            isDevToolsOpened: () => false,
            getZoomFactor: () => 1,
            getURL: () => "https://example.com/login",
            setBackgroundThrottling: vi.fn(),
            downloadURL: vi.fn(),
            debugger: {
                isAttached: () => attached,
                attach: vi.fn(() => {
                    attached = true;
                }),
                detach: vi.fn(() => {
                    attached = false;
                }),
                sendCommand: vi.fn(async () => ({})),
            },
        });
        Mocks.fromId.mockReturnValue(wc);
        agent = await import("./moltenterm-browseragent");
        const { configurePrivilegedIpc } = await import("./moltenterm-privileged-ipc");
        configurePrivilegedIpc((event) => event.sender === (host as any) && event.senderFrame === host.mainFrame);
        ask = vi.fn(async () => true);
        agent.initMoltentermBrowserAgent(ask);
        const register = Mocks.on.mock.calls.find(([channel]) => channel === agent.WebviewRegisteredChannel)[1];
        const inputHandler = Mocks.on.mock.calls.find(([channel]) => channel === agent.WebviewInputChannel)[1];
        input = (event, payload) => {
            const sent = { ...event, senderFrame: event.sender.mainFrame };
            inputHandler(sent, payload);
            return sent;
        };
        register({ sender: host, senderFrame: host.mainFrame }, "panel", "agent-tab", wc.id);
        agent.setBrowserAgentControl({ blockid: "panel", browsertabid: "agent-tab", controlled: true, token: Token });
    });

    afterEach(() => vi.useRealTimers());

    const call = (method = "Page.getNavigationHistory", params?: any) => ({
        blockid: "panel",
        browsertabid: "agent-tab",
        method,
        params,
        token: Token,
    });
    const press = (x: number, y: number) =>
        call("Input.dispatchMouseEvent", {
            type: "mousePressed",
            x,
            y,
            button: "left",
            buttons: 1,
            clickCount: 1,
            moltenhost: "example.com",
        });

    // #971: taking over is explicit; the user's click or key never reaches the page and never stops the agent.
    it("holds back the user's click and key, tells the window, and keeps the agent driving", async () => {
        const click = { preventDefault: vi.fn() };
        wc.emit("before-mouse-event", click, { type: "mouseDown", button: "left", x: 5, y: 5 });
        const key = { preventDefault: vi.fn() };
        wc.emit("before-input-event", key, { type: "keyDown", key: "a", code: "KeyA" });
        expect(click.preventDefault).toHaveBeenCalled();
        expect(key.preventDefault).toHaveBeenCalled();
        expect(held()).toBe(2);
        expect(host.send).toHaveBeenLastCalledWith(agent.UserInputHeldChannel, wc.id);
        await agent.runBrowserAgentCdp(call());
        expect(wc.debugger.sendCommand).toHaveBeenCalledWith("Page.getNavigationHistory", {});
    });

    it("answers the page's gate: the user's press is held back, the agent's goes through, other pages take all", async () => {
        const user = input({ sender: wc }, { type: "mousedown", button: 0, x: 300, y: 40 });
        expect(user.returnValue).toBe(false);
        expect(held()).toBe(1);
        wc.debugger.sendCommand.mockImplementation(async () => ({}));
        await agent.runBrowserAgentCdp(press(100, 200));
        const own = input({ sender: wc }, { type: "mousedown", button: 0, x: 100, y: 200 });
        expect(own.returnValue).toBe(true);
        agent.setBrowserAgentControl({ blockid: "panel", browsertabid: "agent-tab", controlled: false, token: Token });
        const free = input({ sender: wc }, { type: "keydown", key: "a", code: "KeyA" });
        expect(free.returnValue).toBe(true);
        expect(held()).toBe(1);
    });

    it("leaves scrolling, moves, key releases and the page's own frames free", () => {
        for (const [channel, data] of [
            ["before-mouse-event", { type: "mouseWheel", x: 5, y: 5, deltaY: 40 }],
            ["before-mouse-event", { type: "mouseMove", x: 5, y: 5 }],
            ["before-mouse-event", { type: "mouseUp", button: "left", x: 5, y: 5 }],
            ["before-input-event", { type: "keyUp", key: "a", code: "KeyA" }],
        ] as const) {
            const event = { preventDefault: vi.fn() };
            wc.emit(channel, event, data);
            expect(event.preventDefault).not.toHaveBeenCalled();
        }
        expect(held()).toBe(0);
    });

    it("lets the user's input through once control ends (Take over, Stop)", () => {
        agent.setBrowserAgentControl({ blockid: "panel", browsertabid: "agent-tab", controlled: false, token: Token });
        const click = { preventDefault: vi.fn() };
        wc.emit("before-mouse-event", click, { type: "mouseDown", button: "left", x: 5, y: 5 });
        expect(click.preventDefault).not.toHaveBeenCalled();
        expect(held()).toBe(0);
    });

    it("claims the agent's own press on both observers, once each", async () => {
        wc.debugger.sendCommand.mockImplementation(async (method: string) => {
            if (method.startsWith("Input.")) {
                wc.emit("before-mouse-event", ev(), { type: "mouseDown", button: "left", x: 100, y: 200 });
            }
            return {};
        });
        await agent.runBrowserAgentCdp(press(100, 200));
        input({ sender: wc }, { type: "mousedown", button: 0, x: 100, y: 200 });
        expect(held()).toBe(0);
        // The same click again is the user's: each dispatched press covers one press per observer.
        input({ sender: wc }, { type: "mousedown", button: 0, x: 100, y: 200 });
        expect(held()).toBe(1);
    });

    it("tells the window around the agent's press, so the page does not take the keyboard focus (#971)", async () => {
        wc.debugger.sendCommand.mockImplementation(async (method: string, params: any) => {
            if (method === "Input.dispatchMouseEvent" && params?.type === "mousePressed") {
                expect(host.send).toHaveBeenLastCalledWith(agent.AgentPressChannel, wc.id, true);
            }
            return {};
        });
        await agent.runBrowserAgentCdp(press(100, 200));
        expect(host.send).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(1000);
        expect(host.send).toHaveBeenLastCalledWith(agent.AgentPressChannel, wc.id, false);
        await agent.runBrowserAgentCdp(
            call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1, y: 1, moltenhost: "example.com" })
        );
        vi.advanceTimersByTime(1000);
        expect(host.send).toHaveBeenCalledTimes(2);
        expect(wc.debugger.sendCommand).toHaveBeenCalledWith("Emulation.setFocusEmulationEnabled", { enabled: true });
    });

    it("tells the user's click from the agent's while the agent is acting, with no time window", async () => {
        wc.debugger.sendCommand.mockImplementation(async (method: string) => {
            if (method.startsWith("Input.")) {
                wc.emit("before-mouse-event", ev(), { type: "mouseDown", button: "left", x: 600, y: 40 });
            }
            return {};
        });
        await agent.runBrowserAgentCdp(press(100, 200));
        expect(held()).toBe(1);
    });

    it("treats a preload report it cannot read as the user's", async () => {
        await agent.runBrowserAgentCdp(press(100, 200));
        input({ sender: wc }, { type: "mousedown" });
        expect(held()).toBe(1);
    });

    it("forgets an unclaimed entry after 2 s, so it never covers later input", async () => {
        await agent.runBrowserAgentCdp(press(100, 200));
        vi.advanceTimersByTime(2001);
        wc.emit("before-mouse-event", ev(), { type: "mouseDown", button: "left", x: 100, y: 200 });
        expect(held()).toBe(1);
    });

    it("keeps the agent's keys away from MoltenTerm's shortcuts, for every listener of the event", async () => {
        const event = { type: "keyDown", key: "w", code: "KeyW", meta: true };
        wc.debugger.sendCommand.mockImplementation(async (method: string) => {
            if (method.startsWith("Input.")) {
                wc.emit("before-input-event", ev(), event);
            }
            return {};
        });
        await agent.runBrowserAgentCdp(
            call("Input.dispatchKeyEvent", {
                type: "rawKeyDown",
                key: "w",
                code: "KeyW",
                windowsVirtualKeyCode: 87,
                modifiers: 4,
                moltenhost: "example.com",
            })
        );
        expect(held()).toBe(0);
        expect(agent.isAgentInput(wc.id, event as any)).toBe(true);
        const usersOwn = { type: "keyDown", key: "w", code: "KeyW", meta: true };
        expect(agent.isAgentInput(wc.id, usersOwn as any)).toBe(false);
    });

    it("sanitises input: clipboard commands and shortcuts are dropped, unknown events refused", async () => {
        await agent.runBrowserAgentCdp(
            call("Input.dispatchKeyEvent", {
                type: "rawKeyDown",
                key: "a",
                code: "KeyA",
                modifiers: 4,
                commands: ["paste", "selectAll"],
                autoRepeat: true,
                moltenhost: "example.com",
            })
        );
        const sent = wc.debugger.sendCommand.mock.calls.at(-1);
        expect(sent[1].commands).toEqual(["selectAll"]);
        expect(sent[1].autoRepeat).toBeUndefined();
        expect(sent[1].moltenhost).toBeUndefined();
        const calls = wc.debugger.sendCommand.mock.calls.length;
        await expect(
            agent.runBrowserAgentCdp(
                call("Input.dispatchKeyEvent", {
                    type: "rawKeyDown",
                    key: "v",
                    code: "KeyV",
                    modifiers: 2,
                    moltenhost: "example.com",
                })
            )
        ).rejects.toThrow("bad input parameters");
        await expect(
            agent.runBrowserAgentCdp(
                call("Input.dispatchMouseEvent", { type: "mouseDragStart", x: 1, y: 1, moltenhost: "example.com" })
            )
        ).rejects.toThrow("bad input parameters");
        expect(wc.debugger.sendCommand.mock.calls.length).toBe(calls);
    });

    it("refuses input once the tab shows another site than the action was planned on", async () => {
        await expect(
            agent.runBrowserAgentCdp(call("Input.insertText", { text: "secret", moltenhost: "other.example" }))
        ).rejects.toThrow("molten:site-changed");
        await expect(agent.runBrowserAgentCdp(call("Input.insertText", { text: "secret" }))).rejects.toThrow(
            "molten:site-changed"
        );
        expect(wc.debugger.sendCommand.mock.calls.filter(([method]: any[]) => method.startsWith("Input."))).toEqual([]);
        await agent.runBrowserAgentCdp(call("Input.insertText", { text: "ok", moltenhost: "example.com" }));
        expect(wc.debugger.sendCommand).toHaveBeenLastCalledWith("Input.insertText", { text: "ok" });
    });

    it("releases a button the agent holds when control ends", async () => {
        await agent.runBrowserAgentCdp(press(100, 200));
        agent.setBrowserAgentControl({ blockid: "panel", browsertabid: "agent-tab", controlled: false, token: Token });
        await vi.runAllTimersAsync();
        expect(wc.debugger.sendCommand).toHaveBeenLastCalledWith("Input.dispatchMouseEvent", {
            type: "mouseReleased",
            x: 100,
            y: 200,
            button: "left",
            buttons: 0,
            clickCount: 1,
        });
        expect(wc.debugger.detach).toHaveBeenCalled();
    });

    it("asks about one download of a tab at a time", async () => {
        let answer: (allow: boolean) => void;
        ask.mockImplementation(() => new Promise<boolean>((resolve) => (answer = resolve)));
        const item = { getURL: () => "https://files.example.com/a.zip" };
        for (let i = 0; i < 5; i++) {
            const e = { preventDefault: vi.fn() };
            session.emit("will-download", e, item, wc);
            expect(e.preventDefault).toHaveBeenCalled();
        }
        expect(ask).toHaveBeenCalledTimes(1);
        answer(false);
        await vi.runAllTimersAsync();
        session.emit("will-download", { preventDefault: vi.fn() }, item, wc);
        expect(ask).toHaveBeenCalledTimes(2);
    });

    it("clears the emulated viewport before detaching when control ends", async () => {
        await agent.runBrowserAgentCdp(
            call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true })
        );
        expect(wc.debugger.sendCommand).toHaveBeenLastCalledWith("Emulation.setDeviceMetricsOverride", {
            width: 390,
            height: 844,
            deviceScaleFactor: 0,
            mobile: false,
        });
        agent.setBrowserAgentControl({ blockid: "panel", browsertabid: "agent-tab", controlled: false, token: Token });
        await vi.runAllTimersAsync();
        expect(wc.debugger.sendCommand).toHaveBeenLastCalledWith("Emulation.clearDeviceMetricsOverride", {});
        expect(wc.debugger.detach).toHaveBeenCalled();
    });

    it("holds a download back until the user allows it, then lets it through once", async () => {
        const item = { getURL: () => "https://files.example.com/report.pdf?sig=SECRET" };
        const first = { preventDefault: vi.fn() };
        session.emit("will-download", first, item, wc);
        expect(first.preventDefault).toHaveBeenCalled();
        expect(ask).toHaveBeenCalledWith("panel", "agent-tab", "files.example.com");
        await vi.runAllTimersAsync();
        expect(wc.downloadURL).toHaveBeenCalledWith("https://files.example.com/report.pdf?sig=SECRET");
        const again = { preventDefault: vi.fn() };
        session.emit("will-download", again, item, wc);
        expect(again.preventDefault).not.toHaveBeenCalled();
        const third = { preventDefault: vi.fn() };
        session.emit("will-download", third, item, wc);
        expect(third.preventDefault).toHaveBeenCalled();
    });

    it("cancels a download the user denies, and leaves tabs under no control alone", async () => {
        ask.mockResolvedValue(false);
        const item = { getURL: () => "https://files.example.com/a.zip" };
        const denied = { preventDefault: vi.fn() };
        session.emit("will-download", denied, item, wc);
        await vi.runAllTimersAsync();
        expect(denied.preventDefault).toHaveBeenCalled();
        expect(wc.downloadURL).not.toHaveBeenCalled();
        agent.setBrowserAgentControl({ blockid: "panel", browsertabid: "agent-tab", controlled: false, token: Token });
        const free = { preventDefault: vi.fn() };
        session.emit("will-download", free, item, wc);
        expect(free.preventDefault).not.toHaveBeenCalled();
    });

    it("refuses calls after Stop and removes the native input watchers", async () => {
        agent.setBrowserAgentControl({ blockid: "panel", browsertabid: "agent-tab", controlled: false, token: Token });
        wc.emit("before-mouse-event", ev(), { type: "mouseDown" });
        input({ sender: wc }, { type: "mousedown", button: 0, x: 1, y: 1 });
        expect(held()).toBe(0);
        await expect(agent.runBrowserAgentCdp(call())).rejects.toThrow("not under agent control");
        expect(wc.listenerCount("before-input-event")).toBe(0);
        expect(wc.listenerCount("before-mouse-event")).toBe(0);
    });

    it("keeps the Wave tab view of a loaded panel page, driven or not (#375)", () => {
        expect(agent.hostsControlledTab(1)).toBe(true);
        expect(agent.hostsBrowserPage(1)).toBe(true);
        expect(agent.hostsBrowserPage(2)).toBe(false);
        agent.setBrowserAgentControl({ blockid: "panel", browsertabid: "agent-tab", controlled: false, token: Token });
        expect(agent.hostsControlledTab(1)).toBe(false);
        expect(agent.hostsBrowserPage(1)).toBe(true);
        wc.getURL = () => "about:blank";
        expect(agent.hostsBrowserPage(1)).toBe(false);
        wc.getURL = () => "https://example.com/login";
        wc.emit("destroyed");
        expect(agent.hostsBrowserPage(1)).toBe(false);
    });
});
