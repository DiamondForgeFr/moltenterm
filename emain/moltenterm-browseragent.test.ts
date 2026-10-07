// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const Mocks = vi.hoisted(() => ({ fromId: vi.fn(), on: vi.fn() }));
vi.mock("electron", () => ({ webContents: { fromId: Mocks.fromId }, ipcMain: { on: Mocks.on } }));
vi.mock("./authkey", () => ({ AuthKey: "test-auth-key" }));

const Token = createHmac("sha256", "test-auth-key").update("molten:browseragent").digest("hex");

describe("browser agent takeover", () => {
    let agent: typeof import("./moltenterm-browseragent");
    let wc: EventEmitter & Record<string, any>;
    let report: ReturnType<typeof vi.fn>;
    let input: (event: any) => void;

    beforeEach(async () => {
        vi.resetModules();
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-10-07T12:00:00Z"));
        Mocks.on.mockReset();
        wc = Object.assign(new EventEmitter(), {
            id: 42,
            hostWebContents: { id: 1 },
            isDestroyed: () => false,
            getType: () => "webview",
            isDevToolsOpened: () => false,
            setBackgroundThrottling: vi.fn(),
            debugger: { isAttached: () => false, attach: vi.fn(), detach: vi.fn(), sendCommand: vi.fn() },
        });
        Mocks.fromId.mockReturnValue(wc);
        agent = await import("./moltenterm-browseragent");
        report = vi.fn();
        agent.initMoltentermBrowserAgent(report);
        const register = Mocks.on.mock.calls.find(([channel]) => channel === agent.WebviewRegisteredChannel)[1];
        input = Mocks.on.mock.calls.find(([channel]) => channel === agent.WebviewInputChannel)[1];
        register({ sender: { id: 1 } }, "panel", "agent-tab", wc.id);
        agent.setBrowserAgentControl({ blockid: "panel", browsertabid: "agent-tab", controlled: true, token: Token });
    });

    afterEach(() => vi.useRealTimers());

    const call = () => ({
        blockid: "panel",
        browsertabid: "agent-tab",
        method: "Page.getNavigationHistory",
        token: Token,
    });

    it("pauses at once and coalesces native and preload reports until Give back", async () => {
        wc.emit("before-mouse-event", {}, { type: "mouseDown" });
        input({ sender: wc });
        vi.advanceTimersByTime(300);
        wc.emit("before-input-event", {}, { type: "keyDown" });
        expect(report).toHaveBeenCalledTimes(1);
        await expect(agent.runBrowserAgentCdp(call())).rejects.toThrow("The user has taken over");
        expect(wc.debugger.sendCommand).not.toHaveBeenCalled();
    });

    it("takes over again immediately after Give back", async () => {
        wc.emit("before-mouse-event", {}, { type: "mouseDown" });
        agent.setBrowserAgentControl({ blockid: "panel", browsertabid: "agent-tab", controlled: true, token: Token });
        vi.advanceTimersByTime(1);
        wc.emit("before-input-event", {}, { type: "keyDown" });
        expect(report).toHaveBeenCalledTimes(2);
        await expect(agent.runBrowserAgentCdp(call())).rejects.toThrow("The user has taken over");
    });

    it("keeps agent input from reporting takeover", async () => {
        wc.debugger.sendCommand.mockImplementation(async () => {
            wc.emit("before-mouse-event", {}, { type: "mouseDown" });
        });
        await agent.runBrowserAgentCdp({ ...call(), method: "Input.dispatchMouseEvent" });
        expect(report).not.toHaveBeenCalled();
        vi.advanceTimersByTime(151);
        input({ sender: wc });
        expect(report).toHaveBeenCalledTimes(1);
    });

    it("refuses calls after Stop and removes the native input watchers", async () => {
        agent.setBrowserAgentControl({ blockid: "panel", browsertabid: "agent-tab", controlled: false, token: Token });
        wc.emit("before-mouse-event", {}, { type: "mouseDown" });
        input({ sender: wc });
        expect(report).not.toHaveBeenCalled();
        await expect(agent.runBrowserAgentCdp(call())).rejects.toThrow("not under agent control");
        expect(wc.listenerCount("before-input-event")).toBe(0);
        expect(wc.listenerCount("before-mouse-event")).toBe(0);
    });
});
