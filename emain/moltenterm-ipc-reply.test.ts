// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from "node:events";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getWebContentsByBlockId } from "./emain-web";
import { configurePrivilegedIpc } from "./moltenterm-privileged-ipc";

const mocks = vi.hoisted(() => ({ listeners: new Map<string, (...args: any[]) => void>(), contents: new Map<number, any>() }));
vi.mock("electron", () => ({
    ipcMain: {
        on: (channel, listener) => mocks.listeners.set(channel, listener),
        removeListener: (channel, listener) => {
            if (mocks.listeners.get(channel) === listener) mocks.listeners.delete(channel);
        },
    },
    webContents: { fromId: (id) => mocks.contents.get(id) },
}));

const registered = new Set<any>();
beforeAll(() => configurePrivilegedIpc((event) => registered.has(event.sender) && !event.sender.isDestroyed() &&
    event.senderFrame === event.sender.mainFrame && event.senderFrame.url === "file:///fixture/index.html"));
afterEach(() => { mocks.listeners.clear(); mocks.contents.clear(); registered.clear(); vi.useRealTimers(); });

function fixture() {
    const host = Object.assign(new EventEmitter(), {
        mainFrame: { url: "file:///fixture/index.html" },
        isDestroyed: () => false,
        send: vi.fn(),
    });
    registered.add(host);
    const guest = { isDestroyed: () => false, getType: () => "webview", hostWebContents: host };
    mocks.contents.set(42, guest);
    const request = () => getWebContentsByBlockId({ activeTabView: { waveTabId: "tab", webContents: host } } as any, "tab", "block");
    const response = (sender: any = host, frame: any = host.mainFrame, id: any = "42") => {
        const channel = host.send.mock.calls[0][2];
        mocks.listeners.get(channel)?.({ sender, senderFrame: frame }, id);
    };
    return { host, guest, request, response };
}

describe("application webview lookup replies", () => {
    it("keeps the reply slot after unknown, other-app and subframe responses", async () => {
        const other = fixture();
        const f = fixture();
        const result = f.request();
        f.response({ ...f.host });
        f.response(other.host, other.host.mainFrame);
        f.response(f.host, { ...f.host.mainFrame });
        expect(mocks.listeners.size).toBe(1);
        f.response();
        expect(await result).toBe(f.guest);
        expect(mocks.listeners.size).toBe(0);
        expect(f.host.eventNames()).toEqual([]);
    });

    it("installs the listener before sending and supports a synchronous reply", async () => {
        const f = fixture();
        f.host.send.mockImplementation((_channel, _block, reply) => {
            mocks.listeners.get(reply)({ sender: f.host, senderFrame: f.host.mainFrame }, "42");
        });
        expect(await f.request()).toBe(f.guest);
        expect(mocks.listeners.size).toBe(0);
    });

    it.each([null, "42junk", "-1", 2.5, "9007199254740992"])("rejects invalid guest id %s", async (id) => {
        const f = fixture();
        const result = f.request();
        f.response(f.host, f.host.mainFrame, id);
        expect(await result).toBeNull();
    });

    it("rejects a webview belonging to another application", async () => {
        const f = fixture();
        mocks.contents.set(42, { ...f.guest, hostWebContents: {} });
        const result = f.request();
        f.response();
        expect(await result).toBeNull();
    });

    it.each(["destroyed", "navigation", "timeout", "send failure"])("cleans its listener after %s", async (reason) => {
        vi.useFakeTimers();
        const f = fixture();
        if (reason === "send failure") f.host.send.mockImplementation(() => { throw new Error("fixture"); });
        const result = f.request();
        const rejection = expect(result).rejects.toThrow();
        if (reason === "destroyed") f.host.emit("destroyed");
        if (reason === "navigation") f.host.emit("did-start-navigation", {}, "https://fixture.invalid", false, true);
        if (reason === "timeout") await vi.runAllTimersAsync();
        await rejection;
        expect(mocks.listeners.size).toBe(0);
        expect(f.host.eventNames()).toEqual([]);
        expect(vi.getTimerCount()).toBe(0);
    });
});
