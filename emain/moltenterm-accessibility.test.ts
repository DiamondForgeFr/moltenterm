// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { expect, it, vi } from "vitest";
import { configurePrivilegedIpc } from "./moltenterm-privileged-ipc";

const bridge = vi.hoisted(() => ({
    ipc: new Map<string, (...args: any[]) => void>(),
    events: new Map<string, (...args: any[]) => void>(),
    contents: [] as any[],
    registered: new Set<number>(),
    detect: vi.fn(() => true),
}));
vi.mock("electron", () => ({
    app: { isAccessibilitySupportEnabled: bridge.detect, on: (name, cb) => bridge.events.set(name, cb) },
    ipcMain: { on: (name, cb) => bridge.ipc.set(name, cb) },
    webContents: { getAllWebContents: () => bridge.contents },
}));
vi.mock("./emain-tabview", () => ({ getWaveTabViewByWebContentsId: (id) => (bridge.registered.has(id) ? {} : null) }));

it("reads native state once, restricts callers and publishes monotonic updates only to live app tabs", async () => {
    const { initMoltentermAccessibility } = await import("./moltenterm-accessibility");
    initMoltentermAccessibility();
    initMoltentermAccessibility();
    const appTab = { id: 1, mainFrame: {}, isDestroyed: () => false, send: vi.fn() };
    const guest = { id: 2, mainFrame: {}, isDestroyed: () => false, send: vi.fn() };
    const deadTab = { id: 3, mainFrame: {}, isDestroyed: () => true, send: vi.fn() };
    bridge.contents.push(appTab, guest, deadTab);
    bridge.registered.add(1).add(3);
    configurePrivilegedIpc(
        (event) =>
            event.sender === (appTab as any) &&
            !event.sender.isDestroyed() &&
            event.senderFrame === event.sender.mainFrame
    );
    const read = (sender, frame = sender.mainFrame) => {
        const event = { sender, senderFrame: frame, returnValue: undefined };
        bridge.ipc.get("moltenterm:get-accessibility-support")(event);
        return event.returnValue;
    };
    const supported = process.platform === "darwin" || process.platform === "win32";
    expect(read(appTab)).toEqual({ available: supported, enabled: supported, revision: 0 });
    expect(read(guest)).toBeNull();
    expect(read(appTab, {})).toBeNull();
    expect(read(deadTab)).toBeNull();
    bridge.events.get("accessibility-support-changed")({}, false);
    bridge.events.get("accessibility-support-changed")({}, true);
    expect(appTab.send).toHaveBeenLastCalledWith("moltenterm:accessibility-support-changed", {
        available: true,
        enabled: true,
        revision: 2,
    });
    expect(read(appTab)).toEqual({ available: true, enabled: true, revision: 2 });
    expect(guest.send).not.toHaveBeenCalled();
    expect(deadTab.send).not.toHaveBeenCalled();
    expect(bridge.detect).toHaveBeenCalledTimes(supported ? 1 : 0);
});
