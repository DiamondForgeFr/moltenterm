// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { createPrivilegedIpc, IpcDeniedMessage } from "./moltenterm-privileged-ipc";
import { readRendererEnvironment, RendererEnvironmentNames } from "./moltenterm-renderer-env";

vi.mock("electron", () => ({ ipcMain: {} }));

function fixture(documentUrl = "file:///fixture/index.html") {
    const listeners = new Map<string, (...args: any[]) => any>();
    const handlers = new Map<string, (...args: any[]) => any>();
    const frame = { url: documentUrl };
    const host = { mainFrame: frame, isDestroyed: () => false, getURL: () => documentUrl };
    const authorize = vi.fn((event) =>
        event.sender === host && !host.isDestroyed() && event.senderFrame === host.mainFrame &&
        host.getURL() === documentUrl && event.senderFrame.url === documentUrl
    );
    const registration = {
        on: vi.fn((channel, listener) => listeners.set(channel, listener)),
        handle: vi.fn((channel, handler) => handlers.set(channel, handler)),
        removeListener: vi.fn((channel, listener) => {
            if (listeners.get(channel) === listener) listeners.delete(channel);
        }),
    };
    const ipc = createPrivilegedIpc(registration as any, authorize);
    const event = (sender: any = host, senderFrame: any = frame) => ({ sender, senderFrame, returnValue: undefined });
    return { ipc, event, host, frame, authorize, listeners, handlers };
}

describe("privileged IPC registration", () => {
    it.each(["file:///fixture/index.html", "http://localhost:5173/index.html"])("allows the registered main frame at %s", (url) => {
        const f = fixture(url);
        const effect = vi.fn();
        f.ipc.onApp("sync", (event, value) => { effect(); event.returnValue = value; });
        const event = f.event();
        f.listeners.get("sync")(event, "fixture");
        expect(event.returnValue).toBe("fixture");
        expect(effect).toHaveBeenCalledOnce();
        f.ipc.handleApp("invoke", (_event, value) => value);
        expect(f.handlers.get("invoke")(f.event(), "fixture")).toBe("fixture");
    });

    it.each(["guest", "popup", "subframe", "unknown", "destroyed", "navigated", "detached"])("denies %s without executing or leaving sync unanswered", (kind) => {
        const f = fixture();
        const effect = vi.fn();
        f.ipc.onApp("sync", effect);
        f.ipc.handleApp("invoke", effect);
        let event = f.event();
        if (["guest", "popup", "unknown"].includes(kind)) event = f.event({ ...f.host });
        if (kind === "subframe") event = f.event(f.host, { ...f.frame });
        if (kind === "destroyed") f.host.isDestroyed = () => true;
        if (kind === "navigated") f.frame.url = "https://fixture.invalid";
        if (kind === "detached") f.authorize.mockImplementation(() => { throw new Error("detached"); });
        f.listeners.get("sync")(event);
        expect(event.returnValue).toBeNull();
        expect(() => f.handlers.get("invoke")(event)).toThrow(IpcDeniedMessage);
        expect(effect).not.toHaveBeenCalled();
    });

    it("permits only a live guest main frame owned by the registered app", () => {
        const f = fixture();
        const effect = vi.fn();
        f.ipc.onGuest("input", effect);
        const frame = { url: "https://fixture.invalid" };
        const guest = { mainFrame: frame, hostWebContents: f.host, isDestroyed: () => false, getType: () => "webview" };
        const call = (sender = guest, senderFrame = frame) => f.listeners.get("input")(f.event(sender, senderFrame));
        call();
        expect(effect).toHaveBeenCalledOnce();
        call(guest, { ...frame });
        call({ ...guest, hostWebContents: { ...f.host } });
        call({ ...guest, isDestroyed: () => true });
        call({ ...guest, getType: () => "window" });
        f.frame.url = "https://fixture.invalid";
        call();
        expect(effect).toHaveBeenCalledOnce();
    });

    it("removes exactly its registered listener", () => {
        const f = fixture();
        const dispose = f.ipc.onApp("reply", vi.fn());
        expect(f.listeners.has("reply")).toBe(true);
        dispose();
        expect(f.listeners.has("reply")).toBe(false);
    });
});

describe("renderer environment", () => {
    it("exposes exactly the six documented UI values", () => {
        const environment = Object.fromEntries(RendererEnvironmentNames.map((name) => [name, `fixture:${name}`]));
        for (const name of RendererEnvironmentNames) expect(readRendererEnvironment(name, environment)).toBe(`fixture:${name}`);
        expect(readRendererEnvironment("WAVETERM_DEV", {})).toBeNull();
    });

    it("rejects unknown names before reading their values", () => {
        const read = vi.fn(() => { throw new Error("must not read fixture secret"); });
        const environment = new Proxy({}, { get: read });
        for (const name of ["HOME", "WAVETERM_AUTH_KEY", "WAVETERM_CALLER_SECRET", "AWS_SECRET_ACCESS_KEY", "__proto__", "PATH", null, {}, 1]) {
            expect(readRendererEnvironment(name, environment)).toBeNull();
        }
        expect(read).not.toHaveBeenCalled();
    });
});
